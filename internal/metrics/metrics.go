// Package metrics is a minimal Prometheus-text exporter (counters,
// gauges, fixed-bucket histograms). Hand-rolled because client_golang
// pulls nine transitive deps — too much for the four metrics we need.
// Format: https://prometheus.io/docs/instrumenting/exposition_formats/
package metrics

import (
	"fmt"
	"io"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
)

// Registry collects metric series and renders them in Prometheus text
// format. Safe for concurrent use.
type Registry struct {
	mu       sync.RWMutex
	counters []*Counter
	gauges   []*Gauge
	histos   []*Histogram
	gaugeFns []*GaugeFunc
}

// New returns an empty Registry. The constructor takes no arguments
// because all wiring (label values, names, help) happens at metric
// creation time, not at registry creation time.
func New() *Registry {
	return &Registry{}
}

// labelKey is the canonical string used to identify a series within a
// metric — sorted "k=v,k=v" pairs. Sorted so the same logical label
// set always maps to the same key regardless of declaration order.
func labelKey(labels map[string]string) string {
	if len(labels) == 0 {
		return ""
	}
	keys := make([]string, 0, len(labels))
	for k := range labels {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var b strings.Builder
	for i, k := range keys {
		if i > 0 {
			b.WriteByte(',')
		}
		b.WriteString(k)
		b.WriteByte('=')
		b.WriteString(escapeLabel(labels[k]))
	}
	return b.String()
}

// escapeLabel escapes the small set of characters Prometheus requires
// (\, ", and newline). Label values are otherwise free-form UTF-8.
func escapeLabel(v string) string {
	if !strings.ContainsAny(v, `\"`+"\n") {
		return v
	}
	var b strings.Builder
	b.Grow(len(v) + 4)
	for i := 0; i < len(v); i++ {
		switch v[i] {
		case '\\':
			b.WriteString(`\\`)
		case '"':
			b.WriteString(`\"`)
		case '\n':
			b.WriteString(`\n`)
		default:
			b.WriteByte(v[i])
		}
	}
	return b.String()
}

// renderLabels writes the {k="v",...} block. Empty label sets render
// as nothing.
func renderLabels(w io.Writer, labels map[string]string) {
	if len(labels) == 0 {
		return
	}
	keys := make([]string, 0, len(labels))
	for k := range labels {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	fmt.Fprint(w, "{")
	for i, k := range keys {
		if i > 0 {
			fmt.Fprint(w, ",")
		}
		fmt.Fprintf(w, `%s="%s"`, k, escapeLabel(labels[k]))
	}
	fmt.Fprint(w, "}")
}

// Counter is a monotonically increasing series. Series within a
// counter are keyed by their label set; calling With on the same
// label set returns the same atomic value.
type Counter struct {
	name, help string
	mu         sync.Mutex
	series     map[string]*counterSeries
}

type counterSeries struct {
	labels map[string]string
	v      atomic.Uint64
}

// NewCounter registers a counter under name with the given help text.
// Help is shown in `# HELP` lines so dashboards can surface meaning.
func (r *Registry) NewCounter(name, help string) *Counter {
	c := &Counter{name: name, help: help, series: map[string]*counterSeries{}}
	r.mu.Lock()
	r.counters = append(r.counters, c)
	r.mu.Unlock()
	return c
}

// With returns the (possibly newly-created) series for the given
// label set. The returned function increments the underlying counter
// — the function form lets hot paths cache the lookup.
func (c *Counter) With(labels map[string]string) func(uint64) {
	key := labelKey(labels)
	c.mu.Lock()
	s, ok := c.series[key]
	if !ok {
		s = &counterSeries{labels: copyLabels(labels)}
		c.series[key] = s
	}
	c.mu.Unlock()
	return func(n uint64) { s.v.Add(n) }
}

// Inc is a convenience for With(labels)(1) when the caller doesn't
// need to cache the closure.
func (c *Counter) Inc(labels map[string]string) {
	c.With(labels)(1)
}

// Gauge is a value that can go up or down. Unlike Counter it doesn't
// track per-label series in the registry — callers create one Gauge
// per label set when they need labels (rare for our use case).
type Gauge struct {
	name, help string
	v          atomic.Int64
	labels     map[string]string
}

// NewGauge registers a gauge. The Set/Add API uses int64 because all
// our gauges (active connections, reachability) are integers.
func (r *Registry) NewGauge(name, help string, labels map[string]string) *Gauge {
	g := &Gauge{name: name, help: help, labels: copyLabels(labels)}
	r.mu.Lock()
	r.gauges = append(r.gauges, g)
	r.mu.Unlock()
	return g
}

// Set replaces the gauge's value.
func (g *Gauge) Set(v int64) { g.v.Store(v) }

// Add atomically adjusts the gauge's value. Negative deltas decrement.
func (g *Gauge) Add(d int64) { g.v.Add(d) }

// GaugeFunc is a gauge whose value is sampled at scrape time by
// calling a supplied function. Useful for state already maintained
// elsewhere (e.g. agent-reachability cache) that we don't want to
// double-track.
type GaugeFunc struct {
	name, help string
	labels     map[string]string
	fn         func() float64
}

// NewGaugeFunc registers a sampled gauge.
func (r *Registry) NewGaugeFunc(name, help string, labels map[string]string, fn func() float64) *GaugeFunc {
	g := &GaugeFunc{name: name, help: help, labels: copyLabels(labels), fn: fn}
	r.mu.Lock()
	r.gaugeFns = append(r.gaugeFns, g)
	r.mu.Unlock()
	return g
}

// Histogram is a fixed-bucket histogram. Buckets must be strictly
// increasing; +Inf is appended automatically.
type Histogram struct {
	name, help string
	buckets    []float64
	mu         sync.Mutex
	series     map[string]*histoSeries
}

type histoSeries struct {
	labels map[string]string
	counts []atomic.Uint64 // len == len(buckets)+1 (the +Inf overflow)
	sum    atomicFloat
	count  atomic.Uint64
}

// NewHistogram registers a histogram. Callers Observe values and the
// renderer emits *_bucket{le="..."}, *_sum, *_count.
func (r *Registry) NewHistogram(name, help string, buckets []float64) *Histogram {
	dst := make([]float64, len(buckets))
	copy(dst, buckets)
	h := &Histogram{name: name, help: help, buckets: dst, series: map[string]*histoSeries{}}
	r.mu.Lock()
	r.histos = append(r.histos, h)
	r.mu.Unlock()
	return h
}

// Observe records a single value into the series for the given label
// set. O(buckets) per observation, which for our 8-bucket histograms
// is fast enough to call in the request hot path.
func (h *Histogram) Observe(labels map[string]string, v float64) {
	key := labelKey(labels)
	h.mu.Lock()
	s, ok := h.series[key]
	if !ok {
		s = &histoSeries{
			labels: copyLabels(labels),
			counts: make([]atomic.Uint64, len(h.buckets)+1),
		}
		h.series[key] = s
	}
	h.mu.Unlock()
	for i, b := range h.buckets {
		if v <= b {
			s.counts[i].Add(1)
		}
	}
	s.counts[len(h.buckets)].Add(1) // +Inf
	s.sum.add(v)
	s.count.Add(1)
}

// Render writes every registered metric in Prometheus text format.
func (r *Registry) Render(w io.Writer) {
	r.mu.RLock()
	defer r.mu.RUnlock()

	for _, c := range r.counters {
		fmt.Fprintf(w, "# HELP %s %s\n# TYPE %s counter\n", c.name, c.help, c.name)
		c.mu.Lock()
		for _, s := range c.series {
			fmt.Fprint(w, c.name)
			renderLabels(w, s.labels)
			fmt.Fprintf(w, " %d\n", s.v.Load())
		}
		c.mu.Unlock()
	}
	for _, g := range r.gauges {
		fmt.Fprintf(w, "# HELP %s %s\n# TYPE %s gauge\n", g.name, g.help, g.name)
		fmt.Fprint(w, g.name)
		renderLabels(w, g.labels)
		fmt.Fprintf(w, " %d\n", g.v.Load())
	}
	for _, g := range r.gaugeFns {
		fmt.Fprintf(w, "# HELP %s %s\n# TYPE %s gauge\n", g.name, g.help, g.name)
		fmt.Fprint(w, g.name)
		renderLabels(w, g.labels)
		fmt.Fprintf(w, " %g\n", g.fn())
	}
	for _, h := range r.histos {
		fmt.Fprintf(w, "# HELP %s %s\n# TYPE %s histogram\n", h.name, h.help, h.name)
		h.mu.Lock()
		for _, s := range h.series {
			for i, b := range h.buckets {
				labels := mergeLabel(s.labels, "le", fmt.Sprintf("%g", b))
				fmt.Fprintf(w, "%s_bucket", h.name)
				renderLabels(w, labels)
				fmt.Fprintf(w, " %d\n", s.counts[i].Load())
			}
			labels := mergeLabel(s.labels, "le", "+Inf")
			fmt.Fprintf(w, "%s_bucket", h.name)
			renderLabels(w, labels)
			fmt.Fprintf(w, " %d\n", s.counts[len(h.buckets)].Load())

			fmt.Fprintf(w, "%s_sum", h.name)
			renderLabels(w, s.labels)
			fmt.Fprintf(w, " %g\n", s.sum.load())

			fmt.Fprintf(w, "%s_count", h.name)
			renderLabels(w, s.labels)
			fmt.Fprintf(w, " %d\n", s.count.Load())
		}
		h.mu.Unlock()
	}
}

func copyLabels(in map[string]string) map[string]string {
	if in == nil {
		return nil
	}
	out := make(map[string]string, len(in))
	for k, v := range in {
		out[k] = v
	}
	return out
}

func mergeLabel(in map[string]string, k, v string) map[string]string {
	out := make(map[string]string, len(in)+1)
	for kk, vv := range in {
		out[kk] = vv
	}
	out[k] = v
	return out
}

// atomicFloat lets us sum float64 observations atomically using
// atomic.Uint64 + math.Float64bits/Float64frombits style swapping.
type atomicFloat struct {
	bits atomic.Uint64
}

func (a *atomicFloat) add(v float64) {
	for {
		old := a.bits.Load()
		nf := float64FromBits(old) + v
		if a.bits.CompareAndSwap(old, float64ToBits(nf)) {
			return
		}
	}
}

func (a *atomicFloat) load() float64 {
	return float64FromBits(a.bits.Load())
}
