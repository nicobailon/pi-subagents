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

## Run the protocol

Use the canonical workflow, structured advisor contracts, aggregate pass receipts,
and memo requirements in `skills/council-mode/SKILL.md`. Keep the parent as the
only synthesizer and decision maker. Do not introduce a chair advisor, peer chat,
or transcript sharing.

Use its required boundary checkpoints, yield for each async workflow without
polling, and write its required final memo.

Question and options from the slash command invocation:

$@
