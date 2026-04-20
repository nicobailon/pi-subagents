/**
 * Type definitions for the subagent extension
 */

import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@mariozechner/pi-ai";
import type { FSWatcher } from "node:fs";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

// ============================================================================
// Basic Types
// ============================================================================

export interface MaxOutputConfig {
	bytes?: number;
	lines?: number;
}

export interface TruncationResult {
	text: string;
	truncated: boolean;
	originalBytes?: number;
	originalLines?: number;
	artifactPath?: string;
}

export interface Usage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	turns: number;
}

export interface TokenUsage {
	input: number;
	output: number;
	total: number;
}

// ============================================================================
// Progress Tracking
// ============================================================================

export interface AgentProgress {
	index: number;
	agent: string;
	status: "pending" | "running" | "completed" | "failed" | "detached";
	task: string;
	skills?: string[];
	lastActivityAt?: number;
	currentTool?: string;
	currentToolArgs?: string;
	currentToolStartedAt?: number;
	recentTools: Array<{ tool: string; args: string; endMs: number }>;
	recentOutput: string[];
	toolCount: number;
	tokens: number;
	durationMs: number;
	error?: string;
	failedTool?: string;
}

export interface ToolCallSummary {
	text: string;
	expandedText: string;
}

export interface ProgressSummary {
	toolCount: number;
	tokens: number;
	durationMs: number;
}

// ============================================================================
// Results
// ============================================================================

export interface ModelAttempt {
	model: string;
	success: boolean;
	exitCode?: number | null;
	error?: string;
	usage?: Usage;
}

export interface SingleResult {
	agent: string;
	task: string;
	exitCode: number;
	detached?: boolean;
	detachedReason?: string;
	messages?: Message[];
	usage: Usage;
	model?: string;
	attemptedModels?: string[];
	modelAttempts?: ModelAttempt[];
	error?: string;
	sessionFile?: string;
	skills?: string[];
	skillsWarning?: string;
	progress?: AgentProgress;
	progressSummary?: ProgressSummary;
	toolCalls?: ToolCallSummary[];
	artifactPaths?: ArtifactPaths;
	truncation?: TruncationResult;
	finalOutput?: string;
	savedOutputPath?: string;
	outputSaveError?: string;
}

export interface Details {
	mode: "single" | "parallel" | "chain" | "management";
	context?: "fresh" | "fork";
	results: SingleResult[];
	asyncId?: string;
	asyncDir?: string;
	progress?: AgentProgress[];
	progressSummary?: ProgressSummary;
	artifacts?: {
		dir: string;
		files: ArtifactPaths[];
	};
	truncation?: {
		truncated: boolean;
		originalBytes?: number;
		originalLines?: number;
		artifactPath?: string;
	};
	// Chain metadata for observability
	chainAgents?: string[];      // Agent names in order, e.g., ["scout", "planner"]
	totalSteps?: number;         // Total steps in chain
	currentStepIndex?: number;   // 0-indexed current step (for running chains)
}

// ============================================================================
// Artifacts
// ============================================================================

export interface ArtifactPaths {
	inputPath: string;
	outputPath: string;
	jsonlPath: string;
	metadataPath: string;
}

export interface ArtifactConfig {
	enabled: boolean;
	includeInput: boolean;
	includeOutput: boolean;
	includeJsonl: boolean;
	includeMetadata: boolean;
	cleanupDays: number;
}

// ============================================================================
// Async Execution
// ============================================================================

export interface AsyncStatus {
	runId: string;
	mode: "single" | "chain";
	state: "queued" | "running" | "complete" | "failed";
	startedAt: number;
	endedAt?: number;
	lastUpdate?: number;
	cwd?: string;
	currentStep?: number;
	steps?: Array<{
		agent: string;
		status: string;
		durationMs?: number;
		tokens?: TokenUsage;
		skills?: string[];
		model?: string;
		attemptedModels?: string[];
		modelAttempts?: ModelAttempt[];
		error?: string;
	}>;
	sessionDir?: string;
	outputFile?: string;
	totalTokens?: TokenUsage;
	sessionFile?: string;
}

export interface AsyncJobState {
	asyncId: string;
	asyncDir: string;
	status: "queued" | "running" | "complete" | "failed";
	mode?: "single" | "chain";
	agents?: string[];
	currentStep?: number;
	stepsTotal?: number;
	startedAt?: number;
	updatedAt?: number;
	sessionDir?: string;
	outputFile?: string;
	totalTokens?: TokenUsage;
	sessionFile?: string;
}

export interface SubagentState {
	baseCwd: string;
	currentSessionId: string | null;
	asyncJobs: Map<string, AsyncJobState>;
	cleanupTimers: Map<string, ReturnType<typeof setTimeout>>;
	lastUiContext: ExtensionContext | null;
	poller: NodeJS.Timeout | null;
	completionSeen: Map<string, number>;
	watcher: FSWatcher | null;
	watcherRestartTimer: ReturnType<typeof setTimeout> | null;
	resultFileCoalescer: {
		schedule(file: string, delayMs?: number): boolean;
		clear(): void;
	};
}

// ============================================================================
// Display
// ============================================================================

export type DisplayItem = 
	| { type: "text"; text: string } 
	| { type: "tool"; name: string; args: Record<string, unknown> };

// ============================================================================
// Error Handling
// ============================================================================

export interface ErrorInfo {
	hasError: boolean;
	exitCode?: number;
	errorType?: string;
	details?: string;
}

export interface IntercomEventBus {
	on(channel: string, handler: (data: unknown) => void): () => void;
	emit(channel: string, data: unknown): void;
}

export const INTERCOM_DETACH_REQUEST_EVENT = "pi-intercom:detach-request";
export const INTERCOM_DETACH_RESPONSE_EVENT = "pi-intercom:detach-response";

// ============================================================================
// Execution Options
// ============================================================================

export interface RunSyncOptions {
	cwd?: string;
	signal?: AbortSignal;
	allowIntercomDetach?: boolean;
	intercomEvents?: IntercomEventBus;
	onUpdate?: (r: import("@mariozechner/pi-agent-core").AgentToolResult<Details>) => void;
	maxOutput?: MaxOutputConfig;
	artifactsDir?: string;
	artifactConfig?: ArtifactConfig;
	runId: string;
	index?: number;
	sessionDir?: string;
	sessionFile?: string;
	share?: boolean;
	outputPath?: string;
	maxSubagentDepth?: number;
	/** Override the agent's default model (format: "provider/id" or just "id") */
	modelOverride?: string;
	/** Registry models available for heuristic bare-model resolution */
	availableModels?: Array<{ provider: string; id: string; fullId: string }>;
	/** Current parent-session provider to prefer for ambiguous bare model ids */
	preferredModelProvider?: string;
	/** Skills to inject (overrides agent default if provided) */
	skills?: string[];
}

export type IntercomBridgeMode = "off" | "fork-only" | "always";

export interface IntercomBridgeConfig {
	mode?: IntercomBridgeMode;
	instructionFile?: string;
}

export interface TopLevelParallelConfig {
	maxTasks?: number;
	concurrency?: number;
}

export interface ExtensionConfig {
	asyncByDefault?: boolean;
	forceTopLevelAsync?: boolean;
	defaultSessionDir?: string;
	maxSubagentDepth?: number;
	parallel?: TopLevelParallelConfig;
	worktreeSetupHook?: string;
	worktreeSetupHookTimeoutMs?: number;
	intercomBridge?: IntercomBridgeConfig;
}

// ============================================================================
// Constants
// ============================================================================

export const DEFAULT_MAX_OUTPUT: Required<MaxOutputConfig> = {
	bytes: 200 * 1024,
	lines: 5000,
};

export const DEFAULT_ARTIFACT_CONFIG: ArtifactConfig = {
	enabled: true,
	includeInput: true,
	includeOutput: true,
	includeJsonl: false,
	includeMetadata: true,
	cleanupDays: 7,
};

function sanitizeTempScopeSegment(value: string): string {
	const sanitized = value
		.trim()
		.replace(/[^A-Za-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return sanitized || "unknown";
}

export function resolveTempScopeId(options?: {
	env?: NodeJS.ProcessEnv;
	getuid?: (() => number) | undefined;
	userInfo?: (() => { username?: string | null }) | undefined;
	homedir?: (() => string) | undefined;
}): string {
	const env = options?.env ?? process.env;
	const getuid = options && Object.hasOwn(options, "getuid")
		? options.getuid
		: process.getuid?.bind(process);
	if (typeof getuid === "function") {
		return `uid-${getuid()}`;
	}

	for (const key of ["USERNAME", "USER", "LOGNAME"] as const) {
		const value = env[key];
		if (value) return `user-${sanitizeTempScopeSegment(value)}`;
	}

	const userInfo = options && Object.hasOwn(options, "userInfo")
		? options.userInfo
		: os.userInfo;
	try {
		const username = userInfo?.().username;
		if (username) return `user-${sanitizeTempScopeSegment(username)}`;
	} catch {
		// Fall through to home-directory-based scoping.
	}

	const homedir = env.USERPROFILE ?? env.HOME;
	if (homedir) return `home-${sanitizeTempScopeSegment(homedir)}`;

	const resolveHomedir = options && Object.hasOwn(options, "homedir")
		? options.homedir
		: os.homedir;
	try {
		const fallbackHomedir = resolveHomedir?.();
		if (fallbackHomedir) return `home-${sanitizeTempScopeSegment(fallbackHomedir)}`;
	} catch {
		// Fall through to the last-resort shared scope.
	}

	return "shared";
}

export const MAX_PARALLEL = 8;
export const MAX_CONCURRENCY = 4;
export const TEMP_ROOT_DIR = path.join(os.tmpdir(), `pi-subagents-${resolveTempScopeId()}`);
export const RESULTS_DIR = path.join(TEMP_ROOT_DIR, "async-subagent-results");
export const ASYNC_DIR = path.join(TEMP_ROOT_DIR, "async-subagent-runs");
export const CHAIN_RUNS_DIR = path.join(TEMP_ROOT_DIR, "chain-runs");
export const TEMP_ARTIFACTS_DIR = path.join(TEMP_ROOT_DIR, "artifacts");
export const WIDGET_KEY = "subagent-async";
export const SLASH_RESULT_TYPE = "subagent-slash-result";
export const SLASH_SUBAGENT_REQUEST_EVENT = "subagent:slash:request";
export const SLASH_SUBAGENT_STARTED_EVENT = "subagent:slash:started";
export const SLASH_SUBAGENT_RESPONSE_EVENT = "subagent:slash:response";
export const SLASH_SUBAGENT_UPDATE_EVENT = "subagent:slash:update";
export const SLASH_SUBAGENT_CANCEL_EVENT = "subagent:slash:cancel";
export const POLL_INTERVAL_MS = 250;
export const MAX_WIDGET_JOBS = 4;
export const DEFAULT_SUBAGENT_MAX_DEPTH = 2;

export const DEFAULT_FORK_PREAMBLE =
	"You are a delegated subagent running from a fork of the parent session. " +
	"Treat the inherited conversation as reference-only context, not a live thread to continue. " +
	"Do not continue or answer prior messages as if they are waiting for a reply. " +
	"Your sole job is to execute the task below and return a focused result for that task using your tools.";

function normalizeTopLevelParallelValue(value: unknown): number | undefined {
	const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
	if (!Number.isInteger(parsed) || parsed < 1) return undefined;
	return parsed;
}

export function resolveTopLevelParallelMaxTasks(value: unknown): number {
	return normalizeTopLevelParallelValue(value) ?? MAX_PARALLEL;
}

export function resolveTopLevelParallelConcurrency(
	override: unknown,
	configValue: unknown,
): number {
	return normalizeTopLevelParallelValue(override)
		?? normalizeTopLevelParallelValue(configValue)
		?? MAX_CONCURRENCY;
}

export function getAsyncConfigPath(suffix: string): string {
	return path.join(TEMP_ROOT_DIR, `async-cfg-${suffix}.json`);
}

export function wrapForkTask(task: string, preamble?: string | false): string {
	if (preamble === false) return task;
	const effectivePreamble = preamble ?? DEFAULT_FORK_PREAMBLE;
	const wrappedPrefix = `${effectivePreamble}\n\nTask:\n`;
	if (task.startsWith(wrappedPrefix)) return task;
	return `${wrappedPrefix}${task}`;
}

// ============================================================================
// Recursion Depth Guard
// ============================================================================

export function normalizeMaxSubagentDepth(value: unknown): number | undefined {
	const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
	if (!Number.isInteger(parsed) || parsed < 0) return undefined;
	return parsed;
}

export function resolveCurrentMaxSubagentDepth(configMaxDepth?: number): number {
	return normalizeMaxSubagentDepth(process.env.PI_SUBAGENT_MAX_DEPTH)
		?? normalizeMaxSubagentDepth(configMaxDepth)
		?? DEFAULT_SUBAGENT_MAX_DEPTH;
}

export function resolveChildMaxSubagentDepth(parentMaxDepth: number, agentMaxDepth?: number): number {
	const normalizedParent = normalizeMaxSubagentDepth(parentMaxDepth) ?? DEFAULT_SUBAGENT_MAX_DEPTH;
	const normalizedAgent = normalizeMaxSubagentDepth(agentMaxDepth);
	return normalizedAgent === undefined ? normalizedParent : Math.min(normalizedParent, normalizedAgent);
}

export function checkSubagentDepth(configMaxDepth?: number): { blocked: boolean; depth: number; maxDepth: number } {
	const depth = Number(process.env.PI_SUBAGENT_DEPTH ?? "0");
	const maxDepth = resolveCurrentMaxSubagentDepth(configMaxDepth);
	const blocked = Number.isFinite(depth) && depth >= maxDepth;
	return { blocked, depth, maxDepth };
}

export function getSubagentDepthEnv(maxDepth?: number): Record<string, string> {
	const parentDepth = Number(process.env.PI_SUBAGENT_DEPTH ?? "0");
	const nextDepth = Number.isFinite(parentDepth) ? parentDepth + 1 : 1;
	return {
		PI_SUBAGENT_DEPTH: String(nextDepth),
		PI_SUBAGENT_MAX_DEPTH: String(normalizeMaxSubagentDepth(maxDepth) ?? resolveCurrentMaxSubagentDepth()),
	};
}

// ============================================================================
// Utility Functions
// ============================================================================

export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export function truncateOutput(
	output: string,
	config: Required<MaxOutputConfig>,
	artifactPath?: string,
): TruncationResult {
	const lines = output.split("\n");
	const bytes = Buffer.byteLength(output, "utf-8");

	if (bytes <= config.bytes && lines.length <= config.lines) {
		return { text: output, truncated: false };
	}

	let truncatedLines = lines;
	if (lines.length > config.lines) {
		truncatedLines = lines.slice(0, config.lines);
	}

	let result = truncatedLines.join("\n");
	if (Buffer.byteLength(result, "utf-8") > config.bytes) {
		let low = 0;
		let high = result.length;
		while (low < high) {
			const mid = Math.floor((low + high + 1) / 2);
			if (Buffer.byteLength(result.slice(0, mid), "utf-8") <= config.bytes) {
				low = mid;
			} else {
				high = mid - 1;
			}
		}
		result = result.slice(0, low);
	}

	const keptLines = result.split("\n").length;
	const marker = `[TRUNCATED: showing first ${keptLines} of ${lines.length} lines, ${formatBytes(Buffer.byteLength(result))} of ${formatBytes(bytes)}${artifactPath ? ` - full output at ${artifactPath}` : ""}]\n`;

	return {
		text: marker + result,
		truncated: true,
		originalBytes: bytes,
		originalLines: lines.length,
		artifactPath,
	};
}
