import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
	acquireActiveAsyncCapacity,
	activeAsyncCapacitySessionKey,
	ActiveAsyncCapacityError,
	getActiveAsyncCapacitySnapshot,
	inspectActiveAsyncCapacityOwner,
	transferActiveAsyncCapacity,
} from "../../src/runs/background/active-async-capacity.ts";

function tempRoot(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "active-async-capacity-"));
}

function writeJson(filePath: string, value: unknown): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, JSON.stringify(value));
}

function observedProof(runId: string, runnerProcessInstanceId: string) {
	return {
		version: 1,
		state: "observed",
		runId,
		runnerProcessInstanceId,
		observedAt: 300,
		instances: [{
			kind: "runner",
			processInstanceId: runnerProcessInstanceId,
			closeObservedAt: 300,
			exitCode: 0,
			signal: null,
		}],
	};
}

describe("active async capacity", () => {
	it("admits exactly to the limit and rolls back only its own unstarted slot", () => {
		const rootDir = tempRoot();
		try {
			const first = acquireActiveAsyncCapacity({ sessionId: "session-a", limit: 1, runId: "run-a", kind: "runner", asyncDir: path.join(rootDir, "run-a") }, { rootDir, token: () => "token-a" });
			assert.ok(first);
			assert.deepEqual(getActiveAsyncCapacitySnapshot("session-a", 1, { rootDir }), { used: 1, limit: 1 });
			assert.throws(
				() => acquireActiveAsyncCapacity({ sessionId: "session-a", limit: 1, runId: "run-b", kind: "runner", asyncDir: path.join(rootDir, "run-b") }, { rootDir, token: () => "token-b" }),
				(error: unknown) => error instanceof ActiveAsyncCapacityError && error.message === "Active async run capacity exhausted: 1/1 used.",
			);
			assert.equal(first.rollback(), true);
			assert.deepEqual(getActiveAsyncCapacitySnapshot("session-a", 1, { rootDir }), { used: 0, limit: 1 });
		} finally {
			fs.rmSync(rootDir, { recursive: true, force: true });
		}
	});

	it("counts corrupt slot metadata as occupied", () => {
		const rootDir = tempRoot();
		try {
			// Create a valid occupied slot, then corrupt only its owner metadata.
			const handle = acquireActiveAsyncCapacity({ sessionId: "session-corrupt", limit: 1, runId: "run-a", kind: "runner", asyncDir: path.join(rootDir, "run-a") }, { rootDir });
			assert.ok(handle);
			fs.writeFileSync(path.join(rootDir, handle.owner.ownerSessionKey, "slot-0", "owner.json"), "not json");
			assert.deepEqual(getActiveAsyncCapacitySnapshot("session-corrupt", 1, { rootDir }), { used: 1, limit: 1 });
			assert.throws(() => acquireActiveAsyncCapacity({ sessionId: "session-corrupt", limit: 1, runId: "run-b", kind: "runner", asyncDir: path.join(rootDir, "run-b") }, { rootDir }), ActiveAsyncCapacityError);
		} finally {
			fs.rmSync(rootDir, { recursive: true, force: true });
		}
	});

	it("uses the injected clock for reservation and start timestamps", () => {
		const rootDir = tempRoot();
		let now = 100;
		try {
			const runner = acquireActiveAsyncCapacity({ sessionId: "session-clock", limit: 2, runId: "runner", kind: "runner", asyncDir: path.join(rootDir, "runner") }, { rootDir, now: () => now });
			assert.ok(runner);
			assert.equal(runner.owner.reservedAt, 100);
			now = 200;
			runner.markStarted("runner-process");
			assert.equal(runner.owner.runnerStartedAt, 200);

			now = 300;
			const workflow = acquireActiveAsyncCapacity({ sessionId: "session-clock", limit: 2, runId: "workflow", kind: "workflow", asyncDir: path.join(rootDir, "workflow") }, { rootDir, now: () => now });
			assert.ok(workflow);
			workflow.markWorkflowStarted();
			assert.equal(workflow.owner.runnerStartedAt, 300);
		} finally {
			fs.rmSync(rootDir, { recursive: true, force: true });
		}
	});

	it("does not roll back when runner start was recorded only in memory", () => {
		const rootDir = tempRoot();
		try {
			const handle = acquireActiveAsyncCapacity({ sessionId: "session-a", limit: 1, runId: "run-a", kind: "runner", asyncDir: path.join(rootDir, "runs", "run-a") }, { rootDir });
			assert.ok(handle);
			handle.owner.runnerProcessInstanceId = "runner-a";
			handle.owner.runnerStartedAt = Date.now();

			assert.equal(handle.rollback(), false);
			assert.deepEqual(getActiveAsyncCapacitySnapshot("session-a", 1, { rootDir }), { used: 1, limit: 1 });
		} finally {
			fs.rmSync(rootDir, { recursive: true, force: true });
		}
	});

	it("explains runner release verdicts without mutating slots", () => {
		const rootDir = tempRoot();
		const asyncDir = path.join(rootDir, "runs", "run-a");
		try {
			const handle = acquireActiveAsyncCapacity({ sessionId: "session-a", limit: 2, runId: "run-a", kind: "runner", asyncDir }, { rootDir });
			assert.ok(handle);
			handle.markStarted("runner-a");
			writeJson(path.join(asyncDir, "status.json"), { runId: "run-a", sessionId: "session-a", mode: "single", state: "complete", startedAt: 100, processTerminal: { version: 1, state: "unknown", runId: "run-a", runnerProcessInstanceId: "runner-a", reason: "process-tree-unverified" } });

			const retained = inspectActiveAsyncCapacityOwner({ runId: "run-a", sessionId: "session-a", asyncDir }, { rootDir });

			assert.equal(retained.relation, "current");
			assert.equal(retained.release.state, "retained");
			assert.match(retained.release.reason, /process-terminal proof is missing/);
			assert.deepEqual(getActiveAsyncCapacitySnapshot("session-a", 2, { rootDir }), { used: 1, limit: 2 });

			writeJson(path.join(asyncDir, "process-terminal.json"), observedProof("run-a", "runner-a"));
			const releasable = inspectActiveAsyncCapacityOwner({ runId: "run-a", sessionId: "session-a", asyncDir }, { rootDir });
			assert.equal(releasable.release.state, "releasable");
			assert.match(releasable.release.reason, /observed process-terminal proof/);
			assert.equal(releasable.slotDir ? fs.existsSync(releasable.slotDir) : false, true);
		} finally {
			fs.rmSync(rootDir, { recursive: true, force: true });
		}
	});

	it("retains active and unknown runner proof, then releases matching observed proof", () => {
		const rootDir = tempRoot();
		const asyncDir = path.join(rootDir, "runs", "run-a");
		try {
			const handle = acquireActiveAsyncCapacity({ sessionId: "session-a", limit: 2, runId: "run-a", kind: "runner", asyncDir }, { rootDir });
			assert.ok(handle);
			handle.markStarted("runner-a");
			writeJson(path.join(asyncDir, "status.json"), { runId: "run-a", sessionId: "session-a", mode: "single", state: "running", startedAt: 100, processTerminal: { version: 1, state: "pending", runId: "run-a", runnerProcessInstanceId: "runner-a" } });
			assert.deepEqual(getActiveAsyncCapacitySnapshot("session-a", 2, { rootDir }), { used: 1, limit: 2 });
			writeJson(path.join(asyncDir, "status.json"), { runId: "run-a", sessionId: "session-a", mode: "single", state: "complete", startedAt: 100, processTerminal: { version: 1, state: "unknown", runId: "run-a", runnerProcessInstanceId: "runner-a", reason: "process-tree-unverified" } });
			writeJson(path.join(asyncDir, "process-terminal.json"), { version: 1, state: "unknown", runId: "run-a", runnerProcessInstanceId: "runner-a", reason: "process-tree-unverified" });
			assert.deepEqual(getActiveAsyncCapacitySnapshot("session-a", 2, { rootDir }), { used: 1, limit: 2 });
			writeJson(path.join(asyncDir, "process-terminal.json"), observedProof("run-a", "runner-a"));
			assert.deepEqual(getActiveAsyncCapacitySnapshot("session-a", 2, { rootDir }), { used: 0, limit: 2 });
		} finally {
			fs.rmSync(rootDir, { recursive: true, force: true });
		}
	});

	it("does not delete a slot recreated while a terminal owner is released", () => {
		const rootDir = tempRoot();
		const asyncDir = path.join(rootDir, "runs", "run-a");
		try {
			const handle = acquireActiveAsyncCapacity({ sessionId: "session-a", limit: 1, runId: "run-a", kind: "runner", asyncDir }, { rootDir, token: () => "token-a" });
			assert.ok(handle);
			handle.markStarted("runner-a");
			writeJson(path.join(asyncDir, "status.json"), { runId: "run-a", sessionId: "session-a", mode: "single", state: "complete", startedAt: 100 });
			writeJson(path.join(asyncDir, "process-terminal.json"), observedProof("run-a", "runner-a"));

			let replacement: ReturnType<typeof acquireActiveAsyncCapacity>;
			assert.deepEqual(getActiveAsyncCapacitySnapshot("session-a", 1, {
				rootDir,
				afterSlotRename: () => {
					replacement = acquireActiveAsyncCapacity({ sessionId: "session-a", limit: 1, runId: "run-b", kind: "runner", asyncDir: path.join(rootDir, "runs", "run-b") }, { rootDir, token: () => "token-b" });
				},
			}), { used: 1, limit: 1 });
			assert.equal(replacement!.owner.runId, "run-b");
			assert.deepEqual(getActiveAsyncCapacitySnapshot("session-a", 1, { rootDir }), { used: 1, limit: 1 });
		} finally {
			fs.rmSync(rootDir, { recursive: true, force: true });
		}
	});

	it("does not delete a slot recreated during pre-start rollback", () => {
		const rootDir = tempRoot();
		try {
			const first = acquireActiveAsyncCapacity({ sessionId: "session-a", limit: 1, runId: "run-a", kind: "runner", asyncDir: path.join(rootDir, "runs", "run-a") }, {
				rootDir,
				token: () => "token-a",
				afterSlotRename: () => {
					const replacement = acquireActiveAsyncCapacity({ sessionId: "session-a", limit: 1, runId: "run-b", kind: "runner", asyncDir: path.join(rootDir, "runs", "run-b") }, { rootDir, token: () => "token-b" });
					assert.ok(replacement);
				},
			});
			assert.ok(first);
			assert.equal(first.rollback(), true);
			assert.deepEqual(getActiveAsyncCapacitySnapshot("session-a", 1, { rootDir }), { used: 1, limit: 1 });
			assert.equal(first.rollback(), false);
		} finally {
			fs.rmSync(rootDir, { recursive: true, force: true });
		}
	});

	it("restores a transferred source when revival fails before runner proceed", () => {
		const rootDir = tempRoot();
		const sourceDir = path.join(rootDir, "runs", "source");
		const failedDir = path.join(rootDir, "runs", "failed-revival");
		try {
			const source = acquireActiveAsyncCapacity({ sessionId: "session-a", limit: 1, runId: "source", kind: "runner", asyncDir: sourceDir }, { rootDir });
			assert.ok(source);
			source.markStarted("source-runner");
			writeJson(path.join(sourceDir, "status.json"), { runId: "source", sessionId: "session-a", mode: "single", state: "paused", startedAt: 100 });
			const transferred = transferActiveAsyncCapacity({ sessionId: "session-a", limit: 1, sourceRunId: "source", runId: "failed-revival", asyncDir: failedDir }, { rootDir });
			assert.ok(transferred);
			transferred.markStarted("failed-runner");
			assert.equal(transferred.rollbackBeforeRunnerProceed("failed-runner"), true);

			assert.deepEqual(getActiveAsyncCapacitySnapshot("session-a", 1, { rootDir }), { used: 1, limit: 1 });
			const sourceInspection = inspectActiveAsyncCapacityOwner({ sessionId: "session-a", runId: "source", asyncDir: sourceDir }, { rootDir });
			assert.equal(sourceInspection.relation, "current");
			assert.equal(sourceInspection.owner?.runId, "source");
			assert.equal(inspectActiveAsyncCapacityOwner({ sessionId: "session-a", runId: "failed-revival", asyncDir: failedDir }, { rootDir }).relation, "none");
		} finally {
			fs.rmSync(rootDir, { recursive: true, force: true });
		}
	});

	it("releases capacity bound before runner proceed when startup is terminated", () => {
		const rootDir = tempRoot();
		const unboundDir = path.join(rootDir, "runs", "pre-bind");
		const asyncDir = path.join(rootDir, "runs", "pre-proceed");
		try {
			const unbound = acquireActiveAsyncCapacity({ sessionId: "session-a", limit: 1, runId: "pre-bind", kind: "runner", asyncDir: unboundDir }, { rootDir });
			assert.ok(unbound);
			assert.equal(unbound.rollbackBeforeRunnerProceed("pre-bind-runner"), false);
			assert.equal(unbound.rollback(), true);

			const handle = acquireActiveAsyncCapacity({ sessionId: "session-a", limit: 1, runId: "pre-proceed", kind: "runner", asyncDir }, { rootDir });
			assert.ok(handle);
			handle.markStarted("pre-proceed-runner");
			assert.equal(handle.rollback(), false);

			assert.equal(handle.rollbackBeforeRunnerProceed("other-runner"), false);
			assert.deepEqual(getActiveAsyncCapacitySnapshot("session-a", 1, { rootDir }), { used: 1, limit: 1 });
			assert.equal(handle.rollbackBeforeRunnerProceed("pre-proceed-runner"), true);
			assert.deepEqual(getActiveAsyncCapacitySnapshot("session-a", 1, { rootDir }), { used: 0, limit: 1 });

			const bindFailure = acquireActiveAsyncCapacity({ sessionId: "session-a", limit: 1, runId: "pre-proceed-bind-failure", kind: "runner", asyncDir: path.join(rootDir, "runs", "pre-proceed-bind-failure") }, {
				rootDir,
				writeOwner() { throw new Error("simulated durable bind failure"); },
			});
			assert.ok(bindFailure);
			assert.throws(() => bindFailure.markStarted("pre-proceed-bind-failure-runner"), /simulated durable bind failure/);
			assert.equal(bindFailure.rollback(), false);
			assert.equal(bindFailure.rollbackBeforeRunnerProceed("pre-proceed-bind-failure-runner"), true);
			assert.deepEqual(getActiveAsyncCapacitySnapshot("session-a", 1, { rootDir }), { used: 0, limit: 1 });

			const divergent = acquireActiveAsyncCapacity({ sessionId: "session-a", limit: 1, runId: "pre-proceed-divergent", kind: "runner", asyncDir: path.join(rootDir, "runs", "pre-proceed-divergent") }, { rootDir });
			assert.ok(divergent);
			const unstartedOwner = { ...divergent.owner };
			divergent.markStarted("pre-proceed-divergent-runner");
			writeJson(path.join(rootDir, activeAsyncCapacitySessionKey("session-a"), "slot-0", "owner.json"), unstartedOwner);
			assert.equal(divergent.rollback(), false);
			assert.equal(divergent.rollbackBeforeRunnerProceed("pre-proceed-divergent-runner"), true);
			assert.deepEqual(getActiveAsyncCapacitySnapshot("session-a", 1, { rootDir }), { used: 0, limit: 1 });
		} finally {
			fs.rmSync(rootDir, { recursive: true, force: true });
		}
	});

	it("does not restore old source proof after a transferred runner starts", () => {
		const rootDir = tempRoot();
		const sourceDir = path.join(rootDir, "runs", "source");
		const revivedDir = path.join(rootDir, "runs", "revived");
		try {
			const source = acquireActiveAsyncCapacity({ sessionId: "session-a", limit: 1, runId: "source", kind: "runner", asyncDir: sourceDir }, { rootDir });
			assert.ok(source);
			source.markStarted("source-runner");
			writeJson(path.join(sourceDir, "status.json"), { runId: "source", sessionId: "session-a", mode: "single", state: "complete", startedAt: 100 });
			writeJson(path.join(sourceDir, "process-terminal.json"), observedProof("source", "source-runner"));
			const transferred = transferActiveAsyncCapacity({ sessionId: "session-a", limit: 1, sourceRunId: "source", runId: "revived", asyncDir: revivedDir }, { rootDir });
			assert.ok(transferred);
			writeJson(path.join(revivedDir, "status.json"), { runId: "revived", sessionId: "session-a", mode: "single", state: "failed", startedAt: 200, processTerminal: { version: 1, state: "not-started", runId: "revived", runnerProcessInstanceId: "revived-runner" } });
			transferred.markStarted("revived-runner");
			assert.equal(transferred.rollback(), false);

			assert.deepEqual(getActiveAsyncCapacitySnapshot("session-a", 1, { rootDir }), { used: 1, limit: 1 });
			writeJson(path.join(revivedDir, "process-terminal.json"), observedProof("revived", "revived-runner"));
			assert.deepEqual(getActiveAsyncCapacitySnapshot("session-a", 1, { rootDir }), { used: 0, limit: 1 });
		} finally {
			fs.rmSync(rootDir, { recursive: true, force: true });
		}
	});

	it("reports transferred source runs as not owned", () => {
		const rootDir = tempRoot();
		const sourceDir = path.join(rootDir, "runs", "source");
		const nextDir = path.join(rootDir, "runs", "next");
		try {
			const source = acquireActiveAsyncCapacity({ sessionId: "session-a", limit: 1, runId: "source", kind: "runner", asyncDir: sourceDir }, { rootDir });
			assert.ok(source);
			source.markStarted("runner-source");
			writeJson(path.join(sourceDir, "status.json"), { runId: "source", sessionId: "session-a", mode: "single", state: "paused", startedAt: 100 });
			const next = transferActiveAsyncCapacity({ sessionId: "session-a", limit: 1, sourceRunId: "source", runId: "next", asyncDir: nextDir }, { rootDir });
			assert.ok(next);

			const inspection = inspectActiveAsyncCapacityOwner({ runId: "source", sessionId: "session-a", asyncDir: sourceDir }, { rootDir });

			assert.equal(inspection.relation, "source");
			assert.equal(inspection.owner?.runId, "next");
			assert.equal(inspection.release.state, "not-owned");
			assert.match(inspection.release.reason, /transferred to next/);
		} finally {
			fs.rmSync(rootDir, { recursive: true, force: true });
		}
	});

	it("transfers a paused reservation without changing usage", () => {
		const rootDir = tempRoot();
		const sourceDir = path.join(rootDir, "runs", "source");
		try {
			const source = acquireActiveAsyncCapacity({ sessionId: "session-a", limit: 1, runId: "source", kind: "runner", asyncDir: sourceDir }, { rootDir });
			assert.ok(source);
			source.markStarted("runner-source");
			writeJson(path.join(sourceDir, "status.json"), { runId: "source", sessionId: "session-a", mode: "single", state: "paused", startedAt: 100 });
			const next = transferActiveAsyncCapacity({ sessionId: "session-a", limit: 1, sourceRunId: "source", runId: "next", asyncDir: path.join(rootDir, "runs", "next") }, { rootDir });
			assert.ok(next);
			assert.equal(next.owner.sourceRunId, "source");
			assert.equal(next.owner.generation, 1);
			assert.deepEqual(getActiveAsyncCapacitySnapshot("session-a", 1, { rootDir }), { used: 1, limit: 1 });
		} finally {
			fs.rmSync(rootDir, { recursive: true, force: true });
		}
	});

	it("transfers an existing reservation after the cap is disabled", () => {
		const rootDir = tempRoot();
		const sourceDir = path.join(rootDir, "runs", "source");
		try {
			const source = acquireActiveAsyncCapacity({ sessionId: "session-a", limit: 1, runId: "source", kind: "runner", asyncDir: sourceDir }, { rootDir });
			assert.ok(source);
			source.markStarted("runner-source");
			writeJson(path.join(sourceDir, "status.json"), { runId: "source", sessionId: "session-a", mode: "single", state: "paused", startedAt: 100 });
			const next = transferActiveAsyncCapacity({ sessionId: "session-a", limit: undefined, sourceRunId: "source", runId: "next", asyncDir: path.join(rootDir, "runs", "next") }, { rootDir });
			assert.ok(next);
			assert.equal(next.owner.runId, "next");
			assert.deepEqual(getActiveAsyncCapacitySnapshot("session-a", undefined, { rootDir }), { used: 1, limit: 0 });
		} finally {
			fs.rmSync(rootDir, { recursive: true, force: true });
		}
	});

	it("releases terminal workflows despite stale step projections after the controller and async children stop", () => {
		const rootDir = tempRoot();
		const asyncRoot = path.join(rootDir, "runs");
		const workflowDir = path.join(asyncRoot, "workflow");
		const childDir = path.join(asyncRoot, "child");
		try {
			const workflow = acquireActiveAsyncCapacity({ sessionId: "session-a", limit: 1, runId: "workflow", kind: "workflow", asyncDir: workflowDir }, { rootDir });
			assert.ok(workflow);
			workflow.markWorkflowStarted();
			writeJson(path.join(workflowDir, "status.json"), { runId: "workflow", sessionId: "session-a", mode: "workflow", state: "complete", startedAt: 100, steps: [{ agent: "worker", workflowKey: "foreground", async: false, status: "running" }] });
			assert.deepEqual(getActiveAsyncCapacitySnapshot("session-a", 1, { rootDir, liveWorkflowRunIds: new Set(["workflow"]) }), { used: 1, limit: 1 });
			assert.deepEqual(getActiveAsyncCapacitySnapshot("session-a", 1, { rootDir }), { used: 0, limit: 1 });

			const second = acquireActiveAsyncCapacity({ sessionId: "session-a", limit: 1, runId: "workflow-2", kind: "workflow", asyncDir: workflowDir }, { rootDir });
			assert.ok(second);
			second.markWorkflowStarted();
			writeJson(path.join(workflowDir, "status.json"), { runId: "workflow-2", sessionId: "session-a", mode: "workflow", state: "failed", startedAt: 100, steps: [{ agent: "worker", workflowKey: "async", runId: "child", async: true, status: "running" }] });
			writeJson(path.join(childDir, "status.json"), { runId: "child", sessionId: "session-a", mode: "single", state: "complete", startedAt: 100, processTerminal: { version: 1, state: "unknown", runId: "child", runnerProcessInstanceId: "runner-child", reason: "process-tree-unverified" } });
			writeJson(path.join(childDir, "process-terminal.json"), { version: 1, state: "unknown", runId: "child", runnerProcessInstanceId: "runner-child", reason: "process-tree-unverified" });
			assert.deepEqual(getActiveAsyncCapacitySnapshot("session-a", 1, { rootDir }), { used: 1, limit: 1 });
			writeJson(path.join(childDir, "process-terminal.json"), observedProof("child", "runner-child"));
			assert.deepEqual(getActiveAsyncCapacitySnapshot("session-a", 1, { rootDir }), { used: 0, limit: 1 });
		} finally {
			fs.rmSync(rootDir, { recursive: true, force: true });
		}
	});

	it("retains terminal workflows while a resumed async child lacks observed proof", () => {
		const rootDir = tempRoot();
		const asyncRoot = path.join(rootDir, "runs");
		const workflowDir = path.join(asyncRoot, "workflow");
		const childDir = path.join(asyncRoot, "revived-child");
		try {
			const workflow = acquireActiveAsyncCapacity({ sessionId: "session-a", limit: 1, runId: "workflow", kind: "workflow", asyncDir: workflowDir }, { rootDir });
			assert.ok(workflow);
			workflow.markWorkflowStarted();
			writeJson(path.join(workflowDir, "status.json"), { runId: "workflow", sessionId: "session-a", mode: "workflow", state: "failed", startedAt: 100, steps: [{ agent: "worker", workflowKey: "resume", runId: "revived-child", async: true, status: "failed" }] });
			writeJson(path.join(childDir, "status.json"), { runId: "revived-child", sessionId: "session-a", mode: "single", state: "failed", startedAt: 100, processTerminal: { version: 1, state: "not-started", runId: "revived-child", runnerProcessInstanceId: "runner-child" } });

			assert.deepEqual(getActiveAsyncCapacitySnapshot("session-a", 1, { rootDir }), { used: 1, limit: 1 });
			writeJson(path.join(childDir, "process-terminal.json"), observedProof("revived-child", "runner-child"));
			assert.deepEqual(getActiveAsyncCapacitySnapshot("session-a", 1, { rootDir }), { used: 0, limit: 1 });
		} finally {
			fs.rmSync(rootDir, { recursive: true, force: true });
		}
	});

	it("releases terminal workflows when a child is marked failed before launch identity exists", () => {
		const rootDir = tempRoot();
		const workflowDir = path.join(rootDir, "runs", "workflow");
		try {
			const workflow = acquireActiveAsyncCapacity({ sessionId: "session-a", limit: 1, runId: "workflow", kind: "workflow", asyncDir: workflowDir }, { rootDir });
			assert.ok(workflow);
			workflow.markWorkflowStarted();
			writeJson(path.join(workflowDir, "status.json"), {
				runId: "workflow",
				sessionId: "session-a",
				mode: "workflow",
				state: "failed",
				startedAt: 100,
				steps: [{ agent: "worker", workflowKey: "prep-failure", status: "failed", async: false, error: "gate cannot be combined with acceptance" }],
			});

			assert.deepEqual(getActiveAsyncCapacitySnapshot("session-a", 1, { rootDir }), { used: 0, limit: 1 });
		} finally {
			fs.rmSync(rootDir, { recursive: true, force: true });
		}
	});

	it("reclaims only old failed runs with dead runners under the abandoned-timeout policy", () => {
		const cases = [
			{ name: "dead old", state: "failed", pidLiveness: "dead" as const, lastActivityAt: 0, threshold: 1_000, releases: true },
			{ name: "dead recent", state: "failed", pidLiveness: "dead" as const, lastActivityAt: 9_500, threshold: 1_000, releases: false },
			{ name: "alive old", state: "failed", pidLiveness: "alive" as const, lastActivityAt: 0, threshold: 1_000, releases: false },
			{ name: "unknown old", state: "failed", pidLiveness: "unknown" as const, lastActivityAt: 0, threshold: 1_000, releases: false },
			{ name: "strict mode", state: "failed", pidLiveness: "dead" as const, lastActivityAt: 0, threshold: false as const, releases: false },
			{ name: "successful old", state: "complete", pidLiveness: "dead" as const, lastActivityAt: 0, threshold: 1_000, releases: false },
		];
		for (const [index, testCase] of cases.entries()) {
			const rootDir = tempRoot();
			const asyncDir = path.join(rootDir, "runs", `run-${index}`);
			try {
				const handle = acquireActiveAsyncCapacity({ sessionId: "session-policy", limit: 1, runId: `run-${index}`, kind: "runner", asyncDir }, { rootDir });
				assert.ok(handle);
				handle.markStarted(`runner-${index}`);
				writeJson(path.join(asyncDir, "status.json"), {
					runId: `run-${index}`,
					sessionId: "session-policy",
					mode: "single",
					state: testCase.state,
					pid: 50_000 + index,
					startedAt: 0,
					lastActivityAt: testCase.lastActivityAt,
					processTerminal: { version: 1, state: "unknown", runId: `run-${index}`, runnerProcessInstanceId: `runner-${index}`, reason: "stale-repair" },
				});
				const options = {
					rootDir,
					now: () => 10_000,
					pidLiveness: () => testCase.pidLiveness,
					abandonedSlotReleaseAfterMs: testCase.threshold,
				};
				const inspection = inspectActiveAsyncCapacityOwner({ runId: `run-${index}`, sessionId: "session-policy", asyncDir }, options);
				assert.equal(inspection.release.state, testCase.releases ? "releasable" : "retained", testCase.name);
				if (testCase.releases) {
					assert.match(inspection.release.reason, /abandoned-timeout/);
					assert.match(inspection.release.reason, /process proof unknown/);
					assert.deepEqual(getActiveAsyncCapacitySnapshot("session-policy", 1, options), { used: 0, limit: 1 });
					assert.match(fs.readFileSync(path.join(asyncDir, "events.jsonl"), "utf-8"), /"releasedBy":"abandoned-timeout"/);
				} else {
					assert.deepEqual(getActiveAsyncCapacitySnapshot("session-policy", 1, options), { used: 1, limit: 1 });
				}
			} finally {
				fs.rmSync(rootDir, { recursive: true, force: true });
			}
		}
	});
});
