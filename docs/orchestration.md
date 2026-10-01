# Evidence-driven orchestration

Use this guide while explicit Pi orchestration mode is active. The coordinator owns the user's outcome, completion conditions, and sequencing; repository/result state plus child and acceptance evidence are authoritative.

## Loop

Think in evidence-closing stages rather than mandatory role phases:

```text
understand -> act -> prove -> challenge when warranted -> repair until proven
```

At each transition ask what material evidence is still missing, then take the smallest permitted action that can supply it.

- **Understand:** use bounded coordinator read-only inspection directly when it can close a factual gap. Launch `scout`, `researcher`, or `oracle` only when fresh context, specialization, external evidence, or independent adjudication is materially useful.
- **Act:** `worker` is the sole implementation writer.
- **Prove:** inspect concrete changed-file, validation, runtime, and acceptance evidence. A dispatch or launch receipt is never completion evidence.
- **Challenge when warranted:** use a fresh `reviewer` when independent review is requested, required, or materially useful to acceptance. Do not add review ceremony solely because a mutation occurred.
- **Repair until proven:** adjudicate concrete findings, repair accepted defects, and re-establish affected evidence before finishing.

## Compile the contract into existing primitives

For substantial delegated work, avoid making the operator restate the same workflow contract at every transition. Use the primitives Pi already owns:

- put the bounded objective, authority, constraints, and expected result in the child `task`;
- bind any required domain procedure explicitly with `skill` instead of hoping a generic child rediscovers it;
- use `acceptance` for criteria, evidence, review expectation, and stop rules, but not `acceptance.verify` shell commands in orchestration mode;
- use an explicit `mission` when human-readable recovery/cross-run continuity matters, then reuse its `missionId` for later implementation/review runs;
- use relative managed `output`/`outputMode: "file-only"` when a large handoff must survive the child; reserve absolute durable destinations for an operator-approved path.

Do not introduce a parallel task-state model. Missions already own durable run links, decisions, artifacts, acceptance evidence, and external receipts; repository state remains authoritative for code and project status. `mission.update` may record evidence/decisions/receipts, but a receipt is never permission to merge, deploy, or release.

## Writer continuity

For sequential mutation in the same working state, resume the most recent writer by default. Start a fresh writer only when fresh context or isolation is itself useful. This keeps implementation ownership singular without repeatedly reconstructing the same local state.

## Semantic repair rule

If a review-driven repair changes a semantic mechanism, contract, evidence generator, validation boundary, or population/coverage assumption, run a fresh targeted review of that changed blast radius unless a deterministic oracle fully proves it. Re-running the same mechanical checks is not enough when the repaired mechanism can share their blind spot.

Examples that normally warrant targeted re-review:

- changing which records or entities enter the evidence population;
- changing identity, matching, temporal, or aggregation semantics;
- changing how a frozen artifact or validation input is generated;
- changing a validation boundary or completeness assumption.

Purely mechanical repairs such as formatting, typo fixes, or deterministic field plumbing do not require a new reviewer unless the task explicitly requires one.

## Permitted orchestration surface

Use direct semantic child launches plus native lifecycle/status actions. Do not use raw `workflowScript`, workflow files, acceptance/gate shell commands, model overrides, or external CLI writer fallbacks while orchestration mode is active.

Supported patterns include:

```text
subagent({ agent: "worker", task: "Implement the bounded change." })
subagent({ agent: "reviewer", task: "Review the concrete result." })
subagent({ action: "resume", id: "<worker-run>", message: "Repair these accepted findings: ..." })
subagent({ action: "status", id: "<run>" })
subagent({ action: "children.list" })
subagent({ action: "mission.show", missionId: "<mission>" })
```

Read-only `children.list` discovers retained resumable workflow writers. It is workflow-only and is not an exhaustive list of direct native children; when an intended child's exact run id is known, inspect it with `status` and attempt `resume`, which authoritatively checks eligibility.

A supported blocker is a valid terminal outcome. Do not manufacture another execution route merely to keep the loop moving.

## Scope of the policy

Explicit orchestration mode governs only coordinator-initiated public execution: model `subagent` tool calls, the slash/prompt-template bridges, and RPC. Scheduled automation (`executeScheduled`) and structured owned delegation (`executeDelegated`, ownerRunId workflow nodes) are separate non-coordinator execution lanes. They run with their own persisted launch contracts and are intentionally exempt from the transient orchestration-mode policy; do not route them through the coordinator gate.
