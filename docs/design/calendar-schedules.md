# Day and week calendar schedules

Status: implemented for local review; publication and cross-platform CI are pending.
Baseline: main `9eb55dd93abdb3bb5aa468a286dad6bab3e7a7d9`.

## Problem and scope

A fixed `every: "24h"` cannot express a daily local clock time across daylight-saving changes. A fixed `every: "7d"` cannot express a selected set of weekdays. The proposed feature adds these two trigger forms to the existing schedule manager.

The first implementation includes daily and weekly recurrence, an explicit IANA time zone, a local clock time, existing missed-run policies, and existing schedule controls. Month/year recurrence, cron, overlap queues, a timeline inspector, and installation of an OS scheduler remain outside this change.

The historical owner request is [#815](https://github.com/nicobailon/pi-subagents/issues/815). [#819](https://github.com/nicobailon/pi-subagents/pull/819) shipped the first schedule slice and deferred calendar recurrence. Those references establish prior demand; they do not establish approval of this exact design.

## API

```ts
subagent({
  action: "schedule.create",
  id: "daily-review",
  every: "day",
  at: "09:00",
  timezone: "Asia/Taipei",
  workflow: "./.pi/workflows/review.js"
})

subagent({
  action: "schedule.create",
  id: "weekday-review",
  every: "week",
  on: ["mon", "tue", "wed", "thu", "fri"],
  at: "09:00",
  timezone: "Asia/Taipei",
  catchUp: "latest",
  workflow: "./.pi/workflows/review.js"
})
```

`workflow` retains the existing normalization to `workflowScript`; this feature does not introduce a second target API. Existing `args`, `cwd`, `missionId`, `baseRef`, `sessionOnly`, timeout, and authority rules remain applicable.

| Trigger | Required fields | Rejected fields |
| --- | --- | --- |
| One-shot | `at` with its existing delay or zoned-ISO format | `every`, `on`, separate `timezone` |
| Fixed interval | Existing duration `every`, such as `24h` or `7d` | `at`, `on`, `timezone` |
| Daily calendar | `every: "day"`, `at`, `timezone` | `on` |
| Weekly calendar | `every: "week"`, `at`, `timezone`, `on` | Unsupported weekday selectors |

For calendar triggers:

- `at` is exactly `HH:mm`, from `00:00` through `23:59`; seconds and ISO timestamps are rejected.
- `timezone` is required. Accept a supported IANA zone or `UTC`; reject fixed-offset strings and invalid names. Validate against the host's time-zone data and persist its canonical zone name. Never fall back to the host's local time zone.
- Weekly `on` is a nonempty array of `mon` through `sun`. Normalize duplicates and persist ISO weekday order. Numeric selectors and free-form aliases are not supported. The existing string/integer `on` schema was reserved and rejected at runtime, so no working numeric behavior needs a compatibility alias.
- Invalid combinations fail before writing a definition.
- `quiet: true` is valid for both recurring forms. Calendar `at` must not accidentally take the existing one-shot quiet rejection path.

## Time semantics

An occurrence is identified by its schedule and planned UTC instant. The next occurrence is a matching local calendar date and clock time whose instant is strictly later than the reference instant. New schedules use creation time as the reference.

Dates advance in the schedule's time zone. No calendar trigger advances by adding `86_400_000` milliseconds or by reusing the interval arithmetic.

The first version uses fixed, documented daylight-saving rules rather than new policy parameters:

| Case | Rule |
| --- | --- |
| Local time does not exist during a forward change | Skip that local date's occurrence; do not move it to another clock time |
| Local time occurs twice during a backward change | Use the first instant only |
| A whole local date is skipped | Skip that date |
| Host time zone changes | No effect on the persisted schedule zone |

These rules also apply to half-hour transitions. Computation must start near the reference instant, not iterate through every date since schedule creation. Bound helper searches and return a useful error if the host cannot resolve a supported occurrence; do not spin indefinitely or invent a fallback instant.

## Missed runs and control actions

Keep `catchUp: "latest" | "none"` and `overlap: "skip"`.

- `latest`: if the persisted next occurrence is overdue, choose the latest valid occurrence at or before now, bounded below by the persisted pending local date. Launch at most one catch-up run, then calculate the next future occurrence. Never replay every missed date.
- `none`: record a missed receipt for the earliest pending occurrence when appropriate, then advance directly to the next future occurrence. Do not emit an unbounded receipt for every missed date.
- Timer delays and sleep/resume rechecks continue to use the existing bounded timer machinery. Early callbacks rearm; they do not launch a future slot.
- Pause preserves the pending occurrence. Resume and session restoration use the existing catch-up policy.
- A manual launch that is successfully attached satisfies one pending natural occurrence, matching the existing documented manual-run contract. For an overdue trigger, consume the latest pending occurrence; for a future trigger, consume that next occurrence. Advance strictly after the later of now and the consumed instant. A failed manual launch leaves the pending occurrence unchanged.
- Example: a daily 09:00 schedule whose next slot is today at 09:00, manually launched at 08:00, next fires tomorrow at 09:00. If today's natural slot already fired, a successful manual launch consumes the currently pending next-day slot; this must be stated in the user documentation.
- Explicit manual actions remain explicit extra execution; they do not create an overlap queue or reset the local calendar clock.

The persisted pending local date prevents the second instant of a repeated local time from causing a duplicate scheduled run after the first has already been served. This is not an exactly-once execution guarantee: the existing shared-state and launch contracts still apply.

## Storage

Add a trigger variant, for example:

```ts
{
  kind: "calendar",
  every: "week",
  at: "09:00",
  timezone: "Asia/Taipei",
  on: ["mon", "tue", "wed", "thu", "fri"],
  nextLocalDate: "2030-01-07",
  nextRunAt: "2030-01-07T01:00:00.000Z"
}
```

`nextLocalDate` identifies the pending calendar slot; `nextRunAt` is its cached UTC instant. Both advance atomically with the existing schedule record. The date, clock time and zone remain authoritative. Stored definitions receive the same strict input validation, including the selected weekday and valid ISO local date/timestamp.

On restoration after a host time-zone database update, resolve that pending local date again. If its UTC instant changed, refresh the cache at the manager's explicit restore/write boundary before arming; listing must not write files. If the pending slot has become nonexistent, skip it using the same gap rule. Do not move back to a date already served or treat an old cached UTC offset as the catch-up lower bound. A missing/invalid zone or malformed date remains a visible error. This makes local clock time survive future zone-law changes without adding a second execution ledger.

Keep schedule schema versions 1 and 2 with their current mission-binding meaning. Existing readers already reject unknown trigger kinds, so a calendar trigger fails closed on older releases without adding another version solely for that purpose. Existing once/interval records retain their current representation and behavior. Calendar definitions require a reader supporting this feature in every session that shares the store.

`schedule.show` should display the local rule, zone, and next instant so the operator can inspect the actual definition. No new view or status-polling scan is needed.

## Time library and integration

Recommend declaring `@js-temporal/polyfill@0.5.1` as a direct runtime dependency. The supported Node 24 runtime used for the feasibility check did not expose native `Temporal`. Avoid private SDK imports and hand-written time-zone offset arithmetic.

Use ISO `PlainDate`/`PlainDateTime` to select dates. Resolve with `disambiguation: "earlier"`; compare the resulting local date/time with the requested one. A mismatch identifies a nonexistent local slot and is skipped. A matching ambiguous slot selects its first instant.

The prototype exercised date/instant resolution, not a completed schedule-manager implementation. Fifteen Linux/Node 24 cases passed for Taipei weekdays, New York gaps/folds, Lord Howe half-hour changes, Apia's skipped date, month/leap-day boundaries, and pending-slot lower bounds. A date-based lower bound also avoids relying on an obsolete cached UTC instant. One thousand warm next-occurrence computations took about 179 ms in the initial probe. This is feasibility evidence, not a performance budget or cross-platform proof. The polyfill's ESM entry was 128,868 bytes; the installed package also includes source/maps and a `jsbi` dependency.

A static helper import preserves the manager's current synchronous bind/restore API. Measure its host startup/import cost before shipping. Once/interval paths should retain their existing calculations and must not invoke calendar conversion merely because the helper is loaded.

Implementation touchpoints:

- `src/runs/background/calendar-schedule.ts`: input normalization and next/latest occurrence helpers.
- `src/runs/background/scheduled-runs.ts`: trigger union/parser, create, next/latest advancement, manual run, restore, failure rearm, and recurring quiet handling.
- `src/extension/schemas.ts`: update `at`, `every`, `on`, and `timezone` descriptions/types.
- `package.json` and lockfile: declare the runtime dependency directly.
- `docs/missions.md` and `docs/tool-reference.md`: examples, daylight-saving/manual behavior, and reader requirements.

There are several existing `kind === "interval"` branches beyond creation. Audit them all; adding only a parser and `nextAfter` branch is insufficient.

## Acceptance and delivery

Focused helper regressions must cover daily/weekly filtering, exact-reference boundaries, invalid inputs, gaps/folds, half-hour changes, skipped dates, leap/month boundaries, and long downtime without work proportional to all missed dates.

Manager tests must cover create/persist/restore, changed UTC-cache resolution with the same pending local date, both catch-up policies, pause/resume, manual satisfaction and failed launch, overlap skip, error rearm, disabled schedules, recurring quiet, session-only ownership, and mission attachment. Existing one-shot and fixed-interval expectations remain green.

Validate typecheck, public tool schema budgets, package/clean-install behavior, and focused tests on the final head. Windows and macOS time-zone coverage needs actual execution evidence; a macOS job that does not run these tests is not evidence for them. Record host ICU/tzdata versions for failures.

The known schedule `EEXIST` stale-state write, concurrent history update, and orphan-lock problems are separate fixes. Adding a calendar helper does not repair them. Prioritize the narrow stale-state fix before publishing the calendar feature, and exercise calendar integration after it lands rather than claiming the feature makes cross-session scheduling reliable.

Deliver one focused calendar-feature PR with contributor credit and exact-head checks after implementation. Do not mix worktree retention or the schedule inspector into that PR.
