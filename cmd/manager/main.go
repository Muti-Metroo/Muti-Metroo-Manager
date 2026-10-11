package main

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"runtime"
	"strings"
	"syscall"
	"time"

	"github.com/postalsys/muti-metroo-manager/internal/agentprobe"
	"github.com/postalsys/muti-metroo-manager/internal/agenttls"
	"github.com/postalsys/muti-metroo-manager/internal/cli"
	"github.com/postalsys/muti-metroo-manager/internal/config"
	"github.com/postalsys/muti-metroo-manager/internal/downloads"
	"github.com/postalsys/muti-metroo-manager/internal/logging"
	"github.com/postalsys/muti-metroo-manager/internal/metrics"
	"github.com/postalsys/muti-metroo-manager/internal/server"
	"github.com/postalsys/muti-metroo-manager/internal/store"
)

// Version is stamped in by the linker via -ldflags "-X main.Version=...".
var Version = "dev"

func main() {
	build := cli.Build{
		Version: Version,
		Commit:  "",
		GoVer:   runtime.Version(),
	}
	os.Exit(cli.Dispatch(os.Args[1:], build, runServer, os.Stdout, os.Stderr))
}

// runServer is the long-running command: parse flags, take the
// instance lock, open the store + downloads bundle, start the HTTP
// server, and block on SIGINT/SIGTERM.
func runServer(args []string) int {
	lf := config.NewLoadFlags("muti-metroo-manager", os.Stderr)
	lf.FlagSet().Usage = func() {
		printRunUsage(lf, os.Stderr)
	}
	if err := lf.Parse(args); err != nil {
		return 2
	}
	res, err := lf.Resolve()
	if err != nil {
		fmt.Fprintf(os.Stderr, "config: %v\n", err)
		return 2
	}
	cfg := res.Config

	level, levelOK := logging.ParseLevel(cfg.LogLevel)
	format, formatOK := logging.ParseFormat(cfg.LogFormat)
	logger := logging.Configure(os.Stderr, level, format)
	if !levelOK {
		logger.Warn("unknown log level; falling back to info", slog.String("requested", cfg.LogLevel))
	}
	if !formatOK {
		logger.Warn("unknown log format; falling back to text", slog.String("requested", cfg.LogFormat))
	}
	for _, w := range res.Warnings {
		logger.Warn(w)
	}

	if cfg.AuthToken == "" {
		if !cfg.InsecureNoAuth && !server.BindsLoopbackOnly(cfg.Addr) {
			fmt.Fprintf(os.Stderr,
				"refusing to start: no manager auth token configured and %s is not a loopback address.\n"+
					"Set -auth-token-file (or "+config.EnvAuthToken+") so the /api/* routes — including the\n"+
					"agent proxy with remote shell and file transfer — require authentication, or pass\n"+
					"-insecure-no-auth to run an unauthenticated listener on a non-loopback address.\n",
				cfg.Addr)
			return 2
		}
		logger.Warn("manager auth token is NOT set: all /api/* endpoints (including the agent proxy, "+
			"remote shell, and file transfer) are UNAUTHENTICATED — set -auth-token-file or "+
			config.EnvAuthToken+" before exposing this listener",
			slog.String("addr", cfg.Addr),
			slog.Bool("insecure_no_auth", cfg.InsecureNoAuth),
		)
	}

	lock, err := store.AcquireInstanceLock(cfg.DataDir)
	if err != nil {
		logger.Error("acquire lock", slog.String("err", err.Error()))
		return 1
	}
	defer lock.Release()

	st, err := store.Open(cfg.DataDir)
	if err != nil {
		logger.Error("open store", slog.String("err", err.Error()))
		return 1
	}
	defer st.Close()

	bundle, bundleSrc, bundleDisabled := openDownloadsBundle(cfg, logger)
	defer bundle.Close()

	agentTLS, err := agenttls.Config(cfg.AgentCABundle, cfg.InsecureSkipVerify)
	if err != nil {
		logger.Error("agent TLS config", slog.String("err", err.Error()))
		return 1
	}
	if cfg.InsecureSkipVerify {
		logger.Warn("TLS certificate verification for the agent is DISABLED (-insecure-skip-verify): "+
			"the agent bearer token is MITM-able over https agent URLs — prefer -agent-ca-bundle",
			slog.String("agent", cfg.Agent),
		)
	}

	prober := agentprobe.New(cfg.Agent, cfg.AgentToken, 5*time.Second, agentTLS)
	// Run the probe concurrently so a slow/unreachable agent doesn't
	// add 5s to startup. The banner waits up to 1s for a fresh
	// answer; anything later is an "unknown" result the operator can
	// re-check via /healthz.
	probeCh := make(chan agentprobe.Result, 1)
	go func() { probeCh <- prober.Health(context.Background()) }()

	var metricsReg *metrics.Registry
	if cfg.MetricsAddr != "" {
		metricsReg = metrics.New()
	}

	srv, seedHealth := server.New(server.Options{
		Addr:         cfg.Addr,
		AgentURL:     cfg.Agent,
		AgentToken:   cfg.AgentToken,
		AuthToken:    cfg.AuthToken,
		TLSConfig:    agentTLS,
		Store:        st,
		Bundle:       bundle,
		Version:      Version,
		AgentProber:  prober,
		Logger:       logger,
		Metrics:      metricsReg,
		SoundsLocked: cfg.NoSounds,
	})

	metricsSrv := server.MetricsServer(cfg.MetricsAddr, metricsReg)
	metricsErrCh := make(chan error, 1)
	if metricsSrv != nil {
		go func() {
			logger.Info("metrics listener", slog.String("addr", cfg.MetricsAddr))
			metricsErrCh <- metricsSrv.ListenAndServe()
		}()
	}

	serveErrCh := make(chan error, 1)
	go func() {
		var probe agentprobe.Result
		select {
		case probe = <-probeCh:
			seedHealth(probe)
			// keep the cache fresh once the probe finally lands if
			// we showed a "still running" banner above
		case <-time.After(time.Second):
			probe = agentprobe.Result{Error: "probe still running"}
			go func() { seedHealth(<-probeCh) }()
		}
		printStartupBanner(logger, bannerInputs{
			cfg:            cfg,
			store:          st,
			lock:           lock,
			bundle:         bundle,
			bundlePath:     bundleSrc,
			bundleDisabled: bundleDisabled,
			probe:          probe,
		})
		serveErrCh <- srv.ListenAndServe()
	}()

	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)

	// A serve error before any signal (e.g. address already in use) is a
	// startup failure: report it and exit non-zero through the normal
	// return path so the deferred store/lock cleanup runs.
	select {
	case err := <-serveErrCh:
		if err != nil && err != http.ErrServerClosed {
			logger.Error("server error", slog.String("err", err.Error()))
			return 1
		}
		return 0
	case err := <-metricsErrCh:
		if err != nil && err != http.ErrServerClosed {
			logger.Error("metrics server error", slog.String("err", err.Error()))
			return 1
		}
		return 0
	case sig := <-quit:
		logger.Info("shutting down", slog.String("signal", sig.String()))
	}

	// Bounded graceful shutdown: in-flight HTTP requests get up to
	// shutdownTimeout to finish. Note that http.Server.Shutdown does not
	// track hijacked connections, so live WebSocket relays (remote
	// shells, ICMP sessions) and streaming file downloads are still cut
	// when their owning handler returns or the process exits — the
	// graceful window only covers ordinary request/response traffic.
	ctx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
	defer cancel()
	if err := srv.Shutdown(ctx); err != nil {
		logger.Error("server shutdown", slog.String("err", err.Error()))
		return 1
	}
	if metricsSrv != nil {
		if err := metricsSrv.Shutdown(ctx); err != nil {
			logger.Error("metrics server shutdown", slog.String("err", err.Error()))
			return 1
		}
	}
	return 0
}

// shutdownTimeout bounds how long SIGINT/SIGTERM waits for in-flight
// HTTP requests to drain before the process exits anyway.
const shutdownTimeout = 15 * time.Second

// bannerInputs is the cohesive bundle of state the startup banner
// renders — pulling them into a struct lets the caller assemble the
// pieces in one place and keeps printStartupBanner from sprouting
// positional args every time something new shows up.
type bannerInputs struct {
	cfg            config.Config
	store          *store.Store
	lock           *store.InstanceLock
	bundle         *downloads.Bundle
	bundlePath     string
	bundleDisabled bool
	probe          agentprobe.Result
}

func printStartupBanner(logger *slog.Logger, in bannerInputs) {
	logger.Info(fmt.Sprintf("muti-metroo-manager %s (go %s, %s/%s) listening on %s%s",
		Version, runtime.Version(), runtime.GOOS, runtime.GOARCH,
		in.cfg.Addr, bindNote(in.cfg.Addr)))
	logger.Info(fmt.Sprintf("  agent:     %s%s", in.cfg.Agent, agentNote(in.probe)))
	logger.Info(fmt.Sprintf("  token:     %s", tokenSourceNote(in.cfg)))
	logger.Info(fmt.Sprintf("  auth:      %s", authNote(in.cfg)))
	logger.Info(fmt.Sprintf("  data-dir:  %s (db: %s, lock: %s)", in.cfg.DataDir, displayPath(in.store.Path()), displayPath(in.lock.Path())))
	logger.Info(fmt.Sprintf("  downloads: %s", bundleNote(in.bundle, in.bundlePath, in.bundleDisabled)))
	if in.store.FirstRun() {
		logger.Info("first run: created database — back this up alongside your config",
			slog.String("path", in.store.Path()),
		)
	}
}

// bindNote calls out the "binds every interface" risk for default
// :3000 / :PORT addresses so it isn't easy to miss.
func bindNote(addr string) string {
	if strings.HasPrefix(addr, ":") {
		return "  (BIND ALL INTERFACES — pin to 127.0.0.1 if behind a reverse proxy)"
	}
	return ""
}

// agentNote summarises the upstream probe result. We don't fail
// startup when the agent is unreachable — the manager is still useful
// (settings, downloads, audit) even if the proxy targets are down.
func agentNote(r agentprobe.Result) string {
	if r.Reachable {
		bits := []string{"reachable"}
		if r.Body != nil && r.Body.Status != "" {
			bits = append(bits, "status="+r.Body.Status)
			bits = append(bits, fmt.Sprintf("peers=%d", r.Body.PeerCount))
		}
		bits = append(bits, r.Latency.Round(time.Millisecond).String())
		return "  (" + strings.Join(bits, ", ") + ")"
	}
	if r.Error != "" {
		return "  (UNREACHABLE: " + r.Error + ")"
	}
	return "  (UNREACHABLE)"
}

func tokenSourceNote(cfg config.Config) string {
	if cfg.AgentToken == "" {
		return "(none)"
	}
	if cfg.AgentTokenFile != "" {
		return "from " + cfg.AgentTokenFile
	}
	return "set"
}

// authNote summarises the manager-auth posture for the banner.
func authNote(cfg config.Config) string {
	if cfg.AuthToken != "" {
		if cfg.AuthTokenFile != "" {
			return "required, token from " + cfg.AuthTokenFile
		}
		return "required"
	}
	if cfg.InsecureNoAuth {
		return "DISABLED via -insecure-no-auth"
	}
	return "DISABLED (loopback bind only)"
}

func bundleNote(b *downloads.Bundle, src string, disabled bool) string {
	switch {
	case disabled:
		return "disabled"
	case b != nil:
		return fmt.Sprintf("%s (%d files)", src, len(b.Manifest().Files))
	case src != "":
		return src + " (not present — feature off)"
	default:
		return "(none)"
	}
}

func displayPath(p string) string {
	if p == "" {
		return "(none)"
	}
	return p
}

// openDownloadsBundle wraps downloads.ResolvePath with the loud-on-
// missing-explicit-path policy main wants. The legacy `off` sentinel
// is honoured here so existing operators keep working through one
// release; -no-downloads is the supported form going forward.
func openDownloadsBundle(cfg config.Config, logger *slog.Logger) (*downloads.Bundle, string, bool) {
	if cfg.DownloadsBundle == "off" {
		logger.Warn("-downloads-bundle off is deprecated; use -no-downloads")
	}
	path, status := downloads.ResolvePath(cfg.DownloadsBundle, cfg.NoDownloads)
	switch status {
	case downloads.PathDisabled:
		return nil, "", true
	case downloads.PathAbsentExplicit:
		logger.Warn("downloads bundle not found", slog.String("path", path))
		return nil, path, false
	case downloads.PathAbsentImplicit:
		return nil, path, false
	}
	b, err := downloads.Open(path)
	if err != nil {
		logger.Warn("downloads bundle error", slog.String("path", path), slog.String("err", err.Error()))
		return nil, path, false
	}
	return b, path, false
}

// printRunUsage is the help text for `muti-metroo-manager` / `muti-metroo-manager run`.
// It defers the "big picture" sectioned help to `muti-metroo-manager -h`; this
// view focuses on the flags relevant to the current invocation.
func printRunUsage(lf *config.LoadFlags, w *os.File) {
	fmt.Fprintln(w, "usage: muti-metroo-manager [run] [flags]")
	fmt.Fprintln(w, "Starts the management UI. See `muti-metroo-manager -h` for the full subcommand list.")
	fmt.Fprintln(w)
	lf.FlagSet().PrintDefaults()
}
