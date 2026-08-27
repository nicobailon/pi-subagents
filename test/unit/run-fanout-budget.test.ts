import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { afterEach, describe, it } from "node:test";
import {
	claimRunFanoutBatch,
	claimRunFanoutBatchWithCommit,
	createRunFanoutBudget,
	decodeRunFanoutBudgetDescriptor,
	encodeRunFanoutBudgetDescriptor,
	getRunFanoutBudgetSnapshot,
	RunFanoutLimitError,
	validateRunFanoutBudgetDescriptor,
} from "../../src/runs/shared/run-fanout-budget.ts";
import { resolveMaxSubagentSpawnsPerRun, type AsyncStatus } from "../../src/shared/types.ts";
import { listAsyncRuns, summarizeAsyncStatus } from "../../src/runs/background/async-status.ts";
import { createNestedRoute, writeNestedEvent } from "../../src/runs/shared/nested-events.ts";

const directories: string[] = [];
const externalDirectories: string[] = [];
const previousEnv = process.env.PI_SUBAGENT_MAX_SPAWNS_PER_RUN;

afterEach(() => {
	for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
	for (const directory of externalDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
	if (previousEnv === undefined) delete process.env.PI_SUBAGENT_MAX_SPAWNS_PER_RUN;
	else process.env.PI_SUBAGENT_MAX_SPAWNS_PER_RUN = previousEnv;
});

function budget(limit: number) {
	const descriptor = createRunFanoutBudget(`test-${Date.now()}-${Math.random()}`, limit);
	directories.push(descriptor.directory);
	return descriptor;
}

describe("run fan-out budget", () => {
	it("resolves environment over config and falls back to 64", () => {
		delete process.env.PI_SUBAGENT_MAX_SPAWNS_PER_RUN;
		assert.equal(resolveMaxSubagentSpawnsPerRun(undefined), 64);
		assert.equal(resolveMaxSubagentSpawnsPerRun(12), 12);
		for (const invalid of [0, -1, 1.5, "bad"]) assert.equal(resolveMaxSubagentSpawnsPerRun(invalid as number), 64);
		process.env.PI_SUBAGENT_MAX_SPAWNS_PER_RUN = "7";
		assert.equal(resolveMaxSubagentSpawnsPerRun(12), 7);
		for (const invalid of ["0", "-1", "1.5", "bad"]) {
			process.env.PI_SUBAGENT_MAX_SPAWNS_PER_RUN = invalid;
			assert.equal(resolveMaxSubagentSpawnsPerRun(undefined), 64);
		}
	});

	it("degrades status projection when persisted budget state is removed", () => {
		const descriptor = budget(2);
		fs.rmSync(path.join(descriptor.directory, "claims"), { recursive: true, force: true });
		const asyncDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-run-fanout-status-"));
		directories.push(asyncDir);
		fs.writeFileSync(path.join(asyncDir, "run-fanout-budget.json"), JSON.stringify(descriptor), "utf-8");
		const fallback = { used: 1, limit: 2, remaining: 1 };
		const status = {
			runId: "run-1",
			mode: "single",
			state: "running",
			startedAt: 100,
			lastUpdate: 200,
			steps: [{ agent: "worker", status: "running", startedAt: 100 }],
			runFanoutBudget: fallback,
		} as AsyncStatus;
		const summary = summarizeAsyncStatus(asyncDir, status);
		assert.deepEqual(summary.runFanoutBudget, fallback);
		assert.ok(summary.nestedWarnings?.some((warning) => warning.includes("Run fan-out status unavailable")));
	});

	it("keeps nested status projection when persisted budget state is removed", () => {
		const runId = "run-fanout-nested-status";
		const asyncRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-run-fanout-nested-root-"));
		directories.push(asyncRoot);
		const asyncDir = path.join(asyncRoot, runId);
		fs.mkdirSync(asyncDir, { recursive: true });
		const route = createNestedRoute(runId);
		directories.push(path.dirname(route.eventSink));
		const descriptor = budget(2);
		fs.rmSync(path.join(descriptor.directory, "claims"), { recursive: true, force: true });
		fs.writeFileSync(path.join(asyncDir, "run-fanout-budget.json"), JSON.stringify(descriptor), "utf-8");
		const fallback = { used: 1, limit: 2, remaining: 1 };
		fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
			runId,
			mode: "single",
			state: "running",
			startedAt: 100,
			lastUpdate: 200,
			steps: [{ agent: "worker", status: "running" }],
			runFanoutBudget: fallback,
		}), "utf-8");
		writeNestedEvent(route, {
			type: "subagent.nested.started",
			ts: 300,
			parentRunId: runId,
			parentStepIndex: 0,
			child: {
				id: "nested-child",
				parentRunId: runId,
				parentStepIndex: 0,
				depth: 1,
				path: [{ runId, stepIndex: 0 }],
				mode: "single",
				state: "running",
				agent: "nested-worker",
				startedAt: 100,
				lastUpdate: 300,
			},
		});

		const summary = listAsyncRuns(asyncRoot, { states: ["running"], repairScan: true })[0];
		assert.deepEqual(summary?.runFanoutBudget, fallback);
		assert.equal(summary?.nestedChildren?.[0]?.id, "nested-child");
		assert.equal(summary?.steps[0]?.children?.[0]?.id, "nested-child");
		assert.ok(summary?.nestedWarnings?.some((warning) => warning.includes("Run fan-out status unavailable")));
	});

	it("persists claims and rejects the responsible next path at the exact cap", () => {
		const descriptor = budget(2);
		assert.deepEqual(claimRunFanoutBatch(descriptor, ["tasks[0]", "tasks[1]"]), { used: 2, limit: 2, remaining: 0 });
		const restored = decodeRunFanoutBudgetDescriptor(encodeRunFanoutBudgetDescriptor(descriptor));
		assert.deepEqual(getRunFanoutBudgetSnapshot(restored!), { used: 2, limit: 2, remaining: 0 });
		assert.throws(() => claimRunFanoutBatch(descriptor, ["tasks[2]"]), (error: unknown) => {
			assert.ok(error instanceof RunFanoutLimitError);
			assert.equal(error.rejection.path, "tasks[2]");
			assert.equal(error.rejection.used, 2);
			assert.equal(error.rejection.remaining, 0);
			return true;
		});
	});

	it("rolls back only the failed admission batch", () => {
		const descriptor = budget(2);
		claimRunFanoutBatch(descriptor, ["single"]);
		assert.throws(() => claimRunFanoutBatch(descriptor, ["chain[0]", "chain[1]"]), RunFanoutLimitError);
		assert.deepEqual(getRunFanoutBudgetSnapshot(descriptor), { used: 1, limit: 2, remaining: 1 });
	});

	it("rolls back a batch when its commit fails", () => {
		const descriptor = budget(2);
		claimRunFanoutBatch(descriptor, ["existing"]);
		assert.throws(
			() => claimRunFanoutBatchWithCommit(descriptor, ["append"], () => { throw new Error("enqueue failed"); }),
			/enqueue failed/,
		);
		assert.deepEqual(getRunFanoutBudgetSnapshot(descriptor), { used: 1, limit: 2, remaining: 1 });
	});

	it("reports claims-directory I/O errors instead of ordinary exhaustion", () => {
		const descriptor = budget(2);
		fs.rmSync(path.join(descriptor.directory, "claims"), { recursive: true });
		fs.writeFileSync(path.join(descriptor.directory, "claims"), "not a directory", "utf-8");
		assert.throws(() => getRunFanoutBudgetSnapshot(descriptor), /claims directory is unreadable.*ENOTDIR/);
	});

	it("admits exactly one simultaneous two-slot batch at limit two", async () => {
		const moduleUrl = new URL("../../src/runs/shared/run-fanout-budget.ts", import.meta.url).href;
		const script = `import { claimRunFanoutBatch } from ${JSON.stringify(moduleUrl)}; const descriptor = JSON.parse(process.argv[1]); try { claimRunFanoutBatch(descriptor, [process.argv[2] + "[0]", process.argv[2] + "[1]"]); process.stdout.write("admitted"); } catch { process.stdout.write("rejected"); }`;
		for (let iteration = 0; iteration < 12; iteration++) {
			const descriptor = budget(2);
			const launch = (claimPath: string) => new Promise<string>((resolve, reject) => {
				const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "--eval", script, JSON.stringify(descriptor), claimPath], { stdio: ["ignore", "pipe", "pipe"] });
				let stdout = "";
				let stderr = "";
				child.stdout.on("data", (chunk) => { stdout += chunk; });
				child.stderr.on("data", (chunk) => { stderr += chunk; });
				child.on("error", reject);
				child.on("close", (code) => code === 0 ? resolve(stdout) : reject(new Error(stderr)));
			});

			assert.deepEqual((await Promise.all([launch("group-a"), launch("group-b")])).sort(), ["admitted", "rejected"], `iteration ${iteration}`);
			assert.deepEqual(getRunFanoutBudgetSnapshot(descriptor), { used: 2, limit: 2, remaining: 0 });
		}
	});

	it("fails closed when descriptor identity or managed-root containment is invalid", () => {
		const descriptor = budget(2);
		assert.throws(() => validateRunFanoutBudgetDescriptor({ ...descriptor, limit: 3 }), /does not match/);

		const outside = fs.mkdtempSync(path.join(os.tmpdir(), "pi-run-fanout-outside-"));
		externalDirectories.push(outside);
		fs.mkdirSync(path.join(outside, "claims"));
		fs.writeFileSync(path.join(outside, "manifest.json"), JSON.stringify({ version: 1, rootRunId: descriptor.rootRunId, limit: 2, createdAt: Date.now() }));
		const linked = path.join(path.dirname(descriptor.directory), `linked-${Date.now()}`);
		fs.symlinkSync(outside, linked, process.platform === "win32" ? "junction" : "dir");
		directories.push(linked);
		assert.throws(() => validateRunFanoutBudgetDescriptor({ ...descriptor, directory: linked }), /resolves outside/);
	});
});
