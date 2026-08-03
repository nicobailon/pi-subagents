# Pi Subagents: Execution Controls

This file is a detailed reference loaded from `skills/pi-subagents/SKILL.md`.

## Discovery and Scope Rules

Agent files can live in:
- `~/.pi/agent/agents/**/*.md` — user scope
- `.pi/agents/**/*.md` — canonical project scope
- legacy `.agents/**/*.md` — still read for compatibility, but `.pi/agents/` wins on conflicts

Chains live in:
- `~/.pi/agent/chains/**/*.chain.md` and `~/.pi/agent/chains/**/*.chain.json` — user scope
- `.pi/chains/**/*.chain.md` and `.pi/chains/**/*.chain.json` — project scope

Discovery is recursive. `.chain.md` files do not define agents. Use `.chain.md` for simple saved chains and `.chain.json` for dynamic fanout or inline schema objects. Agents and chains can set optional frontmatter/package metadata; `name: scout` plus `package: code-analysis` registers as runtime name `code-analysis.scout` while serialization keeps `name` and `package` separate.

Precedence is by parsed runtime name:
1. project scope
2. user scope
3. builtin agents

Project settings resolve from the nearest parent directory containing `.pi` or `.agents` by default. In monorepos or git worktrees where an incidental nested `.pi` directory should not shadow the repository config, set `subagents.projectRootResolution: "git-root"` in the repository root `.pi/settings.json`; a nested project can opt back with `"nearest"` in its own settings.

## Running Subagents

### Single agent

```typescript
subagent({
  agent: "oracle",
  task: "Review my current direction and challenge assumptions."
})
```

### Forked context

```typescript
subagent({
  agent: "oracle",
  task: "Review my current direction and challenge assumptions.",
  context: "fork"
})
```

`context: "fork"` creates a branched child session from the current persisted
parent session. It does **not** create a fresh minimal review context or filter
history down to only the relevant parts. Use it when you want a separate review
or execution thread that can still reference the parent session history.

Foreground results, async status, fleet, and widget surfaces label each child with
its resolved launch context as `[fresh]` or `[fork]`. Aggregate headers show
`[mixed]` when a run uses both modes.

### Parallel execution

```typescript
subagent({
  tasks: [
    { agent: "scout", task: "Explore the auth module" },
    { agent: "reviewer", task: "Review the API client" }
  ]
})
```

Top-level parallel tasks can override per-task behavior:

```typescript
subagent({
  tasks: [
    { agent: "scout", task: "Map auth", output: "auth-context.md", progress: true },
    { agent: "researcher", task: "Research OAuth best practices", output: "oauth-research.md" },
    { agent: "reviewer", task: "Review auth tests", model: "anthropic/claude-sonnet-4" }
  ],
  concurrency: 3
})
```

Repeat one parallel task N times with the same settings via `count` (useful for identical scouts or review angles without hand-duplicating entries):

```typescript
subagent({
  tasks: [
    { agent: "scout", task: "Map a distinct slice of the auth surface and return compressed context.", count: 3 }
  ],
  concurrency: 3,
  context: "fresh"
})
```

Avoid duplicate output paths in parallel tasks. Concurrent children should not write to the same file. For large saved outputs, set `outputMode: "file-only"` together with an `output` path. The parent result then contains only a compact reference like `Output saved to: /abs/report.md (48.2 KB, 2847 lines). Read this file if needed.` instead of the full saved content. Do not use `output: false` for this; `output: false` means no file output. In chains, relative `output` paths are chain-artifact paths under `{chain_dir}`, not project CWD paths; use an absolute `output` path or a persistent `chainDir` when a saved artifact must outlive the temp chain directory. Read-only children return the complete artifact in their final response and the runtime persists it, so missing write tools are not a supervisor blocker. Mutation-capable children still receive direct-write instructions. Failed runs and save errors still return inline details for debugging.

### Chain execution

```typescript
subagent({
  chain: [
    { agent: "scout", task: "Map the auth flow and summarize key files" },
    { agent: "planner", task: "Create an implementation plan from {previous}" },
    { agent: "worker", task: "Implement the approved plan based on {previous}" }
  ]
})
```

Chain steps can use templated variables such as `{task}`, `{previous}`,
`{chain_dir}`, and `{outputs.name}`. Use `as: "name"` on a successful step or
parallel task to make that output available to later steps. Prefer named outputs
when a later step needs one specific result; keep `{previous}` for simple linear
handoffs or full fan-in summaries. Use `phase` and `label` for status readability.
Use `outputSchema` when later steps need reliable structured data; the child must
call `structured_output` with schema-valid JSON, or the step fails.

Use `agentContract: { version: 1 }` when a caller needs generic result projections
instead of acceptance or mutation effects rewriting execution success. V1 adds
`execution`, `acceptance`, `review`, and `effects`; omitted acceptance means no
acceptance request. Chain steps advance on execution by default under v1. Set
`gateOn: "acceptance"` only when a rejected explicit acceptance report should stop
the chain.

### Async/background

Prefer async mode for every subagent launch. Set `async: true` no matter the task unless there is a specific reason to opt into a foreground/blocking run. This applies to scouts, researchers, workers, reviewers, validators, oracle checks, one-off delegates, chains, and parallel groups. Keep the write path single-threaded even when the run is async.

Async does not mean parallel writes. Do not edit the same active worktree while an async worker is changing it. Parent-side overlap should be reading, validation prep, synthesis, command planning, or review of unaffected context unless the writer is isolated in a separate worktree.

Do not end your turn immediately after launching an async child if you promised to keep working. Continue the local inspection, synthesis, or validation prep, then check the async run when its result is needed.

In an interactive chat, normally return control when ready to yield and let Pi wake the session on completion; do not call `subagent_wait()` merely to wait. Override that default and call it when the current request is run-to-completion — for example, the user asked you to report results back before continuing or a skill cannot return before its background work finishes. Headless sessions auto-drain exact current-session work at `agent_end`; call `subagent_wait()` when this turn must receive results before it ends. Never substitute sleep or status-polling loops.

`subagent_wait()` returns when the next initially active async run or registered provider item finishes or a subagent needs attention. Use `subagent_wait({ all: true })` for all work active at call time, `subagent_wait({ id: "..." })` for one async or remembered detached foreground run, and `subagent_wait({ timeoutMs })` to cap the block. If a foreground child detaches for supervisor coordination, reply first, then wait on its id; do not resume or launch a replacement while it remains detached. Headless sessions also auto-drain exact current-session work at `agent_end` as a final safeguard.

```typescript
subagent({
  agent: "worker",
  task: "Run the full test suite",
  async: true
})
```

File-only output mode also works for async single runs, top-level parallel task items, sequential chain steps, and chain parallel task items. In chains, `{previous}` receives the compact saved-file reference when the prior step used file-only mode. Relative chain output paths are resolved under `{chain_dir}`; pass a persistent `chainDir` or an absolute `output` path when a later human or process needs a stable path outside the temp chain run.

For review fanout where the parent continues a local audit:

```typescript
const run = subagent({
  agent: "reviewer",
  task: "Review the current diff for correctness issues. Do not edit files.",
  async: true,
  context: "fresh"
})
// Continue local inspection, then later call status with the returned id.
```

While children run, the persistent FleetView and the collapsed foreground tool-result card show live per-child detail: resolved model and thinking level, `[fresh]`/`[fork]` context, tool/token/elapsed counters, and current activity. The collapsed running card also prints the configured expand-key hint ("Press … for live detail"); expanding it shows nested children, recent tools, and recent output. Model badges appear once the child's model resolves at first attempt start. `/subagents-fleet` opens the live fleet inspector, which also has per-child controls (`s` steer, `D` stop with confirmation). When optional Herdr 0.7.5+ is available, `H` opens a raw inspector dashboard for the selected active async child; this mirrors artifacts rather than attaching to the headless child. Use it for confusing or long-running active async work when the human wants a dedicated visual pane or FleetView is insufficient, not for routine headless runs.

Inspect async runs with `subagent({ action: "status", id: "..." })` or `subagent({ action: "status" })` for active runs. Use `subagent({ action: "status", view: "fleet" })` when supervising several active foreground/background runs and `subagent({ action: "status", id: "...", view: "transcript", index: 0 })` when you need the latest child output without digging through artifacts. If a delegated fanout child launches nested runs, the parent status view shows them as a tree and you can target a nested run directly with its nested id.

Stop a current-session top-level async run with `stop` (or `/subagents-stop`). Stopped runs finish as `stopped`/cancelled and are not resumable. For an active foreground single-subagent run, `/subagents-detach [run-id]` leaves the child running without terminating it and returns the eventual result through status/wait. Append one more step to the tail of a still-running async chain with `append-step` (`chain` must contain exactly one step). Use checkpoint steps for planned human gates; they pause without launching a child and are approved or rejected through current-session control actions:

```typescript
subagent({ action: "stop", id: "run-id" })
subagent({
  action: "append-step",
  id: "run-id",
  chain: [{ checkpoint: "review", message: "Approve the next implementation step?" }]
})
subagent({ action: "approve-checkpoint", id: "run-id" })
subagent({ action: "reject-checkpoint", id: "run-id" })
```

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

### Scheduled subagent runs

Scheduled runs defer a subagent launch until a future time. They are opt-in and require `{ "scheduledRuns": { "enabled": true } }` in `~/.pi/agent/extensions/subagent/config.json`. Only schedule explicit delayed runs the user asked for; do not schedule runs speculatively.

```typescript
// Launch a reviewer in 30 minutes
subagent({ action: "schedule", agent: "reviewer", task: "Review the diff for correctness issues.", schedule: "+30m", scheduleName: "evening review" })

// Schedule a parallel fanout
subagent({ action: "schedule", tasks: [{ agent: "scout", task: "Map the auth module" }, { agent: "scout", task: "Map the billing module" }], schedule: "+1h" })

// Inspect, list, and cancel
subagent({ action: "schedule-list" })
subagent({ action: "schedule-status", id: "ab12" })
subagent({ action: "schedule-cancel", id: "ab12" })
```

`schedule` accepts the same execution fields as a normal async run (`agent`/`tasks`/`chain`, `cwd`, `model`, `output`, `reads`, `progress`, `acceptance`, `timeoutMs` / `maxRuntimeMs`) plus `schedule` (a relative delay like `+10m`/`+2h`/`+1d` or a future ISO timestamp with a timezone such as `2030-01-01T09:00:00Z`) and an optional `scheduleName`. Scheduled runs always launch async with fresh context; `context: "fork"`, `async: false`, and `clarify: true` are rejected. Once the timer fires, the run becomes a normal tracked async run: it appears in the async widget, is inspectable with `subagent({ action: "status" })`, can be awaited with `subagent_wait()`, and delivers the normal completion notification.

Schedules are persisted per session and restored after a Pi restart. A job whose scheduled time passed by more than `scheduledRuns.maxLatenessMs` (default 5 minutes) while Pi was unavailable is marked `missed` instead of firing late. `scheduledRuns.maxPending` (default 20) caps pending or running scheduled jobs per session.

Humans can use `/subagents-doctor` for the same read-only report. It checks runtime paths, discovery counts, async support, current session context, and intercom bridge state.

### Subagent control

Subagent control is the runtime visibility and intervention layer for delegated runs. It is separate from lifecycle status. Lifecycle status says whether a child is `queued`, `running`, `paused`, `complete`, `stopped`, `failed`, or `rejected`. Activity reporting is factual: it tracks the last observed activity time and the current tool when known. It does not pretend to know that a child is truly stuck. Manual top-level async cancellation uses `stop` / `/subagents-stop`; a live async chain can gain one more tail step via `append-step`, and a paused async chain checkpoint can be decided with `approve-checkpoint` or `reject-checkpoint`.

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
  agent: "worker",
  task: "Run the slow migration test suite",
  control: {
    needsAttentionAfterMs: 300000,
    notifyOn: ["needs_attention"]
  }
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
generated `.pi-subagents/` / temp artifacts do not trigger review. Writing children
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

## Clarify TUI

Single and parallel runs support a clarification TUI when you want to preview or
edit parameters before launch:

```typescript
subagent({
  agent: "worker",
  task: "Implement feature X",
  clarify: true
})
```

Ordinary tool calls launch in the background by default. Set `async: false` when the current turn needs a foreground result, or `clarify: true` when you want the clarify UI; clarify always stays foreground. Clarify edits affect only the next run; use management actions, settings, or markdown files for persistent changes.

## Missions and cross-project routing

Missions are the durable orchestration layer. Use this noun map:

- **Project/codebase** — where work happens.
- **Mission** — why delegated work exists and how to recover it later.
- **Run** — one actual subagent execution.
- **Receipt** — proof or a link for an external outcome, such as a PR, CI check, deployment, or release.

Ordinary launches with a task create a mission by default, so substantial delegated work has a persisted goal, status, run links, decisions, artifacts, and delivery receipts that survive compaction or a new parent chat. Automatic persistence failures leave the run intact and set `details.missionWarning`; explicit `missionId` or `mission` remains strict before launch. Human receipts end with a mission id/status line, while structured JSON text remains untouched and `details.missionId` is authoritative. Pass `missionId` to attach an existing mission, use `mission: { title, goal?, labels? }` to control the auto-created record, pass `mission: false` for intentionally ephemeral work, or set `missions.enabled: false` to opt out globally.

Use `mission.update` while work runs to record decisions, artifacts, labels, summaries, or delivery receipts. A receipt records a pull request, CI, deployment, or release link with a concise status; it does not authorize or automate merge, CI polling, or deployment. Record open product, architecture, or safety decisions there and escalate them upward; do not let a child decide silently. Use `mission.attach-run` only for runs launched outside the normal mission-backed path, and use `mission.close` with a terminal status and concise summary when the mission is done.

After compaction, restart, or confusing history, recover from durable state first: `mission.list` in the project, `mission.list` with `missionScope: "global"` for the user-local cross-project pointer index, then `mission.show` for the relevant mission. `mission.show` refreshes linked async status when available and returns warnings instead of hiding the mission if a linked status file is temporarily unreadable. Use the linked run ids with normal `status`, `steer`, `resume`, or `stop` actions. Project mission JSON remains authoritative over chat history.

Routing rule:
- Same project: ordinary mission-backed subagents.
- Different project, small/bounded task: ordinary subagent with explicit `cwd`.
- Different project, substantial or long-running work: a project-owning orchestrator session rooted there, with a narrow mission and return contract. Do not model it as ordinary child nesting. Phase 1 does not launch this session automatically, and the Herdr inspector is not this orchestrator.

```typescript
subagent({ action: "mission.create", mission: { title: "Ship auth refresh", goal: "Implement and validate refresh handling" } })
subagent({ agent: "worker", task: "Implement the approved plan", missionId: "<mission-id>" })
subagent({ agent: "scout", task: "Quickly answer whether this file exists", mission: false })
subagent({ action: "mission.list", missionScope: "global" })
subagent({ action: "mission.close", missionId: "<mission-id>", missionStatus: "completed", summary: "Auth refresh shipped and tests pass." })
```

## Worktree Isolation

When multiple agents might write concurrently, use worktrees instead of letting
them share one filesystem view.

```typescript
subagent({
  tasks: [
    { agent: "worker", task: "Implement feature A" },
    { agent: "worker", task: "Implement feature B" }
  ],
  worktree: true
})
```

`worktree: true` gives each parallel task its own git worktree branched from
HEAD. This requires a clean git state and is mainly for intentionally parallel
write workflows. On completion, use the versioned aggregate handoff at
`parallelHandoff.path` from foreground details or async status/results instead of scraping the combined
text. Its versioned manifest records child status and output references, full
patch paths and stats, and whether each temporary worktree and branch was
removed. The manifest is journaled immediately after managed worktree setup, before children run, so abrupt exits retain owned paths and branches for recovery. Dirty or divergent work without a successfully captured patch is preserved with a partial-cleanup warning. Permanently discard recorded preserved work with `subagent({ action: "worktree.discard", handoffPath: "<parallelHandoff.path>" })`; authority defaults to interactive confirmation and refuses headlessly, and partial results print manual Git recovery commands. If you want one writer thread and several advisory agents, prefer a
single-writer pattern instead.

Git worktrees start from tracked files, so ignored or untracked build state
such as `node_modules` may be absent. The clean-check ignores pi-subagents'
own `.pi-subagents/` runtime state, including default mission records, but still
rejects ordinary source/config changes. `pi-subagents` attempts to symlink the
root checkout's `node_modules` into each managed worktree when it exists, but
agents should still treat dependency setup as an explicit bootstrap step before
running tests, typecheck, or builds. If module resolution fails in a fresh
worktree, first confirm dependencies were linked, installed, or provisioned by
`worktreeSetupHook` before treating it as a code failure.

## The Oracle Workflow

The intended oracle loop is:
1. the main agent forks to `oracle`
2. `oracle` reviews direction, drift, assumptions, and risks
3. `oracle` can coordinate back through `contact_supervisor` when the bridge injects it
4. the main agent decides what direction to approve
5. only then should `worker` implement

```typescript
// Advisory review in a branched thread. Oracle defaults to forked context.
subagent({
  agent: "oracle",
  task: "Review my current direction, challenge assumptions, and propose the best next move."
})

// Implementation only after explicit approval. Worker defaults to forked context.
subagent({
  agent: "worker",
  task: "Implement the approved approach: ..."
})
```

`oracle` is not a fresh-context reviewer in the Cognition article sense. It is
a forked advisory thread that inherits the parent session history and uses that
history as a baseline contract.

Use `oracle` as a smart-friend escalation when the parent needs help with trajectory rather than diff inspection: architectural boundaries, model capability routing, merge conflicts, reviewer disagreement, context drift after long work, a worker about to invent a pattern, or fixes that require product/scope tradeoffs. Ask broad questions when the right concern is unclear, and let `oracle` point out missing context or files the parent should inspect before asking again. Keep `oracle` advisory unless it has been explicitly assigned the single writer role.

## Subagent + Intercom Coordination

`pi-subagents` includes native supervisor coordination. Child agents can use `contact_supervisor` to ask the exact parent session that spawned them; messages are scoped by parent session id and should not appear in other Pi sessions.

Most agents should not call generic `intercom` directly unless bridge instructions provide a target and `contact_supervisor` is unavailable. Do not invent a target. Prefer the tool from the injected bridge instructions.

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

If no external `pi-intercom` tool owns the `intercom` name, native supervisor coordination may also expose `intercom` as a compatibility fallback. Prefer `subagent_supervisor` for parent replies because it never overrides installed `pi-intercom`.

If intercom messages do not show up, run `subagent({ action: "doctor" })` or `/subagents-doctor`.
