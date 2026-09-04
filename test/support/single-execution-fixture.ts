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

import { before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import type { MockPi } from "./helpers.ts";
import {
	createMockPi,
	createTempDir,
	createEventBus,
	removeTempDir,
	makeAgentConfigs,
	makeAgent,
	resolveMockPiCallArgs,
	tryImport,
} from "./helpers.ts";
import type { ChildWatchdogProgress, SubagentState } from "../../src/shared/types.ts";
import { CHILD_WATCHDOG_STATUS_EVENT } from "../../src/watchdog/child-status.ts";
import type { ChildRuntimeConfig } from "../../src/runs/shared/child-runtime-config.ts";
import { clearExclusions } from "../../src/runs/shared/model-exclusions.ts";

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
	timeoutRecovery?: { changedFiles?: string[]; message?: string; recoveryNeeded?: boolean; reason?: string; reportStatus?: string };
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
	watchdog?: ChildWatchdogProgress;
	launchResolvedExtensions?: LaunchResolvedExtensions;
	runtimeAcknowledgedExtensions?: RuntimeAcknowledgedExtensions;
}

interface MockPiCallRecord {
	args?: string[];
	effectiveArgs?: string[];
	cwd?: string;
	systemPrompts?: Array<{ mode?: string; path?: string; text?: string; error?: string }>;
	/** In-process child session launch (foreground children). */
	launch?: { cwd: string; storage: { kind: string; sessionFile?: string; sessionDir?: string }; model?: string; tools?: string[]; excludeTools?: string[]; extensionPaths: string[]; hooks: string[]; noSkills: boolean; noContextFiles: boolean };
	/** Typed child runtime config the in-process hooks received. */
	runtime?: Record<string, unknown> & { sessionName?: string; intercomSessionName?: string; orchestratorTarget?: string; runId?: string; agent?: string; childIndex?: number; fanoutChild?: boolean; nestedParent?: { parentRunId: string; parentChildIndex?: number; depth: number }; depth?: number; maxDepth?: number; waitTool?: { enabled: boolean }; inheritProjectContext?: boolean; inheritSkills?: boolean; toolBudget?: unknown };
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

function childWatchdogStatus(phase: "idle" | "reviewing" | "stale" | "failed", seq: number) {
	return {
		type: CHILD_WATCHDOG_STATUS_EVENT,
		runId: "watchdog-child-run",
		agent: "echo",
		childIndex: 0,
		stepIndex: 0,
		seq,
		phase,
		ts: Date.now() + seq,
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

async function waitForFileContent(filePath: string, expected: string): Promise<string> {
	for (let attempt = 0; attempt < 300; attempt++) {
		if (fs.existsSync(filePath)) {
			const content = fs.readFileSync(filePath, "utf-8");
			if (content.includes(expected)) return content;
		}
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	return fs.readFileSync(filePath, "utf-8");
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

let tempDir: string;
let agentDir: string;
let mockPi: MockPi;
let previousAgentDir: string | undefined;

export function installSingleExecutionHooks() {
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
}

	function readCall(): { args: string[]; effectiveArgs?: string[]; cwd?: string; systemPrompts: NonNullable<MockPiCallRecord["systemPrompts"]>; launch: MockPiCallRecord["launch"]; runtime: MockPiCallRecord["runtime"] } {
		const callFile = fs.readdirSync(mockPi.dir)
			.filter((name) => name.startsWith("call-") && name.endsWith(".json"))
			.sort()
			.at(-1);
		assert.ok(callFile, "expected a recorded mock pi call");
		const payload = JSON.parse(fs.readFileSync(path.join(mockPi.dir, callFile), "utf-8")) as MockPiCallRecord;
		assert.ok(Array.isArray(payload.args), "expected recorded args");
		return { args: payload.args, effectiveArgs: payload.effectiveArgs, cwd: payload.cwd, systemPrompts: payload.systemPrompts ?? [], launch: payload.launch, runtime: payload.runtime };
	}

	function readCallArgs(): string[] {
		const call = readCall();
		return resolveMockPiCallArgs(call);
	}

	function readAllCallArgs(effective = false): string[][] {
		return fs.readdirSync(mockPi.dir)
			.filter((name) => name.startsWith("call-") && name.endsWith(".json"))
			.sort()
			.map((name) => {
				const call = JSON.parse(fs.readFileSync(path.join(mockPi.dir, name), "utf-8")) as MockPiCallRecord;
				return effective ? resolveMockPiCallArgs(call) : call.args ?? [];
			});
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
		childRuntime?: ChildRuntimeConfig,
	) {
		return createSubagentExecutor!({
			pi: { events: piEvents, getSessionName: () => undefined },
			...(childRuntime ? { childRuntime } : {}),
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

export {
	tempDir, agentDir, mockPi, available, runSync, getFinalOutput, utils,
	createSubagentExecutor, executorMod, escapeRegExp, pathContainsSegments,
	waitForFileContent, writePackageSkill, writeWatchdogSettings,
	withIsolatedWatchdogSettings, childWatchdogStatus, mockAssistantMessage,
	readCall, readCallArgs, readAllCallArgs, makeExecutor,
};
export type {
	ProgressSummary, ArtifactPaths, LaunchResolvedExtensions,
	RuntimeAcknowledgedExtensions, RunSyncResult, ExecutorToolResult,
};
