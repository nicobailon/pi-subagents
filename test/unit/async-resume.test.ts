import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { buildRevivedAsyncTask, resolveAsyncResumeTarget } from "../../src/runs/background/async-resume.ts";

function writeJson(filePath: string, value: object): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf-8");
}

describe("async resume lookup", () => {
	it("resolves a completed single-child run from persisted status", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-resume-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const sessionFile = path.join(root, "session.jsonl");
			fs.writeFileSync(sessionFile, "", "utf-8");
			writeJson(path.join(asyncRoot, "run-abc", "status.json"), {
				runId: "run-abc",
				mode: "single",
				state: "complete",
				startedAt: 100,
				endedAt: 200,
				lastUpdate: 200,
				cwd: root,
				sessionFile,
				steps: [{ agent: "worker", status: "complete" }],
			});

			const target = resolveAsyncResumeTarget({ id: "run-a" }, { asyncDirRoot: asyncRoot, resultsDir: path.join(root, "results") });

			assert.equal(target.kind, "revive");
			assert.equal(target.runId, "run-abc");
			assert.equal(target.agent, "worker");
			assert.equal(target.sessionFile, sessionFile);
			assert.equal(target.cwd, root);
			assert.equal(target.intercomTarget, "subagent-worker-run-abc-1");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects ambiguous run id prefixes", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-resume-ambiguous-"));
		try {
			const asyncRoot = path.join(root, "runs");
			writeJson(path.join(asyncRoot, "run-aa", "status.json"), {
				runId: "run-aa",
				mode: "single",
				state: "running",
				startedAt: 100,
				steps: [{ agent: "scout", status: "running" }],
			});
			writeJson(path.join(asyncRoot, "run-ab", "status.json"), {
				runId: "run-ab",
				mode: "single",
				state: "running",
				startedAt: 100,
				steps: [{ agent: "worker", status: "running" }],
			});

			assert.throws(
				() => resolveAsyncResumeTarget({ id: "run-a" }, { asyncDirRoot: asyncRoot, resultsDir: path.join(root, "results") }),
				/Ambiguous async run id prefix 'run-a' matched: run-aa, run-ab/,
			);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects path-like ids and directories outside the async root", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-resume-paths-"));
		try {
			const asyncRoot = path.join(root, "runs");
			assert.throws(
				() => resolveAsyncResumeTarget({ id: "../run" }, { asyncDirRoot: asyncRoot, resultsDir: path.join(root, "results") }),
				/id must be an async run id or prefix, not a path/,
			);
			assert.throws(
				() => resolveAsyncResumeTarget({ dir: path.join(root, "outside") }, { asyncDirRoot: asyncRoot, resultsDir: path.join(root, "results") }),
				/Async run directory must be inside/,
			);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects non-jsonl session files before reviving", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-resume-session-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const sessionFile = path.join(root, "session.txt");
			fs.writeFileSync(sessionFile, "", "utf-8");
			writeJson(path.join(asyncRoot, "run-session", "status.json"), {
				runId: "run-session",
				mode: "single",
				state: "complete",
				startedAt: 100,
				lastUpdate: 200,
				sessionFile,
				steps: [{ agent: "worker", status: "complete" }],
			});

			assert.throws(
				() => resolveAsyncResumeTarget({ id: "run-session" }, { asyncDirRoot: asyncRoot, resultsDir: path.join(root, "results") }),
				/session file must be a \.jsonl file/,
			);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects malformed result metadata before using session fields", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-resume-malformed-result-"));
		try {
			const resultsDir = path.join(root, "results");
			writeJson(path.join(resultsDir, "run-result.json"), {
				id: "run-result",
				agent: "worker",
				success: true,
				state: "complete",
				results: [{ agent: "worker", sessionFile: { path: "session.jsonl" } }],
			});

			assert.throws(
				() => resolveAsyncResumeTarget({ id: "run-result" }, { asyncDirRoot: path.join(root, "runs"), resultsDir }),
				/results\[0\].sessionFile must be a string/,
			);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects malformed result model metadata", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-resume-malformed-result-model-"));
		try {
			const resultsDir = path.join(root, "results");
			writeJson(path.join(resultsDir, "run-result-model.json"), {
				id: "run-result-model",
				agent: "worker",
				success: true,
				state: "complete",
				results: [{ agent: "worker", model: { id: "bad" } }],
			});

			assert.throws(
				() => resolveAsyncResumeTarget({ id: "run-result-model" }, { asyncDirRoot: path.join(root, "runs"), resultsDir }, { requireSessionFile: false }),
				/results\[0\].model must be a string/,
			);

			writeJson(path.join(resultsDir, "run-result-model.json"), {
				id: "run-result-model",
				agent: "worker",
				success: true,
				state: "complete",
				results: [{ agent: "worker", thinking: { level: "high" } }],
			});

			assert.throws(
				() => resolveAsyncResumeTarget({ id: "run-result-model" }, { asyncDirRoot: path.join(root, "runs"), resultsDir }, { requireSessionFile: false }),
				/results\[0\].thinking must be a string/,
			);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects malformed status session ids", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-resume-malformed-session-id-"));
		try {
			const asyncRoot = path.join(root, "runs");
			writeJson(path.join(asyncRoot, "run-session-id", "status.json"), {
				runId: "run-session-id",
				sessionId: { value: "session" },
				mode: "single",
				state: "running",
				startedAt: 100,
				steps: [{ agent: "worker", status: "running" }],
			});

			assert.throws(
				() => resolveAsyncResumeTarget({ id: "run-session-id" }, { asyncDirRoot: asyncRoot, resultsDir: path.join(root, "results") }),
				/sessionId must be a string/,
			);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects malformed status model metadata", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-resume-malformed-status-model-"));
		try {
			const asyncRoot = path.join(root, "runs");
			writeJson(path.join(asyncRoot, "run-status-model", "status.json"), {
				runId: "run-status-model",
				mode: "single",
				state: "running",
				startedAt: 100,
				steps: [{ agent: "worker", status: "running", model: { id: "bad" } }],
			});

			assert.throws(
				() => resolveAsyncResumeTarget({ id: "run-status-model" }, { asyncDirRoot: asyncRoot, resultsDir: path.join(root, "results") }),
				/steps\[0\].model must be a string/,
			);

			writeJson(path.join(asyncRoot, "run-status-model", "status.json"), {
				runId: "run-status-model",
				mode: "single",
				state: "running",
				startedAt: 100,
				steps: [{ agent: "worker", status: "running", thinking: { level: "high" } }],
			});

			assert.throws(
				() => resolveAsyncResumeTarget({ id: "run-status-model" }, { asyncDirRoot: asyncRoot, resultsDir: path.join(root, "results") }),
				/steps\[0\].thinking must be a string/,
			);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("returns a live intercom target for a running child", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-resume-live-"));
		try {
			const asyncRoot = path.join(root, "runs");
			writeJson(path.join(asyncRoot, "run-live", "status.json"), {
				runId: "run-live",
				mode: "single",
				state: "running",
				startedAt: 100,
				lastUpdate: 100,
				steps: [{ agent: "scout", status: "running", model: "openai/gpt-4.1", thinking: "off" }],
			});

			const target = resolveAsyncResumeTarget({ id: "run-live" }, { asyncDirRoot: asyncRoot, resultsDir: path.join(root, "results") });

			assert.equal(target.kind, "live");
			assert.equal(target.intercomTarget, "subagent-scout-run-live-1");
			assert.equal(target.model, "openai/gpt-4.1");
			assert.equal(target.thinking, "off");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("revives a completed child by index while a sibling async child is still running", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-resume-partial-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const sessionFile = path.join(root, "done.jsonl");
			fs.writeFileSync(sessionFile, "", "utf-8");
			writeJson(path.join(asyncRoot, "run-partial", "status.json"), {
				runId: "run-partial",
				mode: "parallel",
				state: "running",
				startedAt: 100,
				lastUpdate: 200,
				steps: [
					{ agent: "done", status: "complete", sessionFile },
					{ agent: "active", status: "running" },
				],
			});

			const target = resolveAsyncResumeTarget({ id: "run-partial", index: 0 }, { asyncDirRoot: asyncRoot, resultsDir: path.join(root, "results") });
			assert.equal(target.kind, "revive");
			assert.equal(target.agent, "done");
			assert.equal(target.sessionFile, sessionFile);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects pending indexed children in still-running async runs", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-resume-pending-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const sessionFile = path.join(root, "pending.jsonl");
			fs.writeFileSync(sessionFile, "", "utf-8");
			writeJson(path.join(asyncRoot, "run-pending", "status.json"), {
				runId: "run-pending",
				mode: "chain",
				state: "running",
				startedAt: 100,
				lastUpdate: 200,
				steps: [
					{ agent: "active", status: "running" },
					{ agent: "later", status: "pending", sessionFile },
				],
			});

			assert.throws(
				() => resolveAsyncResumeTarget({ id: "run-pending", index: 1 }, { asyncDirRoot: asyncRoot, resultsDir: path.join(root, "results") }),
				/pending and has not started yet/,
			);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("resolves a completed multi-child run when an index and per-child session file are available", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-resume-multi-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const firstSession = path.join(root, "a.jsonl");
			const secondSession = path.join(root, "b.jsonl");
			fs.writeFileSync(firstSession, "", "utf-8");
			fs.writeFileSync(secondSession, "", "utf-8");
			writeJson(path.join(asyncRoot, "run-multi", "status.json"), {
				runId: "run-multi",
				mode: "chain",
				state: "complete",
				startedAt: 100,
				lastUpdate: 200,
				steps: [
					{ agent: "a", status: "complete", sessionFile: firstSession },
					{ agent: "b", status: "complete", sessionFile: secondSession, model: "anthropic/claude-sonnet-4", thinking: "high" },
				],
			});

			assert.throws(
				() => resolveAsyncResumeTarget({ id: "run-multi" }, { asyncDirRoot: asyncRoot, resultsDir: path.join(root, "results") }),
				/Provide index to choose one/,
			);
			const target = resolveAsyncResumeTarget({ id: "run-multi", index: 1 }, { asyncDirRoot: asyncRoot, resultsDir: path.join(root, "results") });
			assert.equal(target.kind, "revive");
			assert.equal(target.agent, "b");
			assert.equal(target.index, 1);
			assert.equal(target.sessionFile, secondSession);
			assert.equal(target.model, "anthropic/claude-sonnet-4");
			assert.equal(target.thinking, "high");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("resolves a completed result-only child with per-child model metadata", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-resume-result-only-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const resultsDir = path.join(root, "results");
			const firstSession = path.join(root, "a.jsonl");
			const secondSession = path.join(root, "b.jsonl");
			fs.writeFileSync(firstSession, "", "utf-8");
			fs.writeFileSync(secondSession, "", "utf-8");
			writeJson(path.join(resultsDir, "run-result-only.json"), {
				id: "run-result-only",
				mode: "parallel",
				success: true,
				state: "complete",
				cwd: root,
				results: [
					{ agent: "a", success: true, sessionFile: firstSession, model: "openai/gpt-4.1" },
					{ agent: "b", success: true, sessionFile: secondSession, model: "anthropic/claude-sonnet-4", thinking: "high" },
				],
			});

			assert.throws(
				() => resolveAsyncResumeTarget({ id: "run-result-only" }, { asyncDirRoot: asyncRoot, resultsDir }),
				/Provide index to choose one/,
			);
			const target = resolveAsyncResumeTarget({ id: "run-result-only", index: 1 }, { asyncDirRoot: asyncRoot, resultsDir });
			assert.equal(target.kind, "revive");
			assert.equal(target.agent, "b");
			assert.equal(target.index, 1);
			assert.equal(target.cwd, root);
			assert.equal(target.sessionFile, secondSession);
			assert.equal(target.model, "anthropic/claude-sonnet-4");
			assert.equal(target.thinking, "high");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("frames the revived follow-up with original run context", () => {
		const task = buildRevivedAsyncTask({
			kind: "revive",
			runId: "run-old",
			state: "complete",
			agent: "worker",
			index: 0,
			intercomTarget: "subagent-worker-run-old-1",
			sessionFile: "/tmp/session.jsonl",
		}, "What changed?");

		assert.match(task, /Original run: run-old/);
		assert.doesNotMatch(task, /async subagent conversation/);
		assert.match(task, /Original agent: worker/);
		assert.match(task, /Original session file: \/tmp\/session\.jsonl/);
		assert.match(task, /Follow-up:\nWhat changed\?/);
	});
});
