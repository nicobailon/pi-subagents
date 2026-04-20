import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { createTempDir, removeTempDir, tryImport } from "../support/helpers.ts";

interface SessionTokensModule {
	parseSessionTokens(sessionDir: string): { input: number; output: number; total: number } | null;
}

const tokensMod = await tryImport<SessionTokensModule>("./session-tokens.ts");
const available = !!tokensMod;

describe("session tokens", { skip: !available ? "pi packages not available" : undefined }, () => {
	it("parses token usage from session message entries", () => {
		const sessionDir = createTempDir("pi-subagent-session-tokens-");
		try {
			const sessionFile = path.join(sessionDir, "2026-01-01T00-00-00-000Z_test.jsonl");
			const lines = [
				JSON.stringify({
					type: "message",
					message: {
						role: "assistant",
						usage: { input: 120, output: 30 },
					},
				}),
				JSON.stringify({
					type: "message",
					message: {
						role: "assistant",
						usage: { inputTokens: 80, outputTokens: 20 },
					},
				}),
			].join("\n");
			fs.writeFileSync(sessionFile, lines + "\n", "utf-8");

			const tokens = tokensMod!.parseSessionTokens(sessionDir);
			assert.deepEqual(tokens, { input: 200, output: 50, total: 250 });
		} finally {
			removeTempDir(sessionDir);
		}
	});
});
