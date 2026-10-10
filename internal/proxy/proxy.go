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

// New creates a proxy targeting the given agent URL.
func New(agentURL, agentToken string) *Proxy {
	tlsCfg := &tls.Config{InsecureSkipVerify: true}
	return &Proxy{
		agentURL:   strings.TrimRight(agentURL, "/"),
		agentToken: agentToken,
		client: &http.Client{
			Timeout: 30 * time.Second,
			Transport: &http.Transport{
				TLSClientConfig: tlsCfg,
			},
		},
		longClient: &http.Client{
			Timeout: 30 * time.Minute,
			Transport: &http.Transport{
				TLSClientConfig: tlsCfg,
			},
		},
	}
}

// isWebSocketUpgrade checks if the request is a WebSocket upgrade.
func isWebSocketUpgrade(r *http.Request) bool {
	return strings.EqualFold(r.Header.Get("Connection"), "Upgrade") &&
		strings.EqualFold(r.Header.Get("Upgrade"), "websocket")
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

	// Copy response headers
	for k, vv := range resp.Header {
		for _, v := range vv {
			w.Header().Add(k, v)
		}
	}

	w.WriteHeader(resp.StatusCode)

	// Use flusher for streaming responses (file downloads)
	if flusher, ok := w.(http.Flusher); ok && isLongTimeout(agentPath) {
		buf := make([]byte, 32*1024)
		for {
			n, readErr := resp.Body.Read(buf)
			if n > 0 {
				w.Write(buf[:n])
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
