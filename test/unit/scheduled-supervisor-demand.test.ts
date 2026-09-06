import assert from "node:assert/strict";
import fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { randomUUID } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { it } from "node:test";
import { createScheduledRunManager } from "../../src/runs/background/scheduled-runs.ts";
import { createSubagentExecutor } from "../../src/runs/foreground/subagent-executor.ts";
import { createNativeSupervisorChannel, ensureSupervisorChannelDir, resolveSupervisorChannelDir } from "../../src/intercom/native-supervisor-channel.ts";
import type { SubagentState } from "../../src/shared/types.ts";

function fixture() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "scheduled-supervisor-"));
	const initialOwner = randomUUID();
	const context = (owner = initialOwner, file: string | null = path.join(root, "parent.jsonl")) => ({
		cwd: root, hasUI: false,
		sessionManager: { getSessionId: () => owner, getSessionFile: () => file, getEntries: () => [] },
	});
	const state = {
		baseCwd: root, currentSessionId: context().sessionManager.getSessionFile(), supervisorOwnerSessionId: initialOwner,
		asyncJobs: new Map(), foregroundControls: new Map(), cleanupTimers: new Map(), lastUiContext: null,
		poller: null, completionSeen: new Map(), watcher: null, watcherRestartTimer: null,
		resultFileCoalescer: { schedule: () => false, clear() {} },
	} as SubagentState;
	const intervals = new Map<object, () => void>();
	const sent: string[] = [], cleanupDirs: string[] = [];
	let starts = 0, activations = 0, terminal = () => {};
	let done = Promise.resolve();
	const pi = {
		getAllTools: () => [], registerTool() {}, getSessionName: () => "parent",
		events: { emit() {}, on() { return () => {}; } },
		sendMessage(message: { details?: { id?: string } }) { if (message.details?.id) sent.push(message.details.id); },
	};
	const channel = createNativeSupervisorChannel(pi as never, state, {
		getCurrentOwnerStates: () => executor.getCurrentSupervisorOwnerStates(),
		platform: "darwin", watch: (() => { throw new Error("Darwin must not watch"); }) as never,
		timers: {
			setInterval: ((handler: () => void, delay: number) => {
				assert.equal(delay, 250); starts++;
				const token = { unref() {} }; intervals.set(token, handler); return token;
			}) as typeof setInterval,
			clearInterval: ((token: object) => { intervals.delete(token); }) as typeof clearInterval,
			setImmediate, clearImmediate,
		},
	});
	const config = { maxSubagentDepth: 2, control: {}, intercomBridge: {} } as never;
	const executor = createSubagentExecutor({
		pi: pi as never, state, config, asyncByDefault: false, tempArtifactsDir: root,
		getSubagentSessionRoot: () => root, expandTilde: value => value, discoverAgents: () => ({ agents: [] }),
		activateSupervisorTransport() { activations++; channel.activateTransport(); },
		refreshResultDelivery() { terminal(); },
	});
	const manager = createScheduledRunManager({ config, storeRoot: path.join(root, "schedules"),
		launch: (params, ctx, signal) => executor.executeScheduled(randomUUID(), params, signal, ctx),
	});
	channel.start();
	return {
		initialOwner, context, state, channel, executor, intervals, sent,
		starts: () => starts, activations: () => activations,
		tick() { for (const handler of [...intervals.values()]) handler(); },
		async launch(ctx = context()) {
			const id = randomUUID();
			const created = await manager.handleToolCall({ action: "schedule.create", id, at: "+1h", workflowScript: "return [];" }, ctx as never);
			assert.equal(created.isError, undefined, JSON.stringify(created));
			done = new Promise<void>(resolve => { terminal = resolve; });
			const launched = await manager.handleToolCall({ action: "schedule.run", id }, ctx as never);
			if (launched.isError) { terminal(); return { launched }; }
			const run = launched.details!.schedules!.runs![0]!;
			assert.equal(run.state, "running");
			cleanupDirs.push(run.asyncDir!);
			assert.equal(manager.observedCompletionRunIds().has(run.asyncId!), true);
			assert.equal(JSON.parse(fs.readFileSync(path.join(run.asyncDir!, "status.json"), "utf8")).state, "running");
			return { launched, run };
		},
		ask(runId: string, owner = initialOwner) {
			const dir = resolveSupervisorChannelDir(runId, "worker", 0);
			cleanupDirs.push(dir); ensureSupervisorChannelDir(dir);
			const id = randomUUID(), file = path.join(dir, "requests", `${id}.json`);
			fs.writeFileSync(file, JSON.stringify({ type: "subagent.supervisor.request", id, createdAt: Date.now(), reason: "need_decision", message: "Delayed decision", expectsReply: true, orchestratorSessionId: owner, runId, agent: "worker", childIndex: 0 }));
			return { id, file, dir };
		},
		async finish() { await done; },
		async dispose() {
			manager.stop(); channel.dispose(); await done;
			for (const dir of [...cleanupDirs, root]) fs.rmSync(dir, { recursive: true, force: true });
		},
	};
}

it("actual scheduled workflows discover delayed Darwin asks, clear terminal asks and rearm without idle demand", async () => {
	const f = fixture();
	try {
		assert.equal(f.intervals.size, 0);
		for (let cycle = 0; cycle < 2; cycle++) {
			const { run } = await f.launch();
			assert.ok(run);
			assert.equal(f.state.asyncJobs.size, 0, "scheduled registration stays isolated");
			assert.equal(f.state.foregroundControls.size, 0);
			const ask = f.ask(run.asyncId!);
			const foreign = f.ask(run.asyncId!, randomUUID());
			const target = { runId: run.asyncId!, agent: "worker", childIndex: 0 };
			// First cycle proves discovery without any lookup; second also checks passive receipts.
			if (cycle === 1) {
				assert.deepEqual(f.channel.findPendingAsks(target), [ask.id]);
				assert.equal(f.channel.pending.size, 0, "live lookup does not register or notify");
				assert.equal(f.sent.includes(ask.id), false);
			}
			f.tick();
			assert.ok(f.sent.includes(ask.id), "actual scheduled workflow must discover delayed same-owner ask without an explicit scan");
			assert.equal(f.channel.pending.has(foreign.id), false);
			assert.equal(f.sent.includes(foreign.id), false);
			assert.deepEqual(fs.readdirSync(path.join(ask.dir, "replies")), []);
			assert.equal(f.intervals.size, 1);
			assert.equal(f.starts(), cycle + 1);
			await f.finish();
			assert.deepEqual(f.channel.findPendingAsks(target), [], "terminal scheduled asks are not live receipts");
			assert.equal(fs.existsSync(ask.file), true, "terminal lookup does not clean request files");
			f.tick();
			assert.equal(f.channel.pending.size, 0, "existing lifecycle predicate sees retained terminal job");
			assert.equal(fs.existsSync(ask.file), false);
			assert.equal(fs.existsSync(foreign.file), true, "foreign requests are not cleaned or answered");
			assert.equal(f.intervals.size, 0);
		}
		assert.equal(f.activations(), 2);
	} finally { await f.dispose(); }
});

it("scheduled owner visibility preserves runtime UUID, same-file isolation and fileless transitions without aborting jobs", async () => {
	const f = fixture();
	try {
		const { run: first } = await f.launch(f.context(f.initialOwner, null));
		assert.ok(first);
		const fileless = [...f.executor.getCurrentSupervisorOwnerStates()][0]!;
		assert.equal(fileless.currentSessionId, f.initialOwner);
		const controller = fileless.workflowControllers!.get(first.asyncId!)!;
		const otherOwner = randomUUID();
		for (const inactive of [null, otherOwner]) {
			f.state.supervisorOwnerSessionId = inactive;
			assert.deepEqual([...f.executor.getCurrentSupervisorOwnerStates()], []);
			f.tick();
			assert.equal(f.intervals.size, 0, "inactive owner work cannot keep active channel polling");
			assert.equal(controller.signal.aborted, false);
		}
		const hiddenAsk = f.ask(first.asyncId!);
		f.channel.activateTransport();
		assert.equal(f.channel.pending.size, 0);
		assert.equal(f.intervals.size, 0);
		f.state.supervisorOwnerSessionId = f.initialOwner;
		f.channel.activateTransport();
		assert.equal(f.channel.pending.has(hiddenAsk.id), true);
		assert.equal(controller.signal.aborted, false);
		await f.finish(); f.tick();
		assert.equal(f.intervals.size, 0);

		const { run: saved } = await f.launch();
		assert.ok(saved);
		const ownStates = [...f.executor.getCurrentSupervisorOwnerStates()];
		assert.equal(ownStates.length, 2, "saving a file retains distinct entries under the same runtime UUID");
		const savedState = ownStates.find(state => state !== fileless)!;
		assert.equal(savedState.currentSessionId, f.context().sessionManager.getSessionFile());
		assert.ok(savedState.asyncJobs.has(saved.asyncId!));
		await f.finish(); f.tick();

		// The main owner remains unchanged during the other runtime's real scheduled launch.
		const { run: other } = await f.launch(f.context(otherOwner));
		assert.ok(other);
		assert.equal(f.intervals.size, 0, "foreign scheduled registration does not supply current-owner demand");
		assert.deepEqual([...f.executor.getCurrentSupervisorOwnerStates()], ownStates);
		const otherAsk = f.ask(other.asyncId!, otherOwner);
		f.channel.activateTransport();
		assert.equal(f.channel.pending.has(otherAsk.id), false);
		f.state.supervisorOwnerSessionId = otherOwner;
		const otherStates = [...f.executor.getCurrentSupervisorOwnerStates()];
		assert.equal(otherStates.length, 1);
		assert.notEqual(otherStates[0], savedState, "same file with new UUID never reuses or retags executor state");
		assert.ok(otherStates[0]!.asyncJobs.has(other.asyncId!));
		assert.equal(savedState.asyncJobs.has(other.asyncId!), false);
		f.channel.activateTransport();
		assert.equal(f.channel.pending.has(otherAsk.id), true);
		await f.finish(); f.tick();
		assert.equal(f.channel.pending.size, 0);
		assert.equal(f.intervals.size, 0);
	} finally { await f.dispose(); }
});

it("failed scheduled workflow persistence rolls back retained demand before activation", async (t) => {
	const f = fixture();
	const rename = fs.renameSync;
	const failedDirs: string[] = [];
	try {
		t.mock.method(fs, "renameSync", (source: fs.PathLike, destination: fs.PathLike) => {
			if (String(destination).endsWith(`${path.sep}status.json`)) {
				failedDirs.push(path.dirname(String(destination)));
				throw Object.assign(new Error("scheduled status persistence failure"), { code: "EACCES" });
			}
			return rename(source, destination);
		});
		syncBuiltinESMExports();
		const { launched } = await f.launch();
		assert.equal(launched.isError, true);
		assert.match(JSON.stringify(launched), /Failed to create async workflow storage/);
		assert.equal(f.activations(), 0);
		const retained = [...f.executor.getCurrentSupervisorOwnerStates()];
		assert.equal(retained.length, 1);
		assert.equal(retained[0]!.asyncJobs.size, 0);
		assert.equal(retained[0]!.workflowControllers!.size, 0);
		f.channel.activateTransport();
		assert.equal(f.intervals.size, 0);
	} finally {
		t.mock.restoreAll(); syncBuiltinESMExports();
		await f.dispose();
		for (const dir of failedDirs) fs.rmSync(dir, { recursive: true, force: true });
	}
});
