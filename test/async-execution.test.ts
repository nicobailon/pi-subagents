/**
 * Integration tests for async (background) agent execution.
 *
 * Tests the async support utilities: jiti availability check,
 * status file reading/caching.
 *
 * Requires pi packages to be importable. Skips gracefully if unavailable.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { createTempDir, removeTempDir, tryImport } from "./helpers.ts";

// Top-level await
const asyncMod = await tryImport<any>("./async-execution.ts");
const utils = await tryImport<any>("./utils.ts");
const available = !!(asyncMod && utils);

const isAsyncAvailable = asyncMod?.isAsyncAvailable;
const readStatus = utils?.readStatus;

describe("async execution utilities", { skip: !available ? "pi packages not available" : undefined }, () => {
	it("reports jiti availability as boolean", () => {
		const result = isAsyncAvailable();
		assert.equal(typeof result, "boolean");
	});

	it("readStatus returns null for missing directory", () => {
		const status = readStatus("/nonexistent/path/abc123");
		assert.equal(status, null);
	});

	it("readStatus parses valid status file", () => {
		const dir = createTempDir();
		try {
			const statusData = {
				runId: "test-123",
				state: "running",
				mode: "single",
				startedAt: Date.now(),
				lastUpdate: Date.now(),
				steps: [{ agent: "test", status: "running" }],
			};
			fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify(statusData));

			const status = readStatus(dir);
			assert.ok(status, "should parse status");
			assert.equal(status.runId, "test-123");
			assert.equal(status.state, "running");
			assert.equal(status.mode, "single");
		} finally {
			removeTempDir(dir);
		}
	});

	it("readStatus preserves model attempt metadata", () => {
		const dir = createTempDir();
		try {
			const statusData = {
				runId: "test-456",
				state: "complete",
				mode: "chain",
				startedAt: Date.now(),
				lastUpdate: Date.now(),
				steps: [{
					agent: "worker",
					status: "complete",
					requestedModel: "openai/gpt-4.1",
					finalModel: "google/gemini-2.5-pro",
					lastFallbackReason: "429 rate limit",
					modelAttempts: [
						{ model: "openai/gpt-4.1", source: "agent", outcome: "failed", classification: "retryable-runtime" },
						{ model: "google/gemini-2.5-pro", source: "fallback", outcome: "success" },
					],
				}],
			};
			fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify(statusData));

			const status = readStatus(dir);
			assert.ok(status);
			assert.equal(status.steps?.[0]?.requestedModel, "openai/gpt-4.1");
			assert.equal(status.steps?.[0]?.finalModel, "google/gemini-2.5-pro");
			assert.equal(status.steps?.[0]?.modelAttempts?.length, 2);
		} finally {
			removeTempDir(dir);
		}
	});

	it("readStatus caches by mtime (second call uses cache)", () => {
		const dir = createTempDir();
		try {
			const statusData = {
				runId: "cache-test",
				state: "running",
				mode: "single",
				startedAt: Date.now(),
			};
			fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify(statusData));

			const s1 = readStatus(dir);
			const s2 = readStatus(dir);
			assert.ok(s1);
			assert.ok(s2);
			assert.equal(s1.runId, s2.runId);
		} finally {
			removeTempDir(dir);
		}
	});
});
