import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { ASYNC_DIR, INTERCOM_DETACH_REQUEST_EVENT, RESULTS_DIR, SUBAGENT_ASYNC_STARTED_EVENT, SUBAGENT_FOREGROUND_COMPLETE_EVENT } from "../../src/shared/types.ts";
import { waitForSubagents } from "../../src/runs/background/subagent-wait.ts";
import { sessionLeaseDir } from "../../src/runs/shared/session-lease.ts";
import type { MockPi } from "../support/helpers.ts";
import {
	createMockPi,
	createTempDir,
	events,
	makeAgent,
	makeMinimalCtx,
	removeTempDir,
	tryImport,
} from "../support/helpers.ts";

interface ExecutorResult {
	content: Array<{ text?: string }>;
	isError?: boolean;
	details?: {
		mode?: string;
		runId?: string;
		results?: Array<{ agent?: string; finalOutput?: string; sessionFile?: string; acceptance?: { status?: string }; artifactPaths?: { metadataPath?: string } }>;
		asyncId?: string;
	};
}

interface ExecutorModule {
	createSubagentExecutor?: (...args: unknown[]) => {
		execute: (
			id: string,
			params: Record<string, unknown>,
			signal: AbortSignal,
			onUpdate: ((result: unknown) => void) | undefined,
			ctx: unknown,
		) => Promise<ExecutorResult>;
	};
}

const executorMod = await tryImport<ExecutorModule>("./src/runs/foreground/subagent-executor.ts");
const available = !!executorMod?.createSubagentExecutor;
const createSubagentExecutor = executorMod?.createSubagentExecutor;

function createRecordingEventBus(options: { acknowledgeResults?: boolean } = {}) {
	const listeners = new Map<string, Set<(payload: unknown) => void>>();
	const emitted: Array<{ channel: string; payload: unknown }> = [];
	const bus = {
		emitted,
		on(channel: string, handler: (payload: unknown) => void) {
			const channelListeners = listeners.get(channel) ?? new Set();
			channelListeners.add(handler);
			listeners.set(channel, channelListeners);
			return () => {
				channelListeners.delete(handler);
				if (channelListeners.size === 0) listeners.delete(channel);
			};
		},
		emit(channel: string, payload: unknown) {
			emitted.push({ channel, payload });
			for (const handler of listeners.get(channel) ?? []) {
				handler(payload);
			}
			if (options.acknowledgeResults && channel === "subagent:result-intercom") {
				const requestId = payload && typeof payload === "object" ? (payload as { requestId?: unknown }).requestId : undefined;
				if (typeof requestId === "string") {
					setImmediate(() => bus.emit("subagent:result-intercom-delivery", { requestId, delivered: true }));
				}
			}
		},
	};
	return bus;
}

describe("intercom result delivery cutover", { skip: !available ? "executor not importable" : undefined }, () => {
	let tempDir: string;
	let homeDir: string;
	let mockPi: MockPi;
	let originalHome: string | undefined;
	let originalUserProfile: string | undefined;

	before(() => {
		originalHome = process.env.HOME;
		originalUserProfile = process.env.USERPROFILE;
		homeDir = createTempDir("pi-subagent-intercom-home-");
		process.env.HOME = homeDir;
		process.env.USERPROFILE = homeDir;
		mockPi = createMockPi();
		mockPi.install();
		fs.mkdirSync(path.join(os.homedir(), ".pi", "agent", "extensions", "pi-intercom"), { recursive: true });
		fs.mkdirSync(path.join(os.homedir(), ".pi", "agent", "intercom"), { recursive: true });
		fs.writeFileSync(path.join(os.homedir(), ".pi", "agent", "intercom", "config.json"), JSON.stringify({ enabled: true }), "utf-8");
	});

	after(() => {
		mockPi.uninstall();
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;
		if (originalUserProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = originalUserProfile;
		removeTempDir(homeDir);
	});

	beforeEach(() => {
		tempDir = createTempDir("pi-subagent-intercom-result-");
		mockPi.reset();
	});

	afterEach(() => {
		removeTempDir(tempDir);
	});

	async function readMockCallArgs(index: number): Promise<string[]> {
		const deadline = Date.now() + 10_000;
		let callFile: string | undefined;
		while (!callFile) {
			callFile = fs.readdirSync(mockPi.dir)
				.filter((name) => name.startsWith("call-") && name.endsWith(".json"))
				.sort()[index];
			if (callFile || Date.now() > deadline) break;
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		assert.ok(callFile, `expected mock pi call at index ${index}`);
		return JSON.parse(fs.readFileSync(path.join(mockPi.dir, callFile), "utf-8")).args as string[];
	}

	async function waitForFile(filePath: string, timeoutMs = 10_000): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		while (!fs.existsSync(filePath)) {
			if (Date.now() > deadline) assert.fail(`Timed out waiting for file: ${filePath}`);
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	}

	async function waitForMissingPath(filePath: string, timeoutMs = 10_000): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		while (fs.existsSync(filePath)) {
			if (Date.now() > deadline) assert.fail(`Timed out waiting for path cleanup: ${filePath}`);
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	}

	function makeExecutor(options: { bridgeMode?: "always" | "off"; agents?: ReturnType<typeof makeAgent>[]; acknowledgeResults?: boolean; kill?: (pid: number, signal?: NodeJS.Signals | 0) => boolean } = {}) {
		const events = createRecordingEventBus({ acknowledgeResults: options.acknowledgeResults ?? true });
		const state = {
			baseCwd: tempDir,
			currentSessionId: null,
			asyncJobs: new Map(),
			foregroundRuns: new Map(),
			foregroundControls: new Map(),
			lastForegroundControlId: null,
			cleanupTimers: new Map(),
			lastUiContext: null,
			poller: null,
			completionSeen: new Map(),
			watcher: null,
			watcherRestartTimer: null,
			resultFileCoalescer: {
				schedule: () => false,
				clear: () => {},
			},
		};
		const executor = createSubagentExecutor!({
			pi: {
				events,
				getSessionName: () => "orchestrator",
				setSessionName: () => {},
			},
			state,
			config: {
				intercomBridge: { mode: options.bridgeMode ?? "always" },
			},
			asyncByDefault: false,
			tempArtifactsDir: tempDir,
			getSubagentSessionRoot: () => tempDir,
			expandTilde: (value: string) => value,
			discoverAgents: () => ({ agents: options.agents ?? [makeAgent("worker")] }),
			kill: options.kill,
		});
		return { executor, events, state };
	}

	it("single foreground runs emit one grouped event and return a compact receipt", async () => {
		mockPi.onCall({ output: "Full child output from worker" });
		const { executor, events } = makeExecutor();

		const result = await executor.execute(
			"single-intercom",
			{ agent: "worker", task: "Implement feature" },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		const intercomEvents = events.emitted.filter((entry) => entry.channel === "subagent:result-intercom");
		assert.equal(intercomEvents.length, 1);
		const payload = intercomEvents[0]!.payload as { children?: Array<{ agent?: string; intercomTarget?: string }>; message?: string; mode?: string };
		assert.equal(payload.mode, "single");
		assert.equal(payload.children?.length, 1);
		assert.equal(payload.children?.[0]?.agent, "worker");
		assert.match(payload.children?.[0]?.intercomTarget ?? "", /^subagent-worker-[a-f0-9]+-1$/);
		assert.match(String(payload.message ?? ""), /Intercom targets below identify child sessions used while they were running/);
		assert.match(String(payload.message ?? ""), /Run intercom target: subagent-worker-[a-f0-9]+-1/);
		assert.match(result.content[0]?.text ?? "", /Delivered single subagent result via intercom\./);
		assert.doesNotMatch(result.content[0]?.text ?? "", /Full child output from worker/);
		assert.equal(result.details?.results?.[0]?.finalOutput, undefined);
		assert.match(String(payload.message ?? ""), /Full child output from worker/);
	});

	it("falls back to legacy foreground output when the bridge is inactive", async () => {
		mockPi.onCall({ output: "Legacy foreground output" });
		const { executor, events } = makeExecutor({ bridgeMode: "off" });

		const result = await executor.execute(
			"single-no-intercom",
			{ agent: "worker", task: "Summarize feature" },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(events.emitted.some((entry) => entry.channel === "subagent:result-intercom"), false);
		assert.match(result.content[0]?.text ?? "", /Legacy foreground output/);
	});

	it("falls back to legacy foreground output when grouped delivery is not acknowledged", async () => {
		mockPi.onCall({ output: "Unacknowledged foreground output" });
		const { executor, events } = makeExecutor({ acknowledgeResults: false });

		const result = await executor.execute(
			"single-no-ack",
			{ agent: "worker", task: "Summarize feature" },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(events.emitted.some((entry) => entry.channel === "subagent:result-intercom"), true);
		assert.match(result.content[0]?.text ?? "", /Unacknowledged foreground output/);
	});

	it("top-level parallel runs emit one grouped event containing all children", async () => {
		mockPi.onCall({ output: "Parallel child output" });
		const { executor, events } = makeExecutor({ agents: [makeAgent("a"), makeAgent("b")] });

		const result = await executor.execute(
			"parallel-intercom",
			{ tasks: [{ agent: "a", task: "task-a" }, { agent: "b", task: "task-b" }] },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		const intercomEvents = events.emitted.filter((entry) => entry.channel === "subagent:result-intercom");
		assert.equal(intercomEvents.length, 1);
		const payload = intercomEvents[0]!.payload as { children?: Array<{ agent?: string; intercomTarget?: string }>; message?: string; mode?: string };
		assert.equal(payload.mode, "parallel");
		assert.deepEqual((payload.children ?? []).map((child) => child.agent).sort(), ["a", "b"]);
		assert.equal((payload.children ?? []).every((child) => /^subagent-[ab]-[a-f0-9]+-[12]$/.test(child.intercomTarget ?? "")), true);
		assert.match(String(payload.message ?? ""), /Intercom targets below identify child sessions used while they were running/);
		assert.match(String(payload.message ?? ""), /Run intercom target: subagent-a-[a-f0-9]+-1/);
		assert.match(String(payload.message ?? ""), /1\. a — completed/);
		assert.match(String(payload.message ?? ""), /2\. b — completed/);
		assert.match(result.content[0]?.text ?? "", /Delivered parallel subagent results via intercom\./);
		assert.equal(result.details?.results?.every((entry) => entry.finalOutput === undefined), true);
	});

	it("chain runs emit one grouped event containing all executed children", async () => {
		mockPi.onCall({ output: "Chain child output" });
		const { executor, events } = makeExecutor({ agents: [makeAgent("a"), makeAgent("b"), makeAgent("c")] });

		const result = await executor.execute(
			"chain-intercom",
			{
				chain: [
					{ agent: "a", task: "step-a" },
					{ parallel: [{ agent: "b", task: "step-b" }, { agent: "c", task: "step-c" }] },
				],
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		const intercomEvents = events.emitted.filter((entry) => entry.channel === "subagent:result-intercom");
		assert.equal(intercomEvents.length, 1);
		const payload = intercomEvents[0]!.payload as { children?: Array<{ agent?: string; intercomTarget?: string }>; message?: string; mode?: string };
		assert.equal(payload.mode, "chain");
		assert.deepEqual((payload.children ?? []).map((child) => child.agent).sort(), ["a", "b", "c"]);
		assert.equal((payload.children ?? []).every((child) => /^subagent-[abc]-[a-f0-9]+-[123]$/.test(child.intercomTarget ?? "")), true);
		assert.match(String(payload.message ?? ""), /1\. a — completed/);
		assert.match(String(payload.message ?? ""), /2\. b — completed/);
		assert.match(String(payload.message ?? ""), /3\. c — completed/);
		assert.match(result.content[0]?.text ?? "", /Delivered chain subagent results via intercom\./);
		assert.equal(result.details?.results?.every((entry) => entry.finalOutput === undefined), true);
	});

	it("detached chain runs do not emit grouped completion receipts", async () => {
		mockPi.onCall({
			steps: [
				{ jsonl: [events.toolStart("contact_supervisor", { reason: "need_decision", message: "Need a decision" })] },
				{ delay: 1000, jsonl: [events.assistantMessage("after reply")] },
			],
		});
		const { executor, events: bus } = makeExecutor({ agents: [makeAgent("a", { systemPrompt: "Intercom orchestration channel:" }), makeAgent("b")] });
		let detachEmitted = false;

		const result = await executor.execute(
			"chain-detached-intercom",
			{
				chain: [
					{ agent: "a", task: "ask supervisor" },
					{ agent: "b", task: "must not run" },
				],
			},
			new AbortController().signal,
			(update: { details?: { progress?: Array<{ currentTool?: string }> } }) => {
				if (detachEmitted) return;
				if (!update.details?.progress?.some((entry) => entry.currentTool === "contact_supervisor")) return;
				detachEmitted = true;
				bus.emit(INTERCOM_DETACH_REQUEST_EVENT, { requestId: "chain-detached" });
			},
			makeMinimalCtx(tempDir),
		);

		assert.equal(detachEmitted, true);
		assert.match(result.content[0]?.text ?? "", /Chain detached for intercom coordination/);
		assert.match(result.content[0]?.text ?? "", /do not resume or launch a replacement/);
		assert.equal(bus.emitted.some((entry) => entry.channel === "subagent:result-intercom"), false);
		assert.equal(mockPi.callCount(), 1);
	});

	it("resume action sends a follow-up to a live async child when the target is registered", async () => {
		const runId = `resume-live-${Date.now()}`;
		const asyncDir = path.join(ASYNC_DIR, runId);
		const kills: Array<{ pid: number; signal?: NodeJS.Signals | 0 }> = [];
		try {
			fs.mkdirSync(asyncDir, { recursive: true });
			fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
				runId,
				mode: "single",
				state: "running",
				pid: process.pid,
				startedAt: 100,
				lastUpdate: Date.now(),
				steps: [{ agent: "worker", status: "running" }],
			}, null, 2), "utf-8");
			const { executor, events } = makeExecutor({
				kill: (pid, signal) => {
					kills.push({ pid, signal });
					return true;
				},
			});

			const result = await executor.execute(
				"resume-live",
				{ action: "resume", id: runId, message: "Can you clarify the last change?" },
				new AbortController().signal,
				undefined,
				makeMinimalCtx(tempDir),
			);

			assert.equal(result.isError, undefined);
			assert.match(result.content[0]?.text ?? "", /Interrupted live async child, then delivered follow-up/);
			assert.deepEqual(kills, [
				{ pid: process.pid, signal: 0 },
				{ pid: process.pid, signal: process.platform === "win32" ? "SIGBREAK" : "SIGUSR2" },
			]);
			const payload = events.emitted.find((entry) => entry.channel === "subagent:result-intercom")?.payload as { to?: string; message?: string } | undefined;
			assert.equal(payload?.to, `subagent-worker-${runId}-1`);
			assert.match(payload?.message ?? "", /Can you clarify the last change\?/);
		} finally {
			fs.rmSync(asyncDir, { recursive: true, force: true });
		}
	});

	it("resume action rejects explicit reviewed acceptance before launching", async () => {
		for (const [index, params] of [
			{ message: "Continue", acceptance: "reviewed" },
			{ chain: [{ agent: "reviewer", task: "Review {previous}", acceptance: { level: "reviewed" } }] },
		].entries()) {
			const { executor, events } = makeExecutor({ agents: [makeAgent("reviewer")] });
			const result = await executor.execute(
				`resume-invalid-acceptance-${index}`,
				{ action: "resume", id: "missing-source-run", ...params },
				new AbortController().signal,
				undefined,
				makeMinimalCtx(tempDir),
			);

			assert.equal(result.isError, true);
			assert.match(result.content[0]?.text ?? "", /Cannot resume:.*cannot be requested explicitly.*independent reviewer result/i);
			assert.equal(events.emitted.some((entry) => entry.channel === SUBAGENT_ASYNC_STARTED_EVENT), false);
		}
	});

	it("resume action can attach a live async child as the first step of a new chain", async () => {
		const sourceRunId = `resume-chain-root-${Date.now()}`;
		const sourceAsyncDir = path.join(ASYNC_DIR, sourceRunId);
		const sourceResultPath = path.join(RESULTS_DIR, `${sourceRunId}.json`);
		const sourceSession = path.join(tempDir, "source-child.jsonl");
		try {
			fs.mkdirSync(sourceAsyncDir, { recursive: true });
			fs.mkdirSync(RESULTS_DIR, { recursive: true });
			fs.writeFileSync(sourceSession, "", "utf-8");
			fs.writeFileSync(path.join(sourceAsyncDir, "status.json"), JSON.stringify({
				runId: sourceRunId,
				mode: "single",
				state: "running",
				pid: process.pid,
				startedAt: 100,
				lastUpdate: 100,
				cwd: tempDir,
				steps: [{ agent: "worker", status: "running", sessionFile: sourceSession }],
			}, null, 2), "utf-8");
			fs.writeFileSync(sourceResultPath, JSON.stringify({
				id: sourceRunId,
				agent: "worker",
				mode: "single",
				success: true,
				state: "complete",
				summary: "root output",
				results: [{ agent: "worker", output: "root output", success: true, sessionFile: sourceSession }],
			}, null, 2), "utf-8");
			const { executor, events } = makeExecutor({ agents: [makeAgent("worker"), makeAgent("reviewer")] });

			const result = await executor.execute(
				"resume-chain-root",
				{
					action: "resume",
					id: sourceRunId,
					chain: [{ agent: "reviewer", task: "Review this root result: {previous}" }],
				},
				new AbortController().signal,
				undefined,
				makeMinimalCtx(tempDir),
			);

			assert.equal(result.isError, undefined);
			assert.match(result.content[0]?.text ?? "", /Attached async subagent/);
			const startedEvent = events.emitted.find((entry) => entry.channel === SUBAGENT_ASYNC_STARTED_EVENT)?.payload as { agent?: string; agents?: string[]; chain?: string[]; chainStepCount?: number } | undefined;
			assert.equal(startedEvent?.agent, "worker");
			assert.deepEqual(startedEvent?.agents, ["worker", "reviewer"]);
			assert.deepEqual(startedEvent?.chain, ["worker", "reviewer"]);
			assert.equal(startedEvent?.chainStepCount, 2);
			const attachedId = result.details?.asyncId;
			assert.ok(attachedId, "expected attached chain async id");
			assert.match(result.details?.asyncDir ?? "", new RegExp(`${attachedId}$`));
			const statusPath = path.join(result.details!.asyncDir!, "status.json");
			await waitForFile(statusPath);
			const attachedStatus = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as { mode?: string; chainStepCount?: number; steps?: Array<{ agent?: string; label?: string; status?: string }> };
			assert.equal(attachedStatus.mode, "chain");
			assert.equal(attachedStatus.chainStepCount, 2);
			assert.deepEqual(attachedStatus.steps?.map((step) => step.agent), ["worker", "reviewer"]);
			assert.match(attachedStatus.steps?.[0]?.label ?? "", /Attached resume-chain-root-/);
			await waitForFile(path.join(RESULTS_DIR, `${attachedId}.json`));
		} finally {
			fs.rmSync(sourceAsyncDir, { recursive: true, force: true });
			fs.rmSync(sourceResultPath, { force: true });
		}
	});

	it("resume action can attach a completed async result without reviving from a session", async () => {
		const sourceRunId = `resume-chain-complete-root-${Date.now()}`;
		const sourceAsyncDir = path.join(ASYNC_DIR, sourceRunId);
		const sourceResultPath = path.join(RESULTS_DIR, `${sourceRunId}.json`);
		try {
			fs.mkdirSync(sourceAsyncDir, { recursive: true });
			fs.mkdirSync(RESULTS_DIR, { recursive: true });
			fs.writeFileSync(path.join(sourceAsyncDir, "status.json"), JSON.stringify({
				runId: sourceRunId,
				mode: "single",
				state: "complete",
				startedAt: 100,
				lastUpdate: 200,
				cwd: tempDir,
				steps: [{ agent: "worker", status: "complete" }],
			}, null, 2), "utf-8");
			fs.writeFileSync(sourceResultPath, JSON.stringify({
				id: sourceRunId,
				agent: "worker",
				mode: "single",
				success: true,
				state: "complete",
				summary: "completed root output",
				results: [{ agent: "worker", output: "completed root output", success: true }],
			}, null, 2), "utf-8");
			const { executor } = makeExecutor({ agents: [makeAgent("worker"), makeAgent("reviewer")] });

			const reviveOnly = await executor.execute(
				"resume-chain-complete-root-revive-only",
				{ action: "resume", id: sourceRunId, message: "Follow up" },
				new AbortController().signal,
				undefined,
				makeMinimalCtx(tempDir),
			);
			assert.equal(reviveOnly.isError, true);
			assert.match(reviveOnly.content[0]?.text ?? "", /does not have a persisted session file/);

			const attached = await executor.execute(
				"resume-chain-complete-root",
				{
					action: "resume",
					id: sourceRunId,
					chain: [{ agent: "reviewer", task: "Review this completed root result: {previous}" }],
				},
				new AbortController().signal,
				undefined,
				makeMinimalCtx(tempDir),
			);

			assert.equal(attached.isError, undefined);
			assert.match(attached.content[0]?.text ?? "", /Attached async subagent/);
			assert.ok(attached.details?.asyncId, "expected attached chain async id");
			await waitForFile(path.join(RESULTS_DIR, `${attached.details.asyncId}.json`));
		} finally {
			fs.rmSync(sourceAsyncDir, { recursive: true, force: true });
			fs.rmSync(sourceResultPath, { force: true });
		}
	});

	it("resume action revives completed multi-child async runs by index", async () => {
		mockPi.onCall({ output: "revived async child b" });
		const runId = `resume-revive-multi-${Date.now()}`;
		const asyncDir = path.join(ASYNC_DIR, runId);
		const firstSession = path.join(tempDir, "child-a.jsonl");
		const secondSession = path.join(tempDir, "child-b.jsonl");
		try {
			fs.mkdirSync(asyncDir, { recursive: true });
			fs.writeFileSync(firstSession, "", "utf-8");
			fs.writeFileSync(secondSession, "", "utf-8");
			fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
				runId,
				mode: "parallel",
				state: "complete",
				startedAt: 100,
				lastUpdate: 200,
				cwd: tempDir,
				steps: [
					{ agent: "a", status: "complete", sessionFile: firstSession },
					{ agent: "b", status: "complete", sessionFile: secondSession, model: "anthropic/claude-sonnet-4", thinking: "high" },
				],
			}, null, 2), "utf-8");
			const { executor } = makeExecutor({ agents: [makeAgent("a"), makeAgent("b")] });

			const result = await executor.execute(
				"resume-revive-multi",
				{ action: "resume", id: runId, index: 1, message: "What did b find?" },
				new AbortController().signal,
				undefined,
				makeMinimalCtx(tempDir),
			);

			assert.equal(result.isError, undefined);
			assert.match(result.content[0]?.text ?? "", /Revived async subagent from/);
			assert.match(result.content[0]?.text ?? "", /Agent: b/);
			assert.match(result.content[0]?.text ?? "", new RegExp(secondSession.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
			const args = await readMockCallArgs(0);
			assert.equal(args[args.indexOf("--session") + 1], secondSession);
			assert.equal(args[args.indexOf("--model") + 1], "anthropic/claude-sonnet-4:high");
		} finally {
			fs.rmSync(asyncDir, { recursive: true, force: true });
		}
	});

	it("resume action revives completed async runs with no-poll handoff guidance", async () => {
		mockPi.onCall({ output: "revived answer" });
		const runId = `resume-revive-${Date.now()}`;
		const asyncDir = path.join(ASYNC_DIR, runId);
		const sessionFile = path.join(tempDir, "child-session.jsonl");
		try {
			fs.mkdirSync(asyncDir, { recursive: true });
			fs.writeFileSync(sessionFile, "", "utf-8");
			fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
				runId,
				mode: "single",
				state: "complete",
				startedAt: 100,
				lastUpdate: 200,
				cwd: tempDir,
				sessionFile,
				steps: [{ agent: "worker", status: "complete" }],
			}, null, 2), "utf-8");
			const { executor } = makeExecutor();

			const result = await executor.execute(
				"resume-revive",
				{ action: "resume", id: runId, message: "What changed?" },
				new AbortController().signal,
				undefined,
				makeMinimalCtx(tempDir),
			);

			assert.equal(result.isError, undefined);
			assert.match(result.content[0]?.text ?? "", /Revived async subagent from/);
			assert.match(result.content[0]?.text ?? "", /Do not run sleep timers or polling loops/);
			assert.match(result.content[0]?.text ?? "", /call subagent_wait\(\)/);
			assert.match(result.content[0]?.text ?? "", /Status if needed: subagent\(\{ action: "status"/);
			assert.doesNotMatch(result.content[0]?.text ?? "", /Follow:/);
			const revivedId = result.details?.asyncId;
			assert.ok(revivedId, "expected revived async id");
			const resultPath = path.join(RESULTS_DIR, `${revivedId}.json`);
			const deadline = Date.now() + 10_000;
			while (!fs.existsSync(resultPath)) {
				if (Date.now() > deadline) assert.fail(`Timed out waiting for revived result file: ${resultPath}`);
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
		} finally {
			fs.rmSync(asyncDir, { recursive: true, force: true });
		}
	});

	it("rejects concurrent direct revival of the same completed async session and releases ownership", async () => {
		const releasePath = path.join(tempDir, "release-async-revival");
		mockPi.onCall({ waitForPath: releasePath, output: "first revived answer" });
		mockPi.onCall({ output: "answer after release" });
		const sourceRunId = `resume-lease-async-${Date.now()}`;
		const sourceAsyncDir = path.join(ASYNC_DIR, sourceRunId);
		const sessionFile = path.join(tempDir, "leased-async-child.jsonl");
		fs.mkdirSync(sourceAsyncDir, { recursive: true });
		fs.writeFileSync(sessionFile, "", "utf-8");
		fs.writeFileSync(path.join(sourceAsyncDir, "status.json"), JSON.stringify({
			runId: sourceRunId,
			mode: "single",
			state: "complete",
			startedAt: 100,
			lastUpdate: 200,
			cwd: tempDir,
			sessionFile,
			steps: [{ agent: "worker", status: "complete" }],
		}, null, 2), "utf-8");
		try {
			const { executor } = makeExecutor();
			const first = await executor.execute(
				"resume-lease-async-first",
				{ action: "resume", id: sourceRunId, message: "First follow-up" },
				new AbortController().signal,
				undefined,
				makeMinimalCtx(tempDir),
			);
			assert.equal(first.isError, undefined);
			const firstRevivedId = first.details?.asyncId;
			assert.ok(firstRevivedId);

			const blocked = await executor.execute(
				"resume-lease-async-blocked",
				{ action: "resume", id: sourceRunId, message: "Conflicting follow-up" },
				new AbortController().signal,
				undefined,
				makeMinimalCtx(tempDir),
			);
			assert.equal(blocked.isError, true);
			assert.match(blocked.content[0]?.text ?? "", new RegExp(`already owned by run '${firstRevivedId}'`));
			assert.equal(fs.readdirSync(mockPi.dir).filter((name) => name.startsWith("call-")).length, 1, "contending revival must not spawn Pi");

			fs.writeFileSync(releasePath, "release", "utf-8");
			await waitForFile(path.join(RESULTS_DIR, `${firstRevivedId}.json`));
			await waitForMissingPath(sessionLeaseDir(sessionFile));
			const afterRelease = await executor.execute(
				"resume-lease-async-after-release",
				{ action: "resume", id: sourceRunId, message: "Follow-up after release" },
				new AbortController().signal,
				undefined,
				makeMinimalCtx(tempDir),
			);
			assert.equal(afterRelease.isError, undefined);
			assert.ok(afterRelease.details?.asyncId);
			await waitForFile(path.join(RESULTS_DIR, `${afterRelease.details.asyncId}.json`));
		} finally {
			fs.writeFileSync(releasePath, "release", "utf-8");
			fs.rmSync(sourceAsyncDir, { recursive: true, force: true });
		}
	});

	it("resume action revives a completed foreground child by index", async () => {
		mockPi.onCall({ output: "first child done" });
		mockPi.onCall({ output: "second child done" });
		mockPi.onCall({ output: "revived foreground answer" });
		const { executor } = makeExecutor({ bridgeMode: "off", agents: [makeAgent("a"), makeAgent("b")] });

		const original = await executor.execute(
			"foreground-resume-original",
			{ tasks: [{ agent: "a", task: "task-a" }, { agent: "b", task: "task-b" }] },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		const runId = original.details?.runId;
		assert.ok(runId, "expected foreground run id");

		const revived = await executor.execute(
			"foreground-resume",
			{ action: "resume", id: runId, index: 1, message: "Follow up with b" },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(revived.isError, undefined);
		assert.match(revived.content[0]?.text ?? "", /Revived foreground subagent from/);
		assert.match(revived.content[0]?.text ?? "", /Agent: b/);
		const reviveArgs = await readMockCallArgs(2);
		const selectedSession = original.details?.results?.[1]?.sessionFile;
		assert.ok(selectedSession, "expected selected child session file");
		assert.equal(reviveArgs[reviveArgs.indexOf("--session") + 1], selectedSession);
		const revivedId = revived.details?.asyncId;
		assert.ok(revivedId, "expected revived async id");
		const resultPath = path.join(RESULTS_DIR, `${revivedId}.json`);
		const deadline = Date.now() + 10_000;
		while (!fs.existsSync(resultPath)) {
			if (Date.now() > deadline) assert.fail(`Timed out waiting for revived result file: ${resultPath}`);
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	});

	it("applies the same exclusive lease to remembered foreground revival", async () => {
		const releasePath = path.join(tempDir, "release-foreground-revival");
		mockPi.onCall({ output: "original foreground answer" });
		mockPi.onCall({ waitForPath: releasePath, output: "first foreground revival" });
		mockPi.onCall({ output: "foreground revival after release" });
		const { executor } = makeExecutor({ bridgeMode: "off" });
		try {
			const original = await executor.execute(
				"foreground-lease-original",
				{ agent: "worker", task: "Original task" },
				new AbortController().signal,
				undefined,
				makeMinimalCtx(tempDir),
			);
			const sourceRunId = original.details?.runId;
			const sessionFile = original.details?.results?.[0]?.sessionFile;
			assert.ok(sourceRunId);
			assert.ok(sessionFile);

			const first = await executor.execute(
				"foreground-lease-first",
				{ action: "resume", id: sourceRunId, message: "First follow-up" },
				new AbortController().signal,
				undefined,
				makeMinimalCtx(tempDir),
			);
			assert.equal(first.isError, undefined);
			const firstRevivedId = first.details?.asyncId;
			assert.ok(firstRevivedId);

			const blocked = await executor.execute(
				"foreground-lease-blocked",
				{ action: "resume", id: sourceRunId, message: "Conflicting follow-up" },
				new AbortController().signal,
				undefined,
				makeMinimalCtx(tempDir),
			);
			assert.equal(blocked.isError, true);
			assert.match(blocked.content[0]?.text ?? "", new RegExp(`already owned by run '${firstRevivedId}'`));
			assert.equal(fs.readdirSync(mockPi.dir).filter((name) => name.startsWith("call-")).length, 2, "contending foreground revival must not spawn Pi");

			fs.writeFileSync(releasePath, "release", "utf-8");
			await waitForFile(path.join(RESULTS_DIR, `${firstRevivedId}.json`));
			await waitForMissingPath(sessionLeaseDir(sessionFile));
			const afterRelease = await executor.execute(
				"foreground-lease-after-release",
				{ action: "resume", id: sourceRunId, message: "Follow-up after release" },
				new AbortController().signal,
				undefined,
				makeMinimalCtx(tempDir),
			);
			assert.equal(afterRelease.isError, undefined);
			assert.ok(afterRelease.details?.asyncId);
			await waitForFile(path.join(RESULTS_DIR, `${afterRelease.details.asyncId}.json`));
		} finally {
			fs.writeFileSync(releasePath, "release", "utf-8");
		}
	});

	it("status recovers remembered detached foreground output after child exit", async () => {
		mockPi.onCall({
			steps: [
				{ jsonl: [events.toolStart("contact_supervisor", { reason: "need_decision", message: "Need a decision" })] },
				{ delay: 50, jsonl: [events.assistantMessage("final recovered answer")] },
			],
		});
		const { executor, events: bus } = makeExecutor({ agents: [makeAgent("a", { systemPrompt: "Intercom orchestration channel:" })] });
		let detachEmitted = false;
		const original = await executor.execute(
			"foreground-detached-status-original",
			{ agent: "a", task: "ask supervisor" },
			new AbortController().signal,
			(update: { details?: { progress?: Array<{ currentTool?: string }> } }) => {
				if (detachEmitted) return;
				if (!update.details?.progress?.some((entry) => entry.currentTool === "contact_supervisor")) return;
				detachEmitted = true;
				bus.emit(INTERCOM_DETACH_REQUEST_EVENT, { requestId: "single-detached-status" });
			},
			makeMinimalCtx(tempDir),
		);
		assert.equal(detachEmitted, true);
		const runId = original.details?.runId;
		assert.ok(runId, "expected foreground run id");
		assert.match(original.content[0]?.text ?? "", /Detached for intercom coordination/);

		const deadline = Date.now() + 5000;
		let statusText = "";
		while (Date.now() < deadline) {
			const status = await executor.execute(
				"foreground-detached-status",
				{ action: "status", id: runId },
				new AbortController().signal,
				undefined,
				makeMinimalCtx(tempDir),
			);
			statusText = status.content[0]?.text ?? "";
			if (/final recovered answer/.test(statusText)) break;
			await new Promise((resolve) => setTimeout(resolve, 25));
		}

		assert.doesNotMatch(statusText, /Async run not found/);
		assert.match(statusText, /State: remembered foreground/);
		assert.match(statusText, /a completed/);
		assert.match(statusText, /final recovered answer/);

		const transcript = await executor.execute(
			"foreground-detached-transcript",
			{ action: "status", id: runId, view: "transcript" },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		const transcriptText = transcript.content[0]?.text ?? "";
		assert.doesNotMatch(transcriptText, /Async run not found/);
		assert.match(transcriptText, /final recovered answer/);
	});

	it("keeps detached acceptance pending and emits recovered foreground completion to the originating session", async () => {
		const acceptanceReport = [
			"final recovered answer",
			"```acceptance-report",
			JSON.stringify({
				criteriaSatisfied: [{ id: "criterion-1", status: "satisfied", evidence: "review completed" }],
				changedFiles: ["src/review.ts"],
				testsAddedOrUpdated: ["test/review.test.ts"],
				commandsRun: [{ command: "npm test", result: "passed", summary: "passed" }],
				validationOutput: ["npm test passed"],
				residualRisks: [],
				noStagedFiles: true,
			}),
			"```",
		].join("\n");
		mockPi.onCall({
			steps: [
				{ jsonl: [events.toolStart("contact_supervisor", { reason: "need_decision", message: "Need a decision" })] },
				{ delay: 75, jsonl: [events.assistantMessage(acceptanceReport)] },
			],
		});
		const { executor, events: bus, state } = makeExecutor({ agents: [makeAgent("a", { systemPrompt: "Intercom orchestration channel:" })] });
		let detachEmitted = false;
		const original = await executor.execute(
			"foreground-detached-completion-original",
			{ agent: "a", task: "ask supervisor", acceptance: { level: "checked", criteria: ["Review completed"] } },
			new AbortController().signal,
			(update: { details?: { progress?: Array<{ currentTool?: string }> } }) => {
				if (detachEmitted || !update.details?.progress?.some((entry) => entry.currentTool === "contact_supervisor")) return;
				detachEmitted = true;
				bus.emit(INTERCOM_DETACH_REQUEST_EVENT, { requestId: "single-detached-completion" });
			},
			makeMinimalCtx(tempDir),
		);
		const runId = original.details?.runId;
		assert.ok(runId, "expected foreground run id");
		assert.equal(original.details?.results?.[0]?.acceptance?.status, "pending");
		assert.match(original.content[0]?.text ?? "", /subagent_wait\(\{ id:/);
		const metadataPath = original.details?.results?.[0]?.artifactPaths?.metadataPath;
		assert.ok(metadataPath);
		const pendingMetadata = JSON.parse(fs.readFileSync(metadataPath, "utf-8")) as { acceptance?: { status?: string } };
		assert.equal(pendingMetadata.acceptance?.status, "pending");

		const waited = await waitForSubagents({ id: runId, timeoutMs: 5000 }, undefined, {
			state: state as never,
			events: bus,
			asyncDirRoot: path.join(tempDir, "async-runs"),
			resultsDir: path.join(tempDir, "results"),
		});
		assert.equal(waited.isError, undefined);
		assert.match(waited.content[0]?.text ?? "", /remembered detached foreground run/);

		const completion = bus.emitted.find((event) => event.channel === SUBAGENT_FOREGROUND_COMPLETE_EVENT);
		assert.ok(completion, "expected a foreground completion event");
		const payload = completion.payload as {
			runId?: string;
			sessionId?: string;
			source?: string;
			summary?: string;
			success?: boolean;
		};
		assert.equal(payload.runId, runId);
		assert.equal(payload.sessionId, "session-123");
		assert.equal(payload.source, "foreground");
		assert.equal(payload.success, true);
		assert.match(payload.summary ?? "", /final recovered answer/);
		const recoveredMetadata = JSON.parse(fs.readFileSync(metadataPath, "utf-8")) as { exitCode?: number; acceptance?: { status?: string; childReport?: unknown } };
		assert.equal(recoveredMetadata.exitCode, 0);
		assert.equal(recoveredMetadata.acceptance?.status, "checked");
		assert.ok(recoveredMetadata.acceptance?.childReport);

		const status = await executor.execute(
			"foreground-detached-completion-status",
			{ action: "status", id: runId },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		assert.match(status.content[0]?.text ?? "", /acceptance: checked/);
	});

	it("preserves deferred acceptance failure details in foreground completion and status", async () => {
		const rejectedReport = [
			"final answer with rejected acceptance evidence",
			"```acceptance-report",
			JSON.stringify({
				criteriaSatisfied: [{ id: "criterion-1", status: "not-satisfied", evidence: "review found a blocker" }],
				changedFiles: ["src/review.ts"],
				testsAddedOrUpdated: ["test/review.test.ts"],
				commandsRun: [{ command: "npm test", result: "failed", summary: "blocker remains" }],
				validationOutput: ["blocker remains"],
				residualRisks: ["review blocker"],
				noStagedFiles: true,
			}),
			"```",
		].join("\n");
		mockPi.onCall({
			steps: [
				{ jsonl: [events.toolStart("contact_supervisor", { reason: "need_decision", message: "Need a decision" })] },
				{ delay: 75, jsonl: [events.assistantMessage(rejectedReport)] },
			],
		});
		const { executor, events: bus, state } = makeExecutor({ agents: [makeAgent("a", { systemPrompt: "Intercom orchestration channel:" })] });
		let detachEmitted = false;
		const original = await executor.execute(
			"foreground-detached-failed-acceptance",
			{ agent: "a", task: "ask supervisor", acceptance: { level: "checked", criteria: ["Review completed"] } },
			new AbortController().signal,
			(update: { details?: { progress?: Array<{ currentTool?: string }> } }) => {
				if (detachEmitted || !update.details?.progress?.some((entry) => entry.currentTool === "contact_supervisor")) return;
				detachEmitted = true;
				bus.emit(INTERCOM_DETACH_REQUEST_EVENT, { requestId: "single-detached-failed-acceptance" });
			},
			makeMinimalCtx(tempDir),
		);
		const runId = original.details?.runId;
		assert.ok(runId);
		assert.equal(original.details?.results?.[0]?.acceptance?.status, "pending");

		const waited = await waitForSubagents({ id: runId, timeoutMs: 5000 }, undefined, {
			state: state as never,
			events: bus,
			asyncDirRoot: path.join(tempDir, "async-runs"),
			resultsDir: path.join(tempDir, "results"),
		});
		assert.equal(waited.isError, undefined);
		assert.match(waited.content[0]?.text ?? "", /1 failed/);

		const completion = bus.emitted.find((event) => event.channel === SUBAGENT_FOREGROUND_COMPLETE_EVENT);
		assert.ok(completion);
		const payload = completion.payload as { success?: boolean; summary?: string };
		assert.equal(payload.success, false);
		assert.match(payload.summary ?? "", /Acceptance rejected/);
		assert.match(payload.summary ?? "", /final answer with rejected acceptance evidence/);

		const status = await executor.execute(
			"foreground-detached-failed-status",
			{ action: "status", id: runId },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		assert.match(status.content[0]?.text ?? "", /acceptance: rejected/);
		assert.match(status.content[0]?.text ?? "", /error: Acceptance rejected/);
	});

	it("status recovers remembered detached chain output after child exit", async () => {
		mockPi.onCall({
			steps: [
				{ jsonl: [events.toolStart("contact_supervisor", { reason: "need_decision", message: "Need a decision" })] },
				{ delay: 50, jsonl: [events.assistantMessage("chain recovered answer")] },
			],
		});
		const { executor, events: bus } = makeExecutor({ agents: [makeAgent("a", { systemPrompt: "Intercom orchestration channel:" }), makeAgent("b")] });
		let detachEmitted = false;
		const original = await executor.execute(
			"foreground-detached-chain-status-original",
			{ chain: [{ agent: "a", task: "ask supervisor" }, { agent: "b", task: "must not run" }] },
			new AbortController().signal,
			(update: { details?: { progress?: Array<{ currentTool?: string }> } }) => {
				if (detachEmitted) return;
				if (!update.details?.progress?.some((entry) => entry.currentTool === "contact_supervisor")) return;
				detachEmitted = true;
				bus.emit(INTERCOM_DETACH_REQUEST_EVENT, { requestId: "chain-detached-status" });
			},
			makeMinimalCtx(tempDir),
		);
		assert.equal(detachEmitted, true);
		const runId = original.details?.runId;
		assert.ok(runId, "expected foreground run id");
		assert.match(original.content[0]?.text ?? "", /Chain detached for intercom coordination/);
		assert.equal(mockPi.callCount(), 1);

		const deadline = Date.now() + 5000;
		let statusText = "";
		while (Date.now() < deadline) {
			const status = await executor.execute(
				"foreground-detached-chain-status",
				{ action: "status", id: runId },
				new AbortController().signal,
				undefined,
				makeMinimalCtx(tempDir),
			);
			statusText = status.content[0]?.text ?? "";
			if (/chain recovered answer/.test(statusText)) break;
			await new Promise((resolve) => setTimeout(resolve, 25));
		}

		assert.doesNotMatch(statusText, /Async run not found/);
		assert.match(statusText, /State: remembered foreground/);
		assert.match(statusText, /a completed/);
		assert.match(statusText, /chain recovered answer/);

		const transcript = await executor.execute(
			"foreground-detached-chain-transcript",
			{ action: "status", id: runId, index: 0, view: "transcript" },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		assert.match(transcript.content[0]?.text ?? "", /chain recovered answer/);
	});

	it("status recovers a later detached serial chain child under its original index", async () => {
		mockPi.onCall({ output: "first step done" });
		mockPi.onCall({
			steps: [
				{ jsonl: [events.toolStart("contact_supervisor", { reason: "need_decision", message: "Need a decision" })] },
				{ delay: 200, jsonl: [events.assistantMessage("second recovered answer")] },
			],
		});
		const { executor, events: bus } = makeExecutor({ agents: [makeAgent("a"), makeAgent("b", { systemPrompt: "Intercom orchestration channel:" }), makeAgent("c")] });
		let detachEmitted = false;
		const original = await executor.execute(
			"foreground-later-detached-chain-status-original",
			{ chain: [{ agent: "a", task: "first" }, { agent: "b", task: "ask supervisor" }, { agent: "c", task: "must not run" }] },
			new AbortController().signal,
			(update: { details?: { progress?: Array<{ currentTool?: string }> } }) => {
				if (detachEmitted) return;
				if (!update.details?.progress?.some((entry) => entry.currentTool === "contact_supervisor")) return;
				detachEmitted = true;
				bus.emit(INTERCOM_DETACH_REQUEST_EVENT, { requestId: "later-chain-detached-status" });
			},
			makeMinimalCtx(tempDir),
		);
		assert.equal(detachEmitted, true);
		const runId = original.details?.runId;
		assert.ok(runId, "expected foreground run id");
		assert.match(original.content[0]?.text ?? "", /Chain detached for intercom coordination/);
		assert.equal(mockPi.callCount(), 2);

		const deadline = Date.now() + 5000;
		let statusText = "";
		while (Date.now() < deadline) {
			const status = await executor.execute(
				"foreground-later-detached-chain-status",
				{ action: "status", id: runId },
				new AbortController().signal,
				undefined,
				makeMinimalCtx(tempDir),
			);
			statusText = status.content[0]?.text ?? "";
			if (/second recovered answer/.test(statusText)) break;
			await new Promise((resolve) => setTimeout(resolve, 25));
		}

		assert.doesNotMatch(statusText, /Async run not found/);
		assert.match(statusText, /State: remembered foreground/);
		assert.match(statusText, /a completed/);
		assert.match(statusText, /b completed/);
		assert.match(statusText, /second recovered answer/);

		const transcript = await executor.execute(
			"foreground-later-detached-chain-transcript",
			{ action: "status", id: runId, index: 1, view: "transcript" },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		assert.match(transcript.content[0]?.text ?? "", /second recovered answer/);
	});

	it("blocks sibling resume while any remembered foreground child remains detached", async () => {
		const { executor, state } = makeExecutor({ bridgeMode: "off", agents: [makeAgent("a"), makeAgent("b")] });
		const siblingSession = path.join(tempDir, "completed-sibling.jsonl");
		fs.writeFileSync(siblingSession, "", "utf-8");
		state.foregroundRuns.set("mixed-detached-run", {
			runId: "mixed-detached-run",
			mode: "parallel",
			cwd: tempDir,
			sessionId: "session-123",
			updatedAt: Date.now(),
			children: [
				{ agent: "a", index: 0, status: "detached", updatedAt: Date.now() },
				{ agent: "b", index: 1, status: "completed", sessionFile: siblingSession, updatedAt: Date.now() },
			],
		});

		const status = await executor.execute(
			"mixed-detached-status",
			{ action: "status", id: "mixed-detached-run" },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		const statusText = status.content[0]?.text ?? "";
		assert.match(statusText, /do not resume or launch a replacement while any child remains detached/);
		assert.doesNotMatch(statusText, /Revive child:/);

		const resumed = await executor.execute(
			"mixed-detached-resume",
			{ action: "resume", id: "mixed-detached-run", index: 1, message: "replace sibling" },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		assert.equal(resumed.isError, true);
		assert.match(resumed.content[0]?.text ?? "", /cannot be revived safely while any child may still be live/);
		assert.match(resumed.content[0]?.text ?? "", /do not launch a replacement/);
	});

	it("resume action rejects detached foreground children that may still be live", async () => {
		mockPi.onCall({
			steps: [
				{ jsonl: [events.toolStart("contact_supervisor", { reason: "need_decision", message: "Need a decision" })] },
				{ delay: 1000, jsonl: [events.assistantMessage("after reply")] },
			],
		});
		const { executor, events: bus } = makeExecutor({ agents: [makeAgent("a", { systemPrompt: "Intercom orchestration channel:" })] });
		let detachEmitted = false;
		const original = await executor.execute(
			"foreground-detached-original",
			{ agent: "a", task: "ask supervisor" },
			new AbortController().signal,
			(update: { details?: { progress?: Array<{ currentTool?: string }> } }) => {
				if (detachEmitted) return;
				if (!update.details?.progress?.some((entry) => entry.currentTool === "contact_supervisor")) return;
				detachEmitted = true;
				bus.emit(INTERCOM_DETACH_REQUEST_EVENT, { requestId: "single-detached" });
			},
			makeMinimalCtx(tempDir),
		);
		assert.equal(detachEmitted, true);
		const runId = original.details?.runId;
		assert.ok(runId, "expected foreground run id");

		const fleet = await executor.execute(
			"foreground-detached-fleet",
			{ action: "status", view: "fleet" },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		const fleetText = fleet.content[0]?.text ?? "";
		assert.match(fleetText, /Detached foreground runs:/);
		assert.ok(fleetText.includes(runId));
		assert.match(fleetText, /recovery: reply to the supervisor request first/);

		const resumed = await executor.execute(
			"foreground-detached-resume",
			{ action: "resume", id: runId, message: "Follow up" },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(resumed.isError, true);
		assert.match(resumed.content[0]?.text ?? "", /detached for intercom coordination/);
		assert.match(resumed.content[0]?.text ?? "", /Reply to the supervisor request first/);
		assert.doesNotMatch(resumed.content[0]?.text ?? "", /revive only/);
	});

	it("does not inspect or resume remembered foreground runs from another parent session", async () => {
		const { executor, state } = makeExecutor({ bridgeMode: "off", agents: [makeAgent("a")] });
		const sessionFile = path.join(tempDir, "other-session-child.jsonl");
		fs.writeFileSync(sessionFile, "", "utf-8");
		state.foregroundRuns.set("other-session-run", {
			runId: "other-session-run",
			mode: "single",
			cwd: tempDir,
			sessionId: "session-other",
			updatedAt: Date.now(),
			children: [{ agent: "a", index: 0, status: "completed", sessionFile }],
		});

		const status = await executor.execute(
			"other-session-status",
			{ action: "status", id: "other-session-run" },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		assert.equal(status.isError, true);
		assert.doesNotMatch(status.content[0]?.text ?? "", /State: remembered foreground/);

		const fleet = await executor.execute(
			"other-session-fleet",
			{ action: "status", view: "fleet" },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		assert.doesNotMatch(fleet.content[0]?.text ?? "", /other-session-run/);

		const resumed = await executor.execute(
			"other-session-resume",
			{ action: "resume", id: "other-session-run", message: "Follow up" },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		assert.equal(resumed.isError, true);
		assert.doesNotMatch(resumed.content[0]?.text ?? "", /Revived foreground subagent/);
		assert.equal(mockPi.callCount(), 0);
	});

	it("resume action keeps exact foreground validation errors over async prefix matches", async () => {
		const base = `exact-invalid-${Date.now()}`;
		const asyncSession = path.join(tempDir, "async-exact-prefix.jsonl");
		fs.writeFileSync(asyncSession, "", "utf-8");
		const asyncDir = path.join(ASYNC_DIR, `${base}-async`);
		try {
			fs.mkdirSync(asyncDir, { recursive: true });
			fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
				runId: `${base}-async`,
				mode: "single",
				state: "complete",
				startedAt: 100,
				lastUpdate: 200,
				cwd: tempDir,
				steps: [{ agent: "a", status: "complete", sessionFile: asyncSession }],
			}, null, 2), "utf-8");
			const { executor, state } = makeExecutor({ bridgeMode: "off", agents: [makeAgent("a")] });
			state.foregroundRuns.set(base, {
				runId: base,
				mode: "single",
				cwd: tempDir,
				sessionId: "session-123",
				updatedAt: Date.now(),
				children: [{ agent: "a", index: 0, status: "completed" }],
			});

			const result = await executor.execute(
				"resume-exact-invalid-foreground",
				{ action: "resume", id: base, message: "Follow up" },
				new AbortController().signal,
				undefined,
				makeMinimalCtx(tempDir),
			);

			assert.equal(result.isError, true);
			assert.match(result.content[0]?.text ?? "", /Foreground run '.+' child 0 does not have a persisted session file/);
			assert.equal(mockPi.callCount(), 0);
		} finally {
			fs.rmSync(asyncDir, { recursive: true, force: true });
		}
	});

	it("resume action keeps exact async validation errors over foreground prefix matches", async () => {
		const base = `exact-invalid-async-${Date.now()}`;
		const foregroundSession = path.join(tempDir, "foreground-exact-prefix.jsonl");
		fs.writeFileSync(foregroundSession, "", "utf-8");
		const asyncDir = path.join(ASYNC_DIR, base);
		try {
			fs.mkdirSync(asyncDir, { recursive: true });
			fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
				runId: base,
				mode: "single",
				state: "complete",
				startedAt: 100,
				lastUpdate: 200,
				cwd: tempDir,
				steps: [{ agent: "a", status: "complete" }],
			}, null, 2), "utf-8");
			const { executor, state } = makeExecutor({ bridgeMode: "off", agents: [makeAgent("a")] });
			state.foregroundRuns.set(`${base}-foreground`, {
				runId: `${base}-foreground`,
				mode: "single",
				cwd: tempDir,
				sessionId: "session-123",
				updatedAt: Date.now(),
				children: [{ agent: "a", index: 0, status: "completed", sessionFile: foregroundSession }],
			});

			const result = await executor.execute(
				"resume-exact-invalid-async",
				{ action: "resume", id: base, message: "Follow up" },
				new AbortController().signal,
				undefined,
				makeMinimalCtx(tempDir),
			);

			assert.equal(result.isError, true);
			assert.match(result.content[0]?.text ?? "", /Async run '.+' child 0 does not have a persisted session file/);
			assert.equal(mockPi.callCount(), 0);
		} finally {
			fs.rmSync(asyncDir, { recursive: true, force: true });
		}
	});

	it("resume action reports async ambiguity even when foreground has one prefix match", async () => {
		const base = `namespace-ambiguous-${Date.now()}`;
		const foregroundSession = path.join(tempDir, "foreground-prefix.jsonl");
		const firstAsyncSession = path.join(tempDir, "async-a.jsonl");
		const secondAsyncSession = path.join(tempDir, "async-b.jsonl");
		fs.writeFileSync(foregroundSession, "", "utf-8");
		fs.writeFileSync(firstAsyncSession, "", "utf-8");
		fs.writeFileSync(secondAsyncSession, "", "utf-8");
		const firstAsyncDir = path.join(ASYNC_DIR, `${base}-async-a`);
		const secondAsyncDir = path.join(ASYNC_DIR, `${base}-async-b`);
		try {
			for (const [asyncDir, runId, sessionFile] of [[firstAsyncDir, `${base}-async-a`, firstAsyncSession], [secondAsyncDir, `${base}-async-b`, secondAsyncSession]] as const) {
				fs.mkdirSync(asyncDir, { recursive: true });
				fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
					runId,
					mode: "single",
					state: "complete",
					startedAt: 100,
					lastUpdate: 200,
					cwd: tempDir,
					steps: [{ agent: "a", status: "complete", sessionFile }],
				}, null, 2), "utf-8");
			}
			const { executor, state } = makeExecutor({ bridgeMode: "off", agents: [makeAgent("a")] });
			state.foregroundRuns.set(`${base}-foreground`, {
				runId: `${base}-foreground`,
				mode: "single",
				cwd: tempDir,
				sessionId: "session-123",
				updatedAt: Date.now(),
				children: [{ agent: "a", index: 0, status: "completed", sessionFile: foregroundSession }],
			});

			const result = await executor.execute(
				"ambiguous-async-prefix-resume",
				{ action: "resume", id: base, message: "Follow up" },
				new AbortController().signal,
				undefined,
				makeMinimalCtx(tempDir),
			);

			assert.equal(result.isError, true);
			assert.match(result.content[0]?.text ?? "", /Ambiguous subagent run id prefix/);
		} finally {
			fs.rmSync(firstAsyncDir, { recursive: true, force: true });
			fs.rmSync(secondAsyncDir, { recursive: true, force: true });
		}
	});

	it("resume action reports ambiguous ids across remembered foreground and async runs", async () => {
		const base = `ambiguous-${Date.now()}`;
		const foregroundSession = path.join(tempDir, "foreground.jsonl");
		const asyncSession = path.join(tempDir, "async.jsonl");
		const asyncId = `${base}-async`;
		const foregroundId = `${base}-foreground`;
		const asyncDir = path.join(ASYNC_DIR, asyncId);
		fs.writeFileSync(foregroundSession, "", "utf-8");
		fs.writeFileSync(asyncSession, "", "utf-8");
		try {
			fs.mkdirSync(asyncDir, { recursive: true });
			fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
				runId: asyncId,
				mode: "single",
				state: "complete",
				startedAt: 100,
				lastUpdate: 200,
				cwd: tempDir,
				steps: [{ agent: "a", status: "complete", sessionFile: asyncSession }],
			}, null, 2), "utf-8");
			const { executor, state } = makeExecutor({ bridgeMode: "off", agents: [makeAgent("a")] });
			state.foregroundRuns.set(foregroundId, {
				runId: foregroundId,
				mode: "single",
				cwd: tempDir,
				sessionId: "session-123",
				updatedAt: Date.now(),
				children: [{ agent: "a", index: 0, status: "completed", sessionFile: foregroundSession }],
			});

			const result = await executor.execute(
				"ambiguous-resume",
				{ action: "resume", id: base, message: "Follow up" },
				new AbortController().signal,
				undefined,
				makeMinimalCtx(tempDir),
			);

			assert.equal(result.isError, true);
			assert.match(result.content[0]?.text ?? "", /ambiguous between foreground run/);
		} finally {
			fs.rmSync(asyncDir, { recursive: true, force: true });
		}
	});

	it("mixed foreground outcomes produce failed grouped status and receipt counts", async () => {
		mockPi.onCall({ matchArgIncludes: "task-a", output: "Parallel child success", exitCode: 0 });
		mockPi.onCall({ matchArgIncludes: "task-b", output: "Parallel child failure", stderr: "Parallel child failure", exitCode: 1 });
		const { executor, events } = makeExecutor({ agents: [makeAgent("a"), makeAgent("b")] });

		const result = await executor.execute(
			"parallel-mixed-intercom",
			{ tasks: [{ agent: "a", task: "task-a" }, { agent: "b", task: "task-b" }] },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		const intercomEvents = events.emitted.filter((entry) => entry.channel === "subagent:result-intercom");
		assert.equal(intercomEvents.length, 1);
		const payload = intercomEvents[0]!.payload as { status?: string; summary?: string; message?: string };
		assert.equal(payload.status, "failed");
		assert.match(String(payload.summary ?? ""), /1 completed, 1 failed/);
		assert.match(String(payload.message ?? ""), /Status: failed/);
		assert.match(result.content[0]?.text ?? "", /Children: 1 completed, 1 failed/);
	});
});
