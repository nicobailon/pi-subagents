import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { initializeProcessTerminal } from "../../src/runs/background/process-terminal.ts";
import { createOwnedProcessTreeController } from "../../src/runs/background/owned-process-tree.ts";
import { TestRunnerLifecycle } from "../support/runner-lifecycle-fixture.ts";

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

function nonterminatingProcess() {
	return spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
		detached: process.platform !== "win32",
		stdio: "ignore",
	});
}

test("fixture cleanup terminates only its exact owned runner", async (t) => {
	const asyncDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-runner-lifecycle-"));
	const owned = nonterminatingProcess();
	const unrelated = nonterminatingProcess();
	assert.ok(owned.pid);
	assert.ok(unrelated.pid);
	const runnerProcessInstanceId = randomUUID();
	initializeProcessTerminal(asyncDir, "fixture-nonterminating", runnerProcessInstanceId);
	const lifecycle = new TestRunnerLifecycle();
	lifecycle.beginTest(t.name);
	lifecycle.track(owned, { runId: "fixture-nonterminating", asyncDir, runnerProcessInstanceId });

	try {
		const result = await lifecycle.cleanup();
		assert.deepEqual(result, [{ runId: "fixture-nonterminating", pid: owned.pid, natural: false }]);
		assert.equal(alive(owned.pid), false, "owned runner must be gone after teardown");
		assert.equal(alive(unrelated.pid), true, "unrelated process must not be touched");
	} finally {
		if (unrelated.pid && alive(unrelated.pid)) {
			await createOwnedProcessTreeController(unrelated.pid, { termGraceMs: 500, killVerifyMs: 500 }).terminate();
		}
		fs.rmSync(asyncDir, { recursive: true, force: true });
	}
});

test("fixture cleanup reports exact run evidence when an owned process cannot be tree-terminated", async (t) => {
	if (process.platform === "win32") return t.skip("POSIX process-group mismatch fixture");
	const asyncDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-runner-lifecycle-diagnostic-"));
	const owned = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
	assert.ok(owned.pid);
	const runnerProcessInstanceId = randomUUID();
	initializeProcessTerminal(asyncDir, "fixture-uncleanable", runnerProcessInstanceId);
	const lifecycle = new TestRunnerLifecycle({ naturalExitGraceMs: 25, exitVerifyMs: 50 });
	lifecycle.beginTest(t.name);
	lifecycle.track(owned, { runId: "fixture-uncleanable", asyncDir, runnerProcessInstanceId });

	try {
		await assert.rejects(lifecycle.cleanup(), (error: Error) => {
			assert.match(error.message, new RegExp(`runId=fixture-uncleanable pid=${owned.pid}`));
			assert.match(error.message, /runnerProcessInstanceId=/);
			assert.match(error.message, /asyncDir=.*pi-runner-lifecycle-diagnostic-/);
			return true;
		});
	} finally {
		owned.kill("SIGKILL");
		await new Promise<void>((resolve) => owned.once("close", () => resolve()));
		fs.rmSync(asyncDir, { recursive: true, force: true });
	}
});

test("future exact ChildProcess close is natural proof without a terminal artifact", async (t) => {
	const asyncDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-runner-lifecycle-natural-"));
	const runner = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
	assert.ok(runner.pid);
	let terminateCalls = 0;
	const lifecycle = new TestRunnerLifecycle({ createProcessTree: () => ({
		terminate: async () => { terminateCalls++; return { state: "unknown", reason: "verification-failed" }; },
		finishAfterWriterClose: async () => ({ state: "unknown", reason: "verification-failed" }),
	}) });
	lifecycle.beginTest(t.name);
	lifecycle.track(runner, { runId: "natural-close", asyncDir, runnerProcessInstanceId: randomUUID() });
	try {
		await new Promise<void>((resolve, reject) => { runner.once("error", reject); runner.once("close", () => resolve()); });
		assert.deepEqual(await lifecycle.cleanup(), [{ runId: "natural-close", pid: runner.pid, natural: true }]);
		assert.equal(terminateCalls, 0);
		assert.deepEqual(await lifecycle.cleanup(), [], "successful owners are removed");
	} finally {
		fs.rmSync(asyncDir, { recursive: true, force: true });
	}
});

test("process closed before tracking is recognized without process-tree termination", async (t) => {
	const asyncDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-runner-lifecycle-already-closed-"));
	const runner = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
	await new Promise<void>((resolve, reject) => { runner.once("error", reject); runner.once("close", () => resolve()); });
	assert.ok(runner.pid);
	let terminateCalls = 0;
	const lifecycle = new TestRunnerLifecycle({ createProcessTree: () => ({
		terminate: async () => { terminateCalls++; return { state: "unknown", reason: "verification-failed" }; },
		finishAfterWriterClose: async () => ({ state: "unknown", reason: "verification-failed" }),
	}) });
	lifecycle.beginTest(t.name);
	lifecycle.track(runner, { runId: "already-closed", asyncDir, runnerProcessInstanceId: randomUUID() });
	try {
		assert.deepEqual(await lifecycle.cleanup(), [{ runId: "already-closed", pid: runner.pid, natural: true }]);
		assert.equal(terminateCalls, 0);
	} finally {
		fs.rmSync(asyncDir, { recursive: true, force: true });
	}
});

test("failed owner remains registered until a later natural close", async (t) => {
	const asyncDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-runner-lifecycle-retry-"));
	const runner = nonterminatingProcess();
	assert.ok(runner.pid);
	let terminateCalls = 0;
	let attempted = false;
	const failedProof = Promise.resolve({ state: "unknown", reason: "verification-failed", diagnostic: "injected cleanup failure" } as const);
	const lifecycle = new TestRunnerLifecycle({ naturalExitGraceMs: 10, exitVerifyMs: 10, createProcessTree: () => ({
		terminate: () => { if (!attempted) { attempted = true; terminateCalls++; } return failedProof; },
		finishAfterWriterClose: () => failedProof,
	}) });
	lifecycle.beginTest(t.name);
	lifecycle.track(runner, { runId: "retained-failure", asyncDir, runnerProcessInstanceId: randomUUID() });
	try {
		await assert.rejects(lifecycle.cleanup(), /retained-failure/);
		await assert.rejects(lifecycle.cleanup(), /retained-failure/);
		assert.equal(terminateCalls, 1, "cached failed controller is not signalled twice");
		if (process.platform === "win32") runner.kill("SIGKILL");
		else process.kill(-runner.pid, "SIGKILL");
		await new Promise<void>((resolve) => runner.once("close", () => resolve()));
		assert.deepEqual(await lifecycle.cleanup(), [{ runId: "retained-failure", pid: runner.pid, natural: true }]);
		assert.deepEqual(await lifecycle.cleanup(), [], "retained owner is removed only after success");
	} finally {
		if (alive(runner.pid)) runner.kill("SIGKILL");
		fs.rmSync(asyncDir, { recursive: true, force: true });
	}
});
