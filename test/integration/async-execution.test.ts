/**
 * Integration tests for async (background) agent execution.
 *
 * Tests the async support utilities: jiti availability check,
 * status file reading/caching.
 *
 * Requires pi packages to be importable. Skips gracefully if unavailable.
 */

import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createEventBus, createMockPi, createTempDir, events, makeAgent, makeMinimalCtx, removeTempDir, tryImport } from "../support/helpers.ts";
import type { MockPi } from "../support/helpers.ts";
import { deliverInterruptRequest, deliverStopRequest, deliverTimeoutRequest } from "../../src/runs/background/control-channel.ts";
import { waitForSubagents } from "../../src/runs/background/subagent-wait.ts";
import { writeAtomicJson } from "../../src/shared/atomic-json.ts";
import { CHILD_WATCHDOG_STATUS_EVENT } from "../../src/watchdog/child-status.ts";
import { MAX_CHILD_PENDING_LINE_BYTES, MAX_CHILD_STDERR_BYTES } from "../../src/runs/shared/child-protocol.ts";
import { SUBAGENT_ASYNC_STARTED_EVENT, SUBAGENT_LIFECYCLE_ARTIFACT_VERSION, TEMP_ARTIFACTS_DIR } from "../../src/shared/types.ts";
import { registerSubagentCapabilityCeiling } from "../../src/api/capability-ceiling.ts";
import { resolveSubagentLaunchContract } from "../../src/api/preflight.ts";
import { discoverAgents } from "../../src/agents/agents.ts";
import { runSync } from "../../src/runs/foreground/execution.ts";
import { ACTIVE_ASYNC_CAPACITY_DIR, acquireActiveAsyncCapacity, activeAsyncCapacitySessionKey } from "../../src/runs/background/active-async-capacity.ts";

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
	results: Array<{ agent?: string; launchContractDigest?: string; launchResolvedExtensions?: LaunchResolvedExtensions; runtimeAcknowledgedExtensions?: RuntimeAcknowledgedExtensions; output?: string; outputState?: "present" | "absent" | "unknown"; success?: boolean; error?: string; protocolError?: { code?: string; stream?: string; limitBytes?: number; observedBytes?: number }; timedOut?: boolean; timeoutRecovery?: { changedFiles?: string[]; message?: string; warning?: string }; stopped?: boolean; turnBudget?: { maxTurns: number; graceTurns: number; outcome: string; turnCount: number; wrapUpRequestedAtTurn?: number; terminationDeferredAtTurn?: number; exceededAtTurn?: number }; turnBudgetExceeded?: boolean; wrapUpRequested?: boolean; model?: string; attemptedModels?: string[]; modelAttempts?: Array<{ success?: boolean; error?: string }>; totalCost?: { inputTokens: number; outputTokens: number; costUsd: number }; structuredOutput?: unknown; agentContract?: { version: 1 }; execution?: { status?: string; success?: boolean; exitCode?: number }; effects?: { fileMutation?: { status?: string; expected?: boolean; attempted?: boolean; message?: string }; settlementDiagnostic?: { finalTextPresent?: boolean; mutation?: { expected?: boolean; attempted?: boolean; observed?: boolean }; requiredOutput?: { kind?: string; path?: string; missing?: boolean }; afterCompactionSettlement?: boolean } }; intercomTarget?: string; acceptance?: { status?: string; effectiveAcceptance?: { level?: string }; childReport?: unknown; runtimeChecks?: Array<{ id?: string; status?: string; message?: string }> }; artifactPaths?: { outputPath?: string; inputPath?: string; metadataPath?: string; transcriptPath?: string }; outputSaveError?: string; metadataSaveError?: string; capabilityCeiling?: { version?: number; allowedTools?: string[]; denyExtensions?: boolean; sources?: string[] }; capabilityAudit?: { effectiveTools?: string[]; removedTools?: string[]; extensionsDenied?: boolean } }>;
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
		timeoutRecovery?: { changedFiles?: string[]; message?: string; warning?: string };
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
	systemPrompts?: Array<{ mode?: string; path?: string; text?: string; error?: string }>;
	requiredChildTools?: string[];
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

function childWatchdogStatus(runId: string, phase: "idle" | "reviewing" | "autofollow" | "settling" | "stale" | "failed", seq: number, followUpPending = false) {
	return {
		type: CHILD_WATCHDOG_STATUS_EVENT,
		runId,
		agent: "worker",
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
			const status = readIfExists(path.join(asyncDir, "status.json"));
			const stdout = readIfExists(path.join(asyncDir, "runner.stdout.log"));
			const stderr = readIfExists(path.join(asyncDir, "runner.stderr.log"));
			assert.fail([
				`Timed out waiting for async result file: ${resultPath}`,
				status ? `status.json: ${status}` : undefined,
				stdout ? `runner stdout: ${stdout}` : undefined,
				stderr ? `runner stderr: ${stderr}` : undefined,
			].filter(Boolean).join("\n"));
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
	while (Date.now() <= deadline) {
		if (fs.existsSync(statusPath)) {
			const status = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatusPayload;
			if (predicate(status)) return status;
		}
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	assert.fail(`Timed out waiting for async status: ${statusPath}`);
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
			return { args: payload.args, systemPrompts: payload.systemPrompts ?? [] };
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
	return payload.args;
}

function readMockPiArgs(mockPi: MockPi, index: number): string[] {
	const callFile = fs.readdirSync(mockPi.dir)
		.filter((name) => name.startsWith("call-") && name.endsWith(".json"))
		.sort()
		.at(index);
	assert.ok(callFile, `expected recorded call ${index}`);
	const payload = JSON.parse(fs.readFileSync(path.join(mockPi.dir, callFile), "utf-8")) as MockPiCallRecord;
	assert.ok(Array.isArray(payload.args), "expected recorded args");
	return payload.args;
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
		const payload = JSON.parse(fs.readFileSync(path.join(mockPi.dir, callFile), "utf-8")) as { args?: string[] };
		assert.ok(Array.isArray(payload.args), "expected recorded args");
		if (payload.args.join("\n").includes(text)) return payload.args;
	}
	assert.fail(`expected recorded call containing ${text}`);
}

describe("async execution utilities", { skip: !available ? "pi packages not available" : undefined }, () => {
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
		executeAsyncSingle(id, {
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
	}

	it("reports jiti availability as boolean", () => {
		const result = isAsyncAvailable();
		assert.equal(typeof result, "boolean");
	});

	it("does not persist terminal async workflow status when the result index write fails", { skip: !isAsyncAvailable() || !createSubagentExecutor ? "jiti or executor not available" : undefined }, async () => {
		const id = `async-workflow-result-index-failure-${Date.now().toString(36)}`;
		const resultIndexPath = path.join(RESULTS_DIR, "result-index");
		let asyncDir: string | undefined;
		let resultPath: string | undefined;
		let pendingPath: string | undefined;
		const originalError = console.error;
		try {
			console.error = () => {};
			fs.rmSync(resultIndexPath, { recursive: true, force: true });
			fs.mkdirSync(RESULTS_DIR, { recursive: true });
			fs.writeFileSync(resultIndexPath, "not a directory", "utf-8");
			const executor = makeAsyncExecutor([]);
			const context = makeMinimalCtx(tempDir);
			context.sessionManager.getSessionId = () => "session-workflow-index";

			const launch = await executor.execute(id, { workflowScript: "return 'done'", async: true }, new AbortController().signal, undefined, context);
			assert.equal(launch.isError, undefined);
			const asyncId = launch.details?.asyncId;
			assert.ok(asyncId, "expected async workflow id");
			asyncDir = path.join(ASYNC_DIR, asyncId);
			resultPath = path.join(RESULTS_DIR, `${asyncId}.json`);
			pendingPath = path.join(RESULTS_DIR, "result-pending", encodeURIComponent("session-workflow-index"), `${encodeURIComponent(asyncId)}.json`);

			const eventsPath = path.join(asyncDir, "events.jsonl");
			const deadline = Date.now() + 5_000;
			let eventsText = "";
			while (Date.now() <= deadline) {
				eventsText = readIfExists(eventsPath) ?? "";
				if (eventsText.includes("subagent.workflow.result_write_failed")) break;
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
			assert.match(eventsText, /subagent\.workflow\.result_write_failed/);
			const status = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8")) as AsyncStatusPayload;
			assert.equal(status.state, "running");
			assert.equal(fs.existsSync(resultPath), false);
			assert.equal(fs.existsSync(pendingPath), true);
		} finally {
			console.error = originalError;
			if (asyncDir) fs.rmSync(asyncDir, { recursive: true, force: true });
			if (resultPath) fs.rmSync(resultPath, { recursive: true, force: true });
			if (pendingPath) fs.rmSync(pendingPath, { force: true });
			fs.rmSync(resultIndexPath, { recursive: true, force: true });
		}
	});

	it("background parses split UTF-8 JSON and a final unterminated protocol line", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		const line = Buffer.from(JSON.stringify(events.assistantMessage("你好 from fragmented async JSON")));
		const unicodeStart = line.indexOf(Buffer.from("你"));
		mockPi.onCall({ stdoutBase64Chunks: [line.subarray(0, unicodeStart + 1).toString("base64"), line.subarray(unicodeStart + 1).toString("base64")] });
		const id = `async-protocol-utf8-${Date.now().toString(36)}`;
		launchProtocolTest(id);
		const payload = await readAsyncPayload(id);
		assert.equal(payload.success, true);
		assert.equal(payload.results[0]?.output, "你好 from fragmented async JSON");
	});

	it("persists terminal status with the result artifact", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ output: "completed output" });
		const id = `async-terminal-status-${Date.now().toString(36)}`;
		launchProtocolTest(id);
		await waitForAsyncResultFile(id);
		const status = JSON.parse(fs.readFileSync(path.join(ASYNC_DIR, id, "status.json"), "utf-8")) as AsyncStatusPayload;
		assert.equal(status.state, "complete");
		assert.equal(status.endedAt !== undefined, true);
	});

	it("makes a launched async run immediately visible to exact status lookup", { skip: !isAsyncAvailable() || !resolveTargetedAsyncRun ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ delay: 500, output: "visible async done" });
		const id = `async-initial-status-${Date.now().toString(36)}`;
		const launch = executeAsyncSingle(id, {
			agent: "worker",
			task: "Remain visible while starting",
			agentConfig: makeAgent("worker", { completionGuard: false, model: "mock/test-model" }),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-initial-status" },
			availableModels: [{ provider: "mock", id: "test-model", fullId: "mock/test-model", contextWindow: 128_000 }],
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			maxSubagentDepth: 2,
		});

		assert.equal(launch.isError, undefined);
		assert.equal(resolveTargetedAsyncRun(ASYNC_DIR, id, "session-initial-status").kind, "exact");
		const status = JSON.parse(fs.readFileSync(path.join(ASYNC_DIR, id, "status.json"), "utf-8")) as AsyncStatusPayload;
		assert.equal(status.sessionId, "session-initial-status");
		assert.equal(status.pid !== undefined, true);
		assert.equal(status.steps?.[0]?.contextLimit, 128_000);
		await waitForAsyncResultFile(id);
	});

	it("persists intercom detach receipts on failed async steps", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ output: "Detached for intercom coordination before task completion.", exitCode: -2 });
		const id = `async-intercom-detach-${Date.now().toString(36)}`;
		launchProtocolTest(id);
		await waitForAsyncResultFile(id);
		const status = JSON.parse(fs.readFileSync(path.join(ASYNC_DIR, id, "status.json"), "utf-8")) as AsyncStatusPayload;
		assert.equal(status.state, "failed");
		assert.equal(status.error, "Detached for intercom coordination before task completion.");
		assert.equal(status.steps?.[0]?.error, "Detached for intercom coordination before task completion.");
	});

	it("persists actionable guidance for ambient extension registration conflicts", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({
			exitCode: 1,
			stderr: 'Error: Failed to load extension "/tmp/pi-mcp-adapter-clone/index.ts": Flag "--mcp-config" conflicts with /tmp/pi-mcp-adapter/index.ts',
		});
		const id = `async-extension-conflict-${Date.now().toString(36)}`;
		launchProtocolTest(id);
		const payload = await readAsyncPayload(id);
		assert.equal(payload.success, false);
		assert.match(payload.results[0]?.error ?? "", /loaded conflicting ambient Pi extensions/);
		assert.match(payload.results[0]?.error ?? "", /"worker":\{"extensions":\[\]\}/);
	});

	it("persists absent output provenance when async lifecycle text is synthetic", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ jsonl: [mockAssistantMessage("", "tool_use")], stderr: "mock child failure", exitCode: 1 });
		const id = `async-output-absent-${Date.now().toString(36)}`;
		launchProtocolTest(id);
		const payload = await readAsyncPayload(id);
		assert.equal(payload.success, false);
		assert.equal(payload.results[0]?.outputState, "absent");
		assert.match(payload.results[0]?.error ?? "", /mock child failure/);
	});

	it("persists present output provenance when async failure follows partial output", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ output: "usable partial answer", stderr: "mock post-output failure", exitCode: 1 });
		const id = `async-output-present-${Date.now().toString(36)}`;
		launchProtocolTest(id);
		const payload = await readAsyncPayload(id);
		assert.equal(payload.success, false);
		assert.equal(payload.results[0]?.outputState, "present");
		assert.equal(payload.results[0]?.output, "usable partial answer");
	});

	it("matches preflight launch digest in equivalent foreground and async execution", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		const agentName = `contract-worker-${Date.now().toString(36)}`;
		const task = "Compare the resolved launch inputs.";
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		const agentDir = path.join(tempDir, "agent-home");
		process.env.PI_CODING_AGENT_DIR = agentDir;
		const permissionExtDir = path.join(agentDir, "extensions", "pi-permission-system");
		fs.mkdirSync(path.join(permissionExtDir, "src"), { recursive: true });
		fs.writeFileSync(path.join(permissionExtDir, "src", "index.ts"), "export default () => {};", "utf-8");
		fs.writeFileSync(path.join(permissionExtDir, "package.json"), JSON.stringify({ name: "test", pi: { extensions: ["./src/index.ts"] } }), "utf-8");
		const agentPath = path.join(tempDir, ".pi", "agents", `${agentName}.md`);
		fs.mkdirSync(path.dirname(agentPath), { recursive: true });
		fs.writeFileSync(agentPath, `---\nname: ${agentName}\ndescription: Contract comparison worker\npermissions:\n  write: ask\n---\n`, "utf-8");
		try {
			const discovered = discoverAgents(tempDir).agents.find((agent) => agent.name === agentName);
			assert.ok(discovered, "expected temporary agent definition to be discovered");
			const preflight = await resolveSubagentLaunchContract({ agent: agentName, cwd: tempDir, task, runId: "contract-preflight" });
			assert.equal(preflight.ok, true);
			assert.ok(preflight.contract.tools.extensionArgs.some((entry) => entry.endsWith(path.join("pi-permission-system", "src", "index.ts"))));

			mockPi.onCall({ output: "foreground contract comparison" });
			const foreground = await runSync(tempDir, [discovered], agentName, task, { runId: "contract-foreground", acceptance: false });
			assert.equal(foreground.exitCode, 0);
			assert.equal(foreground.launchContractDigest, preflight.contract.launchContractDigest);

			mockPi.onCall({ output: "async contract comparison" });
			const asyncId = `async-contract-equivalence-${Date.now().toString(36)}`;
			const launch = executeAsyncSingle(asyncId, {
				agent: agentName,
				task,
				agentConfig: discovered,
				ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
				artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
				shareEnabled: false,
				sessionRoot: path.join(tempDir, "sessions"),
				maxSubagentDepth: 2,
				acceptance: false,
			});
			const payload = await readAsyncPayload(asyncId);
			assert.equal(launch.details.launchContractDigest, preflight.contract.launchContractDigest);
			assert.equal(payload.launchContractDigest, preflight.contract.launchContractDigest);
			assert.equal(payload.results[0]?.launchContractDigest, preflight.contract.launchContractDigest);
		} finally {
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		}
	});

	it("persists the actual launch digest in async status and result metadata", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({
			output: "digest-bound async done",
			runtimeAcknowledgedExtensions: { version: 1, source: "child-runtime", ids: ["ext.async"], omitted: 0 },
		});
		const id = `async-launch-digest-${Date.now().toString(36)}`;
		const privateExtension = path.join(tempDir, "extensions", "private-extension.ts");
		const recoveryAgentConfig = makeAgent("worker", { completionGuard: false, extensions: [privateExtension], tools: ["read"], systemPrompt: "Base prompt" });
		const launch = executeAsyncSingle(id, {
			agent: "worker",
			task: "Exercise launch digest reporting",
			agentConfig: { ...recoveryAgentConfig, tools: ["read", "intercom", "contact_supervisor"], systemPrompt: "Base prompt\n\nIntercom orchestration channel:" },
			recoveryAgentConfig,
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
			acceptance: false,
			context: "fork",
			intercomBridge: { mode: "off" },
		});
		assert.match(launch.details.launchContractDigest ?? "", /^[a-f0-9]{64}$/);
		const recovery = JSON.parse(fs.readFileSync(path.join(ASYNC_DIR, id, "recovery-descriptor.json"), "utf-8")) as { runFanoutBudget?: { rootRunId?: string; limit?: number }; context?: string; intercomBridge?: { mode?: string }; tools?: string[]; systemPrompt?: string };
		assert.deepEqual(recovery.runFanoutBudget && { rootRunId: recovery.runFanoutBudget.rootRunId, limit: recovery.runFanoutBudget.limit }, { rootRunId: id, limit: 64 });
		assert.equal(recovery.context, "fork");
		assert.deepEqual(recovery.intercomBridge, { mode: "off" });
		assert.deepEqual(recovery.tools, ["read"]);
		assert.equal(recovery.systemPrompt, "Base prompt");
		const payload = await readAsyncPayload(id);
		const status = await waitForAsyncState(id, (candidate) => candidate.state === "complete" && candidate.runtimeAcknowledgedExtensions !== undefined);
		assert.equal(payload.launchContractDigest, launch.details.launchContractDigest);
		assert.equal(payload.results[0]?.launchContractDigest, launch.details.launchContractDigest);
		assert.equal(status.launchContractDigest, launch.details.launchContractDigest);
		assert.equal(status.steps?.[0]?.launchContractDigest, launch.details.launchContractDigest);
		assert.equal(launch.details.launchResolvedExtensions?.source, "launch-resolved");
		assert.equal(launch.details.launchResolvedExtensions?.disableAmbientExtensions, true);
		assert.deepEqual(payload.launchResolvedExtensions, launch.details.launchResolvedExtensions);
		assert.deepEqual(payload.results[0]?.launchResolvedExtensions, launch.details.launchResolvedExtensions);
		assert.deepEqual(status.launchResolvedExtensions, launch.details.launchResolvedExtensions);
		assert.deepEqual(status.steps?.[0]?.launchResolvedExtensions, launch.details.launchResolvedExtensions);
		const runtimeAck = { version: 1, source: "child-runtime", ids: ["ext.async"], omitted: 0 };
		assert.deepEqual(payload.runtimeAcknowledgedExtensions, runtimeAck);
		assert.deepEqual(payload.results[0]?.runtimeAcknowledgedExtensions, runtimeAck);
		assert.deepEqual(status.runtimeAcknowledgedExtensions, runtimeAck);
		assert.deepEqual(status.steps?.[0]?.runtimeAcknowledgedExtensions, runtimeAck);
		assert.ok(!JSON.stringify(launch.details.launchResolvedExtensions).includes(tempDir), "projection should not expose raw extension paths");
		// Stale supervisor-bridge pair: the --tools allowlist passes both names
		// through, but PI_SUBAGENT_REQUIRED_TOOLS excludes them so the 0.50 child
		// runtime cannot fail the run over the removed native intercom (#1207).
		const recoveryCallArgs = readMockPiArgs(mockPi, 0);
		assert.equal(recoveryCallArgs[recoveryCallArgs.indexOf("--tools") + 1], "read,intercom,contact_supervisor");
		assert.deepEqual(readMockPiRequiredTools(mockPi, 0), ["read"]);
	});

	it("rejects async thinking above maxThinking before child startup", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, () => {
		const launch = executeAsyncSingle(`async-thinking-ceiling-${Date.now().toString(36)}`, {
			agent: "worker",
			task: "Use the strongest available reasoning.",
			agentConfig: makeAgent("worker", { model: "mock/test-model", maxThinking: "xhigh", completionGuard: false }),
			thinkingOverride: "max",
			availableModels: [{ provider: "mock", id: "test-model", fullId: "mock/test-model" }],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
		});
		assert.equal(launch.isError, true);
		assert.match(launch.content[0]?.text ?? "", /max.*xhigh.*worker/);
		assert.equal(mockPi.callCount(), 0);
	});

	it("rejects implementation workers without mutation-capable tools before spawn", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, () => {
		const id = `async-readonly-worker-contract-${Date.now().toString(36)}`;
		mockPi.onCall({ output: "should not spawn" });
		const launch = executeAsyncSingle(id, {
			agent: "worker",
			task: "Implement the requested source fix",
			agentConfig: makeAgent("worker", { tools: ["read", "grep", "find", "ls", "contact_supervisor"] }),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
			acceptance: false,
		});

		assert.equal(launch.isError, true);
		assert.match(launch.content[0]?.text ?? "", /no mutation-capable tools/);
		assert.equal(mockPi.callCount(), 0);
	});

	it("lets unrestricted implementation workers spawn", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		const id = `async-unrestricted-worker-contract-${Date.now().toString(36)}`;
		mockPi.onCall({ output: "implemented" });
		const launch = executeAsyncSingle(id, {
			agent: "worker",
			task: "Implement the requested source fix",
			agentConfig: makeAgent("worker"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
			acceptance: false,
		});

		assert.equal(launch.isError, undefined);
		await waitForAsyncResultFile(id, 10_000);
		assert.equal(mockPi.callCount(), 1);
	});

	it("lets explicit fast false opt out async external single runs from inherited fast mode", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		const agentConfig = makeAgent("external", {
			fast: true,
			runner: { type: "external-cli", command: process.execPath, args: ["-e", "process.stdout.write('external async fast false')"] },
		} as never);

		const rejected = executeAsyncSingle(`async-external-fast-inherited-${Date.now().toString(36)}`, {
			agent: "external",
			task: "Run external",
			agentConfig,
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
		});
		assert.equal(rejected.isError, true);
		assert.match(rejected.content[0]?.text ?? "", /does not support: fast mode/);

		const id = `async-external-fast-false-${Date.now().toString(36)}`;
		const launch = executeAsyncSingle(id, {
			agent: "external",
			task: "Run external",
			agentConfig,
			fast: false,
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
		});

		assert.equal(launch.isError, undefined, launch.content[0]?.text ?? "launch failed");
		const payload = await readAsyncPayload(id);
		assert.equal(payload.success, true);
		assert.match(payload.results[0]?.output ?? "", /external async fast false/);
		assert.equal(mockPi.callCount(), 0);
	});

	it("lets explicit fast false opt out async external chains from inherited fast mode", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		const agent = makeAgent("external", {
			fast: true,
			runner: { type: "external-cli", command: process.execPath, args: ["-e", "process.stdout.write('external chain fast false')"] },
		} as never);

		const rejected = executeAsyncChain(`async-chain-external-fast-inherited-${Date.now().toString(36)}`, {
			chain: [{ agent: "external", task: "Run external" }],
			resultMode: "chain",
			agents: [agent],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			acceptance: false,
		});
		assert.equal(rejected.isError, true);
		assert.match(rejected.content[0]?.text ?? "", /does not support: fast mode/);

		const id = `async-chain-external-fast-false-${Date.now().toString(36)}`;
		const launch = executeAsyncChain(id, {
			chain: [{ agent: "external", task: "Run external" }],
			resultMode: "chain",
			agents: [agent],
			fast: false,
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			acceptance: false,
		});

		assert.equal(launch.isError, undefined, launch.content[0]?.text ?? "launch failed");
		const payload = await readAsyncPayload(id);
		assert.equal(payload.success, true);
		assert.match(payload.results[0]?.output ?? "", /external chain fast false/);
		assert.equal(mockPi.callCount(), 0);
	});

	it("rejects implementation workers when a capability ceiling removes mutation tools before spawn", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, () => {
		const id = `async-ceiling-readonly-worker-contract-${Date.now().toString(36)}`;
		mockPi.onCall({ output: "should not spawn" });
		const launch = executeAsyncSingle(id, {
			agent: "worker",
			task: "Implement the requested source fix",
			agentConfig: makeAgent("worker", { tools: ["read", "write"] }),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
			acceptance: false,
			capabilityCeiling: { version: 1, allowedTools: ["read"], denyExtensions: true, sources: ["test"] },
		});

		assert.equal(launch.isError, true);
		assert.match(launch.content[0]?.text ?? "", /no mutation-capable tools/);
		assert.equal(mockPi.callCount(), 0);
	});

	it("rejects workflow implementation workers without mutation-capable tools before spawn", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, () => {
		const id = `async-workflow-readonly-worker-contract-${Date.now().toString(36)}`;
		mockPi.onCall({ output: "should not spawn" });
		const launch = executeAsyncChain(id, {
			chain: [{ agent: "worker", task: "Implement the requested source fix" }],
			resultMode: "chain",
			agents: [makeAgent("worker", { tools: ["read", "grep", "find", "ls", "contact_supervisor"] })],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			maxSubagentDepth: 2,
			acceptance: false,
		});

		assert.equal(launch.isError, true);
		assert.match(launch.content[0]?.text ?? "", /no mutation-capable tools/);
		assert.equal(mockPi.callCount(), 0);
	});

	it("rejects workflow read-only workers after previous-output templates resolve to implementation tasks", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		const id = `async-workflow-resolved-readonly-worker-contract-${Date.now().toString(36)}`;
		mockPi.onCall({ output: "Implement the requested source fix" });
		mockPi.onCall({ output: "should not spawn" });
		const launch = executeAsyncChain(id, {
			chain: [
				{ agent: "producer", task: "Return the next instruction" },
				{ agent: "worker", task: "{previous}" },
			],
			resultMode: "chain",
			agents: [
				makeAgent("producer", { completionGuard: false }),
				makeAgent("worker", { tools: ["read", "grep", "find", "ls", "contact_supervisor"] }),
			],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			maxSubagentDepth: 2,
			acceptance: false,
		});

		assert.equal(launch.isError, undefined);
		const resultPath = await waitForAsyncResultFile(id, 10_000);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		assert.equal(payload.success, false);
		assert.match(payload.results[1]?.error ?? "", /no mutation-capable tools/);
		assert.equal(mockPi.callCount(), 1);
	});

	it("background parallel groups report usage budget state and block queued children", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ output: "first async result" });
		const id = `async-usage-budget-${Date.now().toString(36)}`;
		const launch = executeAsyncChain(id, {
			chain: [{
				parallel: [
					{ agent: "first", task: "First task" },
					{ agent: "second", task: "Second task" },
				],
				concurrency: 1,
			}],
			resultMode: "parallel",
			usageBudget: { tokens: { hard: 10 } },
			agents: [makeAgent("first"), makeAgent("second")],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			maxSubagentDepth: 2,
		});

		assert.equal(launch.details.usageBudget?.exhausted, false);
		const payload = await readAsyncPayload(id);
		const status = JSON.parse(fs.readFileSync(path.join(ASYNC_DIR, id, "status.json"), "utf-8")) as AsyncStatusPayload;
		assert.equal(payload.success, false);
		assert.equal(payload.state, "failed");
		assert.match(payload.error ?? payload.summary ?? "", /Usage budget exhausted/);
		assert.equal(payload.results.length, 2);
		assert.equal(payload.results[1]?.skipped, true);
		assert.match(payload.results[1]?.error ?? "", /Usage budget exhausted/);
		assert.equal(mockPi.callCount(), 1);
		assert.equal(payload.usageBudget?.exhausted, true);
		assert.equal(payload.usageBudget?.reason, "tokens");
		assert.equal(status.usageBudget?.exhausted, true);
		assert.equal(status.steps?.[0]?.status, "complete");
		assert.equal(status.steps?.[1]?.status, "failed");
	});

	it("background fails with protocol_output_limit for an oversized stdout line", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ stdoutRaw: "x".repeat(MAX_CHILD_PENDING_LINE_BYTES + 1) });
		const id = `async-protocol-limit-${Date.now().toString(36)}`;
		launchProtocolTest(id);
		const payload = await readAsyncPayload(id);
		assert.equal(payload.success, false);
		assert.equal(payload.results[0]?.protocolError?.code, "protocol_output_limit");
		assert.equal(payload.results[0]?.protocolError?.stream, "stdout");
		assert.match(payload.results[0]?.error ?? "", /protocol_output_limit/);
	});

	it("routes async artifacts to the configured session directory", { skip: !isAsyncAvailable() || !createSubagentExecutor ? "jiti or executor not available" : undefined }, async () => {
		mockPi.onCall({ output: "async session artifact" });
		const sessionFile = path.join(tempDir, "sessions", "parent-session", "session.jsonl");
		const ctx = makeMinimalCtx(tempDir);
		ctx.sessionManager.getSessionFile = () => sessionFile;
		const executor = makeAsyncExecutor([makeAgent("worker", { completionGuard: false })], { artifactDir: "session" });

		const launch = await executor.execute(
			"async-session-artifact-dir",
			{ agent: "worker", task: "Write async session artifacts", async: true, runId: "async-session-artifacts", acceptance: false },
			new AbortController().signal,
			undefined,
			ctx,
		) as AsyncExecutionResult;

		const expectedDir = path.join(path.dirname(sessionFile), "subagent-artifacts");
		assert.equal(launch.isError, undefined);
		assert.ok(launch.details.asyncId);
		const descriptor = JSON.parse(fs.readFileSync(path.join(launch.details.asyncDir!, "recovery-descriptor.json"), "utf-8"));
		assert.equal(descriptor.artifactsDir, expectedDir);
		assert.equal(descriptor.artifactConfig.dir, "session");

		const payload = await readAsyncPayload(launch.details.asyncId);
		const outputPath = payload.results[0]?.artifactPaths?.outputPath;
		assert.ok(outputPath?.startsWith(`${expectedDir}${path.sep}`));
		assert.equal(fs.readFileSync(outputPath, "utf-8"), "async session artifact");
		assert.equal(fs.existsSync(path.join(tempDir, ".pi/subagents", "artifacts")), false);
	});

	it("persists async capability ceiling audit to status, results, events, and metadata", { skip: !isAsyncAvailable() || !createSubagentExecutor ? "jiti or executor not available" : undefined }, async () => {
		mockPi.onCall({ output: "restricted async done" });
		const sessionId = `session-capability-${Date.now().toString(36)}`;
		const handle = registerSubagentCapabilityCeiling({ sessionId, ceiling: { allowedTools: ["read"], denyExtensions: true }, source: "test" });
		try {
			const executor = makeAsyncExecutor([makeAgent("worker", { tools: ["read", "write"], completionGuard: false })]);
			const id = `async-capability-${Date.now().toString(36)}`;
			const ctx = makeMinimalCtx(tempDir);
			ctx.sessionManager.getSessionId = () => sessionId;
			const launch = await executor.execute(
				id,
				{ agent: "worker", task: "Run with a restricted capability ceiling", async: true, runId: id, acceptance: false, artifacts: true },
				new AbortController().signal,
				undefined,
				ctx,
			) as AsyncExecutionResult;
			assert.equal(launch.isError, undefined);
			const asyncId = launch.details.asyncId;
			assert.ok(asyncId);
			const resultPath = await waitForAsyncResultFile(asyncId, 10_000);
			const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
			const status = JSON.parse(fs.readFileSync(path.join(ASYNC_DIR, asyncId, "status.json"), "utf-8")) as AsyncStatusPayload;
			assert.deepEqual(payload.capabilityCeiling, { version: 1, allowedTools: ["read"], denyExtensions: true, sources: ["test"] });
			assert.deepEqual(payload.results[0]?.capabilityCeiling, payload.capabilityCeiling);
			assert.deepEqual(status.capabilityCeiling, payload.capabilityCeiling);
			assert.deepEqual(status.steps?.[0]?.capabilityCeiling, payload.capabilityCeiling);
			assert.deepEqual(payload.capabilityAudit?.effectiveTools, ["read"]);
			assert.deepEqual(payload.capabilityAudit?.removedTools, ["write", "contact_supervisor"]);
			assert.equal(payload.capabilityAudit?.extensionsDenied, true);
			const events = fs.readFileSync(path.join(ASYNC_DIR, asyncId, "events.jsonl"), "utf-8").trim().split("\n").map((line) => JSON.parse(line));
			assert.ok(events.some((event) => event.type === "subagent.capability-ceiling.applied" && event.stepIndex === 0 && event.capabilityAudit?.removedTools?.includes("write")));
			const metadataPath = payload.results[0]?.artifactPaths?.metadataPath;
			assert.ok(metadataPath);
			const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf-8")) as { launchContractDigest?: string; capabilityCeiling?: unknown; capabilityAudit?: { removedTools?: string[] } };
			assert.equal(metadata.launchContractDigest, payload.results[0]?.launchContractDigest);
			assert.deepEqual(metadata.capabilityCeiling, payload.capabilityCeiling);
			assert.deepEqual(metadata.capabilityAudit?.removedTools, ["write", "contact_supervisor"]);
		} finally {
			handle.dispose();
		}
	});

	it("redacts async task text from durable artifacts, transcripts, and metadata", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ output: "async redaction complete" });
		const id = `async-prompt-redaction-${Date.now().toString(36)}`;
		const sentinel = "ASYNC_RAW_PROMPT_SENTINEL_1021";
		executeAsyncSingle(id, {
			agent: "worker",
			task: `Handle ${sentinel} without persisting it`,
			agentConfig: makeAgent("worker", { completionGuard: false }),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: true, includeInput: true, includeOutput: true, includeJsonl: false, includeTranscript: true, includeMetadata: true, cleanupDays: 7 },
			artifactsDir: path.join(tempDir, ".pi/subagents", "artifacts"),
			shareEnabled: false,
			maxSubagentDepth: 2,
			acceptance: false,
		});

		await waitForMockPiCall(mockPi, 0);
		const callFile = fs.readdirSync(mockPi.dir).find((name) => name.endsWith(".json"));
		assert.ok(callFile);
		const call = JSON.parse(fs.readFileSync(path.join(mockPi.dir, callFile), "utf-8")) as { args?: string[] };
		assert.match(call.args?.join("\n") ?? "", new RegExp(sentinel));

		const payload = await readAsyncPayload(id);
		const artifactPaths = payload.results[0]?.artifactPaths;
		assert.ok(artifactPaths?.inputPath);
		assert.ok(artifactPaths.metadataPath);
		assert.ok(artifactPaths.transcriptPath);
		const inputText = fs.readFileSync(artifactPaths.inputPath, "utf-8");
		const transcriptText = fs.readFileSync(artifactPaths.transcriptPath, "utf-8");
		const metadataText = fs.readFileSync(artifactPaths.metadataPath, "utf-8");
		assert.doesNotMatch(inputText, new RegExp(sentinel));
		assert.doesNotMatch(transcriptText, new RegExp(sentinel));
		assert.doesNotMatch(metadataText, new RegExp(sentinel));
		assert.match(inputText, /\[prompt redacted\]/);
		assert.match(transcriptText, /\[prompt redacted\]/);
		assert.equal((JSON.parse(metadataText) as { task?: string }).task, "[prompt redacted]");
	});

	it("background writes a failure stub to output artifacts when no output was produced", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ output: "", stderr: "model unavailable", exitCode: 1 });
		const id = `async-empty-failure-artifact-${Date.now().toString(36)}`;
		executeAsyncSingle(id, {
			agent: "worker",
			task: "Fail before output",
			agentConfig: makeAgent("worker", { completionGuard: false }),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: true, includeInput: true, includeOutput: true, includeJsonl: false, includeMetadata: true, cleanupDays: 7 },
			artifactsDir: path.join(tempDir, ".pi/subagents", "artifacts"),
			shareEnabled: false,
			maxSubagentDepth: 2,
			acceptance: false,
		});

		const payload = await readAsyncPayload(id);
		assert.equal(payload.success, false);
		const outputPath = payload.results[0]?.artifactPaths?.outputPath;
		assert.ok(outputPath, "should expose an output artifact path");
		const artifact = fs.readFileSync(outputPath, "utf-8");
		assert.match(artifact, /Subagent run failed before producing output\./);
		assert.match(artifact, /Error:\nmodel unavailable/);
		assert.match(artifact, /Transcript:/);
		assert.match(artifact, /Metadata:/);
	});

	it("recreates project-local artifact directories removed before async completion", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ delay: 800, output: "completed after artifact cleanup" });
		const id = `async-artifact-dir-recovery-${Date.now().toString(36)}`;
		const artifactsDir = path.join(tempDir, ".pi/subagents", "artifacts");
		executeAsyncSingle(id, {
			agent: "worker",
			task: "Complete after generated artifacts are cleaned",
			agentConfig: makeAgent("worker", { completionGuard: false }),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: true, includeInput: true, includeOutput: true, includeJsonl: false, includeMetadata: true, cleanupDays: 7 },
			artifactsDir,
			shareEnabled: false,
			maxSubagentDepth: 2,
			acceptance: false,
		});

		await waitForMockPiCall(mockPi, 0);
		assert.equal(fs.existsSync(artifactsDir), true);
		fs.rmSync(path.join(tempDir, ".pi/subagents"), { recursive: true, force: true });

		const payload = await readAsyncPayload(id);
		assert.equal(payload.success, true);
		assert.equal(payload.results[0]?.outputSaveError, undefined);
		assert.equal(payload.results[0]?.metadataSaveError, undefined);
		const outputPath = payload.results[0]?.artifactPaths?.outputPath;
		const metadataPath = payload.results[0]?.artifactPaths?.metadataPath;
		assert.ok(outputPath && metadataPath);
		assert.equal(fs.readFileSync(outputPath, "utf-8"), "completed after artifact cleanup");
		assert.equal((JSON.parse(fs.readFileSync(metadataPath, "utf-8")) as { exitCode?: number }).exitCode, 0);
	});

	it("background keeps only a bounded UTF-8 stderr tail", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ output: "failed", stderr: `${"x".repeat(MAX_CHILD_STDERR_BYTES + 1024)}终`, exitCode: 1 });
		const id = `async-stderr-tail-${Date.now().toString(36)}`;
		launchProtocolTest(id);
		const payload = await readAsyncPayload(id);
		assert.equal(payload.success, false);
		assert.ok(Buffer.byteLength(payload.results[0]?.error ?? "") <= MAX_CHILD_STDERR_BYTES);
		assert.match(payload.results[0]?.error ?? "", /终$/);
	});

	it("background preserves retry lifecycle from an oversized agent_end aggregate", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ steps: [
			{ jsonl: [
				events.assistantMessage("retrying oversized async response"),
				{ type: "agent_end", messages: ["x".repeat(MAX_CHILD_PENDING_LINE_BYTES)], willRetry: true },
			] },
			{ delay: 1400, jsonl: [events.assistantMessage("settled after oversized aggregate"), { type: "agent_end", willRetry: false }, { type: "agent_settled" }] },
		] });
		const id = `async-lifecycle-oversized-retry-${Date.now().toString(36)}`;
		const startedAt = Date.now();
		launchProtocolTest(id);
		const payload = await readAsyncPayload(id);
		assert.equal(payload.success, true);
		assert.equal(payload.results[0]?.protocolError, undefined);
		assert.equal(payload.results[0]?.output, "settled after oversized aggregate");
		assert.ok(Date.now() - startedAt >= 1200, "projected agent_end must cancel the retry drain");
	});

	it("background cancels final drain while agent_end reports a retry and waits for agent_settled", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ steps: [
			{ jsonl: [events.assistantMessage("retrying async response"), { type: "agent_end", willRetry: true }] },
			{ delay: 1400, jsonl: [events.assistantMessage("settled async response"), { type: "agent_end", willRetry: false }, { type: "agent_settled" }] },
		] });
		const id = `async-lifecycle-retry-${Date.now().toString(36)}`;
		const startedAt = Date.now();
		launchProtocolTest(id);
		const payload = await readAsyncPayload(id);
		assert.equal(payload.success, true);
		assert.equal(payload.results[0]?.output, "settled async response");
		assert.ok(Date.now() - startedAt >= 1200, "background runner must not terminate during the retry delay");
	});

	it("background does not drain on settlement from a compaction attempt that will retry", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ steps: [
			{ jsonl: [{ type: "compaction_end", willRetry: true }, { type: "agent_settled" }] },
			{ delay: 1400, jsonl: [events.assistantMessage("settled after compaction retry"), { type: "agent_start" }, { type: "agent_end", willRetry: false }, { type: "agent_settled" }] },
		] });
		const id = `async-lifecycle-compaction-retry-${Date.now().toString(36)}`;
		const startedAt = Date.now();
		launchProtocolTest(id);
		const payload = await readAsyncPayload(id);
		assert.equal(payload.success, true);
		assert.equal(payload.results[0]?.output, "settled after compaction retry");
		assert.ok(Date.now() - startedAt >= 1200, "background runner must not terminate during compaction retry");
	});

	it("background treats agent_settled as a clean terminal watermark", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ jsonl: [mockAssistantMessage("settled async without a terminal assistant stop", "tool_use"), { type: "agent_settled" }], keepAliveAfterFinalMessageMs: 15_000 });
		const id = `async-lifecycle-settled-${Date.now().toString(36)}`;
		const startedAt = Date.now();
		launchProtocolTest(id);
		const payload = await readAsyncPayload(id);
		assert.equal(payload.success, true);
		assert.equal(payload.results[0]?.error, undefined);
		assert.equal(payload.results[0]?.output, "settled async without a terminal assistant stop");
		assert.ok(Date.now() - startedAt < 10_000, "agent_settled should trigger bounded child cleanup");
	});

	it("does not report successful compaction settlement as a failure", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({
			jsonl: [{ type: "compaction_start" }, mockAssistantMessage("settled after compaction"), { type: "agent_settled" }],
			keepAliveAfterFinalMessageMs: 15_000,
		});
		const id = `async-lifecycle-compaction-success-${Date.now().toString(36)}`;
		launchProtocolTest(id);
		const payload = await readAsyncPayload(id);
		assert.equal(payload.success, true);
		assert.equal(payload.results[0]?.success, true);
		assert.equal(payload.results[0]?.error, undefined);
		assert.equal(payload.results[0]?.output, "settled after compaction");
		assert.equal(payload.results[0]?.effects?.settlementDiagnostic, undefined);
		const status = await waitForAsyncState(id, (candidate) => candidate.state === "complete");
		assert.equal(status.steps?.[0]?.effects?.settlementDiagnostic, undefined);
	});

	it("keeps named output references literal in async single tasks", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		const task = "Reply with OK. You may reference {outputs.name} if it helps.";
		mockPi.onCall({ output: "OK" });
		const id = `async-single-literal-output-ref-${Date.now().toString(36)}`;
		const result = executeAsyncSingle(id, {
			agent: "worker",
			task,
			agentConfig: makeAgent("worker"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
		});

		assert.equal(result.isError, undefined);
		const call = await waitForMockPiCall(mockPi, 0, 10_000);
		assert.match(call.args.at(-1) ?? "", /\{outputs\.name\}/);
		const payload = await readAsyncPayload(id);
		assert.equal(payload.success, true);
		assert.equal(payload.results[0]?.output, "OK");
	});

	it("spawns the async runner with node when process.execPath is not node", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		const originalExecPath = process.execPath;
		process.execPath = path.join(tempDir, process.platform === "win32" ? "pi.exe" : "pi");
		try {
			mockPi.onCall({ output: "non-node exec async done" });
			const id = `async-non-node-exec-${Date.now().toString(36)}`;
			const result = executeAsyncSingle(id, {
				agent: "worker",
				task: "Say non-node exec async done. Do not edit files.",
				agentConfig: makeAgent("worker"),
				ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
				artifactConfig: {
					enabled: false,
					includeInput: false,
					includeOutput: false,
					includeJsonl: false,
					includeMetadata: false,
					cleanupDays: 7,
				},
				shareEnabled: false,
				sessionRoot: path.join(tempDir, "sessions"),
				maxSubagentDepth: 2,
			});

			assert.equal(result.isError, undefined);
			const resultPath = await waitForAsyncResultFile(id, 30_000);
			const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
			assert.equal(payload.success, true);
			assert.equal(payload.results[0]?.output, "non-node exec async done");
		} finally {
			process.execPath = originalExecPath;
		}
	});

	it("falls back to PATH node when node-like process.execPath is stale", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		const originalExecPath = process.execPath;
		process.execPath = path.join(tempDir, "deleted-node-install", "bin", process.platform === "win32" ? "node.exe" : "node");
		try {
			mockPi.onCall({ output: "stale node exec async done" });
			const id = `async-stale-node-exec-${Date.now().toString(36)}`;
			const result = executeAsyncSingle(id, {
				agent: "worker",
				task: "Say stale node exec async done. Do not edit files.",
				agentConfig: makeAgent("worker"),
				ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
				artifactConfig: {
					enabled: false,
					includeInput: false,
					includeOutput: false,
					includeJsonl: false,
					includeMetadata: false,
					cleanupDays: 7,
				},
				shareEnabled: false,
				sessionRoot: path.join(tempDir, "sessions"),
				maxSubagentDepth: 2,
			});

			assert.equal(result.isError, undefined);
			const resultPath = await waitForAsyncResultFile(id, 10_000);
			const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
			assert.equal(payload.success, true);
			assert.equal(payload.results[0]?.output, "stale node exec async done");
		} finally {
			process.execPath = originalExecPath;
		}
	});

	it("readStatus returns null for missing directory", () => {
		const status = readStatus("/nonexistent/path/abc123");
		assert.equal(status, null);
	});

	it("readStatus parses valid status file", () => {
		const dir = createTempDir();
		try {
			const statusData = {
				runId: "test-123",
				state: "running",
				mode: "single",
				startedAt: Date.now(),
				lastUpdate: Date.now(),
				steps: [{ agent: "test", status: "running" }],
			};
			fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify(statusData));

			const status = readStatus(dir);
			assert.ok(status, "should parse status");
			assert.equal(status.runId, "test-123");
			assert.equal(status.state, "running");
			assert.equal(status.mode, "single");
		} finally {
			removeTempDir(dir);
		}
	});

	it("interrupts every active async parallel child", { skip: !isAsyncAvailable() ? "jiti not available" : process.platform === "win32" ? "cross-process interrupt delivery unreliable on Windows CI" : undefined }, async () => {
		mockPi.onCall({ delay: 5_000, output: "one done" });
		mockPi.onCall({ delay: 5_000, output: "two done" });
		mockPi.onCall({ delay: 5_000, output: "three done" });
		const id = `async-interrupt-parallel-${Date.now().toString(36)}`;
		executeAsyncChain(id, {
			chain: [{
				parallel: [
					{ agent: "one", task: "Wait" },
					{ agent: "two", task: "Wait" },
					{ agent: "three", task: "Wait" },
				],
				concurrency: 3,
			}],
			resultMode: "parallel",
			agents: [makeAgent("one"), makeAgent("two"), makeAgent("three")],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			maxSubagentDepth: 2,
		});

		await waitForMockPiCall(mockPi, 2, 10_000);
		const asyncDir = path.join(ASYNC_DIR, id);
		const statusPath = path.join(asyncDir, "status.json");
		const statusBeforeInterrupt = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatusPayload & { pid?: number };
		deliverInterruptRequest({ asyncDir, pid: statusBeforeInterrupt.pid, source: "test" });

		const resultPath = await waitForAsyncResultFile(id, 30_000);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		const status = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatusPayload;
		assert.equal(payload.state, "paused");
		assert.equal(payload.success, false);
		assert.deepEqual(status.steps?.map((step) => step.status), ["paused", "paused", "paused"]);
		assert.equal(mockPi.callCount(), 3);
	});

	it("journals terminal child status events for running async child stops", { skip: !isAsyncAvailable() ? "jiti not available" : process.platform === "win32" ? "cross-process stop delivery unreliable on Windows CI" : undefined }, async () => {
		mockPi.onCall({ delay: 5_000, output: "one late" });
		mockPi.onCall({ delay: 250, output: "two done" });
		const id = `async-child-stop-parallel-${Date.now().toString(36)}`;
		executeAsyncChain(id, {
			chain: [{
				parallel: [
					{ agent: "one", task: "Wait" },
					{ agent: "two", task: "Finish" },
				],
				concurrency: 2,
			}],
			resultMode: "parallel",
			agents: [makeAgent("one"), makeAgent("two")],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			maxSubagentDepth: 2,
		});

		await waitForMockPiCall(mockPi, 1, 10_000);
		const asyncDir = path.join(ASYNC_DIR, id);
		const statusBeforeStop = await waitForAsyncState(id, (candidate) => candidate.steps?.[0]?.status === "running" && typeof candidate.pid === "number");
		deliverStopRequest({ asyncDir, pid: statusBeforeStop.pid, source: "test", targetIndex: 0, childId: "step:0" });

		await waitForAsyncResultFile(id, 30_000);
		const status = await waitForAsyncState(id, (candidate) => candidate.state !== "running");
		assert.equal(status.steps?.[0]?.status, "stopped");
		const childStatusEvents = fs.readFileSync(path.join(asyncDir, "events.jsonl"), "utf-8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { type?: string; childId?: string; status?: string });
		assert.ok(childStatusEvents.some((event) => event.type === "subagent.child-status" && event.childId === "step:0" && event.status === "stopping"));
		assert.ok(childStatusEvents.some((event) => event.type === "subagent.child-status" && event.childId === "step:0" && event.status === "stopped"));
	});

	it("marks async parallel runs that exceed timeoutMs as timed out", { skip: !isAsyncAvailable() ? "jiti not available" : process.platform === "win32" ? "timeout signal delivery intermittent on Windows CI" : undefined }, async () => {
		mockPi.onCall({ delay: 5_000, output: "one done" });
		mockPi.onCall({ delay: 5_000, output: "two done" });
		const repo = createRepo("pi-subagents-parallel-timeout-recovery-");
		try {
			const id = `async-timeout-parallel-${Date.now().toString(36)}`;
			executeAsyncChain(id, {
				chain: [{
					parallel: [
						{ agent: "one", task: "Wait" },
						{ agent: "two", task: "Wait" },
					],
					concurrency: 2,
				}],
				resultMode: "parallel",
				agents: [makeAgent("one"), makeAgent("two")],
				ctx: { pi: { events: { emit() {} } }, cwd: repo, currentSessionId: "session-1" },
				artifactConfig: {
					enabled: false,
					includeInput: false,
					includeOutput: false,
					includeJsonl: false,
					includeMetadata: false,
					cleanupDays: 7,
				},
				shareEnabled: false,
				maxSubagentDepth: 2,
				timeoutMs: 1_500,
			});

			await waitForMockPiCall(mockPi, 1, 10_000);
			fs.writeFileSync(path.join(repo, "input.md"), "parallel partial child change\n", "utf-8");
			const resultPath = await waitForAsyncResultFile(id, 8_000);
			const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
			const status = await waitForAsyncState(id, (candidate) => candidate.state === "failed");
			assert.equal(payload.state, "failed");
			assert.equal(payload.success, false);
			assert.equal(payload.exitCode, 1);
			assert.equal(payload.timeoutMs, 1_500);
			assert.equal(payload.timedOut, true);
			assert.match(payload.summary ?? "", /Subagent timed out after 1500ms\./);
			assert.equal(status.state, "failed");
			assert.equal(status.timeoutMs, 1_500);
			assert.equal(status.timedOut, true);
			assert.match(status.error ?? "", /Subagent timed out after 1500ms\./);
			assert.deepEqual(status.steps?.map((step) => step.status), ["failed", "failed"]);
			assert.deepEqual(status.steps?.map((step) => step.timedOut), [true, true]);
			assert.deepEqual(status.steps?.map((step) => step.error), ["Subagent timed out after 1500ms.", "Subagent timed out after 1500ms."]);
			assert.deepEqual(status.steps?.map((step) => step.timeoutRecovery?.changedFiles), [["input.md"], ["input.md"]]);
			assert.deepEqual(payload.results.map((result) => result.timedOut), [true, true]);
			assert.deepEqual(payload.results.map((result) => result.timeoutRecovery?.changedFiles), [["input.md"], ["input.md"]]);
			assert.ok(payload.results.every((result) => /Recovery summary:/.test(result.output ?? "")));
			assert.equal(mockPi.callCount(), 2);
		} finally {
			fs.rmSync(repo, { recursive: true, force: true });
		}
	});

	it("enforces an agent-level timeout on an async serial child without a composite deadline", { skip: !isAsyncAvailable() ? "jiti not available" : process.platform === "win32" ? "timeout signal delivery intermittent on Windows CI" : undefined }, async () => {
		mockPi.onCall({ delay: 5_000, output: "too late" });
		const id = `async-child-timeout-chain-${Date.now().toString(36)}`;
		executeAsyncChain(id, {
			chain: [{ agent: "slow", task: "Wait" }],
			agents: [makeAgent("slow", { defaultTimeoutMs: 150 })],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			maxSubagentDepth: 2,
		});

		const payload = await readAsyncPayload(id);
		assert.equal(payload.timeoutMs, undefined, "composite parent must remain unbounded by default");
		assert.equal(payload.state, "failed");
		assert.equal(payload.results[0]?.timedOut, true);
		assert.equal(payload.results[0]?.error, "Subagent timed out after 150ms.");
	});

	it("preserves async timeout recovery summaries in final results", { skip: !isAsyncAvailable() ? "jiti not available" : process.platform === "win32" ? "timeout signal delivery intermittent on Windows CI" : undefined }, async () => {
		mockPi.onCall({ delay: 5_000, output: "too late" });
		const repo = createRepo("pi-subagents-timeout-recovery-");
		try {
			const id = `async-timeout-recovery-${Date.now().toString(36)}`;
			executeAsyncChain(id, {
				chain: [{ agent: "slow", task: "Wait" }],
				agents: [makeAgent("slow")],
				ctx: { pi: { events: { emit() {} } }, cwd: repo, currentSessionId: "session-1" },
				artifactConfig: {
					enabled: true,
					includeInput: false,
					includeOutput: true,
					includeJsonl: true,
					includeMetadata: true,
					cleanupDays: 7,
				},
				shareEnabled: false,
				maxSubagentDepth: 2,
				timeoutMs: 1200,
			});

			await waitForMockPiCall(mockPi, 0, 10_000);
			fs.writeFileSync(path.join(repo, "input.md"), "partial child change\n", "utf-8");
			const payload = await readAsyncPayload(id);
			const status = await waitForAsyncState(id, (candidate) => candidate.state === "failed");
			const result = payload.results[0];
			assert.equal(result?.timedOut, true);
			assert.deepEqual(result?.timeoutRecovery?.changedFiles, ["input.md"]);
			assert.match(result?.timeoutRecovery?.message ?? "", /changed tracked files: input\.md/);
			assert.match(result?.output ?? "", /Recovery summary:/);
			assert.match(result?.output ?? "", /Warning: Inspect partial changes before retrying/);
			assert.deepEqual(status.steps?.[0]?.timeoutRecovery?.changedFiles, ["input.md"]);
		} finally {
			fs.rmSync(repo, { recursive: true, force: true });
		}
	});

	it("kills a wedged tool at the per-tool timeout with a tool-specific error before the run-level timeout", { skip: !isAsyncAvailable() ? "jiti not available" : process.platform === "win32" ? "timeout signal delivery intermittent on Windows CI" : undefined }, async () => {
		// Wedge: tool_execution_start fires, then the mock holds (long delay) so
		// tool_execution_end never arrives — output would keep flowing in a real
		// wedge, which is exactly why a run-level stall detector can't see it.
		mockPi.onCall({
			steps: [
				{ jsonl: [events.toolStart("bash")] },
				{ delay: 30_000 }, // hold far past the per-tool budget; no tool_execution_end
			],
		});
		const id = `async-tool-timeout-${Date.now().toString(36)}`;
		process.env.PI_SUBAGENT_TOOL_TIMEOUT_MS = "1000";
		try {
			executeAsyncChain(id, {
				chain: [{ agent: "one", task: "Wait" }],
				agents: [makeAgent("one")],
				ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
				artifactConfig: {
					enabled: false,
					includeInput: false,
					includeOutput: false,
					includeJsonl: false,
					includeMetadata: false,
					cleanupDays: 7,
				},
				shareEnabled: false,
				maxSubagentDepth: 2,
				timeoutMs: 8_000, // run-level budget is longer; the per-tool timer must fire first
			});

			const payload = await readAsyncPayload(id);
			assert.equal(payload.state, "failed");
			assert.equal(payload.results[0]?.timedOut, true);
			assert.match(payload.results[0]?.error ?? "", /Tool 'bash' exceeded its timeout of 1000ms\./);
		} finally {
			delete process.env.PI_SUBAGENT_TOOL_TIMEOUT_MS;
		}
	});

	it("background keeps a terminal answer authoritative over an earlier tool timeout", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({
			steps: [
				{ jsonl: [events.toolStart("bash")] },
				{ delay: 50, jsonl: [events.assistantMessage("Done")] },
			],
			keepAliveAfterFinalMessageMs: 1_500,
		});
		const id = `async-terminal-tool-timeout-${Date.now().toString(36)}`;
		process.env.PI_SUBAGENT_TOOL_TIMEOUT_MS = "600";
		try {
			executeAsyncChain(id, {
				chain: [{ agent: "one", task: "Do work" }],
				agents: [makeAgent("one")],
				ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
				artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
				shareEnabled: false,
				maxSubagentDepth: 2,
				timeoutMs: 5_000,
			});

			const payload = await readAsyncPayload(id);
			assert.equal(payload.success, true);
			assert.equal(payload.results[0]?.timedOut, undefined);
			assert.equal(payload.results[0]?.output, "Done");
		} finally {
			delete process.env.PI_SUBAGENT_TOOL_TIMEOUT_MS;
		}
	});

	it("keeps an earlier wedged tool armed when another tool starts and ends", { skip: !isAsyncAvailable() ? "jiti not available" : process.platform === "win32" ? "timeout signal delivery intermittent on Windows CI" : undefined }, async () => {
		mockPi.onCall({
			steps: [
				{ jsonl: [{ type: "tool_execution_start", toolCallId: "bash-1", toolName: "bash", args: {} }] },
				{ delay: 50, jsonl: [
					{ type: "tool_execution_start", toolCallId: "read-1", toolName: "read", args: { path: "README.md" } },
					{ type: "tool_execution_end", toolCallId: "read-1", toolName: "read" },
				] },
				{ delay: 30_000 },
			],
		});
		const id = `async-tool-timeout-overlap-${Date.now().toString(36)}`;
		process.env.PI_SUBAGENT_TOOL_TIMEOUT_MS = "1000";
		try {
			executeAsyncChain(id, {
				chain: [{ agent: "one", task: "Wait" }],
				agents: [makeAgent("one")],
				ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
				artifactConfig: {
					enabled: false,
					includeInput: false,
					includeOutput: false,
					includeJsonl: false,
					includeMetadata: false,
					cleanupDays: 7,
				},
				shareEnabled: false,
				maxSubagentDepth: 2,
				timeoutMs: 8_000,
			});

			const payload = await readAsyncPayload(id);
			assert.equal(payload.state, "failed");
			assert.equal(payload.results[0]?.timedOut, true);
			assert.match(payload.results[0]?.error ?? "", /Tool 'bash' exceeded its timeout of 1000ms\./);
		} finally {
			delete process.env.PI_SUBAGENT_TOOL_TIMEOUT_MS;
		}
	});

	it("lets the shorter run-level deadline win over a per-tool timeout", { skip: !isAsyncAvailable() ? "jiti not available" : process.platform === "win32" ? "timeout signal delivery intermittent on Windows CI" : undefined }, async () => {
		mockPi.onCall({
			steps: [
				{ jsonl: [events.toolStart("bash")] },
				{ delay: 30_000 },
			],
		});
		const id = `async-tool-timeout-run-budget-${Date.now().toString(36)}`;
		process.env.PI_SUBAGENT_TOOL_TIMEOUT_MS = "1000";
		try {
			executeAsyncChain(id, {
				chain: [{ agent: "one", task: "Wait" }],
				agents: [makeAgent("one")],
				ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
				artifactConfig: {
					enabled: false,
					includeInput: false,
					includeOutput: false,
					includeJsonl: false,
					includeMetadata: false,
					cleanupDays: 7,
				},
				shareEnabled: false,
				maxSubagentDepth: 2,
				timeoutMs: 300,
			});

			const payload = await readAsyncPayload(id);
			assert.equal(payload.results[0]?.timedOut, true);
			assert.equal(payload.results[0]?.error, "Subagent timed out after 300ms.");
		} finally {
			delete process.env.PI_SUBAGENT_TOOL_TIMEOUT_MS;
		}
	});

	it("does not kill a tool that completes before the per-tool timeout", { skip: !isAsyncAvailable() ? "jiti not available" : process.platform === "win32" ? "timeout signal delivery intermittent on Windows CI" : undefined }, async () => {
		mockPi.onCall({
			jsonl: [
				events.toolStart("bash"),
				events.toolEnd("bash"),
				events.assistantMessage("done"),
				{ type: "agent_end", willRetry: false },
				{ type: "agent_settled" },
			],
		});
		const id = `async-tool-complete-${Date.now().toString(36)}`;
		process.env.PI_SUBAGENT_TOOL_TIMEOUT_MS = "1000";
		try {
			executeAsyncChain(id, {
				chain: [{ agent: "one", task: "Done" }],
				agents: [makeAgent("one")],
				ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
				artifactConfig: {
					enabled: false,
					includeInput: false,
					includeOutput: false,
					includeJsonl: false,
					includeMetadata: false,
					cleanupDays: 7,
				},
				shareEnabled: false,
				maxSubagentDepth: 2,
				timeoutMs: 8_000,
			});

			const payload = await readAsyncPayload(id);
			assert.equal(payload.state, "complete");
			assert.notEqual(payload.results[0]?.timedOut, true);
		} finally {
			delete process.env.PI_SUBAGENT_TOOL_TIMEOUT_MS;
		}
	});

	it("does not apply the per-tool timeout to supervisor tools (contact_supervisor/intercom)", { skip: !isAsyncAvailable() ? "jiti not available" : process.platform === "win32" ? "timeout signal delivery intermittent on Windows CI" : undefined }, async () => {
		// contact_supervisor holds ~1.5s — longer than the 1s per-tool budget — but
		// is allowlisted, so the per-tool timer must not fire.
		mockPi.onCall({
			steps: [
				{
					delay: 1500,
					jsonl: [
						events.toolStart("contact_supervisor"),
						events.toolEnd("contact_supervisor"),
						events.assistantMessage("done"),
						{ type: "agent_end", willRetry: false },
						{ type: "agent_settled" },
					],
				},
			],
		});
		const id = `async-tool-allowlist-${Date.now().toString(36)}`;
		process.env.PI_SUBAGENT_TOOL_TIMEOUT_MS = "1000";
		try {
			executeAsyncChain(id, {
				chain: [{ agent: "one", task: "Ask" }],
				agents: [makeAgent("one")],
				ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
				artifactConfig: {
					enabled: false,
					includeInput: false,
					includeOutput: false,
					includeJsonl: false,
					includeMetadata: false,
					cleanupDays: 7,
				},
				shareEnabled: false,
				maxSubagentDepth: 2,
				timeoutMs: 8_000,
			});

			const payload = await readAsyncPayload(id);
			assert.equal(payload.state, "complete");
			assert.notEqual(payload.results[0]?.timedOut, true);
		} finally {
			delete process.env.PI_SUBAGENT_TOOL_TIMEOUT_MS;
		}
	});

	it("enforces child timeouts on async parallel tasks without a composite deadline", { skip: !isAsyncAvailable() ? "jiti not available" : process.platform === "win32" ? "timeout signal delivery intermittent on Windows CI" : undefined }, async () => {
		mockPi.onCall({ delay: 5_000, output: "one too late" });
		mockPi.onCall({ delay: 5_000, output: "two too late" });
		const id = `async-child-timeout-parallel-${Date.now().toString(36)}`;
		executeAsyncChain(id, {
			chain: [{
				parallel: [
					{ agent: "slow-one", task: "Wait" },
					{ agent: "slow-two", task: "Wait" },
				],
				concurrency: 2,
			}],
			resultMode: "parallel",
			agents: [
				makeAgent("slow-one", { defaultTimeoutMs: 150 }),
				makeAgent("slow-two", { defaultTimeoutMs: 200 }),
			],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			maxSubagentDepth: 2,
		});

		const payload = await readAsyncPayload(id);
		assert.equal(payload.timeoutMs, undefined, "composite parent must remain unbounded by default");
		assert.equal(payload.state, "failed");
		assert.deepEqual(payload.results.map((result) => result.timedOut), [true, true]);
		assert.deepEqual(payload.results.map((result) => result.error), ["Subagent timed out after 150ms.", "Subagent timed out after 200ms."]);
	});

	it("hard-kills async children that ignore timeout SIGTERM", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ delay: 60_000, ignoreSigterm: true, output: "too late" });
		const id = `async-timeout-hard-kill-${Date.now().toString(36)}`;
		const timeoutMs = process.platform === "win32" ? 5_000 : 1_500;
		const startedAt = Date.now();
		executeAsyncSingle(id, {
			agent: "stubborn",
			task: "Ignore soft termination",
			agentConfig: makeAgent("stubborn", { model: "primary-model", fallbackModels: ["fallback-model"] }),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			maxSubagentDepth: 2,
			timeoutMs,
		});

		await waitForMockPiCall(mockPi, 0, 10_000);
		const resultPath = await waitForAsyncResultFile(id, 10_000);
		const elapsedMs = Date.now() - startedAt;
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		const status = await waitForAsyncState(id, (candidate) => candidate.state === "failed");
		assert.equal(payload.state, "failed");
		assert.equal(payload.timedOut, true);
		assert.equal(payload.results[0]?.timedOut, true);
		assert.equal(payload.results[0]?.error, `Subagent timed out after ${timeoutMs}ms.`);
		assert.equal(status.timedOut, true);
		assert.equal(status.steps?.[0]?.timedOut, true);
		assert.ok(elapsedMs < timeoutMs + 4_000, `timeout result should settle after hard kill, elapsed ${elapsedMs}ms`);
		assert.equal(mockPi.callCount(), 1);
	});

	it("cancels async acceptance verification when the run times out", { skip: !isAsyncAvailable() ? "jiti not available" : process.platform === "win32" ? "timeout signal delivery intermittent on Windows CI" : undefined }, async () => {
		mockPi.onCall({ output: "implementation complete" });
		const id = `async-timeout-acceptance-${Date.now().toString(36)}`;
		const timeoutMs = 1_000;
		const startedAt = Date.now();
		executeAsyncSingle(id, {
			agent: "worker",
			task: "Implement with verified acceptance",
			agentConfig: makeAgent("worker"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: {
				enabled: true,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: true,
				cleanupDays: 7,
			},
			artifactsDir: path.join(tempDir, ".pi/subagents", "artifacts"),
			shareEnabled: false,
			maxSubagentDepth: 2,
			timeoutMs,
			acceptance: {
				level: "verified",
				verify: [{ id: "slow", command: `${process.execPath} -e "setTimeout(()=>process.exit(0), 30000)"`, timeoutMs: 60_000 }],
			},
		});

		const resultPath = await waitForAsyncResultFile(id, 5_000);
		const elapsedMs = Date.now() - startedAt;
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		const status = await waitForAsyncState(id, (candidate) => candidate.state === "failed");
		assert.equal(payload.state, "failed");
		assert.equal(payload.timedOut, true);
		assert.equal(payload.results[0]?.timedOut, true);
		assert.equal(payload.results[0]?.acceptance?.status, "rejected");
		assert.equal(payload.results[0]?.acceptance?.runtimeChecks?.[0]?.id, "timeout");
		assert.equal(status.steps?.[0]?.timedOut, true);
		const metadataPath = payload.results[0]?.artifactPaths?.metadataPath;
		assert.ok(metadataPath);
		const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf-8")) as { acceptance?: { status?: string; runtimeChecks?: Array<{ id?: string }> } };
		assert.equal(metadata.acceptance?.status, "rejected");
		assert.equal(metadata.acceptance?.runtimeChecks?.[0]?.id, "timeout");
		assert.ok(elapsedMs < timeoutMs + 4_000, `timeout should cancel acceptance verification well before the verify command completes, elapsed ${elapsedMs}ms`);
	});

	it("async launch messages tell the parent not to sleep-poll", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		const artifactConfig = {
			enabled: false,
			includeInput: false,
			includeOutput: false,
			includeJsonl: false,
			includeMetadata: false,
			cleanupDays: 7,
		};
		const emitted: Array<{ channel: string; data: unknown }> = [];
		const commonParams = {
			ctx: {
				pi: { events: { emit(channel: string, data: unknown) { emitted.push({ channel, data }); } } },
				cwd: tempDir,
				currentSessionId: "session-1",
			},
			artifactConfig,
			shareEnabled: false,
			maxSubagentDepth: 2,
		};
		const startedEvent = (id: string): { task?: string; goal?: string } => {
			const event = emitted.find((entry) => entry.channel === SUBAGENT_ASYNC_STARTED_EVENT && (entry.data as { id?: string }).id === id);
			assert.ok(event, `missing async-started event for ${id}`);
			return event.data as { task?: string; goal?: string };
		};
		mockPi.onCall({ output: "single done" });
		const singleId = `async-handoff-single-${Date.now().toString(36)}`;
		const wrappedTask = `Fork preamble: ${"execution ".repeat(20)}`;
		const rawGoal = `Caller-facing goal: ${"raw ".repeat(40)}`;
		const singleResult = executeAsyncSingle(singleId, {
			agent: "worker",
			task: wrappedTask,
			goal: rawGoal,
			agentConfig: makeAgent("worker"),
			...commonParams,
		});
		assert.match(singleResult.content[0]?.text ?? "", /Async: worker \[/);
		assert.match(singleResult.content[0]?.text ?? "", /Do not run sleep timers or polling loops/);
		assert.match(singleResult.content[0]?.text ?? "", /call subagent_wait\(\)/i);
		assert.match(singleResult.content[0]?.text ?? "", /non-interactive run: Pi auto-drains current-session background work at agent_end/);
		assert.equal(startedEvent(singleId).task, "[prompt redacted]");
		assert.equal(startedEvent(singleId).goal, "[prompt redacted]");
		await waitForAsyncResultFile(singleId, 30_000);

		mockPi.onCall({ output: "interactive done" });
		const interactiveId = `async-handoff-interactive-${Date.now().toString(36)}`;
		const interactiveResult = executeAsyncSingle(interactiveId, {
			agent: "worker",
			task: "Interactive handoff",
			agentConfig: makeAgent("worker"),
			...commonParams,
			ctx: { ...commonParams.ctx, interactive: true },
		});
		assert.match(interactiveResult.content[0]?.text ?? "", /interactive session/);
		assert.match(interactiveResult.content[0]?.text ?? "", /return control to the user/);
		assert.match(interactiveResult.content[0]?.text ?? "", /Do NOT call subagent_wait\(\) merely to wait/);
		assert.doesNotMatch(interactiveResult.content[0]?.text ?? "", /auto-drain/);
		await waitForAsyncResultFile(interactiveId, 30_000);

		mockPi.onCall({ output: "parallel one done" });
		mockPi.onCall({ output: "parallel two done" });
		const parallelId = `async-handoff-parallel-${Date.now().toString(36)}`;
		const parallelResult = executeAsyncChain(parallelId, {
			chain: [{ parallel: [{ agent: "worker", task: "Do one" }, { agent: "reviewer", task: "Do two" }] }],
			resultMode: "parallel",
			agents: [makeAgent("worker"), makeAgent("reviewer")],
			...commonParams,
		});
		assert.match(parallelResult.content[0]?.text ?? "", /Async parallel:/);
		assert.match(parallelResult.content[0]?.text ?? "", /Do not run sleep timers or polling loops/);
		assert.match(parallelResult.content[0]?.text ?? "", /call subagent_wait\(\)/i);
		assert.equal(startedEvent(parallelId).goal, "[prompt redacted]");
		const parallelResultPath = await waitForAsyncResultFile(parallelId, 10_000);
		const parallelPayload = JSON.parse(fs.readFileSync(parallelResultPath, "utf-8")) as { agent?: string; mode?: string };
		assert.equal(parallelPayload.mode, "parallel");
		assert.equal(parallelPayload.agent, "parallel:worker+reviewer");

		mockPi.onCall({ output: "chain done" });
		const chainId = `async-handoff-chain-${Date.now().toString(36)}`;
		const chainGoal = `Coordinate the complete workflow ${"goal ".repeat(30)}`;
		const chainChildTask = `Do chained work ${"child ".repeat(15)}`;
		const chainResult = executeAsyncChain(chainId, {
			task: chainGoal,
			chain: [{ agent: "worker", task: chainChildTask }],
			agents: [makeAgent("worker")],
			...commonParams,
		});
		assert.match(chainResult.content[0]?.text ?? "", /Async chain:/);
		assert.match(chainResult.content[0]?.text ?? "", /Do not run sleep timers or polling loops/);
		const chainEvent = startedEvent(chainId);
		assert.equal(chainEvent.task, "[prompt redacted]");
		assert.equal(chainEvent.goal, "[prompt redacted]");
		await waitForAsyncResultFile(chainId, 10_000);
	});

	it("fails background chains when requested extension tools are unavailable", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ output: "Model incorrectly claimed success", missingTools: ["fixture_search"] });
		const id = `async-missing-extension-tool-${Date.now().toString(36)}`;

		executeAsyncChain(id, {
			chain: [{ agent: "extension-worker", task: "Use fixture search" }],
			agents: [makeAgent("extension-worker", { tools: ["read", "fixture_search"] })],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			maxSubagentDepth: 2,
		});

		const resultPath = await waitForAsyncResultFile(id, 10_000);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		assert.equal(payload.success, false);
		assert.equal(payload.state, "failed");
		assert.match(payload.results[0]?.error ?? "", /requested unavailable child tools: fixture_search/);
		assert.match(payload.results[0]?.error ?? "", /subagentOnlyExtensions/);
	});

	it("records blocked mutation effects when background implementation tools are missing", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ output: "I cannot edit because fixture_search is missing", missingTools: ["fixture_search"] });
		const id = `async-missing-implementation-tool-${Date.now().toString(36)}`;

		executeAsyncSingle(id, {
			agent: "worker",
			task: "Implement the requested source fix",
			agentConfig: makeAgent("worker", { tools: ["read", "fixture_search"] }),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
			acceptance: false,
		});

		const resultPath = await waitForAsyncResultFile(id, 10_000);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		const statusPayload = await waitForAsyncState(id, (candidate) => candidate.state === "failed");

		assert.equal(payload.success, false);
		assert.equal(payload.state, "failed");
		assert.match(payload.results[0]?.error ?? "", /requested unavailable child tools: fixture_search/);
		assert.doesNotMatch(payload.results[0]?.error ?? "", /completed without making edits/);
		assert.equal(payload.results[0]?.effects?.fileMutation?.status, "blocked");
		assert.equal(payload.results[0]?.effects?.fileMutation?.expected, true);
		assert.equal(payload.results[0]?.effects?.fileMutation?.attempted, false);
		assert.match(payload.results[0]?.effects?.fileMutation?.message ?? "", /requested unavailable child tools: fixture_search/);
		assert.equal(statusPayload.steps?.[0]?.effects?.fileMutation?.status, "blocked");
	});

	it("applies agent acceptance roles to inferred async acceptance", { skip: !isAsyncAvailable() || !createSubagentExecutor ? "jiti or executor not available" : undefined }, async () => {
		mockPi.onCall({ output: "exploration complete" });
		const executor = makeAsyncExecutor([makeAgent("worker", { acceptanceRole: "read-only" })]);

		const result = await executor.execute(
			"async-agent-acceptance-role",
			{ agent: "worker", task: "Explore the authentication flow", async: true, clarify: false },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		const asyncId = result.details?.asyncId;
		assert.ok(asyncId, "expected asyncId");
		const payload = await readAsyncPayload(asyncId);
		assert.equal(payload.results[0]?.acceptance?.effectiveAcceptance.level, "attested");
	});



	it("infers async chain acceptance after expanding top-level task templates", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ output: "patched" });
		mockPi.onCall({ output: "reviewed" });

		const patchId = `async-role-task-template-patch-${Date.now().toString(36)}`;
		executeAsyncChain(patchId, {
			task: "Patch src/auth.ts",
			chain: [{ agent: "explorer", task: "{task}" }],
			agents: [makeAgent("explorer", { acceptanceRole: "read-only" })],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-role-task-patch" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			maxSubagentDepth: 2,
		});
		const patchPayload = await readAsyncPayload(patchId);
		assert.equal(patchPayload.results[0]?.acceptance?.effectiveAcceptance?.level, "checked");

		const reviewId = `async-role-task-template-review-${Date.now().toString(36)}`;
		executeAsyncChain(reviewId, {
			task: "Review only; do not edit files",
			chain: [{ agent: "implementer", task: "{task}" }],
			agents: [makeAgent("implementer", { acceptanceRole: "writer" })],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-role-task-review" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			maxSubagentDepth: 2,
		});
		const reviewPayload = await readAsyncPayload(reviewId);
		assert.equal(reviewPayload.results[0]?.acceptance?.effectiveAcceptance?.level, "attested");
	});









	it("async chain static parallel namespaces inherited default outputs", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ matchArgIncludes: "Write first", output: "chain first report" });
		mockPi.onCall({ matchArgIncludes: "Write second", output: "chain second report" });
		const id = `async-chain-parallel-output-${Date.now().toString(36)}`;
		const launch = executeAsyncChain(id, {
			chain: [{ parallel: [{ agent: "worker", task: "Write first" }, { agent: "worker", task: "Write second" }] }],
			agents: [makeAgent("worker", { output: "context.md" })],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-chain-output" },
			artifactConfig: { enabled: true, includeInput: false, includeOutput: true, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			artifactsDir: path.join(tempDir, ".pi/subagents", "artifacts"),
			shareEnabled: false,
			maxSubagentDepth: 2,
		});

		assert.equal(launch.isError, undefined);
		const payload = await readAsyncPayload(id);
		assert.equal(payload.success, true);
		const outputDir = path.join(tempDir, ".pi/subagents", "artifacts", "outputs", id);
		const authoritativePaths = [
			path.join(outputDir, "parallel-0", "0-worker", "context.md"),
			path.join(outputDir, "parallel-0", "1-worker", "context.md"),
		];
		assert.equal(fs.readFileSync(authoritativePaths[0]!, "utf-8"), "chain first report");
		assert.equal(fs.readFileSync(authoritativePaths[1]!, "utf-8"), "chain second report");
		const artifactPaths = payload.results.map((result) => result.artifactPaths?.outputPath);
		assert.ok(artifactPaths[0] && artifactPaths[1]);
		assert.notEqual(artifactPaths[0], artifactPaths[1]);
		assert.equal(fs.readFileSync(artifactPaths[0], "utf-8"), "chain first report");
		assert.equal(fs.readFileSync(artifactPaths[1], "utf-8"), "chain second report");
		const calls = fs.readdirSync(mockPi.dir).filter((name) => name.startsWith("call-")).sort();
		const taskArgs = calls.map((name) => (JSON.parse(fs.readFileSync(path.join(mockPi.dir, name), "utf-8")) as MockPiCallRecord).args?.at(-1) ?? "");
		assert.ok(taskArgs.find((task) => task.includes("Write first"))?.includes(path.join("parallel-0", "0-worker", "context.md")));
		assert.ok(taskArgs.find((task) => task.includes("Write second"))?.includes(path.join("parallel-0", "1-worker", "context.md")));
	});

	it("async single preserves checked evidence while independent review is pending", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({
			output: [
				"implemented",
				"```acceptance-report",
				JSON.stringify({
					criteriaSatisfied: [{ id: "criterion-1", status: "satisfied", evidence: "patched" }],
					changedFiles: ["src/file.ts"],
					testsAddedOrUpdated: ["test/file.test.ts"],
					commandsRun: [{ command: "npm test", result: "passed", summary: "passed" }],
					validationOutput: ["passed"],
					residualRisks: [],
					noStagedFiles: true,
					notes: "done",
				}),
				"```",
			].join("\n"),
		});
		const artifactConfig = {
			enabled: false,
			includeInput: false,
			includeOutput: false,
			includeJsonl: false,
			includeMetadata: false,
			cleanupDays: 7,
		};
		const id = `async-acceptance-${Date.now().toString(36)}`;
		executeAsyncSingle(id, {
			agent: "worker",
			task: "Implement acceptance-covered fix",
			agentConfig: makeAgent("worker", { completionGuard: false }),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-acceptance" },
			artifactConfig,
			shareEnabled: false,
			maxSubagentDepth: 2,
			acceptance: { level: "checked", criteria: ["Patch bug"], review: { agent: "reviewer", required: true } },
		});
		const resultPath = await waitForAsyncResultFile(id, 10_000);
		const result = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		const status = JSON.parse(fs.readFileSync(path.join(ASYNC_DIR, id, "status.json"), "utf-8")) as AsyncStatusPayload;

		assert.equal(result.success, true);
		assert.equal(result.results[0]?.acceptance?.status, "review-required");
		assert.equal(result.results[0]?.acceptance?.evidenceStatus, "checked");
		assert.ok(result.results[0]?.acceptance?.childReport);
		assert.equal(result.results[0]?.acceptance?.reviewResult?.status, "review-required");
		assert.equal(status.steps?.[0]?.acceptance?.status, "review-required");
	});



	it("async chains reject malformed named output references before spawning", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		const id = `async-malformed-output-ref-${Date.now().toString(36)}`;
		const result = executeAsyncChain(id, {
			chain: [{ agent: "consumer", task: "Use {outputs.bad-name}" }],
			agents: [makeAgent("consumer")],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-malformed" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			maxSubagentDepth: 2,
		});

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /Invalid chain output reference '\{outputs\.bad-name\}'/);
		assert.equal(mockPi.callCount(), 0);
	});

	it("async chains persist structured outputs, named outputs, and graph labels", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		const schema = {
			type: "object",
			required: ["value"],
			properties: { value: { type: "string" } },
		};
		mockPi.onCall({ structuredOutput: { value: "Alpha structured" } });
		mockPi.onCall({ output: "used named output" });
		const id = `async-structured-chain-${Date.now().toString(36)}`;
		const result = executeAsyncChain(id, {
			chain: [
				{
					agent: "producer",
					task: "Produce data",
					phase: "Collect",
					label: "Produce structured data",
					as: "data",
					outputSchema: schema,
				},
				{ agent: "consumer", task: "Use {outputs.data}", phase: "Use", label: "Consume data" },
			],
			agents: [makeAgent("producer"), makeAgent("consumer")],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-structured" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			maxSubagentDepth: 2,
		});

		assert.ok(!result.isError);
		const resultPath = await waitForAsyncResultFile(id, 10_000);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		const status = await waitForAsyncState(id, (candidate) => candidate.state === "complete");
		assert.deepEqual(payload.results[0]?.structuredOutput, { value: "Alpha structured" });
		assert.deepEqual(payload.outputs?.data?.structured, { value: "Alpha structured" });
		assert.match(readMockPiArgs(mockPi, 1).at(-1) ?? "", /Alpha structured/);
		assert.equal(status.steps?.[0]?.label, "Produce structured data");
		assert.equal(status.steps?.[0]?.phase, "Collect");
		assert.equal(status.steps?.[0]?.outputName, "data");
		assert.equal(status.steps?.[0]?.structured, true);
		assert.equal(payload.workflowGraph?.nodes?.[0]?.label, "Produce structured data");
		assert.equal(payload.workflowGraph?.nodes?.[0]?.outputName, "data");
		assert.equal(payload.workflowGraph?.nodes?.[0]?.status, "completed");
		assert.equal(payload.workflowGraph?.nodes?.[1]?.status, "completed");
	});

	it("async chains can start parallel, funnel into one step, then fan back out", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ matchArgIncludes: "Scout API", output: "Scout A async findings" });
		mockPi.onCall({ matchArgIncludes: "Scout UI", output: "Scout B async findings" });
		mockPi.onCall({ matchArgIncludes: "Synthesize:", output: "Async funnel synthesis" });
		mockPi.onCall({ matchArgIncludes: "Review funnel A:", output: "Async reviewer A done" });
		mockPi.onCall({ matchArgIncludes: "Review funnel B:", output: "Async reviewer B done" });
		const id = `async-parallel-funnel-fanout-${Date.now().toString(36)}`;
		const result = executeAsyncChain(id, {
			chain: [
				{
					parallel: [
						{ agent: "scout-a", task: "Scout API" },
						{ agent: "scout-b", task: "Scout UI" },
					],
					concurrency: 2,
				},
				{ agent: "synthesizer", task: "Synthesize:\n{previous}" },
				{
					parallel: [
						{ agent: "review-a", task: "Review funnel A:\n{previous}" },
						{ agent: "review-b", task: "Review funnel B:\n{previous}" },
					],
					concurrency: 2,
				},
			],
			agents: [makeAgent("scout-a"), makeAgent("scout-b"), makeAgent("synthesizer"), makeAgent("review-a"), makeAgent("review-b")],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-parallel-funnel-fanout" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			maxSubagentDepth: 2,
		});

		assert.ok(!result.isError, `should launch: ${JSON.stringify(result.content)}`);
		const resultPath = await waitForAsyncResultFile(id, 10_000);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		const status = await waitForAsyncState(id, (candidate) => candidate.state === "complete");
		assert.equal(payload.success, true);
		assert.deepEqual(payload.results.map((entry) => entry.output), [
			"Scout A async findings",
			"Scout B async findings",
			"Async funnel synthesis",
			"Async reviewer A done",
			"Async reviewer B done",
		]);
		assert.deepEqual(status.steps?.map((step) => step.status), ["complete", "complete", "complete", "complete", "complete"]);
		assert.deepEqual(status.parallelGroups, [
			{ start: 0, count: 2, stepIndex: 0 },
			{ start: 3, count: 2, stepIndex: 2 },
		]);
		const funnelTask = readMockPiArgsMatching(mockPi, "Synthesize:").at(-1) ?? "";
		assert.match(funnelTask, /=== Parallel Task 1 \(scout-a\) ===/);
		assert.match(funnelTask, /Scout A async findings/);
		assert.match(funnelTask, /=== Parallel Task 2 \(scout-b\) ===/);
		assert.match(funnelTask, /Scout B async findings/);
		assert.match(readMockPiArgsMatching(mockPi, "Review funnel A:").at(-1) ?? "", /Review funnel A:\nAsync funnel synthesis/);
		assert.match(readMockPiArgsMatching(mockPi, "Review funnel B:").at(-1) ?? "", /Review funnel B:\nAsync funnel synthesis/);
		assert.equal(payload.workflowGraph?.nodes?.[0]?.kind, "parallel-group");
		assert.equal(payload.workflowGraph?.nodes?.[0]?.status, "completed");
		assert.equal(payload.workflowGraph?.nodes?.[1]?.kind, "step");
		assert.equal(payload.workflowGraph?.nodes?.[1]?.status, "completed");
		assert.equal(payload.workflowGraph?.nodes?.[2]?.kind, "parallel-group");
		assert.equal(payload.workflowGraph?.nodes?.[2]?.status, "completed");
	});

	it("async dynamic status shows a placeholder before materialization", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ delay: 800, output: "targets", structuredOutput: { items: [{ path: "src/a.ts" }, { path: "src/b.ts" }] } });
		mockPi.onCall({ output: "review-a", structuredOutput: { ok: "a" } });
		mockPi.onCall({ output: "review-b", structuredOutput: { ok: "b" } });
		mockPi.onCall({ output: "used reviews" });
		const id = `async-dynamic-placeholder-${Date.now().toString(36)}`;
		const result = executeAsyncChain(id, {
			chain: [
				{ agent: "producer", task: "Produce targets", as: "targets", outputSchema: { type: "object" } },
				{
					expand: { from: { output: "targets", path: "/items" }, item: "target", key: "/path", maxItems: 4 },
					parallel: { agent: "reviewer", task: "Review {target.path}", label: "Review {target.path}", outputSchema: { type: "object" } },
					collect: { as: "reviews" },
					concurrency: 1,
				},
				{ agent: "consumer", task: "Use {outputs.reviews}" },
			],
			agents: [makeAgent("producer"), makeAgent("reviewer"), makeAgent("consumer")],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-dynamic-placeholder" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			maxSubagentDepth: 2,
		});

		assert.ok(!result.isError);
		const statusPath = path.join(ASYNC_DIR, id, "status.json");
		const deadline = Date.now() + 5_000;
		let status: AsyncStatusPayload | undefined;
		while (!status) {
			if (Date.now() > deadline) assert.fail(`Timed out waiting for async status file: ${statusPath}`);
			if (fs.existsSync(statusPath)) status = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatusPayload;
			else await new Promise((resolve) => setTimeout(resolve, 50));
		}
		assert.deepEqual(status.steps?.map((step) => step.agent), ["producer", "expand:reviewer", "consumer"]);
		assert.equal(status.steps?.[1]?.label, "Review {target.path}");
		assert.equal(status.steps?.[1]?.outputName, "reviews");
		assert.deepEqual(status.parallelGroups, [{ start: 1, count: 1, stepIndex: 1 }]);

		const resultPath = await waitForAsyncResultFile(id, 10_000);
		const finalStatus = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatusPayload;
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		assert.equal(payload.success, true);
		assert.deepEqual(finalStatus.steps?.map((step) => step.agent), ["producer", "reviewer", "reviewer", "consumer"]);
		assert.deepEqual(finalStatus.parallelGroups, [{ start: 1, count: 2, stepIndex: 1 }]);
	});

	it("async chains expand dynamic fanout and persist collected output", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ output: "targets", structuredOutput: { items: [{ path: "src/a.ts" }, { path: "src/b.ts" }] } });
		mockPi.onCall({ matchArgIncludes: "Review src/a.ts", output: "review-a", structuredOutput: { ok: "a" } });
		mockPi.onCall({ matchArgIncludes: "Review src/b.ts", output: "review-b", structuredOutput: { ok: "b" } });
		mockPi.onCall({ output: "used reviews" });
		const id = `async-dynamic-chain-${Date.now().toString(36)}`;
		const result = executeAsyncChain(id, {
			chain: [
				{ agent: "producer", task: "Produce targets", as: "targets", outputSchema: { type: "object" } },
				{
					expand: { from: { output: "targets", path: "/items" }, item: "target", key: "/path", maxItems: 4 },
					parallel: {
						agent: "reviewer",
						task: "Review {target.path}",
						label: "Review {target.path}",
						outputSchema: { type: "object" },
				},
				collect: { as: "reviews" },
				concurrency: 1,
				},
				{ agent: "consumer", task: "Use {outputs.reviews}" },
			],
			agents: [makeAgent("producer"), makeAgent("reviewer", { output: "context.md" }), makeAgent("consumer")],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-dynamic" },
			artifactConfig: { enabled: true, includeInput: false, includeOutput: true, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			artifactsDir: path.join(tempDir, ".pi/subagents", "artifacts"),
			shareEnabled: false,
			maxSubagentDepth: 2,
		});

		assert.ok(!result.isError);
		const resultPath = await waitForAsyncResultFile(id, 10_000);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		const status = JSON.parse(fs.readFileSync(path.join(ASYNC_DIR, id, "status.json"), "utf-8")) as AsyncStatusPayload;
		assert.equal(payload.success, true);
		assert.equal(mockPi.callCount(), 4);
		assert.match(readMockPiArgs(mockPi, 1).at(-1) ?? "", /Review src\/a\.ts/);
		assert.match(readMockPiArgs(mockPi, 2).at(-1) ?? "", /Review src\/b\.ts/);
		assert.match(readMockPiArgs(mockPi, 3).at(-1) ?? "", /"key":"src\/a\.ts"/);
		const collected = payload.outputs?.reviews?.structured as Array<{ key: string; structured: unknown }>;
		assert.deepEqual(collected.map((item) => item.key), ["src/a.ts", "src/b.ts"]);
		assert.deepEqual(collected.map((item) => item.structured), [{ ok: "a" }, { ok: "b" }]);
		const outputDir = path.join(tempDir, ".pi/subagents", "artifacts", "outputs", id);
		const dynamicOutputPaths = [
			path.join(outputDir, "dynamic-1", "0-reviewer", "context.md"),
			path.join(outputDir, "dynamic-1", "1-reviewer", "context.md"),
		];
		assert.equal(fs.readFileSync(dynamicOutputPaths[0]!, "utf-8"), "review-a");
		assert.equal(fs.readFileSync(dynamicOutputPaths[1]!, "utf-8"), "review-b");
		const reviewerArtifacts = payload.results.slice(1, 3).map((result) => result.artifactPaths?.outputPath);
		assert.ok(reviewerArtifacts[0] && reviewerArtifacts[1]);
		assert.notEqual(reviewerArtifacts[0], reviewerArtifacts[1]);
		assert.equal(fs.readFileSync(reviewerArtifacts[0], "utf-8"), "review-a");
		assert.equal(fs.readFileSync(reviewerArtifacts[1], "utf-8"), "review-b");
		assert.match(readMockPiArgs(mockPi, 1).at(-1) ?? "", new RegExp(dynamicOutputPaths[0]!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
		assert.match(readMockPiArgs(mockPi, 2).at(-1) ?? "", new RegExp(dynamicOutputPaths[1]!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
		assert.equal(status.steps?.length, 4);
		assert.deepEqual(status.parallelGroups, [{ start: 1, count: 2, stepIndex: 1 }]);
		assert.equal(payload.workflowGraph?.nodes?.[1]?.kind, "dynamic-parallel-group");
		assert.deepEqual(payload.workflowGraph?.nodes?.[1]?.children?.map((child) => child.itemKey), ["src/a.ts", "src/b.ts"]);
		assert.equal(payload.workflowGraph?.nodes?.[2]?.flatIndex, 3);
	});

	it("async dynamic fanout blocks queued children when hard reported usage is exhausted", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ output: "targets", structuredOutput: { items: [{ path: "src/a.ts" }, { path: "src/b.ts" }] } });
		mockPi.onCall({ matchArgIncludes: "Review src/a.ts", output: "review-a", structuredOutput: { ok: "a" } });
		const id = `async-dynamic-usage-budget-${Date.now().toString(36)}`;
		executeAsyncChain(id, {
			chain: [
				{ agent: "producer", task: "Produce targets", as: "targets", outputSchema: { type: "object" } },
				{
					expand: { from: { output: "targets", path: "/items" }, item: "target", key: "/path", maxItems: 4 },
					parallel: { agent: "reviewer", task: "Review {target.path}", outputSchema: { type: "object" } },
					collect: { as: "reviews" },
					concurrency: 1,
				},
			],
			usageBudget: { tokens: { hard: 200 } },
			agents: [makeAgent("producer"), makeAgent("reviewer")],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-dynamic-budget" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			maxSubagentDepth: 2,
		});

		const payload = await readAsyncPayload(id);
		const status = JSON.parse(fs.readFileSync(path.join(ASYNC_DIR, id, "status.json"), "utf-8")) as AsyncStatusPayload;
		assert.equal(mockPi.callCount(), 2);
		assert.equal(payload.success, false);
		assert.equal(payload.usageBudget?.exhausted, true);
		assert.equal(status.steps?.[1]?.status, "complete");
		assert.equal(status.steps?.[2]?.status, "failed");
		assert.match(status.steps?.[2]?.error ?? "", /Usage budget exhausted/);
		assert.equal(payload.results.find((result) => result.agent === "reviewer" && result.skipped)?.skipped, true);
	});

	it("rejects a shared explicit output before dynamic fanout children start", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ matchArgIncludes: "Produce targets", output: "targets", structuredOutput: { items: [{ path: "src/a.ts" }, { path: "src/b.ts" }] } });
		const id = `async-dynamic-explicit-output-${Date.now().toString(36)}`;
		const launch = executeAsyncChain(id, {
			chain: [
				{ agent: "producer", task: "Produce targets", as: "targets", outputSchema: { type: "object" } },
				{
					expand: { from: { output: "targets", path: "/items" }, item: "target", maxItems: 2 },
					parallel: { agent: "reviewer", task: "Review {target.path}", output: "shared.md" },
					collect: { as: "reviews" },
					concurrency: 2,
				},
			],
			agents: [makeAgent("producer"), makeAgent("reviewer")],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-dynamic-explicit-output" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			maxSubagentDepth: 2,
		});

		assert.equal(launch.isError, undefined);
		const payload = await readAsyncPayload(id);
		assert.equal(payload.success, false);
		const error = payload.results.find((result) => result.error)?.error ?? "";
		assert.match(error, /materialized 2 items that resolve output to the same path/);
		assert.match(error, /shared\.md/);
		assert.equal(mockPi.callCount(), 1);
	});

	it("async dynamic fanout applies fork session files and thinking overrides to materialized children", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ output: "targets", structuredOutput: { items: [{ path: "src/a.ts" }, { path: "src/b.ts" }] } });
		mockPi.onCall({ output: "review-a", structuredOutput: { ok: "a" } });
		mockPi.onCall({ output: "review-b", structuredOutput: { ok: "b" } });
		const id = `async-dynamic-fork-thinking-${Date.now().toString(36)}`;
		const sessionA = path.join(tempDir, "dynamic-a.jsonl");
		const sessionB = path.join(tempDir, "dynamic-b.jsonl");
		const result = executeAsyncChain(id, {
			chain: [
				{ agent: "producer", task: "Produce targets", as: "targets", outputSchema: { type: "object" } },
				{
					expand: { from: { output: "targets", path: "/items" }, item: "target", key: "/path", maxItems: 2 },
					parallel: {
						agent: "reviewer",
						task: "Review {target.path}",
						label: "Review {target.path}",
						outputSchema: { type: "object" },
					},
					collect: { as: "reviews" },
					concurrency: 1,
				},
			],
			agents: [makeAgent("producer"), makeAgent("reviewer", { model: "anthropic/claude-sonnet-4-5:high", thinking: "high" })],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-dynamic" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			sessionFilesByFlatIndex: [undefined, sessionA, sessionB],
			thinkingOverridesByFlatIndex: [undefined, "off", "off"],
			maxSubagentDepth: 2,
		});

		assert.ok(!result.isError);
		const resultPath = await waitForAsyncResultFile(id, 10_000);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		const status = JSON.parse(fs.readFileSync(path.join(ASYNC_DIR, id, "status.json"), "utf-8")) as AsyncStatusPayload;
		const firstDynamicArgs = readMockPiArgs(mockPi, 1);
		const secondDynamicArgs = readMockPiArgs(mockPi, 2);
		assert.equal(payload.success, true);
		assert.equal(firstDynamicArgs[firstDynamicArgs.indexOf("--session") + 1], sessionA);
		assert.equal(secondDynamicArgs[secondDynamicArgs.indexOf("--session") + 1], sessionB);
		assert.equal(firstDynamicArgs[firstDynamicArgs.indexOf("--model") + 1], "anthropic/claude-sonnet-4-5:off");
		assert.equal(secondDynamicArgs[secondDynamicArgs.indexOf("--model") + 1], "anthropic/claude-sonnet-4-5:off");
		assert.deepEqual(status.steps?.slice(1).map((step) => step.sessionFile), [sessionA, sessionB]);
		assert.deepEqual(status.steps?.slice(1).map((step) => step.thinking), ["off", "off"]);
	});

	it("applies read-only acceptance roles to async dynamic children and their aggregate group", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ output: "targets", structuredOutput: { items: [{ path: "src/a.ts" }, { path: "src/b.ts" }] } });
		const readOnlyReport = [
			"done",
			"```acceptance-report",
			JSON.stringify({
				criteriaSatisfied: [{ id: "criterion-1", status: "satisfied", evidence: "inspection complete" }],
				changedFiles: [],
				testsAddedOrUpdated: [],
				commandsRun: [],
				validationOutput: [],
				reviewFindings: ["No blocking findings"],
				residualRisks: [],
				noStagedFiles: true,
			}),
			"```",
		].join("\n");
		mockPi.onCall({ output: readOnlyReport, structuredOutput: { ok: "a" } });
		mockPi.onCall({ output: readOnlyReport, structuredOutput: { ok: "b" } });
		const id = `async-dynamic-acceptance-role-${Date.now().toString(36)}`;
		const result = executeAsyncChain(id, {
			chain: [
				{ agent: "producer", task: "Produce targets", as: "targets", outputSchema: { type: "object" } },
				{
					expand: { from: { output: "targets", path: "/items" }, item: "target", key: "/path", maxItems: 2 },
					parallel: { agent: "explorer", task: "Explore {target.path}", outputSchema: { type: "object" } },
					collect: { as: "reviews" },
					concurrency: 1,
				},
			],
			agents: [makeAgent("producer"), makeAgent("explorer", { acceptanceRole: "read-only" })],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-dynamic-role" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			maxSubagentDepth: 2,
		});

		assert.ok(!result.isError);
		const payload = await readAsyncPayload(id);
		const explorerResults = payload.results.filter((child) => child.agent === "explorer");
		assert.deepEqual(explorerResults.map((child) => child.acceptance?.effectiveAcceptance?.level), ["attested", "attested"]);
		const dynamicNode = payload.workflowGraph?.nodes?.[1];
		assert.equal(dynamicNode?.acceptanceStatus, "attested");
		assert.deepEqual(dynamicNode?.children?.map((child) => child.acceptanceStatus), ["attested", "attested"]);
	});

	it("infers async dynamic acceptance after materializing item templates", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ output: "targets", structuredOutput: { items: [{ path: "src/a.ts" }, { path: "src/b.ts" }] } });
		const writerReport = [
			"done",
			"```acceptance-report",
			JSON.stringify({
				criteriaSatisfied: [{ id: "criterion-1", status: "satisfied", evidence: "patch complete" }],
				changedFiles: ["src/a.ts"],
				testsAddedOrUpdated: ["test/a.test.ts"],
				commandsRun: [{ command: "npm test", result: "passed", summary: "passed" }],
				validationOutput: ["tests passed"],
				residualRisks: [],
				noStagedFiles: true,
			}),
			"```",
		].join("\n");
		mockPi.onCall({ output: writerReport, structuredOutput: { ok: "a" } });
		mockPi.onCall({ output: writerReport, structuredOutput: { ok: "b" } });
		const id = `async-dynamic-role-item-template-${Date.now().toString(36)}`;
		executeAsyncChain(id, {
			chain: [
				{ agent: "producer", task: "Produce targets", as: "targets", outputSchema: { type: "object" } },
				{
					expand: { from: { output: "targets", path: "/items" }, item: "target", key: "/path", maxItems: 2 },
					parallel: { agent: "explorer", task: "Patch {target.path}", outputSchema: { type: "object" } },
					collect: { as: "reviews" },
					concurrency: 1,
				},
			],
			agents: [makeAgent("producer"), makeAgent("explorer", { acceptanceRole: "read-only" })],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-dynamic-role-item" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			maxSubagentDepth: 2,
		});

		const payload = await readAsyncPayload(id);
		const explorerResults = payload.results.filter((child) => child.agent === "explorer");
		assert.deepEqual(explorerResults.map((child) => child.acceptance?.effectiveAcceptance?.level), ["checked", "checked"]);
		const dynamicNode = payload.workflowGraph?.nodes?.[1];
		assert.equal(payload.success, true);
		assert.equal(dynamicNode?.acceptanceStatus, "rejected");
		assert.deepEqual(dynamicNode?.children?.map((child) => child.acceptanceStatus), ["rejected", "rejected"]);
	});

	it("cancels dynamic fanout aggregate acceptance when the run times out", { skip: !isAsyncAvailable() ? "jiti not available" : process.platform === "win32" ? "timeout signal delivery intermittent on Windows CI" : undefined }, async () => {
		mockPi.onCall({ output: "targets", structuredOutput: { items: [{ path: "src/a.ts" }] } });
		mockPi.onCall({ output: "review-a", structuredOutput: { ok: "a" } });
		const id = `async-dynamic-acceptance-timeout-${Date.now().toString(36)}`;
		const startedAt = Date.now();
		executeAsyncChain(id, {
			chain: [
				{ agent: "producer", task: "Produce targets", as: "targets", outputSchema: { type: "object" } },
				{
					expand: { from: { output: "targets", path: "/items" }, item: "target", key: "/path", maxItems: 4 },
					parallel: { agent: "reviewer", task: "Review {target.path}", outputSchema: { type: "object" }, acceptance: { level: "checked" } },
					collect: { as: "reviews" },
					acceptance: {
						level: "verified",
						verify: [{ id: "slow", command: `${process.execPath} -e "setTimeout(()=>process.exit(0), 5000)"`, timeoutMs: 10_000 }],
					},
				},
			],
			agents: [makeAgent("producer"), makeAgent("reviewer")],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-dynamic-acceptance-timeout" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			maxSubagentDepth: 2,
			timeoutMs: 1_000,
		});

		const resultPath = await waitForAsyncResultFile(id, 5_000);
		const elapsedMs = Date.now() - startedAt;
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		const status = await waitForAsyncState(id, (candidate) => candidate.state === "failed");
		const dynamicNode = payload.workflowGraph?.nodes?.[1] as { status?: string; error?: string; acceptanceStatus?: string } | undefined;
		assert.equal(payload.state, "failed");
		assert.equal(payload.timedOut, true);
		assert.equal(payload.results.at(-1)?.timedOut, true);
		assert.equal(payload.results.at(-1)?.acceptance, undefined);
		assert.equal(dynamicNode?.status, "failed");
		assert.match(dynamicNode?.error ?? "", /Subagent timed out after 1000ms\./);
		assert.notEqual(dynamicNode?.acceptanceStatus, "verified");
		assert.equal(status.timedOut, true);
		assert.ok(elapsedMs < 3_000, `timeout should cancel dynamic aggregate acceptance promptly, elapsed ${elapsedMs}ms`);
	});

	it("async dynamic fanout recomputes later child intercom targets by final flat index", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ output: "targets", structuredOutput: { items: [{ path: "src/a.ts" }, { path: "src/b.ts" }] } });
		mockPi.onCall({ output: "review-a", structuredOutput: { ok: "a" } });
		mockPi.onCall({ output: "review-b", structuredOutput: { ok: "b" } });
		mockPi.onCall({ echoEnv: ["PI_SUBAGENT_INTERCOM_SESSION_NAME"] });
		const id = `async-dynamic-targets-${Date.now().toString(36)}`;
		const result = executeAsyncChain(id, {
			chain: [
				{ agent: "producer", task: "Produce targets", as: "targets", outputSchema: { type: "object" } },
				{
					expand: { from: { output: "targets", path: "/items" }, item: "target", key: "/path", maxItems: 4 },
					parallel: { agent: "reviewer", task: "Review {target.path}", outputSchema: { type: "object" } },
					collect: { as: "reviews" },
					concurrency: 1,
				},
				{ agent: "consumer", task: "Use {outputs.reviews}" },
			],
			agents: [makeAgent("producer"), makeAgent("reviewer"), makeAgent("consumer")],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-dynamic-targets" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			maxSubagentDepth: 2,
			controlIntercomTarget: "subagent-orchestrator-test",
			childIntercomTarget: (agent: string, index: number) => `subagent-${agent}-${id}-${index + 1}`,
		});

		assert.ok(!result.isError);
		const resultPath = await waitForAsyncResultFile(id, 10_000);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		const expectedConsumerTarget = `subagent-consumer-${id}-4`;
		assert.equal(payload.success, true);
		assert.equal(payload.results[3]?.intercomTarget, expectedConsumerTarget);
		assert.deepEqual(JSON.parse(payload.results[3]?.output ?? "{}"), { PI_SUBAGENT_INTERCOM_SESSION_NAME: expectedConsumerTarget });
	});

	it("async dynamic pre-spawn failures persist failed graph status and error", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ output: "targets", structuredOutput: { items: [{ path: "src/a.ts" }, { path: "src/b.ts" }] } });
		const id = `async-dynamic-prespawn-fail-${Date.now().toString(36)}`;
		const result = executeAsyncChain(id, {
			chain: [
				{ agent: "producer", task: "Produce targets", as: "targets", outputSchema: { type: "object" } },
				{
					expand: { from: { output: "targets", path: "/items" }, item: "target", key: "/path", maxItems: 1 },
					parallel: { agent: "reviewer", task: "Review {target.path}" },
					collect: { as: "reviews" },
				},
			],
			agents: [makeAgent("producer"), makeAgent("reviewer")],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-dynamic-fail" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			maxSubagentDepth: 2,
		});

		assert.ok(!result.isError);
		const resultPath = await waitForAsyncResultFile(id, 10_000);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		const status = await waitForAsyncState(id, (candidate) => candidate.state === "failed") as AsyncStatusPayload & { workflowGraph?: AsyncResultPayload["workflowGraph"]; error?: string };
		assert.equal(payload.success, false);
		assert.match(payload.results.at(-1)?.error ?? "", /exceeding maxItems 1/);
		assert.equal(payload.workflowGraph?.nodes?.[1]?.status, "failed");
		assert.match(payload.workflowGraph?.nodes?.[1]?.error ?? "", /exceeding maxItems 1/);
		assert.equal(status.state, "failed");
		assert.match(status.error ?? "", /exceeding maxItems 1/);
		assert.equal(status.workflowGraph?.nodes?.[1]?.status, "failed");
	});

	it("async dynamic collect schema failures persist failed graph status and details", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ output: "targets", structuredOutput: { items: [{ path: "src/a.ts" }] } });
		mockPi.onCall({ output: "review-a", structuredOutput: { ok: "a" } });
		const id = `async-dynamic-collect-fail-${Date.now().toString(36)}`;
		const result = executeAsyncChain(id, {
			chain: [
				{ agent: "producer", task: "Produce targets", as: "targets", outputSchema: { type: "object" } },
				{
					expand: { from: { output: "targets", path: "/items" }, item: "target", key: "/path", maxItems: 4 },
					parallel: { agent: "reviewer", task: "Review {target.path}", outputSchema: { type: "object" } },
					collect: { as: "reviews", outputSchema: { type: "object" } },
				},
			],
			agents: [makeAgent("producer"), makeAgent("reviewer")],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-dynamic-collect-fail" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			maxSubagentDepth: 2,
		});

		assert.ok(!result.isError);
		const resultPath = await waitForAsyncResultFile(id, 10_000);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		assert.equal(payload.success, false);
		assert.match(payload.results.at(-1)?.error ?? "", /Collected output validation failed/);
		assert.ok(Array.isArray(payload.results.at(-1)?.structuredOutput), "failed collect result should preserve ordered collection details");
		assert.equal(payload.workflowGraph?.nodes?.[1]?.status, "failed");
		assert.match(payload.workflowGraph?.nodes?.[1]?.error ?? "", /Collected output validation failed/);
	});



	it("readStatus caches ordered sweeps above 50 files and invalidates same-mtime replacements", () => {
		const root = createTempDir();
		try {
			const fixedTimestamp = new Date(1_700_000_000_000);
			const dirs = Array.from({ length: 51 }, (_, index) => {
				const dir = path.join(root, `run-${index}`);
				const statusPath = path.join(dir, "status.json");
				fs.mkdirSync(dir);
				fs.writeFileSync(statusPath, JSON.stringify({
					runId: `cache-test-${index}`,
					state: "running",
					mode: "single",
					startedAt: fixedTimestamp.getTime(),
				}));
				fs.utimesSync(statusPath, fixedTimestamp, fixedTimestamp);
				return dir;
			});

			const cached = dirs.map((dir) => readStatus(dir));
			cached.forEach((status) => assert.ok(status));
			dirs.forEach((dir, index) => assert.strictEqual(readStatus(dir), cached[index]));

			const replacedDir = dirs[25]!;
			const cachedStatus = cached[25];
			assert.ok(cachedStatus);
			const statusPath = path.join(replacedDir, "status.json");
			writeAtomicJson(statusPath, { ...cachedStatus, state: "stopped" });
			fs.utimesSync(statusPath, fixedTimestamp, fixedTimestamp);
			assert.equal(fs.statSync(statusPath).mtimeMs, fixedTimestamp.getTime());
			const replaced = readStatus(replacedDir);
			assert.ok(replaced);
			assert.equal(replaced.state, "stopped");
			assert.notStrictEqual(replaced, cachedStatus);

			fs.rmSync(statusPath);
			assert.equal(readStatus(replacedDir), null);

			const removedDir = dirs[50]!;
			assert.ok(readStatus(removedDir));
			fs.rmSync(removedDir, { recursive: true, force: true });
			assert.equal(pruneStatusCacheForAsyncRoot(root, dirs.slice(0, 50).map((dir) => path.basename(dir))), 1);
		} finally {
			removeTempDir(root);
		}
	});

	it("readStatus throws for malformed status files", () => {
		const dir = createTempDir();
		try {
			fs.writeFileSync(path.join(dir, "status.json"), "{bad-json", "utf-8");
			assert.throws(() => readStatus(dir), /Failed to parse async status file/);
		} finally {
			removeTempDir(dir);
		}
	});

	it("background runs record fallback attempts and final model", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({
			jsonl: [{
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "primary failed" }],
					model: "openai/gpt-5-mini",
					errorMessage: "rate limit exceeded",
					usage: { input: 10, output: 5, cacheRead: 300, cacheWrite: 0, cost: { total: 0.01 } },
				},
			}],
			exitCode: 1,
		});
		mockPi.onCall({ output: "Recovered asynchronously" });
		const id = `async-fallback-${Date.now().toString(36)}`;
		const sessionRoot = path.join(tempDir, "sessions");
		const asyncDir = path.join(ASYNC_DIR, id);
		const resultPath = path.join(RESULTS_DIR, `${id}.json`);
		const run = executeAsyncSingle(id, {
			agent: "worker",
			task: "Do work",
			acceptance: { level: "none", reason: "descriptor persistence coverage" },
			agentConfig: makeAgent("worker", {
				model: "openai/gpt-5-mini:high",
				fallbackModels: ["anthropic/claude-sonnet-4:low"],
			}),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			availableModels: [
				{ provider: "openai", id: "gpt-5-mini", fullId: "openai/gpt-5-mini" },
				{ provider: "anthropic", id: "claude-sonnet-4", fullId: "anthropic/claude-sonnet-4" },
			],
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot,
			maxSubagentDepth: 2,
		});

		assert.equal(run.details.asyncId, id);

		const started = Date.now();
		while (!fs.existsSync(resultPath)) {
			if (Date.now() - started > 15000) {
				assert.fail(`Timed out waiting for async result file: ${resultPath}`);
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
		}

		const descriptorPath = path.join(asyncDir, "recovery-descriptor.json");
		const descriptor = JSON.parse(fs.readFileSync(descriptorPath, "utf-8"));
		assert.equal(descriptor.sourceRunId, id);
		assert.equal(descriptor.agent, "worker");
		assert.equal(descriptor.model, "openai/gpt-5-mini:high");
		assert.deepEqual(descriptor.fallbackModels, ["anthropic/claude-sonnet-4:low"]);
		assert.equal(descriptor.cwd, tempDir);
		assert.equal(descriptor.sessionDir, path.join(sessionRoot, `async-${id}`));
		assert.deepEqual(descriptor.acceptance, { level: "none", reason: "descriptor persistence coverage" });
		assert.equal(descriptor.initialTurnBudget, undefined);
		assert.equal(Object.hasOwn(descriptor.acceptance, "explicit"), false);
		assert.equal(Object.hasOwn(descriptor.acceptance, "inferredReason"), false);
		assert.equal(Object.hasOwn(descriptor, "task"), false);
		if (process.platform !== "win32") assert.equal(fs.statSync(descriptorPath).mode & 0o777, 0o600);

		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
		assert.equal(payload.lifecycleArtifactVersion, SUBAGENT_LIFECYCLE_ARTIFACT_VERSION);
		assert.equal(payload.success, true);
		assert.equal(payload.results[0].model, "anthropic/claude-sonnet-4:low");
		assert.deepEqual(payload.results[0].attemptedModels, ["openai/gpt-5-mini:high", "anthropic/claude-sonnet-4:low"]);
		assert.equal(payload.results[0].modelAttempts.length, 2);
		assert.deepEqual(payload.results[0].totalCost, { inputTokens: 110, outputTokens: 55, costUsd: 0.011 });
		assert.deepEqual(payload.totalCost, { inputTokens: 110, outputTokens: 55, costUsd: 0.011 });
		const statusPayload = await waitForAsyncState(id, (candidate) => candidate.state === "complete"
			&& candidate.lifecycleArtifactVersion !== undefined
			&& candidate.totalTokens?.total !== undefined
			&& candidate.totalCost !== undefined
			&& candidate.steps[0]?.model !== undefined
			&& candidate.steps[0]?.thinking !== undefined
			&& candidate.steps[0]?.tokens?.total !== undefined
			&& candidate.steps[0]?.totalCost !== undefined);
		assert.equal(statusPayload.lifecycleArtifactVersion, SUBAGENT_LIFECYCLE_ARTIFACT_VERSION);
		assert.equal(statusPayload.steps[0]?.model, "anthropic/claude-sonnet-4:low");
		assert.equal(statusPayload.steps[0]?.thinking, "low");
		assert.ok(statusPayload.totalTokens!.total > 0);
		assert.ok(statusPayload.steps[0]?.tokens!.total > 0);
		assert.equal(statusPayload.totalTokens!.window, 100);
		assert.equal(statusPayload.totalTokens!.windowPeak, 310);
		assert.equal(statusPayload.steps[0]?.tokens!.window, 100);
		assert.equal(statusPayload.steps[0]?.tokens!.windowPeak, 310);
		assert.deepEqual(statusPayload.steps[0]?.totalCost, { inputTokens: 110, outputTokens: 55, costUsd: 0.011 });
		assert.deepEqual(statusPayload.totalCost, { inputTokens: 110, outputTokens: 55, costUsd: 0.011 });
		const events = fs.readFileSync(path.join(asyncDir, "events.jsonl"), "utf-8").trim().split("\n").map((line) => JSON.parse(line));
		assert.equal(events.find((event) => event.type === "subagent.run.started")?.lifecycleArtifactVersion, SUBAGENT_LIFECYCLE_ARTIFACT_VERSION);
		const completed = await waitForAsyncEvent(id, "subagent.run.completed");
		assert.equal(completed.lifecycleArtifactVersion, SUBAGENT_LIFECYCLE_ARTIFACT_VERSION);
		assert.deepEqual(completed.totalCost, { inputTokens: 110, outputTokens: 55, costUsd: 0.011 });
		assert.match(fs.readFileSync(path.join(asyncDir, "output-0.log"), "utf-8"), /Recovered asynchronously/);
		assert.equal(mockPi.callCount(), 2);
	});

	it("background runs retry a zero-activity startup exit on the same model", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ exitCode: 1 });
		mockPi.onCall({ output: "Recovered asynchronously after startup race" });
		const id = `async-startup-retry-${Date.now().toString(36)}`;
		executeAsyncSingle(id, {
			agent: "worker",
			task: "Do work",
			agentConfig: makeAgent("worker", {
				model: "openai/gpt-5-mini:high",
				fallbackModels: ["anthropic/claude-sonnet-4:low"],
			}),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			availableModels: [
				{ provider: "openai", id: "gpt-5-mini", fullId: "openai/gpt-5-mini" },
				{ provider: "anthropic", id: "claude-sonnet-4", fullId: "anthropic/claude-sonnet-4" },
			],
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			maxSubagentDepth: 2,
		});

		const payload = JSON.parse(fs.readFileSync(await waitForAsyncResultFile(id), "utf-8")) as AsyncResultPayload;
		assert.equal(payload.success, true);
		assert.equal(payload.results[0]?.model, "openai/gpt-5-mini:high");
		assert.deepEqual(payload.results[0]?.attemptedModels, ["openai/gpt-5-mini:high"]);
		assert.deepEqual(payload.results[0]?.modelAttempts?.map((attempt) => attempt.success), [false, true]);
		assert.match(payload.results[0]?.output ?? "", /\[startup-retry\].*Recovered asynchronously after startup race/s);
		assert.equal(mockPi.callCount(), 2);
	});

	it("background runs fail when a configured provider-qualified model starts on a different child model", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ jsonl: [events.assistantMessage("wrong async provider", "openai-codex/gpt-5.6-sol")] });
		const id = `async-model-verification-${Date.now().toString(36)}`;
		executeAsyncSingle(id, {
			agent: "worker",
			task: "Do work",
			agentConfig: makeAgent("worker", { model: "opencode-go/ox-alpha-free:max" }),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			availableModels: [
				{ provider: "opencode-go", id: "ox-alpha-free", fullId: "opencode-go/ox-alpha-free" },
				{ provider: "openai-codex", id: "gpt-5.6-sol", fullId: "openai-codex/gpt-5.6-sol" },
			],
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			maxSubagentDepth: 2,
		});

		const payload = JSON.parse(fs.readFileSync(await waitForAsyncResultFile(id), "utf-8")) as AsyncResultPayload;
		assert.equal(payload.success, false);
		assert.equal(payload.results[0]?.model, "opencode-go/ox-alpha-free:max");
		assert.deepEqual(payload.results[0]?.attemptedModels, ["opencode-go/ox-alpha-free:max"]);
		assert.equal(payload.results[0]?.modelAttempts?.[0]?.success, false);
		assert.match(payload.results[0]?.error ?? "", /model_verification_failed/);
		assert.match(payload.results[0]?.error ?? "", /Expected 'opencode-go\/ox-alpha-free:max'/);
		assert.match(payload.results[0]?.error ?? "", /observed 'openai-codex\/gpt-5\.6-sol'/);
		assert.match(payload.results[0]?.modelAttempts?.[0]?.error ?? "", /model_verification_failed/);
		const args = readMockPiArgs(mockPi, 0);
		assert.equal(args[args.indexOf("--model") + 1], "opencode-go/ox-alpha-free:max");
		assert.equal(mockPi.callCount(), 1);
	});

	it("background runs retry the fallback model when the provider stream ends without finish_reason", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({
			jsonl: [{
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "stream broke mid-response" }],
					model: "openai/gpt-5-mini",
					errorMessage: "Stream ended without finish_reason",
					usage: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } },
				},
			}],
			exitCode: 1,
		});
		mockPi.onCall({ output: "Recovered after stream failure" });
		const id = `async-fallback-stream-${Date.now().toString(36)}`;
		executeAsyncSingle(id, {
			agent: "worker",
			task: "Do work",
			agentConfig: makeAgent("worker", {
				model: "openai/gpt-5-mini:high",
				fallbackModels: ["anthropic/claude-sonnet-4:low"],
			}),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			availableModels: [
				{ provider: "openai", id: "gpt-5-mini", fullId: "openai/gpt-5-mini" },
				{ provider: "anthropic", id: "claude-sonnet-4", fullId: "anthropic/claude-sonnet-4" },
			],
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			maxSubagentDepth: 2,
		});

		const payload = JSON.parse(fs.readFileSync(await waitForAsyncResultFile(id), "utf-8"));
		assert.equal(payload.success, true);
		assert.deepEqual(payload.results[0].attemptedModels, ["openai/gpt-5-mini:high", "anthropic/claude-sonnet-4:low"]);
		assert.match(payload.results[0].output ?? "", /Recovered after stream failure/);
		assert.equal(mockPi.callCount(), 2);
	});

	it("background runs retry the fallback model after a provider connection error", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({
			jsonl: [{
				type: "message_end",
				message: {
					role: "assistant",
					content: [],
					model: "openai/gpt-5-mini",
					errorMessage: "Connection error.",
					usage: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } },
				},
			}],
			exitCode: 1,
		});
		mockPi.onCall({ output: "Recovered after connection error" });
		const id = `async-fallback-connection-error-${Date.now().toString(36)}`;
		executeAsyncSingle(id, {
			agent: "worker",
			task: "Do work",
			agentConfig: makeAgent("worker", {
				model: "openai/gpt-5-mini:high",
				fallbackModels: ["anthropic/claude-sonnet-4:low"],
			}),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			availableModels: [
				{ provider: "openai", id: "gpt-5-mini", fullId: "openai/gpt-5-mini" },
				{ provider: "anthropic", id: "claude-sonnet-4", fullId: "anthropic/claude-sonnet-4" },
			],
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			maxSubagentDepth: 2,
		});

		const payload = JSON.parse(fs.readFileSync(await waitForAsyncResultFile(id), "utf-8"));
		assert.equal(payload.success, true);
		assert.deepEqual(payload.results[0].attemptedModels, ["openai/gpt-5-mini:high", "anthropic/claude-sonnet-4:low"]);
		assert.match(payload.results[0].modelAttempts[0].error ?? "", /Connection error/u);
		assert.match(payload.results[0].output ?? "", /Recovered after connection error/u);
		assert.equal(mockPi.callCount(), 2);
	});

	it("background runs do not retry the fallback model for a trailing tool failure", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({
			jsonl: [
				mockAssistantMessage("checking connectivity", "tool_use"),
				events.toolResult("bash", "curl: (28) Connection timed out after 5000 ms\nCommand exited with code 1", true),
			],
			exitCode: 0,
		});
		mockPi.onCall({ output: "fallback must not run" });
		const id = `async-fallback-toolfail-${Date.now().toString(36)}`;
		executeAsyncSingle(id, {
			agent: "worker",
			task: "Do work",
			agentConfig: makeAgent("worker", {
				model: "openai/gpt-5-mini:high",
				fallbackModels: ["anthropic/claude-sonnet-4:low"],
			}),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			availableModels: [
				{ provider: "openai", id: "gpt-5-mini", fullId: "openai/gpt-5-mini" },
				{ provider: "anthropic", id: "claude-sonnet-4", fullId: "anthropic/claude-sonnet-4" },
			],
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			maxSubagentDepth: 2,
		});

		const payload = JSON.parse(fs.readFileSync(await waitForAsyncResultFile(id), "utf-8"));
		assert.equal(payload.success, false);
		assert.equal(payload.results[0].modelAttempts.length, 1);
		assert.match(payload.results[0].error ?? "", /^bash failed \(exit 1\)/);
		assert.match(payload.results[0].error ?? "", /timed out/i);
		assert.equal(mockPi.callCount(), 1);
	});

	it("background runs do not retry raw connection stderr after child activity", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({
			jsonl: [{
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "completed side effect" }],
					model: "openai/gpt-5-mini",
					stopReason: "stop",
					usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } },
				},
			}],
			stderr: "APIConnectionError: Connection closed.",
			exitCode: 1,
		});
		mockPi.onCall({ output: "fallback must not run" });
		const id = `async-fallback-raw-stderr-${Date.now().toString(36)}`;
		executeAsyncSingle(id, {
			agent: "worker",
			task: "Do work",
			agentConfig: makeAgent("worker", {
				model: "openai/gpt-5-mini:high",
				fallbackModels: ["anthropic/claude-sonnet-4:low"],
			}),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			availableModels: [
				{ provider: "openai", id: "gpt-5-mini", fullId: "openai/gpt-5-mini" },
				{ provider: "anthropic", id: "claude-sonnet-4", fullId: "anthropic/claude-sonnet-4" },
			],
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			maxSubagentDepth: 2,
		});

		const payload = JSON.parse(fs.readFileSync(await waitForAsyncResultFile(id), "utf-8"));
		assert.equal(payload.success, false);
		assert.equal(payload.results[0].modelAttempts.length, 1);
		assert.match(payload.results[0].error ?? "", /Connection closed/u);
		assert.equal(mockPi.callCount(), 1);
	});

	it("background runs resume the retained session once after a provider abort following completed tool work", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		const sessionFile = path.join(tempDir, "async-abort-recovery-session.jsonl");
		mockPi.onCall({
			jsonl: [
				events.toolStart("write", { path: "side-effect.txt", content: "done" }),
				events.toolEnd("write"),
				events.toolResult("write", "Wrote side-effect.txt"),
				{
					type: "message_end",
					message: {
						role: "assistant",
						content: [],
						model: "openai/gpt-5-mini",
						errorMessage: "Connection error.",
						usage: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } },
					},
				},
			],
			writeFiles: [{ path: "side-effect.txt", content: "done" }, { path: sessionFile, content: "{}\n" }],
			exitCode: 1,
		});
		mockPi.onCall({ output: "Recovered asynchronously from retained session" });
		const id = `async-fallback-provider-after-tool-${Date.now().toString(36)}`;
		executeAsyncSingle(id, {
			agent: "worker",
			task: "Do work",
			sessionFile,
			agentConfig: makeAgent("worker", {
				model: "openai/gpt-5-mini:high",
				fallbackModels: ["anthropic/claude-sonnet-4:low"],
			}),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			availableModels: [
				{ provider: "openai", id: "gpt-5-mini", fullId: "openai/gpt-5-mini" },
				{ provider: "anthropic", id: "claude-sonnet-4", fullId: "anthropic/claude-sonnet-4" },
			],
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			maxSubagentDepth: 2,
		});

		const payload = JSON.parse(fs.readFileSync(await waitForAsyncResultFile(id), "utf-8"));
		assert.equal(payload.success, true);
		assert.deepEqual(payload.results[0].attemptedModels, ["openai/gpt-5-mini:high"]);
		assert.deepEqual(payload.results[0].modelAttempts.map((attempt: { success: boolean }) => attempt.success), [false, true]);
		assert.equal(mockPi.callCount(), 2);
		const firstArgs = readMockPiArgs(mockPi, 0);
		const resumedArgs = readMockPiArgs(mockPi, 1);
		assert.equal(firstArgs[firstArgs.indexOf("--session") + 1], sessionFile);
		assert.equal(resumedArgs[resumedArgs.indexOf("--session") + 1], sessionFile);
		assert.match(resumedArgs.at(-1) ?? "", /Continue from the current files and transcript/);
		assert.equal(fs.readFileSync(path.join(tempDir, "side-effect.txt"), "utf-8"), "done");
	});

	it("background single thinking override replaces primary and fallback suffixes", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({
			jsonl: [{
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "primary failed" }],
					model: "openai/gpt-5-mini",
					errorMessage: "rate limit exceeded",
					usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
				},
			}],
			exitCode: 1,
		});
		mockPi.onCall({ output: "Recovered asynchronously" });
		const id = `async-fallback-thinking-off-${Date.now().toString(36)}`;
		const run = executeAsyncSingle(id, {
			agent: "worker",
			task: "Do work",
			agentConfig: makeAgent("worker", {
				model: "openai/gpt-5-mini:high",
				fallbackModels: ["anthropic/claude-sonnet-4:low"],
				thinking: "high",
			}),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			availableModels: [
				{ provider: "openai", id: "gpt-5-mini", fullId: "openai/gpt-5-mini" },
				{ provider: "anthropic", id: "claude-sonnet-4", fullId: "anthropic/claude-sonnet-4" },
			],
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			thinkingOverride: "off",
			maxSubagentDepth: 2,
		});

		assert.equal(run.details.asyncId, id);
		const resultPath = await waitForAsyncResultFile(id);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		const firstArgs = readMockPiArgs(mockPi, 0);
		const secondArgs = readMockPiArgs(mockPi, 1);
		assert.equal(payload.success, true);
		assert.equal(payload.results[0].model, "anthropic/claude-sonnet-4:off");
		assert.deepEqual(payload.results[0].attemptedModels, ["openai/gpt-5-mini:off", "anthropic/claude-sonnet-4:off"]);
		assert.equal(firstArgs[firstArgs.indexOf("--model") + 1], "openai/gpt-5-mini:off");
		assert.equal(secondArgs[secondArgs.indexOf("--model") + 1], "anthropic/claude-sonnet-4:off");
	});

	it("background runs retry fallback models when a zero-exit attempt has empty output", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
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
		mockPi.onCall({ output: "Recovered asynchronously from empty output" });
		const id = `async-empty-output-fallback-${Date.now().toString(36)}`;
		executeAsyncSingle(id, {
			agent: "worker",
			task: "Do work",
			agentConfig: makeAgent("worker", {
				model: "openai/gpt-5-mini",
				fallbackModels: ["anthropic/claude-sonnet-4"],
			}),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			maxSubagentDepth: 2,
		});

		const resultPath = await waitForAsyncResultFile(id);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		assert.equal(payload.success, true);
		assert.equal(payload.results[0]?.model, "anthropic/claude-sonnet-4");
		assert.match(payload.results[0]?.output ?? "", /Recovered asynchronously from empty output/);
		assert.match(payload.results[0]?.modelAttempts?.[0]?.error ?? "", /no output/i);
		assert.deepEqual(payload.results[0]?.modelAttempts?.map((attempt) => attempt.success), [false, true]);
		assert.equal(mockPi.callCount(), 2);
	});

	it("background fails a zero-exit child that stops during a tool after earlier assistant output", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({
			jsonl: [
				events.assistantMessage("Work is in progress"),
				events.toolStart("bash", { command: "write files" }),
			],
			exitCode: 0,
		});
		const id = `async-mid-tool-exit-${Date.now().toString(36)}`;
		executeAsyncSingle(id, {
			agent: "worker",
			task: "Do work",
			agentConfig: makeAgent("worker", { model: "openai/gpt-5-mini" }),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			maxSubagentDepth: 2,
		});

		const resultPath = await waitForAsyncResultFile(id);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		assert.equal(payload.success, false);
		assert.equal(payload.results[0]?.success, false);
		assert.match(payload.results[0]?.error ?? "", /exited during 'bash' tool execution \(exit 0\)/);
		assert.match(payload.results[0]?.error ?? "", /Earlier assistant output is not a terminal result/);
		assert.doesNotMatch(payload.results[0]?.error ?? "", /cold-start/);
		assert.equal(mockPi.callCount(), 1);
	});

	it("background retains an earlier open tool when a later overlapping tool completes", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({
			jsonl: [
				{ type: "tool_execution_start", toolCallId: "bash-1", toolName: "bash", args: { command: "wait" } },
				{ type: "tool_execution_start", toolCallId: "read-1", toolName: "read", args: { path: "README.md" } },
				{ type: "tool_execution_end", toolCallId: "read-1", toolName: "read" },
			],
			exitCode: 0,
		});
		const id = `async-overlap-mid-tool-exit-${Date.now().toString(36)}`;
		executeAsyncSingle(id, {
			agent: "worker",
			task: "Do work",
			agentConfig: makeAgent("worker", { model: "openai/gpt-5-mini" }),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			maxSubagentDepth: 2,
		});

		const resultPath = await waitForAsyncResultFile(id);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		assert.equal(payload.success, false);
		assert.match(payload.results[0]?.error ?? "", /exited during 'bash' tool execution \(exit 0\)/);
	});

	it("background runs prefer empty-output fallback over an earlier tool error", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
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
		mockPi.onCall({ output: "Recovered asynchronously on fallback" });
		const id = `async-empty-output-after-tool-error-${Date.now().toString(36)}`;
		executeAsyncSingle(id, {
			agent: "worker",
			task: "Do work",
			agentConfig: makeAgent("worker", {
				model: "openai/gpt-5-mini",
				fallbackModels: ["anthropic/claude-sonnet-4"],
			}),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			maxSubagentDepth: 2,
		});

		const resultPath = await waitForAsyncResultFile(id);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		assert.equal(payload.success, true);
		assert.equal(payload.results[0]?.model, "anthropic/claude-sonnet-4");
		assert.match(payload.results[0]?.modelAttempts?.[0]?.error ?? "", /no output/i);
		assert.equal(mockPi.callCount(), 2);
	});

	it("background runs fail zero-exit provider errors when no fallback succeeds", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({
			jsonl: [{
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "quota hit" }],
					model: "openai/gpt-5-mini",
					errorMessage: "429 quota exceeded",
					usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
				},
			}],
			exitCode: 0,
		});
		const id = `async-zero-exit-provider-error-${Date.now().toString(36)}`;
		executeAsyncSingle(id, {
			agent: "worker",
			task: "Do work",
			agentConfig: makeAgent("worker", { model: "openai/gpt-5-mini" }),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			maxSubagentDepth: 2,
		});

		const resultPath = await waitForAsyncResultFile(id);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		assert.equal(payload.success, false);
		assert.match(payload.results[0]?.error ?? "", /429 quota exceeded/);
		const statusPayload = await waitForAsyncState(id, (status) => status.state === "failed");
		assert.match(statusPayload.steps?.[0]?.error ?? "", /429 quota exceeded/);
	});

	it("background runs treat recovered child errors as successful", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({
			jsonl: [
				events.toolResult("read", "EISDIR: illegal operation on a directory", true),
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
				events.assistantMessage("Recovered asynchronously"),
			],
		});
		const id = `async-recovered-child-error-${Date.now().toString(36)}`;
		const asyncDir = path.join(ASYNC_DIR, id);
		executeAsyncSingle(id, {
			agent: "worker",
			task: "Do work",
			agentConfig: makeAgent("worker", { model: "openai/gpt-5-mini" }),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			maxSubagentDepth: 2,
		});

		const resultPath = await waitForAsyncResultFile(id);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		assert.equal(payload.success, true);
		assert.equal(payload.state, "complete");
		assert.equal(payload.exitCode, 0);
		assert.equal(payload.results[0]?.success, true);
		assert.equal(payload.results[0]?.error, undefined);
		assert.equal(payload.results[0]?.output, "Recovered asynchronously");
		const statusPayload = await waitForAsyncState(id, (candidate) => candidate.state === "complete");
		assert.equal(statusPayload.state, "complete");
		assert.equal(statusPayload.steps?.[0]?.status, "complete");
		assert.equal(statusPayload.steps?.[0]?.exitCode, 0);
	});

	it("background runs keep provider errors failed when followed only by empty assistant output", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
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
		const id = `async-provider-error-empty-stop-${Date.now().toString(36)}`;
		const asyncDir = path.join(ASYNC_DIR, id);
		executeAsyncSingle(id, {
			agent: "worker",
			task: "Do work",
			agentConfig: makeAgent("worker", { model: "openai/gpt-5-mini" }),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			maxSubagentDepth: 2,
		});

		const resultPath = await waitForAsyncResultFile(id);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		assert.equal(payload.success, false);
		assert.equal(payload.state, "failed");
		assert.equal(payload.exitCode, 1);
		assert.equal(payload.results[0]?.success, false);
		assert.match(payload.results[0]?.error ?? "", /provider transport failed/);
		assert.equal(payload.results[0]?.output, "");
		const statusPayload = await waitForAsyncState(id, (candidate) => candidate.state === "failed");
		assert.equal(statusPayload.state, "failed");
		assert.equal(statusPayload.steps?.[0]?.status, "failed");
		assert.equal(statusPayload.steps?.[0]?.exitCode, 1);
	});

	it("background file-only runs write full output but return only a file reference", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ output: "async full output\nwith details" });
		const id = `async-file-only-${Date.now().toString(36)}`;
		const resultPath = path.join(RESULTS_DIR, `${id}.json`);
		const outputPath = path.join(tempDir, "async-file-only.md");
		const run = executeAsyncSingle(id, {
			agent: "analyst",
			task: "Analyze without modifying files",
			agentConfig: makeAgent("analyst", { tools: ["read", "grep", "find", "ls"] }),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			output: outputPath,
			outputMode: "file-only",
			maxSubagentDepth: 2,
		});

		assert.equal(run.details.asyncId, id);
		const call = await waitForMockPiCall(mockPi, 0);
		const taskArg = call.args.at(-1) ?? "";
		const systemPrompt = call.systemPrompts[0]?.text ?? "";
		for (const instruction of [taskArg, systemPrompt]) {
			assert.match(instruction, /Return the complete artifact in your final response\./);
			assert.match(instruction, /runtime will persist it to exactly this path:/);
			assert.match(instruction, /Do not call contact_supervisor merely because no write-capable tool is available\./);
			assert.doesNotMatch(instruction, /Write your findings to exactly this path/);
		}
		const deadline = Date.now() + 10_000;
		while (!fs.existsSync(resultPath)) {
			if (Date.now() > deadline) assert.fail(`Timed out waiting for async result file: ${resultPath}`);
			await new Promise((resolve) => setTimeout(resolve, 100));
		}

		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		assert.equal(payload.success, true);
		assert.match(payload.summary ?? "", /Output saved to:/);
		assert.match(payload.summary ?? "", /2 lines/);
		assert.doesNotMatch(payload.summary ?? "", /async full output/);
		assert.match(payload.results[0]?.output ?? "", /Output saved to:/);
		assert.doesNotMatch(payload.results[0]?.output ?? "", /async full output/);
		assert.equal(fs.readFileSync(outputPath, "utf-8"), "async full output\nwith details");
	});

	it("background single runs route relative outputs to outputBaseDir", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ output: "async configured report" });
		const id = `async-configured-output-base-${Date.now().toString(36)}`;
		const outputBaseDir = path.join(tempDir, "async-configured-outputs");
		const run = executeAsyncSingle(id, {
			agent: "researcher",
			task: "Write report",
			agentConfig: makeAgent("researcher", { output: "context.md" }),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			output: "context.md",
			outputBaseDir,
			maxSubagentDepth: 2,
		});

		assert.equal(run.details.asyncId, id);
		const outputPath = path.join(outputBaseDir, "context.md");
		const call = await waitForMockPiCall(mockPi, 0);
		const taskArg = call.args.at(-1) ?? "";
		assert.match(taskArg, new RegExp(`Write your findings to exactly this path: ${escapeRegExp(outputPath)}`));
		const resultPath = await waitForAsyncResultFile(id);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		assert.equal(payload.success, true);
		assert.equal(fs.readFileSync(outputPath, "utf-8"), "async configured report");
		assert.equal(fs.existsSync(path.join(tempDir, "context.md")), false);
	});

	it("background single runs make output overrides authoritative in the child system prompt", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ output: "async override report" });
		const id = `async-output-override-system-prompt-${Date.now().toString(36)}`;
		const outputPath = path.join(tempDir, "async-custom-report.md");
		const run = executeAsyncSingle(id, {
			agent: "researcher",
			task: "Write report",
			agentConfig: makeAgent("researcher", {
				output: "default-report.md",
				systemPrompt: "Output format (`default-report.md`):\n\nWrite the full report to default-report.md.",
			}),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			output: outputPath,
			maxSubagentDepth: 2,
		});

		assert.equal(run.details.asyncId, id);
		const call = await waitForMockPiCall(mockPi, 0);
		const taskArg = call.args.at(-1) ?? "";
		const systemPrompt = call.systemPrompts[0]?.text ?? "";
		assert.match(taskArg, new RegExp(`Write your findings to exactly this path: ${escapeRegExp(outputPath)}`));
		assert.match(systemPrompt, /Output format \(`default-report\.md`\):/);
		assert.match(systemPrompt, /Runtime output path override:/);
		assert.match(systemPrompt, new RegExp(`Write your findings to exactly this path: ${escapeRegExp(outputPath)}`));
		assert.match(systemPrompt, /Ignore any other output filename or output path mentioned elsewhere/);
		await waitForAsyncResultFile(id);
	});

	it("background single runs treat string false as disabled output", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ output: "async inline report" });
		const id = `async-string-false-output-${Date.now().toString(36)}`;
		const run = executeAsyncSingle(id, {
			agent: "worker",
			task: "Do work",
			agentConfig: makeAgent("worker", { output: "default-report.md" }),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			output: "false",
			maxSubagentDepth: 2,
		});

		assert.equal(run.details.asyncId, id);
		const resultPath = await waitForAsyncResultFile(id);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		assert.equal(payload.success, true);
		assert.equal(payload.results[0]?.output, "async inline report");
		assert.doesNotMatch(payload.summary ?? "", /Output saved to:/);
		assert.equal(fs.existsSync(path.join(tempDir, "false")), false);
		assert.equal(fs.existsSync(path.join(tempDir, "default-report.md")), false);
		assert.doesNotMatch(readLastMockPiArgs(mockPi).at(-1) ?? "", /Write your findings to(?: exactly this path)?:/);
	});

	it("background runs detect hidden tool failures even when the child exits 0", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({
			jsonl: [events.toolResult("bash", "connection refused")],
		});

		const id = `async-hidden-failure-${Date.now().toString(36)}`;
		const resultPath = path.join(RESULTS_DIR, `${id}.json`);
		const sessionRoot = path.join(tempDir, "sessions");

		executeAsyncSingle(id, {
			agent: "worker",
			task: "Deploy app",
			agentConfig: makeAgent("worker"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot,
			maxSubagentDepth: 2,
		});

		const deadline = Date.now() + 10_000;
		while (!fs.existsSync(resultPath)) {
			if (Date.now() > deadline) {
				assert.fail(`Timed out waiting for async result file: ${resultPath}`);
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
		}

		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
		assert.equal(payload.success, false);
		assert.equal(payload.exitCode, 1);
		assert.equal(payload.results[0].success, false);
	});

	it("background implementation runs fail when no mutation attempt occurred", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ output: "I’ll do that now and report back after implementing." });

		const id = `async-no-mutation-${Date.now().toString(36)}`;
		const resultPath = path.join(RESULTS_DIR, `${id}.json`);
		const sessionRoot = path.join(tempDir, "sessions");

		executeAsyncSingle(id, {
			agent: "worker",
			task: "Implement the approved fixes",
			agentConfig: makeAgent("worker"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot,
			maxSubagentDepth: 2,
		});

		const deadline = Date.now() + 10_000;
		while (!fs.existsSync(resultPath)) {
			if (Date.now() > deadline) {
				assert.fail(`Timed out waiting for async result file: ${resultPath}`);
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
		}

		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
		assert.equal(payload.success, false);
		assert.equal(payload.exitCode, 1);
		assert.equal(payload.results[0].success, false);
		assert.match(String(payload.results[0].error ?? ""), /completed without making edits/);
		assert.match(String(payload.results[0].modelAttempts?.[0]?.error ?? ""), /completed without making edits/);
		assert.deepEqual(payload.results[0].effects?.settlementDiagnostic?.mutation, {
			expected: true,
			attempted: false,
			observed: false,
		});
		assert.equal(payload.results[0].effects?.settlementDiagnostic?.finalTextPresent, true);

		const eventsPath = path.join(ASYNC_DIR, id, "events.jsonl");
		const eventsText = fs.readFileSync(eventsPath, "utf-8");
		assert.match(eventsText, /"reason":"completion_guard"/);
		assert.match(eventsText, /Subagent failed: worker/);
		assert.doesNotMatch(eventsText, /Status:/);
		assert.doesNotMatch(eventsText, /Interrupt:/);
	});

	it("does not use shared-cwd sibling tracked edits as parallel completion-guard proof", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({
			matchArgIncludes: "Edit tracked file",
			delay: 50,
			writeFiles: [{ path: "input.md", content: "changed by first sibling\n" }],
			jsonl: [
				...events.completedWrite("input.md", "changed by first sibling\n"),
				events.assistantMessage("Implemented first sibling change."),
			],
		});
		mockPi.onCall({
			matchArgIncludes: "Implement second sibling change",
			delay: 500,
			output: "Implemented second sibling change.",
		});
		const repo = createRepo("pi-subagents-shared-cwd-mutation-guard-");
		const id = `async-parallel-shared-cwd-mutation-${Date.now().toString(36)}`;
		let runnerStarted = false;
		try {
			const launch = executeAsyncChain(id, {
				chain: [{
					parallel: [
						{ agent: "first", task: "Edit tracked file" },
						{ agent: "second", task: "Implement second sibling change" },
					],
					concurrency: 2,
				}],
				resultMode: "parallel",
				agents: [makeAgent("first"), makeAgent("second")],
				ctx: { pi: { events: { emit() {} } }, cwd: repo, currentSessionId: "session-1" },
				artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
				shareEnabled: false,
				maxSubagentDepth: 2,
			});
			runnerStarted = !launch.isError;

			const payload = await readAsyncPayload(id);
			assert.equal(payload.results[0]?.success, true);
			assert.equal(payload.results[0]?.effects?.fileMutation?.status, "observed");
			assert.equal(payload.results[1]?.success, false);
			assert.equal(payload.results[1]?.effects?.fileMutation?.status, "missing");
			assert.equal(payload.results[1]?.effects?.fileMutation?.attempted, false);
			assert.match(payload.results[1]?.error ?? "", /completed without making edits/);
		} finally {
			if (runnerStarted) await waitForAsyncEvent(id, "subagent.run.process_terminal");
			fs.rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
		}
	});

	it("background implementation challenges keep explicit no-change reports successful", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ output: [
			"Kept the current implementation. No new code or test changes were made in this challenge pass.",
			"Reason: the current candidate is the smallest correct shape.",
		].join("\n\n") });

		const id = `async-no-change-challenge-${Date.now().toString(36)}`;
		const sessionRoot = path.join(tempDir, "sessions");
		const task = [
			"You are reviving a previous subagent conversation.",
			"",
			"Original run: source-run",
			"Original agent: worker",
			"Original session file: /tmp/source-session.jsonl",
			"",
			"Use the stored session context as background. Answer the orchestrator's follow-up below. Do not assume the original child process is still alive.",
			"",
			"Follow-up:",
			"Implementation challenge pass 1 for the accepted candidate. Reconsider it and implement any better current-scope change.",
		].join("\n");

		executeAsyncSingle(id, {
			agent: "worker",
			task,
			agentConfig: makeAgent("worker"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot,
			maxSubagentDepth: 2,
		});

		const resultPath = await waitForAsyncResultFile(id, 10_000);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
		assert.equal(payload.success, true);
		assert.equal(payload.exitCode, 0);
		assert.equal(payload.results[0].success, true);
		assert.match(String(payload.results[0].output), /Kept the current implementation/);
		assert.doesNotMatch(String(payload.results[0].error ?? ""), /completed without making edits/);

		const eventsText = fs.readFileSync(path.join(ASYNC_DIR, id, "events.jsonl"), "utf-8");
		assert.doesNotMatch(eventsText, /Subagent failed: worker/);
		assert.doesNotMatch(eventsText, /"reason":"completion_guard"/);
	});

	it("agent contract v1 keeps async acceptance and file-mutation effects separate from execution", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ output: "I’ll do that now and report back after implementing.\n```acceptance-report\n{\"criteriaSatisfied\":[{\"id\":\"criterion-1\",\"status\":\"not-satisfied\",\"evidence\":\"no proof\"}]}\n```" });
		const id = `async-v1-separate-${Date.now().toString(36)}`;

		executeAsyncSingle(id, {
			agent: "worker",
			task: "Implement the approved fixes",
			agentConfig: makeAgent("worker", { completionGuard: true }),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
			agentContract: { version: 1 },
			acceptance: { level: "checked", criteria: ["Return required proof"] },
		});

		const resultPath = await waitForAsyncResultFile(id, 10_000);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		const statusPayload = await waitForAsyncState(id, (candidate) => candidate.state === "complete");

		assert.equal(payload.success, true);
		assert.equal(payload.state, "complete");
		assert.equal(payload.exitCode, 0);
		assert.equal(payload.results[0]?.agentContract?.version, 1);
		assert.equal(payload.results[0]?.execution?.status, "completed");
		assert.equal(payload.results[0]?.execution?.success, true);
		assert.equal(payload.results[0]?.acceptance?.status, "rejected");
		assert.equal(payload.results[0]?.effects?.fileMutation?.status, "missing");
		assert.equal(statusPayload.state, "complete");
		assert.equal(statusPayload.steps?.[0]?.agentContract?.version, 1);
		assert.equal(statusPayload.steps?.[0]?.execution?.status, "completed");
		assert.equal(statusPayload.steps?.[0]?.effects?.fileMutation?.status, "missing");
	});

	it("background single runs support outputSchema", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ output: "structured", structuredOutput: { ok: true, note: "async" } });
		const id = `async-single-schema-${Date.now().toString(36)}`;

		executeAsyncSingle(id, {
			agent: "worker",
			task: "Return structured data",
			agentConfig: makeAgent("worker", { completionGuard: false }),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
			acceptance: false,
			structuredOutputSchema: { type: "object", required: ["ok"], properties: { ok: { type: "boolean" }, note: { type: "string" } } },
		});

		const payload = JSON.parse(fs.readFileSync(await waitForAsyncResultFile(id, 10_000), "utf-8")) as AsyncResultPayload;
		assert.equal(payload.success, true);
		assert.deepEqual(payload.results[0]?.structuredOutput, { ok: true, note: "async" });
	});

	it("background bash-enabled non-implementation agents can opt out of the completion guard", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ output: "cold start test after patch" });

		const id = `async-completion-guard-optout-${Date.now().toString(36)}`;
		const sessionRoot = path.join(tempDir, "sessions");

		executeAsyncSingle(id, {
			agent: "test-runner",
			task: "Run cold start test after patch",
			agentConfig: makeAgent("test-runner", { tools: ["read", "grep", "bash", "ls"], completionGuard: false }),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot,
			maxSubagentDepth: 2,
		});

		const resultPath = await waitForAsyncResultFile(id, 10_000);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
		assert.equal(payload.success, true);
		assert.equal(payload.exitCode, 0);
		assert.equal(payload.results[0].success, true);
		assert.equal(payload.results[0].output, "cold start test after patch");

		const eventsPath = path.join(ASYNC_DIR, id, "events.jsonl");
		const eventsText = fs.readFileSync(eventsPath, "utf-8");
		assert.doesNotMatch(eventsText, /"reason":"completion_guard"/);
	});

	it("background runs prefer the parent session provider for ambiguous bare model ids", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ output: "Done asynchronously" });

		const id = `async-provider-${Date.now().toString(36)}`;
		const resultPath = path.join(RESULTS_DIR, `${id}.json`);
		const sessionRoot = path.join(tempDir, "sessions");

		executeAsyncSingle(id, {
			agent: "worker",
			task: "Do work",
			agentConfig: makeAgent("worker", { model: "gpt-5-mini" }),
			ctx: {
				pi: { events: { emit() {} } },
				cwd: tempDir,
				currentSessionId: "session-1",
				currentModelProvider: "github-copilot",
			},
			availableModels: [
				{ provider: "openai", id: "gpt-5-mini", fullId: "openai/gpt-5-mini" },
				{ provider: "github-copilot", id: "gpt-5-mini", fullId: "github-copilot/gpt-5-mini" },
			],
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot,
			maxSubagentDepth: 2,
		});

		const deadline = Date.now() + 10_000;
		while (!fs.existsSync(resultPath)) {
			if (Date.now() > deadline) {
				assert.fail(`Timed out waiting for async result file: ${resultPath}`);
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
		}

		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
		assert.equal(payload.success, true);
		assert.equal(payload.results[0].model, "github-copilot/gpt-5-mini");
		assert.deepEqual(payload.results[0].attemptedModels, ["github-copilot/gpt-5-mini"]);
	});

	it("rejects an over-cap top-level async launch before creating run artifacts", { skip: !isAsyncAvailable() || !createSubagentExecutor ? "jiti or executor not available" : undefined }, async () => {
		fs.rmSync(path.join(ACTIVE_ASYNC_CAPACITY_DIR, activeAsyncCapacitySessionKey("session-cap")), { recursive: true, force: true });
		const state = {
			baseCwd: tempDir,
			currentSessionId: "session-cap",
			asyncJobs: new Map(),
			fleetJobs: new Map(),
			foregroundControls: new Map(),
			lastForegroundControlId: null,
		};
		const occupied = acquireActiveAsyncCapacity({
			sessionId: "session-cap",
			limit: 1,
			runId: "held-run",
			kind: "runner",
			asyncDir: path.join(tempDir, "held-run"),
		});
		assert.ok(occupied);
		occupied.markStarted("held-runner");
		const rejectedAsyncDir = path.join(ASYNC_DIR, "cap-rejected");
		const rejectedResultPath = path.join(RESULTS_DIR, "cap-rejected.json");
		fs.rmSync(rejectedAsyncDir, { recursive: true, force: true });
		fs.rmSync(rejectedResultPath, { force: true });
		const executor = createSubagentExecutor!({
			pi: { events: createEventBus(), getSessionName: () => undefined },
			state,
			config: { maxActiveAsyncRunsPerSession: 1, artifactDir: "project" },
			asyncByDefault: false,
			tempArtifactsDir: tempDir,
			getSubagentSessionRoot: () => path.join(tempDir, "sessions"),
			expandTilde: (p: string) => p,
			discoverAgents: () => ({ agents: [makeAgent("worker")] }),
		});
		const context = makeMinimalCtx(tempDir);
		context.sessionManager.getSessionFile = () => null;
		context.sessionManager.getSessionId = () => "session-cap";
		const previousDepth = process.env.PI_SUBAGENT_DEPTH;
		process.env.PI_SUBAGENT_DEPTH = "0";
		const result = await executor.execute("cap-rejected", { agent: "worker", task: "Must not start", async: true }, new AbortController().signal, undefined, context);
		if (previousDepth === undefined) delete process.env.PI_SUBAGENT_DEPTH;
		else process.env.PI_SUBAGENT_DEPTH = previousDepth;
		assert.equal(result.isError, true);
		assert.match(result.content[0]?.type === "text" ? result.content[0].text : "", /Active async run capacity exhausted: 1\/1 used/);
		assert.equal(fs.existsSync(rejectedAsyncDir), false);
		assert.equal(fs.existsSync(rejectedResultPath), false);
		assert.equal(fs.existsSync(path.join(tempDir, ".pi", "subagents")), false);
		fs.rmSync(path.join(ACTIVE_ASYNC_CAPACITY_DIR, activeAsyncCapacitySessionKey("session-cap")), { recursive: true, force: true });
	});

	it("scheduled executor launches retain the live active session ownership", { skip: !isAsyncAvailable() || !createSubagentExecutor ? "jiti or executor not available" : undefined }, async () => {
		mockPi.onCall({ output: "Scheduled work completed" });
		const liveCwd = path.join(tempDir, "live-project");
		fs.mkdirSync(liveCwd);
		const state = {
			baseCwd: liveCwd,
			currentSessionId: "session-b",
			lastParentModel: { provider: "deepseek", id: "live-model" },
			subagentSpawns: { sessionId: "session-b", count: 1, configuredLimit: 1, granted: 1, grantHistory: [] },
			asyncJobs: new Map(),
			fleetJobs: new Map(),
			foregroundControls: new Map(),
			lastForegroundControlId: null,
		};
		const executor = createSubagentExecutor!({
			pi: { events: createEventBus(), getSessionName: () => undefined },
			state,
			config: { maxSubagentSpawnsPerSession: 1 },
			asyncByDefault: false,
			tempArtifactsDir: tempDir,
			getSubagentSessionRoot: () => path.join(tempDir, "sessions"),
			expandTilde: (p: string) => p,
			discoverAgents: () => ({ agents: [makeAgent("worker")] }),
		});
		const retainedCtx = makeMinimalCtx(tempDir);
		retainedCtx.sessionManager.getSessionId = () => "session-a";
		retainedCtx.model = { provider: "deepseek", id: "scheduled-model" };
		const launch = await executor.executeScheduled(
			`scheduled-owner-${Date.now().toString(36)}`,
			{ agent: "worker", task: "Run retained project timer", async: true, acceptance: false },
			new AbortController().signal,
			retainedCtx,
		) as AsyncExecutionResult;

		assert.equal(launch.isError, undefined);
		assert.ok(launch.details.asyncId);
		assert.equal(state.currentSessionId, "session-b");
		assert.equal(state.baseCwd, liveCwd);
		assert.deepEqual(state.lastParentModel, { provider: "deepseek", id: "live-model" });
		assert.deepEqual(state.subagentSpawns, { sessionId: "session-b", count: 1, configuredLimit: 1, granted: 1, grantHistory: [] });
		const blocked = await executor.executeScheduled(
			`scheduled-owner-blocked-${Date.now().toString(36)}`,
			{ agent: "worker", task: "Exceed the retained owner budget", async: true, acceptance: false },
			new AbortController().signal,
			retainedCtx,
		);
		assert.equal(blocked.isError, true);
		assert.match(blocked.content[0]?.type === "text" ? blocked.content[0].text : "", /1\/1 used/);
		assert.deepEqual(state.subagentSpawns, { sessionId: "session-b", count: 1, configuredLimit: 1, granted: 1, grantHistory: [] });
		await readAsyncPayload(launch.details.asyncId);
	});

	it("scheduled owners without a model do not inherit the live session model", { skip: !isAsyncAvailable() || !createSubagentExecutor ? "jiti or executor not available" : undefined }, async () => {
		mockPi.onCall({ output: "Scheduled owner work completed" });
		const liveCwd = path.join(tempDir, "live-model-project");
		fs.mkdirSync(liveCwd);
		const state = {
			baseCwd: liveCwd,
			currentSessionId: "session-live",
			lastParentModel: { provider: "router", id: "live-model" },
			asyncJobs: new Map(),
			fleetJobs: new Map(),
			foregroundControls: new Map(),
			lastForegroundControlId: null,
		};
		const executor = createSubagentExecutor!({
			pi: { events: createEventBus(), getSessionName: () => undefined },
			state,
			config: {},
			asyncByDefault: false,
			tempArtifactsDir: tempDir,
			getSubagentSessionRoot: () => path.join(tempDir, "sessions"),
			expandTilde: (p: string) => p,
			discoverAgents: () => ({ agents: [makeAgent("worker")] }),
		});
		const retainedCtx = makeMinimalCtx(tempDir);
		retainedCtx.sessionManager.getSessionId = () => "session-scheduled-owner";

		const launch = await executor.executeScheduled(
			`scheduled-owner-no-model-${Date.now().toString(36)}`,
			{ agent: "worker", task: "Run owner without model", async: true, acceptance: false },
			new AbortController().signal,
			retainedCtx,
		) as AsyncExecutionResult;
		assert.equal(launch.isError, undefined);
		assert.ok(launch.details.asyncId);

		const payload = await readAsyncPayload(launch.details.asyncId);
		assert.equal(payload.success, true);
		assert.equal(state.currentSessionId, "session-live");
		assert.deepEqual(state.lastParentModel, { provider: "router", id: "live-model" });
		const args = readMockPiArgsMatching(mockPi, "Run owner without model");
		assert.equal(args.includes("router/live-model"), false);
		assert.equal(args.includes("--model"), false);
	});

	it("scheduled workflows keep owner status and registries isolated from the live session", { skip: !isAsyncAvailable() || !createSubagentExecutor ? "jiti or executor not available" : undefined }, async () => {
		const liveCwd = path.join(tempDir, "live-workflow-project");
		fs.mkdirSync(liveCwd);
		const state = {
			baseCwd: liveCwd,
			currentSessionId: "session-b",
			subagentSpawns: { sessionId: "session-b", count: 4, configuredLimit: 5, granted: 0, grantHistory: [] },
			asyncJobs: new Map(),
			fleetJobs: new Map(),
			foregroundControls: new Map(),
			lastForegroundControlId: null,
		};
		const executor = createSubagentExecutor!({
			pi: { events: createEventBus(), getSessionName: () => undefined },
			state,
			config: { maxSubagentSpawnsPerSession: 5 },
			asyncByDefault: false,
			tempArtifactsDir: tempDir,
			getSubagentSessionRoot: () => path.join(tempDir, "sessions"),
			expandTilde: (p: string) => p,
			discoverAgents: () => ({ agents: [makeAgent("worker")] }),
		});
		const retainedCtx = makeMinimalCtx(tempDir);
		retainedCtx.sessionManager.getSessionId = () => "session-a";
		const workflowId = `scheduled-workflow-${Date.now().toString(36)}`;
		const launch = await executor.executeScheduled(
			workflowId,
			{ workflowScript: `return await runs.status("${workflowId}")`, async: true },
			new AbortController().signal,
			retainedCtx,
		) as AsyncExecutionResult;

		assert.equal(launch.isError, undefined);
		assert.equal(state.asyncJobs.size, 0);
		assert.equal(state.fleetJobs.size, 0);
		assert.deepEqual(state.subagentSpawns, { sessionId: "session-b", count: 4, configuredLimit: 5, granted: 0, grantHistory: [] });
		const payload = await readAsyncPayload(launch.details.asyncId);
		assert.equal(state.asyncJobs.size, 0);
		assert.equal(state.fleetJobs.size, 0);
		assert.match(payload.workflow.value.output, /Spawn budget: 0\/5 used/);
		assert.match(payload.workflow.value.output, new RegExp(workflowId));
	});

	it("async executor keeps the last parent session model after continuation drops ctx.model", { skip: !isAsyncAvailable() || !createSubagentExecutor ? "jiti or executor not available" : undefined }, async () => {
		mockPi.onCall({ output: "Done asynchronously" });
		const state = {
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
			getSubagentSessionRoot: () => path.join(tempDir, "sessions"),
			expandTilde: (p: string) => p,
			discoverAgents: () => ({ agents: [makeAgent("worker")] }),
		});
		const initialCtx = makeMinimalCtx(tempDir);
		initialCtx.sessionManager.getSessionId = () => "session-continued";
		initialCtx.model = { provider: "deepseek", id: "deepseek-v4-flash" };
		await executor.execute("prime-parent-model", { action: "list" }, new AbortController().signal, undefined, initialCtx);

		const continuedCtx = makeMinimalCtx(tempDir);
		continuedCtx.sessionManager.getSessionId = () => "session-continued";
		const launch = await executor.execute(
			"continued-async-child",
			{ agent: "worker", task: "Do work", async: true, acceptance: false },
			new AbortController().signal,
			undefined,
			continuedCtx,
		) as AsyncExecutionResult;
		assert.equal(launch.isError, undefined);
		assert.ok(launch.details.asyncId);

		const payload = await readAsyncPayload(launch.details.asyncId);
		assert.equal(payload.success, true);
		assert.equal(payload.results[0]?.model, "deepseek/deepseek-v4-flash");
		const args = readMockPiArgs(mockPi, 0);
		assert.equal(args[args.indexOf("--model") + 1], "deepseek/deepseek-v4-flash");
	});

	it("async workflows snapshot the parent model before workflow setup reads session data", { skip: !isAsyncAvailable() || !createSubagentExecutor ? "jiti or executor not available" : undefined }, async () => {
		mockPi.onCall({ output: "Inherited model work" });
		mockPi.onCall({ output: "Explicit model work" });
		const state = {
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
			getSubagentSessionRoot: () => path.join(tempDir, "sessions"),
			expandTilde: (p: string) => p,
			discoverAgents: () => ({ agents: [makeAgent("worker")] }),
		});
		const context = makeMinimalCtx(tempDir);
		context.sessionManager.getSessionId = () => "session-workflow-parent-model";
		context.model = { provider: "router", id: "openai-personal" };
		context.sessionManager.getSessionFile = () => {
			context.model = undefined;
			return null;
		};

		const launch = await executor.execute(
			"workflow-parent-model",
			{ workflowScript: `await runs.run("inherited", { agent: "worker", task: "Do inherited work" }); return runs.run("explicit", { agent: "worker", task: "Do explicit work", model: "openai/gpt-5-mini" });`, async: true },
			new AbortController().signal,
			undefined,
			context,
		) as AsyncExecutionResult;
		assert.equal(launch.isError, undefined);
		assert.ok(launch.details.asyncId);

		const payload = await readAsyncPayload(launch.details.asyncId);
		assert.equal(payload.success, true);
		const inheritedArgs = readMockPiArgsMatching(mockPi, "Do inherited work");
		const explicitArgs = readMockPiArgsMatching(mockPi, "Do explicit work");
		assert.equal(inheritedArgs[inheritedArgs.indexOf("--model") + 1], "router/openai-personal");
		assert.equal(explicitArgs[explicitArgs.indexOf("--model") + 1], "openai/gpt-5-mini");
	});

	it("background single runs inherit the parent session model when no model is set", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ output: "Done asynchronously" });

		const id = `async-single-parent-model-${Date.now().toString(36)}`;
		executeAsyncSingle(id, {
			agent: "worker",
			task: "Do work",
			agentConfig: makeAgent("worker"),
			ctx: {
				pi: { events: { emit() {} } },
				cwd: tempDir,
				currentSessionId: "session-1",
				currentModelProvider: "deepseek",
				currentModel: { provider: "deepseek", id: "deepseek-v4-flash" },
			},
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
		});

		const resultPath = await waitForAsyncResultFile(id, 10_000);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		assert.equal(payload.success, true);
		assert.equal(payload.results[0].model, "deepseek/deepseek-v4-flash");
		assert.deepEqual(payload.results[0].attemptedModels, ["deepseek/deepseek-v4-flash"]);
		const args = readMockPiArgs(mockPi, 0);
		assert.equal(args[args.indexOf("--model") + 1], "deepseek/deepseek-v4-flash");
	});

	it("background forked runs inherit a parent model outside the registry", { skip: !isAsyncAvailable() || !createSubagentExecutor ? "jiti or executor not available" : undefined }, async () => {
		mockPi.onCall({ output: "Forked async work" });
		const parentSessionFile = path.join(tempDir, "parent.jsonl");
		const forkedSessionFile = path.join(tempDir, "forked.jsonl");
		const sessionHeader = JSON.stringify({ type: "session", cwd: fs.realpathSync(tempDir) });
		fs.writeFileSync(parentSessionFile, `${sessionHeader}\n`, "utf-8");
		fs.writeFileSync(forkedSessionFile, `${sessionHeader}\n`, "utf-8");
		const ctx = {
			...makeMinimalCtx(tempDir),
			model: { provider: "gateway", id: "parent-model" },
			modelRegistry: { getAvailable: () => [{ provider: "openai", id: "gpt-5-mini" }] },
			sessionManager: {
				getSessionId: () => "session-123",
				getSessionFile: () => parentSessionFile,
				getLeafId: () => "leaf-current",
				openSession: () => ({ createBranchedSession: () => forkedSessionFile }),
			},
		};
		const launch = await makeAsyncExecutor([makeAgent("worker")]).execute(
			"forked-parent-model",
			{ agent: "worker", task: "Do work", async: true, context: "fork" },
			new AbortController().signal,
			undefined,
			ctx,
		) as AsyncExecutionResult;
		assert.ok(!launch.isError, launch.content[0]?.text);
		assert.ok(launch.details.asyncId);
		const payload = await readAsyncPayload(launch.details.asyncId);
		assert.equal(payload.results[0]?.model, "gateway/parent-model");
	});

	it("revives an inherited parent model outside the current registry", { skip: !isAsyncAvailable() || !createSubagentExecutor ? "jiti or executor not available" : undefined }, async () => {
		mockPi.onCall({ output: "Initial async work" });
		const sourceId = `async-revive-parent-model-${Date.now().toString(36)}`;
		const sessionFile = path.join(tempDir, "sessions", "source.jsonl");
		fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
		fs.writeFileSync(sessionFile, "", "utf-8");
		executeAsyncSingle(sourceId, {
			agent: "worker",
			task: "Initial work",
			agentConfig: makeAgent("worker"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-123" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			sessionFile,
			modelOverride: "gateway/parent-model",
			modelOverrideFromParent: true,
			maxSubagentDepth: 2,
		});
		await readAsyncPayload(sourceId);
		const descriptor = JSON.parse(fs.readFileSync(path.join(ASYNC_DIR, sourceId, "recovery-descriptor.json"), "utf-8"));
		assert.equal(descriptor.modelOverrideFromParent, true);

		mockPi.onCall({ output: "Revived async work" });
		const result = await makeAsyncExecutor([makeAgent("worker")]).execute(
			"revive-parent-model",
			{ action: "resume", id: sourceId, message: "Continue" },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		) as AsyncExecutionResult;
		assert.ok(!result.isError, result.content[0]?.text);
		assert.ok(result.details.asyncId);
		const payload = await readAsyncPayload(result.details.asyncId);
		assert.equal(payload.results[0]?.model, "gateway/parent-model");
	});

	it("reports the retained discovery context when a resumed target agent is missing", { skip: !createSubagentExecutor ? "executor not available" : undefined }, async () => {
		const runId = `resume-missing-agent-${Date.now().toString(36)}`;
		const asyncDir = path.join(ASYNC_DIR, runId);
		const sessionFile = path.join(tempDir, "missing-agent-session.jsonl");
		const visible = makeAgent("visible");
		visible.source = "project";
		const evidenceDir = path.join(tempDir, "request-discovery", "agents");
		try {
			fs.mkdirSync(asyncDir, { recursive: true });
			fs.writeFileSync(sessionFile, "", "utf-8");
			fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
				runId,
				sessionId: "session-123",
				mode: "single",
				state: "complete",
				startedAt: 100,
				lastUpdate: 200,
				cwd: tempDir,
				sessionFile,
				steps: [{ agent: "vanished", status: "complete" }],
			}, null, 2), "utf-8");
			const executor = makeAsyncExecutor([visible], {}, (cwd) => ({
				agents: [visible],
				cwd: path.resolve(cwd),
				scope: "both",
				directories: [{ source: "project", path: evidenceDir, state: "empty" }],
			}));
			const result = await executor.execute(
				"resume-missing-agent",
				{ action: "resume", id: runId, message: "Continue" },
				new AbortController().signal,
				undefined,
				makeMinimalCtx(tempDir),
			) as AsyncExecutionResult;
			assert.equal(result.isError, true);
			assert.match(result.content[0]?.text ?? "", /^Unknown agent for resume: vanished\nEffective cwd: /);
			assert.match(result.content[0]?.text ?? "", new RegExp(evidenceDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
			assert.match(result.content[0]?.text ?? "", /visible \(project\)/);
		} finally {
			fs.rmSync(asyncDir, { recursive: true, force: true });
		}
	});

	it("uses the append request discovery context for a missing appended agent", { skip: !createSubagentExecutor ? "executor not available" : undefined }, async () => {
		const runId = `append-missing-agent-${Date.now().toString(36)}`;
		const asyncDir = path.join(ASYNC_DIR, runId);
		const visible = makeAgent("visible");
		visible.source = "project";
		const evidenceDir = path.join(tempDir, "append-request", "agents");
		const storedCwd = path.join(tempDir, "stored-run-cwd");
		try {
			fs.mkdirSync(asyncDir, { recursive: true });
			fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
				runId,
				sessionId: "session-123",
				mode: "chain",
				state: "running",
				startedAt: 100,
				lastUpdate: 200,
				cwd: storedCwd,
				steps: [{ agent: "visible", status: "running" }],
			}, null, 2), "utf-8");
			const executor = makeAsyncExecutor([visible], {}, (cwd) => ({
				agents: [visible],
				cwd: path.resolve(cwd),
				scope: "both",
				directories: [{ source: "project", path: evidenceDir, state: "empty" }],
			}));
			const result = await executor.execute(
				"append-missing-agent",
				{ action: "append-step", id: runId, step: { agent: "vanished", task: "Review" } },
				new AbortController().signal,
				undefined,
				makeMinimalCtx(tempDir),
			) as AsyncExecutionResult;
			assert.equal(result.isError, true);
			assert.match(result.content[0]?.text ?? "", /^Unknown agent: vanished\nEffective cwd: /);
			assert.match(result.content[0]?.text ?? "", new RegExp(evidenceDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
			assert.match(result.content[0]?.text ?? "", /visible \(project\)/);
			assert.doesNotMatch(result.content[0]?.text ?? "", new RegExp(storedCwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
		} finally {
			fs.rmSync(asyncDir, { recursive: true, force: true });
		}
	});

	it("background chains inherit the parent session model when no step or agent model is set", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ output: "Done asynchronously" });

		const id = `async-chain-parent-model-${Date.now().toString(36)}`;
		executeAsyncChain(id, {
			chain: [{ agent: "worker", task: "Do work" }],
			agents: [makeAgent("worker")],
			ctx: {
				pi: { events: { emit() {} } },
				cwd: tempDir,
				currentSessionId: "session-1",
				currentModelProvider: "deepseek",
				currentModel: { provider: "deepseek", id: "deepseek-v4-flash" },
			},
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
		});

		const resultPath = await waitForAsyncResultFile(id, 10_000);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		assert.equal(payload.success, true);
		assert.equal(payload.results[0].model, "deepseek/deepseek-v4-flash");
		assert.deepEqual(payload.results[0].attemptedModels, ["deepseek/deepseek-v4-flash"]);
		const args = readMockPiArgs(mockPi, 0);
		assert.equal(args[args.indexOf("--model") + 1], "deepseek/deepseek-v4-flash");
	});

	it("background chains treat empty step models as parent inheritance", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ output: "Done asynchronously" });

		const id = `async-chain-empty-model-${Date.now().toString(36)}`;
		executeAsyncChain(id, {
			chain: [{ agent: "worker", task: "Do work", model: "" }],
			agents: [makeAgent("worker", { model: "anthropic/claude-sonnet-4-5", thinking: "high" })],
			ctx: {
				pi: { events: { emit() {} } },
				cwd: tempDir,
				currentSessionId: "session-1",
				currentModelProvider: "openai",
				currentModel: { provider: "openai", id: "gpt-5-mini" },
			},
			availableModels: [
				{ provider: "anthropic", id: "claude-sonnet-4-5", fullId: "anthropic/claude-sonnet-4-5", api: "anthropic-messages" },
				{ provider: "openai", id: "gpt-5-mini", fullId: "openai/gpt-5-mini", api: "openai-responses" },
			],
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
		});

		const resultPath = await waitForAsyncResultFile(id, 10_000);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		assert.equal(payload.success, true);
		assert.equal(payload.results[0].model, "openai/gpt-5-mini:high");
		assert.deepEqual(payload.results[0].attemptedModels, ["openai/gpt-5-mini:high"]);
		const args = readMockPiArgs(mockPi, 0);
		assert.equal(args[args.indexOf("--model") + 1], "openai/gpt-5-mini:high");
	});

	it("background chains keep agent fallback models inherited for scope warnings", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ output: "Done asynchronously" });
		const warnings: string[] = [];
		const originalWarn = console.warn;
		console.warn = (message?: unknown) => warnings.push(String(message));
		try {
			for (const [index, requestedModel] of [undefined, "", "inherit"].entries()) {
				const id = `async-chain-no-parent-${index}-${Date.now().toString(36)}`;
				executeAsyncChain(id, {
					chain: [{ agent: "worker", task: "Do work", ...(requestedModel !== undefined ? { model: requestedModel } : {}) }],
					agents: [makeAgent("worker", { model: "openai/gpt-5-mini", thinking: "high" })],
					ctx: {
						pi: { events: { emit() {} } },
						cwd: tempDir,
						currentSessionId: "session-1",
						modelScope: { enforce: true, allow: ["anthropic/*"] },
					},
					availableModels: [
						{ provider: "openai", id: "gpt-5-mini", fullId: "openai/gpt-5-mini", api: "openai-responses" },
					],
					artifactConfig: {
						enabled: false,
						includeInput: false,
						includeOutput: false,
						includeJsonl: false,
						includeMetadata: false,
						cleanupDays: 7,
					},
					shareEnabled: false,
					sessionRoot: path.join(tempDir, "sessions"),
					maxSubagentDepth: 2,
				});

				const resultPath = await waitForAsyncResultFile(id, 10_000);
				const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
				assert.equal(payload.success, true);
				assert.equal(payload.results[0].model, "openai/gpt-5-mini:high");
				assert.deepEqual(payload.results[0].attemptedModels, ["openai/gpt-5-mini:high"]);
				const args = readMockPiArgs(mockPi, index);
				assert.equal(args[args.indexOf("--model") + 1], "openai/gpt-5-mini:high");
			}
			assert.equal(warnings.length, 3);
			assert.equal(warnings.every((warning) => warning.includes("outside the configured subagent model scope")), true);
		} finally {
			console.warn = originalWarn;
		}
	});

	it("background runs resolve skills from the effective task cwd", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ output: "Done asynchronously" });
		const taskCwd = createTempDir("pi-subagent-async-task-cwd-");
		const id = `async-skill-cwd-${Date.now().toString(36)}`;
		const asyncDir = path.join(ASYNC_DIR, id);
		const resultPath = path.join(RESULTS_DIR, `${id}.json`);
		const statusPath = path.join(asyncDir, "status.json");

		try {
			writePackageSkill(taskCwd, "async-task-cwd-skill");
			executeAsyncSingle(id, {
				agent: "worker",
				task: "Do work",
				agentConfig: makeAgent("worker", { skills: ["async-task-cwd-skill"] }),
				ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
				cwd: taskCwd,
				artifactConfig: {
					enabled: false,
					includeInput: false,
					includeOutput: false,
					includeJsonl: false,
					includeMetadata: false,
					cleanupDays: 7,
				},
				shareEnabled: false,
				sessionRoot: path.join(tempDir, "sessions"),
				maxSubagentDepth: 2,
			});

			const deadline = Date.now() + 10_000;
			while (!fs.existsSync(resultPath)) {
				if (Date.now() > deadline) {
					assert.fail(`Timed out waiting for async result file: ${resultPath}`);
				}
				await new Promise((resolve) => setTimeout(resolve, 100));
			}

			const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
			const status = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatusPayload;
			assert.equal(payload.success, true);
			assert.deepEqual(status.steps?.[0]?.skills, ["async-task-cwd-skill"]);
		} finally {
			removeTempDir(taskCwd);
		}
	});

	it("injects agent-file-relative local skills into background single child prompts", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ output: "Done asynchronously" });
		const id = `async-local-skill-${Date.now().toString(36)}`;
		const agentFile = path.join(tempDir, "agents", "worker", "worker.md");
		const skillFile = path.join(path.dirname(agentFile), "skills", "local", "SKILL.md");
		fs.mkdirSync(path.dirname(skillFile), { recursive: true });
		fs.writeFileSync(skillFile, "---\ndescription: async local skill\n---\nLocal skill body\n", "utf-8");

		executeAsyncSingle(id, {
			agent: "worker",
			task: "Do work",
			agentConfig: makeAgent("worker", { filePath: agentFile, skills: ["local"], skillPath: ["./skills"] }),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			maxSubagentDepth: 2,
		});

		await waitForAsyncResultFile(id);
		const call = await waitForMockPiCall(mockPi, 0);
		assert.match(call.systemPrompts.map((record) => record.text ?? "").join("\n"), /async local skill/);
	});

	it("isolates agent-local skills between background parallel chain children", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ output: "one" });
		mockPi.onCall({ output: "two" });
		const id = `async-parallel-local-skills-${Date.now().toString(36)}`;
		const agents = ["one", "two"].map((name) => {
			const agentFile = path.join(tempDir, "agents", name, `${name}.md`);
			const skillFile = path.join(path.dirname(agentFile), "skills", "local", "SKILL.md");
			fs.mkdirSync(path.dirname(skillFile), { recursive: true });
			fs.writeFileSync(skillFile, `---\ndescription: ${name} async local skill\n---\nbody\n`, "utf-8");
			return makeAgent(name, { filePath: agentFile, skills: ["local"], skillPath: ["./skills"] });
		});

		executeAsyncChain(id, {
			chain: [{ parallel: [{ agent: "one", task: "One" }, { agent: "two", task: "Two" }], concurrency: 2 }],
			resultMode: "parallel",
			agents,
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			maxSubagentDepth: 2,
		});

		await waitForAsyncResultFile(id);
		const prompts = await Promise.all([0, 1].map(async (index) => {
			const call = await waitForMockPiCall(mockPi, index);
			return call.systemPrompts.map((record) => record.text ?? "").join("\n");
		}));
		assert.equal(prompts.filter((prompt) => /one async local skill/.test(prompt) && !/two async local skill/.test(prompt)).length, 1);
		assert.equal(prompts.filter((prompt) => /two async local skill/.test(prompt) && !/one async local skill/.test(prompt)).length, 1);
	});

	it("background single runs report unavailable pi-subagents skill requests", () => {
		const id = `async-pi-subagents-skill-${Date.now().toString(36)}`;
		const result = executeAsyncSingle(id, {
			agent: "worker",
			task: "Do work",
			agentConfig: makeAgent("worker"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			cwd: tempDir,
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			skills: ["pi-subagents"],
			maxSubagentDepth: 2,
		});

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /Skills not found: pi-subagents/);
	});

	it("background chains report unavailable pi-subagents skill requests", () => {
		const id = `async-chain-pi-subagents-skill-${Date.now().toString(36)}`;
		const result = executeAsyncChain(id, {
			chain: [{ agent: "worker", task: "Do work", skill: ["pi-subagents"] }],
			agents: [makeAgent("worker")],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			cwd: tempDir,
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
		});

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /Skills not found: pi-subagents/);
	});

	it("background chains resolve relative step cwd values against the shared cwd", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ output: "Done asynchronously" });
		const chainCwd = createTempDir("pi-subagent-async-chain-cwd-");
		const id = `async-chain-skill-cwd-${Date.now().toString(36)}`;
		const asyncDir = path.join(ASYNC_DIR, id);
		const resultPath = path.join(RESULTS_DIR, `${id}.json`);
		const statusPath = path.join(asyncDir, "status.json");

		try {
			writePackageSkill(path.join(chainCwd, "packages", "app"), "async-chain-step-skill");
			executeAsyncChain(id, {
				chain: [{ agent: "worker", task: "Do work", cwd: "packages/app", skill: ["async-chain-step-skill"] }],
				agents: [makeAgent("worker")],
				ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
				cwd: chainCwd,
				artifactConfig: {
					enabled: false,
					includeInput: false,
					includeOutput: false,
					includeJsonl: false,
					includeMetadata: false,
					cleanupDays: 7,
				},
				shareEnabled: false,
				sessionRoot: path.join(tempDir, "sessions"),
				maxSubagentDepth: 2,
			});

			const deadline = Date.now() + 10_000;
			while (!fs.existsSync(resultPath)) {
				if (Date.now() > deadline) {
					assert.fail(`Timed out waiting for async result file: ${resultPath}`);
				}
				await new Promise((resolve) => setTimeout(resolve, 100));
			}

			const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
			const status = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatusPayload;
			assert.equal(payload.success, true);
			assert.equal(payload.sessionId, "session-1");
			assert.equal(status.sessionId, "session-1");
			assert.deepEqual(status.steps?.[0]?.skills, ["async-chain-step-skill"]);
		} finally {
			removeTempDir(chainCwd);
		}
	});

	it("keeps top-level current tool/path aligned with still-running parallel children", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({
			steps: [
				{ jsonl: [events.toolStart("read", { path: "README.md" })] },
				{ delay: 900, jsonl: [events.toolEnd("read"), events.toolResult("read", "done"), events.assistantMessage("reader done")] },
			],
		});
		mockPi.onCall({
			steps: [
				{ delay: 100, jsonl: [events.toolStart("edit", { path: "docs.md" })] },
				{ delay: 100, jsonl: [events.toolEnd("edit"), events.toolResult("edit", "ok")] },
				{ delay: 700, jsonl: [events.assistantMessage("editor done")] },
			],
		});

		const id = `async-parallel-tool-sync-${Date.now().toString(36)}`;
		const asyncDir = path.join(ASYNC_DIR, id);
		const resultPath = path.join(RESULTS_DIR, `${id}.json`);

		executeAsyncChain(id, {
			chain: [{ parallel: [{ agent: "reader", task: "Read" }, { agent: "editor", task: "Edit" }] }],
			agents: [makeAgent("reader"), makeAgent("editor")],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
		});

		const statusPath = path.join(asyncDir, "status.json");
		const doneDeadline = Date.now() + 10_000;
		let sawRunningTool = false;
		let invariantViolated = false;
		while (!fs.existsSync(resultPath) && Date.now() < doneDeadline) {
			if (fs.existsSync(statusPath)) {
				const status = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatusPayload;
				const runningTools = (status.steps ?? [])
					.filter((step) => step.status === "running" && typeof step.currentTool === "string")
					.map((step) => step.currentTool as string);
				if (runningTools.length > 0) {
					sawRunningTool = true;
					if (!status.currentTool || !runningTools.includes(status.currentTool)) {
						invariantViolated = true;
						break;
					}
				}
			}
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		if (!fs.existsSync(resultPath)) {
			assert.fail(`Timed out waiting for async result file: ${resultPath}`);
		}
		assert.equal(sawRunningTool, true, "expected at least one polling interval with a running step tool");
		assert.equal(invariantViolated, false, "top-level currentTool drifted from running step tools");
	});

	it("returns a tool error when the detached runner config cannot be written", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, () => {
		const id = `async-write-fail-${Date.now().toString(36)}`;
		assert.ok(TEMP_ROOT_DIR, "TEMP_ROOT_DIR should be available for async tests");
		fs.mkdirSync(TEMP_ROOT_DIR, { recursive: true });
		fs.mkdirSync(path.join(TEMP_ROOT_DIR, `async-cfg-${id}.json`), { recursive: true });

		const result = executeAsyncSingle(id, {
			agent: "worker",
			task: "Do work",
			agentConfig: makeAgent("worker"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
		});

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /Failed to start async run/);
		assert.match(result.content[0]?.text ?? "", /async-cfg-/);
	});

	it("does not start child work when initial async status cannot be written", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		const id = `async-status-write-fail-${Date.now().toString(36)}`;
		fs.mkdirSync(path.join(ASYNC_DIR, id, "status.json"), { recursive: true });
		mockPi.onCall({ output: "must not run" });

		const result = executeAsyncSingle(id, {
			agent: "worker",
			task: "Do not start",
			agentConfig: makeAgent("worker"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
		});

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /Failed to persist initial async status/);
		await new Promise((resolve) => setTimeout(resolve, 300));
		assert.equal(mockPi.callCount(), 0);
	});

	it("returns a tool error when an async run uses a missing cwd", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, () => {
		const id = `async-missing-cwd-${Date.now().toString(36)}`;
		const missingCwd = path.join(tempDir, "missing-cwd");

		const singleResult = executeAsyncSingle(id, {
			agent: "worker",
			task: "Do work",
			agentConfig: makeAgent("worker"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			cwd: missingCwd,
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
		});

		assert.equal(singleResult.isError, true);
		assert.match(singleResult.content[0]?.text ?? "", /Failed to start async run/);
		assert.match(singleResult.content[0]?.text ?? "", /cwd does not exist/);

		const chainId = `async-missing-cwd-chain-${Date.now().toString(36)}`;
		const chainResult = executeAsyncChain(chainId, {
			chain: [{ agent: "worker", task: "Do work" }],
			agents: [makeAgent("worker")],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			cwd: missingCwd,
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
		});

		assert.equal(chainResult.isError, true);
		assert.match(chainResult.content[0]?.text ?? "", /Failed to start async chain/);
		assert.match(chainResult.content[0]?.text ?? "", /cwd does not exist/);
	});

	it("returns a tool error when the async runner process cannot spawn", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, () => {
		const originalExecPath = process.execPath;
		const pathKey = process.platform === "win32" ? "Path" : "PATH";
		const originalPath = process.env[pathKey];
		process.execPath = path.join(tempDir, process.platform === "win32" ? "pi.exe" : "pi");
		process.env[pathKey] = tempDir;
		try {
			const id = `async-spawn-fail-${Date.now().toString(36)}`;
			const result = executeAsyncSingle(id, {
				agent: "worker",
				task: "Do work",
				agentConfig: makeAgent("worker"),
				ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
				artifactConfig: {
					enabled: false,
					includeInput: false,
					includeOutput: false,
					includeJsonl: false,
					includeMetadata: false,
					cleanupDays: 7,
				},
				shareEnabled: false,
				sessionRoot: path.join(tempDir, "sessions"),
				maxSubagentDepth: 2,
			});

			assert.equal(result.isError, true);
			assert.match(result.content[0]?.text ?? "", /Failed to start async run/);
			assert.match(result.content[0]?.text ?? "", /async runner did not produce a pid/);
		} finally {
			process.execPath = originalExecPath;
			if (originalPath === undefined) {
				delete process.env[pathKey];
			} else {
				process.env[pathKey] = originalPath;
			}
		}
	});

	it("returns a tool error when an async chain cannot write its detached runner config", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, () => {
		const id = `async-chain-write-fail-${Date.now().toString(36)}`;
		assert.ok(TEMP_ROOT_DIR, "TEMP_ROOT_DIR should be available for async tests");
		fs.mkdirSync(TEMP_ROOT_DIR, { recursive: true });
		fs.mkdirSync(path.join(TEMP_ROOT_DIR, `async-cfg-${id}.json`), { recursive: true });

		const result = executeAsyncChain(id, {
			chain: [{ agent: "worker", task: "Do work" }],
			agents: [makeAgent("worker")],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
		});

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /Failed to start async chain/);
		assert.match(result.content[0]?.text ?? "", /async-cfg-/);
	});

	it("background ignores child watchdog status when child watchdogs are not configured", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		await withIsolatedWatchdogSettings(tempDir, async () => {
			const id = `async-watchdog-unconfigured-${Date.now().toString(36)}`;
			mockPi.onCall({
				jsonl: [events.assistantMessage("async-done-without-watchdog-config"), childWatchdogStatus(id, "reviewing", 1)],
				keepAliveAfterFinalMessageMs: 10000,
			});

			const start = Date.now();
			executeAsyncSingle(id, {
				agent: "worker",
				task: "Do work",
				agentConfig: makeAgent("worker"),
				ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
				artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
				shareEnabled: false,
				sessionRoot: path.join(tempDir, "sessions"),
				maxSubagentDepth: 2,
			});

			const resultPath = await waitForAsyncResultFile(id, 10_000);
			const elapsed = Date.now() - start;
			const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
			assert.ok(elapsed < 6000, `unconfigured watchdog status should not delay async final drain, took ${elapsed}ms`);
			assert.equal(payload.success, true);
			assert.equal(payload.results[0]?.output, "async-done-without-watchdog-config");
			assert.equal((payload.results[0] as { watchdog?: unknown }).watchdog, undefined);
		});
	});

	it("background final-drain waits for child watchdog settlement", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		await withIsolatedWatchdogSettings(tempDir, async () => {
			writeWatchdogSettings(tempDir);
			const id = `async-watchdog-drain-${Date.now().toString(36)}`;
			mockPi.onCall({
				steps: [
					{ jsonl: [events.assistantMessage("async-done-before-watchdog"), childWatchdogStatus(id, "reviewing", 1)] },
					{ delay: 1400, jsonl: [childWatchdogStatus(id, "idle", 2)] },
				],
				keepAliveAfterFinalMessageMs: 10000,
			});

			const start = Date.now();
			executeAsyncSingle(id, {
				agent: "worker",
				task: "Do work",
				agentConfig: makeAgent("worker"),
				ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
				artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
				shareEnabled: false,
				sessionRoot: path.join(tempDir, "sessions"),
				maxSubagentDepth: 2,
			});

			const resultPath = await waitForAsyncResultFile(id, 10_000);
			const elapsed = Date.now() - start;
			const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
			assert.ok(elapsed >= 1200, `watchdog settlement should delay async final drain, took ${elapsed}ms`);
			assert.ok(elapsed < 9000, `settled watchdog should still allow async cleanup, took ${elapsed}ms`);
			assert.equal(payload.success, true);
			assert.equal(payload.results[0]?.output, "async-done-before-watchdog");
			assert.equal((payload.results[0] as { watchdog?: { phase?: string } }).watchdog?.phase, "idle");
		});
	});

	it("background child watchdog tail timeout still finalizes successful output", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		await withIsolatedWatchdogSettings(tempDir, async () => {
			writeWatchdogSettings(tempDir, 150);
			const id = `async-watchdog-timeout-${Date.now().toString(36)}`;
			mockPi.onCall({
				jsonl: [events.assistantMessage("async-done-before-watchdog-timeout"), childWatchdogStatus(id, "reviewing", 1)],
				keepAliveAfterFinalMessageMs: 10000,
			});

			const start = Date.now();
			executeAsyncSingle(id, {
				agent: "worker",
				task: "Do work",
				agentConfig: makeAgent("worker"),
				ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
				artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
				shareEnabled: false,
				sessionRoot: path.join(tempDir, "sessions"),
				maxSubagentDepth: 2,
			});

			const resultPath = await waitForAsyncResultFile(id, 10_000);
			const elapsed = Date.now() - start;
			const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
			assert.ok(elapsed < 6000, `watchdog tail fallback should not hang async final drain, took ${elapsed}ms`);
			assert.equal(payload.success, true);
			assert.equal(payload.results[0]?.output, "async-done-before-watchdog-timeout");
			const watchdog = (payload.results[0] as { watchdog?: { phase?: string; timedOut?: boolean } }).watchdog;
			assert.equal(watchdog?.phase, "stale");
			assert.equal(watchdog?.timedOut, true);
		});
	});

	it("background forced drain after final assistant output is cleanup success", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({
			jsonl: [events.assistantMessage("async-done-before-drain")],
			stderr: "Done after 1 turn(s). Ready for input.\n",
			keepAliveAfterFinalMessageMs: 10000,
		});

		const id = `async-final-drain-${Date.now().toString(36)}`;
		const resultPath = path.join(RESULTS_DIR, `${id}.json`);
		const sessionRoot = path.join(tempDir, "sessions");

		const start = Date.now();
		executeAsyncSingle(id, {
			agent: "worker",
			task: "Do work",
			agentConfig: makeAgent("worker"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot,
			maxSubagentDepth: 2,
		});

		const deadline = Date.now() + 10_000;
		while (!fs.existsSync(resultPath)) {
			if (Date.now() > deadline) {
				assert.fail(`Timed out waiting for async result file: ${resultPath}`);
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
		}

		const elapsed = Date.now() - start;
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
		assert.ok(elapsed < 9000, `should clean up async child before the mock's natural keepalive exit, took ${elapsed}ms`);
		assert.equal(payload.success, true);
		assert.equal(payload.exitCode, 0);
		assert.equal(payload.results[0].success, true);
		assert.equal(payload.results[0].output, "async-done-before-drain");
	});

	it("background forced drain after empty terminal assistant output is cleanup success", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({
			jsonl: [events.assistantMessage("")],
			keepAliveAfterFinalMessageMs: 10000,
		});

		const id = `async-final-drain-empty-${Date.now().toString(36)}`;
		const resultPath = path.join(RESULTS_DIR, `${id}.json`);

		const start = Date.now();
		executeAsyncSingle(id, {
			agent: "scout",
			task: "Inspect something",
			agentConfig: makeAgent("scout"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
		});

		const deadline = Date.now() + 10_000;
		while (!fs.existsSync(resultPath)) {
			if (Date.now() > deadline) assert.fail(`Timed out waiting for async result file: ${resultPath}`);
			await new Promise((resolve) => setTimeout(resolve, 100));
		}

		const elapsed = Date.now() - start;
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
		assert.ok(elapsed < 9000, `should clean up async child before the mock's natural keepalive exit, took ${elapsed}ms`);
		assert.equal(payload.success, true);
		assert.equal(payload.exitCode, 0);
		assert.equal(payload.results[0].success, true);
		assert.equal(payload.results[0].output, "");
	});

	it("background final-drain cleanup preserves explicit assistant errors", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
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

		const id = `async-final-drain-error-${Date.now().toString(36)}`;
		const resultPath = path.join(RESULTS_DIR, `${id}.json`);

		executeAsyncSingle(id, {
			agent: "worker",
			task: "Do work",
			agentConfig: makeAgent("worker"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
		});

		const deadline = Date.now() + 10_000;
		while (!fs.existsSync(resultPath)) {
			if (Date.now() > deadline) assert.fail(`Timed out waiting for async result file: ${resultPath}`);
			await new Promise((resolve) => setTimeout(resolve, 100));
		}

		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
		assert.equal(payload.success, false);
		assert.equal(payload.exitCode, 1);
		assert.equal(payload.results[0].success, false);
		assert.equal(payload.results[0].error, "provider exploded");
	});

	it("prioritizes a missing file-only handoff over the completion guard", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		const partialOutput = "I’ll inspect the retained candidate before changing it.";
		const repo = createRepo("pi-subagents-missing-handoff-partial-");
		const outputPath = path.join(repo, "missing-challenge-report.md");
		mockPi.onCall({
			jsonl: [
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
			writeFiles: [{ path: "input.md", content: "changed by retained child\n" }],
		});

		const task = [
			"You are reviving a previous subagent conversation.",
			"",
			"Original run: source-run",
			"Original agent: worker",
			"Original session file: /tmp/source-session.jsonl",
			"",
			"Use the stored session context as background. Answer the orchestrator's follow-up below. Do not assume the original child process is still alive.",
			"",
			"Follow-up:",
			"Implementation challenge pass 1 for the accepted candidate. Reconsider it and implement any better current-scope change.",
		].join("\n");
		const id = `async-missing-handoff-guard-${Date.now().toString(36)}`;
		try {
			executeAsyncSingle(id, {
				agent: "worker",
				task,
				agentConfig: makeAgent("worker"),
				ctx: { pi: { events: { emit() {} } }, cwd: repo, currentSessionId: "session-1" },
				artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
				shareEnabled: false,
				sessionRoot: path.join(tempDir, "sessions"),
				output: outputPath,
				outputMode: "file-only",
				maxSubagentDepth: 2,
			});

			const resultPath = await waitForAsyncResultFile(id);
			const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
			const child = payload.results[0];
			const diagnostic = child?.error ?? "";
			assert.equal(payload.success, false);
			assert.equal(payload.state, "partial");
			assert.equal(child?.success, false);
			assert.match(diagnostic, new RegExp(`^Required file-only output was not produced: ${escapeRegExp(outputPath)}$`));
			assert.doesNotMatch(diagnostic, /completed without making edits/);
			assert.doesNotMatch(child?.modelAttempts?.[0]?.error ?? "", /completed without making edits/);
			assert.equal(child?.effects?.fileMutation?.status, "observed");
			assert.equal(child?.effects?.fileMutation?.attempted, true);
			assert.deepEqual(child?.effects?.fileMutation?.evidence?.changedFiles, ["input.md"]);
			assert.equal(child?.effects?.settlementDiagnostic?.requiredOutput?.missing, true);
			assert.equal(fs.existsSync(outputPath), false);

			const status = await waitForAsyncState(id, (candidate) => candidate.state === "partial");
			assert.equal(status.activityState, "needs_attention");
			assert.equal(status.steps?.[0]?.activityState, "needs_attention");
			assert.equal(status.steps?.[0]?.error, diagnostic);
			const eventsText = fs.readFileSync(path.join(ASYNC_DIR, id, "events.jsonl"), "utf-8");
			assert.doesNotMatch(eventsText, /completed without making edits/);
		} finally {
			removeTempDir(repo);
		}
	});

	it("preserves terminal empty-output diagnostics after useful child work", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		const partialOutput = "I’ll inspect the retained candidate before changing it.";
		const outputPath = path.join(tempDir, "missing-aborted-report.md");
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

		const id = `async-aborted-empty-handoff-${Date.now().toString(36)}`;
		executeAsyncSingle(id, {
			agent: "worker",
			task: "Implement the approved file changes",
			agentConfig: makeAgent("worker"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			output: outputPath,
			outputMode: "file-only",
			maxSubagentDepth: 2,
		});

		const resultPath = await waitForAsyncResultFile(id);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		const child = payload.results[0];
		const diagnostic = child?.error ?? "";
		assert.equal(payload.success, false);
		assert.equal(child?.success, false);
		assert.match(diagnostic, /^Subagent produced no output \(possible model cold-start or empty response\)\./);
		assert.match(diagnostic, /Required file-only output was not produced/);
		assert.doesNotMatch(diagnostic, /completed without making edits/);
		assert.doesNotMatch(child?.modelAttempts?.[0]?.error ?? "", /completed without making edits/);
		assert.equal(child?.effects?.settlementDiagnostic?.requiredOutput?.missing, true);
		assert.equal(child?.effects?.settlementDiagnostic?.finalTextPresent, true);
		assert.equal(fs.existsSync(outputPath), false);

		const eventsText = fs.readFileSync(path.join(ASYNC_DIR, id, "events.jsonl"), "utf-8");
		assert.doesNotMatch(eventsText, /completed without making edits/);
	});

	it("reports bounded compaction failure context when file-only output is missing", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		const terminalError = `This operation was aborted${"x".repeat(12_000)}`;
		mockPi.onCall({
			jsonl: [
				{ type: "compaction_start" },
				{
					type: "message_end",
					message: {
						role: "assistant",
						content: [],
						model: "mock/test-model",
						stopReason: "error",
						errorMessage: terminalError,
						usage: { input: 100, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } },
					},
				},
				{ type: "agent_settled" },
			],
			exitCode: 0,
		});

		const id = `async-compaction-file-only-error-${Date.now().toString(36)}`;
		const asyncDir = path.join(ASYNC_DIR, id);
		const outputPath = path.join(tempDir, "missing-oracle-report.md");
		executeAsyncSingle(id, {
			agent: "oracle",
			task: "Write a report",
			agentConfig: makeAgent("oracle"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			output: outputPath,
			outputMode: "file-only",
			maxSubagentDepth: 2,
		});

		const resultPath = await waitForAsyncResultFile(id);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		const child = payload.results[0] as (AsyncResultPayload["results"][number] & Record<string, unknown>) | undefined;
		const diagnostic = child?.error ?? "";
		assert.equal(payload.success, false);
		assert.equal(child?.success, false);
		assert.match(diagnostic, /^This operation was aborted/);
		assert.match(diagnostic, /failure followed session compaction and agent settlement/);
		assert.match(diagnostic, /Required file-only output was not produced/);
		assert.ok(diagnostic.length <= 8_192);
		assert.equal(fs.existsSync(outputPath), false);
		assert.equal(child?.output, "");
		assert.equal("savedOutputPath" in (child ?? {}), false);
		assert.equal("outputReference" in (child ?? {}), false);
		assert.equal(payload.summary, `oracle:\n${diagnostic}`);
		const status = await waitForAsyncState(id, (candidate) => candidate.state === "failed");
		assert.equal(status.steps?.[0]?.exitCode, 1);
		assert.equal(status.steps?.[0]?.error, diagnostic);
		const logPath = path.join(asyncDir, `subagent-log-${id}.md`);
		const deadline = Date.now() + 10_000;
		while (!fs.existsSync(logPath)) {
			if (Date.now() > deadline) assert.fail(`Timed out waiting for async run log: ${logPath}`);
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		assert.ok(fs.readFileSync(logPath, "utf-8").includes(`## Summary\noracle:\n${diagnostic}`));
	});

	it("preserves partial imported async roots with mutation evidence", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		const sourceId = `partial-source-${Date.now().toString(36)}`;
		const sourceDir = path.join(ASYNC_DIR, sourceId);
		const message = "Required file-only output was not produced: report.md";
		const effects = { fileMutation: { status: "observed", expected: true, attempted: true, evidence: { source: "tracked-files", trackedOnly: true, cwd: tempDir, changedFiles: ["input.md"], attemptedMutation: true } } };
		fs.mkdirSync(sourceDir, { recursive: true });
		fs.writeFileSync(path.join(sourceDir, "status.json"), JSON.stringify({
			runId: sourceId,
			mode: "single",
			state: "partial",
			activityState: "needs_attention",
			startedAt: Date.now(),
			error: message,
			steps: [{ agent: "worker", status: "failed", activityState: "needs_attention", error: message, effects }],
		}), "utf-8");

		const id = `async-imported-partial-${Date.now().toString(36)}`;
		executeAsyncChain(id, {
			chain: [],
			attachRoot: { runId: sourceId, asyncDir: sourceDir, resultPath: path.join(RESULTS_DIR, `${sourceId}.json`), index: 0, agent: "worker" },
			agents: [makeAgent("worker")],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
		});

		const resultPath = await waitForAsyncResultFile(id);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		assert.equal(payload.success, false);
		assert.equal(payload.state, "partial");
		assert.equal(payload.summary, message);
		assert.equal(payload.results[0]?.execution?.status, "partial");
		assert.deepEqual(payload.results[0]?.effects?.fileMutation?.evidence?.changedFiles, ["input.md"]);

		const status = await waitForAsyncState(id, (candidate) => candidate.state === "partial");
		assert.equal(status.activityState, "needs_attention");
		assert.equal(status.steps?.[0]?.activityState, "needs_attention");
	});

	it("keeps concrete sibling failures above partial mutation evidence", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		const repo = createRepo("pi-subagents-partial-sibling-failure-");
		const outputPath = path.join(repo, "missing-report.md");
		mockPi.onCall({
			matchArgIncludes: "Write required report",
			jsonl: [
				events.assistantMessage("I changed the file but did not hand off the report."),
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
			writeFiles: [{ path: "input.md", content: "changed before missing report\n" }],
		});
		mockPi.onCall({ matchArgIncludes: "Fail normally", stderr: "ordinary sibling failure", exitCode: 1 });

		const id = `async-partial-sibling-failure-${Date.now().toString(36)}`;
		try {
			executeAsyncChain(id, {
				chain: [{
					parallel: [
						{ agent: "partial", task: "Write required report" },
						{ agent: "failure", task: "Fail normally" },
					],
					concurrency: 2,
				}],
				resultMode: "parallel",
				agents: [makeAgent("partial", { output: outputPath, outputMode: "file-only" }), makeAgent("failure", { completionGuard: false })],
				ctx: { pi: { events: { emit() {} } }, cwd: repo, currentSessionId: "session-1" },
				artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
				shareEnabled: false,
				maxSubagentDepth: 2,
			});

			const payload = await readAsyncPayload(id);
			assert.equal(payload.success, false);
			assert.equal(payload.state, "failed");
			assert.match(payload.summary, /ordinary sibling failure/);
			assert.equal(payload.results[0]?.effects?.fileMutation?.status, "observed");
			assert.equal(payload.results[0]?.effects?.settlementDiagnostic?.requiredOutput?.missing, true);
			assert.match(payload.results[1]?.error ?? "", /ordinary sibling failure/);

			const status = await waitForAsyncState(id, (candidate) => candidate.state === "failed");
			assert.equal(status.activityState, undefined);
			assert.match(status.error ?? "", /ordinary sibling failure/);
		} finally {
			removeTempDir(repo);
		}
	});

	it("reports missing file-only output when a child exits without an error", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ delay: 2_100, exitCode: 1 });

		const id = `async-file-only-exit-without-error-${Date.now().toString(36)}`;
		const outputPath = path.join(tempDir, "missing-exit-report.md");
		executeAsyncSingle(id, {
			agent: "worker",
			task: "Write a report",
			agentConfig: makeAgent("worker", { completionGuard: false }),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			output: outputPath,
			outputMode: "file-only",
			maxSubagentDepth: 2,
		});

		const payload = await readAsyncPayload(id);
		const child = payload.results[0];
		const diagnostic = child?.error ?? "";
		assert.equal(payload.success, false);
		assert.equal(payload.exitCode, 1);
		assert.equal(child?.success, false);
		assert.match(diagnostic, /^Required file-only output was not produced:/);
		assert.equal(fs.existsSync(outputPath), false);
		assert.equal(child?.output, "");
		assert.equal(child?.effects?.settlementDiagnostic?.requiredOutput?.kind, "file-only");
		assert.equal(child?.effects?.settlementDiagnostic?.requiredOutput?.path, outputPath);
		assert.equal(child?.effects?.settlementDiagnostic?.requiredOutput?.missing, true);
		const status = await waitForAsyncState(id, (candidate) => candidate.state === "failed");
		assert.equal(status.steps?.[0]?.error, diagnostic);
	});

	it("background runs emit active-long-running control events from child turns", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({
			steps: [
				{ jsonl: [events.assistantMessage("still working")] },
				{ delay: 2_000, jsonl: [events.assistantMessage("done")] },
			],
		});

		const id = `async-active-long-${Date.now().toString(36)}`;
		const asyncDir = path.join(ASYNC_DIR, id);
		const eventsPath = path.join(asyncDir, "events.jsonl");
		const resultPath = path.join(RESULTS_DIR, `${id}.json`);

		executeAsyncSingle(id, {
			agent: "scout",
			task: "Investigate behavior",
			agentConfig: makeAgent("scout"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
			controlConfig: {
				enabled: true,
				needsAttentionAfterMs: 999_999,
				activeNoticeAfterTurns: 1,
				activeNoticeAfterMs: 999_999,
				activeNoticeAfterTokens: 999_999,
				failedToolAttemptsBeforeAttention: 3,
				notifyOn: ["active_long_running", "needs_attention"],
				notifyChannels: ["event", "async", "intercom"],
			},
		});

		const statusPath = path.join(asyncDir, "status.json");
		const deadline = Date.now() + 10_000;
		let eventText = "";
		let statusDuringEvent: AsyncStatusPayload | undefined;
		while (Date.now() < deadline) {
			if (fs.existsSync(eventsPath)) {
				eventText = fs.readFileSync(eventsPath, "utf-8");
			}
			if (eventText.includes('"type":"active_long_running"') && fs.existsSync(statusPath)) {
				const status = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatusPayload;
				if (status.activityState === "active_long_running" && status.steps?.[0]?.activityState === "active_long_running") {
					statusDuringEvent = status;
					break;
				}
			}
			if (eventText.includes('"type":"active_long_running"') && fs.existsSync(resultPath)) {
				assert.fail("run completed before status.json exposed active_long_running");
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
		}

		assert.match(eventText, /"type":"active_long_running"/);
		assert.match(eventText, /"reason":"turn_threshold"/);
		assert.ok(statusDuringEvent, "expected status.json to expose active_long_running while the run is still active");
		assert.equal(statusDuringEvent.activityState, "active_long_running");
		assert.equal(statusDuringEvent.steps?.[0]?.activityState, "active_long_running");

		const doneDeadline = Date.now() + 10_000;
		while (!fs.existsSync(resultPath)) {
			if (Date.now() > doneDeadline) assert.fail(`Timed out waiting for async result file: ${resultPath}`);
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
	});

	it("does not flag a delayed active tool as idle attention", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({
			steps: [
				{ jsonl: [events.toolStart("bash", { command: "sleep 2" })] },
				{ delay: 2_500, jsonl: [events.toolEnd("bash"), events.toolResult("bash", "done")] },
				{ jsonl: [events.assistantMessage("Done")] },
			],
		});

		const id = `async-delayed-tool-attention-${Date.now().toString(36)}`;
		const asyncDir = path.join(ASYNC_DIR, id);
		const eventsPath = path.join(asyncDir, "events.jsonl");
		const resultPath = path.join(RESULTS_DIR, `${id}.json`);
		executeAsyncSingle(id, {
			agent: "worker",
			task: "Run the command",
			agentConfig: makeAgent("worker"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
			controlConfig: {
				enabled: true,
				needsAttentionAfterMs: 200,
				activeNoticeAfterMs: 999_999,
				failedToolAttemptsBeforeAttention: 3,
				notifyOn: ["active_long_running", "needs_attention"],
				notifyChannels: ["event", "async", "intercom"],
			},
		});

		const deadline = Date.now() + 10_000;
		let statusDuringTool: AsyncStatusPayload | undefined;
		while (Date.now() < deadline && !fs.existsSync(resultPath)) {
			if (fs.existsSync(asyncDir) && fs.existsSync(path.join(asyncDir, "status.json"))) {
				const status = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8")) as AsyncStatusPayload;
				const toolStartedAt = status.steps?.[0]?.currentToolStartedAt;
				if (status.currentTool === "bash" && status.steps?.[0]?.currentTool === "bash" && toolStartedAt && Date.now() - toolStartedAt >= 1_500) {
					statusDuringTool = status;
					break;
				}
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		assert.ok(statusDuringTool, "expected status.json to expose the active tool");
		assert.equal(statusDuringTool?.activityState, undefined);
		assert.equal(statusDuringTool?.steps?.[0]?.activityState, undefined);
		const eventText = fs.existsSync(eventsPath) ? fs.readFileSync(eventsPath, "utf-8") : "";
		assert.doesNotMatch(eventText, /"type":"needs_attention"/);
		await waitForAsyncResultFile(id);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		assert.equal(payload.success, true);
	});

	it("background open-tool attention survives an overlapping quick tool", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({
			steps: [
				{ jsonl: [{ type: "tool_execution_start", toolCallId: "bash-1", toolName: "bash", args: { command: "sleep 2" } }] },
				{ delay: 50, jsonl: [
					{ type: "tool_execution_start", toolCallId: "read-1", toolName: "read", args: { path: "README.md" } },
					{ type: "tool_execution_end", toolCallId: "read-1", toolName: "read" },
				] },
				{ delay: 2_000, jsonl: [
					{ type: "tool_execution_end", toolCallId: "bash-1", toolName: "bash" },
					events.toolResult("bash", "done"),
					events.assistantMessage("Done"),
				] },
			],
		});

		const id = `async-overlap-tool-attention-${Date.now().toString(36)}`;
		const asyncDir = path.join(ASYNC_DIR, id);
		const eventsPath = path.join(asyncDir, "events.jsonl");
		const statusPath = path.join(asyncDir, "status.json");
		const resultPath = path.join(RESULTS_DIR, `${id}.json`);
		executeAsyncSingle(id, {
			agent: "worker",
			task: "Run the command",
			agentConfig: makeAgent("worker"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
			controlConfig: {
				enabled: true,
				needsAttentionAfterMs: 999_999,
				activeNoticeAfterMs: 100,
				failedToolAttemptsBeforeAttention: 3,
				notifyOn: ["needs_attention"],
				notifyChannels: ["event", "async", "intercom"],
			},
		});

		const deadline = Date.now() + 10_000;
		let eventText = "";
		let statusDuringEvent: AsyncStatusPayload | undefined;
		while (Date.now() < deadline) {
			if (fs.existsSync(eventsPath)) eventText = fs.readFileSync(eventsPath, "utf-8");
			if (eventText.includes('"reason":"tool_open_threshold"') && fs.existsSync(statusPath)) {
				const status = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatusPayload;
				if (status.activityState === "needs_attention" && status.steps?.[0]?.activityState === "needs_attention") {
					statusDuringEvent = status;
					break;
				}
			}
			if (eventText.includes('"reason":"tool_open_threshold"') && fs.existsSync(resultPath)) {
				assert.fail("run completed before status.json exposed overlapping tool attention");
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
		}

		assert.match(eventText, /"type":"needs_attention"/);
		assert.match(eventText, /"reason":"tool_open_threshold"/);
		assert.match(eventText, /"currentTool":"bash"/);
		assert.ok(statusDuringEvent, "expected status.json to expose overlapping tool attention while the run is active");
		assert.equal(statusDuringEvent.currentTool, "bash");
		assert.equal(statusDuringEvent.steps?.[0]?.currentTool, "bash");
		await waitForAsyncResultFile(id);
	});

	it("subagent_wait wakes when an async child is waiting on contact_supervisor", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		const id = `async-supervisor-attention-${Date.now().toString(36)}`;
		const replyReleasePath = path.join(tempDir, `${id}.reply`);
		const finalReleasePath = path.join(tempDir, `${id}.final`);
		mockPi.onCall({
			steps: [
				{ jsonl: [events.toolStart("contact_supervisor", { reason: "need_decision", message: "Need a decision" })] },
				{ waitForPath: replyReleasePath, jsonl: [events.toolEnd("contact_supervisor"), events.toolResult("contact_supervisor", "**Reply from supervisor:**\nProceed")] },
				{ waitForPath: finalReleasePath, jsonl: [events.assistantMessage("Done")] },
			],
		});

		const asyncDir = path.join(ASYNC_DIR, id);
		const eventsPath = path.join(asyncDir, "events.jsonl");
		const resultPath = path.join(RESULTS_DIR, `${id}.json`);
		const statusPath = path.join(asyncDir, "status.json");
		executeAsyncSingle(id, {
			agent: "worker",
			task: "Ask the supervisor for a blocking decision",
			agentConfig: makeAgent("worker"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
			controlConfig: {
				enabled: true,
				needsAttentionAfterMs: 999_999,
				activeNoticeAfterMs: 999_999,
				failedToolAttemptsBeforeAttention: 3,
				notifyOn: ["active_long_running", "needs_attention"],
				notifyChannels: ["event", "async", "intercom"],
			},
		});

		const releaseMockChild = () => {
			if (!fs.existsSync(replyReleasePath)) fs.writeFileSync(replyReleasePath, "release", "utf-8");
			if (!fs.existsSync(finalReleasePath)) fs.writeFileSync(finalReleasePath, "release", "utf-8");
		};
		const releaseSupervisorReply = () => {
			if (!fs.existsSync(replyReleasePath)) fs.writeFileSync(replyReleasePath, "release", "utf-8");
		};
		try {
			const attentionDeadline = Date.now() + 10_000;
			let statusDuringAttention: AsyncStatusPayload | undefined;
			while (Date.now() < attentionDeadline && !fs.existsSync(resultPath)) {
				if (fs.existsSync(statusPath)) {
					const nextStatus = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatusPayload;
					if (nextStatus.currentTool === "contact_supervisor" && nextStatus.activityState === "needs_attention") {
						statusDuringAttention = nextStatus;
						break;
					}
				}
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
			assert.ok(statusDuringAttention, "expected status.json to expose the blocking supervisor request");

			try {
				const waitResult = await waitForSubagents({ id, timeoutMs: 3_500 }, undefined, {
					state: { currentSessionId: "session-1", foregroundRuns: new Map(), asyncJobs: new Map(), cleanupTimers: new Map(), resultFileCoalescer: new Map() },
					pollIntervalMs: 100,
					events: createEventBus(),
				});
				const waitText = waitResult.content[0]?.text ?? "";
				assert.equal(waitResult.isError, undefined);
				assert.match(waitText, /attention required/i);
				assert.match(waitText, new RegExp(id));
				assert.match(waitText, /intercom\(\{ action: "pending" \}\)/);
				assert.equal(fs.existsSync(resultPath), false, "wait should return before the child completes");
			} finally {
				releaseSupervisorReply();
			}

			const eventText = fs.existsSync(eventsPath) ? fs.readFileSync(eventsPath, "utf-8") : "";
			assert.match(eventText, /"type":"needs_attention"/);
			assert.match(eventText, /"reason":"supervisor_request"/);
			assert.equal(statusDuringAttention.activityState, "needs_attention");
			assert.equal(statusDuringAttention.steps?.[0]?.activityState, "needs_attention");
			assert.equal(statusDuringAttention.currentTool, "contact_supervisor");
			assert.equal(statusDuringAttention.steps?.[0]?.currentTool, "contact_supervisor");

			const clearDeadline = Date.now() + 10_000;
			let statusAfterReply: AsyncStatusPayload | undefined;
			while (Date.now() < clearDeadline && !fs.existsSync(resultPath)) {
				const nextStatus = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatusPayload;
				if (nextStatus.state === "running" && !nextStatus.currentTool && !nextStatus.steps?.[0]?.currentTool) {
					statusAfterReply = nextStatus;
					break;
				}
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
			assert.ok(statusAfterReply, "expected the child to keep running after the supervisor reply");
			assert.equal(statusAfterReply.activityState, undefined);
			assert.equal(statusAfterReply.steps?.[0]?.activityState, undefined);

			fs.writeFileSync(finalReleasePath, "release", "utf-8");
			await waitForAsyncResultFile(id);
		} finally {
			releaseMockChild();
		}
	});

	it("background runs escalate repeated mutating tool failures", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({
			steps: [
				{ jsonl: [events.toolStart("edit", { path: "src/runs/background/subagent-runner.ts" }), events.toolEnd("edit"), events.toolResult("edit", "No exact match found for subagent-runner.ts", true)] },
				{ jsonl: [events.toolStart("edit", { path: "src/runs/background/subagent-runner.ts" }), events.toolEnd("edit"), events.toolResult("edit", "No exact match found for subagent-runner.ts", true)] },
				{ jsonl: [events.toolStart("edit", { path: "src/runs/background/subagent-runner.ts" }), events.toolEnd("edit"), events.toolResult("edit", "No exact match found for subagent-runner.ts", true)] },
				{ delay: 2_000, jsonl: [events.assistantMessage("I need another attempt.")] },
			],
		});

		const id = `async-tool-failures-${Date.now().toString(36)}`;
		const asyncDir = path.join(ASYNC_DIR, id);
		const eventsPath = path.join(asyncDir, "events.jsonl");
		const resultPath = path.join(RESULTS_DIR, `${id}.json`);

		executeAsyncSingle(id, {
			agent: "worker",
			task: "Implement the approved fixes",
			agentConfig: makeAgent("worker"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
			controlConfig: {
				enabled: true,
				needsAttentionAfterMs: 999_999,
				activeNoticeAfterTurns: 999_999,
				activeNoticeAfterMs: 999_999,
				activeNoticeAfterTokens: 999_999,
				failedToolAttemptsBeforeAttention: 3,
				notifyOn: ["active_long_running", "needs_attention"],
				notifyChannels: ["event", "async", "intercom"],
			},
		});

		const statusPath = path.join(asyncDir, "status.json");
		const deadline = Date.now() + 10_000;
		let eventText = "";
		let statusDuringEvent: AsyncStatusPayload | undefined;
		while (Date.now() < deadline) {
			if (fs.existsSync(eventsPath)) {
				eventText = fs.readFileSync(eventsPath, "utf-8");
			}
			if (eventText.includes('"reason":"tool_failures"') && fs.existsSync(statusPath)) {
				const status = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatusPayload;
				if (status.activityState === "needs_attention" && status.steps?.[0]?.activityState === "needs_attention") {
					statusDuringEvent = status;
					break;
				}
			}
			if (eventText.includes('"reason":"tool_failures"') && fs.existsSync(resultPath)) {
				assert.fail("run completed before status.json exposed needs_attention");
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
		}

		assert.match(eventText, /"type":"needs_attention"/);
		assert.match(eventText, /"reason":"tool_failures"/);
		assert.match(eventText, /subagent-runner\.ts/);
		assert.ok(statusDuringEvent, "expected status.json to expose needs_attention while the run is still active");
		assert.equal(statusDuringEvent.activityState, "needs_attention");
		assert.equal(statusDuringEvent.steps?.[0]?.activityState, "needs_attention");

		const doneDeadline = Date.now() + 10_000;
		while (!fs.existsSync(resultPath)) {
			if (Date.now() > doneDeadline) assert.fail(`Timed out waiting for async result file: ${resultPath}`);
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
	});

	it("background event logs drop noisy message updates and cap child diagnostics", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		const previousMaxBytes = process.env.PI_SUBAGENT_ASYNC_EVENTS_MAX_BYTES;
		process.env.PI_SUBAGENT_ASYNC_EVENTS_MAX_BYTES = "900";
		try {
			mockPi.onCall({
				steps: [
					{
						jsonl: [
							{
								type: "message_update",
								assistantMessageEvent: {
									type: "thinking_delta",
									delta: "NOISY_PARTIAL_DELTA",
									partial: { role: "assistant", content: [{ type: "text", text: "NOISY_PARTIAL_SNAPSHOT".repeat(200) }] },
								},
								message: { role: "assistant", content: [{ type: "text", text: "NOISY_PARTIAL_MESSAGE".repeat(200) }] },
							},
							events.toolStart("bash", { command: `echo ${"BIG_COMMAND_PAYLOAD".repeat(200)}` }),
							events.assistantMessage("Done after noisy stream"),
						],
					},
				],
			});

			const id = `async-noisy-events-${Date.now().toString(36)}`;
			const asyncDir = path.join(ASYNC_DIR, id);
			const sessionRoot = path.join(tempDir, "sessions");

			executeAsyncSingle(id, {
				agent: "worker",
				task: "Stream noisy diagnostics",
				agentConfig: makeAgent("worker"),
				ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
				artifactConfig: {
					enabled: false,
					includeInput: false,
					includeOutput: false,
					includeJsonl: false,
					includeMetadata: false,
					cleanupDays: 7,
				},
				shareEnabled: false,
				sessionRoot,
				maxSubagentDepth: 2,
			});

			const resultPath = await waitForAsyncResultFile(id, 10_000);
			const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
			assert.equal(payload.success, true);
			assert.equal(payload.results[0]?.output, "Done after noisy stream");

			const eventsText = fs.readFileSync(path.join(asyncDir, "events.jsonl"), "utf-8");
			assert.doesNotMatch(eventsText, /"type":"message_update"/);
			assert.doesNotMatch(eventsText, /NOISY_PARTIAL_/);
			assert.doesNotMatch(eventsText, /BIG_COMMAND_PAYLOAD/);
			assert.match(eventsText, /"type":"subagent\.events\.truncated"/);
			assert.match(eventsText, /"droppedEventType":"tool_execution_start"/);
		} finally {
			if (previousMaxBytes === undefined) delete process.env.PI_SUBAGENT_ASYNC_EVENTS_MAX_BYTES;
			else process.env.PI_SUBAGENT_ASYNC_EVENTS_MAX_BYTES = previousMaxBytes;
		}
	});

	it("background runs stream child events and live output while active", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({
			steps: [
				{ delay: 200, jsonl: [events.toolStart("bash", { command: "ls" })] },
				{ delay: 600, jsonl: [events.toolEnd("bash"), events.toolResult("bash", "file-a\nfile-b")] },
				{ delay: 600, jsonl: [events.assistantMessage("Done streaming")], stderr: "warning: mock stderr\n" },
			],
		});

		const id = `async-stream-${Date.now().toString(36)}`;
		const asyncDir = path.join(ASYNC_DIR, id);
		const eventsPath = path.join(asyncDir, "events.jsonl");
		const outputPath = path.join(asyncDir, "output-0.log");
		const resultPath = path.join(RESULTS_DIR, `${id}.json`);
		const sessionRoot = path.join(tempDir, "sessions");

		executeAsyncSingle(id, {
			agent: "worker",
			task: "Stream detailed progress",
			agentConfig: makeAgent("worker"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot,
			maxSubagentDepth: 2,
		});

		const liveDeadline = Date.now() + 10_000;
		let sawChildEvent = false;
		let sawLiveOutput = false;
		while (Date.now() < liveDeadline && (!sawChildEvent || !sawLiveOutput)) {
			if (fs.existsSync(eventsPath)) {
				const content = fs.readFileSync(eventsPath, "utf-8");
				sawChildEvent = content.includes('"type":"tool_execution_start"')
					&& content.includes('"subagentSource":"child"');
			}
			if (fs.existsSync(outputPath)) {
				const content = fs.readFileSync(outputPath, "utf-8");
				sawLiveOutput = content.includes("bash: ls") || content.includes("file-a") || content.includes("warning: mock stderr");
			}
			if (sawChildEvent && sawLiveOutput) break;
			assert.equal(fs.existsSync(resultPath), false, "run finished before live observability was written");
			await new Promise((resolve) => setTimeout(resolve, 100));
		}

		assert.equal(sawChildEvent, true, "expected child JSON events to be streamed into events.jsonl");
		assert.equal(sawLiveOutput, true, "expected output-0.log to receive live child output");

		const doneDeadline = Date.now() + 10_000;
		while (!fs.existsSync(resultPath)) {
			if (Date.now() > doneDeadline) {
				assert.fail(`Timed out waiting for async result file: ${resultPath}`);
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
		}

		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
		assert.equal(payload.success, true);
		assert.equal(payload.results[0].output, "Done streaming");

		const status = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8"));
		assert.deepEqual(status.steps[0].recentTools.map((tool: { tool: string; args: string }) => ({ tool: tool.tool, args: tool.args })), [{ tool: "bash", args: "ls" }]);
		assert.deepEqual(status.steps[0].recentOutput, ["file-a", "file-b", "Done streaming"]);
	});
});
