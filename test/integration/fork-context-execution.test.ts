import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import type { MockPi } from "../support/helpers.ts";
import { createEventBus, createMockPi, createTempDir, events, removeTempDir, tryImport } from "../support/helpers.ts";
import { discoverAgents } from "../../agents.ts";
import { INTERCOM_DETACH_REQUEST_EVENT } from "../../types.ts";

interface ExecutorModule {
	createSubagentExecutor?: (...args: unknown[]) => {
		execute: (
			id: string,
			params: Record<string, unknown>,
			signal: AbortSignal,
			onUpdate: ((result: unknown) => void) | undefined,
			ctx: unknown,
		) => Promise<{
			isError?: boolean;
			content: Array<{ text?: string }>;
			details?: {
				context?: "fresh" | "fork";
				results?: Array<{ detached?: boolean; exitCode?: number; skills?: string[] }>;
			};
		}>;
	};
}

interface AsyncExecutionModule {
	isAsyncAvailable?: () => boolean;
}

interface ProgressUpdate {
	details?: {
		progress?: Array<{ status?: string; currentTool?: string }>;
	};
}

const executorMod = await tryImport<ExecutorModule>("./subagent-executor.ts");
const asyncExecutionMod = await tryImport<AsyncExecutionModule>("./async-execution.ts");
const available = !!executorMod;
const createSubagentExecutor = executorMod?.createSubagentExecutor;
const asyncAvailable = asyncExecutionMod?.isAsyncAvailable?.() === true;
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;

interface SessionStubOptions {
	sessionFile?: string;
	leafId?: string | null;
}

interface SessionManagerStub {
	getSessionId(): string;
	getSessionFile(): string | undefined;
	getLeafId(): string | null;
	constructor: {
		open(sessionFile: string): { createBranchedSession(leafId: string): string | undefined };
	};
}

function makeSessionManagerRecorder(options: SessionStubOptions = {}) {
	const manager: SessionManagerStub = {
		getSessionId: () => "session-123",
		getSessionFile: () => options.sessionFile,
		getLeafId: () => (options.leafId === undefined ? "leaf-current" : options.leafId),
		constructor: {
			open: () => ({
				createBranchedSession: () => "/tmp/child.jsonl",
			}),
		},
	};
	return { manager };
}

function makeState(cwd: string) {
	return {
		baseCwd: cwd,
		currentSessionId: null,
		asyncJobs: new Map(),
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
}

describe("fork context execution wiring", { skip: !available ? "subagent executor not importable" : undefined }, () => {
	let tempDir: string;
	let mockPi: MockPi;

	before(() => {
		mockPi = createMockPi();
		mockPi.install();
	});

	after(() => {
		mockPi.uninstall();
	});

	beforeEach(() => {
		tempDir = createTempDir("pi-subagent-fork-test-");
		mockPi.reset();
		mockPi.onCall({ output: "ok" });
	});

	afterEach(() => {
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;
		if (originalUserProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = originalUserProfile;
		removeTempDir(tempDir);
	});

	function makeExecutor() {
		return makeExecutorWithConfig({});
	}

	function makeExecutorWithConfig(config: Record<string, unknown>) {
		return makeExecutorWithDiscoverAgents(() => ({
			agents: [
				{ name: "echo", description: "Echo test agent" },
				{ name: "second", description: "Second test agent" },
			],
			projectAgentsDir: null,
		}), config);
	}

	function makeExecutorWithDiscoverAgents(discoverAgentsImpl: typeof discoverAgents, config: Record<string, unknown> = {}) {
		let sessionName: string | undefined;
		const eventsApi = createEventBus();
		return Object.assign(createSubagentExecutor({
			pi: {
				events: eventsApi,
				getSessionName: () => sessionName,
				setSessionName: (name: string) => {
					sessionName = name;
				},
				sendMessage: () => {},
			},
			state: makeState(tempDir),
			config,
			asyncByDefault: false,
			tempArtifactsDir: tempDir,
			getSubagentSessionRoot: () => tempDir,
			expandTilde: (p: string) => p,
			discoverAgents: discoverAgentsImpl,
		}), { eventsApi });
	}

	function readCallArgs(): string[] {
		const callFile = fs.readdirSync(mockPi.dir)
			.filter((name) => name.startsWith("call-") && name.endsWith(".json"))
			.sort()
			.at(-1);
		assert.ok(callFile, "expected a recorded mock pi call");
		return readRecordedArgs(callFile);
	}

	function readAllCallArgs(): string[][] {
		return fs.readdirSync(mockPi.dir)
			.filter((name) => name.startsWith("call-") && name.endsWith(".json"))
			.sort()
			.map(readRecordedArgs);
	}

	function readRecordedArgs(callFile: string): string[] {
		const payload = JSON.parse(fs.readFileSync(path.join(mockPi.dir, callFile), "utf-8"));
		assert.equal(typeof payload, "object", "expected recorded args payload");
		assert.notEqual(payload, null, "expected recorded args payload");
		assert.ok("args" in payload, "expected recorded args payload");
		assert.ok(Array.isArray(payload.args), "expected recorded args");
		return payload.args;
	}

	function readSessionArgsFromCalls(): string[] {
		return readAllCallArgs()
			.map((args) => {
				const sessionIndex = args.indexOf("--session");
				if (sessionIndex === -1) return undefined;
				const sessionFile = args[sessionIndex + 1];
				assert.ok(sessionFile, "expected a session file after --session");
				return sessionFile;
			})
			.filter((sessionFile): sessionFile is string => Boolean(sessionFile));
	}

	function makeForkingSessionManagerRecorder(options: { sessionFile: string; leafId: string }) {
		const openedPaths: string[] = [];
		const branchedLeafIds: string[] = [];
		let counter = 0;
		fs.mkdirSync(path.dirname(options.sessionFile), { recursive: true });
		fs.writeFileSync(options.sessionFile, '{"type":"session","version":1,"id":"parent","timestamp":"2026-04-16T00:00:00.000Z","cwd":"/tmp"}\n', "utf-8");
		const manager = {
			getSessionId: () => "session-123",
			getSessionFile: () => options.sessionFile,
			getLeafId: () => options.leafId,
			constructor: {
				open: (sessionFile: string) => {
					openedPaths.push(sessionFile);
					return {
						createBranchedSession: (leafId: string) => {
							branchedLeafIds.push(leafId);
							counter++;
							const childSessionFile = path.join(tempDir, `fork-${counter}.jsonl`);
							fs.writeFileSync(childSessionFile, '{"type":"session","version":1,"id":"child","timestamp":"2026-04-16T00:00:00.000Z","cwd":"/tmp"}\n', "utf-8");
							return childSessionFile;
						},
					};
				},
			},
		};
		return { manager, openedPaths, branchedLeafIds };
	}

	function writeAgent(projectRoot: string, name: string, model: string): void {
		const filePath = path.join(projectRoot, ".pi", "agents", `${name}.md`);
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(
			filePath,
			`---\nname: ${name}\ndescription: ${name} agent\nmodel: ${model}\n---\n\nUse ${model}.\n`,
			"utf-8",
		);
	}

	function writeProjectOverride(projectRoot: string, agentName: string, model: string): void {
		const settingsPath = path.join(projectRoot, ".pi", "settings.json");
		fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
		fs.writeFileSync(
			settingsPath,
			JSON.stringify({ subagents: { agentOverrides: { [agentName]: { model } } } }, null, 2),
			"utf-8",
		);
	}

	function writePackageSkill(packageRoot: string, skillName: string): void {
		const skillDir = path.join(packageRoot, "skills", skillName);
		fs.mkdirSync(skillDir, { recursive: true });
		fs.writeFileSync(
			path.join(packageRoot, "package.json"),
			JSON.stringify({ name: `${skillName}-pkg`, version: "1.0.0", pi: { skills: [`./skills/${skillName}`] } }, null, 2),
			"utf-8",
		);
		fs.writeFileSync(
			path.join(skillDir, "SKILL.md"),
			`---\nname: ${skillName}\ndescription: test skill\n---\nbody\n`,
			"utf-8",
		);
	}

	function makeCtx(sessionManager: SessionManagerStub) {
		return {
			cwd: tempDir,
			hasUI: false,
			ui: {},
			modelRegistry: { getAvailable: () => [] },
			sessionManager,
		};
	}

	it("runs a single agent when task is omitted", async () => {
		const { manager } = makeSessionManagerRecorder();
		const executor = makeExecutor();

		const result = await executor.execute(
			"id",
			{ agent: "echo" },
			new AbortController().signal,
			undefined,
			makeCtx(manager),
		);

		assert.equal(result.isError, undefined);
		const args = readCallArgs();
		assert.equal(args.at(-1), "Task: ");
	});

	it("does not treat top-level agent as single mode when tasks are present", async () => {
		const { manager } = makeSessionManagerRecorder();
		const executor = makeExecutor();

		const result = await executor.execute(
			"id",
			{ agent: "echo", tasks: [{ agent: "second", task: "parallel task" }] },
			new AbortController().signal,
			undefined,
			makeCtx(manager),
		);

		assert.equal(result.isError, undefined);
		const args = readCallArgs();
		assert.equal(args.at(-1), "Task: parallel task");
	});

	it("uses agent defaultContext fork when launch context is omitted", async () => {
		const parentSessionFile = path.join(tempDir, "parent.jsonl");
		const { manager, openedPaths, branchedLeafIds } = makeForkingSessionManagerRecorder({ sessionFile: parentSessionFile, leafId: "leaf-current" });
		const executor = makeExecutorWithDiscoverAgents(() => ({
			agents: [
				{ name: "worker", description: "Worker", defaultContext: "fork" },
			],
			projectAgentsDir: null,
		}));

		const result = await executor.execute(
			"id",
			{ agent: "worker", task: "test" },
			new AbortController().signal,
			undefined,
			makeCtx(manager),
		);

		assert.equal(result.isError, undefined);
		assert.equal(result.details?.context, "fork");
		assert.deepEqual(openedPaths, [parentSessionFile]);
		assert.deepEqual(branchedLeafIds, ["leaf-current"]);
		assert.deepEqual(readSessionArgsFromCalls(), [path.join(tempDir, "fork-1.jsonl")]);
	});

	it("keeps default-fork context on run-path errors", async () => {
		const parentSessionFile = path.join(tempDir, "parent.jsonl");
		const { manager } = makeForkingSessionManagerRecorder({ sessionFile: parentSessionFile, leafId: "leaf-current" });
		const executor = makeExecutorWithDiscoverAgents(() => ({
			agents: [
				{ name: "worker", description: "Worker", defaultContext: "fork" },
			],
			projectAgentsDir: null,
		}));

		const ctx = makeCtx(manager);
		ctx.modelRegistry.getAvailable = () => {
			throw new Error("model registry unavailable");
		};

		const result = await executor.execute(
			"id",
			{ agent: "worker" },
			new AbortController().signal,
			undefined,
			ctx,
		);

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /model registry unavailable/);
		assert.equal(result.details?.context, "fork");
	});

	it("keeps explicit fresh context over agent defaultContext fork", async () => {
		const parentSessionFile = path.join(tempDir, "parent.jsonl");
		const { manager, openedPaths, branchedLeafIds } = makeForkingSessionManagerRecorder({ sessionFile: parentSessionFile, leafId: "leaf-current" });
		const executor = makeExecutorWithDiscoverAgents(() => ({
			agents: [
				{ name: "oracle", description: "Oracle", defaultContext: "fork" },
			],
			projectAgentsDir: null,
		}));

		const result = await executor.execute(
			"id",
			{ agent: "oracle", task: "test", context: "fresh" },
			new AbortController().signal,
			undefined,
			makeCtx(manager),
		);

		assert.equal(result.isError, undefined);
		assert.equal(result.details?.context, undefined);
		assert.deepEqual(openedPaths, []);
		assert.deepEqual(branchedLeafIds, []);
		assert.notEqual(readSessionArgsFromCalls()[0], path.join(tempDir, "fork-1.jsonl"));
	});

	it("uses agent defaultContext fork for top-level parallel when launch context is omitted", async () => {
		const parentSessionFile = path.join(tempDir, "parent.jsonl");
		const { manager } = makeForkingSessionManagerRecorder({ sessionFile: parentSessionFile, leafId: "leaf-current" });
		const executor = makeExecutorWithDiscoverAgents(() => ({
			agents: [
				{ name: "worker", description: "Worker", defaultContext: "fork" },
				{ name: "second", description: "Second" },
			],
			projectAgentsDir: null,
		}));

		const result = await executor.execute(
			"id",
			{ tasks: [{ agent: "worker", task: "one" }, { agent: "second", task: "two" }] },
			new AbortController().signal,
			undefined,
			makeCtx(manager),
		);

		assert.equal(result.isError, undefined);
		assert.equal(result.details?.context, "fork");
		assert.deepEqual(readSessionArgsFromCalls().sort(), [path.join(tempDir, "fork-1.jsonl"), path.join(tempDir, "fork-2.jsonl")]);
	});

	it("keeps explicit fresh context over top-level parallel agent defaultContext fork", async () => {
		const parentSessionFile = path.join(tempDir, "parent.jsonl");
		const { manager, openedPaths } = makeForkingSessionManagerRecorder({ sessionFile: parentSessionFile, leafId: "leaf-current" });
		const executor = makeExecutorWithDiscoverAgents(() => ({
			agents: [
				{ name: "worker", description: "Worker", defaultContext: "fork" },
				{ name: "second", description: "Second" },
			],
			projectAgentsDir: null,
		}));

		const result = await executor.execute(
			"id",
			{ tasks: [{ agent: "worker", task: "one" }, { agent: "second", task: "two" }], context: "fresh" },
			new AbortController().signal,
			undefined,
			makeCtx(manager),
		);

		assert.equal(result.isError, undefined);
		assert.equal(result.details?.context, undefined);
		assert.deepEqual(openedPaths, []);
	});

	it("uses agent defaultContext fork for chain runs when launch context is omitted", async () => {
		const parentSessionFile = path.join(tempDir, "parent.jsonl");
		const { manager } = makeForkingSessionManagerRecorder({ sessionFile: parentSessionFile, leafId: "leaf-current" });
		const executor = makeExecutorWithDiscoverAgents(() => ({
			agents: [
				{ name: "echo", description: "Echo" },
				{ name: "worker", description: "Worker", defaultContext: "fork" },
			],
			projectAgentsDir: null,
		}));

		const result = await executor.execute(
			"id",
			{ chain: [{ agent: "echo", task: "scan" }, { agent: "worker", task: "write" }], clarify: false },
			new AbortController().signal,
			undefined,
			makeCtx(manager),
		);

		assert.equal(result.isError, undefined);
		assert.equal(result.details?.context, "fork");
		assert.deepEqual(readSessionArgsFromCalls(), [path.join(tempDir, "fork-1.jsonl"), path.join(tempDir, "fork-2.jsonl")]);
	});

	it("reports unknown top-level parallel agents before default-fork preconditions", async () => {
		const { manager } = makeSessionManagerRecorder({ sessionFile: undefined, leafId: "leaf-current" });
		const executor = makeExecutorWithDiscoverAgents(() => ({
			agents: [{ name: "worker", description: "Worker", defaultContext: "fork" }],
			projectAgentsDir: null,
		}));

		const result = await executor.execute(
			"id",
			{ tasks: [{ agent: "worker", task: "one" }, { agent: "missing", task: "two" }] },
			new AbortController().signal,
			undefined,
			makeCtx(manager),
		);

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /Unknown agent: missing/);
		assert.doesNotMatch(result.content[0]?.text ?? "", /persisted parent session/);
	});

	it("fails fast when context=fork and parent session is missing", async () => {
		const { manager } = makeSessionManagerRecorder({ sessionFile: undefined, leafId: "leaf-current" });
		const executor = makeExecutor();

		const result = await executor.execute(
			"id",
			{ agent: "echo", task: "test", context: "fork" },
			new AbortController().signal,
			undefined,
			makeCtx(manager),
		);

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /persisted parent session/);
	});

	it("fails fast when context=fork and leaf is missing", async () => {
		const { manager } = makeSessionManagerRecorder({ sessionFile: "/tmp/parent.jsonl", leafId: null });
		const executor = makeExecutor();

		const result = await executor.execute(
			"id",
			{ agent: "echo", task: "test", context: "fork" },
			new AbortController().signal,
			undefined,
			makeCtx(manager),
		);

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /current leaf/);
	});

	it("returns a tool error (instead of throwing) when branch creation fails", async () => {
		const executor = makeExecutor();
		const manager = {
			getSessionId: () => "session-123",
			getSessionFile: () => path.join(tempDir, "parent.jsonl"),
			getLeafId: () => "leaf-fail",
			constructor: {
				open: () => ({
					createBranchedSession: () => {
						throw new Error("branch write failed");
					},
				}),
			},
		};

		const result = await executor.execute(
			"id",
			{ agent: "echo", task: "test", context: "fork" },
			new AbortController().signal,
			undefined,
			makeCtx(manager),
		);

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /Failed to create forked subagent session/);
		assert.match(result.content[0]?.text ?? "", /branch write failed/);
	});

	it("creates one forked session for single mode", async () => {
		const { manager, openedPaths, branchedLeafIds } = makeForkingSessionManagerRecorder({
			sessionFile: path.join(tempDir, "parent.jsonl"),
			leafId: "leaf-123",
		});
		const executor = makeExecutor();

		const result = await executor.execute(
			"id",
			{ agent: "echo", task: "single task", context: "fork" },
			new AbortController().signal,
			undefined,
			makeCtx(manager),
		);

		assert.equal(result.isError, undefined);
		assert.deepEqual(openedPaths, [path.join(tempDir, "parent.jsonl")]);
		assert.deepEqual(branchedLeafIds, ["leaf-123"]);
		const args = readCallArgs();
		const sessionIndex = args.indexOf("--session");
		assert.notEqual(sessionIndex, -1);
		assert.notEqual(args[sessionIndex + 1], path.join(tempDir, "parent.jsonl"));
		assert.ok(args[sessionIndex + 1]);
		assert.equal(fs.existsSync(args[sessionIndex + 1]!), true);
	});

	it("creates isolated forked sessions per parallel task", async () => {
		const { manager, openedPaths, branchedLeafIds } = makeForkingSessionManagerRecorder({
			sessionFile: path.join(tempDir, "parent-parallel.jsonl"),
			leafId: "leaf-777",
		});
		const executor = makeExecutor();

		const result = await executor.execute(
			"id",
			{
				tasks: [
					{ agent: "echo", task: "task one" },
					{ agent: "second", task: "task two" },
				],
				context: "fork",
			},
			new AbortController().signal,
			undefined,
			makeCtx(manager),
		);

		assert.equal(result.isError, undefined);
		assert.deepEqual(openedPaths, [path.join(tempDir, "parent-parallel.jsonl"), path.join(tempDir, "parent-parallel.jsonl")]);
		assert.deepEqual(branchedLeafIds, ["leaf-777", "leaf-777"]);
		const sessionArgs = readSessionArgsFromCalls();
		assert.equal(sessionArgs.length, 2);
		assert.equal(new Set(sessionArgs).size, 2);
		for (const childSessionFile of sessionArgs) {
			assert.notEqual(childSessionFile, path.join(tempDir, "parent-parallel.jsonl"));
			assert.equal(fs.existsSync(childSessionFile), true);
		}
	});

	it("expands top-level parallel task counts before fork session allocation", async () => {
		const { manager, openedPaths, branchedLeafIds } = makeForkingSessionManagerRecorder({
			sessionFile: path.join(tempDir, "parent-count.jsonl"),
			leafId: "leaf-count",
		});
		const executor = makeExecutor();

		const result = await executor.execute(
			"id",
			{
				tasks: [{ agent: "echo", task: "task one", count: 3 }],
				context: "fork",
			},
			new AbortController().signal,
			undefined,
			makeCtx(manager),
		);

		assert.equal(result.isError, undefined);
		assert.deepEqual(openedPaths, [
			path.join(tempDir, "parent-count.jsonl"),
			path.join(tempDir, "parent-count.jsonl"),
			path.join(tempDir, "parent-count.jsonl"),
		]);
		assert.deepEqual(branchedLeafIds, ["leaf-count", "leaf-count", "leaf-count"]);
		const sessionArgs = readSessionArgsFromCalls();
		assert.equal(sessionArgs.length, 3);
		assert.equal(new Set(sessionArgs).size, 3);
	});

	it("rejects top-level parallel worktree runs with a conflicting task cwd", async () => {
		const { manager } = makeSessionManagerRecorder({ sessionFile: "/tmp/parent.jsonl", leafId: "leaf-777" });
		const executor = makeExecutor();

		const result = await executor.execute(
			"id",
			{
				tasks: [
					{ agent: "echo", task: "task one" },
					{ agent: "second", task: "task two", cwd: `${tempDir}/other` },
				],
				worktree: true,
			},
			new AbortController().signal,
			undefined,
			makeCtx(manager),
		);

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /worktree isolation uses the shared cwd/i);
		assert.match(result.content[0]?.text ?? "", /task 2 \(second\) sets cwd/i);
	});

	it("rejects top-level parallel counts that expand past MAX_PARALLEL", async () => {
		const { manager } = makeSessionManagerRecorder({ sessionFile: "/tmp/parent.jsonl", leafId: "leaf-max" });
		const executor = makeExecutor();

		const result = await executor.execute(
			"id",
			{
				tasks: [{ agent: "echo", task: "task one", count: 9 }],
			},
			new AbortController().signal,
			undefined,
			makeCtx(manager),
		);

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /Max 8 tasks/);
	});

	it("uses top-level parallel config overrides for maxTasks and concurrency", async () => {
		const { manager } = makeSessionManagerRecorder({ sessionFile: "/tmp/parent.jsonl", leafId: "leaf-max-config" });
		const maxTasksExecutor = makeExecutorWithConfig({ parallel: { maxTasks: 9 } });

		const maxTasksResult = await maxTasksExecutor.execute(
			"id",
			{
				tasks: [{ agent: "echo", task: "task one", count: 9 }],
			},
			new AbortController().signal,
			undefined,
			makeCtx(manager),
		);

		assert.equal(maxTasksResult.isError, undefined);
		assert.equal(mockPi.callCount(), 9);

		for (const testCase of [
			{ name: "config", configConcurrency: 2, paramsConcurrency: undefined, expectedMaxRunning: 2 },
			{ name: "per-call", configConcurrency: 3, paramsConcurrency: 1, expectedMaxRunning: 1 },
		]) {
			mockPi.reset();
			for (let i = 0; i < 3; i++) {
				mockPi.onCall({
					steps: [
						{ jsonl: [events.toolStart("bash", { command: `${testCase.name}-${i}` })] },
						{ delay: 250 },
						{ jsonl: [events.toolEnd("bash"), events.assistantMessage(`done-${i}`)] },
					],
				});
			}

			const executor = makeExecutorWithConfig({ parallel: { concurrency: testCase.configConcurrency } });
			let maxRunning = 0;

			const result = await executor.execute(
				"id",
				{
					tasks: [
						{ agent: "echo", task: "task one" },
						{ agent: "second", task: "task two" },
						{ agent: "echo", task: "task three" },
					],
					...(testCase.paramsConcurrency ? { concurrency: testCase.paramsConcurrency } : {}),
				},
				new AbortController().signal,
				(update: ProgressUpdate) => {
					const progress = update.details?.progress ?? [];
					const running = progress.filter((entry) => entry.status === "running").length;
					maxRunning = Math.max(maxRunning, running);
				},
				makeCtx(makeSessionManagerRecorder().manager),
			);

			assert.equal(result.isError, undefined, testCase.name);
			assert.equal(maxRunning, testCase.expectedMaxRunning, testCase.name);
		}
	});

	it("detaches parallel child runs cleanly on intercom handoff", async () => {
		mockPi.reset();
		mockPi.onCall({
			steps: [
				{ jsonl: [events.toolStart("intercom", { action: "send", to: "orchestrator" })] },
				{ delay: 1000, jsonl: [events.assistantMessage("after handoff")] },
			],
		});
		mockPi.onCall({ output: "other done" });
		const executor = makeExecutorWithDiscoverAgents(() => ({
			agents: [
				{ name: "echo", description: "Echo", systemPrompt: "Intercom orchestration channel:" },
				{ name: "second", description: "Second", systemPrompt: "Intercom orchestration channel:" },
			],
			projectAgentsDir: null,
		}));
		let detachEmitted = false;
		const result = await executor.execute(
			"intercom-parallel",
			{
				tasks: [
					{ agent: "echo", task: "send handoff" },
					{ agent: "second", task: "continue" },
				],
			},
			new AbortController().signal,
			(update: ProgressUpdate) => {
				if (detachEmitted) return;
				if (!update.details?.progress?.some((entry) => entry.currentTool === "intercom")) return;
				detachEmitted = true;
				executor.eventsApi.emit(INTERCOM_DETACH_REQUEST_EVENT, { requestId: "parallel-detach" });
			},
			makeCtx(makeSessionManagerRecorder().manager),
		);

		assert.equal(result.isError, undefined);
		assert.equal(detachEmitted, true);
		assert.equal(result.details?.results?.some((entry) => entry.detached === true && entry.exitCode === 0), true);
	});

	it("runs top-level parallel async requests in the background", { skip: !asyncAvailable ? "jiti not available" : undefined }, async () => {
		const executor = makeExecutor();

		const result = await executor.execute(
			"id",
			{
				tasks: [
					{ agent: "echo", task: "task one" },
					{ agent: "second", task: "task two" },
				],
				async: true,
				clarify: false,
			},
			new AbortController().signal,
			undefined,
			makeCtx(makeSessionManagerRecorder().manager),
		);

		assert.equal(result.isError, undefined);
		assert.ok(result.details?.asyncId, "expected an asyncId for background top-level parallel runs");
		assert.match(result.content[0]?.text ?? "", /Async chain:/);
	});

	it("rejects invalid background top-level parallel requests during executor preflight", async () => {
		const executor = makeExecutor();
		for (const testCase of [
			{
				name: "max tasks",
				params: { tasks: [{ agent: "echo", task: "task one", count: 9 }], async: true, clarify: false },
				patterns: [/Max 8 tasks/],
			},
			{
				name: "worktree cwd conflict",
				params: {
					tasks: [
						{ agent: "echo", task: "task one" },
						{ agent: "second", task: "task two", cwd: `${tempDir}/other` },
					],
					worktree: true,
					async: true,
					clarify: false,
				},
				patterns: [/worktree isolation uses the shared cwd/i, /task 2 \(second\) sets cwd/i],
			},
		]) {
			const result = await executor.execute(
				"id",
				testCase.params,
				new AbortController().signal,
				undefined,
				makeCtx(makeSessionManagerRecorder().manager),
			);

			assert.equal(result.isError, true, testCase.name);
			for (const pattern of testCase.patterns) {
				assert.match(result.content[0]?.text ?? "", pattern, testCase.name);
			}
		}
	});

	it("rejects async chain worktree runs with a conflicting task cwd", async () => {
		const { manager } = makeSessionManagerRecorder({ sessionFile: "/tmp/parent.jsonl", leafId: "leaf-chain" });
		const executor = makeExecutor();

		const result = await executor.execute(
			"id",
			{
				chain: [
					{
						parallel: [
							{ agent: "echo", task: "p1" },
							{ agent: "second", task: "p2", cwd: `${tempDir}/other` },
						],
						worktree: true,
					},
				],
				async: true,
				clarify: false,
			},
			new AbortController().signal,
			undefined,
			makeCtx(manager),
		);

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /parallel chain step 1/i);
		assert.match(result.content[0]?.text ?? "", /task 2 \(second\) sets cwd/i);
	});

	it("creates isolated forked sessions per chain step (including counted parallel steps)", async () => {
		const { manager, openedPaths, branchedLeafIds } = makeForkingSessionManagerRecorder({
			sessionFile: path.join(tempDir, "parent-chain.jsonl"),
			leafId: "leaf-chain",
		});
		const executor = makeExecutor();

		const result = await executor.execute(
			"id",
			{
				chain: [
					{ agent: "echo", task: "step 1" },
					{ parallel: [{ agent: "echo", task: "p1", count: 2 }, { agent: "second", task: "p2", count: 2 }] },
					{ agent: "second", task: "step 3" },
				],
				context: "fork",
				clarify: false,
			},
			new AbortController().signal,
			undefined,
			makeCtx(manager),
		);

		assert.equal(result.isError, undefined);
		assert.deepEqual(openedPaths, Array(6).fill(path.join(tempDir, "parent-chain.jsonl")));
		assert.deepEqual(branchedLeafIds, Array(6).fill("leaf-chain"));
		const sessionArgs = readSessionArgsFromCalls();
		assert.equal(sessionArgs.length, 6, "1 sequential + 4 parallel + 1 sequential");
		assert.equal(new Set(sessionArgs).size, 6);
	});

	it("uses request cwd for management actions", async () => {
		const executor = makeExecutor();
		const worktreeDir = path.join(tempDir, "worktree");
		fs.mkdirSync(path.join(worktreeDir, ".pi"), { recursive: true });

		const result = await executor.execute(
			"id",
			{
				action: "create",
				cwd: "worktree",
				config: { name: "local-helper", description: "Local helper", scope: "project" },
			},
			new AbortController().signal,
			undefined,
			makeCtx(makeSessionManagerRecorder().manager),
		);

		assert.equal(result.isError, false);
		assert.equal(fs.existsSync(path.join(worktreeDir, ".pi", "agents", "local-helper.md")), true);
		assert.equal(fs.existsSync(path.join(tempDir, ".pi", "agents", "local-helper.md")), false);
	});

	it("uses request cwd for execution-time agent discovery", async () => {
		const worktreeDir = path.join(tempDir, "worktree");
		writeAgent(tempDir, "echo", "openai/gpt-5-main");
		writeAgent(worktreeDir, "echo", "anthropic/claude-haiku-4-5");
		const executor = makeExecutorWithDiscoverAgents(discoverAgents);

		const result = await executor.execute(
			"id",
			{ agent: "echo", task: "test", cwd: "worktree" },
			new AbortController().signal,
			undefined,
			makeCtx(makeSessionManagerRecorder().manager),
		);

		assert.equal(result.isError, undefined);
		const args = readCallArgs();
		const modelIndex = args.indexOf("--model");
		assert.notEqual(modelIndex, -1);
		assert.equal(args[modelIndex + 1], "anthropic/claude-haiku-4-5");
	});

	it("resolves parallel task cwd values relative to the request cwd", async () => {
		const worktreeDir = path.join(tempDir, "worktree");
		writePackageSkill(path.join(worktreeDir, "packages", "app"), "parallel-step-skill");
		const executor = makeExecutorWithDiscoverAgents(() => ({
			agents: [{ name: "echo", description: "Echo test agent", skills: ["parallel-step-skill"] }],
			projectAgentsDir: null,
		}));

		const result = await executor.execute(
			"id",
			{
				tasks: [{ agent: "echo", task: "test", cwd: "packages/app" }],
				cwd: worktreeDir,
			},
			new AbortController().signal,
			undefined,
			makeCtx(makeSessionManagerRecorder().manager),
		);

		assert.equal(result.isError, undefined);
		assert.deepEqual(result.details?.results?.[0]?.skills, ["parallel-step-skill"]);
	});

	it("uses request cwd for project builtin overrides during management", async () => {
		const tempHome = createTempDir("pi-subagent-home-");
		process.env.HOME = tempHome;
		process.env.USERPROFILE = tempHome;
		const worktreeDir = path.join(tempDir, "worktree");
		fs.mkdirSync(worktreeDir, { recursive: true });
		writeProjectOverride(tempDir, "reviewer", "openai/gpt-5-main");
		writeProjectOverride(worktreeDir, "reviewer", "openai/gpt-5-worktree");
		const executor = makeExecutor();

		try {
			const result = await executor.execute(
				"id",
				{ action: "get", agent: "reviewer", cwd: "worktree" },
				new AbortController().signal,
				undefined,
				makeCtx(makeSessionManagerRecorder().manager),
			);

			assert.equal(result.isError, false);
			assert.match(result.content[0]?.text ?? "", /Model: openai\/gpt-5-worktree/);
			assert.doesNotMatch(result.content[0]?.text ?? "", /Model: openai\/gpt-5-main/);
		} finally {
			removeTempDir(tempHome);
		}
	});
});
