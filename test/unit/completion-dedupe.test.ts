import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildCompletionKey, markSeenWithTtl } from "../../src/runs/background/completion-dedupe.ts";

describe("buildCompletionKey", () => {
	it("scopes ids to their owning session", () => {
		const first = buildCompletionKey({ id: "run-123", sessionId: "session-a" }, "fallback");
		const second = buildCompletionKey({ id: "run-123", sessionId: "session-b" }, "fallback");
		assert.equal(first, "session:session-a:id:run-123");
		assert.notEqual(first, second);
	});

	it("builds deterministic fallback key when id is missing", () => {
		const first = buildCompletionKey({ agent: "reviewer", timestamp: 123, taskIndex: 1, totalTasks: 2, success: true }, "x");
		const second = buildCompletionKey({ agent: "reviewer", timestamp: 123, taskIndex: 1, totalTasks: 2, success: true }, "x");
		assert.equal(first, second);
	});
});

describe("markSeenWithTtl", () => {
	it("returns true only for duplicates within ttl", () => {
		const seen = new Map<string, number>();
		const ttlMs = 1000;
		assert.equal(markSeenWithTtl(seen, "k", 100, ttlMs), false);
		assert.equal(markSeenWithTtl(seen, "k", 200, ttlMs), true);
		assert.equal(markSeenWithTtl(seen, "k", 1201, ttlMs), false);
	});
});
