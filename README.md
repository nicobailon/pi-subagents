# pi-subagents-http

Pi extension for delegating tasks to remote agents over HTTP. Fork of [pi-subagents](https://github.com/nicobailon/pi-subagents) replacing subprocess spawning with HTTP transport.

Blocks until the remote agent completes by default — no polling loops needed. Parallel delegation runs concurrently and returns all results together.

## Why

pi-subagents spawns child Pi processes on the same machine. This fork delegates to remote agents running as HTTP services — typically Docker containers with their own dependencies, models, and tools.

Use cases:
- Host Pi session orchestrating containerized agents with isolated dependencies
- Multiple orchestrator sessions coordinating shared agent pools
- Agents running on different machines or cloud infrastructure

## Install

```bash
pi install pi-subagents-http
```

Or add to your Pi settings:
```json
{
  "packages": ["pi-subagents-http"]
}
```

## Configure

Create `~/.pi/agent/extensions/subagent-http/config.json`:

```json
{
  "agents": [
    { "name": "researcher", "url": "http://localhost:8082" },
    { "name": "data", "url": "http://localhost:8083" },
    { "name": "writer", "url": "http://localhost:8084" }
  ],
  "defaults": {
    "timeoutMs": 300000,
    "pollIntervalMs": 3000
  }
}
```

Per-agent options: `timeoutMs` (override default), `heartbeat: false` (disable health monitoring).

## Usage

### Single delegation (blocking)

```
subagent({ agent: "researcher", task: "Find market data on renewable energy" })
```

Blocks until complete. Returns the agent's full output, usage stats, and model info.

### Parallel delegation (blocking)

```
subagent({
  tasks: [
    { agent: "researcher", task: "Research competitor pricing" },
    { agent: "writer", task: "Draft pricing comparison summary" }
  ]
})
```

All tasks dispatch concurrently. Blocks until ALL complete. Returns combined results.

### Async delegation (fire-and-forget)

```
subagent({ agent: "researcher", task: "Long research task", async: true })
subagent({ action: "status", id: "abc123" })
```

### Custom poll interval

```
subagent({ agent: "data", task: "Run ETL job", pollIntervalMs: 30000 })
```

Default: adaptive backoff (2s → 5s → 10s → 30s).

### Management

```
subagent({ action: "list" })                  // agents + health status
subagent({ action: "status" })                 // all tracked runs
subagent({ action: "status", id: "abc123" })   // specific run
subagent({ action: "cancel", id: "abc123" })   // cancel running task
```

## Server Contract

Each remote agent must expose:

| Endpoint | Method | Request | Response |
|----------|--------|---------|----------|
| `/invoke` | POST | `{ task, context?, traceparent?, correlationId? }` | `202 { runId, status: "accepted" }` |
| `/status/:runId` | GET | — | `200 { runId, state, startedAt, durationMs, progress }` |
| `/result/:runId` | GET | — | `200 { runId, state, output, error?, usage?, durationMs, model? }` |
| `/cancel/:runId` | POST | — | `200 { runId, state: "cancelled" }` |
| `/describe` | GET | — | `200 { name, description, role, model, tools, extensions, status }` |
| `/health` | GET | — | `200 { status: "ok" }` |

States: `queued`, `running`, `completed`, `failed`, `timeout`, `cancelled`.

`/result/:runId` returns 404 if unknown, 409 if still running.

## Architecture

```
Pi Session (orchestrator)
  │
  └─ subagent({ agent: "researcher", task: "..." })
      │
      ├─ POST /invoke → 202 { runId }
      │
      ├─ [extension polls internally — adaptive backoff]
      │   └─ GET /status/:runId → { state: "running" }
      │   └─ GET /status/:runId → { state: "completed" }
      │
      ├─ GET /result/:runId → { output, usage, model }
      │
      └─ returns full result to LLM (one tool call, one result)
```

## License

MIT
