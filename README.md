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

If you use [pi-prompt-template-model](https://github.com/nicobailon/pi-prompt-template-model), you can wrap subagent delegation in a slash command:

```markdown
---
description: Take a screenshot
model: claude-sonnet-4-20250514
subagent: browser-screenshoter
cwd: /tmp/screenshots
---
Use url in the prompt to take screenshot: $@
```

Then `/take-screenshot https://example.com` switches to Sonnet, delegates to the `browser-screenshoter` agent with `/tmp/screenshots` as the working directory, and restores your model when done. Runtime overrides like `--cwd=<path>` and `--subagent=<name>` work too.

pi-prompt-template-model is entirely optional — pi-subagents works standalone through the `subagent` tool and slash commands. If you want reusable prompt-template workflows on top of subagents, including `/chain-prompts` and compare-style prompts like `pi-prompt-template-model`'s `/best-of-n` example, install [pi-prompt-template-model](https://github.com/nicobailon/pi-prompt-template-model) separately and copy any example prompts you want from its `examples/` directory into `~/.pi/agent/prompts/`.

## Agents

Agents are markdown files with YAML frontmatter that define specialized subagent configurations.

**Agent file locations:**

| Scope | Path | Priority |
|-------|------|----------|
| Builtin | `~/.pi/agent/extensions/subagent/agents/` | Lowest |
| User | `~/.pi/agent/agents/{name}.md` | Medium |
| Project | `.pi/agents/{name}.md` (searches up directory tree) | Highest |

Use `agentScope` parameter to control discovery: `"user"`, `"project"`, or `"both"` (default; project takes priority).

**Builtin agents:** The extension ships with ready-to-use agents — `scout`, `planner`, `worker`, `reviewer`, `context-builder`, `researcher`, and `delegate`. They load at lowest priority so any user or project agent with the same name overrides them.

You can also override selected builtin fields without copying the whole agent. Builtin overrides are stored in settings under `subagents.agentOverrides`:

- User scope: `~/.pi/agent/settings.json`
- Project scope: `.pi/settings.json`

Supported builtin override fields are `model`, `fallbackModels`, `thinking`, `systemPromptMode`, `inheritProjectContext`, `inheritSkills`, `skills`, `tools`, and `systemPrompt`. Project overrides beat user overrides.

**Overriding builtin defaults:**

All builtin agents inherit project instruction files (`AGENTS.md`, `CLAUDE.md`, etc.) by default. To make a builtin agent run without those project instructions:

**Via settings file** — add to `~/.pi/agent/settings.json` (user scope) or `.pi/settings.json` (project scope):
```json
{
  "subagents": {
    "agentOverrides": {
      "reviewer": {
        "inheritProjectContext": false
      }
    }
  }
}
```

**Via `/agents` UI** — press `e` on any builtin agent (like `reviewer`), then toggle `inheritProjectContext` to `false` and save. This creates an override that you can edit or remove later without modifying the builtin definition itself.

Overridden builtins show badges like `[builtin+user]` or `[builtin+project]` to indicate they have customizations applied.

> **Note:** The `researcher` agent uses `web_search`, `fetch_content`, and `get_search_content` tools which require the [pi-web-access](https://github.com/nicobailon/pi-web-access) extension. Install it with `pi install npm:pi-web-access`.

### Prompt Assembly Philosophy

Subagents are designed to be **narrow and intentional**. Custom subagents default to seeing only what you explicitly give them — not Pi's entire base prompt, not your repo's `AGENTS.md`, and not the parent's discovered skills.

This prevents subtle bugs where a "simple" code review agent starts making decisions based on project architecture rules it shouldn't know about, or a focused research agent gets distracted by tool descriptions meant for the orchestrator.

Use inheritance flags to selectively add back context when you actually want it:
- **`inheritProjectContext: true`** — Keep Pi's inherited project-instructions block from project-level files like `AGENTS.md` and `CLAUDE.md`
- **`inheritSkills: true`** — Let the child use Pi's discovered skills catalog
- **`systemPromptMode: append`** — Add the agent's prompt to Pi's base instead of replacing it

Builtin agents ship a little differently: they all inherit project instruction files by default so they follow repo-specific rules out of the box. `delegate` is still the exception for `systemPromptMode` — it stays on `append` because its job is orchestration within the parent workflow, not isolated task execution.

**Agent frontmatter:**

```yaml
---
name: scout
description: Fast codebase recon
tools: read, grep, find, ls, bash, mcp:chrome-devtools  # mcp: requires pi-mcp-adapter
extensions:                 # absent=all, empty=none, csv=allowlist
model: claude-haiku-4-5
fallbackModels: openai/gpt-5-mini, anthropic/claude-sonnet-4  # optional ordered fallbacks
thinking: high               # off, minimal, low, medium, high, xhigh
systemPromptMode: replace    # replace by default, except builtin delegate
inheritProjectContext: false # custom agents default false; builtins opt into true
inheritSkills: false         # strip Pi's discovered skills section
skill: safe-bash, chrome-devtools  # comma-separated skills to inject
output: context.md           # writes to {chain_dir}/context.md
defaultReads: context.md     # comma-separated files to read
defaultProgress: true        # maintain progress.md
interactive: true            # (parsed but not enforced in v1)
maxSubagentDepth: 1          # tighten nested delegation for this agent's children
---

Your system prompt goes here (the markdown body after frontmatter).
```

The `thinking` field sets a default extended thinking level for the agent. At runtime it's appended as a `:level` suffix to the model string (e.g., `claude-sonnet-4-5:high`). If the model already has a thinking suffix (from a chain-clarify override), the agent's default is not double-applied.

`fallbackModels` is an optional ordered list of backup models to try when the primary model fails with a provider/model-style error such as quota, auth, timeout, or provider/model unavailable. In markdown frontmatter, declare it as a comma-separated string. In management `config` objects, you can pass either a comma-separated string or a string array.

`systemPromptMode` — How the agent markdown body is passed to Pi:
- **`replace`** (default) — The agent's markdown body becomes the system prompt. Clean slate, no Pi base prompt baggage.
- **`append`** — The agent's prompt is appended to Pi's normal base prompt. Use this when you want Pi's full capabilities plus your extra instructions.

`inheritProjectContext` — Whether the child keeps Pi's inherited project-instructions block, built from project-level instruction files like `AGENTS.md` and `CLAUDE.md`:
- **`false`** (default) — Strip those inherited project-level instructions from the child's final system prompt. This does not remove repo access, cwd, tools, or the task itself; it only removes those inherited instructions.
- **`true`** — Keep those inherited project-level instructions. Use for specialists that should follow project-specific constraints and conventions.

`inheritSkills` — Whether the child keeps Pi's discovered skills section:
- **`false`** (default) — Skills catalog is stripped. Good for focused agents that shouldn't browse unrelated skills.
- **`true`** — Child sees the full skills list. Use for general-purpose assistants that might need varied tools.

The `skills` field still works independently — it injects specific skills directly into the agent prompt regardless of `inheritSkills`.

**Common Recipes**

| Goal | `systemPromptMode` | `inheritProjectContext` | `inheritSkills` |
|------|-------------------|------------------------|-----------------|
| Fully isolated specialist (custom-agent default) | `replace` | `false` | `false` |
| Specialist that should follow project instruction files | `replace` | `true` | `false` |
| Pi-plus-extensions | `append` | `true` | `true` |

- **Security auditor**: Fully isolated so it objectively checks for vulnerabilities without being biased by project conventions.
- **Architecture planner**: Repo-aware so it respects `AGENTS.md` constraints when making design decisions.
- **Generic helper**: Append mode with full inheritance so it behaves like a slightly-customized Pi.

Fallback resolution follows the same conservative model lookup as normal execution. Explicit `provider/model` values are used as-is. Bare model IDs first prefer the current session provider when that provider actually exposes the model, then fall back to a unique registry match. If a bare ID is still ambiguous, it stays bare.

Fallback is only used for provider/model availability failures. Ordinary task failures such as bad `bash` commands, missing files, or other tool/runtime errors do not trigger a model hop.

**Tool selection semantics**

The `tools` field controls builtin-tool allowlisting and a couple of related extension behaviors:

- `tools` **omitted** → `pi-subagents` does not pass `--tools`, so the child gets Pi's normal default builtin tools.
- `tools` **present** → listed builtin tool names become an explicit allowlist passed via `--tools`.
- `mcp:...` entries are split out of `tools` and forwarded as direct MCP tool selections.
- Path-like entries in `tools` (extension paths or file paths ending in `.ts` / `.js`) are treated as tool-extension paths, not builtin tool names.

This means:

- `tools` omitted + `extensions` omitted → child gets Pi's normal builtin tools and normal extension set.
- `tools: mcp:chrome-devtools` → child still gets Pi's default builtin tools, plus direct MCP tools from `chrome-devtools`.
- `tools: read, bash, mcp:chrome-devtools` → child is restricted to `read` and `bash` for builtin tools, plus direct MCP tools from `chrome-devtools`.

**Extension sandboxing**

Use `extensions` in frontmatter to control which extensions a subagent can access:

```yaml
# Field absent: all extensions load (default behavior)

# Empty field: no extensions
extensions:

# Allowlist specific extensions
extensions: /abs/path/to/ext-a.ts, /abs/path/to/ext-b.ts
```

Semantics:
- `extensions` absent → all extensions load
- `extensions:` empty → `--no-extensions`
- `extensions: a,b` → `--no-extensions --extension a --extension b`

When `extensions` is present, it takes precedence over extension paths implied by `tools` entries.

**MCP Tools (optional)**

If you have the [pi-mcp-adapter](https://github.com/nicobailon/pi-mcp-adapter) extension installed, subagents can use MCP server tools directly. Without that extension, everything below is ignored — MCP integration is entirely optional.

Add `mcp:` prefixed entries to the `tools` field in agent frontmatter:

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

> **First-run caveat:** The MCP adapter caches tool metadata at startup. The first time you connect to a new MCP server, that cache is empty, so tools are only available through the generic `mcp` proxy. After that first session, restart pi and direct tools become available.

**Resolution priority:** step override > agent frontmatter > disabled

## Quick Commands

| Command | Description |
|---------|-------------|
| `/run <agent> <task>` | Run a single agent with a task |
| `/chain agent1 "task1" -> agent2 "task2"` | Run agents in sequence with per-step tasks |
| `/parallel agent1 "task1" -> agent2 "task2"` | Run agents in parallel with per-step tasks |
| `/subagents-status` | Open the async status overlay for active and recent runs |
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
| `output` | `output=context.md` | Write results to file (relative to chain dir for `/chain`/`/parallel`; for `/run`, absolute paths are used as-is and relative paths resolve against cwd) |
| `reads` | `reads=a.md+b.md` | Read files before executing (`+` separates multiple) |
| `model` | `model=anthropic/claude-sonnet-4` | Override model for this step |
| `skills` | `skills=planning+review` | Override skills (`+` separates multiple) |
| `progress` | `progress` | Enable progress tracking |

Set `output=false`, `reads=false`, or `skills=false` to explicitly disable.

### Background Execution

Add `--bg` at the end of any slash command to run in the background:

```
/run scout "full security audit of the codebase" --bg
/chain scout "analyze auth system" -> planner "design refactor plan" -> worker --bg
/parallel scout "scan frontend" -> scout "scan backend" -> scout "scan infra" --bg
```

Without `--bg`, the run is foreground: the tool call stays active and streams progress until completion. With `--bg`, the run is launched asynchronously: control returns immediately, and completion arrives later via notification. In both cases subagents run as separate processes. Check status with the `subagent_status` tool, or open the `/subagents-status` slash command for a read-only overlay listing active runs and recent completions.

### Forked Context Execution

Add `--fork` at the end of `/run`, `/chain`, or `/parallel` to run with `context: "fork"`:

```
/run reviewer "review this diff" --fork
/chain scout "analyze this branch" -> planner "plan next steps" --fork
/parallel scout "audit frontend" -> reviewer "audit backend" --fork
```

You can combine `--fork` and `--bg` in any order:

```
/run reviewer "review this diff" --fork --bg
/run reviewer "review this diff" --bg --fork
```

## Agents Manager

Press **Ctrl+Shift+A** or type `/agents` to open the Agents Manager overlay — a TUI for browsing, viewing, editing, creating, and launching agents and chains.

**Screens:**

| Screen | Description |
|--------|-------------|
| List | Browse all agents and chains with search/filter, scope badges, chain badges |
| Detail | View resolved prompt, frontmatter fields, recent run history, and active builtin override path |
| Edit | Edit fields with specialized pickers and toggles (model, thinking, prompt mode, inherited context, inherited skills, prompt editor) |
| Chain Detail | View chain steps with flow visualization and dependency map |
| Parallel Builder | Build parallel execution slots, add same agent multiple times, per-slot task overrides |
| Task Input | Enter task and launch with optional skip-clarify toggle |
| New Agent | Create from templates (Blank, Scout, Planner, Implementer, Code Reviewer, Blank Chain) |

**List screen keybindings:**
- `↑↓` — navigate agents/chains
- `Enter` — view detail
- Type any character — search/filter
- `Tab` — toggle selection (agents only)
- `Alt+N` — new agent from template
- `Ctrl+K` — clone current item
- `Ctrl+D` or `Del` — delete current item
- `Ctrl+R` — run selected (1 agent: launch, 2+: sequential chain)
- `Ctrl+P` — open parallel builder (from selection or cursor agent)
- `Esc` — clear query, then selection, then close overlay

On a builtin detail screen, `e` opens the builtin override flow instead of cloning the whole agent. If no override exists yet, the manager asks whether to store it in user or project settings first.

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

**Builtin override edit keybindings:**
- `Ctrl+S` — save override
- `r` — reset the focused field back to the builtin value
- `D` — remove the entire override
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
- **Worktree Isolation**: `worktree: true` gives each parallel agent its own git worktree, preventing filesystem conflicts during concurrent execution
- **Chain Clarification TUI**: Interactive preview/edit of chain templates and behaviors before execution
- **Agent Frontmatter Extensions**: Agents declare default chain behavior (`output`, `defaultReads`, `defaultProgress`, `skill`) plus optional recursion limits via `maxSubagentDepth`
- **Chain Artifacts**: Shared directory at a user-scoped temp path like `<tmpdir>/pi-subagents-<scope>/chain-runs/{runId}/` for inter-step files
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
| Chain | Yes | `{ chain: [{agent, task}...] }` with `{task}`, `{previous}`, `{chain_dir}` variables |
| Parallel | Yes | `{ tasks: [{agent, task}...] }` - via TUI toggle or converted to chain for async |

Execution context defaults to `context: "fresh"`, which starts each child run from a clean session. Set `context: "fork"` to start each child from a real branched session created from the parent's current leaf.
When `intercomBridge` is enabled (default: `always`) and `pi-intercom` is installed/enabled, delegated children get runtime instructions for contacting the orchestrator session via `intercom({ action: "ask"|"send", ... })`.

> **Note:** Intercom bridging requires the [pi-intercom](https://github.com/nicobailon/pi-intercom) extension. Install it with `pi install npm:pi-intercom`.

All modes support foreground and background execution. Foreground is the default (the call waits and streams progress). For programmatic background launch, use `clarify: false, async: true`. For interactive background launch, use `clarify: true` and press `b` in the TUI before running. Chains with parallel steps (`{ parallel: [...] }`) run concurrently with configurable `concurrency` and `failFast` options.

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
- `Enter` - Run (foreground) or launch in background if `b` is toggled on
- `Esc` - Cancel
- `↑↓` - Navigate between steps/tasks (parallel, chain)
- `e` - Edit task/template (all modes)
- `m` - Select model (all modes)
- `t` - Select thinking level (all modes)
- `s` - Select skills (all modes)
- `b` - Toggle background/async execution (all modes) — shows `[b]g:ON` when enabled
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

**Skill locations (project-first precedence):**
- Project: `.pi/skills/{name}/SKILL.md`
- Project packages: `.pi/npm/node_modules/*` via `package.json -> pi.skills`
- Project settings packages: local package roots from `.pi/settings.json -> packages`, then `package.json -> pi.skills`
- Current task cwd package: `<cwd>/package.json -> pi.skills`
- Project settings: `.pi/settings.json -> skills`
- User: `~/.pi/agent/skills/{name}/SKILL.md`
- User packages: `~/.pi/agent/npm/node_modules/*` via `package.json -> pi.skills`
- User settings packages: local package roots from `~/.pi/agent/settings.json -> packages`, then `package.json -> pi.skills`
- User settings: `~/.pi/agent/settings.json -> skills`

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

These are the parameters the **LLM agent** passes when it calls the `subagent` tool — not something you type directly. The agent decides to use these based on your conversation. For user-facing commands, see [Quick Commands](#quick-commands) above.

**subagent tool parameters:**
```typescript
// Single agent
{ agent: "worker", task: "refactor auth" }
{ agent: "scout", task: "find todos", maxOutput: { lines: 1000 } }
{ agent: "scout", task: "investigate", output: false }  // disable file output

// Single agent from parent-session fork (real branched session at current leaf)
{ agent: "worker", task: "continue this thread", context: "fork" }

// Parallel
{ tasks: [{ agent: "scout", task: "a" }, { agent: "scout", task: "b" }] }

// Parallel with count shorthand (run the same task 3 times)
{ tasks: [{ agent: "scout", task: "audit auth", count: 3 }] }

// Parallel with forked context (each task gets its own isolated fork)
{ tasks: [{ agent: "scout", task: "audit frontend" }, { agent: "reviewer", task: "audit backend" }], context: "fork" }

// Chain with TUI clarification (default)
{ chain: [
  { agent: "scout", task: "Gather context for auth refactor" },
  { agent: "planner" },  // task defaults to {previous}
  { agent: "worker" },   // uses agent defaults for reads/progress
  { agent: "reviewer" }
]}

// Chain with forked context (each step gets its own isolated fork of the same parent leaf)
{ chain: [
  { agent: "scout", task: "Analyze current branch decisions" },
  { agent: "planner", task: "Plan from {previous}" }
], context: "fork" }

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
    { agent: "worker", task: "Implement auth based on {previous}", count: 2 },
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

// Worktree isolation — each parallel agent gets its own git worktree
{ tasks: [
  { agent: "worker", task: "Implement auth" },
  { agent: "worker", task: "Implement API" }
], worktree: true }

// Worktree isolation in a chain (fan-out with isolation, fan-in for review)
{ chain: [
  { agent: "scout", task: "Gather context" },
  { parallel: [
    { agent: "worker", task: "Implement feature A based on {previous}" },
    { agent: "worker", task: "Implement feature B based on {previous}" }
  ], worktree: true },
  { agent: "reviewer", task: "Review changes from {previous}" }
]}

// Async chain with parallel step (runs in background)
{ chain: [
  { agent: "scout", task: "Gather context" },
  { parallel: [
    { agent: "worker", task: "Implement feature A based on {previous}" },
    { agent: "worker", task: "Implement feature B based on {previous}" }
  ]},
  { agent: "reviewer", task: "Review all changes from {previous}" }
], clarify: false, async: true }
```

**subagent_status tool:**
```typescript
{ action: "list" }                    // active async runs only
{ id: "a53ebe46" }                    // inspect one run
{ dir: "<tmpdir>/pi-subagents-<scope>/async-subagent-runs/a53ebe46-..." }
```

**/subagents-status slash command:**

Opens a small read-only overlay that shows active async runs plus recent completed/failed runs. It auto-refreshes every 2 seconds while open, keeps the current run selected when possible, and uses `↑↓` to select a run plus `Esc` to close.

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
  systemPromptMode: "replace",
  inheritProjectContext: false,
  inheritSkills: false,
  model: "anthropic/claude-sonnet-4",
  fallbackModels: ["openai/gpt-5-mini", "anthropic/claude-haiku-4-5"],
  tools: "read, bash, mcp:github/search_repositories",
  extensions: "", // empty = no extensions
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
- Agent config mapping: `reads -> defaultReads`, `progress -> defaultProgress`, `extensions` controls extension sandboxing, `maxSubagentDepth`, `fallbackModels`, `systemPromptMode`, `inheritProjectContext`, and `inheritSkills` map directly to agent frontmatter, and `tools` supports `mcp:` entries that map to direct MCP tools.
- To clear any optional field, set it to `false` or `""` (e.g., `{ model: false }` or `{ skills: "" }`). Both work for all string-typed fields.

## Parameters

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `agent` | string | - | Agent name (single mode) or target for management get/update/delete |
| `task` | string | - | Task string (single mode) |
| `action` | string | - | Management action: `list`, `get`, `create`, `update`, `delete` |
| `chainName` | string | - | Chain name for management get/update/delete |
| `config` | object | - | Agent or chain config for management create/update. Agent configs also accept `fallbackModels` (comma-separated string or string array), `systemPromptMode` (`append` or `replace`), `inheritProjectContext` (boolean), and `inheritSkills` (boolean). |
| `output` | `string \| false` | agent default | Override output file for single agent (absolute path as-is, relative path resolved against cwd) |
| `skill` | `string \| string[] \| false` | agent default | Override skills (comma-separated string, array, or false to disable) |
| `model` | string | agent default | Override model for single agent |
| `fallbackModels` | `string \| string[]` | agent default | Management/config-only field for ordered backup models. Markdown frontmatter uses a comma-separated string. |
| `tasks` | `{agent, task, cwd?, count?, skill?}[]` | - | Parallel tasks. Foreground runs directly; background requests are converted to an equivalent chain. `count` repeats one task entry N times with the same settings. |
| `worktree` | boolean | false | Create isolated git worktrees for each parallel task. Requires clean git state. Per-worktree diffs included in output. |
| `chain` | ChainItem[] | - | Sequential steps with behavior overrides (see below) |
| `context` | `"fresh" \| "fork"` | `fresh` | Execution context mode. `fork` uses a real branched session from the parent's current leaf for each child run |
| `chainDir` | string | user-scoped temp dir like `<tmpdir>/pi-subagents-<scope>/chain-runs/` | Persistent directory for chain artifacts (default auto-cleaned after 24h) |
| `clarify` | boolean | true (chains) | Show TUI to preview/edit chain; implies sync mode |
| `agentScope` | `"user" \| "project" \| "both"` | `both` | Agent discovery scope (project wins on name collisions) |
| `async` | boolean | false | Background execution (requires `clarify: false` for chains) |
| `cwd` | string | - | Override working directory |
| `maxOutput` | `{bytes?, lines?}` | 200KB, 5000 lines | Truncation limits for final output |
| `artifacts` | boolean | true | Write debug artifacts |
| `includeProgress` | boolean | false | Include full progress in result |
| `share` | boolean | false | Upload session to GitHub Gist (see [Session Sharing](#session-sharing)) |
| `sessionDir` | string | - | Override session log directory (takes precedence over `defaultSessionDir` and parent-session-derived path) |

`context: "fork"` fails fast when the parent session is not persisted, the current leaf is missing, or a branched child session cannot be created. It never silently downgrades to `fresh`.

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

Fallbacks are inherited from the selected agent for that step. There is no per-step `fallbackModels` override in v1.

*Parallel step fields:*

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `parallel` | ParallelTask[] | required | Array of tasks to run concurrently |
| `concurrency` | number | 4 | Max concurrent tasks |
| `failFast` | boolean | false | Stop remaining tasks on first failure |
| `worktree` | boolean | false | Create isolated git worktrees for each parallel task |

*ParallelTask fields:* (same as sequential step)

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `agent` | string | required | Agent name |
| `task` | string | `{previous}` | Task template |
| `cwd` | string | - | Override working directory |
| `count` | number | 1 | Repeat this parallel task N times with the same settings |
| `output` | `string \| false` | agent default | Override output (namespaced to parallel-N/M-agent/) |
| `reads` | `string[] \| false` | agent default | Override files to read |
| `progress` | boolean | agent default | Override progress tracking |
| `skill` | `string \| string[] \| false` | agent default | Override skills or disable all |
| `model` | string | agent default | Override model for this task |

Fallbacks are inherited from the selected agent for that task. There is no per-task `fallbackModels` override in v1.

Status tool:

| Tool | Description |
|------|-------------|
| `subagent_status` | List active async runs or inspect one run by id or dir |

## Worktree Isolation

When multiple agents run in parallel against the same repo, they can clobber each other's file changes. Pass `worktree: true` to give each parallel agent its own git worktree branched from HEAD.

```typescript
// Top-level parallel with worktree isolation
{ tasks: [
  { agent: "worker", task: "Implement auth", count: 2 },
  { agent: "worker", task: "Implement API" }
], worktree: true }

// Chain with worktree-isolated parallel step
{ chain: [
  { agent: "scout", task: "Gather context" },
  { parallel: [
    { agent: "worker", task: "Implement feature A based on {previous}" },
    { agent: "worker", task: "Implement feature B based on {previous}" }
  ], worktree: true },
  { agent: "reviewer", task: "Review all changes from {previous}" }
]}
```

After the parallel step completes, per-agent diff stats are appended to the output (and become `{previous}` for the next chain step). Full patch files are written to disk. The caller or next step can decide what to keep.

**Requirements:**

- Must be inside a git repository
- Working tree must be clean (no uncommitted changes) — commit or stash first
- `node_modules/` is symlinked into each worktree to avoid reinstalling
- Worktree runs use the shared parallel/step `cwd`. Task-level `cwd` overrides must be omitted or match that shared `cwd`; if you need different working directories, disable `worktree` or split the run.
- If `worktreeSetupHook` is configured, it must return valid JSON and complete before timeout

**What happens under the hood:**

1. `git worktree add` creates a temporary worktree per agent in `<tmpdir>/pi-worktree-*`
2. Optional `worktreeSetupHook` runs once per worktree (JSON in on stdin, JSON out on stdout)
3. Each agent runs in its worktree's cwd (preserving subdirectory context)
4. Before diff capture, declared synthetic helper paths (for example `.venv` or copied local config files) are removed
5. After execution, `git add -A && git diff --cached` captures all real changes (committed, modified, and new files)
6. Diff stats appear in the aggregated output; full `.patch` files are written to the artifacts directory
7. Worktrees and temp branches are cleaned up in a `finally` block

If you use [pi-prompt-template-model](https://github.com/nicobailon/pi-prompt-template-model), worktree isolation is also available via `worktree: true` in chain template frontmatter or the `--worktree` CLI flag on `chain-prompts`. `pi-prompt-template-model` compare-style prompts can route through the same worktree machinery too; see the `pi-prompt-template-model` README and `examples/` directory for the installable prompt templates.

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

## Extension Configuration

`pi-subagents` reads optional JSON config from `~/.pi/agent/extensions/subagent/config.json`.

### `defaultSessionDir`

`defaultSessionDir` sets the fallback directory used for session logs. Eg:

```json
{
  "defaultSessionDir": "~/.pi/agent/sessions/subagent/"
}
```

Session root resolution follows this precedence:
1. `params.sessionDir` from the `subagent` tool call
2. `config.defaultSessionDir`
3. Derived from parent session (stored alongside parent session file)

Sessions are always enabled — every subagent run gets a session directory for tracking.

### `maxSubagentDepth`

`maxSubagentDepth` sets the default recursion limit for nested delegation when no inherited `PI_SUBAGENT_MAX_DEPTH` is already in effect. Eg:

```json
{
  "maxSubagentDepth": 1
}
```

Per-agent `maxSubagentDepth` can tighten that limit further for child runs, but it does not relax an already inherited stricter limit.

### `intercomBridge`

Controls whether subagents receive runtime intercom coordination instructions (and `intercom` is auto-added to their tool allowlist when needed).

```json
{
	"intercomBridge": {
		"mode": "always",
		"instructionFile": "./intercom-bridge.md"
	}
}
```

Fields:
- `"mode"` (default: `"always"`): inject bridge in both `fresh` and `fork`, only in `fork`, or disable it entirely
- `"instructionFile"` (optional): path to a Markdown template that replaces the default injected subagent intercom instructions. Supports `{orchestratorTarget}` placeholder interpolation. Relative paths resolve from `~/.pi/agent/extensions/subagent/`.

Example `instructionFile`:

```md
Intercom orchestration channel:

Use `intercom` only to coordinate with the orchestrator session `{orchestratorTarget}`.

- Need a decision or you're blocked: `intercom({ action: "ask", to: "{orchestratorTarget}", message: "<question>" })`
- Need to report progress or completion: `intercom({ action: "send", to: "{orchestratorTarget}", message: "DONE: <summary>" })`

If intercom is unavailable in this run, continue the task normally.
```

Bridge activation also requires all of the following:
- [pi-intercom](https://github.com/nicobailon/pi-intercom) is installed (`pi install npm:pi-intercom`)
- `~/.pi/agent/intercom/config.json` is not set to `"enabled": false`
- the current session can be targeted by intercom (existing `/name`, or the runtime-only fallback alias `subagent-chat-<id>` when unnamed)
- if agent `extensions` is an explicit allowlist, it must include `pi-intercom`

When an unnamed session falls back to `subagent-chat-<id>`, that alias is used only for the live intercom broker. It is not persisted as the Pi session title, so `pi --resume` can still show the transcript snippet.

### `worktreeSetupHook`

`worktreeSetupHook` configures an optional setup hook for worktree-isolated parallel runs. The hook runs once per created worktree, after `git worktree add` succeeds and before the agent starts.

```json
{
  "worktreeSetupHook": "./scripts/setup-worktree.mjs"
}
```

Path rules:
- Must be an absolute path or a repo-relative path
- Bare command names from `PATH` are rejected
- `~/...` is supported for home-directory hooks

Hook I/O contract (JSON only):
- stdin: one JSON object with `repoRoot`, `worktreePath`, `agentCwd`, `branch`, `index`, `runId`, and `baseCommit`
- stdout: one JSON object, e.g. `{ "syntheticPaths": [".venv", ".env.local"] }`

`syntheticPaths` must be relative to the worktree root. These paths are removed before diff capture so helper files/symlinks do not pollute generated patches.

Tracked-file edits are never excluded. If the hook tries to mark tracked paths as synthetic, setup fails.

### `worktreeSetupHookTimeoutMs`

Optional timeout (milliseconds) for each worktree hook invocation.

```json
{
  "worktreeSetupHook": "./scripts/setup-worktree.mjs",
  "worktreeSetupHookTimeoutMs": 45000
}
```

Default: `30000` ms.

## Chain Directory
Each chain run creates a user-scoped temp directory like `<tmpdir>/pi-subagents-<scope>/chain-runs/{runId}/` containing:
- `context.md` - Scout/context-builder output
- `plan.md` - Planner output
- `progress.md` - Worker/reviewer shared progress
- `parallel-{stepIndex}/` - Subdirectories for parallel step outputs
  - `0-{agent}/output.md` - First parallel task output
  - `1-{agent}/output.md` - Second parallel task output
- Additional files as written by agents

Directories older than 24 hours are cleaned up on extension startup.

## Artifacts

Location: `{sessionDir}/subagent-artifacts/` or a user-scoped temp directory like `<tmpdir>/pi-subagents-<scope>/artifacts/`

Files per task:
- `{runId}_{agent}_input.md` - Task prompt
- `{runId}_{agent}_output.md` - Full output (untruncated)
- `{runId}_{agent}.jsonl` - Event stream (sync only)
- `{runId}_{agent}_meta.json` - Timing, usage, exit code, final model, attempted models, and per-attempt outcomes

When fallback is used, metadata records both the ordered `attemptedModels` list and `modelAttempts` entries with success/failure, exit code, error, and usage per attempt.

## Session Logs

Session files (JSONL) are stored under a per-run session directory. Directory selection follows the same precedence as session root resolution: explicit `sessionDir` > `config.defaultSessionDir` > parent-session-derived path. The session file path is shown in output.

When `context: "fork"` is used, each child run starts with `--session <branched-session-file>` produced from the parent's current leaf. This is a real session fork, not injected summary text.

## Session Sharing

When `share: true` is passed, the extension will:

1. Export the full session (all tool calls, file contents, outputs) to an HTML file
2. Upload it to a GitHub Gist using your `gh` CLI credentials
3. Return a shareable URL (`https://shittycodingagent.ai/session/?<gistId>`)

**This is disabled by default.** Session data may contain sensitive information like source code, file paths, environment variables, or credentials that appear in tool outputs.

To enable sharing for a specific run:
```typescript
{ agent: "scout", task: "...", share: true }
```

Requirements:
- GitHub CLI (`gh`) must be installed and authenticated (`gh auth login`)
- Gists are created as "secret" (unlisted but accessible to anyone with the URL)

## Live progress (sync mode)

During sync execution, the collapsed view shows real-time progress for single, chain, and parallel modes.

**Chains:**
- Header: `running chain 1/2 | 8 tools, 1.4k tok, 38s`
- Chain visualization with status: `done scout → running planner` (`done`, `running`, `pending`, `failed`)
- Current tool: `> read: packages/tui/src/...`
- Recent output lines (last 2-3 lines)

**Parallel:**
- Header: `... parallel 2/4 | 12 tools, 2.1k tok, 15s`
- Per-task step cards showing status icon, agent name, model, tool count, and duration
- Current tool and recent output for each running task

Press **Ctrl+O** to expand the full streaming view with complete output per step.

> **Note:** Chain visualization (the `done scout → running planner` line) is only shown for sequential chains. Chains with parallel steps show per-step cards instead.

## Nested subagent recursion guard

Subagents can themselves call the `subagent` tool, which risks unbounded recursive spawning (slow, expensive, hard to observe). A depth guard prevents this.

By default nesting is limited to **2 levels**: `main session → subagent → sub-subagent`. Any deeper `subagent` calls are blocked and return an error with guidance to the calling agent.

You can configure the limit in three places:

1. `PI_SUBAGENT_MAX_DEPTH` in the environment before starting `pi`
2. `config.maxSubagentDepth` in `~/.pi/agent/extensions/subagent/config.json`
3. `maxSubagentDepth` in an agent's frontmatter to tighten the limit for that agent's child runs

Environment inherits downward and wins for the current process. Per-agent limits can tighten child delegation but do not relax an already inherited stricter limit.

Override the limit with `PI_SUBAGENT_MAX_DEPTH` **set before starting `pi`**:

```bash
export PI_SUBAGENT_MAX_DEPTH=3   # allow one more level (use with caution)
export PI_SUBAGENT_MAX_DEPTH=1   # only allow direct subagents, no nesting
export PI_SUBAGENT_MAX_DEPTH=0   # disable the subagent tool entirely
```

`PI_SUBAGENT_DEPTH` is an internal variable propagated automatically to child processes -- don't set it manually.

## Async observability

Async runs write a dedicated observability folder:

```
<tmpdir>/pi-subagents-<scope>/async-subagent-runs/<id>/
  status.json
  events.jsonl
  output-<n>.log
  subagent-log-<id>.md
```

`status.json` is the source of truth for async progress and powers both the TUI widget and `/subagents-status`. Async status and result files are written atomically, so readers do not observe partial JSON during background updates.

`events.jsonl` is the live event stream. It includes high-level wrapper events plus child `pi` JSON events annotated with subagent metadata for the run and step they belong to. `output-<n>.log` is a live human-readable tail for the current step. `subagent-log-<id>.md` is written when the run completes.

When fallback is used in async/background mode, `status.json` and the final result JSON include the final selected model, ordered attempted models, and per-attempt outcomes so background runs are as debuggable as sync runs.

For programmatic access:

```typescript
subagent_status({ action: "list" })
subagent_status({ id: "<id>" })
subagent_status({ dir: "<tmpdir>/pi-subagents-<scope>/async-subagent-runs/<id>" })
```

For an interactive overview, run the `/subagents-status` slash command to open the overlay listing active runs and recent completed/failed runs. The overlay auto-refreshes every 2 seconds while it is open.

## Events

Async events:
- `subagent:started`
- `subagent:complete`

`notify.ts` consumes `subagent:complete` as the canonical completion channel.

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
├── async-status.ts               # Async run discovery, listing, and formatting
├── execution.ts                  # Core runSync and sync fallback handling
├── render.ts                     # TUI rendering (widget, tool result display)
├── subagents-status.ts           # Async status overlay component
├── artifacts.ts                  # Artifact management
├── formatters.ts                 # Output formatting utilities
├── schemas.ts                    # TypeBox parameter schemas
├── utils.ts                      # Shared utility functions (mapConcurrent, readStatus, etc.)
├── types.ts                      # Shared types and constants
├── model-fallback.ts             # Fallback candidate resolution and retry classification
├── subagent-runner.ts            # Async runner (detached process)
├── parallel-utils.ts             # Parallel execution utilities for async runner
├── worktree.ts                   # Git worktree isolation for parallel execution
├── pi-spawn.ts                   # Cross-platform pi CLI spawning
├── single-output.ts              # Solo agent output file handling
├── notify.ts                     # Async completion notifications
├── completion-dedupe.ts          # Completion deduplication for notifications
├── file-coalescer.ts             # Debounced file write coalescing
├── jsonl-writer.ts               # JSONL event stream writer
├── agent-manager.ts              # Overlay orchestrator, screen routing, CRUD
├── agent-manager-list.ts         # List screen (search, multi-select, progressive footer)
├── agent-manager-detail.ts       # Detail screen (resolved prompt, runs, fields)
├── agent-manager-edit.ts         # Edit screen (pickers, prompt editor)
├── agent-manager-parallel.ts     # Parallel builder screen (slot management, agent picker)
├── agent-manager-chain-detail.ts # Chain detail screen (flow visualization)
├── agent-management.ts           # Management action handlers (list, get, create, update, delete)
├── agent-serializer.ts           # Serialize agents to markdown frontmatter
├── agent-scope.ts                # Agent scope resolution utilities
├── agent-selection.ts            # Agent selection state management
├── agent-templates.ts            # Agent/chain creation templates
├── render-helpers.ts             # Shared pad/row/header/footer helpers
├── run-history.ts                # Per-agent run recording (JSONL)
├── test/unit/                    # Fast unit tests for pure modules
├── test/integration/             # Loader-based execution/integration tests
├── test/e2e/                     # End-to-end sandbox tests
├── test/support/                 # Shared test loader, helpers, and mock pi harness
└── text-editor.ts                # Shared text editor (word nav, paste)
```
