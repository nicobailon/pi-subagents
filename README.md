<p>
  <img src="banner.png" alt="pi-subagents" width="1100">
</p>

# pi-subagents

Pi extension for delegating tasks to subagents with chains, parallel execution, TUI clarification, and async support.

https://github.com/user-attachments/assets/702554ec-faaf-4635-80aa-fb5d6e292fd1

## Installation

```bash
pi install npm:pi-subagents
```

To remove:

```bash
npx pi-subagents --remove
```

## Agents

Agents are markdown files with YAML frontmatter that define specialized subagent configurations.

**Agent file locations:**

| Scope | Path |
|-------|------|
| User | `~/.pi/agent/agents/{name}.md` |
| Project | `.pi/agents/{name}.md` (searches up directory tree) |

Use `agentScope` parameter to control discovery: `"user"` (default), `"project"`, or `"both"` (project takes priority).

**Agent frontmatter:**

```yaml
---
name: scout
description: Fast codebase recon
tools: read, grep, find, ls, bash, mcp:chrome-devtools  # mcp: requires pi-mcp-adapter
model: claude-haiku-4-5
thinking: high               # off, minimal, low, medium, high, xhigh
skill: safe-bash, chrome-devtools  # comma-separated skills to inject
output: context.md           # writes to {chain_dir}/context.md
defaultReads: context.md     # comma-separated files to read
defaultProgress: true        # maintain progress.md
interactive: true            # (parsed but not enforced in v1)
---

Your system prompt goes here (the markdown body after frontmatter).
```

The `thinking` field sets a default extended thinking level for the agent. At runtime it's appended as a `:level` suffix to the model string (e.g., `claude-sonnet-4-5:high`). If the model already has a thinking suffix (from a chain-clarify override), the agent's default is not double-applied.

**MCP Tools**

Agents can use MCP server tools directly (requires the [pi-mcp-adapter](https://github.com/nicobailon/pi-mcp-adapter) extension). Add `mcp:` prefixed entries to the `tools` field:

```yaml
# All tools from a server
tools: read, bash, mcp:chrome-devtools

# Specific tools from a server
tools: read, bash, mcp:github/search_repositories, mcp:github/get_file_contents
```

| Syntax | Effect |
|--------|--------|
| `mcp:server-name` | All tools from that MCP server |
| `mcp:server-name/tool_name` | One specific tool |

The `mcp:` items are additive — they don't affect which builtins the agent gets. `tools: mcp:chrome-devtools` (with no regular tools listed) gives the agent all default builtins plus chrome-devtools tools. To restrict builtins, list them explicitly: `tools: read, bash, mcp:chrome-devtools`.

Subagents only get direct MCP tools when `mcp:` items are explicitly listed. Even if your `mcp.json` has `directTools: true` globally, a subagent without `mcp:` in its frontmatter won't get any direct tools — keeping it lean. The `mcp` proxy tool is still available for discovery if needed.

The MCP adapter's metadata cache must be populated for direct tools to work. On the first session with a new MCP server, tools will only be available through the `mcp` proxy. Restart Pi after the first session and direct tools become available.

**Resolution priority:** step override > agent frontmatter > disabled

## Quick Commands

| Command | Description |
|---------|-------------|
| `/run <agent> <task>` | Run a single agent with a task |
| `/chain agent1 "task1" -> agent2 "task2"` | Run agents in sequence with per-step tasks |
| `/parallel agent1 "task1" -> agent2 "task2"` | Run agents in parallel with per-step tasks |
| `/agents` | Open the Agents Manager overlay |

All commands validate agent names locally and tab-complete them, then route through the tool framework for full live progress rendering. Results are sent to the conversation for the LLM to discuss.

### Per-Step Tasks

Use `->` to separate steps and give each step its own task with quotes or `--`:

```
/chain scout "scan the codebase" -> planner "create implementation plan"
/parallel scanner "find security issues" -> reviewer "check code style"
```

Both double and single quotes work. The `--` delimiter also works: `/chain scout -- scan code -> planner -- analyze auth`.

Steps without a task inherit behavior from the execution mode: chain steps get `{previous}` (output from the prior step), parallel steps get the first available task as a fallback.

```
/chain scout "analyze auth" -> planner -> implementer
# scout: "analyze auth", planner: gets scout's output, implementer: gets planner's output
```

**Shared task (no `->`):** Space-separated agents with a single `--` task:

```
/chain scout planner -- analyze the auth system
/parallel scout reviewer -- check for security issues
```

### Inline Per-Step Config

Append `[key=value,...]` to any agent name to override its defaults:

```
/chain scout[output=context.md] "scan code" -> planner[reads=context.md] "analyze auth"
/run scout[model=anthropic/claude-sonnet-4] summarize this codebase
/parallel scanner[output=scan.md] "find issues" -> reviewer[output=review.md] "check style"
```

| Key | Example | Description |
|-----|---------|-------------|
| `output` | `output=context.md` | Write results to file (relative to chain dir for `/chain`/`/parallel`, temp dir for `/run`) |
| `reads` | `reads=a.md+b.md` | Read files before executing (`+` separates multiple) |
| `model` | `model=anthropic/claude-sonnet-4` | Override model for this step |
| `skills` | `skills=planning+review` | Override skills (`+` separates multiple) |
| `progress` | `progress` | Enable progress tracking |

Set `output=false`, `reads=false`, or `skills=false` to explicitly disable.

## Agents Manager

Press **Ctrl+Shift+A** or type `/agents` to open the Agents Manager overlay — a TUI for browsing, viewing, editing, creating, and launching agents and chains.

**Screens:**

| Screen | Description |
|--------|-------------|
| List | Browse all agents and chains with search/filter, scope badges, chain badges |
| Detail | View resolved prompt, frontmatter fields, recent run history |
| Edit | Edit fields with specialized pickers (model, thinking, skills, prompt editor) |
| Chain Detail | View chain steps with flow visualization and dependency map |
| Parallel Builder | Build parallel execution slots, add same agent multiple times, per-slot task overrides |
| Task Input | Enter task and launch with optional skip-clarify toggle |
| New Agent | Create from templates (Blank, Scout, Planner, Implementer, Code Reviewer, Blank Chain) |

**List screen keybindings:**
- `↑↓` — navigate agents/chains
- `Enter` — view detail
- Type any character — search/filter
- `Tab` — toggle selection (agents only)
- `Ctrl+N` — new agent from template
- `Ctrl+K` — clone current item
- `Ctrl+D` or `Del` — delete current item
- `Ctrl+R` — run selected (1 agent: launch, 2+: sequential chain)
- `Ctrl+P` — open parallel builder (from selection or cursor agent)
- `Esc` — clear query, then selection, then close overlay

**Parallel builder keybindings:**
- `↑↓` — navigate slots
- `Ctrl+A` — add agent (opens search picker)
- `Del` or `Ctrl+D` — remove slot
- `Enter` — edit per-slot task override
- `Ctrl+R` — continue to task input (requires 2+ slots)
- `Esc` — back to list

**Task input keybindings:**
- `Enter` — launch (or quick run if skip-clarify is on)
- `Tab` — toggle skip-clarify (defaults to on for all manager launches)
- `Esc` — back

**Multi-select workflow:** Select agents with `Tab`, then press `Ctrl+R` for a sequential chain or `Ctrl+P` to open the parallel builder. The parallel builder lets you add the same agent multiple times, set per-slot task overrides, and launch N agents in parallel. Slots without a custom task use the shared task entered on the next screen.

## Chain Files

Chains are `.chain.md` files stored alongside agent files. They define reusable multi-step pipelines.

**Chain file locations:**

| Scope | Path |
|-------|------|
| User | `~/.pi/agent/agents/{name}.chain.md` |
| Project | `.pi/agents/{name}.chain.md` |

**Format:**

```markdown
---
name: scout-planner
description: Gather context then plan implementation
---

## scout
output: context.md

Analyze the codebase for {task}

## planner
reads: context.md
model: anthropic/claude-sonnet-4-5:high
progress: true

Create an implementation plan based on {previous}
```

Each `## agent-name` section defines a step. Config lines (`output`, `reads`, `model`, `skills`, `progress`) go immediately after the header. A blank line separates config from the task text. Chains support the same three-state semantics as tool params: omitted (inherit from agent), value (override), `false` (disable).

Chains can be created from the Agents Manager template picker ("Blank Chain"), or saved from the chain-clarify TUI during execution.

## Features (beyond base)

- **Slash Commands**: `/run`, `/chain`, `/parallel` with tab-completion and live progress
- **Agents Manager Overlay**: Browse, view, edit, create, delete, and launch agents/chains from a TUI (`Ctrl+Shift+A`)
- **Management Actions**: LLM can list, inspect, create, update, and delete agent/chain definitions via `action` field
- **Chain Files**: Reusable `.chain.md` files with per-step config, saveable from the clarify TUI
- **Multi-select & Parallel**: Select agents in the overlay, launch as chain or parallel
- **Run History**: Per-agent JSONL recording of task, exit code, duration; shown on detail screen
- **Thinking Level**: First-class `thinking` frontmatter field with picker UI and runtime suffix application
- **Agent Templates**: Create agents from presets (Scout, Planner, Implementer, Code Reviewer, Blank Chain)
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
- `S` - Save current overrides to agent's frontmatter file (all modes)
- `W` - Save chain configuration to a `.chain.md` file (chain only)

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
- `Alt+←→` - Move cursor by word
- `↑↓` - Move cursor up/down by display line (auto-scrolls)
- `Page Up/Down` or `Shift+↑↓` - Move cursor by viewport (12 lines)
- `Home/End` - Start/end of current display line
- `Ctrl+Home/End` - Start/end of text
- `Alt+Backspace` - Delete word backward
- Paste supported (multi-line in multi-line editors)

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

## Management Actions

Agent definitions are not loaded into LLM context by default. Management actions let the LLM discover, inspect, create, and modify agent and chain definitions at runtime through the `subagent` tool — no manual file editing or restart required. Newly created agents are immediately usable in the same session. Set `action` and omit execution payloads (`task`, `chain`, `tasks`).

```typescript
// Discover all agents and chains (management defaults to both scopes)
{ action: "list" }
{ action: "list", agentScope: "project" }

// Inspect one agent or chain (searches both scopes)
{ action: "get", agent: "scout" }
{ action: "get", chainName: "review-pipeline" }

// Create agent
{ action: "create", config: {
  name: "Code Scout",
  description: "Scans codebases for patterns and issues",
  scope: "user",
  systemPrompt: "You are a code scout...",
  model: "anthropic/claude-sonnet-4",
  tools: "read, bash, mcp:github/search_repositories",
  skills: "parallel-scout",
  thinking: "high",
  output: "context.md",
  reads: "shared-context.md",
  progress: true
}}

// Create chain (presence of steps creates .chain.md)
{ action: "create", config: {
  name: "review-pipeline",
  description: "Scout then review",
  scope: "project",
  steps: [
    { agent: "scout", task: "Scan {task}", output: "context.md" },
    { agent: "reviewer", task: "Review {previous}", reads: ["context.md"] }
  ]
}}

// Update agent fields (merge semantics)
{ action: "update", agent: "scout", config: { model: "openai/gpt-4o" } }
{ action: "update", agent: "scout", config: { output: false, skills: "" } } // clear optional fields
{ action: "update", chainName: "review-pipeline", config: {
  steps: [
    { agent: "scout", task: "Scan {task}", output: "context.md" },
    { agent: "reviewer", task: "Improved review of {previous}", reads: ["context.md"] }
  ]
}}

// Delete definitions
{ action: "delete", agent: "scout" }
{ action: "delete", chainName: "review-pipeline" }
```

Notes:
- `create` uses `config.scope` (`"user"` or `"project"`), not `agentScope`.
- `update`/`delete` use `agentScope` only for scope disambiguation when the same name exists in both scopes.
- Agent config mapping: `reads -> defaultReads`, `progress -> defaultProgress`, and `tools` supports `mcp:` entries that map to direct MCP tools.
- To clear any optional field, set it to `false` or `""` (e.g., `{ model: false }` or `{ skills: "" }`). Both work for all string-typed fields.

## Parameters

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `agent` | string | - | Agent name (single mode) or target for management get/update/delete |
| `task` | string | - | Task string (single mode) |
| `action` | string | - | Management action: `list`, `get`, `create`, `update`, `delete` |
| `chainName` | string | - | Chain name for management get/update/delete |
| `config` | object | - | Agent or chain config for management create/update |
| `output` | `string \| false` | agent default | Override output file for single agent |
| `skill` | `string \| string[] \| false` | agent default | Override skills (comma-separated string, array, or false to disable) |
| `model` | string | agent default | Override model for single agent |
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
| `model` | string | agent default | Override model for this step |

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
| `model` | string | agent default | Override model for this task |

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

During sync execution, the collapsed view shows real-time progress for single, chain, and parallel modes.

**Chains:**
- Header: `... chain 1/2 | 8 tools, 1.4k tok, 38s`
- Chain visualization with status: `✓scout → ●planner` (✓=done, ●=running, ○=pending, ✗=failed)
- Current tool: `> read: packages/tui/src/...`
- Recent output lines (last 2-3 lines)

**Parallel:**
- Header: `... parallel 2/4 | 12 tools, 2.1k tok, 15s`
- Per-task step cards showing status icon, agent name, model, tool count, and duration
- Current tool and recent output for each running task

Press **Ctrl+O** to expand the full streaming view with complete output per step.

> **Note:** Chain visualization (the `✓scout → ●planner` line) is only shown for sequential chains. Chains with parallel steps show per-step cards instead.

## Nested subagent recursion guard

`pi-subagents` can spawn `pi` processes which themselves have access to the `subagent` tool. Unbounded nesting can easily lead to runaway recursion (slow, expensive, and hard to observe).

By default, nesting is limited to:

- `main session → subagent → subsubagent`

Further nested `subagent` calls are blocked and return guidance (no hard error).

Override with an environment variable **set before starting `pi`**:

```bash
export PI_SUBAGENT_MAX_DEPTH=2  # default
export PI_SUBAGENT_MAX_DEPTH=3  # allow one more level (use with caution)
```

> Increasing the max depth increases the chance of accidental recursion and token cost.

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
├── index.ts                      # Main extension, tool registration, overlay dispatch
├── agents.ts                     # Agent + chain discovery, frontmatter parsing
├── skills.ts                     # Skill resolution, caching, and discovery
├── settings.ts                   # Chain behavior resolution, templates, chain dir
├── chain-clarify.ts              # TUI for chain/single/parallel clarification
├── chain-execution.ts            # Chain orchestration (sequential + parallel)
├── chain-serializer.ts           # Parse/serialize .chain.md files
├── async-execution.ts            # Async/background execution support
├── execution.ts                  # Core runSync, applyThinkingSuffix
├── render.ts                     # TUI rendering (widget, tool result display)
├── artifacts.ts                  # Artifact management
├── formatters.ts                 # Output formatting utilities
├── schemas.ts                    # TypeBox parameter schemas
├── utils.ts                      # Shared utility functions
├── types.ts                      # Shared types and constants
├── subagent-runner.ts            # Async runner (detached process)
├── notify.ts                     # Async completion notifications
├── agent-manager.ts              # Overlay orchestrator, screen routing, CRUD
├── agent-manager-list.ts         # List screen (search, multi-select, progressive footer)
├── agent-manager-detail.ts       # Detail screen (resolved prompt, runs, fields)
├── agent-manager-edit.ts         # Edit screen (pickers, prompt editor)
├── agent-manager-parallel.ts     # Parallel builder screen (slot management, agent picker)
├── agent-manager-chain-detail.ts # Chain detail screen (flow visualization)
├── agent-management.ts           # Management action handlers (list, get, create, update, delete)
├── agent-serializer.ts           # Serialize agents to markdown frontmatter
├── agent-templates.ts            # Agent/chain creation templates
├── render-helpers.ts             # Shared pad/row/header/footer helpers
├── run-history.ts                # Per-agent run recording (JSONL)
└── text-editor.ts                # Shared text editor (word nav, paste)
```
