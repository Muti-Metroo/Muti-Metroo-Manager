package server

import (
	"testing"
	"time"

	"github.com/postalsys/muti-metroo-manager/internal/metrics"
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
