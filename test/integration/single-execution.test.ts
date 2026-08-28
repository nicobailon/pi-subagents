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
import { handleSubagentControlNotice } from "../../src/extension/control-notices.ts";
import { discoverAgents } from "../../src/agents/agents.ts";
import {
	SUBAGENT_DELEGATION_REQUEST_EVENT,
	SUBAGENT_DELEGATION_RESPONSE_EVENT,
	SUBAGENT_DELEGATION_STARTED_EVENT,
	type SubagentDelegationRequest,
	type SubagentDelegationResponse,
	type SubagentDelegationStarted,
} from "../../src/api/delegation.ts";
import { CHAIN_RUNS_DIR, DIRS, INTERCOM_DETACH_REQUEST_EVENT, INTERCOM_DETACH_RESPONSE_EVENT, SUBAGENT_CONTROL_EVENT, TEMP_ARTIFACTS_DIR, type AsyncStatus, type ControlEvent, type SubagentState } from "../../src/shared/types.ts";
import { ACTIVE_RUN_INDEX_DIR } from "../../src/runs/background/active-run-index.ts";
import { listAsyncRuns } from "../../src/runs/background/async-status.ts";
import { CHILD_WATCHDOG_STATUS_EVENT } from "../../src/watchdog/child-status.ts";
import { WAIT_TOOL_ENABLED_ENV } from "../../src/runs/background/wait-config.ts";
import { TOOL_BUDGET_ENV, TOOL_BUDGET_ZERO_AUTH_ENV } from "../../src/runs/shared/tool-budget.ts";
import { createRunFanoutBudget, encodeRunFanoutBudgetDescriptor, RUN_FANOUT_BUDGET_ENV } from "../../src/runs/shared/run-fanout-budget.ts";
import { MainWatchdogRuntime } from "../../src/watchdog/runtime.ts";
import { MAX_CHILD_PENDING_LINE_BYTES, MAX_CHILD_STDERR_BYTES } from "../../src/runs/shared/child-protocol.ts";
import {
	SUBAGENT_CHILD_ENV,
	SUBAGENT_FANOUT_CHILD_ENV,
	SUBAGENT_STEER_ACK_DIR_ENV,
	SUBAGENT_STEER_CAPABILITY_ENV,
	SUBAGENT_STEER_INBOX_ENV,
	SUBAGENT_PARENT_CHILD_INDEX_ENV,
	SUBAGENT_PARENT_CONTROL_INBOX_ENV,
	SUBAGENT_PARENT_DEPTH_ENV,
	SUBAGENT_PARENT_EVENT_SINK_ENV,
	SUBAGENT_PARENT_RUN_ID_ENV,
} from "../../src/runs/shared/pi-args.ts";
import { createNestedRoute, nestedRouteEnv, parseNestedEventRecords } from "../../src/runs/shared/nested-events.ts";
import { resolveMissionStoreLocation } from "../../src/missions/store.ts";
import { missionStatePath } from "../../src/missions/workflow-state.ts";
import { discardPreservedWorktrees } from "../../src/runs/shared/parallel-handoff.ts";
import { createWorktrees } from "../../src/runs/shared/worktree.ts";
import { resolveAsyncResumeTarget } from "../../src/runs/background/async-resume.ts";
import { clearExclusions } from "../../src/runs/shared/model-exclusions.ts";
import { createWorkflowChildPermit, workflowChildPermitConsumed } from "../../src/shared/workflow-child-permit.ts";
import { toSubagentDelegationExecutionParams } from "../../src/slash/delegation-adapters.ts";

interface ModelAttempt {
	success?: boolean;
	exitCode?: number;
	error?: string;
}

interface ProgressSummary {
	agent: string;
	index: number;
	status: string;
	task?: string;
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
	inputPath?: string;
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
	task?: string;
	messages: unknown[];
	error?: string;
	protocolError?: { code?: string; stream?: string; limitBytes?: number; observedBytes?: number };
	model?: string;
	skills?: string[];
	skillsWarning?: string;
	attemptedModels?: string[];
	modelAttempts?: ModelAttempt[];
	contextOverflow?: boolean;
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
	cwd?: string;
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

function pathContainsSegments(filePath: string, ...segments: string[]): boolean {
	return segments.every((segment) => filePath.split(path.sep).includes(segment));
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
	let agentDir: string;
	let mockPi: MockPi;
	let previousAgentDir: string | undefined;

	before(() => {
		mockPi = createMockPi();
		mockPi.install();
	});

	after(() => {
		mockPi.uninstall();
	});

	beforeEach(() => {
		tempDir = createTempDir();
		agentDir = createTempDir("pi-subagent-agent-");
		previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = agentDir;
		mockPi.reset();
		clearExclusions();
	});

	afterEach(() => {
		clearExclusions();
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		removeTempDir(agentDir);
		removeTempDir(tempDir);
	});

	function readCall(): { args: string[]; cwd?: string; systemPrompts: NonNullable<MockPiCallRecord["systemPrompts"]> } {
		const callFile = fs.readdirSync(mockPi.dir)
			.filter((name) => name.startsWith("call-") && name.endsWith(".json"))
			.sort()
			.at(-1);
		assert.ok(callFile, "expected a recorded mock pi call");
		const payload = JSON.parse(fs.readFileSync(path.join(mockPi.dir, callFile), "utf-8")) as MockPiCallRecord;
		assert.ok(Array.isArray(payload.args), "expected recorded args");
		return { args: payload.args, cwd: payload.cwd, systemPrompts: payload.systemPrompts ?? [] };
	}

	function readCallArgs(): string[] {
		return readCall().args;
	}

	function readAllCallArgs(): string[][] {
		return fs.readdirSync(mockPi.dir)
			.filter((name) => name.startsWith("call-") && name.endsWith(".json"))
			.sort()
			.map((name) => (JSON.parse(fs.readFileSync(path.join(mockPi.dir, name), "utf-8")) as MockPiCallRecord).args);
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
		discoverAgentsForCwd?: (cwd: string) => typeof agents,
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
			getSubagentSessionRoot: () => path.join(tempDir, ".pi/subagents", "sessions"),
			expandTilde: (value: string) => value,
			discoverAgents: (cwd: string) => ({ agents: discoverAgentsForCwd ? discoverAgentsForCwd(cwd) : agents }),
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

	it("derives a child session name and passes it to the child env", async () => {
		mockPi.onCall({ echoEnv: ["PI_SUBAGENT_SESSION_NAME"] });
		const agents = makeAgentConfigs(["echo"]);

		const result = await runSync(tempDir, agents, "echo", "Say hello to the world", {});

		assert.equal(result.exitCode, 0);
		assert.equal(result.sessionName, "echo: Say hello to the world");
		assert.equal(result.progressSummary?.sessionName, "echo: Say hello to the world");
		const echoed = JSON.parse(getFinalOutput(result.messages));
		assert.equal(echoed.PI_SUBAGENT_SESSION_NAME, "echo: Say hello to the world");
	});

	it("rejects invalid foreground cwd before spawning Pi", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const executor = makeExecutor([makeAgent("echo")]);
		const requestedCwd = "missing-local-cwd";
		const effectiveCwd = path.resolve(tempDir, requestedCwd);

		const missing = await executor.executePublic(
			"invalid-foreground-cwd",
			{ agent: "echo", task: "Do not spawn", async: false, cwd: requestedCwd },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		assert.equal(missing.isError, true);
		assert.match(missing.content[0]?.text ?? "", new RegExp(`cwd does not exist: ${effectiveCwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
		assert.match(missing.content[0]?.text ?? "", /resolved from "missing-local-cwd"/);

		const fileCwd = path.join(tempDir, "not-a-directory");
		fs.writeFileSync(fileCwd, "file");
		const notDirectory = await executor.executePublic(
			"invalid-foreground-file-cwd",
			{ agent: "echo", task: "Do not spawn", async: false, cwd: fileCwd },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		assert.equal(notDirectory.isError, true);
		assert.match(notDirectory.content[0]?.text ?? "", /cwd is not a directory/);
		assert.match(notDirectory.content[0]?.text ?? "", new RegExp(fileCwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
		assert.equal(mockPi.callCount(), 0);
	});

	it("rejects invalid async cwd before spawning the native runner", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const executor = makeExecutor([makeAgent("echo")]);
		const requestedCwd = "missing-async-cwd";
		const effectiveCwd = path.resolve(tempDir, requestedCwd);

		const result = await executor.executePublic(
			"invalid-async-cwd",
			{ agent: "echo", task: "Do not spawn", async: true, cwd: requestedCwd },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", new RegExp(`cwd does not exist: ${effectiveCwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
		assert.match(result.content[0]?.text ?? "", /resolved from "missing-async-cwd"/);
		assert.equal(mockPi.callCount(), 0);
	});

	it("runs public structured single-child requests directly", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "Structured child completed" });
		const executor = makeExecutor([makeAgent("echo")]);

		const result = await executor.executePublic(
			"structured-single",
			{ agent: "echo", task: "Run through workflow", async: false, context: "fresh" },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, undefined, result.content[0]?.text ?? "");
		assert.equal(result.details.mode, "single");
		assert.equal(mockPi.callCount(), 1);
		assert.doesNotMatch(result.content[0]?.text ?? "", /Console:/);
	});

	it("keeps public structured children alive when tool results backfill without execution_end", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({
			steps: [
				{ jsonl: [{ type: "tool_execution_start", toolCallId: "bash-1", toolName: "bash", args: { command: "echo PROBE_OK" } }] },
				{ delay: 25, jsonl: [
					{ type: "tool_result_end", message: { role: "toolResult", toolCallId: "bash-1", toolName: "bash", isError: false, content: [{ type: "text", text: "PROBE_OK" }] } },
					events.assistantMessage("PROBE_OK"),
				] },
			],
			keepAliveAfterFinalMessageMs: 400,
		});
		const executor = makeExecutor([makeAgent("bash-worker")]);

		const result = await executor.executePublic(
			"structured-single-tool-backfill",
			{ agent: "bash-worker", task: "Run exactly one tool: bash with command echo PROBE_OK.", async: false, toolTimeoutMs: 100, timeoutMs: 5_000 },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, undefined, result.content[0]?.text ?? "workflow failed");
		assert.match(result.content[0]?.text ?? "", /PROBE_OK/);
		assert.equal(result.details.results[0]?.timedOut, undefined);
	});

	it("keeps public structured single-child calls foreground when async is disabled by default", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "Structured child used the foreground default" });
		const executor = makeExecutor([makeAgent("echo")], {}, false);

		const result = await executor.executePublic(
			"structured-single-foreground-default",
			{ agent: "echo", task: "Run through workflow" },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, undefined, result.content[0]?.text ?? "");
		assert.match(result.content[0]?.text ?? "", /Structured child used the foreground default/);
		assert.equal(result.details.asyncId, undefined);
	});

	it("does not override structured single output unless configured by the agent", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		for (const params of [
			{ agent: "echo", task: "Use the task output path", async: false },
			{ agent: "echo", task: "Disable file output", output: false, async: false },
		] as const) {
			mockPi.onCall({ output: "Structured child completed" });
			const result = await makeExecutor([makeAgent("echo")]).executePublic(
				"structured-single-output",
				params,
				new AbortController().signal,
				undefined,
				makeMinimalCtx(tempDir),
			);

			assert.equal(result.isError, undefined, result.content[0]?.text ?? "workflow failed");
			assert.doesNotMatch(readCallArgs().join("\n"), /This path is authoritative for this run/);
		}

		mockPi.onCall({ output: "Agent report" });
		const configuredPath = path.join(tempDir, "agent-report.md");
		const configured = await makeExecutor([makeAgent("echo", { output: configuredPath })]).executePublic(
			"structured-single-agent-output",
			{ agent: "echo", task: "Use agent output", async: false },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(configured.isError, undefined, configured.content[0]?.text ?? "workflow failed");
		const configuredTask = readCallArgs().join("\n");
		assert.match(configuredTask, new RegExp(escapeRegExp(configuredPath)));
		assert.match(configuredTask, /This path is authoritative for this run/);
		assert.equal(fs.readFileSync(configuredPath, "utf-8"), "Agent report");
	});

	it("preserves agent output defaults for structured prompt-template delegation", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const configuredPath = path.join(tempDir, "delegated-agent-report.md");
		mockPi.onCall({
			stdoutRaw: [
				{ type: "tool_execution_start", toolName: "structured_output", args: { value: { ok: true } } },
				{ type: "tool_result_end", message: { role: "toolResult", toolName: "structured_output", content: [{ type: "text", text: "Structured output captured." }] } },
				{ type: "tool_execution_end", toolName: "structured_output" },
			].map((entry) => JSON.stringify(entry)).join("\n") + "\n",
			structuredOutputCapture: { ok: true },
		});
		const executor = makeExecutor([makeAgent("echo", { output: configuredPath, outputMode: "file-only" })]);
		const request: SubagentDelegationRequest = {
			requestId: "delegated-output-default",
			ownerRunId: "owner-1",
			nodeId: "node-1",
			agent: "echo",
			task: "Return structured data",
			context: "fresh",
			cwd: tempDir,
			model: "mock/model",
			result: { kind: "structured", schema: { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } } },
		};

		const result = await executor.executeDelegated(
			request.requestId,
			toSubagentDelegationExecutionParams(request),
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, undefined, result.content[0]?.text ?? "delegated execution failed");
		const child = result.details?.results?.[0];
		assert.equal(child?.savedOutputPath, configuredPath);
		assert.equal(child?.outputMode, "file-only");
		assert.deepEqual(child?.structuredOutput, { ok: true });
		assert.deepEqual(JSON.parse(fs.readFileSync(configuredPath, "utf-8")), { ok: true });
	});

	it("does not inject a workflow child output without an aggregate or explicit output", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "Workflow child completed" });
		const result = await makeExecutor([makeAgent("echo")]).execute(
			"workflow-omitted-output",
			{ async: false, workflowScript: `return runs.run("main", { agent: "echo", task: "Use the task output path" });` },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, undefined, result.content[0]?.text ?? "workflow failed");
		assert.doesNotMatch(readCallArgs().join("\n"), /This path is authoritative for this run/);
	});

	it("consumes one exact host-only workflow child permit before spawn", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const executor = makeExecutor([makeAgent("echo"), makeAgent("other"), makeAgent("external", { runner: { type: "external-cli", command: "external" } })]);
		const ctx = makeMinimalCtx(tempDir);
		const script = `return runs.run("main", { agent: "echo", task: "Exact task", acceptance: false });`;
		mockPi.onCall({ output: "projection probe" });
		const probe = await executor.execute("probe", { async: false, workflowScript: script }, new AbortController().signal, undefined, ctx);
		const launchContractDigest = (probe.details as { results?: Array<{ launchContractDigest?: string }> }).results?.[0]?.launchContractDigest;
		assert.ok(launchContractDigest);

		const permitFor = (workflowRunId: string, overrides: Partial<Parameters<typeof createWorkflowChildPermit>[0]> = {}) => createWorkflowChildPermit({
			issuerPackage: "permit-secret-package",
			workflowRunId,
			childKey: "main",
			agent: "echo",
			launchContractDigest,
			context: "fresh",
			...overrides,
		});
		const run = (id: string, workflowScript: string, permit: ReturnType<typeof permitFor>, async = false) => executor.executeDelegated(
			id,
			{ async, workflowScript, delegatedWorkflowPermit: permit },
			new AbortController().signal,
			undefined,
			ctx,
		);

		mockPi.onCall({ output: "permitted child" });
		const permit = permitFor("permitted");
		const allowed = await run("permitted", script, permit);
		assert.equal(allowed.isError, undefined, allowed.content[0]?.text ?? "permitted workflow failed");
		assert.equal(workflowChildPermitConsumed(permit), true);
		assert.equal(mockPi.callCount(), 2);
		assert.doesNotMatch(JSON.stringify(allowed), /permit-secret-package|__workflowChildPermit/);

		const reused = await run("permitted", script, permit);
		assert.equal(reused.isError, true);
		assert.match(reused.content[0]?.text ?? "", /already consumed/);
		assert.equal(mockPi.callCount(), 2);

		mockPi.onCall({ stderr: "spawned child failed", exitCode: 1 });
		const failedPermit = permitFor("spawn-failure");
		const spawnFailure = await run("spawn-failure", script, failedPermit);
		assert.equal(spawnFailure.isError, true);
		assert.equal(workflowChildPermitConsumed(failedPermit), true);
		assert.equal(mockPi.callCount(), 3, "a consumed permit must not start a retry");

		const denied = [
			await run("wrong-key", `return runs.run("other", { agent: "echo", task: "Exact task", acceptance: false });`, permitFor("wrong-key")),
			await run("wrong-agent", `return runs.run("main", { agent: "other", task: "Exact task", acceptance: false });`, permitFor("wrong-agent")),
			await run("wrong-task", `return runs.run("main", { agent: "echo", task: "Changed task", acceptance: false });`, permitFor("wrong-task")),
			await run("runs-all", `return runs.all([{ key: "main", agent: "echo", task: "Exact task", acceptance: false }]);`, permitFor("runs-all")),
			await run("resume", `return runs.run("main", { resume: "retained-run", task: "Continue" });`, permitFor("resume")),
			await run("external", `return runs.run("main", { agent: "external", task: "Exact task", async: false });`, permitFor("external")),
			await run("async-root", script, permitFor("async-root"), true),
		];
		const denialText = denied.map((result) => result.content[0]?.text ?? "").join("\n");
		assert.match(denialText, /child key mismatch.*agent mismatch.*final launch projection.*runs\.all.*retained resume.*native Pi children.*foreground workflow roots/s);
		const wrongThenRightPermit = permitFor("wrong-then-right");
		const wrongThenRight = await run("wrong-then-right", `
			try { await runs.run("other", { agent: "echo", task: "Exact task", acceptance: false }); } catch {}
			return runs.run("main", { agent: "echo", task: "Exact task", acceptance: false });
		`, wrongThenRightPermit);
		assert.equal(wrongThenRight.isError, true);
		assert.match(wrongThenRight.content[0]?.text ?? "", /already consumed/);
		assert.equal(workflowChildPermitConsumed(wrongThenRightPermit), true);
		assert.equal(mockPi.callCount(), 3, "wrong-then-right must not spawn");
		const fallback = await makeExecutor([makeAgent("echo", { model: "mock/primary", fallbackModels: ["mock/backup"] })]).executeDelegated(
			"fallback",
			{ async: false, workflowScript: script, delegatedWorkflowPermit: permitFor("fallback") },
			new AbortController().signal,
			undefined,
			ctx,
		);
		assert.match(fallback.content[0]?.text ?? "", /does not support model fallback/);
		assert.equal(mockPi.callCount(), 3);
	});

	it("resolves workflow child profile context from its agent default", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "Workflow child completed" });
		const result = await makeExecutor([makeAgent("echo", { defaultContext: "fresh" })], { defaultSubagentContext: "fork" }).execute(
			"workflow-profile-context",
			{ async: false, workflowScript: `return runs.run("main", { agent: "echo", task: "Use profile context", context: "profile" });` },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, undefined, result.content[0]?.text ?? "workflow failed");
		assert.equal(result.details?.results?.[0]?.context, "fresh");
	});

	it("reports a user-requested foreground detach without supervisor guidance", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ steps: [{ delay: 500, jsonl: [events.assistantMessage("completed after user detach")] }] });
		const state: SubagentState = {
			baseCwd: tempDir,
			currentSessionId: null,
			asyncJobs: new Map(),
			foregroundControls: new Map(),
			lastForegroundControlId: null,
		};
		const executor = createSubagentExecutor!({
			pi: { events: createEventBus(), getSessionName: () => undefined },
			state,
			config: {},
			asyncByDefault: false,
			tempArtifactsDir: tempDir,
			getSubagentSessionRoot: () => path.join(tempDir, ".pi/subagents", "sessions"),
			expandTilde: (value: string) => value,
			discoverAgents: () => ({ agents: [makeAgent("echo")] }),
			allowMutatingManagementActions: true,
		});

		const pending = executor.execute(
			"user-detach-guidance",
			{ agent: "echo", task: "Keep working", async: false },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		let control = state.lastForegroundControlId ? state.foregroundControls.get(state.lastForegroundControlId) : undefined;
		for (let attempt = 0; attempt < 100 && !control?.detach; attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 10));
			control = state.lastForegroundControlId ? state.foregroundControls.get(state.lastForegroundControlId) : undefined;
		}
		assert.ok(control?.detach, "foreground detach control should become available");
		assert.equal(control.detach(), true);

		const result = await pending;
		const text = result.content.map((part) => part.type === "text" ? part.text : "").join("\n");
		assert.equal(result.details.results[0]?.detachedReason, "user request");
		assert.match(text, /Detached at user request/);
		assert.match(text, /subagent_wait\(\{ id: "[^"]+", nonBlocking: true \}\)/);
		assert.doesNotMatch(text, /intercom coordination|supervisor request|Wait with subagent_wait/);
		assert.doesNotMatch(text, /subagent_wait\(\{ id: "[^"]+" \}\)/);

		let terminalChild = state.foregroundRuns?.get(control.runId)?.children[0];
		for (let attempt = 0; attempt < 250 && terminalChild?.status !== "completed"; attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 20));
			terminalChild = state.foregroundRuns?.get(control.runId)?.children[0];
		}
		assert.equal(terminalChild?.status, "completed", "detached child should reach its terminal callback before teardown");
		assert.equal(terminalChild.finalOutput, "completed after user detach");
	});

	it("rejects action='single' with execution fields", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const executor = makeExecutor([makeAgent("echo")]);
		const result = await executor.executePublic("single-alias", { action: "single", agent: "echo", task: "work" }, new AbortController().signal, undefined, makeMinimalCtx(tempDir));
		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /action='single' is not supported/);
	});

	it("rejects internal fan-out fields from public workflows", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const executor = makeExecutor([makeAgent("echo")]);
		for (const params of [
			{ workflowScript: `return runs.run("main", { agent: "echo", task: "work" })`, runFanoutBudget: { version: 1 } },
			{ workflowScript: `return runs.run("main", { agent: "echo", task: "work" })`, runFanoutAdmitted: true },
		] as const) {
			const result = await executor.executePublic("private-fanout", params, new AbortController().signal, undefined, makeMinimalCtx(tempDir));
			assert.equal(result.isError, true);
			assert.match(result.content[0]?.text ?? "", /does not accept internal run fan-out fields/);
		}
		assert.equal(mockPi.callCount(), 0);
	});

	it("runs isolation none outside Git and keeps worktree isolation strict", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		assert.equal(fs.existsSync(path.join(tempDir, ".git")), false);
		mockPi.onCall({ output: "shared cwd" });
		const executor = makeExecutor([makeAgent("echo")]);
		const script = `return runs.run("main", { agent: "echo", task: "work" })`;

		const shared = await executor.executePublic(
			"isolation-none",
			{ async: false, isolation: "none", workflowScript: script },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		assert.equal(shared.isError, undefined, shared.content[0]?.text ?? "shared workflow failed");

		const isolated = await executor.executePublic(
			"isolation-worktree",
			{ async: false, isolation: "worktree", workflowScript: script },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		assert.equal(isolated.isError, true);
		assert.match(isolated.content[0]?.text ?? "", /worktree isolation requires a git repository/i);
		assert.equal(mockPi.callCount(), 1);
	});

	it("allows schedule.create to load its workflowScript target from a path", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		let forwarded;
		const executor = makeExecutor([makeAgent("echo")], {}, false, undefined, true, new Map(), undefined, async (params) => {
			forwarded = params;
			return { content: [{ type: "text", text: "created" }], details: { mode: "management", results: [] } };
		});
		fs.writeFileSync(path.join(tempDir, "scheduled.js"), "return runs.run('main', { agent: 'echo' })");

		const result = await executor.executePublic(
			"schedule-create",
			{ action: "schedule.create", id: "nightly", every: "1h", workflowScriptPath: "scheduled.js" },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, undefined);
		assert.equal(result.content[0]?.text, "created");
		assert.equal(forwarded?.workflowScript, "return runs.run('main', { agent: 'echo' })");
	});

	it("validates workflow scripts without launching children or creating artifacts", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const before = fs.readdirSync(tempDir).sort();
		const executor = makeExecutor([makeAgent("echo")], {}, false, undefined, true, new Map(), undefined, undefined, createEventBus(), () => {
			throw new Error("validate must not discover or launch agents");
		});

		const result = await executor.executePublic(
			"offline-validation",
			{ action: "validate", workflowScript: `return runs.run("bad key", { agent: "echo" });` },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, true);
		assert.deepEqual(JSON.parse(result.content[0]?.text ?? "null"), {
			ok: false,
			errors: [{ message: "runs.run key must be 1-128 characters using letters, numbers, '.', '_' or '-', and start with a letter or number.", line: 1, column: 17 }],
		});
		const invalidPreflight = await executor.executePublic(
			"invalid-preflight",
			{ workflowScript: `return runs.run("child", { agent: "echo" });`, preflight: { version: 1, lanes: [{ key: "bad key" }] } },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		assert.equal(invalidPreflight.isError, true);
		assert.match(invalidPreflight.content[0]?.text ?? "", /preflight\.lanes\[0\]\.key/);
		const offlinePreflight = await executor.executePublic(
			"offline-preflight",
			{ action: "validate", workflowScript: "return 1;", preflight: { version: 1, lanes: [{ key: "bad key" }] } },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		assert.equal(offlinePreflight.isError, true);
		const offlinePreflightValidation = JSON.parse(offlinePreflight.content[0]?.text ?? "null") as { ok?: boolean; errors?: unknown[] };
		assert.equal(offlinePreflightValidation.ok, false);
		assert.match(JSON.stringify(offlinePreflightValidation.errors ?? []), /preflight\.lanes\[0\]\.key/);
		assert.equal(mockPi.callCount(), 0);
		assert.deepEqual(fs.readdirSync(tempDir).sort(), before);
	});

	it("runs a workflow host command without launching a child", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const scriptPath = path.join(tempDir, "host-command.cjs");
		fs.writeFileSync(scriptPath, `process.stdout.write("host command passed\\n");`);
		const executor = makeExecutor([makeAgent("echo")]);
		const result = await executor.executePublic(
			"host-command",
			{
				async: false,
				output: "reports/host-command.log",
				workflowScript: `return await runs.host("tests", { kind: "command", command: ${JSON.stringify(`${JSON.stringify(process.execPath)} ${JSON.stringify(scriptPath)}`)}, timeoutMs: 5000, output: "reports/host-command.log", role: "ci", provider: "local" });`,
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, undefined, result.content[0]?.text ?? "host command workflow failed");
		assert.equal(mockPi.callCount(), 0);
		const savedOutput = fs.readFileSync(path.join(tempDir, "reports", "host-command.log"), "utf8");
		assert.match(savedOutput, /host command passed/);
		assert.doesNotMatch(savedOutput, /Workflow completed/);
		assert.deepEqual(result.details.workflow?.receipt?.hostSteps?.map(({ monitorKind, state, reportPath, exitCode }) => ({ monitorKind, state, reportPath, exitCode })), [{ monitorKind: "command", state: "done", reportPath: "reports/host-command.log", exitCode: 0 }]);

		const failedScriptPath = path.join(tempDir, "host-command-failed.cjs");
		fs.writeFileSync(failedScriptPath, `process.stderr.write("host command failed\\n"); process.exit(4);`);
		const failed = await executor.executePublic(
			"host-command-failed",
			{
				async: false,
				workflowScript: `return await runs.host("tests", { kind: "command", command: ${JSON.stringify(`${JSON.stringify(process.execPath)} ${JSON.stringify(failedScriptPath)}`)}, timeoutMs: 5000, output: "reports/host-command-failed.log" });`,
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		assert.equal(failed.isError, true);
		assert.deepEqual(failed.details.workflow?.receipt?.hostSteps?.map(({ state, reasonCode, exitCode }) => ({ state, reasonCode, exitCode })), [{ state: "error", reasonCode: "command_failed", exitCode: 4 }]);
	});

	it("rejects a child output claimed by an earlier host command", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const scriptPath = path.join(tempDir, "host-output-owner.cjs");
		fs.writeFileSync(scriptPath, `process.stdout.write("host owns output\\n");`);
		const sharedOutput = path.join(tempDir, "reports", "shared.log");
		const executor = makeExecutor([makeAgent("echo")]);
		const result = await executor.executePublic(
			"host-output-collision",
			{
				async: false,
				workflowScript: `await runs.host("tests", { kind: "command", command: ${JSON.stringify(`${JSON.stringify(process.execPath)} ${JSON.stringify(scriptPath)}`)}, timeoutMs: 5000, output: "reports/shared.log" }); return runs.run("child", { agent: "echo", task: "unused", output: ${JSON.stringify(sharedOutput)} });`,
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.match(result.content[0]?.text ?? "", /output path is already claimed|resolve output to the same path/);
		assert.equal(mockPi.callCount(), 0);
	});

	it("rejects host and child output aliases through symlinks", { skip: !createSubagentExecutor || process.platform === "win32" ? "symlink output aliases are not portable on Windows CI" : undefined }, async () => {
		const scriptPath = path.join(tempDir, "host-output-alias-owner.cjs");
		const reportsDir = path.join(tempDir, "reports");
		fs.mkdirSync(reportsDir);
		fs.symlinkSync(reportsDir, path.join(tempDir, "linked-reports"), "dir");
		fs.writeFileSync(scriptPath, `process.stdout.write("host owns output alias\\n");`);
		const executor = makeExecutor([makeAgent("echo")]);
		const result = await executor.executePublic(
			"host-output-alias-collision",
			{
				async: false,
				workflowScript: `await runs.host("tests", { kind: "command", command: ${JSON.stringify(`${JSON.stringify(process.execPath)} ${JSON.stringify(scriptPath)}`)}, timeoutMs: 5000, output: "linked-reports/shared.log" }); return runs.run("child", { agent: "echo", task: "unused", output: ${JSON.stringify(path.join(reportsDir, "shared.log"))} });`,
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.match(result.content[0]?.text ?? "", /output path is already claimed|resolve output to the same path/);
		assert.equal(mockPi.callCount(), 0);
	});

	it("rejects host output aliases created after claim registration", { skip: !createSubagentExecutor || process.platform === "win32" ? "symlink output aliases are not portable on Windows CI" : undefined }, async () => {
		const reportsDir = path.join(tempDir, "reports");
		fs.mkdirSync(reportsDir);
		const firstScriptPath = path.join(tempDir, "host-output-first.cjs");
		const aliasScriptPath = path.join(tempDir, "host-output-alias.cjs");
		fs.writeFileSync(firstScriptPath, `process.stdout.write("first evidence\\n");`);
		fs.writeFileSync(aliasScriptPath, `const fs = require("node:fs"); fs.rmSync(${JSON.stringify(path.join(tempDir, "late-link"))}, { recursive: true, force: true }); fs.symlinkSync(${JSON.stringify(reportsDir)}, ${JSON.stringify(path.join(tempDir, "late-link"))}, "dir"); process.stdout.write("second evidence\\n");`);
		const result = await makeExecutor([makeAgent("echo")]).executePublic(
			"host-output-late-alias-collision",
			{
				async: false,
				workflowScript: `await runs.host("first", { kind: "command", command: ${JSON.stringify(`${JSON.stringify(process.execPath)} ${JSON.stringify(firstScriptPath)}`)}, timeoutMs: 5000, output: "reports/shared.log" }); return await runs.host("second", { kind: "command", command: ${JSON.stringify(`${JSON.stringify(process.execPath)} ${JSON.stringify(aliasScriptPath)}`)}, timeoutMs: 5000, output: "late-link/shared.log" });`,
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /output path changed after it was claimed/);
		assert.match(fs.readFileSync(path.join(reportsDir, "shared.log"), "utf-8"), /first evidence/);
	});

	it("rejects child output aliases created after claim registration", { skip: !createSubagentExecutor || process.platform === "win32" ? "symlink output aliases are not portable on Windows CI" : undefined }, async () => {
		const reportsDir = path.join(tempDir, "reports");
		fs.mkdirSync(reportsDir);
		const sharedOutput = path.join(reportsDir, "shared.log");
		fs.writeFileSync(sharedOutput, "prior output\n", "utf-8");
		const lateLink = path.join(tempDir, "late-link");
		const claimedOutput = path.join(lateLink, "shared.log");
		const releasePath = path.join(tempDir, "release-child-output");
		mockPi.onCall({ waitForPath: releasePath, output: "child fallback output" });

		const pending = makeExecutor([makeAgent("echo")]).executePublic(
			"child-output-late-alias-collision",
			{
				async: false,
				workflowScript: `return await runs.run("child", { agent: "echo", task: "unused", output: ${JSON.stringify(claimedOutput)} });`,
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		for (let attempt = 0; attempt < 100 && mockPi.callCount() === 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 20));
		if (mockPi.callCount() !== 1) {
			fs.writeFileSync(releasePath, "go", "utf-8");
			await pending.catch(() => undefined);
		}
		assert.equal(mockPi.callCount(), 1);
		fs.symlinkSync(reportsDir, lateLink, "dir");
		fs.writeFileSync(releasePath, "go", "utf-8");

		const result = await pending;
		const child = (result.details as { results?: Array<{ exitCode?: number; outputSaveError?: string; savedOutputPath?: string }> } | undefined)?.results?.[0];
		assert.equal(child?.exitCode, 1);
		assert.match(child?.outputSaveError ?? "", /Output path changed after it was claimed/);
		assert.equal(child?.savedOutputPath, undefined);
		assert.equal(fs.readFileSync(sharedOutput, "utf-8"), "prior output\n");
	});

	it("persists async host command status and receipt evidence", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const scriptPath = path.join(tempDir, "async-host-command.cjs");
		fs.writeFileSync(scriptPath, `process.stdout.write("async host passed\\n");`);
		const executor = makeExecutor([makeAgent("echo")]);
		const result = await executor.execute(
			"async-host-command",
			{
				async: true,
				mission: false,
				workflowScript: `return await runs.host("tests", { kind: "command", command: ${JSON.stringify(`${JSON.stringify(process.execPath)} ${JSON.stringify(scriptPath)}`)}, timeoutMs: 5000, output: "reports/async-host.log", role: "ci", provider: "local" });`,
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		assert.ok(result.details.asyncDir);
		const statusPath = path.join(result.details.asyncDir!, "status.json");
		let status: { state?: string; workflowGraph?: { nodes?: Array<{ hostStep?: { monitorKind?: string; state?: string; role?: string; reportPath?: string; exitCode?: number | null; updatedAt?: number; deadlineAt?: number } }> } } = {};
		for (let attempt = 0; attempt < 100; attempt++) {
			status = JSON.parse(fs.readFileSync(statusPath, "utf8"));
			if (status.state === "complete" || status.state === "failed") break;
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		assert.equal(status.state, "complete");
		assert.deepEqual(status.workflowGraph?.nodes?.[0]?.hostStep, {
			version: 1, kind: "host-step", monitorKind: "command", id: "tests", label: "tests", role: "ci", provider: "local", state: "done", verdict: "pass", detail: "async host passed", reportPath: "reports/async-host.log", exitCode: 0,
			updatedAt: status.workflowGraph?.nodes?.[0]?.hostStep?.updatedAt,
			deadlineAt: status.workflowGraph?.nodes?.[0]?.hostStep?.deadlineAt,
		});
		const receipt = JSON.parse(fs.readFileSync(path.join(result.details.asyncDir!, "workflow-receipt.json"), "utf8")) as { hostSteps?: Array<{ monitorKind?: string; state?: string; reportPath?: string }> };
		assert.deepEqual(receipt.hostSteps?.map(({ monitorKind, state, reportPath }) => ({ monitorKind, state, reportPath })), [{ monitorKind: "command", state: "done", reportPath: "reports/async-host.log" }]);
		assert.match(fs.readFileSync(path.join(tempDir, "reports", "async-host.log"), "utf8"), /async host passed/);
		fs.rmSync(result.details.asyncDir!, { recursive: true, force: true });
		if (result.details.asyncId) fs.rmSync(path.join(DIRS.results, `${result.details.asyncId}.json`), { force: true });

		const failedScript = path.join(tempDir, "async-host-command-failed.cjs");
		fs.writeFileSync(failedScript, `process.stderr.write("async host failed\\n"); process.exit(3);`);
		const failed = await executor.execute(
			"async-host-command-failed",
			{
				async: true,
				mission: false,
				workflowScript: `return await runs.host("tests", { kind: "command", command: ${JSON.stringify(`${JSON.stringify(process.execPath)} ${JSON.stringify(failedScript)}`)}, timeoutMs: 5000, output: "reports/async-host-failed.log" });`,
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		assert.ok(failed.details.asyncDir);
		const failedStatusPath = path.join(failed.details.asyncDir!, "status.json");
		let failedStatus: { state?: string; workflowGraph?: { nodes?: Array<{ hostStep?: { state?: string; reasonCode?: string; exitCode?: number | null } }> } } = {};
		for (let attempt = 0; attempt < 100; attempt += 1) {
			failedStatus = JSON.parse(fs.readFileSync(failedStatusPath, "utf8"));
			if (failedStatus.state === "complete" || failedStatus.state === "failed") break;
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		assert.equal(failedStatus.state, "failed");
		assert.deepEqual(failedStatus.workflowGraph?.nodes?.map((node) => node.hostStep && { state: node.hostStep.state, reasonCode: node.hostStep.reasonCode, exitCode: node.hostStep.exitCode }), [{ state: "error", reasonCode: "command_failed", exitCode: 3 }]);
		const failedReceipt = JSON.parse(fs.readFileSync(path.join(failed.details.asyncDir!, "workflow-receipt.json"), "utf8")) as { state?: string; hostSteps?: Array<{ state?: string; reasonCode?: string; exitCode?: number | null }> };
		assert.equal(failedReceipt.state, "failed");
		assert.deepEqual(failedReceipt.hostSteps?.map(({ state, reasonCode, exitCode }) => ({ state, reasonCode, exitCode })), [{ state: "error", reasonCode: "command_failed", exitCode: 3 }]);
		assert.match(fs.readFileSync(path.join(tempDir, "reports", "async-host-failed.log"), "utf8"), /async host failed/);
		fs.rmSync(failed.details.asyncDir!, { recursive: true, force: true });
		if (failed.details.asyncId) fs.rmSync(path.join(DIRS.results, `${failed.details.asyncId}.json`), { force: true });
	});

	it("loads workflowScriptPath from the request cwd for validation without launching", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const requestCwd = path.join(tempDir, "request-cwd");
		fs.mkdirSync(requestCwd);
		fs.writeFileSync(path.join(requestCwd, "workflow.js"), `return runs.run("bad key", { agent: "echo" });`);
		const executor = makeExecutor([makeAgent("echo")], {}, false, undefined, true, new Map(), undefined, undefined, createEventBus(), () => {
			throw new Error("validate must not discover or launch agents");
		});

		const result = await executor.executePublic(
			"file-validation",
			{ action: "validate", cwd: "request-cwd", workflowScriptPath: "workflow.js" },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, true);
		assert.deepEqual(JSON.parse(result.content[0]?.text ?? "null"), {
			ok: false,
			errors: [{ message: "runs.run key must be 1-128 characters using letters, numbers, '.', '_' or '-', and start with a letter or number.", line: 1, column: 17 }],
		});
		assert.equal(mockPi.callCount(), 0);
	});

	it("reports missing and empty workflowScriptPath files before validation", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		fs.writeFileSync(path.join(tempDir, "empty.js"), " \n");
		const executor = makeExecutor([makeAgent("echo")], {}, false, undefined, true, new Map(), undefined, undefined, createEventBus(), () => {
			throw new Error("file input errors must not discover or launch agents");
		});

		const missing = await executor.executePublic("missing-file", { action: "validate", workflowScriptPath: "missing.js" }, new AbortController().signal, undefined, makeMinimalCtx(tempDir));
		assert.equal(missing.isError, true);
		assert.match(missing.content[0]?.text ?? "", /Failed to read workflowScriptPath.*missing\.js/);
		assert.doesNotMatch(missing.content[0]?.text ?? "", /validation failed|valid JavaScript/);

		const empty = await executor.executePublic("empty-file", { action: "validate", workflowScriptPath: "empty.js" }, new AbortController().signal, undefined, makeMinimalCtx(tempDir));
		assert.equal(empty.isError, true);
		assert.match(empty.content[0]?.text ?? "", /workflowScriptPath file .*empty\.js.* is empty/);
		assert.doesNotMatch(empty.content[0]?.text ?? "", /validation failed|valid JavaScript/);
		assert.equal(mockPi.callCount(), 0);
	});

	it("executes a workflow loaded from workflowScriptPath", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		fs.writeFileSync(path.join(tempDir, "workflow.js"), `return runs.run("main", { agent: "echo", task: "from file" });`);
		mockPi.onCall({ output: "loaded workflow" });
		const executor = makeExecutor([makeAgent("echo")]);

		const result = await executor.executePublic(
			"file-execution",
			{ async: false, workflowScriptPath: path.join(tempDir, "workflow.js"), preflight: { version: 1, coverage: "complete", lanes: [{ key: "main", mode: "mutation" }] } },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, undefined, result.content[0]?.text ?? "file workflow failed");
		assert.deepEqual(result.details.preflight, { version: 1, coverage: "complete", lanes: [{ key: "main", mode: "mutation" }] });
		assert.equal(mockPi.callCount(), 1);
	});

	it("starts workflow scripts asynchronously with a portable internal run id", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ echoEnv: [SUBAGENT_STEER_INBOX_ENV, SUBAGENT_STEER_CAPABILITY_ENV, SUBAGENT_STEER_ACK_DIR_ENV] });
		const asyncJobs: SubagentState["asyncJobs"] = new Map();
		const executor = makeExecutor([makeAgent("echo", { aliases: ["helper"] })], { missions: { globalIndex: false } }, false, undefined, true, asyncJobs);
		const workflowCwd = path.join(tempDir, "workflow-cwd");
		fs.mkdirSync(workflowCwd);
		const toolCallId = "call_demo|fc_demo";
		const context = makeMinimalCtx(tempDir);
		context.sessionManager.getSessionFile = () => path.join(tempDir, "parent-session.jsonl");

		const result = await executor.execute(
			toolCallId,
			{
				cwd: workflowCwd,
				workflowScript: `emit("starting"); await runs.run("work", { agent: "helper", label: "Run async child", phase: "Execution", task: "Async work" }); return { answer: 42 };`,
				preflight: { version: 1, coverage: "complete", lanes: [{ key: "work", mode: "mutation", claims: ["src/work.ts"], expectedOutput: "child report" }] },
				mission: { summary: "Review the active backlog", labels: ["github-backlog", "review"] },
			},
			new AbortController().signal,
			undefined,
			context,
		);

		assert.equal(result.isError, undefined);
		assert.equal(result.details.mode, "workflow");
		assert.equal(result.details.toolCallId, toolCallId);
		assert.ok(result.details.asyncId);
		const workflowRunId = result.details.asyncId;
		assert.equal(result.details.runId, workflowRunId);
		assert.deepEqual(result.details.preflight, { version: 1, coverage: "complete", lanes: [{ key: "work", mode: "mutation", claims: ["src/work.ts"], expectedOutput: "child report" }] });
		assert.notEqual(workflowRunId, toolCallId);
		assert.match(workflowRunId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
		assert.equal(path.basename(result.details.asyncDir!), workflowRunId);
		assert.equal(asyncJobs.has(workflowRunId), true);
		assert.equal(asyncJobs.get(workflowRunId)?.cwd, workflowCwd);
		assert.equal(asyncJobs.get(workflowRunId)?.sessionRoot, path.join(tempDir, ".pi/subagents", "sessions"));
		assert.deepEqual(asyncJobs.get(workflowRunId)?.preflight, { version: 1, coverage: "complete", lanes: [{ key: "work", mode: "mutation", claims: ["src/work.ts"], expectedOutput: "child report" }] });
		assert.equal(asyncJobs.has(toolCallId), false);
		assert.equal(fs.existsSync(path.join(DIRS.async, toolCallId)), false);
		assert.match(result.content[0]?.text ?? "", /Preflight: v1 · complete · 1 lane/);
		assert.match(result.content[0]?.text ?? "", /Async workflow/);
		const statusPath = path.join(result.details.asyncDir!, "status.json");
		let status: { runId?: string; toolCallId?: string; cwd?: string; sessionRoot?: string; state?: string; preflight?: unknown; steps?: Array<{ agent?: string; sessionName?: string; label?: string; phase?: string; workflowKey?: string; parentWorkflowRunId?: string }>; workflow?: { value?: unknown; emits?: unknown[]; trace?: Array<{ key?: string; agent?: string; label?: string; phase?: string; state?: string }> } } = {};
		for (let attempt = 0; attempt < 100; attempt++) {
			status = JSON.parse(fs.readFileSync(statusPath, "utf-8"));
			if (status.state === "complete" || status.state === "failed") break;
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		assert.equal(status.state, "complete");
		assert.equal(status.runId, workflowRunId);
		assert.equal(status.toolCallId, toolCallId);
		assert.equal(status.cwd, workflowCwd);
		assert.equal(status.sessionRoot, path.join(tempDir, ".pi/subagents", "sessions"));
		assert.deepEqual(status.preflight, { version: 1, coverage: "complete", lanes: [{ key: "work", mode: "mutation", claims: ["src/work.ts"], expectedOutput: "child report" }] });
		const statusResult = await executor.execute(
			"status-preflight",
			{ action: "status", id: workflowRunId },
			new AbortController().signal,
			undefined,
			context,
		);
		assert.match(statusResult.content[0]?.text ?? "", /Preflight: v1 · complete · 1 lane/);
		assert.match(statusResult.content[0]?.text ?? "", /work \| mutation \|/);
		assert.equal(status.steps?.length, 1);
		assert.deepEqual(status.steps?.map(({ agent, sessionName, label, phase, workflowKey }) => ({ agent, sessionName, label, phase, workflowKey })), [
			{ agent: "echo", sessionName: "echo: Async work", label: "Run async child", phase: "Execution", workflowKey: "work" },
		]);
		assert.ok(status.steps?.every((step) => step.parentWorkflowRunId === workflowRunId));
		assert.deepEqual(status.workflow?.value, { answer: 42 });
		assert.deepEqual(status.workflow?.emits, ["starting"]);
		assert.equal(mockPi.callCount(), 1);
		assert.ok(status.workflow?.trace?.some((entry) => entry.key === "work" && entry.agent === "echo" && entry.label === "Run async child" && entry.phase === "Execution" && entry.state === "completed"));
		const traceEvents = fs.readFileSync(path.join(result.details.asyncDir!, "events.jsonl"), "utf-8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { type?: string; trace?: Array<{ key?: string; state?: string }> })
			.filter((event) => event.type === "subagent.workflow.trace");
		assert.equal(traceEvents.length, 2);
		assert.deepEqual(traceEvents[0]?.trace?.map(({ key, state }) => ({ key, state })), [{ key: "work", state: "started" }]);
		assert.deepEqual(traceEvents[1]?.trace?.map(({ key, state }) => ({ key, state })), [
			{ key: "work", state: "started" },
			{ key: "work", state: "completed" },
		]);
		const resultPath = path.join(DIRS.results, `${workflowRunId}.json`);
		const persistedResult = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as { id?: string; runId?: string; toolCallId?: string; agent?: string; cwd?: string; summary?: string; workflow?: { value?: unknown; receipt?: unknown }; workflowReceipt?: { path?: string; receipt?: { workflowRunId?: string; entries?: Record<string, { key?: string; agent?: string; latestRunId?: string; resumability?: { state?: string; reason?: string }; continuation?: { runIds?: string[] } }> } }; results?: Array<{ agent?: string; sessionName?: string; workflowKey?: string; runId?: string; output?: string; usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; turns: number } }> };
		assert.equal(persistedResult.id, workflowRunId);
		assert.equal(persistedResult.runId, workflowRunId);
		assert.equal(persistedResult.toolCallId, toolCallId);
		assert.equal(persistedResult.agent, "workflow");
		assert.equal(persistedResult.cwd, workflowCwd);
		assert.deepEqual(persistedResult.results?.map(({ agent, sessionName, workflowKey }) => ({ agent, sessionName, workflowKey })), [
			{ agent: "echo", sessionName: "echo: Async work", workflowKey: "work" },
		]);
		assert.deepEqual(persistedResult.results?.[0]?.usage, { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0.001, turns: 1 });
		const steeringEnv = JSON.parse(persistedResult.results?.[0]?.output ?? "null") as Record<string, string | null>;
		assert.match(steeringEnv[SUBAGENT_STEER_INBOX_ENV] ?? "", /control[/\\]workflow-foreground[/\\].+[/\\]control[/\\]steer-targets[/\\]0$/);
		assert.match(steeringEnv[SUBAGENT_STEER_CAPABILITY_ENV] ?? "", /control[/\\]workflow-foreground[/\\].+[/\\]control[/\\]steer-capabilities[/\\]0\.json$/);
		assert.match(steeringEnv[SUBAGENT_STEER_ACK_DIR_ENV] ?? "", /control[/\\]workflow-foreground[/\\].+[/\\]control[/\\]steer-acks[/\\]0$/);
		assert.equal(fs.existsSync(path.join(result.details.asyncDir!, "control", "workflow-foreground", persistedResult.results?.[0]?.runId ?? "missing")), false);
		assert.match(persistedResult.summary ?? "", /Return: \{\n  "answer": 42\n\}/);
		assert.deepEqual(persistedResult.workflow?.value, { answer: 42 });
		assert.equal(persistedResult.workflow?.receipt, undefined, "status/result workflow projection must stay receipt-free");
		assert.equal(persistedResult.workflowReceipt?.path, path.join(result.details.asyncDir!, "workflow-receipt.json"));
		assert.equal(persistedResult.workflowReceipt?.receipt?.workflowRunId, workflowRunId);
		assert.equal(persistedResult.workflowReceipt?.receipt?.entries?.work?.key, "work");
		assert.equal(persistedResult.workflowReceipt?.receipt?.entries?.work?.agent, "echo");
		assert.equal(persistedResult.workflowReceipt?.receipt?.entries?.work?.latestRunId, persistedResult.results?.[0]?.runId);
		assert.equal(fs.existsSync(path.join(DIRS.async, persistedResult.results?.[0]?.runId ?? "missing")), false);
		assert.deepEqual(persistedResult.workflowReceipt?.receipt?.entries?.work?.continuation?.runIds, [persistedResult.results?.[0]?.runId]);
		assert.deepEqual(persistedResult.workflowReceipt?.receipt?.entries?.work?.resumability, { state: "resumable" });
		assert.deepEqual(JSON.parse(fs.readFileSync(persistedResult.workflowReceipt!.path!, "utf-8")), persistedResult.workflowReceipt?.receipt);
		assert.equal(fs.existsSync(path.join(DIRS.results, `${toolCallId}.json`)), false);
		fs.rmSync(result.details.asyncDir!, { recursive: true, force: true });
		fs.rmSync(resultPath, { force: true });
	});

	it("keeps script workflow phase during async auto-resume", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({
			jsonl: [
				events.toolStart("read", { path: "src/index.ts" }),
				events.toolEnd("read"),
				events.toolResult("read", "file contents"),
				{
					type: "message_end",
					message: {
						role: "assistant",
						content: [],
						model: "openai-codex/gpt-5.6-luna",
						stopReason: "error",
						errorMessage: "This operation was aborted",
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
					},
				},
			],
			exitCode: 1,
		});
		const releasePath = path.join(tempDir, "release-auto-resume-child");
		mockPi.onCall({ waitForPath: releasePath, output: "Recovered after workflow auto-resume" });
		const executor = makeExecutor([makeAgent("echo", { aliases: ["helper"] })]);
		const result = await executor.execute(
			"workflow-auto-resume-phase-status",
			{ workflowScript: `await runs.run("work", { agent: "helper", label: "Review current diff", phase: "Review", task: "Review the current diff" }); return { ok: true };` },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, undefined, result.content[0]?.text ?? "workflow failed");
		const statusPath = path.join(result.details.asyncDir!, "status.json");
		let status: { state?: string; steps?: Array<{ workflowKey?: string; phase?: string }> } = {};
		for (let attempt = 0; attempt < 100 && mockPi.callCount() < 2; attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		for (let attempt = 0; attempt < 100; attempt++) {
			status = JSON.parse(fs.readFileSync(statusPath, "utf-8"));
			if (status.state === "running" && status.steps?.some((step) => step.workflowKey === "work" && step.phase !== undefined)) break;
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		assert.equal(status.state, "running");
		assert.equal(status.steps?.find((step) => step.workflowKey === "work")?.phase, "Review");

		fs.writeFileSync(releasePath, "go", "utf-8");
		for (let attempt = 0; attempt < 100; attempt++) {
			status = JSON.parse(fs.readFileSync(statusPath, "utf-8"));
			if (status.state === "complete" || status.state === "failed") break;
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		assert.equal(status.state, "complete");
		assert.equal(status.steps?.find((step) => step.workflowKey === "work")?.phase, "Review");
		assert.equal(mockPi.callCount(), 2);

		fs.rmSync(result.details.asyncDir!, { recursive: true, force: true });
		fs.rmSync(path.join(DIRS.results, `${result.details.asyncId}.json`), { force: true });
	});

	it("runs an external CLI workflow child with subagents.defaultModel configured", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const markerPath = path.join(tempDir, "external-started");
		const executor = makeExecutor([
			makeAgent("external", {
				runner: { type: "external-cli", command: process.execPath, args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(markerPath)}, "started"); process.stdout.write("external result")`] },
				model: "mock/default-model",
				modelSource: { type: "subagents.defaultModel", scope: "user", path: "/settings.json", model: "mock/default-model" },
			}),
		]);
		const ctx = { ...makeMinimalCtx(tempDir), model: { provider: "mock", id: "parent-model" } };
		const started = await executor.execute(
			`external-workflow-${Date.now()}`,
			{ workflowScript: `return await runs.run("external", { agent: "external", task: "Run external", async: true });` },
			new AbortController().signal,
			undefined,
			ctx,
		);

		assert.equal(started.isError, undefined);
		assert.ok(started.details.asyncId);
		const workflowResultPath = path.join(DIRS.results, `${started.details.asyncId}.json`);
		let workflowResult: { state?: string; results?: Array<{ output?: string; runId?: string }> } = {};
		for (let attempt = 0; attempt < 100; attempt++) {
			if (fs.existsSync(workflowResultPath)) workflowResult = JSON.parse(fs.readFileSync(workflowResultPath, "utf-8"));
			if (workflowResult.state === "complete" || workflowResult.state === "failed") break;
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		assert.equal(workflowResult.state, "complete");
		assert.match(workflowResult.results?.[0]?.output ?? "", /Async: external/);
		for (let attempt = 0; attempt < 300 && !fs.existsSync(markerPath); attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		assert.equal(fs.readFileSync(markerPath, "utf-8"), "started");
		assert.equal(mockPi.callCount(), 0);

		fs.rmSync(started.details.asyncDir!, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
		fs.rmSync(workflowResultPath, { force: true });
	});

	it("awaits omitted external CLI workflow children through their async result", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const markerPath = path.join(tempDir, "external-awaited-started");
		const executor = makeExecutor([
			makeAgent("external", {
				runner: { type: "external-cli", command: process.execPath, args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(markerPath)}, "started"); process.stdout.write("awaited external result")`] },
				model: "mock/default-model",
				modelSource: { type: "subagents.defaultModel", scope: "user", path: "/settings.json", model: "mock/default-model" },
			}),
		]);
		const result = await executor.execute(
			"external-awaited-workflow",
			{ workflowScript: `return await runs.run("external", { agent: "external", task: "Run external" });`, async: false },
			new AbortController().signal,
			undefined,
			{ ...makeMinimalCtx(tempDir), model: { provider: "mock", id: "parent-model" } },
		);

		assert.equal(result.isError, undefined, result.content[0]?.text ?? "workflow failed");
		assert.equal(result.details.mode, "workflow");
		assert.match(result.content[0]?.text ?? "", /awaited external result/);
		assert.equal(fs.readFileSync(markerPath, "utf-8"), "started");
		assert.equal(mockPi.callCount(), 0);
	});

	it("starts omitted external CLI single-child calls in async mode", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const markerPath = path.join(tempDir, "external-single-omitted-async-started");
		const executor = makeExecutor([
			makeAgent("external", {
				runner: { type: "external-cli", command: process.execPath, args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(markerPath)}, "started"); process.stdout.write("single async result")`] },
				model: "mock/default-model",
				modelSource: { type: "subagents.defaultModel", scope: "user", path: "/settings.json", model: "mock/default-model" },
			}),
		]);
		const result = await executor.execute(
			"external-single-omitted-async",
			{ agent: "external", task: "Run external" },
			new AbortController().signal,
			undefined,
			{ ...makeMinimalCtx(tempDir), model: { provider: "mock", id: "parent-model" } },
		);

		assert.equal(result.isError, undefined, result.content[0]?.text ?? "launch failed");
		assert.ok(result.details.asyncId);
		assert.match(result.content[0]?.text ?? "", /Async: external/);
		for (let attempt = 0; attempt < 300 && !fs.existsSync(markerPath); attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		assert.equal(fs.readFileSync(markerPath, "utf-8"), "started");
		assert.equal(mockPi.callCount(), 0);

		const resultPath = path.join(DIRS.results, `${result.details.asyncId}.json`);
		let runResult: { state?: string } = {};
		for (let attempt = 0; attempt < 100; attempt++) {
			if (fs.existsSync(resultPath)) runResult = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
			if (runResult.state === "complete" || runResult.state === "failed") break;
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		assert.equal(runResult.state, "complete");

		fs.rmSync(result.details.asyncDir!, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
		fs.rmSync(resultPath, { force: true });
	});

	it("lets explicit fast false opt out external CLI agents from inherited fast mode", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const markerPath = path.join(tempDir, "external-fast-false-started");
		const executor = makeExecutor([
			makeAgent("external", {
				fast: true,
				runner: { type: "external-cli", command: process.execPath, args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(markerPath)}, "started"); process.stdout.write("external fast false result")`] },
			}),
		]);

		const rejected = await executor.execute(
			"external-fast-inherited",
			{ agent: "external", task: "Run external", async: true },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		assert.equal(rejected.isError, true);
		assert.match(rejected.content[0]?.text ?? "", /does not support fast mode/);
		assert.equal(fs.existsSync(markerPath), false);

		const result = await executor.execute(
			"external-fast-false",
			{ agent: "external", task: "Run external", async: true, fast: false },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, undefined, result.content[0]?.text ?? "launch failed");
		assert.ok(result.details.asyncId);
		for (let attempt = 0; attempt < 300 && !fs.existsSync(markerPath); attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		assert.equal(fs.readFileSync(markerPath, "utf-8"), "started");
		assert.equal(mockPi.callCount(), 0);

		const resultPath = path.join(DIRS.results, `${result.details.asyncId}.json`);
		let runResult: { state?: string } = {};
		for (let attempt = 0; attempt < 100; attempt++) {
			if (fs.existsSync(resultPath)) runResult = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
			if (runResult.state === "complete" || runResult.state === "failed") break;
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		assert.equal(runResult.state, "complete");

		fs.rmSync(result.details.asyncDir!, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
		fs.rmSync(resultPath, { force: true });
	});

	it("runs external CLI agents with fallback models without registry validation", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const markerPath = path.join(tempDir, "external-fallback-started");
		const executor = makeExecutor([
			makeAgent("external", {
				runner: { type: "external-cli", command: process.execPath, args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(markerPath)}, "started")`] },
				fallbackModels: ["mock/fallback"],
			}),
		]);
		const result = await executor.execute(
			"external-fallback-model",
			{ agent: "external", task: "Run external", async: true },
			new AbortController().signal,
			undefined,
			{
				...makeMinimalCtx(tempDir),
				modelRegistry: { getAvailable: () => [{ provider: "other", id: "known" }] },
			},
		);

		assert.equal(result.isError, undefined);
		assert.doesNotMatch(result.content[0]?.text ?? "", /Unknown subagent model/);
		for (let attempt = 0; attempt < 300 && !fs.existsSync(markerPath); attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		assert.equal(fs.readFileSync(markerPath, "utf-8"), "started");
		assert.equal(mockPi.callCount(), 0);

		assert.ok(result.details.asyncId);
		const resultPath = path.join(DIRS.results, `${result.details.asyncId}.json`);
		let runResult: { state?: string } = {};
		for (let attempt = 0; attempt < 100; attempt++) {
			if (fs.existsSync(resultPath)) runResult = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
			if (runResult.state === "complete" || runResult.state === "failed") break;
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		assert.equal(runResult.state, "complete");

		fs.rmSync(result.details.asyncDir!, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
		fs.rmSync(resultPath, { force: true });
	});

	it("rejects external CLI fork context before fallback model validation", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const markerPath = path.join(tempDir, "external-fork-started");
		const parentSessionFile = path.join(mockPi.dir, "external-fork-parent.jsonl");
		fs.writeFileSync(parentSessionFile, `${JSON.stringify({ type: "session", version: 3, id: "parent", cwd: tempDir })}\n`, "utf-8");
		const ctx = makeMinimalCtx(tempDir);
		Object.assign(ctx.sessionManager, {
			getSessionFile: () => parentSessionFile,
			getLeafId: () => "parent-leaf",
			openSession: () => ({
				createBranchedSession: () => parentSessionFile,
			}),
		});
		const executor = makeExecutor([
			makeAgent("external", {
				runner: { type: "external-cli", command: process.execPath, args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(markerPath)}, "started")`] },
				defaultContext: "fork",
				fallbackModels: ["mock/fallback"],
			}),
		]);
		const result = await executor.execute(
			"external-fork-fallback",
			{ agent: "external", task: "Run external", async: true },
			new AbortController().signal,
			undefined,
			{
				...ctx,
				modelRegistry: { getAvailable: () => [{ provider: "other", id: "known" }] },
			},
		);

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /does not support: fork context/);
		assert.doesNotMatch(result.content[0]?.text ?? "", /Unknown subagent model/);
		assert.equal(mockPi.callCount(), 0);
		assert.equal(fs.existsSync(markerPath), false);
	});

	it("rejects explicit model overrides for external CLI agents", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const executor = makeExecutor([
			makeAgent("external", {
				runner: { type: "external-cli", command: process.execPath, args: ["-e", "process.stdout.write('unreachable')"] },
			}),
		]);
		const result = await executor.execute(
			"external-explicit-model",
			{ agent: "external", task: "Run external", async: true, model: "mock/override" },
			new AbortController().signal,
			undefined,
			{
				...makeMinimalCtx(tempDir),
				modelRegistry: { getAvailable: () => [{ provider: "other", id: "known" }] },
			},
		);

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /does not support: model override/);
		assert.doesNotMatch(result.content[0]?.text ?? "", /Unknown subagent model/);
		assert.equal(mockPi.callCount(), 0);
	});

	it("rejects external CLI agent models that differ from inherited subagents.defaultModel", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const executor = makeExecutor([
			makeAgent("external", {
				runner: { type: "external-cli", command: process.execPath, args: ["-e", "process.stdout.write('unreachable')"] },
				model: "mock/override-model",
				modelSource: { type: "subagents.defaultModel", scope: "user", path: "/settings.json", model: "mock/default-model" },
			}),
		]);
		const result = await executor.execute(
			"external-agent-override-model",
			{ agent: "external", task: "Run external", async: true },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /does not support: model override/);
		assert.equal(mockPi.callCount(), 0);
	});

	it("rejects external CLI agent models that equal inherited subagents.defaultModel without provenance", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const executor = makeExecutor([
			makeAgent("external", {
				runner: { type: "external-cli", command: process.execPath, args: ["-e", "process.stdout.write('unreachable')"] },
				model: "mock/default-model",
			}),
		]);
		const result = await executor.execute(
			"external-agent-same-value-override-model",
			{ agent: "external", task: "Run external", async: true },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /does not support: model override/);
		assert.equal(mockPi.callCount(), 0);
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
		const activeMarkerPath = path.join(DIRS.async, ACTIVE_RUN_INDEX_DIR, workflowRunId);
		assert.equal(fs.existsSync(activeMarkerPath), true);
		let liveStatus: AsyncStatus | undefined;
		const activityDeadline = Date.now() + 5_000;
		while (Date.now() < activityDeadline && !fs.existsSync(resultPath)) {
			const candidate = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatus;
			if (candidate.activityState === "needs_attention" && candidate.steps?.[0]?.currentTool === "read") {
				liveStatus = candidate;
				break;
			}
			await new Promise((resolve) => setTimeout(resolve, 50));
		}

		assert.ok(liveStatus, "expected workflow status to expose live child activity");
		assert.equal(liveStatus.activityState, "needs_attention");
		assert.equal(typeof liveStatus.lastActivityAt, "number");
		assert.equal(liveStatus.currentTool, "read");
		assert.match(liveStatus.currentPath ?? "", /src[/\\]example\.ts$/);
		assert.equal(liveStatus.toolCount, 1);
		assert.equal(liveStatus.steps?.[0]?.status, "running");
		assert.equal(liveStatus.steps?.[0]?.agent, "echo");
		assert.match(liveStatus.steps?.[0]?.sessionFile ?? "", /session\.jsonl$/);
		assert.equal(fs.existsSync(liveStatus.steps?.[0]?.sessionFile ?? ""), true);
		assert.equal(liveStatus.steps?.[0]?.activityState, "needs_attention");
		assert.equal(typeof liveStatus.steps?.[0]?.lastActivityAt, "number");
		assert.equal(liveStatus.steps?.[0]?.toolCount, 1);
		assert.equal(asyncJobs.get(workflowRunId)?.activityState, "needs_attention");
		assert.equal(asyncJobs.get(workflowRunId)?.steps?.[0]?.currentTool, "read");

		const completionDeadline = Date.now() + 5_000;
		while (!fs.existsSync(resultPath)) {
			if (Date.now() > completionDeadline) assert.fail("Timed out waiting for async workflow completion");
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		assert.equal(fs.existsSync(activeMarkerPath), false);
		fs.rmSync(asyncDir, { recursive: true, force: true });
		fs.rmSync(resultPath, { force: true });
	});

	it("notifies the parent when an async workflow child needs attention", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({
			steps: [
				{ jsonl: [events.toolStart("read", { path: "src/example.ts" }), events.toolEnd("read"), events.toolResult("read", "contents")] },
				{ delay: 2_500, jsonl: [events.assistantMessage("Done")] },
			],
		});
		const asyncJobs: SubagentState["asyncJobs"] = new Map();
		const piEvents = createEventBus();
		const controlPayloads: Array<{ event?: ControlEvent; source?: string }> = [];
		piEvents.on(SUBAGENT_CONTROL_EVENT, (payload) => {
			controlPayloads.push(payload as { event?: ControlEvent; source?: string });
		});
		const executor = makeExecutor([makeAgent("echo")], {
			control: {
				enabled: true,
				needsAttentionAfterMs: 100,
				activeNoticeAfterMs: 999_999,
				activeNoticeAfterTurns: 999_999,
				activeNoticeAfterTokens: 999_999,
				notifyOn: ["needs_attention"],
				notifyChannels: ["event"],
			},
		}, false, undefined, true, asyncJobs, undefined, undefined, piEvents);

		const result = await executor.execute(
			"workflow-child-attention-notice",
			{ workflowScript: `return runs.run("stalled-review", { agent: "echo", task: "Inspect the file" });` },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		const { asyncId: workflowRunId, asyncDir } = result.details;
		assert.ok(workflowRunId);
		assert.ok(asyncDir);
		const statusPath = path.join(asyncDir, "status.json");
		const eventsPath = path.join(asyncDir, "events.jsonl");
		const resultPath = path.join(DIRS.results, `${workflowRunId}.json`);
		let liveStatus: AsyncStatus | undefined;
		const activityDeadline = Date.now() + 5_000;
		while (Date.now() < activityDeadline && !fs.existsSync(resultPath)) {
			if (fs.existsSync(statusPath)) {
				const candidate = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatus;
				if (candidate.activityState === "needs_attention" && !candidate.steps?.[0]?.currentTool) {
					liveStatus = candidate;
					break;
				}
			}
			await new Promise((resolve) => setTimeout(resolve, 50));
		}

		assert.ok(liveStatus, "expected workflow status to expose idle child attention");
		assert.equal(liveStatus.activityState, "needs_attention");
		assert.equal(liveStatus.steps?.[0]?.activityState, "needs_attention");
		assert.equal(liveStatus.steps?.[0]?.workflowKey, "stalled-review");

		const attentionPayload = controlPayloads.find((payload) => payload.event?.type === "needs_attention");
		assert.ok(attentionPayload, "expected a live parent control event");
		assert.equal(attentionPayload.source, "async");
		assert.equal(attentionPayload.event?.workflowKey, "stalled-review");
		assert.equal(attentionPayload.event?.reason, "idle");
		const sent: Array<{ options?: { triggerTurn?: boolean } }> = [];
		handleSubagentControlNotice({
			pi: { sendMessage(_message, options) { sent.push({ options: options as { triggerTurn?: boolean } }); } },
			state: { asyncJobs } as SubagentState,
			visibleControlNotices: new Set(),
			details: { event: attentionPayload.event!, source: "async" },
		});
		assert.equal(sent.length, 1);
		assert.deepEqual(sent[0]?.options, { triggerTurn: true });

		assert.equal(fs.existsSync(eventsPath), true);
		const controlRecords = fs.readFileSync(eventsPath, "utf-8")
			.split("\n")
			.filter((line) => line.trim())
			.map((line) => JSON.parse(line) as { type?: string; event?: ControlEvent; runId?: string })
			.filter((record) => record.type === "subagent.control");
		const persisted = controlRecords.find((record) => record.event?.type === "needs_attention");
		assert.ok(persisted, "expected a persisted workflow control event");
		assert.equal(persisted.runId, workflowRunId);
		assert.equal(persisted.event?.workflowKey, "stalled-review");
		assert.equal(controlRecords.filter((record) => record.event?.type === "needs_attention").length, 1);

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

	it("keeps ordinary async workflow child results in the watcher-owned path", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "async child done" });
		const executor = makeExecutor([makeAgent("echo")]);
		const result = await executor.execute(
			`scripted-workflow-async-child-${Date.now()}`,
			{ workflowScript: `return await runs.run("background", { agent: "echo", task: "Async child", async: true });`, async: false },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		const childRunId = (result.details.workflow?.value as { runId?: string } | undefined)?.runId;
		assert.ok(childRunId);
		const childDir = path.join(DIRS.async, childRunId);
		const childResultPath = path.join(DIRS.results, `${childRunId}.json`);
		for (let attempt = 0; attempt < 200 && !fs.existsSync(childResultPath); attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		assert.equal(fs.existsSync(childResultPath), true);
		assert.equal(fs.existsSync(path.join(childDir, "workflow-result.json")), false);
		fs.rmSync(childDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
		fs.rmSync(childResultPath, { force: true });
	});

	it("applies an agent deadline to a workflow-launched async child", { skip: !createSubagentExecutor ? "executor not importable" : process.platform === "win32" ? "timeout signal delivery intermittent on Windows CI" : undefined }, async () => {
		mockPi.onCall({ delay: 5_000, output: "too late" });
		const executor = makeExecutor([makeAgent("slow", { defaultTimeoutMs: 150 })]);
		const result = await executor.execute(
			`scripted-workflow-async-child-timeout-${Date.now()}`,
			{
				workflowScript: `return await runs.run("background", { agent: "slow", task: "Wait", async: true });`,
				async: false,
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		const childRunId = (result.details.workflow?.value as { runId?: string } | undefined)?.runId;
		assert.ok(childRunId, JSON.stringify(result.details.workflow?.value ?? result.content));
		const childDir = path.join(DIRS.async, childRunId);
		const childResultPath = path.join(DIRS.results, `${childRunId}.json`);
		let persisted: { timeoutMs?: number; state?: string; results?: Array<{ timedOut?: boolean; error?: string }> } = {};
		for (let attempt = 0; attempt < 200; attempt++) {
			if (fs.existsSync(childResultPath)) persisted = JSON.parse(fs.readFileSync(childResultPath, "utf-8"));
			if (persisted.state === "failed") break;
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		assert.equal(persisted.timeoutMs, 150);
		assert.equal(persisted.state, "failed");
		assert.deepEqual(persisted.results?.map((entry) => entry.timedOut), [true]);
		assert.deepEqual(persisted.results?.map((entry) => entry.error), ["Subagent timed out after 150ms."]);
		fs.rmSync(childDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
		fs.rmSync(childResultPath, { force: true });
	});

	it("persists workflow parent metadata in an async worktree child status and result", { skip: !createSubagentExecutor || process.platform === "win32" ? "executor unavailable or worktree paths differ on Windows" : undefined }, async () => {
		execFileSync("git", ["init"], { cwd: tempDir, stdio: "ignore" });
		execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: tempDir });
		execFileSync("git", ["config", "user.name", "Test User"], { cwd: tempDir });
		fs.writeFileSync(path.join(tempDir, "base.txt"), "base\n", "utf-8");
		execFileSync("git", ["add", "base.txt"], { cwd: tempDir });
		execFileSync("git", ["commit", "-m", "base"], { cwd: tempDir, stdio: "ignore" });
		mockPi.onCall({ output: "async child done", writeFiles: [{ path: "feature.txt", content: "feature\n" }] });
		const executor = makeExecutor([makeAgent("echo")]);
		const toolCallId = `scripted-workflow-parent-${Date.now()}`;
		const started = await executor.execute(
			toolCallId,
			{ workflowScript: `const child = await runs.run("background", { agent: "echo", task: "Async child", async: true, worktree: true, lane: { version: 1, key: "background", mode: "mutation", sourceRef: "owner/repo#1621", claims: ["feature.txt"] } }); return child.runId;` },
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
		assert.deepEqual(workflowStatus.steps?.[0]?.lane, { version: 1, key: "background", mode: "mutation", sourceRef: "owner/repo#1621", claims: ["feature.txt"] });
		assert.match(workflowStepSessionFile, /session\.jsonl$/);
		const childDir = path.join(DIRS.async, childRunId);
		const childStatusPath = path.join(childDir, "status.json");
		let childStatus: { state?: string; mode?: string; parentWorkflowRunId?: string; workflowKey?: string; lane?: { key: string; mode?: string; sourceRef?: string; claims?: string[] }; steps?: Array<{ lane?: { key: string }; worktreePath?: string; branch?: string }>; parallelHandoff?: { path?: string; changedPatches?: number } } = {};
		for (let attempt = 0; attempt < 200; attempt++) {
			if (fs.existsSync(childStatusPath)) childStatus = JSON.parse(fs.readFileSync(childStatusPath, "utf-8"));
			if (["complete", "failed", "stopped"].includes(childStatus.state ?? "")) break;
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		assert.equal(childStatus.mode, "single");
		assert.equal(childStatus.parentWorkflowRunId, workflowRunId);
		assert.equal(childStatus.workflowKey, "background");
		assert.deepEqual(childStatus.lane, { version: 1, key: "background", mode: "mutation", sourceRef: "owner/repo#1621", claims: ["feature.txt"] });
		assert.deepEqual(childStatus.steps?.[0]?.lane, childStatus.lane);
		assert.equal(typeof childStatus.steps?.[0]?.worktreePath, "string");
		assert.equal(typeof childStatus.steps?.[0]?.branch, "string");
		assert.equal(typeof childStatus.parallelHandoff?.path, "string");
		assert.equal(childStatus.parallelHandoff?.changedPatches, 1);
		assert.equal(fs.existsSync(path.join(tempDir, "feature.txt")), false);
		const handoff = JSON.parse(fs.readFileSync(childStatus.parallelHandoff!.path!, "utf-8")) as { groups?: Array<{ children?: Array<{ workflowKey?: string; runId?: string; lane?: { key: string }; patch?: { changed?: boolean; filesChanged?: number } }>; cleanup?: { state?: string; tasks?: Array<{ path?: string; preserved?: boolean; worktreeRemoved?: boolean; reason?: string }> } }> };
		assert.equal(handoff.groups?.[0]?.children?.[0]?.workflowKey, "background");
		assert.equal(handoff.groups?.[0]?.children?.[0]?.runId, childRunId);
		assert.equal(handoff.groups?.[0]?.children?.[0]?.lane?.key, "background");
		assert.equal(handoff.groups?.[0]?.children?.[0]?.patch?.changed, true);
		assert.equal(handoff.groups?.[0]?.children?.[0]?.patch?.filesChanged, 1);
		assert.equal(handoff.groups?.[0]?.cleanup?.state, "partial");
		assert.equal(handoff.groups?.[0]?.cleanup?.tasks?.[0]?.preserved, true);
		assert.equal(handoff.groups?.[0]?.cleanup?.tasks?.[0]?.worktreeRemoved, false);
		assert.equal(handoff.groups?.[0]?.cleanup?.tasks?.[0]?.reason, "retained child resume requires managed worktree cwd");
		assert.equal(fs.existsSync(handoff.groups?.[0]?.cleanup?.tasks?.[0]?.path ?? ""), true);
		const childResultPath = path.join(DIRS.results, `${childRunId}.json`);
		for (let attempt = 0; attempt < 200 && !fs.existsSync(childResultPath); attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		const childResult = JSON.parse(fs.readFileSync(childResultPath, "utf-8")) as { parentWorkflowRunId?: string; workflowKey?: string };
		assert.equal(childResult.parentWorkflowRunId, workflowRunId);
		assert.equal(childResult.workflowKey, "background");
		const workflowReceipt = JSON.parse(fs.readFileSync(path.join(started.details.asyncDir!, "workflow-receipt.json"), "utf-8")) as { entries?: Record<string, { lane?: { key: string; mode?: string } }> };
		assert.deepEqual(workflowReceipt.entries?.background?.lane, { version: 1, key: "background", mode: "mutation", sourceRef: "owner/repo#1621", claims: ["feature.txt"] });
		assert.equal(fs.existsSync(workflowStepSessionFile), true);
		const retainedCwd = handoff.groups?.[0]?.cleanup?.tasks?.[0]?.path;
		assert.ok(retainedCwd);
		const resumeTarget = resolveAsyncResumeTarget({ id: childRunId }, { asyncDirRoot: DIRS.async, resultsDir: DIRS.results });
		assert.equal(resumeTarget.recoveryDescriptor?.sourceRunId, childRunId);
		assert.equal(path.resolve(resumeTarget.cwd ?? ""), path.resolve(retainedCwd));
		discardPreservedWorktrees(childStatus.parallelHandoff!.path!, { kind: "confirmed" });
		fs.rmSync(started.details.asyncDir!, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
		fs.rmSync(workflowResultPath, { force: true });
		fs.rmSync(childDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
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
		assert.equal(controller.signal.reason instanceof Error ? controller.signal.reason.message : String(controller.signal.reason), "Workflow stopped.");
		assert.match(result.content[0]?.text ?? "", /Stop requested for async workflow workflow-stop/);
	});

	it("persists parent-stopped workflow children as stopped instead of failed", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ delay: 5_000, output: "too late" });
		const workflowControllers = new Map<string, AbortController>();
		const executor = makeExecutor([makeAgent("echo")], {}, false, undefined, true, new Map(), workflowControllers);
		const started = await executor.execute(
			`workflow-stop-child-${Date.now()}`,
			{ workflowScript: `return await runs.run("review", { agent: "echo", task: "Wait" });` },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		assert.ok(started.details.asyncId);
		const workflowRunId = started.details.asyncId;
		const statusPath = path.join(started.details.asyncDir!, "status.json");
		for (let attempt = 0; attempt < 100; attempt++) {
			const status = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatus;
			if (status.steps?.some((step) => step.workflowKey === "review" && step.status === "running")) break;
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		let childCall: string | undefined;
		for (let attempt = 0; attempt < 100 && !childCall; attempt++) {
			childCall = fs.readdirSync(mockPi.dir).find((name) => /^call-\d+-\d+-/.test(name));
			if (!childCall) await new Promise((resolve) => setTimeout(resolve, 20));
		}
		const childPid = Number(childCall?.match(/^call-\d+-(\d+)-/)?.[1]);
		assert.equal(Number.isInteger(childPid) && childPid > 0, true);

		const stopped = await executor.execute(
			"stop-workflow-child",
			{ action: "stop", id: workflowRunId },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		assert.equal(stopped.isError, undefined);

		let status: AsyncStatus = JSON.parse(fs.readFileSync(statusPath, "utf-8"));
		for (let attempt = 0; attempt < 100 && status.state !== "stopped"; attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 20));
			status = JSON.parse(fs.readFileSync(statusPath, "utf-8"));
		}
		assert.equal(status.state, "stopped");
		assert.equal(status.error, "Workflow stopped.");
		assert.equal(status.steps?.[0]?.status, "stopped");
		assert.equal(status.steps?.[0]?.stopped, true);
		assert.equal(status.steps?.[0]?.error, "Workflow stopped.");
		assert.equal(status.workflow?.trace.some((entry) => entry.key === "review" && entry.state === "stopped"), true);
		assert.equal(status.workflow?.trace.some((entry) => entry.key === "review" && entry.state === "failed"), false);

		let childSettled = false;
		for (let attempt = 0; attempt < 100; attempt++) {
			try {
				process.kill(childPid, 0);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ESRCH") {
					childSettled = true;
					break;
				}
				throw error;
			}
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		assert.equal(childSettled, true, "child process must settle after the workflow stop");
		await new Promise((resolve) => setTimeout(resolve, 50));
		status = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatus;
		assert.equal(status.steps?.[0]?.status, "stopped");
		assert.equal(status.steps?.[0]?.stopped, true);
		assert.equal(status.steps?.[0]?.error, "Workflow stopped.");

		fs.rmSync(started.details.asyncDir!, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
		fs.rmSync(path.join(DIRS.results, `${workflowRunId}.json`), { force: true });
	});

	it("stops one live async workflow child without stopping the parent or sibling", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ matchArgIncludes: "Slow child", delay: 5_000, output: "slow late" });
		mockPi.onCall({ matchArgIncludes: "Fast child", delay: 250, output: "fast done" });
		const asyncJobs: SubagentState["asyncJobs"] = new Map();
		const executor = makeExecutor([makeAgent("echo")], {}, false, undefined, true, asyncJobs);
		const started = await executor.execute(
			`workflow-child-stop-${Date.now()}`,
			{
				workflowScript: `
					const results = await runs.all([
						{ key: "slow", agent: "echo", task: "Slow child" },
						{ key: "fast", agent: "echo", task: "Fast child" }
					]);
					return results.map((result) => result.key + ":" + (result.stopped ? "stopped" : result.ok ? "ok" : "failed")).join(",");
				`,
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		assert.equal(started.isError, undefined);
		assert.ok(started.details.asyncDir);
		const workflowRunId = started.details.asyncId!;
		const statusPath = path.join(started.details.asyncDir, "status.json");
		const resultPath = path.join(DIRS.results, `${workflowRunId}.json`);
		let status = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatus;
		for (let attempt = 0; attempt < 150 && !status.steps?.some((step) => step.workflowKey === "slow" && step.status === "running"); attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 20));
			status = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatus;
		}
		const listed = listAsyncRuns(DIRS.async, { sessionId: "session-123", runId: workflowRunId, exactRunId: true })
			.find((run) => run.id === workflowRunId);
		assert.equal(listed?.steps?.find((step) => step.workflowKey === "slow")?.childId, "slow");

		const stop = await executor.execute(
			"stop-workflow-child-only",
			{ action: "stop", id: workflowRunId, childId: "slow" },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		assert.equal(stop.isError, undefined, stop.content[0]?.text ?? "");
		assert.match(stop.content[0]?.text ?? "", /Stop requested for child slow/);

		for (let attempt = 0; attempt < 150 && status.state !== "complete"; attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 20));
			status = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatus;
		}
		assert.equal(status.state, "complete", status.error);
		assert.equal(status.stopped, undefined);
		assert.equal(status.steps?.find((step) => step.workflowKey === "slow")?.status, "stopped");
		assert.equal(status.steps?.find((step) => step.workflowKey === "slow")?.stopped, true);
		assert.equal(status.steps?.find((step) => step.workflowKey === "slow")?.error, "Workflow child 'slow' stopped.");
		assert.equal(status.steps?.find((step) => step.workflowKey === "fast")?.status, "completed");
		assert.equal(status.steps?.find((step) => step.workflowKey === "fast")?.stopped, undefined);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as { state?: string; stopped?: boolean; results?: Array<{ workflowKey?: string; success?: boolean; stopped?: boolean }> };
		assert.equal(payload.state, "complete");
		assert.equal(payload.stopped, undefined);
		assert.equal(payload.results?.find((entry) => entry.workflowKey === "slow")?.stopped, true);
		assert.equal(payload.results?.find((entry) => entry.workflowKey === "fast")?.success, true);
		const childStatusEvents = fs.readFileSync(path.join(started.details.asyncDir, "events.jsonl"), "utf-8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { type?: string; childId?: string; status?: string; reason?: string });
		assert.ok(childStatusEvents.some((event) => event.type === "subagent.child-status" && event.childId === "slow" && event.status === "stopping"));
		const stoppedChildStatus = childStatusEvents.findLast((event) => event.type === "subagent.child-status" && event.childId === "slow" && event.status === "stopped");
		assert.equal(stoppedChildStatus?.reason, "subagent-action");
		fs.rmSync(started.details.asyncDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
		fs.rmSync(resultPath, { force: true });
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

	it("keeps a git worktree clean while routing workflow children through one automatic mission", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "scanned auth" });
		mockPi.onCall({ output: "reviewed auth" });
		const projectDir = path.join(tempDir, "project");
		const agentDir = path.join(tempDir, "agent");
		fs.mkdirSync(projectDir);
		execFileSync("git", ["init"], { cwd: projectDir, stdio: "ignore" });
		execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: projectDir });
		execFileSync("git", ["config", "user.name", "Test User"], { cwd: projectDir });
		fs.writeFileSync(path.join(projectDir, "base.txt"), "base\n", "utf-8");
		execFileSync("git", ["add", "base.txt"], { cwd: projectDir });
		execFileSync("git", ["commit", "-m", "base"], { cwd: projectDir, stdio: "ignore" });
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = agentDir;
		try {
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
				makeMinimalCtx(projectDir),
			);

			assert.equal(result.isError, undefined);
			assert.match(result.content[0]?.text ?? "", /reviewed auth/);
			assert.equal(result.details.mode, "workflow");
			assert.equal(result.details.results.length, 2);
			assert.equal(result.details.workflow?.value && (result.details.workflow.value as { stateType?: unknown }).stateType, "object");
			assert.ok(result.details.missionId);
			const missionFiles = fs.readdirSync(path.join(agentDir, "missions", "projects"), { recursive: true })
				.filter((entry) => typeof entry === "string" && entry.endsWith(".json"));
			assert.equal(missionFiles.length, 1);
			const mission = JSON.parse(fs.readFileSync(path.join(agentDir, "missions", "projects", missionFiles[0]!), "utf-8")) as { objective?: string };
			assert.equal(mission.objective, utils.PROMPT_REDACTED);
			assert.deepEqual(result.details.workflow?.trace.filter((entry) => entry.state === "completed").map((entry) => entry.key), ["scan", "review"]);
			assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: projectDir, encoding: "utf-8" }), "");
		} finally {
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		}
	});

	it("keeps workflow children mission-detached when automatic mission persistence fails", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "scanned auth" });
		mockPi.onCall({ output: "reviewed auth" });
		const blockedIndex = path.join(tempDir, "blocked-mission-index");
		fs.writeFileSync(blockedIndex, "not a directory", "utf-8");
		const executor = makeExecutor([makeAgent("echo")], { missions: { directory: ".pi/subagents/missions", globalIndexDir: blockedIndex } });

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
		const missionDir = path.join(tempDir, ".pi/subagents", "missions");
		const missionFiles = fs.existsSync(missionDir) ? fs.readdirSync(missionDir).filter((entry) => entry.endsWith(".json")) : [];
		assert.equal(missionFiles.length, 1);
	});

	it("shares durable workflow state across a mission and omits it for mission:false", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		const projectDir = path.join(tempDir, "project");
		const agentDir = path.join(tempDir, "agent");
		fs.mkdirSync(projectDir);
		process.env.PI_CODING_AGENT_DIR = agentDir;
		try {
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
				makeMinimalCtx(projectDir),
			);
			assert.equal(first.isError, undefined, first.content[0]?.text ?? "first workflow failed");
			assert.ok(first.details.missionId);
			assert.deepEqual(first.details.workflow?.value, { count: 1 });
			const location = resolveMissionStoreLocation({ projectRoot: projectDir, agentDir });
			const statePath = missionStatePath(location, first.details.missionId);
			assert.equal(fs.existsSync(statePath), true);
			assert.equal(path.relative(projectDir, statePath).startsWith(".."), true);

			const second = await executor.execute(
				"mission-state-second",
				{ async: false, missionId: first.details.missionId, workflowScript: `return await state.get("review.stage");` },
				new AbortController().signal,
				undefined,
				makeMinimalCtx(projectDir),
			);
			assert.equal(second.isError, undefined, second.content[0]?.text ?? "second workflow failed");
			assert.deepEqual(second.details.workflow?.value, { count: 1 });

			const ephemeral = await executor.execute(
				"mission-state-off",
				{ async: false, mission: false, workflowScript: `return typeof state;` },
				new AbortController().signal,
				undefined,
				makeMinimalCtx(projectDir),
			);
			assert.equal(ephemeral.isError, undefined, ephemeral.content[0]?.text ?? "ephemeral workflow failed");
			assert.equal(ephemeral.details.workflow?.value, "undefined");
			assert.equal(ephemeral.details.missionId, undefined);
		} finally {
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		}
	});

	it("runs a direct single child in a managed worktree", { skip: !createSubagentExecutor || process.platform === "win32" ? "executor unavailable or worktree paths differ on Windows" : undefined }, async () => {
		execFileSync("git", ["init"], { cwd: tempDir, stdio: "ignore" });
		execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: tempDir });
		execFileSync("git", ["config", "user.name", "Test User"], { cwd: tempDir });
		fs.writeFileSync(path.join(tempDir, "base.txt"), "base\n", "utf-8");
		execFileSync("git", ["add", "base.txt"], { cwd: tempDir });
		execFileSync("git", ["commit", "-m", "base"], { cwd: tempDir, stdio: "ignore" });
		mockPi.onCall({ output: "isolated feature", writeFiles: [{ path: "feature.txt", content: "feature\n" }] });
		const executor = makeExecutor([makeAgent("worker", { completionGuard: false })]);

		const result = await executor.execute(
			"direct-worktree",
			{ async: false, agent: "worker", task: "Implement feature", worktree: true },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, undefined, result.content[0]?.text ?? "managed worktree child failed");
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

	it("aligns a forked workflow child session with its managed worktree cwd", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		execFileSync("git", ["init"], { cwd: tempDir, stdio: "ignore" });
		execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: tempDir });
		execFileSync("git", ["config", "user.name", "Test User"], { cwd: tempDir });
		fs.writeFileSync(path.join(tempDir, "base.txt"), "base\n", "utf-8");
		execFileSync("git", ["add", "base.txt"], { cwd: tempDir });
		execFileSync("git", ["commit", "-m", "base"], { cwd: tempDir, stdio: "ignore" });

		const parentSessionFile = path.join(mockPi.dir, "parent-session.jsonl");
		const childSessionFile = path.join(mockPi.dir, "forked-child-session.jsonl");
		fs.writeFileSync(parentSessionFile, `${JSON.stringify({ type: "session", version: 3, id: "parent", cwd: tempDir })}\n`, "utf-8");
		const ctx = makeMinimalCtx(tempDir);
		Object.assign(ctx.sessionManager, {
			getSessionFile: () => parentSessionFile,
			getLeafId: () => "parent-leaf",
			openSession: () => ({
				createBranchedSession: () => {
					fs.writeFileSync(childSessionFile, `${JSON.stringify({ type: "session", version: 3, id: "child", cwd: tempDir })}\n`, "utf-8");
					return childSessionFile;
				},
			}),
		});
		mockPi.onCall({ output: "isolated fork child" });
		const executor = makeExecutor([makeAgent("worker", { defaultContext: "fork" })]);

		const result = await executor.execute(
			"forked-worktree-workflow",
			{ async: false, workflowScript: `return runs.run("isolated", { agent: "worker", task: "Work in isolation", worktree: true });` },
			new AbortController().signal,
			undefined,
			ctx,
		);

		assert.equal(result.isError, undefined, result.content[0]?.text ?? "workflow failed");
		const workflowValue = result.details.workflow?.value as { artifactPaths?: string[] } | undefined;
		const handoffPath = workflowValue?.artifactPaths?.find((candidate) => candidate.endsWith(".json") && candidate.includes("handoffs"));
		assert.ok(handoffPath, JSON.stringify(workflowValue));
		const handoff = JSON.parse(fs.readFileSync(handoffPath, "utf-8")) as {
			groups: Array<{ cleanup: { tasks: Array<{ path: string }> } }>;
		};
		const managedWorktreeCwd = handoff.groups[0]?.cleanup.tasks[0]?.path;
		assert.ok(managedWorktreeCwd);
		const callCwd = readCall().cwd;
		assert.ok(callCwd);
		assert.notEqual(path.resolve(callCwd), path.resolve(tempDir));
		assert.equal(path.basename(callCwd), path.basename(managedWorktreeCwd));
		const sessionHeader = JSON.parse(fs.readFileSync(childSessionFile, "utf-8").split("\n", 1)[0]!) as { cwd?: string };
		assert.ok(sessionHeader.cwd);
		assert.equal(path.basename(sessionHeader.cwd), path.basename(callCwd));
	});

	it("rejects workflowScript implementation children under a read-only capability ceiling before spawn", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "completed without edits" });
		const executor = makeExecutor([makeAgent("worker")]);

		const result = await executor.execute(
			"workflow-readonly-implementation-contract",
			{
				async: false,
				workflowScript: `return await runs.run("impl", { agent: "worker", task: "Implement the requested source fix" });`,
				capabilityCeiling: { version: 1, allowedTools: ["read", "grep", "find", "ls", "contact_supervisor"], denyExtensions: true, sources: ["test"] },
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /no mutation-capable tools/);
		assert.doesNotMatch(result.content[0]?.text ?? "", /completed without making edits/);
		assert.equal(mockPi.callCount(), 0);
	});

	it("stringifies workflow child results without object placeholders", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "first report", matchArgIncludes: "Review" });
		mockPi.onCall({ output: "second report", matchArgIncludes: "Monitor" });
		const executor = makeExecutor([makeAgent("echo")]);

		const result = await executor.execute(
			"scripted-workflow-stringified-child-results",
			{
				async: false,
				workflowScript: `
					const [review, monitor] = await runs.all([
						{ key: "review", agent: "echo", task: "Review" },
						{ key: "monitor", agent: "echo", task: "Monitor" }
					]);
					return "## Lane 1\\n" + review + "\\n\\n---\\n\\n## Lane 2\\n" + monitor;
				`,
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		const text = result.content[0]?.text ?? "";
		assert.equal(result.isError, undefined, text || "workflow failed");
		assert.doesNotMatch(text, /\[object Object\]/);
		assert.match(text, /## Lane 1\nfirst report/);
		assert.match(text, /## Lane 2\nsecond report/);
		assert.equal(result.details.workflow?.value, "## Lane 1\nfirst report\n\n---\n\n## Lane 2\nsecond report");
	});

	it("stringifies awaited workflow child results without object placeholders", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "single report", matchArgIncludes: "Review" });
		const executor = makeExecutor([makeAgent("echo")]);

		const result = await executor.execute(
			"scripted-workflow-stringified-single-child-result",
			{
				async: false,
				workflowScript: `
					const review = await runs.run("review", { agent: "echo", task: "Review" });
					return "## Lane\\n" + review;
				`,
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		const text = result.content[0]?.text ?? "";
		assert.equal(result.isError, undefined, text || "workflow failed");
		assert.doesNotMatch(text, /\[object Object\]/);
		assert.match(text, /## Lane\nsingle report/);
		assert.equal(result.details.workflow?.value, "## Lane\nsingle report");
	});

	it("derives workflow child output paths from the workflow output", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "first report", matchArgIncludes: "Review" });
		mockPi.onCall({ output: "second report", matchArgIncludes: "Monitor" });
		const executor = makeExecutor([makeAgent("echo")]);
		const workflowOutput = path.join(tempDir, "workflow-report.md");

		const result = await executor.execute(
			"scripted-workflow-child-output-defaults",
			{
				async: false,
				output: workflowOutput,
				workflowScript: `
					const children = await runs.all([
						{ key: "review", agent: "echo", task: "Review" },
						{ key: "monitor", agent: "echo", task: "Monitor" }
					]);
					return children.map(({ key, artifactPaths }) => ({ key, artifactPaths }));
				`,
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, undefined, result.content[0]?.text ?? "workflow failed");
		assert.match(fs.readFileSync(workflowOutput, "utf-8"), /Workflow completed\./);
		const value = result.details.workflow?.value as Array<{ key: string; artifactPaths: string[] }>;
		const childOutputs = value.map((child) => child.artifactPaths.find((candidate) => candidate.endsWith(".md")) ?? "").sort();
		assert.deepEqual(childOutputs, [
			path.join(tempDir, "workflow-report.monitor.md"),
			path.join(tempDir, "workflow-report.review.md"),
		]);
		assert.equal(fs.readFileSync(path.join(tempDir, "workflow-report.review.md"), "utf-8"), "first report");
		assert.equal(fs.readFileSync(path.join(tempDir, "workflow-report.monitor.md"), "utf-8"), "second report");
	});

	it("maps a task-requested report path to the workflow-saved child output", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "review report" });
		const requestedReport = path.join(tempDir, "requested-review.md");
		const workflowOutput = path.join(tempDir, "workflow-report.md");
		const result = await makeExecutor([makeAgent("echo")]).execute(
			"scripted-workflow-requested-output-mapping",
			{
				async: false,
				output: workflowOutput,
				workflowScript: `return await runs.run("review", { agent: "echo", task: ${JSON.stringify(`Review the change.\n\nWrite your findings to exactly this path: ${requestedReport}`)} });`,
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		const savedReport = path.join(tempDir, "workflow-report.review.md");
		assert.equal(result.isError, undefined, result.content[0]?.text ?? "workflow failed");
		assert.equal(fs.existsSync(requestedReport), false);
		assert.equal(fs.readFileSync(savedReport, "utf-8"), "review report");
		assert.deepEqual((result.details.workflow?.value as { outputPathMapping?: unknown }).outputPathMapping, {
			requestedPath: requestedReport,
			savedPath: savedReport,
		});
		assert.match(result.content[0]?.text ?? "", new RegExp(`Output path mappings: 'review': requested ${escapeRegExp(requestedReport)} -> saved ${escapeRegExp(savedReport)}`));
		assert.match(fs.readFileSync(workflowOutput, "utf-8"), /Output path mappings:/);
	});

	it("preserves output path mappings when an async workflow fails after a completed child", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "review report", matchArgIncludes: "Review first" });
		mockPi.onCall({ exitCode: 1, stderr: "later child failure", matchArgIncludes: "Fail later" });
		const requestedReport = path.join(tempDir, "requested-review.md");
		const workflowOutput = path.join(tempDir, "failed-workflow.md");
		const started = await makeExecutor([makeAgent("echo")]).execute(
			"async-workflow-failed-output-mapping",
			{
				async: true,
				output: workflowOutput,
				workflowScript: `
					await runs.run("review", { agent: "echo", task: ${JSON.stringify(`Review first.\n\nWrite your findings to exactly this path: ${requestedReport}`)} });
					await runs.run("fails", { agent: "echo", task: "Fail later" });
					throw new Error("later workflow failure");
				`,
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(started.isError, undefined);
		assert.ok(started.details.asyncId);
		assert.ok(started.details.asyncDir);
		const resultPath = path.join(DIRS.results, `${started.details.asyncId}.json`);
		for (let attempt = 0; attempt < 150 && !fs.existsSync(resultPath); attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		const persisted = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as { state?: string; summary?: string; results?: Array<{ workflowKey?: string; outputReference?: string; output?: string }> };
		const savedReport = path.join(tempDir, "failed-workflow.review.md");
		const expectedMapping = `Output path mappings: 'review': requested ${requestedReport} -> saved ${savedReport}`;
		assert.equal(persisted.state, "failed");
		assert.equal(persisted.results?.[0]?.workflowKey, "review");
		assert.equal(persisted.results?.[0]?.outputReference, savedReport);
		assert.equal(persisted.results?.[0]?.output, "review report");
		assert.match(persisted.summary ?? "", new RegExp(escapeRegExp(expectedMapping)));
		assert.match(fs.readFileSync(workflowOutput, "utf-8"), new RegExp(escapeRegExp(expectedMapping)));
		assert.equal(fs.readFileSync(savedReport, "utf-8"), "review report");

		fs.rmSync(started.details.asyncDir, { recursive: true, force: true });
		fs.rmSync(resultPath, { force: true });
	});

	it("uses child-cwd agent output defaults for omitted workflow child output", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "app report" });
		const appDir = path.join(tempDir, "packages", "app");
		fs.mkdirSync(appDir, { recursive: true });
		const rootAgents = [makeAgent("echo", { output: "root-report.md" })];
		const appAgents = [makeAgent("echo", { output: "app-report.md" })];
		const executor = makeExecutor(rootAgents, {}, false, undefined, true, new Map(), undefined, undefined, createEventBus(), (cwd) => path.resolve(cwd) === path.resolve(appDir) ? appAgents : rootAgents);

		const result = await executor.execute(
			"scripted-workflow-child-cwd-omitted-output-default",
			{
				async: false,
				workflowScript: `return await runs.run("app", { agent: "echo", task: "Review app", cwd: "packages/app" });`,
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, undefined, result.content[0]?.text ?? "workflow failed");
		assert.equal(fs.existsSync(path.join(appDir, "app-report.md")), false);
		assert.ok(result.details.results[0]?.savedOutputPath && pathContainsSegments(result.details.results[0].savedOutputPath, "artifacts", "outputs", "scripted-workflow-child-cwd-omitted-output-default"));
		assert.equal(path.basename(result.details.results[0]?.savedOutputPath ?? ""), "app-report.md");
		assert.equal(fs.readFileSync(result.details.results[0]?.savedOutputPath ?? "", "utf-8"), "app report");
		assert.equal(fs.existsSync(path.join(tempDir, "root-report.md")), false);
	});

	it("uses child-cwd agent output defaults for workflow output true", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "app report" });
		const appDir = path.join(tempDir, "packages", "app");
		fs.mkdirSync(appDir, { recursive: true });
		const rootAgents = [makeAgent("echo", { output: "root-report.md" })];
		const appAgents = [makeAgent("echo", { output: "app-report.md" })];
		const executor = makeExecutor(rootAgents, {}, false, undefined, true, new Map(), undefined, undefined, createEventBus(), (cwd) => path.resolve(cwd) === path.resolve(appDir) ? appAgents : rootAgents);

		const result = await executor.execute(
			"scripted-workflow-child-cwd-output-default",
			{
				async: false,
				workflowScript: `return await runs.run("app", { agent: "echo", task: "Review app", cwd: "packages/app", output: true });`,
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, undefined, result.content[0]?.text ?? "workflow failed");
		assert.equal(fs.existsSync(path.join(appDir, "app-report.md")), false);
		assert.ok(result.details.results[0]?.savedOutputPath && pathContainsSegments(result.details.results[0].savedOutputPath, "artifacts", "outputs", "scripted-workflow-child-cwd-output-default"));
		assert.equal(path.basename(result.details.results[0]?.savedOutputPath ?? ""), "app-report.md");
		assert.equal(fs.readFileSync(result.details.results[0]?.savedOutputPath ?? "", "utf-8"), "app report");
		assert.equal(fs.existsSync(path.join(tempDir, "root-report.md")), false);
	});

	it("reports workflow aggregate output write failures without throwing", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const outputDir = path.join(tempDir, "aggregate-dir");
		fs.mkdirSync(outputDir);
		const result = await makeExecutor([makeAgent("echo")]).execute(
			"scripted-workflow-aggregate-output-write-error",
			{
				async: false,
				output: outputDir,
				workflowScript: `return "ok";`,
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, undefined, result.content[0]?.text ?? "workflow failed");
		assert.match(result.content[0]?.text ?? "", /Workflow completed\./);
		assert.match(result.content[0]?.text ?? "", /Output file error:/);
		assert.match(result.content[0]?.text ?? "", new RegExp(escapeRegExp(outputDir)));
	});

	it("routes workflow relative outputs to the run output artifact directory", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "child report" });
		const executor = makeExecutor([makeAgent("echo")]);

		const result = await executor.execute(
			"scripted-workflow-relative-output-base",
			{
				async: false,
				output: "workflow-summary.md",
				workflowScript: `return await runs.run("review", { agent: "echo", task: "Review", output: "plans/review.md" });`,
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, undefined, result.content[0]?.text ?? "workflow failed");
		assert.equal(fs.existsSync(path.join(tempDir, "workflow-summary.md")), false);
		assert.equal(fs.existsSync(path.join(tempDir, "plans", "review.md")), false);
		const workflowOutputPath = path.join(TEMP_ARTIFACTS_DIR, "outputs", "scripted-workflow-relative-output-base", "workflow-summary.md");
		assert.match(fs.readFileSync(workflowOutputPath, "utf-8"), /Workflow completed\./);
		assert.ok(result.details.results[0]?.savedOutputPath && pathContainsSegments(result.details.results[0].savedOutputPath, "artifacts", "outputs", "scripted-workflow-relative-output-base", "plans"));
		assert.equal(path.basename(result.details.results[0]?.savedOutputPath ?? ""), "review.md");
		assert.equal(fs.readFileSync(result.details.results[0]?.savedOutputPath ?? "", "utf-8"), "child report");
	});

	it("rejects workflow child output collisions before launch", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const executor = makeExecutor([makeAgent("echo")]);
		const sharedOutput = path.join(tempDir, "shared.md");

		const duplicate = await executor.execute(
			"scripted-workflow-duplicate-child-output",
			{
				async: false,
				workflowScript: `return await runs.all([
					{ key: "review", agent: "echo", task: "Review", output: ${JSON.stringify(sharedOutput)} },
					{ key: "monitor", agent: "echo", task: "Monitor", output: ${JSON.stringify(sharedOutput)} }
				]);`,
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(duplicate.isError, undefined, duplicate.content[0]?.text ?? "workflow failed");
		const duplicateChildren = duplicate.details.workflow?.value as Array<{ ok: boolean; error?: string }>;
		assert.deepEqual(duplicateChildren.map(({ ok }) => ok), [false, false]);
		for (const child of duplicateChildren) {
			assert.match(child.error ?? "", /Workflow children 'review' and 'monitor' resolve output to the same path/);
			assert.match(child.error ?? "", new RegExp(escapeRegExp(sharedOutput)));
		}
		assert.equal(mockPi.callCount(), 0);

		const relativeDuplicateOutput = "relative-shared.md";
		const relativeDuplicate = await executor.execute(
			"scripted-workflow-relative-duplicate-child-output",
			{
				async: false,
				workflowScript: `return await runs.all([
					{ key: "review", agent: "echo", task: "Review", output: ${JSON.stringify(relativeDuplicateOutput)} },
					{ key: "monitor", agent: "echo", task: "Monitor", output: ${JSON.stringify(relativeDuplicateOutput)} }
				]);`,
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(relativeDuplicate.isError, undefined, relativeDuplicate.content[0]?.text ?? "workflow failed");
		const relativeDuplicateChildren = relativeDuplicate.details.workflow?.value as Array<{ ok: boolean; error?: string }>;
		assert.deepEqual(relativeDuplicateChildren.map(({ ok }) => ok), [false, false]);
		for (const child of relativeDuplicateChildren) {
			assert.match(child.error ?? "", /Workflow children 'review' and 'monitor' resolve output to the same path/);
			assert.match(child.error ?? "", new RegExp(`${escapeRegExp(TEMP_ARTIFACTS_DIR)}.*outputs.*${escapeRegExp(relativeDuplicateOutput)}`));
		}
		assert.equal(mockPi.callCount(), 0);
	});

	it("isolates colliding inherited agent-default outputs for parallel workflow children", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "review report", matchArgIncludes: "Review" });
		mockPi.onCall({ output: "monitor report", matchArgIncludes: "Monitor" });
		const result = await makeExecutor([makeAgent("echo", { output: "context.md" })]).execute(
			"scripted-workflow-parallel-inherited-output-collision",
			{
				async: false,
				workflowScript: `return await runs.all([
					{ key: "review", agent: "echo", task: "Review" },
					{ key: "monitor", agent: "echo", task: "Monitor" }
				]);`,
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, undefined, result.content[0]?.text ?? "workflow failed");
		const children = result.details.workflow?.value as Array<{ ok: boolean }>;
		assert.deepEqual(children.map(({ ok }) => ok), [true, true]);
		const outputPaths = result.details.results.map(({ savedOutputPath }) => savedOutputPath ?? "").sort();
		assert.equal(outputPaths.length, 2);
		assert.notEqual(outputPaths[0], outputPaths[1]);
		assert.ok(pathContainsSegments(outputPaths[0]!, "artifacts", "outputs"));
		assert.ok(pathContainsSegments(outputPaths[1]!, "artifacts", "outputs"));
		assert.match(path.basename(outputPaths[0]!), /^(monitor|review)\.md$/);
		assert.match(path.basename(outputPaths[1]!), /^(monitor|review)\.md$/);
		assert.deepEqual(outputPaths.map((outputPath) => fs.readFileSync(outputPath, "utf-8")).sort(), ["monitor report", "review report"]);
		assert.equal(fs.existsSync(path.join(tempDir, "context.md")), false);
	});

	it("isolates inherited outputs that collide with a resumed child output", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const retainedRunId = `retained-output-${Date.now()}`;
		const retainedAsyncDir = path.join(DIRS.async, retainedRunId);
		const retainedSessionFile = path.join(tempDir, "retained-session.jsonl");
		const retainedOutputPath = path.join(tempDir, "context.md");
		const runFanoutBudget = createRunFanoutBudget(retainedRunId, 10);
		fs.mkdirSync(retainedAsyncDir, { recursive: true });
		fs.writeFileSync(retainedSessionFile, "{}\n", "utf-8");
		fs.writeFileSync(path.join(retainedAsyncDir, "status.json"), JSON.stringify({
			runId: retainedRunId,
			sessionId: "session-123",
			state: "failed",
			cwd: tempDir,
			sessionFile: retainedSessionFile,
			steps: [
				{ agent: "echo", status: "failed", sessionFile: retainedSessionFile },
				{ agent: "echo", status: "failed", sessionFile: retainedSessionFile },
			],
		}), "utf-8");
		fs.writeFileSync(path.join(retainedAsyncDir, "recovery-descriptor.json"), JSON.stringify({
			version: 1,
			runFanoutBudget,
			sourceRunId: retainedRunId,
			agent: "echo",
			cwd: tempDir,
			systemPromptMode: "append",
			inheritProjectContext: true,
			inheritSkills: true,
			outputPath: retainedOutputPath,
			outputMode: "inline",
			maxSubagentDepth: 1,
			share: false,
		}), "utf-8");
		mockPi.onCall({ output: "resumed report", matchArgIncludes: "Resume" });
		mockPi.onCall({ output: "review report", matchArgIncludes: "Review" });

		try {
			const result = await makeExecutor([makeAgent("echo", { output: "context.md" })]).execute(
				"scripted-workflow-resumed-inherited-output-collision",
				{
					async: false,
					workflowScript: `return await runs.all([
						{ key: "resume", resume: ${JSON.stringify(retainedRunId)}, index: 1, task: "Resume" },
						{ key: "review", agent: "echo", task: "Review" }
					]);`,
				},
				new AbortController().signal,
				undefined,
				makeMinimalCtx(tempDir),
			);

			assert.equal(result.isError, undefined, result.content[0]?.text ?? "workflow failed");
			const children = result.details.workflow?.value as Array<{ ok: boolean }>;
			assert.deepEqual(children.map(({ ok }) => ok), [true, true]);
			assert.equal(fs.readFileSync(retainedOutputPath, "utf-8"), "resumed report");
			const outputPaths = result.details.results.map(({ savedOutputPath }) => savedOutputPath ?? "");
			const inheritedOutputPaths = outputPaths.filter((outputPath) => outputPath && outputPath !== retainedOutputPath).sort();
			assert.deepEqual(inheritedOutputPaths.map((outputPath) => path.basename(outputPath)), ["context.md"]);
			assert.ok(inheritedOutputPaths.every((outputPath) => pathContainsSegments(outputPath, "artifacts", "outputs")));
		} finally {
			fs.rmSync(retainedAsyncDir, { recursive: true, force: true });
			fs.rmSync(runFanoutBudget.directory, { recursive: true, force: true });
		}
	});

	it("reroutes a later inherited agent-default output collision", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "first report", matchArgIncludes: "First" });
		mockPi.onCall({ output: "second report", matchArgIncludes: "Second" });
		const result = await makeExecutor([makeAgent("echo", { output: "context.md" })]).execute(
			"scripted-workflow-sequential-inherited-output-collision",
			{
				async: false,
				workflowScript: `
					const first = await runs.run("first", { agent: "echo", task: "First" });
					const second = await runs.run("second", { agent: "echo", task: "Second" });
					return [first, second];
				`,
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, undefined, result.content[0]?.text ?? "workflow failed");
		const children = result.details.workflow?.value as Array<{ ok: boolean }>;
		assert.deepEqual(children.map(({ ok }) => ok), [true, true]);
		assert.equal(fs.existsSync(path.join(tempDir, "context.md")), false);
		const outputPaths = result.details.results.map(({ savedOutputPath }) => savedOutputPath ?? "");
		assert.ok(pathContainsSegments(outputPaths[0]!, "artifacts", "outputs"));
		assert.equal(path.basename(outputPaths[0]!), "context.md");
		assert.equal(fs.readFileSync(outputPaths[0]!, "utf-8"), "first report");
		assert.ok(pathContainsSegments(outputPaths[1]!, "artifacts", "outputs"));
		assert.equal(path.basename(outputPaths[1]!), "second.md");
		assert.equal(fs.readFileSync(outputPaths[1]!, "utf-8"), "second report");
	});

	it("preserves a rejected file-only child report when its path matches workflow output", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const usefulReport = "# Review findings\n\nThe implementation loses the final report.";
		const sharedOutput = path.join(tempDir, "review.md");
		mockPi.onCall({ stdoutRaw: `${JSON.stringify(events.assistantMessage(usefulReport))}\n` });
		const executor = makeExecutor([makeAgent("reviewer", { tools: ["read"], completionGuard: false })]);

		const result = await executor.execute(
			"scripted-workflow-file-only-acceptance-collision",
			{
				async: false,
				output: sharedOutput,
				workflowScript: `
					const child = await runs.run("review", {
						agent: "reviewer",
						task: "Write a structured review report.",
						output: ${JSON.stringify(sharedOutput)},
						outputMode: "file-only",
						acceptance: { level: "checked", criteria: ["Return the structured review report"] }
					});
					if (!child.ok) throw new Error(child.error);
					return child;
				`,
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", new RegExp(escapeRegExp(sharedOutput)));
		assert.equal(result.details.results[0]?.acceptance?.status, "rejected");
		assert.match(result.details.results[0]?.acceptance?.runtimeChecks[0]?.message ?? "", /Structured acceptance report not found/);
		assert.equal(result.details.results[0]?.savedOutputPath, sharedOutput);
		assert.deepEqual(fs.readFileSync(sharedOutput), Buffer.from(usefulReport));
	});

	it("identifies validation failures before any workflow child launches", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const executor = makeExecutor([makeAgent("worker")]);
		const workflowId = "scripted-workflow-invalid-nested-async";
		const result = await executor.execute(
			workflowId,
			{
				async: false,
				workflowScript: `const lane = async () => runs.run("writer", { agent: "worker", task: "write" }); return lane();`,
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", new RegExp(`Workflow '${workflowId}' validation failed before child launch; no children launched`));
		assert.match(result.content[0]?.text ?? "", /Parallel plus sequential rewrite/);
		assert.deepEqual(result.details.results, []);
	});

	it("replaces stale workflow output when a child claims its path but writes no report", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const sharedOutput = path.join(tempDir, "failed-review.md");
		fs.writeFileSync(sharedOutput, "stale workflow output", "utf-8");
		mockPi.onCall({ exitCode: 1, stderr: "review child failed before writing output" });
		const executor = makeExecutor([makeAgent("reviewer", { completionGuard: false })]);

		const result = await executor.execute(
			"scripted-workflow-missing-child-output-collision",
			{
				async: false,
				output: sharedOutput,
				workflowScript: `
					const child = await runs.run("review", {
						agent: "reviewer",
						task: "Write a review report.",
						output: ${JSON.stringify(sharedOutput)},
						outputMode: "file-only"
					});
					if (!child.ok) throw new Error(child.error);
					return child;
				`,
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /review child failed before writing output/);
		const workflowOutput = fs.readFileSync(sharedOutput, "utf-8");
		assert.match(workflowOutput, /Workflow failed:.*review child failed before writing output/s);
		assert.doesNotMatch(workflowOutput, /stale workflow output/);
	});

	it("rejects sequential workflow child output collisions before launch", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "first report" });
		const executor = makeExecutor([makeAgent("echo")]);
		const sharedOutput = path.join(tempDir, "sequential-shared.md");

		const result = await executor.execute(
			"scripted-workflow-sequential-output-collision",
			{
				async: false,
				workflowScript: `
					const first = await runs.run("review", { agent: "echo", task: "Review", output: ${JSON.stringify(sharedOutput)} });
					const second = await runs.run("monitor", { agent: "echo", task: "Monitor", output: ${JSON.stringify(sharedOutput)} })
						.catch((error) => ({ ok: false, error: error.message }));
					return [first, second];
				`,
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, undefined, result.content[0]?.text ?? "workflow failed");
		const children = result.details.workflow?.value as Array<{ ok: boolean; error?: string }>;
		assert.deepEqual(children.map(({ ok }) => ok), [true, false]);
		assert.match(children[1]?.error ?? "", /Workflow children 'review' and 'monitor' resolve output to the same path/);
		assert.match(children[1]?.error ?? "", new RegExp(escapeRegExp(sharedOutput)));
		assert.equal(mockPi.callCount(), 1);
	});

	it("checks workflow child output collisions against configured output base", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const configuredBase = path.join(tempDir, "configured-outputs");
		const workflowOutput = "shared.md";

		const resolvedSharedOutput = path.join(configuredBase, workflowOutput);
		const agentDefaultResult = await makeExecutor([makeAgent("echo", { output: workflowOutput })], { singleRunOutputBaseDir: configuredBase }).execute(
			"scripted-workflow-configured-agent-default-output-collision",
			{
				async: false,
				workflowScript: `return await runs.all([
					{ key: "review", agent: "echo", task: "Review", output: true },
					{ key: "monitor", agent: "echo", task: "Monitor", output: true }
				]);`,
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(agentDefaultResult.isError, undefined, agentDefaultResult.content[0]?.text ?? "workflow failed");
		const agentDefaultChildren = agentDefaultResult.details.workflow?.value as Array<{ ok: boolean; error?: string }>;
		assert.deepEqual(agentDefaultChildren.map(({ ok }) => ok), [false, false]);
		for (const child of agentDefaultChildren) {
			assert.match(child.error ?? "", /Workflow children 'review' and 'monitor' resolve output to the same path/);
			assert.match(child.error ?? "", new RegExp(escapeRegExp(resolvedSharedOutput)));
		}
		assert.equal(mockPi.callCount(), 0);
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

	it("reports keyed runs.all result access after siblings settle", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "first child completed", matchArgIncludes: "First task" });
		mockPi.onCall({ output: "second child completed", matchArgIncludes: "Second task" });
		const executor = makeExecutor([makeAgent("echo")]);

		const result = await executor.execute(
			"scripted-workflow-runs-all-keyed-result-access",
			{
				async: false,
				workflowScript: `
					const children = await runs.all([
						{ key: "first", agent: "echo", task: "First task" },
						{ key: "second", agent: "echo", task: "Second task" }
					]);
					return children.first.output;
				`,
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, true);
		assert.equal(mockPi.callCount(), 2);
		assert.match(result.content[0]?.text ?? "", /runs\.all resolves to an ordered array, not a key map/);
		assert.match(result.content[0]?.text ?? "", /Use results\[0\], array destructuring, or results\.map/);
		assert.deepEqual(result.details.workflow?.trace.filter((entry) => entry.state === "completed").map(({ key }) => key).sort(), ["first", "second"]);
	});

	it("keeps array access working when runs.all child keys collide with array properties", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "length child completed", matchArgIncludes: "Length task" });
		mockPi.onCall({ output: "map child completed", matchArgIncludes: "Map task" });
		const executor = makeExecutor([makeAgent("echo")]);

		const result = await executor.execute(
			"scripted-workflow-runs-all-colliding-key-access",
			{
				async: false,
				workflowScript: `
					const children = await runs.all([
						{ key: "length", agent: "echo", task: "Length task" },
						{ key: "map", agent: "echo", task: "Map task" }
					]);
					const [, second] = children;
					return {
						length: children.length,
						first: children[0].output,
						second: second.output,
						outputs: children.map((child) => child.output),
						children
					};
				`,
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, undefined, result.content[0]?.text ?? "workflow failed");
		assert.equal(mockPi.callCount(), 2);
		const value = result.details.workflow?.value as { length?: number; first?: string; second?: string; outputs?: string[]; children?: Array<{ key?: string; ok?: boolean; output?: string }> } | undefined;
		assert.equal(value?.length, 2);
		assert.equal(value?.first, "length child completed");
		assert.equal(value?.second, "map child completed");
		assert.deepEqual(value?.outputs, ["length child completed", "map child completed"]);
		assert.deepEqual(value?.children?.map(({ key, ok, output }) => ({ key, ok, output })), [
			{ key: "length", ok: true, output: "length child completed" },
			{ key: "map", ok: true, output: "map child completed" },
		]);
	});

	it("emits runs.all results as plain arrays", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "first child completed", matchArgIncludes: "First task" });
		mockPi.onCall({ output: "second child completed", matchArgIncludes: "Second task" });
		const executor = makeExecutor([makeAgent("echo")]);

		const result = await executor.execute(
			"scripted-workflow-runs-all-emitted-array",
			{
				async: false,
				workflowScript: `
					const children = await runs.all([
						{ key: "first", agent: "echo", task: "First task" },
						{ key: "second", agent: "echo", task: "Second task" }
					]);
					emit(children);
					return children.map((child) => child.output);
				`,
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, undefined, result.content[0]?.text ?? "workflow failed");
		assert.equal(mockPi.callCount(), 2);
		assert.deepEqual((result.details.workflow?.emits[0] as Array<{ key: string; output: string }>).map(({ key, output }) => ({ key, output })), [
			{ key: "first", output: "first child completed" },
			{ key: "second", output: "second child completed" },
		]);
		assert.deepEqual(result.details.workflow?.value, ["first child completed", "second child completed"]);
	});

	it("rejects an over-limit runs.all batch before launching any workflow child", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const executor = makeExecutor([makeAgent("echo")], { maxSubagentSpawnsPerRun: 1 });

		const result = await executor.execute(
			"scripted-workflow-fanout-limit",
			{
				async: false,
				workflowScript: `return await runs.all([
					{ key: "first", agent: "echo", task: "First task" },
					{ key: "second", agent: "echo", task: "Second task" }
				]);`,
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, undefined, result.content[0]?.text ?? "workflow failed");
		assert.equal(mockPi.callCount(), 0);
		const children = result.details.workflow?.value as Array<{ ok: boolean; error?: string }>;
		assert.deepEqual(children.map(({ ok }) => ok), [false, false]);
		for (const child of children) assert.match(child.error ?? "", /workflow\[second\].*0\/1 used; 2 requested, 1 remaining/);
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
						{ key: "feature-a", agent: "worker", task: "Implement A", worktree: true, lane: { version: 1, key: "feature-a", mode: "mutation", sourceRef: "owner/repo#1621", claims: ["feature-a.txt"] } },
						{ key: "feature-b", agent: "worker", task: "Implement B", worktree: true, lane: { version: 1, key: "feature-b", mode: "mutation", sourceRef: "owner/repo#1621", claims: ["feature-b.txt"] } }
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
			assert.deepEqual(result.details.workflow?.receipt?.entries["feature-a"]?.lane, { version: 1, key: "feature-a", mode: "mutation", sourceRef: "owner/repo#1621", claims: ["feature-a.txt"] });
			assert.deepEqual(result.details.workflow?.receipt?.entries["feature-b"]?.lane, { version: 1, key: "feature-b", mode: "mutation", sourceRef: "owner/repo#1621", claims: ["feature-b.txt"] });
		assert.equal(fs.existsSync(path.join(tempDir, "feature-a.txt")), false);
		assert.equal(fs.existsSync(path.join(tempDir, "feature-b.txt")), false);
		const output = result.content[0]?.text ?? "";
		const handoffPaths = [...output.matchAll(/"([^"\n]*\/handoffs\/[^"\n]+\.json)"/g)].map((match) => match[1]!);
		assert.equal(handoffPaths.length, 2, output);
		const worktreePaths = new Set<string>();
		for (const handoffPath of handoffPaths) {
			const handoff = JSON.parse(fs.readFileSync(handoffPath, "utf-8")) as {
				groups: Array<{
				children: Array<{ workflowKey: string; runId: string; lane: { key: string; mode: string; sourceRef: string; claims: string[] }; patch: { changed: boolean; path: string } }>;
					cleanup: { state: string; tasks: Array<{ path: string; worktreeRemoved: boolean; branchRemoved: boolean }> };
				}>;
			};
			assert.equal(handoff.groups.length, 1);
			assert.equal(handoff.groups[0]?.children.length, 1);
			assert.equal(handoff.groups[0]?.children[0]?.workflowKey, handoff.groups[0]?.children[0]?.lane.key);
			assert.equal(handoff.groups[0]?.children[0]?.runId?.length > 0, true);
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

	it("finalizes a workflow worktree when its child detaches for supervisor coordination", { skip: !createSubagentExecutor ? "executor unavailable" : undefined }, async () => {
		execFileSync("git", ["init"], { cwd: tempDir, stdio: "ignore" });
		execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: tempDir });
		execFileSync("git", ["config", "user.name", "Test User"], { cwd: tempDir });
		fs.writeFileSync(path.join(tempDir, "base.txt"), "base\n", "utf-8");
		execFileSync("git", ["add", "base.txt"], { cwd: tempDir });
		execFileSync("git", ["commit", "-m", "base"], { cwd: tempDir, stdio: "ignore" });
		mockPi.onCall({
			writeFiles: [{ path: "feature.txt", content: "feature\n" }],
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
		assert.match(result.content[0]?.text ?? "", /run detaches: detached/);
		const workflowValue = result.details.workflow?.value as Array<{ ok: boolean; artifactPaths: string[] }>;
		assert.equal(workflowValue[0]?.ok, false);
		const handoffPath = workflowValue[0]?.artifactPaths.find((candidate) => candidate.endsWith(".json"));
		assert.ok(handoffPath, result.content[0]?.text ?? "missing pending handoff");
		let handoff = JSON.parse(fs.readFileSync(handoffPath, "utf-8")) as {
			groups: Array<{
				children: Array<{ status: string; patch: { changed: boolean; filesChanged: number } }>;
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

		for (let attempt = 0; attempt < 150 && handoff.groups[0]?.cleanup.state !== "complete"; attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 20));
			handoff = JSON.parse(fs.readFileSync(handoffPath, "utf-8")) as typeof handoff;
		}
		assert.equal(handoff.groups[0]?.children[0]?.status, "completed");
		assert.equal(handoff.groups[0]?.children[0]?.patch.changed, true);
		assert.equal(handoff.groups[0]?.children[0]?.patch.filesChanged, 1);
		assert.equal(handoff.groups[0]?.cleanup.state, "complete");
		assert.equal(handoff.groups[0]?.cleanup.tasks[0]?.preserved, undefined);
		assert.equal(handoff.groups[0]?.cleanup.tasks[0]?.worktreeRemoved, true);
		assert.equal(handoff.groups[0]?.cleanup.tasks[0]?.branchRemoved, true);
		assert.equal(fs.existsSync(worktreePath), false);
		assert.equal(fs.existsSync(path.join(tempDir, "feature.txt")), false);
	});

	it("continues an async sequential workflow after supervisor coordination settles", { skip: !createSubagentExecutor ? "executor unavailable" : undefined }, async () => {
		execFileSync("git", ["init"], { cwd: tempDir, stdio: "ignore" });
		execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: tempDir });
		execFileSync("git", ["config", "user.name", "Test User"], { cwd: tempDir });
		fs.writeFileSync(path.join(tempDir, "base.txt"), "base\n", "utf-8");
		execFileSync("git", ["add", "base.txt"], { cwd: tempDir });
		execFileSync("git", ["commit", "-m", "base"], { cwd: tempDir, stdio: "ignore" });
		mockPi.onCall({
			matchArgIncludes: "Ask then continue",
			steps: [
				{ jsonl: [events.toolStart("contact_supervisor", { reason: "need_decision", message: "Need a decision" })] },
				{ delay: 500, jsonl: [events.assistantMessage("done after coordination")] },
			],
		});
		mockPi.onCall({ matchArgIncludes: "Use coordinated output: done after coordination", output: "tail completed" });
		const piEvents = createEventBus();
		const asyncJobs: SubagentState["asyncJobs"] = new Map();
		const executor = makeExecutor(
			[makeAgent("worker", { systemPrompt: "Intercom orchestration channel:" })],
			{},
			false,
			undefined,
			true,
			asyncJobs,
			undefined,
			undefined,
			piEvents,
		);
		let detachAccepted = false;
		piEvents.on(INTERCOM_DETACH_RESPONSE_EVENT, (payload) => {
			if ((payload as { requestId?: unknown }).requestId === "async-workflow-detach") {
				detachAccepted ||= (payload as { accepted?: unknown }).accepted === true;
			}
		});
		const detachTimer = setInterval(() => {
			if (!detachAccepted) piEvents.emit(INTERCOM_DETACH_REQUEST_EVENT, { requestId: "async-workflow-detach" });
		}, 10);
		detachTimer.unref();

		const started = await executor.execute(
			"async-scripted-workflow-detached-worktree",
			{
				workflowScript: `
					const child = await runs.run("detaches", { agent: "worker", task: "Ask then continue", worktree: true });
					const tail = await runs.run("tail", { agent: "worker", task: "Use coordinated output: " + child.output });
					return tail.output;
				`,
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		assert.equal(started.isError, undefined);
		assert.ok(started.details.asyncId);
		assert.ok(started.details.asyncDir);
		const workflowRunId = started.details.asyncId;
		const statusPath = path.join(started.details.asyncDir, "status.json");
		const resultPath = path.join(DIRS.results, `${workflowRunId}.json`);
		const activeMarkerPath = path.join(DIRS.async, ACTIVE_RUN_INDEX_DIR, workflowRunId);

		let status = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatus;
		for (let attempt = 0; attempt < 150 && status.steps?.[0]?.activityState !== "needs_attention"; attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 20));
			status = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatus;
		}
		clearInterval(detachTimer);

		assert.equal(detachAccepted, true);

		let reconciled: AsyncStatus | undefined;
		for (let attempt = 0; attempt < 150; attempt++) {
			reconciled = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatus;
			if (reconciled.state === "complete" || reconciled.state === "failed") break;
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		assert.equal(reconciled?.state, "complete", reconciled?.error);
		assert.equal(reconciled?.activityState, undefined);
		assert.equal(reconciled?.steps?.[0]?.status, "completed");
		assert.equal(reconciled?.steps?.[0]?.activityState, undefined);
		assert.equal(reconciled?.steps?.[1]?.workflowKey, "tail");
		assert.equal(reconciled?.steps?.[1]?.status, "completed");
		assert.equal(asyncJobs.get(workflowRunId)?.status, "complete");
		assert.equal(mockPi.callCount(), 2);

		const persistedResult = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as {
			state?: string;
			success?: boolean;
			activityState?: string;
			error?: string;
			results?: Array<{ workflowKey?: string; success?: boolean; output?: string; detached?: boolean; artifactPaths?: { outputPath?: string } }>;
		};
		assert.equal(persistedResult.state, "complete");
		assert.equal(persistedResult.success, true);
		assert.equal(persistedResult.activityState, undefined);
		assert.equal(persistedResult.error, undefined);
		assert.equal(persistedResult.results?.find((entry) => entry.workflowKey === "detaches")?.detached, undefined);
		assert.equal(persistedResult.results?.find((entry) => entry.workflowKey === "tail")?.output, "tail completed");
		const handoffPath = persistedResult.results?.find((entry) => entry.workflowKey === "detaches")?.artifactPaths?.outputPath;
		assert.ok(handoffPath, "missing finalized worktree handoff path");
		const handoff = JSON.parse(fs.readFileSync(handoffPath, "utf-8")) as {
			groups: Array<{
				children: Array<{ status: string; patch: { changed: boolean; filesChanged: number } }>;
				cleanup: { state: string; tasks: Array<{ path: string; worktreeRemoved: boolean; branchRemoved: boolean }> };
			}>;
		};
		assert.equal(handoff.groups[0]?.children[0]?.status, "completed");
		assert.equal(handoff.groups[0]?.children[0]?.patch.changed, false);
		assert.equal(handoff.groups[0]?.children[0]?.patch.filesChanged, 0);
		assert.equal(handoff.groups[0]?.cleanup.state, "complete");
		assert.equal(handoff.groups[0]?.cleanup.tasks[0]?.worktreeRemoved, true);
		assert.equal(handoff.groups[0]?.cleanup.tasks[0]?.branchRemoved, true);
		assert.equal(fs.existsSync(handoff.groups[0]?.cleanup.tasks[0]?.path ?? ""), false);
		assert.equal(fs.existsSync(activeMarkerPath), false);
		fs.rmSync(started.details.asyncDir, { recursive: true, force: true });
		fs.rmSync(resultPath, { force: true });
	});

	it("keeps async workflows failed when a coordinated child is mixed with a real failure", { skip: !createSubagentExecutor ? "executor unavailable" : undefined }, async () => {
		mockPi.onCall({
			matchArgIncludes: "Ask then continue",
			steps: [
				{ jsonl: [events.toolStart("contact_supervisor", { reason: "need_decision", message: "Need a decision" })] },
				{ delay: 500, jsonl: [events.assistantMessage("done after coordination")] },
			],
		});
		mockPi.onCall({ matchArgIncludes: "Fail for real", exitCode: 1, stderr: "real child failure" });
		const piEvents = createEventBus();
		const asyncJobs: SubagentState["asyncJobs"] = new Map();
		const executor = makeExecutor(
			[makeAgent("worker", { systemPrompt: "Intercom orchestration channel:" })],
			{},
			false,
			undefined,
			true,
			asyncJobs,
			undefined,
			undefined,
			piEvents,
		);
		let detachAccepted = false;
		piEvents.on(INTERCOM_DETACH_RESPONSE_EVENT, (payload) => {
			if ((payload as { requestId?: unknown }).requestId === "async-workflow-detach-with-failure") {
				detachAccepted ||= (payload as { accepted?: unknown }).accepted === true;
			}
		});
		const detachTimer = setInterval(() => {
			if (!detachAccepted) piEvents.emit(INTERCOM_DETACH_REQUEST_EVENT, { requestId: "async-workflow-detach-with-failure" });
		}, 10);
		detachTimer.unref();

		const started = await executor.execute(
			"async-scripted-workflow-detached-and-failed",
			{
				workflowScript: `
					await runs.all([
						{ key: "detaches", agent: "worker", task: "Ask then continue" },
						{ key: "fails", agent: "worker", task: "Fail for real" }
					]);
					throw new Error("manual hard failure");
				`,
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		assert.equal(started.isError, undefined);
		assert.ok(started.details.asyncId);
		assert.ok(started.details.asyncDir);
		const workflowRunId = started.details.asyncId;
		const statusPath = path.join(started.details.asyncDir, "status.json");
		const resultPath = path.join(DIRS.results, `${workflowRunId}.json`);

		let status = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatus;
		for (let attempt = 0; attempt < 150 && status.state !== "failed" && status.state !== "paused"; attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 20));
			status = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatus;
		}
		clearInterval(detachTimer);

		assert.equal(detachAccepted, true);
		assert.equal(status.state, "failed");
		assert.equal(status.activityState, undefined);
		assert.match(status.error ?? "", /manual hard failure/);
		assert.equal(status.workflow?.trace.some((entry) => entry.key === "detaches" && entry.state === "completed"), true);
		assert.equal(status.workflow?.trace.some((entry) => entry.key === "fails" && entry.state === "failed"), true);
		assert.equal(status.steps?.find((step) => step.workflowKey === "detaches")?.status, "completed");
		assert.equal(status.steps?.find((step) => step.workflowKey === "detaches")?.activityState, undefined);
		assert.equal(status.steps?.find((step) => step.workflowKey === "fails")?.status, "failed");
		assert.equal(asyncJobs.get(workflowRunId)?.status, "failed");
		assert.equal(asyncJobs.get(workflowRunId)?.activityState, undefined);

		let persistedResult = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as {
			state?: string;
			activityState?: string;
			error?: string;
			workflow?: { trace?: Array<{ key?: string; state?: string }> };
			results?: Array<{ workflowKey?: string; detached?: boolean; success?: boolean }>;
		};
		assert.equal(persistedResult.state, "failed");
		assert.equal(persistedResult.activityState, undefined);
		assert.match(persistedResult.error ?? "", /manual hard failure/);
		assert.equal(persistedResult.workflow?.trace?.some((entry) => entry.key === "detaches" && entry.state === "completed"), true);
		assert.equal(persistedResult.workflow?.trace?.some((entry) => entry.key === "fails" && entry.state === "failed"), true);
		assert.equal(persistedResult.results?.find((entry) => entry.workflowKey === "detaches")?.detached, undefined);
		assert.equal(persistedResult.results?.find((entry) => entry.workflowKey === "detaches")?.success, true);
		assert.equal(persistedResult.results?.find((entry) => entry.workflowKey === "fails")?.success, false);

		await new Promise((resolve) => setTimeout(resolve, 750));
		persistedResult = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
		assert.equal(persistedResult.state, "failed", "real workflow failure must not be overwritten by detached child completion");
		fs.rmSync(started.details.asyncDir, { recursive: true, force: true });
		fs.rmSync(resultPath, { force: true });
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
		assert.deepEqual(result.details.workflow?.receipt?.terminalOutcome, { state: "partial", reason: "budget_exhausted" });
		assert.equal(result.details.workflow?.receipt?.entries.first?.terminalOutcome, undefined);
		assert.deepEqual(result.details.workflow?.receipt?.entries.second?.terminalOutcome, { state: "partial", reason: "budget_exhausted" });
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

	it("records and renders stored lane merge evidence through management actions", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const manifestPath = path.join(tempDir, "lane-handoff.json");
		fs.writeFileSync(manifestPath, JSON.stringify({
			version: 1,
			runId: "lane-action",
			mode: "single",
			source: "async",
			cwd: tempDir,
			createdAt: 1,
			updatedAt: 1,
			groups: [{
				stepIndex: 0,
				baseCommit: "base-commit",
				repoRoot: tempDir,
				children: [{
					index: 0,
					taskIndex: 0,
					agent: "worker",
					status: "completed",
					summary: "done",
					patch: { path: path.join(tempDir, "worker.patch"), branch: "lane-action-branch", changed: false, diffStat: "", filesChanged: 0, insertions: 0, deletions: 0 },
				}],
				cleanup: { state: "partial", pruned: false, tasks: [{ index: 0, path: path.join(tempDir, "worktree"), branch: "lane-action-branch", worktreeRemoved: false, branchRemoved: false, preserved: true }] },
			}],
		}, null, 2), "utf-8");
		const executor = makeExecutor([makeAgent("echo")]);
		const merge = {
			prNumber: 1623,
			reviewedHead: "8888888888888888888888888888888888888888",
			mergeCommit: "9999999999999999999999999999999999999999",
			treeEquivalent: true,
			postMergeChecks: "recorded",
			attestedBy: "nicobailon",
			attestedAt: "2026-08-27T16:23:00.000Z",
		};

		const recorded = await executor.execute(
			"lane-record-action",
			{ action: "lane.recordMerge", laneId: "lane-action", handoffPath: manifestPath, merge },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		assert.equal(recorded.isError, undefined, recorded.content[0]?.text ?? "");
		assert.match(recorded.content[0]?.text ?? "", /Cleanup eligibility: terminal-eligible/);
		assert.equal(recorded.details.parallelHandoff?.cleanupEligibility?.state, "terminal-eligible");

		const rendered = await executor.execute(
			"lane-status-action",
			{ action: "lane.status", laneId: "lane-action", handoffPath: manifestPath },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		assert.equal(rendered.isError, undefined, rendered.content[0]?.text ?? "");
		assert.match(rendered.content[0]?.text ?? "", /Cleanup eligibility: terminal-eligible/);
		assert.match(rendered.content[0]?.text ?? "", /action: "worktree\.cleanup"/);

		const invalid = await executor.execute(
			"lane-invalid-action",
			{ action: "lane.recordMerge", laneId: "lane-action", handoffPath: manifestPath },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		assert.equal(invalid.isError, true);
		assert.match(invalid.content[0]?.text ?? "", /merge must be an object/);
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
			const previousChildEnv = process.env[SUBAGENT_CHILD_ENV];
			delete process.env[SUBAGENT_CHILD_ENV];
			try {
				registerSubagentExtension(fakePi as never);
			} finally {
				if (previousChildEnv === undefined) delete process.env[SUBAGENT_CHILD_ENV];
				else process.env[SUBAGENT_CHILD_ENV] = previousChildEnv;
			}
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

	it("qualifies inherited nested claims with the generated nested run id", async () => {
		mockPi.onCall({ output: "nested completed" });
		const descriptor = createRunFanoutBudget("root-run", 2);
		const previous = process.env[RUN_FANOUT_BUDGET_ENV];
		try {
			process.env[RUN_FANOUT_BUDGET_ENV] = encodeRunFanoutBudgetDescriptor({ ...descriptor, parentPath: "tasks[0]" });
			const executor = makeExecutor([makeAgent("echo")]);
			const result = await executor.execute("nested", { agent: "echo", task: "Nested work" }, new AbortController().signal, undefined, makeMinimalCtx(tempDir));

			assert.equal(result.isError, undefined, result.content[0]?.text ?? "nested run failed");
			const claims = fs.readdirSync(path.join(descriptor.directory, "claims"));
			assert.equal(claims.length, 1);
			const claim = JSON.parse(fs.readFileSync(path.join(descriptor.directory, "claims", claims[0]!), "utf-8")) as { path: string };
			assert.match(claim.path, /^tasks\[0\]\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/single$/);
		} finally {
			if (previous === undefined) delete process.env[RUN_FANOUT_BUDGET_ENV];
			else process.env[RUN_FANOUT_BUDGET_ENV] = previous;
			fs.rmSync(descriptor.directory, { recursive: true, force: true });
		}
	});

	it("rejects an over-limit static run fan-out before creating session artifacts", async () => {
		const sessionDir = path.join(tempDir, "run-fanout-preflight");
		const executor = makeExecutor([makeAgent("echo"), makeAgent("second")], { maxSubagentSpawnsPerRun: 1 });
		const result = await executor.execute(
			"run-fanout-preflight",
			{ tasks: [{ agent: "echo", task: "First" }, { agent: "second", task: "Second" }], sessionDir },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /Run fan-out limit reached at tasks\[1\] \(0\/1 used; 2 requested, 1 remaining\)/);
		assert.deepEqual(result.details.runFanoutBudget, { used: 0, limit: 1, remaining: 1 });
		assert.equal(result.details.runFanoutRejection?.path, "tasks[1]");
		assert.equal(fs.existsSync(sessionDir), false);
		assert.equal(mockPi.callCount(), 0);
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

	it("creates a plan-only worktree cleanup action without removing managed state", { skip: !createSubagentExecutor ? "executor not importable" : process.platform === "win32" ? "worktree paths differ on Windows" : undefined }, async () => {
		const repo = path.join(tempDir, "cleanup-repo");
		const baseDir = path.join(tempDir, "cleanup-worktrees");
		fs.mkdirSync(repo, { recursive: true });
		execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
		execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
		execFileSync("git", ["config", "user.name", "Test User"], { cwd: repo });
		fs.writeFileSync(path.join(repo, "base.txt"), "base\n", "utf-8");
		execFileSync("git", ["add", "base.txt"], { cwd: repo });
		execFileSync("git", ["commit", "-m", "base"], { cwd: repo, stdio: "ignore" });
		const setup = createWorktrees(repo, "action", 1, { baseDir });
		const worktree = setup.worktrees[0]!;
		const manifestPath = path.join(repo, ".pi", "subagents", "artifacts", "handoff.json");
		const baseCommit = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf-8" }).trim();
		fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
		fs.writeFileSync(manifestPath, JSON.stringify({
			version: 1,
			runId: "cleanup-action-run",
			mode: "parallel",
			source: "async",
			cwd: repo,
			createdAt: 1,
			updatedAt: 1,
			groups: [{
				stepIndex: 0,
				baseCommit,
				repoRoot: repo,
				children: [{
					index: 0,
					taskIndex: 0,
					agent: "worker",
					status: "completed",
					summary: "done",
					patch: { path: path.join(repo, ".pi", "subagents", "artifacts", "worktree.patch"), branch: worktree.branch, changed: false, diffStat: "", filesChanged: 0, insertions: 0, deletions: 0 },
				}],
				cleanup: { state: "partial", pruned: false, tasks: [{ index: 0, path: worktree.path, branch: worktree.branch, worktreeRemoved: false, branchRemoved: false, preserved: true }] },
			}],
		}, null, 2), "utf-8");
		fs.writeFileSync(path.join(repo, ".pi", "subagents", "artifacts", "status.json"), JSON.stringify({ runId: "cleanup-action-run", state: "complete" }), "utf-8");
		try {
			const executor = makeExecutor([makeAgent("echo")], { worktreeBaseDir: baseDir });
			const result = await executor.executePublic("cleanup-plan", { action: "worktree.cleanup", repo: "cleanup-repo", mode: "plan" }, new AbortController().signal, undefined, makeMinimalCtx(tempDir));
			assert.equal(result.isError, undefined, result.content[0]?.text ?? "cleanup plan failed");
			const text = result.content[0]?.text ?? "";
			assert.match(text, /Will remove/);
			assert.match(text, /Plan-only mode: no worktrees or branches were removed/);
			const planFiles = fs.readdirSync(path.join(repo, ".pi", "subagents", "cleanup-plans"));
			assert.equal(planFiles.length, 1);
			const planId = planFiles[0]!.replace(/\.json$/, "");
			const childSafe = makeExecutor([makeAgent("echo")], { worktreeBaseDir: baseDir }, false, undefined, false);
			const childSafeResult = await childSafe.executePublic("cleanup-child-safe", { action: "worktree.cleanup", repo: "cleanup-repo", mode: "plan" }, new AbortController().signal, undefined, makeMinimalCtx(tempDir));
			assert.equal(childSafeResult.isError, true);
			assert.match(childSafeResult.content[0]?.text ?? "", /child-safe subagent fanout mode/i);
			const apply = await executor.executePublic("cleanup-apply", { action: "worktree.cleanup", repo: "cleanup-repo", mode: "apply", planId }, new AbortController().signal, undefined, makeMinimalCtx(tempDir));
			assert.equal(apply.isError, true);
			assert.match(apply.content[0]?.text ?? "", /plan.*only|apply\/removal is not available/i);
			assert.ok(fs.existsSync(worktree.path));
			assert.notEqual(execFileSync("git", ["-C", repo, "branch", "--list", worktree.branch], { encoding: "utf-8" }).trim(), "");
		} finally {
			try { execFileSync("git", ["-C", repo, "worktree", "remove", "--force", worktree.path], { stdio: "ignore" }); } catch {}
			try { execFileSync("git", ["-C", repo, "branch", "-D", worktree.branch], { stdio: "ignore" }); } catch {}
		}
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
		assert.deepEqual(result.usage, { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 } });
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
			getSubagentSessionRoot: () => path.join(tempDir, ".pi/subagents", "sessions"),
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

	it("rejects implementation runs without mutation-capable tools before spawn", async () => {
		mockPi.onCall({ output: "should not spawn" });
		const agents = [makeAgent("worker", { tools: ["read", "grep", "find", "ls", "contact_supervisor"] })];

		const result = await runSync(tempDir, agents, "worker", "Implement the approved file changes", {
			runId: "readonly-contract-run",
		});

		assert.equal(result.exitCode, 1);
		assert.match(result.error ?? "", /no mutation-capable tools/);
		assert.equal(mockPi.callCount(), 0);
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

	it("preserves terminal empty-output diagnostics after useful foreground work", async () => {
		const partialOutput = "I’ll inspect the retained candidate before changing it.";
		mockPi.onCall({
			jsonl: [
				events.toolStart("read", { path: "src/index.ts" }),
				events.toolEnd("read"),
				events.toolResult("read", "file contents"),
				events.assistantMessage(partialOutput),
				{
					type: "message_end",
					message: {
						role: "assistant",
						content: [],
						model: "mock/test-model",
						stopReason: "aborted",
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
					},
				},
			],
			exitCode: 0,
		});

		const result = await runSync(tempDir, [makeAgent("worker")], "worker", "Implement the approved file changes", {
			runId: "foreground-aborted-empty-output",
		});

		assert.equal(result.exitCode, 1);
		assert.match(result.error ?? "", /^Subagent produced no output after terminal assistant stopReason "aborted"\./);
		assert.doesNotMatch(result.error ?? "", /completed without making edits/);
		assert.equal(result.finalOutput, partialOutput);
	});

	it("reports why an unsafe foreground compaction abort cannot resume without falling back", async () => {
		mockPi.onCall({
			jsonl: [
				events.toolStart("read", { path: "src/index.ts" }),
				events.toolEnd("read"),
				events.toolResult("read", "file contents"),
				{ type: "compaction_start" },
				{
					type: "message_end",
					message: {
						role: "assistant",
						content: [],
						model: "mock/test-model",
						stopReason: "aborted",
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
					},
				},
				{ type: "agent_settled" },
			],
			exitCode: 0,
		});
		mockPi.onCall({ output: "Fallback must not run" });

		const result = await runSync(tempDir, [makeAgent("worker", { model: "mock/test-model", fallbackModels: ["mock/fallback-model"] })], "worker", "Inspect the current source", {
			runId: "foreground-compaction-abort-no-session",
		});

		assert.equal(result.exitCode, 1);
		assert.match(result.error ?? "", /^Subagent produced no output after terminal assistant stopReason "aborted"\./);
		assert.match(result.error ?? "", /Compaction-induced child abort could not be resumed safely: retained session unavailable\./);
		assert.equal(mockPi.callCount(), 1);
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

	it("applies explicit structured-output contract fields when resuming a foreground workflow child", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const schema = { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } };
		const firstSchema = { type: "object", required: ["first"], properties: { first: { type: "boolean" } } };
		const firstEvents = [
			{ type: "tool_execution_start", toolName: "structured_output", args: { value: { first: true } } },
			{ type: "tool_result_end", message: { role: "toolResult", toolName: "structured_output", content: [{ type: "text", text: "Structured output captured." }] } },
			{ type: "tool_execution_end", toolName: "structured_output" },
		];
		const resumedEvents = [
			{ type: "tool_execution_start", toolName: "structured_output", args: { value: { ok: true } } },
			{ type: "tool_result_end", message: { role: "toolResult", toolName: "structured_output", content: [{ type: "text", text: "Structured output captured." }] } },
			{ type: "tool_execution_end", toolName: "structured_output" },
		];
		mockPi.onCall({ stdoutRaw: firstEvents.map((entry) => JSON.stringify(entry)).join("\n") + "\n", structuredOutputCapture: { first: true } });
		mockPi.onCall({ stdoutRaw: resumedEvents.map((entry) => JSON.stringify(entry)).join("\n") + "\n", structuredOutputCapture: { ok: true } });
		const result = await makeExecutor([makeAgent("echo")]).execute(
			"workflow-explicit-resume-schema",
			{
				async: false,
				workflowScript: `
					const first = await runs.run("first", { agent: "echo", task: "First", outputSchema: ${JSON.stringify(firstSchema)}, agentContract: { version: 1 }, acceptance: false, output: true });
					return runs.run("resumed", { resume: first.runId, task: "Resume", outputSchema: ${JSON.stringify(schema)}, agentContract: { version: 1 }, acceptance: false, output: false });
				`,
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, undefined, result.content[0]?.text ?? "workflow failed");
		const resumed = result.details.workflow?.value as { ok?: boolean; structuredOutput?: unknown; savedOutputPath?: string };
		assert.equal(resumed.ok, true);
		assert.deepEqual(resumed.structuredOutput, { ok: true });
		assert.equal(resumed.savedOutputPath, undefined);
	});

	it("preserves the structured-output contract when resume fields are omitted", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const schema = { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } };
		const structuredEvents = [
			{ type: "tool_execution_start", toolName: "structured_output", args: { value: { ok: true } } },
			{ type: "tool_result_end", message: { role: "toolResult", toolName: "structured_output", content: [{ type: "text", text: "Structured output captured." }] } },
			{ type: "tool_execution_end", toolName: "structured_output" },
		];
		mockPi.onCall({ stdoutRaw: structuredEvents.map((entry) => JSON.stringify(entry)).join("\n") + "\n", structuredOutputCapture: { ok: true } });
		mockPi.onCall({ stdoutRaw: structuredEvents.map((entry) => JSON.stringify(entry)).join("\n") + "\n", structuredOutputCapture: { ok: true } });
		const result = await makeExecutor([makeAgent("echo")]).execute(
			"workflow-inherited-resume-schema",
			{
				async: false,
				workflowScript: `
					const first = await runs.run("first", { agent: "echo", task: "First", outputSchema: ${JSON.stringify(schema)}, agentContract: { version: 1 }, acceptance: false, output: false });
					return runs.run("resumed", { resume: first.runId, task: "Resume" });
				`,
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, undefined, result.content[0]?.text ?? "workflow failed");
		const resumed = result.details.workflow?.value as { ok?: boolean; structuredOutput?: unknown };
		assert.equal(resumed.ok, true);
		assert.deepEqual(resumed.structuredOutput, { ok: true });
	});

	it("auto-resumes a workflow child after a setup abort", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({
			jsonl: [
				events.toolStart("read", { path: "src/index.ts" }),
				events.toolEnd("read"),
				events.toolResult("read", "file contents"),
				{
					type: "message_end",
					message: {
						role: "assistant",
						content: [],
						model: "openai-codex/gpt-5.6-luna",
						stopReason: "error",
						errorMessage: "This operation was aborted",
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
					},
				},
			],
			exitCode: 1,
		});
		mockPi.onCall({ output: "Recovered after workflow auto-resume" });

		const result = await makeExecutor([makeAgent("echo")]).execute(
			"workflow-auto-resume-setup-abort",
			{
				async: false,
				workflowScript: `return runs.run("review", { agent: "echo", task: "Review the current diff", acceptance: false });`,
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, undefined, result.content[0]?.text ?? "workflow failed");
		const child = result.details.workflow?.value as { ok?: boolean; runId?: string; output?: string; continuation?: { runIds?: string[] } };
		assert.equal(child.ok, true);
		assert.match(child.output ?? "", /Recovered after workflow auto-resume/u);
		assert.deepEqual(result.details.results[0]?.usage, { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0.001, turns: 1 });
		// The workflow-level setup recovery is a distinct launch, so its receipt
		// retains both the failed source run and the resumed child run. The
		// compaction planner no longer hides this source by resuming it first.
		assert.equal(child.continuation?.runIds?.length, 2);
		assert.notEqual(child.continuation?.runIds?.[0], child.runId);
		assert.equal(child.continuation?.runIds?.at(-1), child.runId);
		assert.equal(mockPi.callCount(), 2);
	});

	it("preserves an agent default output contract when foreground workflow resume omits output", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const configuredOutput = path.join(tempDir, "configured-resume-output.md");
		const agent = makeAgent("echo", { output: configuredOutput, outputMode: "file-only" });
		const executor = makeExecutor([agent]);
		mockPi.onCall({ output: "first report" });
		mockPi.onCall({ output: "resumed report" });

		const firstResult = await executor.execute(
			"workflow-agent-output-first",
			{ async: false, workflowScript: `return runs.run("first", { agent: "echo", task: "First", acceptance: false });` },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		assert.equal(firstResult.isError, undefined, firstResult.content[0]?.text ?? "workflow failed");
		const first = firstResult.details.workflow?.value as { runId?: string };
		const firstChild = firstResult.details.results[0];
		assert.ok(first.runId);
		assert.equal(firstChild?.savedOutputPath, configuredOutput);
		assert.equal(firstChild?.outputMode, "file-only");

		agent.output = undefined;
		agent.outputMode = undefined;
		const resumedResult = await executor.execute(
			"workflow-agent-output-resumed",
			{ async: false, workflowScript: `return runs.run("resumed", { resume: ${JSON.stringify(first.runId)}, task: "Resume" });` },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(resumedResult.isError, undefined, resumedResult.content[0]?.text ?? "workflow failed");
		const resumed = resumedResult.details.results[0];
		assert.match(resumed?.finalOutput ?? "", new RegExp(`Output saved to: ${escapeRegExp(configuredOutput)}`));
		assert.equal(fs.readFileSync(configuredOutput, "utf-8"), "resumed report");
	});

	it("preserves failed foreground resume errors and transcript metadata", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const executor = makeExecutor([makeAgent("echo")]);
		mockPi.onCall({ output: "first report" });
		const firstResult = await executor.execute(
			"workflow-resume-failure-first",
			{ async: false, workflowScript: `return runs.run("first", { agent: "echo", task: "First" });` },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		assert.equal(firstResult.isError, undefined, firstResult.content[0]?.text ?? "workflow failed");
		const first = firstResult.details.workflow?.value as { runId?: string };
		assert.ok(first.runId);

		const partialOutput = "I’ll re-read the current implementation before changing it.";
		mockPi.onCall({ output: partialOutput });
		const resumedResult = await executor.execute(
			"workflow-resume-failure-resumed",
			{ async: false, workflowScript: `return runs.run("resumed", { resume: ${JSON.stringify(first.runId)}, task: "Implement the approved file changes" });` },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(resumedResult.isError, true);
		const resumedText = resumedResult.content.map((part) => part.type === "text" ? part.text : "").join("\n");
		assert.match(resumedText, /Subagent completed without making edits for an implementation task/);
		assert.doesNotMatch(resumedText, new RegExp(`^${escapeRegExp(partialOutput)}`));
		const child = resumedResult.details.results[0];
		assert.equal(child?.finalOutput, partialOutput);
		assert.match(child?.error ?? "", /Subagent completed without making edits for an implementation task/);
		assert.ok(child?.transcriptPath);
		assert.equal(child?.transcriptPath, child?.artifactPaths?.transcriptPath);
		assert.ok(child?.artifactPaths?.outputPath);
		assert.match(fs.readFileSync(child.transcriptPath, "utf-8"), /first|re-read|implementation/i);
	});

	it("fails closed on an invalid explicit foreground resume output schema", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "first result" });
		const result = await makeExecutor([makeAgent("echo")]).execute(
			"workflow-invalid-explicit-resume-schema",
			{
				async: false,
				workflowScript: `
					const first = await runs.run("first", { agent: "echo", task: "First" });
					return runs.run("resumed", { resume: first.runId, task: "Resume", outputSchema: null });
				`,
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /outputSchema must be a JSON Schema object/);
		assert.equal(mockPi.callCount(), 1);
	});

	it("workflow children with outputSchema can satisfy inherited checked acceptance", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const acceptanceReport = {
			criteriaSatisfied: [{ id: "proof", status: "satisfied", evidence: "structured output returned ok true" }],
			changedFiles: ["none"],
			testsAddedOrUpdated: ["none"],
			commandsRun: [{ command: "not run", result: "not-run", summary: "mock structured-output child" }],
			validationOutput: ["mock output validated"],
			residualRisks: ["none"],
			noStagedFiles: true,
			diffSummary: "no file changes",
		};
		mockPi.onCall({
			stdoutRaw: [
				{ type: "tool_execution_start", toolName: "structured_output", args: { value: { ok: true }, acceptanceReport } },
				{ type: "tool_result_end", message: { role: "toolResult", toolName: "structured_output", content: [{ type: "text", text: "Structured output captured." }] } },
				{ type: "tool_execution_end", toolName: "structured_output" },
			].map((entry) => JSON.stringify(entry)).join("\n") + "\n",
			structuredOutputCapture: { ok: true },
			structuredOutputAcceptanceReport: acceptanceReport,
		});
		const executor = makeExecutor([makeAgent("echo")]);

		const result = await executor.execute(
			"workflow-schema-acceptance-sidecar",
			{
				async: false,
				acceptance: { level: "checked", criteria: [{ id: "proof", must: "Return required proof" }] },
				workflowScript: `
					const child = await runs.run("schema", {
						agent: "echo",
						task: "Return structured data",
						outputSchema: { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } }
					});
					if (!child.ok) throw new Error(child.error);
					return child;
				`,
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		const child = result.details.results[0];
		assert.equal(result.isError, undefined, result.content[0]?.text ?? "workflow failed");
		assert.deepEqual(child?.structuredOutput, { ok: true });
		assert.equal(child?.acceptance?.status, "checked");
		assert.equal(child?.acceptance?.runtimeChecks.some((check) => check.status === "failed"), false);
	});

	it("rejects workflow outputSchema children that omit checked acceptance sidecars", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({
			stdoutRaw: [
				{ type: "tool_execution_start", toolName: "structured_output", args: { value: { ok: true } } },
				{ type: "tool_result_end", message: { role: "toolResult", toolName: "structured_output", content: [{ type: "text", text: "Structured output captured." }] } },
				{ type: "tool_execution_end", toolName: "structured_output" },
			].map((entry) => JSON.stringify(entry)).join("\n") + "\n",
			structuredOutputCapture: { ok: true },
		});
		const executor = makeExecutor([makeAgent("echo")]);

		const result = await executor.execute(
			"workflow-schema-acceptance-missing-sidecar",
			{
				async: false,
				acceptance: { level: "checked", criteria: [{ id: "proof", must: "Return required proof" }] },
				workflowScript: `
					const child = await runs.run("schema", {
						agent: "echo",
						task: "Return structured data",
						outputSchema: { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } }
					});
					if (!child.ok) throw new Error(child.error);
					return child;
				`,
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		const child = result.details.results[0];
		assert.equal(result.isError, true);
		assert.equal(child?.exitCode, 1);
		assert.equal(child?.structuredOutput?.ok, true);
		assert.equal(child?.acceptance?.status, "rejected");
		assert.match(result.content[0]?.text ?? "", /acceptance/i);
	});

	it("surfaces corrupt outputSchema acceptance sidecar read errors", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({
			stdoutRaw: [
				{ type: "tool_execution_start", toolName: "structured_output", args: { value: { ok: true } } },
				{ type: "tool_result_end", message: { role: "toolResult", toolName: "structured_output", content: [{ type: "text", text: "Structured output captured." }] } },
				{ type: "tool_execution_end", toolName: "structured_output" },
			].map((entry) => JSON.stringify(entry)).join("\n") + "\n",
			structuredOutputCapture: { ok: true },
			structuredOutputAcceptanceReportRaw: "{not-json",
		});
		const executor = makeExecutor([makeAgent("echo")]);

		const result = await executor.execute(
			"workflow-schema-acceptance-corrupt-sidecar",
			{
				async: false,
				acceptance: { level: "checked", criteria: [{ id: "proof", must: "Return required proof" }] },
				workflowScript: `
					const child = await runs.run("schema", {
						agent: "echo",
						task: "Return structured data",
						outputSchema: { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } }
					});
					if (!child.ok) throw new Error(child.error);
					return child;
				`,
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		const child = result.details.results[0];
		assert.equal(result.isError, true);
		assert.equal(child?.structuredOutput?.ok, true);
		assert.match(child?.error ?? "", /Failed to read structured output acceptance report/);
		assert.doesNotMatch(child?.error ?? "", /Structured acceptance report not found/);
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
			{ agent: "echo", task: "Return structured data", outputSchema: { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } }, acceptance: false },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		const child = result.details?.results?.[0];
		assert.equal(result.isError, undefined);
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

	it("returns error for unknown agent without retaining the prompt", async () => {
		const agents = makeAgentConfigs(["echo"]);
		const sentinel = "PROMPT_AUDIT_SENTINEL_UNKNOWN";
		const result = await runSync(tempDir, agents, "nonexistent", sentinel, {});

		assert.equal(result.exitCode, 1);
		assert.match(result.error ?? "", /^Unknown agent: nonexistent\nEffective cwd: /);
		assert.match(result.error ?? "", /Consulted agent-definition directories:[\s\S]*Discovered agents:/);
		assert.doesNotMatch(result.error ?? "", /echo \(project\)/);
		assert.equal(result.task, "[prompt redacted]");
		assert.doesNotMatch(JSON.stringify(result), new RegExp(sentinel));
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

	it("surfaces a non-retryable provider failure when the child produced no output", async () => {
		mockPi.onCall({
			jsonl: [{
				type: "message_end",
				message: {
					role: "assistant",
					content: [],
					model: "openai/gpt-5-mini",
					errorMessage: "Invalid request: malformed payload",
					usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
				},
			}],
			exitCode: 1,
		});
		const executor = makeExecutor([makeAgent("echo", { model: "openai/gpt-5-mini" })]);

		const result = await executor.execute(
			"non-retryable-provider-failure",
			{ agent: "echo", task: "Task", async: false, acceptance: false },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /Invalid request: malformed payload/u);
		assert.match(result.details.results[0]?.error ?? "", /Invalid request: malformed payload/u);
		assert.equal(mockPi.callCount(), 1);
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

	it("escalates to file task delivery after a zero-activity SIGKILL startup exit", { skip: process.platform === "win32" ? "POSIX child signal reporting is unavailable on Windows" : false }, async () => {
		mockPi.onCall({ signal: "SIGKILL" });
		mockPi.onCall({ output: "Recovered via file delivery" });
		const agents = [makeAgent("worker", { model: "openai/gpt-5-mini" })];

		const result = await runSync(tempDir, agents, "worker", "Do work", {
			runId: "startup-sigkill-file-delivery-sync",
			acceptance: false,
		});

		assert.equal(result.exitCode, 0);
		assert.equal(result.finalOutput, "Recovered via file delivery");
		assert.equal(mockPi.callCount(), 2);
		const [firstArgs, retryArgs] = readAllCallArgs();
		assert.ok(firstArgs?.includes("Task: Do work"), "first attempt should deliver the task inline");
		const retryTaskArg = retryArgs?.at(-1) ?? "";
		assert.ok(
			retryTaskArg.startsWith("@") && retryTaskArg.endsWith("task.md"),
			`retry should reference a task file instead of inline argv, got: ${retryTaskArg}`,
		);
		assert.match(result.progress.recentOutput.join("\n"), /\[startup-retry\].*file task delivery/i);
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

	it("stops model fallback and flags contextOverflow when the input exceeds the context window", async () => {
		mockPi.onCall({ output: "", stderr: "This model's maximum context length is 8192 tokens", exitCode: 1 });
		mockPi.onCall({ output: "must not run" });
		const agents = [makeAgent("worker", {
			model: "openai/gpt-5-mini",
			fallbackModels: ["anthropic/claude-sonnet-4"],
		})];

		const result = await runSync(tempDir, agents, "worker", "Summarize a huge file", {
			runId: "context-overflow-stops-fallback",
			acceptance: false,
		});

		assert.equal(result.exitCode, 1);
		assert.equal(result.contextOverflow, true);
		assert.equal(result.modelAttempts?.length, 1);
		assert.equal(mockPi.callCount(), 1);
		assert.ok(result.error?.includes("context"), "error should mention context overflow");
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

	it("fails when a configured provider-qualified model starts on a different child model", async () => {
		mockPi.onCall({ jsonl: [events.assistantMessage("wrong provider", "openai-codex/gpt-5.6-sol")] });
		const agents = [makeAgent("echo", { model: "opencode-go/ox-alpha-free:max" })];

		const result = await runSync(tempDir, agents, "echo", "Task", {
			runId: "foreground-model-verification-mismatch",
			acceptance: false,
			availableModels: [
				{ provider: "opencode-go", id: "ox-alpha-free", fullId: "opencode-go/ox-alpha-free" },
				{ provider: "openai-codex", id: "gpt-5.6-sol", fullId: "openai-codex/gpt-5.6-sol" },
			],
		});

		assert.equal(result.exitCode, 1);
		assert.equal(result.model, "opencode-go/ox-alpha-free:max");
		assert.deepEqual(result.attemptedModels, ["opencode-go/ox-alpha-free:max"]);
		assert.match(result.error ?? "", /model_verification_failed/);
		assert.match(result.error ?? "", /Expected 'opencode-go\/ox-alpha-free:max'/);
		assert.match(result.error ?? "", /observed 'openai-codex\/gpt-5\.6-sol'/);
		assert.equal(result.modelAttempts?.[0]?.success, false);
		assert.match(result.modelAttempts?.[0]?.error ?? "", /model_verification_failed/);
		const args = readAllCallArgs()[0]!;
		assert.equal(args[args.indexOf("--model") + 1], "opencode-go/ox-alpha-free:max");
		assert.equal(mockPi.callCount(), 1);
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

	it("rejects an unresolved agent model before spawning Pi", async () => {
		const agents = [makeAgent("echo", { model: "fast" })];

		await assert.rejects(
			runSync(tempDir, agents, "echo", "Task", {
				availableModels: [{ provider: "openai", id: "gpt-5-mini", fullId: "openai/gpt-5-mini" }],
			}),
			/Unknown subagent model 'fast'/,
		);
		assert.equal(mockPi.callCount(), 0);
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

	it("does not drain on settlement from a compaction attempt that will retry", async () => {
		mockPi.onCall({ steps: [
			{ jsonl: [{ type: "compaction_end", willRetry: true }, { type: "agent_settled" }] },
			{ delay: 1400, jsonl: [events.assistantMessage("settled after compaction retry"), { type: "agent_start" }, { type: "agent_end", willRetry: false }, { type: "agent_settled" }] },
		] });
		const startedAt = Date.now();
		const result = await runSync(tempDir, makeAgentConfigs(["echo"]), "echo", "Retry after compaction", { acceptance: false });
		assert.equal(result.exitCode, 0);
		assert.equal(getFinalOutput(result.messages), "settled after compaction retry");
		assert.ok(Date.now() - startedAt >= 1200, "foreground runner must not terminate during compaction retry");
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

	it("does not retry raw connection stderr after child activity", async () => {
		mockPi.onCall({
			jsonl: [events.assistantMessage("completed side effect", "openai/gpt-5-mini")],
			stderr: "APIConnectionError: Connection closed.",
			exitCode: 1,
		});
		mockPi.onCall({ output: "fallback must not run" });
		const agents = [makeAgent("echo", {
			model: "openai/gpt-5-mini",
			fallbackModels: ["anthropic/claude-sonnet-4"],
		})];

		const result = await runSync(tempDir, agents, "echo", "Task", {
			runId: "no-fallback-raw-stderr",
		});

		assert.equal(result.exitCode, 1);
		assert.match(result.error ?? "", /Connection closed/u);
		assert.equal(result.modelAttempts?.length, 1);
		assert.equal(mockPi.callCount(), 1);
	});

	it("does not use compaction recovery for a generic empty assistant abort after a compaction retry", async () => {
		const sessionFile = path.join(tempDir, "generic-empty-after-compaction-retry-session.jsonl");
		mockPi.onCall({
			jsonl: [
				{ type: "compaction_start" },
				{ type: "compaction_end", willRetry: true },
				{ type: "agent_settled" },
				{ type: "agent_start" },
				events.assistantMessage("The compaction retry produced useful output.", "openai/gpt-5-mini"),
				{ type: "agent_settled" },
				{
					type: "message_end",
					message: {
						role: "assistant",
						content: [],
						model: "openai/gpt-5-mini",
						stopReason: "aborted",
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
					},
				},
				{ type: "agent_settled" },
			],
			writeFiles: [{ path: sessionFile, content: "{}\n" }],
			exitCode: 0,
		});
		mockPi.onCall({ output: "Compaction recovery must not run" });
		const agents = [makeAgent("echo", { model: "openai/gpt-5-mini" })];

		const result = await runSync(tempDir, agents, "echo", "Task", {
			runId: "no-compaction-recovery-after-compaction-retry",
			sessionFile,
		});

		assert.equal(result.exitCode, 1);
		assert.match(result.error ?? "", /Subagent produced no output after terminal assistant stopReason "aborted"\./u);
		assert.equal(result.modelAttempts?.length, 1);
		assert.equal(mockPi.callCount(), 1);
	});

	it("does not use compaction recovery after compaction_end willRetry false and a continued agent turn", async () => {
		const sessionFile = path.join(tempDir, "generic-empty-after-successful-compaction-session.jsonl");
		mockPi.onCall({
			jsonl: [
				{ type: "compaction_start" },
				{ type: "compaction_end", willRetry: false },
				{ type: "agent_start" },
				{
					type: "message_end",
					message: {
						role: "assistant",
						content: [],
						model: "openai/gpt-5-mini",
						stopReason: "aborted",
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
					},
				},
				{ type: "agent_settled" },
			],
			writeFiles: [{ path: sessionFile, content: "{}\n" }],
			exitCode: 0,
		});
		mockPi.onCall({ output: "Compaction recovery must not run" });
		const agents = [makeAgent("echo", { model: "openai/gpt-5-mini" })];

		const result = await runSync(tempDir, agents, "echo", "Task", {
			runId: "no-compaction-recovery-after-successful-compaction",
			sessionFile,
		});

		assert.equal(result.exitCode, 1);
		assert.match(result.error ?? "", /Subagent produced no output after terminal assistant stopReason "aborted"\./u);
		assert.equal(result.modelAttempts?.length, 1);
		assert.equal(mockPi.callCount(), 1);
	});

	it("does not use compaction recovery for a generic provider abort after normal settlement", async () => {
		const sessionFile = path.join(tempDir, "generic-provider-after-compaction-session.jsonl");
		mockPi.onCall({
			jsonl: [
				{ type: "compaction_start" },
				events.assistantMessage("Compaction completed and the child settled normally.", "openai/gpt-5-mini"),
				{ type: "agent_settled" },
			],
			writeFiles: [{ path: sessionFile, content: "{}\n" }],
			stderr: "APIConnectionError: Connection reset by provider transport.",
			exitCode: 1,
		});
		mockPi.onCall({ output: "Compaction recovery must not run" });
		const agents = [makeAgent("echo", {
			model: "openai/gpt-5-mini",
			fallbackModels: ["anthropic/claude-sonnet-4"],
		})];

		const result = await runSync(tempDir, agents, "echo", "Task", {
			runId: "no-compaction-recovery-after-normal-settlement",
			sessionFile,
		});

		assert.equal(result.exitCode, 1);
		assert.match(result.error ?? "", /Connection reset by provider transport/u);
		assert.equal(result.modelAttempts?.length, 1);
		assert.equal(mockPi.callCount(), 1);
	});

	it("resumes the retained session once after a compaction-induced abort following completed tool work", async () => {
		const sessionFile = path.join(tempDir, "abort-recovery-session.jsonl");
		mockPi.onCall({
			jsonl: [
				events.toolStart("write", { path: "side-effect.txt", content: "done" }),
				events.toolEnd("write"),
				events.toolResult("write", "Wrote side-effect.txt"),
				{ type: "compaction_start" },
				{
					type: "message_end",
					message: {
						role: "assistant",
						content: [],
						model: "openai/gpt-5-mini",
						stopReason: "aborted",
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
					},
				},
				{ type: "agent_settled" },
			],
			writeFiles: [{ path: "side-effect.txt", content: "done" }, { path: sessionFile, content: "{}\n" }],
			keepAliveAfterFinalMessageMs: 5_000,
			exitCode: 0,
		});
		mockPi.onCall({ output: "Recovered from retained session" });
		const agents = [makeAgent("echo", {
			model: "openai/gpt-5-mini",
			fallbackModels: ["anthropic/claude-sonnet-4"],
		})];

		const result = await runSync(tempDir, agents, "echo", "Task", {
			runId: "resume-provider-after-tool",
			sessionFile,
		});

		assert.equal(result.exitCode, 0);
		assert.equal(result.finalOutput, "Recovered from retained session");
		assert.deepEqual(result.attemptedModels, ["openai/gpt-5-mini"]);
		assert.deepEqual(result.modelAttempts?.map((attempt) => attempt.success), [false, true]);
		assert.equal(mockPi.callCount(), 2);
		const [firstArgs, resumedArgs] = readAllCallArgs();
		assert.equal(firstArgs?.[firstArgs.indexOf("--session") + 1], sessionFile);
		assert.equal(resumedArgs?.[resumedArgs.indexOf("--session") + 1], sessionFile);
		assert.match(resumedArgs?.at(-1) ?? "", /Continue from the current files and transcript/);
		assert.equal(fs.readFileSync(path.join(tempDir, "side-effect.txt"), "utf-8"), "done");
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

	it("reports foreground context window usage without changing cumulative spend", async () => {
		mockPi.onCall({
			jsonl: [{
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "Done" }],
					model: "mock/test-model",
					stopReason: "stop",
					usage: { input: 11, output: 7, cacheRead: 30, cacheWrite: 0, cost: { total: 0.001 } },
				},
			}],
		});

		const result = await runSync(tempDir, makeAgentConfigs(["echo"]), "echo", "Task", {});

		assert.equal(result.progress.tokens, 18);
		assert.equal(result.progress.window, 41);
		assert.equal(result.progress.windowPeak, 41);
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

	it("writes artifacts without retaining the effective prompt", async () => {
		mockPi.onCall({
			output: "Result text",
			runtimeAcknowledgedExtensions: { version: 1, source: "child-runtime", ids: ["ext.ok"], omitted: 0 },
		});
		const privateExtension = path.join(tempDir, "extensions", "private-extension.ts");
		const agents = [makeAgent("echo", { extensions: [privateExtension] })];
		const artifactsDir = path.join(tempDir, "artifacts");
		const sentinel = "PROMPT_AUDIT_SENTINEL_1021";

		const result = await runSync(tempDir, agents, "echo", sentinel, {
			runId: "test-run",
			artifactsDir,
			artifactConfig: { enabled: true, includeInput: true, includeOutput: true, includeMetadata: true },
		});

		assert.equal(result.exitCode, 0);
		assert.ok(result.artifactPaths, "should have artifact paths");
		assert.ok(result.artifactPaths.inputPath, "should have a redacted input artifact");
		assert.doesNotMatch(fs.readFileSync(result.artifactPaths.inputPath, "utf-8"), new RegExp(sentinel));
		assert.match(fs.readFileSync(result.artifactPaths.inputPath, "utf-8"), /live Prompt Audit only/);
		assert.ok(result.transcriptPath, "should expose transcript path on the result");
		assert.equal(result.transcriptPath, result.artifactPaths.transcriptPath);
		assert.ok(fs.existsSync(result.transcriptPath), "transcript should be written");
		const transcript = fs.readFileSync(result.transcriptPath, "utf-8").trim().split("\n").map((line) => JSON.parse(line) as { recordType?: string; source?: string; text?: string });
		assert.equal(transcript[0]?.recordType, "message");
		assert.equal(transcript[0]?.source, "foreground");
		assert.match(transcript[0]?.text ?? "", /live Prompt Audit only/);
		assert.doesNotMatch(fs.readFileSync(result.transcriptPath, "utf-8"), new RegExp(sentinel));
		assert.match(transcript.at(-1)?.text ?? "", /^Result text/);
		assert.equal(result.transcriptError, undefined);
		assert.ok(fs.existsSync(artifactsDir), "artifacts dir should exist");
		const metadataText = fs.readFileSync(result.artifactPaths.metadataPath, "utf-8");
		const metadata = JSON.parse(metadataText) as { task?: string; launchContractDigest?: string; launchResolvedExtensions?: LaunchResolvedExtensions; runtimeAcknowledgedExtensions?: RuntimeAcknowledgedExtensions };
		assert.doesNotMatch(metadataText, new RegExp(sentinel));
		assert.equal(metadata.task, "[prompt redacted]");
		assert.equal(result.task, "[prompt redacted]");
		assert.equal(result.progress.task, "[prompt redacted]");
		assert.match(readCallArgs().join("\n"), new RegExp(sentinel));
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
		assert.equal(fs.existsSync(path.join(tempDir, ".pi/subagents", "artifacts")), false);
	});



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

	it("top-level reviewer runs do not inherit bundled chain artifact reads", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		fs.writeFileSync(path.join(tempDir, "plan.md"), "chain plan");
		fs.writeFileSync(path.join(tempDir, "progress.md"), "chain progress");
		mockPi.onCall({ output: "Review done" });
		const reviewer = discoverAgents(tempDir, "project").agents.find((agent) => agent.name === "reviewer");
		assert.ok(reviewer, "expected bundled reviewer");
		assert.equal(reviewer.defaultReads, undefined);
		const executor = makeExecutor([reviewer]);

		await executor.execute(
			"single-reviewer-without-chain-artifacts",
			{ agent: "reviewer", task: "Review the supplied files." },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		const taskArg = readCallArgs().at(-1) ?? "";
		assert.doesNotMatch(taskArg, /\[Read from:/);
		assert.doesNotMatch(taskArg, /plan\.md|progress\.md/);
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
		assert.match(taskArg, new RegExp(`Write your findings to exactly this path: ${escapeRegExp(path.join(TEMP_ARTIFACTS_DIR, "outputs"))}.*context\\.md`));
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

	it("threads the global config timeout default from deps.config, without overriding explicit or agent values", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const NINETY_MIN = 90 * 60 * 1000;
		mockPi.onCall({ output: "config default" });
		mockPi.onCall({ output: "explicit over config" });
		mockPi.onCall({ output: "agent over config" });
		mockPi.onCall({ output: "invalid config ignored" });

		// A global config.timeoutMs replaces the built-in 30-minute foreground backstop.
		const configExecutor = makeExecutor([makeAgent("echo")], { timeoutMs: NINETY_MIN });
		const configResult = await configExecutor.execute(
			"config-timeout-default",
			{ agent: "echo", task: "Task", async: false },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		assert.equal(configResult.details?.timeoutMs, NINETY_MIN);

		// An explicit call value still wins over the global config default.
		const explicitResult = await configExecutor.execute(
			"config-timeout-explicit",
			{ agent: "echo", task: "Task", async: false, timeoutMs: 2_000 },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		assert.equal(explicitResult.details?.timeoutMs, 2_000);

		// An agent frontmatter default still wins over the global config default (single launches).
		const agentResult = await makeExecutor([makeAgent("echo", { defaultTimeoutMs: 4_000 })], { timeoutMs: NINETY_MIN }).execute(
			"config-timeout-agent-default",
			{ agent: "echo", task: "Task", async: false },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		assert.equal(agentResult.details?.timeoutMs, 4_000);

		// An invalid config value is ignored -> falls back to the built-in 30-minute default.
		const invalidResult = await makeExecutor([makeAgent("echo")], { timeoutMs: -1 }).execute(
			"config-timeout-invalid",
			{ agent: "echo", task: "Task", async: false },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		assert.equal(invalidResult.details?.timeoutMs, executorMod?.DEFAULT_FOREGROUND_TIMEOUT_MS);
	});

	it("applies the global config timeout default to foreground workflow scripts", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ delay: 5_000, output: "too late" });
		mockPi.onCall({ delay: 5_000, output: "too late" });
		const executor = makeExecutor([makeAgent("echo")], { timeoutMs: 250 });

		const configResult = await executor.execute(
			"workflow-config-timeout-default",
			{ async: false, workflowScript: `return await runs.run("slow", { agent: "echo", task: "Wait" });` },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		assert.equal(configResult.isError, true);
		assert.match(configResult.content[0]?.text ?? "", /Workflow script timed out after 250ms/);
		assert.deepEqual(configResult.details.workflow?.receipt?.terminalOutcome, { state: "partial", reason: "timeout" });

		const explicitResult = await executor.execute(
			"workflow-config-timeout-explicit",
			{ async: false, timeoutMs: 150, workflowScript: `return await runs.run("slow", { agent: "echo", task: "Wait" });` },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		assert.equal(explicitResult.isError, true);
		assert.match(explicitResult.content[0]?.text ?? "", /Workflow script timed out after 150ms/);
		assert.deepEqual(explicitResult.details.workflow?.receipt?.terminalOutcome, { state: "partial", reason: "timeout" });

		const childLocalExecutor = makeExecutor([makeAgent("echo")], { timeoutMs: 10_000 });
		mockPi.onCall({ matchArgIncludes: "Fail normally", stderr: "upstream request timed out", exitCode: 1 });
		const ordinaryFailure = await childLocalExecutor.execute(
			"workflow-child-timeout-prose",
			{ async: false, workflowScript: `return await runs.run("failed", { agent: "echo", task: "Fail normally" });` },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		assert.equal(ordinaryFailure.isError, true);
		assert.equal(ordinaryFailure.details.workflow?.receipt?.terminalOutcome, undefined);

		mockPi.onCall({ matchArgIncludes: "Child local timeout", delay: 5_000, output: "too late" });
		const childTimeout = await childLocalExecutor.execute(
			"workflow-child-local-timeout",
			{ async: false, workflowScript: `return await runs.run("slow-child", { agent: "echo", task: "Child local timeout", timeoutMs: 150 });` },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		assert.equal(childTimeout.isError, true);
		assert.equal(childTimeout.details.workflow?.receipt?.terminalOutcome, undefined);
		assert.deepEqual(childTimeout.details.workflow?.receipt?.entries["slow-child"]?.terminalOutcome, { state: "partial", reason: "timeout" });
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
			}),
		]);

		const result = await executor.execute(
			"explicit-launch-values",
			{
				agent: "echo",
				task: "Task",
				async: false,
				timeoutMs: 2_000,
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

	it("passes fanout routing env only when nested fanout is explicitly authorized", async () => {
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
			const inheritedToolAgents = [makeAgent("inherited-delegator", { allowNestedSubagents: true })];
			const inheritedToolFanout = await runSync(tempDir, inheritedToolAgents, "inherited-delegator", "Task", { runId: "inherited-tool-fanout", index: 3 });
			assert.equal(inheritedToolFanout.exitCode, 0);
			assert.deepEqual(JSON.parse(inheritedToolFanout.finalOutput ?? "{}"), {
				PI_SUBAGENT_FANOUT_CHILD: "1",
				PI_SUBAGENT_PARENT_EVENT_SINK: "/tmp/inherited/events.jsonl",
				PI_SUBAGENT_PARENT_CONTROL_INBOX: "/tmp/inherited/control",
				PI_SUBAGENT_PARENT_RUN_ID: "inherited-tool-fanout",
				PI_SUBAGENT_PARENT_CHILD_INDEX: "3",
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

	it("records blocked mutation effects when foreground implementation tools are missing", async () => {
		mockPi.onCall({ output: "I cannot edit because fixture_search is missing", missingTools: ["fixture_search"] });
		const agents = [makeAgent("worker", { tools: ["read", "fixture_search"] })];

		const result = await runSync(tempDir, agents, "worker", "Implement the requested source fix", { runId: "missing-implementation-tool" });

		assert.equal(result.exitCode, 1);
		assert.match(result.error ?? "", /requested unavailable child tools: fixture_search/);
		assert.doesNotMatch(result.error ?? "", /completed without making edits/);
		assert.equal(result.effects?.fileMutation?.status, "blocked");
		assert.equal(result.effects?.fileMutation?.expected, true);
		assert.equal(result.effects?.fileMutation?.attempted, false);
		assert.match(result.effects?.fileMutation?.message ?? "", /requested unavailable child tools: fixture_search/);
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

	it("ignores legacy turn-budget options without prompt injection or termination", async () => {
		mockPi.onCall({
			jsonl: [
				mockAssistantMessage("first turn", "tool_use"),
				mockAssistantMessage("second turn", "tool_use"),
				mockAssistantMessage("completed normally", "stop"),
			],
		});
		const legacyOptions = {
			runId: "foreground-legacy-turn-budget",
			turnBudget: { maxTurns: 1, graceTurns: 0 },
			enforceHardTurnLimit: true,
		} as Parameters<typeof runSync>[4] & { turnBudget: { maxTurns: number; graceTurns: number }; enforceHardTurnLimit: boolean };

		const result = await runSync(tempDir, makeAgentConfigs(["worker"]), "worker", "Complete normally.", legacyOptions);

		assert.equal(result.exitCode, 0);
		assert.equal(result.turnBudgetExceeded, undefined);
		assert.equal(result.wrapUpRequested, undefined);
		assert.match(result.finalOutput ?? "", /completed normally/);
		assert.doesNotMatch(readCall().systemPrompts.map((record) => record.text ?? "").join("\n"), /turn budget|wrap up by this budget/i);
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

	it("returns actionable guidance for ambient extension registration conflicts", async () => {
		mockPi.onCall({
			exitCode: 1,
			stderr: 'Error: Failed to load extension "/tmp/pi-mcp-adapter-clone/index.ts": Tool "mcpScript" conflicts with /tmp/pi-mcp-adapter/index.ts',
		});
		const agents = makeAgentConfigs(["echo"]);

		const result = await runSync(tempDir, agents, "echo", "Task", {});

		assert.equal(result.exitCode, 1);
		assert.match(result.error ?? "", /loaded conflicting ambient Pi extensions/);
		assert.match(result.error ?? "", /"echo":\{"extensions":\[\]\}/);
	});

	it("handles stderr without exit code as info (not error)", async () => {
		mockPi.onCall({ output: "Success", stderr: "Warning: something", exitCode: 0 });
		const agents = makeAgentConfigs(["echo"]);

		const result = await runSync(tempDir, agents, "echo", "Task", {});

		assert.equal(result.exitCode, 0);
	});

});
