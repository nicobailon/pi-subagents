# Agents

An agent is a markdown file: YAML frontmatter on top, a system prompt below. The frontmatter defines the specialist that runs in the child Pi process.

```yaml
---
name: scout
description: Fast codebase recon
tools: read, grep, find, ls
---

Your system prompt goes here.
```

## Where agents live

Lowest to highest priority:

| Scope | Path |
|-------|------|
| Builtin | `~/.pi/agent/extensions/subagent/agents/` |
| Installed package | `package.json` `pi-subagents.agents` or `pi.subagents.agents` |
| User | `~/.pi/agent/agents/**/*.md` |
| Project | Project config `agents/**/*.md` (`.pi/agents/**/*.md` in standard Pi) |

Discovery notes:

- Project discovery also reads legacy `.agents/**/*.md` files. If both `.agents/` and the project config agents directory define the same parsed runtime agent name, the project config directory wins.
- Nested subdirectories are discovered recursively. `.chain.md` files do not define agents.
- Installed Pi packages can expose agent directories from either `{"pi-subagents":{"agents":["./agents"]}}` or `{"pi":{"subagents":{"agents":["./agents"]}}}` in their package manifest. Package agents load above builtins and below user/project agents.
- Use `agentScope: "user" | "project" | "both"` to control discovery. `both` is the default, and project definitions win runtime-name collisions.

## Builtin agents

Builtins load at the lowest priority, so a user or project agent with the same name overrides them. They do not pin a provider model; they inherit your current Pi default model unless you set `subagents.defaultModel` or `subagents.agentOverrides.<name>.model` (see [models.md](models.md)).

| Agent | Use it when you want... |
|-------|--------------------------|
| `scout` | Fast local codebase recon: relevant files, entry points, data flow, risks, and where another agent should start. |
| `researcher` | Web/docs research with sources: official docs, specs, benchmarks, recent changes, and a concise research brief. |
| `worker` | Implementation work, including approved oracle handoffs. It edits files, validates, and escalates unapproved decisions instead of guessing. |
| `reviewer` | Code review and small fixes. It checks the implementation against the task/plan, tests, edge cases, and simplicity. |
| `oracle` | A second opinion before acting. It challenges assumptions, catches drift, and recommends the safest next move without editing. |
| `delegate` | A lightweight general delegate when you want a child agent that behaves close to the parent session. |

Rule of thumb: `scout` before you understand the code, `researcher` before you trust external facts, `worker` to implement, `reviewer` to check, and `oracle` when the decision itself feels risky.

`oracle` is an advisory reviewer that critiques direction and proposes an execution prompt without editing files. `advisor` is the same bundled role under the Claude Code-compatible name.

### Optional Surf integration

When `surf-cli` is installed and loaded, Surf can expose a `gpt-pro` package agent through the `surf-oracle` external-job provider. It starts through the same `subagent({ agent: "gpt-pro" })` mental model as any other agent, but Surf owns the package agent and provider. Surf maps `model: pro` to ChatGPT GPT-5.6 Sol Pro web mode. pi-subagents does not own that model mapping.

If you disabled the old bundled `gpt-pro` workaround with `agentOverrides.gpt-pro.disabled`, remove that override before using Surf's package agent.

The Pi async run remains the source of truth for status, artifacts, wake/wait, mission attachment, retention, and diagnostics.

### Advisory runner data boundary

The built-in `codex-exec` and `codex-exec-writer` profiles are the supported Codex one-shot modes. Both require an installed and authenticated Codex CLI. The adapters own `codex exec --json` argv with ignored user config and rules, ephemeral sessions, approval policy `never`, and a final-message artifact.

| Profile | Access | Sandbox |
|---|---|---|
| `codex-exec` | Read-only analysis | `read-only` |
| `codex-exec-writer` | Explicit workspace edits | `workspace-write` |

Neither adapter uses full access, approval or sandbox bypasses, automatic approval review, or additional writable roots. User profiles cannot add argv. The `codex-exec` selection identity is reserved for the read-only adapter.

Run it asynchronously:

```text
Use codex-exec to analyze this change without editing files.

Use codex-exec-writer to make the requested workspace changes.
```

The adapter validates `codex --version` and `codex exec --help` only when a run launches. Discovery, list, status, and native Pi launches do not probe Codex. JSONL, stderr, and stdout are untrusted. A run succeeds only after bounded valid JSONL contains one `turn.completed` event and the bounded final-message artifact is present.

Maintainers can collect real smoke evidence without making it part of the normal test suite:

```bash
PI_SUBAGENTS_CODEX_EXEC_SMOKE=1 \
PI_SUBAGENTS_CODEX_EXEC_SMOKE_REPORT=/tmp/pi-subagents-codex-exec-smoke.json \
node --experimental-strip-types --import ./test/support/register-loader.mjs \
  --test test/integration/codex-exec-smoke.test.ts

PI_SUBAGENTS_CODEX_EXEC_WRITER_SMOKE=1 \
PI_SUBAGENTS_CODEX_EXEC_WRITER_SMOKE_REPORT=/tmp/pi-subagents-codex-exec-writer-smoke.json \
node --experimental-strip-types --import ./test/support/register-loader.mjs \
  --test test/integration/codex-exec-writer-smoke.test.ts
```

The read-only smoke must report `writeCanaryExists: false`. The writer smoke must report `writeCanaryMatches: true`. Both reports include startup duration and terminal proof without raw protocol output, prompts, or credentials.

The built-in `claude-code` and `claude-code-writer` profiles are the supported Claude Code one-shot modes. Both require an installed Claude Code CLI that is already authenticated through its normal local login. Claude Code 2.1.150 needs the user setting source for normal OAuth/keychain authentication, so both adapters load user settings but exclude project and local settings. User-level Claude Code settings and hooks are therefore an operator-trusted prerequisite. Review or disable unsafe user hooks before using either profile.

| Profile | Access | Permission mode | Built-in tools |
|---|---|---|---|
| `claude-code` | Handoff-only read-only advice | `plan` | none |
| `claude-code-writer` | Explicit workspace file edits | `acceptEdits` | `Read,Write,Edit,Glob,Grep` |

Both adapters own `claude -p` argv with stream JSON, strict empty MCP configuration, user-only setting sources, no session persistence, disabled slash commands, and disabled Chrome integration. The writer mode does not include Bash or any permission bypass. Neither mode uses `--bare`, which does not read normal OAuth/keychain authentication. Neither mode requires `--safe-mode`, which is absent from the installed 2.1.150 help. User profiles cannot add argv. Selecting the code-owned `claude-code-writer` adapter identity is the only way to opt into its write tools; the read-only adapter cannot be widened with user argv.

Run it asynchronously:

```text
Use claude-code to analyze this handoff without editing files.

Use claude-code-writer to make the requested file changes.
```

The adapter validates `claude --version` and `claude --help` only when a run launches. Discovery, list, status, and native Pi launches do not probe Claude Code or authentication. JSONL, stderr, and stdout are untrusted. A run succeeds only after bounded valid JSONL contains exactly one successful terminal `result` with non-empty final text. Missing or revoked local authentication, limit stops, malformed JSON, duplicate terminal results, and EOF before a terminal result fail closed.

Maintainers can opt in to separate read-only and writer canaries:

```bash
PI_SUBAGENTS_CLAUDE_CODE_SMOKE=1 \
PI_SUBAGENTS_CLAUDE_CODE_SMOKE_REPORT=/tmp/pi-subagents-claude-code-smoke.json \
node --experimental-strip-types --import ./test/support/register-loader.mjs \
  --test test/integration/claude-code-smoke.test.ts

PI_SUBAGENTS_CLAUDE_CODE_WRITER_SMOKE=1 \
PI_SUBAGENTS_CLAUDE_CODE_WRITER_SMOKE_REPORT=/tmp/pi-subagents-claude-code-writer-smoke.json \
node --experimental-strip-types --import ./test/support/register-loader.mjs \
  --test test/integration/claude-code-writer-smoke.test.ts
```

Both smoke reports record `authentication: "existing-cli-required"`, `settingSources: "user"`, and `userSettingsTrust: "required"` without recording credential details. For read-only, confirm `terminalState` is `completed` and `writeCanaryExists` is `false`. For writer, confirm `terminalState` is `completed` and `writeCanaryMatches` is `true`. `durationMs` records cold process time. If authentication is missing or revoked, repair the normal local Claude Code login and rerun the smoke. Reports do not contain raw protocol output or credentials.

The built-in `cursor-agent` and `cursor-agent-writer` profiles are the supported Cursor CLI one-shot modes. Both require an installed Cursor CLI and either `CURSOR_API_KEY` or an existing local login.

| Profile | Access | Cursor mode |
|---|---|---|
| `cursor-agent` | Read-only analysis | `ask` |
| `cursor-agent-writer` | Explicit workspace edits | non-interactive print |

Both adapters use stream JSON, the enabled sandbox, and the primary workspace. They write the full handoff to a private `0600` file in a private temporary directory. Process argv contains only a short instruction with that path. The temporary directory is added as a workspace root only when it is outside the primary workspace. The prompt file and directory are removed after completion, failure, or stop.

The adapters do not pass force, yolo, auto-review, MCP approval, plugin, session resume, continue, worktree, or workspace trust flags. User profiles cannot add argv or workspace roots. The `cursor-agent` selection identity is reserved for the read-only adapter.

Launch preflight validates `cursor-agent --version` and `cursor-agent --help` only when a run starts. Discovery, list, status, and native Pi launches do not execute Cursor or probe authentication. A run succeeds only when bounded valid JSONL ends with one successful `result` event that has non-empty final text. Error events, failed results, malformed JSON, output after the terminal event, and EOF before a result fail closed.

Maintainers can run separate read-only and writer canaries:

```bash
PI_SUBAGENTS_CURSOR_AGENT_SMOKE=1 \
PI_SUBAGENTS_CURSOR_AGENT_SMOKE_REPORT=/tmp/pi-subagents-cursor-agent-smoke.json \
node --experimental-strip-types --import ./test/support/register-loader.mjs \
  --test test/integration/cursor-agent-smoke.test.ts

PI_SUBAGENTS_CURSOR_AGENT_WRITER_SMOKE=1 \
PI_SUBAGENTS_CURSOR_AGENT_WRITER_SMOKE_REPORT=/tmp/pi-subagents-cursor-agent-writer-smoke.json \
node --experimental-strip-types --import ./test/support/register-loader.mjs \
  --test test/integration/cursor-agent-writer-smoke.test.ts
```

The read-only smoke must report `writeCanaryExists: false`. The writer smoke must report `writeCanaryMatches: true`. Both reports include startup duration and terminal proof without raw protocol output, prompts, or credentials.

Native `oracle` runs inside Pi and can use its configured read tools. The Claude profiles send the assembled prompt to the local Claude Code CLI through stdin. An external-job agent sends the assembled prompt to its registered provider. Provider options and a prompt digest are persisted in Pi run state. The prompt text is delivered through the local host bridge to the provider and is not stored in the public result payload. Do not place secrets in advisory prompts unless the target provider is approved to receive them.

### External-job state table

| Durable file | Owner | States | Release predicate | Rollback predicate | Stale-head behavior | Fail-closed cases |
|--------------|-------|--------|-------------------|--------------------|---------------------|-------------------|
| `status.json` step `runner` and `externalJob` | pi-subagents async runner | `queued`, `running`, `completed`, `failed`, `stopped`, `blocked` | Provider `result` returns terminal data and the async result is written | Provider start/follow-up/status/result/reattach returns an error | If a status file already has a provider job id, recovery calls `reattach` and `result`; it refuses to start a new prompt when the provider, prompt digest, parent job id, request id, request digest, or options differ | Missing provider, unsupported follow-up provider, capacity conflict, malformed provider response, bridge timeout, prompt digest mismatch, parent conversation missing |
| `result.json` or session result payload | pi-subagents async runner | `complete`, `failed`, `stopped` | All steps reach terminal state and result publication succeeds or is recoverably indexed | Result write fails and pending result repair records the terminal state | Stale status can repair from an existing result file | Unindexed sessionless stale failure |
| `external-job-requests/` and `external-job-responses/` | Host-mediated provider bridge | pending request, terminal response | Host process writes a matching response and removes the request | Bridge timeout or malformed request response | Requests are operation-scoped. Recovery sends `reattach`/`result`, not `start` or `follow-up`, when job metadata exists. `start` and `follow-up` use durable dispatch claims | Provider not registered, host bridge not loaded, malformed request, provider exception, ambiguous dispatch without a provider job id |
| Provider artifact path | External provider | provider-defined terminal artifact | Provider returns `artifactPath`, or Pi writes returned text to `external-job-<index>.result.md` | Provider reports failure or no result | Existing artifact path is retained in `status.json` | Missing artifact with no text output returns a terminal message instead of inventing content |

The `researcher` builtin uses `web_search`, `fetch_content`, and `get_search_content`. Those require [pi-web-access](https://github.com/nicobailon/pi-web-access):

```bash
pi install npm:pi-web-access
```

## Overriding builtins

You can override selected builtin fields without copying the whole agent. Overrides live in settings:

- User: `~/.pi/agent/settings.json`
- Project: project config settings file (`.pi/settings.json` in standard Pi)

```json
{
  "subagents": {
    "agentOverrides": {
      "reviewer": {
        "description": "Independent review tier",
        "inheritProjectContext": false
      }
    }
  }
}
```

Supported override fields: `description`, `output`, `outputMode`, `defaultReads`, `model`, `defaultProvider`, `fallbackModels`, `thinking`, `systemPromptMode`, `inheritProjectContext`, `inheritSkills`, `defaultContext`, `acceptanceRole`, `disabled`, `skills`, `tools`, and `systemPrompt`.

- `description` replaces the discovered description for builtin and custom agents, which lets list output show deployment-specific routing or model metadata.
- Use `output: false`, `defaultReads: false`, `defaultContext: false`, or `acceptanceRole: false` to clear an inherited value.
- Use `tools: "inherit"` on a builtin when that one role should omit its bundled tool allowlist and receive Pi's normal builtins and ambient extensions. This keeps strict tools as the default for other builtins.
- Project overrides beat user overrides.
- Matching user and project agents also receive override fields that their frontmatter leaves unset, so a shared project config agent can keep the persona while local settings choose the model.

Disable and restore:

- `disabled: true` hides a builtin from runtime discovery and agent-facing `subagent({ action: "list" })` output.
- `subagents.disableBuiltins: true` disables all builtins at once.
- `subagent({ action: "disable", agent: "reviewer" })` writes the override without editing settings by hand; `subagent({ action: "enable", agent: "reviewer" })` removes it.
- `subagent({ action: "eject", agent: "reviewer" })` copies a bundled builtin or package agent verbatim into the user or project agent dir (default `user`) as an editable custom file that shadows the original.
- `subagent({ action: "reset", agent: "reviewer" })` deletes the scope's custom agent file and/or settings override entry, restoring the bundled default. It refuses if no bundled default exists (use `delete` for purely custom agents).

`eject`, `disable`, `enable`, and `reset` accept `agentScope: "user" | "project"` and operate in one scope at a time. Project overrides still win over user ones, so a project-scope disable survives a user-scope `enable` until you target the project scope.

## Prompt assembly

Subagents are narrow by default. Custom agents start with a clean system prompt and only the context you intentionally give them. They do not automatically inherit Pi's whole base prompt, project instruction files, or discovered skills catalog.

Use these fields when an agent should see more:

| Field | Effect |
|-------|--------|
| `systemPromptMode: append` | Append the agent prompt to Pi's normal base prompt. |
| `inheritProjectContext: true` | Keep inherited project instructions from files like `AGENTS.md` and `CLAUDE.md`. |
| `inheritSkills: true` | Let the child see Pi's discovered skills catalog. |
| `defaultContext: fork` | Prefer forked session context when a launch omits `context`; if the parent has no persisted session file or current leaf yet, the implicit default falls back to `fresh` without a failed first attempt. Explicit `context: "fork"` remains strict, and explicit `context: "fresh"` still wins. |

Builtin agents opt into project instruction inheritance by default so they follow repo-specific rules out of the box. `delegate` also uses append mode because its job is orchestration inside the parent workflow.

## Frontmatter reference

A full example:

```yaml
---
name: scout
# Optional: registers this as code-analysis.scout while preserving name: scout
package: code-analysis
description: Fast codebase recon
aliases: explorer, code-scout
tools: read, grep, find, ls, bash, mcp:chrome-devtools
extensions:
subagentOnlyExtensions: ./tools/child-only-search.ts
model: claude-haiku-4-5
fallbackModels: openai/gpt-5-mini, anthropic/claude-sonnet-4
thinking: high
systemPromptMode: replace
inheritProjectContext: false
inheritSkills: false
skills: safe-bash, review-checklist
skillPath: ./skills, ../shared-skills
output: context.md
defaultReads: context.md
defaultProgress: true
async: true
timeoutMs: 900000
toolTimeoutMs: 600000
turnBudget: {"maxTurns":20,"graceTurns":2}
acceptance: {"level":"none","reason":"lightweight lookup"}
acceptanceRole: read-only
completionGuard: false
interactive: true
maxSubagentDepth: 1
---

Your system prompt goes here.
```

Simple-scalar list fields accept either a comma-separated form or a newline block list with one `- item` per line. This applies to `tools`, `defaultReads`, `skill`/`skills`, `skillPath`, `fallbackModels`, `extensions`, and `subagentOnlyExtensions`:

```yaml
tools:
  - read
  - mcp:github/search_repositories
fallbackModels:
  - openai/gpt-5-mini
  - anthropic/claude-sonnet-4
```

Field notes:

| Field | Notes |
|-------|-------|
| `package` | Optional package identifier. A file with `name: scout` and `package: code-analysis` registers as `code-analysis.scout`; serialization keeps `name` and `package` separate. |
| `aliases` | Optional comma-separated or block-list names that resolve to this agent for selection and explicit `agent` and task inputs. Runtime status, persistence, and config still use the canonical `name`. Exact canonical names take precedence over aliases, and alias collisions between distinct canonical agents fail as ambiguous. |
| `tools` | Strict child tool allowlist. Named extension tools must also have their provider loaded. `mcp:` entries select direct MCP tools when `pi-mcp-adapter` is installed. |
| `extensions` | Omitted means normal extensions; empty means no extensions; list values allowlist specific extensions. |
| `subagentOnlyExtensions` | Extension paths loaded only in spawned child sessions for this agent. Tools registered there are unavailable to the main agent unless also installed through normal Pi extension configuration. |
| `model` | Default model. Bare ids prefer the current provider when possible, then unique registry matches. |
| `fallbackModels` | Ordered backup models for provider/model failures such as quota, auth, timeout, or unavailable model. Ordinary task failures do not trigger fallback. |
| `thinking` | Appended as a `:level` suffix at runtime unless a suffix is already present. |
| `systemPromptMode` | `replace` by default; `append` keeps Pi's base prompt. |
| `inheritProjectContext` | Keeps or strips inherited project instruction blocks. |
| `inheritSkills` | Keeps or strips Pi's discovered skills catalog. |
| `defaultContext` | Optional `fresh` or `fork` launch-context preference. An implicit `fork` falls back to `fresh` when the parent has no persisted session file or current leaf; an explicit launch `context: "fork"` remains strict. |
| `skills` | Selects specific skills for the child, regardless of `inheritSkills`. |
| `skillPath` | Invocation-private skill files or discovery directories. Relative paths resolve from the agent definition file. Local matches take precedence, while unresolved or unreadable matches fall back to normal skill discovery. This field discovers candidates only; `skills` still selects what the child receives. |
| `output` | Default single-agent output file. |
| `defaultReads` | Files to read before running the agent. |
| `defaultProgress` | Maintain `progress.md`. |
| `async` | Default a single-agent launch to background (`true`) or foreground (`false`) when the call omits `async`. Explicit call values and `forceTopLevelAsync` win. |
| `timeoutMs` | Positive integer default runtime deadline in milliseconds for single-agent launches. Foreground launches use 30 minutes when neither the call nor agent provides a timeout; explicit `timeoutMs`/`maxRuntimeMs` and agent defaults win. |
| `toolTimeoutMs` | Optional positive integer hard per-tool-call deadline in milliseconds. An explicit call value wins, then this agent default, global `toolTimeoutMs`, and `PI_SUBAGENT_TOOL_TIMEOUT_MS`. When omitted, known-fast built-in tools get a five-minute default; long-running tools get attention notices but no hard default. It does not extend the run-level deadline; `contact_supervisor`, `intercom`, and `subagent_wait` are exempt. |
| `turnBudget` | JSON object default such as `{"maxTurns":20,"graceTurns":2}` for single-agent launches. An explicit call value wins, followed by this agent default, then global `turnBudget` config. |
| `acceptance` | Acceptance default for single-agent launches. Use a scalar level such as `checked` or an inline/block YAML map such as `{ level: "none", reason: "lightweight lookup" }`. Explicit call values win; chain and parallel acceptance remains task/step configuration. |
| `acceptanceRole` | Optional `read-only` or `writer` role for automatic acceptance inference. Explicit task mutation or no-edit intent wins; otherwise the declared role replaces agent-name guessing. This does not grant or revoke tools. |
| `completionGuard` | Set `false` only for non-implementation agents that may mention implementation words while using mutation-capable tools such as `bash`. |
| `interactive` | Parsed for compatibility but not currently enforced. |
| `maxSubagentDepth` | Tightens nested delegation for this agent's children. |
| `memory` | Opt-in role-specific persistent memory. See below. |

## Per-agent persistent memory

A recurring custom agent can opt into a durable, role-specific memory scope with the `memory` frontmatter field:

```yaml
memory:
  scope: project
  path: security-reviewer
```

This is independent of Pi's own parent/session/project memory system and writes nothing to it. Memory lives under a dedicated `agent-memory/` namespace so the two never collide.

How it works:

- On each run, the first 200 lines of `MEMORY.md` in the resolved memory directory are injected into the child system prompt, so the agent can recall accumulated role notes such as threat-model entries, release gotchas, or verified commands.
- Agents with write tools (`edit`, `write`, or `bash`, or no `tools` allowlist at all) are told they may append concise dated entries to the file.
- Agents without write tools receive a read-only memory block and are not instructed to edit it. A read-only reviewer can recall prior notes without gaining write capability.
- The memory directory is never created eagerly. The agent's own `write` tool creates it (and `MEMORY.md`) on the first persist.
- Memory paths are validated against `.`/`..` traversal and symlink escape. An unsafe or unresolvable scope is silently skipped rather than breaking the run.

Scopes:

- Project: resolves under `<project>/.pi/agent-memory/<path>` and travels with the repo.
- User: resolves under `~/.pi/agent/agent-memory/<path>` and is shared across projects for that agent.

## Refinement overlays

A refinement overlay is bounded, project-local guidance layered on top of one agent's system prompt without editing the agent file. Use it when an agent repeatedly stumbles on the same project-specific issue and recent run evidence shows what to correct.

```text
/subagents-refine reviewer
```

```ts
subagent({ action: "refine", agent: "reviewer" })
subagent({ action: "refine.show", agent: "reviewer" })
subagent({ action: "refine.rollback", agent: "reviewer" })
```

How it works:

- `refine` collects bounded evidence from that agent's recent runs in the project (statuses, errors, review findings, residual risks, output tails), then launches a fresh read-only proposal child to draft small guidance edits from that evidence.
- Proposed guidance is validated before it is written. Edits that try to override safety, policy, tool, output, acceptance, developer, or system instructions are rejected, as are edits that target all agents or base agent files.
- The accepted overlay is stored at `.pi/subagents/refinements/<agent>.md` with revision metadata and snapshots. Each `refine` or `refine.rollback` adds a snapshot, and `refine.rollback` restores the previous revision.
- At launch, the current overlay is injected into that agent's child system prompt as a `<pi-subagents-refinement>` block scoped to this project. The base agent definition is never modified.

`refine.show` prints the current overlay and revision history. Delete the overlay file to remove the refinement entirely.

## Tool and extension selection

How `tools` behaves:

- `tools` omitted: `pi-subagents` does not pass `--tools`, so the child gets Pi's normal builtin tools.
- `tools` present: regular tool names become an explicit allowlist.
- `tools:` empty: emits `--no-tools`.

An allowlisted name does not load the extension that registers it. Load that provider through normal Pi extension discovery, `extensions`, `subagentOnlyExtensions`, or a path-like `tools` entry.

More rules:

- `mcp:` entries are split out and forwarded as direct MCP selections without granting normal builtins unless those builtins are also listed.
- Path-like `tools` entries, such as extension paths or `.ts`/`.js` files, are treated as tool-extension paths rather than tool names.
- Internal runtime tools such as `structured_output` are added to an explicit allowlist only when their contract is active.
- Agents that declare only known read-only builtin tools skip the implementation completion guard. `bash`, unknown tools, and MCP tools stay mutation-capable. Use `completionGuard: false` for bash-enabled validators or advisors that should never be judged as implementation agents.

Examples:

- `tools` omitted and `extensions` omitted: normal builtins and normal extensions.
- `tools: mcp:chrome-devtools`: only the resolved direct Chrome DevTools MCP tools.
- `tools: read, bash, mcp:chrome-devtools`: only `read` and `bash` as builtins, plus direct Chrome DevTools MCP tools.
- `tools: subagent, read`: a child-safe `subagent` tool is available inside that child so it can run explicitly assigned nested fanout.
- `tools: read, fixture_search` plus `subagentOnlyExtensions: ./tools/fixture-search.ts`: the provider loads only in this agent's child process, and the registered `fixture_search` name survives the strict allowlist.

Direct MCP tools require [pi-mcp-adapter](https://github.com/nicobailon/pi-mcp-adapter). Subagents only receive direct MCP tools when `mcp:` entries are listed in their frontmatter; global `directTools: true` in `mcp.json` is not enough by itself. The generic `mcp` proxy tool can still be used for discovery when available. The adapter caches tool metadata at startup, so after connecting a new MCP server for the first time, restart Pi before relying on direct tools. An `mcp:` entry named `subagent` does not authorize nested fanout; only the builtin `subagent` tool name does. If a resolved direct MCP name is missing from the child registry, pi-subagents keeps the launch failed under the strict allowlist and identifies the condition as a host/pi-mcp-adapter registration problem; verify that the adapter registers the selected tools before child startup.

`extensions` controls child extension loading:

```yaml
# Omitted: all normal extensions load

# Empty: no extensions
extensions:

# Allowlist
extensions: /abs/path/to/ext-a.ts, /abs/path/to/ext-b.ts
```

When `extensions` is present, normal discovered extensions are disabled. The listed extensions, path-like `tools` entries, required pi-subagents runtime extensions, and `subagentOnlyExtensions` still load.

Use `subagentOnlyExtensions` when a custom extension tool should exist only inside child sessions. It is scoped by agent config: every run of that agent receives those extension paths, while other agents do not unless they declare the same field. The current model does not have a separate named-subagent audience inside one agent definition.

To apply the same `extensions` allowlist to every agent that does not declare its own, set `subagents.defaultExtensions` in user or project settings (see [configuration.md](configuration.md)).

Before the first model turn, the child runtime compares every explicit tool name with Pi's final filtered registry. A missing provider fails the run with the unavailable names and concrete `subagentOnlyExtensions`/`extensions` guidance, instead of letting a direct or chained child silently continue without its requested tools.

## Skills

Skills are `SKILL.md` files made available to an agent. The prompt includes skill metadata and the file location; the agent reads the full skill file only when the task matches.

Discovery uses project-first precedence:

1. Project config `skills/{name}/SKILL.md` (`.pi/skills/{name}/SKILL.md` in standard Pi)
2. Project packages and project settings packages via `package.json -> pi.skills`
3. Current task cwd package via `package.json -> pi.skills`
4. Project config `settings.json -> skills`
5. `~/.pi/agent/skills/{name}/SKILL.md`
6. User packages and user settings packages via `package.json -> pi.skills`
7. `~/.pi/agent/settings.json -> skills`

Use agent defaults, override them at runtime, or disable them:

```ts
{ workflowScript: `return runs.run("main", { agent: "scout", task: "..." })` }
{ workflowScript: `return runs.run("main", { agent: "scout", task: "...", skill: "tmux, safe-bash" })` }
{ workflowScript: `return runs.run("main", { agent: "scout", task: "...", skill: false })` }
```

For chains, `skill` at the top level is additive. A step-level `skill` overrides that step; `false` disables skills for that step.

Available skills use this shape in the child prompt:

```xml
The following configured skills are available to this subagent.
Use the read tool to load a skill's file when the task matches its description.
When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.

<available_skills>
  <skill>
    <name>safe-bash</name>
    <description>Run shell commands safely.</description>
    <location>/absolute/path/to/safe-bash/SKILL.md</location>
  </skill>
</available_skills>
```

If an agent has an explicit `tools` allowlist and resolved skills, `read` is added for that child run so the listed skill files can be loaded on demand.

Missing skills do not fail execution. The result summary shows a warning.

Agent-local `skillPath` candidates never enter Pi's parent/global skills catalog. Pair `inheritSkills: false` with explicit `skills` and `skillPath` when a child should receive only its selected private skills.

## The bundled pi-subagents skill

The package bundles a `pi-subagents` skill that is automatically available to the parent agent when the extension is installed. It is for the orchestrating parent only: child subagents never receive it, and their context is explicitly filtered to strip parent-only orchestration instructions.

What it covers:

- **Delegation patterns**: when to launch which agent, whether to use single, parallel, chain, or async mode, and whether to use fresh or forked context.
- **Prompt workflow recipes**: how to apply the packaged techniques directly with `subagent(...)` when the user describes the workflow in natural language instead of invoking a slash command. This includes parallel review, review-loop, parallel research, parallel context-build, parallel handoff-plan, gather-context-and-clarify, and parallel cleanup.
- **Role-agent prompting guidance**: compact contract prompts instead of long scripts, what to include in role-specific meta prompts, and retrieval budgets for researchers.
- **Safety boundaries**: child agents must not run subagents unless their resolved builtin tools explicitly include `subagent`, must not invent intercom targets, and must escalate unapproved decisions.
- **Intercom conventions**: when to ask vs send, and how parent-side supervisor/result delivery works through the native channel.
- **Control and diagnostics**: attention signals, soft interrupts, status, and the `doctor` action.

If you are writing an agent that orchestrates subagents, the bundled skill helps it behave correctly without guessing the patterns. If you are a human user, you do not need to read it; the README and prompt shortcuts encode the same workflows in user-facing form.
