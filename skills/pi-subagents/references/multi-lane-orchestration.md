# Multi-Lane Orchestration

Use this reference when several independent tasks need coordinated workers, worktrees, or repositories. It defines lane ownership; use the other pi-subagents references for run controls, prompts, and mission details. The parent remains the final decision-maker.

Create lanes only when delegation materially improves evidence, independent review, or isolated execution. Do not manufacture parallelism: keep dependent work serial, and only split work when each lane has a distinct decision and useful output.

## Lane board and authority

Before multiple mutation-capable lanes start, record this board in the parent context:

`Lane | repo/cwd | exact decision | claimed files or contract | isolation path | authority | next gate | handoff | why independent`

Record the isolation path before the first mutation. Do not split one source seam or decision into duplicate lanes. Make overlapping work one lane with one source of truth.

For every lane, record the delivery target, allowed actions, required validation, and review rigor. For cross-repository work, name the shared contract and which repository changes first. A blocked decision is a lane state: record the owner, options, recommended default, and evidence needed to continue.

## Partitioned runs

Use one writer per repo/cwd or worktree. Mutation lanes need distinct isolation paths and explicit `cwd` values. Set `worktree: true` when a run needs managed worktree isolation within one repository. Read-only runs can share a checkout only when they cannot change state or create generated files.

For Pi extension repositories, keep lane worktrees outside auto-discovered extension directories such as `~/.pi/agent/extensions`. A stale extension worktree there can auto-load duplicate tools and shortcuts. Remove or move it only after its handoff is durable, the worktree is clean, and no run owns it.

Partition fanout by repository, source seam, decision, or review angle. Each run needs a stable key, lane-specific task, and a managed output path when a file is needed. Do not launch prompts that differ only by item name or broad file glob.

### Cold-start packets and bounded orchestration audits

Every child packet must stand alone: include the goal, exact repository/cwd/ref, authority and edit boundary, relevant context/evidence, success criteria, validation, expected output, and stop/escalation rules. Do not rely on parent history, an issue number, or a broad glob alone. An orchestration audit by a top-reasoning critic model is read-only and returns at most three cited omissions; use high thinking only as an explicit parent/user escalation, never as an autonomous root or a parallel placeholder.

Use one async `workflowScript` for a coordinated wave. Use `runs.all` for independent lanes and `runs.run` for dependent lane stages. Give cross-repository runs explicit `cwd` values and lane-qualified outputs. Use `outputMode: "file-only"` when a report must survive the run or feed a later stage. Keep scratch outputs relative so they live under subagent artifacts; use absolute paths only for durable memory, approved docs paths, or final handoff files.

## Keep independent work moving

While one lane waits, run safe independent preparation, validation, or fresh read-only review lanes. Do not block the parent just because a run is active. If no safe lane remains, record the blocker and the event that will reopen work.

In an ordinary interactive session, completion wakes the parent; after useful
async lanes are launched or triaged, yield rather than use
`bg_wait({ all: true })` as a barrier. “Continue/orchestrate/work until
done” means keep the board moving while safe immediate work remains. If only
async lanes are running, record the revisit trigger and yield.

An ordinary coordinated workflow has one mission. Use its durable state, artifacts, run records, and receipts for recovery. Treat a receipt as evidence, not as authority or acceptance.

After a writer produces a candidate, run the required fresh-context, read-only reviewer. The reviewer inspects the exact worktree and returns evidence-backed findings. The parent decides which findings are in scope and whether the lane is ready. Use `review-and-validation.md` for finding disposition, validation, and gate-failure triage. Send accepted fixes to that lane's sole writer, then rerun only the affected gate.

## Handoff, cleanup, and recovery

Use stable lane-qualified artifact paths for reports and review output. A handoff states the lane status, repository and worktree, changed files, validation, open decisions, next action, and artifact or receipt paths. Copy only the final evidence to memory, a mission record, or a PR/comment, then remove scratch files from the active worktree before closing the lane.

Keep a worktree until its handoff is durable, no run owns it, and no later gate needs it. Clean up only inside the recorded authority boundary. If a run stops or needs attention, preserve its worktree and artifacts, record the last known state and recovery owner, then resume that run or create one replacement lane from the handoff. Do not start another writer while worktree ownership is uncertain.

Before completion, inspect the board. Every lane must be terminal or blocked with a named next action. Confirm one writer per repo/cwd or worktree, required validation, required fresh read-only review, and a durable handoff. The parent reports outcomes, evidence, residual risks, and the next decision.
