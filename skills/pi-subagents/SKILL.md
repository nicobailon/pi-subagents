---
name: pi-subagents
description: |
  Delegate work to builtin or custom subagents with single-agent, parallel,
  scripted, compatibility-chain, async, forked-context, and coordinated workflows. Use
  for advisory review, implementation handoffs, and multi-step tasks where a
  single agent should stay in control while other agents contribute context,
  planning, or execution.
---

# Pi Subagents

This skill is for the main parent orchestrator only. Do not inject or follow it inside spawned child subagents. The parent session owns delegation, orchestration, review fanout, and final fix-worker launches. Ordinary children should not run their own subagent workflows; the explicit exception is a delegated fanout child whose resolved builtin `tools` includes `subagent`, and that child may use `subagent` only for the fanout work the parent assigned.

Use this skill when the parent orchestrator needs one specialized child or composed orchestration. Use `{ agent, task }` for one child and `workflowScript` for sequence, parallelism, branching, retries, or aggregation. Scripted workflows start asynchronously by default; pass `async:false` only for a small foreground run. `workflowScript` is the only public multi-agent orchestration surface.

## How to use this router

Read the matching reference file before acting. Paths are relative to this `SKILL.md`; resolve them against `skills/pi-subagents/` and load them with the read tool.

| Task | Read |
| --- | --- |
| Decide whether to delegate, choose agents, compare tool versus slash commands, apply prompt techniques, or understand builtin roles | `references/prompting-and-roles.md` |
| Run single, scripted, async, scheduled, mission-backed, forked, watchdog, clarify, oracle, or intercom-coordinated workflows | `references/execution-controls.md` |
| List/create/update/delete/eject/disable agents or chains, edit agent files, use prompt-template integration, or expose extension RPC | `references/management-authoring-rpc.md` |
| Check safety constraints, best practices, standard workflows, or error handling | `references/constraints-and-recipes.md` |

For broad or uncertain requests, read more than one reference. For complex work, start with `references/prompting-and-roles.md` and `references/execution-controls.md`, then consult `references/constraints-and-recipes.md` before launching or reviewing child work.

## Always-on constraints

- Keep the parent as orchestrator and final decision-maker.
- Use one writer per cwd/worktree unless isolated worktrees are intentional.
- For parallel fanout, compare child prompts before launch. Do not send clone prompts with only issue numbers, titles, or broad file globs swapped; each child needs a lane-specific task, source seam, prior evidence, and decision that remains distinct without the item number.
- Prefer fresh-context review/validation fanout, then synthesize and apply fixes in the parent.
- Use async/background only when work can proceed independently; do not poll just to wait. For adaptive gates, branch in `workflowScript`. Approval controls remain available only for already-running durable legacy chains.
- Preserve capability ceilings, including child tool restrictions and session-scoped allowed-agent restrictions.
- Escalate unresolved product, architecture, or safety decisions upward instead of letting a child decide silently.
- As a conservative orchestration policy, do not pass `turnBudget`, a hard `toolBudget`, or a tight `usageBudget` to mutation-capable workers. The default tool budget blocks read/search tools rather than mutation tools, and reported usage has no reservation model. If a worker is interrupted after a tool call starts, checkpoint after the current tool returns with changed files, build/test state, and commit or PR state.
