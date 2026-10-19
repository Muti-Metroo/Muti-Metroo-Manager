package server

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/Muti-Metroo/Muti-Metroo-Manager/internal/davshare"
	"github.com/Muti-Metroo/Muti-Metroo-Manager/internal/store"
)

// Share passwords: user-supplied ones must be at least this long, and
// bcrypt only looks at the first 72 bytes, so longer ones are refused
// rather than silently truncated.
const (
	minSharePasswordLen = 8
	maxSharePasswordLen = 72
)

// shareCheckTimeout bounds the remote-path check on create.
const shareCheckTimeout = 30 * time.Second

// shareView is a share as the API returns it: the stored row (minus the
// password hash, which store.Share never serialises) plus the path the
// share is mounted at on this listener.
type shareView struct {
	store.Share
	MountPath string `json:"mount_path"`
}

func viewOf(sh store.Share) shareView {
	return shareView{Share: sh, MountPath: davshare.Prefix + sh.Name + "/"}
}

// shareWithPassword is the create / update response. Password is only
// set when the manager generated one; it is never retrievable later.
// LoopbackOnly mirrors the list response so the UI can show mount help
// without another round trip.
type shareWithPassword struct {
	Share        shareView `json:"share"`
	Password     string    `json:"password,omitempty"`
	LoopbackOnly bool      `json:"loopback_only"`
}

// sharesListHandler serves GET /api/shares and POST /api/shares.
// loopbackOnly tells the UI that mounts only work from this host.
func sharesListHandler(st *store.Store, gw *davshare.Gateway, logger *slog.Logger, loopbackOnly bool) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			shares, err := st.ListShares()
			if err != nil {
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
			views := make([]shareView, len(shares))
			for i, sh := range shares {
				views[i] = viewOf(sh)
			}
			writeJSON(w, http.StatusOK, map[string]any{
				"shares":        views,
				"loopback_only": loopbackOnly,
			})
		case http.MethodPost:
			createShare(w, r, st, gw, logger, loopbackOnly)
		default:
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		}
	})
}

func createShare(w http.ResponseWriter, r *http.Request, st *store.Store, gw *davshare.Gateway, logger *slog.Logger, loopbackOnly bool) {
	var in struct {
		Name       string `json:"name"`
		AgentID    string `json:"agent_id"`
		RemotePath string `json:"remote_path"`
		ReadOnly   *bool  `json:"read_only"`
		Enabled    *bool  `json:"enabled"`
		Username   string `json:"username"`
		Password   string `json:"password"`
	}
	if !decodeOrReject(w, r, &in) {
		return
	}
	sh := store.NormalizeShare(store.Share{
		Name:       in.Name,
		AgentID:    in.AgentID,
		RemotePath: in.RemotePath,
		ReadOnly:   in.ReadOnly == nil || *in.ReadOnly,
		Enabled:    in.Enabled == nil || *in.Enabled,
		Username:   in.Username,
	})
	if sh.Username == "" {
		sh.Username = sh.Name
	}
	password, generated, err := pickPassword(in.Password, in.Password == "")
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	// Validate everything local before asking the agent anything, and
	// leave the deliberately slow bcrypt hash for last.
	if err := store.ValidateShare(sh); err != nil {
		writeShareError(w, err)
		return
	}
	if _, err := st.GetShareByName(sh.Name); err == nil {
		http.Error(w, store.ErrShareExists.Error()+": "+sh.Name, http.StatusConflict)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), shareCheckTimeout)
	err = gw.Client().CheckDir(ctx, sh.AgentID, sh.RemotePath)
	cancel()
	switch {
	case errors.Is(err, davshare.ErrRemoteNotFound), errors.Is(err, davshare.ErrRemoteNotDir),
		errors.Is(err, davshare.ErrRemoteNotAllowed):
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	case err != nil:
		http.Error(w, "could not verify the remote path: "+err.Error(), http.StatusBadGateway)
		return
	}
	if sh.PasswordHash, err = davshare.HashPassword(password); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	created, err := st.CreateShare(sh)
	if err != nil {
		writeShareError(w, err)
		return
	}
	logger.LogAttrs(r.Context(), slog.LevelInfo, "file share created",
		slog.Bool("audit", true),
		slog.String("req_id", requestIDFromContext(r.Context())),
		slog.String("remote", clientIP(r)),
		slog.String("share", created.Name),
		slog.String("agent_id", created.AgentID),
		slog.String("remote_path", created.RemotePath),
		slog.Bool("read_only", created.ReadOnly),
	)
	out := shareWithPassword{Share: viewOf(created), LoopbackOnly: loopbackOnly}
	if generated {
		out.Password = password
	}
	writeJSON(w, http.StatusCreated, out)
}

// shareItemHandler serves PATCH and DELETE on /api/shares/{id}.
func shareItemHandler(st *store.Store, gw *davshare.Gateway, logger *slog.Logger, loopbackOnly bool) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id, err := strconv.ParseInt(strings.TrimPrefix(r.URL.Path, "/api/shares/"), 10, 64)
		if err != nil || id <= 0 {
			http.Error(w, "share id required in path", http.StatusBadRequest)
			return
		}
		switch r.Method {
		case http.MethodPatch:
			var in struct {
				Enabled        *bool  `json:"enabled"`
				ReadOnly       *bool  `json:"read_only"`
				RotatePassword bool   `json:"rotate_password"`
				Password       string `json:"password"`
			}
			if !decodeOrReject(w, r, &in) {
				return
			}
			u := store.ShareUpdate{Enabled: in.Enabled, ReadOnly: in.ReadOnly}
			var password string
			var generated bool
			if in.RotatePassword || in.Password != "" {
				if password, generated, err = pickPassword(in.Password, in.RotatePassword && in.Password == ""); err != nil {
					http.Error(w, err.Error(), http.StatusBadRequest)
					return
				}
				hash, err := davshare.HashPassword(password)
				if err != nil {
					http.Error(w, err.Error(), http.StatusInternalServerError)
					return
				}
				u.PasswordHash = &hash
			}
			updated, err := st.UpdateShare(id, u)
			if err != nil {
				writeShareError(w, err)
				return
			}
			logger.LogAttrs(r.Context(), slog.LevelInfo, "file share updated",
				slog.Bool("audit", true),
				slog.String("req_id", requestIDFromContext(r.Context())),
				slog.String("remote", clientIP(r)),
				slog.String("share", updated.Name),
				slog.Bool("enabled", updated.Enabled),
				slog.Bool("read_only", updated.ReadOnly),
				slog.Bool("password_changed", u.PasswordHash != nil),
			)
			out := shareWithPassword{Share: viewOf(updated), LoopbackOnly: loopbackOnly}
			if generated {
				out.Password = password
			}
			writeJSON(w, http.StatusOK, out)
		case http.MethodDelete:
			sh, err := st.GetShare(id)
			if err != nil {
				writeShareError(w, err)
				return
			}
			if err := st.DeleteShare(id); err != nil {
				writeShareError(w, err)
				return
			}
			gw.Forget(id)
			logger.LogAttrs(r.Context(), slog.LevelInfo, "file share deleted",
				slog.Bool("audit", true),
				slog.String("req_id", requestIDFromContext(r.Context())),
				slog.String("remote", clientIP(r)),
				slog.String("share", sh.Name),
			)
			w.WriteHeader(http.StatusNoContent)
		default:
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		}
	})
}

// pickPassword returns the supplied password after a length check, or
// a generated one when generate is true.
func pickPassword(supplied string, generate bool) (password string, generated bool, err error) {
	if generate {
		p, err := davshare.GeneratePassword()
		return p, true, err
	}
	if len(supplied) < minSharePasswordLen || len(supplied) > maxSharePasswordLen {
		return "", false, errors.New("password must be " + strconv.Itoa(minSharePasswordLen) + "-" +
			strconv.Itoa(maxSharePasswordLen) + " bytes long")
	}
	return supplied, false, nil
}

func decodeOrReject(w http.ResponseWriter, r *http.Request, dst any) bool {
	if err := decodeJSON(w, r, dst); err != nil {
		if errors.Is(err, errBodyTooLarge) {
			http.Error(w, err.Error(), http.StatusRequestEntityTooLarge)
			return false
		}
		http.Error(w, "invalid JSON: "+err.Error(), http.StatusBadRequest)
		return false
	}
	return true
}

func writeShareError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, store.ErrShareNotFound):
		http.Error(w, err.Error(), http.StatusNotFound)
	case errors.Is(err, store.ErrShareExists):
		http.Error(w, err.Error(), http.StatusConflict)
	case errors.Is(err, store.ErrInvalidShare):
		http.Error(w, err.Error(), http.StatusBadRequest)
	default:
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}
