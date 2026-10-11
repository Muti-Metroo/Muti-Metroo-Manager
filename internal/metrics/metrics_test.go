package metrics

import (
	"bytes"
	"strings"
	"testing"
)

func TestCounterRender(t *testing.T) {
	r := New()
	c := r.NewCounter("requests_total", "Number of requests")
	c.Inc(map[string]string{"method": "GET", "status": "200"})
	c.With(map[string]string{"method": "GET", "status": "200"})(2)
	c.Inc(map[string]string{"method": "PUT", "status": "200"})
	var buf bytes.Buffer
	r.Render(&buf)
	out := buf.String()
	if !strings.Contains(out, "# HELP requests_total Number of requests\n") {
		t.Errorf("missing HELP: %q", out)
	}
	if !strings.Contains(out, "# TYPE requests_total counter\n") {
		t.Errorf("missing TYPE")
	}
	if !strings.Contains(out, `requests_total{method="GET",status="200"} 3`) {
		t.Errorf("expected 3 for GET/200; output: %s", out)
	}
	if !strings.Contains(out, `requests_total{method="PUT",status="200"} 1`) {
		t.Errorf("expected 1 for PUT/200; output: %s", out)
	}
}

func TestGauge(t *testing.T) {
	r := New()
	g := r.NewGauge("active", "Active connections", nil)
	g.Set(5)
	g.Add(2)
	g.Add(-3)
	var buf bytes.Buffer
	r.Render(&buf)
	if !strings.Contains(buf.String(), "active 4\n") {
		t.Errorf("expected 'active 4'; got: %s", buf.String())
	}
}

func TestGaugeFunc(t *testing.T) {
	r := New()
	r.NewGaugeFunc("reachable", "agent reachable", nil, func() float64 { return 1 })
	var buf bytes.Buffer
	r.Render(&buf)
	if !strings.Contains(buf.String(), "reachable 1\n") {
		t.Errorf("expected 'reachable 1'; got: %s", buf.String())
	}
}

func TestHistogram(t *testing.T) {
	r := New()
	h := r.NewHistogram("latency_seconds", "Latency", []float64{0.01, 0.1, 1.0})
	for _, v := range []float64{0.005, 0.05, 0.5, 5} {
		h.Observe(map[string]string{"path": "/x"}, v)
	}
	var buf bytes.Buffer
	r.Render(&buf)
	out := buf.String()
	for _, want := range []string{
		`latency_seconds_bucket{le="0.01",path="/x"} 1`,
		`latency_seconds_bucket{le="0.1",path="/x"} 2`,
		`latency_seconds_bucket{le="1",path="/x"} 3`,
		`latency_seconds_bucket{le="+Inf",path="/x"} 4`,
		`latency_seconds_count{path="/x"} 4`,
	} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q in output:\n%s", want, out)
		}
	}
}

func TestLabelEscaping(t *testing.T) {
	r := New()
	c := r.NewCounter("test", "x")
	c.Inc(map[string]string{"raw": `with "quote" and \backslash`})
	var buf bytes.Buffer
	r.Render(&buf)
	if !strings.Contains(buf.String(), `raw="with \"quote\" and \\backslash"`) {
		t.Errorf("escaping failed: %s", buf.String())
	}
}
