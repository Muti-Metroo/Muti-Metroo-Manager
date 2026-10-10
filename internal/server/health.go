package server

import (
	"context"
	"encoding/json"
	"net/http"
	"sync/atomic"
	"time"

	"github.com/postalsys/muti-metroo-manager/internal/agentprobe"
)

// healthCache periodically probes the agent so /healthz can answer in
// constant time without piling up requests on a slow agent. The
// cached snapshot ages out after refreshInterval; a stale-cache flag
// is exposed so monitoring can distinguish "hadn't refreshed yet" from
// "agent currently down."
type healthCache struct {
	prober          *agentprobe.Prober
	version         string
	refreshInterval time.Duration
	timeout         time.Duration

	last atomic.Pointer[healthSnapshot]
}

type healthSnapshot struct {
	At        time.Time
	Reachable bool
	Status    int
	Latency   time.Duration
	Error     string
}

func newHealthCache(prober *agentprobe.Prober, version string) *healthCache {
	hc := &healthCache{
		prober:          prober,
		version:         version,
		refreshInterval: 5 * time.Second,
		timeout:         3 * time.Second,
	}
	hc.last.Store(&healthSnapshot{})
	return hc
}

// snapshot returns the most recent reachability info, refreshing the
// cache on demand if it's older than refreshInterval. Concurrent
// callers may briefly trigger overlapping probes — preferable to
// holding a lock across a network round trip.
func (h *healthCache) snapshot(ctx context.Context) *healthSnapshot {
	if h == nil || h.prober == nil {
		return &healthSnapshot{Error: "agent probe disabled"}
	}
	last := h.last.Load()
	if !last.At.IsZero() && time.Since(last.At) < h.refreshInterval {
		return last
	}
	probeCtx, cancel := context.WithTimeout(ctx, h.timeout)
	defer cancel()
	r := h.prober.Health(probeCtx)
	snap := &healthSnapshot{
		At:        time.Now(),
		Reachable: r.Reachable,
		Status:    r.Status,
		Latency:   r.Latency,
		Error:     r.Error,
	}
	h.last.Store(snap)
	return snap
}

// reachableGauge reports the metroo_manager_agent_reachable value from
// the cache so a tight Prometheus interval can't drive extra agent
// traffic.
func (h *healthCache) reachableGauge() float64 {
	last := h.last.Load()
	if last.At.IsZero() || !last.Reachable {
		return 0
	}
	return 1
}

// seed primes the cache with a result from the startup probe so
// /healthz and /metrics return meaningful data before the first
// scrape arrives.
func (h *healthCache) seed(r agentprobe.Result) {
	h.last.Store(&healthSnapshot{
		At:        time.Now(),
		Reachable: r.Reachable,
		Status:    r.Status,
		Latency:   r.Latency,
		Error:     r.Error,
	})
}

type healthzResponse struct {
	Status          string `json:"status"`
	Version         string `json:"version"`
	AgentReachable  bool   `json:"agent_reachable"`
	AgentStatus     int    `json:"agent_status,omitempty"`
	AgentLatencyMs  int64  `json:"agent_latency_ms,omitempty"`
	AgentError      string `json:"agent_error,omitempty"`
	AgentCheckedAgo int64  `json:"agent_checked_ago_s,omitempty"`
}

// healthzHandler returns JSON describing the manager's own health and
// the cached upstream-agent reachability. The endpoint always returns
// 200 so monitoring can scrape regardless of agent state — the body
// carries the actual status. (A future flag may switch to 503 when
// agent is unreachable for stricter blackbox checks.)
func healthzHandler(hc *healthCache) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		snap := hc.snapshot(r.Context())
		ver := hc.version
		if ver == "" {
			ver = "dev"
		}
		resp := healthzResponse{
			Status:         "ok",
			Version:        ver,
			AgentReachable: snap.Reachable,
			AgentStatus:    snap.Status,
			AgentError:     snap.Error,
		}
		if snap.Latency > 0 {
			resp.AgentLatencyMs = snap.Latency.Milliseconds()
		}
		if !snap.At.IsZero() {
			resp.AgentCheckedAgo = int64(time.Since(snap.At).Seconds())
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(resp)
	})
}
