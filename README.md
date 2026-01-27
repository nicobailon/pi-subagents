<p>
  <img src="banner.png" alt="pi-subagents" width="1100">
</p>

# pi-subagents

Pi extension for delegating tasks to subagents with chains, parallel execution, TUI clarification, and async support.

https://github.com/user-attachments/assets/702554ec-faaf-4635-80aa-fb5d6e292fd1

## Installation

```bash
npx pi-subagents
```

This clones the extension to `~/.pi/agent/extensions/subagent/`. To update, run the same command. To remove:

```bash
npx pi-subagents --remove
```

## Features (beyond base)

- **Skill Injection**: Agents declare skills in frontmatter; skills get injected into system prompts
- **Parallel-in-Chain**: Fan-out/fan-in patterns with `{ parallel: [...] }` steps within chains
- **Chain Clarification TUI**: Interactive preview/edit of chain templates and behaviors before execution
- **Agent Frontmatter Extensions**: Agents declare default chain behavior (`output`, `defaultReads`, `defaultProgress`, `skill`)
- **Chain Artifacts**: Shared directory at `/tmp/pi-chain-runs/{runId}/` for inter-step files
- **Solo Agent Output**: Agents with `output` write to temp dir and return path to caller
- **Live Progress Display**: Real-time visibility during sync execution showing current tool, recent output, tokens, and duration
- **Output Truncation**: Configurable byte/line limits via `maxOutput`
- **Debug Artifacts**: Input/output/JSONL/metadata files per task
- **Session Logs**: JSONL session files with paths shown in output
- **Async Status Files**: Durable `status.json`, `events.jsonl`, and markdown logs for async runs
- **Async Widget**: Lightweight TUI widget shows background run progress
- **Session-scoped Notifications**: Async completions only notify the originating session

## Modes

| Mode | Async Support | Notes |
|------|---------------|-------|
| Single | Yes | `{ agent, task }` - agents with `output` write to temp dir |
| Chain | Yes* | `{ chain: [{agent, task}...] }` with `{task}`, `{previous}`, `{chain_dir}` variables |
| Parallel | Sync only | `{ tasks: [{agent, task}...] }` - auto-downgrades if async requested |

*Chain defaults to sync with TUI clarification. Use `clarify: false` to enable async (sequential-only chains; parallel-in-chain requires sync mode).

**Clarify TUI for single/parallel:**

Single and parallel modes also support the clarify TUI for previewing/editing parameters before execution. Unlike chains, they default to no TUI - use `clarify: true` to enable:

```typescript
// Single agent with clarify TUI
{ agent: "scout", task: "Analyze the codebase", clarify: true }

// Parallel tasks with clarify TUI
{ tasks: [{agent: "scout", task: "Analyze frontend"}, ...], clarify: true }
```

**Clarification TUI keybindings:**

*Navigation mode:*
- `Enter` - Run
- `Esc` - Cancel
- `↑↓` - Navigate between steps/tasks (parallel, chain)
- `e` - Edit task/template (all modes)
- `m` - Select model (all modes)
- `t` - Select thinking level (all modes)
- `s` - Select skills (all modes)
- `w` - Edit writes/output file (single, chain only)
- `r` - Edit reads list (chain only)
- `p` - Toggle progress tracking (chain only)

*Model selector mode:*
- `↑↓` - Navigate model list
- `Enter` - Select model
- `Esc` - Cancel (keep current model)
- Type to filter (fuzzy search by model name or provider)

*Thinking level selector mode:*
- `↑↓` - Navigate level list
- `Enter` - Select level
- `Esc` - Cancel (keep current level)

*Skill selector mode:*
- `↑↓` - Navigate skill list
- `Space` - Toggle skill selection
- `Enter` - Confirm selection
- `Esc` - Cancel (keep current skills)
- Type to filter (fuzzy search by name or description)

*Edit mode (full-screen editor with word wrapping):*
- `Esc` - Save changes and exit
- `Ctrl+C` - Discard changes and exit
- `←→` - Move cursor left/right
- `↑↓` - Move cursor up/down by display line (auto-scrolls)
- `Page Up/Down` or `Shift+↑↓` - Move cursor by viewport (12 lines)
- `Home/End` - Start/end of current display line
- `Ctrl+Home/End` - Start/end of text

## Agent Frontmatter

Agents can declare default chain behavior in their frontmatter:

```yaml
---
name: scout
description: Fast codebase recon
tools: read, grep, find, ls, bash
model: claude-haiku-4-5
skill: safe-bash, chrome-devtools  # comma-separated skills to inject
output: context.md           # writes to {chain_dir}/context.md
defaultReads: context.md     # comma-separated files to read
defaultProgress: true        # maintain progress.md
interactive: true            # (parsed but not enforced in v1)
---
```

**Resolution priority:** step override > agent frontmatter > disabled

## Skills

Skills are specialized instructions loaded from SKILL.md files and injected into the agent's system prompt.

**Skill locations:**
- Project: `.pi/skills/{name}/SKILL.md` (higher priority)
- User: `~/.pi/agent/skills/{name}/SKILL.md`

**Usage:**
```typescript
// Agent with skills from frontmatter
{ agent: "scout", task: "..." }  // uses agent's default skills

// Override skills at runtime
{ agent: "scout", task: "...", skill: "tmux, safe-bash" }

// Disable all skills (including agent defaults)
{ agent: "scout", task: "...", skill: false }

// Chain with chain-level skills (additive to agent skills)
{ chain: [...], skill: "code-review" }

// Chain step with skill override
{ chain: [
  { agent: "scout", skill: "safe-bash" },  // only safe-bash
  { agent: "worker", skill: false }        // no skills at all
]}
```

**Skill injection format:**
```xml
<skill name="safe-bash">
[skill content from SKILL.md, frontmatter stripped]
</skill>
```

**Missing skills:** If a skill cannot be found, execution continues with a warning shown in the result summary.

## Usage

**subagent tool:**
```typescript
// Single agent
{ agent: "worker", task: "refactor auth" }
{ agent: "scout", task: "find todos", maxOutput: { lines: 1000 } }
{ agent: "scout", task: "investigate", output: false }  // disable file output

// Parallel (sync only)
{ tasks: [{ agent: "scout", task: "a" }, { agent: "scout", task: "b" }] }

// Chain with TUI clarification (default)
{ chain: [
  { agent: "scout", task: "Gather context for auth refactor" },
  { agent: "planner" },  // task defaults to {previous}
  { agent: "worker" },   // uses agent defaults for reads/progress
  { agent: "reviewer" }
]}

// Chain without TUI (enables async)
{ chain: [...], clarify: false, async: true }

// Chain with behavior overrides
{ chain: [
  { agent: "scout", task: "find issues", output: false },  // text-only, no file
  { agent: "worker", progress: false }  // disable progress tracking
]}

// Chain with parallel step (fan-out/fan-in)
{ chain: [
  { agent: "scout", task: "Gather context for the codebase" },
  { parallel: [
    { agent: "worker", task: "Implement auth based on {previous}" },
    { agent: "worker", task: "Implement API based on {previous}" }
  ]},
  { agent: "reviewer", task: "Review all changes from {previous}" }
]}

// Parallel step with options
{ chain: [
  { agent: "scout", task: "Find all modules" },
  { parallel: [
    { agent: "worker", task: "Refactor module A" },
    { agent: "worker", task: "Refactor module B" },
    { agent: "worker", task: "Refactor module C" }
  ], concurrency: 2, failFast: true }  // limit concurrency, stop on first failure
]}
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
| `output` | `string \| false` | agent default | Override output file for single agent |
| `skill` | `string \| string[] \| false` | agent default | Override skills (comma-separated string, array, or false to disable) |
| `tasks` | `{agent, task, cwd?, skill?}[]` | - | Parallel tasks (sync only) |
| `chain` | ChainItem[] | - | Sequential steps with behavior overrides (see below) |
| `clarify` | boolean | true (chains) | Show TUI to preview/edit chain; implies sync mode |
| `agentScope` | `"user" \| "project" \| "both"` | `user` | Agent discovery scope |
| `async` | boolean | false | Background execution (requires `clarify: false` for chains) |
| `cwd` | string | - | Override working directory |
| `maxOutput` | `{bytes?, lines?}` | 200KB, 5000 lines | Truncation limits for final output |
| `artifacts` | boolean | true | Write debug artifacts |
| `includeProgress` | boolean | false | Include full progress in result |
| `share` | boolean | true | Create shareable session log |
| `sessionDir` | string | temp | Directory to store session logs |

**ChainItem** can be either a sequential step or a parallel step:

*Sequential step fields:*

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `agent` | string | required | Agent name |
| `task` | string | `{task}` or `{previous}` | Task template (required for first step) |
| `cwd` | string | - | Override working directory |
| `output` | `string \| false` | agent default | Override output filename or disable |
| `reads` | `string[] \| false` | agent default | Override files to read from chain dir |
| `progress` | boolean | agent default | Override progress.md tracking |
| `skill` | `string \| string[] \| false` | agent default | Override skills or disable all |

*Parallel step fields:*

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `parallel` | ParallelTask[] | required | Array of tasks to run concurrently |
| `concurrency` | number | 4 | Max concurrent tasks |
| `failFast` | boolean | false | Stop remaining tasks on first failure |

*ParallelTask fields:* (same as sequential step)

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `agent` | string | required | Agent name |
| `task` | string | `{previous}` | Task template |
| `cwd` | string | - | Override working directory |
| `output` | `string \| false` | agent default | Override output (namespaced to parallel-N/M-agent/) |
| `reads` | `string[] \| false` | agent default | Override files to read |
| `progress` | boolean | agent default | Override progress tracking |
| `skill` | `string \| string[] \| false` | agent default | Override skills or disable all |

Status tool:

| Tool | Description |
|------|-------------|
| `subagent_status` | Inspect async run status by id or dir |

## Chain Variables

Templates support three variables:

| Variable | Description |
|----------|-------------|
| `{task}` | Original task from first step (use in subsequent steps) |
| `{previous}` | Output from prior step (or aggregated outputs from parallel step) |
| `{chain_dir}` | Path to chain artifacts directory |

**Parallel output aggregation:** When a parallel step completes, all outputs are concatenated with clear separators:

```
=== Parallel Task 1 (worker) ===
[output from first task]

=== Parallel Task 2 (worker) ===
[output from second task]
```

This aggregated output becomes `{previous}` for the next step.

## Chain Directory

Each chain run creates `/tmp/pi-chain-runs/{runId}/` containing:
- `context.md` - Scout/context-builder output
- `plan.md` - Planner output  
- `progress.md` - Worker/reviewer shared progress
- `parallel-{stepIndex}/` - Subdirectories for parallel step outputs
  - `0-{agent}/output.md` - First parallel task output
  - `1-{agent}/output.md` - Second parallel task output
- Additional files as written by agents

Directories older than 24 hours are cleaned up on extension startup.

## Artifacts

Location: `{sessionDir}/subagent-artifacts/` or `/tmp/pi-subagent-artifacts/`

Files per task:
- `{runId}_{agent}_input.md` - Task prompt
- `{runId}_{agent}_output.md` - Full output (untruncated)
- `{runId}_{agent}.jsonl` - Event stream (sync only)
- `{runId}_{agent}_meta.json` - Timing, usage, exit code

## Session Logs

Session files (JSONL) are stored under a per-run session dir (temp by default). The session file path is shown in output. Set `sessionDir` to keep session logs outside `/tmp`.

## Live progress (sync mode)

During sync execution, the collapsed view shows:
- Header: `... chain 1/2 | 8 tools, 1.4k tok, 38s`
- Chain visualization with status: `✓scout → ●planner` (✓=done, ●=running, ○=pending, ✗=failed)
- Current tool: `> read: packages/tui/src/...`
- Recent output lines (last 2-3 lines)
- Hint: `(ctrl+o to expand)`

Press **Ctrl+O** to expand the full streaming view with complete output per step.

> **Note:** Chain visualization is only shown for sequential chains. Chains with parallel steps show the header and progress but not the step-by-step visualization.

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
├── agents.ts          # Agent discovery + frontmatter parsing
├── skills.ts          # Skill resolution, caching, and discovery
├── settings.ts        # Chain behavior resolution, templates, chain dir
├── chain-clarify.ts   # TUI component for chain clarification
├── chain-execution.ts # Chain orchestration (sequential + parallel)
├── async-execution.ts # Async/background execution support
├── execution.ts       # Core runSync for single agent execution
├── render.ts          # TUI rendering (widget, tool result display)
├── artifacts.ts       # Artifact management
├── formatters.ts      # Output formatting utilities
├── schemas.ts         # TypeBox parameter schemas
├── utils.ts           # Shared utility functions
├── types.ts           # Shared types
├── subagent-runner.ts # Async runner
└── notify.ts          # Async completion notifications
```
