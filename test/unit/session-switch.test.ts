import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, it } from "node:test";
import type { ExtensionUIDialogOptions } from "@earendil-works/pi-coding-agent";
import { createSessionSwitchGuard, type SessionSwitchContext } from "../../src/extension/session-switch.ts";
import { updateActiveRunIndex } from "../../src/runs/background/active-run-index.ts";
import { closeStopInbox, consumeStopRequestPayloads } from "../../src/runs/background/control-channel.ts";
import { createNestedRoute, nestedRunScope, projectNestedEvents, writeNestedEvent } from "../../src/runs/shared/nested-events.ts";
import { consumeSessionHandoff } from "../../src/shared/session-succession.ts";
import type { AsyncJobState, AsyncStatus, SubagentState } from "../../src/shared/types.ts";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

function fixture() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-session-switch-"));
	const source = path.join(root, "source.jsonl");
	const target = path.join(root, "target.jsonl");
	const asyncDirRoot = path.join(root, "async");
	const resultsDir = path.join(root, "results");
	fs.mkdirSync(asyncDirRoot);
	fs.mkdirSync(resultsDir);
	const state: SubagentState = {
		baseCwd: root, currentSessionId: source,
		asyncJobs: new Map(), foregroundControls: new Map(), workflowControllers: new Map(),
		lastForegroundControlId: null, cleanupTimers: new Map(), lastUiContext: null,
		poller: null, completionSeen: new Map(), watcher: null, watcherRestartTimer: null,
		resultFileCoalescer: { schedule: () => false, clear() {} },
	};
	const events: Array<{ channel: string; data: unknown }> = [];
	const notices: string[] = [];
	let choice: (options: string[], opts: ExtensionUIDialogOptions) => Promise<string | undefined> = async (options) => options[0];
	let title = "";
	let prompts = 0;
	let pendingResults = false;
	let pendingWake = false;
	let questions = false;
	let clock = 0;
	let onSleep = () => {};
	let aborts = 0;
	const ctx: SessionSwitchContext = {
		mode: "tui", hasUI: true,
		abort: async () => { aborts++; },
		sessionManager: { getSessionFile: () => source },
		ui: {
			select: async (text, options, opts = {}) => {
				title = text; prompts++; return choice(options, opts);
			},
			notify: (message: string) => notices.push(message),
		},
	};
	const guard = createSessionSwitchGuard({ events: { emit: (channel, data) => { events.push({ channel, data }); }, on: () => () => {} } }, {
		state, asyncDirRoot, resultsDir,
		hasPendingResults: () => pendingResults || pendingWake,
		hasPendingCompletionWake: () => pendingWake,
		hasPendingSupervisorRequest: () => questions,
		now: () => clock,
		sleep: async (ms) => { clock += ms; onSleep(); },
	});
	cleanups.push(() => { guard.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
	const writeRun = (id: string, status: AsyncJobState["status"] = "running", sessionId = source, asyncDir = path.join(asyncDirRoot, id)) => {
		fs.mkdirSync(asyncDir, { recursive: true });
		fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
			runId: id, mode: "single", state: status, sessionId, pid: process.pid,
			startedAt: Date.now(), lastUpdate: Date.now(), steps: [{ agent: "worker", status }],
			processTerminal: { version: 1, state: "pending", runId: id, runnerProcessInstanceId: `runner-${id}` },
		}));
		updateActiveRunIndex(asyncDir, status);
		state.asyncJobs.set(id, { asyncId: id, asyncDir, sessionId, status });
		return asyncDir;
	};
	const observeExit = (id: string, asyncDir = path.join(asyncDirRoot, id)) => fs.writeFileSync(path.join(asyncDir, "process-terminal.json"), JSON.stringify({
		version: 1, state: "observed", runId: id, runnerProcessInstanceId: `runner-${id}`, observedAt: Date.now(),
		instances: [{ kind: "runner", processInstanceId: `runner-${id}`, closeObservedAt: Date.now(), exitCode: 0, signal: null }],
	}));
	return {
		guard, ctx, state, source, target, events, notices, writeRun, observeExit,
		get prompts() { return prompts; }, get title() { return title; }, get aborts() { return aborts; },
		set choice(value: typeof choice) { choice = value; },
		set pendingResults(value: boolean) { pendingResults = value; },
		set pendingWake(value: boolean) { pendingWake = value; },
		set questions(value: boolean) { questions = value; },
		set onSleep(value: () => void) { onSleep = value; },
	};
}

function blockerEvents(f: ReturnType<typeof fixture>) {
	return f.events.filter((event) => event.channel === "herdr:blocked").map((event) => event.data);
}

describe("session switch decisions", () => {
	it("ignores delivered history and foreign work when deciding whether to prompt", async () => {
		const f = fixture();
		f.writeRun("finished", "complete");
		f.writeRun("foreign", "running", `${f.source}-foreign`);
		assert.equal(await f.guard.beforeSwitch("new", f.ctx), undefined);
		f.guard.sessionShutdown({ type: "session_shutdown", reason: "new", targetSessionFile: f.target });
		assert.equal(f.prompts, 0);
		assert.equal(consumeSessionHandoff(f.target, f.source), false);
		assert.deepEqual(blockerEvents(f), []);
	});

	it("defaults to cancel for indexed work without rereading cached status", async () => {
		const f = fixture();
		const dir = f.writeRun("queued", "queued");
		let cachedReads = 0;
		Object.defineProperty(f.state.asyncJobs.get("queued")!, "asyncDir", { get() { cachedReads++; return dir; } });
		assert.deepEqual(await f.guard.beforeSwitch("new", f.ctx), { cancel: true });
		assert.equal(cachedReads, 0);
		assert.deepEqual(blockerEvents(f), [
			{ active: true, label: "Decide what to do with background work" }, { active: false },
		]);
		assert.equal(f.aborts, 0);
	});

	it("offers a handoff only at shutdown for normalized resume targets", async () => {
		const spellings = [
			(target: string) => target,
			(target: string) => path.relative(process.cwd(), target),
			(target: string) => `~/${path.relative(os.homedir(), target).split(path.sep).join("/")}`,
			(target: string) => pathToFileURL(target).href,
		];
		for (const spell of spellings) {
			const f = fixture();
			const target = path.join(os.homedir(), "sessions", path.basename(path.dirname(f.source)), "target.jsonl");
			f.writeRun("live");
			f.choice = async (options) => options[1];
			assert.equal(await f.guard.beforeSwitch("resume", f.ctx, spell(target)), undefined);
			assert.equal(consumeSessionHandoff(target, f.source), false, spell(target));
			f.guard.sessionShutdown({ type: "session_shutdown", reason: "resume", targetSessionFile: target });
			assert.equal(consumeSessionHandoff(target, f.source), true, spell(target));
		}
	});

	it("does not reuse consent from a failed or subsequently cancelled switch", async () => {
		const f = fixture();
		f.writeRun("live");
		f.choice = async (options) => options[1];
		await f.guard.beforeSwitch("resume", f.ctx, f.target);
		// The destination fails validation (or a later extension cancels): no shutdown happens.
		f.choice = async () => undefined;
		assert.deepEqual(await f.guard.beforeSwitch("resume", f.ctx, f.target), { cancel: true });
		f.guard.sessionShutdown({ type: "session_shutdown", reason: "resume", targetSessionFile: f.target });
		assert.equal(consumeSessionHandoff(f.target, f.source), false);
	});

	it("binds consent to the source, destination and switch reason", async () => {
		for (const mismatch of ["source", "target", "reason"]) {
			const f = fixture();
			f.writeRun("live");
			f.choice = async (options) => options[1];
			await f.guard.beforeSwitch("resume", f.ctx, f.target);
			if (mismatch === "source") f.state.currentSessionId = "another-source";
			const target = mismatch === "target" ? "another-target" : f.target;
			f.guard.sessionShutdown({ type: "session_shutdown", reason: mismatch === "reason" ? "reload" : "resume", targetSessionFile: target });
			assert.equal(consumeSessionHandoff(target, f.source), false);
		}
	});

	it("asks about undelivered results and supervisor questions even without a running row", async () => {
		for (const kind of ["result", "question"]) {
			const f = fixture();
			f.pendingResults = kind === "result";
			f.questions = kind === "question";
			assert.deepEqual(await f.guard.beforeSwitch("fork", f.ctx), { cancel: true });
			assert.match(f.title, kind === "result" ? /^  Undelivered results$/m : /^  Questions awaiting a reply$/m);
			assert.doesNotMatch(f.title, /queued or running/);
			f.choice = async (options) => options[2];
			assert.equal(await f.guard.beforeSwitch("fork", f.ctx), undefined, "leftover messages are not running work");
		}
	});

	it("stops through the existing inbox and waits for terminal status before switching fresh", async () => {
		const f = fixture();
		const dir = f.writeRun("stoppable");
		f.questions = true; // The runner may exit before its question file is removed.
		f.choice = async (options) => options[2];
		let requests = 0;
		let waits = 0;
		f.onSleep = () => {
			const stops = consumeStopRequestPayloads(dir);
			requests += stops.length;
			if (stops.length) f.writeRun("stoppable", "stopped");
			if (++waits === 2) f.observeExit("stoppable");
		};
		assert.equal(await f.guard.beforeSwitch("new", f.ctx), undefined);
		assert.equal(requests, 1);
		assert.equal(waits, 2, "terminal status alone must not claim that the runner exited");
		assert.equal(f.aborts, 1);
		f.guard.sessionShutdown({ type: "session_shutdown", reason: "new", targetSessionFile: f.target });
		assert.equal(consumeSessionHandoff(f.target, f.source), false);
	});

	it("waits for a reused workflow child's exit after its controller is gone", async () => {
		const f = fixture();
		const foreign = `${f.source}-previous`;
		f.writeRun("child", "running", foreign);
		const dir = f.writeRun("workflow");
		const status: AsyncStatus = {
			runId: "workflow", mode: "workflow", state: "running", sessionId: f.source, pid: process.pid, startedAt: Date.now(),
			steps: [{ agent: "worker", runId: "child", async: true, status: "running" }],
		};
		const save = () => fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify(status));
		save();
		const controller = new AbortController();
		f.state.workflowControllers!.set("workflow", controller);
		controller.signal.addEventListener("abort", () => {
			status.state = "stopped";
			status.steps![0]!.status = "stopped";
			f.writeRun("child", "stopped", foreign);
			f.state.workflowControllers!.delete("workflow");
			save();
		});
		let waits = 0;
		f.onSleep = () => { if (++waits === 2) f.observeExit("child"); };
		f.choice = async (options) => options[2];
		assert.equal(await f.guard.beforeSwitch("new", f.ctx), undefined);
		assert.equal(waits, 2);
	});

	it("waits for exit proof when completion races with the prompt or parent abort", async () => {
		for (const phase of ["selection", "abort", "new-during-prompt"]) {
			const f = fixture();
			f.writeRun("finishing");
			const runId = phase === "new-during-prompt" ? "late" : "finishing";
			f.choice = async (options) => {
				if (phase === "selection") f.writeRun("finishing", "complete");
				if (phase === "new-during-prompt") {
					f.writeRun("finishing", "complete");
					f.observeExit("finishing");
					f.writeRun("late");
				}
				return options[2];
			};
			if (phase !== "selection") f.ctx.abort = async () => { f.writeRun(runId, "complete"); };
			let waits = 0;
			f.onSleep = () => { if (++waits === 2) f.observeExit(runId); };
			assert.equal(await f.guard.beforeSwitch("new", f.ctx), undefined);
			assert.equal(waits, 2, phase);
		}
	});

	it("cancels an unverified stop, including runs that finish before the request", async () => {
		for (const phase of ["running", "after-request", "selection", "abort"]) {
			const f = fixture();
			f.writeRun("unproven");
			f.choice = async (options) => {
				if (phase === "selection") f.writeRun("unproven", "complete");
				return options[2];
			};
			if (phase === "abort") f.ctx.abort = async () => { f.writeRun("unproven", "complete"); };
			if (phase === "after-request") f.onSleep = () => { f.writeRun("unproven", "stopped"); };
			assert.deepEqual(await f.guard.beforeSwitch("new", f.ctx), { cancel: true }, phase);
			assert.match(f.notices.at(-1)!, /Could not verify/);
		}
	});

	for (const parent of ["running", "complete", "foreground"] as const) it(`guards and stops nested work with a ${parent} parent`, async () => {
		const f = fixture();
		const rootId = path.basename(path.dirname(f.source));
		const route = createNestedRoute(rootId);
		const dir = path.join(nestedRunScope(rootId).asyncDirRoot, "nested-child");
		cleanups.push(() => {
			fs.rmSync(path.dirname(route.eventSink), { recursive: true, force: true });
			fs.rmSync(nestedRunScope(rootId).asyncDirRoot, { recursive: true, force: true });
		});
		const publish = (state: "running" | "stopped") => {
			f.writeRun("nested-child", state, "nested-owner", dir);
			f.state.asyncJobs.delete("nested-child");
			writeNestedEvent(route, {
				type: state === "running" ? "subagent.nested.started" : "subagent.nested.completed",
				ts: state === "running" ? 100 : 200, parentRunId: rootId,
				child: { id: "nested-child", parentRunId: rootId, depth: 1, path: [{ runId: rootId }], state, asyncDir: dir },
			});
		};
		publish("running");
		if (parent === "foreground") f.state.retainedForegroundNestedRoutes = new Map([[rootId, route]]);
		else {
			f.writeRun(rootId, parent);
			Object.assign(f.state.asyncJobs.get(rootId)!, { nestedRoute: route, nestedChildren: projectNestedEvents(route).children });
		}
		assert.deepEqual(await f.guard.beforeSwitch("new", f.ctx), { cancel: true });
		assert.match(f.title, /^  Nested subagents still running$/m);
		f.choice = async (options) => options[1];
		assert.deepEqual(await f.guard.beforeSwitch("new", f.ctx), parent === "running" ? undefined : { cancel: true });
		if (parent !== "running") assert.match(f.notices.at(-1)!, /Nested work.*cannot be transferred/);
		f.ctx.abort = async () => {
			if (parent === "running") { f.writeRun(rootId, "complete"); f.observeExit(rootId); }
			f.state.asyncJobs.delete(rootId);
			f.state.retainedForegroundNestedRoutes?.clear();
		};
		let requests = 0;
		let waits = 0;
		f.onSleep = () => {
			const stops = consumeStopRequestPayloads(dir);
			requests += stops.length;
			if (stops.length) publish("stopped");
			if (++waits === 2) f.observeExit("nested-child", dir);
		};
		f.choice = async (options) => options[2];
		assert.equal(await f.guard.beforeSwitch("new", f.ctx), undefined);
		assert.equal(requests, 1);
		assert.equal(waits, 2, "nested terminal status alone does not prove runner exit");
	});

	for (const outcome of ["exited", "unverified", "write-error"] as const) it(`handles nested stop races (${outcome})`, async () => {
		const f = fixture();
		const rootId = path.basename(path.dirname(f.source));
		const route = createNestedRoute(rootId);
		const nestedRoot = nestedRunScope(rootId).asyncDirRoot;
		cleanups.push(() => {
			fs.rmSync(path.dirname(route.eventSink), { recursive: true, force: true });
			fs.rmSync(nestedRoot, { recursive: true, force: true });
		});
		const writeChild = (id: string, state: "running" | "complete" | "stopped") => {
			const dir = f.writeRun(id, state, "nested-owner", path.join(nestedRoot, id));
			f.state.asyncJobs.delete(id);
			return dir;
		};
		for (const [index, id] of ["finishing", "sibling"].entries()) {
			writeNestedEvent(route, {
				type: "subagent.nested.started", ts: 100 + index, parentRunId: rootId,
				child: { id, parentRunId: rootId, depth: 1, path: [{ runId: rootId }], state: "running", asyncDir: writeChild(id, "running") },
			});
		}
		const finishing = path.join(nestedRoot, "finishing");
		const sibling = path.join(nestedRoot, "sibling");
		f.state.retainedForegroundNestedRoutes = new Map([[rootId, route]]);
		if (outcome === "write-error") fs.writeFileSync(path.join(finishing, "control"), "blocks stop writes");
		else closeStopInbox(finishing);
		let waits = 0;
		let requests = 0;
		f.onSleep = () => {
			if (++waits === 1) writeChild("finishing", "complete");
			const stops = consumeStopRequestPayloads(sibling);
			requests += stops.length;
			if (stops.length) { writeChild("sibling", "stopped"); f.observeExit("sibling", sibling); }
			if (waits === 2 && outcome === "exited") f.observeExit("finishing", finishing);
		};
		f.choice = async (options) => options[2];
		assert.deepEqual(await f.guard.beforeSwitch("new", f.ctx), outcome === "exited" ? undefined : { cancel: true });
		assert.equal(requests, outcome === "write-error" ? 0 : 1, "a closing inbox must not prevent sibling stop requests");
		if (outcome === "exited") assert.equal(waits, 2);
		else assert.match(f.notices.at(-1)!, outcome === "unverified" ? /Could not verify/ : /ENOTDIR|EEXIST/);
	});

	it("does not transfer a completion Pi has already queued for the old session", async () => {
		const f = fixture();
		f.pendingWake = true;
		f.choice = async (options) => options[1];
		assert.deepEqual(await f.guard.beforeSwitch("new", f.ctx), { cancel: true });
		assert.match(f.notices.at(-1)!, /completion wake is still queued/);
	});

	it("fails closed without an interactive UI", async () => {
		const f = fixture();
		f.writeRun("live");
		Object.assign(f.ctx, { hasUI: false, mode: "print" });
		assert.deepEqual(await f.guard.beforeSwitch("new", f.ctx), { cancel: true });
		assert.equal(f.prompts, 0);
		assert.deepEqual(blockerEvents(f), []);
	});

	it("uses a bounded RPC dialog without claiming a Herdr terminal blocker", async () => {
		const f = fixture();
		f.pendingResults = true;
		Object.assign(f.ctx, { mode: "rpc" });
		f.choice = async (_options, opts) => { assert.equal(opts.timeout, 60_000); return undefined; };
		assert.deepEqual(await f.guard.beforeSwitch("resume", f.ctx, f.target), { cancel: true });
		assert.deepEqual(blockerEvents(f), []);
	});

	it("cancels on dialog failure even when the warning UI also throws", async () => {
		const f = fixture();
		f.pendingResults = true;
		f.choice = async () => { throw new Error("dialog failed"); };
		f.ctx.ui.notify = () => { throw new Error("stale context"); };
		assert.deepEqual(await f.guard.beforeSwitch("new", f.ctx), { cancel: true });
		assert.equal(blockerEvents(f).length, 2);
	});

	it("aborts an open prompt on shutdown and releases only its own blocker once", async () => {
		const f = fixture();
		f.pendingResults = true;
		f.choice = async (_options, opts) => new Promise((resolve) => opts.signal!.addEventListener("abort", () => resolve(undefined), { once: true }));
		const pending = f.guard.beforeSwitch("new", f.ctx);
		assert.deepEqual(await f.guard.beforeSwitch("fork", f.ctx), { cancel: true }, "a concurrent attempt cannot overwrite the decision");
		f.guard.dispose();
		assert.deepEqual(await pending, { cancel: true });
		f.guard.dispose();
		assert.equal(blockerEvents(f).length, 2);
	});
});
