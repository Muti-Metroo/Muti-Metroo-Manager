package cli

import (
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"

	"github.com/postalsys/muti-metroo-manager/internal/agentprobe"
	"github.com/postalsys/muti-metroo-manager/internal/config"
	"github.com/postalsys/muti-metroo-manager/internal/downloads"
)

// runCheck validates config, probes the data dir, and pings
// /healthz. Exit 0 = ok, 1 = environment failure (agent down,
// data-dir unwritable), 2 = operator misuse (bad flags or config).
func runCheck(args []string, build Build, stdout, stderr io.Writer) int {
	lf := config.NewLoadFlags("muti-metroo-manager check", stderr)
	lf.FlagSet().Usage = func() {
		fmt.Fprintln(stderr, "usage: muti-metroo-manager check [flags]")
		fmt.Fprintln(stderr, "Validates configuration, data dir, and agent reachability.")
		fmt.Fprintln(stderr)
		lf.FlagSet().PrintDefaults()
	}
	if err := lf.Parse(args); err != nil {
		if msg := errorString(err); msg != "" {
			fmt.Fprintln(stderr, msg)
		}
		return 2
	}
	res, err := lf.Resolve()
	if err != nil {
		fmt.Fprintf(stderr, "config: %v\n", err)
		return 2
	}
	for _, w := range res.Warnings {
		fmt.Fprintf(stderr, "warn: %s\n", w)
	}

	failed := 0

	// 1. Data dir writability.
	if err := probeDataDir(res.Config.DataDir); err != nil {
		fmt.Fprintf(stdout, "data-dir: FAIL  %s (%v)\n", res.Config.DataDir, err)
		failed++
	} else {
		fmt.Fprintf(stdout, "data-dir: OK    %s\n", res.Config.DataDir)
	}

	// 2. Downloads bundle (only fatal when explicitly set).
	bundlePath, bundleStatus := downloads.ResolvePath(res.Config.DownloadsBundle, res.Config.NoDownloads)
	switch bundleStatus {
	case downloads.PathAbsentExplicit:
		fmt.Fprintf(stdout, "bundle:   FAIL  %s (missing — explicitly set but not found)\n", bundlePath)
		failed++
	case downloads.PathPresent:
		fmt.Fprintf(stdout, "bundle:   OK    %s (present)\n", bundlePath)
	case downloads.PathDisabled:
		fmt.Fprintln(stdout, "bundle:   OK    (disabled)")
	default:
		fmt.Fprintln(stdout, "bundle:   OK    (none — feature off)")
	}

	// 3. Agent reachability.
	agentStatus, agentDetail := probeAgent(res.Config.Agent, res.Config.AgentToken)
	if agentStatus {
		fmt.Fprintf(stdout, "agent:    OK    %s (%s)\n", res.Config.Agent, agentDetail)
	} else {
		fmt.Fprintf(stdout, "agent:    FAIL  %s (%s)\n", res.Config.Agent, agentDetail)
		failed++
	}

	if failed == 0 {
		fmt.Fprintln(stdout, "check:    OK")
		return 0
	}
	fmt.Fprintf(stdout, "check:    FAIL (%d failure%s)\n", failed, pluralS(failed))
	return 1
}

// probeDataDir creates the directory if missing and writes/reads a
// tiny sentinel file to confirm we have actual write permission (not
// just `mkdir succeeded because root`).
func probeDataDir(dir string) error {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("mkdir: %w", err)
	}
	probe := filepath.Join(dir, ".muti-metroo-manager-write-probe")
	if err := os.WriteFile(probe, []byte("ok"), 0o600); err != nil {
		return fmt.Errorf("write: %w", err)
	}
	if err := os.Remove(probe); err != nil {
		return fmt.Errorf("cleanup: %w", err)
	}
	return nil
}

// probeAgent runs a single /healthz request through the shared
// Prober. The 5s budget belongs to the http.Client; an extra
// context.WithTimeout on top would just duplicate that.
func probeAgent(agentURL, token string) (bool, string) {
	r := agentprobe.New(agentURL, token, 5*time.Second).Health(context.Background())
	if !r.Reachable {
		if r.Error != "" {
			return false, r.Error
		}
		return false, fmt.Sprintf("HTTP %d", r.Status)
	}
	return true, fmt.Sprintf("HTTP %d in %s", r.Status, r.Latency.Round(time.Millisecond))
}

func pluralS(n int) string {
	if n == 1 {
		return ""
	}
	return "s"
}
