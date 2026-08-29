---
name: council-mode
description: Run a bounded supervisor-mediated advisor council. Use when the user asks for council mode, asks to convene advisors, debate a decision, cross-examine recommendations, or run /council.
---

# Council Mode

Council mode is parent-supervised advice for a material decision with real tradeoffs. It is not free-form agent chat, implementation work, a transcript dump, mutation authority, or a council UI.

The parent selects the roster, relays only curated claims, decides validity, and writes the memo. Advisors stay read-only and do not see peer transcripts by default.

Before launch, read:

- `skills/pi-subagents/references/execution-controls.md`
- `skills/council-mode/references/pass-contracts.md`

## Roster

Run `subagent({ action: "list" })`, then choose 2-3 executable advisor names that start with `council-`. The prefix is convention only. Never use more than four advisors.

If fewer than two council profiles are available, fill with `oracle`, then `reviewer`. Launch fallback `oracle` with `context: "fork"`; let fallback `reviewer` use its normal profile context. Note fallbacks and known context modes in the memo. If fewer than two advisors remain, use the normal one-oracle consultation loop and label it degraded mode.

`council-*` profiles live in user or project agent directories, not this package. A profile defines model, tools, context, output defaults, and persistent stance. Keep advisors read-only, disable inherited skills unless needed, and put stance in the profile body instead of inventing per-run role labels.

External-job/package advisors may join only when their provider is registered. Treat them as ordinary advisor names in `runs.all`, but honor their runner limits: they may lack repo tools, structured output, or resumability. Include evidence they cannot read, request JSON text instead of `outputSchema`, and use a fresh-context fallback when they cannot resume for cross-exam.

## Passes

Pass 1 is independent reports. Pass 2 is one cross-exam. Run Pass 3 only when `--max-passes 3` was requested and a material dispute can still be settled by evidence. Never run an unbounded loop.

## Protocol

1. Write the council brief: question, scope, non-goals, evidence targets, roster, known advisor context modes, and pass cap.
2. Tell the user the roster, context modes, and pass cap.
3. Launch one async `workflowScript` with `runs.all` for Pass 1. Use stable keys, `phase: "Council pass 1"`, concise labels, and `output: false` unless separate artifacts are useful. Set `context` only when the profile context is known or a fallback rule requires it.
4. Return one aggregate Pass 1 receipt. On completion, tell the user completion count, agreement count, dispute count, and whether Pass 2 is needed.
5. Synthesize the claim matrix in the parent: agreements, disputed claims, missing proof, owner decisions, and at most five material relay claims per advisor.
6. For Pass 2, tell the user which claims are relayed and why they matter. Resume each advisor with a curated challenge packet. A resume needs a retained run id and task; it excludes `agent` and rejects `gate`. Record each new run id; Pass 3 resumes those latest ids with new stable keys.
7. Stop at convergence, pass cap, failed fallback, or user interruption. The parent writes the final memo.

If an advisor is not resumable, run the same profile fresh with its Pass 1 report and challenge packet. Label it a fresh-context fallback, not true cross-exam.

Do not set `clarify`, `worktree`, `gate`, tool budgets, or tight usage budgets on advisors. Bound work through the roster, pass cap, and report length.

## Memo

Converged means no disputed claim remains that both affects the recommendation and can plausibly be settled by advisor evidence. Put unresolved disputes in owner decisions. Do not add a round for polish or symmetry.

The memo states:

- question and scope
- recommendation and rationale
- accepted and rejected feedback with reasons
- owner decisions
- evidence and run ids
- confidence and what would change the decision
- roster, passes, fallbacks, and known advisor context modes

Identify advisors by profile name. State when fallback `oracle` was forked and context-aware. Escalate to a writer only after the memo and only when the user requests it.
