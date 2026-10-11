# Muti Metroo: expose agent PID in topology response

You are working on the **Muti Metroo agent** (Go) at `github.com/Muti-Metroo/Muti-Metroo` (sibling repo to Muti-Metroo-Manager; in this dev tree it's at `../Muti-Metroo` from Muti-Metroo-Manager). Do **not** edit Muti-Metroo-Manager — that repo is consuming this change in a parallel session.

## Why this is needed

Muti-Metroo-Manager's agent panel (InfoTab) shows hostname, OS, version, uptime, and IPs for every mesh member. Operators sometimes need to locate the agent process on the host machine — to inspect resource usage, send a signal, attach a debugger, or confirm the right binary is running. Currently there is no way to get the agent's PID from the UI; the operator has to `ssh` in and `pgrep muti-metroo` or similar.

The fix is to include `pid` in the per-agent `TopologyAgentInfo` struct that the local agent returns from `/api/topology`. Muti-Metroo-Manager already proxies this endpoint and renders whatever fields are present; once the field exists, the consuming session will surface it in the Info tab.

## What to build

### 1. Add `pid` to NodeInfo

NodeInfo is the per-agent struct flooded across the mesh. Add one field:

```go
PID int `json:"pid,omitempty"`
```

Populate it with `os.Getpid()` when building the **local** agent's NodeInfo. Remote agents will include their own PID in their NodeInfo once they are also updated; until then the field is simply absent (`omitempty` ensures no `"pid": 0` noise).

### 2. Surface it in TopologyAgentInfo

The `/api/topology` handler maps NodeInfo entries to `TopologyAgentInfo` response structs. Add the field there too:

```go
PID int `json:"pid,omitempty"`
```

Copy the value straight from NodeInfo. The local agent should also include its own PID in the `local_agent` entry (not just the `agents` list).

### 3. Tests

- NodeInfo serializer: `pid` is included and non-zero for the local agent; `pid` is absent (not `0`) when not set.
- Topology handler: `TopologyAgentInfo.pid` matches `os.Getpid()` for the local entry.
- Backward compat: receiving a NodeInfo without `pid` decodes without errors, `pid` is zero/absent in the response.

## Out of scope

- Muti-Metroo-Manager UI changes — handled in the sibling repo's session.
- Exposing PID over any other endpoint (only topology is needed).
- Anything that changes how PID is collected or formatted beyond `os.Getpid()`.

## Verify

1. `curl http://localhost:8080/api/topology | jq '.local_agent.pid'` — should print the running agent's PID (non-zero).
2. Confirm it matches `pgrep -x muti-metroo` (or whatever the binary name is).
3. `curl http://localhost:8080/api/topology | jq '.agents[].pid'` — remote agents will show `null` until they are updated; that is expected.
4. Run the agent test suite; all existing tests must still pass.

Keep the diff tight: one new field in NodeInfo, one new field in TopologyAgentInfo, wired together in the handler.
