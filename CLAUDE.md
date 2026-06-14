# CLAUDE.md

## Constraints

- Never use powershell
- main is protected — squash merge only, branches auto-delete
- Land changes via `gh pr create` + `gh pr merge --squash`, never `git merge`
- Branch naming: `feat/`, `fix/`, `refactor/`, `chore/`, `docs/` prefixes

## Architecture

Pi extension that registers a `subagent` tool for delegating tasks to remote agents over HTTP.

```
Pi CLI (Node v22)
  └─ subagent extension (src/extension/index.ts)
       ├─ single:   { agent, task }              → blocks until done
       ├─ parallel:  { tasks: [...] }             → blocks until all done
       ├─ async:     { agent, task, async: true }  → fire-and-forget
       └─ management: { action: "list"|"status"|"cancel" }

Transport layer (src/transport/)
  └─ POST /invoke (202) → poll GET /status/:runId → GET /result/:runId
```

Config lives at `~/.pi/agent/extensions/subagent-http/config.json` — defines agent endpoints and defaults.

## Key files

| Path | Purpose |
|------|---------|
| `src/extension/index.ts` | Extension entry — registers `subagent` tool, orchestrates delegation |
| `src/extension/schemas.ts` | Typebox input schemas for tool params |
| `src/extension/config.ts` | Extension-level config loader |
| `src/transport/http-client.ts` | HTTP client — invoke, getStatus, getResult, cancelRun |
| `src/transport/poll.ts` | Adaptive polling with configurable tiers |
| `src/transport/agent-monitor.ts` | Health monitoring for remote agents |
| `src/transport/job-tracker.ts` | Tracks in-flight async jobs |
| `src/transport/config.ts` | Loads agent endpoint config from disk |
| `src/transport/types.ts` | Shared TypeScript types |
| `src/runs/shared/` | Shared run utilities |
| `CONTRACT.md` | Server API contract — remote agents must implement this |
| `skills/` | Pi skills bundled with the extension |

## Tests

```bash
node --experimental-strip-types --test test/unit/*.test.ts
# or
npm test
```

Unit tests live in `test/unit/`. No integration test harness currently exists.

## Gotchas

- Adaptive polling tiers: 2s for first 30s, 5s up to 2min, 10s up to 5min, 30s after that. Override with `fixedIntervalMs` in poll options.
- Pi SDK runs extensions in Node v22 (not Bun) — do not use Bun-specific APIs.
- Health monitoring config is per-agent in `config.json` — monitor intervals and thresholds are separate from poll intervals.
- `CONTRACT.md` is the source of truth for the remote agent HTTP API. Update it when changing transport behavior.
