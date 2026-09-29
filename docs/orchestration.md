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
```

A supported blocker is a valid terminal outcome. Do not manufacture another execution route merely to keep the loop moving.
