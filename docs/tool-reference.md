# Tool reference

Parameters and actions for the `subagent` tool. These are what the LLM passes when it calls the tool; most users ask naturally or use slash commands instead.

## Execution examples

Chaining is code-driven through `workflowScript`. Use `await runs.run(...)` for sequential steps and `await runs.all([{ key, agent, task }, ...])` for ordinary parallel fanout. `runs.all` resolves to an ordered array, not a key map, so use indexes, destructuring, or `.map(...)`, not `results.<key>`. Do not read `.output` from an unawaited `runs.run` launch. Stored `runs.run` promises are only for the advanced rolling fanout pattern under [Workflow steering](#workflow-steering), where every promise is later observed with direct `await`, `Promise.race`, or `Promise.all`. Legacy top-level `chain`, `tasks`, and `parallel` inputs are not supported. Helper functions must be plain functions or explicit Promise chains. Nested `async function` helpers, async arrows, and async methods are rejected so child-launch tracking stays portable across Node and Bun. For permission-sensitive host calls, use an extension-owned named resource such as `{ workflow: "run-ci", args: { command: "npm test" } }`; raw public `workflowScript`/`workflowScriptPath` inputs have unknown resource provenance and cannot call `runs.host`. A resolved resource may internally use `runs.host(key, { kind: "command", command, timeoutMs, output?, role?, provider? })` within its authority ceiling; there is no per-step `cwd`, and commands and relative output paths use the workflow `cwd`. Set `cwd` on the outer `subagent({...})` request instead, or put a trusted directory change in the command (for example, `cd /path/to/worktree && npm test`).

Use `{ action: "validate", workflowScript }` to check statically decidable syntax and structure without launching children. It returns `{ ok, errors }` and fails the tool call when `ok` is false. Literal child `baseRef` values are checked against the runtime ref policy. Dynamic keys and values remain subject to runtime checks; static validation does not guess them.

Use `workflowScriptPath` instead of `workflowScript` to load the same JavaScript statement body from a file. The two fields are mutually exclusive. Relative paths resolve against the request `cwd`, and absolute paths pass through. The host reads the file before validation, scheduling, or sandbox execution. The workflow sandbox still has no filesystem access. Missing, unreadable, and empty files fail as file input errors.

For permission-extension interoperability, use one of the package-owned named resources with bounded `args` instead of caller-supplied workflow text:

```js
{ workflow: "review", args: { task: "Review the auth flow" } }
{ workflow: "run-ci", args: { command: "npm test" } }
```

The host resolves the script and authority internally and records bounded provenance in workflow details and receipts. Named resources cannot be combined with `agent`, `task`, `workflowScript`, or `workflowScriptPath`; user/project resource registries are not part of this first slice.

```js
{ workflowScriptPath: "workflows/review.js", cwd: "/path/to/project" }
{ action: "validate", workflowScriptPath: "workflows/review.js" }
{ action: "schedule.create", every: "6h", workflowScriptPath: "workflows/review.js" }
```

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

### Parallel sequential lanes

Use `runs.lanes(lanes)` inside a `workflowScript` when several independent lanes each have ordered stages. This helper composes the existing workflow child runner; it does not add a top-level `lanes` parameter or a second persistence/cleanup system.

```js
{ workflowScript: `
  const board = await runs.lanes([
    { key: "api", stages: [
      { key: "writer", agent: "worker", task: "Implement the API change" },
      { key: "challenge", resume: "previous", task: "Challenge the implementation" },
      { key: "review", agent: "reviewer", task: "Review the API lane" }
    ] },
    { key: "ui", stages: [
      { key: "writer", agent: "worker", task: "Implement the UI change" },
      { key: "review", agent: "reviewer", task: "Review the UI lane" }
    ] }
  ]);
  return board.map((lane) => ({
    key: lane.key,
    state: lane.state,
    failedStage: lane.failedStage,
    stages: lane.stages.map((stage) => ({
      key: stage.key,
      state: stage.state,
      ok: stage.ok,
      runId: stage.runId,
      outputReference: stage.outputReference,
      verdict: stage.verdict
    }))
  }));
` }
```

The first stage of each lane is launched by one existing `runs.all(...)` batch. Later stages run in lane order. Set `resume: "previous"` on a later stage to continue the preceding retained child; the helper requires that child’s returned `runId` and delegates to the existing resume checks. Stage keys are local to the lane, and generated child keys are `<lane>.<stage>`.

The complete plain-JSON inventory is validated before the first launch (maximum 32 lanes, 16 stages per lane, 64 total stages, and 64 KiB canonical JSON). A failed, stopped, or detached stage blocks only its lane and marks later stages `skipped`; an explicit `structuredOutput.verdict === "blocked"` has the same effect. Reviewer prose is not parsed. The bounded board returns lane/stage keys, state, `ok`, run ids, explicit output references, bounded errors, and optional verdicts, not transcripts. Use raw `runs.run(...)`/`runs.all(...)` for conditional or rolling workflows.

## Parameter reference

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `agent` | string | - | Agent target for management actions. Workflow child agents are set inside `runs.run` or `runs.all`. |
| `action` | string | - | Offline workflow `validate`, agent management (including `guide`, `children.list`, and `refine`/`refine.show`/`refine.rollback`), lane evidence (`lane.status`, `lane.recordMerge`, `lane.recordSupersession`), mission (`mission.create/list/show/update/resolve-decision/attach-run/close`), Herdr inspector (`inspector.open/status/close`), Herdr project pane (`project.open/status/close`), status/control, plan-only `worktree.cleanup`, schedule, watchdog, or doctor action. |
| `topic` | `overview \| workflows \| agents \| missions \| observability \| tool-reference \| configuration \| models \| watchdog \| extension-api` | `overview` | Packaged guide topic for `action: "guide"`. |
| `config` | object/string | - | Agent config for management create/update. |
| `context` | `fresh \| fork` | global or per-agent default, else `fresh` | Explicit `fresh` or `fork` overrides every workflow child. When omitted, [`defaultSubagentContext`](configuration.md#defaultsubagentcontext) wins over each agent's `defaultContext`; `"fork"` creates a real branched session when the parent session file and current leaf exist, otherwise it falls back to `fresh`. Packaged `worker`, `oracle`, and `advisor` default to `fork`. |
| `missionId` | string | - | Attach a workflow to an existing project mission instead of creating its default enclosing mission. |
| `mission` | object/false | auto-create | Override the default enclosing mission with `{ title \| summary, objective?, goal?, budget?, labels? }`. Set exactly one non-empty `title` or `summary`; `objective` and `labels` are optional. `goal` may only be `true`, requires `budget.tokens`, and enables continuation notices. Pass `false` for an intentionally ephemeral workflow with no mission for it or its children and no `state` global. Explicit mission persistence failures are strict. |
| `handoffPath` | string | - | Aggregate handoff manifest for `action: "worktree.discard"` or lane evidence actions, or optional explicit metadata for `action: "worktree.cleanup"`. |
| `repo` | string | runtime cwd | Repository path for `action: "worktree.cleanup"`; plan mode only. The configured worktree base filters candidates by their per-project folder under it but never discovers them. |
| `planId` | string | - | Reserved for a future `worktree.cleanup` apply action; rejected by the current plan-only action. |
| `mode` | `steer \| follow_up \| auto \| plan \| apply` | - | Delivery mode for `action: "steer"`; `worktree.cleanup` currently accepts `plan` only. Apply/removal is reserved for a later change. |
| `laneId` | string | - | Exact `runId` stored in the handoff manifest for `lane.status`, `lane.recordMerge`, or `lane.recordSupersession`. |
| `merge` | object | - | Attested merge evidence for `lane.recordMerge`; requires a positive PR number, full reviewed/merge SHAs, tree-equivalence and post-merge-check statuses, attestor, and timestamp. |
| `supersession` | object | - | Attested replacement-lane evidence for `lane.recordSupersession`; requires a different replacement lane id, attestor, and timestamp. |
| `focus` | boolean | false | Focus the newly split pane for `action: "inspector.open"` or `action: "project.open"`; not a standalone action. Panes open in the background unless you set `focus: true`. Existing saved project panes can be focused through the public project-pane API when Herdr reports a tab or workspace id. |
| `view` | `fleet \| transcript` | - | Optional `status` view for the active fleet surface or transcript tail inspection. |
| `lines` | number | `80` | Maximum transcript lines for `action: "status", view: "transcript"`; capped at 500. |
| `agentScope` | `user \| project \| both` | `both` | Agent discovery scope. Project wins on collisions. |
| `capabilities` | boolean | `false` | With `action: "list"`, return compact prompt-free rows and `details.agentCapabilities` machine-readable records for each agent's declared/default routing capabilities. External CLI rows also include their command and passive local availability. |
| `async` | boolean | default-on | Background execution. Workflows default to background. `async:false` blocks the parent until completion and runs the child as a session inside the parent Pi process; such foreground children never load the parent's ambient extensions, so agents that need MCP tools (`mcpDirectTools`, or MCP tools from an ambient adapter such as pi-mcp-adapter) or models from a provider extension must run as background children, which load them inside the detached runner process. |
| `chatProgress` | `auto \| off \| live-card` | `auto` | WorkflowScript chat projection. `auto` renders a live in-chat card only for watched foreground workflows in the same Git repository, including managed worktrees; it is off otherwise. Explicit `live-card` requires `async:false` and the same Git repository. Async workflows have no inline live card, so omit `chatProgress` or use `auto`/`off`; use `async:false` only when the parent must block. |
| `isolation` | `none \| worktree` | - | Workflow child isolation. `none` runs in the shared cwd and does not need Git. `worktree` requires a managed Git worktree. Do not combine it with a contradictory `worktree` value. |
| `baseRef` | string | `HEAD` | `HEAD` or a supported named ref such as `refs/heads/release`, `refs/tags/v1`, or `origin/main`. Full 40/64-character commit IDs and revision expressions such as `HEAD~1` are unsupported. The ref must resolve to a commit at worktree allocation; omitted values default to `HEAD` resolved at that time. Source-checkout cleanliness is still checked. For workflowScript, set it on the outer request as a default or on an individual `runs.run`/`runs.all` child to override it. |
| `timeoutMs` / `maxRuntimeMs` | number | config `timeoutMs`, else 30 min foreground / single-agent async | Optional run-level max runtime in milliseconds. When omitted, the global [`timeoutMs`](configuration.md#timeoutms) config provides the default; absent that, foreground and plain single-agent async runs fall back to 30 minutes, while composite async runs (chains, parallel tasks, workflows) stay unbounded at the top level. Expiration of this run-level deadline is terminal and does not trigger `fallbackModels`. |
| `toolTimeoutMs` | number | fast-tool default | Optional positive hard per-tool-call deadline in milliseconds. Precedence: call value → agent frontmatter → config → `PI_SUBAGENT_TOOL_TIMEOUT_MS`. The timer starts on `tool_execution_start`, clears on the matching `tool_execution_end`, and terminates the run with `timedOut: true` if the tool remains open. When omitted, known-fast built-in tools get a five-minute default; long-running tools get attention notices but no hard default. It never extends the run deadline; `contact_supervisor`, `intercom`, and `bg_wait` are exempt. |
| `toolBudget` | object | none | Optional child tool-call budget `{ soft?, hard, block? }`. At `soft` the child is nudged to finalize. After `hard`, configured tools are blocked; `block` defaults to `read`, `grep`, `find`, and `ls`, while `"*"` blocks every tool call. Final assistant text is never blocked. |
| `usageBudget` | object | none | Optional root-only reported-usage budget `{ tokens?: { soft?, hard }, costUsd?: { soft?, hard } }`. Soft limits are status-only. Hard limits prevent later child launches after reported usage is reconciled; already-running children are not stopped and no reservations are made. |
| `cwd` | string | runtime cwd | Override working directory. |
| `maxOutput` | object | 200KB, 5000 lines | Final output truncation limits. |
| `artifacts` | boolean | true | Write debug artifacts. |
| `includeProgress` | boolean | false | Include full progress in result. |
| `share` | boolean | false | Upload session export to GitHub Gist. |
| `sessionDir` | string | derived | Override session log directory. |
| `acceptance` | string/object/false | inferred | Configure evidence gates. See [Acceptance gates](#acceptance-gates). |
| `gate` | string | - | One host-run verification command, shorthand for `acceptance: { level: "verified", verify: [{ id: "gate", command }] }`. Also valid on individual `runs.run`/`runs.all` items. Rejects `acceptance` except `false` (treated as omitted), and rejects retained `resume`. |

### Budget guidance for writers

As a conservative orchestration policy, do not set a hard `toolBudget` or tight `usageBudget` on implementation workers, fix workers, reviewers with edit authority, or other mutation-capable children. A default tool budget blocks read/search tools rather than mutation tools, and reported usage has no reservation model, so neither tool-call counts nor token/cost totals measure whether a delivery slice is buildable or safe to hand off. Hard caps remain appropriate for explicitly read-only scouts, reviewers, and validators.

Bound writer work with a narrow task and an outer `timeoutMs` or `maxRuntimeMs` that leaves enough margin for the slice. An elapsed timeout is not a mutation-safe boundary and may still signal a child during tool work. Before the deadline, use `steer` or an attention notice to request a checkpoint after the current tool returns, including changed files, build/test state, remaining work, and commit or PR state.

### Fork context details

Explicit `context: "fork"` fails fast when the parent session is not persisted, the current leaf is missing, or the branched child session cannot be created. By contrast, global `defaultSubagentContext: "fork"` and agent-level `defaultContext: fork` are preferences: when the parent has no persisted session file or current leaf yet, the launch uses `fresh` immediately instead of failing and requiring a retry. Global `defaultSubagentContext: "fresh"` starts fresh. Explicit `context: "fresh"` always wins over both preferences.

When the inherited transcript contains signed Anthropic `thinking` / `redacted_thinking` blocks, `pi-subagents` strips those provider-private blocks from the forked child session. It forces thinking `off` only when the child's effective primary or fallback model resolves through the model registry to the Anthropic provider or `anthropic-messages` API; unresolved models are treated conservatively. The result reports every affected child, including on failed runs. Use `context: "fresh"` when an Anthropic child needs thinking. Explicit `context: "fork"` never silently downgrades to `fresh`.

In workflow runs that omit `context`, each `runs.run` child follows the global `defaultSubagentContext` when set, then its own `defaultContext`. Without the global setting, a fresh-default scout can run fresh beside a fork-default worker. If the parent session file or current leaf is not available yet, implicit fork-default children run fresh. Pass explicit `context: "fork"` or `context: "fresh"` when you intentionally want one context for every child.

### Workflow steering

`runs.steer(key, message, options?)` targets a stable key already launched by `runs.run` or `runs.all`. It does not accept a raw run id. Options are `mode?: "steer" | "follow_up" | "auto"`, `index?: number`, and `ackTimeoutMs?: number`. The promise returns `{ key, state, requestId?, deliveryStatus?, targets?, error? }`, where `state` is `queued`, `delivered`, `missed`, or `failed`.

The workflow trace records the attempt and receipt. Always await, return, or include the promise in an awaited standard Promise combinator. Unawaited steering calls reject workflow completion after the side effect settles. `Promise.race` remains the rolling primitive. Foreground children are steered through their in-process session (`steer` and `auto` interrupt at the next safe point and report `delivered`; `follow_up` queues until the run settles and reports `queued`). Async children use the file control inbox. Steering recovery is disabled in both cases.

For advanced rolling fanout, keep the launched `runs.run` promises in ordinary JavaScript data only when every promise is later observed with direct `await`, `Promise.race`, or `Promise.all`. `Promise.race` gives the next completed child, `runs.steer` can challenge a still-running keyed sibling, and `Promise.all` collects the rest. No separate `runs.start`, `runs.next`, or `runs.collect` API is exposed.

```js
{ workflowScript: `
  let pending = [
    { key: "writer", promise: runs.run("writer", { agent: "worker", task: "Draft the fix" }).then((result) => ({ key: "writer", result })) },
    { key: "reviewer", promise: runs.run("reviewer", { agent: "reviewer", task: "Review likely risks" }).then((result) => ({ key: "reviewer", result })) }
  ];
  const first = await Promise.race(pending.map((child) => child.promise));
  pending = pending.filter((child) => child.key !== first.key);
  const target = pending[0];
  const receipt = await runs.steer(target.key, "Use this early review:\n" + first.result.output, { mode: "auto" });
  const rest = await Promise.all(pending.map((child) => child.promise));
  return { first: first.key, rest: rest.map((child) => child.key), receipt };
` }
```

### Output mode details

Use `outputMode: "file-only"` when a saved output may be large and the parent only needs a pointer. The returned text is a compact reference like `Output saved to: /abs/report.md (48.2 KB, 2847 lines). Read this file if needed.` Failed runs and save errors still return normal inline output for debugging.

In workflowScript, give each child an explicit output path when later script steps need a durable file reference. A child with only read-only tools does not need direct filesystem access for `output`: it returns the complete artifact in its final response and the runtime persists it. Children with mutation-capable tools retain the direct-write instruction.

The `output` field is the API binding; a filename mentioned in task text (for example, `Write your findings to exactly this path: report.md`) is only instruction and does not override runtime routing. When a later workflow step or parent needs a durable file, set `output` on `runs.run`/`runs.all` and return the child’s `outputReference`, `outputPathMapping`, or `artifactPaths`; arbitrary literal strings returned by workflow JavaScript are not rewritten. Omitted child output may use a managed aggregate-derived sibling path.

Workflows get `await state.get(key)` and `await state.set(key, value)` through their default or explicit mission. Use them to share durable JSON values across later workflows attached with the same `missionId`. Each `set` takes the state-file lock and merges its key with the latest on-disk state. Missing keys return `undefined`, and the complete state file has a strict 256 KiB limit. `mission:false` workflows have no `state` global.

### Retained children

Completed workflow children from the current parent session stay addressable as retained children. `{ action: "children.list" }` lists up to the last 10 with their run ids and explicit `resumable` or `not resumable` state. Resume only rows reported `resumable`; if no row is resumable, start a same-role fallback challenge and label it as fallback. A later workflow continues a resumable child by passing `resume` instead of `agent`:

```js
{ workflowScript: `
  let writer = await runs.run("implement", { agent: "worker", task: "Implement the accepted contract" });
  for (const pass of [1, 2]) {
    if (!writer.runId) throw new Error("writer did not return a retained run id");
    writer = await runs.run("followup-" + pass, { resume: writer.runId, task: "Revisit pass " + pass + ": " + writer.output });
  }
  return writer;
` }
```

Each workflow key identifies one result lane. Use a new stable workflow key for every distinct retained resume pass; same-key calls are reused only when launch parameters are identical, and incompatible parameters are rejected.

Inside `workflowScript`, `await runs.run(key, { resume, task })` waits for the revived child to finish and returns its completed output and new `runId`. Each resume can return a new retained run id, so loops must continue from the latest returned `runId`. Top-level `{ action: "resume" }` remains detached and returns a background-run receipt.

For a simple implementation challenge outside a workflow script, send the challenge through `subagent({ action: "resume", id: "<retained-writer-run>", message: "Reconsider the implementation and make any better current-scope change." })` only when `children.list` reports that retained writer as `resumable`. If no retained writer is resumable, start a same-role fallback challenge and record why it is a fallback. Use workflow `runs.run({ resume })` only when the script must await the revived writer output before the next step. Do not use `steer` as the sole challenge action for a completed retained child; `steer` with `mode: "follow_up"` only queues text for the next `resume`.

`resume` and `agent` are mutually exclusive. The revived child keeps its stored agent, model, and tool contract. `gate` is rejected on retained resume items because resume uses the retained child contract.

## Management actions

### Guide

`{ action: "guide" }` reads the packaged `README.md` from the installed version. Pass `topic` to read its packaged `docs/<topic>.md` file instead. Valid topics are `overview`, `workflows`, `agents`, `missions`, `observability`, `tool-reference`, `configuration`, `models`, `watchdog`, and `extension-api`. Unknown topics list the valid values and do not change files. Use `/subagents-guide [topic]` for the slash equivalent.

Agent definitions are not loaded into context by default. Management actions let the LLM discover, inspect, create, update, and delete agents at runtime. An unknown action returns safe next steps (`status` and `list`) and may suggest a close non-destructive action. Destructive actions are only named for a near-complete one-character typo, and suggestions never execute an action.

```ts
{ action: "list" }
{ action: "list", agentScope: "project" }
{ action: "list", capabilities: true }
{ action: "get", agent: "scout" }
{ action: "models" }
{ action: "models", agent: "reviewer" }
{ action: "get", agent: "code-analysis.scout" }

{ action: "create", config: {
  name: "Code Scout",
  package: "code-analysis",
  description: "Scans codebases for patterns and issues",
  scope: "user",
  systemPrompt: "You are a code scout...",
  systemPromptMode: "replace",
  inheritProjectContext: false,
  inheritGlobalContext: false,
  inheritSkills: false,
  model: "anthropic/claude-sonnet-4",
  fallbackModels: ["openai-codex/gpt-5.6-luna:low", "anthropic/claude-haiku-4-5"],
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


{ action: "update", agent: "code-analysis.scout", config: { model: "openai/gpt-4o" } }
{ action: "update", agent: "code-analysis.scout", config: { acceptance: "" } } // clear the frontmatter default
{ action: "update", agent: "code-analysis.scout", config: { acceptanceRole: false } } // restore inferred name fallback
{ action: "delete", agent: "scout" }

{ action: "eject", agent: "reviewer" }
{ action: "eject", agent: "reviewer", agentScope: "project" }
{ action: "disable", agent: "reviewer" }
{ action: "enable", agent: "reviewer", agentScope: "project" }
{ action: "reset", agent: "reviewer" }
```

Rules:

- `capabilities: true` changes `action: "list"` to compact one-line rows and adds `details.agentCapabilities: { agents, restrictedCount, capabilityCeilingSources? }`. Each agent row includes source, aliases, runner type/capabilities, tools, MCP direct tools, mutation tools, model/thinking/fallbacks, default async/timeout, output path/mode, skills/extensions, and whether the current capability ceiling allows execution. External CLI rows include `runner.command`, `runner.available`, and a bounded `runner.unavailableReason` when passive PATH/PATHEXT/X_OK lookup cannot find the command. It never includes an agent's system prompt. Rows show declared/default capabilities and command discoverability, not authentication, version compatibility, or successful launch; launch preflight remains authoritative.
- `create` uses `config.scope`, not `agentScope`.
- `config.name` is the local frontmatter name; optional `config.package` registers the runtime name as `{package}.{name}` and is saved as separate `name` and `package` frontmatter.
- `config.aliases` accepts a comma-separated string, string array, or `false` to clear aliases. Aliases resolve to the canonical agent name for execution and are shown by `list`/`get`.
- `update` and `delete` use the runtime name and `agentScope` only when the same runtime name exists in multiple scopes.
- To clear optional string fields, including `package`, set them to `false` or `""`.

`eject`, `disable`, `enable`, and `reset` are described in [agents.md](agents.md#overriding-builtins).

### Refinement overlays

`refine`, `refine.show`, and `refine.rollback` manage project-local refinement overlays for one agent. `/subagents-refine <agent>` is the slash equivalent of `refine`. See [agents.md](agents.md#refinement-overlays) for behavior and storage.

## Lane merge evidence and cleanup eligibility

Lane evidence actions update an existing parallel handoff manifest at an explicit update boundary. They do not verify GitHub state, run Git commands, or remove worktrees. Pass the manifest path and its exact `runId` as `laneId`:

```ts
subagent({
  action: "lane.recordMerge",
  laneId: "<manifest-run-id>",
  handoffPath: "/path/to/handoff.json",
  merge: {
    prNumber: 123,
    reviewedHead: "<40-character-sha>",
    mergeCommit: "<40-character-sha>",
    treeEquivalent: true,
    postMergeChecks: "recorded",
    attestedBy: "operator",
    attestedAt: "2026-08-27T16:23:00.000Z"
  }
})
subagent({
  action: "lane.recordSupersession",
  laneId: "<manifest-run-id>",
  handoffPath: "/path/to/handoff.json",
  supersession: {
    supersededBy: "<replacement-lane-id>",
    attestedBy: "operator",
    attestedAt: "2026-08-27T16:23:00.000Z"
  }
})
subagent({ action: "lane.status", laneId: "<manifest-run-id>", handoffPath: "/path/to/handoff.json" })
```

The manifest stores one of these fail-closed eligibility states: `active` (an owning child is still running), `terminal-eligible` (complete merge evidence and recorded post-merge checks), `terminal-blocked` with a reason, `superseded-eligible` (an explicit replacement attestation), or `unknown` (missing or malformed evidence/manifest). Each attestation stores a digest of the manifest facts it covered; later group, worktree, or patch changes downgrade that evidence to `terminal-blocked` until it is recorded again. A terminal update recomputes a previously stored `active` state from the current child statuses and evidence. Conflicting reviewed heads and mismatched lane ids are rejected as stale. Existing workflow receipts remain immutable.

`lane.status` renders the stored state and a copy-pasteable `worktree.cleanup` plan invocation. It never runs that invocation. All cleanup planning/apply and apply-time Git/ownership revalidation belong to `worktree.cleanup` from #1622; remote branch deletion and extension-side GitHub verification remain out of scope.

## Status and control actions

### Failed lane recovery and execution-mode boundaries

A failure in the subagent workflow, child launch, prompt runtime, extension loading, or child tooling setup is a lane infrastructure blocker, not permission to silently change execution mode. Stop and report the exact failure, run/status, and repo/cwd/worktree/branch/ref state. Before a same-protocol retry or asking the owner, verify the worktree is clean or capture the partial diff. Retry or fix the `subagent` path only through a clear same-protocol action.

For backlog lanes and other subagent-governed workflows, external/foreground/CLI fallback requires explicit owner approval. Do not silently switch to `interactive_shell`, `pi -ne`, Codex/Claude/Cursor CLI, a foreground agent, or another external mode. `interactive_shell` remains valid when the user explicitly requests visible foreground/CLI work or the task is outside the governed subagent protocol. Pi core may print a generic `pi -ne` extension-load hint; that out-of-repo hint is not protocol-approved fallback. Configured native model/provider fallback remains governed by its own contract.

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
- Completed external-job runs can use the same `resume` action as a provider follow-up when the registered provider exposes `followUp(input)`. Running external-job parents fail closed with guidance to wait for completion. Unsupported providers fail with an update/reload message.
- Revive starts a new child session from the old session context; it does not resume the live session, and it requires the chosen child to have a persisted `.jsonl` session file.
- Direct revival takes an exclusive cross-process lease on the canonical session file until the new child finishes. A concurrent attempt fails before Pi is spawned and identifies the owning revived run; dead-owner leases are reclaimed only when staleness can be proved.

### stop

`stop` ends a current-session top-level async run. It is deliberately stronger than `interrupt`:

- It is not a resumable pause; stopped runs should be restarted as new runs.
- Foreground and nested targets are rejected.
- Direct id calls execute immediately.
- `/subagents-stop` without an id opens a selector with confirmation when a TUI is available. Use `↑`/`↓` or `j`/`k` to move through the selector.
- In non-TUI contexts the slash command prints exact `subagent({ action: "stop", id })` and `/subagents-stop <id>` commands.
- Pass a child id to stop one child of a multi-child async run or workflow while the rest continue: `/subagents-stop <run-id> <child-id>` (equivalent to `subagent({ action: "stop", id, childId })`). Child ids come from status output, the async status snapshot, or `/subagents-inspect-rpc` replies. Only pending or running children are stoppable; the request is rejected for anything else instead of widening to a run-level stop.
- Inactive schedules can appear in the selector, but they are labeled as schedules and route through `schedule.pause`, not `stop`.

### steer

`steer` waits up to three seconds for a correlated child-Pi input acceptance and returns a request id with `delivered`, `scheduled`, `pending`, `partial`, `recovered`, or `failed` plus per-child states. The receipt also has `deliveryStatus: "delivered" | "queued"`. Delivery means Pi accepted the user message, not model compliance. A pending indexed child returns `scheduled`.

The optional `mode` is `steer` by default and keeps the current interrupt behavior. `follow_up` waits for the next turn boundary. `auto` queues during an active turn and delivers immediately between turns. The bounded FIFO holds 20 messages and returns a clear error when full. Terminal details report queued messages that the run did not deliver. A `follow_up` sent to a completed retained workflow child becomes the first brief for its next `resume`; it does not revive the child by itself.

Only a top-level single run may interrupt after the acknowledgment deadline and recover after a further 15-second pause/revival bound; durable multi-child and nested runs never auto-interrupt. Recovery launches a replacement only after the source is confirmed paused, a valid persisted session exists, and deadline, turn, and tool budgets remain. It preserves the original child contract and remaining limits; otherwise the source stays paused with an explicit failure. Late acceptance is recorded but cannot cancel committed recovery.

The persisted `steering` ledger retains 20 requests and replaces the old `steerCount`/`lastSteerAt` fields.

The `/subagents-steer <run-id> [--child <child-id>] <message>` slash command is the host bridge for non-TUI sessions and RPC hosts. `--child` accepts the stable child identity shown in status output and inspect replies (workflow key, child run id, or `step:<index>`) and resolves it to the child index before steering; unknown or ambiguous child ids fail closed. Flags are parsed only between the run id and the message tail — once the message starts, `--` tokens are message text. The bridge always disables pause-and-revive recovery (`steeringRecovery: false`), matching the extension RPC `nonRecoveringSteer` guarantee so the caller keeps authority over the exact child it addressed.

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

`gate` normalizes to verified acceptance with that single command, so the runtime executes it on the host and records the result as evidence. Verification results are memoized per tracked workspace state and effective environment, so an unchanged tree does not rerun the same command. Use explicit `acceptance.verify` when you need multiple commands, timeouts, or custom criteria. `gate` rejects `acceptance` except `false` (treated as omitted), and rejects retained `resume` items. With `worktree: true`, the gate runs inside the child's managed worktree.

### Levels and inference

Acceptance evidence levels are `auto`, `none`, `attested`, `checked`, and `verified`. `acceptance: "auto"` is the default.

Review is a separate gate configured with `acceptance.review`:

- Async, risky, and dynamic writer contexts infer checked evidence plus `review: { agent: "reviewer", required: true }`.
- Reviewer/read-only calls infer no acceptance by default; explicit acceptance requests still apply.
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

For `attested` or stricter levels, the child prompt includes a standardized acceptance section and asks for a fenced `acceptance-report` JSON block. Reviewer/read-only inference resolves to `none`, so it does not add this section; explicit acceptance still does. With `outputSchema`, set `acceptance.report: "on"` to require the same report in the final `structured_output` call, or `"off"` to keep the fenced-report path. Omitting `report` preserves the default behavior. Runs without `outputSchema` never gain a standalone structured-output tool from this option.

The parser canonicalizes known enum synonyms, snake_case report keys and wrappers, underscore fence tags, unambiguous scalar arrays, string booleans, and criterion-id separators. Unknown or ambiguous keys and enum values fail with field-level diagnostics. Explicit empty `changedFiles` and `testsAddedOrUpdated` arrays are recorded as not applicable; missing fields and empty required command or validation evidence still fail.

Acceptance fences are removed from normal output artifacts, while the raw child transcript remains intact and per-child metadata stores the complete acceptance ledger and parsed report. Explicit failed gates fail the run. Inferred gates remain observable without failing the run.

## Herdr project panes

Herdr project panes are peer Pi sessions opened by this Pi session:

```ts
subagent({ action: "project.open", cwd: "/path/to/repo", message: "Start in this project." })
subagent({ action: "project.status", cwd: "/path/to/repo" })
subagent({ action: "project.close", cwd: "/path/to/repo" })
```

The saved pane binding is pane-level only. The parent can refresh status, focus the saved pane when Herdr reports a tab or workspace id, or close it after Herdr verifies ownership and `agent_status: "idle"`. It cannot inspect, steer, or stop subagents inside that peer session. Stale or opaque Herdr metadata stays unknown and fails closed.

Inline status counts active current-session work and Herdr project panes. Use Herdr itself or the project-pane API to focus or close project panes.

## Orca progress tabs (experimental observer)

Orca progress tabs are a global, opt-in observer, not an agent runner. Enable them in the extension config:

```json
{ "orcaProgressTabs": { "enabled": true } }
```

Foreground and background children keep running through their normal native Pi or `external-cli` path. For each top-level subagent call, the observer asks Orca to create one background terminal tab in the owning worktree and mirrors progress into it. Parallel and chain children share that tab and are separated by child headers. Titles receive a persistent worktree-local sequence number, including across separate workflow calls. Creates for the same worktree are serialized in that sequence so tabs appear to the right in order (`1`, then `2`, then `3`) instead of racing. Model/startup retries reuse the same observer. Attaching an already-running async root does not create a duplicate child tab. Terminal control sequences are removed at the viewer sink across read boundaries. Each mirror is capped at 1 MiB and truncates when the cap or stream backpressure is reached. After the run finishes, its viewer returns to the terminal shell instead of ending the terminal session, so the tab and scrollback remain until the user closes them. Successful native Pi runs with a known session append a safely quoted removal command for the exact verified session path; unsuccessful and sessionless runs append only their terminal status.

The observer supports macOS and Linux and is disabled on Windows. It requires executable `orca` on `PATH` (or `PI_SUBAGENT_ORCA_BINARY`) and a running Orca runtime that recognizes the cwd. Availability and tab creation are best-effort: failures never fail, stop, or delay the subagent. When possible, the observer writes a passive manifest under `<worktree>/.pi/subagents/views/orca/`; the manifest is display metadata only, not a lifecycle or control source. Set `orcaProgressTabs.enabled` to `false` to guarantee that no Orca command or tab is created.

Agent profile `runner.type` supports native Pi (the default), `external-cli`, and `external-job`. Orca is intentionally not a profile runner and does not own subagent execution, completion, cancellation, artifacts, or result delivery. External-job providers can optionally expose `followUp(input)` so a completed provider job can continue its parent conversation through `subagent({ action: "resume", id: "<run>", message: "..." })`.

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

Intentionally unsupported: native Pi child options such as model override, structured output, acceptance/agent contract, tool budgets, fast mode, fork context, skills, or native Pi tools unless the runner explicitly implements them. Foreground/clarify, steer/resume/interrupt-as-pause, nested subagents, and fallback models are also unsupported.

## Session sharing

Pass `share: true` to export a full session to HTML, upload it to a secret GitHub Gist through your `gh` credentials, and return a `https://shittycodingagent.ai/session/?<gistId>` URL.

```ts
{ workflowScript: `return runs.run("main", { agent: "scout", task: "..." })`, share: true }
```

This is disabled by default. Session data may contain source code, paths, environment variables, credentials, or other sensitive output. You need `gh` installed and authenticated.
