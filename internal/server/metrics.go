package server

import (
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/Muti-Metroo/Muti-Metroo-Manager/internal/metrics"
)

// instrumentation bundles the per-request metrics so middleware
// can record them in one place.
type instrumentation struct {
	requests *metrics.Counter
	duration *metrics.Histogram

	// reqInc / durObs cache the per-(method,route,status) and
	// per-route closures returned by Counter.With / Histogram.Observe
	// so the request hot path skips the registry-internal mutex on
	// repeat triples (which is every triple after the first).
	mu       sync.RWMutex
	reqInc   map[string]func(uint64)
	durRoute map[string]map[string]string
}

// newInstrumentation registers the request-side metrics. The bucket
// list extends Prometheus' default with 30s/60s for the file-transfer
// paths' long timeouts.
func newInstrumentation(reg *metrics.Registry) *instrumentation {
	if reg == nil {
		return nil
	}
	return &instrumentation{
		requests: reg.NewCounter("metroo_manager_requests_total",
			"Total HTTP requests handled, labelled by method, route, and status."),
		duration: reg.NewHistogram("metroo_manager_request_duration_seconds",
			"Latency of HTTP requests in seconds.",
			[]float64{0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60}),
		reqInc:   map[string]func(uint64){},
		durRoute: map[string]map[string]string{},
	}
}

// observe records one finished request. The first time a given
// (method, route, status) triple appears it pays one Counter.With
// allocation; afterwards the cached closure is reused under an
// RLock so concurrent requests don't serialise.
func (in *instrumentation) observe(method, route, status string, latency float64) {
	key := method + " " + route + " " + status
	in.mu.RLock()
	inc, ok := in.reqInc[key]
	durLabels := in.durRoute[route]
	in.mu.RUnlock()
	if !ok || durLabels == nil {
		in.mu.Lock()
		if inc = in.reqInc[key]; inc == nil {
			inc = in.requests.With(map[string]string{"method": method, "route": route, "status": status})
			in.reqInc[key] = inc
		}
		if durLabels = in.durRoute[route]; durLabels == nil {
			durLabels = map[string]string{"route": route}
			in.durRoute[route] = durLabels
		}
		in.mu.Unlock()
	}
	inc(1)
	in.duration.Observe(durLabels, latency)
}

// instrumentMiddleware records request count + latency. It must sit
// outside accessLog so both observers see the same final status and
// inside CORS so preflight OPTIONS requests are also counted. The
// statusRecorder it installs is reused by accessLog (see middleware.go)
// so a request pays for one wrapper, not two.
func instrumentMiddleware(inst *instrumentation, next http.Handler) http.Handler {
	if inst == nil {
		return next
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ww := &statusRecorder{ResponseWriter: w, status: 200}
		start := time.Now()
		defer func() {
			inst.observe(methodLabel(r.Method), routeLabel(r.URL.Path), strconv.Itoa(ww.status),
				time.Since(start).Seconds())
		}()
		next.ServeHTTP(ww, r)
	})
}

// methodLabel whitelists the HTTP methods the manager's routes actually
// use; anything else lands in OTHER. Combined with routeLabel this keeps
// the per-request series count bounded — a client cycling exotic verbs
// would otherwise mint a new counter series per verb.
func methodLabel(method string) string {
	switch method {
	case http.MethodGet, http.MethodHead, http.MethodPost, http.MethodPut,
		http.MethodPatch, http.MethodDelete, http.MethodOptions,
		"PROPFIND", "PROPPATCH", "MKCOL", "COPY", "MOVE", "LOCK", "UNLOCK":
		return method
	}
	return "OTHER"
}

// routeLabel collapses high-cardinality URL paths so series count
// stays bounded — without this every agent id under /api/proxy/...
// becomes its own series.
func routeLabel(path string) string {
	switch path {
	case "/healthz", "/api/settings", "/api/agent-meta", "/api/shares":
		return path
	}
	switch {
	case strings.HasPrefix(path, "/api/agent-meta/"):
		return "/api/agent-meta/:id"
	case strings.HasPrefix(path, "/api/proxy/"):
		return "/api/proxy/*"
	case strings.HasPrefix(path, "/api/shares/"):
		return "/api/shares/:id"
	case strings.HasPrefix(path, "/dav/"):
		return "/dav/*"
	}
	return "other"
}

// metricsHandler exposes /metrics in Prometheus text format.
func metricsHandler(reg *metrics.Registry) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
		w.WriteHeader(http.StatusOK)
		reg.Render(w)
	})
}
