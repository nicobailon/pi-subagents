---
description: Parallel research/context builders into an implementation handoff plan
---

Use parallel subagents to understand the request, compare any external references, inspect the local codebase, and produce a grounded implementation handoff plan with a final implementation-ready meta-prompt.

Primary request, target, or focus:

$@

Use `context: "fresh"` unless I explicitly ask for forked context. First read or fetch any URLs, issue links, PRs, screenshots, plans, docs, or local files mentioned in the request. Treat them as primary scope, not optional context.

Use the `subagent` tool with `workflowScript`:

1. First step: a parallel group.
   - `researcher`, when the request includes external references, APIs, libraries, docs, current best practices, or prompt-guidance research.
   - `context-builder` for local codebase context.
   - Add a second `context-builder` only when the scope is large enough to benefit from a separate implementation-strategy pass.

2. Second step: a synthesis `context-builder` that reads the parallel findings and writes the final handoff plan and meta-prompt.

Use distinct output paths, `label` values, and `as` names under the chain directory. Example outputs:
- `handoff/external-reference.md`
- `handoff/local-context.md`
- `handoff/implementation-strategy.md`
- `handoff/final-handoff-plan.md`

Use phases such as `Research`, `Local context`, and `Synthesis` so async status is readable. Prefer `{outputs.externalReference}`, `{outputs.localContext}`, and `{outputs.implementationStrategy}` in the synthesis task when those specific inputs are available; keep `{previous}` only when the whole parallel fan-in summary is the desired input.

Do not write these artifacts into the repository unless I explicitly ask for persistent files.

Role guidance:

External reference researcher:
- Study linked projects, docs, issues, examples, source code, or prompt guidance.
- Identify the behavior, API, implementation files, constraints, and transferable ideas.
- Conduct web research if needed. Use `web_search` if it is available; otherwise use whatever equivalent research capability is available.
- Return source links, repo paths, key evidence, risks, and what matters for this implementation.

Local context-builder:
- Read all files needed to fully understand the local issue, not just the first match.
- Follow imports, callers, tests, fixtures, configuration, docs, and adjacent patterns until the local problem, solution space, and validation path are clear.
- Return relevant file paths and line ranges, current architecture, constraints, tests, risks, and open questions.

Implementation-strategy context-builder, when used:
- Compare the external evidence against the local architecture.
- Propose the safest implementation shape, files likely to change, edge cases, validation commands, and decisions that need approval.
- Stay review/planning-only unless I explicitly ask for implementation.

Final synthesis context-builder:
- Read the parallel outputs and produce one concise handoff plan.
- Include what the feature/change should do, what the external reference teaches, what the local codebase implies, the recommended approach, likely files to change, constraints, non-goals, validation, risks, and unresolved questions.
- End with a compact implementation-ready meta-prompt for the next worker/planner.

After the chain returns, synthesize the result for me with:
- the recommended approach;
- artifact paths;
- the final meta-prompt;
- any questions or assumptions that remain.

Do not start implementation from this command unless I explicitly ask for it.
