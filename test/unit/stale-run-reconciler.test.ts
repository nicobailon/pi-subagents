import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { writeAsyncResultFile, writePendingAsyncResultFile } from "../../src/runs/background/result-files.ts";
import { finalizeProcessTerminal, initializeProcessTerminal, readProcessTerminal } from "../../src/runs/background/process-terminal.ts";
import { checkPidLiveness, checkRecordedPidLiveness, reconcileAsyncRun } from "../../src/runs/background/stale-run-reconciler.ts";
import { summarizeAsyncStatus } from "../../src/runs/background/async-status.ts";

function tempRoot(prefix: string): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeStatus(asyncDir: string, status: Record<string, unknown>): void {
	fs.mkdirSync(asyncDir, { recursive: true });
	fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify(status, null, 2), "utf-8");
}

function errno(code: string): NodeJS.ErrnoException {
	const error = new Error(code) as NodeJS.ErrnoException;
	error.code = code;
	return error;
}

describe("async stale-run reconciliation", () => {
	it("classifies pid liveness without treating EPERM as dead", () => {
		assert.equal(checkPidLiveness(process.pid), "alive");
		assert.equal(checkPidLiveness(2_147_483_647, () => true), "alive");
		assert.equal(checkPidLiveness(123, () => { throw errno("ESRCH"); }), "dead");
		assert.equal(checkPidLiveness(123, () => { throw errno("EPERM"); }), "unknown");
		assert.equal(checkPidLiveness(123, () => { throw new Error("boom"); }), "unknown");
	});

	it("treats a pid saved under another boot as dead without probing, only when the pid namespaces are comparable", () => {
		const noProbe = () => { throw new Error("the pid must not be probed"); };
		const alive = () => true;
		const cases = [
			{ name: "other boot, same scope", recorded: { pidNamespaceScope: "pid:[1]", bootId: "boot-a" }, observed: { observedScope: "pid:[1]", observedBootId: "boot-b" }, kill: noProbe, expected: "dead" },
			{ name: "other boot, neither has a scope", recorded: { bootId: "boot-a" }, observed: { observedScope: undefined, observedBootId: "boot-b" }, kill: noProbe, expected: "dead" },
			{ name: "other boot, record scope differs", recorded: { pidNamespaceScope: "pid:[1]", bootId: "boot-a" }, observed: { observedScope: "pid:[2]", observedBootId: "boot-b" }, kill: () => { throw errno("ESRCH"); }, expected: "unknown" },
			{ name: "other boot, only the observer has a scope", recorded: { bootId: "boot-a" }, observed: { observedScope: "pid:[1]", observedBootId: "boot-b" }, kill: alive, expected: "alive" },
			{ name: "same boot, live pid", recorded: { pidNamespaceScope: "pid:[1]", bootId: "boot-a" }, observed: { observedScope: "pid:[1]", observedBootId: "boot-a" }, kill: alive, expected: "alive" },
			{ name: "record has no boot id", recorded: { pidNamespaceScope: "pid:[1]" }, observed: { observedScope: "pid:[1]", observedBootId: "boot-b" }, kill: alive, expected: "alive" },
			{ name: "observer has no boot id", recorded: { pidNamespaceScope: "pid:[1]", bootId: "boot-a" }, observed: { observedScope: "pid:[1]", observedBootId: undefined }, kill: alive, expected: "alive" },
		];
		for (const testCase of cases) {
			assert.equal(checkRecordedPidLiveness({ pid: 4242, ...testCase.recorded }, { ...testCase.observed, kill: testCase.kill }), testCase.expected, testCase.name);
		}
	});

	it("marks a workflow whose Pi process is dead owner-exited, and no other repair", () => {
		const root = tempRoot("pi-stale-run-owner-exited-");
		try {
			const resultsDir = path.join(root, "results");
			const workflowStatus = (runId: string, extra: Record<string, unknown> = {}) => ({
				runId,
				sessionId: "session-owner",
				mode: "workflow",
				state: "running",
				pid: 4242,
				pidNamespaceScope: "pid:[same]",
				bootId: "boot-now",
				startedAt: 1000,
				lastUpdate: 1000,
				steps: [{ agent: "echo", status: "running", startedAt: 1000, workflowKey: "stage2" }],
				workflow: { trace: [], emits: [], console: [], scriptDigest: "digest" },
				...extra,
			});
			const reconcile = (runId: string, status: Record<string, unknown>, options: Parameters<typeof reconcileAsyncRun>[1]) => {
				const asyncDir = path.join(root, runId);
				writeStatus(asyncDir, status);
				const result = reconcileAsyncRun(asyncDir, { resultsDir, pidNamespaceScope: () => "pid:[same]", bootId: () => "boot-now", now: () => 2000, ...options });
				return { result, status: JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8")) };
			};
			const ownerExitedMessage = (runId: string) => `The Pi process (PID 4242) that ran workflow ${runId} exited before the workflow finished. Marked run failed by stale-run reconciliation. Its finished children are kept.`;

			const dead = reconcile("wf-dead", workflowStatus("wf-dead"), { kill: () => { throw errno("ESRCH"); } });
			assert.equal(dead.result.repaired, true);
			assert.equal(dead.status.state, "failed");
			assert.equal(dead.status.workflow.stopCause, "owner-exited");
			assert.equal(dead.status.workflow.scriptDigest, "digest");
			// When the dead owner last updated it, not the repair time, and the stop cause in the result.
			assert.equal(dead.status.workflow.ownerExitedAt, 1000);
			assert.equal(dead.status.endedAt, 2000);
			assert.deepEqual(JSON.parse(fs.readFileSync(path.join(resultsDir, "wf-dead.json"), "utf-8")).workflow, { stopCause: "owner-exited" });
			const neverUpdated = reconcile("wf-never-updated", workflowStatus("wf-never-updated", { lastUpdate: undefined, startedAt: 900 }), { kill: () => { throw errno("ESRCH"); } });
			assert.equal(neverUpdated.status.workflow.ownerExitedAt, 900);
			assert.equal(JSON.parse(fs.readFileSync(path.join(resultsDir, "wf-dead.json"), "utf-8")).summary, ownerExitedMessage("wf-dead"));

			const rebooted = reconcile("wf-rebooted", workflowStatus("wf-rebooted", { bootId: "boot-before" }), { kill: () => { throw new Error("the pid must not be probed"); } });
			assert.equal(rebooted.status.workflow.stopCause, "owner-exited");

			const alive = reconcile("wf-alive", workflowStatus("wf-alive"), { kill: () => true });
			assert.equal(alive.result.repaired, false);
			assert.equal(alive.status.workflow.stopCause, undefined);

			const staleAlive = reconcile("wf-stale-alive", workflowStatus("wf-stale-alive"), { kill: () => true, staleAlivePidMs: 500 });
			assert.equal(staleAlive.status.state, "failed");
			assert.equal(staleAlive.status.workflow.stopCause, undefined);
			assert.match(staleAlive.result.message ?? "", /^Async runner PID 4242 is still live; status has not updated/);

			const staleUnknown = reconcile("wf-stale-unknown", workflowStatus("wf-stale-unknown", { pidNamespaceScope: "pid:[container]" }), { kill: () => { throw errno("ESRCH"); }, staleAlivePidMs: 500 });
			assert.equal(staleUnknown.status.state, "failed");
			assert.equal(staleUnknown.status.workflow.stopCause, undefined);
			assert.match(staleUnknown.result.message ?? "", /cannot be probed from this process/);

			const { workflow: _workflow, ...singleStatus } = workflowStatus("single-dead", { mode: "single" });
			const single = reconcile("single-dead", singleStatus, { kill: () => { throw errno("ESRCH"); } });
			assert.equal(single.status.workflow, undefined);
			assert.equal(single.result.message, "Async runner process 4242 exited or disappeared before writing a result. Marked run failed by stale-run reconciliation.");

			// An owning session's repair adopts its completion owner, so it can deliver the notice; only an owner-exited workflow does.
			const deadPid = () => { throw errno("ESRCH"); };
			const resultOwner = (runId: string) => JSON.parse(fs.readFileSync(path.join(resultsDir, `${runId}.json`), "utf-8")).completionOwnerId;
			const adopted = reconcile("wf-adopted", workflowStatus("wf-adopted", { completionOwnerId: "dead-process" }), { kill: deadPid, adoptCompletionOwnerId: "this-process" });
			assert.equal(adopted.status.completionOwnerId, "this-process");
			assert.equal(resultOwner("wf-adopted"), "this-process");
			// A repair where no owning session adopts it leaves its notice to whichever session owns the run.
			const elsewhere = reconcile("wf-elsewhere", workflowStatus("wf-elsewhere", { completionOwnerId: "dead-process" }), { kill: deadPid });
			assert.equal(elsewhere.status.completionOwnerId, "owning-session");
			assert.equal(resultOwner("wf-elsewhere"), "owning-session");
			const singleKept = reconcile("single-kept", { ...singleStatus, runId: "single-kept", completionOwnerId: "dead-process" }, { kill: deadPid, adoptCompletionOwnerId: "this-process" });
			assert.equal(singleKept.status.completionOwnerId, "dead-process");
			assert.equal(resultOwner("single-kept"), "dead-process");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("repairs a recent Linux zombie only with a verified PID namespace", { skip: process.platform !== "linux", timeout: 10_000 }, async () => {
		const root = tempRoot("pi-stale-run-zombie-");
		const script = String.raw`
			const { spawn } = require("node:child_process");
			const fs = require("node:fs");
			const child = spawn(process.execPath, ["-e", 'process.title = "pi) zombie"; process.exit(0);'], { stdio: "ignore" });
			process.stdout.write(String(child.pid) + "\n");
			// Keep libuv from reaping the child until the test releases stdin.
			fs.readSync(0, Buffer.alloc(1), 0, 1, null);
		`;
		const parent = spawn(process.execPath, ["--eval", script], { stdio: ["pipe", "pipe", "pipe"] });
		const closed = once(parent, "close");
		parent.stdin.on("error", () => {});
		try {
			const [output] = await once(parent.stdout, "data", { signal: AbortSignal.timeout(5_000) });
			const pid = Number(String(output).trim());
			assert.ok(Number.isSafeInteger(pid) && pid > 0);
			let stat = "";
			const deadline = Date.now() + 5_000;
			while (Date.now() < deadline) {
				stat = fs.readFileSync(`/proc/${pid}/stat`, "utf-8");
				if (stat[stat.lastIndexOf(") ") + 2] === "Z") break;
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			assert.match(stat, /\(pi\) zombie\) Z /);
			assert.equal(process.kill(pid, 0), true);
			assert.equal(checkPidLiveness(pid, process.kill, true), "dead");
			const scope = fs.readlinkSync("/proc/self/ns/pid", "utf-8").trim();
			const now = Date.now();
			const resultsDir = path.join(root, "results");
			for (const scenario of [
				{ name: "matching", recorded: scope, observed: scope, immediate: true },
				{ name: "missing-recorded", recorded: undefined, observed: scope, immediate: false },
				{ name: "different", recorded: "pid:[other]", observed: scope, immediate: false },
				{ name: "missing-observed", recorded: scope, observed: undefined, immediate: false },
				{ name: "both-missing", recorded: undefined, observed: undefined, immediate: false },
			]) {
				const runId = `run-zombie-${scenario.name}`;
				const asyncDir = path.join(root, runId);
				writeStatus(asyncDir, {
					runId, sessionId: "zombie-session", mode: "single", state: "running", pid,
					...(scenario.recorded !== undefined ? { pidNamespaceScope: scenario.recorded } : {}),
					startedAt: now - 100, lastUpdate: now - 100,
					steps: [{ agent: "worker", status: "running", startedAt: now - 100 }],
				});
				const options = { resultsDir, pidNamespaceScope: () => scenario.observed, now: () => now };
				const repaired = reconcileAsyncRun(asyncDir, options);
				assert.equal(repaired.repaired, scenario.immediate, scenario.name);
				assert.equal(repaired.status?.state, scenario.immediate ? "failed" : "running", scenario.name);
				const resultPath = path.join(resultsDir, `${runId}.json`);
				assert.equal(fs.existsSync(resultPath), scenario.immediate, scenario.name);
				if (!scenario.immediate) {
					const stale = reconcileAsyncRun(asyncDir, { ...options, staleAlivePidMs: 1000, now: () => now + 2000 });
					assert.equal(stale.repaired, true, scenario.name);
					assert.equal(stale.status?.state, "failed", scenario.name);
					assert.match(stale.message ?? "", /status has not updated for 2100ms.*PID ownership is unverified/);
				}
				const receipt = fs.readFileSync(resultPath, "utf-8");
				assert.equal(JSON.parse(receipt).state, "failed");
				assert.equal(reconcileAsyncRun(asyncDir, options).repaired, false);
				assert.equal(fs.readFileSync(resultPath, "utf-8"), receipt);
			}
			assert.equal(checkPidLiveness(pid), "alive", "unscoped callers retain signal-only probing");
		} finally {
			parent.stdin.end("reap");
			await closed;
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("repairs a run whose PID belongs to another namespace only after status goes stale", () => {
		const root = tempRoot("pi-stale-run-pid-namespace-");
		try {
			const asyncDir = path.join(root, "run-live");
			writeStatus(asyncDir, {
				runId: "run-live",
				mode: "single",
				state: "running",
				pid: 1404,
				pidNamespaceScope: "pid:[runner]",
				startedAt: 1000,
				lastUpdate: 1000,
				steps: [{ agent: "reviewer", status: "running", startedAt: 1000 }],
			});

			const result = reconcileAsyncRun(asyncDir, {
				kill: () => { throw errno("ESRCH"); },
				pidNamespaceScope: () => "pid:[observer]",
				now: () => 2000,
			});

			assert.equal(result.repaired, false);
			assert.equal(result.status?.state, "running");
			assert.equal(JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8")).state, "running");

			const stale = reconcileAsyncRun(asyncDir, {
				kill: () => { throw errno("ESRCH"); },
				pidNamespaceScope: () => "pid:[observer]",
				staleAlivePidMs: 5000,
				now: () => 7000,
			});

			assert.equal(stale.repaired, true);
			assert.equal(stale.status?.state, "failed");
			assert.match(stale.message ?? "", /PID 1404 cannot be probed from this process; status has not updated for 6000ms/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("does not repair a recent namespaced run from an observer without a PID namespace", () => {
		const root = tempRoot("pi-stale-run-pid-namespace-unknown-");
		try {
			const asyncDir = path.join(root, "run-dead");
			writeStatus(asyncDir, {
				runId: "run-dead",
				mode: "single",
				state: "running",
				pid: 1404,
				pidNamespaceScope: "pid:[runner]",
				startedAt: 1000,
				lastUpdate: 1000,
				steps: [{ agent: "reviewer", status: "running", startedAt: 1000 }],
			});

			const result = reconcileAsyncRun(asyncDir, {
				kill: () => { throw errno("ESRCH"); },
				pidNamespaceScope: () => undefined,
				now: () => 2000,
			});

			assert.equal(result.repaired, false);
			assert.equal(result.status?.state, "running");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("marks a dead runner failed and writes exactly one completion result", () => {
		const root = tempRoot("pi-stale-run-");
		try {
			const asyncDir = path.join(root, "run-dead");
			const resultsDir = path.join(root, "results");
			writeStatus(asyncDir, {
				lifecycleArtifactVersion: 3,
				runId: "run-dead",
				sessionId: "session-current",
				completionOwnerId: "owner-current",
				completionOwnerProcess: { pid: 4321, bootId: "boot-a" },
				mode: "single",
				state: "running",
				pid: 12345,
				pidNamespaceScope: "pid:[same]",
				processTerminal: { version: 1, state: "pending", runId: "run-dead", runnerProcessInstanceId: "runner-dead" },
				startedAt: 1000,
				lastUpdate: 1000,
				currentStep: 0,
				steps: [{ agent: "scout", status: "running", startedAt: 1000, contextOverflow: true }],
			});

			const result = reconcileAsyncRun(asyncDir, {
				resultsDir,
				kill: () => { throw errno("ESRCH"); },
				pidNamespaceScope: () => "pid:[same]",
				now: () => 2000,
			});

			assert.equal(result.repaired, true);
			assert.equal(result.status?.state, "failed");
			assert.match(result.message ?? "", /process 12345 exited or disappeared/);
			const status = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8"));
			assert.equal(status.state, "failed");
			assert.equal(status.sessionId, "session-current");
			assert.equal(status.completionOwnerId, "owner-current");
			assert.equal(status.steps[0].status, "failed");
			assert.match(status.steps[0].error, /process 12345 exited or disappeared/);
			const resultJson = JSON.parse(fs.readFileSync(path.join(resultsDir, "run-dead.json"), "utf-8"));
			assert.equal(resultJson.success, false);
			assert.equal(resultJson.sessionId, "session-current");
			assert.equal(resultJson.completionOwnerId, "owner-current");
			assert.deepEqual(resultJson.completionOwnerProcess, { pid: 4321, bootId: "boot-a" });
			assert.equal(resultJson.state, "failed");
			assert.equal(resultJson.exitCode, 1);
			assert.equal(resultJson.results[0].contextOverflow, true);
			assert.match(resultJson.summary, /process 12345 exited or disappeared/);
			assert.match(fs.readFileSync(path.join(asyncDir, "events.jsonl"), "utf-8"), /subagent\.run\.repaired_stale/);

			const resultText = fs.readFileSync(path.join(resultsDir, "run-dead.json"), "utf-8");
			const second = reconcileAsyncRun(asyncDir, {
				resultsDir,
				kill: () => { throw errno("ESRCH"); },
				now: () => 3000,
			});
			assert.equal(second.repaired, false);
			assert.equal(fs.readFileSync(path.join(resultsDir, "run-dead.json"), "utf-8"), resultText);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("keeps a dead workflow child's workflow identity in its repaired result", () => {
		const root = tempRoot("pi-stale-run-");
		try {
			const asyncDir = path.join(root, "run-child");
			const resultsDir = path.join(root, "results");
			writeStatus(asyncDir, {
				runId: "run-child",
				sessionId: "session-current",
				parentWorkflowRunId: "workflow-1",
				workflowKey: "memory",
				mode: "single",
				state: "running",
				pid: 12345,
				startedAt: 1000,
				lastUpdate: 1000,
				steps: [{ agent: "worker", status: "running", startedAt: 1000 }],
			});

			reconcileAsyncRun(asyncDir, { resultsDir, kill: () => { throw errno("ESRCH"); }, now: () => 2000 });

			const resultJson = JSON.parse(fs.readFileSync(path.join(resultsDir, "run-child.json"), "utf-8"));
			assert.equal(resultJson.state, "failed");
			assert.equal(resultJson.parentWorkflowRunId, "workflow-1");
			assert.equal(resultJson.workflowKey, "memory");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("reports the observed runner exit code and signal when a killed runner left no result", () => {
		const root = tempRoot("pi-stale-run-killed-");
		try {
			const asyncDir = path.join(root, "run-killed");
			const resultsDir = path.join(root, "results");
			writeStatus(asyncDir, {
				lifecycleArtifactVersion: 3,
				runId: "run-killed",
				sessionId: "session-current",
				mode: "single",
				state: "running",
				pid: 4242,
				startedAt: 1000,
				lastUpdate: 1000,
				currentStep: 0,
				steps: [{ agent: "worker", status: "running", startedAt: 1000 }],
			});
			initializeProcessTerminal(asyncDir, "run-killed", "runner-killed");
			const proof = finalizeProcessTerminal(asyncDir, "run-killed", { processInstanceId: "runner-killed", closeObservedAt: 1500, exitCode: null, signal: "SIGKILL" });
			assert.equal(proof.state, "unknown");

			reconcileAsyncRun(asyncDir, { resultsDir, kill: () => { throw errno("ESRCH"); }, now: () => 2000 });

			const resultJson = JSON.parse(fs.readFileSync(path.join(resultsDir, "run-killed.json"), "utf-8"));
			assert.equal(resultJson.state, "failed");
			assert.match(resultJson.summary, /Async runner process 4242 exited with code none \(signal SIGKILL\) before writing a result/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("repairs sessionless stale status without writing an unindexed result", () => {
		const root = tempRoot("pi-stale-run-sessionless-");
		try {
			const asyncDir = path.join(root, "run-sessionless");
			const resultsDir = path.join(root, "results");
			writeStatus(asyncDir, {
				runId: "run-sessionless",
				mode: "single",
				state: "running",
				pid: 12345,
				startedAt: 1000,
				lastUpdate: 1000,
				currentStep: 0,
				steps: [{ agent: "scout", status: "running", startedAt: 1000 }],
			});

			const result = reconcileAsyncRun(asyncDir, {
				resultsDir,
				kill: () => { throw errno("ESRCH"); },
				now: () => 2000,
			});

			assert.equal(result.repaired, true);
			assert.equal(result.resultPath, undefined);
			assert.equal(JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8")).state, "failed");
			assert.equal(fs.existsSync(path.join(resultsDir, "run-sessionless.json")), false);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("includes runner stderr diagnostics when repairing a stale startup crash", () => {
		const root = tempRoot("pi-stale-run-stderr-");
		try {
			const asyncDir = path.join(root, "run-dead-stderr");
			const resultsDir = path.join(root, "results");
			writeStatus(asyncDir, {
				runId: "run-dead-stderr",
				sessionId: "session-current",
				mode: "single",
				state: "running",
				pid: 12345,
				startedAt: 1000,
				lastUpdate: 1000,
				currentStep: 0,
				steps: [{ agent: "scout", status: "running", startedAt: 1000 }],
			});
			fs.writeFileSync(path.join(asyncDir, "runner.stderr.log"), "startup failed\nmissing peer package\n", "utf-8");

			const result = reconcileAsyncRun(asyncDir, {
				resultsDir,
				kill: () => { throw errno("ESRCH"); },
				now: () => 2000,
			});

			assert.equal(result.repaired, true);
			assert.match(result.message ?? "", /Runner stderr tail:/);
			assert.match(result.message ?? "", /missing peer package/);
			const status = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8"));
			assert.match(status.steps[0].error, /missing peer package/);
			const resultJson = JSON.parse(fs.readFileSync(path.join(resultsDir, "run-dead-stderr.json"), "utf-8"));
			assert.match(resultJson.summary, /missing peer package/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("keeps stale repair successful when the event log cannot be appended", () => {
		const root = tempRoot("pi-stale-event-log-collision-");
		try {
			const asyncDir = path.join(root, "run-dead-events-dir");
			const resultsDir = path.join(root, "results");
			writeStatus(asyncDir, {
				runId: "run-dead-events-dir",
				sessionId: "session-current",
				mode: "single",
				state: "running",
				pid: 12345,
				startedAt: 1000,
				lastUpdate: 1000,
				currentStep: 0,
				steps: [{ agent: "worker", status: "running", startedAt: 1000 }],
			});
			fs.mkdirSync(path.join(asyncDir, "events.jsonl"));

			const result = reconcileAsyncRun(asyncDir, {
				resultsDir,
				kill: () => { throw errno("ESRCH"); },
				now: () => 2000,
			});

			assert.equal(result.repaired, true);
			assert.equal(result.status?.state, "failed");
			assert.equal(JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8")).state, "failed");
			assert.equal(JSON.parse(fs.readFileSync(path.join(resultsDir, "run-dead-events-dir.json"), "utf-8")).success, false);
			assert.equal(fs.statSync(path.join(asyncDir, "events.jsonl")).isDirectory(), true);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("repairs stale status with per-child result outcomes", () => {
		const root = tempRoot("pi-stale-mixed-result-");
		try {
			const asyncDir = path.join(root, "run-mixed");
			const resultsDir = path.join(root, "results");
			fs.mkdirSync(resultsDir, { recursive: true });
			writeStatus(asyncDir, {
				runId: "run-mixed",
				mode: "chain",
				state: "running",
				pid: 12345,
				startedAt: 1000,
				lastUpdate: 1000,
				steps: [
					{ agent: "scout", status: "running", startedAt: 1000, model: "planned-scout" },
					{ agent: "worker", status: "running", startedAt: 1100, model: "planned-worker" },
				],
			});
			const scoutSession = path.join(root, "scout.jsonl");
			const workerSession = path.join(root, "worker.jsonl");
			fs.writeFileSync(path.join(resultsDir, "run-mixed.json"), JSON.stringify({
				id: "run-mixed",
				success: false,
				state: "failed",
				results: [
					{ agent: "scout", success: true, sessionFile: scoutSession, model: "fast" },
					{ agent: "worker", success: false, error: "boom", sessionFile: workerSession, model: "careful", contextOverflow: true },
				],
			}, null, 2), "utf-8");

			const result = reconcileAsyncRun(asyncDir, {
				resultsDir,
				kill: () => { throw errno("ESRCH"); },
				now: () => 2000,
			});

			assert.equal(result.repaired, true);
			assert.equal(result.status?.state, "failed");
			assert.equal(result.status?.steps?.[0]?.status, "complete");
			assert.equal(result.status?.steps?.[0]?.exitCode, 0);
			assert.equal(result.status?.steps?.[0]?.model, "fast");
			assert.equal(result.status?.steps?.[0]?.sessionFile, scoutSession);
			assert.equal(result.status?.steps?.[1]?.status, "failed");
			assert.equal(result.status?.steps?.[1]?.exitCode, 1);
			assert.equal(result.status?.steps?.[1]?.error, "boom");
			assert.equal(result.status?.steps?.[1]?.model, "careful");
			assert.equal(result.status?.steps?.[1]?.contextOverflow, true);
			assert.equal(result.status?.steps?.[1]?.sessionFile, workerSession);
			assert.equal(result.status?.error, "boom");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("keeps the outcome of workflow children that settled before their owner died", () => {
		const root = tempRoot("pi-stale-workflow-children-");
		try {
			const asyncDir = path.join(root, "wf");
			const step = (key: string, runId: string) => ({ agent: "worker", status: "running", startedAt: 1000, workflowKey: key, parentWorkflowRunId: "wf", runId, async: true });
			writeStatus(asyncDir, {
				runId: "wf",
				mode: "workflow",
				state: "running",
				pid: 12345,
				startedAt: 1000,
				lastUpdate: 1000,
				steps: [
					{ ...step("done", "child-done"), error: "stale host progress error" },
					step("bad", "child-bad"),
					step("live", "child-live"),
					step("gone", "child-gone"),
					step("corrupt", "child-corrupt"),
					step("halted", "child-halted"),
					step("cut", "child-cut"),
					step("foreign", "child-foreign"),
				],
			});
			const child = (runId: string, key: string, state: string, endedAt: number | undefined, childStep: Record<string, unknown>, parentWorkflowRunId = "wf") =>
				writeStatus(path.join(root, runId), { runId, mode: "single", state, startedAt: 1000, ...(endedAt !== undefined ? { endedAt } : {}), parentWorkflowRunId, workflowKey: key, steps: [{ agent: "worker", ...childStep }] });
			child("child-done", "done", "complete", 1500, { status: "complete", exitCode: 0 });
			child("child-bad", "bad", "failed", 1600, { status: "failed", exitCode: 1, error: "child boom" });
			child("child-halted", "halted", "stopped", undefined, { status: "stopped", exitCode: 1, error: "stopped by bg_stop" });
			child("child-cut", "cut", "partial", 1700, { status: "partial", exitCode: 1, error: "turn budget exhausted" });
			// Owned by another workflow: its outcome must not be borrowed.
			child("child-foreign", "foreign", "complete", 1500, { status: "complete", exitCode: 0 }, "other-wf");
			fs.mkdirSync(path.join(root, "child-corrupt"), { recursive: true });
			fs.writeFileSync(path.join(root, "child-corrupt", "status.json"), "{not json", "utf-8");
			writeStatus(path.join(root, "child-live"), { runId: "child-live", mode: "single", state: "running", startedAt: 1000, steps: [{ agent: "worker", status: "running" }] });

			const result = reconcileAsyncRun(asyncDir, {
				resultsDir: path.join(root, "results"),
				kill: () => { throw errno("ESRCH"); },
				now: () => 2000,
			});

			assert.equal(result.status?.state, "failed");
			const steps = result.status?.steps ?? [];
			assert.equal(steps[0]?.status, "complete");
			assert.equal(steps[0]?.exitCode, 0);
			assert.equal(steps[0]?.endedAt, 1500);
			assert.equal(steps[0]?.error, undefined);
			assert.equal(steps[1]?.status, "failed");
			assert.equal(steps[1]?.error, "child boom");
			// Unsettled or unreadable children still inherit the owner failure.
			assert.equal(steps[2]?.status, "failed");
			assert.match(steps[2]?.error ?? "", /stale-run reconciliation/);
			assert.equal(steps[3]?.status, "failed");
			// A corrupt child status keeps the owner repair going and stays visible in the error.
			assert.equal(result.repaired, true);
			assert.equal(steps[4]?.status, "failed");
			assert.match(steps[4]?.error ?? "", /child status unreadable/);
			// Every terminal child state is kept, not only complete and failed.
			assert.equal(steps[5]?.status, "stopped");
			assert.equal(steps[5]?.stopped, true);
			assert.equal(steps[5]?.error, "stopped by bg_stop");
			assert.equal(steps[5]?.endedAt, 2000);
			assert.equal(steps[6]?.status, "partial");
			assert.equal(steps[6]?.error, "turn budget exhausted");
			assert.equal(steps[6]?.endedAt, 1700);
			assert.equal(steps[7]?.status, "failed");
			assert.match(steps[7]?.error ?? "", /stale-run reconciliation/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("retains a root failure when stale result repair writes after runner finalization", () => {
		const root = tempRoot("pi-stale-result-race-");
		try {
			const runId = "run-result-race";
			const staleRunnerProcessInstanceId = "runner-stale-result-race";
			const finalRunnerProcessInstanceId = "runner-final-result-race";
			const asyncDir = path.join(root, runId);
			const resultsDir = path.join(root, "results");
			initializeProcessTerminal(asyncDir, runId, staleRunnerProcessInstanceId);
			const staleStatus = {
				lifecycleArtifactVersion: 3,
				runId,
				mode: "chain",
				state: "running",
				pid: 12345,
				startedAt: 1000,
				lastUpdate: 1500,
				processTerminal: { version: 1, state: "pending", runId, runnerProcessInstanceId: staleRunnerProcessInstanceId },
				steps: [
					{ agent: "scout", status: "complete", startedAt: 1000, endedAt: 1200, exitCode: 0, processTerminal: { version: 1, state: "pending", runId, childIndex: 0, runnerProcessInstanceId: "runner-stale-step-0" } },
					{ agent: "worker", status: "failed", startedAt: 1000, endedAt: 1400, exitCode: 1, error: "child diagnostic", processTerminal: { version: 1, state: "not-started", runId, childIndex: 1, runnerProcessInstanceId: "runner-stale-step-1" } },
				],
			};
			writeStatus(asyncDir, staleStatus);
			fs.mkdirSync(resultsDir, { recursive: true });
			const resultPath = path.join(resultsDir, `${runId}.json`);
			fs.writeFileSync(resultPath, JSON.stringify({
				id: runId,
				success: false,
				state: "failed",
				results: [
					{ agent: "scout", success: true },
					{ agent: "worker", success: false, error: "child diagnostic" },
				],
			}, null, 2), "utf-8");

			const observedTerminal = {
				version: 1,
				state: "observed",
				runId,
				runnerProcessInstanceId: finalRunnerProcessInstanceId,
				observedAt: 1900,
				instances: [{ kind: "runner", processInstanceId: finalRunnerProcessInstanceId, closeObservedAt: 1900, exitCode: 0, signal: null }],
			} as const;
			const observedStepTerminal = {
				version: 1, state: "observed", runId, childIndex: 0,
				runnerProcessInstanceId: "runner-current-step-0",
				observedAt: 1901, resumeDisposition: "non-resumable",
				instances: [{ kind: "runner", processInstanceId: "runner-current-step-0", closeObservedAt: 1901, exitCode: 0, signal: null }],
			} as const;
			const unknownStepTerminal = {
				version: 1, state: "unknown", runId, childIndex: 1,
				runnerProcessInstanceId: "runner-current-step-1",
				reason: "process-tree-unverified", resumeDisposition: "non-resumable",
			} as const;
			const repaired = reconcileAsyncRun(asyncDir, { resultsDir, now: () => 2000 }, () => {
				fs.writeFileSync(path.join(asyncDir, "process-terminal.json"), JSON.stringify(observedTerminal), "utf-8");
				writeStatus(asyncDir, {
					...staleStatus,
					state: "failed",
					error: "ROOT DIAGNOSTIC",
					processTerminal: observedTerminal,
					steps: [
						{ ...staleStatus.steps[0], processTerminal: observedStepTerminal },
						{ ...staleStatus.steps[1], processTerminal: unknownStepTerminal },
					],
					lastUpdate: 1900,
					endedAt: 1900,
				});
			});

			assert.equal(repaired.repaired, true);
			assert.equal(repaired.status?.state, "failed");
			assert.equal(repaired.status?.error, "ROOT DIAGNOSTIC");
			assert.equal(repaired.status?.steps?.[0]?.status, "complete");
			assert.equal(repaired.status?.steps?.[1]?.status, "failed");
			assert.equal(repaired.status?.steps?.[1]?.error, "child diagnostic");
			assert.deepEqual(repaired.status?.processTerminal, observedTerminal);
			assert.deepEqual(repaired.status?.steps?.[0]?.processTerminal, observedStepTerminal);
			assert.deepEqual(repaired.status?.steps?.[1]?.processTerminal, unknownStepTerminal);
			const persistedStatus = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8"));
			assert.equal(persistedStatus.error, "ROOT DIAGNOSTIC");
			assert.deepEqual(persistedStatus.processTerminal, observedTerminal);
			assert.deepEqual(persistedStatus.steps[0].processTerminal, observedStepTerminal);
			assert.deepEqual(persistedStatus.steps[1].processTerminal, unknownStepTerminal);
			const publicStatus = summarizeAsyncStatus(asyncDir, persistedStatus);
			assert.deepEqual(publicStatus.processTerminal, observedTerminal);
			assert.deepEqual(publicStatus.steps[0]?.processTerminal, observedStepTerminal);
			assert.deepEqual(publicStatus.steps[1]?.processTerminal, unknownStepTerminal);
			assert.deepEqual(readProcessTerminal(asyncDir, { runId, runnerProcessInstanceId: finalRunnerProcessInstanceId }), observedTerminal);
			const staleLookup = readProcessTerminal(asyncDir, { runId, runnerProcessInstanceId: staleRunnerProcessInstanceId });
			assert.equal(staleLookup?.state, "unknown");
			assert.equal(staleLookup?.reason, "proof-write-failed");

			const proof = finalizeProcessTerminal(asyncDir, runId, {
				processInstanceId: finalRunnerProcessInstanceId,
				closeObservedAt: 2100,
				exitCode: 0,
				signal: null,
			});
			const finalStatus = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8"));
			assert.deepEqual(proof, observedTerminal);
			assert.deepEqual(finalStatus.processTerminal, proof);
			assert.deepEqual(finalStatus.steps[0].processTerminal, observedStepTerminal);
			assert.deepEqual(finalStatus.steps[1].processTerminal, unknownStepTerminal);
			assert.equal(finalStatus.state, "failed");
			assert.equal(finalStatus.error, "ROOT DIAGNOSTIC");
			assert.equal(JSON.parse(fs.readFileSync(resultPath, "utf-8")).results[1].error, "child diagnostic");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("preserves explicit root failure precedence during result repair", () => {
		const root = tempRoot("pi-stale-result-error-precedence-");
		try {
			const resultsDir = path.join(root, "results");
			fs.mkdirSync(resultsDir, { recursive: true });
			for (const [index, fixture] of [
				{ statusError: "status failure", resultError: "result failure", expected: "status failure" },
				{ statusError: undefined, resultError: "result failure", expected: "result failure" },
			].entries()) {
				const runId = `run-error-precedence-${index}`;
				const asyncDir = path.join(root, runId);
				writeStatus(asyncDir, {
					runId,
					mode: "single",
					state: "running",
					pid: 12345,
					startedAt: 1000,
					lastUpdate: 1000,
					...(fixture.statusError ? { error: fixture.statusError } : {}),
					steps: [{ agent: "worker", status: "running", startedAt: 1000 }],
				});
				fs.writeFileSync(path.join(resultsDir, `${runId}.json`), JSON.stringify({
					id: runId,
					success: false,
					state: "failed",
					error: fixture.resultError,
					results: [{ agent: "worker", success: false, error: "child failure" }],
				}), "utf-8");

				const repaired = reconcileAsyncRun(asyncDir, { resultsDir, now: () => 2000 });
				assert.equal(repaired.status?.error, fixture.expected);
			}
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("repairs stale running status from an indexed pending result", () => {
		const root = tempRoot("pi-stale-indexed-pending-result-");
		const originalError = console.error;
		try {
			console.error = () => {};
			const asyncDir = path.join(root, "run-pending-result");
			const resultsDir = path.join(root, "results");
			writeStatus(asyncDir, {
				runId: "run-pending-result",
				sessionId: "session-current",
				mode: "single",
				state: "running",
				pid: 12345,
				startedAt: 1000,
				lastUpdate: 1000,
				currentStep: 0,
				steps: [{ agent: "worker", status: "running", startedAt: 1000 }],
			});
			const publicResultPath = path.join(resultsDir, "run-pending-result.json");
			fs.mkdirSync(publicResultPath, { recursive: true });
			assert.deepEqual(writeAsyncResultFile(publicResultPath, {
				id: "run-pending-result",
				runId: "run-pending-result",
				sessionId: "session-current",
				success: true,
				state: "complete",
				summary: "already done",
			}), { state: "pending" });

			const result = reconcileAsyncRun(asyncDir, {
				resultsDir,
				kill: () => { throw errno("ESRCH"); },
				now: () => 2000,
			});

			assert.equal(result.repaired, true);
			assert.equal(result.status?.state, "complete");
			assert.equal(result.status?.steps?.[0]?.status, "complete");
			assert.equal(JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8")).state, "complete");
			assert.equal(fs.statSync(publicResultPath).isDirectory(), true);
			assert.match(fs.readFileSync(result.resultPath!, "utf-8"), /already done/);
		} finally {
			console.error = originalError;
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("repairs stale rejected status from an indexed pending status snapshot", () => {
		const root = tempRoot("pi-stale-rejected-pending-result-");
		const originalError = console.error;
		try {
			console.error = () => {};
			const asyncDir = path.join(root, "run-rejected");
			const resultsDir = path.join(root, "results");
			writeStatus(asyncDir, {
				runId: "run-rejected",
				sessionId: "session-current",
				mode: "chain",
				state: "rejected",
				pid: 12345,
				startedAt: 1000,
				lastUpdate: 1000,
				currentStep: 0,
				steps: [{ agent: "worker", status: "rejected", startedAt: 1000, error: "Run rejected." }],
			});
			const publicResultPath = path.join(resultsDir, "run-rejected.json");
			fs.mkdirSync(publicResultPath, { recursive: true });
			writePendingAsyncResultFile(publicResultPath, {
				id: "run-rejected",
				runId: "run-rejected",
				sessionId: "session-current",
				success: false,
				state: "rejected",
				summary: "Run rejected.",
				results: [{ agent: "worker", success: false, error: "Run rejected." }],
			});

			const result = reconcileAsyncRun(asyncDir, {
				resultsDir,
				kill: () => { throw errno("ESRCH"); },
				now: () => 2000,
			});

			assert.equal(result.repaired, false);
			assert.equal(result.status?.state, "rejected");
			assert.equal(result.status?.steps?.[0]?.status, "rejected");
			assert.match(fs.readFileSync(result.resultPath!, "utf-8"), /Run rejected/);
		} finally {
			console.error = originalError;
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("fails a stale run when a live pid has not updated beyond the stale threshold", () => {
		const root = tempRoot("pi-stale-live-pid-");
		try {
			const asyncDir = path.join(root, "run-reused-pid");
			const resultsDir = path.join(root, "results");
			writeStatus(asyncDir, {
				runId: "run-reused-pid",
				mode: "single",
				state: "running",
				pid: 12345,
				startedAt: 1000,
				lastUpdate: 1000,
				steps: [{ agent: "worker", status: "running", startedAt: 1000 }],
			});

			const result = reconcileAsyncRun(asyncDir, {
				resultsDir,
				kill: () => true,
				now: () => 5000,
				staleAlivePidMs: 1000,
			});

			assert.equal(result.repaired, true);
			assert.equal(result.status?.state, "failed");
			assert.match(result.message ?? "", /PID .* is still live; status has not updated/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("preserves an existing result instead of overwriting it with stale-run failure", () => {
		const root = tempRoot("pi-stale-existing-result-");
		try {
			const asyncDir = path.join(root, "run-result");
			const resultsDir = path.join(root, "results");
			fs.mkdirSync(resultsDir, { recursive: true });
			writeStatus(asyncDir, {
				runId: "run-result",
				mode: "single",
				state: "running",
				pid: 12345,
				startedAt: 1000,
				lastUpdate: 1000,
				steps: [{ agent: "worker", status: "running", startedAt: 1000 }],
			});
			const resultPath = path.join(resultsDir, "run-result.json");
			fs.writeFileSync(resultPath, JSON.stringify({ id: "run-result", success: true, state: "complete", summary: "already done" }, null, 2), "utf-8");

			const result = reconcileAsyncRun(asyncDir, {
				resultsDir,
				kill: () => { throw errno("ESRCH"); },
				now: () => 2000,
			});

			assert.equal(result.repaired, true);
			assert.equal(result.status?.state, "complete");
			assert.equal(JSON.parse(fs.readFileSync(resultPath, "utf-8")).summary, "already done");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
