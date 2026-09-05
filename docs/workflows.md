# Workflows and orchestration

How to compose subagents: the recommended pattern, packaged prompt shortcuts, scripted workflows, direct commands, worktree isolation, and child-to-parent coordination.

## Recommended orchestration pattern

Use orchestration as parent-agent guidance, not as a runtime workflow mode. For implementation work, the recommended loop is:

```text
clarify → scout → worker → fresh reviewers → worker
```

Packaged `worker`, `oracle`, and `advisor` default to forked context when a launch omits `context`. If the parent has no persisted session file or current leaf yet, that implicit default falls back to `fresh`. Pass `context: "fresh"` when you intentionally want a fresh child run, or `context: "fork"` when fork must remain strict.

Child-safety boundaries are enforced at runtime:

- Child sessions do not receive the bundled `pi-subagents` skill.
- Forked child context filtering removes parent-only subagent artifacts (including old hidden orchestration-instruction messages, slash/status/control messages, and prior parent `subagent` tool-call/tool-result history) while preserving ordinary prose and unrelated tool calls/results.
- By default, children do not register the `subagent` tool and receive boundary instructions that they are not the parent orchestrator and must not propose or run subagents.
- The explicit exception is an agent whose resolved builtin `tools` includes `subagent`; that child gets a child-safe `subagent` tool for the fanout work the parent assigned, still bounded by `maxSubagentDepth`.

### Failed lane recovery and execution-mode boundaries

A failure in the subagent workflow, child launch, prompt runtime, extension loading, or child tooling setup is a lane infrastructure blocker. It is not permission to silently retry through `interactive_shell`, `pi -ne`, Codex/Claude/Cursor CLI, a foreground agent, or another external execution mode.

Stop and report the exact failure, run/status, and repository/cwd/worktree/branch/ref state. Before a same-protocol retry or asking the owner, verify the worktree is clean or capture the partial diff. Retry or fix the `subagent` path only through a clear same-protocol action. For backlog lanes and other subagent-governed workflows, external/foreground/CLI fallback requires explicit owner approval. `interactive_shell` remains valid when the user explicitly requests visible foreground/CLI work or the task is outside the governed subagent protocol.

Pi core may print a generic `pi -ne` extension-load hint; that out-of-repo hint is not protocol-approved fallback. Configured native model/provider fallback remains governed by its own contract and does not authorize an execution-mode switch.

## Prompt shortcuts

The package includes reusable prompt templates for common workflows. You do not need them, but they are handy when you want the same shape every time:

| Prompt | Use it for |
|--------|------------|
| `/parallel-review` | Launch fresh-context reviewers with distinct angles, then synthesize what to fix. |
| `/review-loop` | Run parent-controlled worker, reviewer, and fix-worker cycles until clean or capped. |
| `/parallel-research` | Combine `researcher` and `scout` for external evidence, local code context, and practical tradeoffs. |
| `/gather-context-and-clarify` | Scout/research first, then ask the user the clarification questions that matter. |
| `/parallel-cleanup` | Run review-only cleanup passes after implementation. |

Add `autofix` to `/parallel-review` or `/parallel-cleanup` to apply only the synthesized fixes worth doing now after reviewers return.

## Scripted workflows (workflowScript)

Use direct `{ agent, task }` for one bounded child. Use `workflowScript` when the parent needs a stable keyed child, sequence, fanout, steering, retry, or aggregation. For ordinary parallel fanout, use `await runs.all([{ key, agent, task }, ...])`. It resolves to an ordered array, not a key map, so use indexes, destructuring, or `.map(...)`, not `results.<key>`. Do not read `.output` from unawaited `runs.run` launches. Store a `runs.run` promise only when the script later observes it with `await`, `Promise.race`, or `Promise.all`, such as steering a live child before awaiting its result. Scripts are ordinary JavaScript statement bodies. Use an explicit `return` for a useful result:

Child results cross into the script as plain JSON data. Non-JSON host metadata is omitted, so use returned fields such as `runId`, `ok`, `output`, and `structuredOutput` for workflow control.

Validate a script without launching children:

```js
subagent({ action: "validate", workflowScript: `
  const results = await runs.all([{ key: "scan", agent: "scout", task: "Scan" }]);
  return results[0].output;
` });
```

For a script stored in a file, use `workflowScriptPath` instead of `workflowScript`:

```js
subagent({ workflowScriptPath: "workflows/review.js", cwd: "/path/to/project" });
subagent({ action: "validate", workflowScriptPath: "workflows/review.js" });
```

The fields are mutually exclusive. Relative paths resolve against the request `cwd`; absolute paths pass through. The host reads the file before validation, schedule creation, or workflow sandbox execution. The sandbox still has no filesystem access. Missing, unreadable, and empty files return file input errors instead of script syntax errors.

### Named workflow resources for permission extensions

Use a named workflow resource when a permission or policy extension needs to distinguish extension-resolved workflow content from raw model-authored scripts:

```js
subagent({ workflow: "review", args: { task: "Review the change" } });
subagent({ workflow: "run-ci", args: { command: "npm test" } });
```

The host resolves the name and validates bounded plain-JSON `args` before starting the workflow. Resource provenance is recorded in workflow details and receipts for downstream permission/policy checks. Resource authority is not caller-supplied: `runs.host` is available only when the resolved resource explicitly grants the requested host key and command. Inline `workflowScript` and `workflowScriptPath` remain raw, unknown-provenance inputs, so their `runs.host` calls are unavailable through the public execution boundary. Named resources cannot be combined with `agent`, `task`, `workflowScript`, or `workflowScriptPath`; this first slice ships only the package-owned `review` and `run-ci` resources, not a user/project resource registry.

### Opt-in bounded workflows

Composite workflows have no default parent deadline. Add bounds only when the workflow contract calls for them:

```js
subagent({
  workflowScript: `
    const scan = await runs.run("scan", { agent: "scout", task: "Inspect the named files." });
    return runs.run("review", { agent: "reviewer", task: "Review:\n" + scan.output });
  `,
  timeoutMs: 900000,
  toolBudget: { soft: 40, hard: 60 },
  usageBudget: { tokens: { soft: 100000, hard: 150000 } }
});
```

- `timeoutMs` sets the workflow deadline and bounds child deadlines to the remaining time.
- `toolBudget` becomes the default for each child unless that child supplies a narrower value.
- `usageBudget` accounts for reported usage across completed workflow children. Once exhausted, it rejects later child launches but does not stop children that are already running.
- Budget and timeout stops return a structured `terminalOutcome` with `state: "partial"` and reason `budget_exhausted` or `timeout`. Workflow receipts keep settled child evidence for recovery.
- After an async workflow receipt is successfully published, `workflowReceiptPath` exposes its exact path in wait completion details, completion notifications, and exact status/debug details. Text responses also identify the receipt. Pending runs and failed receipt publications omit the reference; older status records are not backfilled. The reference records publication, not a guarantee against later retention cleanup. Raw result files retain `workflowReceipt: { path, receipt }`.

These controls are opt-in. Avoid tight hard budgets for mutation-capable workers unless the workflow has an explicit checkpoint and handoff path.

The result is `{ ok, errors }`. Invalid scripts return a tool error and include line and column data when available. Validation checks syntax, portable nested-async rules, literal `runs.run` and `runs.all` keys and child `baseRef` values, duplicate literal keys in one `runs.all` group, direct keyed access to a known `runs.all` result, and statically clear non-JSON boundary values. Dynamic keys and other runtime-only values are accepted without a warning. Validation does not discover agents, launch children, or create run artifacts.

```js
subagent({ workflowScript: `
  const scan = await runs.run("scan", { agent: "scout", task: "Scan the codebase" });
  const reviews = await runs.all([
    { key: "correctness", agent: "reviewer", task: "Review correctness: " + scan.output },
    { key: "tests", agent: "reviewer", task: "Review tests: " + scan.output }
  ]);
  return reviews.map(result => result.output);
` });
```

Keep helper functions portable across Node and Bun. Use top-level `await`, plain helper functions that return `runs.run(...)`, or explicit Promise chains. Do not define nested `async function` helpers, async arrows, or async methods inside `workflowScript`; native async helpers hide child-launch observation in Bun and are rejected.

```js
subagent({ workflowScript: `
  function scan() {
    return runs.run("scan", { agent: "scout", task: "Scan the codebase" });
  }
  const result = await scan();
  return result.output;
` });
```

Chaining is still supported. The supported form is scripted chaining: await one `runs.run(...)` result, then pass its output into the next step. Parallel fanout uses `runs.all(...)` inside the same script.

```js
subagent({ workflowScript: `
  const plan = await runs.run("plan", { agent: "scout", task: "Plan the migration" });
  const patch = await runs.run("patch", { agent: "worker", task: "Implement this plan:\n" + plan.output });
  return patch.output;
` });
```

### Parallel sequential lanes

For a bounded set of independent chains, `runs.lanes(...)` removes the mechanical loop that would otherwise connect each lane's stages. It is a helper inside `workflowScript`, not a new top-level `subagent` execution mode:

```js
subagent({ workflowScript: `
  const board = await runs.lanes([
    {
      key: "api",
      stages: [
        { key: "writer", agent: "worker", task: "Implement the API change" },
        { key: "challenge", resume: "previous", task: "Challenge the API implementation" },
        { key: "review", agent: "reviewer", task: "Review the API lane" }
      ]
    },
    {
      key: "ui",
      stages: [
        { key: "writer", agent: "worker", task: "Implement the UI change" },
        { key: "review", agent: "reviewer", task: "Review the UI lane" }
      ]
    }
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
` });
```

The first stage from every lane is launched in one existing `runs.all(...)` batch. Later stages in each lane start only after the preceding stage settles. A later stage with `resume: "previous"` requires the preceding child to return a retained `runId`; the helper then uses the existing retained-resume launch checks and does not accept an arbitrary run id. Generated child keys use `<lane>.<stage>`, while the returned board uses the local lane and stage keys.

The helper validates the complete plain-JSON lane inventory before launching anything. It bounds the inventory to 32 lanes, 16 stages per lane, 64 total stages, and 64 KiB of canonical JSON; task and path fields retain the existing 1 MiB and 32 KiB limits. Stage keys must be unique within a lane and generated keys must be unique and valid workflow keys. A child failure, stopped/detached result, or explicit `structuredOutput.verdict === "blocked"` blocks only that lane; later stages are marked `skipped` and sibling lanes continue. Reviewer prose is never parsed.

The board is bounded and contains only lane/stage keys, state, success, retained run ids, explicit output references, bounded errors, and an optional structured verdict. It does not return child transcripts or create a lane registry or cleanup authority. Use raw `runs.run(...)`/`runs.all(...)` when a workflow needs conditional or rolling orchestration beyond this helper.

### Host command steps

Use the named `run-ci` resource when a permission/policy extension needs to admit one supported non-interactive command as workflow evidence instead of a child-agent run:

```js
subagent({ workflow: "run-ci", args: { command: "npm test", timeoutMs: 120000 } });
```

The first named resource version supports only `npm test` and `npm run typecheck`, with bounded timeout values. Its resolved script uses `runs.host("ci", ...)` and the resource authority admits only the selected command. **There is no per-step `cwd` field:** the command and relative output path use the workflow cwd. Set `cwd` on the outer `subagent({...})` request when the workflow should run in another directory. The command has no stdin, receives the workflow cwd, and must be awaited or returned. Stdout, stderr, and the saved log are bounded. A nonzero exit, timeout, abort, or output-write failure fails the workflow. Async status and terminal receipts store the bounded host-step state; renderers do not run commands or read command output.

### Steering a workflow child

Use `await runs.steer(key, message, options?)` after `runs.run` or `runs.all` has launched that stable key. Scripts do not target raw run ids. The optional fields are `mode: "steer" | "follow_up" | "auto"`, a non-negative child `index`, and a positive `ackTimeoutMs`.

```js
subagent({ workflowScript: `
  const writer = runs.run("writer", { agent: "worker", task: "Implement the change" });
  const evidence = await runs.run("evidence", { agent: "scout", task: "Find the exact contract" });
  const receipt = await runs.steer("writer", "Also check: " + evidence.output, { mode: "follow_up" });
  return { writer: await writer, receipt };
` });
```

The receipt state is `queued`, `delivered`, `missed`, or `failed`. `delivered` means the child Pi session accepted the input. It does not mean the model followed it. `missed` means the keyed child became terminal or had no live route before delivery. This first slice uses the existing foreground and async steering transports but does not start steering recovery. Workflow traces include one steering attempt entry and one receipt entry.

Always await or return a `runs.steer` promise. The workflow waits for an observed steering side effect to settle before it exits and rejects fire-and-forget calls. Use ordinary `Promise.race` when the first child or steering receipt should advance the script. There is no callback API or child inbox access.

### Advanced rolling child runs

`runs.run` starts a keyed child when you call it. You do not need separate `runs.start`, `runs.next`, or `runs.collect` helpers for rolling councils or staged reviews. This is the advanced exception to ordinary `runs.all` fanout: keep launched promises only when the script later observes each one with direct `await`, `Promise.race`, or `Promise.all`. Use `Promise.race` to wait for the next completed child, steer a still-running sibling by its stable key, and use `Promise.all` to collect the remaining children.

```js
subagent({ workflowScript: `
  let pending = [
    { key: "analysis-a", promise: runs.run("analysis-a", { agent: "reviewer", task: "Analyze option A" }).then((result) => ({ key: "analysis-a", result })) },
    { key: "analysis-b", promise: runs.run("analysis-b", { agent: "reviewer", task: "Analyze option B" }).then((result) => ({ key: "analysis-b", result })) },
    { key: "critic", promise: runs.run("critic", { agent: "reviewer", task: "Find the strongest objection" }).then((result) => ({ key: "critic", result })) }
  ];

  const first = await Promise.race(pending.map((child) => child.promise));
  pending = pending.filter((child) => child.key !== first.key);

  const target = pending.find((child) => child.key === "critic") ?? pending[0];
  const receipt = await runs.steer(target.key, "Challenge this early result:\n" + first.result.output, { mode: "auto" });
  const rest = await Promise.all(pending.map((child) => child.promise));

  return { first: first.result.output, rest: rest.map((child) => child.result.output), receipt };
` });
```

The workflow trace records the run completions and steering receipt. Scripts still never see raw async directories, inbox paths, or session files. If the keyed child is terminal, stale, or has no live route when `runs.steer` runs, the receipt reports `missed` or `failed` and the script can decide whether to continue.

Use named outputs when later workflow steps need structured data or durable references:

```js
subagent({ workflowScript: `
  const inventory = await runs.run("inventory", {
    agent: "scout",
    task: "List the files that need review.",
    outputSchema: {
      type: "object",
      properties: { files: { type: "array", items: { type: "string" } } },
      required: ["files"],
      additionalProperties: false
    }
  });
  return runs.run("review", {
    agent: "reviewer",
    task: "Review these files: " + inventory.structuredOutput.files.join(", ")
  });
` });
```

For dynamic fanout, have one step return a structured list, check it in JavaScript, then map the bounded entries into `runs.all(...)`:

```js
subagent({ workflowScript: `
  const targets = await runs.run("targets", {
    agent: "scout",
    task: "Return up to five source files that need review.",
    outputSchema: {
      type: "object",
      properties: { files: { type: "array", items: { type: "string" }, maxItems: 5 } },
      required: ["files"],
      additionalProperties: false
    }
  });
  const files = targets.structuredOutput.files.slice(0, 5);
  return runs.all(files.map((file, index) => ({
    key: "review-" + index,
    agent: "reviewer",
    task: "Review " + file
  })));
` });
```

For intermediate data that only later steps need, prefer the prior child's returned output or `structuredOutput` instead of writing shared files:

```js
subagent({ workflowScript: `
  const scan = await runs.run("scan", { agent: "scout", task: "Find the files that need fixes." });
  return runs.run("fix", { agent: "worker", task: "Implement these findings:\n" + scan.output });
` });
```

`{chain_dir}` remains available inside scripted workflow step templates for legacy-compatible path templates. It expands to the workflow cwd, not to private temporary storage.

### Migrating old chain shapes

Legacy top-level `chain`, `tasks`, `parallel`, `chainDir`, `/chain`, `/parallel`, `/run-chain`, and durable `.chain.md` execution are no longer the public workflow API. Rewrite them as JavaScript:

```js
// Old shape, no longer supported:
// { chain: [{ agent: "scout", task: "Scan" }, { agent: "worker", task: "Fix from {previous}" }] }

// Current shape:
{ workflowScript: `
  const scan = await runs.run("scan", { agent: "scout", task: "Scan" });
  return runs.run("fix", { agent: "worker", task: "Fix from: " + scan.output });
` }
```

```js
// Old shape, no longer supported:
// { tasks: [{ agent: "reviewer", task: "Review API" }, { agent: "reviewer", task: "Review UI" }] }

// Current shape:
{ workflowScript: `
  return runs.all([
    { key: "api", agent: "reviewer", task: "Review API" },
    { key: "ui", agent: "reviewer", task: "Review UI" }
  ]);
` }
```

For long task text with Markdown fences or shell blocks, use quoted lines instead of a raw template literal:

````js
const task = [
  "Run this command:",
  "```bash",
  "npm test",
  "```"
].join("\n");
return runs.run("test", { agent: "worker", task });
````

A plain workflow creates one enclosing mission by default. Its children do not create separate missions. The result exposes the id as `details.missionId`, and human-readable output ends with `Mission: <id> (<status>)`. Pass `mission:false` for an ephemeral workflow with no mission or durable `state` global.

### Repeatable workflows

Use stable child keys and keep process logic in ordinary JavaScript. `runs.run` launches one child, `runs.all` launches independent children together, and later steps can use each completed child's `output`. Put long task text in arrays joined with `"\n"` so Markdown fences do not conflict with the script string.

For a process you run often, save the task as a prompt template under `.pi/prompts/` or `~/.pi/agent/prompts/` and launch it with `/prompt-workflow`. The adapter compiles prompt steps into `workflowScript`, so templates describe the work instead of embedding raw `subagent` tool-call JSON. You can ask the parent agent to create or update these prompt files from a process described in natural language.

```md
---
description: Review a release candidate
subagent: reviewer
fresh: true
---
Review $@. Return concrete findings with source proof, or state that no issue was found.
```

For first-pass review prompts, filter by evidence rather than by severity. Ask the
reviewer to label concrete current findings P0/P1/P2 and end with `Merge verdict:
BLOCK`, `Merge verdict: OK`, or `Merge verdict: OK with notes`. Reserve
`blockers only` for final pre-merge re-checks after P1/P2 findings are already
known, or for explicit emergency hotfix lanes.

```text
/prompt-workflow review-release-candidate v0.51.0
```

For watched same-repo workflows, pass `async:false` only when the parent must block until completion. That blocking mode also shows the live in-chat workflow card. `chatProgress` can force `off` or `live-card` when the automatic policy is not what you want. Blocking workflows default to a 30-minute timeout; async workflows have no default timeout. See the [tool reference](tool-reference.md) for the full parameter list.

Synchronous workflows publish trace and `emit(...)` updates through the tool update callback regardless of `chatProgress`, including RPC/headless and cross-repository runs. These updates include `details.workflow` and `details.workflowChildren`; `chatProgress: "off"` disables the live card, not transport progress. This is workflow lifecycle progress, not a live child transcript.

The legacy `/chain`, `/parallel`, and `/run-chain` commands are not registered.

## Direct commands

Use `/run <agent> [task] [--bg] [--fork]` for one child.

## Worktree isolation

Scripted workflows can give each writing child a separate managed git worktree by setting `worktree: true` on each `runs.run` / `runs.all` item:

```javascript
const [api, ui] = await runs.all([
  { key: "api", agent: "worker", task: "Implement the API", worktree: true },
  { key: "ui", agent: "worker", task: "Implement the UI", worktree: true }
]);
return { api: api.artifactPaths, ui: ui.artifactPaths };
```

Each child uses the existing worktree lifecycle: it branches from clean HEAD, journals ownership before launch, captures a patch and handoff manifest, then removes cleanly captured temporary worktrees and branches. The handoff manifest path remains available in the child's `artifactPaths`; return or emit it when the orchestrator needs to apply or inspect the patches. `runs.ref` stays concise and intentionally omits full paths.

A top-level `{ workflowScript, worktree: true }` makes isolation the default for every workflow child. An individual child can override that default with `worktree: false`. Keep one writer when parallel writes are not intentionally isolated.

Use `baseRef` to branch managed worktrees from `HEAD` or a supported named ref such as `refs/heads/release`, `refs/tags/v1`, or `origin/main`. Full 40/64-character commit IDs and revision expressions such as `HEAD~1` are unsupported. For example, `{ workflowScript, worktree: true, baseRef: "refs/heads/release" }` applies the release ref to children unless a child supplies its own `baseRef`. If omitted, the default `HEAD` is resolved at worktree allocation, not when the script is validated or a schedule is created. The source checkout must still be clean, and the ref must resolve to a commit before any worktree is allocated.

Configure the worktree provider, native path layout, base directory, and setup hook in [configuration.md](configuration.md).

Setup waits remain nonblocking and cancellable. Normal cleanup, including detached foreground finalization, waits for the same in-process setup turn rather than retaining worktrees merely because another setup is active. This is not a cross-process lock. Hooks must follow the [finite setup contract](configuration.md#worktreesetuphook).

### Lane metadata lifecycle

Workflow children may declare a bounded `lane` object (`version`, `key`, optional
`mode`, opaque `sourceRef`, advisory `claims`, and advisory `outputPaths`). The
lane key must match the `runs.run`/`runs.all` workflow key. These fields are
display and triage hints only: they do not grant tools, authorization, or
cleanup permission, and `sourceRef` is never resolved over the network while
rendering status. Worktree paths and branches copied into status are also
display-only; the handoff manifest remains the deletion authority.

| Durable file | Owner | Pending / running / finalized / cleanup states | Release predicate | Rollback predicate | Stale-head behavior | Fail-closed cases |
| --- | --- | --- | --- | --- | --- | --- |
| `status.json` | Async runner and workflow status projector | Child step starts `pending`, becomes `running`, then terminal `complete`/`failed`/`paused`/`stopped`; worktree path and branch are copied at launch | Status is terminal and the existing active-run/process proof can release the run marker; lane metadata alone never releases a worktree | Setup or persistence failure keeps the lane unknown; only the existing verified setup rollback may remove a newly created worktree | Recorded status is retained; a base/head mismatch is not repaired or inferred from render-time Git calls | Missing, malformed, or key-mismatched lane data; only one of `worktreePath`/`branch`; unverified process state |
| `handoffs/<run-id>.json` | Existing parallel handoff writer and cleanup engine | Group is `partial` with preserved cleanup tasks while pending/running; finalized groups contain child identity, patch, and cleanup evidence; cleanup is `partial` or `complete` | Only the existing cleanup engine's fresh Git checks and recorded task evidence can release a worktree/branch; #1621 adds no deletion path | Missing diff, failed capture, or cleanup error preserves the task and records the reason | `baseCommit` is retained as evidence; stale or changed heads remain unknown/preserved until an explicit later reconciliation | Missing/invalid manifest, mismatched run/key/task identity, duplicate identity, dirty or uncaptured work |
| `workflow-receipt.json` | Workflow terminal settlement | No receipt while `pending`/`running`; terminal receipt is finalized with one optional lane block per keyed child | Receipt publication is complete only after every included child entry is serialized; it does not authorize cleanup | Receipt write failure leaves status/handoff evidence authoritative and the workflow reports the missing receipt | Existing receipt is not backfilled or rewritten from a newer head | Invalid version/state, mismatched entry key or lane key, stale continuation lineage |
| `.active-runs` marker | Existing active-run index | `pending`/`running` while the runner is live; terminal marker remains until observed process proof | Marker removal requires the existing exact-run process-terminal proof | Unknown proof keeps the marker and lane retained for inspection | Marker state is not inferred from Git head or timestamps alone | Missing/unknown process proof, active marker, or foreign run identity |

Older runs without lane metadata remain readable and retain their existing
handoff/cleanup behavior. Missing lane, receipt, or handoff metadata is
unknown—not eligible for destructive cleanup.

Managed setup records actual allocation attempts in the handoff; only validated
allocations become cleanup tasks and display-only status paths/branches. On
cancellation or failure with unknown settlement, it retains actual/attempted
ownership evidence and artifacts for manual reconciliation, blocking further
unsafe setup and cleanup in that process. An allocator interrupted before
reporting its path may leave branch-only diagnostics, never an invented path.
Inspect the handoff before reconciliation; cleanup still requires fresh checks.

## Supervisor coordination (child asks parent)

Child agents can talk back to the parent Pi session without installing `pi-intercom`. `pi-subagents` provides the child-facing `contact_supervisor` tool and the parent-facing `subagent_supervisor({ action: "reply" })` path natively. Generic `intercom` remains available only when an explicitly loaded external provider supplies it.

Use it for work where the child might need a decision instead of guessing:

```text
Run this implementation in the background. If the worker gets blocked or needs a product decision, have it ask me through the supervisor channel.
```

```text
Ask oracle to review this plan. If it sees a decision I need to make, have it ask me instead of assuming.
```

The child uses one dedicated coordination tool, `contact_supervisor`, with a `reason`:

- `need_decision` — blocking decisions or clarification
- `interview_request` — structured input
- `progress_update` — short non-blocking updates when a discovery changes the plan

Children should not ask for clarification when the only conflict is review-only/no-edit versus progress-writing or artifact-writing instructions; no-edit wins.

The parent replies with `subagent_supervisor({ action: "reply", replyTo, message })` or checks pending requests with `subagent_supervisor({ action: "pending" })`. Supervisor messages are scoped to the exact Pi session id that spawned the child. A second Pi session in the same repository does not receive those requests.

Child-side routine completion handoffs are not expected. If a child appears stalled, needs-attention notices show up in the parent session with useful next actions, such as checking `subagent({ action: "status" })`, interrupting the run, or nudging the child.

If a `workflowScript` child detaches through `contact_supervisor`, the enclosing async workflow stays `paused` until that child exits. Then the extension reconciles it to `complete` or `failed`. Wait on the child until that happens.

If messages do not show up, run `/subagents-doctor`. Advanced users can tune the bridge with `intercomBridge` in [configuration.md](configuration.md).

## Recursion guard

Subagents can call `subagent` only when their resolved builtin tools explicitly include `subagent`. That is meant for delegated fanout agents, not ordinary worker/reviewer children. A depth guard prevents unbounded nesting.

By default, nesting is limited to two levels: main session → subagent → sub-subagent. Deeper calls are blocked with guidance to complete the current task directly. Nested runs appear in the parent status widget and `status` output as a tree, and `status`, `interrupt`, and `resume` can target a nested run by its id.

Configure the limit with:

1. `PI_SUBAGENT_MAX_DEPTH` before starting Pi
2. `config.maxSubagentDepth`
3. `maxSubagentDepth` in agent frontmatter, which can only tighten the inherited limit

```bash
export PI_SUBAGENT_MAX_DEPTH=3
export PI_SUBAGENT_MAX_DEPTH=1
export PI_SUBAGENT_MAX_DEPTH=0
```

`PI_SUBAGENT_MAX_DEPTH` applies to the top-level parent; children inherit their limit through their runtime config, and their own depth is tracked there too.

## Prompt-template integration

`pi-subagents` includes a native prompt-workflow adapter for reusable subagent prompt templates, so you do not need `pi-prompt-template-model` for the common subagent workflow path.

Create a prompt in `.pi/prompts/` or `~/.pi/agent/prompts/`:

```md
---
description: Take a screenshot
model: claude-sonnet-4-20250514
subagent: browser-screenshoter
cwd: /tmp/screenshots
---
Use url in the prompt to take screenshot: $@
```

Then run it through the native adapter:

```text
/prompt-workflow take-screenshot https://example.com
```

The adapter delegates to the named subagent, applies `model`, `skill`, `cwd`, and fork/fresh context metadata, and supports runtime overrides such as `--subagent reviewer`, `--fork`, `--fresh`, and `--bg`.

Prompt templates with `chain:` frontmatter are translated into `workflowScript` and launched through `/prompt-workflow`; `/chain-prompts` is no longer registered.
