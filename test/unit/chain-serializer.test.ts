import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseChain, parseJsonChain, serializeChain, serializeJsonChain } from "../../src/agents/chain-serializer.ts";

const chainContent = `---
name: review-chain
description: Review chain
---

## reviewer
output: report.md
outputMode: file-only

Review the diff
`;

describe("chain serializer", () => {
	it("round-trips step outputMode", () => {
		const parsed = parseChain(chainContent, "project", "/tmp/review-chain.md");

		assert.equal(parsed.steps[0]?.outputMode, "file-only");
		assert.match(serializeChain(parsed), /outputMode: file-only/);
	});

	it("round-trips phase, label, as, and path-based outputSchema", () => {
		const parsed = parseChain(`---
name: review-chain
description: Review chain
---

## reviewer
phase: Review
label: correctness pass
as: correctnessFindings
outputSchema: ./schemas/finding.schema.json

Review the diff
`, "project", "/tmp/review-chain.md");

		assert.equal(parsed.steps[0]?.phase, "Review");
		assert.equal(parsed.steps[0]?.label, "correctness pass");
		assert.equal(parsed.steps[0]?.as, "correctnessFindings");
		assert.equal(parsed.steps[0]?.outputSchema, "./schemas/finding.schema.json");
		const serialized = serializeChain(parsed);
		assert.match(serialized, /phase: Review/);
		assert.match(serialized, /label: correctness pass/);
		assert.match(serialized, /as: correctnessFindings/);
		assert.match(serialized, /outputSchema: \.\/schemas\/finding\.schema\.json/);
	});

	it("round-trips markdown chain toolBudget", () => {
		const parsed = parseChain(`---
name: review-chain
description: Review chain
---

## reviewer
toolBudget: {"soft":3,"hard":5,"block":["read","grep"]}

Review the diff
`, "project", "/tmp/review-chain.md");

		assert.deepEqual(parsed.steps[0]?.toolBudget, { soft: 3, hard: 5, block: ["read", "grep"] });
		assert.match(serializeChain(parsed), /toolBudget: \{"soft":3,"hard":5,"block":\["read","grep"\]\}/);
	});

	it("rejects invalid markdown chain toolBudget", () => {
		assert.throws(
			() => parseChain(`---
name: review-chain
description: Review chain
---

## reviewer
toolBudget: {"soft":6,"hard":5}

Review the diff
`, "project", "/tmp/review-chain.md"),
			/toolBudget for step 'reviewer'\.soft must be <= toolBudget for step 'reviewer'\.hard/,
		);
	});

	it("rejects inline outputSchema values in markdown chains", () => {
		assert.throws(
			() => parseChain(`---
name: review-chain
description: Review chain
---

## reviewer
outputSchema: {"type":"object"}

Review the diff
`, "project", "/tmp/review-chain.md"),
			/Inline outputSchema values are not supported/,
		);
	});

	it("rejects invalid dynamic JSON chains with useful diagnostics", () => {
		assert.throws(
			() => parseJsonChain(JSON.stringify({
				name: "bad-dynamic-review",
				description: "Bad dynamic targets",
				chain: [
					{ agent: "scout", task: "Return targets", as: "targets", outputSchema: { type: "object" } },
					{
						expand: { from: { output: "targets", path: "/items" }, maxItems: 4 },
						parallel: [{ agent: "reviewer", task: "Review" }],
						collect: { as: "reviews" },
					},
				],
			}), "project", "/tmp/bad-dynamic-review.chain.json"),
			/static parallel arrays/,
		);
		assert.throws(
			() => parseJsonChain(JSON.stringify({ name: "bad", description: "Bad", chain: [1] }), "project", "/tmp/bad.chain.json"),
			/step 1 must be an object/,
		);
	});

	it("serializes JSON chains back to JSON", () => {
		const parsed = parseJsonChain(JSON.stringify({
			name: "dynamic-review",
			package: "code-analysis",
			description: "Review dynamic targets",
			chain: [
				{ agent: "scout", task: "Return targets", as: "targets", outputSchema: { type: "object" } },
				{
					expand: { from: { output: "targets", path: "/items" }, item: "target", key: "/path", maxItems: 4 },
					parallel: { agent: "reviewer", task: "Review {target.path}", outputSchema: { type: "object" } },
					collect: { as: "reviews" },
				},
			],
		}), "project", "/tmp/dynamic-review.chain.json");

		const serialized = serializeJsonChain(parsed);
		assert.doesNotMatch(serialized, /^---/);
		const reparsed = JSON.parse(serialized) as { name?: string; package?: string; chain?: Array<{ collect?: { as?: string } }> };
		assert.equal(reparsed.name, "dynamic-review");
		assert.equal(reparsed.package, "code-analysis");
		assert.equal(reparsed.chain?.[1]?.collect?.as, "reviews");
	});

	it("parses declarative JSON chains with dynamic fanout toolBudget", () => {
		const parsed = parseJsonChain(JSON.stringify({
			name: "dynamic-review",
			description: "Review dynamic targets",
			chain: [
				{ agent: "scout", task: "Return targets", as: "targets", outputSchema: { type: "object" }, toolBudget: { hard: 4 } },
				{
					expand: { from: { output: "targets", path: "/items" }, item: "target", key: "/path", maxItems: 4 },
					parallel: { agent: "reviewer", task: "Review {target.path}", outputSchema: { type: "object" }, toolBudget: { soft: 3, hard: 5 } },
					collect: { as: "reviews" },
				},
			],
		}), "project", "/tmp/dynamic-review.chain.json");

		assert.deepEqual((parsed.steps[0] as { toolBudget?: unknown }).toolBudget, { hard: 4 });
		assert.deepEqual((parsed.steps[1] as { parallel?: { toolBudget?: unknown } }).parallel?.toolBudget, { soft: 3, hard: 5 });
	});

	it("rejects invalid JSON chain toolBudget", () => {
		assert.throws(
			() => parseJsonChain(JSON.stringify({
				name: "bad-tool-budget",
				description: "Bad tool budget",
				chain: [{ agent: "worker", toolBudget: { hard: 0 } }],
			}), "project", "/tmp/bad-tool-budget.chain.json"),
			/step 1 toolBudget\.hard must be an integer >= 1/,
		);
		assert.throws(
			() => parseJsonChain(JSON.stringify({
				name: "bad-dynamic-tool-budget",
				description: "Bad dynamic tool budget",
				chain: [
					{ agent: "scout", task: "Return targets", as: "targets", outputSchema: { type: "object" } },
					{ expand: { from: { output: "targets", path: "/items" }, maxItems: 4 }, parallel: { agent: "worker", toolBudget: { hard: 3, block: [] } }, collect: { as: "reviews" } },
				],
			}), "project", "/tmp/bad-dynamic-tool-budget.chain.json"),
			/step 2 dynamic template toolBudget\.block must contain at least one tool name/,
		);
	});

	it("parses declarative JSON chains with dynamic fanout", () => {
		const parsed = parseJsonChain(JSON.stringify({
			name: "dynamic-review",
			description: "Review dynamic targets",
			chain: [
				{ agent: "scout", task: "Return targets", as: "targets", outputSchema: { type: "object" } },
				{
					expand: { from: { output: "targets", path: "/items" }, item: "target", key: "/path", maxItems: 4 },
					parallel: { agent: "reviewer", task: "Review {target.path}", outputSchema: { type: "object" } },
					collect: { as: "reviews" },
				},
			],
		}), "project", "/tmp/dynamic-review.chain.json");

		assert.equal(parsed.name, "dynamic-review");
		assert.equal(parsed.steps.length, 2);
		assert.deepEqual((parsed.steps[1] as { collect?: { as?: string } }).collect, { as: "reviews" });
		assert.deepEqual((parsed.steps[0] as { outputSchema?: unknown }).outputSchema, { type: "object" });
	});

	it("parses and validates acceptance in JSON chains", () => {
		const parsed = parseJsonChain(JSON.stringify({
			name: "accepted-chain",
			description: "Chain with acceptance gates",
			chain: [
				{ agent: "worker", task: "Fix bug", acceptance: { level: "checked", evidence: ["changed-files", "commands-run"] } },
				{
					parallel: [
						{ agent: "reviewer", task: "Review", acceptance: "attested" },
					],
				},
			],
		}), "project", "/tmp/accepted-chain.chain.json");

		assert.deepEqual((parsed.steps[0] as { acceptance?: unknown }).acceptance, { level: "checked", evidence: ["changed-files", "commands-run"] });
		assert.equal(((parsed.steps[1] as { parallel?: Array<{ acceptance?: unknown }> }).parallel?.[0]?.acceptance), "attested");
		assert.throws(
			() => parseJsonChain(JSON.stringify({
				name: "bad-acceptance",
				description: "Bad acceptance",
				chain: [{ agent: "worker", acceptance: { level: "none" } }],
			}), "project", "/tmp/bad-acceptance.chain.json"),
			/step 1 acceptance\.reason is required/,
		);
	});
});
