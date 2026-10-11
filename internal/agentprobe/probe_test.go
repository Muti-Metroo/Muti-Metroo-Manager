package agentprobe

import (
	"context"
	"encoding/pem"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/postalsys/muti-metroo-manager/internal/agenttls"
)

// Regression: probing an https agent must verify the certificate by
// default, accept it when the operator supplies the signing CA via a
// bundle, and only skip verification with the explicit insecure flag.
func TestProbeTLSVerification(t *testing.T) {
	agent := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"status":"running","running":true}`))
	}))
	defer agent.Close()

	bundlePath := filepath.Join(t.TempDir(), "ca.pem")
	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: agent.Certificate().Raw})
	if err := os.WriteFile(bundlePath, certPEM, 0o644); err != nil {
		t.Fatal(err)
	}

	t.Run("default verification rejects self-signed", func(t *testing.T) {
		cfg, err := agenttls.Config("", false)
		if err != nil {
			t.Fatal(err)
		}
		r := New(agent.URL, "", 2*time.Second, cfg).Health(context.Background())
		if r.Reachable {
			t.Fatal("self-signed agent must be unreachable with default verification")
		}
	})

	t.Run("CA bundle verifies self-signed", func(t *testing.T) {
		cfg, err := agenttls.Config(bundlePath, false)
		if err != nil {
			t.Fatal(err)
		}
		r := New(agent.URL, "", 2*time.Second, cfg).Health(context.Background())
		if !r.Reachable {
			t.Fatalf("agent with bundled CA must be reachable, got error %q", r.Error)
		}
	})

	t.Run("insecure escape hatch connects", func(t *testing.T) {
		cfg, err := agenttls.Config("", true)
		if err != nil {
			t.Fatal(err)
		}
		r := New(agent.URL, "", 2*time.Second, cfg).Health(context.Background())
		if !r.Reachable {
			t.Fatalf("insecure probe must connect, got error %q", r.Error)
		}
	})
}
