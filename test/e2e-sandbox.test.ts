/**
 * E2E test: extension loading and tool registration.
 *
 * Uses pi-test-harness createTestSession to verify that the extension
 * loads correctly and both tools respond to calls.
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { tryImport } from "./helpers.ts";

const harness = await tryImport<any>("@marcfargas/pi-test-harness");
const available = !!harness;

const EXTENSION = path.resolve("index.ts");

describe("extension loading", { skip: !available ? "pi-test-harness not available" : undefined }, () => {
	const { createTestSession, when, calls, says } = harness;
	let t: any;

	afterEach(() => t?.dispose());

	it("loads extension and subagent tool responds", async () => {
		t = await createTestSession({
			extensions: [EXTENSION],
			mockTools: { bash: "ok", read: "ok", write: "ok", edit: "ok" },
		});

		await t.run(
			when("List agents", [
				calls("subagent", { action: "list" }),
				says("Done."),
			]),
		);

		const results = t.events.toolResultsFor("subagent");
		assert.equal(results.length, 1, "subagent tool should respond");
		assert.ok(!results[0].isError, "should not be an error");
	});

	it("subagent_status tool responds", async () => {
		t = await createTestSession({
			extensions: [EXTENSION],
			mockTools: { bash: "ok", read: "ok", write: "ok", edit: "ok" },
		});

		await t.run(
			when("Check status", [
				calls("subagent_status", { id: "nonexistent" }),
				says("Not found."),
			]),
		);

		const results = t.events.toolResultsFor("subagent_status");
		assert.equal(results.length, 1, "subagent_status tool should respond");
		// Nonexistent ID → error result
		assert.ok(results[0].isError, "should be an error for missing ID");
		assert.ok(results[0].text.includes("not found") || results[0].text.includes("Provide"));
	});
});
