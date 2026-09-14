import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { createWindowsTestProcessTreeController, mapExactTerminationHelperResult, type ExactTerminationStatus, type WindowsProcessRecord, type WindowsTestProcessOps } from "../support/windows-owned-process-tree.ts";

const root = { pid: 100, parentPid: 1, creationIdentity: "638934012345678901" };
const child = { pid: 101, parentPid: 100, creationIdentity: "638934012345678902" };

function mutableOps(initial: WindowsProcessRecord[], onKill?: (pid: number, table: WindowsProcessRecord[]) => { table: WindowsProcessRecord[]; status: ExactTerminationStatus }): WindowsTestProcessOps & { calls: number[] } {
	let table = initial;
	const calls: number[] = [];
	return {
		calls,
		processTable: () => table,
		terminateExact: (pid) => {
			calls.push(pid);
			const result = onKill?.(pid, table) ?? { table: table.filter((row) => row.pid !== pid), status: "terminated" as const };
			table = result.table;
			return { status: result.status };
		},
	};
}

test("test-only Windows controller snapshots and verifies the exact owned tree", async () => {
	const ops = mutableOps([root, child]);
	const proof = await createWindowsTestProcessTreeController(root.pid, { ops, verifyMs: 100 }).terminate();
	assert.equal(proof.state, "observed", JSON.stringify(proof));
	assert.equal(proof.state === "observed" ? proof.mechanism : undefined, "windows-process-handle");
	assert.deepEqual(ops.calls, [child.pid, root.pid]);
});

test("test-only Windows controller rejects helper failure even after disappearance", async () => {
	let table = [root];
	const calls: number[] = [];
	const ops: WindowsTestProcessOps = {
		processTable: () => table,
		terminateExact: (pid) => { calls.push(pid); table = []; return { status: "terminate-failed" }; },
	};
	const proof = await createWindowsTestProcessTreeController(root.pid, { ops, verifyMs: 100 }).terminate();
	assert.equal(proof.state, "unknown");
	assert.match(proof.state === "unknown" ? proof.diagnostic ?? "" : "", /returned terminate-failed/);
	assert.deepEqual(calls, [root.pid]);
	assert.deepEqual(table, []);
});

test("test-only Windows controller refuses a reused root without termination", async () => {
	const replacement = { ...root, creationIdentity: "638934012345679999" };
	let reads = 0;
	const calls: number[] = [];
	const ops: WindowsTestProcessOps = { processTable: () => ++reads === 1 ? [root] : [replacement], terminateExact: (pid) => { calls.push(pid); return { status: "terminated" }; } };
	const proof = await createWindowsTestProcessTreeController(root.pid, { ops, verifyMs: 100 }).terminate();
	assert.equal(proof.state, "unknown");
	assert.match(proof.state === "unknown" ? proof.diagnostic ?? "" : "", /creation identity changed/);
	assert.deepEqual(calls, []);
});

test("test-only Windows controller rejects a captured descendant that remains", async () => {
	const ops = mutableOps([root, child], (pid, table) => ({ table: pid === root.pid ? table.filter((row) => row.pid !== pid) : table, status: "terminated" }));
	const proof = await createWindowsTestProcessTreeController(root.pid, { ops, verifyMs: 0 }).terminate();
	assert.equal(proof.state, "unknown");
	assert.match(proof.state === "unknown" ? proof.diagnostic ?? "" : "", new RegExp(`${child.pid}@${child.creationIdentity}`));
});

test("stale older ParentProcessId row is not classified or signalled", async () => {
	const stale = { pid: 102, parentPid: root.pid, creationIdentity: "638934012345000000" };
	const ops = mutableOps([root, stale]);
	const proof = await createWindowsTestProcessTreeController(root.pid, { ops, verifyMs: 100 }).terminate();
	assert.equal(proof.state, "observed", JSON.stringify(proof));
	assert.deepEqual(ops.calls, [root.pid]);
});

test("late child after the root snapshot is discovered and individually terminated", async () => {
	const late = { pid: 103, parentPid: root.pid, creationIdentity: "638934012345678990" };
	let table = [root];
	let reads = 0;
	const calls: number[] = [];
	const ops: WindowsTestProcessOps = {
		processTable: () => {
			reads++;
			if (reads === 3) table = [root, late];
			return table;
		},
		terminateExact: (pid) => { calls.push(pid); table = table.filter((row) => row.pid !== pid); return { status: "terminated" }; },
	};
	const proof = await createWindowsTestProcessTreeController(root.pid, { ops, verifyMs: 100 }).terminate();
	assert.equal(proof.state, "observed", JSON.stringify(proof));
	assert.deepEqual(calls, [late.pid, root.pid]);
});

test("reused descendant PID is refused", async () => {
	const replacement = { ...child, creationIdentity: "638934012345679999" };
	let reads = 0;
	const calls: number[] = [];
	const ops: WindowsTestProcessOps = {
		processTable: () => ++reads < 3 ? [root, child] : [root, replacement],
		terminateExact: (pid) => { calls.push(pid); return { status: "identity-mismatch" }; },
	};
	const proof = await createWindowsTestProcessTreeController(root.pid, { ops, verifyMs: 0 }).terminate();
	assert.equal(proof.state, "unknown");
	assert.match(proof.state === "unknown" ? proof.diagnostic ?? "" : "", /creation identity changed/);
	assert.deepEqual(calls, []);
});

test("individual descendant exact termination failure fails closed", async () => {
	const ops = mutableOps([root, child], (pid, table) => pid === root.pid
		? { table: table.filter((row) => row.pid !== pid), status: "terminated" }
		: { table, status: "access-denied" });
	const proof = await createWindowsTestProcessTreeController(root.pid, { ops, verifyMs: 0 }).terminate();
	assert.equal(proof.state, "unknown");
	assert.match(proof.state === "unknown" ? proof.diagnostic ?? "" : "", new RegExp(`Exact handle termination for ${child.pid}@.* returned access-denied`));
	assert.deepEqual(ops.calls, [child.pid]);
});

test("row appearing only after root death is ambiguous and never signalled", async () => {
	const unrelated = { pid: 102, parentPid: root.pid, creationIdentity: "638934012345679300" };
	const ops = mutableOps([root], (pid, table) => pid === root.pid ? { table: [unrelated], status: "terminated" } : { table, status: "terminated" });
	const proof = await createWindowsTestProcessTreeController(root.pid, { ops, verifyMs: 100 }).terminate();
	assert.equal(proof.state, "unknown");
	assert.match(proof.state === "unknown" ? proof.diagnostic ?? "" : "", /Ambiguous late descendant/);
	assert.deepEqual(ops.calls, [root.pid]);
});

test("descendants are terminated leaves-first before the root", async () => {
	const grandchild = { pid: 104, parentPid: child.pid, creationIdentity: "638934012345678903" };
	const ops = mutableOps([root, child, grandchild]);
	const proof = await createWindowsTestProcessTreeController(root.pid, { ops, verifyMs: 100 }).terminate();
	assert.equal(proof.state, "observed", JSON.stringify(proof));
	assert.deepEqual(ops.calls, [grandchild.pid, child.pid, root.pid]);
});

test("descendant is not signalled when its exact parent disappears before revalidation", async () => {
	let reads = 0;
	const calls: number[] = [];
	const ops: WindowsTestProcessOps = {
		processTable: () => ++reads < 3 ? [root, child] : [child],
		terminateExact: (pid) => { calls.push(pid); return { status: "terminated" }; },
	};
	const proof = await createWindowsTestProcessTreeController(root.pid, { ops, verifyMs: 100 }).terminate();
	assert.equal(proof.state, "unknown");
	assert.match(proof.state === "unknown" ? proof.diagnostic ?? "" : "", /Exact parent identity.*disappeared/);
	assert.deepEqual(calls, []);
});

test("handle-bound helper refuses replacement created after table revalidation", async () => {
	const calls: Array<{ pid: number; expected: string }> = [];
	const replacementTerminated: number[] = [];
	const ops: WindowsTestProcessOps = {
		processTable: () => [root, child],
		terminateExact: (pid, expected) => {
			calls.push({ pid, expected });
			if (pid === child.pid) return { status: "identity-mismatch", diagnostic: "opened handle belongs to replacement" };
			replacementTerminated.push(pid);
			return { status: "terminated" };
		},
	};
	const proof = await createWindowsTestProcessTreeController(root.pid, { ops, verifyMs: 100 }).terminate();
	assert.equal(proof.state, "unknown");
	assert.match(proof.state === "unknown" ? proof.diagnostic ?? "" : "", /identity-mismatch/);
	assert.deepEqual(calls, [{ pid: child.pid, expected: child.creationIdentity }]);
	assert.deepEqual(replacementTerminated, []);
});

test("exact-termination helper maps bounded native statuses", () => {
	for (const status of ["terminated", "absent", "identity-mismatch", "access-denied", "query-failed", "terminate-failed", "wait-timeout"] as const) {
		assert.deepEqual(mapExactTerminationHelperResult({ status: 0, stdout: JSON.stringify({ status, diagnostic: status }), stderr: "" }), { status, diagnostic: status });
	}
	assert.deepEqual(mapExactTerminationHelperResult({ status: null, stdout: "", stderr: "timed out" }), { status: "query-failed", diagnostic: "timed out" });
	assert.match(mapExactTerminationHelperResult({ status: 0, stdout: "{}", stderr: "" }).diagnostic ?? "", /unknown helper status/);
});

function processAbsent(pid: number): boolean {
	try { process.kill(pid, 0); return false; }
	catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}

async function waitAbsent(pid: number): Promise<void> {
	const deadline = Date.now() + 3000;
	while (!processAbsent(pid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
	assert.equal(processAbsent(pid), true, `exact Windows fixture PID ${pid} survived cleanup`);
}

test("test-only Windows controller kills a persistent parent and child", { skip: process.platform !== "win32", timeout: 20_000 }, async () => {
	const writer = spawn(process.execPath, ["-e", `
		const { spawn } = require("node:child_process");
		const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
		process.stdout.write(String(child.pid) + "\\n");
		setInterval(() => {}, 1000);
	`], { stdio: ["ignore", "pipe", "ignore"] });
	assert.ok(writer.pid);
	const writerCleanup = createWindowsTestProcessTreeController(writer.pid);
	let childPid: number | undefined;
	let childCleanup: ReturnType<typeof createWindowsTestProcessTreeController> | undefined;
	try {
		childPid = await new Promise<number>((resolve, reject) => {
			writer.once("error", reject);
			writer.stdout!.once("data", (chunk) => resolve(Number(String(chunk).trim())));
		});
		childCleanup = createWindowsTestProcessTreeController(childPid);
		const proof = await writerCleanup.terminate();
		assert.equal(proof.state, "observed", JSON.stringify(proof));
		await waitAbsent(writer.pid);
		await waitAbsent(childPid);
	} finally {
		const cleanup = await Promise.allSettled([writerCleanup.terminate(), ...(childCleanup ? [childCleanup.terminate()] : [])]);
		writer.stdout?.destroy();
		writer.unref();
		const absence = await Promise.allSettled([writer.pid, childPid]
			.filter((value): value is number => typeof value === "number")
			.map(waitAbsent));
		const failures = [...cleanup, ...absence].filter((result) => result.status === "rejected");
		if (failures.length > 0) throw new AggregateError(failures.map((result) => result.status === "rejected" ? result.reason : undefined), "Exact Windows fixture cleanup did not settle.");
	}
});
