package agenttls

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestConfigDefaultsToSystemRoots(t *testing.T) {
	cfg, err := Config("", false)
	if err != nil {
		t.Fatalf("Config: %v", err)
	}
	if cfg != nil {
		t.Errorf("Config() = %+v, want nil (system roots, verification on)", cfg)
	}
}

func TestConfigInsecure(t *testing.T) {
	cfg, err := Config("", true)
	if err != nil {
		t.Fatalf("Config: %v", err)
	}
	if cfg == nil || !cfg.InsecureSkipVerify {
		t.Errorf("Config(insecure) = %+v, want InsecureSkipVerify", cfg)
	}
}

func TestConfigCABundle(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "ca.pem")
	if err := os.WriteFile(path, selfSignedCertPEM(t), 0o644); err != nil {
		t.Fatal(err)
	}
	cfg, err := Config(path, false)
	if err != nil {
		t.Fatalf("Config: %v", err)
	}
	if cfg == nil || cfg.RootCAs == nil {
		t.Fatal("Config(bundle) returned no RootCAs")
	}
	if cfg.InsecureSkipVerify {
		t.Error("InsecureSkipVerify must stay off when a CA bundle is given")
	}
}

func TestConfigCABundleMissing(t *testing.T) {
	if _, err := Config(filepath.Join(t.TempDir(), "nope.pem"), false); err == nil {
		t.Fatal("expected error for missing bundle")
	}
}

func TestConfigCABundleNotPEM(t *testing.T) {
	path := filepath.Join(t.TempDir(), "ca.pem")
	if err := os.WriteFile(path, []byte("not a pem"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := Config(path, false); err == nil {
		t.Fatal("expected error for bundle without certificates")
	}
}

// selfSignedCertPEM generates a throwaway self-signed CA certificate
// and returns its PEM encoding.
func selfSignedCertPEM(t *testing.T) []byte {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tpl := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: "test-ca"},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(time.Hour),
		IsCA:                  true,
		KeyUsage:              x509.KeyUsageCertSign,
		BasicConstraintsValid: true,
	}
	der, err := x509.CreateCertificate(rand.Reader, tpl, tpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	return pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
}
