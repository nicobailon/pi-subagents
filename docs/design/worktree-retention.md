# Reviewed worktree cleanup and optional count retention

Status: reviewed cleanup apply implemented for local review; count retention is the dependent implementation step. Publication and cross-platform CI are pending.
Baseline: main `9eb55dd93abdb3bb5aa468a286dad6bab3e7a7d9`.

## Problem and existing primitives

The extension already records preserved worktrees in handoff metadata and can build a repository-specific cleanup plan. `worktree.cleanup` currently accepts `mode: "plan"` only. The proposed change completes reviewed-plan application, then uses that same path for optional count-based retention.

[#1622](https://github.com/nicobailon/pi-subagents/issues/1622) explicitly separates plan creation from destructive application and defines the ownership, drift, authority, and local Git checks for the later apply PR. Reuse those checks; a folder name or age alone does not prove that a worktree belongs to the extension.

The user-facing reference is [Codex worktree cleanup](https://developers.openai.com/codex/app/worktrees/): its default keeps the latest 15 managed worktrees, allows changing/disabling the limit, protects in-progress/pinned/permanent worktrees, and saves a snapshot before deletion. This proposal uses an unset limit by default. The extension does not currently have Codex's complete snapshot/restore or pinned-chat model, and must not claim that it does.

## Public interface and defaults

Manual plan and apply use the existing namespace:

```ts
subagent({ action: "worktree.cleanup", repo: "/path/to/repo", mode: "plan" })
subagent({ action: "worktree.cleanup", repo: "/path/to/repo", mode: "apply", planId: "<reviewed-plan-id>" })
```

Apply requires explicit `repo` and `planId`. Resolve only the named repository-local plan; do not accept an arbitrary plan file path or rebuild a broader plan after approval. Child-safe fanout cannot invoke apply.

Proposed optional config:

```json
{
  "worktreeRetainCount": 15,
  "authorityPolicy": {
    "discardWorktree": "auto"
  }
}
```

`worktreeRetainCount` is a positive safe integer. Reject zero, negative/fractional values, strings, `null`, and non-finite values. Remove the key to disable the additional count-based policy; JSON does not need an `Infinity` value. Invalid configuration must fail visibly through the existing fail-closed validation path, not silently replace the config with defaults.

Use the existing user extension config only; do not add frontmatter or per-tool retention overrides. Changes take effect through the existing extension reload/new-session path, without a new config watcher. Reload/shutdown cancels queued maintenance, and a job checks its current live config/host state before applying a removal. Enabling the key does not itself immediately delete existing worktrees; the next relevant settlement event performs the check, or the operator can use reviewed manual apply.

When the key is absent, do not add count-driven scans or removals. Existing per-run cleanup remains unchanged. An explicit 15 is a retention target, not a hard quota or a changed default.

## Authority

Use the existing `discardWorktree` policy rather than inventing a second deletion-authority setting. Its current default is `confirm`.

| Policy | Manual apply | Count-driven maintenance |
| --- | --- | --- |
| `confirm` | Confirm the exact plan and repo before acquiring mutation locks | Report that automatic deletion needs explicit authority; do not open repeated prompts in a background callback |
| `auto` | Apply the reviewed named plan | May apply freshly created, internally selected plans for eligible excess worktrees |
| `forbid` | Refuse | Keep all candidates and report the policy reason |

A number alone does not override `confirm` or `forbid`. Operators who want unattended deletion configure both the count and the existing `auto` authority, as in the example. This preserves existing default authority and provides an actual unattended mode.

## Deletion conditions

Candidates must appear in both the selected repository's Git worktree inventory and matching extension metadata. Reuse the current planner's predicates, including:

- exact repository, real path, branch and recorded containment;
- a terminal owner and no active ownership marker or retained-child resume dependency;
- a real directory with no symlink escape or protected-root location;
- no dirty or untracked Git state;
- no branch checkout at the main repository or another registered worktree;
- unchanged worktree HEAD, branch tip, base/target facts and status since planning;
- local committed divergence proven merged or durably captured outside the worktree;
- handoff reports and recovery artifacts preserved outside the worktree;
- valid, unique metadata with a complete usable ownership proof.

Also preserve any worktree that is Git-locked or contains ignored files in the first version. A disposable fixture probe confirmed that ordinary `git worktree remove` rejects a nonignored untracked draft but removes ignored files while leaving the local branch. An empty ordinary status is therefore insufficient to promise recoverability. Use a bounded ignored-status check, not a recursive inventory of broad parent directories.

An operator can use the existing `git worktree lock` primitive to protect a managed worktree explicitly. Read the Git inventory's locked state; this proposal does not add a second permanent/pinned-worktree API.

This means dependency/build caches can also block the first version's cleanup. Report that reason honestly. The existing explicitly authorized discard path remains available for an operator who intentionally removes such a worktree. A cache allowlist or full ignored-file snapshot policy would be separate scope; do not infer that every ignored file is disposable.

First-version apply removes only the worktree using plain `git worktree remove`, without `--force`. Keep local branches, including branches containing unmerged commits. This avoids an unnecessary branch-deletion transaction while achieving the directory/disk cleanup. Plan/apply output must say that branches are retained, even where an older plan recorded `willDeleteBranch: true` as a future capability. No broad `git worktree prune` or remote branch deletion is included.

## Plan validity, locking and recovery

Plan files continue to live under the existing repository-local `.pi/subagents/cleanup-plans/` directory. Validate version, repo identity, entry structure, stable content hash, and the existing 30-minute expiry. Reject symlinked/escaping plan paths. A hash detects inconsistency; it is not a signature granting authority.

Acquire a cross-process lock keyed by canonical Git common-directory identity. The existing in-process `withWorktreeTransaction` alone does not coordinate two Pi processes. Use one consistent lock order: the existing in-process transaction, then the repository cleanup/admission lock. Never wait for confirmation while holding either lock. Contention waits are asynchronous and bounded; automatic maintenance skips/retries on a later relevant event rather than blocking a child launch.

The repository lock must also cover admission to resume/reuse an existing managed worktree. Checking terminal state and then deleting without coordinating resume leaves a real race. A cooperating resume acquires the same lock, verifies the worktree still exists and is not being removed, and publishes ownership before releasing it. Apply rereads the proof while holding the lock. Ordinary outside Git/file operations do not share this lock; final Git checks and a non-forced remove are still required.

Reuse the repository's asynchronous retention lock ownership/recovery pattern where appropriate, including process-start identity. Do not reclaim an unknown owner solely because a lock is old. A lock belonging to a provably dead local process can be recovered only with token/identity comparison; otherwise keep the worktree and surface the contention.

Apply is single-use and journaled:

1. Validate the stored plan and resolve authority.
2. Acquire locks; atomically claim the plan id and write a receipt in `applying` state before removal. A claimed plan is never replayed wholesale.
3. For each originally selected entry, reread current Git, ownership, protection and artifact evidence. Compare with the reviewed facts. Skip drifted entries; never substitute newly discovered entries.
4. Remove only that entry with plain Git, retaining its branch. Record per-entry result atomically.
5. Update the matching handoff task's removal fact through a current read-modify-write under the shared metadata mutation lock, preserving later lane evidence. Existing lane-evidence mutation and resume paths must participate or detect a cleanup claim; do not write a stale whole manifest.
6. Publish a durable complete/partial receipt before releasing locks. Cancellation, process exit, or errors leave an honest per-entry record.

After a crash, a subsequent invocation inspects the same receipt and current Git state. It can reconcile an already-missing worktree's metadata; it cannot replay unrecorded destructive operations from a claimed plan. A fresh plan is needed for further removals. Metadata/receipt write failures retain the journal and are reported as partial application, not a successful full cleanup.

No cleanup error may turn a completed child result into a failed child or erase its result artifacts.

## Count selection and lifecycle

The scope is the selected canonical source-checkout `repoRoot` and its existing planner metadata, not a new cross-checkout/global inventory. Count unique extension-owned managed worktree paths still present in Git with provable ownership in that scope, including active and otherwise protected entries. Do not count the source checkout, unowned worktrees, plan records, or local branches. The common Git directory identifies the shared mutation lock; it does not authorize discovering extra metadata from sibling checkouts or removing their worktrees.

Use the owning handoff manifest's valid `createdAt` as the first version's stable ordering key, with canonical path as a deterministic tie-break. This is owning-run creation order, not exact worktree allocation time or Codex-style tracking of every manual visit. Do not use the mutable manifest `updatedAt`: cleanup itself would make surviving siblings appear recently used. Invalid or conflicting age/ownership data makes a candidate non-removable. No new global worktree ledger or last-access scan is required for this version.

Compute excess as `max(0, ownedCount - worktreeRetainCount)`. Select the oldest eligible candidates to remove at most that excess. Protected candidates count toward the target but are skipped when choosing removals. Recount and revalidate under the apply lock; drift can reduce the batch, never expand an already claimed batch.

For example, with 18 owned worktrees and a limit of 15, remove up to three eligible old worktrees. If only one is eligible, retain 17 and report why the target was not reached. A safety condition always takes precedence over the number.

Run count maintenance after durable worktree/handoff settlement in the parent host: foreground finalization and the first delivery of a newly persisted background result. Coalesce duplicate events to one pending job per canonical repo. The detached runner does not create a competing independent automatic cleanup service.

Use existing verifiable terminal ownership in the parent. After a restart, a foreground run without sufficient remembered/durable ownership proof remains protected; the first version does not invent a new ownership ledger to make it removable. A stopped or shutting-down host defers maintenance; there is no new daemon, periodic directory sweep or cleanup work on every Fleet/status refresh.

A bounded ownership inventory determines whether a count check is needed. Avoid expensive per-entry Git checks below the limit. Above it, inspect oldest candidates in a separate worker process and stop after enough eligible entries are selected. Git checks stay outside the parent event loop. Cancellation keeps the worker and its repository lock alive until any already admitted Git command finishes, then stops before the next entry; it cannot roll back an admitted removal. Reuse/extract the planner's predicates rather than implementing a second notion of deletion safety. The current synchronous full planner is not suitable to call directly from a watcher callback. Truncated inventory or bounded-scan failures defer automatic removal and are reported; they must not appear as an exact complete count.

## Implementation split

Deliver two narrow PRs for this feature:

1. Reviewed `worktree.cleanup` apply: shared validators, plan claiming/receipt, per-repo mutation coordination, existing authority, ignored/locked protection, non-forced removal, branch retention, current-metadata reconciliation, focused tests and docs.
2. Optional `worktreeRetainCount`: config validation, stable selection, parent lifecycle scheduling/coalescing, worker-based bounded inspection, counts/reasons, default-off behavior and tests. Build on the first PR's apply/locking path.

Likely touchpoints are `src/runs/shared/worktree-cleanup-plan.ts`, a small shared apply/lock module, `src/runs/foreground/subagent-executor.ts`, existing retained-worktree admission and handoff update boundaries, `src/policy/authority.ts` consumers, `src/extension/config.ts`, `src/shared/types.ts`, parent background result delivery, and relevant docs. The authority defaults themselves remain unchanged.

Coordination with resume and metadata writers is necessary correctness scope, not optional future hardening. Inventory those callers before coding; if their integration cannot be kept reviewable, split that coordination prerequisite rather than shipping an unsafe standalone remove command.

## Acceptance

Apply regressions should prove named-plan-only removal, no child-safe apply, authority behavior, expiry/hash/replay rejection, drift and dirty-after-plan protection, ignored/locked protection, preserved artifacts, branch retention, cancellation/partial receipts, two-process contention, resume-versus-apply ordering, and crash reconciliation without destructive replay. Use disposable fixture repositories for deletion tests.

Count regressions should prove no extra scan/removal when unset, positive-integer validation, per-repo ownership, stable oldest-first selection, protected overflow, incomplete inventory deferral, one job for duplicate delivery, exact config reload/disable behavior, default confirmation blocking unattended deletion, and unchanged child results when maintenance fails.

Benchmark disabled mode, below-limit mode, and an above-limit fixture with realistic metadata/cache presence. Measure event-loop impact and cancellation under asynchronous inspection, not only wall-clock completion. Run focused Linux/Windows/macOS Git cases on the exact feature head and report skipped platforms explicitly.

The observed disposable Git probe and source inspection support this design. They are not a completed implementation, full recovery test, or cross-platform clearance. Required checks and contributor credit apply to the eventual implementation PRs.
