package server

import (
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/postalsys/muti-metroo-manager/internal/agentprobe"
	"github.com/postalsys/muti-metroo-manager/internal/downloads"
	"github.com/postalsys/muti-metroo-manager/internal/metrics"
	"github.com/postalsys/muti-metroo-manager/internal/proxy"
	"github.com/postalsys/muti-metroo-manager/internal/store"
	"github.com/postalsys/muti-metroo-manager/internal/webui"
)

// Options bundles the runtime configuration server.New needs.
type Options struct {
	Addr       string
	AgentURL   string
	AgentToken string
	Store      *store.Store
	Bundle     *downloads.Bundle
	Version    string

	// AuthToken, when non-empty, gates every /api/* route (including
	// /api/proxy/*) behind a bearer token / session cookie — see
	// auth.go. Empty disables the gate; cmd/manager only permits that
	// on loopback binds or with -insecure-no-auth.
	AuthToken string

	// AgentProber, when non-nil, drives /healthz's agent_reachable
	// field, refreshed at most every 5s.
	AgentProber *agentprobe.Prober

	// SoundsLocked forces the UI sound-effects feature off. When true,
	// /api/settings GET returns sounds_enabled=false plus
	// sounds_locked=true so the dialog can disable the toggle, and PUT
	// silently coerces sounds_enabled to false. Set by the operator
	// via -no-sounds.
	SoundsLocked bool

	// Logger defaults to slog.Default() when nil.
	Logger *slog.Logger

	// Metrics, when non-nil, registers request-side metrics and the
	// agent-reachable gauge. The /metrics endpoint itself lives on
	// the separate listener built by MetricsServer.
	Metrics *metrics.Registry
}

// SeedHealthFunc seeds the /healthz cache with a result from the
// startup probe so /healthz and metroo_manager_agent_reachable return
// meaningful data immediately. New returns a closure rather than
// exposing healthCache so callers don't reach into server internals.
type SeedHealthFunc func(agentprobe.Result)

// New builds the HTTP server. Options.Bundle may be nil — when it is,
// the /api/downloads/* routes are not registered and the frontend
// hides the Downloads tab.
//
// The returned SeedHealthFunc is non-nil; cmd/manager calls it once
// the upfront agent probe finishes.
func New(opts Options) (*http.Server, SeedHealthFunc) {
	logger := opts.Logger
	if logger == nil {
		logger = slog.Default()
	}

	mux := http.NewServeMux()
	p := proxy.New(opts.AgentURL, opts.AgentToken)

	hc := newHealthCache(opts.AgentProber, opts.Version)
	mux.Handle("/healthz", healthzHandler(hc))

	inst := newInstrumentation(opts.Metrics)
	if opts.Metrics != nil {
		// Sampled from the /healthz cache so a tight Prometheus
		// interval can't drive extra agent traffic.
		opts.Metrics.NewGaugeFunc("metroo_manager_agent_reachable",
			"1 when the upstream Muti Metroo agent answered the last health probe.",
			nil, hc.reachableGauge)
	}

	// Everything under /api/* sits behind the manager auth gate, with
	// the single exception of the login endpoint — the gate's
	// entrance. The SPA is same-origin, so no CORS headers are
	// emitted at all: browsers enforce same-origin by default and
	// non-browser clients don't need them.
	api := http.NewServeMux()
	api.Handle("/api/proxy/", p)
	api.Handle("/api/settings", settingsHandler(opts.Store, logger, opts.SoundsLocked))
	api.Handle("/api/agent-meta", agentMetaListHandler(opts.Store))
	api.Handle("/api/agent-meta/", agentMetaItemHandler(opts.Store, logger))
	api.Handle("/api/networks", networksListHandler(opts.Store))
	api.Handle("/api/networks/", networkItemHandler(opts.Store, logger))
	api.Handle("/api/positions", positionsHandler(opts.Store, logger))
	if opts.Bundle != nil {
		api.Handle("/api/downloads/manifest", downloadsManifestHandler(opts.Bundle))
		api.Handle("/api/downloads/file/", downloadsFileHandler(opts.Bundle))
	}
	mux.Handle("/api/", authMiddleware(opts.AuthToken, api))
	if opts.AuthToken != "" {
		mux.Handle("/api/auth/login", loginHandler(opts.AuthToken))
	}
	mux.Handle("/", webui.Handler())

	srv := &http.Server{
		Addr:    opts.Addr,
		Handler: instrumentMiddleware(inst, accessLog(logger, mux)),
		// Slowloris hardening. WriteTimeout is deliberately unset: it
		// would kill hijacked WebSocket relays (shell, ping) and long
		// file-transfer streams mid-flight.
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
	}
	return srv, hc.seed
}

// MetricsServer returns a separate *http.Server bound to addr that
// only serves /metrics from reg. cmd/manager calls this when the
// operator passes -metrics-addr; nil is returned when reg is nil.
func MetricsServer(addr string, reg *metrics.Registry) *http.Server {
	if reg == nil || addr == "" {
		return nil
	}
	mux := http.NewServeMux()
	mux.Handle("/metrics", metricsHandler(reg))
	mux.Handle("/", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/metrics", http.StatusFound)
	}))
	// Same Slowloris hardening as the main listener; no WriteTimeout
	// for consistency (a huge /metrics exposition must not be cut off).
	return &http.Server{
		Addr:              addr,
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
	}
}

// settingsHandler serves GET (read) and PUT (replace) on /api/settings.
// The shape matches store.Settings directly. PUT emits a structured
// audit event (`audit=true`) so log pipelines can split state changes
// out of the access log without parsing free-form messages.
func settingsHandler(st *store.Store, logger *slog.Logger, soundsLocked bool) http.Handler {
	clamp := func(s store.Settings) store.Settings {
		if soundsLocked {
			s.SoundsEnabled = false
			s.SoundsLocked = true
		}
		return s
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			s, err := st.GetSettings()
			if err != nil {
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
			writeJSON(w, http.StatusOK, clamp(s))
		case http.MethodPut:
			var in store.Settings
			if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
				http.Error(w, "invalid JSON: "+err.Error(), http.StatusBadRequest)
				return
			}
			if soundsLocked {
				in.SoundsEnabled = false
			}
			out, err := st.UpdateSettings(in)
			if err != nil {
				if errors.Is(err, store.ErrInvalidAddress) {
					http.Error(w, err.Error(), http.StatusBadRequest)
					return
				}
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
			logger.LogAttrs(r.Context(), slog.LevelInfo, "settings updated",
				slog.Bool("audit", true),
				slog.String("req_id", requestIDFromContext(r.Context())),
				slog.String("remote", clientIP(r)),
				slog.String("api_address", out.APIAddress),
				slog.String("socks_address", out.SocksAddress),
				slog.Bool("sounds_enabled", out.SoundsEnabled),
			)
			writeJSON(w, http.StatusOK, clamp(out))
		default:
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		}
	})
}

// agentMetaListHandler serves GET /api/agent-meta → {agentID: {note, icon}, ...}.
func agentMetaListHandler(st *store.Store) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		meta, err := st.GetAgentMetadata()
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		writeJSON(w, http.StatusOK, meta)
	})
}

// agentMetaItemHandler serves PUT /api/agent-meta/{agent_id}. Emits an
// audit event on success so an operator can answer "who attached
// which note to which agent and when."
func agentMetaItemHandler(st *store.Store, logger *slog.Logger) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPut {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		agentID := strings.TrimPrefix(r.URL.Path, "/api/agent-meta/")
		if agentID == "" || strings.Contains(agentID, "/") {
			http.Error(w, "agent id required in path", http.StatusBadRequest)
			return
		}
		var in store.AgentMeta
		if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
			http.Error(w, "invalid JSON: "+err.Error(), http.StatusBadRequest)
			return
		}
		if err := st.UpdateAgentMetadata(agentID, in); err != nil {
			if errors.Is(err, store.ErrInvalidAgentID) || errors.Is(err, store.ErrInvalidIcon) ||
				errors.Is(err, store.ErrInvalidNetworks) {
				http.Error(w, err.Error(), http.StatusBadRequest)
				return
			}
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		logger.LogAttrs(r.Context(), slog.LevelInfo, "agent metadata updated",
			slog.Bool("audit", true),
			slog.String("req_id", requestIDFromContext(r.Context())),
			slog.String("remote", clientIP(r)),
			slog.String("agent_id", agentID),
			slog.String("icon", in.Icon),
			slog.Int("note_len", len(in.Note)),
			slog.String("networks", in.Networks),
		)
		writeJSON(w, http.StatusOK, in)
	})
}

// networksListHandler serves GET /api/networks → {networkID: displayName, ...}.
// Only networks with a custom name appear; the frontend falls back to the
// identifier for the rest.
func networksListHandler(st *store.Store) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		names, err := st.GetNetworks()
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		writeJSON(w, http.StatusOK, names)
	})
}

// networkItemHandler serves PUT /api/networks/{id} with body {"name": "..."}.
// Returns the effective name ({"id","name"}) — equal to the identifier when
// the override was cleared — so the frontend can update its override map.
func networkItemHandler(st *store.Store, logger *slog.Logger) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPut {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		id := strings.TrimPrefix(r.URL.Path, "/api/networks/")
		if id == "" || strings.Contains(id, "/") {
			http.Error(w, "network id required in path", http.StatusBadRequest)
			return
		}
		var in struct {
			Name string `json:"name"`
		}
		if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
			http.Error(w, "invalid JSON: "+err.Error(), http.StatusBadRequest)
			return
		}
		name, err := st.UpsertNetwork(id, in.Name)
		if err != nil {
			if errors.Is(err, store.ErrInvalidNetworkID) {
				http.Error(w, err.Error(), http.StatusBadRequest)
				return
			}
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		logger.LogAttrs(r.Context(), slog.LevelInfo, "network name updated",
			slog.Bool("audit", true),
			slog.String("req_id", requestIDFromContext(r.Context())),
			slog.String("remote", clientIP(r)),
			slog.String("network_id", id),
			slog.String("name", name),
		)
		writeJSON(w, http.StatusOK, map[string]string{"id": id, "name": name})
	})
}

// positionsHandler serves GET /api/positions → {short_id: {x,y}, ...} and
// PUT (replace-all) with the same shape. An empty PUT body clears the set
// (the reset-view action).
func positionsHandler(st *store.Store, logger *slog.Logger) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			positions, err := st.GetPositions()
			if err != nil {
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
			writeJSON(w, http.StatusOK, positions)
		case http.MethodPut:
			var in map[string]store.Position
			if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
				http.Error(w, "invalid JSON: "+err.Error(), http.StatusBadRequest)
				return
			}
			if err := st.ReplacePositions(in); err != nil {
				if errors.Is(err, store.ErrInvalidPosition) {
					http.Error(w, err.Error(), http.StatusBadRequest)
					return
				}
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
			logger.LogAttrs(r.Context(), slog.LevelInfo, "positions updated",
				slog.Bool("audit", true),
				slog.String("req_id", requestIDFromContext(r.Context())),
				slog.String("remote", clientIP(r)),
				slog.Int("count", len(in)),
			)
			writeJSON(w, http.StatusOK, map[string]int{"count": len(in)})
		default:
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		}
	})
}

// downloadsManifestHandler serves GET /api/downloads/manifest with the
// bundle's pre-rendered JSON. Frontend uses 200 vs 404 to decide whether
// to show the Downloads tab.
func downloadsManifestHandler(b *downloads.Bundle) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		w.Write(b.ManifestJSON())
	})
}

// downloadsFileHandler streams a single artifact out of the bundle.
// Path: /api/downloads/file/<name> — the trailing segment is fed
// straight to Bundle.File, which rejects path separators and traversal.
func downloadsFileHandler(b *downloads.Bundle) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		name := strings.TrimPrefix(r.URL.Path, "/api/downloads/file/")
		rc, size, downloadName, err := b.File(name)
		if err != nil {
			if errors.Is(err, os.ErrNotExist) {
				http.NotFound(w, r)
				return
			}
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		defer rc.Close()
		w.Header().Set("Content-Type", contentTypeFor(downloadName))
		w.Header().Set("Content-Length", strconv.FormatInt(size, 10))
		w.Header().Set("Content-Disposition", `attachment; filename="`+downloadName+`"`)
		w.WriteHeader(http.StatusOK)
		io.Copy(w, rc)
	})
}

// contentTypeFor returns a sensible mime type for the artifacts we ship
// in the bundle. Most Muti Metroo binaries are octet-stream; the manual is PDF.
func contentTypeFor(name string) string {
	switch {
	case strings.HasSuffix(name, ".pdf"):
		return "application/pdf"
	default:
		return "application/octet-stream"
	}
}

func writeJSON(w http.ResponseWriter, status int, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}
