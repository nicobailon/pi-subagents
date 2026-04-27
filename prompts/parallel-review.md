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

Give every reviewer a specific task prompt naming its angle. Ask reviewers to return concise, evidence-backed findings with file/line references and suggested fixes. The response should be review feedback, not a context summary. Reviewers must not edit files unless I explicitly ask for a writer pass.

While reviewers run, do your own narrow inspection if useful. After they return, synthesize the feedback into:
- fixes worth doing now
- optional improvements
- feedback to ignore or defer, with a short reason

Do not blindly apply every reviewer suggestion. Ask before applying fixes unless I already told you to address review feedback.

$@
