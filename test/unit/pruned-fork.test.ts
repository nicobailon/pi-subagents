import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { createForkContextResolver } from "../../src/shared/fork-context.ts";
import { pruneForkSessionFile, prunedForkRecoveryPath, type PrunedForkRecoveryPayload } from "../../src/shared/pruned-fork.ts";

function writeJsonl(filePath: string, entries: unknown[]): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf-8");
}

function largeForkEntries(parentSession: string): unknown[] {
	return [
		{ type: "session", version: 1, id: "child", timestamp: "2026-08-24T00:00:00.000Z", cwd: "/tmp", parentSession },
		{ type: "message", id: "user-1", parentId: null, timestamp: "2026-08-24T00:00:01.000Z", message: { role: "user", content: "Keep this recent user decision exact." } },
		{ type: "message", id: "assistant-call", parentId: "user-1", timestamp: "2026-08-24T00:00:02.000Z", message: { role: "assistant", provider: "anthropic", api: "anthropic-messages", model: "anthropic/claude", content: [
			{ type: "thinking", thinking: "private", thinkingSignature: "signed" },
			{ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "large.txt" } },
		] } },
		{ type: "message", id: "tool-result", parentId: "assistant-call", timestamp: "2026-08-24T00:00:03.000Z", message: { role: "toolResult", toolCallId: "tool-1", toolName: "read", content: [{ type: "text", text: "raw-parent-output-".repeat(6_000) }], isError: false } },
	];
}

function validSummaryResponse(payload: string, text = "The large read established the current implementation state."): string {
	const request = JSON.parse(payload) as { items: Array<{ itemId: string }> };
	return JSON.stringify({ summaries: request.items.map((item) => ({ itemId: item.itemId, summary: text })) });
}

function readRecovery(sessionFile: string): PrunedForkRecoveryPayload {
	return JSON.parse(fs.readFileSync(prunedForkRecoveryPath(sessionFile), "utf-8")) as PrunedForkRecoveryPayload;
}

describe("pruned fork sessions", () => {
	it("spills transcript overflow to private recovery with stable visible refs", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-pruned-fork-"));
		try {
			const parentSession = path.join(tempDir, "parent.jsonl");
			const childSession = path.join(tempDir, "child.jsonl");
			writeJsonl(parentSession, [{ type: "session", version: 1, id: "parent", cwd: "/tmp" }]);
			writeJsonl(childSession, largeForkEntries(parentSession));
			fs.chmodSync(childSession, 0o600);
			const fullSize = fs.statSync(childSession).size;

			assert.equal(await pruneForkSessionFile(childSession, async (payload) => validSummaryResponse(payload)), true);
			const prunedText = fs.readFileSync(childSession, "utf-8");
			const entries = prunedText.trim().split("\n").map((line) => JSON.parse(line));
			const recovery = readRecovery(childSession);
			const record = recovery.records[0]!;
			assert.equal(entries[0].parentSession, parentSession);
			assert.equal(recovery.parentSession, parentSession);
			assert.equal(recovery.sourceHeadEntryId, "tool-result");
			assert.equal(record.sourceEntryId, "tool-result");
			assert.equal(record.kind, "tool-result");
			assert.equal(record.toolCallId, "tool-1");
			assert.equal(record.toolName, "read");
			assert.equal(record.isError, false);
			assert.equal(record.utf8Bytes, Buffer.byteLength(record.body, "utf8"));
			assert.equal(record.utf16CodeUnits, record.body.length);
			assert.match(record.bodyDigest, /^sha256:[a-f0-9]{64}$/);
			assert.ok(prunedText.includes(`\\\"batchId\\\":\\\"${recovery.batchId}\\\"`));
			assert.ok(prunedText.includes(`\\\"itemId\\\":\\\"${record.itemId}\\\"`));
			assert.ok(prunedText.includes("Keep this recent user decision exact."));
			assert.ok(!prunedText.includes("raw-parent-output-raw-parent-output"));
			assert.ok(fs.statSync(childSession).size < fullSize / 4);
			if (process.platform !== "win32") {
				assert.equal(fs.statSync(childSession).mode & 0o777, 0o600);
				assert.equal(fs.statSync(prunedForkRecoveryPath(childSession)).mode & 0o777, 0o600);
			}
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("summarizes non-tool assistant overflow before user text", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-pruned-assistant-"));
		try {
			const parentSession = path.join(tempDir, "parent.jsonl");
			const childSession = path.join(tempDir, "child.jsonl");
			const assistantBody = "old-assistant-overflow-".repeat(4_000);
			writeJsonl(childSession, [
				{ type: "session", version: 1, id: "child", cwd: "/tmp", parentSession },
				{ type: "message", id: "assistant-old", parentId: null, message: { role: "assistant", content: [{ type: "text", text: assistantBody }] } },
				{ type: "message", id: "user-recent", parentId: "assistant-old", message: { role: "user", content: "Recent exact decision." } },
			]);
			await pruneForkSessionFile(childSession, async (payload) => validSummaryResponse(payload, "Older assistant context summarized."));
			const text = fs.readFileSync(childSession, "utf-8");
			assert.ok(text.includes("Older assistant context summarized."));
			assert.ok(text.includes("Recent exact decision."));
			assert.ok(!text.includes(assistantBody));
			assert.equal(readRecovery(childSession).records[0]?.kind, "assistant-text");
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("fails closed for invalid JSON and missing item summaries", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-pruned-invalid-summary-"));
		try {
			const childSession = path.join(tempDir, "child.jsonl");
			writeJsonl(childSession, largeForkEntries(path.join(tempDir, "parent.jsonl")));
			const before = fs.readFileSync(childSession, "utf-8");
			await assert.rejects(() => pruneForkSessionFile(childSession, async () => "not-json"), /invalid JSON/);
			await assert.rejects(() => pruneForkSessionFile(childSession, async () => '{"summaries":[]}'), /exactly one summary/);
			assert.equal(fs.readFileSync(childSession, "utf-8"), before);
			assert.equal(fs.existsSync(prunedForkRecoveryPath(childSession)), false);
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("rejects a newline-escaped duplicate of a spilled raw body", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-pruned-raw-leak-"));
		try {
			const parentSession = path.join(tempDir, "parent.jsonl");
			const childSession = path.join(tempDir, "child.jsonl");
			const duplicateBody = "duplicate-overflow-body\n".repeat(1_800);
			writeJsonl(childSession, [
				{ type: "session", version: 1, id: "child", cwd: "/tmp", parentSession },
				{ type: "message", id: "assistant-1", parentId: null, message: { role: "assistant", content: [{ type: "text", text: duplicateBody }] } },
				{ type: "message", id: "assistant-2", parentId: "assistant-1", message: { role: "assistant", content: [{ type: "text", text: duplicateBody }] } },
			]);
			await assert.rejects(() => pruneForkSessionFile(childSession, async (payload) => validSummaryResponse(payload)), /raw overflow leak/);
			assert.equal(fs.existsSync(prunedForkRecoveryPath(childSession)), false);
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("rejects a duplicate spilled tool-call argument after parsing", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-pruned-tool-call-leak-"));
		try {
			const parentSession = path.join(tempDir, "parent.jsonl");
			const childSession = path.join(tempDir, "child.jsonl");
			const duplicateValue = "duplicate-tool-call\n".repeat(2_160);
			writeJsonl(childSession, [
				{ type: "session", version: 1, id: "child", cwd: "/tmp", parentSession },
				{ type: "message", id: "assistant-1", parentId: null, message: { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "write", arguments: { value: duplicateValue, path: "same.txt" } }] } },
				{ type: "message", id: "assistant-2", parentId: "assistant-1", message: { role: "assistant", content: [{ type: "toolCall", id: "call-2", name: "write", arguments: { path: "same.txt", value: duplicateValue } }] } },
			]);
			await assert.rejects(() => pruneForkSessionFile(childSession, async (payload) => validSummaryResponse(payload)), /raw overflow leak/);
			assert.equal(fs.existsSync(prunedForkRecoveryPath(childSession)), false);
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("fails closed on recovery validation and an unspillable budget overflow", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-pruned-budget-"));
		try {
			const parentSession = path.join(tempDir, "parent.jsonl");
			const invalidRecoverySession = path.join(tempDir, "invalid-recovery.jsonl");
			writeJsonl(invalidRecoverySession, largeForkEntries(parentSession));
			await assert.rejects(
				() => pruneForkSessionFile(invalidRecoverySession, async (payload) => validSummaryResponse(payload), { validateRecovery: () => false }),
				/recovery payload failed validation/,
			);
			assert.equal(fs.existsSync(prunedForkRecoveryPath(invalidRecoverySession)), false);

			const opaqueSession = path.join(tempDir, "opaque.jsonl");
			writeJsonl(opaqueSession, [
				{ type: "session", version: 1, id: "child", cwd: "/tmp", parentSession },
				{ type: "custom", id: "opaque-head", parentId: null, customType: "opaque", data: { raw: "x".repeat(80_000) } },
			]);
			await assert.rejects(() => pruneForkSessionFile(opaqueSession, async () => ""), /no spillable overflow items/);
			assert.equal(fs.existsSync(prunedForkRecoveryPath(opaqueSession)), false);
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("blocks fork use until overflow pruning succeeds and keeps thinking sanitization", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-pruned-resolver-"));
		try {
			const parentSession = path.join(tempDir, "parent.jsonl");
			const childSession = path.join(tempDir, "child.jsonl");
			writeJsonl(parentSession, [{ type: "session", version: 1, id: "parent", cwd: "/tmp" }]);
			writeJsonl(childSession, largeForkEntries(parentSession));
			const resolver = createForkContextResolver({ getSessionFile: () => parentSession, getLeafId: () => "tool-result" }, "fork", {
				openSession: () => ({ createBranchedSession: () => childSession }),
				pruneSession: (file) => pruneForkSessionFile(file, async (payload) => validSummaryResponse(payload)),
			});

			assert.throws(() => resolver.sessionFileForIndex(0), /before pruning completed/);
			await resolver.prepareSessionForIndex(0);
			assert.equal(resolver.sessionFileForIndex(0), childSession);
			assert.equal(resolver.thinkingOverrideForIndex(0), "off");
			const text = fs.readFileSync(childSession, "utf-8");
			assert.ok(!text.includes("thinkingSignature"));
			assert.equal(JSON.parse(text.split("\n")[0]!).parentSession, parentSession);
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("does not expose a full fork after pruning fails", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-pruned-failure-"));
		try {
			const parentSession = path.join(tempDir, "parent.jsonl");
			const childSession = path.join(tempDir, "child.jsonl");
			writeJsonl(parentSession, [{ type: "session", version: 1, id: "parent", cwd: "/tmp" }]);
			writeJsonl(childSession, largeForkEntries(parentSession));
			const resolver = createForkContextResolver({ getSessionFile: () => parentSession, getLeafId: () => "tool-result" }, "fork", {
				openSession: () => ({ createBranchedSession: () => childSession }),
				pruneSession: async () => { throw new Error("model failed"); },
			});
			await assert.rejects(() => resolver.prepareSessionForIndex(0), /model failed/);
			assert.throws(() => resolver.sessionFileForIndex(0), /before pruning completed/);
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});
});
