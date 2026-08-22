---
description: Parallel subagents review
---

Launch parallel reviewers for an adversarial review of the current work.

Use fresh context, not forked context, unless I explicitly ask for forked context. Reviewers should inspect the repository, relevant instructions, and current diff directly from files and commands. Do not rely on the main conversation history.

Give each reviewer a distinct angle. Generate the angles dynamically from the user's intent, the plan, the implemented code, and the current diff. If I specify angles, use mine. Otherwise, choose the highest-value review angles for this specific work.

These are examples, not fixed defaults:

1. Correctness and regressions
   Check whether the change satisfies the request, preserves existing behavior, handles edge cases, and avoids hidden runtime failures.

2. Tests and validation
   Check whether tests or validation were added at the right layer, whether assertions are meaningful, and whether the chosen verification commands are enough.

3. Simplicity and maintainability
   Check for unnecessary complexity, duplicate structure, single-use wrappers, brittle abstractions, confusing names, verbosity, and cleanup that is clearly worth doing.

Choose or adapt angles when the work calls for it:
- TypeScript-heavy changes: include type safety, source-of-truth types, casts, and error-boundary discipline.
- UI-heavy changes: include UX, accessibility, copy, and visual quality.
- Security-sensitive changes: include unsafe input/output handling, auth boundaries, privacy, and data exposure.
- Docs-heavy changes: include clarity, accuracy, completeness, reader flow, and non-robotic prose.
- Large multi-file changes: consider a fourth reviewer for structural friction, module boundaries, and testability.

Prefer three strong reviewers over many vague reviewers.

Give every reviewer a specific task prompt naming its angle. Ask reviewers to return concise, evidence-backed findings with file/line references and suggested fixes. Filter on evidence, not severity: a finding must be concrete, current, caused or made reachable by the target diff, and supported by source proof, a test or repro, or a contract contradiction. Label findings P0/P1/P2. P0 blocks merge. P1 should be fixed before release. P2 is report-only. End each review with `Merge verdict: BLOCK`, `Merge verdict: OK`, or `Merge verdict: OK with notes`. If nothing qualifies, ask the reviewer to say exactly `No issues found.` The response should be review feedback, not a context summary. Reviewers must not edit files unless I explicitly ask for a writer pass.

Do not default first-pass reviews to `blockers only`. That phrase is valid only for final pre-merge re-checks after P1/P2 findings are already inventoried, or for explicit emergency hotfix lanes where non-blocking findings are intentionally deferred.

For a targeted follow-up review, ask only whether the named finding was resolved, whether the fix introduced a new defect in the fix blast radius, and whether prior P1/P2 notes still stand. For bot or PR-comment triage, classify each comment as VALID, STALE, INVALID, or OUT-OF-POLICY against current HEAD, then assign P0/P1/P2 only to VALID comments.

While reviewers run, do your own narrow inspection if useful. After they return, synthesize the feedback into:
- fixes worth doing now
- optional improvements
- feedback to ignore or defer, with a short reason

Do not blindly apply every reviewer suggestion.

Autofix mode: if the invocation contains the exact word `autofix`, treat it as workflow control, not review scope. Remove it before deciding the review target. After synthesis, apply only fixes worth doing now, validate, and summarize. Do not apply optional improvements unless explicitly requested. If there are no fixes worth doing now, do not edit.

Without autofix mode, ask before applying fixes unless I already told you to address review feedback. When you ask, end with a compact numbered menu so I can respond with a number. Use wording suited to the findings, but include these choices when applicable:

```text
Reply with [1], [2], or further instructions:
[1] Apply only the fixes worth doing now.
[2] Apply the fixes worth doing now plus optional improvements.
```

Additional review target or focus from the slash command invocation:

$@

If the invocation provides a URL, issue link, file path, plan path, or freeform focus, treat it as the primary review scope. Read or fetch that target before assigning reviewer angles, and pass the target explicitly into each reviewer task.
