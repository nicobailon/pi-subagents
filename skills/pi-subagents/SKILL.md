---
name: pi-subagents
description: |
  Delegate to builtin or custom subagents for single-agent handoffs, parallel
  review, scripted chaining, async work, forked context, and coordinated
  workflows. Use when one parent agent should stay in control while children
  supply focused context, planning, review, or execution.
---

# Pi Subagents

Parent owns orchestration. Children do not spawn subagents unless the parent
explicitly delegated fanout and their resolved `tools` allow `subagent`.

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

Use `runs.lanes(...)` only inside a `workflowScript`, not as a top-level mode. It
keeps a predeclared staged plan visible: first stages batch across lanes, later
stages sequence per lane, and the returned board exposes lane/stage results. See
the [canonical staged-lane example](../../docs/workflows.md#parallel-sequential-lanes).
When staged seams are available, do not give a low-tier writer an end-to-end
issue. Split it into narrow stages, such as a scout/red test, helper-only change,
one render seam, validation, minimality challenge, or fresh review, and give the
writer only its assigned implementation stage.

Use async/background by default. Set `async:false` only when the parent must
block. Final reviews, validation gates, oracle checks, and publication checks
stay async.

In an ordinary interactive session, yield after launching or triaging useful
async lanes and let Pi wake the parent on completion; do not call blocking
`subagent_wait()` merely because a child is active. Use blocking
`subagent_wait()` only when a headless/run-to-completion contract or a required
same-turn artifact makes the result necessary before this turn ends. For
“continue/orchestrate/work until done,” keep the lane board moving while a safe
immediate action remains; if only async lanes are running, record the revisit
trigger and yield.

Package agents appear in `subagent({ action: "list" })`. External CLI/job agents
use their own runner contract. Do not pass native Pi child options to them unless
that runner explicitly supports the option.

## Read the reference for the branch

| Branch | Read |
| --- | --- |
| Delegate or choose roles, prompts, models, or slash commands | `references/prompting-and-roles.md` |
| Execute single, scripted, async, scheduled, mission, forked, watchdog, oracle, or intercom workflows | `references/execution-controls.md` |
| Review, validate, triage gate failures, or prepare delivery | `references/review-and-validation.md` |
| Coordinate lanes, worktrees, repositories, or writer waves | `references/multi-lane-orchestration.md` |
| List, create, edit, disable, eject, or expose agents/RPC | `references/management-authoring-rpc.md` |
| Check safety constraints, recipes, or error handling | `references/constraints-and-recipes.md` |

For complex work, read `prompting-and-roles.md` and `execution-controls.md`, then
load `review-and-validation.md` and `constraints-and-recipes.md` before launch or
review.

## Operating rules

- Keep simple, low-risk one-tool-call work local; delegate asynchronously to a child or `workflowScript` for most non-trivial requests needing multiple tool calls, independent research, broad inspection, risky edits, fresh review, or progress while the parent handles another lane. Avoid duplicate scouts, overlapping writers, and vague prompts without a concrete deliverable; follow the existing `runs.lanes(...)`, worktree, and async-yield guidance.
- Keep the parent on the ordinary strong default model. Route workers/scouts to a fast capable tier, serious reviews to a strong tier, and top reasoning to bounded read-only critique.
- Exact model names are deployment policy. Put them in user/project settings or profiles, not package guidance.
- Give every child a compact meta-prompt checklist: objective; repo/cwd/ref; authority/edit boundary; relevant files/contracts and constraints; success/acceptance criteria; validation; expected output/report; and stop/ask conditions. See `references/prompting-and-roles.md`.
- For mutation work, use an isolated lane/worktree when isolation, overlap, or concurrent juggling matters; keep one writer per cwd/worktree. See `references/multi-lane-orchestration.md` for lane mechanics.
- Keep long/high-output validation out of chat: prefer `interactive_shell` dispatch/background monitors, bounded logs, or subagent-owned reports; return a concise summary plus report path unless same-turn output is required. See `references/execution-controls.md`.
- For cross-codebase work, record the repo, explicit `cwd`, authority boundary, and expected output before launch.
- Make parallel prompts distinct by source seam, evidence, and decision. Do not clone prompts with only item numbers swapped.
- Prefer fresh-context review/validation fanout, then synthesize and apply fixes in the parent.
- For Pi extension repos under `~/.pi/agent/extensions`, put lane worktrees outside extension auto-discovery, such as `~/.pi/agent/worktrees`.
- Preserve capability ceilings, including child tool limits and allowed-agent restrictions.
- Keep planning, product/API/security decisions, acceptance, publication, and merge/release authority with the parent; escalate unresolved choices.
- Treat receipts, CI, review bots, and external-run records as evidence, not authority.
- For backlog maintenance, releases, merge queues, or other public-repo mutation policy, load the matching user/project skill. This package defines delegation primitives, not private policy.
- As a conservative orchestration policy, do not pass a hard `toolBudget` or tight `usageBudget` to mutation-capable workers. The default tool budget blocks read/search tools rather than mutation tools. If interrupted after a tool call starts, checkpoint after the current tool returns with changed files, build/test state, and commit or PR state.
