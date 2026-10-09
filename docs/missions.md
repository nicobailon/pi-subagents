# Missions and schedules

Durable records for delegated work: missions wrap runs so you can recover them later, and schedules launch work on a timer.

## Missions

Missions are durable wrappers around runs. The noun map:

- **Project/codebase** — where work happens.
- **Mission** — why delegated work exists and how to recover it later.
- **Run** — one actual subagent execution.
- **Receipt** — proof or a link for an external outcome, such as a PR, CI check, deployment, or release.

Ordinary workflow launches create one enclosing mission by default, with detailed JSON records under `~/.pi/agent/missions/projects/<project-hash>/` linking objectives, run ids, lifecycle status, decisions, artifact paths, and delivery receipts. Workflow children do not create separate missions. Each workflow child attempt is stored in the enclosing mission with its stable workflow key, run id when known, agent, task metadata, timestamps, session and artifact paths, and latest status heartbeat.

Records created under the old default `<project>/.pi/subagents/missions` stay on disk. Continue them by setting `missions.directory` to that path for the project or by copying the record into the new agent-dir project store. There is no automatic migration.

Behavior:

- Automatic persistence failures do not block the run and are reported as `details.missionWarning`. Explicit `missionId` and `mission` requests remain strict before launch.
- Human receipts end with `Mission: <id> (<status>)`, while JSON/structured output text stays unchanged and `details.missionId` is authoritative.
- Pass `mission: false` for an intentionally ephemeral workflow. It creates no mission for the workflow or its children and has no `state` global.
- Set `missions.enabled: false` to disable automatic mission creation; explicit mission fields and actions still work.
- A workflow with a mission can use `await state.get(key)` and `await state.set(key, value)` for durable JSON state. Missing keys return `undefined`. Keys use the same format as `runs.run` keys. Each set takes the state-file lock, reads the latest file, merges the key, and atomically writes `<mission-directory>/<mission-id>/state.json`. The complete file cannot exceed 256 KiB. Each workflow caches the file on its first `get`. A `mission:false` workflow has no `state` global.

An explicit `mission` object must have exactly one non-empty `title` or `summary`. `objective` and `labels` are optional. When supplied, `goal` must be `true` and requires `budget: { tokens: <positive integer> }`.

```ts
const created = subagent({
  action: "mission.create",
  options: {
    mission: { title: "Ship auth refresh", objective: "Implement and validate token refresh" }
  }
})
// After a ```js workflow block that runs the approved auth refresh plan:
subagent({ workflow: true, options: { missionId: "<mission-id>" } })

// Or create and attach in one launch
subagent({ workflow: true, options: { mission: { title: "Ship auth refresh" } } })
```

### Goal missions

Set `goal: true` with a token budget to make an open mission an active continuation driver:

```ts
subagent({
  action: "mission.create",
  options: {
    mission: {
      title: "Ship auth refresh",
      objective: "Implement and validate token refresh",
      goal: true,
      budget: { tokens: 400000 }
    }
  }
})
```

After each parent turn, an idle goal mission sends one needs-attention notice with its title, remaining token budget, and next ready action. The action comes from `state.nextReadyAction`, `state.nextAction`, a state item with `status: "ready"`, an open decision, or linked-run state. A workflow can write `state.nextReadyAction` to tell the next notice exactly what work is ready. When the latest linked workflow has a resumable retained child, the notice names that child as the `resume` target. Non-resumable retained children stay visible in `children.list` with their reason, but goal notices do not present them as resume targets. The extension never launches or replans goal work by itself.

Linked-run token totals are stored on each run and folded into mission `usage`. An active linked run suppresses notices. Reaching the token budget changes the goal status to `budget-exhausted` and stops notices without closing the mission or reporting success.

Pause and resume notices with `mission.update` and `{ goal: { paused: true } }` or `{ goal: { paused: false } }`. Set `{ goal: false }` to disable goal mode. `mission.close` also ends the loop.

### Managing missions

Use `mission.list`, `mission.show`, `mission.update`, `mission.resolve-decision`, `mission.attach-run`, and `mission.close`.

- Use `mission.update` to record decisions, artifacts, labels, summaries, and delivery receipts while work runs. Adding a decision gates active or completed missions as `needs_decision`; planned and waiting missions keep their lifecycle status while the decision stays visible. Resolve it with `mission.resolve-decision`, `missionId`, the decision `id`, and a resolution in `summary`. A gated mission returns to `active` after its last open decision is resolved.
- `mission.show` includes each workflow child's latest status, phase, update time, session path metadata, and heartbeat. The ledger is a recovery record only. It does not schedule or restart children.
- Receipts are durable links for pull requests, CI, deployments, or releases, each with `kind`, `status`, `title`, `url`, and optional `description`. They record delivery state only; pi-subagents does not merge, poll CI, or deploy.
- Use `mission.close` with a terminal status and summary when a mission is done.
- After compaction or restart, resume from `mission.list`/`mission.show` first: `mission.show` refreshes linked async status where available, then use the linked run ids with normal `status`, `steer`, `resume`, or `stop` actions.
- `mission.list` with `missionScope: "global"` reads the user-local pointer index under the Pi agent directory. Project records remain the source of truth, and missing records are reported as stale rather than hiding other projects.

### Cross-project work

Keep same-project tasks on ordinary subagents. Use an explicit `cwd` for small bounded work in another project.

For substantial or long-running work in another project, open a project-owned Herdr pane with `project.open` and give that project Pi session a narrow mission/result contract (see [extension-api.md](extension-api.md#herdr-integration)). The project pane owns its own subagents; do not model it as ordinary child nesting or expect existing headless runs to move into the pane.

Mission storage configuration (`missions.directory`, `retainTerminal`, `globalIndex`) is in [configuration.md](configuration.md#missions).

## Schedules

Durable schedules are enabled by default and stored per project under `.pi/subagents/schedules/<id>/`.

Create a one-shot schedule:

```js workflow
return runs.run("main", { agent: "reviewer", task: "Review the current diff." });
```

```ts
subagent({
  action: "schedule.create",
  id: "evening-review",
  workflow: true,
  options: {
    name: "Evening review",
    at: "+30m",
    baseRef: "refs/heads/release"
  }
})
```

Create a fixed recurring workflow from a script file:

```ts
// .pi/workflows/backlog.js: return runs.run('main', { agent: 'worker', task: args.task })
subagent({ action: "schedule.create", id: "backlog", workflow: "./.pi/workflows/backlog.js", args: { task: "Maintain core" }, options: { every: "6h", catchUp: "latest" } })
```

Create a daily or weekly local-time schedule:

```ts
subagent({ action: "schedule.create", workflow: "./.pi/workflows/review.js", options: { every: "day", at: "09:00", timezone: "Asia/Taipei" } })
subagent({ action: "schedule.create", workflow: "./.pi/workflows/review.js", options: { every: "week", on: ["mon", "tue", "wed", "thu", "fri"], at: "09:00", timezone: "America/New_York" } })
```

Calendar schedules require `HH:mm` and an explicit IANA `timezone` or `UTC`. Weekly `on` is a non-empty weekday array; duplicates are removed and weekdays sorted. Daily schedules do not accept `on`. Missing local times and skipped dates are skipped; a repeated time fires at its first instant only. The pending local date is persisted with a UTC cache that is refreshed on restoration using the host's current timezone data. Use a calendar-capable version in every session sharing these definitions; older schedulers reject the unknown trigger kind.

Fixed intervals support `m`, `h`, `d`, and `w` units and advance from the planned time without completion drift. The schedule stores the script text read at creation, so later edits to the file do not change it. Schedule arguments are normalized and persisted for exact replay after reload; do not put secrets in them.

Create a quiet recurring workflow whose successful completions stay visible but do not wake the parent session:

```ts
subagent({ action: "schedule.create", id: "nightly-sweep", workflow: true, options: { every: "24h", quiet: true } })
```

Manage schedules with `schedule.list`, `schedule.show`, `schedule.history`, `schedule.pause`, `schedule.resume`, `schedule.run`, `schedule.run-due`, and `schedule.delete`.

Attach an existing mission to give each scheduled workflow access to the same durable `state.get/set`:

```ts
subagent({ action: "schedule.create", id: "backlog", workflow: "./.pi/workflows/backlog.js", options: { every: "6h", missionId: "<mission-id>" } })
```

The mission must be readable in the store resolved from the schedule's target `cwd` and current mission configuration. Creation checks it without changing its status. Every fire uses the normal explicit mission launch path, including after session restoration; missing or invalid records fail before workflow execution. Schedules accept only an existing `missionId`, not mission creation or updates. The script's fixed `args` and its mutable mission state remain separate.

Attachment uses ordinary mission lifecycle and retention rules. A non-goal mission can become terminal after a run, and the next fire reactivates it. `mission.close` does not pause the schedule; use `schedule.pause` or `schedule.delete` to stop future fires. A schedule does not protect its mission from terminal retention (default 200 records). If it is removed, later fires record `failed_launch` rather than creating a replacement. Open mission decisions and goal notice pause/budget settings do not gate schedule launches. Multiple schedules sharing a mission still have independent overlap controls; attachment does not serialize their workflows.

`missions.enabled:false` still permits explicit attachment; `disabledFeatures:["missions"]` rejects it. Each fire resolves the mission store using its target `cwd`, current mission configuration and Pi agent directory; the schedule does not pin the creation-time store. Sessions must resolve the same effective store to reuse the same state. Attachment does not search other worktrees or copy mission records; an explicitly shared `missions.directory` follows the existing storage rules.

Mission-bound definitions use schedule schema version 2 so older versions reject them instead of dropping the attachment. Existing unbound definitions keep version 1 and need no migration. A project using mission attachment should use a version that supports it in every scheduler session.

Behavior:

- Runs always launch async with fresh context. Without `missionId`, they disable mission creation and have no `state` global.
- Project-wide schedules (the default) fire in whichever Pi session in that project claims the fire first, and that session receives the run's notifications. Pass `sessionOnly: true` to bind restoration and every fire to the creating session; other sessions in the project never arm it.
- An optional top-level `baseRef` selects the safe Git ref used by managed worktrees (default `HEAD`); it is persisted with the schedule and forwarded on every fire. The source checkout must still be clean.
- Definitions, bounded history, append-only events, and per-run receipts are stored with mode `0600`.
- `overlap` is currently fixed to `skip`; `catchUp` supports `latest` (default) and `none`.
- A successful `schedule.run` satisfies the next natural fire; a failed manual launch does not skip it. For calendars, a manual launch before today's pending fire consumes today; if today has already fired, it consumes the next pending date. When overdue, it consumes the latest pending occurrence. The next fire is after both that occurrence and the current time.
- If a natural calendar fire overlaps a manual launch that later fails, the pending fire remains due. Pausing the schedule while that launch is pending still prevents automatic execution after the failure.
- `quiet` persists only on recurring (`every`) schedules. Successful automatic fires stay visible without a parent turn; failed, stopped, or paused outcomes still wake the session. One-shot `at` schedules and `schedule.run` stay noisy unless that launch passes `quiet: true`.
- `schedule.run-due` lets an external launcher start due project work without making `pi-subagents` a daemon.
- Month/year recurrence, cron, queue/replace overlap, and the schedule TUI inspector are intentionally deferred to the next slice.
- The old `schedule`, `schedule-list`, `schedule-status`, and `schedule-cancel` actions were removed in a hard cutover.

Disable or bound schedules with the `scheduledRuns` config key in [configuration.md](configuration.md#scheduledruns).
