# pi-subagents-http End-to-End Test Plan

## Prerequisites

- Docker Desktop running
- paperclip-eval on `feat/pi-subagents-http` branch
- pi-subagents-http on `feat/http-transport` branch
- Pi installed on host (`pi --version`)

## Pre-flight

### 1. Rebuild containers

```bash
cd ~/repos/paperclip-eval
docker compose build ceo researcher data writer
docker compose up -d ceo researcher data writer
```

Wait for healthy:
```bash
docker compose ps
```

### 2. Verify new endpoints

```bash
curl -s http://localhost:8082/describe | jq .
curl -s http://localhost:8082/health | jq .
curl -s http://localhost:8083/describe | jq .
curl -s http://localhost:8084/describe | jq .
```

All should return JSON with name, model, status fields.

### 3. Install pi-subagents-http on host

```bash
pi install ~/repos/pi-subagents-http
```

Verify:
```bash
pi extensions list 2>/dev/null || ls ~/.pi/agent/npm/node_modules/pi-subagents-http/package.json
```

### 4. Create config

```bash
mkdir -p ~/.pi/agent/extensions/subagent-http
```

Write `~/.pi/agent/extensions/subagent-http/config.json`:
```json
{
  "agents": [
    { "url": "http://localhost:8082" },
    { "url": "http://localhost:8083" },
    { "url": "http://localhost:8084" }
  ],
  "defaults": {
    "timeoutMs": 300000,
    "pollIntervalMs": 3000
  }
}
```

## Test Sequence

Run each test in a Pi session on the host. Start Pi in any directory:
```bash
pi
```

### Test 1: Discovery

```
subagent({ action: "list" })
```

**Expected:** 3 agents listed with status icons, names from /describe (Researcher, Data Analyst, Writer), models, capabilities. No "unreachable" errors.

**Pass criteria:** All 3 agents show status "ready" (●).

### Test 2: Single delegation

```
subagent({ agent: "researcher", task: "List 3 open-source alternatives to Paperclip for multi-agent orchestration. One paragraph each." })
```

**Expected:** "Delegated to researcher [xxxxxxxx]" message with runId.

**Pass criteria:** 202 accepted, no connection errors.

### Test 3: Status polling

```
subagent({ action: "status" })
```

Then with specific id (use prefix from test 2):
```
subagent({ action: "status", id: "<first 8 chars>" })
```

**Expected:** Shows run state (running → completed), elapsed time. On completion: output text, model, usage stats.

**Pass criteria:** State transitions correctly. Completed run shows full output.

### Test 4: triggerTurn notification

After test 2's delegation, wait without typing. If the run completes while idle, the LLM should receive a notification and start a new turn automatically.

**Expected:** "✓ Remote subagent researcher completed: ..." message appears and LLM reacts.

**Pass criteria:** LLM gets a new turn without user input. If this fails, the LLM must be prompted to check status manually (known limitation if Pi version doesn't support triggerTurn on custom messages).

### Test 5: Parallel delegation

```
subagent({
  tasks: [
    { agent: "researcher", task: "Compare DuckDB vs ClickHouse for embedded analytics in 2 sentences" },
    { agent: "writer", task: "Write a haiku about multi-agent orchestration" }
  ]
})
```

**Expected:** Both dispatched with individual runIds. "Parallel delegation:" summary with ✓ for each.

**Pass criteria:** Both agents receive tasks, both complete independently. `subagent({ action: "status" })` shows both runs.

### Test 6: Cancel

```
subagent({ agent: "data", task: "Write a 5000 word essay on the history of computing from 1940 to 2025 with citations" })
```

Immediately after:
```
subagent({ action: "cancel", id: "<runId prefix>" })
```

**Expected:** "Cancelled run xxxxxxxx (data)" confirmation.

**Pass criteria:** Run state changes to cancelled/failed. Server aborts the Pi session.

### Test 7: Error handling

```
subagent({ agent: "nonexistent", task: "test" })
```

**Expected:** "Unknown agent: nonexistent. Use subagent({ action: "list" }) to see available agents."

**Pass criteria:** Clear error, no crash.

### Test 8: Context passing

```
subagent({
  agent: "researcher",
  task: "What framework best fits our requirements?",
  context: "We need: async task delegation, Docker container support, HTTP transport, free LLM models only. Budget: $0/month for orchestration platform."
})
```

**Expected:** Agent receives both task and context (concatenated). Response references the specific constraints.

**Pass criteria:** Agent output reflects the context, not a generic answer.

## Cleanup

```bash
# Remove pi-subagents-http from Pi (if needed)
pi uninstall pi-subagents-http

# Or keep installed for continued eval
```

## Troubleshooting

**"No remote agents configured"** — config.json missing or wrong path. Check `~/.pi/agent/extensions/subagent-http/config.json`.

**"Unknown agent: researcher"** — /describe returned a different name than expected. Use `subagent({ action: "list" })` to see actual names, then use those.

**Connection refused** — containers not running or not rebuilt. `docker compose ps` to check. Rebuild if needed.

**Agent gets "Wake reason: heartbeat"** — server.mjs doesn't have the `body.task` check in extractPrompt. Rebuild containers.

**triggerTurn doesn't work** — Pi version mismatch. Host Pi v0.75.5 may not support `triggerTurn` on custom messages. Fall back to manual polling.
