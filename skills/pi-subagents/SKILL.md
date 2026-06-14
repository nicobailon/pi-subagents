---
name: pi-subagents
description: |
  Delegate tasks to remote agents running as HTTP services. Blocks until
  complete by default — no polling needed. Use for parallel research,
  implementation handoffs, and multi-agent coordination.
---

# Pi Subagents (HTTP)

Delegate tasks to remote agents over HTTP. Each agent runs as a container with its own model, tools, and dependencies. The tool blocks until the remote agent completes and returns the full result — no polling loop needed.

## Delegation

### Single agent

```typescript
subagent({ agent: "researcher", task: "Find market data on renewable energy trends" })
```

Blocks until the researcher completes. Returns the agent's full output, usage stats, and model info.

### Multiple agents in parallel

```typescript
subagent({
  tasks: [
    { agent: "researcher", task: "Research competitor pricing models" },
    { agent: "writer", task: "Draft a pricing comparison summary" }
  ]
})
```

All tasks dispatch concurrently. Blocks until ALL complete. Returns combined results.

You can also issue multiple `subagent()` tool calls in one message — each blocks independently, all run in parallel.

### Include context

```typescript
subagent({
  agent: "researcher",
  task: "What framework fits our requirements?",
  context: "Requirements: async delegation, Docker support, HTTP transport, free LLMs only."
})
```

### Async mode (fire-and-forget)

Add `async: true` to return immediately instead of blocking. Use `action: "status"` to check later.

```typescript
subagent({ agent: "researcher", task: "Long research task", async: true })
// returns immediately with runId
// later:
subagent({ action: "status", id: "abc123" })
```

### Custom poll interval

Override the adaptive backoff (2s→5s→10s→30s) for tasks with known duration:

```typescript
subagent({ agent: "data", task: "Run hourly ETL job", pollIntervalMs: 30000 })
```

## Management

```typescript
subagent({ action: "list" })                  // show available agents + health
subagent({ action: "status" })                 // show all tracked runs
subagent({ action: "status", id: "abc123" })   // check specific run
subagent({ action: "cancel", id: "abc123" })   // cancel a running task
```

## Orchestration Patterns

### Research then implement

```typescript
// Step 1: blocks until research completes
const research = subagent({ agent: "researcher", task: "Research OAuth 2.1 best practices for SPAs" })

// Step 2: use research output directly (it's in the tool result)
subagent({ agent: "coder", task: `Implement OAuth 2.1 PKCE flow. Research findings:\n${research}` })
```

### Parallel review

```typescript
subagent({
  tasks: [
    { agent: "researcher", task: "Review API design for security concerns" },
    { agent: "researcher", task: "Review API design for performance bottlenecks" }
  ]
})
// Both results returned together — synthesize locally
```

### Fan out then synthesize

```typescript
subagent({
  tasks: [
    { agent: "researcher", task: "Research pricing of competitor A" },
    { agent: "researcher", task: "Research pricing of competitor B" },
    { agent: "researcher", task: "Research pricing of competitor C" }
  ]
})
// All three results in one response — synthesize comparison
```

## Structured Output (Workproducts)

When you need structured, machine-readable research output — not prose — include workproduct instructions in the task:

```typescript
subagent({
  agent: "researcher",
  task: `Research faceless Instagram accounts in the finance niche.

For EACH account found, use record_finding to create a structured finding with:
- claim: the specific factual assertion (e.g. "@account has 1.2M followers")
- sources: array with source_url, source_type, source_reliability (A-F), information_credibility (1-6)
- style: "intelligence"
- topic_tags: ["faceless", "instagram", "finance"]
- entities: account names, platform names

After recording all findings, publish a summary via write_artifact with type "dataset".`
})
```

Without these instructions, agents default to markdown prose. The workproduct/findings system (record_finding, ADMIRALTY grading) is available on research agents but only activates when the task explicitly requests it.

### Artifact type conventions

When delegating tasks that produce artifacts, specify the expected type:
- `research` — raw findings, analysis, source material
- `dataset` — structured data (JSON, CSV, JSONL)
- `report` — final deliverable for humans
- `brief` — executive summary, short-form output

Example:
```typescript
subagent({
  agent: "writer",
  task: "Write the final cross-platform comparison report. Publish via write_artifact with type 'report'."
})
```

## Configuration

`~/.pi/agent/extensions/subagent-http/config.json`:

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

Agent names in config are the names you use in `subagent()` calls. Health and capabilities are discovered via `GET /describe` on each URL.

Per-agent options: `timeoutMs`, `heartbeat: false` (disable health monitoring).

## Important Constraints

- **Blocking by default.** The tool call does not return until the remote agent finishes. This is intentional — no polling loops needed.
- **Cancellation available.** Use `action: "cancel"` to abort a running task.
- **No session continuity.** Each delegation is a fresh request. The remote agent does not see the orchestrator's conversation history.
- **No chains.** Sequence tasks by using the output of one delegation as input to the next.
- **Timeouts are per-agent.** Default 300s. Override in config or per-call via `pollIntervalMs`.

## Error Handling

**"Unknown agent"** — name doesn't match config. Run `subagent({ action: "list" })`.

**"No remote agents configured"** — config.json missing. Create it at the path above.

**Connection refused** — container not running at the configured URL.

**Timeout** — agent didn't complete within timeout. Consider increasing `timeoutMs` in config or using `async: true`.
