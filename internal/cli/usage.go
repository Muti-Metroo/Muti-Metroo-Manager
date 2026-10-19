package cli

import (
	"fmt"
	"io"

	"github.com/Muti-Metroo/Muti-Metroo-Manager/internal/config"
)

// printUsage replaces Go's default flag.Usage with a sectioned help
// page. The aim is the on-call paste test: an SRE reading this once
// at 3am should be able to launch a working server, validate a
// config, and find the env-var name without leaving the screen.
func printUsage(build Build, w io.Writer) {
	fmt.Fprintf(w, `muti-metroo-manager %s: management UI for Muti Metroo mesh networks

USAGE
  muti-metroo-manager [run] [flags]            start the HTTP server (default)
  muti-metroo-manager check [flags]            validate config + probe agent, exit 0/1
  muti-metroo-manager config show [flags]      print resolved config with provenance
  muti-metroo-manager config init [path]       emit a commented TOML config template
  muti-metroo-manager version | -V             print version and build info

FLAGS (run / check / config show)
  -config <path>             TOML file. Values are overridden by env and flags.
  -addr <host:port>          HTTP listen address. Default ":3000" binds every
                             interface; a non-loopback address needs an auth token.
  -agent <url>               Upstream Muti Metroo agent URL (scheme://host:port[/prefix]).
  -agent-token <token>       Bearer token sent to the agent. Visible via /proc;
                             prefer -agent-token-file or %s env.
  -agent-token-file <path>   File containing the agent bearer token (single line).
  -agent-ca-bundle <path>    PEM file with extra CA certificates for an https:// agent.
  -insecure-skip-verify      Do not verify the agent's TLS certificate (MITM-able).
  -auth-token <token>        Token guarding the manager's own /api/* routes.
                             Prefer -auth-token-file or %s env.
  -auth-token-file <path>    File containing the manager auth token (single line).
  -insecure-no-auth          Allow a non-loopback -addr without an auth token (dangerous).
  -data-dir <path>           Directory for muti-metroo-manager.db and the instance lock.
  -log-level <level>         debug | info | warn | error.
  -log-format <format>       text | json.
  -metrics-addr <host:port>  Serve /metrics there (empty disables; keep it private).
  -no-sounds                 Turn the UI sound effects off for every user.

ENVIRONMENT
  %s   bearer token sent to the agent
  %s    manager auth token
  MUTI_METROO_TOKEN            deprecated; same meaning as %s, warns on use

EXAMPLES
  # Local agent on the same host
  muti-metroo-manager -agent http://127.0.0.1:8080

  # Production: token from a file, config from /etc, bind to loopback
  muti-metroo-manager -config /etc/muti-metroo-manager/config.toml

  # systemd ExecStartPre: validate before starting the real service
  muti-metroo-manager check -config /etc/muti-metroo-manager/config.toml

  # Render a starter config to /etc
  muti-metroo-manager config init /etc/muti-metroo-manager/config.toml
`, nonEmpty(build.Version, "dev"), config.EnvAgentToken, config.EnvAuthToken, config.EnvAgentToken, config.EnvAuthToken, config.EnvAgentToken)
}
