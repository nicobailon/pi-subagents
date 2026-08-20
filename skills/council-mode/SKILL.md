---
name: council-mode
description: Run a bounded supervisor-mediated advisor council. Use when the user asks to convene advisors, debate a decision, cross-examine recommendations, or run /council.
---

# Council Mode

This skill is for the parent supervisor only. Do not inject it into advisors. The
parent selects the roster, curates all cross-advisor communication, decides which
feedback is valid, and writes the decision memo. Advisors do not talk directly or
see peer transcripts by default. This is not free-form agent chat.

Use council mode for a material decision with real tradeoffs. Do not use it for a
trivial or settled question, or for implementation work. Read
`skills/pi-subagents/references/execution-controls.md` before you launch advisors.

## Roster and limits

Roles such as architect, skeptic, operator, and performance reviewer belong to the
`/council` request. A `council-*` profile defines only model, tools, context, and
output defaults.

Create model-based profiles in your user or project agent directory. Do not add
them to this package. This is a valid example; roles still come from `/council`:

```markdown
---
name: council-sol
description: Read-only fresh-context advisor for bounded council decisions
tools: read, grep, find, ls
model: openai-codex/gpt-5.6-sol
thinking: high
systemPromptMode: replace
inheritProjectContext: true
inheritSkills: false
defaultContext: fresh
acceptanceRole: read-only
---

Analyze only the assigned council role. Inspect evidence directly. Do not edit,
run mutating commands, commit, push, contact peers, or spawn subagents. Return
concise, cited advice using the report contract in the council task.
```

After `subagent({ action: "list" })`, prefer 2–3 executable names that start with
`council-`. The prefix is a naming convention, not runtime selection. If fewer
than two profiles are available, fill the roster with fresh-context `reviewer`, then
`scout`, until it has two advisors. Note the fallback in the memo. Use the
normal single-oracle consultation loop only when a requested roster or unavailable
builtins leaves fewer than two advisors. Label that result as degraded mode. Never
use more than four advisors.

Pass 1 is independent reports. Pass 2 is one cross-exam. The default pass cap is
2. Run pass 3 only when `--max-passes 3` was requested and a material dispute can
be settled by evidence an advisor can produce. Never run an unbounded loop.

## Protocol

1. The parent writes a brief with the question, scope, non-goals, evidence targets,
   roster, roles, and pass cap.
2. Launch one async `workflowScript` with `runs.all` for independent fresh-context
advisor reports. Use stable keys and set `context: "fresh"` explicitly on every
advisor run. This is required for fallback `reviewer` and `scout` advisors and
   also applies to `council-*` advisors. Each advisor is read-only and must not
   spawn children, edit files, run mutating commands, commit, or push.
   Use `{ key, agent, context: "fresh", task }` for every `runs.all` launch item.
3. The parent synthesizes a claim matrix in session. It contains agreements,
   disputed claims, missing proof, owner decisions, and a relay set of at most five
   high-impact claims per advisor. Do not delegate this synthesis.
4. Launch a second async `workflowScript` with `runs.all` resume calls. Each task
   is a curated challenge packet, not a peer transcript. A resume requires a
   retained run id and a non-empty task. It excludes `agent` and rejects `gate`.
   Record the new run id from every resume. Pass 3 resumes those latest ids.
5. The parent writes the final memo. Do not delegate it.

If an advisor is not resumable, run the same profile in fresh context with its own
pass-1 report and the challenge packet. Label that response as a fresh-context
fallback, not a true cross-exam.

Do not set `clarify`, `worktree`, `gate`, turn budgets, tool budgets, or tight usage
budgets on advisors. Bound work through the roster, pass cap, and report length.

## Advisor contracts

Pass-1 reports are at most about 600 words and use these headings:

1. Recommendation
2. Key evidence
3. Assumptions — marked verified or unverified
4. Risks
5. Confidence — high, medium, or low, with reason
6. Claims to challenge — at most three falsifiable claims
7. Owner decisions
8. What would change my mind

A challenge packet contains only disputed claims, strong conflicting evidence,
missing proof, owner decisions, and high-impact risks. Attribute peer content as
"another advisor". Do not include full peer reports.

For every relayed claim, the cross-exam response says exactly `accept`, `reject`,
`refine`, or `owner-decision`, with cited evidence. It then states whether the
recommendation changed. New critical evidence goes under `Out-of-scope findings`.

## Stop and memo

Converged means no disputed claim remains that both materially affects the
recommendation and can plausibly be settled by evidence. Stop at convergence, the
pass cap, failed fallback, or user interruption. Put unresolved disputes in owner
decisions. Never add a round for polish or symmetry.

The parent memo states the question and scope, recommendation, rationale, accepted
and rejected feedback with reasons, owner decisions, evidence and run ids,
confidence, what would change the decision, and the roster, roles, passes, and
fallbacks.

Council mode is not agent-to-agent chat, a transcript dump, mutation authority,
auto-escalation to writer lanes, or a council UI. Escalate to a writer only after
the parent memo and only when the user explicitly requests it.
