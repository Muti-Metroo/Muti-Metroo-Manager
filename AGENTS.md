# AGENTS.md — Muti Metroo Manager

Web-based management UI ("Muti Metroo Manager") for [Muti Metroo](https://github.com/postalsys/muti-metroo)
mesh networks. A minimal Go backend reverse-proxies browser requests to a Muti Metroo
agent's HTTP API (`/api/proxy/*` is stripped of the prefix and forwarded, HTTP and
WebSocket) and serves an embedded React SPA with a real-time SVG metro-map topology
view, monitoring, remote shell, file transfer, route management, DNS hosts/TLDs,
config wizards, and a downloads bundle.

## Repo layout

- `cmd/manager/` — binary entrypoint (`main.go`); the binary is `muti-metroo-manager`
- `internal/config/` — flags, env vars, YAML config loading
- `internal/server/` — HTTP server, routing, auth, health, metrics
- `internal/proxy/` — reverse proxy to the agent (HTTP + WebSocket relay)
- `internal/webui/` — `go:embed` of the built frontend (`dist/`, generated)
- `internal/store/` — local state (bbolt), host-key/endpoint handling
- `internal/agentprobe/` — connectivity/capability probing of the agent
- `internal/downloads/` — downloads-bundle discovery and manifest
- `internal/cli/`, `internal/logging/`, `internal/metrics/` — subcommands, logging, Prometheus registry
- `frontend/` — React 19 + TypeScript + Vite + Tailwind 4 SPA (tests: vitest)
- `contrib/` — systemd unit and launchd plist examples
- `docs/` — additional docs; `docs/prompts/` holds agent-task prompts

## Build & test

The Go backend embeds the built frontend, so **build the frontend before `go build`**
(`internal/webui/dist` must exist):

```bash
cd frontend && npm ci && npm run build && npm test   # vitest
cd .. && go build ./... && go test ./...
```

Or use `make build` (both steps). Dev loop: `go run ./cmd/manager -addr :3000 -agent http://127.0.0.1:8080`
plus `cd frontend && npm run dev` (Vite on :5173 proxies `/api/proxy/*` to :3000).
Run `make hooks` once to enable the Prettier pre-commit hook.

## Conventions

- Go: standard `gofmt`-clean code; keep `go vet ./...` clean.
- Frontend: TypeScript, Prettier (`npm run format:check`), vitest for unit tests.
- English only — code, comments, docs, and UI strings.
- Branding: the product is **Muti Metroo Manager**; the upstream agent is **Muti Metroo**;
  the companion entry client is **Mutiauk**. The mascot is a mole (see `frontend/public/logo.png`).
  Do not reintroduce legacy "Meshy" naming or hedgehog imagery.

## Releases

Releases are automated with [release-please](https://github.com/googleapis/release-please)
(`.github/workflows/release-please.yml`). Use [Conventional Commits](https://www.conventionalcommits.org/):
`fix:` → patch, `feat:` → minor, `feat!:`/`BREAKING CHANGE:` → major; `docs:`/`chore:`/`ci:` cut no release.
release-please bumps `VERSION` and `CHANGELOG.md` on master. `release.sh` (manual,
GitHub API, needs `GITHUB_TOKEN`) exists for cutting a full binary release with assets.
