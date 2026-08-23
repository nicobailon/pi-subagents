---
name: council-mode
description: Run a bounded supervisor-mediated advisor council. Use when the user asks for council mode, asks to convene advisors, debate a decision, cross-examine recommendations, or run /council.
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

Use advisor profile names directly. A `council-*` profile defines model, tools,
context, output defaults, and any persistent stance in the profile body. Its
profile configuration or explicit invocation owns its context choice.

Package advisors can also join the roster only when their package Pi extension is
installed and their external-job provider is registered. For Surf, `gpt-pro` is
available only after the `surf-cli` Pi extension loads Surf's `surf-oracle`
provider. Treat it as a normal advisor name in `runs.all` after that provider is
visible. It is background-only, so omit `async` unless you explicitly want
detached receipt semantics; workflow execution will await the terminal provider
result. External runners can lack repo tools, structured-output support, or
resumability. For them, include the needed evidence or file excerpts in the task,
use the text JSON contract below instead of `outputSchema`, and use the
fresh-context fallback path for cross-exam when the run is not resumable.

Create model-based profiles in your user or project agent directory. Do not add
them to this package. This is a valid example:

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

Analyze the council question independently. Inspect evidence directly. Do not
edit, run mutating commands, commit, push, contact peers, or spawn subagents.
Return concise, cited advice using the report contract in the council task.
```

After `subagent({ action: "list" })`, prefer 2–3 executable names that start with
`council-`. The prefix is a naming convention, not runtime selection. If fewer
than two profiles are available, fill the roster with `oracle`, then `reviewer`,
until it has two advisors. Launch fallback `oracle` with `context: "fork"` so
global defaults cannot remove its parent-chat context. Let fallback `reviewer`
use its normal profile context. Note the fallback and known context modes in the
memo. Use the normal single-oracle consultation loop only when a requested roster
or unavailable builtins leaves fewer than two advisors.
Label that result as degraded mode. Never use more than four advisors.

Pass 1 is independent reports. Pass 2 is one cross-exam. The default pass cap is
2. Run pass 3 only when `--max-passes 3` was requested and a material dispute can
be settled by evidence an advisor can produce. Never run an unbounded loop.

## Protocol

1. The parent writes a brief with the question, scope, non-goals, evidence targets,
   roster, known advisor context modes, and pass cap. If the user wants a specific
   lens, keep it in the question, scope, or profile body instead of inventing a
   per-advisor label.
2. Before Pass 1, tell the user the roster, requested or known context modes, and
   pass cap. Use a stable key, `phase`, and concise `label` for every
   workflow child. For example, use `advisor-oracle`, `phase: "Council pass 1"`,
   and `label: "Oracle — intent and consistency"`.
3. Launch one async `workflowScript` with `runs.all` for independent advisor
   reports. Set `context` when the selected advisor has a known profile context or
   a fallback rule requests one, because a global default can otherwise override
   that profile. Set `context: "fork"` for fallback `oracle`. If no advisor context
   is known, omit `context` and disclose the unknown runtime default in the memo.
   Each advisor is read-only and must not spawn children, edit files, run mutating
   commands, commit, or push. Set `output: false` unless separate advisor artifacts
   are explicitly requested or useful for the decision. When separate artifacts are
   useful, give advisors relative output paths so the runtime stores them under its
   managed artifact directory; do not ask them to write root-level council report
   files. For installed
   external-runner advisors such as Surf `gpt-pro` after `surf-oracle` is
   registered, do not pass `outputSchema`; put the schema request in the task text
   and accept `result.output` as the report.
4. Return one aggregate Pass 1 receipt. After it completes, tell the user the
   completion count, agreement count, dispute count, and whether Pass 2 is needed.
5. The parent synthesizes a claim matrix in session. It contains agreements,
   disputed claims, missing proof, owner decisions, and a relay set of at most five
   high-impact claims per advisor. Do not delegate this synthesis.
6. Before Pass 2, tell the user how many claims are relayed and why each is
   material. Launch a second async `workflowScript` with `runs.all` resume calls.
   Each task is a curated challenge packet, not a peer transcript. A resume requires
   a retained run id and a non-empty task. It excludes `agent` and rejects `gate`.
   Record the new run id from every resume. Pass 3 resumes those latest ids. Return
   one aggregate Pass 2 receipt.
7. After Pass 2, tell the user whether the council converged or which owner
   decisions remain. The parent writes the final memo. Do not delegate it.

If an advisor is not resumable, run the same profile in fresh context with its own
pass-1 report and the challenge packet. Label that response as a fresh-context
fallback, not a true cross-exam.

Do not set `clarify`, `worktree`, `gate`, turn budgets, tool budgets, or tight usage
budgets on advisors. Bound work through the roster, pass cap, and report length.

## Advisor contracts and pass receipts

Pass-1 reports are at most about 600 words. Give native Pi advisors the same
`outputSchema`, so reports are comparable without heading cleanup. For
external-runner advisors, do not pass `outputSchema`; ask them to return compact
JSON text with the same fields. The following shape is a contract template. Use
the runtime schema syntax supported by the workflow for native advisors and keep
narrative fields as strings:

```js
const pass1OutputSchema = {
  type: "object",
  required: [
    "recommendation", "evidence", "assumptions", "risks", "confidence",
    "challengeClaims", "ownerDecisions", "changeMyMind"
  ],
  properties: {
    recommendation: { type: "string" },
    evidence: {
      type: "array",
      items: {
        type: "object",
        required: ["claim", "sources"],
        properties: {
          claim: { type: "string" },
          sources: { type: "array", items: { type: "string" } }
        }
      }
    },
    assumptions: {
      type: "array",
      items: {
        type: "object",
        required: ["assumption", "status"],
        properties: {
          assumption: { type: "string" },
          status: { enum: ["verified", "unverified"] }
        }
      }
    },
    risks: { type: "array", items: { type: "string" } },
    confidence: {
      type: "object",
      required: ["level", "reason"],
      properties: {
        level: { enum: ["high", "medium", "low"] },
        reason: { type: "string" }
      }
    },
    challengeClaims: { type: "array", items: { type: "string" }, maxItems: 3 },
    ownerDecisions: { type: "array", items: { type: "string" } },
    changeMyMind: { type: "array", items: { type: "string" } }
  }
};
```

Include this contract in each Pass 1 task: inspect supplied evidence directly; do
not see or ask about other advisors; stay read-only; do not spawn children; return
only the structured report. For external-runner advisors, say `Return only JSON
matching this shape. Do not wrap it in Markdown.` and include any evidence they
cannot read through tools.

After `runs.all`, return one aggregate receipt rather than making the parent find
separate artifacts. Preserve the result order or map it by stable key so each row
contains the advisor identity and report:

```js
return {
  pass: 1,
  advisors: results.map((result, index) => ({
    key: result.key,
    agent: result.agent,
    requestedContext: roster[index].context ?? "runtime-default-unknown",
    runId: result.runId,
    report: result.structuredOutput ?? result.output
  }))
};
```

Do not replace `runtime-default-unknown` with a guessed context. It records that
the launch intentionally omitted context.

A challenge packet contains only disputed claims, strong conflicting evidence,
missing proof, owner decisions, and high-impact risks. Attribute peer content as
"another advisor". Do not include full peer reports. Use a common Pass 2 contract:

```js
const pass2OutputSchema = {
  type: "object",
  required: ["responses", "recommendationChanged", "outOfScopeFindings"],
  properties: {
    responses: {
      type: "array",
      items: {
        type: "object",
        required: ["claimId", "disposition", "reason", "sources"],
        properties: {
          claimId: { type: "string" },
          disposition: {
            enum: ["accept", "reject", "refine", "owner-decision"]
          },
          reason: { type: "string" },
          sources: { type: "array", items: { type: "string" } }
        }
      }
    },
    recommendationChanged: {
      type: "object",
      required: ["changed", "reason"],
      properties: { changed: { type: "boolean" }, reason: { type: "string" } }
    },
    outOfScopeFindings: { type: "array", items: { type: "string" } }
  }
};
```

Use stable resume keys such as `cross-oracle`, `phase: "Council pass 2"`, concise
labels, and `output: false` unless separate artifacts are requested or useful. Keep
any artifact outputs under the managed run artifact directory. Do not pass
`outputSchema` to external-runner fallback launches; ask for compact JSON text
instead. The aggregate Pass 2 receipt uses the same row shape as Pass 1, with the
new `runId` and `structuredOutput ?? output`.

## Stop and memo

Converged means no disputed claim remains that both materially affects the
recommendation and can plausibly be settled by evidence. Stop at convergence, the
pass cap, failed fallback, or user interruption. Put unresolved disputes in owner
decisions. Never add a round for polish or symmetry.

The parent memo states the question and scope, recommendation, rationale, accepted
and rejected feedback with reasons, owner decisions, evidence and run ids,
confidence, what would change the decision, and the roster, passes, fallbacks, and
known advisor context modes. Identify advisors by profile name or model-based
profile, not by invented role labels. State that fallback `oracle` is context-aware
and forked.

Council mode is not agent-to-agent chat, a transcript dump, mutation authority,
auto-escalation to writer lanes, or a council UI. Escalate to a writer only after
the parent memo and only when the user explicitly requests it.
