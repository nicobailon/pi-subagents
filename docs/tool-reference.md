# Tool reference

Parameters and actions for the `subagent` tool. These are what the LLM passes when it calls the tool; most users ask naturally or use slash commands instead.

## Execution examples

```js
// One child; return the child promise explicitly
{ workflowScript: `return runs.run("main", { agent: "scout", task: "Analyze the auth flow" })` }

// Sequential workflow
{ workflowScript: `
  const scan = await runs.run("scan", { agent: "scout", task: "Analyze auth" });
  return (await runs.run("implement", { agent: "worker", task: "Implement from: " + scan.output })).output;
` }

// Parallel workflow
{ workflowScript: `
  const results = await runs.all([
    { key: "backend", agent: "reviewer", task: "Review backend" },
    { key: "frontend", agent: "reviewer", task: "Review frontend" }
  ]);
  return results.map(result => result.output);
` }
```

## Parameter reference

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `agent` | string | - | Agent target for management actions. Workflow child agents are set inside `runs.run` or `runs.all`. |
| `action` | string | - | Agent management (including `guide`, `children.list`, and `refine`/`refine.show`/`refine.rollback`), mission (`mission.create/list/show/update/resolve-decision/attach-run/close`), Herdr inspector (`inspector.open/status/close`), status/control, schedule, watchdog, or doctor action. |
| `topic` | `overview \| workflows \| agents \| missions \| observability \| tool-reference \| configuration \| models \| watchdog \| extension-api` | `overview` | Packaged guide topic for `action: "guide"`. |
| `chainName` | string | - | Chain name for management actions. |
| `config` | object/string | - | Agent or existing durable chain config for management create/update. |
| `context` | `fresh \| fork` | per-agent default or `fresh` | Explicit `fresh` or `fork` overrides every workflow child. When omitted, each child agent uses its own `defaultContext`; `fork` creates real branched sessions from the parent leaf. Packaged `worker`, `oracle`, and `advisor` default to `fork`. |
| `missionId` | string | - | Attach a workflow to an existing project mission instead of creating its default enclosing mission. |
| `mission` | object/false | auto-create | Override the default enclosing mission with `{ title, objective?, goal?, budget?, labels? }`; `goal: true` requires `budget.tokens` and enables continuation notices. Pass `false` for an intentionally ephemeral workflow with no mission for it or its children and no `state` global. Explicit mission persistence failures are strict. |
| `handoffPath` | string | - | Aggregate handoff manifest required by `action: "worktree.discard"`. |
| `focus` | boolean | true | Focus the newly split pane for `action: "inspector.open"`; not a standalone action. |
| `view` | `fleet \| transcript` | - | Optional `status` view for the active fleet surface or transcript tail inspection. |
| `lines` | number | `80` | Maximum transcript lines for `action: "status", view: "transcript"`; capped at 500. |
| `agentScope` | `user \| project \| both` | `both` | Agent discovery scope. Project wins on collisions. |
| `async` | boolean | default-on | Background execution. Workflows default to background and accept `async:false` as an explicit foreground escape hatch. |
| `chatProgress` | `auto \| off \| live-card` | `auto` | WorkflowScript chat projection. `auto` renders a live in-chat card only for watched foreground workflows in the same Git repository, including managed worktrees; it is off otherwise. Explicit `live-card` requires `async:false` and the same Git repository. |
| `timeoutMs` / `maxRuntimeMs` | number | 30 min foreground; none async | Optional run-level max runtime in milliseconds. Foreground uses 30 minutes when omitted. Async runs have no default timeout, including async workflows. |
| `turnBudget` | object | none | Optional assistant-turn budget `{ maxTurns, graceTurns }`. At `maxTurns` the child is warned to wrap up. After the grace window (default 1), termination occurs at the next assistant boundary; a response that starts tool work records `termination-deferred` until a later boundary. Partial output is returned on abort. |
| `toolBudget` | object | none | Optional child tool-call budget `{ soft?, hard, block? }`. At `soft` the child is nudged to finalize. After `hard`, configured tools are blocked; `block` defaults to `read`, `grep`, `find`, and `ls`, while `"*"` blocks every tool call. Final assistant text is never blocked. |
| `usageBudget` | object | none | Optional root-only reported-usage budget `{ tokens?: { soft?, hard }, costUsd?: { soft?, hard } }`. Soft limits are status-only. Hard limits prevent later child launches after reported usage is reconciled; already-running children are not stopped and no reservations are made. |
| `cwd` | string | runtime cwd | Override working directory. |
| `maxOutput` | object | 200KB, 5000 lines | Final output truncation limits. |
| `artifacts` | boolean | true | Write debug artifacts. |
| `includeProgress` | boolean | false | Include full progress in result. |
| `share` | boolean | false | Upload session export to GitHub Gist. |
| `sessionDir` | string | derived | Override session log directory. |
| `acceptance` | string/object/false | inferred | Configure evidence gates. See [Acceptance gates](#acceptance-gates). |
| `gate` | string | - | One host-run verification command, shorthand for `acceptance: { level: "verified", verify: [{ id: "gate", command }] }`. Also valid on individual `runs.run`/`runs.all` items. Cannot be combined with `acceptance`, and is rejected with retained `resume`. |

### Budget guidance for writers

As a conservative orchestration policy, do not set `turnBudget`, a hard `toolBudget`, or a tight `usageBudget` on implementation workers, fix workers, reviewers with edit authority, or other mutation-capable children. A default tool budget blocks read/search tools rather than mutation tools, and reported usage has no reservation model, so neither assistant turns, tool-call counts, nor token/cost totals measure whether a delivery slice is buildable or safe to hand off. Hard caps remain appropriate for explicitly read-only scouts, reviewers, and validators.

Bound writer work with a narrow task and an outer `timeoutMs` or `maxRuntimeMs` that leaves enough margin for the slice. An elapsed timeout is not a mutation-safe boundary and may still signal a child during tool work. Before the deadline, use `steer` or an attention notice to request a checkpoint after the current tool returns, including changed files, build/test state, remaining work, and commit or PR state.

### Fork context details

`context: "fork"` fails fast when the parent session is not persisted, the current leaf is missing, or the branched child session cannot be created.

When the inherited transcript contains signed Anthropic `thinking` / `redacted_thinking` blocks, `pi-subagents` strips those provider-private blocks from the forked child session. It forces thinking `off` only when the child's effective primary or fallback model resolves through the model registry to the Anthropic provider or `anthropic-messages` API; unresolved models are treated conservatively. The result reports every affected child, including on failed runs. Use `context: "fresh"` when an Anthropic child needs thinking. Forking never silently downgrades to `fresh`.

In workflow runs that omit `context`, each `runs.run` child follows its own `defaultContext`, so a fresh-default scout can run fresh beside a fork-default worker. Pass explicit `context: "fork"` or `context: "fresh"` when you intentionally want one context for every child.

### Output mode details

Use `outputMode: "file-only"` when a saved output may be large and the parent only needs a pointer. The returned text is a compact reference like `Output saved to: /abs/report.md (48.2 KB, 2847 lines). Read this file if needed.` Failed runs and save errors still return normal inline output for debugging.

In workflowScript, give each child an explicit output path when later script steps need a durable file reference. A child with only read-only tools does not need direct filesystem access for `output`: it returns the complete artifact in its final response and the runtime persists it. Children with mutation-capable tools retain the direct-write instruction.

Workflows get `await state.get(key)` and `await state.set(key, value)` through their default or explicit mission. Use them to share durable JSON values across later workflows attached with the same `missionId`. Each `set` takes the state-file lock and merges its key with the latest on-disk state. Missing keys return `undefined`, and the complete state file has a strict 256 KiB limit. `mission:false` workflows have no `state` global.

### Retained children

Completed workflow children from the current parent session stay addressable as retained children. `{ action: "children.list" }` lists up to the last 10 with their run ids. A later workflow continues one by passing `resume` instead of `agent`:

```js
{ workflowScript: `return runs.run("continue", { resume: "<retained-run-id>", task: "Apply the follow-up feedback" })` }
```

`resume` and `agent` are mutually exclusive. The revived child keeps its stored agent, model, and tool contract. `gate` is rejected on retained resume items because resume uses the retained child contract.

## Management actions

### Guide

`{ action: "guide" }` reads the packaged `README.md` from the installed version. Pass `topic` to read its packaged `docs/<topic>.md` file instead. Valid topics are `overview`, `workflows`, `agents`, `missions`, `observability`, `tool-reference`, `configuration`, `models`, `watchdog`, and `extension-api`. Unknown topics list the valid values and do not change files. Use `/subagents-guide [topic]` for the slash equivalent.

Agent definitions are not loaded into context by default. Management actions let the LLM discover, inspect, create, update, and delete agents and chains at runtime. An unknown action returns safe next steps (`status` and `list`) and may suggest a close non-destructive action. Destructive actions are only named for a near-complete one-character typo, and suggestions never execute an action.

```ts
{ action: "list" }
{ action: "list", agentScope: "project" }
{ action: "get", agent: "scout" }
{ action: "models" }
{ action: "models", agent: "reviewer" }
{ action: "get", agent: "code-analysis.scout" }
{ action: "get", chainName: "review-pipeline" }

{ action: "create", config: {
  name: "Code Scout",
  package: "code-analysis",
  description: "Scans codebases for patterns and issues",
  scope: "user",
  systemPrompt: "You are a code scout...",
  systemPromptMode: "replace",
  inheritProjectContext: false,
  inheritSkills: false,
  model: "anthropic/claude-sonnet-4",
  fallbackModels: ["openai/gpt-5-mini", "anthropic/claude-haiku-4-5"],
  tools: "read, bash, mcp:github/search_repositories",
  extensions: "",
  skills: "parallel-scout",
  thinking: "high",
  acceptance: { level: "none", reason: "lightweight lookup" },
  acceptanceRole: "read-only",
  output: "context.md",
  reads: "shared-context.md",
  progress: true
}}

{ action: "create", config: {
  name: "review-pipeline",
  description: "Scout then review",
  scope: "project",
  steps: [
    { agent: "scout", task: "Scan {task}", output: "context.md" },
    { agent: "reviewer", task: "Review {previous}", reads: ["context.md"] }
  ]
}}

{ action: "update", agent: "code-analysis.scout", config: { model: "openai/gpt-4o" } }
{ action: "update", agent: "code-analysis.scout", config: { acceptance: "" } } // clear the frontmatter default
{ action: "update", agent: "code-analysis.scout", config: { acceptanceRole: false } } // restore inferred name fallback
{ action: "update", chainName: "review-pipeline", config: { steps: [...] } }
{ action: "delete", agent: "scout" }
{ action: "delete", chainName: "review-pipeline" }

{ action: "eject", agent: "reviewer" }
{ action: "eject", agent: "reviewer", agentScope: "project" }
{ action: "disable", agent: "reviewer" }
{ action: "enable", agent: "reviewer", agentScope: "project" }
{ action: "reset", agent: "reviewer" }
```

Rules:

- `create` uses `config.scope`, not `agentScope`.
- `config.name` is the local frontmatter name; optional `config.package` registers the runtime name as `{package}.{name}` and is saved as separate `name` and `package` frontmatter.
- `config.aliases` accepts a comma-separated string, string array, or `false` to clear aliases. Aliases resolve to the canonical agent name for execution and are shown by `list`/`get`.
- `update` and `delete` use the runtime name and `agentScope` only when the same runtime name exists in multiple scopes.
- To clear optional string fields, including `package`, set them to `false` or `""`.

`eject`, `disable`, `enable`, and `reset` are described in [agents.md](agents.md#overriding-builtins).

### Refinement overlays

`refine`, `refine.show`, and `refine.rollback` manage project-local refinement overlays for one agent. `/subagents-refine <agent>` is the slash equivalent of `refine`. See [agents.md](agents.md#refinement-overlays) for behavior and storage.

## Status and control actions

```ts
subagent({ action: "status" })
subagent({ action: "status", view: "fleet" })
subagent({ action: "status", id: "<run-id>" })
subagent({ action: "status", id: "<run-id>", view: "transcript", index: 0, lines: 80 })
subagent({ action: "status", id: "<nested-run-id>" })
subagent({ action: "interrupt", id: "<run-id>" })
subagent({ action: "interrupt", id: "<nested-run-id>" })
subagent({ action: "stop", id: "<run-id>" })
subagent({ action: "resume", id: "<run-id>", message: "follow-up question after it pauses or finishes" })
subagent({ action: "resume", id: "<run-id>", index: 1, message: "follow-up for child 2" })
subagent({ action: "resume", id: "<nested-run-id>", message: "follow-up for a nested child" })
subagent({ action: "steer", id: "<run-id>", message: "guidance for the running child" })
subagent({ action: "steer", id: "<run-id>", mode: "follow_up", message: "check this after the current turn" })
subagent({ action: "steer", id: "<run-id>", index: 1, mode: "auto", message: "guidance for child 2" })
subagent({ action: "append-step", id: "<run-id>", step: { agent: "worker", task: "Continue from {previous}" } })
subagent({ action: "approve-checkpoint", id: "<run-id>" })
subagent({ action: "reject-checkpoint", id: "<run-id>" })
subagent({ action: "doctor" })
```

### status

`status` resolves exact foreground ids, top-level async ids, and nested run ids before falling back to prefix matching.

- `view: "fleet"` is an optional read-only active-run surface with transcript commands; it does not add steering or stop controls.
- `view: "transcript"` tails the selected run's live `output-<index>.log` or persisted session transcript, with `lines` capped at 500.
- Nested status shows the root/parent path, nested children, session/artifact paths when known, and nested control commands.
- Inside child-safe fanout mode, bare `status` requires an id when no local foreground run is active, so children cannot enumerate unrelated top-level async runs.
- Bare `interrupt` still targets only the visible top-level run; interrupting a nested run requires its explicit nested id.

### resume

`resume` revives a paused, completed, or failed async/foreground child by starting a new child from its stored session file. Stopped runs remain non-resumable, and it does not interrupt a live top-level async child. Use `steer` for acknowledged live async guidance.

- Multi-child async runs and remembered foreground single, parallel, or chain runs can be revived by passing `index` to choose the child.
- Nested runs can be resumed by nested id when their live route or persisted nested session metadata is available.
- Revive starts a new child process from the old session context; it does not restart the same OS process, and it requires the chosen child to have a persisted `.jsonl` session file.
- Direct revival takes an exclusive cross-process lease on the canonical session file until the new child finishes. A concurrent attempt fails before Pi is spawned and identifies the owning revived run; dead-owner leases are reclaimed only when staleness can be proved.

### stop

`stop` ends a current-session top-level async run. It is deliberately stronger than `interrupt`:

- It is not a resumable pause; stopped runs should be restarted as new runs.
- Foreground and nested targets are rejected.
- Direct id calls execute immediately.
- `/subagents-stop` without an id opens a selector with confirmation when a TUI is available. Use `↑`/`↓` or `j`/`k` to move through the selector.
- In non-TUI contexts the slash command prints exact `subagent({ action: "stop", id })` and `/subagents-stop <id>` commands.
- Inactive schedules can appear in the selector, but they are labeled as schedules and route through `schedule.pause`, not `stop`.

### steer

`steer` waits up to three seconds for a correlated child-Pi input acceptance and returns a request id with `delivered`, `scheduled`, `pending`, `partial`, `recovered`, or `failed` plus per-child states. The receipt also has `deliveryStatus: "delivered" | "queued"`. Delivery means Pi accepted the user message, not model compliance. A pending indexed child returns `scheduled`.

The optional `mode` is `steer` by default and keeps the current interrupt behavior. `follow_up` waits for the next turn boundary. `auto` queues during an active turn and delivers immediately between turns. The bounded FIFO holds 20 messages and returns a clear error when full. Terminal details report queued messages that the run did not deliver. A `follow_up` sent to a completed retained workflow child becomes the first brief for its next `resume`.

Only a top-level single run may interrupt after the acknowledgment deadline and recover after a further 15-second pause/revival bound; durable multi-child and nested runs never auto-interrupt. Recovery launches a replacement only after the source is confirmed paused, a valid persisted session exists, and deadline, turn, and tool budgets remain. It preserves the original child contract and remaining limits; otherwise the source stays paused with an explicit failure. Late acceptance is recorded but cannot cancel committed recovery.

The persisted `steering` ledger retains 20 requests and replaces the old `steerCount`/`lastSteerAt` fields.

### append-step

`append-step` accepts exactly one `step` object for an existing durable chain for a top-level async chain whose status is still `running`. The step is persisted in the run directory and becomes eligible only after the chain's already-queued steps finish. Completed, failed, rejected, paused, foreground, single, and non-chain runs reject appends.

## Acceptance gates

Every run resolves an effective acceptance policy. Callers may omit `acceptance` for the inferred default, or set it on single runs, top-level parallel task items, chain steps, static parallel tasks, and dynamic fanout templates.

```ts
{
  agent: "worker",
  task: "Implement the fix",
  acceptance: {
    level: "verified",
    criteria: ["Patch the bug without widening scope"],
    evidence: ["changed-files", "tests-added", "commands-run", "residual-risks", "no-staged-files"],
    verify: [{ id: "focused", command: "npm test", timeoutMs: 120000 }]
  }
}
```

### One-command gates

When one host-run command is the entire verification contract, use the `gate` shorthand instead of a full `acceptance` object:

```js
{ workflowScript: `return runs.run("impl", { agent: "worker", task: "Implement the fix", gate: "npm test" })` }
```

`gate` normalizes to verified acceptance with that single command, so the runtime executes it on the host and records the result as evidence. Verification results are memoized per tracked workspace state and effective environment, so an unchanged tree does not rerun the same command. Use explicit `acceptance.verify` when you need multiple commands, timeouts, or custom criteria. `gate` cannot be combined with `acceptance` and is rejected on retained `resume` items. With `worktree: true`, the gate runs inside the child's managed worktree.

### Levels and inference

Acceptance evidence levels are `auto`, `none`, `attested`, `checked`, and `verified`. `acceptance: "auto"` is the default.

Review is a separate gate configured with `acceptance.review`:

- Async, risky, and dynamic writer contexts infer checked evidence plus `review: { agent: "reviewer", required: true }`.
- Read-only tasks infer lightweight attestation.
- Normal writer tasks infer checked evidence without review.

Agent frontmatter or `subagents.agentOverrides` may set `acceptanceRole: "read-only" | "writer"` for ambiguous tasks. Explicit task mutation or no-edit intent wins over that role, while omitted metadata preserves the existing reviewer/scout/worker name heuristics. The role affects acceptance inference only and does not change tool access.

Edge cases:

- The bare string `"none"` is rejected; use `{ level: "none", reason: "..." }` instead.
- `acceptance: false` is accepted only as a deprecated shorthand for disabling gates.
- For reviewer/read-only calls, omit `acceptance`.
- The explicit value `"reviewed"` is not a policy level: it remains schema-recognized only so semantic preflight can explain the mistake without spawning a child. To require review of a writer result, use `acceptance: { level: "checked", review: { required: true, agent: "reviewer" } }` and orchestrate the reviewer separately.
- With `agentContract: { version: 1 }`, omitted, `"auto"`, and `false` mean no acceptance request for that run; explicit acceptance is reported separately from execution.

### Evidence status

Acceptance provenance is stored separately from child prose. `evidenceStatus` preserves evidence progress when the overall status is waiting on or has completed review:

- `claimed`: child finished but did not provide structured evidence.
- `attested`: child returned a structured acceptance report.
- `checked`: runtime structural checks passed, such as required evidence and no staged files.
- `verified`: configured runtime verification commands passed. Child-reported command success does not count.
- `review-required`: required evidence passed, but no independent reviewer result has been supplied.
- `reviewed`: an independent reviewer result is present and has no blockers.
- `rejected`: attestation, structural checks, verification, or review failed.

### The acceptance report

For `attested` or stricter levels, the child prompt includes a standardized acceptance section and asks for a fenced `acceptance-report` JSON block.

The parser canonicalizes known enum synonyms, snake_case report keys and wrappers, underscore fence tags, unambiguous scalar arrays, string booleans, and criterion-id separators. Unknown or ambiguous keys and enum values fail with field-level diagnostics. Explicit empty `changedFiles` and `testsAddedOrUpdated` arrays are recorded as not applicable; missing fields and empty required command or validation evidence still fail.

Acceptance fences are removed from normal output artifacts, while the raw child transcript remains intact and per-child metadata stores the complete acceptance ledger and parsed report. Explicit failed gates fail the run. Inferred gates remain observable without failing the run.

## External CLI agent profiles

Agent profiles can opt into a local one-shot command instead of a Pi child. External runners add no install dependency, but the configured executable must exist at runtime. They are async-only, receive one combined system/task prompt over stdin, and use argv arrays without a shell:

```yaml
runner:
  type: external-cli
  command: node
  args: ["./scripts/local-reviewer.mjs"]
  promptDelivery: stdin
async: true
```

Supported: status artifacts, stdout/stderr logs, timeout, and stop. Full stdout and stderr are written to log files, while the in-memory final stdout response and stderr error are limited to their last 64 KiB.

Intentionally unsupported: foreground/clarify, steer/resume/interrupt-as-pause, Pi models/tools/extensions, skills, structured output, nested subagents, and fallback models.

## Session sharing

Pass `share: true` to export a full session to HTML, upload it to a secret GitHub Gist through your `gh` credentials, and return a `https://shittycodingagent.ai/session/?<gistId>` URL.

```ts
{ workflowScript: `return runs.run("main", { agent: "scout", task: "..." })`, share: true }
```

This is disabled by default. Session data may contain source code, paths, environment variables, credentials, or other sensitive output. You need `gh` installed and authenticated.
