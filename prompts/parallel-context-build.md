---
description: Parallel context builders for planning handoff
---

Launch fresh-context `context-builder` subagents in parallel to build grounded handoff context for planning or implementation.

Use the `subagent` tool with `workflowScript` and `runs.all(...)`; assign each child a distinct absolute or durable output path. Use `context: "fresh"` unless I explicitly ask for forked context. Give every parallel task a distinct `output` path, `label`, and `as` name, for example:

- `context-build/request-and-scope.md`
- `context-build/codebase-and-patterns.md`
- `context-build/validation-and-risks.md`

Use one phase such as `phase: "Context build"` for the parallel tasks so async status is readable. A later synthesis step can reference specific outputs with `{outputs.requestScope}`, `{outputs.codebasePatterns}`, and `{outputs.validationRisks}` instead of relying only on `{previous}`.

Do not write these context artifacts into the repository unless I explicitly ask for persistent files.

Treat the slash command arguments as the primary request, target, or focus:

$@

If the invocation provides a URL, issue link, file path, plan path, or freeform request, read or fetch that target before assigning builder angles, then pass the target explicitly into every `context-builder` task.

Choose two or three strong builders based on the request. Prefer three only when the scope benefits from independent context slices. These are examples, not fixed defaults:

1. Request and scope
   Clarify the actual goal, user intent, constraints, non-goals, open questions, and decisions that affect the handoff.

2. Codebase and patterns
   Inspect relevant files, call paths, existing abstractions, tests, package constraints, and local conventions that the next agent must follow.

3. Validation and risks
   Identify likely failure modes, edge cases, test strategy, commands to run, dependency/API concerns, and escalation rules.

Adapt the angles when the request calls for it:
- Issue or PR URL: include issue requirements, acceptance criteria, linked discussion, and likely affected files.
- Plan file: include plan consistency, missing context, implementation sequence, and validation readiness.
- External API/library work: include current docs or primary sources through `web_search` when needed.
- Large refactor: include module boundaries, dependency direction, migration/cutover risks, and testability.
- UI/product work: include user flow, accessibility, copy, visual constraints, and implementation touchpoints.

Ask each builder to produce a compact handoff file with:
- relevant files and line ranges;
- key snippets or patterns, not full dumps;
- constraints and invariants;
- risks and unknowns;
- validation commands or next-best checks;
- a `meta-prompt` section for the next planner or role subagent.

After the builders return, synthesize their outputs into:
- the most important context the next agent needs;
- the recommended meta-prompt to use next;
- open questions or assumptions;
- the output artifact paths.

Do not start implementation from this command unless I explicitly ask for it.
