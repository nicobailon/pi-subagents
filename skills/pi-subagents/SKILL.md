---
name: pi-subagents
description: |
  Delegate work to builtin or custom subagents with single-agent, parallel,
  scripted-chaining, async, forked-context, and coordinated workflows. Use
  for advisory review, implementation handoffs, and multi-step tasks where a
  single agent should stay in control while other agents contribute context,
  planning, or execution.
---

# Pi Subagents

This skill is for the main parent orchestrator only. Do not inject or follow it inside spawned child subagents. The parent session owns delegation, orchestration, review fanout, and final fix-worker launches. Ordinary children should not run their own subagent workflows; the explicit exception is a delegated fanout child whose resolved builtin `tools` includes `subagent`, and that child may use `subagent` only for the fanout work the parent assigned.

Use this skill when the parent orchestrator needs one specialized child or composed orchestration. Use `workflowScript` for all execution, including one isolated child. Chaining is still supported, but it is code-driven: use `await runs.run(...)` for sequential steps, `runs.all([...])` for parallel fanout, and ordinary JavaScript for branching, retries, gate monitors, and aggregation. Keep workflow helpers portable: use plain helper functions or explicit Promise chains, not nested `async function` helpers, async arrows, or async methods. Do not use legacy top-level `chain` / `tasks` inputs or durable `.chain.md` execution. Scripted workflows normally start asynchronously unless config sets `asyncByDefault:false`; set `async:true` explicitly when async behavior matters. Pass `async:false` only when the parent must block until completion. Async mode still shows progress. Do not use `async:false` for final reviews, backlog gates, run-to-completion convenience, or because no other work is available.

## How to use this router

Read the matching reference file before acting. Paths are relative to this `SKILL.md`; resolve them against `skills/pi-subagents/` and load them with the read tool.

| Task | Read |
| --- | --- |
| Decide whether to delegate, choose agents, compare tool versus slash commands, apply prompt techniques, or understand builtin roles | `references/prompting-and-roles.md` |
| Run one-child, scripted, async, scheduled, mission-backed, forked, watchdog, oracle, or intercom-coordinated workflows | `references/execution-controls.md` |
| List/create/update/delete/eject/disable agents, inspect legacy chain records, edit agent files, use prompt-template integration, or expose extension RPC | `references/management-authoring-rpc.md` |
| Check safety constraints, best practices, standard workflows, or error handling | `references/constraints-and-recipes.md` |

For broad or uncertain requests, read more than one reference. For complex work, start with `references/prompting-and-roles.md` and `references/execution-controls.md`, then consult `references/constraints-and-recipes.md` before launching or reviewing child work.

## Always-on constraints

- Keep the parent as orchestrator and final decision-maker.
- Use one writer per cwd/worktree unless isolated worktrees are intentional.
- For cross-codebase work, record the target repo, explicit `cwd`, authority boundary, and expected output before launch. Do not assume the parent session cwd is the child repo.
- For parallel fanout, compare child prompts before launch. Do not send clone prompts with only issue numbers, titles, or broad file globs swapped; each child needs a lane-specific task, source seam, prior evidence, and decision that remains distinct without the item number. Launch that fanout as one async `workflowScript` with stable keys and aggregate output unless there is truly only one child.
- Prefer fresh-context review/validation fanout, then synthesize and apply fixes in the parent.
- Use async/background by default. Final reviews, gate checks, oracle checks, and backlog lanes stay async. Use `async:false` only when the parent must block until completion. Do not poll just to wait. For adaptive gates, branch in `workflowScript`.
- For Pi extension repos whose canonical checkout is under `~/.pi/agent/extensions`, never create lane worktrees as sibling directories there. Pi auto-loads `~/.pi/agent/extensions/*/index.ts`, so sibling worktrees can register duplicate tools. Put lanes under `~/.pi/agent/worktrees`, another worktree base outside auto-discovery, or a temporary clone. If a lane must run the modified extension itself, use an isolated Pi config home with `PI_CODING_AGENT_DIR=<lane-config> pi --no-extensions -e <lane>/index.ts`. Use full containers only when path and config isolation are insufficient.
- Preserve capability ceilings, including child tool restrictions and session-scoped allowed-agent restrictions.
- Escalate unresolved product, architecture, authority, release, merge, or safety decisions upward instead of letting a child decide silently.
- Treat receipts, CI, review bots, and external-run records as evidence, not authority to merge, close, comment, publish, or release.
- As a conservative orchestration policy, do not pass `turnBudget`, a hard `toolBudget`, or a tight `usageBudget` to mutation-capable workers. The default tool budget blocks read/search tools rather than mutation tools, and reported usage has no reservation model. If a worker is interrupted after a tool call starts, checkpoint after the current tool returns with changed files, build/test state, and commit or PR state.
