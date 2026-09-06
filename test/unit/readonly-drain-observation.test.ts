import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { it } from "node:test";
import { ReadonlyDrainObservation } from "../../src/runs/shared/readonly-drain-observation.ts";
import { drainOutstandingWork } from "../../src/runs/background/auto-drain.ts";
import { updateActiveRunIndex, releaseActiveRunIndex } from "../../src/runs/background/active-run-index.ts";
import { DIRS, type SubagentState } from "../../src/shared/types.ts";
import { listBackgroundWorkProviders, registerBackgroundWorkProvider } from "../../src/api/background-work.ts";
import { captureReadonlyChildDrain, createCapturedChildHooks, observeReadonlyChildHookDrain } from "../../src/runs/shared/child-hooks.ts";

const file = "/exact/child.jsonl";
const state = { currentSessionId: file } as SubagentState;
const observation = () => new ReadonlyDrainObservation(file, () => listBackgroundWorkProviders().length === 0);
const done = { content: [{ type: "text" as const, text: "done" }], details: { mode: "management" as const, results: [] } };

it("only the installed runtime drain can complete evidence, not acknowledgements, UI, wrong file or replacement installation", async () => {
	for (const kind of ["normal", "ack-only", "UI", "wrong-file", "second", "reinstalled", "missing-installation"] as const) {
		const config = { fanoutChild: false, fast: false, waitTool: { enabled: false } };
		const { hooks } = createCapturedChildHooks(config);
		type Handler = (event: unknown, ctx: unknown) => unknown;
		const handlers = new Map<string, Handler[]>();
		const pi = { on(event: string, handler: Handler) { handlers.set(event, [...handlers.get(event) ?? [], handler]); }, events: { on() { return () => {}; } } };
		observeReadonlyChildHookDrain(hooks, true, file); hooks[0].factory(pi as never);
		const settled = captureReadonlyChildDrain(hooks);
		const ctx = { hasUI: kind === "UI", sessionManager: { getSessionFile: () => file } };
		for (const handler of handlers.get("session_start") ?? []) await handler({}, ctx);
		const ends = handlers.get("agent_end")!;
		assert.equal(ends.length, 2, "acknowledgement and actual drain remain distinct");
		await ends[0]({}, ctx); assert.equal(settled(), false);
		if (kind !== "ack-only") await ends[1]({}, kind === "wrong-file" ? { sessionManager: { getSessionFile: () => "/other" } } : ctx);
		if (kind === "second") await ends[1]({}, ctx);
		if (kind === "reinstalled") { observeReadonlyChildHookDrain(hooks, true, file); hooks[0].factory(pi as never); }
		if (kind === "missing-installation") { observeReadonlyChildHookDrain(hooks, true, file); assert.equal(captureReadonlyChildDrain(hooks)(), false); }
		assert.equal(settled(), kind === "normal");
	}
});

it("requires first false AND actual completion, with sticky first-true and second-episode denial", () => {
	for (const active of [false, true]) {
		const proof = observation();
		assert.equal(proof.settled(), false);
		proof.begin(file, true); proof.predicate(active);
		assert.equal(proof.check(), !active, "first true denies synchronously, before waiting or completion");
		assert.equal(proof.settled(), false);
		proof.predicate(false); proof.complete();
		assert.equal(proof.settled(), !active);
		proof.begin(file, true); proof.predicate(false); proof.complete();
		assert.equal(proof.settled(), false);
	}
});

it("observes true before wait, preserves waits/errors/deadlines and never certifies injected dependencies", async () => {
	for (const mode of ["success", "error", "throw", "timeout", "predicate throw", "false"] as const) {
		const proof = observation(); let checks = 0; let waits = 0; let clock = 0;
		const draining = drainOutstandingWork({ state, timeoutMs: 10, now: () => clock,
			hasWork: () => { if (mode === "predicate throw") throw new Error("query failure"); return mode !== "false" && checks++ === 0 || mode === "timeout"; },
			wait: async (_params, _signal, deps) => {
				waits++; assert.equal(proof.settled(), false);
				assert.equal(deps.failOnFailedRuns, true); assert.equal(deps.stopOnAttention, false);
				if (mode === "throw") throw new Error("wait throw");
				clock = 11; return mode === "error" ? { ...done, isError: true } : done;
			},
		}, proof);
		if (["error", "throw", "timeout", "predicate throw"].includes(mode)) await assert.rejects(draining, /Auto-drain failed|wait throw|timed out|query failure/);
		else await draining;
		assert.equal(waits, mode === "false" || mode === "predicate throw" ? 0 : 1);
		assert.equal(proof.settled(), false);
	}
	for (const injection of [{ hasWork: () => false }, { wait: async () => done }, { now: Date.now }]) {
		const proof = observation(); await drainOutstandingWork({ state, ...injection }, proof); assert.equal(proof.settled(), false);
	}
});

it("requires exact identity, normal completion and a nonthrowing clean guard", async () => {
	for (const identity of [null, "SDK-UUID", "/different.jsonl"]) {
		const proof = observation();
		if (identity === null) await assert.rejects(drainOutstandingWork({ state: { currentSessionId: identity } as SubagentState }, proof), /identity/);
		else await drainOutstandingWork({ state: { currentSessionId: identity } as SubagentState }, proof);
		assert.equal(proof.settled(), false);
	}
	const broken = new ReadonlyDrainObservation(file, () => { throw new Error("inspection"); });
	await drainOutstandingWork({ state }, broken); assert.equal(broken.settled(), false);
});

for (const kind of ["empty", "dead-owned", "result-queued-owned", "result-running-owned", "dismissed-owned", "unrelated-running", "unrelated-dead", "terminal-owned", "unknown-owner", "unknown-state", "corrupt", "missing-status", "missing-directory", "rejected-entry", "rejected-entry-ENOENT", "rejected-entry-ENOTDIR", "unrelated-scale"] as const) {
	it(`ordinary scan/read counts unchanged and conservative raw evidence: ${kind}`, async (t) => {
		async function run(opted: boolean) {
			const dirs: string[] = [];
			const rejectedEntry = kind.startsWith("rejected-entry");
			const count = kind === "unrelated-scale" ? 40 : kind === "empty" ? 0 : 1;
			for (let i = 0; i < count; i++) {
				const id = `drain-proof-${kind}-${opted}-${i}`; const dir = join(DIRS.async, id); dirs.push(dir);
				fs.mkdirSync(dir, { recursive: true });
				const status = { runId: id, mode: "single", state: kind === "terminal-owned" ? "complete" : kind === "result-queued-owned" ? "queued" : "running",
					sessionId: kind.startsWith("unrelated") ? "/other/file" : kind === "unknown-owner" ? undefined : file,
					startedAt: Date.now(), steps: [{ agent: "reader", status: "running" }],
					...(kind.includes("dead") ? { pid: 2147483647 } : {}), ...(kind === "dismissed-owned" ? { displayDismissedAt: 1 } : {}),
				};
				if (kind === "unknown-state") status.state = "nonsense";
				if (kind !== "missing-status") fs.writeFileSync(join(dir, "status.json"), kind === "corrupt" ? "{" : JSON.stringify(status));
				updateActiveRunIndex(dir, "running");
				if (kind === "missing-directory") fs.rmSync(dir, { recursive: true });
				if (rejectedEntry) { fs.rmSync(dir, { recursive: true }); fs.writeFileSync(dir, "not a directory"); }
				if (kind.startsWith("result-")) { fs.mkdirSync(DIRS.results, { recursive: true }); fs.writeFileSync(join(DIRS.results, `${id}.json`), JSON.stringify({ success: true, results: [] })); }
			}
			const originalRead = fs.readFileSync; const originalStat = fs.statSync; const originalReaddir = fs.readdirSync;
			// lstat rejects the regular-file entry on every OS. Marker cleanup then
			// stats file/status.json: Windows reports ENOENT, POSIX ENOTDIR.
			// Exercise the native boundary and deterministically cover both contracts.
			const injectedCode = kind === "rejected-entry-ENOENT" ? "ENOENT" : kind === "rejected-entry-ENOTDIR" ? "ENOTDIR" : undefined;
			let boundaryCode = injectedCode;
			if (rejectedEntry && !boundaryCode) {
				assert.throws(() => originalStat(join(dirs[0], "status.json")), (error: NodeJS.ErrnoException) => {
					assert.ok(error.code === "ENOENT" || error.code === "ENOTDIR");
					boundaryCode = error.code;
					return true;
				});
			}
			const counts = { index: 0, read: 0, stat: 0 };
			const isStatus = (p: unknown) => dirs.some((dir) => String(p) === join(dir, "status.json"));
			fs.readFileSync = ((...args: Parameters<typeof fs.readFileSync>) => { if (isStatus(args[0])) counts.read++; return originalRead(...args); }) as typeof fs.readFileSync;
			fs.statSync = ((...args: Parameters<typeof fs.statSync>) => {
				if (isStatus(args[0])) {
					counts.stat++;
					if (injectedCode) throw Object.assign(new Error(`${injectedCode}: fixture status stat`), { code: injectedCode });
				}
				return originalStat(...args);
			}) as typeof fs.statSync;
			fs.readdirSync = ((...args: Parameters<typeof fs.readdirSync>) => { if (String(args[0]) === join(DIRS.async, ".active-runs")) counts.index++; return originalReaddir(...args); }) as typeof fs.readdirSync;
			syncBuiltinESMExports();
			const proof = opted ? observation() : undefined;
			try {
				const outcome = await drainOutstandingWork({ state }, proof).then(
					() => "completed",
					(error: Error) => {
						assert.ok(rejectedEntry, `unexpected drain rejection: ${error}`);
						assert.match(error.message, /Failed to list async runs/);
						const inspection = error.cause as Error;
						assert.match(inspection.message, /Failed to inspect async status file/);
						return (inspection.cause as NodeJS.ErrnoException).code;
					},
				);
				assert.equal(outcome, boundaryCode === "ENOTDIR" ? "ENOTDIR" : "completed");
				if (rejectedEntry) assert.deepEqual(counts, { index: 1, read: 0, stat: 1 }, "rejected entry reaches the cleanup status-stat boundary exactly once");
				assert.equal(counts.index, 1, "first predicate is false, with no wait/final requery");
				if (proof) assert.equal(proof.settled(), ["empty", "unrelated-running", "unrelated-dead", "terminal-owned", "unrelated-scale"].includes(kind));
				const capturedCounts = { ...counts };
				if (kind.includes("dead")) assert.equal(JSON.parse(originalRead(join(dirs[0], "status.json"), "utf8")).state, "failed", "ordinary dead-PID repair remains");
				if (kind.startsWith("result-")) assert.equal(JSON.parse(originalRead(join(dirs[0], "status.json"), "utf8")).state, "complete", "ordinary result repair remains");
				return { counts: capturedCounts, outcome };
			} finally {
				fs.readFileSync = originalRead; fs.statSync = originalStat; fs.readdirSync = originalReaddir; syncBuiltinESMExports();
				for (const dir of dirs) { releaseActiveRunIndex(dir); fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(join(DIRS.results, `${dir.split("/").at(-1)}.json`), { force: true }); }
			}
		}
		const observed = await run(true), baseline = await run(false);
		assert.deepEqual(observed, baseline, "observation preserves outcome and adds no index enumeration/status reads or metadata checks");
		t.diagnostic(`baseline = opted-in ${JSON.stringify(observed)}`);
	});
}

for (const throws of [false, true]) it(`unknown provider veto precedes ordinary callbacks and survives removal (throws=${throws})`, async () => {
	const proof = observation(); let calls = 0;
	const unregister = registerBackgroundWorkProvider({ name: "drain-proof-provider", listActiveWork() { calls++; assert.equal(proof.check(), false); if (throws) throw new Error("provider failure"); return []; } });
	try {
		assert.equal(calls, 0);
		if (throws) await assert.rejects(drainOutstandingWork({ state }, proof), /provider failure/);
		else await drainOutstandingWork({ state }, proof);
		assert.ok(calls > 0);
	} finally { unregister(); }
	assert.equal(proof.settled(), false);
});
