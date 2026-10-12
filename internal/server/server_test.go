package server

import (
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/Muti-Metroo/Muti-Metroo-Manager/internal/metrics"
	"github.com/Muti-Metroo/Muti-Metroo-Manager/internal/store"
)

// Regression: both listeners must carry Slowloris timeouts.
// WriteTimeout stays zero on purpose — it would kill hijacked
// WebSocket relays and long file-transfer streams.
func TestServerTimeouts(t *testing.T) {
	srv, _ := New(Options{Addr: "127.0.0.1:0", AgentURL: "http://127.0.0.1:8080"})
	if srv.ReadHeaderTimeout != 10*time.Second {
		t.Errorf("ReadHeaderTimeout = %v, want 10s", srv.ReadHeaderTimeout)
	}
	if srv.IdleTimeout != 120*time.Second {
		t.Errorf("IdleTimeout = %v, want 120s", srv.IdleTimeout)
	}
	if srv.WriteTimeout != 0 {
		t.Errorf("WriteTimeout = %v, want 0 (would break WebSocket hijack + long downloads)", srv.WriteTimeout)
	}

	mSrv := MetricsServer("127.0.0.1:0", metrics.New())
	if mSrv == nil {
		t.Fatal("MetricsServer returned nil")
	}
	if mSrv.ReadHeaderTimeout != 10*time.Second {
		t.Errorf("metrics ReadHeaderTimeout = %v, want 10s", mSrv.ReadHeaderTimeout)
	}
	if mSrv.IdleTimeout != 120*time.Second {
		t.Errorf("metrics IdleTimeout = %v, want 120s", mSrv.IdleTimeout)
	}
	if mSrv.WriteTimeout != 0 {
		t.Errorf("metrics WriteTimeout = %v, want 0", mSrv.WriteTimeout)
	}
}

// Regression: JSON-decoding endpoints must reject oversized bodies
// with 413 rather than reading unbounded input.
func TestMaxJSONBody(t *testing.T) {
	huge := `{"note":"` + strings.Repeat("x", maxJSONBody) + `"}`

	st, err := store.Open(t.TempDir())
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { st.Close() })

	cases := []struct {
		name    string
		handler http.Handler
		path    string
	}{
		{"settings", settingsHandler(st, slog.Default(), false), "/api/settings"},
		{"agent-meta", agentMetaItemHandler(st, slog.Default()), "/api/agent-meta/0123456789abcdef0123456789abcdef"},
		{"networks", networkItemHandler(st, slog.Default()), "/api/networks/prod"},
		{"positions", positionsHandler(st, slog.Default()), "/api/positions"},
	}
	for _, tc := range cases {
		t.Run(tc.name+" rejects oversized body", func(t *testing.T) {
			r := httptest.NewRequest(http.MethodPut, tc.path, strings.NewReader(huge))
			rec := httptest.NewRecorder()
			tc.handler.ServeHTTP(rec, r)
			if rec.Code != http.StatusRequestEntityTooLarge {
				t.Fatalf("status = %d, want 413", rec.Code)
			}
		})
		t.Run(tc.name+" accepts normal body", func(t *testing.T) {
			r := httptest.NewRequest(http.MethodPut, tc.path, strings.NewReader(`{}`))
			rec := httptest.NewRecorder()
			tc.handler.ServeHTTP(rec, r)
			if rec.Code == http.StatusRequestEntityTooLarge {
				t.Fatal("small body rejected as too large")
			}
		})
	}
}
