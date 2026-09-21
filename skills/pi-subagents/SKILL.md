---
name: pi-subagents
description: |
  Technical guidance for operator-requested delegation to builtin or custom
  subagents: bounded handoffs, parallel review, scripted workflows, async work,
  forked context, isolation, and coordinated execution.
---

# Pi Subagents

The parent works directly by default. Invoke subagents only when the operator
requested delegation in the current request or through applicable user/project
instructions. Task size, complexity, risk, tool-call count, recipe fit, or an
available specialist does not independently authorize delegation.

Once authorized, choose the smallest bounded shape that earns its token and
elapsed-time overhead through concrete evidence, independent review,
specialization, useful parallelism, or needed isolation. A single child is
valid; writer, challenge, and review stages must each earn their overhead rather
than becoming default ceremony. The parent keeps user intent, constraints,
routing, arbitration, decisions, final acceptance, and publication authority,
and may perform the work directly where it is the most efficient owner.

Children do not spawn subagents unless the parent explicitly delegated fanout
and their resolved `tools` allow `subagent`.

## Launch shape

| Need | Use |
| --- | --- |
| One bounded task for one child | direct `{ agent, task }` |
| JavaScript control flow or data-dependent branching; sequence, fanout, retry, rolling fanout, or aggregation | `workflowScript` with `runs.run(...)` / `runs.all(...)` |
| A broad plan split into visible narrow stages per lane | `workflowScript` with `runs.lanes([{ key, stages: [...] }])` |
| Independent worktree or repository lanes | `references/multi-lane-orchestration.md` |
| Council of advisors | `../council-mode/SKILL.md` |
| Management, status, steering, authoring, or inspection | `action` |

`workflowScript` is code-driven: `runs.run(...)` for keyed steps,
`runs.all([...])` for fanout, plain JavaScript for branching and aggregation.
Keep scripts portable: use top-level `await`, plain helpers, or explicit Promise
chains, not nested async helpers. Legacy top-level `chain` / `tasks` inputs and
durable `.chain.md` execution are inspection or migration material only.

Use `runs.lanes(...)` only inside a `workflowScript`, not as a top-level mode,
when a broad, predeclared plan benefits from visible per-lane stages; otherwise
use ordinary `runs.run(...)` / `runs.all(...)`. See the [canonical staged-lane
example](../../docs/workflows.md#parallel-sequential-lanes). Keep assignments
bounded, but do not add stages or ceremony just to satisfy this skill.

When composing `runs.run(...)`, `runs.all(...)`, or `runs.lanes(...)`, always
supply a short verb + behavior display `label` derived from the task, unless
the user supplied an explicit label; preserve that label. Keep the stable
machine `key` independent (for example, `issue2011-writer` with
`label: "Fix workflow steering"`). For `runs.lanes`, put labels on stage
items, not lane objects. Use stage-appropriate labels for reviews and retained-child
follow-ups too (for example, `Review workflow steering`). Generate labels in
the orchestrator while composing the launch—no extra model call, runtime
generator, or schema change. Native direct `{ agent, task }` calls have no
top-level `label` parameter; do not invent one or wrap a tiny single task in
a workflow just to label it.

Use async/background by default. Set `async:false` only when the parent must
block. Final reviews, validation gates, oracle checks, and publication checks
stay async.

In an ordinary interactive session, yield after launching or triaging useful
async lanes and let Pi wake the parent on completion; ordinary async subagents
already have native completion notifications, so do not call `bg_wait()` merely
because a child is active. Use blocking `bg_wait()` only for provider,
detached, or other background work without a native notification when a
headless/run-to-completion contract or a required same-turn artifact makes the
result necessary before this turn ends. For
“continue/orchestrate/work until done,” keep the lane board moving while a safe
immediate action remains; if only async lanes are running, record the revisit
trigger and yield.

Package agents appear in `subagent({ action: "list" })`. External CLI/job agents
use their own runner contract. Do not pass native Pi child options to them unless
that runner explicitly supports the option.

## Read the reference for the branch

For exact API fields and worked examples, call `subagent({action:"guide",topic:"tool-reference"})` or `topic:"workflows"`. The compact tool definition is not the recipe catalog; use `topic:"missions"` for mission updates and schedules.

| Branch | Read |
| --- | --- |
| Delegate or choose roles, prompts, models, or slash commands | `references/prompting-and-roles.md` |
| Execute single, scripted, async, scheduled, mission, forked, watchdog, oracle, or intercom workflows | `references/execution-controls.md` |
| Review, validate, triage gate failures, or prepare delivery | `references/review-and-validation.md` |
| Coordinate lanes, worktrees, repositories, or writer waves | `references/multi-lane-orchestration.md` |
| List, create, edit, disable, eject, or expose agents/RPC | `references/management-authoring-rpc.md` |
| Check safety constraints, recipes, or error handling | `references/constraints-and-recipes.md` |

For an authorized complex delegated workflow, read `prompting-and-roles.md` and
`execution-controls.md`, then load `review-and-validation.md` and
`constraints-and-recipes.md` before launch or review.

## Operating rules

- Avoid duplicate scouts, overlapping writers, and vague prompts without a concrete deliverable.
- Keep the parent on the ordinary strong default model. Route workers/scouts to a fast capable tier, serious reviews to a strong tier, and top reasoning to bounded read-only critique.
- Exact model names are deployment policy. Put them in user/project settings or profiles, not package guidance.
- Give every child a compact meta-prompt checklist: objective; repo/cwd/ref; authority/edit boundary; relevant files/contracts and constraints; success/acceptance criteria; validation; expected output/report; and stop/ask conditions. See `references/prompting-and-roles.md`.
- Before launching a writer for substantial mutation work, classify it as single-seam or multi-seam and partition multi-seam work across exclusive component owners, gates, and durable handoffs before an integration-only owner. See `references/multi-lane-orchestration.md`.
- For mutation work, use an isolated lane/worktree when isolation, overlap, or concurrent juggling matters; keep one writer per cwd/worktree. See `references/multi-lane-orchestration.md` for lane mechanics.
- Keep long/high-output validation out of chat: prefer `interactive_shell` dispatch/background monitors, bounded logs, or subagent-owned reports; return a concise summary plus report path unless same-turn output is required. Do not use `interactive_shell` as an implicit fallback for a failed `subagent` lane; see `references/execution-controls.md`.
- Treat subagent workflow, child launch, prompt runtime, extension load, and child tooling setup failures as lane infrastructure blockers. Stop, report the exact failure and run/worktree state, verify a clean worktree or capture a partial diff, and use only a clear same-protocol retry or an owner-approved execution-mode fallback.
- For cross-codebase work, record the repo, explicit `cwd`, authority boundary, and expected output before launch.
- Make parallel prompts distinct by source seam, evidence, and decision. Do not clone prompts with only item numbers swapped.
- Prefer fresh-context review/validation fanout, then synthesize and apply fixes in the parent.
- For Pi extension repos under `~/.pi/agent/extensions`, put lane worktrees outside extension auto-discovery, such as `~/.pi/agent/worktrees`.
- Preserve capability ceilings, including child tool limits and allowed-agent restrictions.
- Preserve parent authority and escalate unresolved choices.
- Treat receipts, CI, review bots, and external-run records as evidence, not authority.
- For backlog maintenance, releases, merge queues, or other public-repo mutation policy, load the matching user/project skill. This package defines delegation primitives, not private policy.
- As a conservative orchestration policy, do not pass a hard `toolBudget` or tight `usageBudget` to mutation-capable workers. The default tool budget blocks read/search tools rather than mutation tools. If interrupted after a tool call starts, checkpoint after the current tool returns with changed files, build/test state, and commit or PR state.
