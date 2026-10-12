package cli

import (
	"fmt"
	"io"
)

// printUsage replaces Go's default flag.Usage with a sectioned help
// page. The aim is the on-call paste test: an SRE reading this once
// at 3am should be able to launch a working server, validate a
// config, and find the env-var name without leaving the screen.
func printUsage(build Build, w io.Writer) {
	fmt.Fprintf(w, `muti-metroo-manager %s — management UI for Muti Metroo mesh networks

USAGE
  muti-metroo-manager [run] [flags]            start the HTTP server (default)
  muti-metroo-manager check [flags]            validate config + probe agent, exit 0/1
  muti-metroo-manager config show [flags]      print resolved config with provenance
  muti-metroo-manager config init [path]       emit a commented TOML config template
  muti-metroo-manager version | -V             print version and build info

FLAGS (run / check / config show)
  -config <path>            TOML file. Values are overridden by env and flags.
  -addr <host:port>         HTTP listen address. Default ":3000" binds every
                            interface.
  -agent <url>              Upstream Muti Metroo agent URL (scheme://host:port[/prefix]).
  -agent-token <token>      Bearer token sent to the agent. Visible via /proc;
                            prefer -agent-token-file or %s env.
  -agent-token-file <path>  File containing the bearer token (single line).
  -data-dir <path>          Directory for muti-metroo-manager.db and the instance lock.

ENVIRONMENT
  %s   bearer token sent to the agent
  MUTI_METROO_TOKEN              deprecated; same meaning, warns on use

EXAMPLES
  # Local agent on the same host
  muti-metroo-manager -agent http://127.0.0.1:8080

  # Production: token from a file, config from /etc, bind to loopback
  muti-metroo-manager -config /etc/muti-metroo-manager/config.toml

  # systemd ExecStartPre: validate before starting the real service
  muti-metroo-manager check -config /etc/muti-metroo-manager/config.toml

  # Render a starter config to /etc
  muti-metroo-manager config init /etc/muti-metroo-manager/config.toml
`, nonEmpty(build.Version, "dev"), "METROO_MANAGER_AGENT_TOKEN", "METROO_MANAGER_AGENT_TOKEN")
}
