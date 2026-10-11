// Package agenttls builds the *tls.Config shared by the reverse proxy
// and the agent prober so both follow the same upstream-TLS posture:
// verified by default, an optional extra CA bundle for agents with
// self-signed certificates, and an explicit insecure escape hatch.
package agenttls

import (
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"os"
)

// Config returns the TLS client configuration for talking to the
// agent. A nil config (the default) means "verify with the system
// roots". caBundle points at a PEM file whose certificates are added
// on top of the system pool — the supported way to reach agents with
// self-signed or private-CA certificates. insecure disables
// verification entirely; callers must surface a loud warning when it
// is set.
func Config(caBundle string, insecure bool) (*tls.Config, error) {
	if insecure {
		return &tls.Config{InsecureSkipVerify: true}, nil
	}
	if caBundle == "" {
		return nil, nil
	}
	pool, err := x509.SystemCertPool()
	if err != nil {
		// SystemCertPool can fail on exotic platforms; fall back to an
		// empty pool so the bundle still works on its own.
		pool = x509.NewCertPool()
	}
	pem, err := os.ReadFile(caBundle)
	if err != nil {
		return nil, fmt.Errorf("read agent CA bundle: %w", err)
	}
	if !pool.AppendCertsFromPEM(pem) {
		return nil, fmt.Errorf("agent CA bundle %s contains no PEM certificates", caBundle)
	}
	return &tls.Config{RootCAs: pool}, nil
}
