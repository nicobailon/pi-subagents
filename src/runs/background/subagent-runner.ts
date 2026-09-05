import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type { Message } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { arbitrateCompletionGuardRescue, createTaskMutationArbiter } from "../shared/llm-intent-arbiter.ts";

// Detached runners skip Pi's CLI proxy setup. Keep fetch on the same Undici dispatcher.
function ensureProxyAwareHttpDispatcher(): void {
	try {
		// SAFETY: require loads the pinned direct dependency described by these types.
		const undici = createRequire(import.meta.url)("undici") as typeof import("undici");
		const dispatcher = new undici.EnvHttpProxyAgent({ allowH2: false });
		// Fetch rejects stream errors; the listener prevents an unhandled EventEmitter error.
		EventEmitter.prototype.on.call(dispatcher, "error", () => {});
		undici.setGlobalDispatcher(dispatcher);
		undici.install();
	} catch (error) {
		console.error(`[pi-subagents] proxy-aware HTTP dispatcher not installed: ${error instanceof Error ? error.message : String(error)}`);
	}
}
ensureProxyAwareHttpDispatcher();
import { writeAtomicJson } from "../../shared/atomic-json.ts";
import { writeAsyncResultFile, writePendingAsyncResultFile } from "./result-files.ts";
import { createFileCoalescer } from "../../shared/file-coalescer.ts";
import { createCapacityResilientJsonWriter } from "../../shared/capacity-resilient-json.ts";
import { isStorageCapacityError } from "../../shared/file-system-retry.ts";
import { updateActiveRunIndex } from "./active-run-index.ts";
import { createChildTranscriptWriter, type ChildTranscriptWriter } from "../../shared/child-transcript.ts";
import { closeSteerInbox, consumeInterruptRequest, consumeSteerRequests, deliverInterruptRequest, deliverStopRequest, deliverTimeoutRequest, watchAsyncControlInbox, type SteerRequest, type StopRequest } from "./control-channel.ts";
import { appendJsonl as appendRawJsonl, formatOutputArtifactContent, getArtifactPaths, writeArtifact, writeMetadata } from "../../shared/artifacts.ts";
import { PI_CODING_AGENT_PACKAGE, resolveInstalledPiPackageRoot } from "../shared/pi-spawn.ts";
import { preflightLaunchCwd } from "../shared/launch-cwd.ts";
import { captureSingleOutputSnapshot, extractChildWrittenOutput, finalizeSingleOutput, formatSavedOutputReference, injectOutputPathSystemPrompt, injectSingleOutputInstruction, resolveSingleOutput, type SingleOutputSnapshot } from "../shared/single-output.ts";
import {
	type ActivityState,
	type ArtifactConfig,
	type ExternalCliRunnerStatus,
	type ExternalJobRunnerStatus,
	type ExternalJobStatus,
	type ExternalProcessStatus,
	type ArtifactPaths,
	type AsyncParallelGroupStatus,
	type AsyncStatus,
	type ChainOutputMap,
	type CostSummary,
	type LaunchResolvedChildExtensions,
	type RuntimeAcknowledgedChildExtensions,
	type ModelAttempt,
	type PiWriterProcessInstanceExit,
	type NestedRouteInfo,
	type NestedRunSummary,
	type ResolvedControlConfig,
	type ResolvedToolBudget,
	type RunFanoutBudgetDescriptor,
	type SubagentRunMode,
	type SubagentOutputState,
	type UsageBudgetConfig,
	type ToolBudgetState,
	type Usage,
	type WorkflowGraphSnapshot,
	type SteeringTargetState,
	type SteeringTargetStatus,
	type SubagentChildStatusEvent,
	type WorkflowLaneMetadata,
	DEFAULT_MAX_OUTPUT,
	type MaxOutputConfig,
	SUBAGENT_LIFECYCLE_ARTIFACT_VERSION,
	truncateOutput,
} from "../../shared/types.ts";
import {
	DEFAULT_CONTROL_CONFIG,
	buildControlEvent,
	deriveActivityState,
	claimControlNotification,
	formatControlIntercomMessage,
	formatControlNoticeMessage,
	shouldEmitOpenToolAttention,
} from "../shared/subagent-control.ts";
import {
	type RunnerSubagentStep as SubagentStep,
	type RunnerStep,
	isDynamicRunnerGroup,
	isParallelGroup,
	flattenSteps,
	mapConcurrent,
	aggregateParallelOutputs,
	MAX_PARALLEL_CONCURRENCY,
	DEFAULT_GLOBAL_CONCURRENCY_LIMIT,
	Semaphore,
} from "../shared/parallel-utils.ts";
import { applyThinkingSuffix, deriveForkPromptCacheKey, projectLaunchResolvedChildExtensions, resolvePiLaunchToolPlan } from "../shared/child-tool-plan.ts";
import { buildInProcessChildLaunch, type InheritedChildRuntime } from "../shared/child-launch.ts";
import type { ChildSessionFactory } from "../shared/child-session.ts";
import { runChildSession, type ChildEvent, type RunChildSessionResult, type StepSteerHandler } from "./run-child-session.ts";
import { loadRunnerChildSessionFactory } from "./runner-child-sessions.ts";
import { SUBAGENT_CHILD_ENV } from "../shared/child-runtime-config.ts";
import { deriveChildSessionName } from "../../shared/child-session-name.ts";
import { alignForkedSessionCwd } from "../../shared/fork-session-cwd.ts";
import { outputEntryFromAsyncResult, resolveOutputReferences } from "../shared/chain-outputs.ts";
import { clearStructuredOutputCaptures, createStructuredOutputFileCapture, createStructuredOutputRuntime, MISSING_STRUCTURED_OUTPUT_CALL_ERROR, readStructuredOutput, readStructuredOutputAcceptanceReport } from "../shared/structured-output.ts";
import { formatMidToolExitError, isOrdinaryToolForMidToolExit, isUnexplainedProcessSignal } from "../shared/process-signal.ts";
import { formatChildToolDiagnostic } from "../shared/tool-availability.ts";
import { buildTimeoutRecoverySummary, collectTrackedMutationEvidence, snapshotTrackedMutations } from "../shared/mutation-evidence.ts";
import { collectDynamicResults, DynamicFanoutError, materializeDynamicParallelStep, validateDynamicCollection } from "../shared/dynamic-fanout.ts";
import { claimRunFanoutBatch, getRunFanoutBudgetSnapshot } from "../shared/run-fanout-budget.ts";
import { nestedSummaryFromAsyncStatus, projectNestedEvents, resolveNestedAsyncDir, writeNestedEvent } from "../shared/nested-events.ts";
import { formatModelAttemptNote, formatSubagentModelVerificationError, isContextOverflow, isRetryableModelFailureAttempt, recordRetryableModelFailure } from "../shared/model-fallback.ts";
import { markProcessTerminalCandidateLeaseRelease, processTerminalPath, writeProcessTerminalCandidate, type ProcessTerminalCandidate } from "./process-terminal.ts";
import { createSteeringStatus, recordSteeringRequest, steeringStatus, terminalSteeringNoticeState, updateSteeringTarget } from "./steering.ts";
import { PROMPT_REDACTED, detectSubagentError, extractTextFromContent, extractToolArgsPreview, formatEmptyTerminalAssistantResponseError, getFinalOutput, hasEmptyTerminalAssistantResponse, readStatus } from "../../shared/utils.ts";
import { evaluateCompletionMutationGuard, expectsImplementationMutation, hasMutationToolCapability, validateImplementationToolContract } from "../shared/completion-guard.ts";
import { planCompletionEvidence, projectSettlementDiagnostic } from "../shared/completion-evidence.ts";
import { planAbortRecovery } from "../shared/abort-recovery.ts";
import {
	createMutatingFailureState,
	didMutatingToolFail,
	isMutatingTool,
	nextLongRunningTrigger,
	recordMutatingFailure,
	resetMutatingFailureState,
	resolveCurrentPath,
	shouldEscalateMutatingFailures,
	summarizeRecentMutatingFailures,
} from "../shared/long-running-guard.ts";
import { parseSessionTokens } from "../../shared/session-tokens.ts";
import type { TokenUsage } from "../../shared/types.ts";
import {
	cleanupWorktrees,
	createWorktrees,
	withWorktreeTransaction,
	WorktreeSetupError,
	type WorktreeSetupProgress,
	diffWorktrees,
	findWorktreeTaskCwdConflict,
	formatWorktreeDiffSummary,
	formatWorktreeTaskCwdConflict,
	WORKTREE_AGENT_CWD_PLACEHOLDER,
	type WorktreeSetup,
} from "../shared/worktree.ts";
import { findModelInfo, resolveEffectiveThinking } from "../../shared/model-info.ts";
import { assertThinkingWithinCeiling } from "../../shared/thinking-ceiling.ts";
import { launchBindingDigest } from "../../shared/launch-contract.ts";
import { writeInitialProgressFile } from "../../shared/settings.ts";
import { resolveSubagentIntercomTarget } from "../../intercom/intercom-bridge.ts";
import { acceptanceFailureMessage, aggregateAcceptanceReport, buildSkippedAcceptanceLedger, evaluateAcceptance, formatAcceptancePrompt, resolveAcceptanceReportMode, resolveEffectiveAcceptance, stripAcceptanceReport } from "../shared/acceptance.ts";
import { attachContractProjections, isAgentContract } from "../shared/agent-contract.ts";
import { waitForImportedAsyncRoot } from "./chain-root-attachment.ts";
import { normalizeExtensionBindings } from "../shared/extension-bindings.ts";
import { appendRunnerStepsToStatus, consumeChainAppendRequests, countPendingChainAppendRequests, statusStepDescription } from "./chain-append.ts";
import { asyncStatusChildIdentity } from "../shared/child-identity.ts";
import { initialToolBudgetState, toolBudgetState } from "../shared/tool-budget.ts";
import { effectiveToolTimeoutMs, formatToolTimeoutMessage, toolTimeoutCallKey } from "../shared/tool-timeout.ts";
import { usageBudgetExceededMessage, usageBudgetState } from "../shared/usage-budget.ts";
import { formatParallelHandoffError, formatParallelHandoffReference, parallelHandoffPath, writeParallelHandoffGroup, writeWorktreeSetupHandoff } from "../shared/parallel-handoff.ts";
import { resolveWatchdogConfig } from "../../watchdog/settings.ts";
import { acquireSessionLease, type SessionLeaseRequest } from "../shared/session-lease.ts";
import { buildExternalCliPrompt, runExternalCli } from "../shared/external-cli-runner.ts";
import { resolveClaudeCodeLaunch } from "../shared/claude-code-adapter.ts";
import { resolveCodexExecLaunch } from "../shared/codex-exec-adapter.ts";
import { resolveCursorAgentLaunch } from "../shared/cursor-agent-adapter.ts";
import { resolveExternalCliRunnerStatus } from "../shared/external-cli-contract.ts";
import { runExternalJob } from "../shared/external-job-runner.ts";
import { createOrcaProgressTab, type OrcaProgressTab } from "../shared/orca-progress-tabs.ts";
import type { ResolvedSubagentCapabilityCeiling } from "../shared/capability-ceiling.ts";
import {
	acceptChildWatchdogEvent,
	applyChildWatchdogMessage,
	isChildWatchdogStatusEvent,
	resolveChildWatchdogConfig,
	type ChildWatchdogStatusEvent,
} from "../../watchdog/child-status.ts";

const INTERCOM_DETACH_RECEIPT = "Detached for intercom coordination before task completion.";

// This process hosts child sessions. An ambient copy of pi-subagents loaded
// into one of them must register nothing; the variable marks the process as a
// child host.
process.env[SUBAGENT_CHILD_ENV] = "1";

interface SubagentRunConfig {
	id: string;
	steps: RunnerStep[];
	resultPath: string;
	cwd: string;
	placeholder: string;
	taskIndex?: number;
	totalTasks?: number;
	maxOutput?: MaxOutputConfig;
	artifactsDir?: string;
	artifactConfig?: Partial<ArtifactConfig>;
	share?: boolean;
	sessionDir?: string;
	asyncDir: string;
	sessionId?: string | null;
	completionOwnerId?: string;
	piPackageRoot?: string;
	/** Test seam: module the runner imports its `ChildSessionFactory` from. */
	childSessionFactoryModule?: string;
	/** The launching executor's own child runtime when it was itself an in-process child. */
	inheritedChildRuntime?: InheritedChildRuntime;
	worktreeSetupHook?: string;
	worktreeSetupHookTimeoutMs?: number;
	worktreeBaseDir?: string;
	baseRef?: string;
	worktreeProvider?: import("../../shared/types.ts").WorktreeProvider;
	worktreeBranchPrefix?: string;
	controlConfig?: ResolvedControlConfig;
	controlIntercomTarget?: string;
	childIntercomTargets?: Array<string | undefined>;
	resultMode?: SubagentRunMode;
	mode?: SubagentRunMode;
	dynamicFanoutMaxItems?: number;
	workflowGraph?: WorkflowGraphSnapshot;
	nestedRoute?: NestedRouteInfo;
	nestedSelf?: { parentRunId: string; parentStepIndex?: number; depth: number; path?: Array<{ runId: string; stepIndex?: number; agent?: string }> };
	timeoutMs?: number;
	deadlineAt?: number;
	/** Resolved configured hard per-tool-call timeout (ms); fast tools still have a default when undefined. */
	toolTimeoutMs?: number;
	toolBudget?: ResolvedToolBudget;
	usageBudget?: UsageBudgetConfig;
	revivalLease?: SessionLeaseRequest;
	revivalLeaseToken?: string;
	/** Global cap on simultaneously-running subagent tasks within this run. */
	globalConcurrencyLimit?: number;
	capabilityCeiling?: ResolvedSubagentCapabilityCeiling;
	runFanoutBudget?: RunFanoutBudgetDescriptor;
	launchContractDigest?: string;
	launchResolvedExtensions?: LaunchResolvedChildExtensions;
	runtimeAcknowledgedExtensions?: RuntimeAcknowledgedChildExtensions;
	runnerProcessInstanceId?: string;
	launchBarrierToken?: string;
	parentWorkflowRunId?: string;
	workflowKey?: string;
	lane?: WorkflowLaneMetadata;
}

interface StepResult {
	agent: string;
	/** Human-readable display name for the child session, when derived at launch. */
	sessionName?: string;
	context?: "fresh" | "fork";
	capabilityCeiling?: ResolvedSubagentCapabilityCeiling;
	capabilityAudit?: import("../shared/capability-ceiling.ts").SubagentCapabilityAudit;
	launchResolvedExtensions?: LaunchResolvedChildExtensions;
	runtimeAcknowledgedExtensions?: RuntimeAcknowledgedChildExtensions;
	output: string;
	outputState?: SubagentOutputState;
	error?: string;
	success?: boolean;
	exitCode: number | null;
	usage?: Usage;
	savedOutputPath?: string;
	skipped?: boolean;
	interrupted?: boolean;
	detached?: boolean;
	timedOut?: boolean;
	stopped?: boolean;
	processSignal?: string | null;
	timeoutRecovery?: import("../../shared/types.ts").TimeoutRecoverySummary;
	toolBudget?: ToolBudgetState;
	toolBudgetBlocked?: boolean;
	sessionFile?: string;
	intercomTarget?: string;
	model?: string;
	thinking?: string;
	attemptedModels?: string[];
	modelAttempts?: ModelAttempt[];
	/** True when the dispatch failed because the input exceeded the model's context window. */
	contextOverflow?: boolean;
	totalCost?: CostSummary;
	artifactPaths?: ArtifactPaths;
	outputSaveError?: string;
	metadataSaveError?: string;
	truncated?: boolean;
	transcriptPath?: string;
	transcriptError?: string;
	agentContract?: import("../../shared/types.ts").AgentContract;
	launchContractDigest?: string;
	execution?: import("../../shared/types.ts").ExecutionProjection;
	review?: import("../../shared/types.ts").ReviewProjection;
	effects?: import("../../shared/types.ts").EffectsProjection;
	structuredOutput?: unknown;
	structuredOutputPath?: string;
	structuredOutputSchemaPath?: string;
	acceptance?: import("../../shared/types.ts").AcceptanceLedger;
	watchdog?: import("../../shared/types.ts").ChildWatchdogProgress;
	runner?: ExternalCliRunnerStatus | ExternalJobRunnerStatus;
	externalProcess?: ExternalProcessStatus;
	externalJob?: ExternalJobStatus;
}

function persistStepArtifacts(input: {
	artifactPaths: ArtifactPaths;
	artifactConfig?: Partial<ArtifactConfig>;
	output: string;
	metadata: object;
}): { outputSaveError?: string; metadataSaveError?: string } {
	const errors: { outputSaveError?: string; metadataSaveError?: string } = {};
	if (input.artifactConfig?.includeOutput !== false) {
		try {
			writeArtifact(input.artifactPaths.outputPath, input.output);
		} catch (error) {
			errors.outputSaveError = `Artifact output post-processing failed: ${error instanceof Error ? error.message : String(error)}`;
		}
	}
	if (input.artifactConfig?.includeMetadata !== false) {
		try {
			writeMetadata(input.artifactPaths.metadataPath, input.metadata);
		} catch (error) {
			errors.metadataSaveError = `Artifact metadata post-processing failed: ${error instanceof Error ? error.message : String(error)}`;
		}
	}
	return errors;
}

const ASYNC_INTERRUPT_SIGNAL: NodeJS.Signals = process.platform === "win32" ? "SIGBREAK" : "SIGUSR2";
const DEFAULT_MAX_ASYNC_EVENTS_BYTES = 50 * 1024 * 1024;
const ASYNC_EVENTS_MAX_BYTES_ENV = "PI_SUBAGENT_ASYNC_EVENTS_MAX_BYTES";
const TRUNCATED_EVENT_TYPE = "subagent.events.truncated";
const TRUNCATION_MARKER_RESERVE_BYTES = 512;

interface AsyncEventLogState {
	bytes: number;
	diagnosticsTruncated: boolean;
}

const asyncEventLogStates = new Map<string, AsyncEventLogState>();

function maxAsyncEventsBytes(): number {
	const raw = process.env[ASYNC_EVENTS_MAX_BYTES_ENV];
	if (!raw) return DEFAULT_MAX_ASYNC_EVENTS_BYTES;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_MAX_ASYNC_EVENTS_BYTES;
	return Math.floor(parsed);
}

function eventLogState(filePath: string): AsyncEventLogState {
	let state = asyncEventLogStates.get(filePath);
	if (state) return state;
	let bytes = 0;
	try {
		bytes = fs.statSync(filePath).size;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			// Diagnostic event accounting is best-effort; writes below are also safe.
		}
	}
	state = { bytes, diagnosticsTruncated: false };
	asyncEventLogStates.set(filePath, state);
	return state;
}

function appendJsonl(filePath: string, line: string): void {
	try {
		appendRawJsonl(filePath, line);
		const state = asyncEventLogStates.get(filePath);
		if (state) state.bytes += Buffer.byteLength(`${line}\n`, "utf-8");
	} catch {
		// Async event logging is diagnostic and must not fail the run.
	}
}

function appendDiagnosticJsonl(filePath: string, line: string, droppedEventType?: string): void {
	if (!line.trim()) return;
	const state = eventLogState(filePath);
	if (state.diagnosticsTruncated) return;
	const maxBytes = maxAsyncEventsBytes();
	const chunkBytes = Buffer.byteLength(`${line}\n`, "utf-8");
	const diagnosticBudget = Math.max(0, maxBytes - TRUNCATION_MARKER_RESERVE_BYTES);
	if (state.bytes + chunkBytes <= diagnosticBudget) {
		appendJsonl(filePath, line);
		return;
	}

	const marker = JSON.stringify({
		type: TRUNCATED_EVENT_TYPE,
		ts: Date.now(),
		maxBytes,
		droppedEventType,
	});
	if (state.bytes + Buffer.byteLength(`${marker}\n`, "utf-8") <= maxBytes) {
		appendJsonl(filePath, marker);
	}
	state.diagnosticsTruncated = true;
}

function isBlockingSupervisorTool(toolName: string | undefined, args: unknown): boolean {
	if (!args || typeof args !== "object" || Array.isArray(args)) return false;
	if (toolName === "contact_supervisor") {
		const reason = (args as Record<string, unknown>).reason;
		return reason === "need_decision" || reason === "interview_request";
	}
	return toolName === "intercom" && (args as Record<string, unknown>).action === "ask";
}

function findLatestSessionFile(sessionDir: string): string | null {
	try {
		const files = fs
			.readdirSync(sessionDir)
			.filter((f) => f.endsWith(".jsonl"))
			.map((f) => path.join(sessionDir, f));
		if (files.length === 0) return null;
		files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
		return files[0] ?? null;
	} catch {
		// Session lookup is optional metadata.
		return null;
	}
}

function emptyUsage(): Usage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
}

function tokenUsageFromAttempts(attempts: ModelAttempt[] | undefined): TokenUsage | null {
	if (!attempts || attempts.length === 0) return null;
	let input = 0;
	let output = 0;
	for (const attempt of attempts) {
		input += attempt.usage?.input ?? 0;
		output += attempt.usage?.output ?? 0;
	}
	const total = input + output;
	return total > 0 ? { input, output, total } : null;
}

function costSummaryFromAttempts(attempts: ModelAttempt[] | undefined): CostSummary | undefined {
	if (!attempts || attempts.length === 0) return undefined;
	let inputTokens = 0;
	let outputTokens = 0;
	let costUsd = 0;
	for (const attempt of attempts) {
		inputTokens += attempt.usage?.input ?? 0;
		outputTokens += attempt.usage?.output ?? 0;
		costUsd += attempt.usage?.cost ?? 0;
	}
	return inputTokens > 0 || outputTokens > 0 || costUsd > 0
		? { inputTokens, outputTokens, costUsd }
		: undefined;
}

function usageFromAttempts(attempts: ModelAttempt[] | undefined): Usage | undefined {
	if (!attempts || attempts.length === 0) return undefined;
	const usage = emptyUsage();
	for (const attempt of attempts) {
		if (!attempt.usage) continue;
		usage.input += attempt.usage.input;
		usage.output += attempt.usage.output;
		usage.cacheRead += attempt.usage.cacheRead;
		usage.cacheWrite += attempt.usage.cacheWrite;
		usage.cost += attempt.usage.cost;
		usage.turns += attempt.usage.turns;
	}
	return usage.input !== 0 || usage.output !== 0 || usage.cacheRead !== 0 || usage.cacheWrite !== 0 || usage.cost !== 0 || usage.turns !== 0
		? usage
		: undefined;
}

function appendRecentStepOutput(step: RunnerStatusStep, lines: string[]): void {
	const nonEmpty = lines.filter((line) => line.trim());
	if (nonEmpty.length === 0) return;
	step.recentOutput ??= [];
	step.recentOutput.push(...nonEmpty);
	if (step.recentOutput.length > 50) {
		step.recentOutput.splice(0, step.recentOutput.length - 50);
	}
}

type UndefinedOmitted<T extends object> = {
	[K in keyof T]: Exclude<T[K], undefined>;
};

function omitUndefinedProperties<const T extends object>(value: T): UndefinedOmitted<T> {
	for (const key in value) {
		if (value[key] === undefined) delete value[key];
	}
	return value as UndefinedOmitted<T>;
}

type WithUndefinedOptionals<T extends object> = {
	[K in keyof T]: {} extends Pick<T, K> ? T[K] | undefined : T[K];
};

type RequiredKeysAllowingUndefined<T extends object> = {
	[K in keyof T]-?: {} extends Pick<T, K> ? never : undefined extends T[K] ? K : never;
}[keyof T];

function compactOptional<T extends object>(
	value: WithUndefinedOptionals<T> & (RequiredKeysAllowingUndefined<T> extends never ? unknown : never),
): T {
	for (const key of Object.keys(value) as Array<keyof T>) {
		if (value[key] === undefined) delete value[key];
	}
	return value as T;
}

function setOptionalProperty<T extends object, K extends keyof T>(target: T, key: K, value: T[K]): void {
	if (value === undefined) delete target[key];
	else target[key] = value;
}

function resetStepLiveDetail(step: RunnerStatusStep): void {
	delete step.currentTool;
	delete step.currentToolArgs;
	delete step.currentToolStartedAt;
	delete step.currentPath;
	step.recentTools = [];
	step.recentOutput = [];
}

const MAX_CHILD_FAILURE_DIAGNOSTIC_CHARS = 8_192;

function formatRequiredOutputError(requiredOutput: {
	kind: "file-only" | "structured";
	path: string;
	missing: boolean;
} | undefined): string | undefined {
	if (!requiredOutput?.missing) return undefined;
	return `Required ${requiredOutput.kind} output was not produced: ${requiredOutput.path.slice(0, 2_048)}`;
}

function formatChildFailureDiagnostic(input: {
	error: string | undefined;
	afterCompactionSettlement?: boolean;
	abortRecoveryDiagnostic?: string;
	requiredOutput?: {
		kind: "file-only" | "structured";
		path: string;
		missing: boolean;
	};
}): string | undefined {
	const missingOutput = formatRequiredOutputError(input.requiredOutput);
	const notes = [
		input.abortRecoveryDiagnostic,
		input.afterCompactionSettlement ? "Child failure followed session compaction and agent settlement." : undefined,
		missingOutput && input.error !== missingOutput ? missingOutput : undefined,
	].filter((note): note is string => Boolean(note));
	if (notes.length === 0) return input.error;
	const context = notes.join("\n");
	const errorLimit = MAX_CHILD_FAILURE_DIAGNOSTIC_CHARS - (context ? context.length + 1 : 0);
	const baseError = input.error || "Subagent failed.";
	return `${baseError.slice(0, Math.max(0, errorLimit))}${context ? `\n${context}` : ""}`;
}

function resolvePiPackageRootFallback(): string {
	const root = resolveInstalledPiPackageRoot();
	if (root) return root;
	throw new Error(`Could not resolve ${PI_CODING_AGENT_PACKAGE} package root`);
}

async function exportSessionHtml(sessionFile: string, outputDir: string, piPackageRoot?: string): Promise<string> {
	const pkgRoot = piPackageRoot ?? resolvePiPackageRootFallback();
	const exportModulePath = path.join(pkgRoot, "dist", "core", "export-html", "index.js");
	const moduleUrl = pathToFileURL(exportModulePath).href;
	const mod = await import(moduleUrl);
	const exportFromFile = (mod as { exportFromFile?: (inputPath: string, options?: { outputPath?: string }) => string })
		.exportFromFile;
	if (typeof exportFromFile !== "function") {
		throw new Error("exportFromFile not available");
	}
	const outputPath = path.join(outputDir, `${path.basename(sessionFile, ".jsonl")}.html`);
	return exportFromFile(sessionFile, { outputPath });
}

function createShareLink(htmlPath: string): { shareUrl: string; gistUrl: string } | { error: string } {
	try {
		const auth = spawnSync("gh", ["auth", "status"], { encoding: "utf-8", windowsHide: true });
		if (auth.status !== 0) {
			return { error: "GitHub CLI is not logged in. Run 'gh auth login' first." };
		}
	} catch {
		return { error: "GitHub CLI (gh) is not installed." };
	}

	try {
		const result = spawnSync("gh", ["gist", "create", htmlPath], { encoding: "utf-8", windowsHide: true });
		if (result.status !== 0) {
			const err = (result.stderr || "").trim() || "Failed to create gist.";
			return { error: err };
		}
		const gistUrl = (result.stdout || "").trim();
		const gistId = gistUrl.split("/").pop();
		if (!gistId) return { error: "Failed to parse gist ID." };
		const shareUrl = `https://shittycodingagent.ai/session/?${gistId}`;
		return { shareUrl, gistUrl };
	} catch (err) {
		return { error: String(err) };
	}
}

function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
	const minutes = Math.floor(ms / 60000);
	const seconds = Math.floor((ms % 60000) / 1000);
	return `${minutes}m${seconds}s`;
}

function writeRunLog(
	logPath: string,
	input: {
		id: string;
		mode: SubagentRunMode;
		cwd: string;
		startedAt: number;
		endedAt: number;
		steps: Array<{
			agent: string;
			status: string;
			durationMs?: number;
		}>;
		summary: string;
		truncated: boolean;
		artifactsDir?: string;
		sessionFile?: string;
		shareUrl?: string;
		shareError?: string;
	},
	write: (filePath: string, content: string) => void = (filePath, content) => fs.writeFileSync(filePath, content, "utf-8"),
): void {
	const lines: string[] = [];
	lines.push(`# Subagent run ${input.id}`);
	lines.push("");
	lines.push(`- **Mode:** ${input.mode}`);
	lines.push(`- **CWD:** ${input.cwd}`);
	lines.push(`- **Started:** ${new Date(input.startedAt).toISOString()}`);
	lines.push(`- **Ended:** ${new Date(input.endedAt).toISOString()}`);
	lines.push(`- **Duration:** ${formatDuration(input.endedAt - input.startedAt)}`);
	if (input.sessionFile) lines.push(`- **Session:** ${input.sessionFile}`);
	if (input.shareUrl) lines.push(`- **Share:** ${input.shareUrl}`);
	if (input.shareError) lines.push(`- **Share error:** ${input.shareError}`);
	if (input.artifactsDir) lines.push(`- **Artifacts:** ${input.artifactsDir}`);
	lines.push("");
	lines.push("## Steps");
	lines.push("| Step | Agent | Status | Duration |");
	lines.push("| --- | --- | --- | --- |");
	input.steps.forEach((step, i) => {
		const duration = step.durationMs !== undefined ? formatDuration(step.durationMs) : "-";
		lines.push(`| ${i + 1} | ${step.agent} | ${step.status} | ${duration} |`);
	});
	lines.push("");
	lines.push("## Summary");
	if (input.truncated) {
		lines.push("_Output truncated_");
		lines.push("");
	}
	lines.push(input.summary.trim() || "(no output)");
	lines.push("");
	write(logPath, lines.join("\n"));
}

/** Context for running a single step */
interface SingleStepContext {
	previousOutput: string;
	outputs?: ChainOutputMap;
	placeholder: string;
	cwd: string;
	sessionEnabled: boolean;
	sessionDir?: string;
	artifactsDir?: string;
	artifactConfig?: Partial<ArtifactConfig>;
	id: string;
	flatIndex: number;
	flatStepCount: number;
	outputFile: string;
	transcriptPath?: string;
	piPackageRoot?: string;
	/** Factory the runner creates this step's child session through. */
	childSessions: ChildSessionFactory;
	/** The launching executor's own child runtime; nested route, depth, and ceilings come from here. */
	inheritedChildRuntime?: InheritedChildRuntime;
	registerInterrupt?: (interrupt: (() => void) | undefined) => void;
	registerTimeout?: (interrupt: (() => void) | undefined) => void;
	registerStop?: (stop: (() => void) | undefined) => void;
	/** Receives the live child's steer handler while its session runs. */
	registerSteer?: (steer: StepSteerHandler | undefined) => void;
	timeoutSignal?: AbortSignal;
	stopSignal?: AbortSignal;
	timeoutMessage?: string;
	stopMessage?: string;
	/** Resolved configured hard per-tool-call timeout (ms); fast tools still have a default when undefined. */
	toolTimeoutMs?: number;
	/** Effective step deadline (Date.now() + effective timeout) when a run budget exists. */
	deadlineAt?: number;
	childIntercomTarget?: string;
	orchestratorIntercomTarget?: string;
	nestedRoute?: NestedRouteInfo;
	capabilityCeiling?: ResolvedSubagentCapabilityCeiling;
	runFanoutBudget?: RunFanoutBudgetDescriptor;
	onAttemptStart?: (attempt: { model?: string; thinking?: string; contextLimit?: number }) => void;
	onChildEvent?: (event: ChildEvent) => void;
	onExternalProcess?: (process: ExternalProcessStatus) => void;
	onExternalJob?: (status: ExternalJobStatus) => void;
	skipAcceptance?: () => boolean;
	usageBudgetExhausted?: () => boolean;
	/** False when sibling work in the same Git worktree could have caused the tracked diff. */
	trackedMutationEvidenceForCompletionGuard?: boolean;
	orcaProgressTab?: OrcaProgressTab;
}

/** Run a single pi agent step, returning output and metadata */
async function runSingleStepInner(
	step: SubagentStep,
	ctx: SingleStepContext,
): Promise<StepResult & { completionGuardTriggered?: boolean }> {
	if (step.importAsyncRoot) {
		let importTimedOut = false;
		let importStopped = false;
		ctx.registerTimeout?.(() => {
			importTimedOut = true;
			let pid: number | undefined;
			try {
				pid = readStatus(step.importAsyncRoot!.asyncDir)?.pid;
			} catch {
				pid = undefined;
			}
			try {
				deliverTimeoutRequest(omitUndefinedProperties({ asyncDir: step.importAsyncRoot!.asyncDir, pid, source: "ancestor-timeout" }));
			} catch {
				// The parent runner's own timeout result is authoritative for the attached step.
			}
		});
		ctx.registerStop?.(() => {
			importStopped = true;
			let pid: number | undefined;
			try {
				pid = readStatus(step.importAsyncRoot!.asyncDir)?.pid;
			} catch {
				pid = undefined;
			}
			try {
				deliverStopRequest(omitUndefinedProperties({ asyncDir: step.importAsyncRoot!.asyncDir, pid, source: "ancestor-stop" }));
			} catch {
				// The parent runner's own stopped result is authoritative for the attached step.
			}
		});
		try {
			const imported = await waitForImportedAsyncRoot(step.importAsyncRoot, omitUndefinedProperties({
				shouldAbort: () => importTimedOut || importStopped || ctx.timeoutSignal?.aborted === true || ctx.stopSignal?.aborted === true || ctx.skipAcceptance?.() === true,
				timeoutMessage: importStopped || ctx.stopSignal?.aborted === true ? ctx.stopMessage : ctx.timeoutMessage,
			}));
			try {
				fs.writeFileSync(ctx.outputFile, imported.output, "utf-8");
			} catch {
				// Output files are observability only for imported roots.
			}
			const stopped = importStopped || imported.stopped === true || ctx.stopSignal?.aborted === true;
			const timedOut = !stopped && (importTimedOut || imported.timedOut === true || ctx.timeoutSignal?.aborted === true || ctx.skipAcceptance?.() === true);
			const message = stopped ? ctx.stopMessage ?? "Subagent stopped by user." : ctx.timeoutMessage ?? "Subagent timed out.";
			return omitUndefinedProperties({
				agent: imported.agent,
				output: timedOut || stopped ? message : imported.output,
				exitCode: timedOut || stopped ? 1 : imported.exitCode,
				error: timedOut || stopped ? message : imported.error,
				timedOut: timedOut ? true : undefined,
				stopped: stopped ? true : undefined,
				sessionFile: imported.sessionFile,
				intercomTarget: imported.intercomTarget,
				model: imported.model,
				attemptedModels: imported.attemptedModels,
				modelAttempts: imported.modelAttempts,
				contextOverflow: imported.contextOverflow,
				totalCost: imported.totalCost,
				usage: imported.usage,
				structuredOutput: timedOut || stopped ? undefined : imported.structuredOutput,
				structuredOutputPath: timedOut || stopped ? undefined : imported.structuredOutputPath,
				structuredOutputSchemaPath: timedOut || stopped ? undefined : imported.structuredOutputSchemaPath,
				acceptance: timedOut || stopped ? undefined : imported.acceptance,
				execution: timedOut || stopped ? undefined : imported.execution,
				effects: timedOut || stopped ? undefined : imported.effects,
			});
		} finally {
			ctx.registerTimeout?.(undefined);
			ctx.registerStop?.(undefined);
		}
	}

	const effectiveStructuredOutput = step.structuredOutput ?? (step.structuredOutputSchema
		? createStructuredOutputRuntime(step.structuredOutputSchema, path.join(path.dirname(ctx.outputFile), "structured-output"), { acceptanceReport: resolveAcceptanceReportMode(step.acceptanceInput) })
		: undefined);
	const placeholderRegex = new RegExp(ctx.placeholder.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g");
	let task = step.task.replace(placeholderRegex, () => ctx.previousOutput);
	if (ctx.outputs) task = resolveOutputReferences(task, ctx.outputs);
	const taskForCompletionGuard = task;
	let resolvedTaskToolPlan: ReturnType<typeof resolvePiLaunchToolPlan> | undefined;
	if (!step.runner) {
		resolvedTaskToolPlan = resolvePiLaunchToolPlan(omitUndefinedProperties({
			tools: step.tools,
			excludeTools: step.excludeTools,
			allowNestedSubagents: step.allowNestedSubagents,
			extensions: step.extensions,
			subagentOnlyExtensions: step.subagentOnlyExtensions,
			fast: step.fast,
			model: step.model,
			modelCandidates: step.modelCandidates,
			mcpDirectTools: step.mcpDirectTools,
			cwd: step.cwd ?? ctx.cwd,
			requireReadTool: Boolean(step.skills?.length),
			structuredOutput: Boolean(effectiveStructuredOutput),
			capabilityCeiling: step.capabilityCeiling ?? ctx.capabilityCeiling,
			inheritedCapabilityCeiling: ctx.inheritedChildRuntime?.capabilityCeiling,
			permissionRules: step.permissionRules,
		}));
		const contractTools = resolvedTaskToolPlan.explicitToolAllowlist ? resolvedTaskToolPlan.effectiveToolAllowlist : undefined;
		const contractError = validateImplementationToolContract({
			agent: step.agent,
			task: taskForCompletionGuard,
			tools: contractTools,
			mcpDirectTools: resolvedTaskToolPlan.effectiveMcpTools,
			configuredExtensions: resolvedTaskToolPlan.configuredExtensions,
			requestedTools: resolvedTaskToolPlan.requestedBuiltinTools,
			acceptanceRole: step.acceptanceRole,
			completionGuard: step.completionGuard,
		});
		if (contractError) {
			return omitUndefinedProperties({
				agent: step.agent,
				context: step.context,
				output: contractError,
				error: contractError,
				exitCode: 1,
				capabilityCeiling: resolvedTaskToolPlan.capabilityCeiling,
				capabilityAudit: resolvedTaskToolPlan.capabilityAudit,
			});
		}
	}
	// Derive from the pre-acceptance task so internal acceptance/recovery
	// instructions never leak into the display name.
	const childSessionName = step.sessionName ?? deriveChildSessionName({ agent: step.agent, task, label: step.label });
	if (step.effectiveAcceptance) {
		const acceptancePrompt = formatAcceptancePrompt(step.effectiveAcceptance, { reportOptional: isAgentContract(step.agentContract), structuredOutput: Boolean(step.structuredOutput?.acceptanceReportPath) });
		if (acceptancePrompt) task = `${task}\n${acceptancePrompt}`;
	}
	const sessionEnabled = Boolean(step.sessionFile) || ctx.sessionEnabled;
	const sessionDir = step.sessionFile ? undefined : ctx.sessionDir;

	let artifactPaths: ArtifactPaths | undefined;
	let transcriptWriter: ChildTranscriptWriter | undefined;
	if (ctx.artifactsDir && ctx.artifactConfig?.enabled !== false) {
		const index = ctx.flatStepCount > 1 ? ctx.flatIndex : undefined;
		artifactPaths = getArtifactPaths(ctx.artifactsDir, ctx.id, step.agent, index);
		fs.mkdirSync(ctx.artifactsDir, { recursive: true });
		if (ctx.artifactConfig?.includeInput !== false) {
			fs.writeFileSync(artifactPaths.inputPath, `# Task for ${step.agent}\n\n${PROMPT_REDACTED}; live Prompt Audit only.\n`, "utf-8");
		}
		if (ctx.artifactConfig?.includeTranscript !== false) {
			transcriptWriter = createChildTranscriptWriter({
				transcriptPath: artifactPaths.transcriptPath,
				source: "async",
				runId: ctx.id,
				agent: step.agent,
				childIndex: ctx.flatIndex,
				cwd: step.cwd ?? ctx.cwd,
			});
		}
	}
	transcriptWriter?.writeInitialUserMessage(`${PROMPT_REDACTED}; live Prompt Audit only.`);

	if (step.runner?.type === "external-cli") {
		const externalCwd = step.cwd ?? ctx.cwd;
		const adapterLaunch = step.runner.adapter === "codex-exec" || step.runner.adapter === "codex-exec-writer"
			? resolveCodexExecLaunch({ adapter: step.runner.adapter, command: step.runner.command, asyncDir: path.dirname(ctx.outputFile), stepIndex: ctx.flatIndex })
			: step.runner.adapter === "claude-code" || step.runner.adapter === "claude-code-writer"
				? resolveClaudeCodeLaunch({ adapter: step.runner.adapter, command: step.runner.command })
				: step.runner.adapter === "cursor-agent" || step.runner.adapter === "cursor-agent-writer"
					? resolveCursorAgentLaunch({ adapter: step.runner.adapter, command: step.runner.command, cwd: externalCwd, asyncDir: path.dirname(ctx.outputFile), stepIndex: ctx.flatIndex })
				: undefined;
		const runner = resolveExternalCliRunnerStatus({ ...step.runner, ...(adapterLaunch ? { args: adapterLaunch.args } : {}) });
		const outputSnapshot = captureSingleOutputSnapshot(step.outputPath);
		const external = await runExternalCli(omitUndefinedProperties({
			command: adapterLaunch?.command ?? runner.command,
			args: adapterLaunch?.args ?? runner.args,
			cwd: externalCwd,
			prompt: buildExternalCliPrompt(step.systemPrompt ?? "", task),
			asyncDir: path.dirname(ctx.outputFile),
			stepIndex: ctx.flatIndex,
			environment: adapterLaunch?.environment,
			preflight: adapterLaunch?.preflight,
			parser: adapterLaunch?.parser,
			finalOutputPath: adapterLaunch?.finalOutputPath,
			promptFilePath: adapterLaunch?.promptFilePath,
			temporaryDirectories: adapterLaunch?.temporaryDirectories,
			registerTimeout: ctx.registerTimeout,
			registerStop: ctx.registerStop,
			timeoutMessage: ctx.timeoutMessage,
			stopMessage: ctx.stopMessage,
			onProcess: ctx.onExternalProcess,
			onStdout: (chunk) => ctx.orcaProgressTab?.append(chunk.toString("utf-8")),
			onStderr: (chunk) => ctx.orcaProgressTab?.append(chunk.toString("utf-8")),
		}));
		try { fs.writeFileSync(ctx.outputFile, external.output, "utf-8"); } catch { /* Observability output is best-effort. */ }
		const resolvedOutput = step.outputPath && external.exitCode === 0
			? resolveSingleOutput(step.outputPath, external.output, outputSnapshot, step.outputClaimPath)
			: { fullOutput: external.output };
		const outputReference = resolvedOutput.savedPath ? formatSavedOutputReference(resolvedOutput.savedPath, resolvedOutput.fullOutput) : undefined;
		const exitCode = resolvedOutput.fatalError ? 1 : external.exitCode;
		const error = resolvedOutput.fatalError && resolvedOutput.saveError
			? external.error ? `${external.error}\n${resolvedOutput.saveError}` : resolvedOutput.saveError
			: external.error;
		const finalizedOutput = finalizeSingleOutput(omitUndefinedProperties({
			fullOutput: resolvedOutput.fullOutput,
			outputPath: step.outputPath,
			outputMode: step.outputMode,
			exitCode: exitCode ?? 1,
			savedPath: resolvedOutput.savedPath,
			outputReference,
			saveError: resolvedOutput.saveError,
		}));
		const artifactErrors = artifactPaths && ctx.artifactConfig?.enabled !== false
			? persistStepArtifacts({
				artifactPaths,
				artifactConfig: ctx.artifactConfig,
				output: formatOutputArtifactContent(omitUndefinedProperties({ output: resolvedOutput.fullOutput, error: external.error, metadataPath: ctx.artifactConfig?.includeMetadata === false ? undefined : artifactPaths.metadataPath })),
				metadata: { runId: ctx.id, agent: step.agent, task: PROMPT_REDACTED, runner, externalProcess: external.externalProcess, exitCode: external.exitCode, error: external.error, timestamp: Date.now() },
			})
			: {};
		return omitUndefinedProperties({
			agent: step.agent,
			...(childSessionName ? { sessionName: childSessionName } : {}),
			context: step.context,
			output: finalizedOutput.displayOutput,
			outputState: external.output.trim() ? "present" : "absent",
			exitCode,
			error,
			timedOut: external.timedOut,
			stopped: external.stopped,
			processSignal: external.processSignal,
			artifactPaths,
			outputSaveError: [resolvedOutput.saveError, artifactErrors.outputSaveError].filter(Boolean).join("\n") || undefined,
			metadataSaveError: artifactErrors.metadataSaveError,
			runner,
			externalProcess: external.externalProcess,
		});
	}

	if (step.runner?.type === "external-job") {
		const runner: ExternalJobRunnerStatus = {
			type: "external-job",
			provider: step.runner.provider,
			options: step.runner.options ?? {},
			capabilities: { stop: false, steer: false, resume: false, structuredOutput: false, toolEvents: false },
		};
		const outputSnapshot = captureSingleOutputSnapshot(step.outputPath);
		const external = await runExternalJob(omitUndefinedProperties({
			provider: runner.provider,
			options: runner.options,
			cwd: step.cwd ?? ctx.cwd,
			prompt: buildExternalCliPrompt(step.systemPrompt ?? "", task),
			asyncDir: path.dirname(ctx.outputFile),
			stepIndex: ctx.flatIndex,
			runId: ctx.id,
			agent: step.agent,
			sessionId: step.parentSessionId,
			registerTimeout: ctx.registerTimeout,
			registerStop: ctx.registerStop,
			timeoutMessage: ctx.timeoutMessage,
			stopMessage: ctx.stopMessage,
			onExternalJob: ctx.onExternalJob,
			followUp: step.externalJobFollowUp,
		}));
		try { fs.writeFileSync(ctx.outputFile, external.output, "utf-8"); } catch { /* Observability output is best-effort. */ }
		const resolvedOutput = step.outputPath && external.exitCode === 0
			? resolveSingleOutput(step.outputPath, external.output, outputSnapshot, step.outputClaimPath)
			: { fullOutput: external.output };
		const outputReference = resolvedOutput.savedPath ? formatSavedOutputReference(resolvedOutput.savedPath, resolvedOutput.fullOutput) : undefined;
		const exitCode = resolvedOutput.fatalError ? 1 : external.exitCode;
		const error = resolvedOutput.fatalError && resolvedOutput.saveError
			? external.error ? `${external.error}\n${resolvedOutput.saveError}` : resolvedOutput.saveError
			: external.error;
		const finalizedOutput = finalizeSingleOutput(omitUndefinedProperties({
			fullOutput: resolvedOutput.fullOutput,
			outputPath: step.outputPath,
			outputMode: step.outputMode,
			exitCode: exitCode ?? 1,
			savedPath: resolvedOutput.savedPath,
			outputReference,
			saveError: resolvedOutput.saveError,
		}));
		const artifactErrors = artifactPaths && ctx.artifactConfig?.enabled !== false
			? persistStepArtifacts({
				artifactPaths,
				artifactConfig: ctx.artifactConfig,
				output: formatOutputArtifactContent(omitUndefinedProperties({ output: resolvedOutput.fullOutput, error: external.error, metadataPath: ctx.artifactConfig?.includeMetadata === false ? undefined : artifactPaths.metadataPath })),
				metadata: { runId: ctx.id, agent: step.agent, task: PROMPT_REDACTED, runner, externalJob: external.externalJob, exitCode: external.exitCode, error: external.error, timestamp: Date.now() },
			})
			: {};
		return omitUndefinedProperties({
			agent: step.agent,
			...(childSessionName ? { sessionName: childSessionName } : {}),
			context: step.context,
			output: finalizedOutput.displayOutput,
			outputState: external.output.trim() ? "present" : "absent",
			exitCode,
			error,
			timedOut: external.timedOut,
			stopped: external.stopped,
			artifactPaths,
			outputSaveError: [resolvedOutput.saveError, artifactErrors.outputSaveError].filter(Boolean).join("\n") || undefined,
			metadataSaveError: artifactErrors.metadataSaveError,
			runner,
			externalJob: external.externalJob,
		});
	}

	const effectiveCwd = step.cwd ?? ctx.cwd;
	const cwdError = preflightLaunchCwd(step.requestedCwd ?? effectiveCwd, effectiveCwd);
	if (cwdError) return { agent: step.agent, output: cwdError, error: cwdError, exitCode: 1, context: step.context };
	if (step.context === "fork" && step.sessionFile && fs.existsSync(step.sessionFile)) {
		alignForkedSessionCwd(step.sessionFile, effectiveCwd);
	}

	const candidates = step.modelCandidates !== undefined
		? step.modelCandidates.length > 0 ? step.modelCandidates : [undefined]
		: step.model
			? [step.model]
			: [undefined];
	const attemptedModels: string[] = [];
	let capabilityAudit: import("../shared/capability-ceiling.ts").SubagentCapabilityAudit | undefined;
	let launchResolvedExtensions = step.launchResolvedExtensions;
	const modelAttempts: ModelAttempt[] = [];
	const attemptNotes: string[] = [];
	let finalRequiredOutputMissing: boolean | undefined;
	const eventsPath = path.join(path.dirname(ctx.outputFile), "events.jsonl");
	let finalResult: RunChildSessionResult | undefined;
	let finalOutputSnapshot: SingleOutputSnapshot | undefined;
	let structuredAcceptanceReport: unknown;
	let structuredAcceptanceReportError: string | undefined;
	let completionGuardTriggeredFinal = false;
	let toolBudget = step.toolBudget ? initialToolBudgetState(step.toolBudget) : undefined;
	let toolBudgetBlocked = false;
	let actualLaunchContractDigest = step.launchContractDigest;
	const mutationSnapshot = snapshotTrackedMutations(step.cwd ?? ctx.cwd);
	let finalMutationEvidence = collectTrackedMutationEvidence(mutationSnapshot, step.cwd ?? ctx.cwd);

	let modelIndex = 0;
	let contextOverflow = false;
	let launchWarningsEmitted = false;
	let abortRecoveryAttempted = false;
	let nextAttemptTask = task;
	modelAttemptsLoop: while (modelIndex < candidates.length) {
		if (ctx.timeoutSignal?.aborted || ctx.stopSignal?.aborted || ctx.skipAcceptance?.()) break;
		const recoveringAbort = abortRecoveryAttempted;
		const attemptTask = nextAttemptTask;
		const candidate = candidates[modelIndex];
		const expectedModelForVerification = candidate && !(step.skipPrimaryModelVerification && modelIndex === 0) ? candidate : undefined;
		try {
			assertThinkingWithinCeiling({ model: candidate, configThinking: step.thinking, ceiling: step.thinkingCeiling, agent: step.agent, runId: ctx.id });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return omitUndefinedProperties({ agent: step.agent, output: message, error: message, exitCode: 1, context: step.context, thinkingCeiling: step.thinkingCeiling });
		}
		ctx.onAttemptStart?.(omitUndefinedProperties({
			model: candidate,
			thinking: resolveEffectiveThinking(candidate, step.thinking),
			contextLimit: findModelInfo(candidate, step.modelVerificationRegistry)?.contextWindow,
		}));
		const outputSnapshot = captureSingleOutputSnapshot(step.outputPath);
		if (effectiveStructuredOutput) {
			const cleanupError = clearStructuredOutputCaptures(effectiveStructuredOutput);
			if (cleanupError) {
				return omitUndefinedProperties({ agent: step.agent, output: cleanupError, error: cleanupError, exitCode: 1, context: step.context });
			}
		}
		const watchdogConfig = resolveWatchdogConfig(step.cwd ?? ctx.cwd);
		const extensionBindings = normalizeExtensionBindings(step.extensionBindings)?.value;
		const childWatchdog = watchdogConfig.ok
			? resolveChildWatchdogConfig({
				config: watchdogConfig.config,
				agent: step.agent,
				runId: ctx.id,
				childIndex: ctx.flatIndex,
			})
			: undefined;
		let watchdogSink: ((event: ChildWatchdogStatusEvent) => void) | undefined;
		const launch = buildInProcessChildLaunch(omitUndefinedProperties({
			parentSessionId: step.parentSessionId,
			forkCacheKey: step.context === "fork" ? deriveForkPromptCacheKey(step.parentSessionId) : undefined,
			sessionEnabled,
			sessionDir,
			sessionFile: step.sessionFile,
			model: candidate,
			inheritProjectContext: step.inheritProjectContext,
			inheritGlobalContext: step.inheritGlobalContext,
			inheritSkills: step.inheritSkills,
			requireReadTool: Boolean(step.skills?.length),
			tools: step.tools,
			excludeTools: step.excludeTools,
			allowNestedSubagents: step.allowNestedSubagents,
			extensions: step.extensions,
			subagentOnlyExtensions: step.subagentOnlyExtensions,
			fast: step.fast,
			modelCandidates: step.modelCandidates,
			systemPrompt: step.systemPrompt ?? "",
			systemPromptMode: step.systemPromptMode,
			mcpDirectTools: step.mcpDirectTools,
			extensionBindings,
			capabilityCeiling: step.capabilityCeiling ?? ctx.capabilityCeiling,
			cwd: step.cwd ?? ctx.cwd,
			intercomSessionName: ctx.childIntercomTarget,
			sessionName: childSessionName,
			orchestratorIntercomTarget: ctx.orchestratorIntercomTarget,
			runId: ctx.id,
			childAgentName: step.agent,
			childIndex: ctx.flatIndex,
			nestedRoute: ctx.nestedRoute,
			runFanoutBudget: ctx.runFanoutBudget ? {
				...ctx.runFanoutBudget,
				...(step.runFanoutPath ? { parentPath: `${ctx.runFanoutBudget.parentPath ? `${ctx.runFanoutBudget.parentPath}/` : ""}${step.runFanoutPath}` } : {}),
			} : undefined,
			structuredOutput: effectiveStructuredOutput,
			toolBudget: step.toolBudget,
			permissionRules: step.permissionRules,
			permissionAuditPath: step.permissionRules && ctx.artifactsDir
				? path.join(ctx.artifactsDir, "permission-audit", `${ctx.id}-${ctx.flatIndex}.jsonl`)
				: undefined,
			childWatchdog,
			watchdogStatus: (event) => watchdogSink?.(event),
			waitToolEnabled: step.waitToolEnabled,
			waitToolDefaultTimeoutMs: step.waitToolDefaultTimeoutMs,
			thinkingCeiling: step.thinkingCeiling,
			maxSubagentDepth: step.maxSubagentDepth,
			inherited: ctx.inheritedChildRuntime,
			host: "runner",
		}));
		let intentModelContext: Pick<ExtensionContext, "model" | "modelRegistry"> | undefined;
		launch.session.hooks.push({
			name: "pi-subagents:completion-intent",
			factory: (pi) => pi.on("session_start", (_event, childCtx) => {
				// Keep only the attempt's model services. The shared factory runtime
				// outlives child disposal; no live session or auth work is retained here.
				intentModelContext = { model: childCtx.model, modelRegistry: childCtx.modelRegistry };
			}),
		});
		if (effectiveStructuredOutput && launch.config.structuredOutput) {
			// The runner reads the value back from the runtime's files after the run.
			launch.config.structuredOutput.capture = createStructuredOutputFileCapture(effectiveStructuredOutput);
		}
		const { warnings, capabilityAudit: attemptCapabilityAudit } = launch;
		if (!launchWarningsEmitted && warnings.length > 0) {
			for (const warning of warnings) console.warn(`[pi-subagents] ${warning}`);
			launchWarningsEmitted = true;
		}
		if (step.definitionDigest) {
			const toolPlan = resolvedTaskToolPlan ?? resolvePiLaunchToolPlan(omitUndefinedProperties({
				tools: step.tools,
				excludeTools: step.excludeTools,
				allowNestedSubagents: step.allowNestedSubagents,
				extensions: step.extensions,
				subagentOnlyExtensions: step.subagentOnlyExtensions,
				fast: step.fast,
				model: step.model,
				modelCandidates: step.modelCandidates,
				mcpDirectTools: step.mcpDirectTools,
				cwd: step.cwd ?? ctx.cwd,
				requireReadTool: Boolean(step.skills?.length),
				structuredOutput: Boolean(effectiveStructuredOutput),
				capabilityCeiling: step.capabilityCeiling ?? ctx.capabilityCeiling,
				inheritedCapabilityCeiling: ctx.inheritedChildRuntime?.capabilityCeiling,
				permissionRules: step.permissionRules,
			}));
			launchResolvedExtensions = projectLaunchResolvedChildExtensions(toolPlan);
			actualLaunchContractDigest = launchBindingDigest(omitUndefinedProperties({
				definitionDigest: step.definitionDigest,
				task: step.launchBindingTask ?? task,
				...(candidate ? { model: candidate } : {}),
				modelCandidates: candidates as string[],
				...(step.fast !== undefined ? { fast: step.fast } : {}),
				...(resolveEffectiveThinking(candidate, step.thinking) ? { thinking: resolveEffectiveThinking(candidate, step.thinking) } : {}),
				...(step.thinkingCeiling ? { thinkingCeiling: step.thinkingCeiling } : {}),
				systemPrompt: step.systemPrompt ?? "",
				systemPromptMode: step.systemPromptMode,
				inheritProjectContext: step.inheritProjectContext,
				inheritGlobalContext: step.inheritGlobalContext,
				inheritSkills: step.inheritSkills,
				skills: step.skills,
				tools: toolPlan.effectiveToolAllowlist,
				...(toolPlan.excludeTools.length > 0 ? { excludeTools: toolPlan.excludeTools } : {}),
				extensions: toolPlan.extensionArgs,
				mcpDirectTools: toolPlan.effectiveMcpTools,
				...(step.outputPath ? { outputPath: step.outputPath } : {}),
				...(step.outputMode ? { outputMode: step.outputMode } : {}),
				...(step.structuredOutputSchema ? { structuredOutputSchema: step.structuredOutputSchema } : {}),
				...(extensionBindings ? { extensionBindings } : {}),
			}));
		}
		capabilityAudit = attemptCapabilityAudit;
		// Each attempt rewrites the step output log; synchronous appends keep a
		// retried attempt from interleaving with the previous attempt's flush.
		fs.writeFileSync(ctx.outputFile, "", "utf-8");
		const run = await runChildSession(omitUndefinedProperties({
			factory: ctx.childSessions,
			launch,
			prompt: `Task: ${attemptTask}`,
			childWatchdog,
			childEventContext: { runId: ctx.id, stepIndex: ctx.flatIndex, agent: step.agent },
			appendChildEvent: (event) => appendDiagnosticJsonl(eventsPath, JSON.stringify(event), typeof event.type === "string" ? event.type : undefined),
			writeOutputLine: (line) => {
				try {
					fs.appendFileSync(ctx.outputFile, `${line}\n`, "utf-8");
				} catch {
					// The output log is observability only.
				}
				ctx.orcaProgressTab?.append(`${line}\n`);
			},
			registerInterrupt: ctx.registerInterrupt,
			registerTimeout: ctx.registerTimeout,
			registerStop: ctx.registerStop,
			registerSteer: ctx.registerSteer,
			registerWatchdogStatus: (sink) => { watchdogSink = sink; },
			timeoutMessage: ctx.timeoutMessage,
			stopMessage: ctx.stopMessage,
			onChildEvent: ctx.onChildEvent,
			transcriptWriter,
			toolTimeoutMs: ctx.toolTimeoutMs,
			runDeadlineAt: ctx.deadlineAt,
			expectedModelForVerification,
			modelVerificationRegistry: step.modelVerificationRegistry,
			modelResponseAliases: step.modelResponseAliases,
			mutationTools: step.mutationTools,
		}));
		const toolDiagnostic = run.exitCode === 0 && !run.error ? launch.capture.toolDiagnostic() : undefined;
		const toolAvailabilityError = toolDiagnostic ? formatChildToolDiagnostic(toolDiagnostic) : undefined;
		const runtimeAcknowledgedExtensions = launch.capture.runtimeAcknowledgedExtensions();
		const midToolExitError = run.currentTool
			&& isOrdinaryToolForMidToolExit(run.currentTool)
			&& !run.interrupted
			&& !run.timedOut
			&& !run.stopped
			&& !toolAvailabilityError
			? formatMidToolExitError({ toolName: run.currentTool })
			: undefined;

		let structuredOutput: unknown;
		let structuredError: string | undefined;
		let validatedStructuredOutput = false;
		if (effectiveStructuredOutput && run.exitCode === 0 && !run.error && !toolAvailabilityError && !midToolExitError) {
			if (!run.structuredOutputToolInvoked) {
				structuredError = MISSING_STRUCTURED_OUTPUT_CALL_ERROR;
			} else {
				const structured = await readStructuredOutput({
					schema: effectiveStructuredOutput.schema,
					schemaPath: effectiveStructuredOutput.schemaPath,
					outputPath: effectiveStructuredOutput.outputPath,
				});
				if (structured.error) structuredError = structured.error;
				else {
					structuredOutput = structured.value;
					const acceptanceReport = readStructuredOutputAcceptanceReport(effectiveStructuredOutput);
					structuredAcceptanceReport = acceptanceReport.value;
					structuredAcceptanceReportError = acceptanceReport.error;
					validatedStructuredOutput = true;
				}
			}
		}
		const errorMessages = validatedStructuredOutput
			? run.messages.slice(run.structuredOutputMessageStartIndex ?? run.messages.length)
			: run.messages;
		const hiddenError = run.exitCode === 0 && !run.error && !toolAvailabilityError && !structuredError && !midToolExitError
			? detectSubagentError(errorMessages)
			: null;
		const terminalEmptyAfterUsefulWork = !validatedStructuredOutput
			&& hasEmptyTerminalAssistantResponse(run.messages)
			&& (run.toolCount > 0 || Boolean(run.finalOutput.trim()));
		const emptyOutputError = run.exitCode === 0
			&& !run.error
			&& !toolAvailabilityError
			&& !structuredError
			&& !validatedStructuredOutput
			&& (!run.finalOutput.trim() || terminalEmptyAfterUsefulWork)
			&& (!hiddenError?.hasError || hasEmptyTerminalAssistantResponse(run.messages))
			? formatEmptyTerminalAssistantResponseError(run.messages)
			: undefined;
		const completionGuardEnabled = isAgentContract(step.agentContract) ? step.completionGuard === true : step.completionGuard !== false;
		const completionToolPlan = resolvedTaskToolPlan;
		const completionTools = completionToolPlan ? (completionToolPlan.explicitToolAllowlist ? completionToolPlan.effectiveToolAllowlist : undefined) : step.tools;
		const mutationEvidence = collectTrackedMutationEvidence(mutationSnapshot, step.cwd ?? ctx.cwd);
		finalMutationEvidence = mutationEvidence;
		const completionMutationEvidence = ctx.trackedMutationEvidenceForCompletionGuard === false ? undefined : mutationEvidence;
		const completionGuard = run.exitCode === 0 && !run.error && !structuredError && !hiddenError?.hasError && !midToolExitError && !emptyOutputError && completionGuardEnabled
			? evaluateCompletionMutationGuard(omitUndefinedProperties({
				agent: step.agent,
				task: taskForCompletionGuard,
				messages: run.messages,
				tools: completionTools,
				mcpDirectTools: completionToolPlan?.effectiveMcpTools ?? step.mcpDirectTools,
				mutationTools: step.mutationTools,
				toolAvailabilityError,
				mutationEvidence: completionMutationEvidence,
			}))
			: undefined;
		const mutationAttemptObserved = run.observedMutationAttempt === true || completionMutationEvidence?.attemptedMutation === true;
		let arbitration = { triggered: completionGuard?.triggered === true && !mutationAttemptObserved, rescued: false };
		if (arbitration.triggered) {
			const modelContext = intentModelContext;
			arbitration = await arbitrateCompletionGuardRescue({
				guardTriggered: true,
				task: taskForCompletionGuard,
				// Construct lazily too: the shared gate refuses overlength tasks before
				// registry/auth/model work. The child has already shut down normally.
				arbiter: modelContext ? async (task) => createTaskMutationArbiter(modelContext)?.(task) ?? "unavailable" : undefined,
			});
		}
		const completionEvidence = planCompletionEvidence({
			guard: completionGuard,
			guardTriggered: arbitration.triggered,
			arbiterRescued: arbitration.rescued,
			completionGuardEnabled,
			mutationCapable: hasMutationToolCapability(completionTools, completionToolPlan?.effectiveMcpTools ?? step.mcpDirectTools),
			implementationMutationExpected: expectsImplementationMutation(step.agent, taskForCompletionGuard),
			mutationAttemptObserved,
			mutationEvidence: completionMutationEvidence,
			agentContractEnabled: isAgentContract(step.agentContract),
		});
		const finalOutputHasPersistableFileContent = run.exitCode === 0 && !run.error && !emptyOutputError && Boolean(stripAcceptanceReport(run.finalOutput).trim());
		const requiredOutput = step.outputMode === "file-only" && step.outputPath
			? { kind: "file-only" as const, path: step.outputPath, missing: !fs.existsSync(step.outputPath) && !finalOutputHasPersistableFileContent }
			: effectiveStructuredOutput
				? { kind: "structured" as const, path: effectiveStructuredOutput.outputPath, missing: !fs.existsSync(effectiveStructuredOutput.outputPath) }
			: undefined;
		finalRequiredOutputMissing = requiredOutput?.missing;
		const missingRequiredOutputError = formatRequiredOutputError(requiredOutput);
		const missingRequiredOutputAfterMutation = Boolean(missingRequiredOutputError) && (mutationAttemptObserved || Boolean(mutationEvidence.changedFiles.length));
		const effectiveExitCode = toolAvailabilityError || completionEvidence.legacyFailureError || midToolExitError || structuredError || emptyOutputError || missingRequiredOutputError
			? 1
			: hiddenError?.hasError
				? (hiddenError.exitCode ?? 1)
				: run.error && run.exitCode === 0
					? 1
					: run.exitCode;
		const underlyingError = toolAvailabilityError
			?? midToolExitError
			?? structuredError
			?? run.error
			?? emptyOutputError
			?? (missingRequiredOutputAfterMutation ? missingRequiredOutputError : undefined)
			?? (hiddenError?.hasError
				? hiddenError.details
					? `${hiddenError.errorType} failed (exit ${effectiveExitCode}): ${hiddenError.details}`
					: `${hiddenError.errorType} failed with exit code ${effectiveExitCode}`
				: undefined);
		const error = underlyingError ?? missingRequiredOutputError ?? completionEvidence.legacyFailureError;
		const attempt: ModelAttempt = omitUndefinedProperties({
			model: candidate ?? run.model ?? step.model ?? "default",
			success: effectiveExitCode === 0 && !error,
			exitCode: effectiveExitCode,
			error,
			usage: run.usage,
		});
		modelAttempts.push(attempt);
		if (!recoveringAbort && candidate) attemptedModels.push(candidate);
		completionGuardTriggeredFinal = completionEvidence.guardTriggered && !underlyingError && !missingRequiredOutputError;
		finalOutputSnapshot = outputSnapshot;
		if (step.toolBudget) {
			const toolMessages = run.messages.filter((message) => message.role === "toolResult");
			const blockedMessage = toolMessages.find((message) => extractTextFromContent(message.content).includes("Tool budget hard limit reached"));
			toolBudgetBlocked = Boolean(blockedMessage);
			toolBudget = toolBudgetState(step.toolBudget, toolMessages.length, blockedMessage ? (blockedMessage as { toolName?: string }).toolName : undefined);
		}
		const settlementDiagnostic = projectSettlementDiagnostic(completionEvidence, {
			terminalFailed: effectiveExitCode !== 0,
			finalTextPresent: Boolean(stripAcceptanceReport(run.finalOutput).trim()),
			mutationObserved: mutationEvidence.attemptedMutation,
			requiredOutput,
			afterCompactionSettlement: run.afterCompactionSettlement === true,
		});
		const fileMutationEffect = completionEvidence.fileMutation ?? (missingRequiredOutputAfterMutation ? { status: "observed" as const, expected: completionEvidence.mutationExpected, attempted: true, evidence: mutationEvidence } : undefined);
		finalResult = { ...run, exitCode: effectiveExitCode, model: candidate ?? run.model, error, structuredOutput, runtimeAcknowledgedExtensions, ...(step.agentContract ? { agentContract: step.agentContract } : {}), ...(fileMutationEffect || settlementDiagnostic ? { effects: { ...(fileMutationEffect ? { fileMutation: fileMutationEffect } : {}), ...(settlementDiagnostic ? { settlementDiagnostic } : {}) } } : {}) } as RunChildSessionResult;
		const abortRecovery = !attempt.success ? planAbortRecovery({
			messages: run.messages,
			error,
			sessionAvailable: Boolean(step.sessionFile && fs.existsSync(step.sessionFile)),
			alreadyResumed: abortRecoveryAttempted,
			stopped: run.stopped || ctx.stopSignal?.aborted || ctx.skipAcceptance?.(),
			interrupted: run.interrupted,
			timedOut: run.timedOut || ctx.timeoutSignal?.aborted,
			toolBudgetExhausted: run.toolBudgetBlocked || toolBudgetBlocked,
			usageBudgetExhausted: ctx.usageBudgetExhausted?.(),
			structuredOutputFailed: Boolean(structuredError),
			acceptanceFailed: false,
			currentTool: run.currentTool,
			afterCompactionSettlement: run.afterCompactionSettlement,
		}) : undefined;
		if (abortRecovery?.action === "settle" && abortRecovery.diagnostic) {
			attempt.error = attempt.error
				? `${abortRecovery.diagnostic}\n${attempt.error.slice(0, 8_000)}`
				: abortRecovery.diagnostic;
			if (finalResult) finalResult.abortRecoveryDiagnostic = abortRecovery.diagnostic;
		}
		if (run.stopped || run.timedOut || ctx.timeoutSignal?.aborted || ctx.stopSignal?.aborted || ctx.skipAcceptance?.()) break modelAttemptsLoop;
		if (abortRecovery?.action === "settle" && abortRecovery.diagnostic) break modelAttemptsLoop;
		if (attempt.success) break modelAttemptsLoop;
		if (recoveringAbort) break modelAttemptsLoop;
		if (abortRecovery?.action === "resume") {
			abortRecoveryAttempted = true;
			nextAttemptTask = abortRecovery.prompt;
			attemptNotes.push("[abort-recovery] provider/transport abort after useful progress; resuming the retained child session once.");
			continue;
		}
		if (completionEvidence.guardTriggered) break modelAttemptsLoop;

		const retryableModelFailure = isRetryableModelFailureAttempt({ error, messages: run.messages, toolCount: run.toolCount });
		if (retryableModelFailure) recordRetryableModelFailure(candidate ?? run.model ?? step.model, error);
		if (isContextOverflow(error)) {
			contextOverflow = true;
			attemptNotes.push(`[fallback] ${attempt.model} failed: context overflow — the input exceeds this model's context window. Reduce the task input or use a model with a larger context window.`);
			break modelAttemptsLoop;
		}
		if (!retryableModelFailure || modelIndex === candidates.length - 1) break modelAttemptsLoop;
		attemptNotes.push(formatModelAttemptNote(attempt, candidates[modelIndex + 1]));
		modelIndex += 1;
	}

	const rawOutput = finalResult?.finalOutput ?? "";
	const outputForPersistence = stripAcceptanceReport(rawOutput);
	const resolvedOutput = step.outputPath && finalResult?.exitCode === 0
		? resolveSingleOutput(step.outputPath, outputForPersistence, finalOutputSnapshot, step.outputClaimPath)
		: { fullOutput: outputForPersistence };
	if (resolvedOutput.fatalError) {
		if (finalResult) {
			finalResult.exitCode = 1;
			finalResult.error = finalResult.error ? `${finalResult.error}\n${resolvedOutput.saveError}` : resolvedOutput.saveError;
		}
	}
	const output = stripAcceptanceReport(resolvedOutput.fullOutput);
	const outputReference = resolvedOutput.savedPath ? formatSavedOutputReference(resolvedOutput.savedPath, output) : undefined;
	let outputForSummary = output;
	if (attemptNotes.length > 0) {
		outputForSummary = `${attemptNotes.join("\n")}\n\n${outputForSummary}`.trim();
	}
	if (finalResult?.stopped && !outputForSummary.trim()) {
		outputForSummary = ctx.stopMessage ?? "Subagent stopped by user.";
	}
	const outputForAcceptance = rawOutput;
	const childWrittenOutput = step.outputPath
		? extractChildWrittenOutput(finalResult?.messages, step.outputPath, step.cwd ?? ctx.cwd)
		: undefined;
	const outputState: SubagentOutputState = finalResult?.outputState === "present"
		|| (finalResult as (RunChildSessionResult & { structuredOutput?: unknown }) | undefined)?.structuredOutput !== undefined
		|| Boolean(childWrittenOutput?.trim())
		? "present"
		: resolvedOutput.savedPath
			? "unknown"
			: finalResult?.outputState ?? "unknown";
	const timeoutRecovery = finalResult?.timedOut === true || ctx.timeoutSignal?.aborted === true
		? buildTimeoutRecoverySummary({
			termination: "timed-out",
			evidence: finalMutationEvidence,
			requiredOutputMissing: finalRequiredOutputMissing,
			currentTool: finalResult?.currentTool,
			currentToolArgs: finalResult?.currentToolArgs,
			currentPath: finalResult?.currentPath,
			sessionFile: step.sessionFile,
			transcriptPath: transcriptWriter ? artifactPaths?.transcriptPath : undefined,
			artifactPaths,
		})
		: undefined;
	if (timeoutRecovery) outputForSummary = outputForSummary.trim()
		? `${outputForSummary}\n\n${timeoutRecovery.message}`
		: timeoutRecovery.message;
	const finalizedOutput = finalizeSingleOutput(omitUndefinedProperties({
		fullOutput: outputForSummary,
		outputPath: step.outputPath,
		outputMode: step.outputMode,
		exitCode: finalResult?.exitCode ?? 1,
		savedPath: resolvedOutput.savedPath,
		outputReference,
		saveError: resolvedOutput.saveError,
	}));
	outputForSummary = finalizedOutput.displayOutput;
	const acceptance = step.effectiveAcceptance && !finalResult?.stopped && !ctx.timeoutSignal?.aborted && !ctx.stopSignal?.aborted && !ctx.skipAcceptance?.()
		? await evaluateAcceptance(omitUndefinedProperties({
			acceptance: step.effectiveAcceptance,
			output: outputForAcceptance,
			report: structuredAcceptanceReport as import("../../shared/types.ts").AcceptanceReport | undefined,
			reportError: structuredAcceptanceReportError,
			fileOutput: childWrittenOutput !== undefined && step.outputPath
				? { content: childWrittenOutput, path: step.outputPath, authoritative: step.outputMode === "file-only", durable: resolvedOutput.savedPath !== undefined }
				: undefined,
			cwd: step.cwd ?? ctx.cwd,
			signal: combinedAbortSignal([ctx.timeoutSignal, ctx.stopSignal]),
			abortMessage: ctx.stopSignal?.aborted ? ctx.stopMessage ?? "Subagent stopped by user." : ctx.timeoutMessage ?? "Subagent timed out.",
			reportOptional: isAgentContract(step.agentContract),
			artifactsDir: ctx.artifactsDir,
			runId: ctx.id,
			watchdog: finalResult?.watchdog,
		}))
		: undefined;
	const stoppedAfterAcceptance = finalResult?.stopped === true || ctx.stopSignal?.aborted === true;
	const timedOutAfterAcceptance = !stoppedAfterAcceptance && (finalResult?.timedOut === true || ctx.timeoutSignal?.aborted === true);
	const effectiveAcceptance = step.effectiveAcceptance
		? stoppedAfterAcceptance
			? buildSkippedAcceptanceLedger(step.effectiveAcceptance, { id: "stopped", message: "Acceptance was not evaluated because the subagent was stopped." })
			: timedOutAfterAcceptance
				? buildSkippedAcceptanceLedger(step.effectiveAcceptance, { id: "timeout", message: "Acceptance was not evaluated because the subagent timed out." })
				: acceptance
		: undefined;
	const acceptanceFailure = effectiveAcceptance ? acceptanceFailureMessage(effectiveAcceptance) : undefined;
	const acceptanceCanFailRun = acceptanceFailure && effectiveAcceptance?.explicit && (finalResult?.exitCode ?? 1) === 0 && !finalResult?.interrupted && !timedOutAfterAcceptance && !stoppedAfterAcceptance && !isAgentContract(step.agentContract);
	const effectiveFinalExitCode = timedOutAfterAcceptance || stoppedAfterAcceptance ? 1 : acceptanceCanFailRun ? 1 : finalResult?.exitCode ?? 1;
	const intercomDetachReceipt = finalResult?.finalOutput === INTERCOM_DETACH_RECEIPT;
	const baseFinalError = stoppedAfterAcceptance
		? ctx.stopMessage ?? "Subagent stopped by user."
		: timedOutAfterAcceptance
			? finalResult?.error ?? ctx.timeoutMessage ?? "Subagent timed out."
			: acceptanceCanFailRun
					? (finalResult?.error ? `${finalResult.error}\n${acceptanceFailure}` : acceptanceFailure)
					: finalResult?.error ?? (intercomDetachReceipt ? INTERCOM_DETACH_RECEIPT : undefined);
	const effectiveFinalError = formatChildFailureDiagnostic({
		error: baseFinalError,
		afterCompactionSettlement: effectiveFinalExitCode !== 0 ? finalResult?.afterCompactionSettlement : undefined,
		abortRecoveryDiagnostic: effectiveFinalExitCode !== 0 ? finalResult?.abortRecoveryDiagnostic : undefined,
		requiredOutput: effectiveFinalExitCode !== 0 ? finalResult?.effects?.settlementDiagnostic?.requiredOutput : undefined,
	});
	const usage = usageFromAttempts(modelAttempts);

	const artifactErrors = artifactPaths && ctx.artifactConfig?.enabled !== false
		? persistStepArtifacts({
			artifactPaths,
			artifactConfig: ctx.artifactConfig,
			output: formatOutputArtifactContent(omitUndefinedProperties({
				output,
				error: effectiveFinalError,
				transcriptPath: transcriptWriter ? artifactPaths.transcriptPath : undefined,
				metadataPath: ctx.artifactConfig?.includeMetadata === false ? undefined : artifactPaths.metadataPath,
			})),
			metadata: {
				runId: ctx.id,
				agent: step.agent,
				task: PROMPT_REDACTED,
				exitCode: effectiveFinalExitCode,
				model: finalResult?.model,
				attemptedModels: attemptedModels.length > 0 ? attemptedModels : undefined,
				modelAttempts,
				usage,
				error: effectiveFinalError,
				acceptance: effectiveAcceptance,
				...(capabilityAudit ? { capabilityCeiling: capabilityAudit.ceiling, capabilityAudit } : {}),
				launchContractDigest: actualLaunchContractDigest,
				launchResolvedExtensions,
				...((finalResult as (RunChildSessionResult & { runtimeAcknowledgedExtensions?: RuntimeAcknowledgedChildExtensions }) | undefined)?.runtimeAcknowledgedExtensions ? { runtimeAcknowledgedExtensions: (finalResult as RunChildSessionResult & { runtimeAcknowledgedExtensions?: RuntimeAcknowledgedChildExtensions }).runtimeAcknowledgedExtensions } : {}),
				...(transcriptWriter ? { transcriptPath: artifactPaths.transcriptPath } : {}),
				transcriptError: transcriptWriter?.getError(),
				skills: step.skills,
				timestamp: Date.now(),
			},
		})
		: {};

	const result: StepResult & { completionGuardTriggered?: boolean } = omitUndefinedProperties({
		agent: step.agent,
		...(childSessionName ? { sessionName: childSessionName } : {}),
		context: step.context,
		...(step.agentContract ? { agentContract: step.agentContract } : {}),
		launchContractDigest: actualLaunchContractDigest,
		output: outputForSummary,
		outputState,
		exitCode: effectiveFinalExitCode,
		error: effectiveFinalError,
		sessionFile: step.sessionFile,
		intercomTarget: ctx.childIntercomTarget,
		model: finalResult?.model,
		thinking: resolveEffectiveThinking(finalResult?.model, step.thinking),
		attemptedModels: attemptedModels.length > 0 ? attemptedModels : undefined,
		modelAttempts,
		contextOverflow: contextOverflow || undefined,
		totalCost: costSummaryFromAttempts(modelAttempts),
		usage,
		artifactPaths,
		savedOutputPath: finalizedOutput.savedPath,
		outputSaveError: [resolvedOutput.saveError, artifactErrors.outputSaveError].filter(Boolean).join("\n") || undefined,
		metadataSaveError: artifactErrors.metadataSaveError,
		transcriptPath: transcriptWriter ? artifactPaths?.transcriptPath : undefined,
		transcriptError: transcriptWriter?.getError(),
		interrupted: timedOutAfterAcceptance || stoppedAfterAcceptance ? false : finalResult?.interrupted,
		timedOut: timedOutAfterAcceptance ? true : finalResult?.timedOut,
		stopped: stoppedAfterAcceptance ? true : finalResult?.stopped,
		timeoutRecovery,
		toolBudget,
		toolBudgetBlocked: toolBudgetBlocked || undefined,
		completionGuardTriggered: completionGuardTriggeredFinal,
		...((finalResult as (RunChildSessionResult & { effects?: import("../../shared/types.ts").EffectsProjection }) | undefined)?.effects ? { effects: (finalResult as RunChildSessionResult & { effects?: import("../../shared/types.ts").EffectsProjection }).effects } : {}),
		structuredOutput: timedOutAfterAcceptance || stoppedAfterAcceptance ? undefined : (finalResult as (RunChildSessionResult & { structuredOutput?: unknown }) | undefined)?.structuredOutput,
		structuredOutputPath: timedOutAfterAcceptance || stoppedAfterAcceptance ? undefined : effectiveStructuredOutput?.outputPath,
		structuredOutputSchemaPath: timedOutAfterAcceptance || stoppedAfterAcceptance ? undefined : effectiveStructuredOutput?.schemaPath,
		acceptance: effectiveAcceptance,
		watchdog: finalResult?.watchdog,
		...(capabilityAudit ? { capabilityCeiling: capabilityAudit.ceiling, capabilityAudit } : {}),
		launchResolvedExtensions,
		...((finalResult as (RunChildSessionResult & { runtimeAcknowledgedExtensions?: RuntimeAcknowledgedChildExtensions }) | undefined)?.runtimeAcknowledgedExtensions ? { runtimeAcknowledgedExtensions: (finalResult as RunChildSessionResult & { runtimeAcknowledgedExtensions?: RuntimeAcknowledgedChildExtensions }).runtimeAcknowledgedExtensions } : {}),
	});
	return isAgentContract(step.agentContract) ? attachContractProjections(result as unknown as import("../../shared/types.ts").SingleResult) as unknown as typeof result : result;
}

async function runSingleStep(
	step: SubagentStep,
	ctx: SingleStepContext,
): Promise<StepResult & { completionGuardTriggered?: boolean }> {
	if (!step.importAsyncRoot) ctx.orcaProgressTab?.section({ agent: step.agent, index: ctx.flatIndex, count: ctx.flatStepCount });
	return runSingleStepInner(step, ctx);
}

type RunnerStatusStep = NonNullable<AsyncStatus["steps"]>[number] & {
	exitCode?: number | null;
	description?: string;
};

function externalRunnerStatus(runner: SubagentStep["runner"]): ExternalCliRunnerStatus | ExternalJobRunnerStatus | undefined {
	if (runner?.type === "external-cli") {
		return resolveExternalCliRunnerStatus(runner);
	}
	if (runner?.type === "external-job") {
		return {
			type: "external-job",
			provider: runner.provider,
			options: runner.options ?? {},
			capabilities: { stop: false, steer: false, resume: false, structuredOutput: false, toolEvents: false },
		};
	}
	return undefined;
}

function appendCapabilityCeilingAppliedEvent(eventsPath: string, runId: string, stepIndex: number, agent: string, result: StepResult): void {
	if (!result.capabilityCeiling) return;
	appendJsonl(eventsPath, JSON.stringify({
		type: "subagent.capability-ceiling.applied",
		ts: Date.now(),
		runId,
		stepIndex,
		agent,
		capabilityCeiling: result.capabilityCeiling,
		...(result.capabilityAudit ? { capabilityAudit: result.capabilityAudit } : {}),
	}));
}

type RunnerStatusPayload = Omit<AsyncStatus, "steps" | "parallelGroups" | "pid" | "cwd" | "currentStep" | "chainStepCount" | "lastUpdate"> & {
	pid: number;
	cwd: string;
	currentStep: number;
	chainStepCount: number;
	parallelGroups: AsyncParallelGroupStatus[];
	steps: RunnerStatusStep[];
	lastUpdate: number;
	artifactsDir?: string;
	shareUrl?: string;
	gistUrl?: string;
	shareError?: string;
	error?: string;
};

function requiredStatusStep(statusPayload: RunnerStatusPayload, index: number): RunnerStatusStep {
	const step = statusPayload.steps[index];
	if (!step) throw new Error(`Missing status step at index ${index}`);
	return step;
}

function setStatusWorktreeReference(statusStep: RunnerStatusStep, worktree: WorktreeSetup["worktrees"][number]): void {
	statusStep.worktreePath = worktree.path;
	statusStep.branch = worktree.branch;
	if (worktree.provider) statusStep.provider = worktree.provider;
	if (worktree.naming) statusStep.naming = worktree.naming;
}

function markParallelGroupSetupFailure(input: {
	statusPayload: RunnerStatusPayload;
	results: StepResult[];
	group: Extract<RunnerStep, { parallel: SubagentStep[] }>;
	groupStartFlatIndex: number;
	setupError: string;
	failedAt: number;
	statusPath: string;
	eventsPath: string;
	asyncDir: string;
	runId: string;
	stepIndex: number;
	writeStatus: (status: RunnerStatusPayload) => void;
}): void {
	for (let taskIndex = 0; taskIndex < input.group.parallel.length; taskIndex++) {
		const flatTaskIndex = input.groupStartFlatIndex + taskIndex;
		const statusStep = requiredStatusStep(input.statusPayload, flatTaskIndex);
		const task = input.group.parallel[taskIndex];
		if (!task) throw new Error(`Missing parallel task at index ${taskIndex}`);
		const stopped = statusStep.stopped || statusStep.stopRequested || input.statusPayload.stopped;
		const paused = !stopped && input.statusPayload.state === "paused";
		statusStep.status = stopped ? "stopped" : paused ? "paused" : "failed";
		statusStep.startedAt = input.failedAt;
		statusStep.endedAt = input.failedAt;
		statusStep.durationMs = 0;
		statusStep.exitCode = paused ? 0 : 1;
		statusStep.error ??= input.setupError;
		input.results.push(omitUndefinedProperties({ agent: task.agent, context: task.context, output: input.setupError, error: input.setupError, success: false, exitCode: paused ? 0 : 1, sessionFile: task.sessionFile, stopped: stopped || undefined, interrupted: paused || undefined, timedOut: input.statusPayload.timedOut || undefined }));
	}
	input.statusPayload.currentStep = input.groupStartFlatIndex;
	input.statusPayload.lastUpdate = input.failedAt;
	input.statusPayload.outputFile = path.join(input.asyncDir, `output-${input.groupStartFlatIndex}.log`);
	input.writeStatus(input.statusPayload);
	appendJsonl(input.eventsPath, JSON.stringify({
		type: "subagent.parallel.completed",
		ts: input.failedAt,
		runId: input.runId,
		stepIndex: input.stepIndex,
		success: false,
	}));
}

function markParallelGroupRunning(input: {
	statusPayload: RunnerStatusPayload;
	group: Extract<RunnerStep, { parallel: SubagentStep[] }>;
	groupStartFlatIndex: number;
	groupStartTime: number;
	statusPath: string;
	eventsPath: string;
	asyncDir: string;
	runId: string;
	stepIndex: number;
	writeStatus: (status: RunnerStatusPayload) => void;
}): void {
	for (let taskIndex = 0; taskIndex < input.group.parallel.length; taskIndex++) {
		const flatTaskIndex = input.groupStartFlatIndex + taskIndex;
		const statusStep = requiredStatusStep(input.statusPayload, flatTaskIndex);
		statusStep.status = "pending";
		delete statusStep.startedAt;
		delete statusStep.endedAt;
		delete statusStep.durationMs;
		delete statusStep.lastActivityAt;
		delete statusStep.activityState;
		delete statusStep.error;
	}
	input.statusPayload.currentStep = input.groupStartFlatIndex;
	delete input.statusPayload.activityState;
	input.statusPayload.lastActivityAt = input.groupStartTime;
	input.statusPayload.lastUpdate = input.groupStartTime;
	input.statusPayload.outputFile = path.join(input.asyncDir, `output-${input.groupStartFlatIndex}.log`);
	input.writeStatus(input.statusPayload);
	appendJsonl(input.eventsPath, JSON.stringify({
		type: "subagent.parallel.started",
		ts: input.groupStartTime,
		runId: input.runId,
		stepIndex: input.stepIndex,
		agents: input.group.parallel.map((task) => task.agent),
		count: input.group.parallel.length,
	}));
}

function bindWorktreeCwd(step: SubagentStep, worktreeCwd: string): SubagentStep {
	const bind = <T extends string | null | undefined>(value: T): T => value === null || value === undefined ? value : value.replaceAll(WORKTREE_AGENT_CWD_PLACEHOLDER, worktreeCwd) as T;
	return {
		...step,
		task: bind(step.task) ?? step.task,
		...(step.systemPrompt !== undefined ? { systemPrompt: bind(step.systemPrompt) } : {}),
		...(step.outputPath !== undefined ? { outputPath: bind(step.outputPath) } : {}),
		...(step.launchBindingTask !== undefined ? { launchBindingTask: bind(step.launchBindingTask) } : {}),
		...(step.requestedCwd !== undefined ? { requestedCwd: bind(step.requestedCwd) } : {}),
	};
}

function prepareParallelTaskRun(
	task: SubagentStep,
	cwd: string,
	worktreeSetup: WorktreeSetup | undefined,
	taskIndex: number,
): { taskForRun: SubagentStep; taskCwd: string } {
	if (!worktreeSetup) return { taskForRun: task, taskCwd: cwd };
	const { cwd: _taskCwd, ...taskForRun } = task;
	const boundTask = bindWorktreeCwd(taskForRun, worktreeSetup.worktrees[taskIndex]!.agentCwd);
	return {
		taskForRun: boundTask,
		taskCwd: worktreeSetup.worktrees[taskIndex]!.agentCwd,
	};
}

function captureParallelWorktreeDiffs(
	worktreeSetup: WorktreeSetup,
	asyncDir: string,
	stepIndex: number,
	group: Extract<RunnerStep, { parallel: SubagentStep[] }>,
): { diffs: ReturnType<typeof diffWorktrees>; summary: string } {
	const diffsDir = path.join(asyncDir, "worktree-diffs", `step-${stepIndex}`);
	const diffs = diffWorktrees(worktreeSetup, group.parallel.map((task) => task.agent), diffsDir);
	return { diffs, summary: formatWorktreeDiffSummary(diffs) };
}

function ensureParallelProgressFile(cwd: string, group: Extract<RunnerStep, { parallel: SubagentStep[] }>): void {
	const progressPath = path.join(cwd, "progress.md");
	if (!group.parallel.some((task) => task.task.includes(`Update progress at: ${progressPath}`))) return;
	writeInitialProgressFile(cwd);
}

function resolveAsyncStepTranscriptPath(input: {
	artifactsDir?: string;
	artifactConfig?: Partial<ArtifactConfig>;
	runId: string;
	agent: string;
	flatIndex: number;
	flatStepCount: number;
}): string | undefined {
	if (!input.artifactsDir || input.artifactConfig?.enabled === false || input.artifactConfig?.includeTranscript === false) return undefined;
	return getArtifactPaths(
		input.artifactsDir,
		input.runId,
		input.agent,
		input.flatStepCount > 1 ? input.flatIndex : undefined,
	).transcriptPath;
}

type SingleStepResult = Awaited<ReturnType<typeof runSingleStep>>;

function missingRequiredOutputAfterUsefulMutation(result: SingleStepResult): boolean {
	const effects = result.effects;
	return effects?.settlementDiagnostic?.requiredOutput?.missing === true
		&& (effects.settlementDiagnostic.mutation.attempted || effects.fileMutation?.attempted === true || Boolean(effects.fileMutation?.evidence?.changedFiles.length));
}

function partialExecutionWithUsefulMutation(result: SingleStepResult): boolean {
	const fileMutation = result.effects?.fileMutation;
	return result.execution?.status === "partial" && (fileMutation?.attempted === true || Boolean(fileMutation?.evidence?.changedFiles.length));
}

function partialEvidenceResult(result: SingleStepResult): boolean {
	return missingRequiredOutputAfterUsefulMutation(result) || partialExecutionWithUsefulMutation(result);
}

function concreteFailureResult(result: SingleStepResult): boolean {
	return result.success === false && !partialEvidenceResult(result);
}

function combinedAbortSignal(signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
	const activeSignals = signals.filter((signal): signal is AbortSignal => Boolean(signal));
	if (activeSignals.length === 0) return undefined;
	if (activeSignals.length === 1) return activeSignals[0];
	const controller = new AbortController();
	const abort = (): void => controller.abort();
	for (const signal of activeSignals) {
		if (signal.aborted) {
			abort();
			break;
		}
		signal.addEventListener("abort", abort, { once: true });
	}
	return controller.signal;
}

async function runSingleStepWithTimeout(
	step: SubagentStep,
	ctx: SingleStepContext,
	parentDeadlineAt?: number,
): Promise<SingleStepResult> {
	if (step.timeoutMs === undefined) return runSingleStep(step, ctx);

	const parentRemainingMs = parentDeadlineAt === undefined ? undefined : Math.max(0, parentDeadlineAt - Date.now());
	const timeoutMs = parentRemainingMs === undefined ? step.timeoutMs : Math.min(step.timeoutMs, parentRemainingMs);
	const timeoutMessage = parentRemainingMs !== undefined && parentRemainingMs <= step.timeoutMs
		? ctx.timeoutMessage
		: `Subagent timed out after ${step.timeoutMs}ms.`;
	const timeoutController = new AbortController();
	let timeoutAction: (() => void) | undefined;
	let timeoutTriggered = false;
	const triggerTimeout = (): void => {
		if (timeoutTriggered) return;
		timeoutTriggered = true;
		timeoutController.abort();
		timeoutAction?.();
	};
	const registerTimeout = (action: (() => void) | undefined): void => {
		timeoutAction = action;
		ctx.registerTimeout?.(action ? triggerTimeout : undefined);
		if (action && timeoutTriggered) action();
	};
	const timer = setTimeout(triggerTimeout, timeoutMs);
	timer.unref?.();
	try {
		return await runSingleStep(step, {
			...ctx,
			registerTimeout,
			deadlineAt: Date.now() + timeoutMs,
			timeoutSignal: combinedAbortSignal([ctx.timeoutSignal, timeoutController.signal]),
			timeoutMessage,
		});
	} finally {
		clearTimeout(timer);
		ctx.registerTimeout?.(undefined);
	}
}

async function runSubagent(
	config: SubagentRunConfig,
	childSessions: ChildSessionFactory,
): Promise<void> {
	const { id, steps, resultPath, cwd, placeholder, taskIndex, totalTasks, maxOutput, artifactsDir, artifactConfig } =
		config;
	const globalSemaphore = new Semaphore(config.globalConcurrencyLimit ?? DEFAULT_GLOBAL_CONCURRENCY_LIMIT);
	let previousOutput = "";
	const outputs: ChainOutputMap = {};
	const results: StepResult[] = [];
	const overallStartTime = Date.now();
	const shareEnabled = config.share === true;
	const asyncDir = config.asyncDir;
	const handoffWorkflowKey = config.workflowKey;
	const handoffChildRunId = handoffWorkflowKey ? id : undefined;
	const statusPath = path.join(asyncDir, "status.json");
	const eventsPath = path.join(asyncDir, "events.jsonl");
	const logPath = path.join(asyncDir, `subagent-log-${id}.md`);
	const controlConfig = config.controlConfig ?? DEFAULT_CONTROL_CONFIG;
	const activeChildInterrupts = new Map<number, () => void>();
	const activeChildTimeouts = new Map<number, () => void>();
	const activeChildStops = new Map<number, () => void>();
	const activeChildSteers = new Map<number, StepSteerHandler>();
	/** Steers routed to a running step before its session was created. */
	const queuedStepSteers = new Map<number, SteerRequest[]>();
	const childStopRequests = new Map<number, { childId: string; requestedAt: number }>();
	const pendingStepSteers: SteerRequest[] = [];
	let interrupted = false;
	let currentActivityState: ActivityState | undefined;
	let activityTimer: NodeJS.Timeout | undefined;
	let timeoutTimer: NodeJS.Timeout | undefined;
	let timedOut = false;
	let stopped = false;
	let usageBudgetExceeded = false;
	const timeoutMessage = config.timeoutMs !== undefined ? `Subagent timed out after ${config.timeoutMs}ms.` : undefined;
	const stopMessage = "Subagent stopped by user.";
	const timeoutAbortController = new AbortController();
	const stopAbortController = new AbortController();
	const setupInterruptController = new AbortController();
	const setupSignal = AbortSignal.any([timeoutAbortController.signal, stopAbortController.signal, setupInterruptController.signal]);
	let previousCumulativeTokens: TokenUsage = { input: 0, output: 0, total: 0 };
	let latestSessionFile: string | undefined;

	const flatSteps = flattenSteps(steps);
	const initialFlatStepCount = flatSteps.length;
	const parallelGroups: Array<{ start: number; count: number; stepIndex: number }> = [];
	const initialStatusSteps: RunnerStatusStep[] = [];
	let flatStepCount = 0;
	for (let stepIndex = 0; stepIndex < steps.length; stepIndex++) {
		const step = steps[stepIndex]!;
		if (isParallelGroup(step)) {
			parallelGroups.push({ start: flatStepCount, count: step.parallel.length, stepIndex });
			for (const task of step.parallel) {
				const taskFlatIndex = flatStepCount;
				const transcriptPath = resolveAsyncStepTranscriptPath(omitUndefinedProperties({ artifactsDir, artifactConfig, runId: id, agent: task.agent, flatIndex: taskFlatIndex, flatStepCount: initialFlatStepCount }));
				const taskSessionName = task.sessionName ?? deriveChildSessionName({ agent: task.agent, task: task.task, label: task.label });
				initialStatusSteps.push(omitUndefinedProperties({
					agent: task.agent,
					...(task.lane ? { lane: task.lane } : config.lane ? { lane: config.lane } : {}),
					...(taskSessionName ? { sessionName: taskSessionName } : {}),
					...(externalRunnerStatus(task.runner) ? { runner: externalRunnerStatus(task.runner) } : {}),
					...(statusStepDescription(task.task) ? { description: statusStepDescription(task.task) } : {}),
					...(task.context ? { context: task.context } : {}),
					phase: task.phase,
					label: task.label,
					outputName: task.outputName,
					structured: task.structured,
					...(task.agentContract ? { agentContract: task.agentContract } : {}),
					...(task.launchContractDigest ? { launchContractDigest: task.launchContractDigest } : {}),
					...(task.launchResolvedExtensions ? { launchResolvedExtensions: task.launchResolvedExtensions } : {}),
					...(task.capabilityCeiling ? { capabilityCeiling: task.capabilityCeiling } : {}),
					...(task.thinkingCeiling ? { thinkingCeiling: task.thinkingCeiling } : {}),
					status: "pending",
					...(task.toolBudget ? { toolBudget: initialToolBudgetState(task.toolBudget) } : {}),
					...(task.sessionFile ? { sessionFile: task.sessionFile } : {}),
					...(transcriptPath ? { transcriptPath } : {}),
					skills: task.skills,
					model: task.model,
					...(task.contextLimit !== undefined ? { contextLimit: task.contextLimit } : {}),
					thinking: task.thinking,
					attemptedModels: task.modelCandidates && task.modelCandidates.length > 0 ? task.modelCandidates : task.model ? [task.model] : undefined,
					recentTools: [],
					recentOutput: [],
				}));
				flatStepCount++;
			}
		} else if (isDynamicRunnerGroup(step)) {
			parallelGroups.push({ start: flatStepCount, count: 1, stepIndex });
			initialStatusSteps.push(omitUndefinedProperties({
				agent: `expand:${step.parallel.agent}`,
				...(externalRunnerStatus(step.parallel.runner) ? { runner: externalRunnerStatus(step.parallel.runner) } : {}),
				...(step.parallel.context ? { context: step.parallel.context } : {}),
				phase: step.phase ?? step.parallel.phase,
				label: step.label ?? step.parallel.label ?? `Dynamic fanout (${step.collect.as})`,
				outputName: step.collect.as,
				structured: Boolean(step.collect.outputSchema),
				...(step.parallel.contextLimit !== undefined ? { contextLimit: step.parallel.contextLimit } : {}),
				...(step.agentContract ? { agentContract: step.agentContract } : {}),
				...(step.capabilityCeiling ? { capabilityCeiling: step.capabilityCeiling } : {}),
				...(step.thinkingCeiling ? { thinkingCeiling: step.thinkingCeiling } : {}),
				status: "pending",
				...(step.parallel.toolBudget ? { toolBudget: initialToolBudgetState(step.parallel.toolBudget) } : {}),
				recentTools: [],
				recentOutput: [],
			}));
			flatStepCount++;
		} else {
			const stepFlatIndex = flatStepCount;
			const transcriptPath = resolveAsyncStepTranscriptPath(omitUndefinedProperties({ artifactsDir, artifactConfig, runId: id, agent: step.agent, flatIndex: stepFlatIndex, flatStepCount: initialFlatStepCount }));
			const stepSessionName = step.sessionName ?? deriveChildSessionName({ agent: step.agent, task: step.task, label: step.label });
			initialStatusSteps.push(omitUndefinedProperties({
				agent: step.agent,
				...(step.lane ? { lane: step.lane } : config.lane ? { lane: config.lane } : {}),
				...(stepSessionName ? { sessionName: stepSessionName } : {}),
				...(externalRunnerStatus(step.runner) ? { runner: externalRunnerStatus(step.runner) } : {}),
				...(statusStepDescription(step.task) ? { description: statusStepDescription(step.task) } : {}),
				...(step.context ? { context: step.context } : {}),
				phase: step.phase,
				label: step.label,
				outputName: step.outputName,
				structured: step.structured,
				...(step.agentContract ? { agentContract: step.agentContract } : {}),
				...(step.launchContractDigest ? { launchContractDigest: step.launchContractDigest } : {}),
				...(step.launchResolvedExtensions ? { launchResolvedExtensions: step.launchResolvedExtensions } : {}),
				...(step.capabilityCeiling ? { capabilityCeiling: step.capabilityCeiling } : {}),
				...(step.thinkingCeiling ? { thinkingCeiling: step.thinkingCeiling } : {}),
				status: "pending",
				...(step.toolBudget ? { toolBudget: initialToolBudgetState(step.toolBudget) } : {}),
				...(step.sessionFile ? { sessionFile: step.sessionFile } : {}),
				...(transcriptPath ? { transcriptPath } : {}),
				skills: step.skills,
				model: step.model,
				...(step.contextLimit !== undefined ? { contextLimit: step.contextLimit } : {}),
				thinking: step.thinking,
				attemptedModels: step.modelCandidates && step.modelCandidates.length > 0 ? step.modelCandidates : step.model ? [step.model] : undefined,
				recentTools: [],
				recentOutput: [],
			}));
			flatStepCount++;
		}
	}
	const sessionEnabled = Boolean(config.sessionDir)
		|| shareEnabled
		|| flatSteps.some((step) => Boolean(step.sessionFile));
	if (config.runnerProcessInstanceId) {
		for (const step of initialStatusSteps) {
			step.processTerminal = { version: 1, state: "pending", runId: id, runnerProcessInstanceId: config.runnerProcessInstanceId };
		}
	}
	const initialAgentLabel = initialStatusSteps.length === 1
		? initialStatusSteps[0]!.agent
		: (config.resultMode ?? (flatSteps.length > 1 ? "chain" : "single")) === "parallel"
			? `parallel:${initialStatusSteps.map((step) => step.agent).join("+")}`
			: `chain:${initialStatusSteps.map((step) => step.agent).join("->")}`;
	const orcaProgressTab = flatSteps.every((step) => step.importAsyncRoot) ? undefined : createOrcaProgressTab({
		cwd,
		runId: id,
		agent: initialAgentLabel,
		index: 0,
		stepCount: Math.max(initialStatusSteps.length, 1),
	});

	const statusPayload: RunnerStatusPayload = omitUndefinedProperties({
		lifecycleArtifactVersion: SUBAGENT_LIFECYCLE_ARTIFACT_VERSION,
		runId: id,
		...(config.sessionId ? { sessionId: config.sessionId } : {}),
		...(config.completionOwnerId ? { completionOwnerId: config.completionOwnerId } : {}),
		mode: config.resultMode ?? (flatSteps.length > 1 ? "chain" : "single"),
		...(config.nestedSelf ? { isNested: true } : {}),
		state: "running",
		steering: createSteeringStatus(),
		lastActivityAt: overallStartTime,
		startedAt: overallStartTime,
		lastUpdate: overallStartTime,
		...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
		...(config.deadlineAt !== undefined ? { deadlineAt: config.deadlineAt } : {}),
		...(config.toolBudget ? { toolBudget: initialToolBudgetState(config.toolBudget) } : {}),
		...(config.usageBudget ? { usageBudget: usageBudgetState(config.usageBudget, undefined) } : {}),
		pid: process.pid,
		cwd,
		currentStep: 0,
		chainStepCount: steps.length,
		parallelGroups,
		workflowGraph: config.workflowGraph,
		...(config.launchContractDigest ? { launchContractDigest: config.launchContractDigest } : {}),
		...(config.launchResolvedExtensions ? { launchResolvedExtensions: config.launchResolvedExtensions } : {}),
		...(config.capabilityCeiling ? { capabilityCeiling: config.capabilityCeiling } : {}),
		...(config.runFanoutBudget ? { runFanoutBudget: getRunFanoutBudgetSnapshot(config.runFanoutBudget) } : {}),
		...(config.parentWorkflowRunId ? { parentWorkflowRunId: config.parentWorkflowRunId } : {}),
		...(config.workflowKey ? { workflowKey: config.workflowKey } : {}),
		...(config.lane ? { lane: config.lane } : {}),
		...(config.runnerProcessInstanceId ? { processTerminal: { version: 1 as const, state: "pending" as const, runId: id, runnerProcessInstanceId: config.runnerProcessInstanceId } } : {}),
		steps: initialStatusSteps,
		artifactsDir,
		sessionDir: config.sessionDir,
		outputFile: path.join(asyncDir, "output-0.log"),
	});

	let lastIndexedStatusState: AsyncStatus["state"] | undefined;
	const indexPersistence = createCapacityResilientJsonWriter({
		keepAlive: true,
		onSuccess: (_filePath, payload) => {
			lastIndexedStatusState = (payload as { state: AsyncStatus["state"] }).state;
		},
		onError: (error, filePath) => console.error(`Failed to update async run index '${filePath}':`, error),
	});
	const queueActiveRunIndex = (): void => {
		const state = statusPayload.state;
		if (state === lastIndexedStatusState && indexPersistence.pendingCount() === 0) return;
		indexPersistence.write(asyncDir, { state, toolCallId: statusPayload.toolCallId }, (_filePath, payload) => {
			const indexPayload = payload as { state: AsyncStatus["state"]; toolCallId?: string };
			updateActiveRunIndex(asyncDir, indexPayload.state, indexPayload.toolCallId, { retryCapacityErrors: true });
		});
	};
	const runPersistence = createCapacityResilientJsonWriter({
		keepAlive: true,
		onSuccess: (filePath) => {
			if (filePath === statusPath) queueActiveRunIndex();
		},
		onError: (error, filePath) => console.error(`Failed to persist async run state '${filePath}':`, error),
	});
	try {
		fs.mkdirSync(asyncDir, { recursive: true });
	} catch (error) {
		if (!isStorageCapacityError(error)) throw error;
		console.error(`Failed to prepare async run storage '${asyncDir}' while storage is full:`, error);
	}
	runPersistence.write(statusPath, statusPayload);

	let pendingParallelUsageCost: CostSummary = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
	const currentUsageTotals = (): CostSummary => {
		const cost = results.reduce<CostSummary>((sum, result) => ({
			inputTokens: sum.inputTokens + (result.totalCost?.inputTokens ?? result.usage?.input ?? 0),
			outputTokens: sum.outputTokens + (result.totalCost?.outputTokens ?? result.usage?.output ?? 0),
			costUsd: sum.costUsd + (result.totalCost?.costUsd ?? result.usage?.cost ?? 0),
		}), { inputTokens: pendingParallelUsageCost.inputTokens, outputTokens: pendingParallelUsageCost.outputTokens, costUsd: pendingParallelUsageCost.costUsd });
		return {
			inputTokens: Math.max(cost.inputTokens, statusPayload.totalTokens?.input ?? 0),
			outputTokens: Math.max(cost.outputTokens, statusPayload.totalTokens?.output ?? 0),
			costUsd: cost.costUsd,
		};
	};
	const refreshUsageBudget = () => {
		setOptionalProperty(statusPayload, "usageBudget", usageBudgetState(config.usageBudget, currentUsageTotals()));
		return statusPayload.usageBudget;
	};
	const emitNestedSelfEvent = (type: "subagent.nested.updated" | "subagent.nested.completed"): void => {
		if (!config.nestedRoute || !config.nestedSelf) return;
		try {
			writeNestedEvent(config.nestedRoute, omitUndefinedProperties({
				type,
				ts: Date.now(),
				parentRunId: config.nestedSelf.parentRunId,
				parentStepIndex: config.nestedSelf.parentStepIndex,
				child: nestedSummaryFromAsyncStatus(statusPayload, asyncDir, omitUndefinedProperties({
					id,
					parentRunId: config.nestedSelf.parentRunId,
					parentStepIndex: config.nestedSelf.parentStepIndex,
					depth: config.nestedSelf.depth,
					path: config.nestedSelf.path,
					mode: statusPayload.mode,
					ts: Date.now(),
				})),
			}));
		} catch (error) {
			console.error("Failed to emit nested async status event:", error);
		}
	};
	const refreshWorkflowGraph = (): void => {
		if (!config.workflowGraph) return;
		const graph = structuredClone(statusPayload.workflowGraph ?? config.workflowGraph);
		const normalize = (status: RunnerStatusStep["status"]): "pending" | "running" | "completed" | "failed" | "paused" | "stopped" | "detached" | "rejected" => {
			if (status === "complete" || status === "completed") return "completed";
			if (status === "running" || status === "failed" || status === "paused" || status === "stopped" || status === "pending" || status === "rejected") return status;
			return "pending";
		};
		const updateNode = (node: NonNullable<typeof graph.nodes>[number]): void => {
			if (node.flatIndex !== undefined) {
				const step = statusPayload.steps[node.flatIndex];
				if (step) {
					node.status = normalize(step.status);
					setOptionalProperty(node, "error", step.error);
					setOptionalProperty(node, "acceptanceStatus", step.acceptance?.status);
				}
				if (statusPayload.currentStep === node.flatIndex) graph.currentNodeId = node.id;
			}
			for (const child of node.children ?? []) updateNode(child);
			if (node.children?.length) {
				if (node.children.every((child) => child.status === "completed")) node.status = "completed";
				else if (node.children.some((child) => child.status === "running")) node.status = "running";
				else if (node.children.some((child) => child.status === "stopped")) node.status = "stopped";
				else if (node.children.some((child) => child.status === "rejected")) node.status = "rejected";
				else if (node.children.some((child) => child.status === "failed")) node.status = "failed";
				else if (node.children.some((child) => child.status === "paused")) node.status = "paused";
			}
			if (node.error && node.status !== "stopped" && node.status !== "rejected") node.status = "failed";
		};
		for (const node of graph.nodes) updateNode(node);
		statusPayload.workflowGraph = graph;
	};
	let finalResultCommitted = false;
	const statusResultState = (): AsyncStatus["state"] | undefined => {
		if (statusPayload.state === "running" || statusPayload.state === "queued") return undefined;
		return statusPayload.state;
	};
	const statusResultSummary = (state: AsyncStatus["state"]): string => {
		if (statusPayload.error) return statusPayload.error;
		if (state === "paused") return "Paused after interrupt. Waiting for explicit next action.";
		if (state === "partial") return "Subagent needs attention after partial work.";
		if (state === "stopped") return stopMessage;
		if (state === "rejected") return "Subagent rejected.";
		return state === "complete" ? "Subagent completed." : "Subagent failed.";
	};
	const statusResultSuccess = (state: AsyncStatus["state"], step: RunnerStatusStep): boolean | undefined => {
		if (step.status === "complete" || step.status === "completed") return true;
		if (step.status === "failed" || step.status === "stopped" || step.status === "rejected") return false;
		if (state === "complete") return true;
		if (state === "failed" || state === "partial" || state === "stopped" || state === "rejected") return false;
		return undefined;
	};
	const writeRecoverableStatusResult = (): void => {
		const state = statusResultState();
		if (!state || finalResultCommitted || !config.sessionId) return;
		if ((state as string) === "complete") return;
		const now = statusPayload.endedAt ?? statusPayload.lastUpdate ?? Date.now();
		const summary = statusResultSummary(state);
		runPersistence.write(resultPath, omitUndefinedProperties({
			lifecycleArtifactVersion: SUBAGENT_LIFECYCLE_ARTIFACT_VERSION,
			id,
			runId: id,
			agent: statusPayload.steps.length === 1 ? statusPayload.steps[0]!.agent : statusPayload.mode === "parallel" ? `parallel:${statusPayload.steps.map((step) => step.agent).join("+")}` : `chain:${statusPayload.steps.map((step) => step.agent).join("->")}`,
			mode: statusPayload.mode,
			success: state === "complete",
			state,
			summary,
			error: state === "failed" || state === "partial" || state === "stopped" || state === "rejected" ? summary : undefined,
			stopped: state === "stopped" ? true : undefined,
			results: statusPayload.steps.map((step) => omitUndefinedProperties({
				agent: step.agent,
				...(step.sessionName ? { sessionName: step.sessionName } : {}),
				output: step.status === "complete" || step.status === "completed" ? "" : step.error ?? summary,
				error: step.error,
				success: statusResultSuccess(state, step),
				sessionFile: step.sessionFile,
				model: step.model,
				thinking: step.thinking,
				attemptedModels: step.attemptedModels,
				modelAttempts: step.modelAttempts,
				usage: usageFromAttempts(step.modelAttempts),
				contextOverflow: step.contextOverflow,
			})),
			exitCode: state === "complete" || state === "paused" ? 0 : 1,
			timestamp: now,
			durationMs: Math.max(0, now - overallStartTime),
			asyncDir,
			cwd,
			sessionId: config.sessionId,
			completionOwnerId: config.completionOwnerId,
			sessionFile: statusPayload.sessionFile ?? latestSessionFile,
		}), (filePath, payload) => writePendingAsyncResultFile(filePath, payload as Record<string, unknown>));
	};
	const writeStatusPayloadNow = (): void => {
		refreshWorkflowGraph();
		writeRecoverableStatusResult();
		runPersistence.write(statusPath, statusPayload);
		emitNestedSelfEvent(statusPayload.state === "running" || statusPayload.state === "queued" ? "subagent.nested.updated" : "subagent.nested.completed");
	};
	const statusWriteCoalescer = createFileCoalescer(writeStatusPayloadNow, 100);
	const writeStatusPayload = (immediate = true): void => {
		if (immediate || statusPayload.state !== "running") {
			if (!statusWriteCoalescer.flush(statusPath)) writeStatusPayloadNow();
			return;
		}
		statusWriteCoalescer.schedule(statusPath);
	};
	const updateExternalProcess = (index: number, process: ExternalProcessStatus): void => {
		requiredStatusStep(statusPayload, index).externalProcess = process;
		statusPayload.lastUpdate = Date.now();
		writeStatusPayload();
	};
	const updateExternalJob = (index: number, externalJob: ExternalJobStatus): void => {
		requiredStatusStep(statusPayload, index).externalJob = externalJob;
		statusPayload.lastUpdate = Date.now();
		writeStatusPayload();
	};
	const childStopTargetId = (index: number): string => asyncStatusChildIdentity(requiredStatusStep(statusPayload, index), index);
	const appendChildStatusEvent = (index: number, childId: string, status: "stopping" | "stopped", now = Date.now()): void => {
		const step = requiredStatusStep(statusPayload, index);
		appendJsonl(eventsPath, JSON.stringify({
			type: "subagent.child-status",
			version: 1,
			ts: now,
			runId: id,
			childId,
			status,
			reason: "user",
			source: "async",
			stepIndex: index,
			agent: step.agent,
			...(step.runId ? { childRunId: step.runId } : {}),
			...(step.workflowKey ? { workflowKey: step.workflowKey } : {}),
			...(step.phase ? { phase: step.phase } : {}),
			...(step.label ? { label: step.label } : {}),
		} satisfies SubagentChildStatusEvent));
	};
	const appendTerminalChildStatusEvent = (index: number, now = Date.now()): void => {
		const request = childStopRequests.get(index);
		if (request) appendChildStatusEvent(index, request.childId, "stopped", now);
	};
	const markChildStopRequested = (index: number, childId: string, now = Date.now()): boolean => {
		const step = statusPayload.steps[index];
		if (!step || (step.status !== "pending" && step.status !== "running")) return false;
		childStopRequests.set(index, { childId, requestedAt: now });
		step.stopRequested = true;
		step.stopRequestedAt = now;
		delete step.activityState;
		statusPayload.lastUpdate = now;
		writeStatusPayload();
		appendJsonl(eventsPath, JSON.stringify({ type: "subagent.step.stop_requested", ts: now, runId: id, stepIndex: index, childId, agent: step.agent }));
		appendChildStatusEvent(index, childId, "stopping", now);
		return true;
	};
	const markChildStopped = (index: number, now = Date.now()): void => {
		const step = requiredStatusStep(statusPayload, index);
		if (step.status === "stopped") return;
		step.status = "stopped";
		step.error = stopMessage;
		step.exitCode = 1;
		step.stopped = true;
		step.stopRequested = true;
		step.stopRequestedAt = childStopRequests.get(index)?.requestedAt ?? step.stopRequestedAt ?? now;
		delete step.activityState;
		step.endedAt = now;
		step.durationMs = step.startedAt ? now - step.startedAt : 0;
		step.lastActivityAt = now;
		statusPayload.lastUpdate = now;
		writeStatusPayload();
		const childId = childStopRequests.get(index)?.childId ?? childStopTargetId(index);
		appendJsonl(eventsPath, JSON.stringify({ type: "subagent.step.stopped", ts: now, runId: id, stepIndex: index, childId, agent: step.agent, exitCode: 1, durationMs: step.durationMs }));
		appendChildStatusEvent(index, childId, "stopped", now);
	};
	const childStopResult = (index: number, agent: string, context?: "fresh" | "fork"): SingleStepResult => {
		markChildStopped(index);
		return stoppedStepResult(agent, context, requiredStatusStep(statusPayload, index).sessionName);
	};
	const stopChildStep = (request: StopRequest): void => {
		if (request.targetIndex === undefined) {
			stopRunner();
			return;
		}
		const childId = request.childId ?? childStopTargetId(request.targetIndex);
		const now = Date.now();
		if (!markChildStopRequested(request.targetIndex, childId, now)) {
			appendJsonl(eventsPath, JSON.stringify({ type: "subagent.step.stop_failed", ts: now, runId: id, stepIndex: request.targetIndex, childId, message: "Child is not pending or running." }));
			return;
		}
		const stop = activeChildStops.get(request.targetIndex);
		if (stop) stop();
		else if (requiredStatusStep(statusPayload, request.targetIndex).status === "pending") {
			appendJsonl(eventsPath, JSON.stringify({ type: "subagent.step.stop_queued", ts: now, runId: id, stepIndex: request.targetIndex, childId }));
		}
	};
	const registerStepInterrupt = (flatIndex: number, interrupt: (() => void) | undefined): void => {
		if (!interrupt) {
			activeChildInterrupts.delete(flatIndex);
			return;
		}
		activeChildInterrupts.set(flatIndex, interrupt);
		if (interrupted) interrupt();
	};
	const registerStepTimeout = (flatIndex: number, interrupt: (() => void) | undefined): void => {
		if (!interrupt) {
			activeChildTimeouts.delete(flatIndex);
			return;
		}
		activeChildTimeouts.set(flatIndex, interrupt);
		if (timedOut) interrupt();
	};
	const registerStepStop = (flatIndex: number, stop: (() => void) | undefined): void => {
		if (!stop) {
			activeChildStops.delete(flatIndex);
			return;
		}
		activeChildStops.set(flatIndex, stop);
		if (stopped || childStopRequests.has(flatIndex)) stop();
	};
	const registerStepSteer = (flatIndex: number, steer: StepSteerHandler | undefined): void => {
		if (!steer) {
			activeChildSteers.delete(flatIndex);
			return;
		}
		activeChildSteers.set(flatIndex, steer);
		const queued = queuedStepSteers.get(flatIndex);
		queuedStepSteers.delete(flatIndex);
		for (const request of queued ?? []) steerLiveChild(flatIndex, request);
	};
	const interruptActiveChildren = (): void => {
		for (const interrupt of [...activeChildInterrupts.values()]) interrupt();
	};
	const timeoutActiveChildren = (): void => {
		for (const interrupt of [...activeChildTimeouts.values()]) interrupt();
	};
	const stopActiveChildren = (): void => {
		for (const stop of [...activeChildStops.values()]) stop();
	};
	const nestedRuns = function* (children: NestedRunSummary[] | undefined): Generator<NestedRunSummary> {
		for (const child of children ?? []) {
			yield child;
			yield* nestedRuns(child.children);
			yield* nestedRuns(child.steps?.flatMap((step) => step.children ?? []));
		}
	};
	const interruptNestedAsyncDescendants = (): void => {
		if (!config.nestedRoute) return;
		let registry: ReturnType<typeof projectNestedEvents>;
		try {
			registry = projectNestedEvents(config.nestedRoute);
		} catch (error) {
			appendJsonl(eventsPath, JSON.stringify({
				type: "subagent.nested.interrupt_failed",
				ts: Date.now(),
				runId: id,
				message: error instanceof Error ? error.message : String(error),
			}));
			return;
		}
		for (const run of nestedRuns(registry.children)) {
			if (run.state !== "running" && run.state !== "queued") continue;
			const nestedAsyncDir = run.asyncDir ?? resolveNestedAsyncDir(config.nestedRoute.rootRunId, run);
			if (!nestedAsyncDir) continue;
			try {
				deliverInterruptRequest({ asyncDir: nestedAsyncDir, source: "ancestor-interrupt" });
			} catch (error) {
				appendJsonl(eventsPath, JSON.stringify({
					type: "subagent.nested.interrupt_failed",
					ts: Date.now(),
					runId: id,
					targetRunId: run.id,
					message: error instanceof Error ? error.message : String(error),
				}));
			}
		}
	};
	const stopNestedAsyncDescendants = (): void => {
		if (!config.nestedRoute) return;
		let registry: ReturnType<typeof projectNestedEvents>;
		try {
			registry = projectNestedEvents(config.nestedRoute);
		} catch (error) {
			appendJsonl(eventsPath, JSON.stringify({
				type: "subagent.nested.stop_failed",
				ts: Date.now(),
				runId: id,
				message: error instanceof Error ? error.message : String(error),
			}));
			return;
		}
		for (const run of nestedRuns(registry.children)) {
			if (run.state !== "running" && run.state !== "queued") continue;
			const nestedAsyncDir = run.asyncDir ?? resolveNestedAsyncDir(config.nestedRoute.rootRunId, run);
			if (!nestedAsyncDir) continue;
			try {
				deliverStopRequest(omitUndefinedProperties({ asyncDir: nestedAsyncDir, pid: run.pid, source: "ancestor-stop" }));
			} catch (error) {
				appendJsonl(eventsPath, JSON.stringify({
					type: "subagent.nested.stop_failed",
					ts: Date.now(),
					runId: id,
					targetRunId: run.id,
					message: error instanceof Error ? error.message : String(error),
				}));
			}
		}
	};
	const timeoutNestedAsyncDescendants = (): void => {
		if (!config.nestedRoute) return;
		let registry: ReturnType<typeof projectNestedEvents>;
		try {
			registry = projectNestedEvents(config.nestedRoute);
		} catch (error) {
			appendJsonl(eventsPath, JSON.stringify({
				type: "subagent.nested.timeout_failed",
				ts: Date.now(),
				runId: id,
				message: error instanceof Error ? error.message : String(error),
			}));
			return;
		}
		for (const run of nestedRuns(registry.children)) {
			if (run.state !== "running" && run.state !== "queued") continue;
			const nestedAsyncDir = run.asyncDir ?? resolveNestedAsyncDir(config.nestedRoute.rootRunId, run);
			if (!nestedAsyncDir) continue;
			try {
				deliverTimeoutRequest(omitUndefinedProperties({ asyncDir: nestedAsyncDir, pid: run.pid, source: "ancestor-timeout" }));
			} catch (error) {
				appendJsonl(eventsPath, JSON.stringify({
					type: "subagent.nested.timeout_failed",
					ts: Date.now(),
					runId: id,
					targetRunId: run.id,
					message: error instanceof Error ? error.message : String(error),
				}));
			}
		}
	};
	const pausedStepResult = (agent: string, context?: "fresh" | "fork", sessionName?: string): SingleStepResult => omitUndefinedProperties({
		agent,
		sessionName,
		context,
		output: "Paused after interrupt. Waiting for explicit next action.",
		exitCode: 0,
		interrupted: true,
	});
	const timedOutStepResult = (agent: string, context?: "fresh" | "fork", sessionName?: string): SingleStepResult => omitUndefinedProperties({
		agent,
		sessionName,
		context,
		output: timeoutMessage ?? "Subagent timed out.",
		error: timeoutMessage ?? "Subagent timed out.",
		exitCode: 1,
		timedOut: true,
	});
	const stoppedStepResult = (agent: string, context?: "fresh" | "fork", sessionName?: string): SingleStepResult => omitUndefinedProperties({
		agent,
		sessionName,
		context,
		output: stopMessage,
		error: stopMessage,
		exitCode: 1,
		stopped: true,
	});
	const consumePendingAppendRequests = (): void => {
		if (statusPayload.mode !== "chain" || statusPayload.state !== "running") return;
		const requests = consumeChainAppendRequests(asyncDir);
		if (requests.length === 0) {
			const pendingAppends = countPendingChainAppendRequests(asyncDir);
			if ((statusPayload.pendingAppends ?? 0) !== pendingAppends) {
				statusPayload.pendingAppends = pendingAppends;
				statusPayload.lastUpdate = Date.now();
				writeStatusPayload();
			}
			return;
		}
		const appendedSteps = requests.flatMap((request) => request.steps);
		steps.push(...appendedSteps);
		const now = Date.now();
		const pendingAppends = countPendingChainAppendRequests(asyncDir);
		const added = appendRunnerStepsToStatus({
			status: statusPayload,
			steps: appendedSteps,
			now,
			pendingAppends,
		});
		mutatingFailureStates.push(...Array.from({ length: added.addedFlatSteps }, () => createMutatingFailureState()));
		pendingToolResults.push(...Array.from({ length: added.addedFlatSteps }, () => undefined));
		if (config.childIntercomTargets) {
			config.childIntercomTargets = statusPayload.steps.map((statusStep, index) => resolveSubagentIntercomTarget(id, statusStep.agent, index));
		}
		writeStatusPayload();
		for (const request of requests) {
			appendJsonl(eventsPath, JSON.stringify({
				type: "subagent.chain.append.accepted",
				ts: now,
				runId: id,
				requestId: request.id,
				stepCount: request.steps.length,
				pendingAppends,
			}));
		}
	};
	const markDynamicGraphGroup = (stepIndex: number, status: "completed" | "failed" | "running" | "stopped", error?: string, acceptance?: import("../../shared/types.ts").AcceptanceLedger): void => {
		const groupNode = statusPayload.workflowGraph?.nodes.find((node) => node.id === `step-${stepIndex}`);
		if (!groupNode) return;
		groupNode.status = status;
		setOptionalProperty(groupNode, "error", error);
		setOptionalProperty(groupNode, "acceptanceStatus", acceptance?.status ?? groupNode.acceptanceStatus);
	};

	const stepOutputActivityAt = (index: number): number => {
		const step = statusPayload.steps[index];
		let lastActivityAt = step?.lastActivityAt ?? step?.startedAt ?? overallStartTime;
		const outputPath = path.join(asyncDir, `output-${index}.log`);
		try {
			lastActivityAt = Math.max(lastActivityAt, fs.statSync(outputPath).mtimeMs);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				console.error(`Failed to inspect async output file '${outputPath}':`, error);
			}
		}
		return lastActivityAt;
	};
	const emittedControlEventKeys = new Set<string>();
	const activeLongRunningSteps = new Set<number>();
	const mutatingFailureStates = initialStatusSteps.map(() => createMutatingFailureState());
	const pendingToolResults: Array<{ tool: string; path?: string; mutates: boolean; startedAt?: number } | undefined> = initialStatusSteps.map(() => undefined);
	type ActiveToolCall = { key: string; tool: string; args: string; startedAt: number; path?: string; blocksSupervisor: boolean };
	const activeToolCalls = initialStatusSteps.map(() => new Map<string, ActiveToolCall>());
	const activeToolKeysByName = initialStatusSteps.map(() => new Map<string, string[]>());
	const activeToolSequences = initialStatusSteps.map(() => 0);
	const latestActiveToolCall = (flatIndex: number): ActiveToolCall | undefined => [...(activeToolCalls[flatIndex]?.values() ?? [])].sort((left, right) => right.startedAt - left.startedAt)[0];
	const refreshStepCurrentTool = (flatIndex: number): void => {
		const step = statusPayload.steps[flatIndex];
		if (!step) return;
		const active = latestActiveToolCall(flatIndex);
		if (!active) {
			delete step.currentTool;
			delete step.currentToolArgs;
			delete step.currentToolStartedAt;
			delete step.currentPath;
			return;
		}
		step.currentTool = active.tool;
		step.currentToolArgs = active.args;
		step.currentToolStartedAt = active.startedAt;
		setOptionalProperty(step, "currentPath", active.path);
	};
	const recordActiveToolCall = (flatIndex: number, event: { toolCallId?: unknown; toolName: string }, input: { argsPreview: string; currentPath?: string; blocksSupervisor: boolean; now: number }): ActiveToolCall => {
		const sequence = (activeToolSequences[flatIndex] ?? 0) + 1;
		activeToolSequences[flatIndex] = sequence;
		const key = toolTimeoutCallKey(event, sequence);
		const active: ActiveToolCall = {
			key,
			tool: event.toolName,
			args: input.argsPreview,
			startedAt: input.now,
			blocksSupervisor: input.blocksSupervisor,
			...(input.currentPath !== undefined ? { path: input.currentPath } : {}),
		};
		activeToolCalls[flatIndex]?.set(key, active);
		const keysByName = activeToolKeysByName[flatIndex];
		const keys = keysByName?.get(active.tool) ?? [];
		keys.push(key);
		keysByName?.set(active.tool, keys);
		refreshStepCurrentTool(flatIndex);
		return active;
	};
	const removeActiveToolCallKey = (flatIndex: number, key: string): ActiveToolCall | undefined => {
		const calls = activeToolCalls[flatIndex];
		const active = calls?.get(key);
		if (!active) return undefined;
		calls?.delete(key);
		const keysByName = activeToolKeysByName[flatIndex];
		const keys = keysByName?.get(active.tool)?.filter((candidate) => candidate !== key) ?? [];
		if (keys.length > 0) keysByName?.set(active.tool, keys);
		else keysByName?.delete(active.tool);
		return active;
	};
	const removeActiveToolCall = (flatIndex: number, event: { toolCallId?: unknown; toolName?: unknown }): ActiveToolCall | undefined => {
		const calls = activeToolCalls[flatIndex];
		const key = typeof event.toolCallId === "string" && event.toolCallId.length > 0
			? `id:${event.toolCallId}`
			: typeof event.toolName === "string"
				? activeToolKeysByName[flatIndex]?.get(event.toolName)?.[0]
				: calls?.size === 1
					? [...calls.keys()][0]
					: undefined;
		return key ? removeActiveToolCallKey(flatIndex, key) : undefined;
	};
	const openToolAttentionTarget = (flatIndex: number, now: number): ActiveToolCall | undefined => [...(activeToolCalls[flatIndex]?.values() ?? [])]
		.filter((active) => shouldEmitOpenToolAttention({ config: controlConfig, currentTool: active.tool, currentToolStartedAt: active.startedAt, now }))
		.sort((left, right) => left.startedAt - right.startedAt)[0];
	const supervisorAttentionSteps = new Map<number, ActivityState | undefined>();
	const mutatingFailureWindowMs = 5 * 60_000;
	const appendControlEvent = (rawEvent: ReturnType<typeof buildControlEvent>) => {
		if (!controlConfig.enabled) return;
		const contextStep = statusPayload.steps[rawEvent.index ?? statusPayload.currentStep ?? 0];
		const event = {
			...rawEvent,
			...(contextStep?.workflowKey ?? statusPayload.workflowKey ? { workflowKey: contextStep?.workflowKey ?? statusPayload.workflowKey } : {}),
			...(contextStep?.phase ? { phase: contextStep.phase } : {}),
			...(contextStep?.label ? { label: contextStep.label } : {}),
			...(contextStep?.description ? { taskPreview: contextStep.description } : {}),
		};
		const childIntercomTarget = config.childIntercomTargets?.[event.index ?? statusPayload.currentStep];
		const channels = event.type === "active_long_running"
			? controlConfig.notifyChannels.filter((channel) => channel !== "intercom")
			: controlConfig.notifyChannels;
		if (channels.length === 0 || !claimControlNotification(controlConfig, event, emittedControlEventKeys, childIntercomTarget)) return;
		appendJsonl(eventsPath, JSON.stringify({
			type: "subagent.control",
			event,
			channels,
			childIntercomTarget,
			noticeText: formatControlNoticeMessage(event, childIntercomTarget),
			...(config.controlIntercomTarget && channels.includes("intercom") ? {
				intercom: {
					to: config.controlIntercomTarget,
					message: formatControlIntercomMessage(event, childIntercomTarget),
				},
			} : {}),
		}));
	};
	const syncTopLevelCurrentTool = (): void => {
		const activeStep = statusPayload.steps
			.filter((step) => step.status === "running" && typeof step.currentTool === "string" && step.currentTool.length > 0)
			.sort((left, right) => (right.currentToolStartedAt ?? 0) - (left.currentToolStartedAt ?? 0))[0];
		setOptionalProperty(statusPayload, "currentTool", activeStep?.currentTool);
		setOptionalProperty(statusPayload, "currentToolStartedAt", activeStep?.currentToolStartedAt);
		setOptionalProperty(statusPayload, "currentPath", activeStep?.currentPath);
	};
	const syncAggregateActivityState = (): void => {
		const nextRunState = statusPayload.steps.some((step) => step.activityState === "needs_attention")
			? "needs_attention"
			: statusPayload.steps.some((step) => step.activityState === "active_long_running")
				? "active_long_running"
				: undefined;
		currentActivityState = nextRunState;
		setOptionalProperty(statusPayload, "activityState", nextRunState);
	};
	const maybeEmitOpenToolAttention = (flatIndex: number, now: number): boolean => {
		const step = statusPayload.steps[flatIndex];
		if (!step || step.status !== "running" || step.activityState === "needs_attention") return false;
		const target = openToolAttentionTarget(flatIndex, now);
		if (!target) return false;
		const previous = step.activityState;
		step.activityState = "needs_attention";
		statusPayload.activityState = "needs_attention";
		const toolDurationMs = Math.max(0, now - target.startedAt);
		appendControlEvent(buildControlEvent(omitUndefinedProperties({
			type: "needs_attention",
			from: previous,
			to: "needs_attention",
			runId: id,
			agent: step.agent,
			index: flatIndex,
			ts: now,
			message: `${step.agent} has had tool '${target.tool}' open for ${Math.floor(toolDurationMs / 1000)}s`,
			reason: "tool_open_threshold",
			turns: step.turnCount,
			tokens: step.tokens?.total,
			toolCount: step.toolCount,
			currentTool: target.tool,
			currentToolDurationMs: toolDurationMs,
			currentPath: target.path,
		})));
		return true;
	};
	const maybeEmitActiveLongRunning = (flatIndex: number, now: number): boolean => {
		if (!controlConfig.enabled || activeLongRunningSteps.has(flatIndex)) return false;
		const step = statusPayload.steps[flatIndex];
		if (!step || step.status !== "running" || step.activityState === "needs_attention") return false;
		const reason = nextLongRunningTrigger(controlConfig, {
			startedAt: step.startedAt ?? overallStartTime,
			now,
			turns: step.turnCount ?? 0,
			tokens: step.tokens?.total ?? 0,
		});
		if (!reason) return false;
		activeLongRunningSteps.add(flatIndex);
		const previous = step.activityState;
		step.activityState = "active_long_running";
		statusPayload.activityState = statusPayload.activityState === "needs_attention" ? "needs_attention" : "active_long_running";
		const event = buildControlEvent(omitUndefinedProperties({
			type: "active_long_running",
			from: previous,
			to: "active_long_running",
			runId: id,
			agent: step.agent,
			index: flatIndex,
			ts: now,
			message: `${step.agent} is still active but long-running`,
			reason,
			turns: step.turnCount,
			tokens: step.tokens?.total,
			toolCount: step.toolCount,
			currentTool: step.currentTool,
			currentToolDurationMs: step.currentToolStartedAt ? Math.max(0, now - step.currentToolStartedAt) : undefined,
			currentPath: step.currentPath,
			elapsedMs: now - (step.startedAt ?? overallStartTime),
		}));
		appendControlEvent(event);
		return true;
	};
	const steeringMarkerPath = (requestId: string): string => path.join(asyncDir, "control", "steer-recovery", `${Buffer.from(requestId).toString("base64url")}.json`);
	const markSteeringAttention = (index: number): void => {
		const step = statusPayload.steps[index];
		if (step) step.activityState = "needs_attention";
		statusPayload.activityState = "needs_attention";
	};
	const emitSteeringEvent = (type: string, request: SteerRequest, index?: number, extra: Record<string, unknown> = {}): void => {
		appendJsonl(eventsPath, JSON.stringify({ type, ts: Date.now(), runId: id, requestId: request.id, ...(index !== undefined ? { index } : {}), ...extra }));
	};
	const emitSteeringNotice = (requestId: string, state: "failed" | "partial" | "recovered", message: string): void => {
		appendJsonl(eventsPath, JSON.stringify({ type: "subagent.steering.notice", ts: Date.now(), runId: id, requestId, state, message, ...(config.sessionId ? { currentSessionId: config.sessionId } : {}) }));
	};
	const recordSteeringLifecycle = (request: SteerRequest, targets: Array<{ index: number; state: SteeringTargetState; reason?: string }>): void => {
		const lifecycle = steeringStatus(statusPayload);
		recordSteeringRequest(lifecycle, omitUndefinedProperties({ id: request.id, requestedAt: request.ts, source: request.source, message: request.message, targets }));
		for (const target of targets) {
			const step = statusPayload.steps[target.index];
			if (!step) continue;
			step.steering ??= createSteeringStatus();
			recordSteeringRequest(step.steering, omitUndefinedProperties({ id: request.id, requestedAt: request.ts, source: request.source, message: request.message, targets: [target] }));
		}
	};
	const updateSteeringLifecycleTarget = (
		requestId: string,
		index: number,
		state: SteeringTargetState,
		now: number,
		fields: Pick<SteeringTargetStatus, "reason" | "replacementRunId"> = {},
	): SteeringTargetStatus | undefined => {
		const updated = updateSteeringTarget(steeringStatus(statusPayload), requestId, index, state, now, fields);
		const step = statusPayload.steps[index];
		if (step?.steering) updateSteeringTarget(step.steering, requestId, index, state, now, fields);
		return updated;
	};
	const emitTerminalSteeringNotice = (requestId: string, failureMessage: string): void => {
		const state = terminalSteeringNoticeState(steeringStatus(statusPayload), requestId);
		if (state === "partial") emitSteeringNotice(requestId, "partial", `Steering partially delivered for run ${id}.`);
		else if (state === "failed") emitSteeringNotice(requestId, "failed", failureMessage);
	};
	const deliverSteerRequest = (request: SteerRequest): void => {
		if (statusPayload.state !== "running") {
			const reason = `run became ${statusPayload.state} before steering request was consumed`;
			const indexes = request.targetIndex !== undefined
				? [request.targetIndex]
				: request.targetIndexes?.length
					? request.targetIndexes
					: statusPayload.steps.map((_, index) => index);
			const targets = indexes.map((index) => ({ index, state: "failed" as const, reason }));
			recordSteeringLifecycle(request, targets);
			emitSteeringEvent("subagent.steer.requested", request, undefined, { targets });
			for (const target of targets) emitSteeringEvent("subagent.steer.failed", request, target.index, { reason });
			emitTerminalSteeringNotice(request.id, `Steering failed for run ${id}: ${reason}.`);
			statusPayload.lastUpdate = Date.now();
			writeStatusPayload();
			return;
		}
		const runningIndexes = statusPayload.steps
			.map((step, index) => ({ step, index }))
			.filter(({ step }) => step.status === "running")
			.map(({ index }) => index);
		const targets = request.targetIndex !== undefined
			? [request.targetIndex]
			: request.targetIndexes?.length
				? request.targetIndexes
				: runningIndexes.length > 0
					? runningIndexes
					: statusPayload.mode === "single" && statusPayload.steps[0]?.status === "pending"
						? [0]
						: [];
		const now = Date.now();
		const targetStates = targets.map((index) => {
			const step = statusPayload.steps[index];
			if (!step) return { index, state: "failed" as const, reason: "child index out of range" };
			if (step.status === "pending") return { index, state: "scheduled" as const };
			if (step.status !== "running") return { index, state: "failed" as const, reason: `child is ${step.status}` };
			return { index, state: "routed" as const };
		});
		recordSteeringLifecycle(request, targetStates);
		emitSteeringEvent("subagent.steer.requested", request, undefined, { targets: targetStates });
		for (const target of targetStates) {
			if (target.state === "routed") {
				updateSteeringLifecycleTarget(request.id, target.index, "routed", now);
				emitSteeringEvent("subagent.steer.routed", request, target.index);
				steerLiveChild(target.index, request);
			} else if (target.state === "failed") {
				markSteeringAttention(target.index);
				emitSteeringEvent("subagent.steer.failed", request, target.index, { reason: target.reason });
			} else {
				emitSteeringEvent("subagent.steer.scheduled", request, target.index);
			}
		}
		emitTerminalSteeringNotice(request.id, `Steering failed for run ${id}: no requested child remained steerable.`);
		statusPayload.lastUpdate = now;
		writeStatusPayload();
	};
	/** Record the outcome of handing a routed steer to the live child session. */
	const applySteerDelivery = (requestId: string, index: number, delivery: { state: "delivered" | "queued" | "failed"; message: string }): void => {
		const lifecycle = steeringStatus(statusPayload);
		const request = lifecycle.recent.find((candidate) => candidate.id === requestId);
		if (!request || !request.targets.some((target) => target.index === index)) return;
		const late = fs.existsSync(steeringMarkerPath(requestId));
		const now = Date.now();
		if (delivery.state === "delivered") {
			updateSteeringLifecycleTarget(requestId, index, late ? "late" : "delivered", now, omitUndefinedProperties({ reason: late ? "acknowledged after recovery commit" : undefined }));
			emitSteeringEvent("subagent.steer.delivered", { type: "steer", id: requestId, ts: now, message: delivery.message }, index, { late, deliveryStatus: "delivered", message: delivery.message });
		} else if (delivery.state === "queued") {
			updateSteeringLifecycleTarget(requestId, index, "queued", now);
			emitSteeringEvent("subagent.steer.queued", { type: "steer", id: requestId, ts: now, message: delivery.message }, index, { deliveryStatus: "queued", message: delivery.message });
		} else {
			markSteeringAttention(index);
			updateSteeringLifecycleTarget(requestId, index, "failed", now, { reason: delivery.message });
			emitSteeringEvent("subagent.steer.failed", { type: "steer", id: requestId, ts: now, message: delivery.message }, index, { reason: delivery.message });
		}
		emitTerminalSteeringNotice(requestId, `Steering failed for run ${id}: ${delivery.message}`);
		statusPayload.lastUpdate = now;
		writeStatusPayload();
	};
	/** Hand a routed steer to the step's live session, or hold it until the session exists. */
	const steerLiveChild = (index: number, request: SteerRequest): void => {
		const steer = activeChildSteers.get(index);
		if (!steer) {
			const queued = queuedStepSteers.get(index) ?? [];
			queued.push(request);
			queuedStepSteers.set(index, queued);
			return;
		}
		void steer(request).then(
			(delivery) => applySteerDelivery(request.id, index, delivery),
			(error) => applySteerDelivery(request.id, index, { state: "failed", message: error instanceof Error ? error.message : String(error) }),
		);
	};
	const flushPendingStepSteers = (flatIndex: number): void => {
		const remaining: SteerRequest[] = [];
		for (const request of pendingStepSteers.splice(0)) {
			if (request.targetIndex === undefined) deliverSteerRequest({ ...request, targetIndex: flatIndex });
			else if (request.targetIndex === flatIndex) deliverSteerRequest(request);
			else remaining.push(request);
		}
		pendingStepSteers.push(...remaining);
	};
	const updateStepModel = (flatIndex: number, model: string | undefined, thinking: string | undefined, contextLimit?: number, now = Date.now()): void => {
		const step = statusPayload.steps[flatIndex];
		if (!step) return;
		setOptionalProperty(step, "model", model);
		setOptionalProperty(step, "thinking", thinking);
		setOptionalProperty(step, "contextLimit", contextLimit);
		statusPayload.lastUpdate = now;
		writeStatusPayload();
	};
	const updateStepFromChildEvent = (flatIndex: number, event: ChildEvent): void => {
		const step = statusPayload.steps[flatIndex];
		if (!step) return;
		const previousActivityState = step.activityState;
		const now = Date.now();
		statusPayload.currentStep = flatIndex;
		if (isChildWatchdogStatusEvent(event)) {
			const next = acceptChildWatchdogEvent({
				current: step.watchdog,
				event,
				runId: id,
				agent: step.agent,
				childIndex: flatIndex,
			});
			if (!next) return;
			step.watchdog = next;
			step.lastActivityAt = now;
			statusPayload.lastActivityAt = now;
			statusPayload.lastUpdate = now;
			writeStatusPayload(false);
			return;
		}
		if (event.type === "message_end") {
			const next = applyChildWatchdogMessage(step.watchdog, event.message, now);
			if (next) step.watchdog = next;
			if (next && (event.message as { role?: unknown } | undefined)?.role === "custom") {
				statusPayload.lastUpdate = now;
				writeStatusPayload(false);
				return;
			}
		}
		if (event.type === "tool_execution_start" && event.toolName) {
			const mutates = isMutatingTool(event.toolName, event.args, flatSteps[flatIndex]?.mutationTools);
			const currentPath = resolveCurrentPath(event.toolName, event.args);
			const argsPreview = extractToolArgsPreview(event.args ?? {});
			const blocksSupervisor = isBlockingSupervisorTool(event.toolName, event.args);
			step.toolCount = (step.toolCount ?? 0) + 1;
			const configuredToolBudget = flatSteps[flatIndex]?.toolBudget;
			if (configuredToolBudget) {
				step.toolBudget = toolBudgetState(configuredToolBudget, step.toolCount);
				statusPayload.toolBudget = step.toolBudget;
			}
			recordActiveToolCall(flatIndex, { toolCallId: (event as { toolCallId?: unknown }).toolCallId, toolName: event.toolName }, { argsPreview, currentPath, blocksSupervisor, now });
			pendingToolResults[flatIndex] = omitUndefinedProperties({ tool: event.toolName, path: currentPath, mutates, startedAt: now });
			statusPayload.toolCount = (statusPayload.toolCount ?? 0) + 1;
			syncTopLevelCurrentTool();
			if (controlConfig.enabled && blocksSupervisor && step.activityState !== "needs_attention") {
				const previous = step.activityState;
				step.activityState = "needs_attention";
				supervisorAttentionSteps.set(flatIndex, previous);
				currentActivityState = "needs_attention";
				statusPayload.activityState = "needs_attention";
				appendControlEvent(buildControlEvent(omitUndefinedProperties({
					type: "needs_attention",
					from: previous,
					to: "needs_attention",
					runId: id,
					agent: step.agent,
					index: flatIndex,
					ts: now,
					message: `${step.agent} is waiting for a supervisor reply`,
					reason: "supervisor_request",
					turns: step.turnCount,
					tokens: step.tokens?.total,
					toolCount: step.toolCount,
					currentTool: step.currentTool,
					toolCallId: event.toolCallId,
					currentToolDurationMs: 0,
					currentPath: step.currentPath,
				})));
			}
		} else if (event.type === "tool_execution_end") {
			const endedTool = removeActiveToolCall(flatIndex, event);
			if (endedTool) {
				step.recentTools ??= [];
				step.recentTools.push({ tool: endedTool.tool, args: endedTool.args, endMs: now });
			}
			refreshStepCurrentTool(flatIndex);
			const supervisorPreviousActivity = supervisorAttentionSteps.get(flatIndex);
			const stillBlockingSupervisor = [...(activeToolCalls[flatIndex]?.values() ?? [])].some((active) => active.blocksSupervisor);
			const clearedSupervisorAttention = endedTool?.blocksSupervisor && !stillBlockingSupervisor ? supervisorAttentionSteps.delete(flatIndex) : false;
			if (clearedSupervisorAttention && step.activityState === "needs_attention") {
				setOptionalProperty(step, "activityState", supervisorPreviousActivity);
				syncAggregateActivityState();
			}
			syncTopLevelCurrentTool();
		} else if (event.type === "tool_result_end" && event.message) {
			const toolSnapshot = pendingToolResults[flatIndex];
			pendingToolResults[flatIndex] = undefined;
			const resultText = extractTextFromContent(event.message.content);
			if (toolSnapshot && resultText.includes("Tool budget hard limit reached")) {
				const configuredToolBudget = flatSteps[flatIndex]?.toolBudget;
				if (configuredToolBudget) {
					step.toolBudget = toolBudgetState(configuredToolBudget, step.toolCount ?? 0, toolSnapshot.tool);
					step.toolBudgetBlocked = true;
					statusPayload.toolBudget = step.toolBudget;
					statusPayload.toolBudgetBlocked = true;
				}
			}
			appendRecentStepOutput(step, resultText.split("\n").slice(-10));
			if (toolSnapshot?.mutates && didMutatingToolFail(resultText)) {
				const state = mutatingFailureStates[flatIndex]!;
				recordMutatingFailure(state, omitUndefinedProperties({
					tool: toolSnapshot.tool,
					path: toolSnapshot.path,
					error: resultText.split("\n").find((line) => line.trim())?.trim().slice(0, 180) ?? "mutating tool failed",
					ts: now,
				}), mutatingFailureWindowMs);
				if (controlConfig.enabled && shouldEscalateMutatingFailures(state, controlConfig.failedToolAttemptsBeforeAttention) && step.activityState !== "needs_attention") {
					const previous = step.activityState;
					step.activityState = "needs_attention";
					statusPayload.activityState = "needs_attention";
					appendControlEvent(buildControlEvent(omitUndefinedProperties({
						type: "needs_attention",
						from: previous,
						to: "needs_attention",
						runId: id,
						agent: step.agent,
						index: flatIndex,
						ts: now,
						message: `${step.agent} needs attention after repeated mutating tool failures`,
						reason: "tool_failures",
						turns: step.turnCount,
						tokens: step.tokens?.total,
						toolCount: step.toolCount,
						currentTool: toolSnapshot.tool,
						currentToolDurationMs: toolSnapshot.startedAt ? Math.max(0, now - toolSnapshot.startedAt) : undefined,
						currentPath: toolSnapshot.path,
						recentFailureSummary: summarizeRecentMutatingFailures(state),
					})));
				}
			} else if (toolSnapshot?.mutates) {
				resetMutatingFailureState(mutatingFailureStates[flatIndex]!);
			}
		} else if (event.type === "message_end" && event.message?.role === "assistant") {
			appendRecentStepOutput(step, stripAcceptanceReport(extractTextFromContent(event.message.content)).split("\n").slice(-10));
			step.turnCount = (step.turnCount ?? 0) + 1;
			const usage = event.message.usage;
			if (usage) {
				const input = usage.input ?? usage.inputTokens ?? 0;
				const output = usage.output ?? usage.outputTokens ?? 0;
				const window = input + (usage.cacheRead ?? usage.cacheReadTokens ?? 0);
				const previousInput = step.tokens?.input ?? 0;
				const previousOutput = step.tokens?.output ?? 0;
				step.tokens = { input: previousInput + input, output: previousOutput + output, total: previousInput + previousOutput + input + output, window, windowPeak: Math.max(step.tokens?.windowPeak ?? 0, window) };
				const totalInput = statusPayload.totalTokens?.input ?? 0;
				const totalOutput = statusPayload.totalTokens?.output ?? 0;
				statusPayload.totalTokens = { input: totalInput + input, output: totalOutput + output, total: totalInput + totalOutput + input + output, window, windowPeak: Math.max(statusPayload.totalTokens?.windowPeak ?? 0, window) };
				refreshUsageBudget();
			}
			statusPayload.turnCount = Math.max(statusPayload.turnCount ?? 0, step.turnCount);
		}
		syncTopLevelCurrentTool();
		step.lastActivityAt = now;
		statusPayload.lastActivityAt = now;
		statusPayload.lastUpdate = now;
		maybeEmitActiveLongRunning(flatIndex, now);
		// A sibling may keep aggregate attention unchanged; publish this step's transition.
		writeStatusPayload(step.activityState !== previousActivityState);
	};
	const updateRunnerActivityState = (now: number): boolean => {
		if (!controlConfig.enabled) return false;
		let changed = false;
		let runLastActivityAt = statusPayload.lastActivityAt ?? overallStartTime;
		for (let index = 0; index < statusPayload.steps.length; index++) {
			const step = statusPayload.steps[index]!;
			if (step.status !== "running") continue;
			const lastActivityAt = stepOutputActivityAt(index);
			runLastActivityAt = Math.max(runLastActivityAt, lastActivityAt);
			if (step.lastActivityAt !== lastActivityAt) {
				step.lastActivityAt = lastActivityAt;
				changed = true;
			}
			const idleState = deriveActivityState(omitUndefinedProperties({
				config: controlConfig,
				startedAt: step.startedAt ?? overallStartTime,
				lastActivityAt,
				turnCount: step.turnCount,
				currentTool: step.currentTool,
				thinking: step.thinking,
				now,
			}));
			if (idleState === "needs_attention") {
				const previous = step.activityState;
				step.activityState = "needs_attention";
				if (previous !== "needs_attention") {
					appendControlEvent(buildControlEvent(omitUndefinedProperties({
						from: previous,
						to: "needs_attention",
						runId: id,
						agent: step.agent,
						index,
						ts: now,
						lastActivityAt,
					})));
					changed = true;
				}
			} else if (maybeEmitOpenToolAttention(index, now)) {
				changed = true;
			} else if (maybeEmitActiveLongRunning(index, now)) {
				changed = true;
			}
		}
		if (statusPayload.lastActivityAt !== runLastActivityAt) {
			statusPayload.lastActivityAt = runLastActivityAt;
			changed = true;
		}
		const nextRunState = statusPayload.steps.some((step) => step.activityState === "needs_attention")
			? "needs_attention"
			: statusPayload.steps.some((step) => step.activityState === "active_long_running")
				? "active_long_running"
				: undefined;
		if (nextRunState !== currentActivityState) {
			currentActivityState = nextRunState;
			setOptionalProperty(statusPayload, "activityState", nextRunState);
			changed = true;
		}
		statusPayload.lastUpdate = now;
		if (changed) writeStatusPayload();
		return changed;
	};
	if (controlConfig.enabled) {
		activityTimer = setInterval(() => {
			if (statusPayload.state !== "running") return;
			const now = Date.now();
			updateRunnerActivityState(now);
		}, 1000);
		activityTimer.unref?.();
	}

	const publishSetupUnknown = (progress: WorktreeSetupProgress): void => {
		if (!progress.unknown) return;
		const proof = {
			version: 1 as const, state: "unknown" as const, runId: id,
			runnerProcessInstanceId: config.runnerProcessInstanceId ?? "unknown",
			reason: "process-tree-unverified" as const,
			diagnostic: `Worktree setup settlement unknown: ${progress.unknown}; manual reconciliation required; ${parallelHandoffPath(asyncDir)}`,
		};
		statusPayload.processTerminal = proof;
		// Publish the sticky proof independently of in-process child writer counts.
		writeAtomicJson(processTerminalPath(asyncDir), proof);
	};
	const finalizeWorktree = async (setup: WorktreeSetup, stepIndex: number, flatStartIndex: number, action: () => void, deadlineAt?: number): Promise<void> => {
		let admitted = false;
		try { await withWorktreeTransaction(() => {
			if (deadlineAt !== undefined && Date.now() >= deadlineAt) throw new Error("Run deadline expired before worktree cleanup");
			admitted = true;
			action();
		}); }
		catch (error) {
			if (admitted) throw error;
			const reason = `Worktree finalization retained; manual reconciliation required: ${error instanceof Error ? error.message : String(error)}`;
			statusPayload.parallelHandoff = writeParallelHandoffGroup({
				manifestPath: parallelHandoffPath(asyncDir), runId: id,
				mode: (config.resultMode ?? statusPayload.mode) === "parallel" ? "parallel" : (config.resultMode ?? statusPayload.mode) === "single" ? "single" : "chain",
				source: "async", cwd, stepIndex, flatStartIndex, setup, diffs: [], results: [],
				cleanup: { state: "partial", pruned: false, errors: [reason], tasks: setup.worktrees.map((worktree) => ({
					index: worktree.index, path: worktree.path, branch: worktree.branch, provider: worktree.provider, naming: worktree.naming,
					worktreeRemoved: false, branchRemoved: false, preserved: true, reason,
				})) },
			});
			previousOutput = [previousOutput, reason, formatParallelHandoffReference(statusPayload.parallelHandoff)].filter(Boolean).join("\n\n");
			writeStatusPayload();
		}
	};
	const cleanupRemainingWorktree = (setup: WorktreeSetup, stepIndex: number, flatStartIndex: number) => finalizeWorktree(setup, stepIndex, flatStartIndex, () => {
		const cleanup = cleanupWorktrees(setup);
		statusPayload.parallelHandoff = writeParallelHandoffGroup({
			manifestPath: parallelHandoffPath(asyncDir), runId: id,
			mode: (config.resultMode ?? statusPayload.mode) === "parallel" ? "parallel" : (config.resultMode ?? statusPayload.mode) === "single" ? "single" : "chain",
			source: "async", cwd, stepIndex, flatStartIndex, setup, diffs: [], results: [], cleanup,
		});
		writeStatusPayload();
	}, config.deadlineAt);
	const interruptRunner = () => {
		consumeInterruptRequest(asyncDir);
		if (interrupted || statusPayload.state !== "running") return;
		interrupted = true;
		setupInterruptController.abort();
		const now = Date.now();
		statusPayload.state = "paused";
		currentActivityState = undefined;
		delete statusPayload.activityState;
		statusPayload.lastUpdate = now;
		for (const step of statusPayload.steps) {
			if (step.status === "running") {
				step.status = "paused";
				delete step.activityState;
				step.endedAt = now;
				setOptionalProperty(step, "durationMs", step.startedAt ? now - step.startedAt : undefined);
				step.lastActivityAt = now;
			}
		}
		writeStatusPayload();
		appendJsonl(eventsPath, JSON.stringify({
			type: "subagent.run.paused",
			ts: now,
			runId: id,
		}));
		interruptNestedAsyncDescendants();
		interruptActiveChildren();
	};
	const stopRunner = () => {
		if (stopped || timedOut || interrupted || statusPayload.state !== "running") return;
		stopped = true;
		const now = Date.now();
		statusPayload.stopped = true;
		statusPayload.error = stopMessage;
		currentActivityState = undefined;
		delete statusPayload.activityState;
		statusPayload.lastUpdate = now;
		for (const step of statusPayload.steps) {
			if (step.status !== "running" && step.status !== "pending") continue;
			step.status = "stopped";
			step.error = stopMessage;
			step.exitCode = 1;
			step.stopped = true;
			delete step.activityState;
			step.endedAt = now;
			step.durationMs = step.startedAt ? now - step.startedAt : 0;
			step.lastActivityAt = now;
		}
		writeStatusPayload();
		appendJsonl(eventsPath, JSON.stringify({
			type: "subagent.run.stopped",
			ts: now,
			runId: id,
			message: stopMessage,
		}));
		stopAbortController.abort();
		stopNestedAsyncDescendants();
		stopActiveChildren();
	};
	const timeoutRunner = () => {
		if (timedOut || stopped || interrupted || statusPayload.state !== "running") return;
		timedOut = true;
		const now = Date.now();
		const message = timeoutMessage ?? "Subagent timed out.";
		statusPayload.timedOut = true;
		statusPayload.error = message;
		currentActivityState = undefined;
		delete statusPayload.activityState;
		statusPayload.lastUpdate = now;
		for (const step of statusPayload.steps) {
			if (step.status !== "running" && step.status !== "pending") continue;
			step.status = "failed";
			step.error = message;
			step.exitCode = 1;
			step.timedOut = true;
			delete step.activityState;
			step.endedAt = now;
			step.durationMs = step.startedAt ? now - step.startedAt : 0;
			step.lastActivityAt = now;
		}
		writeStatusPayload();
		appendJsonl(eventsPath, JSON.stringify({
			type: "subagent.run.timed_out",
			ts: now,
			runId: id,
			timeoutMs: config.timeoutMs,
			deadlineAt: config.deadlineAt,
			message,
		}));
		timeoutAbortController.abort();
		timeoutNestedAsyncDescendants();
		timeoutActiveChildren();
	};
	process.on(ASYNC_INTERRUPT_SIGNAL, interruptRunner);
	// Portable control inbox: the parent drops control request files here when
	// it cannot deliver OS signals (e.g. ENOSYS on Windows) or when steering a
	// live child. Interrupts still route into the same graceful interruptRunner().
	const disposeControlInbox = watchAsyncControlInbox(asyncDir, {
		onInterrupt: interruptRunner,
		onTimeout: timeoutRunner,
		onStop: stopChildStep,
		onSteer: (request) => {
			const targetStep = request.targetIndex !== undefined ? statusPayload.steps[request.targetIndex] : undefined;
			if (targetStep?.status === "pending") {
				deliverSteerRequest(request);
				pendingStepSteers.push(request);
			} else if (request.targetIndexes !== undefined || request.targetIndex !== undefined || statusPayload.steps.some((step) => step.status === "running")) {
				deliverSteerRequest(request);
			} else {
				deliverSteerRequest(request);
				pendingStepSteers.push(request);
			}
		},
	});
	if (config.deadlineAt !== undefined) {
		const remainingMs = Math.max(0, config.deadlineAt - Date.now());
		timeoutTimer = setTimeout(timeoutRunner, remainingMs);
		timeoutTimer.unref?.();
	}
	appendJsonl(
		eventsPath,
		JSON.stringify({
			type: "subagent.run.started",
			lifecycleArtifactVersion: SUBAGENT_LIFECYCLE_ARTIFACT_VERSION,
			ts: overallStartTime,
			runId: id,
			mode: statusPayload.mode,
			cwd,
			pid: process.pid,
		}),
	);

	let flatIndex = 0;
	let stepCursor = 0;
	while (true) {
		if (interrupted || timedOut || stopped) break;
		consumePendingAppendRequests();
		if (stepCursor >= steps.length) break;
		refreshUsageBudget();
		if (statusPayload.usageBudget?.exhausted) {
			usageBudgetExceeded = true;
			statusPayload.state = "failed";
			statusPayload.error = usageBudgetExceededMessage(statusPayload.usageBudget);
			statusPayload.currentStep = flatIndex;
			statusPayload.lastUpdate = Date.now();
			writeStatusPayload();
			break;
		}
		const stepIndex = stepCursor++;
		const step = steps[stepIndex]!;

		if (isDynamicRunnerGroup(step)) {
			const groupStartFlatIndex = flatIndex;
			let materialized: ReturnType<typeof materializeDynamicParallelStep>;
			try {
				materialized = materializeDynamicParallelStep(step as Parameters<typeof materializeDynamicParallelStep>[0], outputs, stepIndex, omitUndefinedProperties({ maxItems: config.dynamicFanoutMaxItems, allowRunnerFields: true }));
				if (materialized.parallel.length > 1 && step.parallel.outputPath && !step.parallel.namespaceOutputPath) {
					throw new DynamicFanoutError(`Dynamic chain step ${stepIndex + 1} materialized ${materialized.parallel.length} items that resolve output to the same path: ${step.parallel.outputPath}. Remove the explicit output path or use an inherited relative agent output so each item can be isolated.`);
				}
				for (const [itemIndex] of materialized.parallel.entries()) {
					const thinkingOverride = step.thinkingOverrides?.[itemIndex];
					const model = thinkingOverride ? applyThinkingSuffix(step.parallel.model, thinkingOverride, true) : step.parallel.model;
					const configThinking = thinkingOverride ? thinkingOverride : step.parallel.thinking;
					const candidates = step.parallel.modelCandidates !== undefined
						? step.parallel.modelCandidates.length > 0
							? step.parallel.modelCandidates.map((candidate) => thinkingOverride ? applyThinkingSuffix(candidate, thinkingOverride, true) ?? candidate : candidate)
							: [undefined]
						: model ? [model] : [undefined];
					for (const candidate of candidates) {
						assertThinkingWithinCeiling({ model: candidate, configThinking, ceiling: step.parallel.thinkingCeiling, agent: step.parallel.agent, runId: id });
					}
				}
				if (materialized.collectedOnEmpty) await validateDynamicCollection(step.collect.outputSchema, materialized.collectedOnEmpty);
				if (!config.runFanoutBudget) throw new Error("Async runner is missing its run fan-out budget identity.");
				const runFanoutBudget = claimRunFanoutBatch(config.runFanoutBudget, materialized.parallel.map((_, itemIndex) => `chain[${stepIndex}].expand[${itemIndex}]`));
				statusPayload.runFanoutBudget = runFanoutBudget;
			} catch (error) {
				const now = Date.now();
				const message = error instanceof DynamicFanoutError ? error.message : error instanceof Error ? error.message : String(error);
				statusPayload.state = "failed";
				statusPayload.error = message;
				statusPayload.currentStep = flatIndex;
				const placeholder = statusPayload.steps[groupStartFlatIndex];
				if (placeholder) {
					placeholder.status = "failed";
					placeholder.error = message;
					placeholder.startedAt = now;
					placeholder.endedAt = now;
					placeholder.durationMs = 0;
					placeholder.exitCode = 1;
				}
				statusPayload.lastUpdate = now;
				markDynamicGraphGroup(stepIndex, "failed", message);
				writeStatusPayload();
				results.push(omitUndefinedProperties({ agent: step.parallel.agent, context: step.parallel.context, output: message, error: message, success: false, exitCode: 1 }));
				break;
			}

			const effectiveDynamicGroupAcceptance = resolveEffectiveAcceptance(omitUndefinedProperties({
				explicit: step.acceptanceInput,
				agentName: step.parallel.agent,
				acceptanceRole: step.acceptanceRole,
				task: materialized.parallel.map((task) => task.task ?? step.parallel.task).join("\n") || step.parallel.task,
				mode: config.mode,
				async: true,
				dynamicGroup: true,
				agentContract: step.agentContract,
			}));

			if (materialized.parallel.length === 0) {
				const now = Date.now();
				const collection = materialized.collectedOnEmpty ?? [];
				outputs[step.collect.as] = {
					text: JSON.stringify(collection),
					structured: collection,
					agent: step.parallel.agent,
					stepIndex,
				};
				statusPayload.outputs = outputs;
				const placeholder = statusPayload.steps[groupStartFlatIndex];
				if (placeholder) {
					placeholder.status = "complete";
					placeholder.startedAt = now;
					placeholder.endedAt = now;
					placeholder.durationMs = 0;
				}
				previousOutput = "Dynamic fanout produced 0 results.";
				const groupAcceptance = effectiveDynamicGroupAcceptance.explicit && !timedOut && !stopped
					? await evaluateAcceptance(omitUndefinedProperties({
						acceptance: effectiveDynamicGroupAcceptance,
						output: "",
						report: aggregateAcceptanceReport({
							results: [],
							notes: "Dynamic fanout produced 0 results.",
						}),
						cwd,
						signal: combinedAbortSignal([timeoutAbortController.signal, stopAbortController.signal]),
						abortMessage: stopAbortController.signal.aborted ? stopMessage : timeoutMessage ?? "Subagent timed out.",
						reportOptional: isAgentContract(step.agentContract),
					}))
					: undefined;
				const groupStopped = stopped || stopAbortController.signal.aborted;
				const groupTimedOut = !groupStopped && (timedOut || timeoutAbortController.signal.aborted);
				const effectiveGroupAcceptance = groupTimedOut || groupStopped ? undefined : groupAcceptance;
				if (placeholder && effectiveGroupAcceptance) placeholder.acceptance = effectiveGroupAcceptance;
				const groupAcceptanceFailure = effectiveGroupAcceptance && (!isAgentContract(step.agentContract) || step.gateOn === "acceptance") ? acceptanceFailureMessage(effectiveGroupAcceptance) : undefined;
				if (groupTimedOut || groupStopped || groupAcceptanceFailure) {
					const errorMessage = groupStopped ? stopMessage : groupTimedOut ? timeoutMessage ?? "Subagent timed out." : groupAcceptanceFailure!;
					statusPayload.state = groupStopped ? "stopped" : "failed";
					statusPayload.error = errorMessage;
					setOptionalProperty(statusPayload, "stopped", groupStopped ? true : statusPayload.stopped);
					if (placeholder) {
						placeholder.status = groupStopped ? "stopped" : "failed";
						placeholder.error = errorMessage;
						placeholder.exitCode = 1;
						setOptionalProperty(placeholder, "timedOut", groupTimedOut ? true : undefined);
						setOptionalProperty(placeholder, "stopped", groupStopped ? true : undefined);
					}
					markDynamicGraphGroup(stepIndex, groupStopped ? "stopped" : "failed", errorMessage, effectiveGroupAcceptance);
					statusPayload.lastUpdate = Date.now();
					writeStatusPayload();
					results.push(omitUndefinedProperties({ agent: step.parallel.agent, context: step.parallel.context, output: errorMessage, error: errorMessage, success: false, exitCode: 1, timedOut: groupTimedOut ? true : undefined, stopped: groupStopped ? true : undefined, acceptance: effectiveGroupAcceptance }));
					break;
				}
				flatIndex++;
				statusPayload.lastUpdate = now;
				markDynamicGraphGroup(stepIndex, "completed", undefined, effectiveGroupAcceptance);
				writeStatusPayload();
				continue;
			}

			const dynamicSteps = materialized.parallel.map((task, itemIndex) => {
				const thinkingOverride = step.thinkingOverrides?.[itemIndex];
				const model = thinkingOverride ? applyThinkingSuffix(step.parallel.model, thinkingOverride, true) : step.parallel.model;
				const thinking = thinkingOverride ? resolveEffectiveThinking(model, thinkingOverride) : undefined;
				const outputPath = step.parallel.namespaceOutputPath && step.parallel.outputPath
					? path.join(path.dirname(step.parallel.outputPath), `dynamic-${stepIndex}`, `${itemIndex}-${step.parallel.agent}`, path.basename(step.parallel.outputPath))
					: step.parallel.outputPath;
				const taskText = task.task ?? step.parallel.task;
				const materializedTask = step.parallel.namespaceOutputPath ? injectSingleOutputInstruction(taskText, outputPath, step.parallel) : taskText;
				const sessionName = deriveChildSessionName({ agent: step.parallel.agent, task: taskText, label: task.label ?? step.parallel.label });
				return omitUndefinedProperties({
					...step.parallel,
					runFanoutPath: `chain[${stepIndex}].expand[${itemIndex}]`,
					task: materializedTask,
					...(sessionName ? { sessionName } : {}),
					effectiveAcceptance: resolveEffectiveAcceptance(omitUndefinedProperties({
						explicit: step.parallel.acceptanceInput,
						agentName: step.parallel.agent,
						acceptanceRole: step.parallel.acceptanceRole,
						task: materializedTask,
						mode: config.mode,
						async: true,
						dynamic: step.parallel.acceptanceInput === undefined,
						agentContract: step.parallel.agentContract ?? step.agentContract,
					})),
					systemPrompt: step.parallel.namespaceOutputPath ? injectOutputPathSystemPrompt(step.parallel.systemPrompt ?? "", outputPath, step.parallel) : step.parallel.systemPrompt,
					outputPath,
					label: task.label ?? step.parallel.label,
					...(step.sessionFiles?.[itemIndex] ? { sessionFile: step.sessionFiles[itemIndex] } : {}),
					...(thinkingOverride ? {
						...(model ? { model } : {}),
						...(thinking ? { thinking } : {}),
						...(step.parallel.modelCandidates ? { modelCandidates: step.parallel.modelCandidates.flatMap((candidate) => {
							const resolved = applyThinkingSuffix(candidate, thinkingOverride, true);
							return resolved ? [resolved] : [];
						}) } : {}),
					} : {}),
					structuredOutputSchema: step.parallel.structuredOutputSchema ?? step.parallel.structuredOutput?.schema,
				});
			});
			const dynamicFlatStepCount = Math.max(statusPayload.steps.length - 1 + dynamicSteps.length, 1);
			const dynamicStatusSteps: RunnerStatusStep[] = dynamicSteps.map((task, itemIndex) => {
				const transcriptPath = resolveAsyncStepTranscriptPath(omitUndefinedProperties({ artifactsDir, artifactConfig, runId: id, agent: task.agent, flatIndex: groupStartFlatIndex + itemIndex, flatStepCount: dynamicFlatStepCount }));
				return omitUndefinedProperties({
					agent: task.agent,
					...(task.sessionName ? { sessionName: task.sessionName } : {}),
					...(statusStepDescription(task.task) ? { description: statusStepDescription(task.task) } : {}),
					...(task.context ? { context: task.context } : {}),
					...(task.phase ?? step.phase ? { phase: task.phase ?? step.phase } : {}),
					...(task.label ? { label: task.label } : {}),
					structured: Boolean(task.structuredOutputSchema),
					...(task.agentContract ? { agentContract: task.agentContract } : {}),
					...(task.launchResolvedExtensions ? { launchResolvedExtensions: task.launchResolvedExtensions } : {}),
					...(task.capabilityCeiling ? { capabilityCeiling: task.capabilityCeiling } : {}),
					status: "pending",
					...(task.sessionFile ? { sessionFile: task.sessionFile } : {}),
					...(transcriptPath ? { transcriptPath } : {}),
					...(task.skills ? { skills: task.skills } : {}),
					...(task.model ? { model: task.model } : {}),
					...(task.contextLimit !== undefined ? { contextLimit: task.contextLimit } : {}),
					...(task.thinking ? { thinking: task.thinking } : {}),
					...(task.thinkingCeiling ? { thinkingCeiling: task.thinkingCeiling } : {}),
					...(task.modelCandidates && task.modelCandidates.length > 0 ? { attemptedModels: task.modelCandidates } : task.model ? { attemptedModels: [task.model] } : {}),
					recentTools: [],
					recentOutput: [],
				});
			});
			statusPayload.steps.splice(groupStartFlatIndex, 1, ...dynamicStatusSteps);
			if (config.childIntercomTargets) {
				config.childIntercomTargets = statusPayload.steps.map((statusStep, index) => resolveSubagentIntercomTarget(id, statusStep.agent, index));
			}
			mutatingFailureStates.splice(groupStartFlatIndex, 1, ...dynamicStatusSteps.map(() => createMutatingFailureState()));
			pendingToolResults.splice(groupStartFlatIndex, 1, ...dynamicStatusSteps.map(() => undefined));
			const materializedDelta = dynamicStatusSteps.length - 1;
			for (const group of statusPayload.parallelGroups) {
				if (group.stepIndex === stepIndex) {
					group.start = groupStartFlatIndex;
					group.count = dynamicStatusSteps.length;
				} else if (group.start > groupStartFlatIndex) {
					group.start += materializedDelta;
				}
			}
			if (statusPayload.workflowGraph) {
				const shiftFlatIndexes = (nodes: NonNullable<typeof statusPayload.workflowGraph>["nodes"]): void => {
					for (const node of nodes) {
						if (node.stepIndex !== undefined && node.stepIndex > stepIndex && node.flatIndex !== undefined && node.flatIndex >= groupStartFlatIndex) {
							node.flatIndex += dynamicStatusSteps.length;
						}
						if (node.children) shiftFlatIndexes(node.children);
					}
				};
				shiftFlatIndexes(statusPayload.workflowGraph.nodes);
				const groupNode = statusPayload.workflowGraph.nodes.find((node) => node.id === `step-${stepIndex}`);
				if (groupNode) {
					groupNode.children = materialized.items.map((item, itemIndex) => omitUndefinedProperties({
						id: `step-${stepIndex}-item-${item.idKey}`,
						kind: "agent",
						agent: step.parallel.agent,
						phase: dynamicSteps[itemIndex]?.phase ?? step.phase,
						label: dynamicSteps[itemIndex]?.label?.trim() || `${step.parallel.agent} ${item.key}`,
						status: "pending",
						flatIndex: groupStartFlatIndex + itemIndex,
						stepIndex,
						itemKey: item.key,
						structured: Boolean(dynamicSteps[itemIndex]?.structuredOutputSchema),
					}));
				}
			}
			writeStatusPayload();

			const concurrency = step.concurrency ?? MAX_PARALLEL_CONCURRENCY;
			const failFast = step.failFast ?? false;
			let aborted = false;
			const parallelResults = await mapConcurrent(dynamicSteps, concurrency, async (task, taskIdx): Promise<StepResult> => {
				const fi = groupStartFlatIndex + taskIdx;
				refreshUsageBudget();
				if (statusPayload.usageBudget?.exhausted) {
					const skippedAt = Date.now();
					const message = usageBudgetExceededMessage(statusPayload.usageBudget);
					requiredStatusStep(statusPayload, fi).status = "failed";
					requiredStatusStep(statusPayload, fi).error = message;
					requiredStatusStep(statusPayload, fi).startedAt = skippedAt;
					requiredStatusStep(statusPayload, fi).endedAt = skippedAt;
					requiredStatusStep(statusPayload, fi).durationMs = 0;
					requiredStatusStep(statusPayload, fi).exitCode = 1;
					statusPayload.lastUpdate = skippedAt;
					usageBudgetExceeded = true;
					writeStatusPayload();
					appendJsonl(eventsPath, JSON.stringify({ type: "subagent.step.failed", ts: skippedAt, runId: id, stepIndex: fi, agent: task.agent, exitCode: 1, durationMs: 0 }));
					return omitUndefinedProperties({ agent: task.agent, ...(task.sessionName ? { sessionName: task.sessionName } : {}), context: task.context, output: message, error: message, exitCode: 1 as number | null, skipped: true });
				}
				if (timedOut) return timedOutStepResult(task.agent, task.context, task.sessionName);
				if (stopped) return stoppedStepResult(task.agent, task.context, task.sessionName);
				if (childStopRequests.has(fi)) return childStopResult(fi, task.agent, task.context);
				if (interrupted) return pausedStepResult(task.agent, task.context, task.sessionName);
				if (aborted && failFast) {
					const skippedAt = Date.now();
					requiredStatusStep(statusPayload, fi).status = "failed";
					requiredStatusStep(statusPayload, fi).error = "Skipped due to fail-fast";
					requiredStatusStep(statusPayload, fi).startedAt = skippedAt;
					requiredStatusStep(statusPayload, fi).endedAt = skippedAt;
					requiredStatusStep(statusPayload, fi).durationMs = 0;
					requiredStatusStep(statusPayload, fi).exitCode = -1;
					statusPayload.lastUpdate = skippedAt;
					writeStatusPayload();
					return omitUndefinedProperties({ agent: task.agent, ...(task.sessionName ? { sessionName: task.sessionName } : {}), context: task.context, output: "(skipped — fail-fast)", exitCode: -1 as number | null, skipped: true });
				}
				const taskStartTime = Date.now();
				statusPayload.currentStep = fi;
				requiredStatusStep(statusPayload, fi).status = "running";
				delete requiredStatusStep(statusPayload, fi).error;
				delete requiredStatusStep(statusPayload, fi).activityState;
				resetStepLiveDetail(requiredStatusStep(statusPayload, fi));
				requiredStatusStep(statusPayload, fi).startedAt = taskStartTime;
				requiredStatusStep(statusPayload, fi).lastActivityAt = taskStartTime;
				statusPayload.outputFile = path.join(asyncDir, `output-${fi}.log`);
				statusPayload.lastActivityAt = taskStartTime;
				statusPayload.lastUpdate = taskStartTime;
				writeStatusPayload();
				appendJsonl(eventsPath, JSON.stringify({ type: "subagent.step.started", ts: taskStartTime, runId: id, stepIndex: fi, agent: task.agent }));
				flushPendingStepSteers(fi);
				const singleResult = await runSingleStepWithTimeout(task, compactOptional<SingleStepContext>({
					previousOutput, placeholder, cwd, sessionEnabled,
					outputs,
					sessionDir: config.sessionDir ? path.join(config.sessionDir, `dynamic-${stepIndex}-${taskIdx}`) : undefined,
					artifactsDir, artifactConfig, id,
					flatIndex: fi, flatStepCount: Math.max(statusPayload.steps.length, 1),
					outputFile: path.join(asyncDir, `output-${fi}.log`),
					piPackageRoot: config.piPackageRoot,
					childSessions,
					inheritedChildRuntime: config.inheritedChildRuntime,
					childIntercomTarget: config.childIntercomTargets?.[fi],
					orchestratorIntercomTarget: config.controlIntercomTarget,
					nestedRoute: config.nestedRoute,
					capabilityCeiling: config.capabilityCeiling,
					runFanoutBudget: config.runFanoutBudget,
					registerInterrupt: (interrupt) => registerStepInterrupt(fi, interrupt),
					registerTimeout: (interrupt) => registerStepTimeout(fi, interrupt),
					registerStop: (stop) => registerStepStop(fi, stop),
					registerSteer: (steer) => registerStepSteer(fi, steer),
					timeoutSignal: timeoutAbortController.signal,
					stopSignal: stopAbortController.signal,
					trackedMutationEvidenceForCompletionGuard: false,
					timeoutMessage,
					stopMessage,
					toolTimeoutMs: task.toolTimeoutMs ?? config.toolTimeoutMs,
					onAttemptStart: (attempt) => updateStepModel(fi, attempt.model, attempt.thinking, attempt.contextLimit),
					onChildEvent: (event) => updateStepFromChildEvent(fi, event),
					onExternalProcess: (process) => updateExternalProcess(fi, process),
					onExternalJob: (externalJob) => updateExternalJob(fi, externalJob),
					skipAcceptance: () => timedOut || stopped || childStopRequests.has(fi),
					usageBudgetExhausted: () => refreshUsageBudget()?.exhausted === true,
					orcaProgressTab,
				}), config.deadlineAt);
				const taskEndTime = Date.now();
				const childInterrupted = singleResult.interrupted === true;
				const childStopped = singleResult.stopped === true;
				requiredStatusStep(statusPayload, fi).status = stopped || childStopped ? "stopped" : timedOut ? "failed" : childInterrupted ? "paused" : singleResult.exitCode === 0 ? "complete" : "failed";
				requiredStatusStep(statusPayload, fi).endedAt = taskEndTime;
				requiredStatusStep(statusPayload, fi).durationMs = taskEndTime - taskStartTime;
				requiredStatusStep(statusPayload, fi).exitCode = stopped || childStopped ? 1 : timedOut ? 1 : childInterrupted ? 0 : singleResult.exitCode;
				setOptionalProperty(requiredStatusStep(statusPayload, fi), "timedOut", timedOut || singleResult.timedOut ? true : undefined);
				setOptionalProperty(requiredStatusStep(statusPayload, fi), "stopped", stopped || childStopped ? true : undefined);
				setOptionalProperty(requiredStatusStep(statusPayload, fi), "toolBudget", singleResult.toolBudget);
				setOptionalProperty(requiredStatusStep(statusPayload, fi), "toolBudgetBlocked", singleResult.toolBudgetBlocked);
				if (singleResult.toolBudget) statusPayload.toolBudget = singleResult.toolBudget;
				if (singleResult.toolBudgetBlocked) statusPayload.toolBudgetBlocked = true;
				setOptionalProperty(requiredStatusStep(statusPayload, fi), "sessionName", singleResult.sessionName);
				setOptionalProperty(requiredStatusStep(statusPayload, fi), "model", singleResult.model);
				setOptionalProperty(requiredStatusStep(statusPayload, fi), "thinking", resolveEffectiveThinking(singleResult.model, requiredStatusStep(statusPayload, fi).thinking));
				setOptionalProperty(requiredStatusStep(statusPayload, fi), "attemptedModels", singleResult.attemptedModels);
				setOptionalProperty(requiredStatusStep(statusPayload, fi), "modelAttempts", singleResult.modelAttempts);
				setOptionalProperty(requiredStatusStep(statusPayload, fi), "contextOverflow", singleResult.contextOverflow);
				setOptionalProperty(requiredStatusStep(statusPayload, fi), "totalCost", singleResult.totalCost);
				if (singleResult.totalCost) {
					pendingParallelUsageCost = {
						inputTokens: pendingParallelUsageCost.inputTokens + singleResult.totalCost.inputTokens,
						outputTokens: pendingParallelUsageCost.outputTokens + singleResult.totalCost.outputTokens,
						costUsd: pendingParallelUsageCost.costUsd + singleResult.totalCost.costUsd,
					};
					refreshUsageBudget();
				}
				setOptionalProperty(requiredStatusStep(statusPayload, fi), "error", stopped || childStopped ? stopMessage : timedOut ? (timeoutMessage ?? "Subagent timed out.") : singleResult.error);
				setOptionalProperty(requiredStatusStep(statusPayload, fi), "transcriptPath", singleResult.transcriptPath ?? requiredStatusStep(statusPayload, fi).transcriptPath);
				setOptionalProperty(requiredStatusStep(statusPayload, fi), "transcriptError", singleResult.transcriptError);
				setOptionalProperty(requiredStatusStep(statusPayload, fi), "agentContract", singleResult.agentContract);
				setOptionalProperty(requiredStatusStep(statusPayload, fi), "launchContractDigest", singleResult.launchContractDigest);
				setOptionalProperty(requiredStatusStep(statusPayload, fi), "launchResolvedExtensions", singleResult.launchResolvedExtensions);
				setOptionalProperty(requiredStatusStep(statusPayload, fi), "runtimeAcknowledgedExtensions", singleResult.runtimeAcknowledgedExtensions);
				setOptionalProperty(requiredStatusStep(statusPayload, fi), "effects", singleResult.effects);
				setOptionalProperty(requiredStatusStep(statusPayload, fi), "execution", singleResult.execution);
				setOptionalProperty(requiredStatusStep(statusPayload, fi), "review", singleResult.review);
				setOptionalProperty(requiredStatusStep(statusPayload, fi), "structuredOutput", singleResult.structuredOutput);
				setOptionalProperty(requiredStatusStep(statusPayload, fi), "structuredOutputPath", singleResult.structuredOutputPath);
				setOptionalProperty(requiredStatusStep(statusPayload, fi), "structuredOutputSchemaPath", singleResult.structuredOutputSchemaPath);
				setOptionalProperty(requiredStatusStep(statusPayload, fi), "acceptance", singleResult.acceptance);
				setOptionalProperty(requiredStatusStep(statusPayload, fi), "timeoutRecovery", singleResult.timeoutRecovery);
				setOptionalProperty(requiredStatusStep(statusPayload, fi), "watchdog", singleResult.watchdog);
				setOptionalProperty(requiredStatusStep(statusPayload, fi), "capabilityCeiling", singleResult.capabilityCeiling);
				setOptionalProperty(requiredStatusStep(statusPayload, fi), "capabilityAudit", singleResult.capabilityAudit);
				if (singleResult.capabilityCeiling) statusPayload.capabilityCeiling = singleResult.capabilityCeiling;
				if (singleResult.capabilityAudit) statusPayload.capabilityAudit = singleResult.capabilityAudit;
				statusPayload.lastUpdate = taskEndTime;
				writeStatusPayload();
				appendCapabilityCeilingAppliedEvent(eventsPath, id, fi, task.agent, singleResult);
		appendJsonl(eventsPath, JSON.stringify({
			type: stopped || childStopped ? "subagent.step.stopped" : timedOut ? "subagent.step.failed" : childInterrupted ? "subagent.step.paused" : singleResult.exitCode === 0 ? "subagent.step.completed" : "subagent.step.failed",
			ts: taskEndTime, runId: id, stepIndex: fi, agent: task.agent,
			exitCode: stopped || childStopped ? 1 : timedOut ? 1 : childInterrupted ? 0 : singleResult.exitCode, durationMs: taskEndTime - taskStartTime,
		}));
		if (stopped || childStopped) appendTerminalChildStatusEvent(fi, taskEndTime);
		if (singleResult.exitCode !== 0 && failFast && !childStopped) aborted = true;
				return stopped || childStopped ? { ...singleResult, output: stopMessage, error: stopMessage, exitCode: 1, interrupted: false, timedOut: false, stopped: true, skipped: false } : timedOut ? { ...singleResult, output: singleResult.output || (timeoutMessage ?? "Subagent timed out."), error: singleResult.error ?? timeoutMessage ?? "Subagent timed out.", exitCode: 1, interrupted: false, timedOut: true, skipped: false } : { ...singleResult, skipped: false };
			}, globalSemaphore);

			flatIndex += dynamicSteps.length;
			for (const pr of parallelResults) {
				results.push(omitUndefinedProperties({
					agent: pr.agent,
					...(pr.sessionName ? { sessionName: pr.sessionName } : {}),
					context: pr.context,
					agentContract: pr.agentContract,
					launchContractDigest: pr.launchContractDigest,
					launchResolvedExtensions: pr.launchResolvedExtensions,
					runtimeAcknowledgedExtensions: pr.runtimeAcknowledgedExtensions,
					output: pr.output,
					outputState: pr.outputState,
					error: pr.error,
					success: pr.stopped !== true && pr.interrupted !== true && pr.exitCode === 0,
					exitCode: pr.interrupted === true ? 0 : pr.exitCode,
					skipped: pr.skipped,
					interrupted: pr.interrupted,
					timedOut: pr.timedOut,
					stopped: pr.stopped,
					toolBudget: pr.toolBudget,
					toolBudgetBlocked: pr.toolBudgetBlocked,
					sessionFile: pr.sessionFile,
					intercomTarget: pr.intercomTarget,
					model: pr.model,
					thinking: pr.thinking,
					attemptedModels: pr.attemptedModels,
					modelAttempts: pr.modelAttempts,
					contextOverflow: pr.contextOverflow,
					totalCost: pr.totalCost,
					usage: pr.usage,
					artifactPaths: pr.artifactPaths,
					transcriptPath: pr.transcriptPath,
					transcriptError: pr.transcriptError,
					effects: pr.effects,
					execution: pr.execution,
					review: pr.review,
					timeoutRecovery: pr.timeoutRecovery,
					structuredOutput: pr.structuredOutput,
					structuredOutputPath: pr.structuredOutputPath,
					structuredOutputSchemaPath: pr.structuredOutputSchemaPath,
					acceptance: pr.acceptance,
					watchdog: pr.watchdog,
					capabilityCeiling: pr.capabilityCeiling,
					capabilityAudit: pr.capabilityAudit,
				}));
			}
			pendingParallelUsageCost = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
			refreshUsageBudget();
			const collection = collectDynamicResults(step as Parameters<typeof collectDynamicResults>[0], materialized.items, parallelResults);
			const failures = parallelResults.filter((result) => result.exitCode !== 0 && result.exitCode !== -1);
			const acceptanceFailures = parallelResults
				.map((result, originalIndex) => ({ result, originalIndex, task: dynamicSteps[originalIndex] }))
				.filter(({ result, task }) => isAgentContract(task?.agentContract ?? step.agentContract) && task?.gateOn === "acceptance" && result.acceptance?.status === "rejected");
			if (acceptanceFailures.length > 0) {
				const message = acceptanceFailures
					.map(({ result, originalIndex }) => `Dynamic item ${originalIndex + 1} (${result.agent}, key ${materialized.items[originalIndex]?.key ?? originalIndex}) acceptance rejected: ${(result.acceptance ? acceptanceFailureMessage(result.acceptance) : undefined) ?? "acceptance rejected"}`)
					.join("\n");
				results.push(omitUndefinedProperties({ agent: step.parallel.agent, context: step.parallel.context, output: message, error: message, success: false, exitCode: 1, structuredOutput: collection }));
				statusPayload.error = message;
				markDynamicGraphGroup(stepIndex, "failed", message);
			}
			if (failures.length === 0 && acceptanceFailures.length === 0) {
				try {
					await validateDynamicCollection(step.collect.outputSchema, collection);
					outputs[step.collect.as] = {
						text: JSON.stringify(collection),
						structured: collection,
						agent: step.parallel.agent,
						stepIndex,
					};
					statusPayload.outputs = outputs;
					const groupAcceptance = !timedOut && !stopped
						? await evaluateAcceptance(omitUndefinedProperties({
							acceptance: effectiveDynamicGroupAcceptance,
							output: "",
							report: aggregateAcceptanceReport({
								results: parallelResults,
								notes: `Dynamic fanout collected ${collection.length} result(s) into ${step.collect.as}.`,
							}),
							cwd,
							signal: combinedAbortSignal([timeoutAbortController.signal, stopAbortController.signal]),
							abortMessage: stopAbortController.signal.aborted ? stopMessage : timeoutMessage ?? "Subagent timed out.",
							reportOptional: isAgentContract(step.agentContract),
						}))
						: undefined;
					const groupStopped = stopped || stopAbortController.signal.aborted;
					const groupTimedOut = !groupStopped && (timedOut || timeoutAbortController.signal.aborted);
					const effectiveGroupAcceptance = groupTimedOut || groupStopped ? undefined : groupAcceptance;
					const groupAcceptanceFailure = effectiveDynamicGroupAcceptance.explicit && effectiveGroupAcceptance && (!isAgentContract(step.agentContract) || step.gateOn === "acceptance") ? acceptanceFailureMessage(effectiveGroupAcceptance) : undefined;
					const groupError = groupStopped ? stopMessage : groupTimedOut ? timeoutMessage ?? "Subagent timed out." : groupAcceptanceFailure;
					markDynamicGraphGroup(stepIndex, groupError ? groupStopped ? "stopped" : "failed" : "completed", groupError, effectiveGroupAcceptance);
					if (groupError) {
						results.push(omitUndefinedProperties({
							agent: step.parallel.agent,
							output: groupError,
							error: groupError,
							success: false,
							exitCode: 1,
							timedOut: groupTimedOut ? true : undefined,
							stopped: groupStopped ? true : undefined,
							structuredOutput: collection,
							acceptance: effectiveGroupAcceptance,
						}));
						statusPayload.error = groupError;
						setOptionalProperty(statusPayload, "stopped", groupStopped ? true : statusPayload.stopped);
					}
				} catch (error) {
					const message = error instanceof DynamicFanoutError ? error.message : error instanceof Error ? error.message : String(error);
					results.push(omitUndefinedProperties({ agent: step.parallel.agent, context: step.parallel.context, output: message, error: message, success: false, exitCode: 1, structuredOutput: collection }));
					statusPayload.error = message;
					markDynamicGraphGroup(stepIndex, "failed", message);
				}
			}
			previousOutput = aggregateParallelOutputs(
				parallelResults.map((r, i) => omitUndefinedProperties({
					agent: r.agent,
					taskIndex: i,
					output: r.output,
					exitCode: r.exitCode,
					error: r.error,
				})),
				(i, agent) => `=== Dynamic Item ${i + 1} (${agent}, key ${materialized.items[i]?.key ?? i}) ===`,
			);
			appendJsonl(eventsPath, JSON.stringify({
				type: "subagent.dynamic.completed",
				ts: Date.now(),
				runId: id,
				stepIndex,
				success: failures.length === 0 && acceptanceFailures.length === 0,
			}));
			if (failures.length > 0) markDynamicGraphGroup(stepIndex, "failed", failures[0]?.error ?? "Dynamic fanout child failed.");
			statusPayload.lastUpdate = Date.now();
			writeStatusPayload();
			if (failures.length > 0 || statusPayload.error) break;
			continue;
		}

		if (isParallelGroup(step)) {
			const group = step;
			const concurrency = group.concurrency ?? MAX_PARALLEL_CONCURRENCY;
			const failFast = group.failFast ?? false;
			const groupStartFlatIndex = flatIndex;
			let aborted = false;
			let worktreeSetup: WorktreeSetup | undefined;
			let worktreeFinalized = false;
			if (group.worktree) {
				const worktreeTaskCwdConflict = findWorktreeTaskCwdConflict(group.parallel, cwd);
				if (worktreeTaskCwdConflict) {
					const failedAt = Date.now();
					markParallelGroupSetupFailure({
						statusPayload,
						results,
						group,
						groupStartFlatIndex,
						setupError: formatWorktreeTaskCwdConflict(worktreeTaskCwdConflict, cwd),
						failedAt,
						statusPath,
						eventsPath,
						asyncDir,
						runId: id,
						stepIndex,
						writeStatus: () => writeStatusPayload(),
					});
					flatIndex += group.parallel.length;
					break;
				}
				try {
					worktreeSetup = await createWorktrees(cwd, `${id}-s${stepIndex}`, group.parallel.length, omitUndefinedProperties({
						signal: setupSignal,
						deadlineAt: config.deadlineAt,
						agents: group.parallel.map((task) => task.agent),
						labels: group.parallel.map((task) => task.lane?.key ?? config.workflowKey ?? task.outputName ?? task.label),
						tasks: group.parallel.map((task) => task.task),
						provider: config.worktreeProvider,
						baseRef: config.baseRef,
						branchPrefix: config.worktreeBranchPrefix,
						setupHook: config.worktreeSetupHook
							? omitUndefinedProperties({ hookPath: config.worktreeSetupHook, timeoutMs: config.worktreeSetupHookTimeoutMs })
							: undefined,
						baseDir: config.worktreeBaseDir,
						onProgress: (progress) => {
							publishSetupUnknown(progress);
							for (const worktree of progress.setup.worktrees) setStatusWorktreeReference(requiredStatusStep(statusPayload, groupStartFlatIndex + worktree.index), worktree);
							const pendingHandoff = writeWorktreeSetupHandoff({
								manifestPath: parallelHandoffPath(asyncDir),
								runId: id,
								mode: (config.resultMode ?? statusPayload.mode) === "parallel" ? "parallel" : "chain",
								source: "async",
								cwd,
								stepIndex,
								flatStartIndex: groupStartFlatIndex,
								progress,
								laneBindings: handoffWorkflowKey || config.lane ? [{ index: groupStartFlatIndex, taskIndex: 0, ...(handoffWorkflowKey ? { workflowKey: handoffWorkflowKey } : {}), ...(handoffChildRunId ? { runId: handoffChildRunId } : {}), ...(config.lane ? { lane: config.lane } : {}) }] : undefined,
							});
							if (!pendingHandoff) return;
							statusPayload.parallelHandoff = pendingHandoff;
							statusPayload.lastUpdate = Date.now();
							writeStatusPayload();
						},
					}));
					if (config.deadlineAt !== undefined && Date.now() >= config.deadlineAt) timeoutRunner();
					if (setupSignal.aborted) throw new Error(stopped ? stopMessage : timedOut ? timeoutMessage ?? "Subagent timed out." : "Subagent paused during worktree setup.");
				} catch (error) {
					if (worktreeSetup) await cleanupRemainingWorktree(worktreeSetup, stepIndex, groupStartFlatIndex);
					if (config.deadlineAt !== undefined && Date.now() >= config.deadlineAt) timeoutRunner();
					const setupError = error instanceof Error ? error.message : String(error);
					if (error instanceof WorktreeSetupError) publishSetupUnknown(error.snapshot);
					for (let index = groupStartFlatIndex; index < groupStartFlatIndex + group.parallel.length; index++) {
						if (childStopRequests.has(index)) markChildStopped(index);
					}
					const failedAt = Date.now();
					markParallelGroupSetupFailure({
						statusPayload,
						results,
						group,
						groupStartFlatIndex,
						setupError,
						failedAt,
						statusPath,
						eventsPath,
						asyncDir,
						runId: id,
						stepIndex,
						writeStatus: () => writeStatusPayload(),
					});
					flatIndex += group.parallel.length;
					break;
				}
			}

			try {
				if (group.worktree) ensureParallelProgressFile(cwd, group);
				const groupStartTime = Date.now();
				markParallelGroupRunning({
					statusPayload,
					group,
					groupStartFlatIndex,
					groupStartTime,
					statusPath,
					eventsPath,
					asyncDir,
					runId: id,
					stepIndex,
					writeStatus: () => writeStatusPayload(),
				});
				const parallelResults = await mapConcurrent(
					group.parallel,
					concurrency,
					async (task, taskIdx): Promise<StepResult> => {
						const fi = groupStartFlatIndex + taskIdx;
						refreshUsageBudget();
						if (statusPayload.usageBudget?.exhausted) {
							const skippedAt = Date.now();
							const message = usageBudgetExceededMessage(statusPayload.usageBudget);
							requiredStatusStep(statusPayload, fi).status = "failed";
							requiredStatusStep(statusPayload, fi).error = message;
							requiredStatusStep(statusPayload, fi).startedAt = skippedAt;
							requiredStatusStep(statusPayload, fi).endedAt = skippedAt;
							requiredStatusStep(statusPayload, fi).durationMs = 0;
							requiredStatusStep(statusPayload, fi).exitCode = 1;
							delete requiredStatusStep(statusPayload, fi).activityState;
							statusPayload.lastUpdate = skippedAt;
							usageBudgetExceeded = true;
							writeStatusPayload();
							appendJsonl(eventsPath, JSON.stringify({
								type: "subagent.step.failed", ts: skippedAt, runId: id, stepIndex: fi, agent: task.agent, exitCode: 1, durationMs: 0,
							}));
							return omitUndefinedProperties({ agent: task.agent, ...(task.sessionName ? { sessionName: task.sessionName } : {}), context: task.context, output: message, error: message, exitCode: 1 as number | null, skipped: true });
						}
						if (timedOut) return timedOutStepResult(task.agent, task.context, task.sessionName);
						if (stopped) return stoppedStepResult(task.agent, task.context, task.sessionName);
						if (childStopRequests.has(fi)) return childStopResult(fi, task.agent, task.context);
						if (interrupted) return pausedStepResult(task.agent, task.context, task.sessionName);
						if (aborted && failFast) {
							const skippedAt = Date.now();
							requiredStatusStep(statusPayload, fi).status = "failed";
							requiredStatusStep(statusPayload, fi).error = "Skipped due to fail-fast";
							requiredStatusStep(statusPayload, fi).startedAt = skippedAt;
							requiredStatusStep(statusPayload, fi).endedAt = skippedAt;
							requiredStatusStep(statusPayload, fi).durationMs = 0;
							requiredStatusStep(statusPayload, fi).exitCode = -1;
							delete requiredStatusStep(statusPayload, fi).activityState;
							statusPayload.lastUpdate = skippedAt;
							writeStatusPayload();
							appendJsonl(eventsPath, JSON.stringify({
								type: "subagent.step.failed", ts: skippedAt, runId: id, stepIndex: fi, agent: task.agent, exitCode: -1, durationMs: 0,
							}));
							return omitUndefinedProperties({ agent: task.agent, ...(task.sessionName ? { sessionName: task.sessionName } : {}), context: task.context, output: "(skipped — fail-fast)", exitCode: -1 as number | null, skipped: true });
						}

						const taskStartTime = Date.now();
						statusPayload.currentStep = fi;
						requiredStatusStep(statusPayload, fi).status = "running";
						delete requiredStatusStep(statusPayload, fi).error;
						delete requiredStatusStep(statusPayload, fi).activityState;
						resetStepLiveDetail(requiredStatusStep(statusPayload, fi));
						requiredStatusStep(statusPayload, fi).startedAt = taskStartTime;
						delete requiredStatusStep(statusPayload, fi).endedAt;
						delete requiredStatusStep(statusPayload, fi).durationMs;
						requiredStatusStep(statusPayload, fi).lastActivityAt = taskStartTime;
						statusPayload.outputFile = path.join(asyncDir, `output-${fi}.log`);
						statusPayload.lastActivityAt = taskStartTime;
						statusPayload.lastUpdate = taskStartTime;
						writeStatusPayload();

						appendJsonl(eventsPath, JSON.stringify({
							type: "subagent.step.started", ts: taskStartTime, runId: id, stepIndex: fi, agent: task.agent,
						}));

						const taskSessionDir = config.sessionDir
							? path.join(config.sessionDir, `parallel-${taskIdx}`)
							: undefined;
						const { taskForRun, taskCwd } = prepareParallelTaskRun(task, cwd, worktreeSetup, taskIdx);
						flushPendingStepSteers(fi);

						const singleResult = await runSingleStepWithTimeout(taskForRun, compactOptional<SingleStepContext>({
							previousOutput, placeholder, cwd: taskCwd, sessionEnabled,
							outputs,
							sessionDir: taskSessionDir,
							artifactsDir, artifactConfig, id,
							flatIndex: fi, flatStepCount: Math.max(statusPayload.steps.length, 1),
							outputFile: path.join(asyncDir, `output-${fi}.log`),
							piPackageRoot: config.piPackageRoot,
							childSessions,
							inheritedChildRuntime: config.inheritedChildRuntime,
							childIntercomTarget: config.childIntercomTargets?.[fi],
							orchestratorIntercomTarget: config.controlIntercomTarget,
							nestedRoute: config.nestedRoute,
							capabilityCeiling: config.capabilityCeiling,
							runFanoutBudget: config.runFanoutBudget,
							registerInterrupt: (interrupt) => registerStepInterrupt(fi, interrupt),
							registerTimeout: (interrupt) => registerStepTimeout(fi, interrupt),
							registerStop: (stop) => registerStepStop(fi, stop),
							registerSteer: (steer) => registerStepSteer(fi, steer),
							timeoutSignal: timeoutAbortController.signal,
							stopSignal: stopAbortController.signal,
							trackedMutationEvidenceForCompletionGuard: Boolean(worktreeSetup),
							timeoutMessage,
							stopMessage,
							toolTimeoutMs: taskForRun.toolTimeoutMs ?? config.toolTimeoutMs,
							onAttemptStart: (attempt) => updateStepModel(fi, attempt.model, attempt.thinking, attempt.contextLimit),
							onChildEvent: (event) => updateStepFromChildEvent(fi, event),
							onExternalProcess: (process) => updateExternalProcess(fi, process),
							onExternalJob: (externalJob) => updateExternalJob(fi, externalJob),
							skipAcceptance: () => timedOut || stopped || childStopRequests.has(fi),
							usageBudgetExhausted: () => refreshUsageBudget()?.exhausted === true,
							orcaProgressTab,
						}), config.deadlineAt);
						if (task.sessionFile) {
							latestSessionFile = task.sessionFile;
						}

						const taskEndTime = Date.now();
						const taskDuration = taskEndTime - taskStartTime;
						const childInterrupted = singleResult.interrupted === true;
						const childStopped = singleResult.stopped === true;

						requiredStatusStep(statusPayload, fi).status = stopped || childStopped ? "stopped" : timedOut ? "failed" : childInterrupted ? "paused" : singleResult.exitCode === 0 ? "complete" : "failed";
						requiredStatusStep(statusPayload, fi).endedAt = taskEndTime;
						requiredStatusStep(statusPayload, fi).durationMs = taskDuration;
						requiredStatusStep(statusPayload, fi).exitCode = stopped || childStopped ? 1 : timedOut ? 1 : childInterrupted ? 0 : singleResult.exitCode;
						setOptionalProperty(requiredStatusStep(statusPayload, fi), "timedOut", timedOut || singleResult.timedOut ? true : undefined);
						setOptionalProperty(requiredStatusStep(statusPayload, fi), "stopped", stopped || childStopped ? true : undefined);
						setOptionalProperty(requiredStatusStep(statusPayload, fi), "toolBudget", singleResult.toolBudget);
						setOptionalProperty(requiredStatusStep(statusPayload, fi), "toolBudgetBlocked", singleResult.toolBudgetBlocked);
						if (singleResult.toolBudget) statusPayload.toolBudget = singleResult.toolBudget;
						if (singleResult.toolBudgetBlocked) statusPayload.toolBudgetBlocked = true;
						setOptionalProperty(requiredStatusStep(statusPayload, fi), "sessionName", singleResult.sessionName);
						setOptionalProperty(requiredStatusStep(statusPayload, fi), "model", singleResult.model);
						setOptionalProperty(requiredStatusStep(statusPayload, fi), "thinking", resolveEffectiveThinking(singleResult.model, requiredStatusStep(statusPayload, fi).thinking));
						setOptionalProperty(requiredStatusStep(statusPayload, fi), "attemptedModels", singleResult.attemptedModels);
						setOptionalProperty(requiredStatusStep(statusPayload, fi), "modelAttempts", singleResult.modelAttempts);
						setOptionalProperty(requiredStatusStep(statusPayload, fi), "contextOverflow", singleResult.contextOverflow);
						setOptionalProperty(requiredStatusStep(statusPayload, fi), "totalCost", singleResult.totalCost);
						if (singleResult.totalCost) {
							pendingParallelUsageCost = {
								inputTokens: pendingParallelUsageCost.inputTokens + singleResult.totalCost.inputTokens,
								outputTokens: pendingParallelUsageCost.outputTokens + singleResult.totalCost.outputTokens,
								costUsd: pendingParallelUsageCost.costUsd + singleResult.totalCost.costUsd,
							};
							refreshUsageBudget();
						}
						setOptionalProperty(requiredStatusStep(statusPayload, fi), "error", stopped || childStopped ? stopMessage : timedOut ? (timeoutMessage ?? "Subagent timed out.") : singleResult.error);
						setOptionalProperty(requiredStatusStep(statusPayload, fi), "transcriptPath", singleResult.transcriptPath ?? requiredStatusStep(statusPayload, fi).transcriptPath);
						setOptionalProperty(requiredStatusStep(statusPayload, fi), "transcriptError", singleResult.transcriptError);
						setOptionalProperty(requiredStatusStep(statusPayload, fi), "agentContract", singleResult.agentContract);
						setOptionalProperty(requiredStatusStep(statusPayload, fi), "launchResolvedExtensions", singleResult.launchResolvedExtensions);
						setOptionalProperty(requiredStatusStep(statusPayload, fi), "runtimeAcknowledgedExtensions", singleResult.runtimeAcknowledgedExtensions);
						setOptionalProperty(requiredStatusStep(statusPayload, fi), "effects", singleResult.effects);
						setOptionalProperty(requiredStatusStep(statusPayload, fi), "execution", singleResult.execution);
						setOptionalProperty(requiredStatusStep(statusPayload, fi), "review", singleResult.review);
						setOptionalProperty(requiredStatusStep(statusPayload, fi), "structuredOutput", singleResult.structuredOutput);
						setOptionalProperty(requiredStatusStep(statusPayload, fi), "structuredOutputPath", singleResult.structuredOutputPath);
						setOptionalProperty(requiredStatusStep(statusPayload, fi), "structuredOutputSchemaPath", singleResult.structuredOutputSchemaPath);
						setOptionalProperty(requiredStatusStep(statusPayload, fi), "acceptance", singleResult.acceptance);
						setOptionalProperty(requiredStatusStep(statusPayload, fi), "timeoutRecovery", singleResult.timeoutRecovery);
						setOptionalProperty(requiredStatusStep(statusPayload, fi), "watchdog", singleResult.watchdog);
						setOptionalProperty(requiredStatusStep(statusPayload, fi), "capabilityCeiling", singleResult.capabilityCeiling);
						setOptionalProperty(requiredStatusStep(statusPayload, fi), "capabilityAudit", singleResult.capabilityAudit);
						if (singleResult.capabilityCeiling) statusPayload.capabilityCeiling = singleResult.capabilityCeiling;
						if (singleResult.capabilityAudit) statusPayload.capabilityAudit = singleResult.capabilityAudit;
						statusPayload.lastUpdate = taskEndTime;
						writeStatusPayload();
						appendCapabilityCeilingAppliedEvent(eventsPath, id, fi, task.agent, singleResult);

						appendJsonl(eventsPath, JSON.stringify({
							type: stopped || childStopped ? "subagent.step.stopped" : timedOut ? "subagent.step.failed" : childInterrupted ? "subagent.step.paused" : singleResult.exitCode === 0 ? "subagent.step.completed" : "subagent.step.failed",
							ts: taskEndTime, runId: id, stepIndex: fi, agent: task.agent,
							exitCode: stopped || childStopped ? 1 : timedOut ? 1 : childInterrupted ? 0 : singleResult.exitCode, durationMs: taskDuration,
						}));
						if (stopped || childStopped) appendTerminalChildStatusEvent(fi, taskEndTime);
						if (singleResult.completionGuardTriggered) {
							const event = buildControlEvent(omitUndefinedProperties({
								from: requiredStatusStep(statusPayload, fi).activityState,
								to: "needs_attention",
								runId: id,
								agent: task.agent,
								index: fi,
								ts: taskEndTime,
								message: `${task.agent} completed without making edits for an implementation task`,
								reason: "completion_guard",
							}));
							appendControlEvent(event);
						}

						if (singleResult.exitCode !== 0 && failFast && !childStopped) aborted = true;
						return stopped || childStopped ? { ...singleResult, output: stopMessage, error: stopMessage, exitCode: 1, interrupted: false, timedOut: false, stopped: true, skipped: false } : timedOut ? { ...singleResult, output: singleResult.output || (timeoutMessage ?? "Subagent timed out."), error: singleResult.error ?? timeoutMessage ?? "Subagent timed out.", exitCode: 1, interrupted: false, timedOut: true, skipped: false } : { ...singleResult, skipped: false };
					},
					globalSemaphore,
				);

				flatIndex += group.parallel.length;

				for (let t = 0; t < group.parallel.length; t++) {
					const fi = groupStartFlatIndex + t;
					const sessionTokens = config.sessionDir
						? parseSessionTokens(path.join(config.sessionDir, `parallel-${t}`))
						: null;
					const fallbackTokens = tokenUsageFromAttempts(parallelResults[t]?.modelAttempts);
					const observedTokens = requiredStatusStep(statusPayload, fi).tokens;
					const taskTokens = sessionTokens ?? (fallbackTokens
						? { ...fallbackTokens, ...(observedTokens?.window !== undefined ? { window: observedTokens.window } : {}), ...(observedTokens?.windowPeak !== undefined ? { windowPeak: observedTokens.windowPeak } : {}) }
						: null);
					if (!taskTokens) continue;
					requiredStatusStep(statusPayload, fi).tokens = taskTokens;
					previousCumulativeTokens = {
						input: previousCumulativeTokens.input + taskTokens.input,
						output: previousCumulativeTokens.output + taskTokens.output,
						total: previousCumulativeTokens.total + taskTokens.total,
						...(taskTokens.window !== undefined ? { window: taskTokens.window } : {}),
						...(previousCumulativeTokens.windowPeak !== undefined || taskTokens.windowPeak !== undefined
							? { windowPeak: Math.max(previousCumulativeTokens.windowPeak ?? 0, taskTokens.windowPeak ?? 0) }
							: {}),
					};
				}
				statusPayload.totalTokens = { ...previousCumulativeTokens };
				statusPayload.lastUpdate = Date.now();
				writeStatusPayload();

				for (const pr of parallelResults) {
					results.push(omitUndefinedProperties({
						agent: pr.agent,
						context: pr.context,
						agentContract: pr.agentContract,
						launchContractDigest: pr.launchContractDigest,
						launchResolvedExtensions: pr.launchResolvedExtensions,
						output: pr.output,
						outputState: pr.outputState,
						error: pr.error,
						success: pr.stopped !== true && pr.interrupted !== true && pr.exitCode === 0,
						exitCode: pr.interrupted === true ? 0 : pr.exitCode,
						skipped: pr.skipped,
						interrupted: pr.interrupted,
						timedOut: pr.timedOut,
						stopped: pr.stopped,
						toolBudget: pr.toolBudget,
						toolBudgetBlocked: pr.toolBudgetBlocked,
						sessionFile: pr.sessionFile,
						intercomTarget: pr.intercomTarget,
						model: pr.model,
						thinking: pr.thinking,
						attemptedModels: pr.attemptedModels,
						modelAttempts: pr.modelAttempts,
						contextOverflow: pr.contextOverflow,
						totalCost: pr.totalCost,
						usage: pr.usage,
						artifactPaths: pr.artifactPaths,
						transcriptPath: pr.transcriptPath,
						transcriptError: pr.transcriptError,
							effects: pr.effects,
							execution: pr.execution,
							review: pr.review,
							timeoutRecovery: pr.timeoutRecovery,
							structuredOutput: pr.structuredOutput,
						structuredOutputPath: pr.structuredOutputPath,
						structuredOutputSchemaPath: pr.structuredOutputSchemaPath,
						acceptance: pr.acceptance,
						watchdog: pr.watchdog,
					}));
				}
				pendingParallelUsageCost = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
				refreshUsageBudget();
				for (let t = 0; t < group.parallel.length; t++) {
					const outputName = group.parallel[t]?.outputName;
					if (outputName) outputs[outputName] = outputEntryFromAsyncResult({
						agent: parallelResults[t]!.agent,
						output: parallelResults[t]!.output,
						structuredOutput: parallelResults[t]!.structuredOutput,
					}, stepIndex);
				}
				statusPayload.outputs = outputs;

				previousOutput = aggregateParallelOutputs(
					parallelResults.map((r) => omitUndefinedProperties({
						agent: r.agent,
						output: r.output,
						exitCode: r.exitCode,
						error: r.error,
						model: r.model,
						attemptedModels: r.attemptedModels,
					})),
				);
				if (worktreeSetup) {
					const setup = worktreeSetup;
					worktreeFinalized = true;
					await finalizeWorktree(setup, stepIndex, groupStartFlatIndex, () => {
						const captured = captureParallelWorktreeDiffs(setup, asyncDir, stepIndex, group);
						if (captured.summary) previousOutput = `${previousOutput}\n\n${captured.summary}`;
						const manifestPath = parallelHandoffPath(asyncDir);
						const handoff = {
							manifestPath,
							runId: id,
							mode: (config.resultMode ?? statusPayload.mode) === "parallel" ? "parallel" as const : "chain" as const,
							source: "async" as const,
							cwd,
							stepIndex,
							flatStartIndex: groupStartFlatIndex,
							setup,
							diffs: captured.diffs,
							results: parallelResults.map((result) => ({
								agent: result.agent,
								...(handoffWorkflowKey ? { workflowKey: handoffWorkflowKey } : {}),
								...(handoffChildRunId ? { runId: handoffChildRunId } : {}),
								...(config.lane ? { lane: config.lane } : {}),
								status: result.stopped || (result.exitCode !== 0 && isUnexplainedProcessSignal(omitUndefinedProperties({
									processSignal: result.processSignal,
									interrupted: result.interrupted,
									timedOut: result.timedOut,
									stopped: result.stopped,
								}))) ? "stopped" as const : result.interrupted ? "paused" as const : result.exitCode === 0 ? "completed" as const : "failed" as const,
								summary: result.output || result.error || "(no output)",
								...(result.artifactPaths?.outputPath ? { outputPath: result.artifactPaths.outputPath } : {}),
								...(result.structuredOutput !== undefined ? { structuredOutput: result.structuredOutput } : {}),
								...(result.structuredOutputPath ? { structuredOutputPath: result.structuredOutputPath } : {}),
								...(result.sessionFile ? { sessionPath: result.sessionFile } : {}),
							})),
						};
						try {
							writeParallelHandoffGroup(handoff);
							const cleanup = cleanupWorktrees(setup, { kind: "preserve", capturedDiffs: captured.diffs, handoffManifestPath: manifestPath });
							statusPayload.parallelHandoff = writeParallelHandoffGroup({ ...handoff, cleanup });
							previousOutput = `${previousOutput}\n\n${formatParallelHandoffReference(statusPayload.parallelHandoff)}`;
						} catch (error) {
							previousOutput = `${previousOutput}\n\n${formatParallelHandoffError(error)}`;
						}
						writeStatusPayload();
					});
				}

				appendJsonl(eventsPath, JSON.stringify({
					type: "subagent.parallel.completed",
					ts: Date.now(),
					runId: id,
					stepIndex,
					success: parallelResults.every((r) => r.exitCode === 0 || r.exitCode === -1)
						&& parallelResults.every((result, index) => !(isAgentContract(group.parallel[index]?.agentContract) && group.parallel[index]?.gateOn === "acceptance" && result.acceptance?.status === "rejected")),
				}));

				const acceptanceGateFailure = parallelResults
					.map((result, index) => ({ result, index, task: group.parallel[index] }))
					.find(({ result, task }) => isAgentContract(task?.agentContract) && task?.gateOn === "acceptance" && result.acceptance?.status === "rejected");
				if (acceptanceGateFailure) {
					statusPayload.error = (acceptanceGateFailure.result.acceptance ? acceptanceFailureMessage(acceptanceGateFailure.result.acceptance) : undefined) ?? "Parallel acceptance gate rejected the step.";
					writeStatusPayload();
					break;
				}
				if (parallelResults.some((r) => r.exitCode !== 0 && r.exitCode !== -1)) {
					break;
				}
			} finally {
				if (worktreeSetup && !worktreeFinalized) await cleanupRemainingWorktree(worktreeSetup, stepIndex, groupStartFlatIndex);
			}
		} else {
			const seqStep = step as SubagentStep;
			if (timedOut) {
				results.push(timedOutStepResult(seqStep.agent, seqStep.context, seqStep.sessionName));
				flatIndex++;
				continue;
			}
			if (stopped) {
				results.push(stoppedStepResult(seqStep.agent, seqStep.context, seqStep.sessionName));
				flatIndex++;
				continue;
			}
			if (childStopRequests.has(flatIndex)) {
				results.push(childStopResult(flatIndex, seqStep.agent, seqStep.context));
				flatIndex++;
				continue;
			}
			if (interrupted) {
				results.push(pausedStepResult(seqStep.agent, seqStep.context, seqStep.sessionName));
				flatIndex++;
				continue;
			}
			let singleWorktreeSetup: WorktreeSetup | undefined;
			if (seqStep.worktree) {
				try {
					singleWorktreeSetup = await createWorktrees(cwd, `${id}-s${stepIndex}`, 1, omitUndefinedProperties({
						signal: setupSignal,
						deadlineAt: config.deadlineAt,
						agents: [seqStep.agent],
						labels: [seqStep.lane?.key ?? config.workflowKey ?? seqStep.outputName ?? seqStep.label],
						tasks: [seqStep.task],
						provider: config.worktreeProvider,
						baseRef: config.baseRef,
						branchPrefix: config.worktreeBranchPrefix,
						setupHook: config.worktreeSetupHook
							? omitUndefinedProperties({ hookPath: config.worktreeSetupHook, timeoutMs: config.worktreeSetupHookTimeoutMs })
							: undefined,
						baseDir: config.worktreeBaseDir,
						onProgress: (progress) => {
							publishSetupUnknown(progress);
							const worktree = progress.setup.worktrees[0];
							if (worktree) {
								setStatusWorktreeReference(requiredStatusStep(statusPayload, flatIndex), worktree);
							}
							const pendingHandoff = writeWorktreeSetupHandoff({
								manifestPath: parallelHandoffPath(asyncDir),
								runId: id,
								mode: "single",
								source: "async",
								cwd,
								stepIndex,
								flatStartIndex: flatIndex,
								progress,
								laneBindings: handoffWorkflowKey || config.lane ? [{ index: flatIndex, taskIndex: 0, ...(handoffWorkflowKey ? { workflowKey: handoffWorkflowKey } : {}), ...(handoffChildRunId ? { runId: handoffChildRunId } : {}), ...(config.lane ? { lane: config.lane } : {}) }] : undefined,
							});
							if (!pendingHandoff) return;
							statusPayload.parallelHandoff = pendingHandoff;
							statusPayload.lastUpdate = Date.now();
							writeStatusPayload();
						},
					}));
				} catch (error) {
					if (error instanceof WorktreeSetupError) publishSetupUnknown(error.snapshot);
					if (config.deadlineAt !== undefined && Date.now() >= config.deadlineAt) timeoutRunner();
					const message = error instanceof Error ? error.message : String(error);
					if (childStopRequests.has(flatIndex)) markChildStopped(flatIndex);
					const statusStep = requiredStatusStep(statusPayload, flatIndex);
					statusStep.status = stopped || childStopRequests.has(flatIndex) ? "stopped" : interrupted ? "paused" : "failed";
					statusStep.error ??= message;
					statusStep.exitCode = interrupted ? 0 : 1;
					statusStep.endedAt = Date.now();
					results.push(stopped ? stoppedStepResult(seqStep.agent, seqStep.context, seqStep.sessionName)
						: childStopRequests.has(flatIndex) ? childStopResult(flatIndex, seqStep.agent, seqStep.context)
						: timedOut ? timedOutStepResult(seqStep.agent, seqStep.context, seqStep.sessionName)
						: interrupted ? pausedStepResult(seqStep.agent, seqStep.context, seqStep.sessionName)
						: { agent: seqStep.agent, output: message, error: message, exitCode: 1, success: false });
					statusPayload.error ??= message;
					writeStatusPayload();
					flatIndex++;
					break;
				}
			}
			if (singleWorktreeSetup && config.deadlineAt !== undefined && Date.now() >= config.deadlineAt) timeoutRunner();
			if (singleWorktreeSetup && (timedOut || stopped || interrupted || childStopRequests.has(flatIndex))) {
				await cleanupRemainingWorktree(singleWorktreeSetup, stepIndex, flatIndex);
				results.push(stopped ? stoppedStepResult(seqStep.agent, seqStep.context, seqStep.sessionName)
					: childStopRequests.has(flatIndex) ? childStopResult(flatIndex, seqStep.agent, seqStep.context)
					: timedOut ? timedOutStepResult(seqStep.agent, seqStep.context, seqStep.sessionName)
					: pausedStepResult(seqStep.agent, seqStep.context, seqStep.sessionName));
				if (interrupted) requiredStatusStep(statusPayload, flatIndex).status = "paused";
				flatIndex++;
				continue;
			}
			const singleCwd = singleWorktreeSetup?.worktrees[0]?.agentCwd ?? cwd;
			const stepStartTime = Date.now();
			statusPayload.currentStep = flatIndex;
			requiredStatusStep(statusPayload, flatIndex).status = "running";
			delete requiredStatusStep(statusPayload, flatIndex).activityState;
			delete statusPayload.activityState;
			resetStepLiveDetail(requiredStatusStep(statusPayload, flatIndex));
			setOptionalProperty(requiredStatusStep(statusPayload, flatIndex), "skills", seqStep.skills);
			requiredStatusStep(statusPayload, flatIndex).startedAt = stepStartTime;
			requiredStatusStep(statusPayload, flatIndex).lastActivityAt = stepStartTime;
			statusPayload.lastActivityAt = stepStartTime;
			statusPayload.lastUpdate = stepStartTime;
			statusPayload.outputFile = path.join(asyncDir, `output-${flatIndex}.log`);
			writeStatusPayload();

			appendJsonl(eventsPath, JSON.stringify({
				type: "subagent.step.started",
				ts: stepStartTime,
				runId: id,
				stepIndex: flatIndex,
				agent: seqStep.agent,
			}));

			flushPendingStepSteers(flatIndex);
			const executionStep = singleWorktreeSetup
				? bindWorktreeCwd({ ...seqStep, cwd: singleCwd }, singleCwd)
				: seqStep;
			let singleResult: Awaited<ReturnType<typeof runSingleStepWithTimeout>>;
			try {
				singleResult = await runSingleStepWithTimeout(executionStep, compactOptional<SingleStepContext>({
				previousOutput, placeholder, cwd: singleCwd, sessionEnabled,
				outputs: statusPayload.mode === "single" ? undefined : outputs,
				sessionDir: config.sessionDir,
				artifactsDir, artifactConfig, id,
				flatIndex, flatStepCount: Math.max(statusPayload.steps.length, 1),
				outputFile: path.join(asyncDir, `output-${flatIndex}.log`),
				piPackageRoot: config.piPackageRoot,
				childSessions,
				inheritedChildRuntime: config.inheritedChildRuntime,
				childIntercomTarget: config.childIntercomTargets?.[flatIndex],
				orchestratorIntercomTarget: config.controlIntercomTarget,
				nestedRoute: config.nestedRoute,
				capabilityCeiling: config.capabilityCeiling,
				runFanoutBudget: config.runFanoutBudget,
				registerInterrupt: (interrupt) => registerStepInterrupt(flatIndex, interrupt),
				registerTimeout: (interrupt) => registerStepTimeout(flatIndex, interrupt),
				registerStop: (stop) => registerStepStop(flatIndex, stop),
				registerSteer: (steer) => registerStepSteer(flatIndex, steer),
				timeoutSignal: timeoutAbortController.signal,
				stopSignal: stopAbortController.signal,
				timeoutMessage,
				stopMessage,
				toolTimeoutMs: seqStep.toolTimeoutMs ?? config.toolTimeoutMs,
				onAttemptStart: (attempt) => updateStepModel(flatIndex, attempt.model, attempt.thinking, attempt.contextLimit),
				onChildEvent: (event) => updateStepFromChildEvent(flatIndex, event),
				onExternalProcess: (process) => updateExternalProcess(flatIndex, process),
				onExternalJob: (externalJob) => updateExternalJob(flatIndex, externalJob),
				skipAcceptance: () => timedOut || stopped || childStopRequests.has(flatIndex),
				usageBudgetExhausted: () => refreshUsageBudget()?.exhausted === true,
				orcaProgressTab,
				}), config.deadlineAt);
			} catch (error) {
				if (singleWorktreeSetup) await cleanupRemainingWorktree(singleWorktreeSetup, stepIndex, flatIndex);
				throw error;
			}
			if (seqStep.sessionFile) {
				latestSessionFile = seqStep.sessionFile;
			}

			previousOutput = singleResult.output;
			const childStopped = singleResult.stopped === true;
			results.push(omitUndefinedProperties({
				agent: singleResult.agent,
				...(singleResult.sessionName ? { sessionName: singleResult.sessionName } : {}),
				context: singleResult.context,
				agentContract: singleResult.agentContract,
				launchContractDigest: singleResult.launchContractDigest,
				launchResolvedExtensions: singleResult.launchResolvedExtensions,
				runtimeAcknowledgedExtensions: singleResult.runtimeAcknowledgedExtensions,
				output: stopped || childStopped ? stopMessage : timedOut ? singleResult.output || (timeoutMessage ?? "Subagent timed out.") : singleResult.output,
				outputState: singleResult.outputState,
				error: stopped || childStopped ? stopMessage : timedOut ? (timeoutMessage ?? "Subagent timed out.") : singleResult.error,
				success: !stopped && !childStopped && !timedOut && singleResult.interrupted !== true && singleResult.exitCode === 0,
				exitCode: stopped || childStopped ? 1 : timedOut ? 1 : singleResult.interrupted === true ? 0 : singleResult.exitCode,
				sessionFile: singleResult.sessionFile,
				intercomTarget: singleResult.intercomTarget,
				model: singleResult.model,
				thinking: singleResult.thinking,
				attemptedModels: singleResult.attemptedModels,
				modelAttempts: singleResult.modelAttempts,
				contextOverflow: singleResult.contextOverflow,
				totalCost: singleResult.totalCost,
				usage: singleResult.usage,
				artifactPaths: singleResult.artifactPaths,
				savedOutputPath: singleResult.savedOutputPath,
				transcriptPath: singleResult.transcriptPath,
				transcriptError: singleResult.transcriptError,
				effects: singleResult.effects,
				execution: singleResult.execution,
				review: singleResult.review,
				timeoutRecovery: singleResult.timeoutRecovery,
				structuredOutput: singleResult.structuredOutput,
				structuredOutputPath: singleResult.structuredOutputPath,
				structuredOutputSchemaPath: singleResult.structuredOutputSchemaPath,
				acceptance: singleResult.acceptance,
				watchdog: singleResult.watchdog,
				capabilityCeiling: singleResult.capabilityCeiling,
				capabilityAudit: singleResult.capabilityAudit,
				interrupted: singleResult.interrupted,
				timedOut: timedOut || singleResult.timedOut ? true : undefined,
				stopped: stopped || childStopped ? true : undefined,
				toolBudget: singleResult.toolBudget,
				toolBudgetBlocked: singleResult.toolBudgetBlocked,
				runner: singleResult.runner,
				externalProcess: singleResult.externalProcess,
				externalJob: singleResult.externalJob,
			}));
			if (seqStep.outputName) {
				outputs[seqStep.outputName] = outputEntryFromAsyncResult({
					agent: singleResult.agent,
					output: singleResult.output,
					structuredOutput: singleResult.structuredOutput,
				}, stepIndex);
			}
			statusPayload.outputs = outputs;

			const cumulativeTokens = config.sessionDir ? parseSessionTokens(config.sessionDir) : null;
			let stepTokens: TokenUsage | null = cumulativeTokens
				? {
						input: cumulativeTokens.input - previousCumulativeTokens.input,
						output: cumulativeTokens.output - previousCumulativeTokens.output,
						total: cumulativeTokens.total - previousCumulativeTokens.total,
						...(cumulativeTokens.window !== undefined ? { window: cumulativeTokens.window } : {}),
						...(cumulativeTokens.windowPeak !== undefined ? { windowPeak: cumulativeTokens.windowPeak } : {}),
					}
				: null;
			if (cumulativeTokens) {
				previousCumulativeTokens = cumulativeTokens;
			} else {
				const fallbackTokens = tokenUsageFromAttempts(singleResult.modelAttempts);
				const observedTokens = requiredStatusStep(statusPayload, flatIndex).tokens;
				stepTokens = fallbackTokens
					? { ...fallbackTokens, ...(observedTokens?.window !== undefined ? { window: observedTokens.window } : {}), ...(observedTokens?.windowPeak !== undefined ? { windowPeak: observedTokens.windowPeak } : {}) }
					: null;
				if (stepTokens) {
					previousCumulativeTokens = {
						input: previousCumulativeTokens.input + stepTokens.input,
						output: previousCumulativeTokens.output + stepTokens.output,
						total: previousCumulativeTokens.total + stepTokens.total,
						...(stepTokens.window !== undefined ? { window: stepTokens.window } : {}),
						...(previousCumulativeTokens.windowPeak !== undefined || stepTokens.windowPeak !== undefined
							? { windowPeak: Math.max(previousCumulativeTokens.windowPeak ?? 0, stepTokens.windowPeak ?? 0) }
							: {}),
					};
				}
			}

			const stepEndTime = Date.now();
			const childInterrupted = singleResult.interrupted === true;
			requiredStatusStep(statusPayload, flatIndex).status = stopped || childStopped ? "stopped" : timedOut ? "failed" : childInterrupted ? "paused" : singleResult.exitCode === 0 ? "complete" : "failed";
			requiredStatusStep(statusPayload, flatIndex).endedAt = stepEndTime;
			requiredStatusStep(statusPayload, flatIndex).durationMs = stepEndTime - stepStartTime;
			requiredStatusStep(statusPayload, flatIndex).exitCode = stopped || childStopped ? 1 : timedOut ? 1 : childInterrupted ? 0 : singleResult.exitCode;
			setOptionalProperty(requiredStatusStep(statusPayload, flatIndex), "timedOut", timedOut || singleResult.timedOut ? true : undefined);
			setOptionalProperty(requiredStatusStep(statusPayload, flatIndex), "stopped", stopped || childStopped ? true : undefined);
			setOptionalProperty(requiredStatusStep(statusPayload, flatIndex), "toolBudget", singleResult.toolBudget);
			setOptionalProperty(requiredStatusStep(statusPayload, flatIndex), "toolBudgetBlocked", singleResult.toolBudgetBlocked);
			if (singleResult.toolBudget) statusPayload.toolBudget = singleResult.toolBudget;
			if (singleResult.toolBudgetBlocked) statusPayload.toolBudgetBlocked = true;
			setOptionalProperty(requiredStatusStep(statusPayload, flatIndex), "sessionName", singleResult.sessionName);
			setOptionalProperty(requiredStatusStep(statusPayload, flatIndex), "model", singleResult.model);
			setOptionalProperty(requiredStatusStep(statusPayload, flatIndex), "thinking", resolveEffectiveThinking(singleResult.model, requiredStatusStep(statusPayload, flatIndex).thinking));
			setOptionalProperty(requiredStatusStep(statusPayload, flatIndex), "attemptedModels", singleResult.attemptedModels);
			setOptionalProperty(requiredStatusStep(statusPayload, flatIndex), "modelAttempts", singleResult.modelAttempts);
			setOptionalProperty(requiredStatusStep(statusPayload, flatIndex), "contextOverflow", singleResult.contextOverflow);
			setOptionalProperty(requiredStatusStep(statusPayload, flatIndex), "totalCost", singleResult.totalCost);
			setOptionalProperty(requiredStatusStep(statusPayload, flatIndex), "error", stopped || childStopped ? stopMessage : timedOut ? (timeoutMessage ?? "Subagent timed out.") : singleResult.error);
			setOptionalProperty(requiredStatusStep(statusPayload, flatIndex), "transcriptPath", singleResult.transcriptPath ?? requiredStatusStep(statusPayload, flatIndex).transcriptPath);
			setOptionalProperty(requiredStatusStep(statusPayload, flatIndex), "transcriptError", singleResult.transcriptError);
			setOptionalProperty(requiredStatusStep(statusPayload, flatIndex), "agentContract", singleResult.agentContract);
			setOptionalProperty(requiredStatusStep(statusPayload, flatIndex), "launchResolvedExtensions", singleResult.launchResolvedExtensions);
			setOptionalProperty(requiredStatusStep(statusPayload, flatIndex), "runtimeAcknowledgedExtensions", singleResult.runtimeAcknowledgedExtensions);
			setOptionalProperty(requiredStatusStep(statusPayload, flatIndex), "effects", singleResult.effects);
			setOptionalProperty(requiredStatusStep(statusPayload, flatIndex), "execution", singleResult.execution);
			setOptionalProperty(requiredStatusStep(statusPayload, flatIndex), "review", singleResult.review);
			setOptionalProperty(requiredStatusStep(statusPayload, flatIndex), "structuredOutput", singleResult.structuredOutput);
			setOptionalProperty(requiredStatusStep(statusPayload, flatIndex), "structuredOutputPath", singleResult.structuredOutputPath);
			setOptionalProperty(requiredStatusStep(statusPayload, flatIndex), "structuredOutputSchemaPath", singleResult.structuredOutputSchemaPath);
			setOptionalProperty(requiredStatusStep(statusPayload, flatIndex), "acceptance", singleResult.acceptance);
			setOptionalProperty(requiredStatusStep(statusPayload, flatIndex), "timeoutRecovery", singleResult.timeoutRecovery);
			setOptionalProperty(requiredStatusStep(statusPayload, flatIndex), "watchdog", singleResult.watchdog);
			setOptionalProperty(requiredStatusStep(statusPayload, flatIndex), "capabilityCeiling", singleResult.capabilityCeiling);
			setOptionalProperty(requiredStatusStep(statusPayload, flatIndex), "capabilityAudit", singleResult.capabilityAudit);
			if (singleResult.capabilityCeiling) statusPayload.capabilityCeiling = singleResult.capabilityCeiling;
			if (singleResult.capabilityAudit) statusPayload.capabilityAudit = singleResult.capabilityAudit;
			if (stepTokens) {
				requiredStatusStep(statusPayload, flatIndex).tokens = stepTokens;
				statusPayload.totalTokens = { ...previousCumulativeTokens };
			}
			statusPayload.lastUpdate = stepEndTime;
			writeStatusPayload();
			appendCapabilityCeilingAppliedEvent(eventsPath, id, flatIndex, seqStep.agent, singleResult);

			appendJsonl(eventsPath, JSON.stringify({
				type: stopped || childStopped ? "subagent.step.stopped" : timedOut ? "subagent.step.failed" : childInterrupted ? "subagent.step.paused" : singleResult.exitCode === 0 ? "subagent.step.completed" : "subagent.step.failed",
				ts: stepEndTime,
				runId: id,
				stepIndex: flatIndex,
				agent: seqStep.agent,
				exitCode: stopped || childStopped ? 1 : timedOut ? 1 : childInterrupted ? 0 : singleResult.exitCode,
				durationMs: stepEndTime - stepStartTime,
				tokens: stepTokens,
			}));
			if (stopped || childStopped) appendTerminalChildStatusEvent(flatIndex, stepEndTime);
			if (singleWorktreeSetup && !singleResult.detached) {
				const setup = singleWorktreeSetup;
				await finalizeWorktree(setup, stepIndex, flatIndex, () => {
					const diffs = diffWorktrees(setup, [seqStep.agent], path.join(asyncDir, "worktree-diffs", `step-${stepIndex}`));
					const diffSummary = formatWorktreeDiffSummary(diffs);
					const manifestPath = parallelHandoffPath(asyncDir);
					const handoff = {
						manifestPath,
						runId: id,
						mode: "single" as const,
						source: "async" as const,
						cwd,
						stepIndex,
						flatStartIndex: flatIndex,
						setup,
						diffs,
						results: [{
							agent: singleResult.agent,
							...(handoffWorkflowKey ? { workflowKey: handoffWorkflowKey } : {}),
							...(handoffChildRunId ? { runId: handoffChildRunId } : {}),
							...(config.lane ? { lane: config.lane } : {}),
							status: singleResult.stopped ? "stopped" as const : singleResult.interrupted ? "paused" as const : singleResult.exitCode === 0 ? "completed" as const : "failed" as const,
							summary: singleResult.output || singleResult.error || "(no output)",
							...(singleResult.artifactPaths?.outputPath ? { outputPath: singleResult.artifactPaths.outputPath } : {}),
							...(singleResult.structuredOutput !== undefined ? { structuredOutput: singleResult.structuredOutput } : {}),
							...(singleResult.structuredOutputPath ? { structuredOutputPath: singleResult.structuredOutputPath } : {}),
							...(singleResult.sessionFile ? { sessionPath: singleResult.sessionFile } : {}),
						}],
					};
					try {
						writeParallelHandoffGroup(handoff);
						const cleanup = cleanupWorktrees(setup, {
							kind: "preserve",
							capturedDiffs: diffs,
							handoffManifestPath: manifestPath,
							...(config.parentWorkflowRunId && singleResult.sessionFile && fs.existsSync(singleResult.sessionFile) && !singleResult.stopped
								? { cleanupBlocker: "retained child resume requires managed worktree cwd" }
								: {}),
						});
						statusPayload.parallelHandoff = writeParallelHandoffGroup({ ...handoff, cleanup });
						previousOutput = [previousOutput, diffSummary, formatParallelHandoffReference(statusPayload.parallelHandoff)].filter(Boolean).join("\n\n");
					} catch (error) {
						previousOutput = [previousOutput, diffSummary, formatParallelHandoffError(error)].filter(Boolean).join("\n\n");
					}
					writeStatusPayload();
				});
			}

			if (singleResult.completionGuardTriggered) {
				const event = buildControlEvent(omitUndefinedProperties({
					from: requiredStatusStep(statusPayload, flatIndex).activityState,
					to: "needs_attention",
					runId: id,
					agent: seqStep.agent,
					index: flatIndex,
					ts: stepEndTime,
					message: `${seqStep.agent} completed without making edits for an implementation task`,
					reason: "completion_guard",
				}));
				appendControlEvent(event);
			}

			flatIndex++;
			if (isAgentContract(seqStep.agentContract) && seqStep.gateOn === "acceptance" && singleResult.acceptance?.status === "rejected") {
				statusPayload.error = acceptanceFailureMessage(singleResult.acceptance) ?? "Chain acceptance gate rejected the step.";
				writeStatusPayload();
				break;
			}
			if (singleResult.exitCode !== 0) {
				break;
			}
		}
	}

	let summary = results.map((r) => `${r.agent}:\n${r.output || (r.exitCode !== 0 ? r.error : undefined) || "(no output)"}`).join("\n\n");
	let truncated = false;

	if (maxOutput) {
		const config = { ...DEFAULT_MAX_OUTPUT, ...maxOutput };
		const lastArtifactPath = results[results.length - 1]?.artifactPaths?.outputPath;
		const truncResult = truncateOutput(summary, config, lastArtifactPath);
		if (truncResult.truncated) {
			summary = truncResult.text;
			truncated = true;
		}
	}

	const resultMode = config.resultMode ?? statusPayload.mode;
	const singleRuntimeAcknowledgedExtensions = results.length === 1 ? results[0]?.runtimeAcknowledgedExtensions : undefined;
	const totalCost = results.reduce<CostSummary>((sum, result) => ({
		inputTokens: sum.inputTokens + (result.totalCost?.inputTokens ?? 0),
		outputTokens: sum.outputTokens + (result.totalCost?.outputTokens ?? 0),
		costUsd: sum.costUsd + (result.totalCost?.costUsd ?? 0),
	}), { inputTokens: 0, outputTokens: 0, costUsd: 0 });
	const finalTotalCost = totalCost.inputTokens > 0 || totalCost.outputTokens > 0 || totalCost.costUsd > 0 ? totalCost : undefined;
	const finalFlatAgents = statusPayload.steps.map((step) => step.agent);
	const agentName = finalFlatAgents.length === 1
		? finalFlatAgents[0]!
		: resultMode === "parallel"
			? `parallel:${finalFlatAgents.join("+")}`
			: `chain:${finalFlatAgents.join("->")}`;
	let sessionFile: string | undefined;
	let shareUrl: string | undefined;
	let gistUrl: string | undefined;
	let shareError: string | undefined;

	if (shareEnabled) {
		sessionFile = config.sessionDir
			? (findLatestSessionFile(config.sessionDir) ?? undefined)
			: undefined;
		if (!sessionFile && latestSessionFile) {
			sessionFile = latestSessionFile;
		}
		if (sessionFile) {
			try {
				const exportDir = config.sessionDir ?? path.dirname(sessionFile);
				const htmlPath = await exportSessionHtml(sessionFile, exportDir, config.piPackageRoot);
				const share = createShareLink(htmlPath);
				if ("error" in share) shareError = share.error;
				else {
					shareUrl = share.shareUrl;
					gistUrl = share.gistUrl;
				}
			} catch (err) {
				shareError = String(err);
			}
		} else {
			shareError = "Session file not found.";
		}
	}

	if (activityTimer) {
		clearInterval(activityTimer);
		activityTimer = undefined;
	}
	if (timeoutTimer) {
		clearTimeout(timeoutTimer);
		timeoutTimer = undefined;
	}
	if (!timedOut && !stopped && !interrupted && config.timeoutMs !== undefined && timeoutMessage !== undefined && results.some((result) => result.timedOut === true && result.error?.startsWith(timeoutMessage))) {
		timedOut = true;
	}
	const signalTerminated = !stopped && !timedOut && !interrupted && results.some((result) => result.exitCode !== 0 && isUnexplainedProcessSignal(omitUndefinedProperties({
		processSignal: result.processSignal,
		interrupted: result.interrupted,
		timedOut: result.timedOut,
		stopped: result.stopped,
	})));
	const partialWithEvidence = !stopped && !signalTerminated && !timedOut && !usageBudgetExceeded && !interrupted && results.some(partialEvidenceResult) && !results.some(concreteFailureResult);
	statusPayload.state = stopped || signalTerminated ? "stopped" : timedOut || usageBudgetExceeded ? "failed" : interrupted ? "paused" : results.every((r) => r.success) ? "complete" : partialWithEvidence ? "partial" : "failed";
	closeSteerInbox(asyncDir, statusPayload.state, (filePath, payload) => runPersistence.write(filePath, payload));
	disposeControlInbox();
	for (const request of consumeSteerRequests(asyncDir)) deliverSteerRequest(request);
	const effectiveSessionFile = sessionFile ?? latestSessionFile;
	const steeringLifecycle = steeringStatus(statusPayload);
	for (const request of steeringLifecycle.recent) {
		let changed = false;
		for (const target of request.targets) {
			if (target.state !== "scheduled" && target.state !== "routed" && target.state !== "queued") continue;
			changed = true;
			const reason = target.state === "queued" ? "run ended before queued follow-up delivery" : "child terminated before steering delivery";
			updateSteeringLifecycleTarget(request.id, target.index, "failed", Date.now(), { reason });
			markSteeringAttention(target.index);
			emitSteeringEvent("subagent.steer.failed", { type: "steer", id: request.id, ts: request.requestedAt, message: reason }, target.index, { reason });
		}
		if (changed) emitTerminalSteeringNotice(request.id, `Steering failed for run ${id}: child terminated before delivery.`);
	}
	const runEndedAt = Date.now();
	delete statusPayload.activityState;
	if (stopped) {
		statusPayload.stopped = true;
		statusPayload.error = stopMessage;
	} else if (signalTerminated && !statusPayload.error) {
		setOptionalProperty(statusPayload, "error", results.find((result) => result.processSignal)?.error);
	}
	if (timedOut) {
		statusPayload.timedOut = true;
		statusPayload.error = timeoutMessage ?? "Subagent timed out.";
	}
	if (usageBudgetExceeded && statusPayload.usageBudget && !statusPayload.error) {
		statusPayload.error = usageBudgetExceededMessage(statusPayload.usageBudget);
	}
	if (partialWithEvidence) {
		const partialResult = results.find(partialEvidenceResult);
		statusPayload.activityState = "needs_attention";
		statusPayload.error = partialResult?.error ?? statusPayload.error;
		for (const step of statusPayload.steps) {
			if (step.status === "failed") step.activityState = "needs_attention";
		}
	}
	statusPayload.endedAt = runEndedAt;
	statusPayload.lastUpdate = runEndedAt;
	setOptionalProperty(statusPayload, "sessionFile", effectiveSessionFile);
	if (singleRuntimeAcknowledgedExtensions) statusPayload.runtimeAcknowledgedExtensions = singleRuntimeAcknowledgedExtensions;
	setOptionalProperty(statusPayload, "totalCost", finalTotalCost);
	setOptionalProperty(statusPayload, "usageBudget", usageBudgetState(config.usageBudget, currentUsageTotals()));
	setOptionalProperty(statusPayload, "shareUrl", shareUrl);
	setOptionalProperty(statusPayload, "gistUrl", gistUrl);
	setOptionalProperty(statusPayload, "shareError", shareError);
	if ((statusPayload.state === "failed" || statusPayload.state === "partial") && !statusPayload.error) {
		const concreteFailure = results.find(concreteFailureResult);
		const failedStep = concreteFailure ? undefined : statusPayload.steps.find((s) => s.status === "failed");
		if (concreteFailure?.error) statusPayload.error = concreteFailure.error;
		if (failedStep?.agent) {
			statusPayload.error = `Step failed: ${failedStep.agent}`;
		}
	}
	try {
		runPersistence.write(resultPath, {
			lifecycleArtifactVersion: SUBAGENT_LIFECYCLE_ARTIFACT_VERSION,
			id,
			agent: agentName,
			mode: resultMode,
			success: statusPayload.state === "complete",
			state: statusPayload.state,
			summary: stopped ? stopMessage : signalTerminated ? (statusPayload.error ?? "Subagent process terminated by signal.") : timedOut ? (timeoutMessage ?? "Subagent timed out.") : usageBudgetExceeded ? (statusPayload.error ?? "Usage budget exhausted.") : interrupted ? "Paused after interrupt. Waiting for explicit next action." : statusPayload.state === "partial" ? (statusPayload.error ?? summary) : summary,
			...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
			...(config.deadlineAt !== undefined ? { deadlineAt: config.deadlineAt } : {}),
			...(statusPayload.toolBudget ? { toolBudget: statusPayload.toolBudget } : {}),
			...(statusPayload.toolBudgetBlocked ? { toolBudgetBlocked: true } : {}),
			...(statusPayload.usageBudget ? { usageBudget: statusPayload.usageBudget } : {}),
			...(stopped ? { stopped: true, error: stopMessage } : timedOut ? { timedOut: true, error: timeoutMessage ?? "Subagent timed out." } : usageBudgetExceeded ? { error: statusPayload.error ?? "Usage budget exhausted." } : {}),
			results: results.map((r) => omitUndefinedProperties({
				agent: r.agent,
				...(r.sessionName ? { sessionName: r.sessionName } : {}),
				context: r.context,
				output: r.output,
				outputState: r.outputState,
				error: r.error,
				success: r.success,
				skipped: r.skipped || undefined,
				interrupted: r.interrupted || undefined,
				timedOut: r.timedOut || undefined,
				stopped: r.stopped || undefined,
				processSignal: r.processSignal || undefined,
				toolBudget: r.toolBudget,
				toolBudgetBlocked: r.toolBudgetBlocked || undefined,
				sessionFile: r.sessionFile,
				intercomTarget: r.intercomTarget,
				model: r.model,
				thinking: r.thinking,
				attemptedModels: r.attemptedModels,
				modelAttempts: r.modelAttempts,
				contextOverflow: r.contextOverflow,
				totalCost: r.totalCost,
				usage: r.usage,
				artifactPaths: r.artifactPaths,
				savedOutputPath: r.savedOutputPath,
				outputSaveError: r.outputSaveError,
				metadataSaveError: r.metadataSaveError,
				truncated: r.truncated,
				transcriptPath: r.transcriptPath,
				transcriptError: r.transcriptError,
				agentContract: r.agentContract,
				launchContractDigest: r.launchContractDigest,
				launchResolvedExtensions: r.launchResolvedExtensions,
				runtimeAcknowledgedExtensions: r.runtimeAcknowledgedExtensions,
				runner: r.runner,
				externalProcess: r.externalProcess,
				externalJob: r.externalJob,
				execution: r.execution,
				review: r.review,
				effects: r.effects,
				structuredOutput: r.structuredOutput,
				structuredOutputPath: r.structuredOutputPath,
				structuredOutputSchemaPath: r.structuredOutputSchemaPath,
				acceptance: r.acceptance,
				watchdog: r.watchdog,
				timeoutRecovery: r.timeoutRecovery,
				capabilityCeiling: r.capabilityCeiling,
				capabilityAudit: r.capabilityAudit,
			})),
			outputs,
			workflowGraph: statusPayload.workflowGraph,
			parallelHandoff: statusPayload.parallelHandoff,
			capabilityCeiling: statusPayload.capabilityCeiling,
			capabilityAudit: statusPayload.capabilityAudit,
			...(config.parentWorkflowRunId ? { parentWorkflowRunId: config.parentWorkflowRunId } : {}),
			...(config.workflowKey ? { workflowKey: config.workflowKey } : {}),
			exitCode: statusPayload.state === "complete" || statusPayload.state === "paused" ? 0 : 1,
			timestamp: runEndedAt,
			durationMs: runEndedAt - overallStartTime,
			totalTokens: statusPayload.totalTokens,
			totalCost: finalTotalCost,
			usageBudget: statusPayload.usageBudget,
			truncated,
			artifactsDir,
			cwd,
			asyncDir,
			launchContractDigest: config.launchContractDigest,
			launchResolvedExtensions: config.launchResolvedExtensions,
			runtimeAcknowledgedExtensions: singleRuntimeAcknowledgedExtensions,
			sessionId: config.sessionId,
			completionOwnerId: config.completionOwnerId,
			sessionFile: effectiveSessionFile,
			intercomTarget: config.controlIntercomTarget,
			shareUrl,
			gistUrl,
			shareError,
			...(taskIndex !== undefined && { taskIndex }),
			...(totalTasks !== undefined && { totalTasks }),
		}, (filePath, payload) => { writeAsyncResultFile(filePath, payload as Record<string, unknown>); });
		finalResultCommitted = true;
	} catch (err) {
		const message = `Failed to write result file ${resultPath}: ${err instanceof Error ? err.message : String(err)}`;
		console.error(message, err);
		statusPayload.state = "failed";
		statusPayload.error = message;
		statusPayload.lastUpdate = Date.now();
	}
	writeStatusPayload();
	await orcaProgressTab?.finish(statusPayload.state === "complete" ? "completed" : statusPayload.state === "stopped" ? "stopped" : "failed", effectiveSessionFile);
	appendJsonl(
		eventsPath,
		JSON.stringify({
			type: "subagent.run.completed",
			lifecycleArtifactVersion: SUBAGENT_LIFECYCLE_ARTIFACT_VERSION,
			ts: runEndedAt,
			runId: id,
			status: statusPayload.state,
			durationMs: runEndedAt - overallStartTime,
			totalTokens: statusPayload.totalTokens,
			totalCost: finalTotalCost,
			usageBudget: statusPayload.usageBudget,
		}),
	);
	writeRunLog(logPath, omitUndefinedProperties({
		id,
		mode: statusPayload.mode,
		cwd,
		startedAt: overallStartTime,
		endedAt: runEndedAt,
		steps: statusPayload.steps.map((step) => omitUndefinedProperties({
			agent: step.agent,
			status: step.status,
			durationMs: step.durationMs,
		})),
		summary,
		truncated,
		artifactsDir,
		sessionFile: effectiveSessionFile,
		shareUrl,
		shareError,
	}), (filePath, content) => runPersistence.write(filePath, { content }, (_path, payload) => {
		fs.writeFileSync(_path, (payload as { content: string }).content, "utf-8");
	}));
	// The run is committed: release the child sessions first, then wait for the
	// storage-capacity retries that may still hold the final status or result.
	await childSessions.dispose().catch((error: unknown) => console.error("Failed to dispose runner child sessions:", error));
	while (runPersistence.pendingCount() + indexPersistence.pendingCount() > 0) {
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
	runPersistence.dispose();
	indexPersistence.dispose();
	if (config.runnerProcessInstanceId) {
		// Children run inside this process, so no step has writer processes to prove terminal.
		const writers: Record<string, PiWriterProcessInstanceExit[]> = {};
		const expectedWriters: Record<string, number> = {};
		for (const index of results.keys()) {
			writers[String(index)] = [];
			expectedWriters[String(index)] = 0;
		}
		const candidate: ProcessTerminalCandidate = {
			version: 1,
			runId: id,
			runnerProcessInstanceId: config.runnerProcessInstanceId,
			writers,
			expectedWriters,
			...(config.revivalLease?.sessionFile ? { sessionFile: config.revivalLease.sessionFile } : {}),
			...(config.revivalLeaseToken ? { revivalLeaseToken: config.revivalLeaseToken } : {}),
		};
		try {
			writeProcessTerminalCandidate(asyncDir, candidate);
		} catch (error) {
			console.error(`Failed to write process-terminal candidate for '${id}':`, error);
		}
	}
}

async function waitForStartupControl(
	controlPath: string,
	token: string,
	action: "ack" | "proceed",
	timeoutMs = 30_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() <= deadline) {
		if (fs.existsSync(controlPath)) {
			let payload: { action?: unknown; token?: unknown };
			try {
				payload = JSON.parse(fs.readFileSync(controlPath, "utf-8")) as { action?: unknown; token?: unknown };
			} catch (error) {
				throw new Error(`Failed to read runner startup control '${controlPath}': ${error instanceof Error ? error.message : String(error)}`);
			}
			if (payload.token !== token) throw new Error("Runner startup control token does not match.");
			if (payload.action === action) return;
			if (payload.action !== "ack" && payload.action !== "proceed") throw new Error("Runner startup control action is invalid.");
		}
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error(`Timed out after ${timeoutMs}ms waiting for runner startup control '${action}'.`);
}

async function runConfiguredSubagent(config: SubagentRunConfig): Promise<void> {
	let lease: ReturnType<typeof acquireSessionLease> | undefined;
	let startupCommitted = config.revivalLease === undefined && config.launchBarrierToken === undefined;
	const startupPath = path.join(config.asyncDir, "runner-startup.json");
	const startupAckPath = path.join(config.asyncDir, "runner-startup-ack.json");
	const startupProceedPath = path.join(config.asyncDir, "runner-startup-proceed.json");
	const releaseOnExit = (): void => {
		try {
			lease?.release();
		} catch {
			// Exit cleanup is best effort; a dead-owner lease is reclaimed on the next revival.
		}
	};
	process.once("exit", releaseOnExit);
	try {
		if (config.launchBarrierToken) {
			await waitForStartupControl(startupProceedPath, config.launchBarrierToken, "proceed");
			startupCommitted = true;
			try {
				fs.rmSync(startupProceedPath, { force: true });
			} catch {
				// Startup control cleanup is best effort after the parent commits the run.
			}
		} else if (config.revivalLease) {
			lease = acquireSessionLease(config.revivalLease);
			config.revivalLeaseToken = lease.owner.token;
			writeAtomicJson(startupPath, { state: "ready", token: lease.owner.token, pid: process.pid, owner: lease.owner });
			await waitForStartupControl(startupAckPath, lease.owner.token, "ack");
			writeAtomicJson(startupPath, { state: "acknowledged", token: lease.owner.token, pid: process.pid });
			await waitForStartupControl(startupProceedPath, lease.owner.token, "proceed");
			startupCommitted = true;
			for (const controlPath of [startupAckPath, startupProceedPath]) {
				try {
					fs.rmSync(controlPath, { force: true });
				} catch {
					// Startup control cleanup is best effort after the parent commits the run.
				}
			}
		}
		const childSessions = await loadRunnerChildSessionFactory(config);
		try {
			await runSubagent(config, childSessions);
		} finally {
			try {
				await childSessions.dispose();
			} catch (error) {
				console.error("Failed to dispose runner child sessions:", error);
			}
		}
	} catch (error) {
		if (!startupCommitted) {
			try {
				writeAtomicJson(startupPath, { state: "error", pid: process.pid, error: error instanceof Error ? error.message : String(error) });
			} catch {
				// The parent will time out and terminate this runner if the handshake cannot be written.
			}
		}
		throw error;
	} finally {
		process.off("exit", releaseOnExit);
		if (lease) {
			let acknowledged = false;
			try {
				acknowledged = lease.release();
			} catch (error) {
				console.error("Failed to release session revival lease:", error);
			}
			try {
				markProcessTerminalCandidateLeaseRelease(config.asyncDir, lease.owner.token, acknowledged);
			} catch (error) {
				console.error("Failed to record session revival lease release:", error);
			}
		}
	}
}

function startConfiguredSubagent(config: SubagentRunConfig): void {
	// Child sessions and the extensions loaded into them may leave handles
	// behind even after shutdown; the run is fully persisted by now, so exit
	// explicitly instead of waiting for the event loop to drain.
	runConfiguredSubagent(config).then(
		() => process.exit(0),
		(runErr) => {
			console.error("Subagent runner error:", runErr);
			process.exit(1);
		},
	);
}

const configArg = process.argv[2];
if (configArg) {
	try {
		const configJson = fs.readFileSync(configArg, "utf-8");
		const config = JSON.parse(configJson) as SubagentRunConfig;
		try {
			fs.unlinkSync(configArg);
		} catch {
			// Temp config cleanup is best effort.
		}
		startConfiguredSubagent(config);
	} catch (err) {
		console.error("Subagent runner error:", err);
		process.exit(1);
	}
} else {
	let input = "";
	process.stdin.setEncoding("utf-8");
	process.stdin.on("data", (chunk) => {
		input += chunk;
	});
	process.stdin.on("end", () => {
		try {
			const config = JSON.parse(input) as SubagentRunConfig;
			startConfiguredSubagent(config);
		} catch (err) {
			console.error("Subagent runner error:", err);
			process.exit(1);
		}
	});
}
