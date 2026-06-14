# Extension: Heartbeat, Cancel, Notify

## Intent

Add agent health monitoring, cancel action, and investigate Pi notify API for result delivery. Makes the extension production-ready for real orchestration.

## Context Package

### Relevant existing code

- `src/extension/index.ts` — tool registration, 257 lines
- `src/extension/schemas.ts` — SubagentHttpParams TypeBox schema
- `src/transport/types.ts` — AgentEndpoint, HttpConfig, RemoteRun types
- `src/transport/http-client.ts` — invoke, getStatus, getResult, describe
- `src/transport/job-tracker.ts` — JobTracker class with background polling
- `src/transport/config.ts` — loadHttpConfig, getAgent, listAgents
- `skills/pi-subagents/SKILL.md` — LLM instructions

### Pi Extension API (peer dep)

- `pi.registerTool(tool)` — register a tool
- `pi.sendMessage(text, options?)` — inject message into conversation
- `pi.notify(text, options?)` — MAY exist for triggering new LLM turns (needs investigation)
- `pi.on("session_start" | "session_shutdown", handler)` — lifecycle hooks

## Behavioral Contracts

### Heartbeat (AgentMonitor)

```
GIVEN agents configured in config.json
WHEN the extension loads
THEN start a periodic health check (GET /health) for each agent where heartbeat !== false
AND track agent reachability in local state
AND log warnings when agents become unreachable
AND update status when agents recover

GIVEN an agent with heartbeat: false in config
WHEN the extension loads
THEN skip health monitoring for that agent
```

Config shape addition to AgentEndpoint:
```typescript
interface AgentEndpoint {
  // ... existing fields
  heartbeat?: boolean; // default true
}
```

Default interval: 30s. Configurable via `defaults.heartbeatIntervalMs`.

### Cancel action

```
GIVEN a tracked run with known runId
WHEN subagent({ action: "cancel", id: "abc123" }) is called
THEN POST /cancel/:runId to the remote agent
AND update local tracker state to "cancelled"
AND return confirmation

GIVEN an unknown run
WHEN subagent({ action: "cancel", id: "..." }) is called
THEN return error "No run found matching '...'"
```

### Notify investigation

```
GIVEN Pi extension API
WHEN investigating notification capabilities
THEN check if pi.notify() exists or if pi.sendMessage() accepts a triggerTurn option
AND if available, use it for async completion delivery
AND if not available, document in SKILL.md that LLM must poll
```

## Definition of Done

- [ ] AgentMonitor class in src/transport/agent-monitor.ts
- [ ] Heartbeat polling per agent (GET /health), configurable interval
- [ ] heartbeat: false config option per agent
- [ ] Agent reachability tracked, used by list action
- [ ] action: "cancel" added to schema and extension
- [ ] Cancel calls POST /cancel/:runId on remote server
- [ ] Pi notify API investigated, used if available
- [ ] SKILL.md updated with cancel action
- [ ] Types updated (AgentEndpoint.heartbeat, HttpConfig.defaults.heartbeatIntervalMs)
