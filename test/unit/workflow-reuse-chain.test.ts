import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import type { WorkflowScriptChildResult } from "../../src/workflows/scripted-workflow.ts";
import { appendWorkflowChildJournal, matchWorkflowReuse, readNamedWorkflowReuseSource } from "../../src/workflows/workflow-reuse.ts";

const CWD = "/repo";

function okResult(runId: string): WorkflowScriptChildResult {
	// SAFETY: reuse only reads `ok` and `runId` from a settled journal result.
	return { ok: true, runId } as WorkflowScriptChildResult;
}

describe("workflow reuse across a relaunch chain", () => {
	const withRoot = (body: (root: string, writeRun: (runId: string, options?: { reusedFrom?: string; mode?: string; scriptDigest?: string; head?: boolean; records?: Array<{ key: string; start?: string; settle?: string }> }) => void) => void) => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-reuse-chain-"));
		try {
			body(root, (runId, options = {}) => {
				const asyncDir = path.join(root, runId);
				fs.mkdirSync(asyncDir, { recursive: true });
				fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
					runId, sessionId: "session", mode: options.mode ?? "workflow", state: "failed", startedAt: 1, endedAt: 2, cwd: CWD,
					workflow: { trace: [], emits: [], console: [], scriptDigest: options.scriptDigest ?? "digest", ...(options.head ? { stopCause: "runtime-replaced" } : {}), ...(options.reusedFrom ? { reusedFrom: options.reusedFrom } : {}) },
				}));
				for (const record of options.records ?? []) {
					if (record.start) appendWorkflowChildJournal(asyncDir, { type: "start", key: record.key, fingerprint: "fp", runId: record.start });
					if (record.settle) appendWorkflowChildJournal(asyncDir, { type: "settle", key: record.key, fingerprint: "fp", result: okResult(record.settle) });
				}
			});
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	};

	it("takes each key from the newest run that recorded it", () => {
		withRoot((root, writeRun) => {
			writeRun("a", { records: [{ key: "k3", settle: "a-k3" }, { key: "k4", settle: "a-k4" }] });
			writeRun("b", { reusedFrom: "a", records: [{ key: "k1", settle: "b-k1" }, { key: "k2", settle: "b-k2" }, { key: "k3", start: "b-k3" }] });
			writeRun("c", { reusedFrom: "b", head: true, records: [{ key: "k1", start: "c-k1" }] });
			const source = readNamedWorkflowReuseSource(root, "c", "digest", CWD);
			assert.equal(source.runId, "c");
			assert.deepEqual(matchWorkflowReuse(source, "k1", "fp"), { kind: "started", runId: "c-k1" });
			assert.deepEqual(matchWorkflowReuse(source, "k2", "fp"), { kind: "settled", result: okResult("b-k2") });
			assert.deepEqual(matchWorkflowReuse(source, "k3", "fp"), { kind: "started", runId: "b-k3" });
			assert.deepEqual(matchWorkflowReuse(source, "k4", "fp"), { kind: "settled", result: okResult("a-k4") });
		});
	});

	it("stops at a missing link, a non-workflow link, or a different script, keeping what it read", () => {
		for (const [name, link] of [
			["missing", undefined],
			["non-workflow", { mode: "single" }],
			["other script", { scriptDigest: "other" }],
		] as const) {
			withRoot((root, writeRun) => {
				if (link) writeRun("link", { ...link, reusedFrom: "beyond", records: [{ key: "link-key", settle: "link-run" }] });
				writeRun("beyond", { records: [{ key: "beyond-key", settle: "beyond-run" }] });
				writeRun("good", { reusedFrom: "link", records: [{ key: "good-key", settle: "good-run" }] });
				writeRun("head", { head: true, reusedFrom: "good", records: [{ key: "head-key", settle: "head-run" }] });
				const source = readNamedWorkflowReuseSource(root, "head", "digest", CWD);
				assert.equal(matchWorkflowReuse(source, "head-key", "fp")?.kind, "settled", name);
				assert.equal(matchWorkflowReuse(source, "good-key", "fp")?.kind, "settled", name);
				assert.equal(matchWorkflowReuse(source, "link-key", "fp"), undefined, name);
				assert.equal(matchWorkflowReuse(source, "beyond-key", "fp"), undefined, name);
			});
		}
	});

	it("stops at a reusedFrom that is not a string, keeping the head's records", () => {
		for (const reusedFrom of [42, null, { runId: "link" }]) {
			withRoot((root, writeRun) => {
				writeRun("head", { head: true, records: [{ key: "head-key", settle: "head-run" }] });
				const statusPath = path.join(root, "head", "status.json");
				const status = JSON.parse(fs.readFileSync(statusPath, "utf-8"));
				fs.writeFileSync(statusPath, JSON.stringify({ ...status, workflow: { ...status.workflow, reusedFrom } }));
				const source = readNamedWorkflowReuseSource(root, "head", "digest", CWD);
				assert.equal(matchWorkflowReuse(source, "head-key", "fp")?.kind, "settled", JSON.stringify(reusedFrom));
			});
		}
	});

	it("ends on a cycle and after 16 links", () => {
		withRoot((root, writeRun) => {
			writeRun("x", { reusedFrom: "y", records: [{ key: "x-key", settle: "x-run" }] });
			writeRun("y", { reusedFrom: "x", records: [{ key: "y-key", settle: "y-run" }] });
			writeRun("cycle-head", { head: true, reusedFrom: "x" });
			const source = readNamedWorkflowReuseSource(root, "cycle-head", "digest", CWD);
			assert.equal(matchWorkflowReuse(source, "x-key", "fp")?.kind, "settled");
			assert.equal(matchWorkflowReuse(source, "y-key", "fp")?.kind, "settled");
		});
		withRoot((root, writeRun) => {
			for (let link = 1; link <= 17; link++) writeRun(`link-${link}`, { reusedFrom: `link-${link + 1}`, records: [{ key: `key-${link}`, settle: `run-${link}` }] });
			writeRun("long-head", { head: true, reusedFrom: "link-1" });
			const source = readNamedWorkflowReuseSource(root, "long-head", "digest", CWD);
			assert.equal(matchWorkflowReuse(source, "key-16", "fp")?.kind, "settled");
			assert.equal(matchWorkflowReuse(source, "key-17", "fp"), undefined);
		});
	});
});
