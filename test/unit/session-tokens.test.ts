import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { parseSessionTokens, parseSessionUsage } from "../../src/shared/session-tokens.ts";

type FixtureUsage = {
	input?: number;
	inputTokens?: number;
	output?: number;
	outputTokens?: number;
	cacheRead?: number;
	cacheReadTokens?: number;
	cacheWrite?: number;
	totalTokens?: number;
	cost?: { total?: number } | number;
};

function writeSession(dir: string, lines: string[]): string {
	const file = path.join(dir, "session.jsonl");
	fs.writeFileSync(file, lines.join("\n"), "utf-8");
	return dir;
}

function assistantUsage(usage: FixtureUsage): string {
	return JSON.stringify({ type: "message", message: { role: "assistant", content: [], usage } });
}

function withTempDir(run: (root: string) => void): void {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-session-usage-"));
	try {
		run(root);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}

describe("parseSessionUsage", () => {
	it("sums standard message usage blocks and counts assistant turns", () => {
		withTempDir((root) => {
			writeSession(root, [
				assistantUsage({ input: 100, output: 50, cacheRead: 10, cacheWrite: 5, totalTokens: 165, cost: { total: 0.001 } }),
				assistantUsage({ input: 200, output: 60, cacheRead: 20, cacheWrite: 0, totalTokens: 280, cost: { total: 0.002 } }),
			]);
			assert.deepEqual(parseSessionUsage(root), {
				input: 300,
				output: 110,
				cacheRead: 30,
				cacheWrite: 5,
				cost: 0.003,
				turns: 2,
			});
		});
	});

	it("tolerates provider field variants and numeric cost", () => {
		withTempDir((root) => {
			writeSession(root, [
				assistantUsage({ inputTokens: 40, outputTokens: 20, cacheReadTokens: 8, cost: 0.0005 }),
			]);
			assert.deepEqual(parseSessionUsage(root), {
				input: 40,
				output: 20,
				cacheRead: 8,
				cacheWrite: 0,
				cost: 0.0005,
				turns: 1,
			});
		});
	});

	it("reads top-level entry usage and ignores non-assistant turns for the turn count", () => {
		withTempDir((root) => {
			writeSession(root, [
				JSON.stringify({ type: "compaction", usage: { input: 500, output: 100, totalTokens: 600, cost: { total: 0.01 } } }),
				JSON.stringify({ type: "message", message: { role: "toolResult", usage: { input: 0, output: 0, totalTokens: 0, cost: { total: 0 } } } }),
			]);
			assert.deepEqual(parseSessionUsage(root), {
				input: 500,
				output: 100,
				cacheRead: 0,
				cacheWrite: 0,
				cost: 0.01,
				turns: 0,
			});
		});
	});

	it("ignores malformed lines, negative and non-numeric values", () => {
		withTempDir((root) => {
			writeSession(root, [
				"not json {",
				JSON.stringify({ type: "message", message: { role: "assistant", content: [], usage: { input: -5, output: "lots", cacheRead: null, cost: { total: -1 } } } }),
				assistantUsage({ input: 10, output: 5, totalTokens: 15, cost: { total: 0.001 } }),
			]);
			assert.deepEqual(parseSessionUsage(root), {
				input: 10,
				output: 5,
				cacheRead: 0,
				cacheWrite: 0,
				cost: 0.001,
				turns: 2,
			});
		});
	});

	it("returns null without a session file and leaves parseSessionTokens untouched", () => {
		const missing = path.join(os.tmpdir(), `pi-session-usage-missing-${Date.now()}`);
		assert.equal(parseSessionUsage(missing), null);
		withTempDir((root) => {
			assert.equal(parseSessionUsage(root), null);
			assert.equal(parseSessionTokens(root), null);
		});
	});
});
