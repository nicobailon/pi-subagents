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
				{ agent: "worker", task: "Fix bug", acceptance: { criteria: ["Patch bug"], evidence: ["changed-files", "commands-run"] } },
				{
					parallel: [
						{ agent: "reviewer", task: "Review", acceptance: { criteria: ["Return concrete findings"] } },
					],
				},
			],
		}), "project", "/tmp/accepted-chain.chain.json");

		assert.deepEqual((parsed.steps[0] as { acceptance?: unknown }).acceptance, { criteria: ["Patch bug"], evidence: ["changed-files", "commands-run"] });
		assert.deepEqual(((parsed.steps[1] as { parallel?: Array<{ acceptance?: unknown }> }).parallel?.[0]?.acceptance), { criteria: ["Return concrete findings"] });
		assert.throws(
			() => parseJsonChain(JSON.stringify({
				name: "bad-acceptance",
				description: "Bad acceptance",
				chain: [{ agent: "worker", acceptance: { level: "none" } }],
			}), "project", "/tmp/bad-acceptance.chain.json"),
			/step 1 acceptance\.level is no longer supported/,
		);
		assert.throws(
			() => parseJsonChain(JSON.stringify({
				name: "bad-criterion",
				description: "Bad criterion",
				chain: [{ agent: "worker", acceptance: { criteria: [{ must: "Patch" }] } }],
			}), "project", "/tmp/bad-criterion.chain.json"),
			/step 1 acceptance\.criteria\[0\]\.id is required/,
		);
		assert.throws(
			() => parseJsonChain(JSON.stringify({
				name: "bad-key",
				description: "Bad key",
				chain: [{ agent: "worker", acceptance: { criteria: ["Patch"], maxFinalizationTurn: 2 } }],
			}), "project", "/tmp/bad-key.chain.json"),
			/step 1 acceptance\.maxFinalizationTurn is not supported/,
		);
		assert.throws(
			() => parseJsonChain(JSON.stringify({
				name: "group-acceptance",
				description: "Group acceptance",
				chain: [{ parallel: [{ agent: "worker" }], acceptance: { criteria: ["Group done"] } }],
			}), "project", "/tmp/group-acceptance.chain.json"),
			/static parallel groups/,
		);
		assert.throws(
			() => parseJsonChain(JSON.stringify({
				name: "dynamic-group-acceptance",
				description: "Dynamic group acceptance",
				chain: [{ expand: { from: { output: "targets", path: "/items" }, maxItems: 2 }, parallel: { agent: "worker" }, collect: { as: "done" }, acceptance: { criteria: ["Group done"] } }],
			}), "project", "/tmp/dynamic-group-acceptance.chain.json"),
			/dynamic fanout groups/,
		);
	});
});
