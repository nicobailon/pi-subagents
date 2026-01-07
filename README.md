# pi-async-subagents

Pi extension for delegating tasks to subagents with async support, output truncation, debug artifacts, progress tracking, and optional session sharing.

## Features (beyond base)

- **Output Truncation**: Configurable byte/line limits via `maxOutput`
- **Debug Artifacts**: Input/output/JSONL/metadata files per task
- **Session Logs**: JSONL + optional HTML export; share link via GitHub Gist
- **Async Status Files**: Durable `status.json`, `events.jsonl`, and markdown logs for async runs
- **Async Widget**: Lightweight TUI widget shows background run progress
- **Session-scoped Notifications**: Async completions only notify the originating session

## Modes

| Mode | Async Support | Notes |
|------|---------------|-------|
| Single | Yes | `{ agent, task }` |
| Chain | Yes | `{ chain: [{agent, task}...] }` with `{previous}` placeholder |
| Parallel | Sync only | `{ tasks: [{agent, task}...] }` - auto-downgrades if async requested |

## Usage

**subagent tool:**
```typescript
{ agent: "worker", task: "refactor auth", async: false }
{ agent: "scout", task: "find todos", maxOutput: { lines: 1000 } }
{ tasks: [{ agent: "scout", task: "a" }, { agent: "scout", task: "b" }] }
{ chain: [{ agent: "scout", task: "find" }, { agent: "worker", task: "fix {previous}" }] }
{ agent: "scout", task: "investigate", share: true }
{ agent: "scout", task: "investigate", share: false, sessionDir: "/path/to/keep" }
```

**subagent_status tool:**
```typescript
{ id: "a53ebe46" }
{ dir: "/tmp/pi-async-subagent-runs/a53ebe46-..." }
```

## Parameters

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `agent` | string | - | Agent name (single mode) |
| `task` | string | - | Task string (single mode) |
| `tasks` | `{agent, task, cwd?}[]` | - | Parallel tasks (sync only) |
| `chain` | `{agent, task, cwd?}[]` | - | Sequential steps (single/async supported); use `{previous}` |
| `agentScope` | `"user" \| "project" \| "both"` | `user` | Agent discovery scope |
| `async` | boolean | true | Background execution (single/chain only) |
| `cwd` | string | - | Override working directory |
| `maxOutput` | `{bytes?, lines?}` | 200KB, 5000 lines | Truncation limits for final output |
| `artifacts` | boolean | true | Write debug artifacts |
| `includeProgress` | boolean | false | Include full progress in result |
| `share` | boolean | true | Create shareable session log (requires `gh`) |
| `sessionDir` | string | temp | Directory to store session logs (enables sessions even if `share=false`) |

Status tool:

| Tool | Description |
|------|-------------|
| `subagent_status` | Inspect async run status by id or dir |

## Artifacts

Location: `{sessionDir}/subagent-artifacts/` or `/tmp/pi-subagent-artifacts/`

Files per task:
- `{runId}_{agent}_input.md` - Task prompt
- `{runId}_{agent}_output.md` - Full output (untruncated)
- `{runId}_{agent}.jsonl` - Event stream (sync only)
- `{runId}_{agent}_meta.json` - Timing, usage, exit code

## Session logs + share links

Session files are stored under a per-run session dir (temp by default). If `share=true` and `gh` is logged in,
the tool exports HTML and creates a private gist, then reports a share URL. Set `sessionDir` to keep session
logs outside `/tmp`.

## Async observability

Async runs write a dedicated observability folder:

```
/tmp/pi-async-subagent-runs/<id>/
  status.json
  events.jsonl
  subagent-log-<id>.md
```

`status.json` is the source of truth for async progress and powers the TUI widget. If you already use
`/status <id>` you can keep doing that; otherwise use:

```typescript
subagent_status({ id: "<id>" })
subagent_status({ dir: "/tmp/pi-async-subagent-runs/<id>" })
```

## Events

Async events:
- `subagent:started`
- `subagent:complete`

Legacy events (still emitted):
- `subagent_enhanced:started`
- `subagent_enhanced:complete`

## Files

```
├── index.ts           # Main extension (registerTool)
├── notify.ts          # Async completion notifications
├── subagent-runner.ts # Async runner
├── agents.ts          # Agent discovery
├── artifacts.ts       # Artifact management
└── types.ts           # Shared types
```
