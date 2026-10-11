// Package config holds Muti Metroo Manager's runtime configuration. A Config is
// the single source of truth for every tunable: built-in defaults are
// merged with an optional TOML file, the process environment, and CLI
// flags, in that order. The accompanying Source map records which
// layer wrote each field so `muti-metroo-manager config show` can render
// provenance for audit reviews.
package config

// Config is the resolved, runtime-effective configuration.
//
// Field comments describe how the value is used at runtime; the
// per-flag and per-env-var documentation lives in load.go alongside
// the flag declarations so the help output stays in one place.
type Config struct {
	// Addr is the listen address for the HTTP server (host:port).
	Addr string `toml:"addr"`

	// Agent is the URL of the upstream Muti Metroo agent HTTP API. The
	// proxy strips /api/proxy from incoming paths and forwards to
	// this base.
	Agent string `toml:"agent"`

	// AgentToken is the bearer token sent to the agent. Resolved at
	// load time from (in priority order) the -agent-token flag, the
	// METROO_MANAGER_AGENT_TOKEN env var, the legacy MUTI_METROO_TOKEN env var,
	// and finally the file referenced by AgentTokenFile.
	AgentToken string `toml:"-"`

	// AgentTokenFile is the path to a file containing the bearer
	// token. Preferred over AgentToken at the CLI because argv leaks
	// via /proc/<pid>/cmdline on multi-tenant hosts.
	AgentTokenFile string `toml:"agent_token_file"`

	// AgentCABundle is the path to a PEM file with additional CA
	// certificates for verifying the agent's TLS certificate. The
	// supported way to reach agents with self-signed or private-CA
	// certificates over https:// agent URLs.
	AgentCABundle string `toml:"agent_ca_bundle"`

	// InsecureSkipVerify disables TLS certificate verification when
	// talking to the agent. Escape hatch only — the token sent to the
	// agent becomes MITM-able. Startup logs a loud warning.
	InsecureSkipVerify bool `toml:"insecure_skip_verify"`

	// AuthToken guards the manager's own /api/* routes (including the
	// agent proxy). Resolved like AgentToken: -auth-token flag,
	// METROO_MANAGER_AUTH_TOKEN env var, then AuthTokenFile. Empty means
	// "no manager auth" — only permitted on loopback binds unless
	// InsecureNoAuth is set.
	AuthToken string `toml:"-"`

	// AuthTokenFile is the path to a file containing the manager auth
	// token. Preferred over -auth-token for the same /proc reason as
	// AgentTokenFile.
	AuthTokenFile string `toml:"auth_token_file"`

	// InsecureNoAuth explicitly allows binding a non-loopback address
	// with no manager auth token. Without it (or a token) the server
	// refuses to start on a wildcard bind.
	InsecureNoAuth bool `toml:"insecure_no_auth"`

	// DataDir is where muti-metroo-manager.db and the instance lock live.
	DataDir string `toml:"data_dir"`

	// DownloadsBundle is the path to muti-metroo-downloads-bundle.zip. An
	// empty string means "look next to the binary"; a path that
	// doesn't exist is fatal when explicitly set.
	DownloadsBundle string `toml:"downloads_bundle"`

	// NoDownloads disables the downloads tab even if a bundle is
	// present next to the binary. Replaces the legacy magic string
	// `-downloads-bundle off`.
	NoDownloads bool `toml:"no_downloads"`

	// LogLevel is the minimum slog level (debug | info | warn | error).
	LogLevel string `toml:"log_level"`

	// LogFormat is the output encoding — "text" (default) or "json".
	LogFormat string `toml:"log_format"`

	// MetricsAddr enables a separate /metrics listener at the given
	// host:port. Empty disables it. Kept on its own listener so the
	// management UI doesn't accidentally expose Prometheus metrics
	// to whoever can reach the main port.
	MetricsAddr string `toml:"metrics_addr"`

	// NoSounds disables the UI's audio cues regardless of the
	// per-user setting. The settings dialog grays out its toggle
	// when this is on.
	NoSounds bool `toml:"no_sounds"`
}

// Defaults returns a Config populated with the values used when the
// operator passes no flags, no env, and no config file. They are kept
// here (not embedded in flag.String calls) so every layer — including
// `config init` and `config show` — sees the same baseline.
//
// DataDir is resolved per-OS by DefaultDataDir so a supervisor's
// arbitrary CWD doesn't leak into the SQLite path.
func Defaults() Config {
	return Config{
		Addr:               ":3000",
		Agent:              "http://127.0.0.1:8080",
		AgentToken:         "",
		AgentTokenFile:     "",
		AgentCABundle:      "",
		InsecureSkipVerify: false,
		AuthToken:          "",
		AuthTokenFile:      "",
		InsecureNoAuth:     false,
		DataDir:            DefaultDataDir(),
		DownloadsBundle:    "",
		NoDownloads:        false,
		LogLevel:           "info",
		LogFormat:          "text",
		MetricsAddr:        "",
		NoSounds:           false,
	}
}

// Source records the layer that produced each field's effective value.
// The keys match the TOML key names (or, for runtime-only fields like
// AgentToken, the lower_snake_case of the Go field). Values are one of
// the SourceXxx constants.
type Source map[string]string

const (
	SourceDefault   = "default"
	SourceFile      = "file"
	SourceEnv       = "env"
	SourceFlag      = "flag"
	SourceTokenFile = "token-file"
)

// allFields is the canonical ordering used when rendering Config in
// `config show` / `config init`. Keep in sync with the Config struct.
var allFields = []string{
	"addr",
	"agent",
	"agent_token",
	"agent_token_file",
	"agent_ca_bundle",
	"insecure_skip_verify",
	"auth_token",
	"auth_token_file",
	"insecure_no_auth",
	"data_dir",
	"downloads_bundle",
	"no_downloads",
	"log_level",
	"log_format",
	"metrics_addr",
	"no_sounds",
}

// Fields returns the canonical key order for rendering.
func Fields() []string {
	out := make([]string, len(allFields))
	copy(out, allFields)
	return out
}
