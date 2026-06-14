# pi-subagents-http: HTTP Transport Spec

## Intent

Replace pi-subagents' subprocess spawning with HTTP transport so a Pi orchestrator agent can delegate tasks to remote agents running in Docker containers. Each container runs server.mjs (or equivalent) exposing an HTTP API. The orchestrator discovers agents via a config file mapping names to URLs.

Primary use case: host-based Pi session orchestrating N containerized agents with isolated dependencies. Secondary: orchestrator itself in a container on the same Docker network, enabling multiple concurrent orchestration sessions.

## Context Package

### Relevant existing code

- `src/runs/foreground/execution.ts` — `runSingleAttempt()` at line 121 calls `spawn()` to run Pi as a child process. Reads JSONL from stdout pipe. This is the foreground/streaming transport boundary.
- `src/runs/background/async-execution.ts` — `spawnRunner()` at line 171 spawns a detached process writing status to filesystem. This is the async transport boundary.
- `src/runs/shared/pi-spawn.ts` — resolves Pi CLI binary path for subprocess spawning. Not needed for HTTP.
- `src/extension/index.ts` — tool registration, event handling, TUI widgets. Transport-agnostic. Keep.
- `src/extension/schemas.ts` — TypeBox schemas for subagent tool params. Keep.
- `src/shared/types.ts` — type definitions, constants, result structures. Keep (modify minimally).
- `src/agents/` — agent discovery, config, management. Replace discovery mechanism.
- `src/intercom/` — IPC between Pi sessions. Not applicable to HTTP model. Remove.
- `src/shared/fork-context.ts` — session branching via .jsonl files. Not applicable. Remove.
- `src/runs/shared/worktree.ts` — git worktree isolation. Containers provide isolation. Remove.
- `src/runs/shared/nested-events.ts` — nested subagent runs. Out of scope for v1. Remove.
- `src/tui/` — TUI rendering. Keep.
- `src/slash/` — slash commands. Keep (simplify).

### Reference: server.mjs API (paperclip-eval)

Current API on each agent container:
- `POST /invoke` — accepts `{ agentId, runId, context }`, returns `202 { runId, status: "accepted" }`
- Agent runs task asynchronously in background
- No status or result endpoints yet (must be added)

### Architectural constraints

- Extension must be a valid Pi package (TypeScript, discovered via package.json `pi.extensions`)
- Must work on Windows (host) and Linux (container)
- No new runtime dependencies beyond what pi-subagents already uses (node:http/https is stdlib)
- Agent containers are pre-existing — extension is client-only, does not manage container lifecycle
- Config file approach (not service discovery) — agents are known at startup

### Anti-patterns to avoid

- No subprocess spawning — that's the whole point of this fork
- No filesystem-based IPC — agents are remote
- No session file branching — context travels in HTTP payload
- No direct Pi SDK dependency for execution — agents run their own Pi instances

## Behavioral Contracts

### Agent Registry

```
GIVEN a config file at ~/.pi/agent/extensions/subagent-http/config.json
WHEN the extension loads
THEN it reads the agent registry and validates each entry has name, url, and optional metadata
AND agents are available via subagent({ action: "list" })
```

Config format:
```json
{
  "agents": [
    {
      "name": "researcher",
      "url": "http://researcher:8080",
      "description": "Research agent with web tools",
      "model": "deepseek/deepseek-chat"
    },
    {
      "name": "coder",
      "url": "http://localhost:8083",
      "description": "Coding agent with full file access"
    }
  ],
  "defaults": {
    "timeoutMs": 300000,
    "pollIntervalMs": 3000
  }
}
```

### Delegate (async — primary mode)

```
GIVEN a registered agent "researcher" at http://researcher:8080
WHEN subagent({ agent: "researcher", task: "Find market data on X" }) is called
THEN the extension POSTs to http://researcher:8080/invoke with { task, context? }
AND receives 202 { runId, status: "accepted" }
AND returns immediately with the runId and async status message
AND the run is tracked in local state for polling
```

### Status Check

```
GIVEN an active run with runId "abc123" delegated to "researcher"
WHEN subagent({ action: "status", id: "abc123" }) is called
THEN the extension GETs http://researcher:8080/status/abc123
AND returns the current state (running/completed/failed), progress info, and partial output if available
```

### Result Retrieval

```
GIVEN a completed run with runId "abc123"
WHEN the status shows state: "completed"
THEN the extension GETs http://researcher:8080/result/abc123
AND returns the agent's output text, usage stats, and exit status
AND the run is marked complete in local tracking
```

### Parallel Delegation

```
GIVEN registered agents "researcher" and "coder"
WHEN subagent({ tasks: [{ agent: "researcher", task: "..." }, { agent: "coder", task: "..." }] }) is called
THEN the extension POSTs to both agents concurrently
AND tracks both runs independently
AND returns combined status
```

### Timeout Handling

```
GIVEN a delegated run exceeding timeoutMs (default 300000ms)
WHEN the timeout fires
THEN the run is marked as timed out in local state
AND the result includes a timeout error
AND no attempt is made to kill the remote process (fire-and-forget)
```

### Connection Failure

```
GIVEN an agent URL that is unreachable
WHEN delegation is attempted
THEN the extension returns an error result immediately
AND does not retry (caller can retry explicitly)
```

## Edge Case Inventory

1. Agent URL unreachable at delegation time — immediate error, no retry
2. Agent URL reachable at delegation but unreachable at status poll — return last known state + connectivity error
3. Agent returns non-202 from /invoke — error with HTTP status and body
4. Agent returns 202 but /status endpoint doesn't exist yet — graceful degradation, treat as "running" until timeout
5. Multiple concurrent delegations to same agent — each gets unique runId, tracked independently
6. Config file missing — extension registers with zero agents, list action returns empty
7. Config file malformed JSON — extension logs error, registers with zero agents
8. Agent name collision in config — last entry wins
9. Orchestrator restarts mid-run — runs are lost (stateless, no persistence across sessions)
10. Very large result payload — truncate using existing pi-subagents truncation logic
11. Agent returns result before first status poll — result should still be retrievable

## Definition of Done

- [ ] Config file loading from `~/.pi/agent/extensions/subagent-http/config.json`
- [ ] Agent registry with list/get actions
- [ ] HTTP client: POST /invoke, GET /status/:runId, GET /result/:runId
- [ ] Async delegation (single agent)
- [ ] Async delegation (parallel — multiple agents)
- [ ] Status polling via subagent({ action: "status" })
- [ ] Result retrieval on completion
- [ ] Timeout handling
- [ ] Connection error handling
- [ ] TUI widget showing active remote runs
- [ ] All subprocess-related code removed or replaced
- [ ] Intercom code removed
- [ ] Worktree code removed
- [ ] Nested run code removed
- [ ] Fork context code removed
- [ ] Extension loads and registers tool in Pi
- [ ] README updated for HTTP transport usage
- [ ] Package.json updated (name, description, remove unused deps)

## Server-Side Contract (for agent containers)

The agent HTTP server must implement:

```
POST /invoke
  Request:  { task: string, context?: string, runId?: string }
  Response: 202 { runId: string, status: "accepted" }

GET /status/:runId
  Response: 200 {
    runId: string,
    state: "running" | "completed" | "failed",
    progress?: { toolCount: number, turnCount: number, currentTool?: string },
    partialOutput?: string
  }

GET /result/:runId
  Response: 200 {
    runId: string,
    state: "completed" | "failed",
    output: string,
    error?: string,
    usage?: { input: number, output: number, cost: number, turns: number },
    durationMs: number
  }
  OR 404 if runId not found
  OR 409 if still running
```

These endpoints need to be added to server.mjs in the paperclip-eval repo (separate work item, not part of this extension).

## Negative Space

What must not change:
- Pi extension API contract (registerTool, events, etc.)
- Tool name remains "subagent"
- Basic action schema (list, get, status, etc.)

Out of scope:
- Container lifecycle management (docker compose up/down)
- Service discovery (DNS, consul, etc.)
- Authentication between orchestrator and agents
- SSE/WebSocket streaming (v2)
- Session forking/branching over HTTP (v2)
- Chain execution (v2 — requires sequential step coordination)
- Nested subagent runs
- Intercom messaging
- Git worktree management
- Agent creation/update/delete management actions (agents are defined in config, not created at runtime)

Decisions reserved for human review:
- Whether to add auth headers to HTTP requests
- Whether chain mode should be in v1 or deferred
- Polling interval defaults

## Open Questions

(empty — all resolved in spec)
