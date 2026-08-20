---
description: Run a bounded supervisor-mediated council of advisors and write a decision memo
argument-hint: "<question> [--advisors name:role,name:role] [--max-passes 2|3] [--scope ...] [--non-goals ...]"
---

Run a bounded, supervisor-mediated council on this question. You, the parent
session, are the supervisor. You select the roster, curate cross-advisor packets,
decide which feedback is valid, and write the final memo. Advisors do not talk
directly or see peer transcripts by default. This is not free-form agent chat.

Before you orchestrate, read `skills/council-mode/SKILL.md` and
`skills/pi-subagents/references/execution-controls.md`.

Parse the invocation yourself. The flags below are conventions, not runtime
options. Record a brief with the question, scope, non-goals, evidence targets,
roster, roles, and pass cap. Default `--max-passes` to 2. Clamp it to 2 or 3. If
the question is trivial or settled, answer directly instead of convening a council.

## Roster

- If `--advisors` is given, use exactly those `name:role` pairs. Fail clearly on an
  unknown agent.
- Otherwise list agents with `subagent({ action: "list" })`, then prefer 2–3
  executable names that start with `council-`.
- If fewer than two profiles are available, fill the roster with `oracle`, then
  `reviewer`, until it has two advisors. Launch fallback `oracle` with
  `context: "fork"` so global defaults cannot remove its parent-chat context.
  Let `reviewer` use its normal profile context. Note the fallback and known
  context modes in the memo.
- Use the normal single-oracle loop only when a requested roster or unavailable
  builtins leaves fewer than two advisors. Label the memo as degraded mode.

Roles belong to this request, not to the profiles. Keep the roster at 2–3 and never
exceed 4.

## Pass 1: independent reports

Launch one async `workflowScript` with `runs.all` and a stable key for each advisor.
Set `context` when the selected advisor has a known profile context or a fallback
rule requests one, because a global default can otherwise override that profile.
Set `context: "fork"` for fallback `oracle`. If no advisor context is known, omit
`context` and disclose the unknown runtime default in the memo. Each task includes
the brief, the assigned role, and these rules:

- Inspect the repository and supplied evidence directly. You do not see other
  advisors and must not ask about them.
- Read-only. Do not edit files, run mutating commands, commit, or push.
- Do not spawn subagents. Keep the report to about 600 words or less.

Do not set `clarify`, `worktree`, `gate`, turn budgets, tool budgets, or tight usage
budgets. Record every returned run id. Yield for the async workflow. Do not poll.

Require these exact report headings:

1. Recommendation
2. Key evidence
3. Assumptions — mark each verified or unverified
4. Risks
5. Confidence — high, medium, or low, with reason
6. Claims to challenge — up to three falsifiable claims
7. Owner decisions
8. What would change my mind

## Claim matrix

After pass 1, build the claim matrix yourself in this parent session. Do not use a
workflowScript or child for this synthesis. Include agreements and evidence status,
disputed claims and positions, missing proof, merged owner decisions, and a relay
set. Relay at most five disputed, high-impact, or missing-proof claims per advisor.
Drop style disagreements.

## Pass 2: curated cross-exam

Launch a second async `workflowScript` with `runs.all`. Resume each retained advisor
with `runs.run("cross-<name>", { resume: "<run id>", task: "<packet>" })`. Resume
excludes `agent`, requires a non-empty task, and does not support `gate`. Each
resume returns a new run id. Record it and use the latest id for any pass 3.

For a non-resumable advisor, launch a fresh same-profile advisor with that
advisor's own pass-1 report and the packet. Mark it in the memo as a
fresh-context fallback, not a true cross-exam.

A packet contains only disputed claims, strong conflicting evidence, missing proof,
owner decisions, and high-impact risks. Attribute peers only as "another advisor".
Never include full peer reports. For each relayed claim, require exactly one of
`accept`, `reject`, `refine`, or `owner-decision`, with cited evidence. Then require
whether the recommendation changed and why. Put new critical evidence under
`Out-of-scope findings` without opening a new debate.

## Optional pass 3 and stop

Run pass 3 only when `--max-passes 3` was requested and a disputed claim materially
affects the recommendation and can plausibly be settled by evidence an advisor can
produce. Never run more than three advisor passes or resume an advisor more than
`max-passes - 1` times.

Stop when the council converges, the cap is reached, fallback fails, or the user
interrupts. Converged means no disputed claim remains that is both material to the
recommendation and resolvable by evidence. Make all other disagreement an owner
decision. Do not add rounds for polish, re-litigation, or fairness.

## Decision memo

Write the memo yourself. Do not delegate it. Include:

- Question and scope
- Recommendation and rationale
- Accepted feedback, with advisor and pass
- Rejected feedback, with a short reason
- Unresolved owner decisions
- Evidence: paths, commands, and run ids; do not inline transcripts
- Confidence and what would change the decision
- Process note: roster, roles, passes, fallbacks, degraded modes, and known advisor
  context modes. State that fallback `oracle` is context-aware and forked.

Question and options from the slash command invocation:

$@
