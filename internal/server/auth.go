package server

import (
	"crypto/subtle"
	"encoding/json"
	"net"
	"net/http"
	"net/netip"
	"strings"
)

// authCookieName carries the session credential set by the login
// endpoint. HttpOnly + SameSite=Strict; the SPA never reads it, the
// browser just sends it back on same-origin requests (fetch and
// WebSocket upgrade alike).
const authCookieName = "mmm_auth"

// managerAuthRealm marks the manager's own 401s so the SPA can tell
// "the manager wants its token" apart from a proxied agent 401.
const managerAuthRealm = `Bearer realm="muti-metroo-manager"`

// authMiddleware gates next behind the manager auth token. Three
// credential carriers are accepted, first match wins:
//   - Authorization: Bearer <token> (API clients)
//   - the mmm_auth session cookie (browser, set by loginHandler)
//   - ?token=<token> query parameter (browser WebSocket upgrades that
//     predate the cookie flow)
//
// An empty token disables the gate entirely — callers only reach that
// state on loopback binds or with -insecure-no-auth.
func authMiddleware(token string, next http.Handler) http.Handler {
	if token == "" {
		return next
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !authorized(r, token) {
			writeAuthRequired(w)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// authorized reports whether r carries the manager token in any of the
// accepted carriers. All comparisons are constant-time.
func authorized(r *http.Request, token string) bool {
	match := func(candidate string) bool {
		return candidate != "" &&
			subtle.ConstantTimeCompare([]byte(candidate), []byte(token)) == 1
	}
	if h := r.Header.Get("Authorization"); strings.HasPrefix(h, "Bearer ") {
		if match(strings.TrimPrefix(h, "Bearer ")) {
			return true
		}
	}
	if c, err := r.Cookie(authCookieName); err == nil && match(c.Value) {
		return true
	}
	return match(r.URL.Query().Get("token"))
}

// writeAuthRequired emits the 401 shape the SPA's API client keys on:
// the WWW-Authenticate realm distinguishes a manager 401 from an agent
// 401 relayed through /api/proxy.
func writeAuthRequired(w http.ResponseWriter) {
	w.Header().Set("WWW-Authenticate", managerAuthRealm)
	writeJSON(w, http.StatusUnauthorized, map[string]string{
		"error":      "manager authentication required",
		"error_code": "manager_auth_required",
	})
}

// loginHandler serves POST /api/auth/login with body {"token": "..."}.
// On success it sets the session cookie and returns 204; the SPA then
// retries whatever request was refused. The route is registered
// outside the auth gate — it is the gate's entrance.
func loginHandler(token string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		var in struct {
			Token string `json:"token"`
		}
		// The body is one short string; cap it far below the global 1MB
		// JSON budget so the decode can't be used for memory churn.
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&in); err != nil {
			http.Error(w, "invalid JSON: "+err.Error(), http.StatusBadRequest)
			return
		}
		if in.Token == "" ||
			subtle.ConstantTimeCompare([]byte(in.Token), []byte(token)) != 1 {
			writeAuthRequired(w)
			return
		}
		cookie := &http.Cookie{
			Name:     authCookieName,
			Value:    in.Token,
			Path:     "/",
			HttpOnly: true,
			SameSite: http.SameSiteStrictMode,
		}
		// Secure when the request arrived over TLS — directly or via a
		// TLS-terminating reverse proxy — so the cookie can't leak over
		// plaintext on deployments that mix both.
		if r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https" {
			cookie.Secure = true
		}
		http.SetCookie(w, cookie)
		w.WriteHeader(http.StatusNoContent)
	})
}

// BindsLoopbackOnly reports whether addr pins the listener to a
// loopback interface. Used by cmd/manager to refuse unauthenticated
// wildcard binds: ":3000" (empty host) and "0.0.0.0:3000" bind every
// interface; "127.0.0.1:3000", "[::1]:3000", and "localhost:3000" do
// not. Unparseable addresses are treated as non-loopback so the safe
// default is to refuse.
func BindsLoopbackOnly(addr string) bool {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		// Tolerate a bare port ("3000") the way net/http does.
		if !strings.Contains(addr, ":") {
			host = ""
		} else {
			return false
		}
	}
	if host == "" {
		return false
	}
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip, err := netip.ParseAddr(strings.Trim(host, "[]"))
	if err != nil {
		return false
	}
	return ip.IsLoopback()
}
