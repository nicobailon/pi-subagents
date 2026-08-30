# Pi Subagents: Review And Validation

Generic review and delivery guidance for delegated work. This file does not encode private backlog, merge, or release policy.

## Delivery loop

Use the smallest loop that proves the change:

1. Inspect the source, diff, issue, or plan directly.
2. Keep one writer for each cwd or worktree.
3. Run focused validation that can fail for the changed behavior.
4. Use fresh-context read-only review for substantial, risky, public, or hard-to-see changes.
5. Apply only accepted findings inside the same writer boundary.
6. Re-run affected validation and review only the changed blast radius.
7. Inspect the final diff and evidence before parent acceptance.

Skip review ceremony for trivial wording, renames, or local-only probes when direct parent inspection is enough.

## Review shape

| Situation | Shape |
| --- | --- |
| One coherent diff or one risk | one reviewer |
| Independent risks, such as correctness, tests, security, or UI | parallel reviewers with distinct contracts |
| Possible over-scope or needless complexity | same-writer challenge before fresh review |
| Material design tradeoff | council mode |

Reviewers are fresh-context by default. Use the ordinary `reviewer` role for routine code review. Forked oracle/advisor runs are escalation-only for parent-history, drift, root-cause, model-routing, or hard tradeoff evidence.

## Finding disposition

The parent classifies each finding against current HEAD:

- **Valid blocker:** concrete failure, repro, security issue, contract mismatch, or source-proven regression. Fix now.
- **Valid non-blocker:** real but outside the delivery slice. Record or defer.
- **Stale:** fixed or absent at the reviewed head. Cite current evidence.
- **Invalid:** contradicted by source, tests, docs, or user-approved scope. Cite the contradiction.
- **Out of policy/scope:** needs unapproved product, architecture, authority, release, or public-repo action. Escalate.
- **Speculative:** no contract, repro, or reachable failure. Do not block.

A clean reviewer result is evidence, not publication authority.

## Gate-failure triage

When validation fails:

1. Confirm the run belongs to the exact head/ref under judgment.
2. Read the focused failing logs first.
3. Name the failing test, assertion, contract, or thread.
4. Classify cause: current diff, stale test, environment/setup, or existing flake.
5. Reproduce locally when practical with the narrowest command.
6. Patch forward when the current diff caused it.
7. For stale/flaky failures, collect proof before one rerun or residual-risk note.
8. Re-run the affected command or exact-head gate after every fix.

For bot comments, classify each thread as valid, stale, invalid, or out of policy before assigning severity.

## Final checklist

Before reporting delegated work as done, verify the relevant subset:

- final diff contains only intended files
- focused validation covers changed behavior
- substantial or risky changes have fresh-review evidence
- accepted findings are fixed and revalidated
- publication authority exists before push, comment, close, merge, deploy, or release
- external checks are exact-head when used as evidence
- handoff is durable before cleanup
- residual risks, skipped validation, and blocked decisions are explicit

## Public/private boundary

For issue/PR backlogs, releases, merge queues, contributor credit, or repo-specific policy, load the matching user/project skill when available. Keep those rules out of this public package until intentionally released.
