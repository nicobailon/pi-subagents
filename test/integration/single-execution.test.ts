/**
 * Integration tests for single (sync) agent execution.
 *
 * Uses the local createMockPi() helper to simulate the pi CLI.
 * Tests the full spawn→parse→result pipeline in runSync without a real LLM.
 *
 * These tests require pi packages to be importable (they run inside a pi
 * environment or with pi packages installed). If unavailable, tests skip
 * gracefully.
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import type { MockPi } from "../support/helpers.ts";
import {
	createMockPi,
	createTempDir,
	createEventBus,
	removeTempDir,
	makeAgentConfigs,
	makeAgent,
	makeMinimalCtx,
	events,
	tryImport,
} from "../support/helpers.ts";
import registerSubagentExtension from "../../src/extension/index.ts";
import {
	SUBAGENT_DELEGATION_REQUEST_EVENT,
	SUBAGENT_DELEGATION_RESPONSE_EVENT,
	SUBAGENT_DELEGATION_STARTED_EVENT,
	type SubagentDelegationRequest,
	type SubagentDelegationResponse,
	type SubagentDelegationStarted,
} from "../../src/api/delegation.ts";
import { CHAIN_RUNS_DIR, DIRS, INTERCOM_DETACH_REQUEST_EVENT, INTERCOM_DETACH_RESPONSE_EVENT, type AsyncStatus, type SubagentState } from "../../src/shared/types.ts";
import { CHILD_WATCHDOG_STATUS_EVENT } from "../../src/watchdog/child-status.ts";
import { WAIT_TOOL_ENABLED_ENV } from "../../src/runs/background/wait-config.ts";
import { TOOL_BUDGET_ENV, TOOL_BUDGET_ZERO_AUTH_ENV } from "../../src/runs/shared/tool-budget.ts";
import { MainWatchdogRuntime } from "../../src/watchdog/runtime.ts";
import { MAX_CHILD_PENDING_LINE_BYTES, MAX_CHILD_STDERR_BYTES } from "../../src/runs/shared/child-protocol.ts";
import {
	SUBAGENT_FANOUT_CHILD_ENV,
	SUBAGENT_PARENT_CHILD_INDEX_ENV,
	SUBAGENT_PARENT_CONTROL_INBOX_ENV,
	SUBAGENT_PARENT_DEPTH_ENV,
	SUBAGENT_PARENT_EVENT_SINK_ENV,
	SUBAGENT_PARENT_RUN_ID_ENV,
} from "../../src/runs/shared/pi-args.ts";
import { createNestedRoute, nestedRouteEnv, parseNestedEventRecords } from "../../src/runs/shared/nested-events.ts";

interface ModelAttempt {
	success?: boolean;
	exitCode?: number;
	error?: string;
}

interface ProgressSummary {
	agent: string;
	index: number;
	status: string;
	activityState?: string;
	lastActivityAt?: number;
	currentTool?: string;
	currentToolArgs?: string;
	currentToolStartedAt?: number;
	currentPath?: string;
	turnCount?: number;
	tokens?: number;
	durationMs: number;
	toolCount: number;
}

interface ArtifactPaths {
	outputPath: string;
	transcriptPath?: string;
	metadataPath?: string;
}

interface LaunchResolvedExtensions {
	version?: number;
	source?: string;
	disableAmbientExtensions?: boolean;
	runtime?: string[];
	configured?: string[];
	effective?: string[];
}

interface RuntimeAcknowledgedExtensions {
	version?: number;
	source?: string;
	ids?: string[];
	omitted?: number;
}

interface RunSyncResult {
	exitCode: number;
	agent: string;
	messages: unknown[];
	error?: string;
	protocolError?: { code?: string; stream?: string; limitBytes?: number; observedBytes?: number };
	model?: string;
	skills?: string[];
	skillsWarning?: string;
	attemptedModels?: string[];
	modelAttempts?: ModelAttempt[];
	usage: { turns: number; input: number; output: number };
	progress: ProgressSummary;
	controlEvents?: Array<{ type?: string; message: string; reason?: string; turns?: number; tokens?: number; currentPath?: string; recentFailureSummary?: string }>;
	artifactPaths?: ArtifactPaths;
	transcriptPath?: string;
	transcriptError?: string;
	finalOutput?: string;
	processSignal?: string | null;
	interrupted?: boolean;
	timedOut?: boolean;
	turnBudget?: { maxTurns: number; graceTurns: number; outcome: string; turnCount: number; wrapUpRequestedAtTurn?: number; exceededAtTurn?: number };
	turnBudgetExceeded?: boolean;
	wrapUpRequested?: boolean;
	detached?: boolean;
	detachedReason?: string;
	savedOutputPath?: string;
	outputMode?: "inline" | "file-only";
	outputReference?: { path: string; bytes: number; lines: number; message: string };
	outputSaveError?: string;
	sessionFile?: string;
	structuredOutput?: unknown;
	agentContract?: { version: 1 };
	execution?: { status?: string; success?: boolean; exitCode?: number; error?: string };
	review?: { status?: string };
	effects?: { fileMutation?: { status?: string; expected?: boolean; attempted?: boolean; message?: string } };
	acceptance?: {
		status?: string;
		verifyRuns?: Array<{ status?: string }>;
		runtimeChecks?: Array<{ id?: string; status?: string; message?: string }>;
	};
	launchResolvedExtensions?: LaunchResolvedExtensions;
	runtimeAcknowledgedExtensions?: RuntimeAcknowledgedExtensions;
}

interface MockPiCallRecord {
	args?: string[];
	systemPrompts?: Array<{ mode?: string; path?: string; text?: string; error?: string }>;
}

function writeWatchdogSettings(projectDir: string, tailMs = 120_000): void {
	const settingsPath = path.join(projectDir, ".pi", "settings.json");
	fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
	fs.writeFileSync(settingsPath, JSON.stringify({
		subagents: {
			watchdog: {
				enabled: true,
				children: {
					enabled: true,
					watchdogTailTimeoutMs: tailMs,
				},
			},
		},
	}, null, 2), "utf-8");
}

async function withIsolatedWatchdogSettings<T>(projectDir: string, run: () => Promise<T>): Promise<T> {
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const previousHome = process.env.HOME;
	const previousUserProfile = process.env.USERPROFILE;
	const isolatedHome = path.join(projectDir, "isolated-home");
	process.env.PI_CODING_AGENT_DIR = path.join(isolatedHome, ".pi", "agent");
	process.env.HOME = isolatedHome;
	process.env.USERPROFILE = isolatedHome;
	try {
		return await run();
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		if (previousUserProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = previousUserProfile;
	}
}

function childWatchdogStatus(phase: "idle" | "reviewing" | "autofollow" | "settling" | "stale" | "failed", seq: number, followUpPending = false) {
	return {
		type: CHILD_WATCHDOG_STATUS_EVENT,
		runId: "watchdog-child-run",
		agent: "echo",
		childIndex: 0,
		stepIndex: 0,
		seq,
		phase,
		ts: Date.now() + seq,
		followUpPending,
	};
}

function mockAssistantMessage(text: string, stopReason: "stop" | "tool_use" = "stop") {
	return {
		type: "message_end",
		message: {
			role: "assistant",
			content: stopReason === "tool_use"
				? [{ type: "text", text }, { type: "toolCall", name: "bash", arguments: { command: "echo test" } }]
				: [{ type: "text", text }],
			model: "mock/test-model",
			stopReason,
			usage: {
				input: 10,
				output: 5,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 0.001 },
			},
		},
	};
}

interface ExecutionModule {
	runSync(
		runtimeCwd: string,
		agents: ReturnType<typeof makeAgentConfigs>,
		agentName: string,
		task: string,
		options: Record<string, unknown>,
	): Promise<RunSyncResult>;
}

interface UtilsModule {
	getFinalOutput(messages: unknown[]): string;
}

interface ExecutorToolResult {
	content: Array<{ text?: string }>;
	isError?: boolean;
	details?: {
		totalCost?: { inputTokens: number; outputTokens: number; costUsd: number };
		controlEvents?: Array<{ type?: string }>;
		asyncId?: string;
		timeoutMs?: number;
		turnBudget?: { maxTurns: number; graceTurns: number };
		artifacts?: { dir: string; files: ArtifactPaths[] };
	};
}

interface ExecutorModule {
	createSubagentExecutor?: (...args: unknown[]) => {
		execute: (...args: unknown[]) => Promise<ExecutorToolResult>;
		executeDelegated: (...args: unknown[]) => Promise<ExecutorToolResult>;
	};
	DEFAULT_FOREGROUND_TIMEOUT_MS?: number;
}

const execution = await tryImport<ExecutionModule>("./src/runs/foreground/execution.ts");
const utils = await tryImport<UtilsModule>("./src/shared/utils.ts");
const executorMod = await tryImport<ExecutorModule>("./src/runs/foreground/subagent-executor.ts");
const available = !!(execution && utils);

const runSync = execution?.runSync;
const getFinalOutput = utils?.getFinalOutput;
const createSubagentExecutor = executorMod?.createSubagentExecutor;

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

describe("single sync execution", { skip: !available ? "pi packages not available" : undefined }, () => {
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
		tempDir = createTempDir();
		mockPi.reset();
	});

	afterEach(() => {
		removeTempDir(tempDir);
	});

	function readCall(): { args: string[]; systemPrompts: NonNullable<MockPiCallRecord["systemPrompts"]> } {
		const callFile = fs.readdirSync(mockPi.dir)
			.filter((name) => name.startsWith("call-") && name.endsWith(".json"))
			.sort()
			.at(-1);
		assert.ok(callFile, "expected a recorded mock pi call");
		const payload = JSON.parse(fs.readFileSync(path.join(mockPi.dir, callFile), "utf-8")) as MockPiCallRecord;
		assert.ok(Array.isArray(payload.args), "expected recorded args");
		return { args: payload.args, systemPrompts: payload.systemPrompts ?? [] };
	}

	function readCallArgs(): string[] {
		return readCall().args;
	}

	function makeExecutor(
		agents = [makeAgent("echo")],
		config: Record<string, unknown> = {},
		asyncByDefault = false,
		initialSpawnState?: NonNullable<SubagentState["subagentSpawns"]>,
		allowMutatingManagementActions = true,
		initialAsyncJobs: SubagentState["asyncJobs"] = new Map(),
		workflowControllers?: Map<string, AbortController>,
		handleScheduledRunAction?: Parameters<typeof createSubagentExecutor>[0]["handleScheduledRunAction"],
		piEvents = createEventBus(),
	) {
		return createSubagentExecutor!({
			pi: { events: piEvents, getSessionName: () => undefined },
			state: {
				baseCwd: tempDir,
				currentSessionId: initialSpawnState?.sessionId ?? null,
				...(initialSpawnState ? { subagentSpawns: initialSpawnState } : {}),
				asyncJobs: initialAsyncJobs,
				...(workflowControllers ? { workflowControllers } : {}),
				foregroundControls: new Map(),
				lastForegroundControlId: null,
			},
			config,
			asyncByDefault,
			tempArtifactsDir: tempDir,
			getSubagentSessionRoot: () => path.join(tempDir, ".pi-subagents", "sessions"),
			expandTilde: (value: string) => value,
			discoverAgents: () => ({ agents }),
			allowMutatingManagementActions,
			...(handleScheduledRunAction ? { handleScheduledRunAction } : {}),
		});
	}

	it("spawns agent and captures output", async () => {
		mockPi.onCall({ output: "Hello from mock agent" });
		const agents = makeAgentConfigs(["echo"]);

		const sessionFile = path.join(tempDir, "child-session.jsonl");
		const result = await runSync(tempDir, agents, "echo", "Say hello", { sessionFile });

		assert.equal(result.exitCode, 0);
		assert.equal(result.agent, "echo");
		assert.equal(result.sessionFile, sessionFile);
		assert.ok(result.messages.length > 0, "should have messages");

		const output = getFinalOutput(result.messages);
		assert.equal(output, "Hello from mock agent");
	});

	it("rejects action='single' with execution fields", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const executor = makeExecutor([makeAgent("echo")]);

		const result = await executor.executePublic(
			"single-alias",
			{ action: "single", agent: "echo", task: "Run through alias" },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /Direct execution was removed/);
		assert.equal(mockPi.callCount(), 0);
	});

	it("allows schedule.create to carry the required workflowScript target", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		let forwarded;
		const executor = makeExecutor([makeAgent("echo")], {}, false, undefined, true, new Map(), undefined, async (params) => {
			forwarded = params;
			return { content: [{ type: "text", text: "created" }], details: { mode: "management", results: [] } };
		});

		const result = await executor.execute(
			"schedule-create",
			{ action: "schedule.create", id: "nightly", every: "1h", workflowScript: "return runs.run('main', { agent: 'echo' })" },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, undefined);
		assert.equal(result.content[0]?.text, "created");
		assert.equal(forwarded?.workflowScript, "return runs.run('main', { agent: 'echo' })");
	});

	it("starts workflow scripts asynchronously with a portable internal run id", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "async workflow child" });
		const asyncJobs: SubagentState["asyncJobs"] = new Map();
		const executor = makeExecutor([makeAgent("echo")], { missions: { globalIndex: false } }, false, undefined, true, asyncJobs);
		const workflowCwd = path.join(tempDir, "workflow-cwd");
		fs.mkdirSync(workflowCwd);
		const toolCallId = "call_demo|fc_demo";

		const result = await executor.execute(
			toolCallId,
			{
				cwd: workflowCwd,
				workflowScript: `emit("starting"); await runs.run("work", { agent: "echo", task: "Async work" }); return { answer: 42 };`,
				mission: { summary: "Review the active backlog", labels: ["github-backlog", "review"] },
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, undefined);
		assert.equal(result.details.mode, "workflow");
		assert.equal(result.details.toolCallId, toolCallId);
		assert.ok(result.details.asyncId);
		const workflowRunId = result.details.asyncId;
		assert.equal(result.details.runId, workflowRunId);
		assert.notEqual(workflowRunId, toolCallId);
		assert.match(workflowRunId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
		assert.equal(path.basename(result.details.asyncDir!), workflowRunId);
		assert.equal(asyncJobs.has(workflowRunId), true);
		assert.equal(asyncJobs.get(workflowRunId)?.cwd, workflowCwd);
		assert.equal(asyncJobs.has(toolCallId), false);
		assert.equal(fs.existsSync(path.join(DIRS.async, toolCallId)), false);
		assert.match(result.content[0]?.text ?? "", /Async workflow/);
		const statusPath = path.join(result.details.asyncDir!, "status.json");
		let status: { runId?: string; toolCallId?: string; cwd?: string; state?: string; steps?: Array<{ parentWorkflowRunId?: string }>; workflow?: { value?: unknown; emits?: unknown[]; trace?: Array<{ key?: string; state?: string }> } } = {};
		for (let attempt = 0; attempt < 100; attempt++) {
			status = JSON.parse(fs.readFileSync(statusPath, "utf-8"));
			if (status.state === "complete" || status.state === "failed") break;
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		assert.equal(status.state, "complete");
		assert.equal(status.runId, workflowRunId);
		assert.equal(status.toolCallId, toolCallId);
		assert.equal(status.cwd, workflowCwd);
		assert.equal(status.steps?.length, 1);
		assert.ok(status.steps?.every((step) => step.parentWorkflowRunId === workflowRunId));
		assert.deepEqual(status.workflow?.value, { answer: 42 });
		assert.deepEqual(status.workflow?.emits, ["starting"]);
		assert.equal(mockPi.callCount(), 1);
		assert.ok(status.workflow?.trace?.some((entry) => entry.key === "work" && entry.state === "completed"));
		const resultPath = path.join(DIRS.results, `${workflowRunId}.json`);
		const persistedResult = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as { id?: string; runId?: string; toolCallId?: string; agent?: string; cwd?: string; summary?: string; workflow?: { value?: unknown } };
		assert.equal(persistedResult.id, workflowRunId);
		assert.equal(persistedResult.runId, workflowRunId);
		assert.equal(persistedResult.toolCallId, toolCallId);
		assert.equal(persistedResult.agent, "workflow");
		assert.equal(persistedResult.cwd, workflowCwd);
		assert.match(persistedResult.summary ?? "", /Return: \{\n  "answer": 42\n\}/);
		assert.deepEqual(persistedResult.workflow?.value, { answer: 42 });
		assert.equal(fs.existsSync(path.join(DIRS.results, `${toolCallId}.json`)), false);
		fs.rmSync(result.details.asyncDir!, { recursive: true, force: true });
		fs.rmSync(resultPath, { force: true });
	});

	it("projects live child activity into async workflow status", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({
			steps: [
				{ jsonl: [events.toolStart("read", { path: "src/example.ts" })] },
				{ delay: 2_500, jsonl: [events.toolEnd("read"), events.toolResult("read", "contents")] },
				{ jsonl: [events.assistantMessage("Done")] },
			],
		});
		const asyncJobs: SubagentState["asyncJobs"] = new Map();
		const executor = makeExecutor([makeAgent("echo")], {
			control: {
				enabled: true,
				needsAttentionAfterMs: 100,
				activeNoticeAfterMs: 100,
				activeNoticeAfterTurns: 999_999,
				activeNoticeAfterTokens: 999_999,
				notifyOn: ["active_long_running", "needs_attention"],
				notifyChannels: ["event"],
			},
		}, false, undefined, true, asyncJobs);

		const result = await executor.execute(
			"workflow-live-activity",
			{ workflowScript: `return runs.run("main", { agent: "echo", task: "Inspect the file" });` },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		const { asyncId: workflowRunId, asyncDir } = result.details;
		assert.ok(workflowRunId);
		assert.ok(asyncDir);
		const statusPath = path.join(asyncDir, "status.json");
		const resultPath = path.join(DIRS.results, `${workflowRunId}.json`);
		let liveStatus: AsyncStatus | undefined;
		const activityDeadline = Date.now() + 5_000;
		while (Date.now() < activityDeadline && !fs.existsSync(resultPath)) {
			const candidate = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatus;
			if (candidate.activityState === "active_long_running" && candidate.steps?.[0]?.currentTool === "read") {
				liveStatus = candidate;
				break;
			}
			await new Promise((resolve) => setTimeout(resolve, 50));
		}

		assert.ok(liveStatus, "expected workflow status to expose live child activity");
		assert.equal(liveStatus.activityState, "active_long_running");
		assert.equal(typeof liveStatus.lastActivityAt, "number");
		assert.equal(liveStatus.currentTool, "read");
		assert.match(liveStatus.currentPath ?? "", /src[/\\]example\.ts$/);
		assert.equal(liveStatus.toolCount, 1);
		assert.equal(liveStatus.steps?.[0]?.status, "running");
		assert.equal(liveStatus.steps?.[0]?.agent, "echo");
		assert.match(liveStatus.steps?.[0]?.sessionFile ?? "", /session\.jsonl$/);
		assert.equal(fs.existsSync(liveStatus.steps?.[0]?.sessionFile ?? ""), true);
		assert.equal(liveStatus.steps?.[0]?.activityState, "active_long_running");
		assert.equal(typeof liveStatus.steps?.[0]?.lastActivityAt, "number");
		assert.equal(liveStatus.steps?.[0]?.toolCount, 1);
		assert.equal(asyncJobs.get(workflowRunId)?.activityState, "active_long_running");
		assert.equal(asyncJobs.get(workflowRunId)?.steps?.[0]?.currentTool, "read");

		const completionDeadline = Date.now() + 5_000;
		while (!fs.existsSync(resultPath)) {
			if (Date.now() > completionDeadline) assert.fail("Timed out waiting for async workflow completion");
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		fs.rmSync(asyncDir, { recursive: true, force: true });
		fs.rmSync(resultPath, { force: true });
	});

	it("rejects an invalid async workflow usage budget before creating run state", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const asyncJobs: SubagentState["asyncJobs"] = new Map();
		const executor = makeExecutor([makeAgent("echo")], {}, false, undefined, true, asyncJobs);
		const runId = `scripted-workflow-invalid-budget-${Date.now()}`;

		const result = await executor.execute(
			runId,
			{ workflowScript: `return "unreachable";`, usageBudget: { tokens: { hard: 0 } } },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /usageBudget\.tokens\.hard must be a positive number/);
		assert.equal(result.details.asyncId, undefined);
		assert.equal(asyncJobs.has(runId), false);
		assert.equal(fs.existsSync(path.join(DIRS.async, runId)), false);
		assert.equal(fs.existsSync(path.join(DIRS.results, `${runId}.json`)), false);
	});

	it("rejects async child launches from budgeted async workflows", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const executor = makeExecutor([makeAgent("echo")]);
		const runId = `scripted-workflow-budget-async-child-${Date.now()}`;
		const started = await executor.execute(
			runId,
			{
				workflowScript: `await runs.run("background", { agent: "echo", task: "Async child", async: true }); return "unreachable";`,
				usageBudget: { tokens: { hard: 100 } },
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(started.isError, undefined);
		assert.ok(started.details.asyncId);
		assert.notEqual(started.details.asyncId, runId);
		const resultPath = path.join(DIRS.results, `${started.details.asyncId}.json`);
		let persisted: { state?: string; summary?: string; results?: Array<{ success?: boolean; output?: string }> } = {};
		for (let attempt = 0; attempt < 100; attempt++) {
			if (fs.existsSync(resultPath)) persisted = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
			if (persisted.state === "failed") break;
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		assert.equal(persisted.state, "failed");
		assert.match(persisted.summary ?? "", /workflow usageBudget does not support async runs\.run launches/);
		assert.equal(persisted.results?.length, 1);
		assert.equal(persisted.results?.[0]?.success, false);
		assert.match(persisted.results?.[0]?.output ?? "", /workflow usageBudget does not support async runs\.run launches/);
		assert.equal(mockPi.callCount(), 0);
		fs.rmSync(started.details.asyncDir!, { recursive: true, force: true });
		fs.rmSync(resultPath, { force: true });
	});

	it("persists workflow parent metadata in an async worktree child status and result", { skip: !createSubagentExecutor || process.platform === "win32" ? "executor unavailable or worktree paths differ on Windows" : undefined }, async () => {
		execFileSync("git", ["init"], { cwd: tempDir, stdio: "ignore" });
		execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: tempDir });
		execFileSync("git", ["config", "user.name", "Test User"], { cwd: tempDir });
		fs.writeFileSync(path.join(tempDir, "base.txt"), "base\n", "utf-8");
		execFileSync("git", ["add", "base.txt"], { cwd: tempDir });
		execFileSync("git", ["commit", "-m", "base"], { cwd: tempDir, stdio: "ignore" });
		mockPi.onCall({ output: "async child done" });
		const executor = makeExecutor([makeAgent("echo")]);
		const toolCallId = `scripted-workflow-parent-${Date.now()}`;
		const started = await executor.execute(
			toolCallId,
			{ workflowScript: `const child = await runs.run("background", { agent: "echo", task: "Async child", async: true, worktree: true }); return child.runId;` },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		assert.ok(started.details.asyncId);
		const workflowRunId = started.details.asyncId;
		const workflowResultPath = path.join(DIRS.results, `${workflowRunId}.json`);
		let childRunId: string | undefined;
		for (let attempt = 0; attempt < 150; attempt++) {
			if (fs.existsSync(workflowResultPath)) {
				const workflowResult = JSON.parse(fs.readFileSync(workflowResultPath, "utf-8")) as { workflow?: { value?: unknown } };
				if (typeof workflowResult.workflow?.value === "string") { childRunId = workflowResult.workflow.value; break; }
			}
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		assert.ok(childRunId);
		const workflowStatus = JSON.parse(fs.readFileSync(path.join(started.details.asyncDir!, "status.json"), "utf-8")) as AsyncStatus;
		const workflowStepSessionFile = workflowStatus.steps?.[0]?.sessionFile ?? "";
		assert.equal(workflowStatus.steps?.[0]?.agent, "echo");
		assert.match(workflowStepSessionFile, /session\.jsonl$/);
		const childDir = path.join(DIRS.async, childRunId);
		const childStatusPath = path.join(childDir, "status.json");
		let childStatus: { state?: string; mode?: string; parentWorkflowRunId?: string; workflowKey?: string; parallelHandoff?: { path?: string } } = {};
		for (let attempt = 0; attempt < 200; attempt++) {
			if (fs.existsSync(childStatusPath)) childStatus = JSON.parse(fs.readFileSync(childStatusPath, "utf-8"));
			if (["complete", "failed", "stopped"].includes(childStatus.state ?? "")) break;
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		assert.equal(childStatus.mode, "parallel");
		assert.equal(childStatus.parentWorkflowRunId, workflowRunId);
		assert.equal(childStatus.workflowKey, "background");
		assert.equal(typeof childStatus.parallelHandoff?.path, "string");
		const childResultPath = path.join(DIRS.results, `${childRunId}.json`);
		for (let attempt = 0; attempt < 200 && !fs.existsSync(childResultPath); attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		const childResult = JSON.parse(fs.readFileSync(childResultPath, "utf-8")) as { parentWorkflowRunId?: string; workflowKey?: string };
		assert.equal(childResult.parentWorkflowRunId, workflowRunId);
		assert.equal(childResult.workflowKey, "background");
		assert.equal(fs.existsSync(workflowStepSessionFile), true);
		fs.rmSync(started.details.asyncDir!, { recursive: true, force: true });
		fs.rmSync(workflowResultPath, { force: true });
		fs.rmSync(childDir, { recursive: true, force: true });
		fs.rmSync(path.join(DIRS.results, `${childRunId}.json`), { force: true });
	});

	it("stops a live async workflow through its controller", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const controller = new AbortController();
		const executor = makeExecutor([makeAgent("echo")], {}, false, undefined, true, new Map(), new Map([["workflow-stop", controller]]));
		const result = await executor.execute(
			"stop-call",
			{ action: "stop", id: "workflow-stop" },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		assert.equal(result.isError, undefined);
		assert.equal(controller.signal.aborted, true);
		assert.match(result.content[0]?.text ?? "", /Stop requested for async workflow workflow-stop/);
	});

	it("reports completed async workflows as not running when stopped after completion", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const runId = `workflow-stop-complete-${Date.now()}`;
		const asyncDir = path.join(DIRS.async, runId);
		fs.mkdirSync(asyncDir, { recursive: true });
		fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
			runId,
			sessionId: "session-123",
			mode: "workflow",
			state: "complete",
			startedAt: Date.now(),
			lastUpdate: Date.now(),
			cwd: tempDir,
			pid: process.pid,
		}), "utf-8");
		const asyncJobs: SubagentState["asyncJobs"] = new Map([[runId, {
			asyncId: runId,
			asyncDir,
			cwd: tempDir,
			status: "complete",
			mode: "workflow",
			agents: [],
			steps: [],
			startedAt: Date.now(),
			updatedAt: Date.now(),
		}]]);
		const executor = makeExecutor([makeAgent("echo")], {}, false, undefined, true, asyncJobs);

		const result = await executor.execute(
			"stop-completed-workflow",
			{ action: "stop", id: runId },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /No running or queued async run was found/);
		assert.doesNotMatch(result.content[0]?.text ?? "", /reload recovery/);
		fs.rmSync(asyncDir, { recursive: true, force: true });
	});

	it("routes workflow children through one automatic mission", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "scanned auth" });
		mockPi.onCall({ output: "reviewed auth" });
		const executor = makeExecutor([makeAgent("echo")], { missions: { globalIndex: false } });

		const result = await executor.execute(
			"scripted-workflow",
			{
				async: false,
				workflowScript: `
					const stateType = typeof state;
					const scan = await runs.run("scan", { agent: "echo", task: "Scan auth" });
					const review = await runs.run("review", { agent: "echo", task: "Review: " + scan.output });
					return { output: review.output, stateType };
				`,
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, undefined);
		assert.match(result.content[0]?.text ?? "", /reviewed auth/);
		assert.equal(result.details.mode, "workflow");
		assert.equal(result.details.results.length, 2);
		assert.equal(result.details.workflow?.value && (result.details.workflow.value as { stateType?: unknown }).stateType, "object");
		assert.ok(result.details.missionId);
		const missionDir = path.join(tempDir, ".pi-subagents", "missions");
		const missionFiles = fs.readdirSync(missionDir).filter((entry) => entry.endsWith(".json"));
		assert.equal(missionFiles.length, 1);
		const mission = JSON.parse(fs.readFileSync(path.join(missionDir, missionFiles[0]!), "utf-8")) as { objective?: string };
		assert.equal(mission.objective, "Scan auth");
		assert.deepEqual(result.details.workflow?.trace.filter((entry) => entry.state === "completed").map((entry) => entry.key), ["scan", "review"]);
	});

	it("keeps workflow children mission-detached when automatic mission persistence fails", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "scanned auth" });
		mockPi.onCall({ output: "reviewed auth" });
		const blockedIndex = path.join(tempDir, "blocked-mission-index");
		fs.writeFileSync(blockedIndex, "not a directory", "utf-8");
		const executor = makeExecutor([makeAgent("echo")], { missions: { globalIndexDir: blockedIndex } });

		const result = await executor.execute(
			"scripted-workflow-mission-warning",
			{
				async: false,
				workflowScript: `
					const scan = await runs.run("scan", { agent: "echo", task: "Scan auth" });
					const review = await runs.run("review", { agent: "echo", task: "Review: " + scan.output });
					return review.output;
				`,
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, undefined);
		assert.equal(result.details.missionId, undefined);
		assert.match(result.details.missionWarning ?? "", /Mission tracking unavailable/);
		assert.equal(result.details.results.length, 2);
		const missionDir = path.join(tempDir, ".pi-subagents", "missions");
		const missionFiles = fs.existsSync(missionDir) ? fs.readdirSync(missionDir).filter((entry) => entry.endsWith(".json")) : [];
		assert.equal(missionFiles.length, 1);
	});

	it("shares durable workflow state across a mission and omits it for mission:false", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const executor = makeExecutor([makeAgent("echo")], { missions: { globalIndex: false } });
		const first = await executor.execute(
			"mission-state-first",
			{
				async: false,
				mission: { title: "Stateful workflow" },
				workflowScript: `await state.set("review.stage", { count: 1 }); return await state.get("review.stage");`,
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		assert.equal(first.isError, undefined, first.content[0]?.text ?? "first workflow failed");
		assert.ok(first.details.missionId);
		assert.deepEqual(first.details.workflow?.value, { count: 1 });
		const statePath = path.join(tempDir, ".pi-subagents", "missions", first.details.missionId, "state.json");
		assert.equal(fs.existsSync(statePath), true);

		const second = await executor.execute(
			"mission-state-second",
			{ async: false, missionId: first.details.missionId, workflowScript: `return await state.get("review.stage");` },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		assert.equal(second.isError, undefined, second.content[0]?.text ?? "second workflow failed");
		assert.deepEqual(second.details.workflow?.value, { count: 1 });

		const ephemeral = await executor.execute(
			"mission-state-off",
			{ async: false, mission: false, workflowScript: `return typeof state;` },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		assert.equal(ephemeral.isError, undefined, ephemeral.content[0]?.text ?? "ephemeral workflow failed");
		assert.equal(ephemeral.details.workflow?.value, "undefined");
		assert.equal(ephemeral.details.missionId, undefined);
	});

	it("runs a direct single child in a managed worktree", { skip: !createSubagentExecutor || process.platform === "win32" ? "executor unavailable or worktree paths differ on Windows" : undefined }, async () => {
		execFileSync("git", ["init"], { cwd: tempDir, stdio: "ignore" });
		execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: tempDir });
		execFileSync("git", ["config", "user.name", "Test User"], { cwd: tempDir });
		fs.writeFileSync(path.join(tempDir, "base.txt"), "base\n", "utf-8");
		execFileSync("git", ["add", "base.txt"], { cwd: tempDir });
		execFileSync("git", ["commit", "-m", "base"], { cwd: tempDir, stdio: "ignore" });
		mockPi.onCall({ output: "isolated feature", writeFiles: [{ path: "feature.txt", content: "feature\n" }] });
		const executor = makeExecutor([makeAgent("worker")]);

		const result = await executor.execute(
			"direct-worktree",
			{ async: false, agent: "worker", task: "Implement feature", worktree: true },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, undefined);
		assert.equal(mockPi.callCount(), 1);
		assert.equal(fs.existsSync(path.join(tempDir, "feature.txt")), false);
		const handoffPath = (result.content[0]?.text ?? "").match(/([^\s]+\/handoffs\/[^\s]+\.json)/)?.[1];
		assert.ok(handoffPath, result.content[0]?.text);
		const handoff = JSON.parse(fs.readFileSync(handoffPath, "utf-8")) as {
			groups: Array<{
				cleanup: { state: string; tasks: Array<{ worktreeRemoved: boolean }> };
			}>;
		};
		assert.equal(handoff.groups[0]?.cleanup.state, "complete");
		assert.equal(handoff.groups[0]?.cleanup.tasks[0]?.worktreeRemoved, true);

	});

	it("lets runs.all siblings settle when one child fails", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ exitCode: 1, stderr: "first child failed" });
		mockPi.onCall({ output: "second child completed" });
		const executor = makeExecutor([makeAgent("echo")]);

		const result = await executor.execute(
			"scripted-workflow-settlement",
			{
				async: false,
				workflowScript: `
					const children = await runs.all([
						{ key: "first", agent: "echo", task: "First task" },
						{ key: "second", agent: "echo", task: "Second task" }
					]);
					return children.map(({ key, ok, error }) => error === undefined ? { key, ok } : { key, ok, error });
				`,
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, undefined, result.content[0]?.text ?? "workflow failed");
		assert.equal(mockPi.callCount(), 2);
		const value = result.details.workflow?.value as Array<{ key: string; ok: boolean; error?: string }>;
		assert.deepEqual(value.map(({ key }) => key), ["first", "second"]);
		assert.deepEqual(value.map(({ ok }) => ok).sort(), [false, true]);
		const failed = value.find(({ ok }) => !ok);
		const succeeded = value.find(({ ok }) => ok);
		assert.match(failed?.error ?? "", /first child failed/);
		assert.equal(succeeded?.error, undefined);
		assert.deepEqual(result.details.workflow?.trace.filter((entry) => entry.state !== "started").map(({ state }) => state).sort(), ["completed", "failed"]);
	});

	it("runs a direct child gate as host-verified acceptance", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const markerFile = "direct-gate.txt";
		const markerPath = path.join(tempDir, markerFile);
		mockPi.onCall({ output: [
			"done",
			"```acceptance-report",
			JSON.stringify({
				criteriaSatisfied: [{ id: "criterion-1", status: "satisfied", evidence: "implemented" }],
				changedFiles: ["src/file.ts"],
				testsAddedOrUpdated: ["test/file.test.ts"],
				commandsRun: [{ command: "npm test", result: "passed", summary: "passed" }],
				validationOutput: ["tests passed"],
				residualRisks: [],
				noStagedFiles: true,
			}),
			"```",
		].join("\n") });
		const executor = makeExecutor([makeAgent("echo")]);

		const result = await executor.execute(
			"direct-gate",
			{ async: false, agent: "echo", task: "Validate the result without edits", gate: `${process.execPath} -e "require('node:fs').writeFileSync('${markerFile}','verified')"` },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, undefined, result.content[0]?.text ?? "direct gate failed");
		assert.equal(fs.readFileSync(markerPath, "utf-8"), "verified");
		assert.equal(result.details.results[0]?.acceptance?.status, "verified");
		assert.equal(result.details.results[0]?.acceptance?.verifyRuns[0]?.id, "gate");
	});

	it("lets runs.all siblings settle when one verified gate fails", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const acceptedReport = [
			"done",
			"```acceptance-report",
			JSON.stringify({
				criteriaSatisfied: [{ id: "criterion-1", status: "satisfied", evidence: "implemented" }],
				changedFiles: ["src/file.ts"],
				testsAddedOrUpdated: ["test/file.test.ts"],
				commandsRun: [{ command: "npm test", result: "passed", summary: "passed" }],
				validationOutput: ["tests passed"],
				residualRisks: [],
				noStagedFiles: true,
			}),
			"```",
		].join("\n");
		mockPi.onCall({ output: acceptedReport });
		mockPi.onCall({ output: acceptedReport });
		const executor = makeExecutor([makeAgent("echo")]);

		const result = await executor.execute(
			"scripted-workflow-gates",
			{
				async: false,
				workflowScript: `
					const children = await runs.all([
						{ key: "fails-gate", agent: "echo", task: "First task", gate: ${JSON.stringify(`${process.execPath} -e "process.exit(7)"`)} },
						{ key: "passes-gate", agent: "echo", task: "Second task", gate: ${JSON.stringify(`${process.execPath} -e "process.exit(0)"`)} }
					]);
					return children.map(({ key, ok }) => ({ key, ok }));
				`,
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, undefined, result.content[0]?.text ?? "workflow failed");
		assert.equal(mockPi.callCount(), 2);
		assert.deepEqual(result.details.workflow?.value, [
			{ key: "fails-gate", ok: false },
			{ key: "passes-gate", ok: true },
		]);
		const [failed, passed] = result.details.results;
		assert.equal(failed?.acceptance?.status, "rejected");
		assert.equal(failed?.acceptance?.verifyRuns[0]?.status, "failed");
		assert.equal(passed?.acceptance?.status, "verified");
		assert.equal(passed?.acceptance?.verifyRuns[0]?.status, "passed");
	});

	it("gives parallel workflow children separate managed worktrees and durable handoffs", { skip: !createSubagentExecutor || process.platform === "win32" ? "executor unavailable or worktree paths differ on Windows" : undefined }, async () => {
		execFileSync("git", ["init"], { cwd: tempDir, stdio: "ignore" });
		execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: tempDir });
		execFileSync("git", ["config", "user.name", "Test User"], { cwd: tempDir });
		fs.writeFileSync(path.join(tempDir, "base.txt"), "base\n", "utf-8");
		execFileSync("git", ["add", "base.txt"], { cwd: tempDir });
		execFileSync("git", ["commit", "-m", "base"], { cwd: tempDir, stdio: "ignore" });
		mockPi.onCall({ output: "feature a", writeFiles: [{ path: "feature-a.txt", content: "a\n" }] });
		mockPi.onCall({ output: "feature b", writeFiles: [{ path: "feature-b.txt", content: "b\n" }] });
		const executor = makeExecutor([makeAgent("worker")]);

		const result = await executor.execute(
			"scripted-workflow-worktrees",
			{
				async: false,
				workflowScript: `
					const children = await runs.all([
						{ key: "feature-a", agent: "worker", task: "Implement A", worktree: true },
						{ key: "feature-b", agent: "worker", task: "Implement B", worktree: true }
					]);
					return children.map(({ key, artifactPaths }) => ({ key, artifactPaths }));
				`,
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, undefined);
		assert.equal(mockPi.callCount(), 2, result.content[0]?.text ?? "workflow produced no output");
		assert.equal(fs.existsSync(path.join(tempDir, "feature-a.txt")), false);
		assert.equal(fs.existsSync(path.join(tempDir, "feature-b.txt")), false);
		const output = result.content[0]?.text ?? "";
		const handoffPaths = [...output.matchAll(/"([^"\n]*\/handoffs\/[^"\n]+\.json)"/g)].map((match) => match[1]!);
		assert.equal(handoffPaths.length, 2, output);
		const worktreePaths = new Set<string>();
		for (const handoffPath of handoffPaths) {
			const handoff = JSON.parse(fs.readFileSync(handoffPath, "utf-8")) as {
				groups: Array<{
					children: Array<{ patch: { changed: boolean; path: string } }>;
					cleanup: { state: string; tasks: Array<{ path: string; worktreeRemoved: boolean; branchRemoved: boolean }> };
				}>;
			};
			assert.equal(handoff.groups.length, 1);
			assert.equal(handoff.groups[0]?.children.length, 1);
			assert.equal(handoff.groups[0]?.children[0]?.patch.changed, true);
			assert.equal(fs.existsSync(handoff.groups[0]!.children[0]!.patch.path), true);
			assert.equal(handoff.groups[0]?.cleanup.state, "complete");
			assert.equal(handoff.groups[0]?.cleanup.tasks[0]?.worktreeRemoved, true);
			assert.equal(handoff.groups[0]?.cleanup.tasks[0]?.branchRemoved, true);
			worktreePaths.add(handoff.groups[0]!.cleanup.tasks[0]!.path);
		}
		assert.equal(worktreePaths.size, 2);
		for (const worktreePath of worktreePaths) assert.equal(fs.existsSync(worktreePath), false);
		assert.match(result.content[0]?.text ?? "", /handoffs/);
	});

	it("preserves a workflow worktree when its child detaches for supervisor coordination", { skip: !createSubagentExecutor || process.platform === "win32" ? "executor unavailable or worktree paths differ on Windows" : undefined }, async () => {
		execFileSync("git", ["init"], { cwd: tempDir, stdio: "ignore" });
		execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: tempDir });
		execFileSync("git", ["config", "user.name", "Test User"], { cwd: tempDir });
		fs.writeFileSync(path.join(tempDir, "base.txt"), "base\n", "utf-8");
		execFileSync("git", ["add", "base.txt"], { cwd: tempDir });
		execFileSync("git", ["commit", "-m", "base"], { cwd: tempDir, stdio: "ignore" });
		mockPi.onCall({
			steps: [
				{ jsonl: [events.toolStart("contact_supervisor", { reason: "need_decision", message: "Need a decision" })] },
				{ delay: 500, jsonl: [events.assistantMessage("done after coordination")] },
			],
		});
		const piEvents = createEventBus();
		const executor = makeExecutor(
			[makeAgent("worker", { systemPrompt: "Intercom orchestration channel:" })],
			{},
			false,
			undefined,
			true,
			new Map(),
			undefined,
			undefined,
			piEvents,
		);
		let detachAccepted = false;
		piEvents.on(INTERCOM_DETACH_RESPONSE_EVENT, (payload) => {
			if ((payload as { requestId?: unknown }).requestId === "workflow-worktree-detach") {
				detachAccepted ||= (payload as { accepted?: unknown }).accepted === true;
			}
		});
		const detachTimer = setInterval(() => {
			if (!detachAccepted) piEvents.emit(INTERCOM_DETACH_REQUEST_EVENT, { requestId: "workflow-worktree-detach" });
		}, 10);
		detachTimer.unref();

		const result = await executor.execute(
			"scripted-workflow-detached-worktree",
			{
				async: false,
				workflowScript: `
					const children = await runs.all([
						{ key: "detaches", agent: "worker", task: "Ask then continue", worktree: true }
					]);
					return children.map(({ key, ok, artifactPaths }) => ({ key, ok, artifactPaths }));
				`,
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		clearInterval(detachTimer);

		assert.equal(detachAccepted, true);
		assert.equal(result.isError, undefined, result.content[0]?.text ?? "workflow failed");
		assert.match(result.content[0]?.text ?? "", /run detaches: failed/);
		const workflowValue = result.details.workflow?.value as Array<{ ok: boolean; artifactPaths: string[] }>;
		assert.equal(workflowValue[0]?.ok, false);
		const handoffPath = workflowValue[0]?.artifactPaths.find((candidate) => candidate.endsWith(".json"));
		assert.ok(handoffPath, result.content[0]?.text ?? "missing pending handoff");
		const handoff = JSON.parse(fs.readFileSync(handoffPath, "utf-8")) as {
			groups: Array<{
				cleanup: { state: string; tasks: Array<{ path: string; branch: string; preserved: boolean; worktreeRemoved: boolean; branchRemoved: boolean }> };
			}>;
		};
		const cleanup = handoff.groups[0]?.cleanup;
		assert.equal(cleanup?.state, "partial");
		assert.equal(cleanup?.tasks[0]?.preserved, true);
		assert.equal(cleanup?.tasks[0]?.worktreeRemoved, false);
		assert.equal(cleanup?.tasks[0]?.branchRemoved, false);
		const worktreePath = cleanup?.tasks[0]?.path;
		const branch = cleanup?.tasks[0]?.branch;
		assert.ok(worktreePath);
		assert.ok(branch);
		assert.equal(fs.existsSync(worktreePath), true, "live detached worktree must remain present");

		await new Promise((resolve) => setTimeout(resolve, 750));
		execFileSync("git", ["worktree", "remove", "--force", worktreePath], { cwd: tempDir });
		execFileSync("git", ["branch", "-D", branch], { cwd: tempDir, stdio: "ignore" });
	});

	it("inherits workflow-level worktree isolation and allows a child opt-out", { skip: !createSubagentExecutor || process.platform === "win32" ? "executor unavailable or worktree paths differ on Windows" : undefined }, async () => {
		execFileSync("git", ["init"], { cwd: tempDir, stdio: "ignore" });
		execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: tempDir });
		execFileSync("git", ["config", "user.name", "Test User"], { cwd: tempDir });
		fs.writeFileSync(path.join(tempDir, "base.txt"), "base\n", "utf-8");
		execFileSync("git", ["add", "base.txt"], { cwd: tempDir });
		execFileSync("git", ["commit", "-m", "base"], { cwd: tempDir, stdio: "ignore" });
		mockPi.onCall({ output: "isolated", writeFiles: [{ path: "isolated.txt", content: "isolated\n" }] });
		mockPi.onCall({ output: "shared", writeFiles: [{ path: "shared.txt", content: "shared\n" }] });
		const executor = makeExecutor([makeAgent("worker")]);

		const result = await executor.execute(
			"scripted-workflow-worktree-default",
			{
				async: false,
				worktree: true,
				workflowScript: `
					const isolated = await runs.run("isolated", { agent: "worker", task: "Isolated" });
					const shared = await runs.run("shared", { agent: "worker", task: "Shared", worktree: false });
					return { isolated: isolated.artifactPaths, shared: shared.artifactPaths };
				`,
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, undefined, result.content[0]?.text ?? "workflow failed");
		assert.equal(fs.existsSync(path.join(tempDir, "isolated.txt")), false);
		assert.equal(fs.readFileSync(path.join(tempDir, "shared.txt"), "utf-8"), "shared\n");
		const output = result.content[0]?.text ?? "";
		const handoffPaths = [...output.matchAll(/"([^"\n]*\/handoffs\/[^"\n]+\.json)"/g)].map((match) => match[1]!);
		assert.equal(handoffPaths.length, 1, output);
		assert.equal(fs.existsSync(handoffPaths[0]!), true);
	});

	it("supports dynamic parallel phases followed by sequential worktree children", { skip: !createSubagentExecutor || process.platform === "win32" ? "executor unavailable or worktree paths differ on Windows" : undefined }, async () => {
		execFileSync("git", ["init"], { cwd: tempDir, stdio: "ignore" });
		execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: tempDir });
		execFileSync("git", ["config", "user.name", "Test User"], { cwd: tempDir });
		fs.writeFileSync(path.join(tempDir, "base.txt"), "base\n", "utf-8");
		execFileSync("git", ["add", "base.txt"], { cwd: tempDir });
		execFileSync("git", ["commit", "-m", "base"], { cwd: tempDir, stdio: "ignore" });
		mockPi.onCall({ output: "api built", writeFiles: [{ path: "api.txt", content: "api\n" }] });
		mockPi.onCall({ output: "ui built", writeFiles: [{ path: "ui.txt", content: "ui\n" }] });
		mockPi.onCall({ output: "joined", writeFiles: [{ path: "joined.txt", content: "joined\n" }] });
		mockPi.onCall({ output: "shared", writeFiles: [{ path: "shared.txt", content: "shared\n" }] });
		const executor = makeExecutor([makeAgent("worker")]);

		const result = await executor.execute(
			"scripted-workflow-dynamic-worktree-phases",
			{
				async: false,
				worktree: true,
				workflowScript: `
					const targets = ["api", "ui"];
					const built = await runs.all(targets.map((target) => ({
						key: "build-" + target,
						agent: "worker",
						task: "Build " + target
					})));
					const joined = await runs.run("join", { agent: "worker", task: built.map((child) => child.key).join(",") });
					const shared = await runs.run("shared", { agent: "worker", task: joined.key, worktree: false });
					return {
						built: built.map((child) => ({ key: child.key, artifactPaths: child.artifactPaths })),
						joined: { key: joined.key, artifactPaths: joined.artifactPaths },
						shared: shared.key
					};
				`,
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, undefined, result.content[0]?.text ?? "workflow failed");
		assert.equal(mockPi.callCount(), 4, result.content[0]?.text ?? "workflow produced no output");
		assert.equal(fs.existsSync(path.join(tempDir, "api.txt")), false);
		assert.equal(fs.existsSync(path.join(tempDir, "ui.txt")), false);
		assert.equal(fs.existsSync(path.join(tempDir, "joined.txt")), false);
		assert.equal(fs.readFileSync(path.join(tempDir, "shared.txt"), "utf-8"), "shared\n");

		const output = result.content[0]?.text ?? "";
		assert.match(output, /build-api/);
		assert.match(output, /build-ui/);
		assert.match(output, /join/);
		assert.match(output, /shared/);
		const handoffPaths = [...output.matchAll(/"([^"\n]*\/handoffs\/[^"\n]+\.json)"/g)].map((match) => match[1]!);
		assert.equal(handoffPaths.length, 3, output);
		const worktreePaths = new Set<string>();
		for (const handoffPath of handoffPaths) {
			const handoff = JSON.parse(fs.readFileSync(handoffPath, "utf-8")) as {
				groups: Array<{
					children: Array<{ patch: { changed: boolean; path: string } }>;
					cleanup: { state: string; tasks: Array<{ path: string; worktreeRemoved: boolean; branchRemoved: boolean }> };
				}>;
			};
			assert.equal(handoff.groups.length, 1);
			assert.equal(handoff.groups[0]?.children[0]?.patch.changed, true);
			assert.equal(fs.existsSync(handoff.groups[0]!.children[0]!.patch.path), true);
			assert.equal(handoff.groups[0]?.cleanup.state, "complete");
			assert.equal(handoff.groups[0]?.cleanup.tasks[0]?.worktreeRemoved, true);
			assert.equal(handoff.groups[0]?.cleanup.tasks[0]?.branchRemoved, true);
			worktreePaths.add(handoff.groups[0]!.cleanup.tasks[0]!.path);
		}
		assert.equal(worktreePaths.size, 3);
		for (const worktreePath of worktreePaths) assert.equal(fs.existsSync(worktreePath), false);
	});

	it("applies a workflow usage budget across scripted child launches", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "first result" });
		const executor = makeExecutor([makeAgent("echo")]);

		const result = await executor.execute(
			"scripted-workflow-usage-budget",
			{
				async: false,
				workflowScript: `
					await runs.run("first", { agent: "echo", task: "First task" });
					await runs.run("second", { agent: "echo", task: "Second task" });
				`,
				usageBudget: { tokens: { hard: 10 } },
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /Usage budget exhausted/);
		assert.equal(result.details.mode, "workflow");
		assert.equal(mockPi.callCount(), 1);
		assert.equal(result.details.usageBudget?.exhausted, true);
	});

	it("admits a zero run-level tool budget only for marked structured delegated execution", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const zeroBudget = { hard: 0, block: "*" as const };
		const params = { agent: "echo", task: "Answer without tools", toolBudget: zeroBudget };
		const ctx = makeMinimalCtx(tempDir);
		const executor = makeExecutor([makeAgent("echo")]);

		const ordinary = await executor.execute(
			"ordinary-zero-budget",
			{ ...params, delegatedAllowZeroToolBudget: true },
			new AbortController().signal,
			undefined,
			ctx,
		);
		assert.equal(ordinary.isError, true);
		assert.match(ordinary.content[0]?.text ?? "", /toolBudget\.hard must be an integer >= 1/);

		const unmarkedDelegated = await executor.executeDelegated(
			"unmarked-delegated-zero-budget",
			params,
			new AbortController().signal,
			undefined,
			ctx,
		);
		assert.equal(unmarkedDelegated.isError, true);
		assert.match(unmarkedDelegated.content[0]?.text ?? "", /toolBudget\.hard must be an integer >= 1/);

		mockPi.onCall({ echoEnv: [TOOL_BUDGET_ENV, TOOL_BUDGET_ZERO_AUTH_ENV] });
		const structuredDelegated = await executor.executeDelegated(
			"structured-delegated-zero-budget",
			{ ...params, delegatedAllowZeroToolBudget: true },
			new AbortController().signal,
			undefined,
			ctx,
		);
		assert.equal(structuredDelegated.isError, undefined);
		assert.deepEqual(structuredDelegated.details.toolBudget, zeroBudget);
		const env = JSON.parse(structuredDelegated.content[0]?.text ?? "{}") as Record<string, string>;
		assert.deepEqual(JSON.parse(env[TOOL_BUDGET_ENV] ?? "null"), zeroBudget);
		assert.equal(env[TOOL_BUDGET_ZERO_AUTH_ENV], "1");
		assert.equal(mockPi.callCount(), 1);
	});

	it("keeps delegated agent and config tool budgets at a minimum of one", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const ctx = makeMinimalCtx(tempDir);
		const cases = [
			makeExecutor([makeAgent("echo", { toolBudget: { hard: 0 } })]),
			makeExecutor([makeAgent("echo")], { toolBudget: { hard: 0 } }),
		];
		for (const [index, executor] of cases.entries()) {
			const result = await executor.executeDelegated(
				`delegated-default-zero-budget-${index}`,
				{ agent: "echo", task: "Do work", delegatedAllowZeroToolBudget: true },
				new AbortController().signal,
				undefined,
				ctx,
			);
			assert.equal(result.isError, true);
			assert.match(result.content[0]?.text ?? "", /(?:agent\.|config\.)?toolBudget\.hard must be an integer >= 1/);
		}
		assert.equal(mockPi.callCount(), 0);
	});

	it("rejects string \"none\" acceptance before spawning", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const executor = makeExecutor([makeAgent("echo")]);

		const result = await executor.execute(
			"string-none-acceptance",
			{ agent: "echo", task: "Do work", acceptance: "none" },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /acceptance level "none" requires a reason/);
		assert.equal(mockPi.callCount(), 0);
	});

	it("rejects invalid verified acceptance before spawning", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const executor = makeExecutor([makeAgent("echo")]);
		const invalidPolicies = [
			"verified",
			{ level: "verified" },
			{ level: "verified", verify: [] },
		] as const;

		for (const [index, acceptance] of invalidPolicies.entries()) {
			const result = await executor.execute(
				`invalid-verified-acceptance-${index}`,
				{ agent: "echo", task: "Do work", acceptance: acceptance as never },
				new AbortController().signal,
				undefined,
				makeMinimalCtx(tempDir),
			);

			assert.equal(result.isError, true);
			assert.match(result.content[0]?.text ?? "", /(?:verified.*object form|verify.*at least one runtime command)/i);
		}
		assert.equal(mockPi.callCount(), 0);
	});

	it("rejects invalid verified async chain acceptance before spawning", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const executor = makeExecutor([makeAgent("echo")]);

		const result = await executor.execute(
			"invalid-verified-async-chain-acceptance",
			{ chain: [{ agent: "echo", task: "Do work", acceptance: { level: "verified", verify: [] } }], async: true },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /verify.*at least one runtime command/i);
		assert.equal(mockPi.callCount(), 0);
	});

	it("rejects unknown action strings at runtime", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const executor = makeExecutor([makeAgent("echo")]);

		const result = await executor.execute(
			"unknown-action",
			{ action: "not-a-real-action" },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /Unknown action: not-a-real-action/);
		assert.match(result.content[0]?.text ?? "", /Valid:/);
	});

	it("routes watchdog.configure through the management action path", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const gpt = { provider: "openai-codex", id: "gpt-5.5", reasoning: true };
		const opus = { provider: "anthropic", id: "claude-opus-4-8", reasoning: true };
		const models = [gpt, opus];
		const watchdog = new MainWatchdogRuntime({ cwd: tempDir });
		const executor = createSubagentExecutor!({
			pi: { events: createEventBus(), getSessionName: () => undefined },
			state: { baseCwd: tempDir, currentSessionId: null, asyncJobs: new Map(), foregroundControls: new Map(), lastForegroundControlId: null },
			config: {},
			asyncByDefault: false,
			watchdog,
			tempArtifactsDir: tempDir,
			getSubagentSessionRoot: () => tempDir,
			expandTilde: (value: string) => value,
			discoverAgents: () => ({ agents: [makeAgent("echo")] }),
		});
		const ctx = {
			...makeMinimalCtx(tempDir),
			model: gpt,
			modelRegistry: {
				getAvailable: () => models,
				find: (provider: string, id: string) => models.find((model) => model.provider === provider && model.id === id),
				hasConfiguredAuth: (model: unknown) => Boolean(model),
			},
		};

		const result = await executor.execute(
			"watchdog-configure",
			{ action: "watchdog.configure", model: "recommended" },
			new AbortController().signal,
			undefined,
			ctx,
		);

		assert.equal(result.isError, undefined);
		assert.match(result.content[0]?.text ?? "", /session model configured: anthropic\/claude-opus-4-8:high/);
		assert.equal(watchdog.getSnapshot(tempDir).config.main.model, "anthropic/claude-opus-4-8");
	});

	it("rejects duplicate concurrent subagent execution calls", async () => {
		mockPi.onCall({ output: "first call completed", delay: 100 });
		const executor = makeExecutor([makeAgent("echo")]);
		const ctx = makeMinimalCtx(tempDir);

		const first = executor.execute("first", { agent: "echo", task: "First call" }, new AbortController().signal, undefined, ctx);
		const second = await executor.execute("second", { agent: "echo", task: "Duplicate call" }, new AbortController().signal, undefined, ctx);
		const firstResult = await first;

		assert.equal(firstResult.isError, undefined);
		assert.equal(second.isError, true);
		assert.match(second.content[0]?.text ?? "", /Issue exactly ONE subagent call per turn/);
		assert.equal(mockPi.callCount(), 1);
	});

	it("allows concurrent delegated foreground execution calls", async () => {
		mockPi.onCall({ output: "first delegated call", delay: 100 });
		mockPi.onCall({ output: "second delegated call", delay: 100 });
		const executor = makeExecutor([makeAgent("echo"), makeAgent("second")]);
		const ctx = makeMinimalCtx(tempDir);

		const [first, second] = await Promise.all([
			executor.executeDelegated("first", { agent: "echo", task: "First delegated call" }, new AbortController().signal, undefined, ctx),
			executor.executeDelegated("second", { agent: "second", task: "Second delegated call" }, new AbortController().signal, undefined, ctx),
		]);

		assert.equal(first.isError, undefined);
		assert.equal(second.isError, undefined);
		assert.equal(mockPi.callCount(), 2);
	});

	it("routes registered structured text delegation through the concurrent executor", async () => {
		const literalJsonText = '{"looks":"json"}';
		mockPi.onCall({
			steps: [
				{ jsonl: [events.toolStart("read", { path: "package.json" })], delay: 20 },
				{ jsonl: [events.toolEnd("read"), events.toolResult("read", "{}")], delay: 20 },
				{
					jsonl: [{
						type: "message_end",
						message: {
							role: "assistant",
							content: [{ type: "text", text: literalJsonText }],
							model: "mock/test-model",
							stopReason: "stop",
							usage: {
								input: 11,
								output: 7,
								cacheRead: 3,
								cacheWrite: 2,
								cost: { total: 0.0125 },
							},
						},
					}],
					delay: 60,
				},
			],
		});
		mockPi.onCall({ output: "registered structured second node", delay: 100 });
		const extensionEvents = createEventBus();
		const runtimeHandlers = new Map<string, Array<(event: unknown, ctx: ReturnType<typeof makeMinimalCtx>) => void>>();
		const fakePi = new Proxy({
			events: extensionEvents,
			on(event: string, handler: (event: unknown, ctx: ReturnType<typeof makeMinimalCtx>) => void) {
				const handlers = runtimeHandlers.get(event) ?? [];
				handlers.push(handler);
				runtimeHandlers.set(event, handlers);
				return () => runtimeHandlers.set(event, (runtimeHandlers.get(event) ?? []).filter((entry) => entry !== handler));
			},
			registerTool() {},
			registerCommand() {},
			registerShortcut() {},
			registerMessageRenderer() {},
			sendMessage() {},
			getSessionName() { return undefined; },
		}, {
			get(target, prop) {
				if (prop in target) return target[prop as keyof typeof target];
				return () => undefined;
			},
		});
		const ctx = {
			...makeMinimalCtx(tempDir),
			modelRegistry: {
				getAvailable: () => [{ provider: "mock", id: "test-model", reasoning: true }],
			},
			sessionManager: {
				getSessionId: () => "registered-delegation-session",
				getSessionFile: () => path.join(tempDir, "registered-delegation-session.jsonl"),
				getEntries: () => [],
			},
		};
		const started: SubagentDelegationStarted[] = [];
		const responses: SubagentDelegationResponse[] = [];
		extensionEvents.on(SUBAGENT_DELEGATION_STARTED_EVENT, (payload) => {
			if ((payload as { ownerRunId?: unknown }).ownerRunId === "owner-delegation") {
				started.push(payload as SubagentDelegationStarted);
			}
		});
		extensionEvents.on(SUBAGENT_DELEGATION_RESPONSE_EVENT, (payload) => {
			if ((payload as { ownerRunId?: unknown }).ownerRunId === "owner-delegation") {
				responses.push(payload as SubagentDelegationResponse);
			}
		});

		const firstRequest = {
			requestId: "registered-a",
			ownerRunId: "owner-delegation",
			nodeId: "node-a",
			agent: "worker",
			task: "Return literal JSON-looking text",
			context: "fresh",
			cwd: tempDir,
			model: "mock/test-model",
			thinking: "high",
			result: { kind: "text" },
		} satisfies SubagentDelegationRequest;
		const secondRequest = {
			requestId: "registered-b",
			ownerRunId: "owner-delegation",
			nodeId: "node-b",
			agent: "reviewer",
			task: "Run the second logical node",
			context: "fresh",
			cwd: tempDir,
			model: "mock/test-model",
			thinking: "high",
			result: { kind: "text" },
		} satisfies SubagentDelegationRequest;

		try {
			registerSubagentExtension(fakePi as never);
			for (const handler of runtimeHandlers.get("session_start") ?? []) {
				await handler({ reason: "startup" }, ctx);
			}
			extensionEvents.emit(SUBAGENT_DELEGATION_REQUEST_EVENT, firstRequest);
			extensionEvents.emit(SUBAGENT_DELEGATION_REQUEST_EVENT, secondRequest);

			const callDeadlineAt = Date.now() + 30_000;
			while (mockPi.callCount() < 2 && responses.length < 2 && Date.now() < callDeadlineAt) {
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
			assert.equal(mockPi.callCount(), 2, `different logical nodes should use the concurrent delegated execution path: ${JSON.stringify(responses)}`);
			assert.deepEqual(started.map(({ requestId, ownerRunId, nodeId }) => ({ requestId, ownerRunId, nodeId })).sort((a, b) => a.nodeId.localeCompare(b.nodeId)), [
				{ requestId: "registered-a", ownerRunId: "owner-delegation", nodeId: "node-a" },
				{ requestId: "registered-b", ownerRunId: "owner-delegation", nodeId: "node-b" },
			]);

			const responseDeadlineAt = Date.now() + 30_000;
			while (responses.length < 2 && Date.now() < responseDeadlineAt) {
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
			assert.equal(responses.length, 2);
			assert.ok(responses.every((response) => response.status === "completed"));
			const terminalResponses = responses.filter((response) => response.status !== "invalid_request");
			assert.equal(terminalResponses.length, 2);
			for (const response of terminalResponses) {
				assert.equal(response.ownerRunId, "owner-delegation");
				assert.equal(response.model, "mock/test-model:high");
				assert.equal(response.thinking, "high");
				assert.match(response.launchContractDigest ?? "", /^[0-9a-f]{64}$/);
			}
			const literalResponse = terminalResponses.find((response) => response.result?.kind === "text" && response.result.text === literalJsonText);
			assert.ok(literalResponse);
			assert.deepEqual(literalResponse.result, { kind: "text", text: literalJsonText });
			assert.deepEqual(literalResponse.usage && {
				input: literalResponse.usage.input,
				output: literalResponse.usage.output,
				cacheRead: literalResponse.usage.cacheRead,
				cacheWrite: literalResponse.usage.cacheWrite,
				cost: literalResponse.usage.cost,
				turns: literalResponse.usage.turns,
				toolCalls: literalResponse.usage.toolCalls,
			}, {
				input: 11,
				output: 7,
				cacheRead: 3,
				cacheWrite: 2,
				cost: 0.0125,
				turns: 1,
				toolCalls: 1,
			});
			assert.equal(typeof literalResponse.usage?.durationMs, "number");
			const plainResponse = terminalResponses.find((response) => response.result?.kind === "text" && response.result.text === "registered structured second node");
			assert.ok(plainResponse);
		} finally {
			for (const handler of runtimeHandlers.get("session_shutdown") ?? []) {
				await handler({}, ctx);
			}
		}
	});

	it("allows concurrent async launches in one turn", async () => {
		mockPi.onCall({ output: "async one" });
		mockPi.onCall({ output: "async two" });
		const executor = makeExecutor([makeAgent("echo"), makeAgent("second")]);
		const ctx = makeMinimalCtx(tempDir);
		const [first, second] = await Promise.all([
			executor.execute("first", { agent: "echo", task: "First", async: true }, new AbortController().signal, undefined, ctx),
			executor.execute("second", { agent: "second", task: "Second", async: true }, new AbortController().signal, undefined, ctx),
		]);
		assert.doesNotMatch(first.content[0]?.text ?? "", /Issue exactly ONE subagent call per turn/);
		assert.doesNotMatch(second.content[0]?.text ?? "", /Issue exactly ONE subagent call per turn/);
		const deadlineAt = Date.now() + 30_000;
		while (mockPi.callCount() < 2 && Date.now() < deadlineAt) {
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		assert.equal(mockPi.callCount(), 2, "both detached mock children should start before test cleanup");
	});

	it("does not impose a cumulative spawn cap by default", async () => {
		mockPi.onCall({ output: "continued after forty launches" });
		const spawnState = { sessionId: "session-123", count: 40 };
		const executor = makeExecutor([makeAgent("echo")], {}, false, spawnState);
		const ctx = makeMinimalCtx(tempDir);

		const result = await executor.execute("forty-one", { agent: "echo", task: "Continue work" }, new AbortController().signal, undefined, ctx);

		assert.equal(result.isError, undefined);
		assert.equal(mockPi.callCount(), 1);
		assert.equal(spawnState.count, 40, "unlimited sessions should bypass cumulative accounting");
	});

	it("blocks total subagent spawns after an opt-in per-session quota", async () => {
		mockPi.onCall({ output: "first call completed" });
		const executor = makeExecutor([makeAgent("echo")], { maxSubagentSpawnsPerSession: 1 });
		const ctx = makeMinimalCtx(tempDir);

		const first = await executor.execute("first", { agent: "echo", task: "First call" }, new AbortController().signal, undefined, ctx);
		const second = await executor.execute("second", { agent: "echo", task: "Second call" }, new AbortController().signal, undefined, ctx);

		assert.equal(first.isError, undefined);
		assert.equal(second.isError, true);
		assert.match(second.content[0]?.text ?? "", /Subagent spawn limit reached for this session \(1\/1 used, 1 requested\)/);
		assert.equal(mockPi.callCount(), 1);
	});

	it("reports structured spawn-budget usage through status", async () => {
		const spawnState = { sessionId: "session-123", count: 3, configuredLimit: 4, granted: 1, grantHistory: [] };
		const executor = makeExecutor([makeAgent("echo")], { maxSubagentSpawnsPerSession: 4 }, false, spawnState);

		const status = await executor.execute("status", { action: "status" }, new AbortController().signal, undefined, makeMinimalCtx(tempDir));

		assert.match(status.content[0]?.text ?? "", /^Status target: active runs\nSpawn budget: 3\/5 used, 2 remaining/);
		assert.deepEqual(status.details?.spawnBudget, {
			used: 3,
			configuredLimit: 4,
			granted: 1,
			limit: 5,
			remaining: 2,
			grantRemaining: 3,
			grantHistory: [],
		});
	});

	it("preflights static chains before creating run artifacts", async () => {
		const sessionDir = path.join(tempDir, "preflight-session");
		const executor = makeExecutor(
			[makeAgent("echo"), makeAgent("second")],
			{ maxSubagentSpawnsPerSession: 1 },
		);
		const result = await executor.execute(
			"chain-preflight",
			{
				chain: [
					{ agent: "echo", task: "First" },
					{ agent: "second", task: "Second" },
				],
				sessionDir,
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /0\/1 used, 2 requested\).*1 remaining/);
		assert.match(result.content[0]?.text ?? "", /no children were started/);
		assert.equal(fs.existsSync(sessionDir), false);
		assert.equal(mockPi.callCount(), 0);
	});

	it("applies bounded root-interactive spawn-budget grants", async () => {
		mockPi.onCall({ output: "continued after grant" });
		const spawnState = { sessionId: "session-123", count: 1 };
		const executor = makeExecutor([makeAgent("echo")], { maxSubagentSpawnsPerSession: 1 }, false, spawnState);
		const decisions = [false, true];
		let confirmations = 0;
		const interactiveCtx = {
			...makeMinimalCtx(tempDir),
			hasUI: true,
			ui: { confirm: async () => { confirmations += 1; return decisions.shift() ?? false; } },
		};

		const canceled = await executor.execute(
			"cancel-grant",
			{ action: "grant-spawn-budget", additional: 1 },
			new AbortController().signal,
			undefined,
			interactiveCtx,
		);
		const granted = await executor.execute(
			"grant",
			{ action: "grant-spawn-budget", additional: 1 },
			new AbortController().signal,
			undefined,
			interactiveCtx,
		);
		const run = await executor.execute(
			"after-grant",
			{ agent: "echo", task: "Continue" },
			new AbortController().signal,
			undefined,
			interactiveCtx,
		);
		const exhausted = await executor.execute(
			"grant-again",
			{ action: "grant-spawn-budget", additional: 1 },
			new AbortController().signal,
			undefined,
			interactiveCtx,
		);

		assert.equal(canceled.isError, undefined);
		assert.match(canceled.content[0]?.text ?? "", /grant canceled; no capacity was added/i);
		assert.equal(granted.isError, undefined);
		assert.match(granted.content[0]?.text ?? "", /grant applied: \+1/i);
		assert.equal(confirmations, 2);
		assert.equal(granted.details?.spawnBudget?.limit, 2);
		assert.equal(run.isError, undefined);
		assert.equal(spawnState.count, 2);
		assert.equal(exhausted.isError, true);
		assert.match(exhausted.content[0]?.text ?? "", /only 0 of the original configured limit remains grantable/);
	});

	it("rechecks spawn-budget state after confirmation", async () => {
		const spawnState = { sessionId: "session-123", count: 0 };
		const executor = makeExecutor([makeAgent("echo")], { maxSubagentSpawnsPerSession: 2 }, false, spawnState);
		const ctx = {
			...makeMinimalCtx(tempDir),
			hasUI: true,
			ui: { confirm: async () => { spawnState.count = 1; return true; } },
		};

		const result = await executor.execute(
			"grant-race",
			{ action: "grant-spawn-budget", additional: 1 },
			new AbortController().signal,
			undefined,
			ctx,
		);

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /budget, or active-child state changed/);
		assert.equal(result.details?.spawnBudget?.granted, 0);
	});

	it("rejects spawn-budget grants outside a settled root interactive session", async () => {
		mockPi.onCall({ output: "still running", delay: 100 });
		const executor = makeExecutor([makeAgent("echo")], { maxSubagentSpawnsPerSession: 2 });
		const headless = await executor.execute(
			"headless-grant",
			{ action: "grant-spawn-budget", additional: 1 },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		const childSafe = makeExecutor([makeAgent("echo")], { maxSubagentSpawnsPerSession: 2 }, false, undefined, false);
		const child = await childSafe.execute(
			"child-grant",
			{ action: "grant-spawn-budget", additional: 1 },
			new AbortController().signal,
			undefined,
			{ ...makeMinimalCtx(tempDir), hasUI: true },
		);
		const asyncActive = makeExecutor(
			[makeAgent("echo")],
			{ maxSubagentSpawnsPerSession: 2 },
			false,
			undefined,
			true,
			new Map([["async-active", { asyncId: "async-active", asyncDir: tempDir, status: "running", sessionId: "session-123" }]]),
		);
		const detached = await asyncActive.execute(
			"async-active-grant",
			{ action: "grant-spawn-budget", additional: 1 },
			new AbortController().signal,
			undefined,
			{ ...makeMinimalCtx(tempDir), hasUI: true },
		);
		const running = executor.execute(
			"running",
			{ agent: "echo", task: "Long run" },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		const active = await executor.execute(
			"active-grant",
			{ action: "grant-spawn-budget", additional: 1 },
			new AbortController().signal,
			undefined,
			{ ...makeMinimalCtx(tempDir), hasUI: true },
		);
		await running;

		assert.equal(headless.isError, true);
		assert.match(headless.content[0]?.text ?? "", /root interactive parent session/);
		assert.equal(child.isError, true);
		assert.match(child.content[0]?.text ?? "", /root interactive parent session/);
		assert.equal(detached.isError, true);
		assert.match(detached.content[0]?.text ?? "", /rejected while current-session children are queued or running/);
		assert.equal(active.isError, true);
		assert.match(active.content[0]?.text ?? "", /rejected while current-session children are queued or running/);
	});

	it("allows management actions while an execution call is in progress", async () => {
		mockPi.onCall({ output: "first call completed", delay: 100 });
		const executor = makeExecutor([makeAgent("echo")]);
		const ctx = makeMinimalCtx(tempDir);

		const first = executor.execute("first", { agent: "echo", task: "First call" }, new AbortController().signal, undefined, ctx);
		const status = await executor.execute("status", { action: "status" }, new AbortController().signal, undefined, ctx);
		const firstResult = await first;

		assert.equal(firstResult.isError, undefined);
		assert.equal(status.isError, undefined);
		assert.doesNotMatch(status.content[0]?.text ?? "", /Rejected: a subagent call is already in progress/);
		assert.equal(mockPi.callCount(), 1);
	});

	it("allows intentional parallel tasks inside one subagent execution call", async () => {
		mockPi.onCall({ output: "first parallel result" });
		mockPi.onCall({ output: "second parallel result" });
		const executor = makeExecutor([makeAgent("echo"), makeAgent("second")]);

		const result = await executor.execute(
			"parallel",
			{ tasks: [{ agent: "echo", task: "First task" }, { agent: "second", task: "Second task" }] },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, undefined);
		assert.equal(mockPi.callCount(), 2);
		assert.deepEqual(result.details?.totalCost, { inputTokens: 200, outputTokens: 100, costUsd: 0.002 });
	});

	it("reports total cost for foreground single runs", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "single result" });
		const executor = makeExecutor([makeAgent("echo")]);

		const result = await executor.execute(
			"single-cost",
			{ agent: "echo", task: "Single task" },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, undefined);
		assert.deepEqual(result.details?.totalCost, { inputTokens: 100, outputTokens: 50, costUsd: 0.001 });
	});

	it("ignores stale foreground control notification contexts after reload", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({
			jsonl: [
				events.assistantMessage("first update"),
				events.assistantMessage("second update"),
			],
		});
		const state: SubagentState = {
			baseCwd: tempDir,
			currentSessionId: null,
			asyncJobs: new Map(),
			foregroundRuns: new Map(),
			foregroundControls: new Map(),
			lastForegroundControlId: null,
		};
		const staleEvents = {
			on: createEventBus().on,
			emit() { throw new Error("This extension ctx is stale after session replacement or reload."); },
		};
		const updates: ExecutorToolResult[] = [];
		const executor = createSubagentExecutor!({
			pi: { events: staleEvents, getSessionName: () => undefined },
			state,
			config: { control: { enabled: true, activeNoticeAfterTurns: 2, activeNoticeAfterMs: 999_999, activeNoticeAfterTokens: 999_999, notifyOn: ["active_long_running"], notifyChannels: ["event"] } },
			asyncByDefault: false,
			tempArtifactsDir: tempDir,
			getSubagentSessionRoot: () => path.join(tempDir, ".pi-subagents", "sessions"),
			expandTilde: (value: string) => value,
			discoverAgents: () => ({ agents: [makeAgent("echo")] }),
			allowMutatingManagementActions: true,
		});

		const result = await executor.execute(
			"stale-control-context",
			{ agent: "echo", task: "Investigate behavior", async: false },
			new AbortController().signal,
			(update: ExecutorToolResult) => updates.push(update),
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, undefined, result.content[0]?.text ?? "foreground run failed");
		assert.equal(result.details.results[0]?.exitCode, 0);
		const controlEvents = updates.flatMap((update) => update.details?.controlEvents ?? []);
		assert.equal(controlEvents[0]?.type, "active_long_running");
	});

	it("emits resolved model and thinking for nested foreground starts", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "nested result" });
		const route = createNestedRoute("root-nested-model");
		const envPatch = {
			...nestedRouteEnv(route),
			[SUBAGENT_PARENT_RUN_ID_ENV]: "parent-run",
			[SUBAGENT_PARENT_CHILD_INDEX_ENV]: "2",
			[SUBAGENT_PARENT_DEPTH_ENV]: "1",
		};
		const savedEnv = Object.fromEntries(Object.keys(envPatch).map((key) => [key, process.env[key]]));
		try {
			Object.assign(process.env, envPatch);
			const executor = makeExecutor([makeAgent("echo", { model: "openai/gpt-5-mini", thinking: "high" })]);

			const result = await executor.execute(
				"nested-model-start",
				{ agent: "echo", task: "Nested task" },
				new AbortController().signal,
				undefined,
				makeMinimalCtx(tempDir),
			);

			assert.equal(result.isError, undefined);
			const records = fs.readdirSync(route.eventSink)
				.sort()
				.flatMap((name) => parseNestedEventRecords(fs.readFileSync(path.join(route.eventSink, name), "utf-8"), route));
			const started = records.find((record) => record.type === "subagent.nested.started");
			assert.equal(started?.child.model, "openai/gpt-5-mini");
			assert.equal(started?.child.thinking, "high");
			assert.deepEqual(started?.child.steps, [{ agent: "echo", status: "running", model: "openai/gpt-5-mini", thinking: "high" }]);
		} finally {
			for (const [key, value] of Object.entries(savedEnv)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
			fs.rmSync(path.dirname(route.eventSink), { recursive: true, force: true });
		}
	});

	it("blocks later foreground chain children when hard reported usage is exhausted", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "first result" });
		const executor = makeExecutor([makeAgent("echo"), makeAgent("second")]);

		const result = await executor.execute(
			"foreground-usage-budget",
			{
				chain: [
					{ agent: "echo", task: "First task" },
					{ agent: "second", task: "Second task" },
				],
				usageBudget: { tokens: { hard: 10 } },
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /Usage budget exhausted/);
		assert.equal(mockPi.callCount(), 1);
		assert.equal(result.details?.usageBudget?.exhausted, true);
		assert.equal(result.details?.usageBudget?.reason, "tokens");
	});

	it("blocks queued foreground parallel children when hard reported usage is exhausted", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "first result" });
		const executor = makeExecutor([makeAgent("echo"), makeAgent("second")]);

		const result = await executor.execute(
			"foreground-parallel-usage-budget",
			{
				tasks: [
					{ agent: "echo", task: "First task" },
					{ agent: "second", task: "Second task" },
				],
				concurrency: 1,
				usageBudget: { tokens: { hard: 10 } },
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, undefined);
		assert.equal(mockPi.callCount(), 1);
		assert.equal(result.details?.results.length, 2);
		assert.equal(result.details?.results[1]?.skipped, true);
		assert.match(result.details?.results[1]?.error ?? "", /Usage budget exhausted/);
		assert.equal(result.details?.usageBudget?.exhausted, true);
	});

	it("fails implementation runs that complete without mutation attempts", async () => {
		mockPi.onCall({ output: "Validation:\nlet rawFilename = params.filename.trim();" });
		const agents = [makeAgent("worker")];
		const controlEvents: Array<{ message: string }> = [];

		const result = await runSync(tempDir, agents, "worker", "Implement the approved file changes", {
			runId: "guard-run",
			onControlEvent: (event: { message: string }) => controlEvents.push(event),
		});

		assert.equal(result.exitCode, 1);
		assert.match(result.error ?? "", /completed without making edits/);
		assert.equal(result.finalOutput, "Validation:\nlet rawFilename = params.filename.trim();");
		assert.equal(result.progress.status, "failed");
		assert.deepEqual(controlEvents.map((event) => event.message), [
			"worker completed without making edits for an implementation task",
		]);
		assert.deepEqual(result.controlEvents?.map((event) => event.message), [
			"worker completed without making edits for an implementation task",
		]);
	});

	it("agent contract v1 reports omitted acceptance separately without injecting a prompt", async () => {
		mockPi.onCall({ output: "Plan only" });
		const agents = [makeAgent("worker", { tools: ["read", "write"] })];

		const result = await runSync(tempDir, agents, "worker", "Implement the approved file changes", {
			runId: "v1-no-acceptance",
			agentContract: { version: 1 },
		});
		const call = readCall();

		assert.equal(result.exitCode, 0);
		assert.equal(result.agentContract?.version, 1);
		assert.deepEqual(result.execution, { status: "completed", success: true, exitCode: 0 });
		assert.equal(result.acceptance?.status, "not-required");
		assert.equal(result.review?.status, "not-requested");
		assert.deepEqual(result.effects, {});
		assert.doesNotMatch(call.args.join("\n"), /## Acceptance Contract/);
	});

	it("agent contract v1 keeps acceptance rejection out of execution status", async () => {
		mockPi.onCall({ output: "Done\n```acceptance-report\n{\"criteriaSatisfied\":[{\"id\":\"criterion-1\",\"status\":\"not-satisfied\",\"evidence\":\"no proof\"}]}\n```" });
		const agents = [makeAgent("worker", { tools: ["read"], completionGuard: false })];

		const result = await runSync(tempDir, agents, "worker", "Summarize the fix", {
			runId: "v1-acceptance-reject",
			agentContract: { version: 1 },
			acceptance: { level: "checked", criteria: ["Return required proof"] },
		});

		assert.equal(result.exitCode, 0);
		assert.equal(result.error, undefined);
		assert.equal(result.execution?.status, "completed");
		assert.equal(result.execution?.success, true);
		assert.equal(result.acceptance?.status, "rejected");
		assert.match(result.acceptance.runtimeChecks?.[0]?.message ?? "", /not-satisfied/);
	});

	it("agent contract v1 records explicit completion guard as an effect", async () => {
		mockPi.onCall({ output: "Plan only" });
		const agents = [makeAgent("worker", { tools: ["read", "write"], completionGuard: true })];

		const result = await runSync(tempDir, agents, "worker", "Implement the approved file changes", {
			runId: "v1-completion-effect",
			agentContract: { version: 1 },
		});

		assert.equal(result.exitCode, 0);
		assert.equal(result.execution?.status, "completed");
		assert.equal(result.effects?.fileMutation?.status, "missing");
		assert.equal(result.effects?.fileMutation?.expected, true);
		assert.equal(result.effects?.fileMutation?.attempted, false);
	});

	it("direct single tool calls support outputSchema", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({
			stdoutRaw: [
				{ type: "tool_execution_start", toolName: "structured_output", args: { value: { ok: true, note: "captured" } } },
				{ type: "tool_result_end", message: { role: "toolResult", toolName: "structured_output", content: [{ type: "text", text: "Structured output captured." }] } },
				{ type: "tool_execution_end", toolName: "structured_output" },
			].map((entry) => JSON.stringify(entry)).join("\n") + "\n",
			structuredOutputCapture: { ok: true, note: "captured" },
		});
		const executor = makeExecutor([makeAgent("echo")]);

		const result = await executor.execute(
			"single-schema",
			{ agent: "echo", task: "Return structured data", outputSchema: { type: "object", required: ["ok"], properties: { ok: { type: "boolean" }, note: { type: "string" } } }, acceptance: false },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, undefined);
		const child = result.details?.results?.[0];
		assert.deepEqual(child?.structuredOutput, { ok: true, note: "captured" });
		assert.match(child?.finalOutput ?? "", /"ok": true/);
		if (child?.artifactPaths?.outputPath) assert.match(fs.readFileSync(child.artifactPaths.outputPath, "utf-8"), /"note": "captured"/);
	});

	it("accepts recovered tool errors before valid structured output but rejects later errors", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const recoveredError = { type: "tool_result_end", message: { role: "toolResult", toolName: "read", isError: true, content: [{ type: "text", text: "EISDIR" }] } };
		const structuredEvents = [
			{ type: "tool_execution_start", toolName: "structured_output", args: { value: { ok: true } } },
			{ type: "tool_result_end", message: { role: "toolResult", toolName: "structured_output", content: [{ type: "text", text: "Structured output captured." }] } },
			{ type: "tool_execution_end", toolName: "structured_output" },
		];
		mockPi.onCall({
			stdoutRaw: [recoveredError, ...structuredEvents].map((entry) => JSON.stringify(entry)).join("\n") + "\n",
			structuredOutputCapture: { ok: true },
		});
		const executor = makeExecutor([makeAgent("echo")]);
		const params = { agent: "echo", task: "Return structured data", outputSchema: { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } }, acceptance: false } as const;

		const recovered = await executor.execute("single-schema-recovered-error", params, new AbortController().signal, undefined, makeMinimalCtx(tempDir));

		assert.equal(recovered.isError, undefined);
		assert.deepEqual(recovered.details?.results?.[0]?.structuredOutput, { ok: true });

		mockPi.reset();
		mockPi.onCall({
			stdoutRaw: [...structuredEvents, recoveredError].map((entry) => JSON.stringify(entry)).join("\n") + "\n",
			structuredOutputCapture: { ok: true },
		});
		const terminal = await executor.execute("single-schema-terminal-error", params, new AbortController().signal, undefined, makeMinimalCtx(tempDir));

		assert.equal(terminal.isError, true);
		assert.match(terminal.details?.results?.[0]?.error ?? "", /read failed/);
	});

	it("rejects structured output capture files that were not produced by the structured_output tool", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "spoofed", structuredOutputCapture: { ok: true } });
		const executor = makeExecutor([makeAgent("echo")]);

		const result = await executor.execute(
			"single-schema-spoof",
			{ agent: "echo", task: "Return structured data", outputSchema: { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } }, acceptance: false, artifacts: false },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		const child = result.details?.results?.[0];
		assert.equal(result.isError, true);
		assert.equal(child?.structuredOutputFailed, true);
		assert.match(child?.error ?? "", /Missing structured_output call/);
		assert.ok(child?.structuredOutputPath);
		assert.equal(fs.existsSync(path.dirname(child.structuredOutputPath)), false);
	});

	it("does not create a temporary structured output directory before file-only validation", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const previousTmpdir = process.env.TMPDIR;
		process.env.TMPDIR = tempDir;
		try {
			const executor = makeExecutor([makeAgent("echo")]);

			const result = await executor.execute(
				"single-schema-file-only-missing-path",
				{ agent: "echo", task: "Return structured data", outputSchema: { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } }, outputMode: "file-only", acceptance: false, artifacts: false },
				new AbortController().signal,
				undefined,
				makeMinimalCtx(tempDir),
			);

			assert.equal(result.isError, true);
			assert.match(result.content[0]?.text ?? "", /outputMode: "file-only"/);
			assert.equal(mockPi.callCount(), 0);
			assert.equal(fs.readdirSync(tempDir).some((name) => name.startsWith("pi-subagent-structured-")), false);
		} finally {
			if (previousTmpdir === undefined) delete process.env.TMPDIR;
			else process.env.TMPDIR = previousTmpdir;
		}
	});

	it("allows a structured_output tool call at the exact strict turn boundary", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({
			stdoutRaw: [
				{
					type: "message_end",
					message: {
						role: "assistant",
						content: [{ type: "toolCall", id: "structured-1", name: "structured_output", arguments: { value: { ok: true } } }],
						model: "mock/test-model",
						stopReason: "toolUse",
						usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } },
					},
				},
				{ type: "tool_execution_start", toolName: "structured_output", args: { value: { ok: true } } },
				{ type: "tool_result_end", message: { role: "toolResult", toolName: "structured_output", content: [{ type: "text", text: "Structured output captured." }] } },
				{ type: "tool_execution_end", toolName: "structured_output" },
			].map((entry) => JSON.stringify(entry)).join("\n") + "\n",
			structuredOutputCapture: { ok: true },
		});
		const executor = makeExecutor([makeAgent("echo")]);

		const result = await executor.execute(
			"single-schema-strict-boundary",
			{ agent: "echo", task: "Return structured data", outputSchema: { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } }, turnBudget: { maxTurns: 1, graceTurns: 0 }, enforceHardTurnLimit: true, acceptance: false },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		const child = result.details?.results?.[0];
		assert.equal(result.isError, undefined);
		assert.equal(child?.turnBudgetExceeded, undefined);
		assert.deepEqual(child?.structuredOutput, { ok: true });
	});

	it("returns captured output when the foreground executor fails an implementation run", async () => {
		mockPi.onCall({ output: "Oracle review:\n- finding one\n- finding two" });
		const executor = makeExecutor([makeAgent("oracle")]);

		const result = await executor.execute(
			"failed-single-output",
			{ agent: "oracle", task: "Implement the approved file changes" },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		const text = result.content[0]?.text ?? "";
		assert.equal(result.isError, true);
		assert.match(text, /completed without making edits/);
		assert.match(text, /Output:\nOracle review:\n- finding one\n- finding two/);
		assert.match(text, /Output artifact: /);
	});

	it("fails future-tense implementation summaries when no mutation attempt occurred", async () => {
		mockPi.onCall({ output: "I’ll do that now and report back after implementing." });
		const agents = [makeAgent("worker")];

		const result = await runSync(tempDir, agents, "worker", "Implement the approved fixes", {
			runId: "guard-future-tense",
		});

		assert.equal(result.exitCode, 1);
		assert.match(result.error ?? "", /completed without making edits/);
	});

	it("allows declared read-only agents to mention implementation words without edits", async () => {
		mockPi.onCall({ output: "Validation report after the patch" });
		const agents = [makeAgent("architect", { tools: ["read", "grep", "find", "ls"] })];

		const result = await runSync(tempDir, agents, "architect", "Produce a proposal that implements the approved fix", {
			runId: "guard-readonly-tools",
		});

		assert.equal(result.exitCode, 0);
		assert.equal(result.progress.status, "completed");
		assert.equal(result.finalOutput, "Validation report after the patch");
	});

	it("keeps bash-enabled implementation tasks conservative unless completion guard is disabled", async () => {
		mockPi.onCall({ output: "cold start test after patch" });
		mockPi.onCall({ output: "cold start test after patch" });
		const agents = [
			makeAgent("test-runner", { tools: ["read", "grep", "bash", "ls"] }),
			makeAgent("test-runner-optout", { tools: ["read", "grep", "bash", "ls"], completionGuard: false }),
		];

		const withoutOptOut = await runSync(tempDir, agents, "test-runner", "Patch the cold start test", {
			runId: "guard-bash-conservative",
		});
		assert.equal(withoutOptOut.exitCode, 1);
		assert.match(withoutOptOut.error ?? "", /completed without making edits/);

		const withOptOut = await runSync(tempDir, agents, "test-runner-optout", "Patch the cold start test", {
			runId: "guard-bash-optout",
		});
		assert.equal(withOptOut.exitCode, 0);
		assert.equal(withOptOut.progress.status, "completed");
	});

	it("allows implementation runs when parsed messages include a real edit tool call", async () => {
		mockPi.onCall({
			jsonl: [
				{
					type: "message_end",
					message: {
						role: "assistant",
						content: [{ type: "toolCall", name: "edit", arguments: { path: "src/file.ts", oldText: "a", newText: "b" } }],
						model: "mock/test-model",
						stopReason: "toolUse",
						usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } },
					},
				},
				events.assistantMessage("Applied edit"),
			],
		});
		const agents = [makeAgent("worker")];

		const result = await runSync(tempDir, agents, "worker", "Implement the approved file changes", {
			runId: "guard-success",
		});

		assert.equal(result.exitCode, 0);
		assert.equal(result.progress.status, "completed");
		assert.equal(result.finalOutput, "Applied edit");
	});

	it("resolves explicit agent aliases to canonical execution names", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "Implemented" });
		const executor = makeExecutor([makeAgent("worker", { aliases: ["developer"], completionGuard: false })]);

		const result = await executor.execute("single", { agent: "developer", task: "Implement" }, new AbortController().signal, undefined, makeMinimalCtx(tempDir));

		assert.equal(result.isError, undefined);
		assert.equal(result.details?.results[0]?.agent, "worker");
		assert.match(result.content[0]?.text ?? "", /Implemented/);
	});

	it("returns error for unknown agent", async () => {
		const agents = makeAgentConfigs(["echo"]);
		const result = await runSync(tempDir, agents, "nonexistent", "Do something", {});

		assert.equal(result.exitCode, 1);
		assert.ok(result.error?.includes("Unknown agent"));
	});


	it("emits an active-long-running notice after the turn threshold", async () => {
		mockPi.onCall({
			jsonl: [
				events.assistantMessage("first update"),
				events.assistantMessage("second update"),
			],
		});
		const agents = makeAgentConfigs(["echo"]);
		const controlEvents: NonNullable<RunSyncResult["controlEvents"]> = [];

		const result = await runSync(tempDir, agents, "echo", "Investigate behavior", {
			runId: "run-active",
			controlConfig: { enabled: true, activeNoticeAfterTurns: 2, activeNoticeAfterMs: 999_999, activeNoticeAfterTokens: 999_999, notifyOn: ["active_long_running", "needs_attention"] },
			onControlEvent: (event: NonNullable<RunSyncResult["controlEvents"]>[number]) => controlEvents.push(event),
		});

		assert.equal(result.exitCode, 0);
		assert.equal(controlEvents.length, 1);
		assert.equal(controlEvents[0]?.type, "active_long_running");
		assert.equal(controlEvents[0]?.reason, "turn_threshold");
		assert.equal(controlEvents[0]?.turns, 2);
		assert.equal(result.controlEvents?.[0]?.type, "active_long_running");
		assert.equal(result.progress.activityState, "active_long_running");
	});

	it("escalates repeated mutating tool failures to needs attention", async () => {
		mockPi.onCall({
			jsonl: [
				events.toolStart("edit", { path: "src/runs/background/async-status.ts" }),
				events.toolEnd("edit"),
				events.toolResult("edit", "No exact match found for async-status.ts", true),
				events.toolStart("edit", { path: "src/runs/background/async-status.ts" }),
				events.toolEnd("edit"),
				events.toolResult("edit", "No exact match found for async-status.ts", true),
				events.toolStart("edit", { path: "src/runs/background/async-status.ts" }),
				events.toolEnd("edit"),
				events.toolResult("edit", "No exact match found for async-status.ts", true),
				events.assistantMessage("I need to retry the same edit."),
			],
		});
		const agents = [makeAgent("worker")];
		const controlEvents: NonNullable<RunSyncResult["controlEvents"]> = [];

		const result = await runSync(tempDir, agents, "worker", "Implement the approved fixes", {
			runId: "run-failures",
			controlConfig: { enabled: true, failedToolAttemptsBeforeAttention: 3, notifyOn: ["active_long_running", "needs_attention"] },
			onControlEvent: (event: NonNullable<RunSyncResult["controlEvents"]>[number]) => controlEvents.push(event),
		});

		assert.equal(result.exitCode, 0);
		const failureEvent = controlEvents.find((event) => event.reason === "tool_failures");
		assert.equal(failureEvent?.type, "needs_attention");
		assert.equal(failureEvent?.currentPath, "src/runs/background/async-status.ts");
		assert.match(failureEvent?.recentFailureSummary ?? "", /No exact match/);
		assert.equal(result.progress.activityState, "needs_attention");
	});

	it("does not surface control state or events when control is disabled", async () => {
		mockPi.onCall({
			jsonl: [
				events.assistantMessage("first update"),
				events.assistantMessage("second update"),
			],
		});
		const agents = makeAgentConfigs(["echo"]);
		const controlEvents: NonNullable<RunSyncResult["controlEvents"]> = [];

		const result = await runSync(tempDir, agents, "echo", "Investigate behavior", {
			runId: "run-control-disabled",
			controlConfig: { enabled: false, activeNoticeAfterTurns: 1, activeNoticeAfterMs: 1, activeNoticeAfterTokens: 1, notifyOn: ["active_long_running", "needs_attention"] },
			onControlEvent: (event: NonNullable<RunSyncResult["controlEvents"]>[number]) => controlEvents.push(event),
		});

		assert.equal(result.exitCode, 0);
		assert.equal(result.progress.activityState, undefined);
		assert.equal(result.controlEvents, undefined);
		assert.equal(controlEvents.length, 0);
	});

	it("captures non-zero exit code", async () => {
		mockPi.onCall({ exitCode: 1, stderr: "Something went wrong" });
		const agents = makeAgentConfigs(["fail"]);

		const result = await runSync(tempDir, agents, "fail", "Do something", {});

		assert.equal(result.exitCode, 1);
		assert.ok(result.error?.includes("Something went wrong"));
	});

	it("retries a zero-activity startup exit on the same model", async () => {
		mockPi.onCall({ exitCode: 1 });
		mockPi.onCall({ output: "Recovered after startup race" });
		const agents = [makeAgent("worker", {
			model: "openai/gpt-5-mini",
			fallbackModels: ["anthropic/claude-sonnet-4"],
		})];

		const result = await runSync(tempDir, agents, "worker", "Do work", {
			runId: "startup-retry-sync",
			acceptance: false,
		});

		assert.equal(result.exitCode, 0);
		assert.equal(result.model, "openai/gpt-5-mini");
		assert.equal(result.finalOutput, "Recovered after startup race");
		assert.deepEqual(result.attemptedModels, ["openai/gpt-5-mini"]);
		assert.deepEqual(result.modelAttempts?.map((attempt) => attempt.success), [false, true]);
		assert.match(result.progress.recentOutput.join("\n"), /\[startup-retry\].*same model/i);
		assert.equal(result.progress.recentOutput.filter((line) => line.startsWith("[startup-retry]")).length, 1);
		assert.equal(mockPi.callCount(), 2);
	});

	it("does not retry a non-zero exit after tool activity", async () => {
		mockPi.onCall({ jsonl: [events.toolStart("read", { path: "package.json" })], exitCode: 1 });
		mockPi.onCall({ output: "must not run" });
		const agents = [makeAgent("worker", {
			model: "openai/gpt-5-mini",
			fallbackModels: ["anthropic/claude-sonnet-4"],
		})];

		const result = await runSync(tempDir, agents, "worker", "Read a file", {
			runId: "startup-no-retry-after-tool",
			acceptance: false,
		});

		assert.equal(result.exitCode, 1);
		assert.equal(result.modelAttempts?.length, 1);
		assert.equal(mockPi.callCount(), 1);
	});

	it("does not retry non-SIGKILL signaled child exits", { skip: process.platform === "win32" ? "POSIX child signal reporting is unavailable on Windows" : false }, async () => {
		mockPi.onCall({ signal: "SIGTERM" });
		mockPi.onCall({ output: "must not run" });
		const agents = [makeAgent("worker", { model: "openai/gpt-5-mini" })];

		const result = await runSync(tempDir, agents, "worker", "Do work", {
			runId: "startup-no-retry-after-signal",
			acceptance: false,
		});

		assert.equal(result.exitCode, 1);
		assert.equal(result.processSignal, "SIGTERM");
		assert.equal(result.error, "Subagent process terminated by signal SIGTERM.");
		assert.equal(result.modelAttempts?.length, 1);
		assert.equal(mockPi.callCount(), 1);
	});

	it("prefers signal termination errors over stderr tails", { skip: process.platform === "win32" ? "POSIX child signal reporting is unavailable on Windows" : false }, async () => {
		mockPi.onCall({ stderr: "INFO benign startup line\n", signal: "SIGTERM" });
		const agents = [makeAgent("worker", { model: "openai/gpt-5-mini" })];

		const result = await runSync(tempDir, agents, "worker", "Do work", {
			runId: "signal-error-over-stderr",
			acceptance: false,
		});

		assert.equal(result.exitCode, 1);
		assert.equal(result.processSignal, "SIGTERM");
		assert.equal(result.error, "Subagent process terminated by signal SIGTERM.");
		assert.doesNotMatch(result.error ?? "", /INFO benign startup line/);
	});

	it("does not retry a child exit with raw stdout diagnostics", async () => {
		mockPi.onCall({ stdoutRaw: "configuration failed before protocol startup\n", exitCode: 1 });
		mockPi.onCall({ output: "must not run" });
		const agents = [makeAgent("worker", { model: "openai/gpt-5-mini" })];

		const result = await runSync(tempDir, agents, "worker", "Do work", {
			runId: "startup-no-retry-after-stdout-diagnostic",
			acceptance: false,
		});

		assert.equal(result.exitCode, 1);
		assert.match(result.error ?? "", /configuration failed before protocol startup/);
		assert.equal(result.modelAttempts?.length, 1);
		assert.equal(mockPi.callCount(), 1);
	});

	it("reports an actionable error after startup retries are exhausted", async () => {
		mockPi.onCall({ exitCode: 1 });
		const agents = [makeAgent("worker", {
			model: "openai/gpt-5-mini",
			fallbackModels: ["anthropic/claude-sonnet-4"],
		})];

		const result = await runSync(tempDir, agents, "worker", "Do work", {
			runId: "startup-retry-exhausted-sync",
			acceptance: false,
		});

		assert.equal(result.exitCode, 1);
		assert.equal(result.modelAttempts?.length, 4);
		assert.deepEqual(result.attemptedModels, ["openai/gpt-5-mini"]);
		assert.match(result.error ?? "", /failed to start after 4 attempts.*concurrent Pi startup race/i);
		assert.equal(mockPi.callCount(), 4);
	});

	it("handles long tasks via temp file (ENAMETOOLONG prevention)", async () => {
		mockPi.onCall({ output: "Got it" });
		const longTask = "Analyze ".repeat(2000); // ~16KB
		const agents = makeAgentConfigs(["echo"]);

		const result = await runSync(tempDir, agents, "echo", longTask, {});

		assert.equal(result.exitCode, 0);
		const output = getFinalOutput(result.messages);
		assert.equal(output, "Got it");
	});

	it("uses agent model config", async () => {
		mockPi.onCall({ output: "Done" });
		const agents = [makeAgent("echo", { model: "anthropic/claude-sonnet-4" })];

		const result = await runSync(tempDir, agents, "echo", "Task", {});

		assert.equal(result.exitCode, 0);
		// result.model is set from agent config via applyThinkingSuffix, then
		// overwritten by the first message_end event only if result.model is unset.
		// Since agent has model config, it stays as the configured value.
		assert.equal(result.model, "anthropic/claude-sonnet-4");
	});

	it("model override from options takes precedence", async () => {
		mockPi.onCall({ output: "Done" });
		const agents = [makeAgent("echo", { model: "anthropic/claude-sonnet-4" })];

		const result = await runSync(tempDir, agents, "echo", "Task", {
			modelOverride: "openai/gpt-4o",
		});

		assert.equal(result.exitCode, 0);
		assert.equal(result.model, "openai/gpt-4o");
	});

	it("prefers the parent session provider for ambiguous bare model ids", async () => {
		mockPi.onCall({ output: "Done" });
		const agents = [makeAgent("echo", { model: "gpt-5-mini" })];

		const result = await runSync(tempDir, agents, "echo", "Task", {
			availableModels: [
				{ provider: "openai", id: "gpt-5-mini", fullId: "openai/gpt-5-mini" },
				{ provider: "github-copilot", id: "gpt-5-mini", fullId: "github-copilot/gpt-5-mini" },
			],
			preferredModelProvider: "github-copilot",
		});

		assert.equal(result.exitCode, 0);
		assert.equal(result.model, "github-copilot/gpt-5-mini");
		assert.deepEqual(result.attemptedModels, ["github-copilot/gpt-5-mini"]);
	});

	it("parses split UTF-8 JSON and a final unterminated protocol line", async () => {
		const line = Buffer.from(JSON.stringify(events.assistantMessage("你好 from fragmented JSON")));
		const unicodeStart = line.indexOf(Buffer.from("你"));
		mockPi.onCall({ stdoutBase64Chunks: [
			line.subarray(0, unicodeStart + 1).toString("base64"),
			line.subarray(unicodeStart + 1).toString("base64"),
		] });
		const result = await runSync(tempDir, makeAgentConfigs(["echo"]), "echo", "Read fragmented output", { acceptance: false });
		assert.equal(result.exitCode, 0);
		assert.equal(getFinalOutput(result.messages), "你好 from fragmented JSON");
	});

	it("projects an oversized turn_end aggregate without losing the foreground result", async () => {
		mockPi.onCall({ jsonl: [
			events.assistantMessage("result before oversized aggregate"),
			{ type: "turn_end", message: {}, toolResults: [{ content: "x".repeat(MAX_CHILD_PENDING_LINE_BYTES) }] },
			{ type: "agent_end", willRetry: false },
			{ type: "agent_settled" },
		] });
		const result = await runSync(tempDir, makeAgentConfigs(["echo"]), "echo", "Read parallel images", { acceptance: false });
		assert.equal(result.exitCode, 0);
		assert.equal(result.protocolError, undefined);
		assert.equal(getFinalOutput(result.messages), "result before oversized aggregate");
	});

	it("fails with protocol_output_limit when a child emits an oversized stdout line", async () => {
		mockPi.onCall({ stdoutRaw: "x".repeat(MAX_CHILD_PENDING_LINE_BYTES + 1) });
		const result = await runSync(tempDir, makeAgentConfigs(["echo"]), "echo", "Emit malformed output", { acceptance: false });
		assert.equal(result.exitCode, 1);
		assert.equal(result.protocolError?.code, "protocol_output_limit");
		assert.equal(result.protocolError?.stream, "stdout");
		assert.match(result.error ?? "", /protocol_output_limit/);
	});

	it("keeps only a bounded UTF-8 stderr tail", async () => {
		mockPi.onCall({ output: "failed", stderr: `${"x".repeat(MAX_CHILD_STDERR_BYTES + 1024)}终`, exitCode: 1 });
		const result = await runSync(tempDir, makeAgentConfigs(["echo"]), "echo", "Fail noisily", { acceptance: false });
		assert.equal(result.exitCode, 1);
		assert.ok(Buffer.byteLength(result.error ?? "") <= MAX_CHILD_STDERR_BYTES);
		assert.match(result.error ?? "", /终$/);
	});

	it("cancels final drain while agent_end reports a retry and waits for agent_settled", async () => {
		mockPi.onCall({ steps: [
			{ jsonl: [events.assistantMessage("retrying response"), { type: "agent_end", willRetry: true }] },
			{ delay: 1400, jsonl: [events.assistantMessage("settled response"), { type: "agent_end", willRetry: false }, { type: "agent_settled" }] },
		] });
		const startedAt = Date.now();
		const result = await runSync(tempDir, makeAgentConfigs(["echo"]), "echo", "Retry once", { acceptance: false });
		assert.equal(result.exitCode, 0);
		assert.equal(getFinalOutput(result.messages), "settled response");
		assert.ok(Date.now() - startedAt >= 1200, "foreground runner must not terminate during the retry delay");
	});

	it("treats agent_settled as a clean terminal watermark", async () => {
		const nonTerminalMessage = events.assistantMessage("settled without a terminal assistant stop") as { message: { stopReason: string } };
		nonTerminalMessage.message.stopReason = "length";
		mockPi.onCall({ jsonl: [nonTerminalMessage, { type: "agent_settled" }], keepAliveAfterFinalMessageMs: 5000 });
		const startedAt = Date.now();
		const result = await runSync(tempDir, makeAgentConfigs(["echo"]), "echo", "Wait until settled", { acceptance: false });
		assert.equal(result.exitCode, 0);
		assert.equal(result.error, undefined);
		assert.equal(getFinalOutput(result.messages), "settled without a terminal assistant stop");
		assert.ok(Date.now() - startedAt < 4000, "agent_settled should trigger bounded child cleanup");
	});

	it("tracks usage from message events", async () => {
		mockPi.onCall({ output: "Done" });
		const agents = makeAgentConfigs(["echo"]);

		const result = await runSync(tempDir, agents, "echo", "Task", {});

		assert.equal(result.usage.turns, 1);
		assert.equal(result.usage.input, 100); // from mock
		assert.equal(result.usage.output, 50); // from mock
	});

	it("advances to a fallback model after a recovered startup race and provider failure", async () => {
		mockPi.onCall({ exitCode: 1 });
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
		const agents = [makeAgent("echo", {
			model: "openai/gpt-5-mini",
			fallbackModels: ["anthropic/claude-sonnet-4"],
		})];

		const result = await runSync(tempDir, agents, "echo", "Task", {
			runId: "startup-then-fallback-sync",
			acceptance: false,
		});

		assert.equal(result.exitCode, 0);
		assert.equal(result.model, "anthropic/claude-sonnet-4");
		assert.deepEqual(result.attemptedModels, [
			"openai/gpt-5-mini",
			"anthropic/claude-sonnet-4",
		]);
		assert.deepEqual(result.modelAttempts?.map((attempt) => attempt.success), [false, false, true]);
		assert.equal(mockPi.callCount(), 3);
	});

	it("retries with fallback models on retryable provider failures", async () => {
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
		const agents = [makeAgent("echo", {
			model: "openai/gpt-5-mini",
			fallbackModels: ["anthropic/claude-sonnet-4"],
		})];

		const result = await runSync(tempDir, agents, "echo", "Task", {
			runId: "fallback-sync",
		});

		assert.equal(result.exitCode, 0);
		assert.equal(result.model, "anthropic/claude-sonnet-4");
		assert.deepEqual(result.attemptedModels, ["openai/gpt-5-mini", "anthropic/claude-sonnet-4"]);
		assert.equal(result.modelAttempts?.length, 2);
		assert.equal(result.modelAttempts?.[0]?.success, false);
		assert.equal(result.modelAttempts?.[1]?.success, true);
		assert.equal(result.usage.turns, 2);
		assert.equal(mockPi.callCount(), 2);
	});

	it("retries with fallback models when provider errors exit zero", async () => {
		mockPi.onCall({
			jsonl: [{
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "weekly quota hit" }],
					model: "openai/gpt-5-mini",
					errorMessage: "429 you have reached your weekly usage limit / quota exceeded",
					usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
				},
			}],
			exitCode: 0,
		});
		mockPi.onCall({ output: "Recovered on fallback" });
		const agents = [makeAgent("echo", {
			model: "openai/gpt-5-mini",
			fallbackModels: ["anthropic/claude-sonnet-4"],
		})];

		const result = await runSync(tempDir, agents, "echo", "Task", {
			runId: "fallback-zero-exit-provider-error",
		});

		assert.equal(result.exitCode, 0);
		assert.equal(result.model, "anthropic/claude-sonnet-4");
		assert.deepEqual(result.modelAttempts?.map((attempt) => attempt.success), [false, true]);
	});

	it("retries with fallback models when a zero-exit attempt has empty output", async () => {
		mockPi.onCall({
			jsonl: [{
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "" }],
					model: "openai/gpt-5-mini",
					stopReason: "error",
					usage: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
				},
			}],
			exitCode: 0,
		});
		mockPi.onCall({ output: "Recovered from empty output" });
		const agents = [makeAgent("echo", {
			model: "openai/gpt-5-mini",
			fallbackModels: ["anthropic/claude-sonnet-4"],
		})];

		const result = await runSync(tempDir, agents, "echo", "Task", {
			runId: "fallback-zero-exit-empty-output",
		});

		assert.equal(result.exitCode, 0);
		assert.equal(result.model, "anthropic/claude-sonnet-4");
		assert.equal(result.finalOutput, "Recovered from empty output");
		assert.match(result.modelAttempts?.[0]?.error ?? "", /no output/i);
		assert.deepEqual(result.modelAttempts?.map((attempt) => attempt.success), [false, true]);
		assert.equal(mockPi.callCount(), 2);
	});

	it("prefers empty-output fallback over an earlier tool error", async () => {
		mockPi.onCall({
			jsonl: [
				events.toolResult("read", "ENOENT: no such file or directory", true),
				events.toolResult("read", "recovered file contents"),
				{
					type: "message_end",
					message: {
						role: "assistant",
						content: [],
						model: "openai/gpt-5-mini",
						stopReason: "stop",
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
					},
				},
			],
			exitCode: 0,
		});
		mockPi.onCall({ output: "Recovered on fallback" });
		const agents = [makeAgent("echo", {
			model: "openai/gpt-5-mini",
			fallbackModels: ["anthropic/claude-sonnet-4"],
		})];

		const result = await runSync(tempDir, agents, "echo", "Task", {
			runId: "fallback-empty-output-after-tool-error",
		});

		assert.equal(result.exitCode, 0);
		assert.equal(result.model, "anthropic/claude-sonnet-4");
		assert.match(result.modelAttempts?.[0]?.error ?? "", /no output/i);
		assert.equal(mockPi.callCount(), 2);
	});

	it("fails zero-exit provider errors when no fallback succeeds", async () => {
		mockPi.onCall({
			jsonl: [{
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "weekly quota hit" }],
					model: "openai/gpt-5-mini",
					errorMessage: "429 quota exceeded",
					usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
				},
			}],
			exitCode: 0,
		});
		const agents = [makeAgent("echo", { model: "openai/gpt-5-mini" })];

		const result = await runSync(tempDir, agents, "echo", "Task", {
			runId: "zero-exit-provider-error-no-fallback",
		});

		assert.equal(result.exitCode, 1);
		assert.match(result.error ?? "", /429 quota exceeded/);
		assert.deepEqual(result.modelAttempts?.map((attempt) => attempt.success), [false]);
	});

	it("treats recovered child tool errors as successful foreground runs", async () => {
		mockPi.onCall({
			jsonl: [
				events.toolResult("read", "EISDIR: illegal operation on a directory", true),
				events.assistantMessage("Done"),
			],
		});
		const agents = makeAgentConfigs(["echo"]);

		const result = await runSync(tempDir, agents, "echo", "Inspect files", {
			runId: "recovered-tool-error",
		});

		assert.equal(result.exitCode, 0);
		assert.equal(result.error, undefined);
		assert.equal(result.finalOutput, "Done");
		assert.equal(getFinalOutput(result.messages), "Done");
		assert.equal(result.progress.status, "completed");
	});

	it("treats recovered assistant provider errors as successful foreground runs", async () => {
		mockPi.onCall({
			jsonl: [
				{
					type: "message_end",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "temporary provider failure" }],
						model: "openai/gpt-5-mini",
						stopReason: "error",
						errorMessage: "provider transport failed",
						usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
					},
				},
				events.assistantMessage("Recovered"),
			],
		});
		const agents = makeAgentConfigs(["echo"]);

		const result = await runSync(tempDir, agents, "echo", "Recover from provider error", {
			runId: "recovered-provider-error",
		});

		assert.equal(result.exitCode, 0);
		assert.equal(result.error, undefined);
		assert.equal(result.finalOutput, "Recovered");
		assert.equal(getFinalOutput(result.messages), "Recovered");
		assert.equal(result.progress.status, "completed");
	});

	it("keeps provider errors failed when followed only by empty assistant output", async () => {
		mockPi.onCall({
			jsonl: [
				{
					type: "message_end",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "temporary provider failure" }],
						model: "openai/gpt-5-mini",
						stopReason: "error",
						errorMessage: "provider transport failed",
						usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
					},
				},
				events.assistantMessage(""),
			],
		});
		const agents = makeAgentConfigs(["echo"]);

		const result = await runSync(tempDir, agents, "echo", "Recover from provider error", {
			runId: "provider-error-empty-stop",
		});

		assert.equal(result.exitCode, 1);
		assert.match(result.error ?? "", /provider transport failed/);
		assert.equal(result.finalOutput, "");
		assert.equal(result.progress.status, "failed");
	});

	it("fails when all fallback model attempts report provider errors", async () => {
		for (const model of ["openai/gpt-5-mini", "anthropic/claude-sonnet-4"]) {
			mockPi.onCall({
				jsonl: [{
					type: "message_end",
					message: {
						role: "assistant",
						content: [{ type: "text", text: `${model} quota hit` }],
						model,
						errorMessage: "429 quota exceeded",
						usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
					},
				}],
				exitCode: 0,
			});
		}
		const agents = [makeAgent("echo", {
			model: "openai/gpt-5-mini",
			fallbackModels: ["anthropic/claude-sonnet-4"],
		})];

		const result = await runSync(tempDir, agents, "echo", "Task", {
			runId: "zero-exit-provider-error-all-fallbacks-fail",
		});

		assert.equal(result.exitCode, 1);
		assert.deepEqual(result.modelAttempts?.map((attempt) => attempt.success), [false, false]);
		assert.match(result.error ?? "", /429 quota exceeded/);
	});

	it("baselines output files per fallback attempt", async () => {
		const outputPath = path.join(tempDir, "fallback-output.md");
		mockPi.onCall({
			jsonl: [{
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "primary failed" }],
					model: "openai/gpt-5-mini",
					errorMessage: "429 quota exceeded",
					usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
				},
			}],
			exitCode: 0,
			delay: 100,
		});
		mockPi.onCall({ output: "fallback assistant output" });
		const agents = [makeAgent("echo", {
			model: "openai/gpt-5-mini",
			fallbackModels: ["anthropic/claude-sonnet-4"],
		})];

		const runPromise = runSync(tempDir, agents, "echo", "Task", {
			runId: "fallback-output-per-attempt",
			outputPath,
		});
		setTimeout(() => {
			fs.writeFileSync(outputPath, "stale partial output from failed primary", "utf-8");
		}, 20);

		const result = await runPromise;

		assert.equal(result.exitCode, 0);
		assert.equal(fs.readFileSync(outputPath, "utf-8"), "fallback assistant output");
	});

	it("does not retry on ordinary task/tool failures", async () => {
		mockPi.onCall({
			jsonl: [events.toolResult("bash", "process exited with code 127", true)],
			exitCode: 0,
		});
		const agents = [makeAgent("echo", {
			model: "openai/gpt-5-mini",
			fallbackModels: ["anthropic/claude-sonnet-4"],
		})];

		const result = await runSync(tempDir, agents, "echo", "Task", {
			runId: "no-fallback-task-failure",
		});

		assert.equal(result.exitCode, 127);
		assert.equal(result.modelAttempts?.length, 1);
		assert.equal(mockPi.callCount(), 1);
	});

	it("tracks progress during execution", async () => {
		mockPi.onCall({ output: "Done" });
		const agents = makeAgentConfigs(["echo"]);

		const result = await runSync(tempDir, agents, "echo", "Task", { index: 3 });

		assert.ok(result.progress, "should have progress");
		assert.equal(result.progress.agent, "echo");
		assert.equal(result.progress.index, 3);
		assert.equal(result.progress.status, "completed");
		assert.ok(result.progress.durationMs > 0, "should track duration");
	});

	it("streams progress while a foreground child has not emitted output", async () => {
		const updates: Array<{ text: string; durationMs: number | undefined }> = [];
		const releasePath = path.join(tempDir, "release-foreground-progress");
		mockPi.onCall({ output: "Done", waitForPath: releasePath });

		const runPromise = runSync(tempDir, makeAgentConfigs(["echo"]), "echo", "Task", {
			onUpdate: (update: { content: Array<{ type: string; text?: string }>; details?: { progress?: ProgressSummary[] } }) => {
				updates.push({
					text: update.content[0]?.text ?? "",
					durationMs: update.details?.progress?.[0]?.durationMs,
				});
			},
		});
		const deadline = Date.now() + 5_000;
		while (updates.filter((update) => update.text === "(running...)").length < 2 && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		fs.writeFileSync(releasePath, "release", "utf-8");
		const result = await runPromise;

		const runningUpdates = updates.filter((update) => update.text === "(running...)");
		assert.equal(result.exitCode, 0);
		assert.ok(runningUpdates.length >= 2, "expected an initial update and a heartbeat before child output");
		assert.ok((runningUpdates.at(-1)?.durationMs ?? 0) > (runningUpdates[0]?.durationMs ?? 0), "expected heartbeat duration to advance");
	});

	it("tracks live activity updates and exposes artifact paths while running", async () => {
		const updates: Array<{ details?: { results?: Array<{ artifactPaths?: ArtifactPaths }>; progress?: ProgressSummary[] } }> = [];
		mockPi.onCall({
			steps: [
				{ jsonl: [events.toolStart("read", { path: "package.json" })], delay: 20 },
				{ jsonl: [events.toolEnd("read"), events.toolResult("read", "{\"name\":\"pkg\"}")], delay: 20 },
				{ jsonl: [events.assistantMessage("Done")] },
			],
		});
		const agents = makeAgentConfigs(["echo"]);
		const artifactsDir = path.join(tempDir, "artifacts");

		const result = await runSync(tempDir, agents, "echo", "Task", {
			runId: "live-progress",
			artifactsDir,
			artifactConfig: { enabled: true, includeInput: true, includeOutput: true, includeMetadata: true },
			onUpdate: (update: { details?: { results?: Array<{ artifactPaths?: ArtifactPaths }>; progress?: ProgressSummary[] } }) => {
				updates.push(update);
			},
		});

		assert.ok(updates.length > 0, "expected at least one live progress update");
		assert.equal(
			updates.some((update) => update.details?.results?.[0]?.artifactPaths?.outputPath.endsWith("_output.md") === true),
			true,
		);
		const runningToolUpdate = updates.find((update) => update.details?.progress?.[0]?.currentTool === "read");
		assert.ok(runningToolUpdate, "expected a live progress update for the running tool");
		assert.equal(runningToolUpdate?.details?.progress?.[0]?.currentTool, "read");
		assert.equal(typeof runningToolUpdate?.details?.progress?.[0]?.currentToolStartedAt, "number");
		assert.equal(typeof result.progress.lastActivityAt, "number");
		assert.equal(result.progress.currentToolStartedAt, undefined);
	});

	it("does not flag a delayed active tool as idle attention", async () => {
		const updates: Array<{ details?: { progress?: ProgressSummary[] } }> = [];
		const controlEvents: NonNullable<RunSyncResult["controlEvents"]> = [];
		mockPi.onCall({
			steps: [
				{ jsonl: [events.toolStart("bash", { command: "sleep 2" })] },
				{ delay: 2_000, jsonl: [events.toolEnd("bash"), events.toolResult("bash", "done")] },
				{ jsonl: [events.assistantMessage("Done")] },
			],
		});

		const result = await runSync(tempDir, makeAgentConfigs(["echo"]), "echo", "Task", {
			runId: "delayed-tool-attention",
			controlConfig: { enabled: true, needsAttentionAfterMs: 200, activeNoticeAfterMs: 999_999, notifyOn: ["needs_attention"] },
			onUpdate: (update: { details?: { progress?: ProgressSummary[] } }) => updates.push(update),
			onControlEvent: (event: NonNullable<RunSyncResult["controlEvents"]>[number]) => controlEvents.push(event),
		});

		assert.equal(result.exitCode, 0);
		assert.equal(result.progress.activityState, undefined);
		assert.equal(controlEvents.some((event) => event.type === "needs_attention"), false);
		assert.equal(updates.some((update) => update.details?.progress?.some((progress) => progress.currentTool === "bash")), true);
	});

	it("sets progress.status to failed on non-zero exit", async () => {
		mockPi.onCall({ exitCode: 1 });
		const agents = makeAgentConfigs(["fail"]);

		const result = await runSync(tempDir, agents, "fail", "Task", {});

		assert.equal(result.progress.status, "failed");
	});

	it("handles multi-turn conversation from JSONL", async () => {
		mockPi.onCall({
			jsonl: [
				events.toolStart("bash", { command: "ls" }),
				events.toolEnd("bash"),
				events.toolResult("bash", "file1.txt\nfile2.txt"),
				events.assistantMessage("Found 2 files: file1.txt and file2.txt"),
			],
		});
		const agents = makeAgentConfigs(["scout"]);

		const result = await runSync(tempDir, agents, "scout", "List files", {});

		assert.equal(result.exitCode, 0);
		const output = getFinalOutput(result.messages);
		assert.ok(output.includes("file1.txt"), "should capture assistant text");
		assert.equal(result.progress.toolCount, 1, "should count tool calls");
	});

	it("resolves skills from the effective task cwd", async () => {
		const taskCwd = createTempDir("pi-subagent-task-cwd-");
		try {
			writePackageSkill(taskCwd, "task-cwd-skill");
			mockPi.onCall({ output: "Done" });
			const agents = [makeAgent("echo", { skills: ["task-cwd-skill"] })];

			const result = await runSync(tempDir, agents, "echo", "Task", { cwd: taskCwd });

			assert.equal(result.exitCode, 0);
			assert.deepEqual(result.skills, ["task-cwd-skill"]);
			assert.equal(result.skillsWarning, undefined);
		} finally {
			removeTempDir(taskCwd);
		}
	});

	it("injects an agent-file-relative local skill into the foreground child prompt", async () => {
		mockPi.onCall({ output: "Done" });
		const agentFile = path.join(tempDir, "agents", "nested", "worker.md");
		const skillFile = path.join(path.dirname(agentFile), "skills", "local", "SKILL.md");
		fs.mkdirSync(path.dirname(skillFile), { recursive: true });
		fs.writeFileSync(skillFile, "---\ndescription: local skill description\n---\nLocal skill body\n", "utf-8");
		const agents = [makeAgent("worker", { filePath: agentFile, skills: ["local"], skillPath: ["./skills"] })];

		const result = await runSync(tempDir, agents, "worker", "Task", {});

		assert.equal(result.exitCode, 0);
		assert.deepEqual(result.skills, ["local"]);
		const prompt = readCall().systemPrompts.map((record) => record.text ?? "").join("\n");
		assert.match(prompt, /local skill description/);
		assert.match(prompt, new RegExp(escapeRegExp(skillFile)));
	});

	it("falls back to the runtime cwd when the task cwd lacks a skill", async () => {
		const taskCwd = path.join(tempDir, "nested");
		fs.mkdirSync(taskCwd, { recursive: true });
		writePackageSkill(tempDir, "runtime-fallback-skill");
		mockPi.onCall({ output: "Done" });
		const agents = [makeAgent("echo", { skills: ["runtime-fallback-skill"] })];

		const result = await runSync(tempDir, agents, "echo", "Task", { cwd: taskCwd });

		assert.equal(result.exitCode, 0);
		assert.deepEqual(result.skills, ["runtime-fallback-skill"]);
		assert.equal(result.skillsWarning, undefined);
	});

	it("fails foreground runs on explicit unavailable pi-subagents skill requests without spawning", async () => {
		const agents = [makeAgent("worker")];

		const result = await runSync(tempDir, agents, "worker", "Task", { skills: ["pi-subagents"] });

		assert.equal(result.exitCode, 1);
		assert.equal(result.error, "Skills not found: pi-subagents");
		assert.equal(mockPi.callCount(), 0);
	});

	it("fails foreground runs when an agent default requests pi-subagents skill", async () => {
		const agents = [makeAgent("worker", { skills: ["pi-subagents"] })];

		const result = await runSync(tempDir, agents, "worker", "Task", {});

		assert.equal(result.exitCode, 1);
		assert.equal(result.error, "Skills not found: pi-subagents");
		assert.equal(mockPi.callCount(), 0);
	});

	it("writes artifacts when configured", async () => {
		mockPi.onCall({
			output: "Result text",
			runtimeAcknowledgedExtensions: { version: 1, source: "child-runtime", ids: ["ext.ok"], omitted: 0 },
		});
		const privateExtension = path.join(tempDir, "extensions", "private-extension.ts");
		const agents = [makeAgent("echo", { extensions: [privateExtension] })];
		const artifactsDir = path.join(tempDir, "artifacts");

		const result = await runSync(tempDir, agents, "echo", "Task", {
			runId: "test-run",
			artifactsDir,
			artifactConfig: { enabled: true, includeInput: true, includeOutput: true, includeMetadata: true },
		});

		assert.equal(result.exitCode, 0);
		assert.ok(result.artifactPaths, "should have artifact paths");
		assert.ok(result.transcriptPath, "should expose transcript path on the result");
		assert.equal(result.transcriptPath, result.artifactPaths.transcriptPath);
		assert.ok(fs.existsSync(result.transcriptPath), "transcript should be written");
		const transcript = fs.readFileSync(result.transcriptPath, "utf-8").trim().split("\n").map((line) => JSON.parse(line) as { recordType?: string; source?: string; text?: string });
		assert.equal(transcript[0]?.recordType, "message");
		assert.equal(transcript[0]?.source, "foreground");
		assert.match(transcript.at(-1)?.text ?? "", /^Result text/);
		assert.equal(result.transcriptError, undefined);
		assert.ok(fs.existsSync(artifactsDir), "artifacts dir should exist");
		const metadata = JSON.parse(fs.readFileSync(result.artifactPaths.metadataPath, "utf-8")) as { launchContractDigest?: string; launchResolvedExtensions?: LaunchResolvedExtensions; runtimeAcknowledgedExtensions?: RuntimeAcknowledgedExtensions };
		assert.equal(metadata.launchContractDigest, result.launchContractDigest);
		assert.equal(result.launchResolvedExtensions?.source, "launch-resolved");
		assert.equal(result.launchResolvedExtensions?.disableAmbientExtensions, true);
		assert.deepEqual(metadata.launchResolvedExtensions, result.launchResolvedExtensions);
		assert.deepEqual(result.runtimeAcknowledgedExtensions, { version: 1, source: "child-runtime", ids: ["ext.ok"], omitted: 0 });
		assert.deepEqual(metadata.runtimeAcknowledgedExtensions, result.runtimeAcknowledgedExtensions);
		assert.ok(!JSON.stringify(result.launchResolvedExtensions).includes(tempDir), "projection should not expose raw extension paths");
	});

	it("routes foreground artifacts to the configured session directory", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "session artifact result" });
		const sessionFile = path.join(tempDir, "sessions", "parent-session", "session.jsonl");
		const ctx = makeMinimalCtx(tempDir);
		ctx.sessionManager.getSessionFile = () => sessionFile;
		const executor = makeExecutor([makeAgent("echo")], { artifactDir: "session" });

		const result = await executor.execute(
			"session-artifact-dir",
			{ agent: "echo", task: "Write session-scoped artifacts", runId: "session-artifacts" },
			new AbortController().signal,
			undefined,
			ctx,
		);

		const expectedDir = path.join(path.dirname(sessionFile), "subagent-artifacts");
		assert.equal(result.isError, undefined);
		assert.equal(result.details?.artifacts?.dir, expectedDir);
		assert.ok(result.details?.artifacts?.files[0]?.outputPath.startsWith(`${expectedDir}${path.sep}`));
		assert.equal(fs.readFileSync(result.details.artifacts.files[0].outputPath, "utf-8"), "session artifact result");
		assert.equal(fs.existsSync(path.join(tempDir, ".pi-subagents", "artifacts")), false);
	});

	for (const artifactDir of ["session", "temp"] as const) {
		it(`keeps foreground chain scratch files out of the project for artifactDir=${artifactDir}`, { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
			mockPi.onCall({ output: `${artifactDir} chain result` });
			const sessionFile = path.join(tempDir, "sessions", "parent-session", "session.jsonl");
			const ctx = makeMinimalCtx(tempDir);
			ctx.sessionManager.getSessionFile = () => sessionFile;
			const executor = makeExecutor([makeAgent("echo")], { artifactDir });

			const result = await executor.execute(
				`${artifactDir}-chain-artifact-dir`,
				{ chain: [{ agent: "echo", task: "Run without project-local scratch files in {chain_dir}" }] },
				new AbortController().signal,
				undefined,
				ctx,
			);

			const taskArg = readCallArgs().at(-1) ?? "";
			assert.equal(result.isError, undefined);
			assert.ok(taskArg.includes(`${CHAIN_RUNS_DIR}${path.sep}`), taskArg);
			assert.equal(fs.existsSync(path.join(tempDir, ".pi-subagents", "chain-runs")), false);
			assert.equal(fs.existsSync(path.join(tempDir, ".pi-subagents", "artifacts")), false);
		});
	}

	it("writes a failure stub to foreground output artifacts when no output was produced", async () => {
		mockPi.onCall({ output: "", stderr: "model unavailable", exitCode: 1 });
		const artifactsDir = path.join(tempDir, "artifacts-failed-output");

		const result = await runSync(tempDir, makeAgentConfigs(["echo"]), "echo", "Task", {
			runId: "failed-no-output",
			artifactsDir,
			artifactConfig: { enabled: true, includeInput: true, includeOutput: true, includeMetadata: true },
			acceptance: false,
		});

		assert.equal(result.exitCode, 1);
		assert.ok(result.artifactPaths?.outputPath, "should expose an output artifact path");
		const artifact = fs.readFileSync(result.artifactPaths.outputPath, "utf-8");
		assert.match(artifact, /Subagent run failed before producing output\./);
		assert.match(artifact, /Error:\nmodel unavailable/);
		assert.match(artifact, /Transcript:/);
		assert.match(artifact, /Metadata:/);
	});

	it("does not surface transcript paths when transcript artifacts are disabled", async () => {
		mockPi.onCall({ output: "Result text" });
		const agents = makeAgentConfigs(["echo"]);
		const artifactsDir = path.join(tempDir, "artifacts-disabled-transcript");

		const result = await runSync(tempDir, agents, "echo", "Task", {
			runId: "test-run-no-transcript",
			artifactsDir,
			artifactConfig: { enabled: true, includeInput: true, includeOutput: true, includeTranscript: false, includeMetadata: true },
		});

		assert.equal(result.exitCode, 0);
		assert.equal(result.transcriptPath, undefined);
		assert.equal(result.transcriptError, undefined);
		assert.ok(result.artifactPaths?.metadataPath, "should have metadata path");
		const metadata = JSON.parse(fs.readFileSync(result.artifactPaths.metadataPath, "utf-8")) as { transcriptPath?: string; transcriptError?: string };
		assert.equal(metadata.transcriptPath, undefined);
		assert.equal(metadata.transcriptError, undefined);
		assert.equal(fs.existsSync(result.artifactPaths.transcriptPath!), false);
	});

	it("preserves agent-written output files instead of overwriting them with the final receipt", async () => {
		const outputPath = path.join(tempDir, "report.md");
		const artifactsDir = path.join(tempDir, "artifacts");
		mockPi.onCall({ output: `Wrote to ${outputPath}`, delay: 100 });
		const agents = makeAgentConfigs(["echo"]);

		const runPromise = runSync(tempDir, agents, "echo", "Task", {
			runId: "output-file-preserved",
			outputPath,
			artifactsDir,
			artifactConfig: { enabled: true, includeInput: true, includeOutput: true, includeMetadata: true },
		});

		setTimeout(() => {
			fs.writeFileSync(outputPath, "real file content", "utf-8");
		}, 20);

		const result = await runPromise;
		assert.equal(result.exitCode, 0);
		assert.equal(result.finalOutput, "real file content");
		assert.equal(fs.readFileSync(outputPath, "utf-8"), "real file content");
		assert.ok(result.artifactPaths, "should have artifact paths");
		assert.equal(fs.readFileSync(result.artifactPaths.outputPath, "utf-8"), "real file content");
	});

	it("falls back to persisting assistant output when the target file was not changed", async () => {
		const outputPath = path.join(tempDir, "report.md");
		fs.writeFileSync(outputPath, "stale content", "utf-8");
		mockPi.onCall({ output: "fresh assistant output" });
		const agents = makeAgentConfigs(["echo"]);

		const result = await runSync(tempDir, agents, "echo", "Task", {
			runId: "output-file-fallback",
			outputPath,
		});

		assert.equal(result.exitCode, 0);
		assert.equal(result.finalOutput, "fresh assistant output");
		assert.equal(fs.readFileSync(outputPath, "utf-8"), "fresh assistant output");
	});

	it("routes foreground single relative outputs to the run output artifact directory by default", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "default report" });
		const executor = makeExecutor([makeAgent("researcher", { output: "context.md" })]);

		const result = await executor.execute(
			"single-default-output-base",
			{ agent: "researcher", task: "Write report" },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		const taskArg = readCallArgs().at(-1) ?? "";
		assert.equal(result.isError, undefined);
		assert.match(taskArg, new RegExp(`Write your findings to exactly this path: ${escapeRegExp(path.join(tempDir, ".pi-subagents", "artifacts", "outputs"))}.*context\\.md`));
		assert.equal(fs.existsSync(path.join(tempDir, "context.md")), false);
	});

	it("routes foreground single relative outputs to configured singleRunOutputBaseDir", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "configured report" });
		const configuredBase = path.join(tempDir, "configured-outputs");
		const executor = makeExecutor(
			[makeAgent("researcher", { output: "context.md" })],
			{ singleRunOutputBaseDir: configuredBase },
		);

		const result = await executor.execute(
			"single-configured-output-base",
			{ agent: "researcher", task: "Write report" },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		const expectedOutputPath = path.join(configuredBase, "context.md");
		const taskArg = readCallArgs().at(-1) ?? "";
		assert.equal(result.isError, undefined);
		assert.match(taskArg, new RegExp(`Write your findings to exactly this path: ${escapeRegExp(expectedOutputPath)}`));
		assert.equal(fs.readFileSync(expectedOutputPath, "utf-8"), "configured report");
		assert.equal(fs.existsSync(path.join(tempDir, "context.md")), false);
	});

	it("makes task-level output overrides authoritative in the child system prompt", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "override report" });
		const overridePath = path.join(tempDir, "custom-report.md");
		const executor = makeExecutor([
			makeAgent("researcher", {
				output: "default-report.md",
				systemPrompt: "Output format (`default-report.md`):\n\nWrite the full report to default-report.md.",
			}),
		]);

		const result = await executor.execute(
			"single-output-override-system-prompt",
			{ agent: "researcher", task: "Write report", output: overridePath },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		const call = readCall();
		const taskArg = call.args.at(-1) ?? "";
		const systemPrompt = call.systemPrompts[0]?.text ?? "";
		assert.equal(result.isError, undefined);
		assert.match(taskArg, new RegExp(`Write your findings to exactly this path: ${escapeRegExp(overridePath)}`));
		assert.match(systemPrompt, /Output format \(`default-report\.md`\):/);
		assert.match(systemPrompt, /Runtime output path override:/);
		assert.match(systemPrompt, new RegExp(`Write your findings to exactly this path: ${escapeRegExp(overridePath)}`));
		assert.match(systemPrompt, /Ignore any other output filename or output path mentioned elsewhere/);
	});

	it("persists read-only file-only output without requiring a child write tool", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "complete read-only analysis" });
		const outputPath = path.join(tempDir, "read-only-analysis.md");
		const executor = makeExecutor([makeAgent("analyst", {
			tools: ["read", "grep", "find", "ls"],
			systemPrompt: "Analyze without modifying files.",
		})]);

		const result = await executor.execute(
			"single-read-only-output",
			{ agent: "analyst", task: "Analyze the runtime", output: outputPath, outputMode: "file-only", acceptance: false },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		const call = readCall();
		const taskArg = call.args.at(-1) ?? "";
		const systemPrompt = call.systemPrompts[0]?.text ?? "";
		assert.equal(result.isError, undefined);
		assert.equal(fs.readFileSync(outputPath, "utf-8"), "complete read-only analysis");
		assert.match(result.content[0]?.text ?? "", /Output saved to:/);
		for (const instruction of [taskArg, systemPrompt]) {
			assert.match(instruction, /Return the complete artifact in your final response\./);
			assert.match(instruction, /runtime will persist it to exactly this path:/);
			assert.match(instruction, /Do not call contact_supervisor merely because no write-capable tool is available\./);
			assert.doesNotMatch(instruction, /Write your findings to exactly this path/);
		}
	});

	it("treats string false as disabled output in foreground single runs", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "inline report" });
		const executor = makeExecutor([makeAgent("echo", { output: "default-report.md" })]);

		const result = await executor.execute(
			"single-string-false-output",
			{ agent: "echo", task: "Write report", output: "false" },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, undefined);
		assert.match(result.content[0]?.text ?? "", /inline report/);
		assert.doesNotMatch(result.content[0]?.text ?? "", /Output saved to:/);
		assert.equal(fs.existsSync(path.join(tempDir, "false")), false);
		assert.equal(fs.existsSync(path.join(tempDir, "default-report.md")), false);
		assert.doesNotMatch(readCallArgs().at(-1) ?? "", /Write your findings to(?: exactly this path)?:/);
	});

	it("rejects explicit reviewed acceptance at every execution nesting level before spawning", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const cases = [
			{ agent: "echo", task: "Review", acceptance: "reviewed" },
			{ agent: "echo", task: "Review", acceptance: { level: "reviewed" } },
			{ tasks: [{ agent: "echo", task: "Review", acceptance: "reviewed" }] },
			{ chain: [{ agent: "echo", task: "Review", acceptance: { level: "reviewed" } }] },
			{ chain: [{ parallel: [{ agent: "echo", task: "Review", acceptance: "reviewed" }] }] },
			{ chain: [{ expand: { from: { output: "targets", path: "/items" } }, parallel: { agent: "echo", acceptance: { level: "reviewed" } }, collect: { as: "reviews" } }] },
		];
		for (const [index, params] of cases.entries()) {
			const executor = makeExecutor();
			const result = await executor.execute(
				`reviewed-acceptance-${index}`,
				params,
				new AbortController().signal,
				undefined,
				makeMinimalCtx(tempDir),
			);

			assert.equal(result.isError, true);
			assert.match(result.content[0]?.text ?? "", /achieved status.*omit acceptance.*acceptance\.review\.required/i);
		}
		assert.equal(mockPi.callCount(), 0);
	});

	it("rejects explicit reviewed acceptance before appending a chain step", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const executor = makeExecutor([makeAgent("echo")]);
		const result = await executor.execute(
			"append-reviewed-acceptance",
			{
				action: "append-step",
				id: "missing-run",
				step: { agent: "echo", task: "Review the previous work", acceptance: { level: "reviewed" } },
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /Cannot append step:.*achieved status.*acceptance\.review\.required/i);
		assert.equal(mockPi.callCount(), 0);
	});

	it("rejects mismatched foreground timeout aliases before spawning", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const executor = makeExecutor();

		const result = await executor.execute(
			"timeout-alias-validation",
			{ agent: "echo", task: "Task", timeoutMs: 100, maxRuntimeMs: 200 },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /aliases/);
		assert.equal(mockPi.callCount(), 0);
	});

	it("applies the foreground timeout default without overriding explicit or agent values", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "package default" });
		mockPi.onCall({ output: "explicit timeout" });
		mockPi.onCall({ output: "max runtime alias" });
		mockPi.onCall({ output: "agent timeout" });

		const defaultExecutor = makeExecutor();
		const defaultResult = await defaultExecutor.execute(
			"foreground-timeout-default",
			{ agent: "echo", task: "Task" },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		assert.equal(defaultResult.details?.timeoutMs, executorMod?.DEFAULT_FOREGROUND_TIMEOUT_MS);
		assert.equal(defaultResult.details?.timeoutMs, 30 * 60 * 1000);

		const explicitResult = await defaultExecutor.execute(
			"foreground-timeout-explicit",
			{ agent: "echo", task: "Task", async: false, timeoutMs: 2_000 },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		assert.equal(explicitResult.details?.timeoutMs, 2_000);

		const aliasResult = await defaultExecutor.execute(
			"foreground-timeout-alias",
			{ agent: "echo", task: "Task", async: false, maxRuntimeMs: 3_000 },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		assert.equal(aliasResult.details?.timeoutMs, 3_000);

		const agentResult = await makeExecutor([
			makeAgent("echo", { defaultTimeoutMs: 4_000 }),
		]).execute(
			"foreground-timeout-agent-default",
			{ agent: "echo", task: "Task", async: false },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		assert.equal(agentResult.details?.timeoutMs, 4_000);
	});

	it("runs omitted async launches in the background when the global default is enabled", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const executor = makeExecutor([makeAgent("echo")], {}, true);

		const result = await executor.execute(
			"global-async-default",
			{ agent: "echo", task: "Task" },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, undefined);
		assert.match(result.content[0]?.text ?? "", /Async:/);
		assert.equal(typeof result.details?.asyncId, "string");
	});

	it("keeps omitted async launches foreground when the global default is disabled", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "config foreground default finished" });
		const executor = makeExecutor([makeAgent("echo")], {}, false);

		const result = await executor.execute(
			"global-foreground-opt-out",
			{ agent: "echo", task: "Task" },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, undefined);
		assert.match(result.content[0]?.text ?? "", /config foreground default finished/);
		assert.equal(result.details?.asyncId, undefined);
	});

	it("applies agent frontmatter defaults to single-agent launches", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const executor = makeExecutor([
			makeAgent("echo", {
				defaultAsync: true,
				defaultTimeoutMs: 2_000,
				defaultTurnBudget: { maxTurns: 4, graceTurns: 2 },
			}),
		]);

		const result = await executor.execute(
			"agent-launch-defaults",
			{ agent: "echo", task: "Task" },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, undefined);
		assert.match(result.content[0]?.text ?? "", /Async:/);
		assert.equal(typeof result.details?.asyncId, "string");
		assert.equal(result.details?.timeoutMs, 2_000);
		assert.deepEqual(result.details?.turnBudget, { maxTurns: 4, graceTurns: 2 });
	});

	it("applies agent acceptance defaults and lets explicit calls override them", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "default acceptance disabled" });
		mockPi.onCall({ stdoutRaw: `${JSON.stringify(events.assistantMessage("explicit checked response without a report"))}\n` });
		const executor = makeExecutor([
			makeAgent("echo", { defaultAcceptance: { level: "none", reason: "lightweight response" } }),
		]);

		const defaulted = await executor.execute(
			"agent-acceptance-default",
			{ agent: "echo", task: "Return a concise answer" },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		assert.equal(defaulted.isError, undefined);
		assert.equal(defaulted.details?.results?.[0]?.acceptance?.status, "not-required");
		assert.equal(defaulted.details?.results?.[0]?.acceptance?.effectiveAcceptance.reason, "lightweight response");

		const explicit = await executor.execute(
			"agent-acceptance-explicit",
			{ agent: "echo", task: "Return a concise answer", acceptance: "checked" },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		assert.equal(explicit.isError, true);
		assert.equal(explicit.details?.results?.[0]?.acceptance?.status, "rejected");
	});

	it("lets agent frontmatter override the global async default", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "agent foreground default finished" });
		const executor = makeExecutor(
			[makeAgent("echo", { defaultAsync: false })],
			{},
			true,
		);

		const result = await executor.execute(
			"agent-foreground-default",
			{ agent: "echo", task: "Task" },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, undefined);
		assert.match(result.content[0]?.text ?? "", /agent foreground default finished/);
		assert.equal(result.details?.asyncId, undefined);
	});

	it("lets explicit single-agent launch values override frontmatter defaults", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "explicit foreground finished" });
		const executor = makeExecutor([
			makeAgent("echo", {
				defaultAsync: true,
				defaultTimeoutMs: 1,
				defaultTurnBudget: { maxTurns: 1, graceTurns: 0 },
			}),
		]);

		const result = await executor.execute(
			"explicit-launch-values",
			{
				agent: "echo",
				task: "Task",
				async: false,
				timeoutMs: 2_000,
				turnBudget: { maxTurns: 4, graceTurns: 2 },
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, undefined);
		assert.match(result.content[0]?.text ?? "", /explicit foreground finished/);
		assert.equal(result.details?.asyncId, undefined);
	});

	it("allows timeout settings for async runs before spawning", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const executor = makeExecutor();

		const result = await executor.execute(
			"timeout-async-validation",
			{ agent: "echo", task: "Task", async: true, timeoutMs: 1_000 },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, undefined);
		assert.match(result.content[0]?.text ?? "", /Async:/);
		assert.equal(result.details?.timeoutMs, 1_000);
	});

	it("rejects file-only mode without an output path before spawning", async () => {
		const agents = makeAgentConfigs(["echo"]);

		const result = await runSync(tempDir, agents, "echo", "Task", {
			runId: "output-file-only-missing-path",
			outputMode: "file-only",
		});

		assert.equal(result.exitCode, 1);
		assert.match(result.error ?? "", /outputMode: "file-only"/);
		assert.equal(mockPi.callCount(), 0);
	});

	it("returns only a saved-output reference in file-only mode", async () => {
		const outputPath = path.join(tempDir, "file-only-report.md");
		const artifactsDir = path.join(tempDir, "file-only-artifacts");
		mockPi.onCall({ output: "full saved output\nwith details" });
		const agents = makeAgentConfigs(["echo"]);

		const result = await runSync(tempDir, agents, "echo", "Task", {
			runId: "output-file-only",
			outputPath,
			outputMode: "file-only",
			artifactsDir,
		});

		assert.equal(result.exitCode, 0);
		assert.equal(result.outputMode, "file-only");
		assert.equal(result.savedOutputPath, outputPath);
		assert.equal(result.outputReference?.path, outputPath);
		assert.match(result.finalOutput ?? "", /^Output saved to:/);
		assert.match(result.finalOutput ?? "", /2 lines/);
		assert.doesNotMatch(result.finalOutput ?? "", /full saved output/);
		assert.equal(fs.readFileSync(outputPath, "utf-8"), "full saved output\nwith details");
		assert.ok(result.artifactPaths, "should have artifact paths");
		assert.equal(fs.readFileSync(result.artifactPaths.outputPath, "utf-8"), "full saved output\nwith details");
	});

	it("passes maxSubagentDepth through to child execution env", async () => {
		mockPi.onCall({ echoEnv: ["PI_SUBAGENT_DEPTH", "PI_SUBAGENT_MAX_DEPTH"] });
		const agents = makeAgentConfigs(["echo"]);
		const prevDepth = process.env.PI_SUBAGENT_DEPTH;
		const prevMaxDepth = process.env.PI_SUBAGENT_MAX_DEPTH;
		delete process.env.PI_SUBAGENT_DEPTH;
		delete process.env.PI_SUBAGENT_MAX_DEPTH;

		try {
			const result = await runSync(tempDir, agents, "echo", "Task", {
				runId: "depth-env",
				maxSubagentDepth: 1,
			});

			assert.equal(result.exitCode, 0);
			assert.deepEqual(JSON.parse(result.finalOutput ?? "{}"), {
				PI_SUBAGENT_DEPTH: "1",
				PI_SUBAGENT_MAX_DEPTH: "1",
			});
		} finally {
			if (prevDepth === undefined) delete process.env.PI_SUBAGENT_DEPTH;
			else process.env.PI_SUBAGENT_DEPTH = prevDepth;
			if (prevMaxDepth === undefined) delete process.env.PI_SUBAGENT_MAX_DEPTH;
			else process.env.PI_SUBAGENT_MAX_DEPTH = prevMaxDepth;
		}
	});

	it("passes the effective wait-tool setting through to child execution", async () => {
		mockPi.onCall({ echoEnv: [WAIT_TOOL_ENABLED_ENV] });
		const result = await runSync(tempDir, makeAgentConfigs(["echo"]), "echo", "Task", {
			runId: "wait-tool-env",
			waitToolEnabled: false,
		});
		assert.equal(result.exitCode, 0);
		assert.deepEqual(JSON.parse(result.finalOutput ?? "{}"), {
			[WAIT_TOOL_ENABLED_ENV]: "false",
		});
	});

	it("passes prompt inheritance env flags through to child execution", async () => {
		mockPi.onCall({ echoEnv: ["PI_SUBAGENT_INHERIT_PROJECT_CONTEXT", "PI_SUBAGENT_INHERIT_SKILLS"] });
		const agents = [makeAgent("echo", {
			systemPromptMode: "replace",
			inheritProjectContext: false,
			inheritSkills: false,
		})];

		const result = await runSync(tempDir, agents, "echo", "Task", {
			runId: "prompt-inheritance-env",
		});

		assert.equal(result.exitCode, 0);
		assert.deepEqual(JSON.parse(result.finalOutput ?? "{}"), {
			PI_SUBAGENT_INHERIT_PROJECT_CONTEXT: "0",
			PI_SUBAGENT_INHERIT_SKILLS: "0",
		});
	});

	it("passes fanout routing env only when builtin subagent is declared", async () => {
		const envKeys = [
			SUBAGENT_FANOUT_CHILD_ENV,
			SUBAGENT_PARENT_EVENT_SINK_ENV,
			SUBAGENT_PARENT_CONTROL_INBOX_ENV,
			SUBAGENT_PARENT_RUN_ID_ENV,
			SUBAGENT_PARENT_CHILD_INDEX_ENV,
		];
		const saved = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
		try {
			process.env[SUBAGENT_PARENT_EVENT_SINK_ENV] = "/tmp/inherited/events.jsonl";
			process.env[SUBAGENT_PARENT_CONTROL_INBOX_ENV] = "/tmp/inherited/control";
			process.env[SUBAGENT_PARENT_RUN_ID_ENV] = "inherited-run";
			process.env[SUBAGENT_PARENT_CHILD_INDEX_ENV] = "7";

			mockPi.onCall({ echoEnv: envKeys });
			const fanoutAgents = [makeAgent("delegator", { tools: ["read", "subagent"] })];
			const fanout = await runSync(tempDir, fanoutAgents, "delegator", "Task", { runId: "fanout-run", index: 2 });
			assert.equal(fanout.exitCode, 0);
			assert.deepEqual(JSON.parse(fanout.finalOutput ?? "{}"), {
				PI_SUBAGENT_FANOUT_CHILD: "1",
				PI_SUBAGENT_PARENT_EVENT_SINK: "/tmp/inherited/events.jsonl",
				PI_SUBAGENT_PARENT_CONTROL_INBOX: "/tmp/inherited/control",
				PI_SUBAGENT_PARENT_RUN_ID: "fanout-run",
				PI_SUBAGENT_PARENT_CHILD_INDEX: "2",
			});

			mockPi.onCall({ echoEnv: envKeys });
			const nonFanoutAgents = [makeAgent("worker", { tools: ["read"] })];
			const nonFanout = await runSync(tempDir, nonFanoutAgents, "worker", "Task", { runId: "non-fanout-run" });
			assert.equal(nonFanout.exitCode, 0);
			assert.deepEqual(JSON.parse(nonFanout.finalOutput ?? "{}"), {
				PI_SUBAGENT_FANOUT_CHILD: "0",
				PI_SUBAGENT_PARENT_EVENT_SINK: "",
				PI_SUBAGENT_PARENT_CONTROL_INBOX: "",
				PI_SUBAGENT_PARENT_RUN_ID: "",
				PI_SUBAGENT_PARENT_CHILD_INDEX: "",
			});
		} finally {
			for (const key of envKeys) {
				if (saved[key] === undefined) delete process.env[key];
				else process.env[key] = saved[key];
			}
		}
	});

	it("passes supervisor metadata through to child execution", async () => {
		mockPi.onCall({ echoEnv: [
			"PI_SUBAGENT_INTERCOM_SESSION_NAME",
			"PI_SUBAGENT_ORCHESTRATOR_TARGET",
			"PI_SUBAGENT_RUN_ID",
			"PI_SUBAGENT_CHILD_AGENT",
			"PI_SUBAGENT_CHILD_INDEX",
		] });
		const agents = makeAgentConfigs(["echo"]);

		const result = await runSync(tempDir, agents, "echo", "Task", {
			runId: "78f659a3",
			index: 2,
			intercomSessionName: "subagent-echo-78f659a3-3",
			orchestratorIntercomTarget: "subagent-chat-parent",
		});

		assert.equal(result.exitCode, 0);
		assert.deepEqual(JSON.parse(result.finalOutput ?? "{}"), {
			PI_SUBAGENT_INTERCOM_SESSION_NAME: "subagent-echo-78f659a3-3",
			PI_SUBAGENT_ORCHESTRATOR_TARGET: "subagent-chat-parent",
			PI_SUBAGENT_RUN_ID: "78f659a3",
			PI_SUBAGENT_CHILD_AGENT: "echo",
			PI_SUBAGENT_CHILD_INDEX: "2",
		});
	});

	it("fails with actionable diagnostics when a requested extension tool is not loaded", async () => {
		mockPi.onCall({ output: "Model incorrectly claimed success", missingTools: ["fixture_search"] });
		const agents = [makeAgent("extension-worker", { tools: ["read", "fixture_search"], fallbackModels: ["mock/fallback-model"] })];

		const result = await runSync(tempDir, agents, "extension-worker", "Use fixture search", { runId: "missing-extension-tool" });

		assert.equal(result.exitCode, 1);
		assert.match(result.error ?? "", /requested unavailable child tools: fixture_search/);
		assert.match(result.error ?? "", /subagentOnlyExtensions/);
		assert.match(result.error ?? "", /strict allowlist/);
		assert.equal(result.modelAttempts?.length, 1);
	});

	it("passes custom tool extensions through even when explicit extensions are allowlisted", { skip: process.platform === "win32" ? "extension path resolution intermittent on Windows CI" : undefined }, async () => {
		mockPi.onCall({ output: "Done" });
		const agents = [makeAgent("echo", {
			tools: ["read", "./custom-tool.ts"],
			extensions: ["./allowed-ext.ts"],
		})];

		const result = await runSync(tempDir, agents, "echo", "Task", {
			runId: "tool-extension-allowlist",
		});

		assert.equal(result.exitCode, 0);
		const args = readCallArgs();
		const extensionArgs = args.filter((arg, index) => args[index - 1] === "--extension");
		assert.ok(extensionArgs.some((arg) => arg.endsWith(path.join("src", "runs", "shared", "subagent-prompt-runtime.ts"))));
		assert.ok(extensionArgs.some((arg) => arg.replace(/\\/g, "/").endsWith("custom-tool.ts")));
		assert.ok(extensionArgs.some((arg) => arg.replace(/\\/g, "/").endsWith("allowed-ext.ts")));
	});

	it("passes subagent-only extensions through to child execution", { skip: process.platform === "win32" ? "extension path resolution intermittent on Windows CI" : undefined }, async () => {
		mockPi.onCall({ output: "Done" });
		const agents = [makeAgent("echo", {
			tools: ["read"],
			subagentOnlyExtensions: ["./child-only-tool.ts"],
		})];

		const result = await runSync(tempDir, agents, "echo", "Task", {
			runId: "subagent-only-extension",
		});

		assert.equal(result.exitCode, 0);
		const args = readCallArgs();
		const extensionArgs = args.filter((arg, index) => args[index - 1] === "--extension");
		assert.ok(extensionArgs.some((arg) => arg.endsWith(path.join("src", "runs", "shared", "subagent-prompt-runtime.ts"))));
		assert.ok(extensionArgs.some((arg) => arg.replace(/\\/g, "/").endsWith("child-only-tool.ts")));
	});

	it("ignores child watchdog status when foreground child watchdogs are not configured", async () => {
		await withIsolatedWatchdogSettings(tempDir, async () => {
			mockPi.onCall({
				jsonl: [events.assistantMessage("done-without-watchdog-config"), childWatchdogStatus("reviewing", 1)],
				keepAliveAfterFinalMessageMs: 10000,
			});
			const agents = makeAgentConfigs(["echo"]);

			const start = Date.now();
			const result = await runSync(tempDir, agents, "echo", "Task", { runId: "watchdog-child-run" });
			const elapsed = Date.now() - start;

			assert.ok(elapsed < 5000, `unconfigured watchdog status should not delay final drain, took ${elapsed}ms`);
			assert.equal(result.exitCode, 0);
			assert.equal(result.finalOutput, "done-without-watchdog-config");
			assert.equal((result as RunSyncResult & { watchdog?: unknown }).watchdog, undefined);
		});
	});

	it("waits for child watchdog settlement before foreground final-drain cleanup", async () => {
		await withIsolatedWatchdogSettings(tempDir, async () => {
			writeWatchdogSettings(tempDir);
			mockPi.onCall({
				steps: [
					{ jsonl: [events.assistantMessage("done-before-watchdog"), childWatchdogStatus("reviewing", 1)] },
					{ delay: 1400, jsonl: [childWatchdogStatus("idle", 2)] },
				],
				keepAliveAfterFinalMessageMs: 10000,
			});
			const agents = makeAgentConfigs(["echo"]);

			const start = Date.now();
			const result = await runSync(tempDir, agents, "echo", "Task", { runId: "watchdog-child-run" });
			const elapsed = Date.now() - start;

			assert.ok(elapsed >= 1200, `watchdog settlement should delay final drain, took ${elapsed}ms`);
			assert.ok(elapsed < 6000, `settled watchdog should still allow cleanup, took ${elapsed}ms`);
			assert.equal(result.exitCode, 0);
			assert.equal(result.finalOutput, "done-before-watchdog");
			assert.equal((result as RunSyncResult & { watchdog?: { phase?: string } }).watchdog?.phase, "idle");
		});
	});

	it("falls back after child watchdog tail timeout without failing successful foreground output", async () => {
		await withIsolatedWatchdogSettings(tempDir, async () => {
			writeWatchdogSettings(tempDir, 150);
			mockPi.onCall({
				jsonl: [events.assistantMessage("done-before-watchdog-timeout"), childWatchdogStatus("reviewing", 1)],
				keepAliveAfterFinalMessageMs: 10000,
			});
			const agents = makeAgentConfigs(["echo"]);

			const start = Date.now();
			const result = await runSync(tempDir, agents, "echo", "Task", { runId: "watchdog-child-run" });
			const elapsed = Date.now() - start;

			assert.ok(elapsed < 5000, `watchdog tail fallback should not hang, took ${elapsed}ms`);
			assert.equal(result.exitCode, 0);
			assert.equal(result.finalOutput, "done-before-watchdog-timeout");
			const watchdog = (result as RunSyncResult & { watchdog?: { phase?: string; timedOut?: boolean } }).watchdog;
			assert.equal(watchdog?.phase, "stale");
			assert.equal(watchdog?.timedOut, true);
		});
	});

	it("treats forced drain after final assistant output as cleanup success", async () => {
		mockPi.onCall({
			jsonl: [events.assistantMessage("done-before-drain")],
			stderr: "Done after 1 turn(s). Ready for input.\n",
			keepAliveAfterFinalMessageMs: 10000,
		});
		const agents = makeAgentConfigs(["echo"]);

		const start = Date.now();
		const result = await runSync(tempDir, agents, "echo", "Task", {});
		const elapsed = Date.now() - start;

		assert.ok(elapsed < 4000, `should clean up shortly after terminal stop, took ${elapsed}ms`);
		assert.equal(result.exitCode, 0);
		assert.equal(result.error, undefined);
		assert.equal(result.finalOutput, "done-before-drain");
		assert.ok(!(result.progress?.recentOutput ?? []).some((line) => line.includes("Forcing termination")));
	});

	it("treats forced drain after empty terminal assistant output as cleanup success", async () => {
		mockPi.onCall({
			jsonl: [{
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "" }],
					model: "mock/test-model",
					stopReason: "stop",
					usage: { input: 100, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } },
				},
			}],
			keepAliveAfterFinalMessageMs: 10000,
		});
		const agents = makeAgentConfigs(["echo"]);

		const start = Date.now();
		const result = await runSync(tempDir, agents, "echo", "Task", {});
		const elapsed = Date.now() - start;

		assert.ok(elapsed < 4000, `should clean up shortly after empty terminal stop, took ${elapsed}ms`);
		assert.equal(result.exitCode, 0);
		assert.equal(result.error, undefined);
		assert.equal(result.finalOutput, "");
		assert.equal(result.progress.status, "completed");
		assert.ok(!(result.progress?.recentOutput ?? []).some((line) => line.includes("Forcing termination")));
	});

	it("keeps explicit assistant errors as failures during final-drain cleanup", async () => {
		mockPi.onCall({
			jsonl: [{
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "failed" }],
					model: "mock/test-model",
					stopReason: "stop",
					errorMessage: "provider exploded",
					usage: { input: 100, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } },
				},
			}],
			keepAliveAfterFinalMessageMs: 10000,
		});
		const agents = makeAgentConfigs(["echo"]);

		const result = await runSync(tempDir, agents, "echo", "Task", {});

		assert.equal(result.exitCode, 1);
		assert.equal(result.error, "provider exploded");
		assert.equal(result.progress.status, "failed");
	});

	it("handles abort signal (completes faster than delay)", async () => {
		mockPi.onCall({ delay: 10000 }); // Long delay — process should be killed before this
		const agents = makeAgentConfigs(["slow"]);
		const controller = new AbortController();

		const start = Date.now();
		setTimeout(() => controller.abort(), 200);

		const result = await runSync(tempDir, agents, "slow", "Slow task", {
			signal: controller.signal,
		});
		const elapsed = Date.now() - start;

		// The key assertion: the run should complete much faster than the 10s delay,
		// proving the abort signal terminated the process early.
		assert.ok(elapsed < 5000, `should abort early, took ${elapsed}ms`);
		// Exit code is platform-dependent (Windows: often 1 or 0, Linux: null/143)
	});

	it("marks foreground runs that exceed timeoutMs as timed out", async () => {
		mockPi.onCall({ delay: 10000 });
		const agents = makeAgentConfigs(["slow"]);

		const start = Date.now();
		const result = await runSync(tempDir, agents, "slow", "Slow task", {
			timeoutMs: 150,
		});
		const elapsed = Date.now() - start;

		assert.ok(elapsed < 5000, `should time out early, took ${elapsed}ms`);
		assert.notEqual(result.exitCode, 0);
		assert.equal(result.timedOut, true);
		assert.equal(result.error, "Subagent timed out after 150ms.");
		assert.match(result.finalOutput ?? "", /Subagent timed out after 150ms\./);
		assert.equal(result.progress.status, "failed");
	});

	it("allows a foreground run to finish on the final turn-budget grace turn", async () => {
		mockPi.onCall({
			jsonl: [
				mockAssistantMessage("working before wrap-up", "tool_use"),
				mockAssistantMessage("final wrapped output", "stop"),
			],
		});
		const agents = makeAgentConfigs(["worker"]);

		const result = await runSync(tempDir, agents, "worker", "Use the final grace turn to wrap up.", {
			turnBudget: { maxTurns: 1, graceTurns: 1 },
			runId: "foreground-turn-budget-soft",
		});

		assert.equal(result.exitCode, 0);
		assert.equal(result.turnBudgetExceeded, undefined);
		assert.equal(result.wrapUpRequested, true);
		assert.equal(result.turnBudget?.outcome, "wrap-up-requested");
		assert.equal(result.turnBudget?.turnCount, 2);
		assert.match(result.finalOutput ?? "", /Turn budget wrap-up was requested after 1 assistant turn/);
		assert.match(result.finalOutput ?? "", /final wrapped output/);
	});

	it("preserves a clean foreground completion after turn-budget work defers", async () => {
		mockPi.onCall({
			steps: [
				{
					jsonl: [
						mockAssistantMessage("starting required tool work", "tool_use"),
						events.toolStart("bash", { command: "node build.mjs" }),
					],
				},
				{
					delay: 500,
					jsonl: [
						events.toolResult("bash", "build completed"),
						events.toolEnd("bash"),
						mockAssistantMessage("safe assistant boundary reached", "stop"),
					],
				},
			],
		});
		const agents = makeAgentConfigs(["worker"]);
		const snapshots: Array<{
			turnBudget?: { outcome?: string; terminationDeferredAtTurn?: number };
			turnBudgetExceeded?: boolean;
			error?: string;
			currentTool?: string;
			status?: string;
		}> = [];

		const result = await runSync(tempDir, agents, "worker", "Finish active tool work before enforcing the hard limit.", {
			turnBudget: { maxTurns: 1, graceTurns: 0 },
			runId: "foreground-turn-budget-deferred",
			onUpdate(update: { details?: { results?: Array<{ turnBudget?: { outcome?: string; terminationDeferredAtTurn?: number }; turnBudgetExceeded?: boolean; error?: string }>; progress?: Array<{ currentTool?: string; status?: string }> } }) {
				const current = update.details?.results?.[0];
				const progress = update.details?.progress?.[0];
				snapshots.push({
					turnBudget: current?.turnBudget,
					turnBudgetExceeded: current?.turnBudgetExceeded,
					error: current?.error,
					currentTool: progress?.currentTool,
					status: progress?.status,
				});
			},
		});

		const duringTool = snapshots.find((snapshot) => snapshot.turnBudget?.outcome === "termination-deferred" && snapshot.currentTool === "bash");
		assert.ok(duringTool, "expected a running snapshot with deferred termination and the active tool");
		assert.equal(duringTool.turnBudget?.terminationDeferredAtTurn, 1);
		assert.equal(duringTool.turnBudgetExceeded, undefined);
		assert.equal(duringTool.error, undefined);
		assert.equal(duringTool.status, "running");
		assert.equal(result.exitCode, 0);
		assert.equal(result.turnBudgetExceeded, undefined);
		assert.equal(result.turnBudget?.outcome, "wrap-up-requested");
		assert.equal(result.turnBudget?.turnCount, 2);
		assert.match(result.finalOutput ?? "", /safe assistant boundary reached/);
		assert.ok(result.messages?.some((message) => message.role === "toolResult" && JSON.stringify(message.content).includes("build completed")));
	});

	it("does not run acceptance verification after a foreground timeout", async () => {
		const markerPath = path.join(tempDir, "verify-ran.txt");
		const report = [
			"done",
			"```acceptance-report",
			JSON.stringify({
				criteriaSatisfied: [{ id: "criterion-1", status: "satisfied", evidence: "integration test evidence" }],
				changedFiles: ["src/a.ts"],
				testsAddedOrUpdated: ["test/a.test.ts"],
				commandsRun: [{ command: "npm test", result: "passed", summary: "passed" }],
				validationOutput: ["validation passed"],
				residualRisks: [],
				noStagedFiles: true,
				notes: "complete",
			}),
			"```",
		].join("\n");
		mockPi.onCall({ jsonl: [events.assistantMessage(report)], keepAliveAfterFinalMessageMs: 10000 });
		const agents = makeAgentConfigs(["slow"]);

		const result = await runSync(tempDir, agents, "slow", "Slow task", {
			timeoutMs: 150,
			acceptance: {
				level: "verified",
				verify: [{
					id: "marker",
					command: "node -e \"require('node:fs').writeFileSync(process.env.VERIFY_MARKER, 'ran')\"",
					env: { VERIFY_MARKER: markerPath },
					timeoutMs: 10_000,
				}],
			},
		});

		assert.equal(result.timedOut, true);
		assert.equal(result.acceptance?.status, "rejected");
		assert.equal(result.acceptance?.runtimeChecks?.[0]?.id, "timeout");
		assert.equal(result.acceptance?.verifyRuns?.length, 0);
		assert.equal(fs.existsSync(markerPath), false);
	});

	it("soft-interrupts the current turn and returns a paused result", async () => {
		mockPi.onCall({ delay: 10000 });
		const agents = makeAgentConfigs(["slow"]);
		const controller = new AbortController();
		const controlEvents: Array<{ type?: string; to?: string }> = [];

		const start = Date.now();
		setTimeout(() => controller.abort(), 200);

		const result = await runSync(tempDir, agents, "slow", "Slow task", {
			runId: "interrupt-run",
			interruptSignal: controller.signal,
			onControlEvent: (event: { type?: string; to?: string }) => {
				controlEvents.push(event);
			},
		});
		const elapsed = Date.now() - start;

		assert.ok(elapsed < 5000, `should interrupt early, took ${elapsed}ms`);
		assert.equal(result.exitCode, 0);
		assert.equal(result.interrupted, true);
		assert.equal(result.progress.activityState, undefined);
		assert.deepEqual(controlEvents, []);
		assert.match(result.finalOutput ?? "", /Interrupted/);
	});

	it("preserves manual interrupt semantics when a timeout is also configured", async () => {
		mockPi.onCall({ delay: 10000 });
		const agents = makeAgentConfigs(["slow"]);
		const controller = new AbortController();

		setTimeout(() => controller.abort(), 100);
		const result = await runSync(tempDir, agents, "slow", "Slow task", {
			interruptSignal: controller.signal,
			timeoutMs: 500,
		});

		assert.equal(result.exitCode, 0);
		assert.equal(result.interrupted, true);
		assert.equal(result.timedOut, undefined);
		assert.equal(result.error, undefined);
		assert.match(result.finalOutput ?? "", /Interrupted/);
	});

	it("supports synchronous user detach and rejects duplicate and late detach calls", async () => {
		mockPi.onCall({ steps: [
			{ delay: 500, jsonl: [events.assistantMessage("completed after user detach")] },
		] });
		let detachActive: ((reason?: string) => boolean) | undefined;
		let detachAccepted = false;
		let duplicateAccepted = true;
		let recoveredResult: RunSyncResult | undefined;

		const result = await runSync(tempDir, makeAgentConfigs(["echo"]), "echo", "Keep working", {
			runId: "user-foreground-detach",
			acceptance: false,
			onDetachReady: (detach: (reason?: string) => boolean) => {
				detachActive = detach;
				detachAccepted = detach("user request");
				duplicateAccepted = detach("user request");
			},
			onDetachedExit: (postExit) => { recoveredResult = postExit as RunSyncResult; },
		});

		assert.equal(detachAccepted, true);
		assert.equal(duplicateAccepted, false);
		assert.equal(recoveredResult, undefined, "foreground result should return before the child completes");
		assert.equal(result.exitCode, -2);
		assert.equal(result.detached, true);
		assert.equal(result.detachedReason, "user request");
		assert.equal(result.finalOutput, "Detached at user request before task completion.");
		assert.equal(result.processSignal, undefined);

		for (let attempt = 0; attempt < 100 && !recoveredResult; attempt++) await new Promise((resolve) => setTimeout(resolve, 20));
		assert.ok(recoveredResult);
		assert.equal(recoveredResult.exitCode, 0);
		assert.equal(recoveredResult.processSignal, undefined);
		assert.equal(recoveredResult.finalOutput, "completed after user detach");
		assert.equal(detachActive?.("user request"), false, "detach must reject calls after child exit");
	});

	it("produces the same authoritative terminal result attached and detached", async () => {
		mockPi.onCall({ output: "authoritative answer" });
		mockPi.onCall({ steps: [{ delay: 75, jsonl: [events.assistantMessage("authoritative answer")] }] });
		const agents = makeAgentConfigs(["echo"]);
		const attached = await runSync(tempDir, agents, "echo", "Equivalent task", {
			runId: "attached-authoritative-result",
			acceptance: false,
		});
		let terminal: RunSyncResult | undefined;
		const receipt = await runSync(tempDir, agents, "echo", "Equivalent task", {
			runId: "detached-authoritative-result",
			acceptance: false,
			onDetachReady: (detach) => assert.equal(detach("user request"), true),
			onDetachedExit: (result) => { terminal = result as RunSyncResult; },
		});
		assert.equal(receipt.detached, true);
		for (let attempt = 0; attempt < 100 && !terminal; attempt++) await new Promise((resolve) => setTimeout(resolve, 20));
		assert.ok(terminal);
		assert.deepEqual(
			{
				exitCode: terminal.exitCode,
				finalOutput: terminal.finalOutput,
				usage: terminal.usage,
				progressStatus: terminal.progress.status,
				acceptanceStatus: terminal.acceptance?.status,
			},
			{
				exitCode: attached.exitCode,
				finalOutput: attached.finalOutput,
				usage: attached.usage,
				progressStatus: attached.progress.status,
				acceptanceStatus: attached.acceptance?.status,
			},
		);
		assert.equal(terminal.detached, undefined);
		assert.equal(terminal.detachedReason, "user request");
	});

	it("isolates every nested detach receipt field from terminal completion and later sanitization", async () => {
		const receiptReport = [
			"receipt snapshot",
			"```acceptance-report",
			JSON.stringify({
				criteriaSatisfied: [{ id: "criterion-1", status: "satisfied", evidence: "receipt evidence" }],
				changedFiles: ["src/receipt.ts"],
				testsAddedOrUpdated: ["test/receipt.test.ts"],
				commandsRun: [{ command: "npm test", result: "passed", summary: "passed" }],
				residualRisks: [],
				noStagedFiles: true,
			}),
			"```",
		].join("\n");
		const terminalReport = [
			"terminal answer",
			"```acceptance-report",
			JSON.stringify({
				criteriaSatisfied: [{ id: "criterion-1", status: "satisfied", evidence: "terminal isolation verified" }],
				changedFiles: ["src/receipt.ts"],
				testsAddedOrUpdated: ["test/receipt.test.ts"],
				commandsRun: [{ command: "npm test", result: "passed", summary: "passed" }],
				residualRisks: [],
				noStagedFiles: true,
			}),
			"```",
		].join("\n");
		mockPi.onCall({ steps: [
			{ jsonl: [{
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: receiptReport }],
					model: "mock/test-model",
					stopReason: "toolUse",
					usage: { input: 7, output: 3, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } },
				},
			}] },
			{ delay: 300, jsonl: [events.assistantMessage(terminalReport)] },
		] });
		let detach: ((reason?: string) => boolean) | undefined;
		let detached = false;
		let terminal: RunSyncResult | undefined;
		const receipt = await runSync(tempDir, makeAgentConfigs(["echo"]), "echo", "Keep the receipt isolated", {
			runId: "detached-deep-receipt-isolation",
			agentContract: { version: 1 },
			acceptance: {
				level: "checked",
				criteria: [{
					id: "criterion-1",
					must: "Keep detach receipt state isolated",
					evidence: ["changed-files", "tests-added", "commands-run", "residual-risks", "no-staged-files"],
				}],
			},
			onDetachReady: (detachAttempt) => { detach = detachAttempt; },
			onUpdate: (update: { content?: Array<{ text?: string }> }) => {
				if (detached || !update.content?.[0]?.text?.includes("receipt snapshot")) return;
				detached = detach?.("user request") === true;
			},
			onDetachedExit: (result) => { terminal = result as RunSyncResult; },
		});

		assert.equal(receipt.detached, true);
		const receiptMessages = receipt.messages as Array<{
			role?: string;
			model?: string;
			content: Array<{ type?: string; text?: string; callerOwned?: boolean }>;
		}>;
		const callerOwnedReceiptText = `caller-owned mutation\n${receiptReport}`;
		(receipt.agentContract as unknown as { version: number }).version = 999;
		receiptMessages[0]!.model = "caller-owned/model";
		receiptMessages[0]!.content[0]!.text = callerOwnedReceiptText;
		receiptMessages[0]!.content[0]!.callerOwned = true;
		receiptMessages[0]!.content.push({ type: "text", text: "caller-only content" });
		receiptMessages.push({ role: "assistant", model: "caller-only/model", content: [{ type: "text", text: "caller-only message" }] });
		const mutableAcceptance = receipt.acceptance as unknown as {
			status: string;
			effectiveAcceptance: { level: string; criteria: Array<{ must: string }> };
			criteria: Array<{ must: string }>;
		};
		mutableAcceptance.status = "rejected";
		mutableAcceptance.effectiveAcceptance.level = "none";
		mutableAcceptance.effectiveAcceptance.criteria[0]!.must = "caller corrupted effective criterion";
		mutableAcceptance.criteria[0]!.must = "caller corrupted ledger criterion";
		receipt.progress.status = "failed";
		(receipt.progress as unknown as { recentOutput: string[] }).recentOutput.push("caller-only progress");
		receipt.usage.turns = 999;
		receipt.usage.input = 999;
		receipt.attemptedModels = ["caller-only/model"];
		receipt.modelAttempts = [{ success: false, exitCode: 99, error: "caller-only attempt" }];
		receipt.effects = { fileMutation: { status: "missing", expected: true, attempted: false, message: "caller-only effect" } };
		receipt.execution = { status: "failed", success: false, exitCode: 99 };
		receipt.review = { status: "blockers" };

		for (let attempt = 0; attempt < 100 && !terminal; attempt++) await new Promise((resolve) => setTimeout(resolve, 20));
		assert.ok(terminal);
		assert.equal(terminal.exitCode, 0);
		assert.equal(terminal.finalOutput, "terminal answer");
		assert.deepEqual(terminal.agentContract, { version: 1 });
		assert.equal(terminal.acceptance?.status, "checked");
		assert.equal(terminal.acceptance?.runtimeChecks.every((check) => check.status === "passed"), true);
		assert.equal(terminal.progress.status, "completed");
		assert.deepEqual(terminal.usage, { turns: 2, input: 107, output: 53, cacheRead: 0, cacheWrite: 0, cost: 0.002 });
		assert.deepEqual(terminal.attemptedModels, ["mock/test-model"]);
		assert.deepEqual(terminal.modelAttempts?.map((attempt) => ({ success: attempt.success, exitCode: attempt.exitCode })), [{ success: true, exitCode: 0 }]);
		assert.equal(terminal.execution?.status, "completed");
		assert.equal(terminal.execution?.success, true);
		assert.equal(terminal.review?.status, "not-requested");
		assert.deepEqual(terminal.effects, {});
		assert.doesNotMatch(JSON.stringify(terminal.messages), /acceptance-report/);
		assert.equal(receiptMessages[0]!.content[0]!.text, callerOwnedReceiptText, "terminal report sanitization must not mutate the caller receipt");
		assert.equal(receiptMessages[0]!.content[0]!.callerOwned, true);
		assert.equal(receiptMessages.length, 2);
	});

	it("keeps the full fallback loop and authoritative aggregation alive after detach", async () => {
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
		mockPi.onCall({ output: "Recovered on detached fallback" });
		const agents = [makeAgent("echo", {
			model: "openai/gpt-5-mini",
			fallbackModels: ["anthropic/claude-sonnet-4"],
		})];
		let terminal: RunSyncResult | undefined;

		const receipt = await runSync(tempDir, agents, "echo", "Task", {
			runId: "detached-fallback-loop",
			acceptance: false,
			onDetachReady: (detach) => assert.equal(detach("user request"), true),
			onDetachedExit: (result) => { terminal = result as RunSyncResult; },
		});

		assert.equal(receipt.detached, true);
		for (let attempt = 0; attempt < 300 && !terminal; attempt++) await new Promise((resolve) => setTimeout(resolve, 20));
		assert.ok(terminal);
		assert.equal(terminal.detached, undefined, "terminal status must not remain detached");
		assert.equal(terminal.detachedReason, "user request");
		assert.equal(terminal.exitCode, 0);
		assert.equal(terminal.finalOutput, "Recovered on detached fallback");
		assert.deepEqual(terminal.attemptedModels, ["openai/gpt-5-mini", "anthropic/claude-sonnet-4"]);
		assert.deepEqual(terminal.modelAttempts?.map((attempt) => attempt.success), [false, true]);
		assert.equal(terminal.usage.turns, 2);
		assert.equal(mockPi.callCount(), 2);
	});

	it("terminalizes a post-receipt completion pipeline throw exactly once with strict projections", async () => {
		mockPi.onCall({ steps: [{ delay: 75, jsonl: [events.assistantMessage("answer before callback failure")] }] });
		let terminal: RunSyncResult | undefined;
		let callbackCount = 0;
		const receipt = await runSync(tempDir, makeAgentConfigs(["echo"]), "echo", "Task", {
			runId: "detached-completion-pipeline-throw",
			acceptance: { level: "checked", criteria: ["result is checked"] },
			agentContract: { version: 1 },
			onDetachReady: (detach) => {
				assert.equal(detach("user request"), true);
			},
			onUpdate: (update: { details?: { progress?: Array<{ status?: string }> } }) => {
				if (update.details?.progress?.[0]?.status === "completed") throw new Error("terminal consumer update failed");
			},
			onDetachedExit: (result) => {
				callbackCount++;
				terminal = result as RunSyncResult;
			},
		});
		assert.equal(receipt.detached, true);
		(receipt.agentContract as unknown as { version: number }).version = 999;
		receipt.messages.push({ role: "assistant", content: [{ type: "text", text: "caller-only fallback message" }] });
		const mutableAcceptance = receipt.acceptance as unknown as {
			status: string;
			effectiveAcceptance: { level: string; criteria: Array<{ must: string }> };
		};
		mutableAcceptance.status = "accepted";
		mutableAcceptance.effectiveAcceptance.level = "none";
		mutableAcceptance.effectiveAcceptance.criteria[0]!.must = "caller-only fallback criterion";
		receipt.progress.status = "completed";
		receipt.usage.turns = 999;
		receipt.usage.input = 999;
		receipt.attemptedModels = ["caller-only/fallback"];
		receipt.modelAttempts = [{ success: true, exitCode: 0 }];
		receipt.effects = { fileMutation: { status: "observed", expected: false, attempted: true, message: "caller-only fallback effect" } };
		for (let attempt = 0; attempt < 100 && !terminal; attempt++) await new Promise((resolve) => setTimeout(resolve, 20));
		assert.ok(terminal);
		assert.equal(callbackCount, 1);
		assert.equal(terminal.exitCode, 1);
		assert.equal(terminal.detached, undefined);
		assert.equal(terminal.detachedReason, "user request");
		assert.equal(terminal.progress?.status, "failed");
		assert.equal(terminal.acceptance?.status, "rejected");
		assert.equal(terminal.acceptance?.runtimeChecks?.[0]?.id, "completion-pipeline");
		assert.equal(terminal.execution?.status, "failed");
		assert.equal(terminal.execution?.success, false);
		assert.equal(terminal.review?.status, "not-requested");
		assert.deepEqual(terminal.agentContract, { version: 1 });
		assert.deepEqual(terminal.effects, {});
		assert.equal(terminal.usage.turns, 0);
		assert.equal(terminal.attemptedModels, undefined);
		assert.equal(terminal.modelAttempts, undefined);
		assert.doesNotMatch(JSON.stringify(terminal.messages), /caller-only fallback message/);
		assert.match(terminal.error ?? "", /Detached completion pipeline failed after receipt/);
	});

	it("contains a synchronous onDetachReady throw and completes attached", async () => {
		mockPi.onCall({ output: "completed while attached" });
		const result = await runSync(tempDir, makeAgentConfigs(["echo"]), "echo", "Task", {
			runId: "throwing-detach-ready-consumer",
			acceptance: false,
			onDetachReady: () => {
				throw new Error("bad detach consumer");
			},
		});
		assert.equal(result.exitCode, 0);
		assert.equal(result.detached, undefined);
		assert.equal(result.finalOutput, "completed while attached");
		assert.equal(result.progress.recentOutput.some((line) => /Foreground detach callback failed: bad detach consumer/.test(line)), true);
	});

	it("reports expected artifact post-processing I/O failures without rejecting", async () => {
		mockPi.onCall({ steps: [
			{ jsonl: [events.toolStart("read", { path: "README.md" })] },
			{ delay: 50, jsonl: [events.assistantMessage("artifact answer")] },
		] });
		const artifactsDir = path.join(tempDir, "artifact-output-failure");
		let sabotaged = false;
		const result = await runSync(tempDir, makeAgentConfigs(["echo"]), "echo", "Task", {
			runId: "artifact-output-result-field",
			acceptance: false,
			artifactsDir,
			artifactConfig: { enabled: true },
			onUpdate: (update: { details?: { results?: Array<{ artifactPaths?: { outputPath?: string } }> } }) => {
				const outputPath = update.details?.results?.[0]?.artifactPaths?.outputPath;
				if (sabotaged || !outputPath) return;
				sabotaged = true;
				fs.mkdirSync(outputPath);
			},
		});
		assert.equal(sabotaged, true);
		assert.equal(result.exitCode, 0);
		assert.match(result.outputSaveError ?? "", /Artifact output post-processing failed/);
	});

	it("publishes detach despite best-effort receipt metadata persistence failure", async () => {
		mockPi.onCall({ steps: [{ delay: 100, jsonl: [events.assistantMessage("completed after metadata recovery")] }] });
		const artifactsDir = path.join(tempDir, "receipt-metadata-failure");
		let terminal: RunSyncResult | undefined;
		const receipt = await runSync(tempDir, makeAgentConfigs(["echo"]), "echo", "Task", {
			runId: "detach-receipt-metadata-failure",
			acceptance: false,
			artifactsDir,
			artifactConfig: { enabled: true },
			onDetachReady: (detach) => {
				fs.rmSync(artifactsDir, { recursive: true, force: true });
				fs.writeFileSync(artifactsDir, "block metadata", "utf-8");
				assert.equal(detach("user request"), true);
				fs.rmSync(artifactsDir, { force: true });
				fs.mkdirSync(artifactsDir, { recursive: true });
			},
			onDetachedExit: (result) => { terminal = result as RunSyncResult; },
		});
		assert.equal(receipt.detached, true);
		assert.ok(receipt.metadataSaveError, "receipt should record best-effort metadata persistence failure");
		for (let attempt = 0; attempt < 100 && !terminal; attempt++) await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal(terminal?.exitCode, 0);
	});

	it("contains a throwing detached-exit callback", async () => {
		mockPi.onCall({ steps: [{ delay: 50, jsonl: [events.assistantMessage("done")] }] });
		let callbackCount = 0;
		const receipt = await runSync(tempDir, makeAgentConfigs(["echo"]), "echo", "Task", {
			runId: "throwing-detached-exit-callback",
			acceptance: false,
			onDetachReady: (detach) => assert.equal(detach("user request"), true),
			onDetachedExit: () => {
				callbackCount++;
				throw new Error("consumer callback failed");
			},
		});
		assert.equal(receipt.detached, true);
		for (let attempt = 0; attempt < 100 && callbackCount === 0; attempt++) await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal(callbackCount, 1);
	});

	it("skips acceptance evaluation when an explicitly interrupted detached result settles", async () => {
		mockPi.onCall({ steps: [{ delay: 10_000, jsonl: [events.assistantMessage("too late")] }] });
		const interrupt = new AbortController();
		let terminal: RunSyncResult | undefined;
		const receipt = await runSync(tempDir, makeAgentConfigs(["slow"]), "slow", "Task", {
			runId: "detached-interrupted-acceptance",
			acceptance: { level: "checked", criteria: ["result is checked"] },
			interruptSignal: interrupt.signal,
			onDetachReady: (detach) => {
				assert.equal(detach("user request"), true);
				setTimeout(() => interrupt.abort(), 25);
			},
			onDetachedExit: (result) => { terminal = result as RunSyncResult; },
		});
		assert.equal(receipt.detached, true);
		for (let attempt = 0; attempt < 100 && !terminal; attempt++) await new Promise((resolve) => setTimeout(resolve, 20));
		assert.ok(terminal);
		assert.equal(terminal.interrupted, true);
		assert.equal(terminal.exitCode, 0);
		assert.equal(terminal.acceptance?.status, "pending");
		assert.equal(terminal.acceptance?.runtimeChecks[0]?.status, "not-applicable");
		assert.equal(terminal.error, undefined);
	});

	it("linearizes originating abort against detach and keeps explicit interrupt routable afterward", async () => {
		mockPi.onCall({ steps: [{ delay: 10_000, jsonl: [events.assistantMessage("too late")] }] });
		const origin = new AbortController();
		const interrupt = new AbortController();
		let terminal: RunSyncResult | undefined;
		const receipt = await runSync(tempDir, makeAgentConfigs(["slow"]), "slow", "Keep working", {
			runId: "detach-origin-abort-race",
			acceptance: false,
			signal: origin.signal,
			interruptSignal: interrupt.signal,
			onDetachReady: (detach) => {
				assert.equal(detach("user request"), true);
				origin.abort();
				setTimeout(() => interrupt.abort(), 50);
			},
			onDetachedExit: (result) => { terminal = result as RunSyncResult; },
		});

		assert.equal(receipt.detached, true);
		for (let attempt = 0; attempt < 100 && !terminal; attempt++) await new Promise((resolve) => setTimeout(resolve, 20));
		assert.ok(terminal);
		assert.equal(terminal.interrupted, true, "explicit control interrupt must remain active after detach");
		assert.equal(terminal.processSignal, "SIGINT");
		assert.equal(terminal.detached, undefined);
	});

	it("lets an already-observed originating abort win over detach", async () => {
		mockPi.onCall({ delay: 10_000 });
		const origin = new AbortController();
		let detachAccepted = true;
		const result = await runSync(tempDir, makeAgentConfigs(["slow"]), "slow", "Abort first", {
			runId: "origin-abort-wins-detach",
			signal: origin.signal,
			onDetachReady: (detach) => {
				origin.abort();
				detachAccepted = detach("user request");
			},
		});
		assert.equal(detachAccepted, false);
		assert.equal(result.detached, undefined);
	});

	it("keeps the configured runtime timeout active after user detach", async () => {
		mockPi.onCall({ delay: 10_000 });
		let recoveredResult: RunSyncResult | undefined;
		const startedAt = Date.now();

		const result = await runSync(tempDir, makeAgentConfigs(["slow"]), "slow", "Do not run forever", {
			runId: "user-detach-timeout",
			timeoutMs: 150,
			acceptance: false,
			onDetachReady: (detach: (reason?: string) => boolean) => {
				assert.equal(detach("user request"), true);
			},
			onDetachedExit: (postExit) => { recoveredResult = postExit as RunSyncResult; },
		});

		assert.equal(result.detached, true);
		assert.ok(Date.now() - startedAt < 1_000, "detach should release the foreground waiter promptly");
		for (let attempt = 0; attempt < 300 && !recoveredResult; attempt++) await new Promise((resolve) => setTimeout(resolve, 20));
		assert.ok(recoveredResult, "configured timeout should terminate and recover the detached child");
		assert.equal(recoveredResult.timedOut, true);
		assert.equal(recoveredResult.error, "Subagent timed out after 150ms.");
		assert.equal(recoveredResult.progress.status, "failed");
		assert.ok(Date.now() - startedAt < 5_000, "detached child should remain bounded by runtime enforcement");
	});

	for (const toolName of ["intercom", "contact_supervisor"]) {
		it(`detaches cleanly on ${toolName} handoff without aborting the child process`, async () => {
			const eventBus = createEventBus();
			let accepted = false;
			eventBus.on(INTERCOM_DETACH_RESPONSE_EVENT, (payload) => {
				if (!payload || typeof payload !== "object") return;
				accepted = (payload as { accepted?: unknown }).accepted === true;
			});
			mockPi.onCall({
				steps: [
					{ jsonl: [events.toolStart(toolName, toolName === "intercom" ? { action: "ask", to: "orchestrator" } : { reason: "need_decision", message: "Need a decision" })] },
					{ delay: 1000, jsonl: [events.assistantMessage("received pong")] },
				],
			});
			const agents = makeAgentConfigs(["echo"]);

			// Emit the detach request the moment we observe the coordination tool start
			// in a progress update — this is the signal the parent has set
			// `intercomStarted=true`. Using a fixed delay here races the mock's
			// cold spawn and flakes under load.
			let detachEmitted = false;
			const runPromise = runSync(tempDir, agents, "echo", "Task", {
				runId: `${toolName}-detach`,
				allowIntercomDetach: true,
				intercomEvents: eventBus,
				onUpdate: (update) => {
					if (detachEmitted) return;
					const progress = (update as { details?: { progress?: Array<{ currentTool?: string }> } }).details?.progress;
					const sawCoordinationTool = Array.isArray(progress) && progress.some((p) => p?.currentTool === toolName);
					if (!sawCoordinationTool) return;
					detachEmitted = true;
					eventBus.emit(INTERCOM_DETACH_REQUEST_EVENT, { requestId: "test-request" });
				},
			});

			const result = await runPromise;

			assert.equal(result.exitCode, -2);
			assert.equal(result.detached, true);
			assert.equal(result.detachedReason, "intercom coordination");
			assert.equal(result.finalOutput, "Detached for intercom coordination before task completion.");
			assert.equal(result.progress?.status, "detached");
			assert.equal(accepted, true);
		});
	}

	it("reports intercom detach race losses and repeated requests as not accepted", async () => {
		const abortBus = createEventBus();
		const abortResponses: boolean[] = [];
		abortBus.on(INTERCOM_DETACH_RESPONSE_EVENT, (payload) => abortResponses.push((payload as { accepted: boolean }).accepted));
		mockPi.onCall({ steps: [{ jsonl: [events.toolStart("contact_supervisor", { reason: "need_decision", message: "Need decision" })] }, { delay: 10_000 }] });
		const origin = new AbortController();
		let requested = false;
		const abortedResult = await runSync(tempDir, makeAgentConfigs(["echo"]), "echo", "Task", {
			runId: "intercom-abort-race-loss",
			allowIntercomDetach: true,
			intercomEvents: abortBus,
			signal: origin.signal,
			onUpdate: (update) => {
				if (requested || !update.details?.progress?.some((item) => item.currentTool === "contact_supervisor")) return;
				requested = true;
				origin.abort();
				abortBus.emit(INTERCOM_DETACH_REQUEST_EVENT, { requestId: "abort-race" });
			},
		});
		assert.equal(abortedResult.detached, undefined);
		assert.deepEqual(abortResponses, [false]);

		const repeatedBus = createEventBus();
		const repeatedResponses: boolean[] = [];
		repeatedBus.on(INTERCOM_DETACH_RESPONSE_EVENT, (payload) => repeatedResponses.push((payload as { accepted: boolean }).accepted));
		mockPi.onCall({ steps: [{ jsonl: [events.toolStart("contact_supervisor", { reason: "need_decision", message: "Need decision" })] }, { delay: 50, jsonl: [events.assistantMessage("done")] }] });
		let repeated = false;
		const repeatedReceipt = await runSync(tempDir, makeAgentConfigs(["echo"]), "echo", "Task", {
			runId: "intercom-repeated-detach",
			allowIntercomDetach: true,
			intercomEvents: repeatedBus,
			onUpdate: (update) => {
				if (repeated || !update.details?.progress?.some((item) => item.currentTool === "contact_supervisor")) return;
				repeated = true;
				repeatedBus.emit(INTERCOM_DETACH_REQUEST_EVENT, { requestId: "first" });
				repeatedBus.emit(INTERCOM_DETACH_REQUEST_EVENT, { requestId: "second" });
			},
		});
		assert.equal(repeatedReceipt.detached, true);
		assert.deepEqual(repeatedResponses, [true, false]);
	});

	it("does not launch retries or fallbacks after intercom detach and keeps timeout enforcement", async () => {
		const fallbackBus = createEventBus();
		mockPi.onCall({
			steps: [{ jsonl: [events.toolStart("contact_supervisor", { reason: "need_decision", message: "Need decision" })] }],
			stderr: "rate limit exceeded",
			exitCode: 1,
		});
		mockPi.onCall({ output: "must not launch" });
		let resolveFallbackTerminal!: (result: RunSyncResult) => void;
		const fallbackTerminal = new Promise<RunSyncResult>((resolve) => { resolveFallbackTerminal = resolve; });
		let fallbackRequested = false;
		const receipt = await runSync(tempDir, [makeAgent("echo", { model: "openai/gpt-5-mini", fallbackModels: ["anthropic/claude-sonnet-4"] })], "echo", "Task", {
			runId: "intercom-no-fallback",
			acceptance: false,
			allowIntercomDetach: true,
			intercomEvents: fallbackBus,
			onUpdate: (update) => {
				if (fallbackRequested || !update.details?.progress?.some((item) => item.currentTool === "contact_supervisor")) return;
				fallbackRequested = true;
				fallbackBus.emit(INTERCOM_DETACH_REQUEST_EVENT, { requestId: "no-fallback" });
			},
			onDetachedExit: (result) => { resolveFallbackTerminal(result as RunSyncResult); },
		});
		assert.equal(receipt.detached, true);
		const fallbackResult = await fallbackTerminal;
		assert.equal(mockPi.callCount(), 1);
		assert.equal(fallbackResult.exitCode, 1);

		const timeoutBus = createEventBus();
		mockPi.reset();
		mockPi.onCall({ delay: 10_000 });
		let resolveTimeoutTerminal!: (result: RunSyncResult) => void;
		const timeoutTerminal = new Promise<RunSyncResult>((resolve) => { resolveTimeoutTerminal = resolve; });
		let timeoutRequested = false;
		const timeoutReceipt = await runSync(tempDir, makeAgentConfigs(["slow"]), "slow", "Task", {
			runId: "intercom-timeout-enforced",
			acceptance: false,
			timeoutMs: 125,
			allowIntercomDetach: true,
			intercomEvents: timeoutBus,
			onDetachReady: () => {
				if (timeoutRequested) return;
				timeoutRequested = true;
				timeoutBus.emit(INTERCOM_DETACH_REQUEST_EVENT, {
					requestId: "timeout",
					runId: "intercom-timeout-enforced",
					agent: "slow",
					childIndex: 0,
				});
			},
			onDetachedExit: (result) => { resolveTimeoutTerminal(result as RunSyncResult); },
		});
		assert.equal(timeoutReceipt.detached, true);
		const timeoutResult = await timeoutTerminal;
		assert.equal(timeoutResult.timedOut, true);
		assert.equal(timeoutResult.exitCode, 1);
	});

	it("enforces the stdout protocol limit after foreground detachment", async () => {
		const eventBus = createEventBus();
		mockPi.onCall({ steps: [
			{ jsonl: [events.toolStart("contact_supervisor", { reason: "need_decision", message: "Need a decision" })] },
			{ delay: 100, stdoutRaw: "x".repeat(MAX_CHILD_PENDING_LINE_BYTES + 1) },
			{ delay: 5000 },
		] });
		let detachEmitted = false;
		let recoveredResult: RunSyncResult | undefined;
		const result = await runSync(tempDir, makeAgentConfigs(["echo"]), "echo", "Detach then emit malformed output", {
			runId: "detached-protocol-limit",
			allowIntercomDetach: true,
			intercomEvents: eventBus,
			acceptance: false,
			onUpdate: (update) => {
				if (detachEmitted) return;
				const progress = (update as { details?: { progress?: Array<{ currentTool?: string }> } }).details?.progress;
				if (!Array.isArray(progress) || !progress.some((item) => item.currentTool === "contact_supervisor")) return;
				detachEmitted = true;
				eventBus.emit(INTERCOM_DETACH_REQUEST_EVENT, { requestId: "detached-protocol-request" });
			},
			onDetachedExit: (postExit) => { recoveredResult = postExit as RunSyncResult; },
		});
		assert.equal(result.exitCode, -2);
		for (let attempt = 0; attempt < 100 && !recoveredResult; attempt++) await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal(recoveredResult?.exitCode, 1);
		assert.equal(recoveredResult?.protocolError?.code, "protocol_output_limit");
	});

	it("does not save a detached placeholder to an explicit file-only output", async () => {
		const eventBus = createEventBus();
		mockPi.onCall({
			steps: [
				{ jsonl: [events.toolStart("contact_supervisor", { reason: "need_decision", message: "Need a decision" })] },
				{ delay: 1000, jsonl: [events.assistantMessage("after reply")] },
			],
		});
		const agents = makeAgentConfigs(["echo"]);
		const outputPath = path.join(tempDir, "detached-output.md");
		let detachEmitted = false;

		const result = await runSync(tempDir, agents, "echo", "Task", {
			runId: "detached-file-only-output",
			allowIntercomDetach: true,
			intercomEvents: eventBus,
			outputPath,
			outputMode: "file-only",
			onUpdate: (update) => {
				if (detachEmitted) return;
				const progress = (update as { details?: { progress?: Array<{ currentTool?: string }> } }).details?.progress;
				if (!Array.isArray(progress) || !progress.some((p) => p?.currentTool === "contact_supervisor")) return;
				detachEmitted = true;
				eventBus.emit(INTERCOM_DETACH_REQUEST_EVENT, { requestId: "file-only-detach" });
			},
		});

		assert.equal(result.exitCode, -2);
		assert.equal(result.detached, true);
		assert.equal(result.savedOutputPath, undefined);
		assert.equal(fs.existsSync(outputPath), false);
		assert.match(result.outputSaveError ?? "", /not finalized/);
	});

	it("finalizes explicit output before reporting detached child post-exit success", async () => {
		const eventBus = createEventBus();
		mockPi.onCall({
			steps: [
				{ jsonl: [events.toolStart("contact_supervisor", { reason: "need_decision", message: "Need a decision" })] },
				{ delay: 100, jsonl: [events.assistantMessage("after reply")] },
			],
		});
		const agents = makeAgentConfigs(["echo"]);
		const outputPath = path.join(tempDir, "detached-final-output.md");
		let detachEmitted = false;
		let recoveredResult: RunSyncResult | undefined;

		const result = await runSync(tempDir, agents, "echo", "Task", {
			runId: "detached-file-only-post-exit-output",
			allowIntercomDetach: true,
			intercomEvents: eventBus,
			outputPath,
			outputMode: "file-only",
			onUpdate: (update) => {
				if (detachEmitted) return;
				const progress = (update as { details?: { progress?: Array<{ currentTool?: string }> } }).details?.progress;
				if (!Array.isArray(progress) || !progress.some((p) => p?.currentTool === "contact_supervisor")) return;
				detachEmitted = true;
				eventBus.emit(INTERCOM_DETACH_REQUEST_EVENT, { requestId: "file-only-post-exit-detach" });
			},
			onDetachedExit: (postExit) => {
				recoveredResult = postExit as RunSyncResult;
			},
		});

		assert.equal(result.exitCode, -2);
		assert.equal(result.detached, true);
		assert.equal(fs.existsSync(outputPath), false);

		for (let attempt = 0; attempt < 100 && (!fs.existsSync(outputPath) || !recoveredResult); attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 20));
		}

		assert.equal(fs.readFileSync(outputPath, "utf-8"), "after reply");
		assert.ok(recoveredResult);
		assert.equal(recoveredResult.exitCode, 0);
		assert.equal(recoveredResult.progress?.status, "completed");
		assert.equal(recoveredResult.savedOutputPath, outputPath);
		assert.equal(recoveredResult.outputSaveError, undefined);
		assert.match(recoveredResult.finalOutput ?? "", /^Output saved to:/);
	});

	it("aborts a foreground coordination tool start instead of detaching without a delivered handoff", async () => {
		mockPi.onCall({
			steps: [
				{ jsonl: [events.toolStart("contact_supervisor", { reason: "need_decision", message: "Need a decision" })] },
				{ delay: 10000, jsonl: [events.assistantMessage("after abort")] },
			],
		});
		const agents = makeAgentConfigs(["echo"]);
		const controller = new AbortController();
		let aborted = false;

		const result = await runSync(tempDir, agents, "echo", "Task", {
			runId: "contact-supervisor-abort-without-handoff",
			allowIntercomDetach: true,
			signal: controller.signal,
			onUpdate: (update) => {
				if (aborted) return;
				const progress = (update as { details?: { progress?: Array<{ currentTool?: string }> } }).details?.progress;
				if (!Array.isArray(progress) || !progress.some((p) => p?.currentTool === "contact_supervisor")) return;
				aborted = true;
				controller.abort();
			},
		});

		assert.equal(aborted, true);
		assert.notEqual(result.exitCode, -2);
		assert.equal(result.detached, undefined);
		assert.notEqual(result.progress?.status, "detached");
	});

	for (const testCase of [
		{ name: "intercom ask", toolName: "intercom", args: { action: "ask", to: "orchestrator" } },
		{ name: "contact_supervisor need_decision", toolName: "contact_supervisor", args: { reason: "need_decision", message: "Need a decision" } },
		{ name: "contact_supervisor interview_request", toolName: "contact_supervisor", args: { reason: "interview_request", message: "Need input", interview: { questions: [] } } },
	]) {
		it(`does not detach foreground children on blocking ${testCase.name} before a delivered handoff`, async () => {
			mockPi.onCall({
				steps: [
					{ jsonl: [events.toolStart(testCase.toolName, testCase.args)] },
					{ delay: 50, jsonl: [events.assistantMessage("received pong")] },
				],
			});
			const agents = makeAgentConfigs(["echo"]);

			const result = await runSync(tempDir, agents, "echo", "Task", {
				runId: `${testCase.toolName}-blocking-detach`,
				allowIntercomDetach: true,
			});

			assert.equal(result.exitCode, 0);
			assert.equal(result.detached, undefined);
			assert.equal(result.finalOutput, "received pong");
			assert.equal(result.progress?.status, "completed");
		});
	}

	for (const testCase of [
		{ name: "intercom send", toolName: "intercom", args: { action: "send", to: "orchestrator", message: "FYI" } },
		{ name: "contact_supervisor progress_update", toolName: "contact_supervisor", args: { reason: "progress_update", message: "FYI" } },
	]) {
		it(`does not proactively detach foreground children on non-blocking ${testCase.name}`, async () => {
			mockPi.onCall({
				steps: [
					{ jsonl: [events.toolStart(testCase.toolName, testCase.args)] },
					{ jsonl: [events.toolEnd(testCase.toolName)] },
					{ jsonl: [events.assistantMessage("done")] },
				],
			});
			const agents = makeAgentConfigs(["echo"]);

			const result = await runSync(tempDir, agents, "echo", "Task", {
				runId: `${testCase.toolName}-nonblocking`,
				allowIntercomDetach: true,
			});

			assert.equal(result.exitCode, 0);
			assert.equal(result.detached, undefined);
			assert.equal(result.finalOutput, "done");
			assert.equal(result.progress?.status, "completed");
		});
	}

	it("lets an active intercom child accept detach when another child is listening", async () => {
		const eventBus = createEventBus();
		let firstDetachResponse: boolean | undefined;
		eventBus.on(INTERCOM_DETACH_RESPONSE_EVENT, (payload) => {
			if (!payload || typeof payload !== "object") return;
			if ((payload as { requestId?: unknown }).requestId !== "parallel-request") return;
			firstDetachResponse ??= (payload as { accepted?: unknown }).accepted === true;
		});
		mockPi.onCall({ delay: 500, output: "quiet child done" });
		const agents = makeAgentConfigs(["quiet", "intercom"]);

		const quietRun = runSync(tempDir, agents, "quiet", "Quiet task", {
			runId: "quiet-listener",
			allowIntercomDetach: true,
			intercomEvents: eventBus,
		});
		for (let attempt = 0; attempt < 50 && mockPi.callCount() < 1; attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		assert.equal(mockPi.callCount(), 1);
		mockPi.onCall({
			steps: [
				{ jsonl: [events.toolStart("intercom", { action: "send", to: "orchestrator" })] },
				{ delay: 500, jsonl: [events.assistantMessage("after intercom")] },
			],
		});

		let detachEmitted = false;
		const intercomRun = runSync(tempDir, agents, "intercom", "Intercom task", {
			runId: "active-intercom",
			allowIntercomDetach: true,
			intercomEvents: eventBus,
			onUpdate: (update) => {
				if (detachEmitted) return;
				const progress = (update as { details?: { progress?: Array<{ currentTool?: string }> } }).details?.progress;
				const sawIntercom = Array.isArray(progress) && progress.some((p) => p?.currentTool === "intercom");
				if (!sawIntercom) return;
				detachEmitted = true;
				eventBus.emit(INTERCOM_DETACH_REQUEST_EVENT, { requestId: "parallel-request" });
			},
		});

		const [quietResult, intercomResult] = await Promise.all([quietRun, intercomRun]);

		assert.equal(quietResult.exitCode, 0);
		assert.equal(quietResult.detached, undefined);
		assert.equal(intercomResult.exitCode, -2);
		assert.equal(intercomResult.detached, true);
		assert.equal(firstDetachResponse, true);
	});

	it("handles stderr without exit code as info (not error)", async () => {
		mockPi.onCall({ output: "Success", stderr: "Warning: something", exitCode: 0 });
		const agents = makeAgentConfigs(["echo"]);

		const result = await runSync(tempDir, agents, "echo", "Task", {});

		assert.equal(result.exitCode, 0);
	});

});
