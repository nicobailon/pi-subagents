# Council Mode Pass Contracts

Load this before launching council advisors.

## Pass 1 report

Native Pi advisors should receive this `outputSchema`. External runners should receive the same shape as plain JSON text and no `outputSchema`.

```js
const pass1OutputSchema = {
  type: "object",
  required: [
    "recommendation",
    "evidence",
    "assumptions",
    "risks",
    "confidence",
    "challengeClaims",
    "ownerDecisions",
    "changeMyMind"
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

Task text:

- inspect supplied evidence directly
- do not ask other advisors or read peer reports
- stay read-only
- do not spawn children
- return only the structured report
- keep the report under about 600 words

For external runners, say: `Return only JSON matching this shape. Do not wrap it in Markdown.` Include any evidence they cannot read with tools.

## Pass 1 aggregate receipt

Return one aggregate receipt. Preserve result order or map it by stable key.

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

Do not replace `runtime-default-unknown` with a guessed context.

## Pass 2 challenge

A challenge packet contains only disputed claims, strong conflicting evidence, missing proof, owner decisions, and high-impact risks. Attribute peer content as "another advisor". Do not include full peer reports.

Native Pi advisors receive `pass2OutputSchema`. External runners and fresh external fallbacks receive the same shape as JSON-only task text and no `outputSchema`.

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
          disposition: { enum: ["accept", "reject", "refine", "owner-decision"] },
          reason: { type: "string" },
          sources: { type: "array", items: { type: "string" } }
        }
      }
    },
    recommendationChanged: {
      type: "object",
      required: ["changed", "reason"],
      properties: {
        changed: { type: "boolean" },
        reason: { type: "string" }
      }
    },
    outOfScopeFindings: { type: "array", items: { type: "string" } }
  }
};
```

Use stable resume keys such as `cross-oracle`, `phase: "Council pass 2"`, concise labels, and `output: false` unless separate artifacts are useful. The aggregate Pass 2 receipt uses the Pass 1 row shape with the new `runId` and `structuredOutput ?? output`. Pass 3 resumes those latest ids with new stable keys.

## Advisor profile template

Create model-based advisors in the user or project agent directory, not in this package:

```markdown
---
name: council-sol
description: Read-only fresh-context advisor for bounded council decisions
tools: read, grep, find, ls
model: provider/top-reasoning-model
thinking: high
systemPromptMode: replace
inheritProjectContext: true
inheritSkills: false
defaultContext: fresh
acceptanceRole: read-only
---

Analyze the council question independently. Inspect evidence directly. Do not edit, run mutating commands, commit, push, contact peers, or spawn subagents. Return concise, cited advice using the report contract in the council task.
```
