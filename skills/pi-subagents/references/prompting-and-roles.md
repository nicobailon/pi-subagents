# Prompting and Roles

All launch guidance below assumes delegation was requested by the operator in
the current request or applicable user/project instructions. Complexity and
workflow fit choose a shape after that; they do not authorize a launch.

## Roles

| Agent | Use for | Default context | Tier |
| --- | --- | --- | --- |
| `scout` | Codebase recon | fresh | fast |
| `worker` | Implementation, the single writer | fresh | fast capable |
| `reviewer` | Code and plan review; read-only (send fixes to `worker`) | fresh | strong, high thinking for serious reviews |
| `researcher` | Web and primary-source research | fresh | default |
| `delegate` | Generic bounded task | fresh | default |
| `oracle` | Rare escalation on direction, drift, root cause, or hard tradeoffs | fork (fresh if the parent session is not persisted yet) | top reasoning, read-only |

Run `subagent({ action: "list" })` for project, user, and package agents;
project agents override user agents, which override builtins. `worker` and
`delegate` get only their listed tools; to give a child an extension tool,
name it in `tools` and load its extension (guide
`agents/tool-and-extension-selection`). Each launch uses one resolved model;
on a quota or availability failure, report it rather than picking another
model.

## Writing the brief

The SKILL.md brief checklist says what goes in. To make it work:

- Write a contract, not a script. Name the destination and let the role pick the path.
- Give discovery anchors: source roots, files, symbols, and paths for scouts; plans, task paths, and named seams for workers; changed files, contracts, and the verification target for reviewers; which evidence matters (source, policy docs, inherited decisions) for oracle.
- Use `must`, `always`, and `never` only for real invariants. For judgment calls, give a decision rule.
- Give researchers a retrieval budget: broad targeted searches, fetch only the strongest sources, search again only for a missing required fact, then stop.
- For implementation, state what to change, what not to change, where the evidence is, how to validate, and when to escalate. Never ask a child to plan more subagents or continue the parent conversation.
- When the user gives a URL, issue, PR, plan, or file, read it first and name it explicitly in every child task; fresh children cannot see the parent's history.
- Review-only children: "Do not modify project/source files; returning findings through the configured output artifact is allowed."

## Techniques

Packaged prompt shortcuts (`/parallel-review`, `/review-loop`,
`/parallel-research`, `/gather-context-and-clarify`, `/parallel-cleanup`,
`/council`) encode these. When the user describes one in words, run the same
shape directly with `subagent(...)`.

**Parallel review.** Fresh-context `reviewer` children, each with a distinct
angle drawn from the target (correctness and regressions, tests, simplicity;
adapt for security, UI, TypeScript, docs). Report only concrete current issues
with source proof, a test or repro, or a contract contradiction; for a diff,
the diff must cause or expose the issue. Label findings P0/P1/P2 and end with
`Merge verdict: BLOCK`, `OK`, or `OK with notes`. A follow-up review asks only
whether the named finding is fixed, whether the fix broke something nearby,
and whether earlier notes still stand. Bot comments are first classified
VALID, STALE, INVALID, or OUT-OF-POLICY against the current head.

**Review loop.** Writer, fresh reviewers, accepted fixes to one writer,
capped at 3 rounds. Details in [orchestration.md](orchestration.md#review-loop).

**Parallel research.** `researcher` for docs, specs, recent changes, and
primary sources, plus `scout` for local files, patterns, and integration
points. Ask for links or file ranges, confidence, gaps, and what the evidence
means for the decision.

**Gather context and clarify.** `scout` for local context, `researcher` only
when outside sources would change the answer. Then synthesize and ask the user
the open questions with `interview` before planning.

**Parallel cleanup.** After implementation, two fresh reviewers with
`output: false`: one deslop pass, one verbosity pass, using the `deslop` and
`verbosity-cleaner` skills when available. They flag issues with file and line
and the smallest fix; the parent decides what to apply.

**Skill specialists.** When `list` suggests skill subagents relevant to the
requested handoff, launch at most one or two, fresh context, read-only unless
implementation was requested, passing `skill: "<name>"` on a direct call or a
`runs.run` / `runs.all` item (`workflow: "parallel"` items do not take it). A suggestion is a hint,
not authority to fan out.

**Oracle consultation.** For "ask/consult the oracle" on a plan or design, run
one forked `oracle`. If its answer challenges the direction or leaves a
material tradeoff, resume that same child once with a focused question, then
decide. Skip the second round for one-shot requests or settled answers. Oracle
advice approves nothing; `worker` implements only after the parent approves a
direction. Never use oracle or a top-reasoning model for routine reviews; use
`reviewer`, and escalate only when review, CI, or source evidence leaves an
invariant, root-cause, routing, or product question open.

**Council.** For several advisors debating a material decision, follow
[../../council-mode/SKILL.md](../../council-mode/SKILL.md) instead of ad hoc
parallel oracle calls.

## Model tiers

Keep the parent on its ordinary strong model. Workers and scouts use a fast
capable tier; serious reviews use a strong tier at high thinking; a
top-reasoning model is only a bounded read-only critic after ordinary evidence
falls short, never an autonomous root. Map tiers to real models in user or
project settings or a profile (guide `models/setting-defaults-and-overrides`,
`models/profiles-and-provider-model-catalogs`). Explicit user policy wins.
Never pick a model from memory.
