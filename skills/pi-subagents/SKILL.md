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
| One disposable child | direct `{ agent, task }` |
| Sequence, fanout, retry, gate monitor, retained resume, cross-repo wave, or aggregate result | `workflowScript` |
| Council of advisors | `../council-mode/SKILL.md` |
| Management, status, steering, authoring, or inspection | `action` |

`workflowScript` is code-driven: `runs.run(...)` for keyed steps,
`runs.all([...])` for fanout, plain JavaScript for branching and aggregation.
Keep scripts portable: use top-level `await`, plain helpers, or explicit Promise
chains, not nested async helpers. Legacy top-level `chain` / `tasks` inputs and
durable `.chain.md` execution are inspection or migration material only.

Use async/background by default. Set `async:false` only when the parent must
block. Final reviews, validation gates, oracle checks, and publication checks
stay async.

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

- Delegate only when a child improves evidence, independent review, or isolated execution.
- Keep the parent on the ordinary strong default model. Route workers/scouts to a fast capable tier, serious reviews to a strong tier, and top reasoning to bounded read-only critique.
- Exact model names are deployment policy. Put them in user/project settings or profiles, not package guidance.
- Give every child a cold-start packet: goal, target/cwd/ref, authority, edit boundary, context/evidence, success criteria, validation, output, and stop rules.
- Keep one writer per cwd/worktree. Parallel writers need isolated worktrees and a lane board.
- For cross-codebase work, record the repo, explicit `cwd`, authority boundary, and expected output before launch.
- Make parallel prompts distinct by source seam, evidence, and decision. Do not clone prompts with only item numbers swapped.
- Prefer fresh-context review/validation fanout, then synthesize and apply fixes in the parent.
- For Pi extension repos under `~/.pi/agent/extensions`, put lane worktrees outside extension auto-discovery, such as `~/.pi/agent/worktrees`.
- Preserve capability ceilings, including child tool limits and allowed-agent restrictions.
- Escalate unresolved product, architecture, authority, release, merge, or safety decisions.
- Treat receipts, CI, review bots, and external-run records as evidence, not authority.
- For backlog maintenance, releases, merge queues, or other public-repo mutation policy, load the matching user/project skill. This package defines delegation primitives, not private policy.
- As a conservative orchestration policy, do not pass a hard `toolBudget` or tight `usageBudget` to mutation-capable workers. The default tool budget blocks read/search tools rather than mutation tools. If interrupted after a tool call starts, checkpoint after the current tool returns with changed files, build/test state, and commit or PR state.
