package cli

import (
	"flag"
	"fmt"
	"io"
	"os"

	"github.com/postalsys/muti-metroo-manager/internal/config"
)

// runConfigInit emits a commented TOML template. With no path it
// writes to stdout; with a path it creates the file (refusing to
// clobber unless -force is given).
func runConfigInit(args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("muti-metroo-manager config init", flag.ContinueOnError)
	fs.SetOutput(stderr)
	force := fs.Bool("force", false, "overwrite the target file if it already exists")
	fs.Usage = func() {
		fmt.Fprintln(stderr, "usage: muti-metroo-manager config init [-force] [path]")
		fmt.Fprintln(stderr, "Emits a fully-commented TOML config to stdout (or path).")
		fmt.Fprintln(stderr)
		fs.PrintDefaults()
	}
	if err := fs.Parse(args); err != nil {
		return 2
	}
	rest := fs.Args()
	if len(rest) > 1 {
		fmt.Fprintln(stderr, "muti-metroo-manager config init: at most one path argument is allowed")
		return 2
	}

	body := renderInitTemplate(config.Defaults())

	if len(rest) == 0 {
		_, err := io.WriteString(stdout, body)
		if err != nil {
			fmt.Fprintf(stderr, "write: %v\n", err)
			return 1
		}
		return 0
	}

	path := rest[0]
	flags := os.O_WRONLY | os.O_CREATE | os.O_TRUNC
	if !*force {
		flags |= os.O_EXCL
	}
	f, err := os.OpenFile(path, flags, 0o644)
	if err != nil {
		fmt.Fprintf(stderr, "open %s: %v\n", path, err)
		return 1
	}
	if _, err := io.WriteString(f, body); err != nil {
		f.Close()
		fmt.Fprintf(stderr, "write %s: %v\n", path, err)
		return 1
	}
	if err := f.Close(); err != nil {
		fmt.Fprintf(stderr, "close %s: %v\n", path, err)
		return 1
	}
	fmt.Fprintf(stdout, "wrote %s\n", path)
	return 0
}

// renderInitTemplate is exported as a free function so tests can
// assert the output round-trips through parseFlat.
func renderInitTemplate(d config.Config) string {
	const tpl = `# Muti Metroo Manager configuration
#
# This file is loaded with -config /path/to/config.toml. Values here
# override the built-in defaults; environment variables and CLI flags
# override values here. Run ` + "`muti-metroo-manager config show`" + ` to see the
# resolved configuration with per-field provenance.

# HTTP listen address. Default %q binds every interface; pin to
# 127.0.0.1:3000 (or behind a reverse proxy) on hosts where the
# management UI shouldn't be reachable from the network.
addr = %q

# Upstream Muti Metroo agent base URL. The proxy strips /api/proxy from
# incoming paths and forwards to this URL.
agent = %q

# Path to a file containing the bearer token sent to the agent. One
# line, trailing newline trimmed. Preferred over passing the token via
# -agent-token (which leaks through /proc/<pid>/cmdline) and over the
# environment (which is visible to anything that can read /proc/environ).
agent_token_file = %q

# Path to a PEM file with additional CA certificates used to verify
# the agent's TLS certificate. The supported way to reach agents with
# self-signed or private-CA certificates over an https:// agent URL.
agent_ca_bundle = %q

# Disable TLS certificate verification when talking to the agent.
# Escape hatch only: the bearer token sent to the agent becomes
# MITM-able. Startup logs a loud warning; prefer agent_ca_bundle.
insecure_skip_verify = %t

# Path to a file containing the manager's own auth token. When set,
# every /api/* route (including the agent proxy, remote shell, and
# file transfer) requires an Authorization: Bearer header or the
# session cookie set by the UI's login gate. When empty the manager
# refuses to bind a non-loopback address unless insecure_no_auth is
# set. Preferred over -auth-token for the same /proc reason as above.
auth_token_file = %q

# Explicitly allow binding a non-loopback address with no manager auth
# token. Dangerous: anyone who can reach the port gets full control of
# the agent API.
insecure_no_auth = %t

# Persistent state directory. Holds muti-metroo-manager.db and the instance lock.
data_dir = %q

# Path to muti-metroo-downloads-bundle.zip. Empty means "look next to the
# binary"; if you set this to an explicit path the file must exist or
# the server refuses to start.
downloads_bundle = %q

# Hard-disable the Downloads tab even if a bundle is present next to
# the binary.
no_downloads = %t

# Minimum log severity. One of: debug | info | warn | error.
log_level = %q

# Log output encoding. "text" is human-readable; "json" emits one
# structured event per line for SIEM ingestion.
log_format = %q

# host:port for the Prometheus /metrics endpoint. Empty disables it.
# Pin to a private interface (e.g. 127.0.0.1:9100) so external scrapers
# go through your monitoring fabric, not the public listener.
metrics_addr = %q
`
	return fmt.Sprintf(tpl,
		d.Addr,
		d.Addr,
		d.Agent,
		d.AgentTokenFile,
		d.AgentCABundle,
		d.InsecureSkipVerify,
		d.AuthTokenFile,
		d.InsecureNoAuth,
		d.DataDir,
		d.DownloadsBundle,
		d.NoDownloads,
		d.LogLevel,
		d.LogFormat,
		d.MetricsAddr,
	)
}
