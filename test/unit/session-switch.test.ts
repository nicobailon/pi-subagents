import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import type { ExtensionUIDialogOptions } from "@earendil-works/pi-coding-agent";
import { createSessionSwitchGuard, type SessionSwitchContext } from "../../src/extension/session-switch.ts";
import { updateActiveRunIndex } from "../../src/runs/background/active-run-index.ts";
import { createNestedRoute, nestedRunScope, writeNestedEvent } from "../../src/runs/shared/nested-events.ts";
import { inheritedSessionIds, recordSessionReplacement, recordSessionStart } from "../../src/shared/session-succession.ts";
import type { AsyncJobState, SubagentState } from "../../src/shared/types.ts";

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
	const notices: string[] = [];
	let choice: (options: string[], opts: ExtensionUIDialogOptions) => Promise<string | undefined> = async (options) => options[0];
	let title = "";
	let prompts = 0;
	let pendingResults = false;
	let questions = false;
	const ctx: SessionSwitchContext = {
		mode: "tui", hasUI: true,
		ui: {
			select: async (text, options, opts = {}) => {
				title = text; prompts++; return choice(options, opts);
			},
			notify: (message: string) => notices.push(message),
		},
	};
	const guard = createSessionSwitchGuard({
		state, asyncDirRoot, resultsDir,
		hasPendingResults: () => pendingResults,
		hasPendingSupervisorRequest: () => questions,
	});
	cleanups.push(() => { guard.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
	const writeRun = (id: string, status: AsyncJobState["status"] = "running", sessionId = source, asyncDir = path.join(asyncDirRoot, id)) => {
		fs.mkdirSync(asyncDir, { recursive: true });
		fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
			runId: id, mode: "single", state: status, sessionId, pid: process.pid,
			startedAt: Date.now(), lastUpdate: Date.now(), steps: [{ agent: "worker", status }],
		}));
		updateActiveRunIndex(asyncDir, status);
		state.asyncJobs.set(id, { asyncId: id, asyncDir, sessionId, status });
		return asyncDir;
	};
	// What the destination inherits once Pi starts it in place of the source.
	const switchTo = (reason: "new" | "resume" | "fork" | "quit" = "new") => {
		guard.sessionShutdown({ type: "session_shutdown", reason, targetSessionFile: target });
		recordSessionReplacement(target, source);
		return inheritedSessionIds(target);
	};
	return {
		guard, ctx, state, source, target, notices, writeRun, switchTo,
		get prompts() { return prompts; }, get title() { return title; },
		set choice(value: typeof choice) { choice = value; },
		set pendingResults(value: boolean) { pendingResults = value; },
		set questions(value: boolean) { questions = value; },
	};
}

describe("session switch decisions", () => {
	it("hands work over without a prompt when nothing of this session is outstanding", async () => {
		const f = fixture();
		f.writeRun("finished", "complete");
		f.writeRun("foreign", "running", `${f.source}-foreign`);
		assert.equal(await f.guard.beforeSwitch("new", f.ctx), undefined);
		assert.equal(f.prompts, 0);
		assert.deepEqual(f.switchTo(), [f.source]);
	});

	it("hands work over without a prompt when there is no UI", async () => {
		const f = fixture();
		f.writeRun("live");
		Object.assign(f.ctx, { hasUI: false, mode: "print" });
		assert.equal(await f.guard.beforeSwitch("new", f.ctx), undefined);
		assert.equal(f.prompts, 0);
		assert.deepEqual(f.switchTo(), [f.source]);
	});

	it("stays by default", async () => {
		const f = fixture();
		f.writeRun("queued", "queued");
		assert.deepEqual(await f.guard.beforeSwitch("new", f.ctx), { cancel: true });
		assert.match(f.title, /^ {2}1 run queued or running$/m);
	});

	it("asks instead of refusing when a tracked run's status cannot be read", async () => {
		const f = fixture();
		const dir = f.writeRun("corrupt");
		fs.writeFileSync(path.join(dir, "status.json"), "{\"runId\":");
		f.choice = async (options) => options[1];
		assert.equal(await f.guard.beforeSwitch("new", f.ctx), undefined);
		assert.equal(f.prompts, 1);
	});

	it("takes the work to the new session", async () => {
		const f = fixture();
		f.writeRun("live");
		f.choice = async (options) => options[1];
		assert.equal(await f.guard.beforeSwitch("resume", f.ctx), undefined);
		assert.deepEqual(f.switchTo("resume"), [f.source]);
	});

	it("leaves the work with the original session until it is opened again", async () => {
		const f = fixture();
		f.writeRun("live");
		f.choice = async (options) => options[2];
		assert.equal(await f.guard.beforeSwitch("fork", f.ctx), undefined);
		assert.deepEqual(f.switchTo("fork"), []);
		recordSessionStart(f.source, false);
		assert.deepEqual(f.switchTo("new"), [f.source], "reopening the original session ends the choice");
	});

	it("keeps what a session took over when it is resumed after leaving its work", async () => {
		const f = fixture();
		const earlier = `${f.source}-earlier`;
		recordSessionReplacement(f.source, earlier); // The source took the earlier session's work.
		f.writeRun("live");
		f.choice = async (options) => options[2];
		assert.equal(await f.guard.beforeSwitch("new", f.ctx), undefined);
		assert.deepEqual(f.switchTo("new"), []);
		// /resume back to the source from the new session, twice as an RPC rebind does.
		for (let start = 0; start < 2; start++) {
			recordSessionStart(f.source, false);
			recordSessionReplacement(f.source, f.target);
			assert.deepEqual(inheritedSessionIds(f.source), [f.target, earlier]);
		}
	});

	it("applies a leave choice only to the switch that committed", async () => {
		for (const mismatch of ["cancelled", "source", "reason"]) {
			const f = fixture();
			f.writeRun("live");
			f.choice = async (options) => options[2];
			await f.guard.beforeSwitch("resume", f.ctx);
			if (mismatch === "cancelled") {
				// A later extension cancelled the switch, so no shutdown followed; the next attempt hands work over.
				f.writeRun("live", "complete");
				assert.equal(await f.guard.beforeSwitch("new", f.ctx), undefined);
			}
			if (mismatch === "source") f.state.currentSessionId = "another-source";
			assert.deepEqual(f.switchTo(mismatch === "reason" ? "quit" : "new"), [f.source], mismatch);
		}
	});

	it("asks about undelivered results, supervisor questions and nested work", async () => {
		for (const kind of ["result", "question", "nested"]) {
			const f = fixture();
			f.pendingResults = kind === "result";
			f.questions = kind === "question";
			if (kind === "nested") {
				const rootId = path.basename(path.dirname(f.source));
				const route = createNestedRoute(rootId);
				const dir = path.join(nestedRunScope(rootId).asyncDirRoot, "nested-child");
				cleanups.push(() => {
					fs.rmSync(path.dirname(route.eventSink), { recursive: true, force: true });
					fs.rmSync(nestedRunScope(rootId).asyncDirRoot, { recursive: true, force: true });
				});
				f.writeRun("nested-child", "running", "nested-owner", dir);
				f.state.asyncJobs.delete("nested-child");
				writeNestedEvent(route, {
					type: "subagent.nested.started", ts: 100, parentRunId: rootId,
					child: { id: "nested-child", parentRunId: rootId, depth: 1, path: [{ runId: rootId }], state: "running", asyncDir: dir },
				});
				f.state.retainedForegroundNestedRoutes = new Map([[rootId, route]]);
			}
			assert.deepEqual(await f.guard.beforeSwitch("fork", f.ctx), { cancel: true }, kind);
			assert.match(f.title, { result: /^ {2}Undelivered results$/m, question: /^ {2}Questions awaiting a reply$/m, nested: /^ {2}Nested subagents still running$/m }[kind]!);
			assert.doesNotMatch(f.title, /queued or running/);
		}
	});

	it("bounds the RPC dialog and stays when the host does not answer", async () => {
		const f = fixture();
		f.pendingResults = true;
		Object.assign(f.ctx, { mode: "rpc" });
		f.choice = async (_options, opts) => { assert.equal(opts.timeout, 60_000); return undefined; };
		assert.deepEqual(await f.guard.beforeSwitch("resume", f.ctx), { cancel: true });
	});

	it("cancels on dialog failure even when the warning UI also throws", async () => {
		const f = fixture();
		f.pendingResults = true;
		f.choice = async () => { throw new Error("dialog failed"); };
		f.ctx.ui.notify = () => { throw new Error("stale context"); };
		assert.deepEqual(await f.guard.beforeSwitch("new", f.ctx), { cancel: true });
	});

	it("cancels an open prompt on shutdown and refuses a concurrent attempt", async () => {
		const f = fixture();
		f.pendingResults = true;
		f.choice = async (_options, opts) => new Promise((resolve) => opts.signal!.addEventListener("abort", () => resolve(undefined), { once: true }));
		const pending = f.guard.beforeSwitch("new", f.ctx);
		assert.deepEqual(await f.guard.beforeSwitch("fork", f.ctx), { cancel: true });
		f.guard.dispose();
		assert.deepEqual(await pending, { cancel: true });
	});
});
