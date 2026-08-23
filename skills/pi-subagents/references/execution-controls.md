# Pi Subagents: Execution Controls

This file is a detailed reference loaded from `skills/pi-subagents/SKILL.md`.

## Discovery and Scope Rules

Agent files can live in:
- `~/.pi/agent/agents/**/*.md` — user scope
- `.pi/agents/**/*.md` — canonical project scope
- legacy `.agents/**/*.md` — still read for compatibility, but `.pi/agents/` wins on conflicts

Saved chain files may still be discovered for management and existing durable run state, but they are not a public execution surface. Author new orchestration with `workflowScript`.

Precedence is by parsed runtime name:
1. project scope
2. user scope
3. builtin agents

Project settings resolve from the nearest parent directory containing `.pi` or `.agents` by default. In monorepos or git worktrees where an incidental nested `.pi` directory should not shadow the repository config, set `subagents.projectRootResolution: "git-root"` in the repository root `.pi/settings.json`; a nested project can opt back with `"nearest"` in its own settings.

## Running Subagents

### External CLI profiles

An agent may set `runner.type: external-cli` with a non-empty `command`, optional string `args`, and `promptDelivery: stdin` (the default). The command runs with `shell: false`, inherits the resolved cwd and environment, and receives the combined agent instructions and task through stdin. It must already be installed; pi-subagents adds no CLI dependency.

External CLI profiles are async-only and one-shot. They support lifecycle artifacts, stdout/stderr logs, timeout, and stop. Full stdout and stderr are retained in their log files, while the final stdout response and stderr error kept in memory are each limited to their last 64 KiB. They do not support foreground/clarify, steer/resume/interrupt-as-pause, Pi models/tools/extensions/skills, tool or turn budgets, structured output, nested subagents, fallbacks, or sessions.

### External job profiles

An agent may set `runner.type: external-job` with a non-empty `provider` and optional JSON `options`. When `surf-cli` is installed and loaded, Surf can optionally expose a `gpt-pro` package agent through provider `surf-oracle`. Surf maps `model: pro` to ChatGPT GPT-5.6 Sol Pro web mode. pi-subagents does not own that package agent or model mapping. Remove any old `agentOverrides.gpt-pro.disabled` workaround before using Surf's package agent. The provider must be registered in the host Pi process through `pi-subagents/external-job-provider`; the async runner talks to that parent-owned registry through a local operation bridge.

External job profiles are async-only. The provider owns the remote job and Pi owns the async run record. Status persists provider name, provider job id, prompt digest, provider options, handle/conversation URLs when supplied, result artifact path, last known state, and provider failure code/message. Recovery uses existing provider job metadata to call `reattach` and `result`; it refuses to redispatch a prompt when the persisted provider job does not match the prompt digest.

External job profiles do not support foreground/clarify, steer/resume, Pi models/tools/extensions/skills, tool or turn budgets, structured output, native child permissions, fallbacks, or Pi child sessions. Capacity conflicts fail closed and include the blocking provider job id when the provider supplies it.

### Single agent

```typescript
subagent({
  workflowScript: `return runs.run("oracle-check", { agent: "oracle", task: "Review my current direction and challenge assumptions." })`
})
```

### Forked context

```typescript
subagent({
  workflowScript: `return runs.run("oracle-check", { agent: "oracle", task: "Review my current direction and challenge assumptions.", context: "fork" })`
})
```

`context: "fork"` creates a branched child session from the current persisted
parent session. It does **not** create a fresh minimal review context or filter
history down to only the relevant parts. Use it when you want a separate review
or execution thread that can still reference the parent session history.

Foreground results, async status, fleet, and widget surfaces label each child with
its resolved launch context as `[fresh]` or `[fork]`. Aggregate headers show
`[mixed]` when a run uses both modes.

### Scripted workflows

`workflowScript` is the sole public execution surface. Use `runs.run(key, { agent, task, ... })` for one child, `runs.all([...])` for parallel children, and ordinary JavaScript for sequence, branching, filtering, retries, and aggregation. Scripts are ordinary JavaScript statement bodies, so use an explicit return such as `workflowScript: "return runs.run('main', { agent: 'worker', task: '...' })"` for a useful one-child result. Use top-level `await`, plain helper functions, or explicit Promise chains; nested `async function` helpers, async arrows, and async methods are rejected. Prefer a single scripted workflow whenever the parent is starting a coordinated wave, such as multiple reviews, review plus gate monitor, worker then monitor setup, cross-repo prep lanes, or a fanout that the parent will consume together.

```js
subagent({
  workflowScript: `
    const scan = await runs.run("scan", { agent: "scout", task: "Map the target" });
    const reviews = await runs.all([
      { key: "correctness", agent: "reviewer", task: "Review correctness: " + scan.output },
      { key: "tests", agent: "reviewer", task: "Review tests: " + scan.output }
    ]);
    return reviews.map(result => result.output);
  `
})
```

Scripts run in a timed worker with only `runs.run`, `runs.all`, `runs.status`, `runs.ref/refs`, `emit`, captured `console`, and standard JavaScript. Pass explicit task text to `runs.run`. Mission-attached workflows also get `await state.get(key)` and `await state.set(key, value)` for durable JSON state shared across workflows on the same mission; `mission: false` workflows have no `state` global. Stable keys are required. Child launches follow ordinary single-agent execution controls. Give each child a distinct decision and output path when reports must outlive the workflow, then consume the aggregate workflow result before opening individual reports. Do not ask children to write `reports/...` or other repo-root scratch paths in task text.

If `runs.all` is missing in a running session, reload or update `pi-subagents` before retrying. The current runtime supports `runs.all`; `await Promise.all([runs.run(...)])` is also supported for advanced dynamic fanout.

For one host-run verification command, pass `gate: "npm test"` on a `runs.run`/`runs.all` item (or at the top level as a workflow default). It is shorthand for verified acceptance with that single command: the runtime executes it on the host, records the result as evidence, and memoizes it per tracked workspace state and effective environment. `gate` cannot be combined with `acceptance`; use explicit `acceptance.verify` for multiple commands or custom criteria.

Completed workflow children from this parent session stay addressable as retained children. `subagent({ action: "children.list" })` lists up to the last 10 with run ids and reports each row as `resumable` or `not resumable` with a reason. Resume only rows reported `resumable`. For a retained-child challenge, use `resume` instead of `steer` when the child is complete. If no retained child is resumable, launch a same-role fallback challenge and label it as fallback. A later workflow continues a resumable child with `runs.run(key, { resume: "<run-id>", task: "follow-up" })`. Inside `workflowScript`, awaiting that call waits for the revived child to finish and returns its completed output and new `runId`; top-level `{ action: "resume" }` remains detached. Pass explicit follow-up task text. Assign each returned child result back to the loop variable because every resume can return a new retained `runId`; always resume the latest returned id. `resume` and `agent` are mutually exclusive, the revived child keeps its stored agent/model/tool contract, and `gate` is rejected on retained resume items.

Terminal async workflows also persist `workflow-receipt.json` beside `status.json`. It maps each stable child key to its agent, requested and resolved context when known, latest run id, resumability, output reference, and continuation lineage. A later workflow can resume the latest retained child without copying its run id:

```js
return runs.run("cross-oracle", {
  resume: { workflowRunId: "<pass-1-workflow-id>", key: "advisor-oracle", latest: true },
  task: "Review the focused challenge packet."
});
```

Keyed resume reads that one exact receipt and revalidates the retained run at launch. It fails when the workflow or key is missing, the receipt is stale, `latest` is not `true`, or the recorded child is no longer resumable. Foreground workflow results expose the same receipt in `details.workflow.receipt`, but cross-workflow keyed lookup requires the durable receipt from an async workflow.

### Async/background

Prefer async mode for every subagent launch. Set `async: true` no matter the task unless the parent must block until completion. This applies to scouts, researchers, workers, reviewers, validators, oracle checks, one-off delegates, final review gates, backlog gates, and scripted workflows. Keep the write path single-threaded even when the run is async.

Use `async:false` only when the parent must block until completion. Async mode still shows progress. Do not use `async:false` because a task is short, because it is the last gate, because no other work is ready, because the user asked to finish the overall job, or because blocking is convenient.

Async does not mean parallel writes. Do not edit the same active worktree while an async worker is changing it. Parent-side overlap should be reading, validation prep, synthesis, command planning, or review of unaffected context unless the writer is isolated in a separate worktree.

Do not end your turn immediately after launching an async child if you promised to keep working. Continue the local inspection, synthesis, or validation prep, then check the async run when its result is needed. If no safe independent work remains, return control and let Pi wake the session; do not convert the child to foreground.

In an interactive chat, normally return control when ready to yield and let Pi wake the session on completion; do not call `subagent_wait()` merely to wait. A run-to-completion user request is not by itself a reason to use foreground children. Override the normal yield-and-wake flow only when this exact turn cannot safely end without the result, such as a headless provider flow or a skill contract that must produce a same-turn artifact. Use `subagent_wait()`, not `async:false`, for that current-turn dependency. Never substitute sleep or status-polling loops.

`subagent_wait()` returns when the next initially active async run or registered provider item finishes or a subagent needs attention. Use `subagent_wait({ all: true })` for all work active at call time, `subagent_wait({ id: "..." })` for one async or remembered detached foreground run, and `subagent_wait({ timeoutMs })` to cap the block. In a long-lived interactive parent session, use `subagent_wait({ id: "...", nonBlocking: true })` to resolve the prefix to one exact run, persist an armed subscription, return immediately, and wake later on completion, failure, attention, reconciliation failure, or timeout. Ordinary status lists armed subscriptions separately from active children. This differs from disabling `waitTool`, which returns immediately without arming a future wake. If a foreground child detaches for supervisor coordination, reply first, then wait on its id; do not resume or launch a replacement while it remains detached. Headless sessions also auto-drain exact current-session work at `agent_end` as a final safeguard.

```typescript
subagent({
  workflowScript: `return runs.run("main", { agent: "worker", task: "Run the full test suite" })`,
  async: true
})
```

File-only output mode works for workflowScript child launches. Use relative child output paths for scratch reports so the runtime stores them under the run artifact directory and age-based cleanup can remove them. Use absolute paths only for user-approved durable destinations, such as session memory, a docs folder outside the repo, or a known handoff path. For cross-codebase waves, include the repo slug or lane key in each output path so reports from different repositories cannot collide.

For review fanout where the parent continues a local audit:

```typescript
const run = subagent({
  workflowScript: `return runs.run("correctness", { agent: "reviewer", task: "Review the current diff for correctness issues. Do not edit files." })`,
  async: true,
  context: "fresh"
})
// Continue local inspection, then later call status with the returned id.
```

While children run, the persistent FleetView and the collapsed foreground tool-result card show live per-child detail: resolved model and thinking level, `[fresh]`/`[fork]` context, tool/token/elapsed counters, and current activity. The collapsed running card also prints the configured expand-key hint ("Press … for live detail"); expanding it shows nested children, recent tools, and recent output. Model badges appear once the child's model resolves at first attempt start. `/subagents-fleet` opens the live fleet inspector, which also has per-child controls (`s` steer, `D` stop with confirmation). When optional Herdr 0.7.5+ is available, `H` opens a raw inspector dashboard for the selected active async child; this mirrors artifacts rather than attaching to the headless child. When optional Orca progress tabs are enabled, Pi creates one passive Orca observer tab for the top-level subagent call. Parallel and chain children share that tab and write child section headers into the mirrored log instead of opening one tab per child. Pi remains authoritative for lifecycle, status, control, artifacts, and results; the Orca tab is display-only. Pi also writes passive display metadata under `.pi/subagents/views/orca/` when possible, so other surfaces can discover the observer without treating it as an owned child run. Use visual panes for confusing or long-running active async work when the human wants a dedicated surface or FleetView is insufficient, not for routine headless runs.

Inspect async runs with `subagent({ action: "status", id: "..." })` or `subagent({ action: "status" })` for active runs. Use `subagent({ action: "status", view: "fleet" })` when supervising several active foreground/background runs and `subagent({ action: "status", id: "...", view: "transcript", index: 0 })` when you need the latest child output without digging through artifacts. If a delegated fanout child launches nested runs, the parent status view shows them as a tree and you can target a nested run directly with its nested id.

Stop a current-session top-level async run with `stop` (or `/subagents-stop`). Stopped runs finish as `stopped`/cancelled and are not resumable. For an active foreground single-subagent run, `/subagents-detach [run-id]` leaves the child running without terminating it and returns the eventual result through status/wait.

```typescript
subagent({ action: "stop", id: "run-id" })
subagent({ action: "stop", id: "run-id", childId: "child-id" })
```

Use `childId` only for active async/workflow runs whose status snapshot shows a
matching child. Observer hosts can listen for the advertised
`subagent:child-status` event to update child-stop UI quickly, but status
snapshots remain the source of truth after reconnects or duplicate event
delivery.

Use `steer` for top-level live async guidance and `resume` after a delegated run pauses or finishes. Routed nested runs retain their existing non-destructive live follow-up path:

```typescript
subagent({ action: "steer", id: "run-id", message: "Focus on the failing test." })
subagent({ action: "resume", id: "run-id", message: "Follow up on this point." })
subagent({ action: "resume", id: "run-id", index: 1, message: "Continue reviewer 2." })
subagent({ action: "resume", id: "nested-run-id", message: "Continue this nested reviewer." })
```

Resume behavior:
- `resume` revives paused, completed, or failed async/foreground children from persisted session files; stopped runs remain non-resumable, and it does not interrupt live top-level async children.
- Use `steer` for acknowledged guidance to a live top-level async child.
- A live nested run can still receive a non-destructive `resume` follow-up through its owner route.
- If an async child has completed, `resume` revives it by starting a new async child from the persisted child session file.
- Multi-child async runs require `index` unless only one running child is selectable.
- Completed foreground single, parallel, and chain runs can also be revived by `index` while their run metadata remains in extension state.
- Nested runs can be resumed by nested id when a live route or persisted nested session metadata is available.
- Revive starts a new child process from the old session context; it does not restart the same OS process.
- Direct revival holds an exclusive cross-process lease on the canonical child session file until the new child finishes. Concurrent attempts fail before Pi starts and identify the owning revived run; stale ownership is reclaimed only when the recorded process is demonstrably gone or reused.
- If the chosen child has no persisted `.jsonl` session file, resume fails and reports that directly.

Use diagnostics when setup or child startup looks wrong:

```typescript
subagent({ action: "doctor" })
```

### External terminal work

Use native `subagent` runs for unattended implementation, review, and gate work that needs managed isolation, durable artifacts, and process controls. Use `interactive_shell` for visible terminal work, alternate CLIs, trust prompts, and recovery.

A cooperating terminal runtime can register read-only external records through `pi-subagents/external-runs`. Records include the source, session, state, optional report path, and completion reason. They are observations only: pi-subagents does not start, stop, steer, or otherwise own the foreign process. Run unattended raw terminal agents in an explicit isolated cwd or worktree; do not use a live project checkout as disposable review space.

### Scheduled subagent runs

Schedules are durable project records under `.pi/subagents/schedules/`. They are enabled by default; set `{ "scheduledRuns": { "enabled": false } }` in `~/.pi/agent/extensions/subagent/config.json` to disable them. Only schedule explicit work the user asked for.

```typescript
// One-shot reviewer
subagent({ action: "schedule.create", id: "evening-review", name: "Evening review", at: "+30m", workflowScript: "return runs.run('main', { agent: 'reviewer', task: 'Review the diff.' })" })

// Fixed recurring workflow
subagent({ action: "schedule.create", id: "backlog", every: "6h", catchUp: "latest", workflowScript: "..." })

subagent({ action: "schedule.list" })
subagent({ action: "schedule.show", id: "backlog" })
subagent({ action: "schedule.history", id: "backlog" })
subagent({ action: "schedule.pause", id: "backlog" })
subagent({ action: "schedule.resume", id: "backlog" })
subagent({ action: "schedule.run", id: "backlog" })
subagent({ action: "schedule.run-due" })
subagent({ action: "schedule.delete", id: "backlog" })
```

`schedule.create` accepts exactly one target, `workflowScript`, and exactly one trigger (`at`, or a fixed `every` interval using `m`, `h`, `d`, or `w`). Runs always launch async with fresh context and no automatic mission; mission attachment is deferred from this first slice. `overlap` is currently `skip`; `catchUp` supports `latest` and `none`. `schedule.run-due` is the headless external-launcher seam. Calendar recurrence, cron, and the schedule inspector are deferred from this first safe slice. Definitions, bounded history, append-only events, and per-run receipts remain project-scoped across Pi sessions.

Humans can use `/subagents-doctor` for the same read-only report. It checks runtime paths, discovery counts, async support, current session context, and intercom bridge state.

### Subagent control

Subagent control is the runtime visibility and intervention layer for delegated runs. It is separate from lifecycle status. Lifecycle status says whether a child is `queued`, `running`, `paused`, `complete`, `stopped`, `failed`, or `rejected`. Activity reporting is factual: it tracks the last observed activity time and the current tool when known. It does not pretend to know that a child is truly stuck. Manual top-level async cancellation uses `stop` / `/subagents-stop`.

Default behavior is intentionally conservative. When no activity has been observed past the configured threshold, the run emits a `needs_attention` control event. Foreground runs can push this as a `subagent:control-event` event, and async runs persist it to `events.jsonl` so the parent tracker can surface it without constant manual polling. Notification-worthy control events are also inserted into the visible transcript so both the user and the parent agent can see them, with a proactive hint plus concrete `nudge`, `status`, and `interrupt` options. Visible notifications fire once per child run and attention state.

Use soft interrupt when a child is clearly blocked or drifting and the parent needs to regain control:

```typescript
subagent({ action: "interrupt" })
```

Pass `id` when targeting a specific controllable run, including a nested run shown in the parent status tree:

```typescript
subagent({ action: "interrupt", id: "abc123" })
subagent({ action: "interrupt", id: "nested-run-id" })
```

A soft interrupt cancels the current child turn and leaves the run paused. It does not mean the delegated task succeeded or failed. Bare `interrupt` does not target hidden nested descendants; use the explicit nested id. After an interrupt, decide the next explicit action: resume with clearer instructions, replace the task, ask the user, or stop the workflow.

Per-run control thresholds can be overridden when a task legitimately runs without observable output for longer than usual:

```typescript
subagent({
  workflowScript: `return runs.run("slow-tests", {
    agent: "worker",
    task: "Run the slow migration test suite",
    control: {
      needsAttentionAfterMs: 300000,
      notifyOn: ["needs_attention"]
    }
  })`
})
```

If the run already has an active intercom bridge target, needs-attention notifications can also prepare a compact intercom ping for the orchestrator. When a child route is available, the ping tells the orchestrator which agent needs attention and includes the exact `intercom({ action: "send", to: "..." })` target for a nudge. Do not invent a target or ask the child to self-report when no bridge exists.

Steering is acknowledged delivery, not a send attempt or model-compliance signal:

```typescript
subagent({ action: "steer", id: "abc123", message: "Focus on the failing test." })
```

The action waits up to three seconds for the child Pi session to accept the correlated user input and returns a request id with `delivered`, `scheduled`, `pending`, `partial`, `recovered`, or `failed` plus per-child states. Indexed pending children return `scheduled` immediately. Only a top-level single-child run may automatically interrupt after a missed acknowledgment and recover after confirmed pause within a further 15 seconds. Recovery preserves the original child contract and only its remaining deadline, turn, and tool budgets. If the session is missing, a budget is exhausted, the pause cannot be confirmed, or replacement launch fails, the source remains paused when pausing succeeded and the action returns the exact failure. Chain, parallel, and nested runs never auto-interrupt; inspect their per-child outcomes and handle failures explicitly. A late acknowledgment is recorded and cannot cancel committed recovery.

## Watchdog

The subagent watchdog is an **opt-in** adversarial change reviewer. It is not the
`reviewer` subagent and is not configured by `subagents.defaultModel` or
`agentOverrides.reviewer`.

When enabled, it reviews actual repo edits at safe `agent_end` boundaries only if
the final worktree state changed during that turn. Unchanged or reverted diffs and
generated `.pi/subagents/` / temp artifacts do not trigger review. Writing children
can review their own worktree; the parent can still review the aggregate diff after
child changes land. Enabled watchdogs also run changed-file TypeScript/JavaScript
LSP diagnostics before the model pass when `typescript-language-server` is available.
They keep bounded current-scope context from real user prompts (`watchdog.scope.enabled`)
and can optionally run non-blocking Scopey-style cadence reviews every N tool results
(`watchdog.cadence.everyNTools`). Cadence corrections and blocker auto-follow prompts
are always transcript-visible; choose the watchdog model that matches the desired
cheap-monitor vs strong-reviewer policy.

Prefer a strong complementary model (for example Opus 4.8 high paired against a
GPT 5.5 main session, or the reverse). Recommendation and configuration:

```text
/subagents-watchdog recommend-model
/subagents-watchdog session model recommended
/subagents-watchdog on
/subagents-watchdog status
/subagents-watchdog check
```

```typescript
subagent({ action: "watchdog.status" })
subagent({ action: "watchdog.recommend-model" })
subagent({ action: "watchdog.configure", model: "recommended", scope: "session" })
subagent({ action: "watchdog.check" })
```

`session` scope is temporary. Persistent `user`/`project` scopes write settings only
when the user asked. Use ordinary fresh-context `reviewer` fanout for planned review
waves; enable the watchdog when you want an automatic second pass on real edits.

## Missions and cross-project routing

Missions are the durable orchestration layer. Use this noun map:

- **Project/codebase** — where work happens.
- **Mission** — why delegated work exists and how to recover it later.
- **Run** — one actual subagent execution.
- **Receipt** — proof or a link for an external outcome, such as a PR, CI check, deployment, or release.

Ordinary launches with a task create a mission by default, so substantial delegated work has a persisted objective, status, run links, decisions, artifacts, and delivery receipts that survive compaction or a new parent chat. Automatic persistence failures leave the run intact and set `details.missionWarning`; explicit `missionId` or `mission` remains strict before launch. Human receipts end with a mission id/status line, while structured JSON text remains untouched and `details.missionId` is authoritative. Pass `missionId` to attach an existing mission, use `mission: { title, objective?, goal?, budget?, labels? }` to control the auto-created record, pass `mission: false` for intentionally ephemeral work, or set `missions.enabled: false` to opt out globally. `objective` is the intent string; `goal: true` requires `budget.tokens` and turns the open mission into a continuation driver that sends one needs-attention notice after idle parent turns until the budget is exhausted, the goal is paused with `mission.update` `{ goal: { paused: true } }`, or the mission closes.

Use `mission.update` while work runs to record decisions, artifacts, labels, summaries, or delivery receipts. A receipt records a pull request, CI, deployment, or release link with a concise status; it does not authorize or automate merge, CI polling, or deployment. Record open product, architecture, or safety decisions there and escalate them upward; do not let a child decide silently. Use `mission.attach-run` only for runs launched outside the normal mission-backed path, and use `mission.close` with a terminal status and concise summary when the mission is done.

### Mission use policy

- **Keep the default.** Every ordinary `workflowScript` launch with a task creates one enclosing mission automatically. All workflow children share it and never get their own. Do not add `mission: {...}` boilerplate. Pass it only to set the title, objective, labels, or to enable `goal` with `budget`.
- **Use `mission: false` for noise.** Use it for trivial one-shot lookups, scouts, disposable probes, and quick validation where a recovery record is noise. It removes the mission and the `state` global for the whole workflow, so do not use it for monitors or multi-workflow loops that coordinate through `state`. Scheduled runs already launch without automatic missions.
- **Use `missionId` for follow-up work.** Attach later work to an existing objective with `missionId`; attachment re-marks the mission active. `missionId` and `mission` are mutually exclusive. Explicit attachment fails before launch if the mission is missing, while automatic missions degrade to `details.missionWarning` without blocking the run.
- **Keep `state` small.** Mission `state` is JSON coordination across workflows on the same mission. Keys use the same format as run keys, values must be JSON, and the whole state file is capped at 256 KiB. Each `set` merges one key under a file lock. Put large content in artifact files and store paths in state. In goal missions, write `state.set("nextReadyAction", "...")` so the next idle-turn notice names the exact ready step.
- **Use artifacts and receipts as evidence.** Mission-backed launches already record run artifacts such as async `status.json`, `events.jsonl`, child output paths, and handoff manifests. Add `mission.update` artifacts only for extra durable outputs such as `patch`, `review`, or `note` files. Add receipts for external outcomes: `pull_request`, `ci`, `deployment`, or `release`; each receipt needs an absolute URL. Receipts are evidence, not authority to merge, deploy, or release.
- **Resolve decisions explicitly.** `mission.update` `decisions` can only add open decisions; `mission.update` itself cannot resolve one — use the `mission.resolve-decision` action (decision `id` plus a non-empty `summary`) to settle and close it. In a goal mission, an unresolved decision becomes the fallback next ready action in each notice. Use decisions sparingly there; record them for escalation and audit, steer goal continuation through `state.nextReadyAction`, and close the mission when the question is settled.
- **Close missions when done.** `mission.close` takes `missionStatus` `completed`, `failed`, or `cancelled` plus a concise `summary`, and ends any goal loop. Goal notices go only to the owning session and stop silently at `budget-exhausted` without closing or claiming success, so close explicitly. Terminal missions are pruned beyond configured retention, so store durable outputs as artifacts, receipts, and summary before closing.

After compaction, restart, or confusing history, recover from durable state first: `mission.list` in the project, `mission.list` with `missionScope: "global"` for the user-local cross-project pointer index, then `mission.show` for the relevant mission. `mission.show` refreshes linked async status when available and returns warnings instead of hiding the mission if a linked status file is temporarily unreadable. Use the linked run ids with normal `status`, `steer`, `resume`, or `stop` actions. Project mission JSON remains authoritative over chat history.

Routing rule:
- Same project: ordinary mission-backed subagents.
- Different project, small/bounded task: ordinary async subagent with explicit `cwd`, an authority boundary, and durable output.
- Several projects with independent work: one async `workflowScript` whose child keys include repo slugs and whose child calls set explicit `cwd`; keep publication and merge decisions serial per repo.
- Different project, substantial or long-running work: open a project-owned Herdr pane rooted there when a separate visible project session is useful, then give that project Pi session a narrow mission/result contract. Do not model it as ordinary child nesting, and do not expect existing headless runs to move into the pane.

Project panes run a separate Pi session from the target directory. Subagents launched inside that pane use that project's config, agents, skills, files, git state, and mission records. The pane binding lives under `<projectRoot>/.pi/subagents/project-panes/herdr.json`. When Pi runs inside Herdr, the owning pane reports compact active-work status and title suffixes, and the parent inline status counts opened project panes. Use Herdr itself or `project.status` / `project.close` for pane-level follow-up. For ordinary headless delegation to another repo, prefer explicit `cwd` first; reserve project panes for visible or persistent project ownership.

```typescript
subagent({ action: "mission.create", mission: { title: "Ship auth refresh", objective: "Implement and validate refresh handling" } })
subagent({ workflowScript: `return runs.run("main", { agent: "worker", task: "Implement the approved plan" })`, missionId: "<mission-id>" })
subagent({ workflowScript: `return runs.run("main", { agent: "scout", task: "Quickly answer whether this file exists" })`, mission: false })
subagent({ action: "mission.list", missionScope: "global" })
subagent({ action: "mission.resolve-decision", missionId: "<mission-id>", id: "<decision-id>", summary: "Settled: ship the v2 API; no schema freeze needed." })
subagent({ action: "project.open", cwd: "/path/to/other-repo", message: "Own this mission for the project and report back with receipts." })
subagent({ action: "project.status", cwd: "/path/to/other-repo" })
subagent({ action: "project.close", cwd: "/path/to/other-repo" })
subagent({ action: "mission.close", missionId: "<mission-id>", missionStatus: "completed", summary: "Auth refresh shipped and tests pass." })
```

## Worktree Isolation

When multiple agents might write concurrently, use worktrees instead of letting
them share one filesystem view.

```typescript
subagent({
  workflowScript: `
    const results = await runs.all([
      { key: "feature-a", agent: "worker", task: "Implement feature A", worktree: true },
      { key: "feature-b", agent: "worker", task: "Implement feature B", worktree: true }
    ]);
    return results.map(({ key, artifactPaths }) => ({ key, artifactPaths }));
  `
})
```

`worktree: true` on a `runs.run` / `runs.all` item gives that child its own git
worktree branched from HEAD. A top-level workflow `worktree: true` makes this the
default for every child, and a child can opt out with `worktree: false`. This
requires a clean git state and is mainly for intentionally parallel write
workflows. On completion, use each child's handoff path from its
`artifactPaths` instead of scraping combined text. Each manifest records child status and output references, full
patch paths and stats, and whether each temporary worktree and branch was
removed. The manifest is journaled immediately after managed worktree setup, before children run, so abrupt exits retain owned paths and branches for recovery. Dirty or divergent work without a successfully captured patch is preserved with a partial-cleanup warning. Permanently discard recorded preserved work with `subagent({ action: "worktree.discard", handoffPath: "<child handoff path>" })`; authority defaults to interactive confirmation and refuses headlessly, and partial results print manual Git recovery commands. If you want one writer thread and several advisory agents, prefer a
single-writer pattern instead.

Git worktrees start from tracked files, so ignored or untracked build state
such as `node_modules` may be absent. The clean-check ignores pi-subagents'
own `.pi/subagents/` runtime state, including default mission records, but still
rejects ordinary source/config changes. `pi-subagents` attempts to symlink the
root checkout's `node_modules` into each managed worktree when it exists, but
agents should still treat dependency setup as an explicit bootstrap step before
running tests, typecheck, or builds. If module resolution fails in a fresh
worktree, first confirm dependencies were linked, installed, or provisioned by
`worktreeSetupHook` before treating it as a code failure.

## The Oracle Workflow

### Oracle consultation loop

For plan, design, or architecture advice that asks to ask, consult, discuss with, or come to agreement with `oracle`, start with one forked oracle run. Read its result. If it challenges the direction or leaves a material tradeoff, resume that same completed child once with a focused follow-up, then synthesize the parent decision. `resume` returns a new run id, but continues the same oracle session and inherited context. Do not force a second round for an explicit one-shot request, a trivial question, or a fully settled first answer.

```typescript
const first = await runs.run("oracle-consult", { agent: "oracle", task: "Review this plan and identify the strongest unresolved tradeoff." });
const final = await runs.run("oracle-consult-follow-up", { resume: first.runId, task: "Address this focused question, then state the best recommendation: ..." });
```

The parent remains the final decision-maker. Oracle advice does not approve a direction or start implementation.

The intended oracle loop is:
1. the main agent forks to `oracle`
2. `oracle` reviews direction, drift, assumptions, and risks
3. `oracle` can coordinate back through `contact_supervisor` when the bridge injects it
4. the main agent decides what direction to approve
5. only then should `worker` implement

```typescript
// Advisory review in a branched thread. Oracle defaults to forked context.
subagent({
  workflowScript: `return runs.run("oracle-check", { agent: "oracle", task: "Review my current direction, challenge assumptions, and propose the best next move." })`
})

// Implementation only after explicit approval. Worker defaults to forked context.
subagent({
  workflowScript: `return runs.run("implementation", { agent: "worker", task: "Implement the approved approach: ..." })`
})
```

`oracle` is not a fresh-context reviewer in the Cognition article sense. It is
a forked advisory thread that inherits the parent session history and uses that
history as a baseline contract.

Use `oracle` as a smart-friend escalation when the parent needs help with trajectory rather than diff inspection: architectural boundaries, model capability routing, merge conflicts, reviewer disagreement, context drift after long work, a worker about to invent a pattern, or fixes that require product/scope tradeoffs. Ask broad questions when the right concern is unclear, and let `oracle` point out missing context or files the parent should inspect before asking again. Keep `oracle` advisory unless it has been explicitly assigned the single writer role.

## Subagent + Intercom Coordination

`pi-subagents` includes native supervisor coordination. Child agents can use `contact_supervisor` to ask the exact parent session that spawned them; messages are scoped by parent session id and should not appear in other Pi sessions. Parents inspect or reply with `subagent_supervisor`. This path does not require `pi-intercom`.

This is separate from optional external completion delivery. Set `intercomBridge.resultDelivery: true` only when an external listener consumes and acknowledges `subagent:result-intercom` grouped results. It does not deliver results by itself, and it does not change native supervisor asks or progress updates.

Generic `intercom` is external or provider-supplied only. Native supervisor coordination injects `contact_supervisor`, not generic `intercom`. Use generic `intercom` only when external bridge instructions provide an explicit safe target. Do not invent a target. Prefer the tool from the injected bridge instructions.

Use `contact_supervisor` with `reason: "need_decision"` when:
- a subagent is blocked on a decision
- a child needs clarification instead of guessing
- an approval, product, API, or scope choice is required before continuing safely

Use `contact_supervisor` with `reason: "interview_request"` when the child needs structured supervisor input rather than a freeform answer. The request waits for a parent reply, so the child should stay alive and continue only after the reply arrives.

Do not use `contact_supervisor` just to resolve review-only/no-project-edit versus progress-writing or output-artifact instructions. The child must not modify project/source files, but returning findings through its normal response or configured output artifact is allowed unless the parent explicitly set `output: false`.

Use `contact_supervisor` with `reason: "progress_update"` when:
- a child is explicitly asked for progress
- a meaningful discovery changes the plan
- a long-running child needs to report a blocked/progress checkpoint without waiting for normal tool return flow

Message conventions:
- `reason: "need_decision"` and `reason: "interview_request"` wait for the parent reply and return it to the child.
- `reason: "progress_update"` is non-blocking and should stay concise.
- Child-side routine completion handoffs are not expected. Native supervisor messages are for decisions, structured input, and meaningful progress updates while a child is still running.

If bridge instructions provide the child-facing tool, a child can ask:

```typescript
contact_supervisor({
  reason: "need_decision",
  message: "Should I optimize for readability or performance here?"
})
```

The parent replies with the native supervisor tool:

```typescript
subagent_supervisor({ action: "reply", message: "Optimize for readability." })
```

Or inspects unresolved asks first:

```typescript
subagent_supervisor({ action: "pending" })
```

Native supervisor coordination does not expose generic `intercom` as a fallback. Use `subagent_supervisor` for parent replies.

If intercom messages do not show up, run `subagent({ action: "doctor" })` or `/subagents-doctor`.
