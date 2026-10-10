# Muti Metroo Manager

Web-based management UI for Muti Metroo mesh networks. Provides a real-time SVG metro-map topology view, monitoring, remote shell access, file transfer, route management, mesh testing, and sleep/wake cluster control.

**Documentation:** https://github.com/postalsys/Muti-Metroo-Manager/

## Features

- **Topology Map** — Interactive SVG metro-style network visualization with role indicators, path highlighting, and reachability coloring
- **Monitoring** — Dashboard stats (peers, streams, routes, exit nodes, SOCKS5, exit handler) with 5s polling
- **Remote Shell** — xterm.js terminal to any agent via WebSocket binary protocol
- **File Transfer** — Upload/download files to/from agents (with browseable remote filesystem)
- **Route Management** — View, add, and remove dynamic routes; view static routes; route trace simulator
- **Port Forwarding** — Browse forward listeners and endpoints across the mesh
- **DNS** — Mesh-host registry (name → IPv4/IPv6) and TLD suffix management
- **Mesh Test** — On-demand or auto-polling (60s) reachability test across all agents
- **Sleep/Wake** — Cluster-wide sleep and wake control (when enabled)
- **Agent Panel** — Slide-in detail panel per agent: info, routes, forwards, peers, shell, files, ping tabs
- **Config Wizards** — Generate Muti Metroo agent and Mutiauk configs from the UI
- **Downloads** — Optional binary/manual download tab (when a `muti-metroo-downloads-bundle.zip` is deployed alongside the binary)
- **Persistent Settings**, SQLite-backed operator overrides (advertised API/SOCKS5 addresses) and per-agent metadata (note, icon, network membership)
- **Light / Dark Theme**, Follows the OS by default, toggled from the header and remembered per browser; self-hosted fonts, so the UI needs no internet access

## Quick Start

**Prerequisites:** Go 1.25+, Node.js 18+, npm

```bash
make build
./build/muti-metroo-manager -agent http://<agent-host>:8080
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

## Configuration

Muti Metroo Manager reads its configuration from three layers — built-in
defaults, an optional TOML file, the process environment, and CLI
flags — with each later layer overriding the previous. Use
`muti-metroo-manager config show` to render the resolved configuration with
per-field provenance.

### Subcommands

| Command | Purpose |
|---------|---------|
| `muti-metroo-manager` _(default)_ / `muti-metroo-manager run` | Start the HTTP server |
| `muti-metroo-manager check` | Validate config + probe the agent; exit 0/1 (drop into systemd `ExecStartPre=`) |
| `muti-metroo-manager config show` | Print the effective configuration with provenance |
| `muti-metroo-manager config init [path]` | Emit a fully-commented TOML template |
| `muti-metroo-manager version` / `-V` / `--version` | Print version, commit, Go version |

### Flags

| Flag | Default | Description |
|------|---------|-------------|
| `-config` | — | Path to a TOML config file (overridden by env and flags) |
| `-addr` | `:3000` | HTTP listen address (binds every interface; pin to `127.0.0.1:3000` if behind a reverse proxy) |
| `-agent` | `http://127.0.0.1:8080` | Muti Metroo agent URL to proxy to |
| `-agent-token` | — | Bearer token for agent API authentication. Visible via `/proc/<pid>/cmdline`; prefer `-agent-token-file` or `METROO_MANAGER_AGENT_TOKEN` |
| `-agent-token-file` | — | File containing the bearer token (single line, trimmed). Recommended for production. |
| `-data-dir` | OS-appropriate¹ | Directory for `muti-metroo-manager.db` and the instance lock |
| `-downloads-bundle` | next to binary | Path to `muti-metroo-downloads-bundle.zip`; an explicitly set path that does not exist is fatal |
| `-no-downloads` | `false` | Disable the Downloads tab regardless of bundle presence |
| `-log-level` | `info` | Minimum log severity: `debug`, `info`, `warn`, `error` |
| `-log-format` | `text` | Log encoding: `text` (human) or `json` (SIEM ingestion) |
| `-metrics-addr` | — | host:port to expose Prometheus `/metrics` on (empty disables); pin to a private interface |

¹ macOS: `~/Library/Application Support/Muti-Metroo-Manager/`. Linux as root:
`/var/lib/muti-metroo-manager`. Linux as a user: `$XDG_CONFIG_HOME/muti-metroo-manager`.
Windows: `%LOCALAPPDATA%\muti-metroo-manager`.

The legacy `-downloads-bundle off` sentinel still works for
backwards compatibility but logs a deprecation warning — use
`-no-downloads` instead.

### Environment variables

| Variable | Effect |
|----------|--------|
| `METROO_MANAGER_AGENT_TOKEN` | Bearer token sent to the agent |
| `MUTI_METROO_TOKEN` | _Deprecated alias for the above; logs a warning on use._ |

### Example config file

```bash
muti-metroo-manager config init /etc/muti-metroo-manager/config.toml
```

```toml
addr = "127.0.0.1:3000"
agent = "https://mesh.example.com"
agent_token_file = "/etc/muti-metroo-manager/token"
data_dir = "/var/lib/muti-metroo-manager"
no_downloads = false
```

Inline `agent_token` is intentionally rejected; use `agent_token_file`
or the env var instead.

### Observability

- `GET /healthz` (on the main listener) returns the manager's own
  status plus the cached upstream-agent reachability — safe to scrape
  from external monitoring.
- `GET /metrics` (on the optional `-metrics-addr` listener) returns
  Prometheus text format. Series include `metroo_manager_requests_total`,
  `metroo_manager_request_duration_seconds`, and
  `metroo_manager_agent_reachable`.
- Per-request access lines and `audit=true` state-change lines are
  emitted via `slog`; flip `-log-format=json` to feed them into a
  SIEM. Each request gets a random `req_id` propagated through the
  log line and the `X-Request-ID` response header.

### Running as a service

Reference unit files live in `contrib/`:

- `contrib/systemd/muti-metroo-manager.service` — Linux systemd. Pre-start runs
  `muti-metroo-manager check`; sandbox knobs (`ProtectSystem=strict`,
  `NoNewPrivileges=true`, etc.) are turned on by default.
- `contrib/launchd/com.muti-metroo-manager.plist` — macOS user agent. Pin
  paths and (optional) the bearer token in `EnvironmentVariables`.
- `contrib/openrc/muti-metroo-manager` — OpenRC for Alpine / Gentoo.

## Development

Run the Go backend and Vite dev server in separate terminals:

```bash
# Terminal 1 — Go backend
go run ./cmd/manager -addr :3000 -agent http://<agent-host>:8080

# Terminal 2 — Vite dev server (hot reload)
cd frontend && npm install && npm run dev
```

The Vite dev server runs on [http://localhost:5173](http://localhost:5173) and proxies `/api/proxy/*` requests to the Go backend at `localhost:3000`.

## Project Structure

```
cmd/manager/            Go entrypoint, CLI flag parsing, graceful shutdown
internal/
  server/               HTTP routing: /api/proxy/*, /api/settings, /api/agent-meta[/*], /api/downloads/*, SPA
  proxy/                Reverse proxy to agent (HTTP + WebSocket relay)
  store/                SQLite-backed operator overrides + per-agent metadata (modernc.org/sqlite, pure Go)
  downloads/            Optional zip-bundle file server backing the Downloads tab
  webui/                Embedded SPA (go:embed), content-type mapping, SPA fallback
frontend/
  src/
    api/                API client functions, TypeScript types
    components/
      MetroMap/         SVG topology: layout algorithm, stations, connections, tooltips
      AgentPanel/       Slide-in panel: info, routes, forwards, peers, shell, files, ping tabs (+ IconPicker)
      ConfigWizard/     Wizard for generating Muti Metroo agent configs
      EntryConfigWizard/ Wizard for generating Mutiauk configs
      wizard/           Shared wizard primitives (Field, etc.)
      Header.tsx        Brand bar, agent label
      Footer.tsx        Footer bar with mesh test summary
      Tabs.tsx          The tab strip (size="sm" for sub-tabs)
      DialogHeader.tsx  Shared dialog title bar + close button
      ActionsMenu.tsx   Header dropdown: mesh test, sleep/wake, wizards, settings
      AgentSearch.tsx   Topology agent quick-search (`/` hotkey)
      RoutesPanel.tsx, RouteTable.tsx, RouteTraceSection.tsx, RouteCommentDialog.tsx  Route + trace UI
      ForwardRouteTable.tsx  Port-forward route table
      DnsTab.tsx, DnsHostsTab.tsx, DnsTldsTab.tsx  Mesh-host registry + TLD suffix UI
      DownloadsTab.tsx  Optional binaries/manuals download tab
      SettingsDialog.tsx, TokenDialog.tsx, ConfirmDialog.tsx, TestResultsModal.tsx, Alert.tsx  Modal dialogs + alerts
      wizard/           Field.tsx + WizardShell.tsx, the frame both config wizards render
    styles/             Tailwind v4 + FlyonUI theme (app.css entry; fonts, layout, ui, metro)
    router.ts           URL-driven tab + agent-panel state (path + ?agent=&panel=)
  vite.config.ts        Build output → internal/webui/dist, dev proxy config
Makefile                build, build-frontend, build-go, dev, clean targets
```

## Architecture

**Go backend** — Minimal reverse proxy that sits between the browser and a Muti Metroo agent. All `/api/proxy/*` requests are stripped of the prefix and forwarded to the agent (HTTP and WebSocket). A small SQLite database (managed by `internal/store`) holds operator-set overrides for the advertised API/SOCKS5 addresses plus per-agent operator metadata (note + icon). An optional downloads bundle (`internal/downloads`) lets operators expose binaries and manuals under `/api/downloads/*`. The Vite-built frontend is embedded into the binary via `go:embed` and served with SPA fallback. External Go dependencies: `gorilla/websocket` (proxy) and `modernc.org/sqlite` (pure-Go SQLite driver).

**React frontend**, Single-page app built with React 19, TypeScript, and Vite, styled with Tailwind v4 + FlyonUI (compiled by the Vite plugin from `frontend/src/styles/app.css`; FlyonUI's runtime JS is not loaded, since React owns every interactive component). The router (`frontend/src/router.ts`) is a hand-rolled URL state hook, no routing library, encoding the major tab, sub-tab, selected agent, and agent-panel tab into the path + query (`/<major>/<sub>?agent=&panel=`). State is managed with React hooks (`useState`, `useRef`, `useEffect` polling). The shell tab uses xterm.js with a custom binary WebSocket protocol for PTY communication.
