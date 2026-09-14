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

async function waitForFile(filePath: string): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (fs.existsSync(filePath)) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	assert.fail(`Timed out waiting for ${filePath}`);
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

test("exact cached process-terminal observation proves a natural close after artifacts are removed", async (t) => {
	const asyncDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-runner-lifecycle-natural-"));
	const runner = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
	assert.ok(runner.pid);
	const runnerProcessInstanceId = randomUUID();
	let resolveTerminal!: (proof: {
		version: 1; state: "observed"; runId: string; runnerProcessInstanceId: string; observedAt: number;
		instances: [{ kind: "runner"; processInstanceId: string; closeObservedAt: number; exitCode: number | null; signal: string | null }];
	}) => void;
	const processTerminal = new Promise<Parameters<typeof resolveTerminal>[0]>((resolve) => { resolveTerminal = resolve; });
	let terminateCalls = 0;
	const lifecycle = new TestRunnerLifecycle({ createProcessTree: () => ({
		terminate: async () => { terminateCalls++; return { state: "unknown", reason: "verification-failed" }; },
		finishAfterWriterClose: async () => ({ state: "unknown", reason: "verification-failed" }),
	}) });
	lifecycle.beginTest(t.name);
	lifecycle.track(runner, { runId: "natural-close", asyncDir, runnerProcessInstanceId }, processTerminal);
	try {
		await new Promise<void>((resolve, reject) => { runner.once("error", reject); runner.once("close", (exitCode, signal) => {
			const closeObservedAt = Date.now();
			resolveTerminal({
				version: 1, state: "observed", runId: "natural-close", runnerProcessInstanceId, observedAt: closeObservedAt,
				instances: [{ kind: "runner", processInstanceId: runnerProcessInstanceId, closeObservedAt, exitCode, signal }],
			});
			resolve();
		}); });
		fs.rmSync(asyncDir, { recursive: true, force: true });
		assert.deepEqual(await lifecycle.cleanup(), [{ runId: "natural-close", pid: runner.pid, natural: true }]);
		assert.equal(terminateCalls, 0);
		assert.deepEqual(await lifecycle.cleanup(), [], "successful owners are removed");
	} finally {
		fs.rmSync(asyncDir, { recursive: true, force: true });
	}
});

test("process close without exact terminal proof fails closed without process-tree termination", async (t) => {
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
		await assert.rejects(lifecycle.cleanup(), /closed without exact observed process-terminal proof/);
		await assert.rejects(lifecycle.cleanup(), /already-closed/, "failed owner remains registered for suite retry");
		assert.equal(terminateCalls, 0);
	} finally {
		fs.rmSync(asyncDir, { recursive: true, force: true });
	}
});

test("failed owner remains registered after a later unproved natural close", async (t) => {
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
		await assert.rejects(lifecycle.cleanup(), /closed without exact observed process-terminal proof/);
		await assert.rejects(lifecycle.cleanup(), /retained-failure/, "unproved closed owner remains registered");
	} finally {
		if (alive(runner.pid)) runner.kill("SIGKILL");
		fs.rmSync(asyncDir, { recursive: true, force: true });
	}
});

test("closed runner with a separately detached live child is rejected and preserves evidence", async (t) => {
	if (process.platform === "win32") return t.skip("POSIX separately detached process-group topology");
	const asyncDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-runner-lifecycle-detached-child-"));
	const childPidPath = path.join(asyncDir, "child.pid");
	const runner = spawn(process.execPath, ["-e", [
		"const { spawn } = require('node:child_process');",
		"const fs = require('node:fs');",
		"const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });",
		"fs.writeFileSync(process.argv[1], String(child.pid));",
		"child.unref();",
		"setTimeout(() => process.exit(17), 20);",
	].join("\n"), childPidPath], { detached: true, stdio: "ignore" });
	assert.ok(runner.pid);
	const runnerProcessInstanceId = randomUUID();
	initializeProcessTerminal(asyncDir, "detached-child-crash", runnerProcessInstanceId);
	const lifecycle = new TestRunnerLifecycle({ naturalExitGraceMs: 25 });
	lifecycle.beginTest(t.name);
	lifecycle.track(runner, { runId: "detached-child-crash", asyncDir, runnerProcessInstanceId });
	let childPid: number | undefined;
	try {
		await waitForFile(childPidPath);
		childPid = Number(fs.readFileSync(childPidPath, "utf-8"));
		assert.ok(Number.isSafeInteger(childPid) && childPid > 0);
		if (runner.exitCode === null && runner.signalCode === null) {
			await new Promise<void>((resolve) => runner.once("close", () => resolve()));
		}
		await assert.rejects(lifecycle.cleanup(), /closed without exact observed process-terminal proof/);
		assert.equal(alive(childPid), true, "cleanup must not signal a detached survivor after root close");
		assert.equal(fs.existsSync(path.join(asyncDir, "process-terminal.json")), true);
		assert.equal(fs.existsSync(path.join(asyncDir, "process-terminal-candidate.json")), true);
		await assert.rejects(lifecycle.cleanup(), /detached-child-crash/, "registration and evidence remain available for retry");
	} finally {
		if (childPid && alive(childPid)) {
			const proof = await createOwnedProcessTreeController(childPid, { termGraceMs: 500, killVerifyMs: 500 }).terminate();
			assert.equal(proof.state, "observed", `test must exactly reap known child ${childPid}`);
		}
		fs.rmSync(asyncDir, { recursive: true, force: true });
	}
});
