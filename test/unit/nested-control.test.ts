import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import registerFanoutChildSubagentExtension from "../../src/extension/fanout-child.ts";
import { createSubagentExecutor, readNestedRecoveryDescriptor } from "../../src/runs/foreground/subagent-executor.ts";
import { createNestedRoute, findNestedControlResult, projectNestedEvents, readNestedControlRequests, readNestedControlResults, snapshotNestedEventFiles, writeNestedControlRequest, writeNestedControlResult, writeNestedEvent } from "../../src/runs/shared/nested-events.ts";
import {
	SUBAGENT_CHILD_ENV,
	SUBAGENT_FANOUT_CHILD_ENV,
	SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV,
	SUBAGENT_PARENT_CHILD_INDEX_ENV,
	SUBAGENT_PARENT_CONTROL_INBOX_ENV,
	SUBAGENT_PARENT_EVENT_SINK_ENV,
	SUBAGENT_PARENT_ROOT_RUN_ID_ENV,
	SUBAGENT_PARENT_RUN_ID_ENV,
} from "../../src/runs/shared/pi-args.ts";
import { ASYNC_DIR, type SubagentState } from "../../src/shared/types.ts";
import { createRunFanoutBudget } from "../../src/runs/shared/run-fanout-budget.ts";

const routeRoots: string[] = [];
const fanoutListenerCleanupKey = "__piSubagentFanoutChildNestedControlInboxCleanups";
const savedEnv = {
	[SUBAGENT_CHILD_ENV]: process.env[SUBAGENT_CHILD_ENV],
	[SUBAGENT_FANOUT_CHILD_ENV]: process.env[SUBAGENT_FANOUT_CHILD_ENV],
	[SUBAGENT_PARENT_EVENT_SINK_ENV]: process.env[SUBAGENT_PARENT_EVENT_SINK_ENV],
	[SUBAGENT_PARENT_CONTROL_INBOX_ENV]: process.env[SUBAGENT_PARENT_CONTROL_INBOX_ENV],
	[SUBAGENT_PARENT_ROOT_RUN_ID_ENV]: process.env[SUBAGENT_PARENT_ROOT_RUN_ID_ENV],
	[SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV]: process.env[SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV],
	[SUBAGENT_PARENT_RUN_ID_ENV]: process.env[SUBAGENT_PARENT_RUN_ID_ENV],
	[SUBAGENT_PARENT_CHILD_INDEX_ENV]: process.env[SUBAGENT_PARENT_CHILD_INDEX_ENV],
};

afterEach(() => {
	const globalStore = globalThis as Record<string, unknown>;
	const listenerCleanups = globalStore[fanoutListenerCleanupKey];
	if (listenerCleanups instanceof Map) {
		for (const entry of listenerCleanups.values()) {
			if (typeof entry === "function") entry();
			else if (entry && typeof entry === "object" && typeof (entry as { cleanup?: unknown }).cleanup === "function") (entry as { cleanup: () => void }).cleanup();
		}
	}
	delete globalStore[fanoutListenerCleanupKey];
	for (const root of routeRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
	for (const [key, value] of Object.entries(savedEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

function createState(): SubagentState {
	return {
		baseCwd: "",
		currentSessionId: null,
		asyncJobs: new Map(),
		foregroundRuns: new Map(),
		foregroundControls: new Map(),
		lastForegroundControlId: null,
		pendingForegroundControlNotices: new Map(),
		cleanupTimers: new Map(),
		lastUiContext: null,
		poller: null,
		completionSeen: new Map(),
		watcher: null,
		watcherRestartTimer: null,
		resultFileCoalescer: { schedule: () => false, clear: () => {} },
	};
}

function createExecutor(state = createState(), agents: Array<Record<string, unknown>> = [], allowMutatingManagementActions = true, events: any = { emit() {}, on() { return () => {}; } }) {
	return createSubagentExecutor({
		pi: { events, getSessionName() { return "parent"; } } as any,
		state,
		config: { maxSubagentDepth: 2, control: {}, intercomBridge: {} } as any,
		asyncByDefault: false,
		tempArtifactsDir: os.tmpdir(),
		getSubagentSessionRoot: (parentSessionFile) => parentSessionFile ? path.join(path.dirname(parentSessionFile), path.basename(parentSessionFile, ".jsonl")) : os.tmpdir(),
		expandTilde: (value) => value,
		discoverAgents: () => ({ agents: agents as any }),
		allowMutatingManagementActions,
	});
}

function ctx(root: string, sessionFile: string | null = null) {
	return {
		cwd: root,
		hasUI: false,
		sessionManager: { getSessionId() { return "session"; }, getSessionFile() { return sessionFile; } },
		modelRegistry: { getAvailable() { return []; } },
	} as any;
}

function createNestedRun(id = "nested-live", state: "running" | "complete" | "failed" | "paused" = "running", extras: Record<string, unknown> = {}) {
	const route = createNestedRoute("root-control");
	routeRoots.push(path.dirname(route.eventSink));
	writeNestedEvent(route, {
		type: state === "running" ? "subagent.nested.updated" : "subagent.nested.completed",
		ts: 100,
		parentRunId: "root-control",
		parentStepIndex: 0,
		child: { id, parentRunId: "root-control", parentStepIndex: 0, depth: 1, path: [{ runId: "root-control", stepIndex: 0 }], state, agent: "worker", ownerState: state === "running" ? "live" : "gone", ...extras },
	});
	return route;
}

function stateWithNestedRoute(route: ReturnType<typeof createNestedRoute>): SubagentState {
	const state = createState();
	state.foregroundControls.set(route.rootRunId, {
		runId: route.rootRunId,
		mode: "single",
		startedAt: 1,
		updatedAt: 1,
		nestedRoute: route,
	});
	state.lastForegroundControlId = route.rootRunId;
	return state;
}

function setNestedRouteEnv(route: ReturnType<typeof createNestedRoute>, parentRunId = route.rootRunId) {
	process.env[SUBAGENT_PARENT_EVENT_SINK_ENV] = route.eventSink;
	process.env[SUBAGENT_PARENT_CONTROL_INBOX_ENV] = route.controlInbox;
	process.env[SUBAGENT_PARENT_ROOT_RUN_ID_ENV] = route.rootRunId;
	process.env[SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV] = route.capabilityToken;
	process.env[SUBAGENT_PARENT_RUN_ID_ENV] = parentRunId;
	process.env[SUBAGENT_PARENT_CHILD_INDEX_ENV] = "0";
}

function text(result: Awaited<ReturnType<ReturnType<typeof createExecutor>["execute"]>>): string {
	return result.content[0]?.type === "text" ? result.content[0].text : "";
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	assert.equal(predicate(), true);
}

describe("nested control routing", () => {
	it("finds a control result without considering files present before its request", () => {
		const route = createNestedRoute("root-targeted-result");
		routeRoots.push(path.dirname(route.eventSink));
		const requestedAt = Date.now();
		writeNestedControlResult(route, { ts: requestedAt, requestId: "older", targetRunId: "child", ok: true, message: "older result" });
		writeNestedEvent(route, {
			type: "subagent.nested.updated",
			ts: requestedAt + 1,
			parentRunId: route.rootRunId,
			child: { id: "child", parentRunId: route.rootRunId, depth: 1, path: [], state: "running" },
		});
		const ignoredFiles = snapshotNestedEventFiles(route);
		writeNestedControlResult(route, { ts: requestedAt - 1, requestId: "target", targetRunId: "child", ok: true, message: "target result" });

		assert.equal(findNestedControlResult(route, "target", "child", ignoredFiles)?.message, "target result");
		assert.equal(findNestedControlResult(route, "older", "child", ignoredFiles), undefined);
		assert.equal(readNestedControlResults(route).length, 2);
	});

	it("routes interrupt to an explicit nested id through the control inbox", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-nested-control-"));
		try {
			const route = createNestedRun();
			const executor = createExecutor(stateWithNestedRoute(route));
			setTimeout(() => {
				const request = readNestedControlRequests(route)[0];
				assert.ok(request, "expected a nested control request");
				writeNestedControlResult(route, { ts: Date.now(), requestId: request.requestId, targetRunId: request.targetRunId, ok: true, message: "nested interrupt accepted" });
			}, 50);

			const result = await executor.execute("interrupt", { action: "interrupt", id: "nested-live" }, new AbortController().signal, undefined, ctx(root));
			assert.equal(result.isError, undefined);
			assert.match(text(result), /nested interrupt accepted/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("renders nested children in foreground status output", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-nested-foreground-status-"));
		try {
			const route = createNestedRun("nested-foreground");
			const state = createState();
			state.foregroundControls.set("root-control", {
				runId: "root-control",
				mode: "single",
				startedAt: 1,
				updatedAt: 1,
				currentAgent: "orchestrator",
				currentIndex: 0,
				nestedRoute: route,
			});
			state.lastForegroundControlId = "root-control";

			const result = await createExecutor(state).execute("status", { action: "status", id: "root-control" }, new AbortController().signal, undefined, ctx(root));

			assert.equal(result.isError, undefined);
			assert.match(text(result), /^Status target: run root-control\nSpawn budget:/);
			assert.match(text(result), /Run: root-control/);
			assert.match(text(result), /↳ worker \[nested-foreground\] running/);
			assert.match(text(result), /Status: subagent\(\{ action: "status", id: "nested-foreground" \}\)/);

			const transcript = await createExecutor(state).execute("transcript", { action: "status", id: "root-control", index: 0, view: "transcript" }, new AbortController().signal, undefined, ctx(root));
			assert.equal(transcript.isError, undefined);
			assert.match(text(transcript), /^Transcript target: run root-control · child 0\nSpawn budget:/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("labels dir-target status output", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-status-dir-label-"));
		const runId = `status-dir-${Date.now().toString(36)}`;
		const asyncDir = path.join(ASYNC_DIR, runId);
		try {
			fs.mkdirSync(asyncDir, { recursive: true });
			fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
				runId,
				mode: "single",
				state: "running",
				startedAt: 1,
				lastUpdate: 1,
				cwd: root,
				steps: [{ agent: "worker", status: "running" }],
			}), "utf-8");

			const state = createState();
			state.foregroundControls.set("foreground-live", { runId: "foreground-live", mode: "single", startedAt: 1, updatedAt: 1, currentAgent: "worker", currentIndex: 0 });
			state.lastForegroundControlId = "foreground-live";
			const executor = createExecutor(state);
			const result = await executor.execute("status-dir", { action: "status", dir: asyncDir }, new AbortController().signal, undefined, ctx(root));

			assert.equal(result.isError, undefined);
			assert.ok(text(result).startsWith(`Status target: dir ${asyncDir}\nSpawn budget:`), text(result));
			assert.match(text(result), new RegExp(`Run: ${runId}`));
			assert.doesNotMatch(text(result), /foreground-live/);

			const transcript = await executor.execute("transcript-dir", { action: "status", dir: asyncDir, view: "transcript" }, new AbortController().signal, undefined, ctx(root));
			assert.ok(text(transcript).startsWith(`Transcript target: dir ${asyncDir}\nSpawn budget:`), text(transcript));
			assert.doesNotMatch(text(transcript), /Live foreground transcript/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
			fs.rmSync(asyncDir, { recursive: true, force: true });
		}
	});

	it("scopes child-safe nested status lookup to the inherited route and child address", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-nested-child-scope-"));
		try {
			const allowedRoute = createNestedRun("shared-nested");
			setNestedRouteEnv(allowedRoute, "root-control");
			const outsideRoute = createNestedRoute("root-outside");
			routeRoots.push(path.dirname(outsideRoute.eventSink));
			writeNestedEvent(outsideRoute, {
				type: "subagent.nested.updated",
				ts: 100,
				parentRunId: "root-outside",
				parentStepIndex: 0,
				child: { id: "shared-nested", parentRunId: "root-outside", parentStepIndex: 0, depth: 1, path: [{ runId: "root-outside", stepIndex: 0 }], state: "running", agent: "outside" },
			});

			const result = await createExecutor(createState(), [], false).execute("status", { action: "status", id: "shared-nested" }, new AbortController().signal, undefined, ctx(root));

			assert.equal(result.isError, undefined);
			assert.match(text(result), /Nested run: shared-nested/);
			assert.match(text(result), /Root: root-control/);
			assert.doesNotMatch(text(result), /root-outside/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("requires an id for child-safe status instead of listing unrelated top-level async runs", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-nested-child-safe-status-"));
		const runId = `child-safe-unrelated-${Date.now().toString(36)}`;
		const asyncDir = path.join(ASYNC_DIR, runId);
		try {
			fs.mkdirSync(asyncDir, { recursive: true });
			fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
				runId,
				mode: "single",
				state: "running",
				pid: 12345,
				startedAt: 100,
				lastUpdate: 100,
				steps: [{ agent: "outside", status: "running", startedAt: 100 }],
			}, null, 2), "utf-8");

			const result = await createExecutor(createState(), [], false).execute("status", { action: "status" }, new AbortController().signal, undefined, ctx(root));

			assert.equal(result.isError, true);
			assert.match(text(result), /requires an id/);
			assert.doesNotMatch(text(result), new RegExp(runId));
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
			fs.rmSync(asyncDir, { recursive: true, force: true });
		}
	});

	it("does not let bare interrupt target hidden nested descendants", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-nested-bare-interrupt-"));
		try {
			createNestedRun("nested-only");
			const result = await createExecutor().execute("interrupt", { action: "interrupt" }, new AbortController().signal, undefined, ctx(root));
			assert.equal(result.isError, true);
			assert.match(text(result), /No interrupt-capable run found/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("times out owner-gone nested control and ignores late results", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-nested-timeout-"));
		try {
			const route = createNestedRun("nested-timeout");
			const executor = createExecutor(stateWithNestedRoute(route));
			const lateResponder = (async () => {
				const deadline = Date.now() + 2_000;
				let request = readNestedControlRequests(route)[0];
				while (!request && Date.now() < deadline) {
					await new Promise((resolve) => setTimeout(resolve, 10));
					request = readNestedControlRequests(route)[0];
				}
				assert.ok(request, "expected a nested control request");
				await new Promise((resolve) => setTimeout(resolve, 1_200));
				writeNestedControlResult(route, { ts: Date.now(), requestId: request.requestId, targetRunId: request.targetRunId, ok: true, message: "late success" });
			})();
			const result = await executor.execute("interrupt", { action: "interrupt", id: "nested-timeout" }, new AbortController().signal, undefined, ctx(root));
			await lateResponder;
			assert.equal(result.isError, true);
			assert.match(text(result), /owner is not reachable/);
			assert.doesNotMatch(text(result), /late success/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("routes resume for live nested runs through the control inbox", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-nested-live-resume-"));
		try {
			const emitted: Array<{ name: string; payload: unknown }> = [];
			const events = { emit(name: string, payload: unknown) { emitted.push({ name, payload }); }, on() { return () => {}; } };
			const route = createNestedRun("nested-live-resume", "running", { intercomTarget: "attacker-target", leafIntercomTarget: "attacker-leaf" });
			const executor = createExecutor(stateWithNestedRoute(route), [], true, events);
			setTimeout(() => {
				const request = readNestedControlRequests(route)[0];
				assert.ok(request, "expected a nested resume request");
				assert.equal(request.action, "resume");
				assert.equal(request.message, "continue please");
				writeNestedControlResult(route, { ts: Date.now(), requestId: request.requestId, targetRunId: request.targetRunId, ok: true, message: "nested resume accepted" });
			}, 50);

			const result = await executor.execute("resume", { action: "resume", id: "nested-live-resume", message: "continue please" }, new AbortController().signal, undefined, ctx(root));

			assert.equal(result.isError, undefined);
			assert.match(text(result), /nested resume accepted/);
			assert.equal(emitted.some((event) => {
				const payload = event.payload as { to?: unknown };
				return payload.to === "attacker-target" || payload.to === "attacker-leaf";
			}), false);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("validates terminal nested resume session files before revive", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-nested-terminal-resume-"));
		try {
			const route = createNestedRun("nested-terminal-resume", "complete", { sessionFile: path.join(root, "missing-session.jsonl") });

			const result = await createExecutor(stateWithNestedRoute(route), [{ name: "worker", description: "Worker", prompt: "Do work" }])
				.execute("resume", { action: "resume", id: "nested-terminal-resume", message: "continue" }, new AbortController().signal, undefined, ctx(root));

			assert.equal(result.isError, true);
			assert.match(text(result), /session file does not exist/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("restores the original extension bindings for terminal nested revival", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-nested-binding-recovery-"));
		try {
			const descriptor = {
				version: 1,
				runFanoutBudget: createRunFanoutBudget("nested-bound", 64),
				sourceRunId: "nested-bound",
				agent: "worker",
				cwd: root,
				systemPromptMode: "replace",
				inheritGlobalContext: false,
				inheritProjectContext: false,
				inheritSkills: false,
				outputMode: "inline",
				maxSubagentDepth: 2,
				share: false,
				extensionBindings: { "shepherd.dispatch/1": { role: "coder" } },
			};
			fs.writeFileSync(path.join(root, "recovery-descriptor.json"), JSON.stringify(descriptor));
			assert.deepEqual(readNestedRecoveryDescriptor(root, "nested-bound", "worker")?.extensionBindings, descriptor.extensionBindings);
			assert.throws(() => readNestedRecoveryDescriptor(root, "other-run", "worker"), /different source run/);
			assert.throws(() => readNestedRecoveryDescriptor(root, "nested-bound", "reviewer"), /different agent/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects stopped nested runs before attempting revival", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-nested-stopped-resume-"));
		try {
			const route = createNestedRun("nested-stopped-resume", "stopped", { sessionFile: path.join(root, "missing-session.jsonl") });

			const result = await createExecutor(stateWithNestedRoute(route), [{ name: "worker", description: "Worker", prompt: "Do work" }])
				.execute("resume", { action: "resume", id: "nested-stopped-resume", message: "continue" }, new AbortController().signal, undefined, ctx(root));

			assert.equal(result.isError, true);
			assert.match(text(result), /was stopped and cannot be resumed/);
			assert.doesNotMatch(text(result), /session file/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects terminal nested resume session files outside trusted roots", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-nested-terminal-untrusted-"));
		try {
			const parentSessionFile = path.join(root, "parent.jsonl");
			const attackerSessionFile = path.join(root, "outside", "session.jsonl");
			fs.mkdirSync(path.dirname(attackerSessionFile), { recursive: true });
			fs.writeFileSync(parentSessionFile, "");
			fs.writeFileSync(attackerSessionFile, "");
			const route = createNestedRun("nested-untrusted-resume", "complete", { sessionFile: attackerSessionFile });

			const result = await createExecutor(stateWithNestedRoute(route), [{ name: "worker", description: "Worker", prompt: "Do work" }])
				.execute("resume", { action: "resume", id: "nested-untrusted-resume", message: "continue" }, new AbortController().signal, undefined, ctx(root, parentSessionFile));

			assert.equal(result.isError, true);
			assert.match(text(result), /outside trusted nested session roots/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects terminal nested resume session files from sibling run directories", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-nested-terminal-sibling-"));
		try {
			const parentSessionFile = path.join(root, "parent.jsonl");
			const siblingSessionFile = path.join(root, "parent", "other-run", "run-0", "session.jsonl");
			fs.mkdirSync(path.dirname(siblingSessionFile), { recursive: true });
			fs.writeFileSync(parentSessionFile, "");
			fs.writeFileSync(siblingSessionFile, "");
			const route = createNestedRun("nested-sibling-resume", "complete", { sessionFile: siblingSessionFile });

			const result = await createExecutor(stateWithNestedRoute(route), [{ name: "worker", description: "Worker", prompt: "Do work" }])
				.execute("resume", { action: "resume", id: "nested-sibling-resume", message: "continue" }, new AbortController().signal, undefined, ctx(root, parentSessionFile));

			assert.equal(result.isError, true);
			assert.match(text(result), /not under that nested run's session directory/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("emits a failed completed nested event when foreground execution throws after start", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-nested-foreground-throw-"));
		try {
			const route = createNestedRoute("root-parent");
			routeRoots.push(path.dirname(route.eventSink));
			setNestedRouteEnv(route, "root-parent");
			const throwingCtx = {
				...ctx(root),
				modelRegistry: { getAvailable() { throw new Error("model registry exploded"); } },
			};

			const result = await createExecutor(createState(), [{ name: "worker", description: "Worker", prompt: "Do work" }])
				.execute("run", { agent: "worker", task: "go" }, new AbortController().signal, undefined, throwingCtx);

			assert.equal(result.isError, true);
			assert.match(text(result), /model registry exploded/);
			const registry = projectNestedEvents(route);
			assert.equal(registry.children.length, 1);
			assert.equal(registry.children[0]?.state, "failed");
			assert.match(registry.children[0]?.error ?? "", /model registry exploded/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("keeps the fanout child control listener alive after control inbox polling errors", async () => {
		const route = createNestedRoute("root-poll-error");
		routeRoots.push(path.dirname(route.eventSink));
		setNestedRouteEnv(route, "root-poll-error");
		process.env[SUBAGENT_CHILD_ENV] = "1";
		process.env[SUBAGENT_FANOUT_CHILD_ENV] = "1";
		const pi = {
			events: { emit() {}, on() { return () => {}; } },
			registerTool() {},
			getSessionName() { return "child"; },
		} as any;
		fs.rmSync(route.controlInbox, { recursive: true, force: true });
		fs.writeFileSync(route.controlInbox, "not a directory", "utf-8");
		const originalError = console.error;
		const logged: unknown[][] = [];
		console.error = (...args: unknown[]) => {
			logged.push(args);
		};
		try {
			registerFanoutChildSubagentExtension(pi);
			await waitFor(() => logged.some((entry) => String(entry[0] ?? "").includes(route.controlInbox) && String(entry[0] ?? "").includes("root-poll-error")));

			fs.rmSync(route.controlInbox, { force: true });
			fs.mkdirSync(route.controlInbox, { recursive: true });
			const requestPath = writeNestedControlRequest(route, {
				ts: Date.now(),
				requestId: "poll-error-recovers",
				targetRunId: "missing-run",
				action: "interrupt",
			});

			await waitFor(() => readNestedControlResults(route).some((result) => result.requestId === "poll-error-recovers" && result.ok === false));
			assert.equal(fs.existsSync(requestPath), false);
		} finally {
			console.error = originalError;
		}
	});

	it("keeps fanout child control requests when result writing fails and retries after recovery", async () => {
		const route = createNestedRoute("root-result-write-fails");
		routeRoots.push(path.dirname(route.eventSink));
		setNestedRouteEnv(route, "root-result-write-fails");
		process.env[SUBAGENT_CHILD_ENV] = "1";
		process.env[SUBAGENT_FANOUT_CHILD_ENV] = "1";
		const pi = {
			events: { emit() {}, on() { return () => {}; } },
			registerTool() {},
			getSessionName() { return "child"; },
		} as any;
		fs.rmSync(route.eventSink, { recursive: true, force: true });
		fs.writeFileSync(route.eventSink, "not a directory", "utf-8");
		const requestPath = writeNestedControlRequest(route, {
			ts: Date.now(),
			requestId: "result-write-fails",
			targetRunId: "missing-run",
			action: "interrupt",
		});
		const originalError = console.error;
		const logged: unknown[][] = [];
		console.error = (...args: unknown[]) => {
			logged.push(args);
		};
		try {
			registerFanoutChildSubagentExtension(pi);
			await waitFor(() => logged.some((entry) => String(entry[0] ?? "").includes("result-write-fails") && /keeping request for retry/.test(String(entry[0] ?? ""))));
			assert.equal(fs.existsSync(requestPath), true);

			fs.rmSync(route.eventSink, { force: true });
			fs.mkdirSync(route.eventSink, { recursive: true });
			await waitFor(() => readNestedControlResults(route).some((result) => result.requestId === "result-write-fails" && result.ok === false));
			assert.equal(fs.existsSync(requestPath), false);
		} finally {
			console.error = originalError;
		}
	});

	it("cleans the prior listener on reload and processes a resume request once", async () => {
		const route = createNestedRoute("root-reload-listener");
		routeRoots.push(path.dirname(route.eventSink));
		setNestedRouteEnv(route, "root-reload-listener");
		process.env[SUBAGENT_CHILD_ENV] = "1";
		process.env[SUBAGENT_FANOUT_CHILD_ENV] = "1";
		const registrations: string[] = [];
		const activeIntervals = new Set<ReturnType<typeof setInterval>>();
		const originalSetInterval = globalThis.setInterval;
		const originalClearInterval = globalThis.clearInterval;
		globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
			const interval = originalSetInterval(...args);
			activeIntervals.add(interval);
			return interval;
		}) as typeof setInterval;
		globalThis.clearInterval = ((interval: ReturnType<typeof setInterval>) => {
			activeIntervals.delete(interval);
			return originalClearInterval(interval);
		}) as typeof clearInterval;
		try {
			const makePi = () => ({
				events: { emit() {}, on() { return () => {}; } },
				registerTool() { registrations.push("subagent"); },
				getSessionName() { return "child"; },
			}) as any;
			const firstPi = makePi();

			registerFanoutChildSubagentExtension(firstPi);
			registerFanoutChildSubagentExtension(firstPi);
			registerFanoutChildSubagentExtension(makePi());
			assert.equal(activeIntervals.size, 1);

			const unrelatedRoute = createNestedRoute("root-unrelated-listener");
			routeRoots.push(path.dirname(unrelatedRoute.eventSink));
			setNestedRouteEnv(unrelatedRoute, "root-unrelated-listener");
			registerFanoutChildSubagentExtension(makePi());
			assert.equal(activeIntervals.size, 2);

			delete process.env[SUBAGENT_PARENT_EVENT_SINK_ENV];
			delete process.env[SUBAGENT_PARENT_CONTROL_INBOX_ENV];
			delete process.env[SUBAGENT_PARENT_ROOT_RUN_ID_ENV];
			delete process.env[SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV];
			registerFanoutChildSubagentExtension(makePi());
			assert.equal(activeIntervals.size, 2);

			setNestedRouteEnv(route, "root-reload-listener");
			writeNestedControlRequest(route, {
				ts: Date.now(),
				requestId: "reload-resume-once",
				targetRunId: "missing-run",
				action: "resume",
				message: "continue",
			});

			await waitFor(() => readNestedControlResults(route).length === 1);
			assert.equal(registrations.length, 4);
			assert.equal(readNestedControlResults(route)[0]?.requestId, "reload-resume-once");
		} finally {
			globalThis.setInterval = originalSetInterval;
			globalThis.clearInterval = originalClearInterval;
		}
	});

	it("negatively acknowledges ownerless fanout child control requests and removes them", async () => {
		const route = createNestedRoute("root-ownerless");
		routeRoots.push(path.dirname(route.eventSink));
		setNestedRouteEnv(route, "root-ownerless");
		process.env[SUBAGENT_CHILD_ENV] = "1";
		process.env[SUBAGENT_FANOUT_CHILD_ENV] = "1";
		const pi = {
			events: { emit() {}, on() { return () => {}; } },
			registerTool() {},
			getSessionName() { return "child"; },
		} as any;
		const requestPath = writeNestedControlRequest(route, {
			ts: Date.now(),
			requestId: "ownerless-request",
			targetRunId: "missing-run",
			action: "interrupt",
		});

		registerFanoutChildSubagentExtension(pi);
		await waitFor(() => readNestedControlResults(route).some((result) => result.requestId === "ownerless-request" && result.ok === false));

		assert.equal(fs.existsSync(requestPath), false);
		const result = readNestedControlResults(route).find((item) => item.requestId === "ownerless-request");
		assert.match(result?.message ?? "", /not active/);
	});
});
