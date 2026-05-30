import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { updateDirsForSession, sanitizeTempScopeSegment, DIRS, resolveTempScopeId } from "../../src/shared/types.ts";
import * as path from "node:path";
import * as os from "node:os";

describe("sanitizeTempScopeSegment", () => {
	it("trims and replaces non-alphanumeric chars with dashes", () => {
		assert.equal(sanitizeTempScopeSegment("Hello World!"), "Hello-World");
	});

	it("returns 'unknown' for empty/whitespace-only strings", () => {
		assert.equal(sanitizeTempScopeSegment(""), "unknown");
		assert.equal(sanitizeTempScopeSegment("   "), "unknown");
	});

	it("strips leading/trailing dashes", () => {
		assert.equal(sanitizeTempScopeSegment("--hello--"), "hello");
	});
});

describe("updateDirsForSession", () => {
	it("returns a path containing the base scope and session suffix", () => {
		const baseScopeId = resolveTempScopeId();
		const sessionId = "abc12345def67890";
		const result = updateDirsForSession(sessionId);

		assert.ok(result.includes("pi-subagents-"));
		assert.ok(result.includes(baseScopeId));
		assert.ok(result.includes("abc12345")); // first 8 chars
	});

	it("updates DIRS.results and DIRS.async to be under the session-scoped root", () => {
		const sessionId = "test-session-id-12345";
		updateDirsForSession(sessionId);

		assert.ok(DIRS.results.includes("async-subagent-results"));
		assert.ok(DIRS.async.includes("async-subagent-runs"));
		// substring(0,8) = "test-ses", sanitized = "test-ses" (hyphens kept)
		assert.ok(DIRS.results.includes("test-ses"));
		assert.ok(DIRS.async.includes("test-ses"));
		// All DIRS entries share the session-scoped root
		assert.ok(DIRS.chain.includes("test-ses"));
		assert.ok(DIRS.artifacts.includes("test-ses"));
	});

	it("produces different paths for different session IDs", () => {
		const result1 = updateDirsForSession("aaaa1111-bbb");
		const result2 = updateDirsForSession("cccc2222-ddd");

		assert.notEqual(result1, result2);
	});

	it("handles short session IDs gracefully", () => {
		const sessionId = "ab";
		const result = updateDirsForSession(sessionId);

		assert.ok(result.includes("pi-subagents-"));
		assert.ok(result.includes("ab")); // the short session ID
	});

	it("updates chain and artifacts dirs as well", () => {
		const sessionId = "chain-test-123";
		const result = updateDirsForSession(sessionId);

		assert.ok(DIRS.chain.includes("chain-runs"));
		assert.ok(DIRS.artifacts.includes("artifacts"));
		assert.equal(path.dirname(DIRS.results), result);
		assert.equal(path.dirname(DIRS.async), result);
		assert.equal(path.dirname(DIRS.chain), result);
		assert.equal(path.dirname(DIRS.artifacts), result);
	});
});