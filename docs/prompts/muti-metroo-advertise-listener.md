# Muti Metroo: advertise each agent's dial-target listener over NodeInfo

You are working on the **Muti Metroo agent** (Go) at `github.com/Muti-Metroo/Muti-Metroo` (sibling repo to Muti-Metroo-Manager; in this dev tree it's at `../Muti-Metroo` from Muti-Metroo-Manager). Do **not** edit Muti-Metroo-Manager — that repo is consuming this change in a parallel session.

## Why this is needed

Muti-Metroo-Manager's "Generate Muti Metroo Agent Config" wizard pre-populates the new agent's `peers:` list from a "pick a peer to dial" picker. Today the picker pulls only the **local** agent's outbound peer table, so it can offer just the addresses that the *local* operator's agent currently dials — typically one or two. An operator preparing a config for an agent that should dial **LAMP** (a mesh member the local agent has no direct link to) gets nothing useful, even though LAMP is reachable transitively through the mesh.

The fix is to surface **each mesh member's own dial-target listener** as part of the `/api/topology` response. The local Muti-Metroo-Manager instance already proxies `/api/topology` straight from this agent and renders every member it sees — but the per-agent NodeInfo currently carries no listener address, only `socks5_addr`, `forward_endpoints`, `exit_routes`, etc.

Once each agent advertises its listener over NodeInfo, the wizard can list every mesh member with an advertised listener — including agents the local one has never dialed. Operators can then prepare a config for a brand-new agent that will dial LAMP directly, without first chaining through the local agent.

## What to build

### 1. Config: a per-listener `advertise` block

In the agent's YAML config, each listener entry already has `transport`, `address`, `path` (h2/ws), `plaintext`, etc. Add an optional **`advertise`** subkey:

```yaml
listeners:
  - transport: h2
    address: 0.0.0.0:3000
    path: /mesh
    plaintext: false
    advertise:
      address: kreata.ee:3000   # publicly reachable host:port new agents should dial
      path: /mesh               # only meaningful for h2/ws; default = listener.path
      # transport defaults to listener.transport
```

Behavior:

- `advertise` is **opt-in**. Without it, the listener is **not** propagated over NodeInfo — operators behind NAT or on internal-only listeners must not be auto-advertised.
- `advertise.address` is required when the block is present, must validate as `host:port` (reject `0.0.0.0:N`, `127.0.0.1:N`, `::N` — those are obviously wrong as dial targets and are common mistakes).
- `advertise.path` and `advertise.transport` default to the listener's own values; allow overriding only for unusual reverse-proxy setups.
- An agent may declare advertise on **multiple** listeners (e.g. one quic + one h2). Carry all of them.

### 2. NodeInfo wire format

NodeInfo (the per-agent struct flooded across the mesh) gains one optional field:

```go
type AdvertisedListener struct {
    Transport string `json:"transport"`        // "quic" | "h2" | "ws"
    Address   string `json:"address"`          // "host:port", no path
    Path      string `json:"path,omitempty"`   // for h2/ws; absent for quic
}

// In NodeInfo:
AdvertisedListeners []AdvertisedListener `json:"advertised_listeners,omitempty"`
```

Use the plural `advertised_listeners` from day one — even if most agents have one, the data model should support multi-transport advertisement without a future schema break.

Encoding rules:
- Empty/nil → omit the field entirely (don't emit `"advertised_listeners": []`).
- Order is config order (don't sort).
- Drop entries during NodeInfo serialization if `advertise.address` is empty — defensive.

### 3. Topology endpoint

The `/api/topology` handler builds `TopologyAgentInfo` for each known mesh member from its NodeInfo. Add the `advertised_listeners` field to the response struct:

```go
type TopologyAgentInfo struct {
    // ... existing fields ...
    AdvertisedListeners []AdvertisedListener `json:"advertised_listeners,omitempty"`
}
```

Pass through verbatim from each NodeInfo. The local agent should also include its own `advertised_listeners` (so the topology list is symmetric — every member, including the local one, surfaces its dial targets the same way).

### 4. Tests

- Config parser: roundtrip a YAML with and without `advertise`. Reject `0.0.0.0:443`, `127.0.0.1:8080`, `[::]:8080`. Accept `kreata.ee:3000`, `[2001:db8::1]:8080`, `1.2.3.4:443`.
- NodeInfo serializer: `advertised_listeners` omitted when empty; included when set; order preserved.
- Flooding: a freshly-joined agent that receives a NodeInfo from a peer with `advertised_listeners` set surfaces them in its own topology view.
- Backward compat: old agents (no `advertised_listeners`) decode without errors and surface `nil`.

### 5. Documentation

If `github.com/Muti-Metroo/Muti-Metroo-Manager/` (or the agent's own docs site) has a config reference, add a section for `listeners[].advertise`. One paragraph + the YAML example above is enough.

## Out of scope

- Auto-discovery (i.e. inferring a public address). Operators always set `advertise.address` explicitly.
- Health-checking advertised listeners. The wizard on the consuming side will treat an offline agent's listener as a stale entry and let the operator decide.
- Transport changes. Existing `listeners[]` schema for `transport`, `address`, `path`, `plaintext`, etc. is unchanged.
- Web UI changes. The Muti-Metroo-Manager repo (sibling) is being modified in parallel to consume this; do not touch it.

## How the consumer uses this

For context only — do not implement: Muti-Metroo-Manager's `ConfigWizard.tsx` will read `agent.advertised_listeners` from `/api/topology`, synthesize "available peer" candidates for every mesh member that has one (excluding `is_local`), and merge with the local agent's outbound peer table (current source). Topology-derived entries win on conflict; both sources are deduped by `agent.id`.

## Verify

1. Add a per-listener `advertise` block on the local dev agent (e.g. `kreata.ee:3000`).
2. Restart and `curl http://localhost:8080/api/topology | jq '.agents[] | {id, display_name, advertised_listeners}'`. Confirm the new field appears for the local agent.
3. Wait for NodeInfo flooding (one poll cycle) and check that other mesh members also surface the field once their configs are updated.
4. Run the agent test suite. Add the new tests above.

Keep the diff tight: schema + wire field + handler. Do not refactor unrelated config or topology code.
