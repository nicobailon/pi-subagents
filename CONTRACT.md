# Agent Server Contract

pi-subagents-http delegates tasks to remote agents via HTTP. Any server implementing this contract works with the extension — no Pi SDK dependency required.

## Endpoints

### Required

| Endpoint | Method | Request | Response | Notes |
|----------|--------|---------|----------|-------|
| `/invoke` | POST | `{ task: string, context?: string, correlationId?: string, traceparent?: string }` | `202 { runId: string, status: "accepted" }` | Must return immediately. Process task asynchronously. |
| `/result/:runId` | GET | — | `200 { runId, state, output, error?, usage?, durationMs, model? }` | `404` if unknown. `409 { error: "still_running" }` if not finished. |

### Recommended

| Endpoint | Method | Response | Fallback if missing |
|----------|--------|----------|---------------------|
| `/status/:runId` | GET | `200 { runId, state, startedAt?, durationMs?, progress? }` | Extension polls `/result` directly (gets 409 until done) |
| `/health` | GET | `200 { status: "ok" }` | Agent monitor skips health checks |
| `/describe` | GET | `200 { name, description?, model?, tools?, status? }` | Extension uses name from config.json |

### Optional

| Endpoint | Method | Response | Fallback if missing |
|----------|--------|----------|---------------------|
| `/cancel/:runId` | POST | `200 { runId, state: "cancelled" }` | Extension marks run as failed locally, server keeps running |

## Response Schemas

### POST /invoke → 202

```json
{
  "runId": "unique-id-string",
  "status": "accepted"
}
```

The `runId` is server-generated. All subsequent queries use this ID.

### GET /result/:runId → 200

```json
{
  "runId": "abc123",
  "state": "completed",
  "output": "The agent's final text response",
  "error": null,
  "usage": {
    "input": 15000,
    "output": 500,
    "cacheRead": 0,
    "cost": 0,
    "turns": 3
  },
  "durationMs": 45000,
  "model": "deepseek/deepseek-chat"
}
```

`state` is `"completed"` or `"failed"`. The `output` field contains the agent's final prose — same text an LLM would see as its assistant response. If the agent wrote artifacts, artifact URIs appear in the output text.

### GET /result/:runId → 409 (still running)

```json
{
  "error": "still_running",
  "state": "running"
}
```

### GET /status/:runId → 200

```json
{
  "runId": "abc123",
  "state": "queued",
  "startedAt": "2026-01-01T00:00:00Z",
  "durationMs": 5000,
  "progress": {
    "turnCount": 2
  }
}
```

States: `queued`, `running`, `completed`, `failed`, `timeout`, `cancelled`.

### GET /describe → 200

```json
{
  "name": "researcher",
  "description": "Research agent with web search and scraping tools",
  "model": "deepseek/deepseek-chat",
  "tools": ["web_search", "web_fetch", "scrape_apify"],
  "extensions": ["web-search", "web-scrape", "artifacts"],
  "status": "ready"
}
```

`status`: `ready`, `busy`, `starting`.

### POST /cancel/:runId → 200

```json
{
  "runId": "abc123",
  "state": "cancelled"
}
```

Returns `404` if unknown, `409` if already finished.

## Minimal Implementation

A server only needs to implement `/invoke` (POST, 202) and `/result/:runId` (GET, 200/404/409). Everything else has fallback behavior in the extension.

The simplest possible server:

```javascript
import http from "node:http";
import { randomUUID } from "node:crypto";

const runs = new Map();

http.createServer(async (req, res) => {
  if (req.method === "POST" && req.url === "/invoke") {
    const body = JSON.parse(await readBody(req));
    const runId = randomUUID();
    runs.set(runId, { state: "running", output: "" });
    res.writeHead(202, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ runId, status: "accepted" }));
    // Process task asynchronously
    processTask(body.task, runId);
    return;
  }

  if (req.method === "GET" && req.url.startsWith("/result/")) {
    const runId = req.url.slice(8);
    const run = runs.get(runId);
    if (!run) { res.writeHead(404); res.end('{"error":"not_found"}'); return; }
    if (run.state === "running") { res.writeHead(409); res.end('{"error":"still_running"}'); return; }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(run));
    return;
  }

  res.writeHead(404); res.end();
}).listen(8080);
```

## Configuration

The extension reads `~/.pi/agent/extensions/subagent-http/config.json`:

```json
{
  "agents": [
    {
      "name": "researcher",
      "url": "http://localhost:8082",
      "description": "Optional fallback if /describe unavailable",
      "timeoutMs": 600000,
      "heartbeat": false
    }
  ],
  "defaults": {
    "timeoutMs": 300000,
    "pollIntervalMs": 3000,
    "heartbeatIntervalMs": 30000
  }
}
```

`name` is required — this is how the LLM references the agent in `subagent({ agent: "researcher" })`. Case-insensitive matching. If `/describe` returns a different name, the extension warns but uses the config name.
