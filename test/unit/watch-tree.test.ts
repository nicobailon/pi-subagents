import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { buildWatchSections } from "../../src/watch/watch-tree.ts";
import type { SubagentState } from "../../src/shared/types.ts";

function stateWithJobs(jobs: Array<[string, Partial<SubagentState["asyncJobs"] extends Map<string, infer J> ? J : never>]>): SubagentState {
	return {
		baseCwd: process.cwd(),
		currentSessionId: "session-current",
		asyncJobs: new Map(jobs.map(([id, job]) => [id, job as any])),
		foregroundControls: new Map(),
		lastForegroundControlId: null,
		cleanupTimers: new Map(),
		lastUiContext: null,
		poller: null,
		completionSeen: new Map(),
		watcher: null,
		watcherRestartTimer: null,
		resultFileCoalescer: { schedule: () => false, clear: () => {} },
	} as any;
}

describe("subagent watch tree", () => {
	it("groups active, queued, and done jobs and includes run ids", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "watch-tree-"));
		try {
			const activeDir = path.join(root, "active");
			const queuedDir = path.join(root, "queued");
			const doneDir = path.join(root, "done");
			fs.mkdirSync(activeDir, { recursive: true });
			fs.mkdirSync(queuedDir, { recursive: true });
			fs.mkdirSync(doneDir, { recursive: true });

			const state = stateWithJobs([
				["run-active", { asyncId: "run-active", asyncDir: activeDir, status: "running", mode: "parallel", agents: ["reviewer", "reviewer"], steps: [
					{ agent: "reviewer", label: "Correctness", status: "running", currentTool: "read", sessionFile: path.join(root, "a.jsonl") },
					{ agent: "reviewer", label: "Tests", status: "complete", sessionFile: path.join(root, "b.jsonl") },
				] }],
				["run-queued", { asyncId: "run-queued", asyncDir: queuedDir, status: "queued", mode: "single", agents: ["worker"], steps: [
					{ agent: "worker", status: "pending" },
				] }],
				["run-done", { asyncId: "run-done", asyncDir: doneDir, status: "complete", mode: "single", agents: ["scout"], steps: [
					{ agent: "scout", status: "complete", sessionFile: path.join(root, "c.jsonl") },
				] }],
			]);

			const sections = buildWatchSections(state, { now: () => 1_000 });
			assert.deepEqual(sections.map((s) => s.title), ["Active", "Queued", "Done"]);
			assert.equal(sections[0]!.rows.some((r) => r.text.includes("run-active")), true);
			assert.equal(sections[0]!.targets.map((t) => t.agent).join(","), "reviewer,reviewer");
			assert.equal(sections[0]!.targets[0]!.displayName, "Correctness");
			assert.equal(sections[0]!.targets[0]!.outputLog, path.join(activeDir, "output-0.log"));
			assert.equal(sections[1]!.targets[0]!.rootRunId, "run-queued");
			assert.equal(sections[2]!.targets[0]!.rootRunId, "run-done");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("renders nested descendants as indented selectable targets", () => {
		const state = stateWithJobs([
			["root", { asyncId: "root", asyncDir: "/tmp/root", status: "running", mode: "single", agents: ["orchestrator"], steps: [
				{ agent: "orchestrator", status: "running", children: [
					{ id: "nested-1", parentRunId: "root", depth: 1, path: [{ runId: "root", stepIndex: 0, agent: "orchestrator" }], state: "running", agent: "reviewer", currentTool: "grep", sessionFile: "/tmp/nested.jsonl" },
				] },
			] }],
		]);

		const sections = buildWatchSections(state, { now: () => 1_000 });
		const nested = sections[0]!.targets.find((target) => target.id.includes("nested-1"));
		assert.ok(nested);
		assert.equal(nested.agent, "reviewer");
		assert.deepEqual(nested.ancestry, ["root", "orchestrator", "reviewer"]);
		assert.equal(sections[0]!.rows.some((row) => row.text.includes("└─") || row.text.includes("├─")), true);
	});

	it("uses status.json steps and preserves original step indexes for logs", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "watch-tree-status-"));
		try {
			const asyncDir = path.join(root, "run");
			fs.mkdirSync(asyncDir, { recursive: true });
			fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
				runId: "run-status",
				mode: "parallel",
				state: "running",
				startedAt: 1,
				steps: [
					{ index: 2, agent: "late", status: "running", sessionFile: path.join(root, "late.jsonl") },
				],
			}));
			const state = stateWithJobs([
				["run-status", { asyncId: "run-status", asyncDir, status: "running", mode: "parallel", agents: ["late"], steps: [] }],
			]);

			const target = buildWatchSections(state, { now: () => 1_000 })[0]!.targets[0]!;
			assert.equal(target.stepIndex, 2);
			assert.equal(target.id, "run-status/3");
			assert.equal(target.outputLog, path.join(asyncDir, "output-2.log"));
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("creates placeholder targets for queued jobs before status steps exist", () => {
		const state = stateWithJobs([
			["queued", { asyncId: "queued", asyncDir: "/tmp/queued", status: "queued", mode: "parallel", agents: ["a", "b"], steps: [] }],
		]);
		const sections = buildWatchSections(state, { now: () => 1_000 });
		assert.equal(sections[0]!.title, "Queued");
		assert.deepEqual(sections[0]!.targets.map((target) => target.agent), ["a", "b"]);
	});

	it("renders nested run steps as selectable targets", () => {
		const state = stateWithJobs([
			["root", { asyncId: "root", asyncDir: "/tmp/root", status: "running", mode: "single", agents: ["orchestrator"], steps: [
				{ agent: "orchestrator", status: "running", children: [
					{ id: "nested-chain", parentRunId: "root", depth: 1, path: [{ runId: "root", stepIndex: 0, agent: "orchestrator" }], state: "running", agents: ["scout", "reviewer"], asyncDir: "/tmp/nested-chain", steps: [
						{ agent: "scout", status: "complete", sessionFile: "/tmp/scout.jsonl" },
						{ agent: "reviewer", status: "running", sessionFile: "/tmp/reviewer.jsonl", currentTool: "read" },
					] },
				] },
			] }],
		]);

		const targets = buildWatchSections(state, { now: () => 1_000 })[0]!.targets;
		const reviewer = targets.find((target) => target.id === "root/nested-chain/2");
		assert.ok(reviewer);
		assert.equal(reviewer.agent, "reviewer");
		assert.equal(reviewer.sessionFile, "/tmp/reviewer.jsonl");
		assert.equal(reviewer.outputLog, path.join("/tmp/nested-chain", "output-1.log"));
	});
});
