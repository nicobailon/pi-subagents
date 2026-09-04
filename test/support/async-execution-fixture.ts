/**
 * Integration tests for async (background) agent execution.
 *
 * Tests the async support utilities: jiti availability check,
 * status file reading/caching.
 *
 * Requires pi packages to be importable. Skips gracefully if unavailable.
 */

import { after, afterEach, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createEventBus, createMockPi, createTempDir, makeAgent, removeTempDir, resolveMockPiCallArgs, tryImport } from "./helpers.ts";
import type { MockPi } from "./helpers.ts";
import { CHILD_WATCHDOG_STATUS_EVENT } from "../../src/watchdog/child-status.ts";
import { clearExclusions } from "../../src/runs/shared/model-exclusions.ts";

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

interface UsageBudgetState {
	version?: number;
	source?: string;
	exhausted?: boolean;
	reason?: string;
	tokens?: { used?: number; hard?: number; exhausted?: boolean };
	costUsd?: { used?: number; hard?: number; exhausted?: boolean };
}

interface AsyncExecutionResult {
	content: Array<{ text?: string }>;
	isError?: boolean;
	details: { asyncId?: string; asyncDir?: string; launchContractDigest?: string; launchResolvedExtensions?: LaunchResolvedExtensions; runtimeAcknowledgedExtensions?: RuntimeAcknowledgedExtensions; usageBudget?: UsageBudgetState };
}

interface AsyncResultPayload {
	lifecycleArtifactVersion?: number;
	success: boolean;
	state?: string;
	exitCode?: number;
	sessionId?: string;
	mode?: string;
	launchContractDigest?: string;
	launchResolvedExtensions?: LaunchResolvedExtensions;
	runtimeAcknowledgedExtensions?: RuntimeAcknowledgedExtensions;
	summary?: string;
	error?: string;
	timeoutMs?: number;
	deadlineAt?: number;
	timedOut?: boolean;
	stopped?: boolean;
	turnBudget?: { maxTurns: number; graceTurns: number; outcome: string; turnCount: number; wrapUpRequestedAtTurn?: number; terminationDeferredAtTurn?: number; exceededAtTurn?: number };
	turnBudgetExceeded?: boolean;
	wrapUpRequested?: boolean;
	totalTokens?: { input: number; output: number; total: number };
	totalCost?: { inputTokens: number; outputTokens: number; costUsd: number };
	usageBudget?: UsageBudgetState;
	results: Array<{ agent?: string; sessionName?: string; launchContractDigest?: string; launchResolvedExtensions?: LaunchResolvedExtensions; runtimeAcknowledgedExtensions?: RuntimeAcknowledgedExtensions; output?: string; outputState?: "present" | "absent" | "unknown"; success?: boolean; error?: string; timedOut?: boolean; timeoutRecovery?: { changedFiles?: string[]; message?: string; warning?: string; recoveryNeeded?: boolean; reason?: string; reportStatus?: string }; stopped?: boolean; turnBudget?: { maxTurns: number; graceTurns: number; outcome: string; turnCount: number; wrapUpRequestedAtTurn?: number; terminationDeferredAtTurn?: number; exceededAtTurn?: number }; turnBudgetExceeded?: boolean; wrapUpRequested?: boolean; model?: string; thinking?: string; attemptedModels?: string[]; modelAttempts?: Array<{ success?: boolean; error?: string }>; totalCost?: { inputTokens: number; outputTokens: number; costUsd: number }; usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; turns: number }; structuredOutput?: unknown; agentContract?: { version: 1 }; execution?: { status?: string; success?: boolean; exitCode?: number }; effects?: { fileMutation?: { status?: string; expected?: boolean; attempted?: boolean; message?: string }; settlementDiagnostic?: { finalTextPresent?: boolean; mutation?: { expected?: boolean; attempted?: boolean; observed?: boolean }; requiredOutput?: { kind?: string; path?: string; missing?: boolean }; afterCompactionSettlement?: boolean } }; intercomTarget?: string; acceptance?: { status?: string; effectiveAcceptance?: { level?: string }; childReport?: unknown; runtimeChecks?: Array<{ id?: string; status?: string; message?: string }> }; artifactPaths?: { outputPath?: string; inputPath?: string; metadataPath?: string; transcriptPath?: string }; outputSaveError?: string; metadataSaveError?: string; capabilityCeiling?: { version?: number; allowedTools?: string[]; denyExtensions?: boolean; sources?: string[] }; capabilityAudit?: { effectiveTools?: string[]; removedTools?: string[]; extensionsDenied?: boolean } }>;
	outputs?: Record<string, { text?: string; structured?: unknown }>;
	workflowGraph?: { nodes?: Array<{ kind?: string; label?: string; phase?: string; status?: string; acceptanceStatus?: string; error?: string; outputName?: string; structured?: boolean; children?: Array<{ label?: string; outputName?: string; itemKey?: string; status?: string; acceptanceStatus?: string; error?: string }> }> };
	parallelHandoff?: { version?: number; path?: string; groupCount?: number; childCount?: number; changedPatches?: number; cleanupState?: string };
	capabilityCeiling?: { version?: number; allowedTools?: string[]; denyExtensions?: boolean; sources?: string[] };
	capabilityAudit?: { effectiveTools?: string[]; removedTools?: string[]; extensionsDenied?: boolean };
}

interface AsyncStatusPayload {
	lifecycleArtifactVersion?: number;
	sessionId?: string;
	pid?: number;
	activityState?: string;
	currentTool?: string;
	currentPath?: string;
	state?: string;
	endedAt?: number;
	launchContractDigest?: string;
	launchResolvedExtensions?: LaunchResolvedExtensions;
	runtimeAcknowledgedExtensions?: RuntimeAcknowledgedExtensions;
	error?: string;
	timeoutMs?: number;
	deadlineAt?: number;
	timedOut?: boolean;
	stopped?: boolean;
	turnBudget?: { maxTurns: number; graceTurns: number; outcome: string; turnCount: number; wrapUpRequestedAtTurn?: number; terminationDeferredAtTurn?: number; exceededAtTurn?: number };
	turnBudgetExceeded?: boolean;
	wrapUpRequested?: boolean;
	totalTokens?: { total: number };
	totalCost?: { inputTokens: number; outputTokens: number; costUsd: number };
	usageBudget?: UsageBudgetState;
	parallelGroups?: Array<{ start: number; count: number; stepIndex: number }>;
	parallelHandoff?: { version?: number; path?: string; groupCount?: number; childCount?: number; changedPatches?: number; cleanupState?: string };
	capabilityCeiling?: { version?: number; allowedTools?: string[]; denyExtensions?: boolean; sources?: string[] };
	capabilityAudit?: { effectiveTools?: string[]; removedTools?: string[]; extensionsDenied?: boolean };
	steps?: Array<{
		agent?: string;
		sessionName?: string;
		label?: string;
		phase?: string;
		outputName?: string;
		structured?: boolean;
		skills?: string[];
		activityState?: string;
		currentTool?: string;
		status?: string;
		exitCode?: number;
		timedOut?: boolean;
		timeoutRecovery?: { changedFiles?: string[]; message?: string; warning?: string; recoveryNeeded?: boolean; reason?: string; reportStatus?: string };
		error?: string;
		model?: string;
		thinking?: string;
		tokens?: { total: number };
		totalCost?: { inputTokens: number; outputTokens: number; costUsd: number };
		agentContract?: { version: 1 };
		launchContractDigest?: string;
		launchResolvedExtensions?: LaunchResolvedExtensions;
		runtimeAcknowledgedExtensions?: RuntimeAcknowledgedExtensions;
		execution?: { status?: string; success?: boolean; exitCode?: number };
		effects?: { fileMutation?: { status?: string; expected?: boolean; attempted?: boolean }; settlementDiagnostic?: { finalTextPresent?: boolean; mutation?: { expected?: boolean; attempted?: boolean; observed?: boolean }; requiredOutput?: { kind?: string; path?: string; missing?: boolean }; afterCompactionSettlement?: boolean } };
		acceptance?: { status?: string };
		contextLimit?: number;
		turnBudget?: { maxTurns: number; graceTurns: number; outcome: string; turnCount: number; wrapUpRequestedAtTurn?: number; terminationDeferredAtTurn?: number; exceededAtTurn?: number };
		turnBudgetExceeded?: boolean;
		wrapUpRequested?: boolean;
		capabilityCeiling?: { version?: number; allowedTools?: string[]; denyExtensions?: boolean; sources?: string[] };
		capabilityAudit?: { effectiveTools?: string[]; removedTools?: string[]; extensionsDenied?: boolean };
	}>;
}

interface MockPiCallRecord {
	args?: string[];
	effectiveArgs?: string[];
	systemPrompts?: Array<{ mode?: string; path?: string; text?: string; error?: string }>;
	requiredChildTools?: string[];
	/** The `ChildRuntimeConfig` the scripted child session was launched with. */
	runtime?: Record<string, unknown>;
}

/** Recorded child runtime config of the mock call at `index`, once it exists. */
async function waitForMockPiRuntime(mockPi: MockPi, index: number, timeoutMs = 30_000): Promise<Record<string, unknown>> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const callFile = fs.readdirSync(mockPi.dir)
			.filter((name) => name.startsWith("call-") && name.endsWith(".json"))
			.sort()
			.at(index);
		if (callFile) {
			const payload = JSON.parse(fs.readFileSync(path.join(mockPi.dir, callFile), "utf-8")) as MockPiCallRecord;
			assert.ok(payload.runtime, "expected a recorded child runtime config");
			return payload.runtime;
		}
		if (Date.now() > deadline) assert.fail(`Timed out waiting for recorded mock pi call ${index}`);
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
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

function childWatchdogStatus(runId: string, phase: "idle" | "reviewing" | "stale" | "failed", seq: number) {
	return {
		type: CHILD_WATCHDOG_STATUS_EVENT,
		runId,
		agent: "worker",
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

interface AsyncExecutionModule {
	isAsyncAvailable(): boolean;
	executeAsyncSingle(id: string, params: Record<string, unknown>): AsyncExecutionResult;
	executeAsyncChain(id: string, params: Record<string, unknown>): AsyncExecutionResult;
}

interface AsyncStatusModule {
	resolveTargetedAsyncRun(root: string, id: string, sessionId?: string): { kind: string };
}

interface UtilsModule {
	readStatus(dir: string): { runId: string; state: string; mode: string } | null;
	pruneStatusCacheForAsyncRoot(root: string, runIds: Iterable<string>): number;
}

interface TypesModule {
	ASYNC_DIR: string;
	RESULTS_DIR: string;
	TEMP_ROOT_DIR: string;
}

interface ExecutorModule {
	createSubagentExecutor?: (...args: unknown[]) => {
		execute: (...args: unknown[]) => Promise<{ content: Array<{ text?: string }>; isError?: boolean; details?: { asyncId?: string } }>;
	};
}

const asyncMod = await tryImport<AsyncExecutionModule>("./src/runs/background/async-execution.ts");
const asyncStatusMod = await tryImport<AsyncStatusModule>("./src/runs/background/async-status.ts");
const utils = await tryImport<UtilsModule>("./src/shared/utils.ts");
const typesMod = await tryImport<TypesModule>("./src/shared/types.ts");
const executorMod = await tryImport<ExecutorModule>("./src/runs/foreground/subagent-executor.ts");
const available = !!(asyncMod && utils && typesMod);

const isAsyncAvailable = asyncMod?.isAsyncAvailable;
const executeAsyncSingle = asyncMod?.executeAsyncSingle;
const executeAsyncChain = asyncMod?.executeAsyncChain;
const resolveTargetedAsyncRun = asyncStatusMod?.resolveTargetedAsyncRun;
const readStatus = utils?.readStatus;
const pruneStatusCacheForAsyncRoot = utils?.pruneStatusCacheForAsyncRoot;
const ASYNC_DIR = typesMod?.ASYNC_DIR;
const RESULTS_DIR = typesMod?.RESULTS_DIR;
const TEMP_ROOT_DIR = typesMod?.TEMP_ROOT_DIR;
const createSubagentExecutor = executorMod?.createSubagentExecutor;

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function git(cwd: string, args: string[]): string {
	const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf-8" });
	if (result.status !== 0) {
		throw new Error(result.stderr.trim() || result.stdout.trim() || `git ${args.join(" ")} failed`);
	}
	return result.stdout.trim();
}

function createRepo(prefix: string): string {
	const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	git(repoDir, ["init"]);
	git(repoDir, ["config", "user.email", "tests@example.com"]);
	git(repoDir, ["config", "user.name", "Async Tests"]);
	fs.writeFileSync(path.join(repoDir, "input.md"), "input\n", "utf-8");
	git(repoDir, ["add", "-A"]);
	git(repoDir, ["commit", "-m", "initial commit"]);
	return repoDir;
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

function readIfExists(filePath: string): string | undefined {
	try {
		const text = fs.readFileSync(filePath, "utf-8").trim();
		return text || undefined;
	} catch {
		return undefined;
	}
}

async function waitForAsyncResultFile(id: string, timeoutMs = 15_000): Promise<string> {
	const resultPath = path.join(RESULTS_DIR, `${id}.json`);
	const deadline = Date.now() + timeoutMs;
	while (!fs.existsSync(resultPath)) {
		if (Date.now() > deadline) {
			const asyncDir = path.join(ASYNC_DIR, id);
			// Summarize before teardown; never print free-form output, prompts or tokens.
			const evidence = ["status.json", "runner-startup-proceed.json", "process-terminal.json", "events.jsonl", "runner.stdout.log", "runner.stderr.log"].map((name) => {
				let text: string;
				try {
					text = fs.readFileSync(path.join(asyncDir, name), "utf-8");
				} catch (error) {
					const code = (error as NodeJS.ErrnoException).code;
					return `${name}: ${code === "ENOENT" ? "absent" : `unreadable (${code ?? "unknown"})`}`;
				}
				if (!text.length) return `${name}: empty`;
				const size = `${Buffer.byteLength(text)} bytes (contents withheld)`;
				if (name !== "status.json") return `${name}: readable, ${size}`;
				try {
					const status = JSON.parse(text) as AsyncStatusPayload;
					const knownState = (value: unknown) => ["pending", "running", "complete", "failed", "cancelled"].includes(String(value)) ? value : "other/absent";
					return `${name}: ${JSON.stringify({ state: knownState(status.state), steps: status.steps?.map((step) => knownState(step.status)), endedAtPresent: typeof status.endedAt === "number" })}`;
				} catch {
					return `${name}: invalid status JSON, ${size}`;
				}
			});
			// The current fixture queue proves prompt entry, not per-run identity or settlement.
			const queueDir = process.env.MOCK_PI_QUEUE_DIR;
			let mockEvidence = "mock queue: not configured";
			if (queueDir) {
				try {
					const calls = fs.readdirSync(queueDir).filter((name) => name.startsWith("call-") && name.endsWith(".json"));
					mockEvidence = `mock queue: readable, prompt call records=${calls.length} (current fixture, not correlated to run)`;
				} catch (error) {
					const code = (error as NodeJS.ErrnoException).code;
					mockEvidence = `mock queue: ${code === "ENOENT" ? "absent" : `unreadable (${code ?? "unknown"})`}`;
				}
			}
			assert.fail([
				`Timed out waiting for async result file: ${resultPath}`,
				mockEvidence,
				...evidence,
			].join("\n"));
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	return resultPath;
}

async function waitForAsyncEvent(id: string, type: string, timeoutMs = 10_000): Promise<Record<string, unknown>> {
	const eventsPath = path.join(ASYNC_DIR, id, "events.jsonl");
	const deadline = Date.now() + timeoutMs;
	while (Date.now() <= deadline) {
		const event = readIfExists(eventsPath)
			?.split("\n")
			.map((line) => JSON.parse(line) as Record<string, unknown>)
			.find((candidate) => candidate.type === type);
		if (event) return event;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	assert.fail(`Timed out waiting for async event '${type}': ${eventsPath}`);
}

async function waitForAsyncState(id: string, predicate: (status: AsyncStatusPayload) => boolean, timeoutMs = 10_000): Promise<AsyncStatusPayload> {
	const statusPath = path.join(ASYNC_DIR, id, "status.json");
	const deadline = Date.now() + timeoutMs;
	let last: AsyncStatusPayload | undefined;
	while (Date.now() <= deadline) {
		if (fs.existsSync(statusPath)) {
			const status = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatusPayload;
			last = status;
			if (predicate(status)) return status;
		}
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	assert.fail(`Timed out waiting for async status: ${statusPath} (last state: ${last?.state ?? "missing"}, error: ${last?.error ?? "none"}, step statuses: ${last?.steps?.map((step) => step.status).join(",") ?? "none"})`);
}

async function waitForMockPiCall(mockPi: MockPi, index: number, timeoutMs = 30_000): Promise<{ args: string[]; systemPrompts: NonNullable<MockPiCallRecord["systemPrompts"]> }> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const callFile = fs.readdirSync(mockPi.dir)
			.filter((name) => name.startsWith("call-") && name.endsWith(".json"))
			.sort()
			.at(index);
		if (callFile) {
			const payload = JSON.parse(fs.readFileSync(path.join(mockPi.dir, callFile), "utf-8")) as MockPiCallRecord;
			assert.ok(Array.isArray(payload.args), "expected recorded args");
			return { args: resolveMockPiCallArgs(payload), systemPrompts: payload.systemPrompts ?? [] };
		}
		if (Date.now() > deadline) assert.fail(`Timed out waiting for recorded mock pi call ${index}`);
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}

async function waitForMockPiArgs(mockPi: MockPi, index: number, timeoutMs = 30_000): Promise<string[]> {
	return (await waitForMockPiCall(mockPi, index, timeoutMs)).args;
}

function readLastMockPiArgs(mockPi: MockPi): string[] {
	const callFile = fs.readdirSync(mockPi.dir)
		.filter((name) => name.startsWith("call-") && name.endsWith(".json"))
		.sort()
		.at(-1);
	assert.ok(callFile, "expected a recorded mock pi call");
	const payload = JSON.parse(fs.readFileSync(path.join(mockPi.dir, callFile), "utf-8")) as MockPiCallRecord;
	assert.ok(Array.isArray(payload.args), "expected recorded args");
	return resolveMockPiCallArgs(payload);
}

function readMockPiArgs(mockPi: MockPi, index: number): string[] {
	const callFile = fs.readdirSync(mockPi.dir)
		.filter((name) => name.startsWith("call-") && name.endsWith(".json"))
		.sort()
		.at(index);
	assert.ok(callFile, `expected recorded call ${index}`);
	const payload = JSON.parse(fs.readFileSync(path.join(mockPi.dir, callFile), "utf-8")) as MockPiCallRecord;
	assert.ok(Array.isArray(payload.args), "expected recorded args");
	return resolveMockPiCallArgs(payload);
}

function readMockPiRequiredTools(mockPi: MockPi, index: number): string[] {
	const callFile = fs.readdirSync(mockPi.dir)
		.filter((name) => name.startsWith("call-") && name.endsWith(".json"))
		.sort()
		.at(index);
	assert.ok(callFile, `expected recorded call ${index}`);
	const payload = JSON.parse(fs.readFileSync(path.join(mockPi.dir, callFile), "utf-8")) as MockPiCallRecord;
	assert.ok(Array.isArray(payload.requiredChildTools), "expected recorded required child tools");
	return payload.requiredChildTools;
}

function readMockPiArgsMatching(mockPi: MockPi, text: string): string[] {
	const callFiles = fs.readdirSync(mockPi.dir)
		.filter((name) => name.startsWith("call-") && name.endsWith(".json"))
		.sort();
	for (const callFile of callFiles) {
		const payload = JSON.parse(fs.readFileSync(path.join(mockPi.dir, callFile), "utf-8")) as MockPiCallRecord;
		assert.ok(Array.isArray(payload.args), "expected recorded args");
		const args = resolveMockPiCallArgs(payload);
		if (args.join("\n").includes(text)) return args;
	}
	assert.fail(`expected recorded call containing ${text}`);
}

// Each physical suite installs these hooks inside its describe callback.
// Mutable bindings stay live and process-local under the default test isolation.
let tempDir: string;
let mockPi: MockPi;

export function installAsyncExecutionHooks(): void {
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
		clearExclusions();
	});

	afterEach(() => {
		clearExclusions();
		removeTempDir(tempDir);
	});
}

	function makeAsyncExecutor(
		agents: ReturnType<typeof makeAgent>[],
		config: Record<string, unknown> = {},
		discoverOverride?: (cwd: string) => { agents: ReturnType<typeof makeAgent>[]; cwd?: string; scope?: "user" | "project" | "both"; directories?: Array<{ source: "builtin" | "package" | "user" | "project" | "runtime"; path: string; state: "absent" | "empty" | "candidates" | "unreadable" | "not-directory"; candidateCount?: number }> },
	) {
		return createSubagentExecutor!({
			pi: { events: createEventBus(), getSessionName: () => undefined },
			state: { baseCwd: tempDir, currentSessionId: null, asyncJobs: new Map(), foregroundControls: new Map(), lastForegroundControlId: null },
			config,
			asyncByDefault: false,
			tempArtifactsDir: tempDir,
			getSubagentSessionRoot: () => tempDir,
			expandTilde: (p: string) => p,
			discoverAgents: (cwd: string) => discoverOverride ? discoverOverride(cwd) : ({ agents }),
		});
	}

	async function readAsyncPayload(id: string): Promise<AsyncResultPayload> {
		const resultPath = await waitForAsyncResultFile(id, 10_000);
		return JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
	}

	function launchProtocolTest(id: string): void {
		const receipt = executeAsyncSingle(id, {
			agent: "worker",
			task: "Exercise child protocol",
			agentConfig: makeAgent("worker", { completionGuard: false }),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
			acceptance: false,
		});
		assert.equal(receipt.isError === true, false, "protocol launch must succeed");
		assert.equal(receipt.details.asyncId === id, true, "protocol launch must identify the requested run");
		assert.equal(receipt.details.asyncDir === path.join(ASYNC_DIR, id), true, "protocol launch must identify the expected artifacts");
	}

export type { AsyncExecutionResult, AsyncResultPayload, AsyncStatusPayload, MockPiCallRecord };
export {
	available, isAsyncAvailable, executeAsyncSingle, executeAsyncChain,
	resolveTargetedAsyncRun, readStatus, pruneStatusCacheForAsyncRoot,
	ASYNC_DIR, RESULTS_DIR, TEMP_ROOT_DIR, createSubagentExecutor,
	tempDir, mockPi, makeAsyncExecutor, readAsyncPayload, launchProtocolTest,
	waitForMockPiRuntime, writeWatchdogSettings, withIsolatedWatchdogSettings,
	childWatchdogStatus, mockAssistantMessage, escapeRegExp, createRepo,
	writePackageSkill, readIfExists, waitForAsyncResultFile, waitForAsyncEvent,
	waitForAsyncState, waitForMockPiCall, readLastMockPiArgs,
	readMockPiArgs, readMockPiRequiredTools, readMockPiArgsMatching,
};
