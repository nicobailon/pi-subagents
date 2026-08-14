# Pi Subagents: Constraints And Recipes

This file is a detailed reference loaded from `skills/pi-subagents/SKILL.md`.

## Important Constraints

- **Forking requires a persisted parent session.** If the current session does not
  have a persisted session file, forked runs fail. Packaged `worker`, `oracle`,
  and `advisor` default to forked context, so use `context: "fresh"` explicitly
  when that is not available or not wanted.
- **Forked runs inherit parent history.** They are branched threads, not fresh
  filtered contexts. Use fresh context for adversarial reviewers unless the user explicitly asks for forked context.
- **Default subagent nesting depth is 2.** Deeper recursive delegation is blocked
  unless configured otherwise.
- **Attention signals are not lifecycle state.** `needs_attention` means no activity has been observed past the configured threshold. `paused` means the child turn was intentionally interrupted or is awaiting direction; it is not the same as `failed`.
- **Intercom asks are blocking.** A session can only maintain one pending outbound
  ask wait state at a time.
- **Keep conversational authority clear.** Advisory subagents should not silently
  become second decision-makers.
- **Respect the fixed authority policy.** `authorityPolicy` is a small `auto` / `confirm` / `forbid` map for supported operational actions. Worktree discard, destructive cleanup, and spawn-budget grants default to confirmation; stop, steer, and schedule creation remain automatic. Use `worktree.discard` with the durable `handoffPath`; confirm-required actions refuse safely without an interactive UI and retained paths include manual Git recovery commands.

Runtime config can change orchestration behavior. `intercomBridge.resultDelivery: false` disables only external acknowledged grouped-result delivery when native parent notifications own completion; supervisor asks/progress stay active, and enabled transport failures are still reported. `asyncByDefault` and `forceTopLevelAsync` affect whether launches detach; `waitTool` can make direct `subagent_wait()` calls return immediately while headless auto-drain remains active, and its effective value is propagated to child runtimes; `globalConcurrencyLimit` bounds concurrent fanout, while a positive `maxSubagentSpawnsPerSession` optionally caps cumulative launches (`0` or unset is unlimited). Status and doctor report the budget; static work preflights declared capacity; only the settled root interactive parent can use `grant-spawn-budget` after native confirmation, with total grants bounded by the original cap. Compaction does not reset usage or grants; `singleRunOutputBaseDir` and `worktreeBaseDir` route outputs and worktrees; `completionBatch` groups async notifications. `artifactDir` is `project` (default), `session`, or `temp` and chooses where subagent artifacts are stored. Set `asyncWidget: false` to hide the above-editor background-run widget when a companion footer or dashboard owns that space (fleet inspector remains available). Per-run `artifacts: false` disables artifact capture for that launch. Async status and result artifacts include `lifecycleArtifactVersion` and fields such as `workflowGraph`, `steps`, `results`, `totalTokens`, `totalCost`, `turnCount`, `toolCount`, and nested `children`. Child protocol failures expose a structured `protocolError`; `protocol_output_limit` means a child emitted a JSONL line above the 16 MiB live-parser cap. Prefer these artifacts and `status` views over scraping terminal output.

## Best Practices

### Prefer async orchestration

Launch every subagent asynchronously by default. Use `async: true` for scouts, researchers, workers, reviewers, validators, oracle checks, one-off delegates, and scripted workflows unless you intentionally need a foreground/blocking run. Launch all execution through `workflowScript`; use `return runs.run("main", { agent, task })` for one isolated child and `runs.all([...])` when two or more child lanes, monitors, or dependent steps should move together. The parent should keep moving: inspect code while scouts run, prepare validation while a worker implements, do a local diff pass while reviewers review, and synthesize or verify while a fix worker applies accepted feedback. Async is the default orchestration posture; foreground runs are the explicit opt-out.

### Use subagent_wait() to block until async runs finish

In an interactive chat, do not call `subagent_wait()` merely to wait after launching background work; return control to the user and Pi will wake the session on completion. Override that default when the current request is run-to-completion — for example, the user asked you to stay with the task and report results back this turn or a skill must finish in one turn. In a headless run, Pi auto-drains exact current-session work at `agent_end`; call `subagent_wait()` when this turn must receive results before it ends. In either case, `subagent_wait()` blocks the current turn until the next run completes or needs attention, keeps the turn alive for normal notification delivery, then returns.

- `subagent_wait()` — return when the next initially active async run or registered provider item finishes, or a subagent needs attention.
- `subagent_wait({ all: true })` — block until every async run and provider item active at call time finishes, or a subagent needs attention.
- `subagent_wait({ id: "..." })` — block on one async or remembered detached foreground run (id or prefix). Provider items are not selected through this parameter.
- `subagent_wait({ timeoutMs })` — cap the block; active work keeps running if it elapses.

Providers are discovered through the `pi-subagents/background-work` registry and must return stable item IDs with exact owning session IDs. Child agents receive no provider automatically: keep `subagent_wait` in the child `tools` allowlist and load provider extensions through `extensions` or `subagentOnlyExtensions`.

For non-interactive fleet orchestration, `subagent_wait()` can keep N workers in flight: launch N, wait for the next completion, react to the result, launch a replacement if needed, then wait again. Use `subagent_wait({ all: true })` only when you intentionally want to drain the fleet to zero. If the turn ends first, headless `agent_end` auto-drain still waits for exact current-session work. In an interactive session, return to the user instead of holding the turn open just to await completion.

If config or `PI_SUBAGENT_WAIT_TOOL_ENABLED` disables blocking behavior, direct `subagent_wait` calls return immediately. Headless `agent_end` auto-drain remains active as a lifecycle safeguard and surfaces provider, reconciliation, or timeout failures.

### Keep writes single-threaded by default

A strong pattern is one main decision-maker plus advisory/research/review/validation subagents around it. Use `oracle` for advice and `worker` for the actual write path. Parallelize reading, review, validation, and synthesis support, not normal writes, unless you deliberately isolate writers with worktrees. Across repositories, each repo/worktree still gets at most one writer, with explicit `cwd` and authority in the child prompt. A child that writes should report what changed, what was left undone, commands run with exit codes, validation evidence, surprises, and any decisions that need parent approval.

### Use fork for branched advisory or execution threads

Forked runs are useful when the child should reason in a separate thread while
still inheriting the parent’s accumulated context. They are especially useful for
`oracle`, which audits inherited decisions and drift. For adversarial code review,
prefer fresh-context reviewers that inspect the repo and diff directly unless the
user explicitly requests forked context.

### Prefer narrow tasks

Give subagents specific tasks rather than vague mandates.
`Review auth.ts for null-check gaps` works better than `Review everything`.

### Escalate decisions upward

If a subagent encounters an unapproved product, architecture, scope, merge, release, credential, or authority choice, it should use `contact_supervisor` and wait for the reply instead of deciding alone. Generic `intercom` is external-only and should be used only when an explicit provider supplies it and the task identifies a safe target. External checks, receipts, and review bots provide evidence only; they do not grant authority.

### Intervene only on clear control signals

Use subagent control proactively when a delegated run emits `needs_attention`, or when a human asks you to regain control. Do not interrupt just because a child has briefly produced no output. Silence can be normal during long tool calls, test runs, or model reasoning.

### Name sessions meaningfully

Use `/name` so intercom targeting stays stable.

## Common Workflows

### Recon → Plan → Implement

```js
subagent({ workflowScript: `
  const context = await runs.run("recon", { agent: "scout", task: "Inspect the codebase and identify the implementation seam" });
  return (await runs.run("implement", { agent: "worker", task: "Implement from: " + context.output })).output;
` })
```

### Fable mode for complex work

Fable mode is the default orchestration posture for complex work. It is not a separate runtime mode; it is how the parent session uses `subagent`, `interview`, `subagent_wait`, acceptance contracts, artifacts, and fresh-context review when the work has real complexity. Use it for complex features, broad refactors, migrations, ambiguous goals, multi-system changes, expensive validation, user-visible behavior changes, or any request to plan/orchestrate end to end. Do not force it onto tiny one-shot delegation.

Run the work through seven gated phases:

1. **Understand** — use `scout` fanout for breadth, but the parent personally reads the load-bearing files and lets direct source reading decide disagreements. Gate: the parent can quote the exact code or behavior being changed and knows the repo's verification harness.
2. **Decide** — separate user-owned decisions from implementation judgments. Use `interview` for product, naming, cost, taste, risk, release, merge, or authority decisions; decide routine engineering details in the parent and state them. Gate: every user-owned decision needed for design is answered or recorded as a blocked follow-up.
3. **Design** — use read-only design/review children for parallel perspectives. Before parallel workstreams, write seam contracts: ownership boundaries, composition points, assumptions, and validation handoffs. Gate: one parent-synthesized plan and written seams for parallel work.
4. **Implement** — capture a baseline first, then launch one async `worker` as the sole writer for the active worktree unless isolated worktrees were intentionally requested. For cross-codebase work, launch separate async workers only when each has its own repo/worktree, explicit `cwd`, and non-overlapping authority. Break large work into serial milestones instead of concurrent writes. Gate: build/typecheck is green and every output or diff delta is characterized as intended or fixed.
5. **Verify** — climb the spend ladder: static checks, free end-to-end/dry-run, cheapest live probe, targeted changed-path live test, then full realistic run when warranted. Observe the artifact itself, not only exit codes or scores, and confirm the changed code actually executed. Gate: the highest necessary rung has directly observed evidence matching intent.
6. **Iterate** — when a gate or reviewer finds a defect, the parent names the failure class, searches for siblings, synthesizes fixes, and sends exactly one fix worker for accepted changes. For LLM judges, gates, or detectors, trigger on concrete findings rather than scores, record pass/violations/error verdicts, cache nondeterministic verdicts by input hash, budget enough output tokens, and sanitize judge text before reusing it downstream. Gate: the class is fixed or explicitly bounded, and recurrence detection exists when feasible.
7. **Ship** — run adversarial fresh-context review/validation outside the implementation path, disposition every finding, rerun affected gates, then have the parent inspect the final diff. Commit, push, comment, close, merge, release, or open PRs only inside user-approved boundaries for that repo. Gate: findings are dispositioned, gates re-pass, and the final summary names evidence, artifacts, residual risks, and output paths.

### Clarify → Plan → Implement → Review (self-orchestrated workflow)

For straightforward non-trivial work, this sequence is the lightweight version of the parent-owned loop. When the task is complex, use Fable mode above. In either case, factor in the packaged prompt workflows without literally invoking slash commands. Use the same patterns through tools and subagents.

Keep builtin agent defaults unless the user explicitly asks for a different model, thinking level, skills, output behavior, context mode, or other override. Do not add overrides just because you are orchestrating; the defaults encode the intended role behavior. In particular, packaged `worker`, `oracle`, and `advisor` default to forked context.

When the user approves launching a subagent to carry out a plan or workflow, treat that as approval to generate a proper role-specific meta prompt for that subagent. Include the approved plan path or summary, clarified requirements, non-goals, relevant context, role boundaries, files or areas to inspect, acceptance criteria, expected output, and validation expectations. Do not pass vague instructions like “implement the plan fully” or “review this” by themselves.

- `/gather-context-and-clarify` maps to: launch `scout` and, when needed, `researcher`; synthesize findings; then use `interview` to ask every clarification question needed for shared understanding.
- `/parallel-review` maps to: launch fresh-context `reviewer` agents with distinct review angles; synthesize the feedback before applying anything.
- `/review-loop` maps to: keep the parent in charge of worker → fresh reviewers → synthesized fix worker cycles until no fixes worth doing now remain, an unapproved decision appears, or the review-round cap is reached.
- `/parallel-research` maps to: combine local `scout` context with external `researcher` evidence when current docs, ecosystem behavior, or API details matter.
- `/parallel-cleanup` maps to: use review-only cleanup passes after implementation, especially for simplicity, verbosity, and redundant tests.

For feature work, use this sequence as scaffolding for parent-agent behavior:

```text
clarify → validation contract → scout → async worker → parallel async fresh-context reviewers/validators → async fix worker → follow-up review when warranted → parent review
```

The validation contract defines acceptance before code is written: expected behavior, acceptance checks, commands or user flows to exercise, and evidence the worker should return. Keep it lightweight for small tasks, but make it explicit enough that reviewers and validators are checking the intended outcome rather than the worker’s own assumptions.

For one host-run verification command, `gate: "npm test"` on the child is shorthand for verified acceptance with that command; it cannot be combined with `acceptance` and is rejected on retained resume items. Use the structured `acceptance` field when the run should carry an explicit acceptance contract. If omitted, subagents infer an effective policy from role, mode, and risk. Evidence levels end at `verified`: use `level: "checked"` for ordinary writer evidence and `level: "verified"` when the runtime should run explicit validation commands. Independent review is orthogonal; use `review: { required: true, agent: "reviewer" }` and orchestrate the reviewer separately. `review-required` means evidence passed but review is pending, while `reviewed` means a real independent result found no blockers. For reviewer/read-only calls, omit `acceptance`. Never explicitly request `level: "reviewed"`; that value remains recognized only so preflight can return an actionable correction. To disable gates, use `{ level: "none", reason: "..." }`; the bare string `"none"` is rejected, and `false` is accepted only as a deprecated shorthand. Child-reported command success is evidence, not runtime verification.

The first `worker` implements the approved plan. The parent continues with independent inspection or validation prep while it runs, not parallel edits to the same worktree. When the async worker completes, treat its handoff as the transition into review, not as final completion, unless the user explicitly asked for worker-only work, review-only output, or to stop after implementation. Parallel reviewers inspect the resulting diff from fresh context. Validators check behavior with the best available evidence: commands, tests, browser/CLI interaction, screenshots, logs, or manual reproduction notes. The final `worker` applies synthesized review fixes in forked context, then the parent looks over the final diff before completing. The parent may launch these steps as an initial async `workflowScript` when the workflow is already clear, or as follow-up workflowScript runs after each async completion. Initial workflows should pass `async: true` so the main chat is unblocked. Do not stop after parallel review unless the user explicitly asked for review-only output or the review surfaced a decision that needs approval first.

For complex work, risky changes, broad refactors, or many changed lines, increase review and validation fanout rather than trusting one reviewer. Use distinct angles such as correctness/regressions, tests/validation, simplicity/maintainability, security/privacy, performance, docs/API contracts, and user-flow behavior. When reviewers find non-trivial issues or the fix worker touches many lines, run another focused review round before final validation.

When review has already produced concrete findings across several independent areas, use staged fix orchestration: parallel read-only reviewers for each issue cluster, one sole writer worker for the active worktree, then parallel fresh-context validators. This is the safest way to handle a dirty worktree with many prior changes because it parallelizes judgment without parallelizing writes. Non-blocking suggestions may go into the writer prompt only if they are small, safe, and inside the approved scope; otherwise defer them explicitly.

For very large work, split into serial milestones instead of launching a swarm of writers. Each milestone gets one writer, a validation contract, fresh-context review/validation, a fix pass, and parent acceptance before the next milestone starts. Use parallel subagents inside a milestone for read-only context, research, review, and validation only.

Keep orchestration authority in the parent session. Child subagents should not launch more subagents, read this skill, or run their own orchestration loops unless the parent intentionally selected a fanout agent whose builtin `tools` includes `subagent`. Spawned subagents do not receive the `pi-subagents` skill, parent-only status/control/slash messages, or prior parent `subagent` tool-call/tool-result artifacts. Ordinary children also do not receive the `subagent` extension tool. Child context filtering strips old hidden orchestration-instruction messages when they appear in inherited history. Every child receives a boundary instruction: ordinary children are told the parent owns orchestration and they must not propose or run subagents; explicit fanout children are told to use `subagent` only for the assigned fanout work, with `maxSubagentDepth` still enforced. Implementation children must call real edit/write tools instead of printing pseudo tool calls. Pass children concrete role-specific work instead.

1. Clarify first. This is mandatory. Gather code context with `scout`, add `researcher` only when external evidence matters, then ask the user clarifying questions with `interview` until scope, acceptance criteria, constraints, and non-goals are clear.
2. Define the validation contract. State acceptance before implementation: expected behavior, checks to run, user flows to exercise, and evidence required in the worker handoff. For UI, CLI, integration, or workflow changes, include at least one validator angle that uses the product the way a user would rather than only reading code.
3. Plan when useful. For complex work, write a plan doc yourself and get approval before implementation. For simple work, confirm shared understanding and explicitly note why planning is skipped.
4. Implement with one writer. After approval, launch `worker` asynchronously with a proper meta prompt that includes clarified requirements, relevant context, plan path or summary, the validation contract, and output expectations. Packaged `worker` defaults to forked context; pass `context: "fresh"` only when you intentionally want a fresh child. While it runs, prepare validation or inspect adjacent code instead of editing the same worktree.
5. Require a useful worker handoff. Ask the worker to report changed files, what was implemented, what was left undone, commands run with exit codes, validation evidence, surprises or new risks, decisions made inside approved scope, and decisions needing parent approval.
6. Review after implementation. After the worker completes, launch parallel async fresh-context `reviewer` agents for correctness/regressions, tests/validation, and simplicity/maintainability. Add security, performance, docs/API, domain-specific, or user-flow validators for complex work, risky changes, broad refactors, or many changed lines. Use `output: false` unless review artifacts are explicitly needed.
7. Synthesize, then run the fix worker. Separate blockers, fixes worth doing now, optional improvements, and feedback to ignore/defer, then launch an async forked `worker` to apply fixes worth doing now when the workflow is implementation-authorized. If reviewers found scope/product/architecture choices that were not approved, ask the user first instead of applying them.
8. Review again when warranted. If the fix worker made substantial changes or addressed non-trivial findings, run another focused parallel review round before final validation.
9. Validate and complete. After the fix worker and any follow-up review return, inspect the final diff yourself, run or confirm focused validation, update docs/changelog when relevant, and summarize what changed and why.

Example implementation handoff after clarification and optional planning:

```typescript
subagent({
  workflowScript: `return runs.run("implementation", {
    agent: "worker",
    task: "Implement the approved feature.\n\nClarified requirements:\n- ...\n\nPlan: see ~/Documents/docs/...-plan.md\n\nValidation contract:\n- ...\n\nReturn a handoff with changed files, what was implemented, what was left undone, commands run with exit codes, validation evidence, surprises/new risks, and decisions needing parent approval.",
    acceptance: {
      level: "checked",
      evidence: ["changed-files", "tests-added", "commands-run", "residual-risks", "no-staged-files"]
    }
  })`,
  async: true
})
```

Example review pass after implementation:

```typescript
subagent({
  workflowScript: `
    const results = await runs.all([
      { key: "correctness", agent: "reviewer", task: "Review the current diff for correctness and regressions. Inspect changed files directly; do not rely on the worker's reasoning.", output: false },
      { key: "tests", agent: "reviewer", task: "Review the current diff for tests and validation quality against the validation contract. Inspect changed files directly.", output: false },
      { key: "simplicity", agent: "reviewer", task: "Review the current diff for simplicity and maintainability. Inspect changed files directly.", output: false }
    ]);
    return results.map(result => result.output);
  `,
  context: "fresh",
  async: true
})
```

Example fix worker after parallel reviews:

```typescript
subagent({
  workflowScript: `return runs.run("fix", {
    agent: "worker",
    task: "Apply the synthesized reviewer feedback below. Only apply fixes worth doing now; preserve user-approved scope; ask before unapproved product or architecture changes. Run focused validation and summarize what changed.\n\nReviewer synthesis:\n..."
  })`,
  async: true
})
```

### Review loop

Do not treat review as the final step for implementation work. Run reviewers and validators, synthesize their findings against user scope and the validation contract, then launch one `worker` for accepted fixes when implementation is authorized.

When an async implementation worker completes, treat the worker handoff as an intermediate state. The next parent action is review fanout, then synthesis, then a fix worker if reviewers found fixes worth doing now. This can be planned as an initial async `workflowScript` when the whole workflow is known, or continued as follow-up workflowScript runs when the parent only launched the first worker initially. Initial workflows should pass `async: true` so the main chat is unblocked.

For explicit review-loop requests, repeat worker → fresh-reviewer → synthesized-fix-worker cycles until reviewers find no blockers or fixes worth doing now, remaining feedback is optional or intentionally deferred, an unapproved product/scope/architecture decision needs the user, or the max review-round cap is reached. Default to 3 review rounds unless the user sets a different cap. For complex work, many changed lines, or any fix pass that materially changes the diff, run another focused review round before the parent’s final look; otherwise stop instead of chasing optional polish.

### Parallel non-conflicting analysis

```js
subagent({ workflowScript: `
  return await runs.all([
    { key: "frontend", agent: "scout", task: "Inspect the frontend" },
    { key: "backend", agent: "scout", task: "Inspect the backend" }
  ]);
` })
```

Use distinct keys, prompts, and output paths. Do not launch parallel writers into the same checkout.

## Error Handling

**"Unknown agent"**
```typescript
subagent({ action: "list" })
// Check available agents and chains, then confirm scope/precedence.
```

**Setup, discovery, or intercom confusion**
```typescript
subagent({ action: "doctor" })
// Check runtime paths, async support, discovery counts, current session, and intercom bridge state.
```

**"Max subagent depth exceeded"**
```typescript
// Flatten the workflow or raise maxSubagentDepth in config.
```

**"Session manager did not return a session file"**
```typescript
// Persist the current session before using context: "fork".
```

**Intercom "Already waiting for a reply"**
```typescript
// Resolve the current outbound ask before starting another one.
```

**Parallel output-path conflict**
```typescript
// Give each parallel task a distinct output path, or disable output for tasks that do not need it.
```

**Worktree launch fails**
```typescript
// Ensure the git working tree is clean and task cwd overrides match the shared cwd.
```

**Child fails before starting**
```typescript
// Inspect `subagent({ action: "status", id: "..." })`, artifact metadata/output logs, and run doctor. Extension loader errors usually appear in child output logs.
```
