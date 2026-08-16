import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import type { MockPi } from "../support/helpers.ts";
import { createEventBus, createMockPi, createTempDir, events, removeTempDir, tryImport } from "../support/helpers.ts";
import { discoverAgents } from "../../src/agents/agents.ts";
import { ACTIVE_ASYNC_CAPACITY_DIR, acquireActiveAsyncCapacity, activeAsyncCapacitySessionKey } from "../../src/runs/background/active-async-capacity.ts";
import { DEFAULT_FORK_PREAMBLE, INTERCOM_DETACH_REQUEST_EVENT, SUBAGENT_ASYNC_STARTED_EVENT } from "../../src/shared/types.ts";

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
				context?: "fresh" | "fork" | "mixed";
				mode?: "single" | "parallel" | "chain";
				asyncId?: string;
				results?: Array<{ context?: "fresh" | "fork"; detached?: boolean; exitCode?: number; skills?: string[] }>;
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

const executorMod = await tryImport<ExecutorModule>("./src/runs/foreground/subagent-executor.ts");
const asyncExecutionMod = await tryImport<AsyncExecutionModule>("./src/runs/background/async-execution.ts");
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
	openSession(sessionFile: string): { createBranchedSession(leafId: string): string | undefined };
}

function makeSessionManagerRecorder(options: SessionStubOptions = {}) {
	const manager: SessionManagerStub = {
		getSessionId: () => "session-123",
		getSessionFile: () => options.sessionFile,
		getLeafId: () => (options.leafId === undefined ? "leaf-current" : options.leafId),
		openSession: () => ({
			createBranchedSession: () => "/tmp/child.jsonl",
		}),
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

	function readCallArgsForTask(taskText: string): string[] {
		const args = readAllCallArgs().find((callArgs) => {
			const prompt = callArgs.at(-1) ?? "";
			return prompt.startsWith(`Task: ${taskText}\n`)
				|| prompt.includes(`\n\nTask:\n${taskText}\n`);
		});
		assert.ok(args, `expected a recorded mock pi call for task '${taskText}'`);
		return args;
	}

	function readSessionArg(args: string[]): string {
		const sessionIndex = args.indexOf("--session");
		assert.notEqual(sessionIndex, -1);
		const sessionFile = args[sessionIndex + 1];
		assert.ok(sessionFile, "expected a session file after --session");
		return sessionFile;
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
			openSession: (sessionFile: string) => {
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

	function makeSignedThinkingSessionManager(childSessionFile: string) {
		const parentSessionFile = path.join(tempDir, "parent.jsonl");
		fs.writeFileSync(parentSessionFile, '{"type":"session","version":1,"id":"parent","timestamp":"2026-04-16T00:00:00.000Z","cwd":"/tmp"}\n', "utf-8");
		return {
			getSessionId: () => "session-123",
			getSessionFile: () => parentSessionFile,
			getLeafId: () => "assistant-1",
			openSession: () => ({
				createBranchedSession: () => {
					fs.writeFileSync(childSessionFile, [
						{ type: "session", version: 1, id: "child", timestamp: "2026-04-16T00:00:00.000Z", cwd: "/tmp", parentSession: parentSessionFile },
						{ type: "message", id: "assistant-1", parentId: null, timestamp: "2026-04-16T00:00:02.000Z", message: { role: "assistant", provider: "anthropic", api: "anthropic-messages", model: "anthropic/claude-sonnet-4-5", content: [{ type: "thinking", thinking: "private chain", thinkingSignature: "signed" }, { type: "text", text: "answer" }] } },
					].map((entry) => JSON.stringify(entry)).join("\n") + "\n", "utf-8");
					return childSessionFile;
				},
			}),
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
		assert.ok((args.at(-1) ?? "").startsWith("Task: \n\n## Acceptance Contract"));
	});



	it("falls back to fresh when an implicit default fork has no persisted parent session", async () => {
		const { manager } = makeSessionManagerRecorder({ sessionFile: undefined, leafId: "leaf-current" });
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
		assert.equal(result.details?.context, "fresh");
		assert.equal(result.details?.results?.[0]?.context, "fresh");
		assert.doesNotMatch(readCallArgs().at(-1) ?? "", /delegated subagent running from a fork/);
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

	it("uses global defaultSubagentContext fork for a fresh-default agent", async () => {
		const parentSessionFile = path.join(tempDir, "parent.jsonl");
		const { manager, openedPaths, branchedLeafIds } = makeForkingSessionManagerRecorder({ sessionFile: parentSessionFile, leafId: "leaf-current" });
		const executor = makeExecutorWithDiscoverAgents(() => ({
			agents: [
				{ name: "worker", description: "Worker", defaultContext: "fresh" },
			],
			projectAgentsDir: null,
		}), { defaultSubagentContext: "fork" });

		const result = await executor.execute(
			"id",
			{ agent: "worker", task: "test" },
			new AbortController().signal,
			undefined,
			makeCtx(manager),
		);

		assert.equal(result.isError, undefined);
		assert.equal(result.details?.context, "fork");
		assert.equal(result.details?.results?.[0]?.context, "fork");
		assert.deepEqual(openedPaths, [parentSessionFile]);
		assert.deepEqual(branchedLeafIds, ["leaf-current"]);
		assert.deepEqual(readSessionArgsFromCalls(), [path.join(tempDir, "fork-1.jsonl")]);
	});

	it("uses global defaultSubagentContext fresh for a fork-default agent", async () => {
		const parentSessionFile = path.join(tempDir, "parent.jsonl");
		const { manager, openedPaths } = makeForkingSessionManagerRecorder({ sessionFile: parentSessionFile, leafId: "leaf-current" });
		const executor = makeExecutorWithDiscoverAgents(() => ({
			agents: [
				{ name: "worker", description: "Worker", defaultContext: "fork" },
			],
			projectAgentsDir: null,
		}), { defaultSubagentContext: "fresh" });

		const result = await executor.execute(
			"id",
			{ agent: "worker", task: "test" },
			new AbortController().signal,
			undefined,
			makeCtx(manager),
		);

		assert.equal(result.isError, undefined);
		assert.equal(result.details?.context, "fresh");
		assert.equal(result.details?.results?.[0]?.context, "fresh");
		assert.deepEqual(openedPaths, []);
	});

	it("sanitizes inherited signed thinking and forces child thinking off", async () => {
		const parentSessionFile = path.join(tempDir, "parent.jsonl");
		const childSessionFile = path.join(tempDir, "fork-with-thinking.jsonl");
		fs.writeFileSync(parentSessionFile, '{"type":"session","version":1,"id":"parent","timestamp":"2026-04-16T00:00:00.000Z","cwd":"/tmp"}\n', "utf-8");
		const manager = {
			getSessionId: () => "session-123",
			getSessionFile: () => parentSessionFile,
			getLeafId: () => "assistant-1",
			openSession: () => ({
				createBranchedSession: () => {
					fs.writeFileSync(childSessionFile, [
						{ type: "session", version: 1, id: "child", timestamp: "2026-04-16T00:00:00.000Z", cwd: "/tmp", parentSession: parentSessionFile },
						{ type: "message", id: "user-1", parentId: null, timestamp: "2026-04-16T00:00:01.000Z", message: { role: "user", content: "prompt" } },
						{ type: "message", id: "assistant-1", parentId: "user-1", timestamp: "2026-04-16T00:00:02.000Z", message: { role: "assistant", provider: "anthropic", api: "anthropic-messages", model: "anthropic/claude-sonnet-4-5", content: [{ type: "thinking", thinking: "private chain", thinkingSignature: "signed" }, { type: "text", text: "answer" }] } },
					].map((entry) => JSON.stringify(entry)).join("\n") + "\n", "utf-8");
					return childSessionFile;
				},
			}),
		};
		const executor = makeExecutorWithDiscoverAgents(() => ({
			agents: [
				{ name: "worker", description: "Worker", defaultContext: "fork", model: "anthropic/claude-sonnet-4-5:high", thinking: "high" },
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
		const args = readCallArgs();
		assert.equal(args[args.indexOf("--model") + 1], "anthropic/claude-sonnet-4-5:off");
		const entries = fs.readFileSync(childSessionFile, "utf-8").trim().split("\n").map((line) => JSON.parse(line));
		assert.deepEqual(entries[2].message.content, [{ type: "text", text: "answer" }]);
		assert.equal(entries[3].type, "thinking_level_change");
		assert.equal(entries[3].thinkingLevel, "off");
	});

	it("forces every foreground fallback attempt off after sanitizing inherited signed thinking", async () => {
		mockPi.reset();
		mockPi.onCall({
			jsonl: [{
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "temporary provider failure" }],
					model: "openai/gpt-5-mini",
					errorMessage: "rate limit exceeded",
					usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
				},
			}],
			exitCode: 1,
		});
		mockPi.onCall({ output: "Recovered on fallback" });
		const parentSessionFile = path.join(tempDir, "parent.jsonl");
		const childSessionFile = path.join(tempDir, "fork-with-thinking.jsonl");
		fs.writeFileSync(parentSessionFile, '{"type":"session","version":1,"id":"parent","timestamp":"2026-04-16T00:00:00.000Z","cwd":"/tmp"}\n', "utf-8");
		const manager = {
			getSessionId: () => "session-123",
			getSessionFile: () => parentSessionFile,
			getLeafId: () => "assistant-1",
			openSession: () => ({
				createBranchedSession: () => {
					fs.writeFileSync(childSessionFile, [
						{ type: "session", version: 1, id: "child", timestamp: "2026-04-16T00:00:00.000Z", cwd: "/tmp", parentSession: parentSessionFile },
						{ type: "message", id: "assistant-1", parentId: null, timestamp: "2026-04-16T00:00:02.000Z", message: { role: "assistant", provider: "anthropic", api: "anthropic-messages", model: "anthropic/claude-sonnet-4-5", content: [{ type: "thinking", thinking: "private chain", thinkingSignature: "signed" }, { type: "text", text: "answer" }] } },
					].map((entry) => JSON.stringify(entry)).join("\n") + "\n", "utf-8");
					return childSessionFile;
				},
			}),
		};
		const executor = makeExecutorWithDiscoverAgents(() => ({
			agents: [
				{ name: "worker", description: "Worker", defaultContext: "fork", model: "openai/gpt-5-mini:high", fallbackModels: ["anthropic/claude-sonnet-4:low"], thinking: "high" },
			],
			projectAgentsDir: null,
		}));

		const ctx = {
			...makeCtx(manager),
			modelRegistry: {
				getAvailable: () => [
					{ provider: "openai", id: "gpt-5-mini", api: "openai-responses", reasoning: true },
					{ provider: "anthropic", id: "claude-sonnet-4", api: "anthropic-messages", reasoning: true },
				],
			},
		};
		const result = await executor.execute(
			"id",
			{ agent: "worker", task: "test" },
			new AbortController().signal,
			undefined,
			ctx,
		);

		assert.equal(result.isError, undefined);
		const modelArgs = readAllCallArgs().map((args) => args[args.indexOf("--model") + 1]);
		assert.deepEqual(modelArgs, ["openai/gpt-5-mini:off", "anthropic/claude-sonnet-4:off"]);
	});

	it("keeps requested thinking for non-Anthropic forked children without Anthropic fallbacks", async () => {
		mockPi.reset();
		mockPi.onCall({ output: "done" });
		const parentSessionFile = path.join(tempDir, "parent.jsonl");
		const childSessionFile = path.join(tempDir, "fork-keep-thinking.jsonl");
		fs.writeFileSync(parentSessionFile, '{"type":"session","version":1,"id":"parent","timestamp":"2026-04-16T00:00:00.000Z","cwd":"/tmp"}\n', "utf-8");
		const manager = {
			getSessionId: () => "session-123",
			getSessionFile: () => parentSessionFile,
			getLeafId: () => "assistant-1",
			openSession: () => ({
				createBranchedSession: () => {
					fs.writeFileSync(childSessionFile, [
						{ type: "session", version: 1, id: "child", timestamp: "2026-04-16T00:00:00.000Z", cwd: "/tmp", parentSession: parentSessionFile },
						{ type: "message", id: "assistant-1", parentId: null, timestamp: "2026-04-16T00:00:02.000Z", message: { role: "assistant", provider: "anthropic", api: "anthropic-messages", model: "anthropic/claude-sonnet-4-5", content: [{ type: "thinking", thinking: "private chain", thinkingSignature: "signed" }, { type: "text", text: "answer" }] } },
					].map((entry) => JSON.stringify(entry)).join("\n") + "\n", "utf-8");
					return childSessionFile;
				},
			}),
		};
		const executor = makeExecutorWithDiscoverAgents(() => ({
			agents: [
				{ name: "worker", description: "Worker", defaultContext: "fork", model: "openai/gpt-5-mini:high", thinking: "high" },
			],
			projectAgentsDir: null,
		}));

		const ctx = {
			...makeCtx(manager),
			modelRegistry: {
				getAvailable: () => [{ provider: "openai", id: "gpt-5-mini", api: "openai-responses", reasoning: true }],
			},
		};
		const result = await executor.execute(
			"id",
			{ agent: "worker", task: "test" },
			new AbortController().signal,
			undefined,
			ctx,
		);

		assert.equal(result.isError, undefined);
		const args = readCallArgs();
		assert.equal(args[args.indexOf("--model") + 1], "openai/gpt-5-mini:high");
		const entries = fs.readFileSync(childSessionFile, "utf-8").trim().split("\n").map((line) => JSON.parse(line));
		assert.deepEqual(entries[1].message.content, [{ type: "text", text: "answer" }]);
		assert.equal(entries.length, 2);
		const text = result.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
		assert.equal(text.includes("fork context forced thinking off"), false);
	});

	it("keeps inherited model-scope violations as warnings in fork mode", async () => {
		const childSessionFile = path.join(tempDir, "fork-model-scope-warning.jsonl");
		const manager = makeSignedThinkingSessionManager(childSessionFile);
		const executor = makeExecutorWithDiscoverAgents(() => ({
			agents: [
				{ name: "worker", description: "Worker", defaultContext: "fork", model: "openai/gpt-5-mini:high", thinking: "high" },
			],
			projectAgentsDir: null,
			modelScope: { enforce: true, allow: ["anthropic/*"] },
		}));
		const ctx = {
			...makeCtx(manager),
			modelRegistry: {
				getAvailable: () => [{ provider: "openai", id: "gpt-5-mini", api: "openai-responses", reasoning: true }],
			},
		};
		const warnings: string[] = [];
		const originalWarn = console.warn;
		console.warn = (message?: unknown) => warnings.push(String(message));
		try {
			const result = await executor.execute(
				"id",
				{ agent: "worker", task: "test" },
				new AbortController().signal,
				undefined,
				ctx,
			);

			assert.equal(result.isError, undefined);
			assert.equal(warnings.length, 1);
			assert.match(warnings[0]!, /outside the configured subagent model scope/);
			const args = readCallArgs();
			assert.equal(args[args.indexOf("--model") + 1], "openai/gpt-5-mini:high");
		} finally {
			console.warn = originalWarn;
		}
	});

	it("warns when empty inheritance falls back to an out-of-scope agent model", async () => {
		const childSessionFile = path.join(tempDir, "fork-empty-model-scope-warning.jsonl");
		const manager = makeSignedThinkingSessionManager(childSessionFile);
		const executor = makeExecutorWithDiscoverAgents(() => ({
			agents: [
				{ name: "worker", description: "Worker", defaultContext: "fork", model: "openai/gpt-5-mini", thinking: "high" },
			],
			projectAgentsDir: null,
			modelScope: { enforce: true, allow: ["anthropic/*"] },
		}));
		const ctx = {
			...makeCtx(manager),
			modelRegistry: {
				getAvailable: () => [{ provider: "openai", id: "gpt-5-mini", api: "openai-responses", reasoning: true }],
			},
		};
		const warnings: string[] = [];
		const originalWarn = console.warn;
		console.warn = (message?: unknown) => warnings.push(String(message));
		try {
			for (const model of ["", "inherit"]) {
				const result = await executor.execute(
					"id",
					{ agent: "worker", task: "test", model },
					new AbortController().signal,
					undefined,
					ctx,
				);
				assert.equal(result.isError, undefined);
			}

			assert.equal(warnings.length, 2);
			assert.equal(warnings.every((warning) => warning.includes("outside the configured subagent model scope")), true);
			for (const args of readAllCallArgs()) {
				assert.equal(args[args.indexOf("--model") + 1], "openai/gpt-5-mini:high");
			}
		} finally {
			console.warn = originalWarn;
		}
	});

	it("notes the forced thinking downgrade in the result for Anthropic forked children", async () => {
		mockPi.reset();
		mockPi.onCall({ output: "done" });
		const parentSessionFile = path.join(tempDir, "parent.jsonl");
		const childSessionFile = path.join(tempDir, "fork-note-downgrade.jsonl");
		fs.writeFileSync(parentSessionFile, '{"type":"session","version":1,"id":"parent","timestamp":"2026-04-16T00:00:00.000Z","cwd":"/tmp"}\n', "utf-8");
		const manager = {
			getSessionId: () => "session-123",
			getSessionFile: () => parentSessionFile,
			getLeafId: () => "assistant-1",
			openSession: () => ({
				createBranchedSession: () => {
					fs.writeFileSync(childSessionFile, [
						{ type: "session", version: 1, id: "child", timestamp: "2026-04-16T00:00:00.000Z", cwd: "/tmp", parentSession: parentSessionFile },
						{ type: "message", id: "assistant-1", parentId: null, timestamp: "2026-04-16T00:00:02.000Z", message: { role: "assistant", provider: "anthropic", api: "anthropic-messages", model: "anthropic/claude-sonnet-4-5", content: [{ type: "thinking", thinking: "private chain", thinkingSignature: "signed" }, { type: "text", text: "answer" }] } },
					].map((entry) => JSON.stringify(entry)).join("\n") + "\n", "utf-8");
					return childSessionFile;
				},
			}),
		};
		const executor = makeExecutorWithDiscoverAgents(() => ({
			agents: [
				{ name: "worker", description: "Worker", defaultContext: "fork", model: "anthropic/claude-sonnet-4-5:high", thinking: "high" },
			],
			projectAgentsDir: null,
		}));

		const ctx = {
			...makeCtx(manager),
			modelRegistry: {
				getAvailable: () => [{ provider: "anthropic", id: "claude-sonnet-4-5", api: "anthropic-messages", reasoning: true }],
			},
		};
		const result = await executor.execute(
			"id",
			{ agent: "worker", task: "test" },
			new AbortController().signal,
			undefined,
			ctx,
		);

		assert.equal(result.isError, undefined);
		const text = result.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
		assert.equal(text.includes("fork context forced thinking off for worker (child 0)"), true);
	});

	it("resolves inherit before classifying a forked child", async () => {
		const childSessionFile = path.join(tempDir, "fork-inherit-thinking.jsonl");
		const manager = makeSignedThinkingSessionManager(childSessionFile);
		const executor = makeExecutorWithDiscoverAgents(() => ({
			agents: [
				{ name: "worker", description: "Worker", defaultContext: "fork", thinking: "high" },
			],
			projectAgentsDir: null,
		}));
		const ctx = {
			...makeCtx(manager),
			model: { provider: "anthropic", id: "claude-sonnet-4-5" },
			modelRegistry: {
				getAvailable: () => [{ provider: "anthropic", id: "claude-sonnet-4-5", api: "anthropic-messages", reasoning: true }],
			},
		};

		const result = await executor.execute(
			"id",
			{ agent: "worker", task: "test", model: "inherit" },
			new AbortController().signal,
			undefined,
			ctx,
		);

		assert.equal(result.isError, undefined);
		const args = readCallArgs();
		assert.equal(args[args.indexOf("--model") + 1], "anthropic/claude-sonnet-4-5:off");
	});







	it("includes the fork-thinking downgrade note on failed results", async () => {
		mockPi.reset();
		mockPi.onCall({ stderr: "task failed", exitCode: 1 });
		const childSessionFile = path.join(tempDir, "fork-failed-thinking.jsonl");
		const manager = makeSignedThinkingSessionManager(childSessionFile);
		const executor = makeExecutorWithDiscoverAgents(() => ({
			agents: [
				{ name: "worker", description: "Worker", defaultContext: "fork", model: "anthropic/claude-sonnet-4-5:high", thinking: "high" },
			],
			projectAgentsDir: null,
		}));
		const ctx = {
			...makeCtx(manager),
			modelRegistry: {
				getAvailable: () => [{ provider: "anthropic", id: "claude-sonnet-4-5", api: "anthropic-messages", reasoning: true }],
			},
		};

		const result = await executor.execute(
			"id",
			{ agent: "worker", task: "test" },
			new AbortController().signal,
			undefined,
			ctx,
		);

		assert.equal(result.isError, true);
		const text = result.content.filter((block) => block.text).map((block) => block.text).join("\n");
		assert.equal(text.includes("fork context forced thinking off for worker (child 0)"), true);
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
		assert.equal(result.details?.context, "fresh");
		assert.equal(result.details?.results?.[0]?.context, "fresh");
		assert.deepEqual(openedPaths, []);
		assert.deepEqual(branchedLeafIds, []);
		assert.notEqual(readSessionArgsFromCalls()[0], path.join(tempDir, "fork-1.jsonl"));
	});







	it("fails before launching mixed parallel children when a default-fork session cannot branch", async () => {
		const parentSessionFile = path.join(tempDir, "parent-mixed-fail.jsonl");
		fs.writeFileSync(parentSessionFile, '{"type":"session","version":1,"id":"parent","timestamp":"2026-04-16T00:00:00.000Z","cwd":"/tmp"}\n', "utf-8");
		const manager = {
			getSessionId: () => "session-123",
			getSessionFile: () => parentSessionFile,
			getLeafId: () => "leaf-fail",
			openSession: () => ({
				createBranchedSession: () => {
					throw new Error("branch write failed");
				},
			}),
		};
		const executor = makeExecutorWithDiscoverAgents(() => ({
			agents: [
				{ name: "scout", description: "Scout", defaultContext: "fresh" },
				{ name: "worker", description: "Worker", defaultContext: "fork" },
			],
			projectAgentsDir: null,
		}));

		const result = await executor.execute(
			"id",
			{ tasks: [{ agent: "scout", task: "scan" }, { agent: "worker", task: "write" }] },
			new AbortController().signal,
			undefined,
			makeCtx(manager),
		);

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /Failed to create forked subagent session/);
		assert.match(result.content[0]?.text ?? "", /branch write failed/);
		assert.equal(mockPi.callCount(), 0);
	});

	it("preflights static default-fork chain steps even when the chain also has dynamic fanout", async () => {
		const parentSessionFile = path.join(tempDir, "parent-dynamic-chain-fail.jsonl");
		fs.writeFileSync(parentSessionFile, '{"type":"session","version":1,"id":"parent","timestamp":"2026-04-16T00:00:00.000Z","cwd":"/tmp"}\n', "utf-8");
		const manager = {
			getSessionId: () => "session-123",
			getSessionFile: () => parentSessionFile,
			getLeafId: () => "leaf-fail",
			openSession: () => ({
				createBranchedSession: () => {
					throw new Error("branch write failed");
				},
			}),
		};
		const executor = makeExecutorWithDiscoverAgents(() => ({
			agents: [
				{ name: "scout", description: "Scout", defaultContext: "fresh" },
				{ name: "worker", description: "Worker", defaultContext: "fork" },
			],
			projectAgentsDir: null,
		}));

		const result = await executor.execute(
			"id",
			{
				chain: [
					{ agent: "scout", task: "scan" },
					{ agent: "worker", task: "write" },
					{
						expand: { from: { output: "items", path: "$" } },
						parallel: { agent: "scout", task: "inspect item" },
						collect: { as: "inspections" },
					},
				],
				clarify: false,
			},
			new AbortController().signal,
			undefined,
			makeCtx(manager),
		);

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /Failed to create forked subagent session/);
		assert.match(result.content[0]?.text ?? "", /branch write failed/);
		assert.equal(mockPi.callCount(), 0);
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

	it("falls back to fresh when an implicit default fork has a session path that is not persisted yet", async () => {
		const parentSessionFile = path.join(tempDir, "unpersisted-parent.jsonl");
		const { manager } = makeSessionManagerRecorder({ sessionFile: parentSessionFile, leafId: "leaf-current" });
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
		assert.equal(result.details?.context, "fresh");
		assert.equal(result.details?.results?.[0]?.context, "fresh");
		assert.doesNotMatch(readCallArgs().at(-1) ?? "", /delegated subagent running from a fork/);
	});

	it("falls back to fresh when an implicit default fork has no current leaf", async () => {
		const parentSessionFile = path.join(tempDir, "parent-no-leaf.jsonl");
		fs.writeFileSync(parentSessionFile, '{"type":"session","version":1,"id":"parent","timestamp":"2026-04-16T00:00:00.000Z","cwd":"/tmp"}\n', "utf-8");
		const { manager } = makeSessionManagerRecorder({ sessionFile: parentSessionFile, leafId: null });
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
		assert.equal(result.details?.context, "fresh");
		assert.equal(result.details?.results?.[0]?.context, "fresh");
		assert.doesNotMatch(readCallArgs().at(-1) ?? "", /delegated subagent running from a fork/);
	});

	it("keeps explicit fork fail-fast even when the agent defaults to fork", async () => {
		const { manager } = makeSessionManagerRecorder({ sessionFile: undefined, leafId: "leaf-current" });
		const executor = makeExecutorWithDiscoverAgents(() => ({
			agents: [
				{ name: "worker", description: "Worker", defaultContext: "fork" },
			],
			projectAgentsDir: null,
		}));

		const result = await executor.execute(
			"id",
			{ agent: "worker", task: "test", context: "fork" },
			new AbortController().signal,
			undefined,
			makeCtx(manager),
		);

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /persisted parent session/);
		assert.equal(mockPi.callCount(), 0);
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
		const parentSessionFile = path.join(tempDir, "parent.jsonl");
		fs.writeFileSync(parentSessionFile, '{"type":"session","version":1,"id":"parent","timestamp":"2026-04-16T00:00:00.000Z","cwd":"/tmp"}\n', "utf-8");
		const manager = {
			getSessionId: () => "session-123",
			getSessionFile: () => parentSessionFile,
			getLeafId: () => "leaf-fail",
			openSession: () => ({
				createBranchedSession: () => {
					throw new Error("branch write failed");
				},
			}),
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
		const task = `test ${path.basename(tempDir)}`;

		const result = await executor.execute(
			"id",
			{ agent: "echo", task, cwd: "worktree" },
			new AbortController().signal,
			undefined,
			makeCtx(makeSessionManagerRecorder().manager),
		);

		assert.equal(result.isError, undefined);
		const args = readAllCallArgs().find((callArgs) => (callArgs.at(-1) ?? "").startsWith(`Task: ${task}\n\n## Acceptance Contract`));
		assert.ok(args, "expected a recorded mock pi call for this test task");
		const modelIndex = args.indexOf("--model");
		assert.notEqual(modelIndex, -1);
		assert.equal(args[modelIndex + 1], "anthropic/claude-haiku-4-5");
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
