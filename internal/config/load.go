package config

import (
	"flag"
	"fmt"
	"io"
	"os"
	"strings"
)

// LoadResult is the bundle every caller of Load needs: the merged
// Config, a per-field Source map (for `config show` and audit), the
// path of the config file actually read (empty if none), and any
// non-fatal warnings (e.g. legacy MUTI_METROO_TOKEN env in use).
type LoadResult struct {
	Config      Config
	Source      Source
	ConfigPath  string
	Warnings    []string
	FlagOutput  string // captured -h / -help output when ErrUsage is returned
	UsageCalled bool
}

// Env var names. The legacy form is read but logged with a deprecation
// warning so existing systemd unit files keep working through one
// release cycle.
const (
	EnvAgentToken       = "METROO_MANAGER_AGENT_TOKEN"
	EnvAgentTokenLegacy = "MUTI_METROO_TOKEN"
	EnvAuthToken        = "METROO_MANAGER_AUTH_TOKEN"
)

// LoadFlags is the set of command-line flags that produce the
// run-time Config. It is exposed so the same flag set can be reused by
// `config show` to render the effective config without starting the
// server.
type LoadFlags struct {
	fs *flag.FlagSet

	configPath         string
	addr               string
	agent              string
	agentToken         string
	agentTokenFile     string
	agentCABundle      string
	insecureSkipVerify bool
	authToken          string
	authTokenFile      string
	insecureNoAuth     bool
	dataDir            string
	downloadsBnd       string
	noDownloads        bool
	logLevel           string
	logFormat          string
	metricsAddr        string
	noSounds           bool
}

// NewLoadFlags constructs a flag.FlagSet with every Muti Metroo Manager flag
// declared. The returned LoadFlags can be parsed with Parse and then
// merged with file + env via Resolve.
func NewLoadFlags(name string, errOut io.Writer) *LoadFlags {
	fs := flag.NewFlagSet(name, flag.ContinueOnError)
	fs.SetOutput(errOut)
	lf := &LoadFlags{fs: fs}
	d := Defaults()
	fs.StringVar(&lf.configPath, "config", "",
		"path to a TOML config file; values are overridden by env and flags")
	fs.StringVar(&lf.addr, "addr", d.Addr,
		"HTTP listen address (host:port; \":3000\" binds all interfaces)")
	fs.StringVar(&lf.agent, "agent", d.Agent,
		"Muti Metroo agent URL (scheme://host:port[/prefix])")
	fs.StringVar(&lf.agentToken, "agent-token", "",
		"bearer token for the agent (prefer -agent-token-file or "+EnvAgentToken+" env)")
	fs.StringVar(&lf.agentTokenFile, "agent-token-file", "",
		"path to a file containing the bearer token (single line, trimmed)")
	fs.StringVar(&lf.agentCABundle, "agent-ca-bundle", "",
		"path to a PEM file with extra CA certificates for verifying the agent's TLS certificate")
	fs.BoolVar(&lf.insecureSkipVerify, "insecure-skip-verify", false,
		"disable TLS certificate verification when talking to the agent (MITM-able; logs a warning)")
	fs.StringVar(&lf.authToken, "auth-token", "",
		"bearer token guarding the manager's own /api/* routes (prefer -auth-token-file or "+EnvAuthToken+" env)")
	fs.StringVar(&lf.authTokenFile, "auth-token-file", "",
		"path to a file containing the manager auth token (single line, trimmed)")
	fs.BoolVar(&lf.insecureNoAuth, "insecure-no-auth", false,
		"allow binding a non-loopback address with no manager auth token (dangerous)")
	fs.StringVar(&lf.dataDir, "data-dir", d.DataDir,
		"directory for persistent state (muti-metroo-manager.db)")
	fs.StringVar(&lf.downloadsBnd, "downloads-bundle", "",
		"path to muti-metroo-downloads-bundle.zip (default: alongside the binary)")
	fs.BoolVar(&lf.noDownloads, "no-downloads", false,
		"disable the downloads tab even if a bundle is present")
	fs.StringVar(&lf.logLevel, "log-level", d.LogLevel,
		"minimum log severity (debug | info | warn | error)")
	fs.StringVar(&lf.logFormat, "log-format", d.LogFormat,
		"log output encoding (text | json)")
	fs.StringVar(&lf.metricsAddr, "metrics-addr", d.MetricsAddr,
		"host:port to expose /metrics on (empty disables; pin to a private interface)")
	fs.BoolVar(&lf.noSounds, "no-sounds", d.NoSounds,
		"force the UI sound effects off regardless of per-user setting")
	return lf
}

// FlagSet exposes the underlying flag.FlagSet so callers can override
// Usage or wire additional flags before Parse.
func (lf *LoadFlags) FlagSet() *flag.FlagSet { return lf.fs }

// Parse runs flag.Parse with the given args. Returns flag.ErrHelp on
// -h/-help so callers can distinguish "user asked for help" from a
// genuine parse error.
func (lf *LoadFlags) Parse(args []string) error {
	return lf.fs.Parse(args)
}

// Args returns the positional arguments left over after flag parsing.
func (lf *LoadFlags) Args() []string { return lf.fs.Args() }

// Resolve merges defaults → config file (if any) → env → flags into a
// single Config and records each field's provenance in Source. Returns
// non-fatal warnings (e.g. deprecated env var in use); fatal problems
// (unreadable config file, malformed TOML) come back as an error.
func (lf *LoadFlags) Resolve() (LoadResult, error) {
	cfg := Defaults()
	src := Source{}
	for _, k := range allFields {
		src[k] = SourceDefault
	}

	var warnings []string
	configPath := strings.TrimSpace(lf.configPath)

	// File layer.
	if configPath != "" {
		f, err := os.Open(configPath)
		if err != nil {
			return LoadResult{}, fmt.Errorf("open config: %w", err)
		}
		defer f.Close()
		fileMap, err := parseFlat(f)
		if err != nil {
			return LoadResult{}, fmt.Errorf("parse %s: %w", configPath, err)
		}
		if err := applyFileLayer(&cfg, src, fileMap); err != nil {
			return LoadResult{}, fmt.Errorf("config %s: %w", configPath, err)
		}
	}

	// Env layer.
	if v := os.Getenv(EnvAgentToken); v != "" {
		cfg.AgentToken = v
		src["agent_token"] = SourceEnv
	} else if v := os.Getenv(EnvAgentTokenLegacy); v != "" {
		cfg.AgentToken = v
		src["agent_token"] = SourceEnv
		warnings = append(warnings,
			"environment variable "+EnvAgentTokenLegacy+
				" is deprecated; use "+EnvAgentToken+" instead")
	}
	if v := os.Getenv(EnvAuthToken); v != "" {
		cfg.AuthToken = v
		src["auth_token"] = SourceEnv
	}

	// Flag layer — only fields actually set on the command line win.
	setFlags := map[string]bool{}
	lf.fs.Visit(func(f *flag.Flag) { setFlags[f.Name] = true })

	if setFlags["addr"] {
		cfg.Addr = lf.addr
		src["addr"] = SourceFlag
	}
	if setFlags["agent"] {
		cfg.Agent = lf.agent
		src["agent"] = SourceFlag
	}
	if setFlags["agent-token"] {
		cfg.AgentToken = lf.agentToken
		src["agent_token"] = SourceFlag
		warnings = append(warnings,
			"-agent-token reads the token from argv (visible to other users via /proc); "+
				"prefer -agent-token-file or "+EnvAgentToken+" env")
	}
	if setFlags["agent-token-file"] {
		cfg.AgentTokenFile = lf.agentTokenFile
		src["agent_token_file"] = SourceFlag
	}
	if setFlags["agent-ca-bundle"] {
		cfg.AgentCABundle = lf.agentCABundle
		src["agent_ca_bundle"] = SourceFlag
	}
	if setFlags["insecure-skip-verify"] {
		cfg.InsecureSkipVerify = lf.insecureSkipVerify
		src["insecure_skip_verify"] = SourceFlag
	}
	if setFlags["auth-token"] {
		cfg.AuthToken = lf.authToken
		src["auth_token"] = SourceFlag
		warnings = append(warnings,
			"-auth-token reads the token from argv (visible to other users via /proc); "+
				"prefer -auth-token-file or "+EnvAuthToken+" env")
	}
	if setFlags["auth-token-file"] {
		cfg.AuthTokenFile = lf.authTokenFile
		src["auth_token_file"] = SourceFlag
	}
	if setFlags["insecure-no-auth"] {
		cfg.InsecureNoAuth = lf.insecureNoAuth
		src["insecure_no_auth"] = SourceFlag
	}
	if setFlags["data-dir"] {
		cfg.DataDir = lf.dataDir
		src["data_dir"] = SourceFlag
	}
	if setFlags["downloads-bundle"] {
		cfg.DownloadsBundle = lf.downloadsBnd
		src["downloads_bundle"] = SourceFlag
	}
	if setFlags["no-downloads"] {
		cfg.NoDownloads = lf.noDownloads
		src["no_downloads"] = SourceFlag
	}
	if setFlags["log-level"] {
		cfg.LogLevel = lf.logLevel
		src["log_level"] = SourceFlag
	}
	if setFlags["log-format"] {
		cfg.LogFormat = lf.logFormat
		src["log_format"] = SourceFlag
	}
	if setFlags["metrics-addr"] {
		cfg.MetricsAddr = lf.metricsAddr
		src["metrics_addr"] = SourceFlag
	}
	if setFlags["no-sounds"] {
		cfg.NoSounds = lf.noSounds
		src["no_sounds"] = SourceFlag
	}

	// Token-file layer is applied last but only if no higher-priority
	// source produced a token. The file form is the recommended way
	// to ship a token in production, so it's "authoritative when no
	// flag/env set it" rather than "lowest priority" — otherwise a
	// stale env var would silently override the file an operator
	// explicitly wired into the unit file.
	if cfg.AgentTokenFile != "" && cfg.AgentToken == "" {
		tok, err := readTokenFile(cfg.AgentTokenFile)
		if err != nil {
			return LoadResult{}, fmt.Errorf("read agent_token_file: %w", err)
		}
		cfg.AgentToken = tok
		src["agent_token"] = SourceTokenFile
	}
	if cfg.AuthTokenFile != "" && cfg.AuthToken == "" {
		tok, err := readTokenFile(cfg.AuthTokenFile)
		if err != nil {
			return LoadResult{}, fmt.Errorf("read auth_token_file: %w", err)
		}
		cfg.AuthToken = tok
		src["auth_token"] = SourceTokenFile
	}

	return LoadResult{
		Config:     cfg,
		Source:     src,
		ConfigPath: configPath,
		Warnings:   warnings,
	}, nil
}

// applyFileLayer copies recognised keys out of a parsed config file
// onto cfg and records the file as the source. Unknown keys are an
// error — silently ignoring typos is exactly the kind of foot-gun a
// hospital ops team should not have to debug at 3am.
func applyFileLayer(cfg *Config, src Source, m map[string]any) error {
	strField := func(key string, dst *string, v any) error {
		s, ok := v.(string)
		if !ok {
			return fmt.Errorf("%s: expected string", key)
		}
		*dst = s
		src[key] = SourceFile
		return nil
	}
	boolField := func(key string, dst *bool, v any) error {
		b, ok := v.(bool)
		if !ok {
			return fmt.Errorf("%s: expected bool", key)
		}
		*dst = b
		src[key] = SourceFile
		return nil
	}
	for k, v := range m {
		var err error
		switch k {
		case "addr":
			err = strField(k, &cfg.Addr, v)
		case "agent":
			err = strField(k, &cfg.Agent, v)
		case "agent_token_file":
			err = strField(k, &cfg.AgentTokenFile, v)
		case "agent_ca_bundle":
			err = strField(k, &cfg.AgentCABundle, v)
		case "insecure_skip_verify":
			err = boolField(k, &cfg.InsecureSkipVerify, v)
		case "auth_token_file":
			err = strField(k, &cfg.AuthTokenFile, v)
		case "insecure_no_auth":
			err = boolField(k, &cfg.InsecureNoAuth, v)
		case "data_dir":
			err = strField(k, &cfg.DataDir, v)
		case "downloads_bundle":
			err = strField(k, &cfg.DownloadsBundle, v)
		case "no_downloads":
			err = boolField(k, &cfg.NoDownloads, v)
		case "log_level":
			err = strField(k, &cfg.LogLevel, v)
		case "log_format":
			err = strField(k, &cfg.LogFormat, v)
		case "metrics_addr":
			err = strField(k, &cfg.MetricsAddr, v)
		case "no_sounds":
			err = boolField(k, &cfg.NoSounds, v)
		case "agent_token":
			return fmt.Errorf("agent_token in config files is not supported; use agent_token_file or " + EnvAgentToken)
		case "auth_token":
			return fmt.Errorf("auth_token in config files is not supported; use auth_token_file or " + EnvAuthToken)
		default:
			return fmt.Errorf("unknown key %q (run `muti-metroo-manager config init` for the full list)", k)
		}
		if err != nil {
			return err
		}
	}
	return nil
}

// readTokenFile reads a single-line bearer token. Trailing newlines
// (the usual case for `echo $token > /etc/muti-metroo-manager/token`) are
// trimmed; the token must be non-empty after trimming.
func readTokenFile(path string) (string, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	tok := strings.TrimSpace(string(b))
	if tok == "" {
		return "", fmt.Errorf("%s is empty", path)
	}
	return tok, nil
}
