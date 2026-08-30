# Pi Subagents: Constraints And Recipes

This file is a detailed reference loaded from `skills/pi-subagents/SKILL.md`.

## Important Constraints

- **Explicit forking requires a persisted parent session.** If the current session
  does not have a persisted session file or current leaf, explicit `context: "fork"`
  fails. An agent-level `defaultContext: fork` is a preference: packaged `worker`,
  `oracle`, and `advisor` fall back to `fresh` when those fork preconditions are not
  met yet. Use `context: "fresh"` when you do not want a fork even after the parent
  session exists.
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

Runtime config can change orchestration behavior. `intercomBridge.resultDelivery: false` disables only external acknowledged grouped-result delivery when native parent notifications own completion; supervisor asks/progress stay active, and enabled transport failures are still reported. `asyncByDefault` and `forceTopLevelAsync` affect whether launches detach; `waitTool` can make direct `bg_wait()` calls return immediately while headless auto-drain remains active, and its effective value is propagated to child runtimes; `globalConcurrencyLimit` bounds concurrent fanout, while a positive `maxSubagentSpawnsPerSession` optionally caps cumulative launches (`0` or unset is unlimited). Status and doctor report the budget; static work preflights declared capacity; only the settled root interactive parent can use `grant-spawn-budget` after native confirmation, with total grants bounded by the original cap. Compaction does not reset usage or grants; `singleRunOutputBaseDir` and `worktreeBaseDir` route outputs and worktrees; `completionBatch` groups async notifications. `artifactDir` is `session` (default), `project`, or `temp` and chooses where subagent artifacts are stored. Set `asyncWidget: false` to hide the above-editor background-run widget when a companion footer or dashboard owns that space (fleet inspector remains available). Per-run `artifacts: false` disables artifact capture for that launch. Async status and result artifacts include `lifecycleArtifactVersion` and fields such as `workflowGraph`, `steps`, `results`, `totalTokens`, `totalCost`, `turnCount`, `toolCount`, and nested `children`. Child protocol failures expose a structured `protocolError`; `protocol_output_limit` means a child emitted a JSONL line above the 16 MiB live-parser cap. Prefer these artifacts and `status` views over scraping terminal output.

### Keep report artifacts out of the repository root

Treat lane reports, review notes, council pass reports, and gate logs as scratch unless the user explicitly asks to keep them. Prefer `output: false` and the aggregate workflow result for short reports. When a later step needs a file, use the runtime-managed output artifact by setting a stable child key plus a relative `output` path such as `plans/deploy.md`; relative child outputs are saved under the run artifact directory, not the project root. Do not put `reports/...`, `*-report.json`, or similar repo-root paths in child task text.

For durable evidence, copy only the final summary to session memory, a PR body/comment, a mission artifact, or a user-approved docs path outside the repo. After the PR, issue, or gate reaches a terminal state, delete or move scratch reports from the active worktree before reporting completion. Keep a project `.gitignore` entry for ad-hoc report patterns only as a safety net; it is not the cleanup mechanism.

## Best Practices

- Run subagents asynchronously by default; direct one-child execution is enough for one bounded task, while `workflowScript` is the composition surface for JavaScript control flow and data-dependent branching. Use `async: false` only when the parent must block. See `references/execution-controls.md` → Async/background for wait semantics.
- For a predeclared broad plan split into visible narrow stages, use `runs.lanes([...])` inside `workflowScript`; use raw `runs.run(...)`/`runs.all(...)` for conditional or rolling flows. See [`execution-controls.md`](execution-controls.md#parallel-sequential-lanes).
- Keep one writer per cwd/worktree. Parallelize reading, review, and validation; concurrent writers need isolated worktrees. Give every child a cold-start packet with its goal, target/ref, authority, context, success criteria, validation, output, and stop rules.
- Keep tasks narrow and standalone; do not rely on issue numbers, broad globs, or supervisor round-trips to supply missing context.
- Keep authority with the parent. Escalate unapproved product, scope, architecture, merge, credential, or release decisions; checks, receipts, and review bots are evidence, not authority.
- Use `fresh` context for adversarial review. `fork` is a persisted, history-inheriting branch; see `references/execution-controls.md` for its preconditions.
- Use a same-session oracle follow-up only when its first answer leaves a material tradeoff. Treat `needs_attention` as a control signal, not failure, and do not interrupt a child merely because it is quiet during tools, tests, or reasoning.
- Use `/name` when intercom targeting needs a stable session name.

## Workflow selection

This reference keeps cross-cutting policy and failure handling. Load the matching domain reference for detail:

| Need | Read |
| --- | --- |
| Execution syntax, lifecycle, async/wait, missions, controls, watchdog, or worktrees | [`references/execution-controls.md`](execution-controls.md) |
| Role choice, prompt contracts, review/research/cleanup techniques, or model tiering | [`references/prompting-and-roles.md`](prompting-and-roles.md) |
| Fresh review, validation, gate failures, finding disposition, and final delivery checks | [`references/review-and-validation.md`](review-and-validation.md) |
| Independent lanes, repositories, worktrees, and handoffs | [`references/multi-lane-orchestration.md`](multi-lane-orchestration.md) |
| Agent management, file authoring, prompt integration, or RPC | [`references/management-authoring-rpc.md`](management-authoring-rpc.md) |

Choose the smallest recipe that fits:

- **Recon → plan → implement:** run one focused `scout`, then one `worker` that consumes its findings.
- **Non-trivial implementation:** clarify scope and acceptance, record user-owned decisions and seam/validation contracts, scout load-bearing code, plan when useful, use one writer, run fresh review/validation, apply only accepted fixes with one writer, then inspect direct evidence and the final diff before parent acceptance. Split large work into serial milestones instead of a writer swarm; do not stop at review without disposition.
- **Parallel analysis:** fan out only independent read/review/validation work, or isolate each writer in its own worktree. Never run concurrent writers in one checkout.

## Error Handling

- **Unknown agent:** run `subagent({ action: "list" })`; check scope/precedence and author new orchestration with `workflowScript`, not legacy chains.
- **Setup, discovery, or intercom confusion:** run `subagent({ action: "doctor" })`.
- **Max subagent depth exceeded:** flatten the workflow or raise `maxSubagentDepth` in config.
- **Missing session file for a fork:** persist the parent session before using `context: "fork"`.
- **Intercom already waiting for a reply:** resolve the pending ask before starting another.
- **Parallel output-path conflict:** give each task a distinct output path, or disable output where no artifact is needed.
- **Worktree launch failure:** ensure the git tree is clean and task cwd overrides match the shared cwd.
- **Child fails before starting:** inspect `subagent({ action: "status", id: "..." })`, artifact metadata, output logs, and `doctor`; loader errors usually appear in child logs.
