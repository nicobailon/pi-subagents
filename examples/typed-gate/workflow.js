// Run from this directory:
//   subagent({ workflowScriptPath: "workflow.js", agentScope: "both" })
//
// Shape 1: a typed gate grades the reviewer's report the moment the child finishes.
// Shape 2: the classifier agent is a typed step the workflow fans out and branches on.

const review = await runs.run("review", {
  agent: "reviewer",
  task: "Review src/ for correctness. Read-only. Write the full review to the output path.",
  output: "reports/review.md",
  outputMode: "file-only",
  gate: {
    command: "./classify --report reports/review.md",
    output: "json",
    schema: { type: "object", properties: { verdict: { enum: ["ok", "blocked"] }, risk: { type: "number" } }, required: ["verdict", "risk"] }
  }
});

const items = [
  { key: "i1", text: "Title: cleanup deletes branches with unpushed commits. Blocker: lost work." },
  { key: "i2", text: "Title: typo in docs. LGTM otherwise." }
];
const triage = await runs.all(items.map((item) => ({ key: item.key, agent: "classifier", task: item.text })));
const routed = triage.map((r, i) => {
  const parsed = JSON.parse(r.output.slice(r.output.indexOf("{")));
  return { key: items[i].key, verdict: parsed.verdict, risk: parsed.risk, lane: parsed.risk > 0.5 ? "strong-review" : "fast-lane" };
});

return {
  review: { verdict: review.structuredOutput.verdict, risk: review.structuredOutput.risk, report: review.outputReference },
  routed
};
