import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, it } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SingleExecutionCleanup, SingleExecutionCleanupHooks } from "../support/single-execution-cleanup.ts";
import { SUBAGENT_ASYNC_STARTED_EVENT as START, SUBAGENT_PROCESS_TERMINAL_EVENT as TERMINAL } from "../../src/shared/types.ts";
import { initializeProcessTerminal, writeProcessTerminalCandidate, finalizeProcessTerminal } from "../../src/runs/background/process-terminal.ts";
import { createEventBus } from "../support/helpers.ts";

for (const mode of ["failure", "success", "ordinary"] as const) {
	it(`SingleExecutionCleanup subprocess ${mode} preserves automatic-root exit ownership`, async () => {
		const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "single-cleanup-process-"));
		const home = path.join(scratch, "home"), tmp = path.join(scratch, "tmp");
		fs.mkdirSync(home);
		fs.mkdirSync(tmp);
		const env = { ...process.env, HOME: home, TMPDIR: tmp };
		delete env.PI_SUBAGENTS_TEMP_ROOT;
		const argv = ["--experimental-strip-types", "--import", fileURLToPath(new URL("../support/isolated-temp-root.mjs", import.meta.url)), fileURLToPath(new URL("../support/single-execution-cleanup-process.ts", import.meta.url)), mode];
		console.log(JSON.stringify({ subprocessLaunch: { executable: process.execPath, argv, home, tmp, rootOverride: null } }));
		const child = spawn(process.execPath, argv, { env, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "", stderr = "";
		child.stdout.on("data", chunk => { stdout += chunk; });
		child.stderr.on("data", chunk => { stderr += chunk; });
		const close = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
			child.once("error", reject);
			child.once("close", (code, signal) => resolve({ code, signal }));
		});
		console.log(JSON.stringify({ subprocessClose: { pid: child.pid, ...close, stdout, stderr } }));
		assert.deepEqual(close, { code: 0, signal: null }, stderr);
		const receipt = JSON.parse(stdout.trim());
		assert.equal(receipt.pid, child.pid);
		assert.equal(receipt.producersLaunched, 0);
		assert.equal(path.dirname(receipt.root), tmp);
		assert.equal(receipt.dir, path.join(receipt.root, "synthetic-run"));
		const retained = fs.existsSync(receipt.dir);
		console.log(JSON.stringify({ postObservedClose: { mode, root: receipt.root, retained } }));
		// Only a closed, known producer-free fixture can be removed by this parent.
		try {
			assert.equal(retained, mode === "failure", "missing retained root after observed close (failure), or unexpected ordinary retention");
			assert.equal(fs.existsSync(receipt.root), mode === "failure");
		} finally {
			fs.rmSync(scratch, { recursive: true, force: true });
		}
	});
}

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture(id = "owned-run", instance = "owned-instance", pid = 123) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "single-cleanup-control-"));
	roots.push(root);
	const dir = path.join(root, "run");
	fs.mkdirSync(dir);
	initializeProcessTerminal(dir, id, instance);
	fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify({ runId: id, pid, state: "complete", processTerminal: { version: 1, state: "pending", runId: id, runnerProcessInstanceId: instance } }));
	writeProcessTerminalCandidate(dir, { version: 1, runId: id, runnerProcessInstanceId: instance, writers: {}, expectedWriters: { "0": 0 } });
	const events = createEventBus();
	const start = { id, asyncDir: dir, pid };
	const finalize = () => finalizeProcessTerminal(dir, id, { processInstanceId: instance, closeObservedAt: Date.now(), exitCode: 0, signal: null });
	return { root, dir, id, instance, events, start, finalize };
}

it("SingleExecutionCleanup waits past publication and raw close until parent finalization notification", async () => {
	const f = fixture();
	const cleanup = new SingleExecutionCleanup(f.events, 15_000, () => {});
	f.events.emit(START, f.start);
	cleanup.expect(f.id, f.dir);
	fs.writeFileSync(path.join(f.dir, "result.json"), JSON.stringify({ state: "complete" }));
	let removals = 0;
	const settled = cleanup.settle();
	assert.equal(cleanup.settle(), settled, "barrier is cached");
	const removal = settled.then(() => { removals++; fs.rmSync(f.dir, { recursive: true }); });
	await Promise.resolve();
	assert.equal(removals, 0);
	f.events.emit("raw-close", { exitCode: 0 });
	await Promise.resolve();
	assert.equal(removals, 0);
	fs.writeFileSync(path.join(f.dir, "parent-finalizer-write"), "last write");
	const proof = f.finalize();
	await Promise.resolve();
	assert.equal(removals, 0, "durable proof alone is not notification");
	f.events.emit(TERMINAL, proof);
	assert.equal(removals, 0, "removal cannot run inside synchronous finalizer callback");
	await removal;
	assert.equal(removals, 1);
	assert.equal(cleanup.observing, false, "listeners and timer removed");
});

it("SingleExecutionCleanup retains early start and terminal before execute returns identity", async () => {
	const f = fixture();
	const cleanup = new SingleExecutionCleanup(f.events, 15_000, () => {});
	const result = await cleanup.run(async () => {
		f.events.emit(START, f.start);
		f.events.emit(TERMINAL, f.finalize());
		cleanup.expect(f.id, f.dir);
		return "original result";
	});
	assert.equal(result, "original result");
	assert.equal(cleanup.observing, false);
});

for (const negative of ["wrong-run", "wrong-instance", "unknown", "malformed", "missing-close", "nonzero-close", "conflicting-start", "extra-start", "wrong-pid", "wrong-directory", "missing-status"] as const) {
	it(`SingleExecutionCleanup rejects ${negative} without throwing observers or removing roots`, async () => {
		const f = fixture();
		const cleanup = new SingleExecutionCleanup(f.events, 15_000, () => {});
		if (negative === "missing-status") fs.unlinkSync(path.join(f.dir, "status.json"));
		assert.doesNotThrow(() => f.events.emit(START, negative === "wrong-pid" ? { ...f.start, pid: 999 } : f.start));
		if (negative === "conflicting-start") assert.doesNotThrow(() => f.events.emit(START, f.start));
		if (negative === "extra-start") {
			const second = fixture("second-owned-start", "second-owned-instance", 456);
			assert.doesNotThrow(() => f.events.emit(START, second.start));
		}
		cleanup.expect(f.id, negative === "wrong-directory" ? f.root : f.dir);
		const proof = f.finalize();
		let event: unknown = proof;
		if (negative === "wrong-run") event = { ...proof, runId: "foreign" };
		if (negative === "wrong-instance") event = { ...proof, runnerProcessInstanceId: "foreign" };
		if (negative === "unknown") event = { ...proof, state: "unknown", reason: "writer-close-unverified" };
		if (negative === "malformed") event = { runId: f.id };
		if (negative === "missing-close") event = { ...proof, instances: [] };
		if (negative === "nonzero-close") event = { ...proof, instances: proof.instances?.map(x => ({ ...x, exitCode: 1 })) };
		assert.doesNotThrow(() => f.events.emit(TERMINAL, event));
		if (negative === "extra-start") await assert.rejects(cleanup.settle(), /expected exactly one owned start/);
		else await assert.rejects(cleanup.settle());
		assert.ok(fs.existsSync(f.dir));
		assert.equal(cleanup.observing, false);
	});
}

for (const phase of ["launch", "assertion"] as const) {
	it(`SingleExecutionCleanup retains original ${phase} error and unsettled roots`, async () => {
		const f = fixture();
		const cleanup = new SingleExecutionCleanup(f.events, 10, () => {});
		const original = new Error(`${phase} failure`);
		await assert.rejects(cleanup.run(async () => {
			if (phase === "assertion") {
				f.events.emit(START, f.start);
				cleanup.expect(f.id, f.dir);
			}
			throw original;
		}), error => {
			assert.ok(error instanceof AggregateError);
			assert.equal(error.errors[0], original);
			assert.ok(error.errors[1] instanceof Error);
			return true;
		});
		assert.ok(fs.existsSync(f.dir));
		assert.equal(cleanup.observing, false);
	});
}

it("SingleExecutionCleanup preserves an assertion error even with matching settlement", async () => {
	const f = fixture();
	const cleanup = new SingleExecutionCleanup(f.events, 15_000, () => {});
	const original = new Error("functional assertion");
	await assert.rejects(cleanup.run(async () => {
		f.events.emit(START, f.start);
		cleanup.expect(f.id, f.dir);
		f.events.emit(TERMINAL, f.finalize());
		throw original;
	}), error => error === original);
	cleanup.assertSettled();
});

it("SingleExecutionCleanupHooks blocks later reset, directory removal and mock uninstall after cached failure", async () => {
	const f = fixture();
	const hooks = new SingleExecutionCleanupHooks(() => {});
	const cleanup = hooks.register(f.events);
	assert.throws(() => hooks.beforeSetup(), /unsettled/);
	await assert.rejects(cleanup.run(async () => { throw new Error("launch failed"); }), AggregateError);
	let removals = 0, uninstalls = 0, resets = 0;
	await assert.rejects(async () => { await hooks.beforeRemoval(); removals++; fs.rmSync(f.root, { recursive: true }); });
	await assert.rejects(async () => { await hooks.beforeUninstall(); uninstalls++; });
	assert.throws(() => { hooks.beforeSetup(); resets++; });
	assert.throws(() => hooks.register(f.events));
	assert.deepEqual({ removals, uninstalls, resets }, { removals: 0, uninstalls: 0, resets: 0 });
	assert.ok(fs.existsSync(f.root));
	assert.equal(cleanup.observing, false);
});

it("SingleExecutionCleanupHooks leaves ordinary fixture hooks unchanged and releases settled ownership", async () => {
	const hooks = new SingleExecutionCleanupHooks(() => {});
	hooks.beforeSetup();
	await hooks.beforeRemoval();
	await hooks.beforeUninstall();
	const f = fixture();
	const cleanup = hooks.register(f.events);
	f.events.emit(START, f.start);
	cleanup.expect(f.id, f.dir);
	f.events.emit(TERMINAL, f.finalize());
	await hooks.beforeRemoval();
	hooks.afterRemoval();
	hooks.beforeSetup();
	await hooks.beforeUninstall();
});
