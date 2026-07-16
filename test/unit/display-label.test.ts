import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveDisplayLabel, resolveSiblingDisplayLabels, sanitizeDisplayLabel } from "../../src/runs/shared/display-label.ts";

describe("display labels", () => {
	it("prefers and sanitizes explicit labels", () => {
		assert.equal(resolveDisplayLabel({ label: "  Review\n API\u001b[31m  ", task: "ignored", agent: "scout" }), "Review API");
	});

	it("derives a compact deterministic fallback from the task", () => {
		assert.equal(
			resolveDisplayLabel({ task: "Please inspect the authentication middleware and report security issues", agent: "scout" }),
			"inspect the authentication middleware and report security",
		);
	});

	it("falls back to role and ordinal when a task has no usable text", () => {
		assert.equal(resolveDisplayLabel({ task: "{task}", agent: "reviewer", ordinal: 3 }), "reviewer 3");
	});

	it("deduplicates sibling labels without changing their order", () => {
		assert.deepEqual(
			resolveSiblingDisplayLabels([
				{ agent: "scout", task: "Review auth" },
				{ agent: "scout", task: "Review auth" },
				{ agent: "scout", task: "Review cache" },
			], (item) => item),
			["Review auth #1", "Review auth #2", "Review cache"],
		);
	});

	it("preserves duplicate explicit labels while suffixing colliding fallbacks", () => {
		assert.deepEqual(
			resolveSiblingDisplayLabels([
				{ agent: "scout", task: "Review auth", label: "Review auth" },
				{ agent: "scout", task: "Review auth", label: "Review auth" },
				{ agent: "scout", task: "Review auth" },
			], (item) => item),
			["Review auth", "Review auth", "Review auth #3"],
		);
	});

	it("bounds labels used in persisted status and TUI rows", () => {
		assert.equal(sanitizeDisplayLabel("x".repeat(100))?.length, 64);
	});
});
