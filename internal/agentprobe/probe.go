// Package agentprobe issues read-only health requests against the
// upstream Muti Metroo agent. Both `muti-metroo-manager check` (one-shot) and the
// long-running server (cached for /healthz, refreshed periodically)
// share this code so their views of agent reachability never drift.
package agentprobe

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"
)

// Result is a snapshot of the agent's health.
type Result struct {
	Reachable bool          `json:"reachable"`
	Status    int           `json:"status"`
	Latency   time.Duration `json:"latency_ns"`
	Error     string        `json:"error,omitempty"`
	// Body is the parsed /healthz response when present, or nil. The
	// agent currently returns a small status object that's useful in
	// the startup banner ("running, peers=2").
	Body *HealthBody `json:"body,omitempty"`
}

// HealthBody mirrors the subset of /healthz the manager actually
// renders. Unknown fields are ignored so additions to the agent are
// not breaking changes.
type HealthBody struct {
	Status    string `json:"status"`
	Running   bool   `json:"running"`
	PeerCount int    `json:"peer_count"`
}

// Prober wraps an *http.Client so callers can reuse a single
// connection pool across periodic probes.
type Prober struct {
	client *http.Client
	agent  string
	token  string
}

// New creates a Prober for the given agent base URL. timeout bounds
// the entire request including connection setup. tlsCfg selects the
// upstream-TLS posture for https:// agent URLs; nil means default
// verification against the system roots.
func New(agentURL, token string, timeout time.Duration, tlsCfg *tls.Config) *Prober {
	return &Prober{
		client: &http.Client{
			Timeout: timeout,
			Transport: &http.Transport{
				TLSClientConfig: tlsCfg,
			},
		},
		agent: strings.TrimRight(agentURL, "/"),
		token: token,
	}
}

// Health issues a single GET <agent>/healthz with the prober's
// configured timeout. It never panics; transport errors and non-2xx
// statuses both surface as Reachable=false with the reason in Error.
func (p *Prober) Health(ctx context.Context) Result {
	if p.agent == "" {
		return Result{Error: "agent URL is empty"}
	}
	start := time.Now()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, p.agent+"/healthz", nil)
	if err != nil {
		return Result{Error: err.Error()}
	}
	if p.token != "" {
		req.Header.Set("Authorization", "Bearer "+p.token)
	}
	resp, err := p.client.Do(req)
	if err != nil {
		return Result{Error: err.Error(), Latency: time.Since(start)}
	}
	defer resp.Body.Close()
	r := Result{Status: resp.StatusCode, Latency: time.Since(start)}
	if resp.StatusCode == http.StatusUnauthorized {
		r.Error = "HTTP 401 — bearer token rejected"
		return r
	}
	if resp.StatusCode >= 400 {
		r.Error = fmt.Sprintf("HTTP %d", resp.StatusCode)
		return r
	}
	r.Reachable = true
	var body HealthBody
	if err := json.NewDecoder(resp.Body).Decode(&body); err == nil {
		r.Body = &body
	}
	return r
}
