# Pi Subagents: Management Authoring Rpc

This file is a detailed reference loaded from `skills/pi-subagents/SKILL.md`.

## Management Mode

The `subagent(...)` tool also supports management actions.

### List available agents and chains

```typescript
subagent({ action: "list" })
```

### List retained children

```typescript
subagent({ action: "children.list" })
```

Lists up to the last 10 retained workflow children from this parent session with explicit `resumable` or `not resumable` rows. Resume only rows reported `resumable`. Send a simple follow-up or implementation challenge with `subagent({ action: "resume", id: "<run-id>", message: "..." })`. Continue one inside a workflow with `runs.run(key, { resume: "<run-id>", task: "follow-up" })`; the revived child keeps its stored agent, model, and tool contract. If no resumable child is listed, start a same-role fallback challenge and label it as fallback. `steer` with `mode: "follow_up"` only queues text for the next `resume` when the child has already completed.

### Refinement overlays

```typescript
subagent({ action: "refine", agent: "reviewer" })
subagent({ action: "refine.show", agent: "reviewer" })
subagent({ action: "refine.rollback", agent: "reviewer" })
```

`refine` builds a bounded project-local guidance overlay for one agent from recent run evidence, using a fresh read-only proposal child; validated guidance is stored under `.pi/subagents/refinements/<agent>.md` with revision snapshots and is injected into that agent's child system prompt for this project. `refine.show` prints the current overlay and history; `refine.rollback` restores the previous revision. Guidance that tries to override safety, policy, tool, output, acceptance, developer, or system instructions is rejected. `/subagents-refine <agent>` is the slash equivalent.

### Create an agent

```typescript
subagent({
  action: "create",
  config: {
    name: "my-agent",
    package: "code-analysis",
    description: "Project-specific implementation helper",
    systemPrompt: "Your system prompt here.",
    systemPromptMode: "replace",
    model: "openai-codex/gpt-5.4",
    tools: "read,grep,find,ls,bash"
  }
})
```

### Update an agent

```typescript
subagent({
  action: "update",
  agent: "code-analysis.my-agent",
  config: {
    thinking: "high"
  }
})
```

### Delete an agent

```typescript
subagent({ action: "delete", agent: "code-analysis.my-agent" })
```

### Eject, disable, enable, and reset

```typescript
// Copy a bundled builtin/package agent to user scope as an editable custom file.
subagent({ action: "eject", agent: "reviewer" })
subagent({ action: "eject", agent: "reviewer", agentScope: "project" })

// Hide an agent from runtime discovery without deleting it (reversible).
subagent({ action: "disable", agent: "reviewer" })
subagent({ action: "enable", agent: "reviewer", agentScope: "project" })

// Delete the scope's custom agent file and/or settings override, restoring the bundled default.
subagent({ action: "reset", agent: "reviewer" })
```

`eject` copies a builtin or package agent verbatim into the user (default) or project agent dir so it can be customized without hunting package files; the copy shadows the original by runtime name. `disable` writes a reversible `agentOverrides.<name>.disabled: true` entry to the user or project settings file. `enable` removes that `disabled` field while keeping any other override fields. `reset` removes the scope's custom file and settings override to restore the bundled default, and refuses if no bundled default exists (use `delete` for purely custom agents). All four take optional `agentScope: "user" | "project"`; project overrides win over user ones, so target the project scope to undo a project-scope disable.

Use management actions when the system needs to create or edit subagents on
demand without dropping into raw file editing.

Management actions create or update user/project agent files. `config.name` is the local frontmatter name; optional `config.package` registers and looks up the runtime name as `{package}.{name}`. Use the dotted runtime name for `get`, `update`, `delete`, slash commands, and chain steps. For small builtin changes such as a model swap, prefer `subagents.agentOverrides` in settings.

## Creating and Editing Agents by File

A minimal agent file looks like this:

```markdown
---
name: my-agent
package: code-analysis
description: What this agent does
aliases: developer, coder
model: openai-codex/gpt-5.4
thinking: high
tools: read, grep, find, ls, bash
systemPromptMode: replace
inheritProjectContext: true
inheritSkills: false
skills: safe-bash, review-checklist
skillPath: ./skills, ../shared-skills
---

Your system prompt here.
```

That is only a starting point. Omit `package` for the traditional unqualified runtime name. Common optional fields include:
- `defaultProgress`
- `defaultReads`
- `output`
- `aliases`
- `fallbackModels`
- `subagentOnlyExtensions`
- `skills`
- `skillPath`
- `memory`
- `maxSubagentDepth`
- `acceptance`
- `acceptanceRole`
- `async` — single-agent default for background launch (`true`/`false`); explicit tool-call `async` wins
- `timeoutMs` — single-agent default run-level max runtime in ms; foreground calls use a 30-minute package default only when neither the call nor agent provides one (tool alias `maxRuntimeMs` is also accepted)
- `turnBudget` — single-agent default `{ maxTurns, graceTurns? }` JSON object

`aliases` is an optional comma-separated or block-list set of alternate names for selecting an agent. Aliases resolve to the canonical `name` for execution, status, persistence, and config. Exact canonical names take precedence over aliases, and alias collisions between distinct canonical agents fail as ambiguous. Management create/update accepts a comma-separated string, string array, or `false`/empty string to clear aliases.

`acceptance` is a single-agent launch default. Use a scalar level such as `checked` or an inline/block YAML map such as `{ level: "none", reason: "lightweight lookup" }`. An explicit tool-call value wins; chain and parallel acceptance remains configured on the task or step. Management create/update accepts the same policy object, and `acceptance: ""` clears the frontmatter default (`false` remains the deprecated disabled-policy shorthand).

`acceptanceRole` is `read-only` or `writer` and controls automatic acceptance inference only. Explicit task mutation or no-edit intent wins; otherwise the role replaces agent-name guessing. Omission preserves the current name heuristics. The field does not grant or revoke tools. Management accepts `false` or an empty string to clear it.

`tools` is a strict child allowlist, not an extension loader. For a named extension tool, keep its registered name in `tools` and load its provider through normal Pi discovery, `extensions`, a path-like `tools` entry, or `subagentOnlyExtensions`. For example, pair `tools: read, fixture_search` with `subagentOnlyExtensions: ./tools/fixture-search.ts` when the provider should exist only in that agent's child sessions. The child now fails with the unavailable names and provider-loading guidance instead of silently continuing when a requested tool is absent; internal `structured_output` is allowed automatically when an output schema requires it.

`skillPath` adds invocation-private skill files or discovery directories relative to the agent file; it does not select them, so list the desired names under `skills`. Local matches win, unresolved or unreadable matches use normal discovery, and local candidates never enter the parent/global catalog. Use `memory: { scope: "project" | "user", path: "<name>" }` for opt-in role-specific durable memory under the dedicated `agent-memory/` namespace; it is separate from parent/session project memory.

For many customizations, builtin overrides in settings are lower-friction than
copying a full builtin file.

## Prompt Template Integration

The package includes prompt shortcuts for common workflows: `/parallel-review`,
`/review-loop`, `/parallel-research`, `/gather-context-and-clarify`, and
`/parallel-cleanup`. Use them when the user wants repeatable review,
review/fix loops, research, context handoff, implementation handoff,
clarification, or cleanup-review patterns. `/parallel-review autofix` and
`/parallel-cleanup autofix` synthesize reviewer feedback and then apply only the
fixes worth doing now. Parent agents can also apply the same recipes directly
with `subagent(...)` when the user describes the workflow in natural language
instead of invoking a slash command.

Additional user prompt templates can delegate into `pi-subagents` through the native `/prompt-workflow` command. This is useful when a slash command should always run through a particular agent or with forked context. Prompt frontmatter can set `subagent`, `model`, `skill`, `cwd`, `fresh`, `fork`, or `inheritContext` for the native adapter.

## Extension RPC

Other Pi extensions can call `pi-subagents` through the in-process event bus. The RPC channels are `subagents:rpc:v1:ready`, `subagents:rpc:v1:request`, and per-request replies at `subagents:rpc:v1:reply:<requestId>`. Envelopes use `{ version: 1, requestId, method, params }`, and replies use `{ version: 1, requestId, success, data | error }`. `ping` advertises the exact process-local async completion event as `events.asyncComplete` for RPC-spawn consumers.

Methods: `ping`, `status`, `spawn`, `steer`, `interrupt`, `resume`, and `stop`. `ping` capability metadata advertises optional projections: `capabilities.fleetStatus: { version: 1 }` adds bounded current-session `data.fleet` records (opaque reconciliation `key`, resolved `agent`, optional `role`, `model`, `effort`, caller-facing `goal`, `startedAt`, split `{ input, output, total }` tokens, plus `totalActive`/`omitted` overflow counts) to successful `status` replies; `capabilities.launchResolvedExtensions` advertises parent-resolved opaque launch-extension identifiers in status details; `capabilities.runtimeAcknowledgedExtensions` advertises the best-effort child-runtime acknowledgement projection fed by cooperating extensions emitting `subagent:acknowledge-extension`. Foreground `details.results[]` rows carry a stable numeric `index`; correlate children by `(runId, index)` rather than row position. Consumers should read status/result artifacts and RPC projections instead of scraping terminal output and must ignore unknown fields. `spawn` requires `workflowScript`, is async-only, and rejects management actions, `async: false`, or `clarify: true`; it reuses the normal executor, so discovery, validation, session attribution, configured spawn caps, child-safety depth, artifacts, and async status are shared with the `subagent` tool. `status`, acknowledged async `steer`, and `interrupt` map to the normal control actions. RPC steer disables pause-and-revive recovery and advertises `capabilities.nonRecoveringSteer`, preserving the caller's authority over the exact spawned child. `resume` requires a target plus non-empty message and delegates to the package-owned revival path; it may set a caller-owned `file-only` output path but cannot override the persisted child model, tools, budgets, session ownership, or exclusive session lease. For retained-child workflows, list children first and resume only rows reported `resumable`; otherwise start a same-role fallback challenge and label it as fallback. `stop` targets running async runs through the existing timeout control channel. `pi.events` is process-local, so separate Pi processes and child subagents need lifecycle artifact files or `pi-intercom` instead.
