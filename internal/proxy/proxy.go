package proxy

import (
	"crypto/tls"
	"io"
	"net/http"
	"strings"
	"time"
)

// Proxy forwards requests to a Muti Metroo agent, stripping the /api/proxy prefix.
type Proxy struct {
	agentURL   string
	agentToken string
	client     *http.Client
	longClient *http.Client
}

// maxIdleConnsPerHost keeps a polling dashboard (topology refresh,
// monitoring ticks) from churning TCP connections to the single agent
// upstream. The http.Transport default of 2 is sized for browsing
// many hosts, not for one hot upstream.
const maxIdleConnsPerHost = 16

// New creates a proxy targeting the given agent URL. tlsCfg configures
// verification of the agent's certificate for https:// agent URLs; nil
// means default verification against the system roots (see
// internal/agenttls for the CA-bundle and insecure variants).
func New(agentURL, agentToken string, tlsCfg *tls.Config) *Proxy {
	return &Proxy{
		agentURL:   strings.TrimRight(agentURL, "/"),
		agentToken: agentToken,
		client: &http.Client{
			Timeout: 30 * time.Second,
			Transport: &http.Transport{
				TLSClientConfig:     tlsCfg,
				MaxIdleConnsPerHost: maxIdleConnsPerHost,
			},
		},
		longClient: &http.Client{
			Timeout: 30 * time.Minute,
			Transport: &http.Transport{
				TLSClientConfig:     tlsCfg,
				MaxIdleConnsPerHost: maxIdleConnsPerHost,
			},
		},
	}
}

// isWebSocketUpgrade checks if the request is a WebSocket upgrade.
// The Connection header is a comma-separated token list — browsers
// send the bare "Upgrade", but a fronting reverse proxy may hand us
// "keep-alive, Upgrade" instead.
func isWebSocketUpgrade(r *http.Request) bool {
	return headerHasToken(r.Header, "Connection", "upgrade") &&
		strings.EqualFold(r.Header.Get("Upgrade"), "websocket")
}

// headerHasToken reports whether the named header carries the given
// token in any of its comma-separated values.
func headerHasToken(h http.Header, name, token string) bool {
	for _, v := range h.Values(name) {
		for _, t := range strings.Split(v, ",") {
			if strings.EqualFold(strings.TrimSpace(t), token) {
				return true
			}
		}
	}
	return false
}

// isLongTimeout returns true for paths that need extended timeouts (file transfer).
func isLongTimeout(path string) bool {
	return strings.HasSuffix(path, "/file/upload") || strings.HasSuffix(path, "/file/download")
}

// ServeHTTP handles requests by proxying them to the agent.
// It expects the request path to start with /api/proxy.
func (p *Proxy) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// Strip /api/proxy prefix to get the agent-side path
	agentPath := strings.TrimPrefix(r.URL.Path, "/api/proxy")
	if agentPath == "" {
		agentPath = "/"
	}

	// WebSocket upgrade → delegate to WebSocket handler
	if isWebSocketUpgrade(r) {
		p.handleWebSocket(w, r, agentPath)
		return
	}

	targetURL := p.agentURL + agentPath
	if r.URL.RawQuery != "" {
		targetURL += "?" + r.URL.RawQuery
	}

	proxyReq, err := http.NewRequestWithContext(r.Context(), r.Method, targetURL, r.Body)
	if err != nil {
		http.Error(w, "failed to create proxy request", http.StatusBadGateway)
		return
	}

	// Forward all relevant request headers
	for _, hdr := range []string{"Content-Type", "Accept", "Authorization", "X-Request-ID"} {
		if v := r.Header.Get(hdr); v != "" {
			proxyReq.Header.Set(hdr, v)
		}
	}
	// Server-side token overrides any client-sent Authorization header
	if p.agentToken != "" {
		proxyReq.Header.Set("Authorization", "Bearer "+p.agentToken)
	}
	// Default Accept to JSON if not set
	if proxyReq.Header.Get("Accept") == "" {
		proxyReq.Header.Set("Accept", "application/json")
	}

	// Pick client based on timeout needs
	client := p.client
	if isLongTimeout(agentPath) {
		client = p.longClient
	}

	resp, err := client.Do(proxyReq)
	if err != nil {
		http.Error(w, "agent unreachable: "+err.Error(), http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	// Copy response headers, dropping hop-by-hop ones (plus any the
	// agent names in its Connection header) — they describe the
	// agent↔manager hop and must not be forwarded to the client.
	stripHopByHop(resp.Header)
	for k, vv := range resp.Header {
		for _, v := range vv {
			w.Header().Add(k, v)
		}
	}

	w.WriteHeader(resp.StatusCode)

	// Use flusher for streaming responses (file downloads). A failed
	// write means the client is gone; abort instead of draining the
	// rest of the upstream body pointlessly.
	if flusher, ok := w.(http.Flusher); ok && isLongTimeout(agentPath) {
		buf := make([]byte, 32*1024)
		for {
			n, readErr := resp.Body.Read(buf)
			if n > 0 {
				if _, err := w.Write(buf[:n]); err != nil {
					return
				}
				flusher.Flush()
			}
			if readErr != nil {
				break
			}
		}
	} else {
		io.Copy(w, resp.Body)
	}
}

// hopByHopHeaders are the RFC 7230 §6.1 connection-specific headers
// that must not be relayed end-to-end.
var hopByHopHeaders = []string{
	"Connection",
	"Keep-Alive",
	"Proxy-Authenticate",
	"Proxy-Authorization",
	"TE",
	"Trailer",
	"Transfer-Encoding",
	"Upgrade",
}

// stripHopByHop removes the fixed hop-by-hop headers from h, plus any
// extra header fields named by the Connection token list.
func stripHopByHop(h http.Header) {
	for _, tok := range strings.Split(h.Get("Connection"), ",") {
		if tok = strings.TrimSpace(tok); tok != "" {
			h.Del(tok)
		}
	}
	for _, k := range hopByHopHeaders {
		h.Del(k)
	}
}
