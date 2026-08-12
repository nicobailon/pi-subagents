import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type { Message } from "@earendil-works/pi-ai";
import { writeAtomicJson } from "../../shared/atomic-json.ts";
import { createFileCoalescer } from "../../shared/file-coalescer.ts";
import { isActiveAsyncState, updateActiveRunIndex } from "./active-run-index.ts";
import { createChildTranscriptWriter, type ChildTranscriptWriter } from "../../shared/child-transcript.ts";
import { closeSteerInbox, consumeInterruptRequest, consumeSteerRequests, deliverInterruptRequest, deliverStopRequest, deliverTimeoutRequest, enqueueStepSteer, steerAcksDir, steerCapabilityPath, stepSteerInboxDir, watchAsyncControlInbox, type SteerAck, type SteerCapability, type SteerRequest } from "./control-channel.ts";
import { appendJsonl as appendRawJsonl, formatOutputArtifactContent, getArtifactPaths, writeArtifact, writeMetadata } from "../../shared/artifacts.ts";
import { PI_CODING_AGENT_PACKAGE, getPiSpawnCommand, resolveInstalledPiPackageRoot } from "../shared/pi-spawn.ts";
import { captureSingleOutputSnapshot, extractChildWrittenOutput, finalizeSingleOutput, formatSavedOutputReference, injectOutputPathSystemPrompt, injectSingleOutputInstruction, resolveSingleOutput, type SingleOutputSnapshot } from "../shared/single-output.ts";
import {
	type ActivityState,
	type ArtifactConfig,
	type ExternalCliRunnerStatus,
	type ExternalProcessStatus,
	type ArtifactPaths,
	type AsyncParallelGroupStatus,
	type AsyncStatus,
	type ChainOutputMap,
	type CostSummary,
	type LaunchResolvedChildExtensionsV1,
	type RuntimeAcknowledgedChildExtensionsV1,
	type ModelAttempt,
	type NestedRouteInfo,
	type NestedRunSummary,
	type ResolvedControlConfig,
	type ResolvedTurnBudget,
	type ResolvedToolBudget,
	type SubagentRunMode,
	type SubagentOutputState,
	type UsageBudgetConfig,
	type ToolBudgetState,
	type TurnBudgetState,
	type Usage,
	type WorkflowGraphSnapshot,
	type SteeringStatus,
	type SteeringTargetState,
	type SteeringTargetStatus,
	DEFAULT_MAX_OUTPUT,
	type MaxOutputConfig,
	SUBAGENT_LIFECYCLE_ARTIFACT_VERSION,
	POLL_INTERVAL_MS,
	truncateOutput,
	getSubagentDepthEnv,
} from "../../shared/types.ts";
import {
	DEFAULT_CONTROL_CONFIG,
	buildControlEvent,
	deriveActivityState,
	claimControlNotification,
	formatControlIntercomMessage,
	formatControlNoticeMessage,
} from "../shared/subagent-control.ts";
import {
	type RunnerSubagentStep as SubagentStep,
	type RunnerStep,
	isCheckpointRunnerStep,
	isDynamicRunnerGroup,
	isParallelGroup,
	flattenSteps,
	mapConcurrent,
	aggregateParallelOutputs,
	MAX_PARALLEL_CONCURRENCY,
	DEFAULT_GLOBAL_CONCURRENCY_LIMIT,
	Semaphore,
} from "../shared/parallel-utils.ts";
import { applyThinkingSuffix, buildPiArgs, cleanupTempDir, projectLaunchResolvedChildExtensions, resolvePiLaunchToolPlan, type SubagentTaskDelivery } from "../shared/pi-args.ts";
import { readRuntimeAcknowledgedExtensions } from "../shared/runtime-acknowledged-extensions.ts";
import { outputEntryFromAsyncResult, resolveOutputReferences } from "../shared/chain-outputs.ts";
import { createStructuredOutputRuntime, MISSING_STRUCTURED_OUTPUT_CALL_ERROR, readStructuredOutput } from "../shared/structured-output.ts";
import { formatProcessSignalError, isUnexplainedProcessSignal } from "../shared/process-signal.ts";
import { readChildToolDiagnosticError } from "../shared/tool-availability.ts";
import { collectDynamicResults, DynamicFanoutError, materializeDynamicParallelStep, validateDynamicCollection } from "../shared/dynamic-fanout.ts";
import { nestedSummaryFromAsyncStatus, projectNestedEvents, resolveNestedAsyncDir, writeNestedEvent } from "../shared/nested-events.ts";
import { formatModelAttemptNote, isRetryableModelFailure } from "../shared/model-fallback.ts";
import {
	SUBAGENT_STARTUP_RETRY_DELAYS_MS,
	formatSubagentStartupRetryExhaustedError,
	formatSubagentStartupRetryNote,
	isRetryableSubagentStartupFailure,
	waitForSubagentStartupRetry,
} from "../shared/subagent-startup-retry.ts";
import { markProcessTerminalCandidateLeaseRelease, writeProcessTerminalCandidate, type ProcessTerminalCandidate } from "./process-terminal.ts";
import { createSteeringStatus, recordSteeringRequest, steeringStatus, terminalSteeringNoticeState, updateSteeringTarget } from "./steering.ts";
import { attachPostExitStdioGuard, trySignalChild } from "../../shared/post-exit-stdio-guard.ts";
import { PROMPT_REDACTED, detectSubagentError, extractTextFromContent, extractToolArgsPreview, getFinalOutput, hasEmptyTerminalAssistantResponse, readStatus } from "../../shared/utils.ts";
import { evaluateCompletionMutationGuard } from "../shared/completion-guard.ts";
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
	diffWorktrees,
	findWorktreeTaskCwdConflict,
	formatWorktreeDiffSummary,
	formatWorktreeTaskCwdConflict,
	type WorktreeSetup,
} from "../shared/worktree.ts";
import { resolveEffectiveThinking } from "../../shared/model-info.ts";
import { launchBindingDigest } from "../../shared/launch-contract.ts";
import { writeInitialProgressFile } from "../../shared/settings.ts";
import { resolveSubagentIntercomTarget } from "../../intercom/intercom-bridge.ts";
import { acceptanceFailureMessage, aggregateAcceptanceReport, buildSkippedAcceptanceLedger, evaluateAcceptance, formatAcceptancePrompt, resolveEffectiveAcceptance, stripAcceptanceReport } from "../shared/acceptance.ts";
import { attachContractProjections, isAgentContractV1 } from "../shared/agent-contract.ts";
import { waitForImportedAsyncRoot } from "./chain-root-attachment.ts";
import { appendRunnerStepsToStatus, consumeChainAppendRequests, countPendingChainAppendRequests, statusStepDescription } from "./chain-append.ts";
import { appendTurnBudgetSystemPrompt, formatTurnBudgetOutput, initialTurnBudgetState, turnBudgetDecision, turnBudgetDeferredNote, turnBudgetDeferredState, turnBudgetExceededMessage, turnBudgetSoftNote, turnBudgetState } from "../shared/turn-budget.ts";
import { initialToolBudgetState, toolBudgetState } from "../shared/tool-budget.ts";
import { usageBudgetExceededMessage, usageBudgetState } from "../shared/usage-budget.ts";
import { formatParallelHandoffError, formatParallelHandoffReference, parallelHandoffPath, writeParallelHandoffGroup, writePendingParallelHandoff } from "../shared/parallel-handoff.ts";
import { resolveWatchdogConfig } from "../../watchdog/settings.ts";
import { createBoundedByteTail, createBoundedLineReader, formatProtocolOutputLimit, MAX_CHILD_STDERR_BYTES, PI_AGGREGATE_EVENT_PROJECTOR, projectChildLifecycle, type ChildLifecycleAction, type ProtocolOutputLimit } from "../shared/child-protocol.ts";
import { acquireSessionLease, type SessionLeaseRequest } from "../shared/session-lease.ts";
import { buildExternalCliPrompt, runExternalCli } from "../shared/external-cli-runner.ts";
import { decodeSubagentCapabilityCeiling, SUBAGENT_CAPABILITY_CEILING_ENV, type ResolvedSubagentCapabilityCeiling } from "../shared/capability-ceiling.ts";
import {
	CHILD_WATCHDOG_CONFIG_ENV,
	acceptChildWatchdogEvent,
	childWatchdogIsActive,
	decodeChildWatchdogConfig,
	isChildWatchdogStatusEvent,
	resolveChildWatchdogConfig,
	type ChildWatchdogStateSnapshot,
} from "../../watchdog/child-status.ts";

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
	piPackageRoot?: string;
	piArgv1?: string;
	worktreeSetupHook?: string;
	worktreeSetupHookTimeoutMs?: number;
	worktreeBaseDir?: string;
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
	turnBudget?: ResolvedTurnBudget;
	toolBudget?: ResolvedToolBudget;
	usageBudget?: UsageBudgetConfig;
	revivalLease?: SessionLeaseRequest;
	revivalLeaseToken?: string;
	/** Global cap on simultaneously-running subagent tasks within this run. */
	globalConcurrencyLimit?: number;
	capabilityCeiling?: ResolvedSubagentCapabilityCeiling;
	launchContractDigest?: string;
	launchResolvedExtensions?: LaunchResolvedChildExtensionsV1;
	runtimeAcknowledgedExtensions?: RuntimeAcknowledgedChildExtensionsV1;
	runnerProcessInstanceId?: string;
	parentWorkflowRunId?: string;
	workflowKey?: string;
}

interface StepResult {
	agent: string;
	context?: "fresh" | "fork";
	capabilityCeiling?: ResolvedSubagentCapabilityCeiling;
	capabilityAudit?: import("../shared/capability-ceiling.ts").SubagentCapabilityAudit;
	launchResolvedExtensions?: LaunchResolvedChildExtensionsV1;
	runtimeAcknowledgedExtensions?: RuntimeAcknowledgedChildExtensionsV1;
	output: string;
	outputState?: SubagentOutputState;
	error?: string;
	protocolError?: ProtocolOutputLimit;
	success?: boolean;
	exitCode: number | null;
	usage?: Usage;
	savedOutputPath?: string;
	skipped?: boolean;
	interrupted?: boolean;
	timedOut?: boolean;
	stopped?: boolean;
	processSignal?: string | null;
	turnBudget?: TurnBudgetState;
	turnBudgetExceeded?: boolean;
	wrapUpRequested?: boolean;
	toolBudget?: ToolBudgetState;
	toolBudgetBlocked?: boolean;
	sessionFile?: string;
	intercomTarget?: string;
	model?: string;
	attemptedModels?: string[];
	modelAttempts?: ModelAttempt[];
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
	writerProcesses?: Array<{ processInstanceId: string; kind: "pi-writer"; attempt: number; closeObservedAt: number; exitCode: number | null; signal: string | null }>;
	writerAttemptCount?: number;
	runner?: ExternalCliRunnerStatus;
	externalProcess?: ExternalProcessStatus;
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

function shouldPersistChildEvent(event: Record<string, unknown>): boolean {
	return event.type !== "message_update";
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

function appendRecentStepOutput(step: RunnerStatusStep, lines: string[]): void {
	const nonEmpty = lines.filter((line) => line.trim());
	if (nonEmpty.length === 0) return;
	step.recentOutput ??= [];
	step.recentOutput.push(...nonEmpty);
	if (step.recentOutput.length > 50) {
		step.recentOutput.splice(0, step.recentOutput.length - 50);
	}
}

function assistantStartsToolCall(message: Message): boolean {
	return Array.isArray(message.content)
		&& message.content.some((part) => (part as { type?: string }).type === "toolCall");
}

function isTerminalAssistantStop(message: Message): boolean {
	return (message as { stopReason?: string }).stopReason === "stop" && !assistantStartsToolCall(message);
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

interface ChildEventContext {
	eventsPath: string;
	runId: string;
	stepIndex: number;
	agent: string;
}

interface ChildUsage {
	input?: number;
	inputTokens?: number;
	output?: number;
	outputTokens?: number;
	cacheRead?: number;
	cacheWrite?: number;
	cost?: { total?: number };
}

type ChildMessage = Message & {
	model?: string;
	errorMessage?: string;
	usage?: ChildUsage;
};

interface ChildEvent {
	type?: string;
	message?: ChildMessage;
	toolName?: string;
	args?: Record<string, unknown>;
	willRetry?: unknown;
}

interface RunPiStreamingResult {
	stderr: string;
	exitCode: number | null;
	messages: Message[];
	usage: Usage;
	toolCount: number;
	durationMs: number;
	model?: string;
	error?: string;
	protocolError?: ProtocolOutputLimit;
	finalOutput: string;
	outputState: SubagentOutputState;
	interrupted?: boolean;
	timedOut?: boolean;
	stopped?: boolean;
	turnBudget?: TurnBudgetState;
	turnBudgetExceeded?: boolean;
	wrapUpRequested?: boolean;
	toolBudget?: ToolBudgetState;
	toolBudgetBlocked?: boolean;
	observedMutationAttempt?: boolean;
	structuredOutputToolInvoked?: boolean;
	structuredOutputMessageStartIndex?: number;
	watchdog?: ChildWatchdogStateSnapshot;
	runtimeAcknowledgedExtensions?: RuntimeAcknowledgedChildExtensionsV1;
	processInstanceId: string;
	processCloseObservedAt?: number;
	processSignal?: string | null;
}

function runPiStreaming(
	args: string[],
	cwd: string,
	outputFile: string,
	env?: Record<string, string | undefined>,
	piPackageRoot?: string,
	piArgv1?: string,
	maxSubagentDepth?: number,
	childEventContext?: ChildEventContext,
	registerInterrupt?: (interrupt: (() => void) | undefined) => void,
	onChildEvent?: (event: ChildEvent) => void,
	transcriptWriter?: ChildTranscriptWriter,
	registerTimeout?: (interrupt: (() => void) | undefined) => void,
	timeoutMessage?: string,
	registerStop?: (stop: (() => void) | undefined) => void,
	stopMessage?: string,
	registerTurnBudgetAbort?: (abort: ((message: string, state?: TurnBudgetState) => void) | undefined) => void,
	onWriterProcess?: (writer: { state: "none" | "spawning" } | { state: "running"; pid: number }) => void,
): Promise<RunPiStreamingResult> {
	return new Promise((resolve) => {
		const startedAt = Date.now();
		const processInstanceId = randomUUID();
		onWriterProcess?.({ state: "spawning" });
		const outputStream = fs.createWriteStream(outputFile, { flags: "w" });
		const spawnEnv = { ...process.env, ...(env ?? {}), ...getSubagentDepthEnv(maxSubagentDepth) };
		const spawnSpec = getPiSpawnCommand(args, {
			...(piPackageRoot ? { piPackageRoot } : {}),
			...(piArgv1 ? { argv1: piArgv1 } : {}),
		});
		const child = spawn(spawnSpec.command, spawnSpec.args, {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
			env: spawnEnv,
			windowsHide: true,
		});
		const stderrTail = createBoundedByteTail();
		const rawStdoutTail = createBoundedByteTail();
		const messages: Message[] = [];
		const usage = emptyUsage();
		let model: string | undefined;
		let writerRegistrationError: string | undefined;
		if (typeof child.pid === "number") {
			try {
				onWriterProcess?.({ state: "running", pid: child.pid });
			} catch (writerError) {
				writerRegistrationError = `Failed to record revived Pi writer ownership: ${writerError instanceof Error ? writerError.message : String(writerError)}`;
				trySignalChild(child, "SIGKILL");
			}
		}
		let error: string | undefined = writerRegistrationError;
		let assistantError: string | undefined;
		let interrupted = false;
		let timedOut = false;
		let stopped = false;
		let turnBudgetExceeded = false;
		let turnBudgetMessage: string | undefined;
		let turnBudget: TurnBudgetState | undefined;
		let observedMutationAttempt = false;
		let structuredOutputToolInvoked = false;
		let structuredOutputMessageStartIndex: number | undefined;
		let toolCount = 0;
		const childWatchdogConfig = decodeChildWatchdogConfig(env?.[CHILD_WATCHDOG_CONFIG_ENV]);
		let childWatchdogState: ChildWatchdogStateSnapshot | undefined;
		let applyChildLifecycle = (_action: ChildLifecycleAction): void => {};
		const updateChildWatchdogState = (snapshot: ChildWatchdogStateSnapshot): void => {
			childWatchdogState = snapshot;
		};

		const writeOutputLine = (line: string) => {
			if (!line.trim()) return;
			outputStream.write(`${line}\n`);
		};

		const writeOutputText = (text: string) => {
			for (const line of text.split("\n")) {
				writeOutputLine(line);
			}
		};

		const appendChildEvent = (event: Record<string, unknown>) => {
			if (!childEventContext) return;
			if (!shouldPersistChildEvent(event)) return;
			appendDiagnosticJsonl(childEventContext.eventsPath, JSON.stringify({
				...event,
				subagentSource: "child",
				subagentRunId: childEventContext.runId,
				subagentStepIndex: childEventContext.stepIndex,
				subagentAgent: childEventContext.agent,
				observedAt: Date.now(),
			}), typeof event.type === "string" ? event.type : undefined);
		};

		const appendChildLine = (type: "subagent.child.stdout" | "subagent.child.stderr", line: string) => {
			appendChildEvent({ type, line });
			if (type === "subagent.child.stdout") transcriptWriter?.writeStdoutLine(line);
			else transcriptWriter?.writeStderrLine(line);
		};

		const processStdoutLine = (line: string) => {
			if (!line.trim()) return;
			let event: ChildEvent;
			try {
				event = JSON.parse(line) as ChildEvent;
			} catch {
				rawStdoutTail.push(`${line}\n`);
				writeOutputLine(line);
				appendChildLine("subagent.child.stdout", line);
				return;
			}

			appendChildEvent(event as unknown as Record<string, unknown>);
			transcriptWriter?.writeChildEvent(event);
			if (event.type === "agent_settled") agentSettledReceived = true;
			applyChildLifecycle(projectChildLifecycle(event));

			if (isChildWatchdogStatusEvent(event)) {
				if (!childWatchdogConfig) return;
				const next = acceptChildWatchdogEvent({
					current: childWatchdogState,
					event,
					...(childEventContext ? {
						runId: childEventContext.runId,
						agent: childEventContext.agent,
						childIndex: childEventContext.stepIndex,
					} : {}),
				});
				if (!next) return;
				updateChildWatchdogState(next);
				onChildEvent?.(event);
				if (childWatchdogIsActive(next)) {
					if (finalDrainTimer) {
						clearTimeout(finalDrainTimer);
						finalDrainTimer = undefined;
					}
					if (finalHardKillTimer) {
						clearTimeout(finalHardKillTimer);
						finalHardKillTimer = undefined;
					}
					armWatchdogTail();
				} else {
					clearWatchdogTailTimer();
					if (cleanTerminalAssistantStopReceived || agentSettledReceived) startFinalDrain();
				}
				return;
			}

			onChildEvent?.(event);

			if (event.type === "tool_execution_start" && event.toolName) {
				toolCount += 1;
				if (event.toolName === "structured_output") {
					structuredOutputToolInvoked = true;
					structuredOutputMessageStartIndex = messages.length;
				}
				observedMutationAttempt = observedMutationAttempt || isMutatingTool(event.toolName, event.args);
				const toolArgs = extractToolArgsPreview(event.args ?? {});
				writeOutputLine(toolArgs ? `${event.toolName}: ${toolArgs}` : event.toolName);
				return;
			}

			if ((event.type === "message_end" || event.type === "tool_result_end") && event.message) {
				messages.push(event.message);
				const text = extractTextFromContent(event.message.content);
				if (text) writeOutputText(text);

				if (event.type !== "message_end" || event.message.role !== "assistant") return;
				if (event.message.model) model = event.message.model;
				if (event.message.errorMessage) assistantError = event.message.errorMessage;
				const eventUsage = event.message.usage;
				if (eventUsage) {
					usage.turns++;
					usage.input += eventUsage.input ?? eventUsage.inputTokens ?? 0;
					usage.output += eventUsage.output ?? eventUsage.outputTokens ?? 0;
					usage.cacheRead += eventUsage.cacheRead ?? 0;
					usage.cacheWrite += eventUsage.cacheWrite ?? 0;
					usage.cost += eventUsage.cost?.total ?? 0;
				}
				if (isTerminalAssistantStop(event.message)) {
					if (!event.message.errorMessage && extractTextFromContent(event.message.content).trim()) assistantError = undefined;
					cleanTerminalAssistantStopReceived ||= !event.message.errorMessage;
					applyChildLifecycle(projectChildLifecycle(event, true));
				}
			}
		};

		// Guard both cases that can leave the parent waiting on `close` forever:
		// a lingering stdio holder after `exit`, or a child that never exits.
		const FINAL_STOP_GRACE_MS = 1000;
		const HARD_KILL_MS = 3000;
		const TIMEOUT_HARD_KILL_MS = 3000;
		let childExited = false;
		let forcedTerminationSignal = false;
		let cleanTerminalAssistantStopReceived = false;
		let agentSettledReceived = false;
		let finalDrainTimer: NodeJS.Timeout | undefined;
		let finalHardKillTimer: NodeJS.Timeout | undefined;
		let watchdogTailTimer: NodeJS.Timeout | undefined;
		let timeoutHardKillTimer: NodeJS.Timeout | undefined;
		let turnBudgetTerminationTimer: NodeJS.Timeout | undefined;
		let turnBudgetHardKillTimer: NodeJS.Timeout | undefined;
		let protocolHardKillTimer: NodeJS.Timeout | undefined;
		let protocolError: ProtocolOutputLimit | undefined;
		let settled = false;
		applyChildLifecycle = (action: ChildLifecycleAction): void => {
			if (action === "cancel-drain") {
				if (finalDrainTimer) {
					clearTimeout(finalDrainTimer);
					finalDrainTimer = undefined;
				}
				if (finalHardKillTimer) {
					clearTimeout(finalHardKillTimer);
					finalHardKillTimer = undefined;
				}
				clearWatchdogTailTimer();
				return;
			}
			if (action === "start-drain") startFinalDrain();
		};
		const failProtocol = (limit: ProtocolOutputLimit): void => {
			if (protocolError) return;
			protocolError = limit;
			error = formatProtocolOutputLimit(limit);
			if (!childExited) {
				trySignalChild(child, "SIGTERM");
				protocolHardKillTimer = setTimeout(() => {
					if (!settled) trySignalChild(child, "SIGKILL");
				}, 3000);
				protocolHardKillTimer.unref?.();
			}
		};
		const stdoutReader = createBoundedLineReader({
			oversizedLineProjector: PI_AGGREGATE_EVENT_PROJECTOR,
			onLine: processStdoutLine,
			onLimit: failProtocol,
		});
		const stderrReader = createBoundedLineReader({
			stream: "stderr",
			maxPendingLineBytes: MAX_CHILD_STDERR_BYTES,
			onLine: (line) => appendChildLine("subagent.child.stderr", line),
			onLimit: (limit) => appendChildLine("subagent.child.stderr", formatProtocolOutputLimit(limit)),
		});
		const clearStdioGuard = attachPostExitStdioGuard(child, { idleMs: 2000, hardMs: 8000 });
		child.stdout.on("data", (chunk: Buffer) => stdoutReader.push(chunk));
		child.stderr.on("data", (chunk: Buffer) => {
			stderrTail.push(chunk);
			stderrReader.push(chunk);
			outputStream.write(chunk);
		});
		registerInterrupt?.(() => {
			if (settled || timedOut || stopped) return;
			interrupted = true;
			if (!error) error = "Interrupted. Waiting for explicit next action.";
			trySignalChild(child, "SIGINT");
			setTimeout(() => {
				if (!settled && !timedOut && !stopped) trySignalChild(child, "SIGTERM");
			}, 1000).unref?.();
		});
		registerTimeout?.(() => {
			if (settled || timedOut || stopped) return;
			timedOut = true;
			interrupted = false;
			error = timeoutMessage ?? "Subagent timed out.";
			trySignalChild(child, "SIGTERM");
			timeoutHardKillTimer = setTimeout(() => {
				if (!settled) trySignalChild(child, "SIGKILL");
			}, TIMEOUT_HARD_KILL_MS);
			timeoutHardKillTimer.unref?.();
		});
		registerStop?.(() => {
			if (settled || timedOut || stopped) return;
			stopped = true;
			interrupted = false;
			error = stopMessage ?? "Subagent stopped by user.";
			trySignalChild(child, "SIGTERM");
			timeoutHardKillTimer = setTimeout(() => {
				if (!settled) trySignalChild(child, "SIGKILL");
			}, TIMEOUT_HARD_KILL_MS);
			timeoutHardKillTimer.unref?.();
		});
		registerTurnBudgetAbort?.((message, state) => {
			if (settled || timedOut || stopped || turnBudgetExceeded) return;
			turnBudgetExceeded = true;
			turnBudgetMessage = message;
			turnBudget = state;
			interrupted = false;
			error = message;
			trySignalChild(child, "SIGINT");
			turnBudgetTerminationTimer = setTimeout(() => {
				if (!settled && !timedOut && !stopped) trySignalChild(child, "SIGTERM");
			}, 1000);
			turnBudgetTerminationTimer.unref?.();
			turnBudgetHardKillTimer = setTimeout(() => {
				if (!settled && !timedOut && !stopped) trySignalChild(child, "SIGKILL");
			}, 4000);
			turnBudgetHardKillTimer.unref?.();
		});
		const clearDrainTimers = () => {
			if (finalDrainTimer) {
				clearTimeout(finalDrainTimer);
				finalDrainTimer = undefined;
			}
			if (finalHardKillTimer) {
				clearTimeout(finalHardKillTimer);
				finalHardKillTimer = undefined;
			}
			clearWatchdogTailTimer();
			if (timeoutHardKillTimer) {
				clearTimeout(timeoutHardKillTimer);
				timeoutHardKillTimer = undefined;
			}
			if (turnBudgetTerminationTimer) {
				clearTimeout(turnBudgetTerminationTimer);
				turnBudgetTerminationTimer = undefined;
			}
			if (turnBudgetHardKillTimer) {
				clearTimeout(turnBudgetHardKillTimer);
				turnBudgetHardKillTimer = undefined;
			}
			if (protocolHardKillTimer) {
				clearTimeout(protocolHardKillTimer);
				protocolHardKillTimer = undefined;
			}
		};
		function startFinalDrain(): void {
			if (childWatchdogIsActive(childWatchdogState)) {
				armWatchdogTail();
				return;
			}
			if (childExited || finalDrainTimer || settled) return;
			finalDrainTimer = setTimeout(() => {
				if (settled) return;
				const termSent = trySignalChild(child, "SIGTERM");
				if (!termSent) return;
				forcedTerminationSignal = true;
				if (!cleanTerminalAssistantStopReceived && !agentSettledReceived && !error && !assistantError) {
					error = `Subagent process did not exit within ${FINAL_STOP_GRACE_MS}ms after its terminal event. Forcing termination.`;
				}
				finalHardKillTimer = setTimeout(() => {
					if (settled) return;
					forcedTerminationSignal = trySignalChild(child, "SIGKILL") || forcedTerminationSignal;
				}, HARD_KILL_MS);
				finalHardKillTimer.unref?.();
			}, FINAL_STOP_GRACE_MS);
			finalDrainTimer.unref?.();
		}
		function clearWatchdogTailTimer(): void {
			if (watchdogTailTimer) {
				clearTimeout(watchdogTailTimer);
				watchdogTailTimer = undefined;
			}
		}
		function armWatchdogTail(): void {
			if ((!cleanTerminalAssistantStopReceived && !agentSettledReceived) || watchdogTailTimer || settled) return;
			watchdogTailTimer = setTimeout(() => {
				watchdogTailTimer = undefined;
				updateChildWatchdogState({
					phase: "stale",
					seq: (childWatchdogState?.seq ?? 0) + 1,
					lastUpdate: Date.now(),
					followUpPending: false,
					reason: "child watchdog tail timeout",
					timedOut: true,
				});
				startFinalDrain();
			}, childWatchdogConfig?.watchdogTailTimeoutMs ?? 120_000);
			watchdogTailTimer.unref?.();
		}
		child.on("exit", () => {
			childExited = true;
			clearDrainTimers();
		});
		child.on("close", (exitCode, signal) => {
			settled = true;
			const processCloseObservedAt = Date.now();
			try {
				onWriterProcess?.({ state: "none" });
			} catch {
				// The runner still owns and releases the lease during finalization.
			}
			registerInterrupt?.(undefined);
			registerTimeout?.(undefined);
			registerStop?.(undefined);
			registerTurnBudgetAbort?.(undefined);
			clearDrainTimers();
			clearStdioGuard();
			stdoutReader.end();
			stderrReader.end();
			outputStream.end();
			const stderr = stderrTail.text();
			const finalOutput = getFinalOutput(messages) || rawStdoutTail.text().trim();
			const finalError = error ?? assistantError;
			const forcedDrainAfterFinalSuccess = Boolean(forcedTerminationSignal || signal) && (cleanTerminalAssistantStopReceived || agentSettledReceived) && !finalError;
			const signalError = isUnexplainedProcessSignal({
				processSignal: signal,
				interrupted,
				timedOut,
				stopped,
				turnBudgetExceeded,
				forcedDrainAfterFinalSuccess,
			}) ? formatProcessSignalError(signal!) : undefined;
			resolve(omitUndefinedProperties({
				stderr,
				exitCode: timedOut || stopped ? 1 : turnBudgetExceeded ? 1 : interrupted || forcedDrainAfterFinalSuccess ? 0 : forcedTerminationSignal || signal ? (exitCode ?? 1) : exitCode,
				messages,
				usage,
				toolCount,
				durationMs: Date.now() - startedAt,
				model,
				error: stopped ? (stopMessage ?? "Subagent stopped by user.") : timedOut ? (timeoutMessage ?? "Subagent timed out.") : turnBudgetExceeded ? turnBudgetMessage : interrupted || forcedDrainAfterFinalSuccess ? undefined : finalError ?? signalError,
				protocolError,
				finalOutput: (timedOut || stopped) && !finalOutput.trim() ? (stopped ? stopMessage ?? "Subagent stopped by user." : timeoutMessage ?? "Subagent timed out.") : finalOutput,
				outputState: finalOutput.trim() ? "present" : "absent",
				interrupted,
				timedOut,
				stopped,
				turnBudget,
				turnBudgetExceeded,
				wrapUpRequested: turnBudget?.outcome === "wrap-up-requested" || turnBudget?.outcome === "termination-deferred" || turnBudgetExceeded || undefined,
				observedMutationAttempt,
				structuredOutputToolInvoked,
				structuredOutputMessageStartIndex,
				watchdog: childWatchdogState,
				processInstanceId,
				processCloseObservedAt,
				processSignal: signal,
			}));
		});

		child.on("error", (spawnError) => {
			settled = true;
			try {
				onWriterProcess?.({ state: "none" });
			} catch {
				// The runner still owns and releases the lease during finalization.
			}
			registerInterrupt?.(undefined);
			registerTimeout?.(undefined);
			registerStop?.(undefined);
			registerTurnBudgetAbort?.(undefined);
			clearDrainTimers();
			clearStdioGuard();
			stdoutReader.end();
			stderrReader.end();
			outputStream.end();
			const stderr = stderrTail.text();
			const finalOutput = getFinalOutput(messages) || rawStdoutTail.text().trim();
			const spawnErrorMessage = spawnError instanceof Error ? spawnError.message : String(spawnError);
			resolve(omitUndefinedProperties({ stderr, exitCode: 1, messages, usage, toolCount, durationMs: Date.now() - startedAt, model, error: stopped ? (stopMessage ?? "Subagent stopped by user.") : timedOut ? (timeoutMessage ?? "Subagent timed out.") : turnBudgetExceeded ? turnBudgetMessage : error ?? assistantError ?? spawnErrorMessage, protocolError, finalOutput: (timedOut || stopped) && !finalOutput.trim() ? (stopped ? stopMessage ?? "Subagent stopped by user." : timeoutMessage ?? "Subagent timed out.") : finalOutput, outputState: finalOutput.trim() ? "present" : "absent", timedOut, stopped, turnBudget, turnBudgetExceeded, wrapUpRequested: turnBudget?.outcome === "wrap-up-requested" || turnBudget?.outcome === "termination-deferred" || turnBudgetExceeded || undefined, observedMutationAttempt, structuredOutputToolInvoked, structuredOutputMessageStartIndex, watchdog: childWatchdogState, processInstanceId }));
		});
	});
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
		const auth = spawnSync("gh", ["auth", "status"], { encoding: "utf-8" });
		if (auth.status !== 0) {
			return { error: "GitHub CLI is not logged in. Run 'gh auth login' first." };
		}
	} catch {
		return { error: "GitHub CLI (gh) is not installed." };
	}

	try {
		const result = spawnSync("gh", ["gist", "create", htmlPath], { encoding: "utf-8" });
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
	fs.writeFileSync(logPath, lines.join("\n"), "utf-8");
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
	steerInboxDir?: string;
	steerCapabilityPath?: string;
	steerAckDir?: string;
	transcriptPath?: string;
	piPackageRoot?: string;
	piArgv1?: string;
	registerInterrupt?: (interrupt: (() => void) | undefined) => void;
	registerTimeout?: (interrupt: (() => void) | undefined) => void;
	registerStop?: (stop: (() => void) | undefined) => void;
	registerTurnBudgetAbort?: (abort: ((message: string, state?: TurnBudgetState) => void) | undefined) => void;
	timeoutSignal?: AbortSignal;
	stopSignal?: AbortSignal;
	timeoutMessage?: string;
	stopMessage?: string;
	turnBudget?: ResolvedTurnBudget;
	childIntercomTarget?: string;
	orchestratorIntercomTarget?: string;
	nestedRoute?: NestedRouteInfo;
	capabilityCeiling?: ResolvedSubagentCapabilityCeiling;
	onAttemptStart?: (attempt: { model?: string; thinking?: string }) => void;
	onChildEvent?: (event: ChildEvent) => void;
	onWriterProcess?: (writer: { state: "none" | "spawning" } | { state: "running"; pid: number }) => void;
	onExternalProcess?: (process: ExternalProcessStatus) => void;
	skipAcceptance?: () => boolean;
}

/** Run a single pi agent step, returning output and metadata */
async function runSingleStep(
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
				totalCost: imported.totalCost,
				structuredOutput: timedOut || stopped ? undefined : imported.structuredOutput,
				structuredOutputPath: timedOut || stopped ? undefined : imported.structuredOutputPath,
				structuredOutputSchemaPath: timedOut || stopped ? undefined : imported.structuredOutputSchemaPath,
				acceptance: timedOut || stopped ? undefined : imported.acceptance,
			});
		} finally {
			ctx.registerTimeout?.(undefined);
			ctx.registerStop?.(undefined);
		}
	}

	const effectiveStructuredOutput = step.structuredOutput ?? (step.structuredOutputSchema
		? createStructuredOutputRuntime(step.structuredOutputSchema, path.join(path.dirname(ctx.outputFile), "structured-output"))
		: undefined);
	const placeholderRegex = new RegExp(ctx.placeholder.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g");
	let task = step.task.replace(placeholderRegex, () => ctx.previousOutput);
	if (ctx.outputs) task = resolveOutputReferences(task, ctx.outputs);
	const taskForCompletionGuard = task;
	if (step.effectiveAcceptance) {
		const acceptancePrompt = formatAcceptancePrompt(step.effectiveAcceptance, { reportOptional: isAgentContractV1(step.agentContract) });
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
		const runner: ExternalCliRunnerStatus = {
			type: "external-cli",
			command: step.runner.command,
			args: step.runner.args ?? [],
			promptDelivery: step.runner.promptDelivery ?? "stdin",
			capabilities: { stop: true, steer: false, resume: false, structuredOutput: false, toolEvents: false },
		};
		const outputSnapshot = captureSingleOutputSnapshot(step.outputPath);
		const external = await runExternalCli(omitUndefinedProperties({
			command: runner.command,
			args: runner.args,
			cwd: step.cwd ?? ctx.cwd,
			prompt: buildExternalCliPrompt(step.systemPrompt ?? "", task),
			asyncDir: path.dirname(ctx.outputFile),
			stepIndex: ctx.flatIndex,
			registerTimeout: ctx.registerTimeout,
			registerStop: ctx.registerStop,
			timeoutMessage: ctx.timeoutMessage,
			stopMessage: ctx.stopMessage,
			onProcess: ctx.onExternalProcess,
		}));
		try { fs.writeFileSync(ctx.outputFile, external.output, "utf-8"); } catch { /* Observability output is best-effort. */ }
		const resolvedOutput = step.outputPath && external.exitCode === 0
			? resolveSingleOutput(step.outputPath, external.output, outputSnapshot)
			: { fullOutput: external.output };
		const outputReference = resolvedOutput.savedPath ? formatSavedOutputReference(resolvedOutput.savedPath, resolvedOutput.fullOutput) : undefined;
		const finalizedOutput = finalizeSingleOutput(omitUndefinedProperties({
			fullOutput: resolvedOutput.fullOutput,
			outputPath: step.outputPath,
			outputMode: step.outputMode,
			exitCode: external.exitCode ?? 1,
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
			context: step.context,
			output: finalizedOutput.displayOutput,
			outputState: external.output.trim() ? "present" : "absent",
			exitCode: external.exitCode,
			error: external.error,
			timedOut: external.timedOut,
			stopped: external.stopped,
			processSignal: external.processSignal,
			artifactPaths,
			outputSaveError: artifactErrors.outputSaveError,
			metadataSaveError: artifactErrors.metadataSaveError,
			runner,
			externalProcess: external.externalProcess,
		});
	}

	const candidates = step.modelCandidates && step.modelCandidates.length > 0
		? step.modelCandidates
		: step.model
			? [step.model]
			: [undefined];
	const attemptedModels: string[] = [];
	let capabilityAudit: import("../shared/capability-ceiling.ts").SubagentCapabilityAudit | undefined;
	let launchResolvedExtensions = step.launchResolvedExtensions;
	const modelAttempts: ModelAttempt[] = [];
	const writerProcesses: Array<{ processInstanceId: string; kind: "pi-writer"; attempt: number; closeObservedAt: number; exitCode: number | null; signal: string | null }> = [];
	let writerAttemptCount = 0;
	const attemptNotes: string[] = [];
	const eventsPath = path.join(path.dirname(ctx.outputFile), "events.jsonl");
	let finalResult: RunPiStreamingResult | undefined;
	let finalOutputSnapshot: SingleOutputSnapshot | undefined;
	let completionGuardTriggeredFinal = false;
	let turnBudget = ctx.turnBudget ? initialTurnBudgetState(ctx.turnBudget) : undefined;
	let toolBudget = step.toolBudget ? initialToolBudgetState(step.toolBudget) : undefined;
	let toolBudgetBlocked = false;
	let actualLaunchContractDigest = step.launchContractDigest;

	let modelIndex = 0;
	let startupAttemptIndex = 0;
	// Escalated to "file" after an unexplained zero-activity startup failure so
	// retries keep the task text out of argv (endpoint pre-exec scans may deny it).
	let taskDeliveryOverride: SubagentTaskDelivery | undefined;
	modelAttemptsLoop: while (modelIndex < candidates.length) {
		if (ctx.timeoutSignal?.aborted || ctx.stopSignal?.aborted || ctx.skipAcceptance?.()) break;
		const candidate = candidates[modelIndex];
		ctx.onAttemptStart?.(omitUndefinedProperties({ model: candidate, thinking: resolveEffectiveThinking(candidate, step.thinking) }));
		const outputSnapshot = captureSingleOutputSnapshot(step.outputPath);
		if (effectiveStructuredOutput) {
			try {
				if (fs.existsSync(effectiveStructuredOutput.outputPath)) fs.unlinkSync(effectiveStructuredOutput.outputPath);
			} catch {
				// Missing/stale structured-output files are handled after the child exits.
			}
		}
		const watchdogConfig = resolveWatchdogConfig(step.cwd ?? ctx.cwd);
		const childWatchdog = watchdogConfig.ok
			? resolveChildWatchdogConfig({
				config: watchdogConfig.config,
				agent: step.agent,
				runId: ctx.id,
				childIndex: ctx.flatIndex,
			})
			: undefined;
		const { args, env, tempDir, toolDiagnosticPath, runtimeAcknowledgedExtensionsPath, capabilityAudit: attemptCapabilityAudit } = buildPiArgs(omitUndefinedProperties({
			parentSessionId: step.parentSessionId,
			baseArgs: ["--mode", "json", "-p"],
			task,
			taskDelivery: taskDeliveryOverride,
			sessionEnabled,
			sessionDir,
			sessionFile: step.sessionFile,
			model: candidate,
			inheritProjectContext: step.inheritProjectContext,
			inheritSkills: step.inheritSkills,
			requireReadTool: Boolean(step.skills?.length),
			tools: step.tools,
			extensions: step.extensions,
			subagentOnlyExtensions: step.subagentOnlyExtensions,
			systemPrompt: appendTurnBudgetSystemPrompt(step.systemPrompt ?? "", ctx.turnBudget),
			systemPromptMode: step.systemPromptMode,
			mcpDirectTools: step.mcpDirectTools,
			capabilityCeiling: step.capabilityCeiling ?? ctx.capabilityCeiling,
			cwd: step.cwd ?? ctx.cwd,
			promptFileStem: step.agent,
			intercomSessionName: ctx.childIntercomTarget,
			orchestratorIntercomTarget: ctx.orchestratorIntercomTarget,
			runId: ctx.id,
			childAgentName: step.agent,
			childIndex: ctx.flatIndex,
			parentEventSink: ctx.nestedRoute?.eventSink,
			parentControlInbox: ctx.nestedRoute?.controlInbox,
			parentRootRunId: ctx.nestedRoute?.rootRunId,
			parentCapabilityToken: ctx.nestedRoute?.capabilityToken,
			steerInboxDir: ctx.steerInboxDir,
			steerCapabilityPath: ctx.steerCapabilityPath,
			steerAckDir: ctx.steerAckDir,
			structuredOutput: effectiveStructuredOutput,
			toolBudget: step.toolBudget,
			permissionRules: step.permissionRules,
			permissionAuditPath: step.permissionRules && ctx.artifactsDir
				? path.join(ctx.artifactsDir, "permission-audit", `${ctx.id}-${ctx.flatIndex}.jsonl`)
				: undefined,
			childWatchdog,
			waitToolEnabled: step.waitToolEnabled,
		}));
		if (step.definitionDigest) {
			const toolPlan = resolvePiLaunchToolPlan(omitUndefinedProperties({
				tools: step.tools,
				extensions: step.extensions,
				subagentOnlyExtensions: step.subagentOnlyExtensions,
				mcpDirectTools: step.mcpDirectTools,
				cwd: step.cwd ?? ctx.cwd,
				requireReadTool: Boolean(step.skills?.length),
				structuredOutput: Boolean(effectiveStructuredOutput),
				capabilityCeiling: step.capabilityCeiling ?? ctx.capabilityCeiling,
				inheritedCapabilityCeiling: decodeSubagentCapabilityCeiling(process.env[SUBAGENT_CAPABILITY_CEILING_ENV]),
			}));
			launchResolvedExtensions = projectLaunchResolvedChildExtensions(toolPlan);
			actualLaunchContractDigest = launchBindingDigest(omitUndefinedProperties({
				definitionDigest: step.definitionDigest,
				task: step.launchBindingTask ?? task,
				...(candidate ? { model: candidate } : {}),
				modelCandidates: candidates as string[],
				...(resolveEffectiveThinking(candidate, step.thinking) ? { thinking: resolveEffectiveThinking(candidate, step.thinking) } : {}),
				systemPrompt: appendTurnBudgetSystemPrompt(step.systemPrompt ?? "", ctx.turnBudget),
				systemPromptMode: step.systemPromptMode,
				inheritProjectContext: step.inheritProjectContext,
				inheritSkills: step.inheritSkills,
				skills: step.skills,
				tools: toolPlan.effectiveToolAllowlist,
				extensions: toolPlan.extensionArgs,
				mcpDirectTools: toolPlan.effectiveMcpTools,
				...(step.outputPath ? { outputPath: step.outputPath } : {}),
				...(step.outputMode ? { outputMode: step.outputMode } : {}),
				...(step.structuredOutputSchema ? { structuredOutputSchema: step.structuredOutputSchema } : {}),
			}));
		}
		capabilityAudit = attemptCapabilityAudit;
		writerAttemptCount += 1;
		const run = await runPiStreaming(
			args,
			step.cwd ?? ctx.cwd,
			ctx.outputFile,
			env,
			ctx.piPackageRoot,
			ctx.piArgv1,
			step.maxSubagentDepth,
			{ eventsPath, runId: ctx.id, stepIndex: ctx.flatIndex, agent: step.agent },
			ctx.registerInterrupt,
			ctx.onChildEvent,
			transcriptWriter,
			ctx.registerTimeout,
			ctx.timeoutMessage,
			ctx.registerStop,
			ctx.stopMessage,
			ctx.registerTurnBudgetAbort,
			ctx.onWriterProcess,
		);
		if (run.processCloseObservedAt !== undefined) {
			writerProcesses.push({
				processInstanceId: run.processInstanceId,
				kind: "pi-writer",
				attempt: writerAttemptCount - 1,
				closeObservedAt: run.processCloseObservedAt,
				exitCode: run.exitCode,
				signal: run.processSignal ?? null,
			});
		}
		if (run.turnBudget) turnBudget = run.turnBudget;
		else if (ctx.turnBudget) {
			const assistantMessages = run.messages.filter((message) => message.role === "assistant");
			const turnCount = assistantMessages.length;
			const lastAssistantMessage = assistantMessages.at(-1);
			if (turnCount > 0 && turnCount < ctx.turnBudget.maxTurns) {
				turnBudget = { ...ctx.turnBudget, outcome: "within-budget", turnCount };
			} else if (turnCount >= ctx.turnBudget.maxTurns) {
				const decision = turnBudgetDecision(
					ctx.turnBudget,
					turnCount,
					lastAssistantMessage ? isTerminalAssistantStop(lastAssistantMessage) : false,
					lastAssistantMessage ? assistantStartsToolCall(lastAssistantMessage) : false,
				);
				turnBudget = decision === "defer"
					? turnBudgetDeferredState(ctx.turnBudget, turnCount)
					: turnBudgetState(ctx.turnBudget, turnCount, decision === "abort");
			}
		}
		const toolAvailabilityError = run.exitCode === 0 && !run.error
			? readChildToolDiagnosticError(toolDiagnosticPath)
			: undefined;
		const runtimeAcknowledgedExtensions = readRuntimeAcknowledgedExtensions(runtimeAcknowledgedExtensionsPath);
		cleanupTempDir(tempDir);

		let structuredOutput: unknown;
		let structuredError: string | undefined;
		let validatedStructuredOutput = false;
		if (effectiveStructuredOutput && run.exitCode === 0 && !run.error && !toolAvailabilityError) {
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
					validatedStructuredOutput = true;
				}
			}
		}
		const errorMessages = validatedStructuredOutput
			? run.messages.slice(run.structuredOutputMessageStartIndex ?? run.messages.length)
			: run.messages;
		const hiddenError = run.exitCode === 0 && !run.error && !toolAvailabilityError && !structuredError
			? detectSubagentError(errorMessages)
			: null;
		const emptyOutputError = run.exitCode === 0
			&& !run.error
			&& !toolAvailabilityError
			&& !structuredError
			&& !run.finalOutput.trim()
			&& !validatedStructuredOutput
			&& (!hiddenError?.hasError || hasEmptyTerminalAssistantResponse(run.messages))
			? "Subagent produced no output (possible model cold-start or empty response)."
			: undefined;
		const completionGuardEnabled = isAgentContractV1(step.agentContract) ? step.completionGuard === true : step.completionGuard !== false;
		const completionGuard = run.exitCode === 0 && !run.error && !toolAvailabilityError && !structuredError && !hiddenError?.hasError && !emptyOutputError && completionGuardEnabled
			? evaluateCompletionMutationGuard(omitUndefinedProperties({
				agent: step.agent,
				task: taskForCompletionGuard,
				messages: run.messages,
				tools: step.tools,
				mcpDirectTools: step.mcpDirectTools,
			}))
			: undefined;
		const completionGuardTriggered = completionGuard?.triggered === true && !run.observedMutationAttempt;
		const fileMutationEffect = completionGuard
			? {
				status: completionGuard.expectedMutation ? completionGuardTriggered ? "missing" as const : "observed" as const : "not-applicable" as const,
				expected: completionGuard.expectedMutation,
				attempted: completionGuard.attemptedMutation || run.observedMutationAttempt === true,
				...(completionGuardTriggered ? { message: "Subagent completed without making edits for an implementation task." } : {}),
			}
			: undefined;
		const completionGuardError = completionGuardTriggered && !isAgentContractV1(step.agentContract)
			? "Subagent completed without making edits for an implementation task.\nIt appears to have returned planning or scratchpad output instead of applying changes."
			: undefined;
		const effectiveExitCode = toolAvailabilityError || (completionGuardTriggered && !isAgentContractV1(step.agentContract)) || structuredError || emptyOutputError
			? 1
			: hiddenError?.hasError
				? (hiddenError.exitCode ?? 1)
				: run.error && run.exitCode === 0
					? 1
					: run.exitCode;
		const signalError = run.exitCode !== 0 && isUnexplainedProcessSignal(omitUndefinedProperties({
			processSignal: run.processSignal,
			interrupted: run.interrupted,
			timedOut: run.timedOut,
			stopped: run.stopped,
			turnBudgetExceeded: run.turnBudgetExceeded,
		})) ? formatProcessSignalError(run.processSignal!) : undefined;
		const error = toolAvailabilityError
			?? completionGuardError
			?? structuredError
			?? emptyOutputError
			?? (hiddenError?.hasError
				? hiddenError.details
					? `${hiddenError.errorType} failed (exit ${effectiveExitCode}): ${hiddenError.details}`
					: `${hiddenError.errorType} failed with exit code ${effectiveExitCode}`
				: run.error || signalError || (run.exitCode !== 0 && run.stderr.trim() ? run.stderr.trim() : undefined));
		const attempt: ModelAttempt = omitUndefinedProperties({
			model: candidate ?? run.model ?? step.model ?? "default",
			success: effectiveExitCode === 0 && !error,
			exitCode: effectiveExitCode,
			error,
			usage: run.usage,
		});
		modelAttempts.push(attempt);
		if (candidate && startupAttemptIndex === 0) attemptedModels.push(candidate);
		completionGuardTriggeredFinal = completionGuardTriggered;
		finalOutputSnapshot = outputSnapshot;
		if (step.toolBudget) {
			const toolMessages = run.messages.filter((message) => message.role === "toolResult");
			const blockedMessage = toolMessages.find((message) => extractTextFromContent(message.content).includes("Tool budget hard limit reached"));
			toolBudgetBlocked = Boolean(blockedMessage);
			toolBudget = toolBudgetState(step.toolBudget, toolMessages.length, blockedMessage ? (blockedMessage as { toolName?: string }).toolName : undefined);
		}
		finalResult = { ...run, exitCode: effectiveExitCode, model: candidate ?? run.model, error, structuredOutput, runtimeAcknowledgedExtensions, ...(step.agentContract ? { agentContract: step.agentContract } : {}), ...(fileMutationEffect ? { effects: { fileMutation: fileMutationEffect } } : {}) } as RunPiStreamingResult & { structuredOutput?: unknown; agentContract?: import("../../shared/types.ts").AgentContract; effects?: import("../../shared/types.ts").EffectsProjection };
		if (run.turnBudgetExceeded) break modelAttemptsLoop;
		if (run.stopped || run.timedOut || ctx.timeoutSignal?.aborted || ctx.stopSignal?.aborted || ctx.skipAcceptance?.()) break modelAttemptsLoop;
		if (attempt.success || completionGuardTriggered) break modelAttemptsLoop;

		const startupFailure = isRetryableSubagentStartupFailure(omitUndefinedProperties({
			exitCode: effectiveExitCode,
			error,
			finalOutput: run.finalOutput,
			messageCount: run.messages.length,
			toolCount: run.toolCount,
			usage: run.usage,
			durationMs: run.durationMs,
			protocolError: run.protocolError,
			processSignal: run.processSignal,
			observedMutationAttempt: run.observedMutationAttempt,
			interrupted: run.interrupted,
			timedOut: run.timedOut,
			stopped: run.stopped,
			turnBudgetExceeded: run.turnBudgetExceeded,
		}));
		const retryDelayMs = SUBAGENT_STARTUP_RETRY_DELAYS_MS[startupAttemptIndex];
		if (startupFailure && retryDelayMs !== undefined) {
			const retryNote = formatSubagentStartupRetryNote({
				model: attempt.model,
				attempt: startupAttemptIndex + 1,
				maxAttempts: SUBAGENT_STARTUP_RETRY_DELAYS_MS.length + 1,
				delayMs: retryDelayMs,
			});
			const shouldRetry = await waitForSubagentStartupRetry(retryDelayMs, [ctx.timeoutSignal, ctx.stopSignal]);
			if (!shouldRetry || ctx.skipAcceptance?.()) break modelAttemptsLoop;
			if (!taskDeliveryOverride && run.processSignal === "SIGKILL") {
				taskDeliveryOverride = "file";
				attemptNotes.push("[startup-retry] retrying with file task delivery to keep the task text out of the child process argv.");
			}
			attempt.error = retryNote;
			attemptNotes.push(retryNote);
			startupAttemptIndex += 1;
			continue;
		}
		if (startupFailure) {
			const startupError = formatSubagentStartupRetryExhaustedError({
				model: attempt.model,
				attempts: startupAttemptIndex + 1,
			});
			attempt.error = startupError;
			finalResult.error = startupError;
			finalResult.finalOutput = startupError;
			break modelAttemptsLoop;
		}
		if (!isRetryableModelFailure(error) || modelIndex === candidates.length - 1) break modelAttemptsLoop;
		attemptNotes.push(formatModelAttemptNote(attempt, candidates[modelIndex + 1]));
		modelIndex += 1;
		startupAttemptIndex = 0;
	}

	const rawOutput = finalResult?.finalOutput ?? "";
	const outputForPersistence = stripAcceptanceReport(rawOutput);
	const resolvedOutput = step.outputPath && finalResult?.exitCode === 0
		? resolveSingleOutput(step.outputPath, outputForPersistence, finalOutputSnapshot)
		: { fullOutput: outputForPersistence };
	const output = stripAcceptanceReport(resolvedOutput.fullOutput);
	const outputReference = resolvedOutput.savedPath ? formatSavedOutputReference(resolvedOutput.savedPath, output) : undefined;
	let outputForSummary = output;
	if (attemptNotes.length > 0) {
		outputForSummary = `${attemptNotes.join("\n")}\n\n${outputForSummary}`.trim();
	}
	if (finalResult?.stopped && !outputForSummary.trim()) {
		outputForSummary = ctx.stopMessage ?? "Subagent stopped by user.";
	} else if (!finalResult?.timedOut && !finalResult?.stopped && finalResult?.turnBudgetExceeded && turnBudget) {
		outputForSummary = formatTurnBudgetOutput(turnBudgetExceededMessage(turnBudget, turnBudget.turnCount), outputForSummary);
	} else if (!finalResult?.timedOut && !finalResult?.stopped && turnBudget?.outcome === "termination-deferred") {
		const note = turnBudgetDeferredNote(turnBudget, turnBudget.terminationDeferredAtTurn ?? turnBudget.turnCount);
		outputForSummary = outputForSummary.trim() ? `${note}\n\n${outputForSummary}` : note;
	} else if (!finalResult?.timedOut && !finalResult?.stopped && turnBudget?.outcome === "wrap-up-requested") {
		const note = turnBudgetSoftNote(turnBudget, turnBudget.wrapUpRequestedAtTurn ?? turnBudget.turnCount);
		outputForSummary = outputForSummary.trim() ? `${note}\n\n${outputForSummary}` : note;
	}
	const outputForAcceptance = rawOutput;
	const childWrittenOutput = step.outputPath
		? extractChildWrittenOutput(finalResult?.messages, step.outputPath, step.cwd ?? ctx.cwd)
		: undefined;
	const outputState: SubagentOutputState = finalResult?.outputState === "present"
		|| (finalResult as (RunPiStreamingResult & { structuredOutput?: unknown }) | undefined)?.structuredOutput !== undefined
		|| Boolean(childWrittenOutput?.trim())
		? "present"
		: resolvedOutput.savedPath
			? "unknown"
			: finalResult?.outputState ?? "unknown";
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
	const acceptance = step.effectiveAcceptance && !finalResult?.stopped && !finalResult?.turnBudgetExceeded && !ctx.timeoutSignal?.aborted && !ctx.stopSignal?.aborted && !ctx.skipAcceptance?.()
		? await evaluateAcceptance(omitUndefinedProperties({
			acceptance: step.effectiveAcceptance,
			output: outputForAcceptance,
			fileOutput: childWrittenOutput !== undefined && step.outputPath
				? { content: childWrittenOutput, path: step.outputPath, authoritative: step.outputMode === "file-only" }
				: undefined,
			cwd: step.cwd ?? ctx.cwd,
			signal: combinedAbortSignal([ctx.timeoutSignal, ctx.stopSignal]),
			abortMessage: ctx.stopSignal?.aborted ? ctx.stopMessage ?? "Subagent stopped by user." : ctx.timeoutMessage ?? "Subagent timed out.",
			reportOptional: isAgentContractV1(step.agentContract),
			artifactsDir: ctx.artifactsDir,
			runId: ctx.id,
		}))
		: undefined;
	const stoppedAfterAcceptance = finalResult?.stopped === true || ctx.stopSignal?.aborted === true;
	const timedOutAfterAcceptance = !stoppedAfterAcceptance && (finalResult?.timedOut === true || ctx.timeoutSignal?.aborted === true);
	const turnBudgetExceeded = finalResult?.turnBudgetExceeded === true;
	const effectiveAcceptance = step.effectiveAcceptance
		? stoppedAfterAcceptance
			? buildSkippedAcceptanceLedger(step.effectiveAcceptance, { id: "stopped", message: "Acceptance was not evaluated because the subagent was stopped." })
			: timedOutAfterAcceptance
				? buildSkippedAcceptanceLedger(step.effectiveAcceptance, { id: "timeout", message: "Acceptance was not evaluated because the subagent timed out." })
				: turnBudgetExceeded
					? buildSkippedAcceptanceLedger(step.effectiveAcceptance, { id: "turn-budget", message: "Acceptance was not evaluated because the subagent exceeded its turn budget." })
					: acceptance
		: undefined;
	const acceptanceFailure = effectiveAcceptance ? acceptanceFailureMessage(effectiveAcceptance) : undefined;
	const acceptanceCanFailRun = acceptanceFailure && effectiveAcceptance?.explicit && (finalResult?.exitCode ?? 1) === 0 && !finalResult?.interrupted && !timedOutAfterAcceptance && !stoppedAfterAcceptance && !turnBudgetExceeded && !isAgentContractV1(step.agentContract);
	const effectiveFinalExitCode = timedOutAfterAcceptance || stoppedAfterAcceptance || turnBudgetExceeded ? 1 : acceptanceCanFailRun ? 1 : finalResult?.exitCode ?? 1;
	const effectiveFinalError = stoppedAfterAcceptance
		? ctx.stopMessage ?? "Subagent stopped by user."
		: timedOutAfterAcceptance
			? ctx.timeoutMessage ?? "Subagent timed out."
			: turnBudgetExceeded
				? finalResult?.error ?? (turnBudget ? turnBudgetExceededMessage(turnBudget, turnBudget.turnCount) : "Subagent exceeded turn budget.")
				: acceptanceCanFailRun
					? (finalResult?.error ? `${finalResult.error}\n${acceptanceFailure}` : acceptanceFailure)
					: finalResult?.error;

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
				error: effectiveFinalError,
				acceptance: effectiveAcceptance,
				...(capabilityAudit ? { capabilityCeiling: capabilityAudit.ceiling, capabilityAudit } : {}),
				launchContractDigest: actualLaunchContractDigest,
				launchResolvedExtensions,
				...((finalResult as (RunPiStreamingResult & { runtimeAcknowledgedExtensions?: RuntimeAcknowledgedChildExtensionsV1 }) | undefined)?.runtimeAcknowledgedExtensions ? { runtimeAcknowledgedExtensions: (finalResult as RunPiStreamingResult & { runtimeAcknowledgedExtensions?: RuntimeAcknowledgedChildExtensionsV1 }).runtimeAcknowledgedExtensions } : {}),
				...(transcriptWriter ? { transcriptPath: artifactPaths.transcriptPath } : {}),
				transcriptError: transcriptWriter?.getError(),
				skills: step.skills,
				timestamp: Date.now(),
			},
		})
		: {};

	const result: StepResult & { completionGuardTriggered?: boolean } = omitUndefinedProperties({
		agent: step.agent,
		context: step.context,
		...(step.agentContract ? { agentContract: step.agentContract } : {}),
		launchContractDigest: actualLaunchContractDigest,
		output: outputForSummary,
		outputState,
		exitCode: effectiveFinalExitCode,
		error: effectiveFinalError,
		protocolError: finalResult?.protocolError,
		sessionFile: step.sessionFile,
		intercomTarget: ctx.childIntercomTarget,
		model: finalResult?.model,
		attemptedModels: attemptedModels.length > 0 ? attemptedModels : undefined,
		modelAttempts,
		totalCost: costSummaryFromAttempts(modelAttempts),
		artifactPaths,
		outputSaveError: artifactErrors.outputSaveError,
		metadataSaveError: artifactErrors.metadataSaveError,
		transcriptPath: transcriptWriter ? artifactPaths?.transcriptPath : undefined,
		transcriptError: transcriptWriter?.getError(),
		interrupted: timedOutAfterAcceptance || stoppedAfterAcceptance || turnBudgetExceeded ? false : finalResult?.interrupted,
		timedOut: timedOutAfterAcceptance ? true : finalResult?.timedOut,
		stopped: stoppedAfterAcceptance ? true : finalResult?.stopped,
		processSignal: finalResult?.processSignal,
		turnBudget,
		turnBudgetExceeded: turnBudgetExceeded || undefined,
		wrapUpRequested: finalResult?.wrapUpRequested || turnBudget?.outcome === "wrap-up-requested" || turnBudget?.outcome === "termination-deferred" || turnBudgetExceeded || undefined,
		toolBudget,
		toolBudgetBlocked: toolBudgetBlocked || undefined,
		completionGuardTriggered: completionGuardTriggeredFinal,
		...((finalResult as (RunPiStreamingResult & { effects?: import("../../shared/types.ts").EffectsProjection }) | undefined)?.effects ? { effects: (finalResult as RunPiStreamingResult & { effects?: import("../../shared/types.ts").EffectsProjection }).effects } : {}),
		structuredOutput: timedOutAfterAcceptance || stoppedAfterAcceptance || turnBudgetExceeded ? undefined : (finalResult as (RunPiStreamingResult & { structuredOutput?: unknown }) | undefined)?.structuredOutput,
		structuredOutputPath: timedOutAfterAcceptance || stoppedAfterAcceptance || turnBudgetExceeded ? undefined : effectiveStructuredOutput?.outputPath,
		structuredOutputSchemaPath: timedOutAfterAcceptance || stoppedAfterAcceptance || turnBudgetExceeded ? undefined : effectiveStructuredOutput?.schemaPath,
		acceptance: effectiveAcceptance,
		watchdog: finalResult?.watchdog,
		...(capabilityAudit ? { capabilityCeiling: capabilityAudit.ceiling, capabilityAudit } : {}),
		launchResolvedExtensions,
		...((finalResult as (RunPiStreamingResult & { runtimeAcknowledgedExtensions?: RuntimeAcknowledgedChildExtensionsV1 }) | undefined)?.runtimeAcknowledgedExtensions ? { runtimeAcknowledgedExtensions: (finalResult as RunPiStreamingResult & { runtimeAcknowledgedExtensions?: RuntimeAcknowledgedChildExtensionsV1 }).runtimeAcknowledgedExtensions } : {}),
		writerProcesses,
		writerAttemptCount,
	});
	return isAgentContractV1(step.agentContract) ? attachContractProjections(result as unknown as import("../../shared/types.ts").SingleResult) as unknown as typeof result : result;
}

type RunnerStatusStep = NonNullable<AsyncStatus["steps"]>[number] & {
	exitCode?: number | null;
	description?: string;
};

function externalRunnerStatus(runner: SubagentStep["runner"]): ExternalCliRunnerStatus | undefined {
	if (runner?.type !== "external-cli") return undefined;
	return {
		type: "external-cli",
		command: runner.command,
		args: runner.args ?? [],
		promptDelivery: runner.promptDelivery ?? "stdin",
		capabilities: { stop: true, steer: false, resume: false, structuredOutput: false, toolEvents: false },
	};
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
}): void {
	for (let taskIndex = 0; taskIndex < input.group.parallel.length; taskIndex++) {
		const flatTaskIndex = input.groupStartFlatIndex + taskIndex;
		const statusStep = requiredStatusStep(input.statusPayload, flatTaskIndex);
		const task = input.group.parallel[taskIndex];
		if (!task) throw new Error(`Missing parallel task at index ${taskIndex}`);
		statusStep.status = "failed";
		statusStep.startedAt = input.failedAt;
		statusStep.endedAt = input.failedAt;
		statusStep.durationMs = 0;
		statusStep.exitCode = 1;
		input.results.push(omitUndefinedProperties({ agent: task.agent, context: task.context, output: input.setupError, success: false, exitCode: 1, sessionFile: task.sessionFile }));
	}
	input.statusPayload.currentStep = input.groupStartFlatIndex;
	input.statusPayload.lastUpdate = input.failedAt;
	input.statusPayload.outputFile = path.join(input.asyncDir, `output-${input.groupStartFlatIndex}.log`);
	writeAtomicJson(input.statusPath, input.statusPayload);
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
	writeAtomicJson(input.statusPath, input.statusPayload);
	appendJsonl(input.eventsPath, JSON.stringify({
		type: "subagent.parallel.started",
		ts: input.groupStartTime,
		runId: input.runId,
		stepIndex: input.stepIndex,
		agents: input.group.parallel.map((task) => task.agent),
		count: input.group.parallel.length,
	}));
}

function prepareParallelTaskRun(
	task: SubagentStep,
	cwd: string,
	worktreeSetup: WorktreeSetup | undefined,
	taskIndex: number,
): { taskForRun: SubagentStep; taskCwd: string } {
	if (!worktreeSetup) return { taskForRun: task, taskCwd: cwd };
	const { cwd: _taskCwd, ...taskForRun } = task;
	return {
		taskForRun,
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
	onWriterProcess?: (writer: { state: "none" | "spawning" } | { state: "running"; pid: number }) => void,
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
	const statusPath = path.join(asyncDir, "status.json");
	const eventsPath = path.join(asyncDir, "events.jsonl");
	const logPath = path.join(asyncDir, `subagent-log-${id}.md`);
	const controlConfig = config.controlConfig ?? DEFAULT_CONTROL_CONFIG;
	const activeChildInterrupts = new Map<number, () => void>();
	const activeChildTimeouts = new Map<number, () => void>();
	const activeChildStops = new Map<number, () => void>();
	const activeChildTurnBudgetAborts = new Map<number, (message: string, state?: TurnBudgetState) => void>();
	const pendingStepSteers: SteerRequest[] = [];
	const steeringCapabilities = new Map<number, SteerCapability>();
	let interrupted = false;
	let currentActivityState: ActivityState | undefined;
	let activityTimer: NodeJS.Timeout | undefined;
	let timeoutTimer: NodeJS.Timeout | undefined;
	let timedOut = false;
	let stopped = false;
	let turnBudgetExceeded = false;
	let usageBudgetExceeded = false;
	let checkpointRejected = false;
	let pendingCheckpointDecision: "approved" | "rejected" | undefined;
	let wakeCheckpointDecision: (() => void) | undefined;
	const timeoutMessage = config.timeoutMs !== undefined ? `Subagent timed out after ${config.timeoutMs}ms.` : undefined;
	const stopMessage = "Subagent stopped by user.";
	const timeoutAbortController = new AbortController();
	const stopAbortController = new AbortController();
	let previousCumulativeTokens: TokenUsage = { input: 0, output: 0, total: 0 };
	let latestSessionFile: string | undefined;

	const flatSteps = flattenSteps(steps);
	const initialFlatStepCount = flatSteps.length;
	const parallelGroups: Array<{ start: number; count: number; stepIndex: number }> = [];
	const initialStatusSteps: RunnerStatusStep[] = [];
	let flatStepCount = 0;
	for (let stepIndex = 0; stepIndex < steps.length; stepIndex++) {
		const step = steps[stepIndex]!;
		if (isCheckpointRunnerStep(step)) {
			initialStatusSteps.push(omitUndefinedProperties({
				agent: `checkpoint:${step.checkpoint}`,
				phase: step.phase,
				label: step.label ?? step.checkpoint,
				status: "pending",
				checkpoint: { name: step.checkpoint, ...(step.message ? { message: step.message } : {}), status: "pending", stepIndex },
				recentTools: [],
				recentOutput: [],
			}));
			flatStepCount++;
			continue;
		}
		if (isParallelGroup(step)) {
			parallelGroups.push({ start: flatStepCount, count: step.parallel.length, stepIndex });
			for (const task of step.parallel) {
				const taskFlatIndex = flatStepCount;
				const transcriptPath = resolveAsyncStepTranscriptPath(omitUndefinedProperties({ artifactsDir, artifactConfig, runId: id, agent: task.agent, flatIndex: taskFlatIndex, flatStepCount: initialFlatStepCount }));
				initialStatusSteps.push(omitUndefinedProperties({
					agent: task.agent,
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
					status: "pending",
					...(task.toolBudget ? { toolBudget: initialToolBudgetState(task.toolBudget) } : {}),
					...(task.sessionFile ? { sessionFile: task.sessionFile } : {}),
					...(transcriptPath ? { transcriptPath } : {}),
					skills: task.skills,
					model: task.model,
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
				...(step.agentContract ? { agentContract: step.agentContract } : {}),
				...(step.capabilityCeiling ? { capabilityCeiling: step.capabilityCeiling } : {}),
				status: "pending",
				...(step.parallel.toolBudget ? { toolBudget: initialToolBudgetState(step.parallel.toolBudget) } : {}),
				recentTools: [],
				recentOutput: [],
			}));
			flatStepCount++;
		} else {
			const stepFlatIndex = flatStepCount;
			const transcriptPath = resolveAsyncStepTranscriptPath(omitUndefinedProperties({ artifactsDir, artifactConfig, runId: id, agent: step.agent, flatIndex: stepFlatIndex, flatStepCount: initialFlatStepCount }));
			initialStatusSteps.push(omitUndefinedProperties({
				agent: step.agent,
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
				status: "pending",
				...(step.toolBudget ? { toolBudget: initialToolBudgetState(step.toolBudget) } : {}),
				...(step.sessionFile ? { sessionFile: step.sessionFile } : {}),
				...(transcriptPath ? { transcriptPath } : {}),
				skills: step.skills,
				model: step.model,
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
	const statusPayload: RunnerStatusPayload = omitUndefinedProperties({
		lifecycleArtifactVersion: SUBAGENT_LIFECYCLE_ARTIFACT_VERSION,
		runId: id,
		...(config.sessionId ? { sessionId: config.sessionId } : {}),
		mode: config.resultMode ?? (flatSteps.length > 1 ? "chain" : "single"),
		...(config.nestedRoute ? { isNested: true } : {}),
		state: "running",
		steering: createSteeringStatus(),
		lastActivityAt: overallStartTime,
		startedAt: overallStartTime,
		lastUpdate: overallStartTime,
		...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
		...(config.deadlineAt !== undefined ? { deadlineAt: config.deadlineAt } : {}),
		...(config.turnBudget ? { turnBudget: initialTurnBudgetState(config.turnBudget) } : {}),
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
		...(config.parentWorkflowRunId ? { parentWorkflowRunId: config.parentWorkflowRunId } : {}),
		...(config.workflowKey ? { workflowKey: config.workflowKey } : {}),
		...(config.runnerProcessInstanceId ? { processTerminal: { version: 1 as const, state: "pending" as const, runId: id, runnerProcessInstanceId: config.runnerProcessInstanceId } } : {}),
		steps: initialStatusSteps,
		artifactsDir,
		sessionDir: config.sessionDir,
		outputFile: path.join(asyncDir, "output-0.log"),
	});

	fs.mkdirSync(asyncDir, { recursive: true });
	writeAtomicJson(statusPath, statusPayload);
	updateActiveRunIndex(asyncDir, statusPayload.state);
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
					setOptionalProperty(node, "checkpoint", step.checkpoint);
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
	let lastIndexedActiveState = isActiveAsyncState(statusPayload.state);
	const writeStatusPayloadNow = (): void => {
		refreshWorkflowGraph();
		writeAtomicJson(statusPath, statusPayload);
		const activeState = isActiveAsyncState(statusPayload.state);
		if (activeState !== lastIndexedActiveState) {
			updateActiveRunIndex(asyncDir, statusPayload.state);
			lastIndexedActiveState = activeState;
		}
		emitNestedSelfEvent(statusPayload.state === "running" || statusPayload.state === "queued" ? "subagent.nested.updated" : "subagent.nested.completed");
	};
	const statusWriteCoalescer = createFileCoalescer(writeStatusPayloadNow, 100);
	const writeStatusPayload = (immediate = true): void => {
		if (immediate || statusPayload.state !== "running" || statusPayload.activityState !== undefined) {
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
		if (stopped) stop();
	};
	const registerStepTurnBudgetAbort = (flatIndex: number, abort: ((message: string, state?: TurnBudgetState) => void) | undefined): void => {
		if (!abort) {
			activeChildTurnBudgetAborts.delete(flatIndex);
			return;
		}
		activeChildTurnBudgetAborts.set(flatIndex, abort);
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
	const pausedStepResult = (agent: string, context?: "fresh" | "fork"): SingleStepResult => omitUndefinedProperties({
		agent,
		context,
		output: "Paused after interrupt. Waiting for explicit next action.",
		exitCode: 0,
		interrupted: true,
	});
	const timedOutStepResult = (agent: string, context?: "fresh" | "fork"): SingleStepResult => omitUndefinedProperties({
		agent,
		context,
		output: timeoutMessage ?? "Subagent timed out.",
		error: timeoutMessage ?? "Subagent timed out.",
		exitCode: 1,
		timedOut: true,
	});
	const stoppedStepResult = (agent: string, context?: "fresh" | "fork"): SingleStepResult => omitUndefinedProperties({
		agent,
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
	const supervisorAttentionSteps = new Map<number, ActivityState | undefined>();
	const mutatingFailureWindowMs = 5 * 60_000;
	const appendControlEvent = (event: ReturnType<typeof buildControlEvent>) => {
		if (!controlConfig.enabled) return;
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
			if (steeringCapabilities.get(index)?.supported === false) return { index, state: "failed" as const, reason: "child Pi session does not support steering" };
			return { index, state: "routed" as const };
		});
		recordSteeringLifecycle(request, targetStates);
		emitSteeringEvent("subagent.steer.requested", request, undefined, { targets: targetStates });
		for (const target of targetStates) {
			if (target.state === "routed") {
				try {
					enqueueStepSteer(asyncDir, target.index, request);
					updateSteeringLifecycleTarget(request.id, target.index, "routed", now);
					emitSteeringEvent("subagent.steer.routed", request, target.index);
				} catch (error) {
					markSteeringAttention(target.index);
					updateSteeringLifecycleTarget(request.id, target.index, "failed", now, { reason: error instanceof Error ? error.message : String(error) });
					emitSteeringEvent("subagent.steer.failed", request, target.index, { reason: error instanceof Error ? error.message : String(error) });
				}
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
	const consumeSteerAck = (ack: SteerAck): void => {
		const lifecycle = steeringStatus(statusPayload);
		const request = lifecycle.recent.find((candidate) => candidate.id === ack.requestId);
		if (!request || !request.targets.some((target) => target.index === ack.index)) return;
		const late = fs.existsSync(steeringMarkerPath(ack.requestId));
		const now = Date.now();
		if (ack.state === "delivered") {
			updateSteeringLifecycleTarget(ack.requestId, ack.index, late ? "late" : "delivered", now, omitUndefinedProperties({ reason: late ? "acknowledged after recovery commit" : undefined }));
			emitSteeringEvent("subagent.steer.delivered", { type: "steer", id: ack.requestId, ts: now, message: ack.message }, ack.index, { late, deliveryStatus: "delivered", message: ack.message });
		} else if (ack.state === "queued") {
			updateSteeringLifecycleTarget(ack.requestId, ack.index, "queued", now);
			emitSteeringEvent("subagent.steer.queued", { type: "steer", id: ack.requestId, ts: now, message: ack.message }, ack.index, { deliveryStatus: "queued", message: ack.message });
		} else {
			markSteeringAttention(ack.index);
			updateSteeringLifecycleTarget(ack.requestId, ack.index, "failed", now, { reason: ack.message });
			emitSteeringEvent("subagent.steer.failed", { type: "steer", id: ack.requestId, ts: now, message: ack.message }, ack.index, { reason: ack.message });
		}
		emitTerminalSteeringNotice(ack.requestId, `Steering failed for run ${id}: ${ack.message}`);
		statusPayload.lastUpdate = now;
		writeStatusPayload();
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
	const updateStepModel = (flatIndex: number, model: string | undefined, thinking: string | undefined, now = Date.now()): void => {
		const step = statusPayload.steps[flatIndex];
		if (!step) return;
		setOptionalProperty(step, "model", model);
		setOptionalProperty(step, "thinking", thinking);
		statusPayload.lastUpdate = now;
		writeStatusPayload();
	};
	const updateStepTurnBudget = (
		flatIndex: number,
		turnCount: number,
		now: number,
		terminalAssistantStop: boolean,
		toolWorkActiveOrStarting: boolean,
	): void => {
		const budget = config.turnBudget;
		const step = statusPayload.steps[flatIndex];
		if (!budget || !step || timedOut || stopped || turnBudgetExceeded || step.turnBudgetExceeded) return;
		if (turnCount < budget.maxTurns) {
			const state: TurnBudgetState = { ...budget, outcome: "within-budget", turnCount };
			step.turnBudget = state;
			statusPayload.turnBudget = state;
			return;
		}
		if (!step.wrapUpRequested) {
			step.wrapUpRequested = true;
			statusPayload.wrapUpRequested = true;
			appendRecentStepOutput(step, [turnBudgetSoftNote(budget, turnCount)]);
		}
		const decision = turnBudgetDecision(budget, turnCount, terminalAssistantStop, toolWorkActiveOrStarting);
		if (decision === "defer") {
			const firstDeferredTurn = step.turnBudget?.terminationDeferredAtTurn;
			const deferredState = turnBudgetDeferredState(budget, turnCount, firstDeferredTurn);
			step.turnBudget = deferredState;
			statusPayload.turnBudget = deferredState;
			if (firstDeferredTurn === undefined) {
				appendJsonl(eventsPath, JSON.stringify({
					type: "subagent.step.turn_budget_deferred",
					ts: now,
					runId: id,
					stepIndex: flatIndex,
					agent: step.agent,
					turnCount,
					maxTurns: budget.maxTurns,
					graceTurns: budget.graceTurns,
				}));
			}
			return;
		}
		const state = turnBudgetState(budget, turnCount, false);
		step.turnBudget = state;
		statusPayload.turnBudget = state;
		if (decision !== "abort") return;
		const exceededState = turnBudgetState(budget, turnCount, true);
		const message = turnBudgetExceededMessage(budget, turnCount);
		step.turnBudget = exceededState;
		step.turnBudgetExceeded = true;
		step.wrapUpRequested = true;
		step.error = message;
		turnBudgetExceeded = true;
		statusPayload.turnBudget = exceededState;
		statusPayload.turnBudgetExceeded = true;
		statusPayload.wrapUpRequested = true;
		statusPayload.error = message;
		statusPayload.lastUpdate = now;
		appendJsonl(eventsPath, JSON.stringify({ type: "subagent.step.turn_budget_exceeded", ts: now, runId: id, stepIndex: flatIndex, agent: step.agent, turnCount, maxTurns: budget.maxTurns, graceTurns: budget.graceTurns, message }));
		activeChildTurnBudgetAborts.get(flatIndex)?.(message, exceededState);
	};
	const updateStepFromChildEvent = (flatIndex: number, event: ChildEvent): void => {
		const step = statusPayload.steps[flatIndex];
		if (!step) return;
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
		if (event.type === "tool_execution_start" && event.toolName) {
			const mutates = isMutatingTool(event.toolName, event.args);
			const currentPath = resolveCurrentPath(event.toolName, event.args);
			step.toolCount = (step.toolCount ?? 0) + 1;
			const configuredToolBudget = flatSteps[flatIndex]?.toolBudget;
			if (configuredToolBudget) {
				step.toolBudget = toolBudgetState(configuredToolBudget, step.toolCount);
				statusPayload.toolBudget = step.toolBudget;
			}
			step.currentTool = event.toolName;
			step.currentToolArgs = extractToolArgsPreview(event.args ?? {});
			step.currentToolStartedAt = now;
			setOptionalProperty(step, "currentPath", currentPath);
			pendingToolResults[flatIndex] = omitUndefinedProperties({ tool: event.toolName, path: currentPath, mutates, startedAt: now });
			statusPayload.toolCount = (statusPayload.toolCount ?? 0) + 1;
			syncTopLevelCurrentTool();
			if (controlConfig.enabled && isBlockingSupervisorTool(event.toolName, event.args) && step.activityState !== "needs_attention") {
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
					currentToolDurationMs: 0,
					currentPath: step.currentPath,
				})));
			}
		} else if (event.type === "tool_execution_end") {
			if (step.currentTool) {
				step.recentTools ??= [];
				step.recentTools.push({ tool: step.currentTool, args: step.currentToolArgs || "", endMs: now });
			}
			const supervisorPreviousActivity = supervisorAttentionSteps.get(flatIndex);
			const clearedSupervisorAttention = supervisorAttentionSteps.delete(flatIndex);
			delete step.currentTool;
			delete step.currentToolArgs;
			delete step.currentToolStartedAt;
			delete step.currentPath;
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
				const previousInput = step.tokens?.input ?? 0;
				const previousOutput = step.tokens?.output ?? 0;
				step.tokens = { input: previousInput + input, output: previousOutput + output, total: previousInput + previousOutput + input + output };
				const totalInput = statusPayload.totalTokens?.input ?? 0;
				const totalOutput = statusPayload.totalTokens?.output ?? 0;
				statusPayload.totalTokens = { input: totalInput + input, output: totalOutput + output, total: totalInput + totalOutput + input + output };
				refreshUsageBudget();
			}
			statusPayload.turnCount = Math.max(statusPayload.turnCount ?? 0, step.turnCount);
			updateStepTurnBudget(
				flatIndex,
				step.turnCount,
				now,
				isTerminalAssistantStop(event.message),
				assistantStartsToolCall(event.message) || Boolean(step.currentTool),
			);
		}
		syncTopLevelCurrentTool();
		step.lastActivityAt = now;
		statusPayload.lastActivityAt = now;
		statusPayload.lastUpdate = now;
		maybeEmitActiveLongRunning(flatIndex, now);
		writeStatusPayload(false);
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
				currentTool: step.currentTool,
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

	const interruptRunner = () => {
		consumeInterruptRequest(asyncDir);
		if (interrupted || statusPayload.state !== "running") return;
		interrupted = true;
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
		statusPayload.state = "stopped";
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
		statusPayload.state = "failed";
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
		onStop: stopRunner,
		onCheckpointDecision: (decision) => {
			pendingCheckpointDecision = decision;
			wakeCheckpointDecision?.();
		},
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
		onSteerCapability: (capability) => {
			steeringCapabilities.set(capability.index, capability);
			if (!capability.supported) {
				const now = Date.now();
				const lifecycle = steeringStatus(statusPayload);
				for (const request of lifecycle.recent) {
					if (!request.targets.some((target) => target.index === capability.index && (target.state === "routed" || target.state === "scheduled"))) continue;
					markSteeringAttention(capability.index);
					updateSteeringLifecycleTarget(request.id, capability.index, "failed", now, { reason: "child Pi session does not support steering" });
					emitSteeringEvent("subagent.steer.failed", { type: "steer", id: request.id, ts: request.requestedAt, message: "child Pi session does not support steering" }, capability.index, { reason: "child Pi session does not support steering" });
					emitTerminalSteeringNotice(request.id, `Steering failed for run ${id}: child ${capability.index} does not support steering.`);
				}
				statusPayload.lastUpdate = now;
				writeStatusPayload();
			}
		},
		onSteerAck: consumeSteerAck,
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
	const waitForCheckpointDecision = async (): Promise<"approved" | "rejected" | undefined> => {
		while (!pendingCheckpointDecision && !interrupted && !timedOut && !stopped) {
			await new Promise<void>((resolve) => {
				wakeCheckpointDecision = resolve;
				const timer = setTimeout(resolve, POLL_INTERVAL_MS);
				timer.unref?.();
			});
			wakeCheckpointDecision = undefined;
		}
		const decision = pendingCheckpointDecision;
		pendingCheckpointDecision = undefined;
		return decision;
	};

	while (true) {
		if (interrupted || timedOut || stopped || turnBudgetExceeded) break;
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

		if (isCheckpointRunnerStep(step)) {
			const now = Date.now();
			const statusStep = statusPayload.steps[flatIndex];
			const checkpoint = { name: step.checkpoint, ...(step.message ? { message: step.message } : {}), status: "pending" as const, stepIndex };
			statusPayload.state = "paused";
			statusPayload.currentStep = flatIndex;
			statusPayload.checkpoint = checkpoint;
			delete statusPayload.activityState;
			statusPayload.lastUpdate = now;
			if (statusStep) {
				statusStep.status = "paused";
				statusStep.startedAt = now;
				statusStep.checkpoint = checkpoint;
			}
			writeStatusPayload();
			appendJsonl(eventsPath, JSON.stringify({ type: "subagent.checkpoint.paused", ts: now, runId: id, stepIndex, checkpoint }));
			const decision = await waitForCheckpointDecision();
			if (decision === "approved") {
				const approvedAt = Date.now();
				const approved = { ...checkpoint, status: "approved" as const, approvedAt };
				statusPayload.state = "running";
				statusPayload.checkpoint = approved;
				if (statusStep) {
					statusStep.status = "complete";
					statusStep.endedAt = approvedAt;
					statusStep.durationMs = approvedAt - now;
					statusStep.exitCode = 0;
					statusStep.checkpoint = approved;
				}
				statusPayload.lastUpdate = approvedAt;
				writeStatusPayload();
				appendJsonl(eventsPath, JSON.stringify({ type: "subagent.checkpoint.approved", ts: approvedAt, runId: id, stepIndex, checkpoint: approved }));
				flatIndex++;
				continue;
			}
			if (decision === "rejected") {
				const rejectedAt = Date.now();
				const rejected = { ...checkpoint, status: "rejected" as const, rejectedAt };
				checkpointRejected = true;
				statusPayload.state = "rejected";
				statusPayload.error = `Checkpoint '${step.checkpoint}' rejected.`;
				statusPayload.checkpoint = rejected;
				if (statusStep) {
					statusStep.status = "rejected";
					statusStep.error = statusPayload.error;
					statusStep.endedAt = rejectedAt;
					statusStep.durationMs = rejectedAt - now;
					statusStep.exitCode = 1;
					statusStep.checkpoint = rejected;
				}
				statusPayload.lastUpdate = rejectedAt;
				writeStatusPayload();
				appendJsonl(eventsPath, JSON.stringify({ type: "subagent.checkpoint.rejected", ts: rejectedAt, runId: id, stepIndex, checkpoint: rejected }));
				break;
			}
			break;
		}

		if (isDynamicRunnerGroup(step)) {
			const groupStartFlatIndex = flatIndex;
			let materialized: ReturnType<typeof materializeDynamicParallelStep>;
			try {
				materialized = materializeDynamicParallelStep(step as Parameters<typeof materializeDynamicParallelStep>[0], outputs, stepIndex, omitUndefinedProperties({ maxItems: config.dynamicFanoutMaxItems, allowRunnerFields: true }));
				if (materialized.parallel.length > 1 && step.parallel.outputPath && !step.parallel.namespaceOutputPath) {
					throw new DynamicFanoutError(`Dynamic chain step ${stepIndex + 1} materialized ${materialized.parallel.length} items that resolve output to the same path: ${step.parallel.outputPath}. Remove the explicit output path or use an inherited relative agent output so each item can be isolated.`);
				}
				if (materialized.collectedOnEmpty) await validateDynamicCollection(step.collect.outputSchema, materialized.collectedOnEmpty);
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
						reportOptional: isAgentContractV1(step.agentContract),
					}))
					: undefined;
				const groupStopped = stopped || stopAbortController.signal.aborted;
				const groupTimedOut = !groupStopped && (timedOut || timeoutAbortController.signal.aborted);
				const effectiveGroupAcceptance = groupTimedOut || groupStopped ? undefined : groupAcceptance;
				if (placeholder && effectiveGroupAcceptance) placeholder.acceptance = effectiveGroupAcceptance;
				const groupAcceptanceFailure = effectiveGroupAcceptance && (!isAgentContractV1(step.agentContract) || step.gateOn === "acceptance") ? acceptanceFailureMessage(effectiveGroupAcceptance) : undefined;
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
				return omitUndefinedProperties({
					...step.parallel,
					task: materializedTask,
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
					...(task.thinking ? { thinking: task.thinking } : {}),
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
					return omitUndefinedProperties({ agent: task.agent, context: task.context, output: message, error: message, exitCode: 1 as number | null, skipped: true });
				}
				if (timedOut) return timedOutStepResult(task.agent, task.context);
				if (stopped) return stoppedStepResult(task.agent, task.context);
				if (interrupted) return pausedStepResult(task.agent, task.context);
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
					return omitUndefinedProperties({ agent: task.agent, context: task.context, output: "(skipped — fail-fast)", exitCode: -1 as number | null, skipped: true });
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
					steerInboxDir: stepSteerInboxDir(asyncDir, fi),
					steerCapabilityPath: steerCapabilityPath(asyncDir, fi),
					steerAckDir: steerAcksDir(asyncDir, fi),
					piPackageRoot: config.piPackageRoot,
					piArgv1: config.piArgv1,
					childIntercomTarget: config.childIntercomTargets?.[fi],
					orchestratorIntercomTarget: config.controlIntercomTarget,
					nestedRoute: config.nestedRoute,
					capabilityCeiling: config.capabilityCeiling,
					registerInterrupt: (interrupt) => registerStepInterrupt(fi, interrupt),
					registerTimeout: (interrupt) => registerStepTimeout(fi, interrupt),
					registerStop: (stop) => registerStepStop(fi, stop),
					registerTurnBudgetAbort: (abort) => registerStepTurnBudgetAbort(fi, abort),
					timeoutSignal: timeoutAbortController.signal,
					stopSignal: stopAbortController.signal,
					timeoutMessage,
					stopMessage,
					turnBudget: config.turnBudget,
					onAttemptStart: (attempt) => updateStepModel(fi, attempt.model, attempt.thinking),
					onChildEvent: (event) => updateStepFromChildEvent(fi, event),
					onWriterProcess,
					onExternalProcess: (process) => updateExternalProcess(fi, process),
					skipAcceptance: () => timedOut || stopped,
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
				setOptionalProperty(requiredStatusStep(statusPayload, fi), "turnBudget", singleResult.turnBudget);
				setOptionalProperty(requiredStatusStep(statusPayload, fi), "turnBudgetExceeded", singleResult.turnBudgetExceeded);
				setOptionalProperty(requiredStatusStep(statusPayload, fi), "wrapUpRequested", singleResult.wrapUpRequested);
				setOptionalProperty(requiredStatusStep(statusPayload, fi), "toolBudget", singleResult.toolBudget);
				setOptionalProperty(requiredStatusStep(statusPayload, fi), "toolBudgetBlocked", singleResult.toolBudgetBlocked);
				if (singleResult.toolBudget) statusPayload.toolBudget = singleResult.toolBudget;
				if (singleResult.toolBudgetBlocked) statusPayload.toolBudgetBlocked = true;
				if (singleResult.turnBudget) statusPayload.turnBudget = singleResult.turnBudget;
				if (singleResult.turnBudgetExceeded) statusPayload.turnBudgetExceeded = true;
				if (singleResult.wrapUpRequested) statusPayload.wrapUpRequested = true;
				setOptionalProperty(requiredStatusStep(statusPayload, fi), "model", singleResult.model);
				setOptionalProperty(requiredStatusStep(statusPayload, fi), "thinking", resolveEffectiveThinking(singleResult.model, requiredStatusStep(statusPayload, fi).thinking));
				setOptionalProperty(requiredStatusStep(statusPayload, fi), "attemptedModels", singleResult.attemptedModels);
				setOptionalProperty(requiredStatusStep(statusPayload, fi), "modelAttempts", singleResult.modelAttempts);
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
				if (singleResult.exitCode !== 0 && failFast) aborted = true;
				return stopped || childStopped ? { ...singleResult, output: stopMessage, error: stopMessage, exitCode: 1, interrupted: false, timedOut: false, stopped: true, skipped: false } : timedOut ? { ...singleResult, output: timeoutMessage ?? "Subagent timed out.", error: timeoutMessage ?? "Subagent timed out.", exitCode: 1, interrupted: false, timedOut: true, skipped: false } : { ...singleResult, skipped: false };
			}, globalSemaphore);

			flatIndex += dynamicSteps.length;
			for (const pr of parallelResults) {
				results.push(omitUndefinedProperties({
					agent: pr.agent,
					context: pr.context,
					agentContract: pr.agentContract,
					launchContractDigest: pr.launchContractDigest,
					launchResolvedExtensions: pr.launchResolvedExtensions,
					runtimeAcknowledgedExtensions: pr.runtimeAcknowledgedExtensions,
					output: pr.output,
					outputState: pr.outputState,
					error: pr.error,
					protocolError: pr.protocolError,
					success: pr.stopped !== true && pr.interrupted !== true && pr.exitCode === 0,
					exitCode: pr.interrupted === true ? 0 : pr.exitCode,
					skipped: pr.skipped,
					interrupted: pr.interrupted,
					timedOut: pr.timedOut,
					stopped: pr.stopped,
					turnBudget: pr.turnBudget,
					turnBudgetExceeded: pr.turnBudgetExceeded,
					wrapUpRequested: pr.wrapUpRequested,
					toolBudget: pr.toolBudget,
					toolBudgetBlocked: pr.toolBudgetBlocked,
					sessionFile: pr.sessionFile,
					intercomTarget: pr.intercomTarget,
					model: pr.model,
					attemptedModels: pr.attemptedModels,
					modelAttempts: pr.modelAttempts,
					totalCost: pr.totalCost,
					artifactPaths: pr.artifactPaths,
					transcriptPath: pr.transcriptPath,
					transcriptError: pr.transcriptError,
					effects: pr.effects,
					execution: pr.execution,
					review: pr.review,
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
				.filter(({ result, task }) => isAgentContractV1(task?.agentContract ?? step.agentContract) && task?.gateOn === "acceptance" && result.acceptance?.status === "rejected");
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
							reportOptional: isAgentContractV1(step.agentContract),
						}))
						: undefined;
					const groupStopped = stopped || stopAbortController.signal.aborted;
					const groupTimedOut = !groupStopped && (timedOut || timeoutAbortController.signal.aborted);
					const effectiveGroupAcceptance = groupTimedOut || groupStopped ? undefined : groupAcceptance;
					const groupAcceptanceFailure = effectiveDynamicGroupAcceptance.explicit && effectiveGroupAcceptance && (!isAgentContractV1(step.agentContract) || step.gateOn === "acceptance") ? acceptanceFailureMessage(effectiveGroupAcceptance) : undefined;
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
					});
					flatIndex += group.parallel.length;
					break;
				}
				try {
					worktreeSetup = createWorktrees(cwd, `${id}-s${stepIndex}`, group.parallel.length, omitUndefinedProperties({
						agents: group.parallel.map((task) => task.agent),
						setupHook: config.worktreeSetupHook
							? omitUndefinedProperties({ hookPath: config.worktreeSetupHook, timeoutMs: config.worktreeSetupHookTimeoutMs })
							: undefined,
						baseDir: config.worktreeBaseDir,
					}));
				} catch (error) {
					const setupError = error instanceof Error ? error.message : String(error);
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
					});
					flatIndex += group.parallel.length;
					break;
				}
			}

			try {
				if (worktreeSetup) {
					writePendingParallelHandoff({
						manifestPath: parallelHandoffPath(asyncDir),
						runId: id,
						mode: (config.resultMode ?? statusPayload.mode) === "parallel" ? "parallel" : "chain",
						source: "async",
						cwd,
						stepIndex,
						flatStartIndex: groupStartFlatIndex,
						setup: worktreeSetup,
					});
				}
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
							return omitUndefinedProperties({ agent: task.agent, context: task.context, output: message, error: message, exitCode: 1 as number | null, skipped: true });
						}
						if (timedOut) return timedOutStepResult(task.agent, task.context);
						if (stopped) return stoppedStepResult(task.agent, task.context);
						if (interrupted) return pausedStepResult(task.agent, task.context);
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
							return omitUndefinedProperties({ agent: task.agent, context: task.context, output: "(skipped — fail-fast)", exitCode: -1 as number | null, skipped: true });
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
							steerInboxDir: stepSteerInboxDir(asyncDir, fi),
							steerCapabilityPath: steerCapabilityPath(asyncDir, fi),
							steerAckDir: steerAcksDir(asyncDir, fi),
							piPackageRoot: config.piPackageRoot,
							piArgv1: config.piArgv1,
							childIntercomTarget: config.childIntercomTargets?.[fi],
							orchestratorIntercomTarget: config.controlIntercomTarget,
							nestedRoute: config.nestedRoute,
							capabilityCeiling: config.capabilityCeiling,
							registerInterrupt: (interrupt) => registerStepInterrupt(fi, interrupt),
							registerTimeout: (interrupt) => registerStepTimeout(fi, interrupt),
							registerStop: (stop) => registerStepStop(fi, stop),
							registerTurnBudgetAbort: (abort) => registerStepTurnBudgetAbort(fi, abort),
							timeoutSignal: timeoutAbortController.signal,
							stopSignal: stopAbortController.signal,
							timeoutMessage,
							stopMessage,
							turnBudget: config.turnBudget,
							onAttemptStart: (attempt) => updateStepModel(fi, attempt.model, attempt.thinking),
							onChildEvent: (event) => updateStepFromChildEvent(fi, event),
							onWriterProcess,
							onExternalProcess: (process) => updateExternalProcess(fi, process),
							skipAcceptance: () => timedOut || stopped,
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
						setOptionalProperty(requiredStatusStep(statusPayload, fi), "turnBudget", singleResult.turnBudget);
						setOptionalProperty(requiredStatusStep(statusPayload, fi), "turnBudgetExceeded", singleResult.turnBudgetExceeded);
						setOptionalProperty(requiredStatusStep(statusPayload, fi), "wrapUpRequested", singleResult.wrapUpRequested);
						setOptionalProperty(requiredStatusStep(statusPayload, fi), "toolBudget", singleResult.toolBudget);
						setOptionalProperty(requiredStatusStep(statusPayload, fi), "toolBudgetBlocked", singleResult.toolBudgetBlocked);
						if (singleResult.toolBudget) statusPayload.toolBudget = singleResult.toolBudget;
						if (singleResult.toolBudgetBlocked) statusPayload.toolBudgetBlocked = true;
						if (singleResult.turnBudget) statusPayload.turnBudget = singleResult.turnBudget;
						if (singleResult.turnBudgetExceeded) statusPayload.turnBudgetExceeded = true;
						if (singleResult.wrapUpRequested) statusPayload.wrapUpRequested = true;
						setOptionalProperty(requiredStatusStep(statusPayload, fi), "model", singleResult.model);
						setOptionalProperty(requiredStatusStep(statusPayload, fi), "thinking", resolveEffectiveThinking(singleResult.model, requiredStatusStep(statusPayload, fi).thinking));
						setOptionalProperty(requiredStatusStep(statusPayload, fi), "attemptedModels", singleResult.attemptedModels);
						setOptionalProperty(requiredStatusStep(statusPayload, fi), "modelAttempts", singleResult.modelAttempts);
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

						if (singleResult.exitCode !== 0 && failFast) aborted = true;
						return stopped || childStopped ? { ...singleResult, output: stopMessage, error: stopMessage, exitCode: 1, interrupted: false, timedOut: false, stopped: true, skipped: false } : timedOut ? { ...singleResult, output: timeoutMessage ?? "Subagent timed out.", error: timeoutMessage ?? "Subagent timed out.", exitCode: 1, interrupted: false, timedOut: true, skipped: false } : { ...singleResult, skipped: false };
					},
					globalSemaphore,
				);

				flatIndex += group.parallel.length;

				for (let t = 0; t < group.parallel.length; t++) {
					const fi = groupStartFlatIndex + t;
					const sessionTokens = config.sessionDir
						? parseSessionTokens(path.join(config.sessionDir, `parallel-${t}`))
						: null;
					const taskTokens = sessionTokens ?? tokenUsageFromAttempts(parallelResults[t]?.modelAttempts);
					if (!taskTokens) continue;
					requiredStatusStep(statusPayload, fi).tokens = taskTokens;
					previousCumulativeTokens = {
						input: previousCumulativeTokens.input + taskTokens.input,
						output: previousCumulativeTokens.output + taskTokens.output,
						total: previousCumulativeTokens.total + taskTokens.total,
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
						protocolError: pr.protocolError,
						success: pr.stopped !== true && pr.interrupted !== true && pr.exitCode === 0,
						exitCode: pr.interrupted === true ? 0 : pr.exitCode,
						skipped: pr.skipped,
						interrupted: pr.interrupted,
						timedOut: pr.timedOut,
						stopped: pr.stopped,
						turnBudget: pr.turnBudget,
						turnBudgetExceeded: pr.turnBudgetExceeded,
						wrapUpRequested: pr.wrapUpRequested,
						toolBudget: pr.toolBudget,
						toolBudgetBlocked: pr.toolBudgetBlocked,
						sessionFile: pr.sessionFile,
						intercomTarget: pr.intercomTarget,
						model: pr.model,
						attemptedModels: pr.attemptedModels,
						modelAttempts: pr.modelAttempts,
						totalCost: pr.totalCost,
						artifactPaths: pr.artifactPaths,
						transcriptPath: pr.transcriptPath,
						transcriptError: pr.transcriptError,
						effects: pr.effects,
						execution: pr.execution,
						review: pr.review,
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
					const captured = captureParallelWorktreeDiffs(worktreeSetup, asyncDir, stepIndex, group);
					if (captured.summary) previousOutput = `${previousOutput}\n\n${captured.summary}`;
					worktreeFinalized = true;
					const manifestPath = parallelHandoffPath(asyncDir);
					const handoff = {
						manifestPath,
						runId: id,
						mode: (config.resultMode ?? statusPayload.mode) === "parallel" ? "parallel" as const : "chain" as const,
						source: "async" as const,
						cwd,
						stepIndex,
						flatStartIndex: groupStartFlatIndex,
						setup: worktreeSetup,
						diffs: captured.diffs,
						results: parallelResults.map((result) => ({
							agent: result.agent,
							status: result.stopped || (result.exitCode !== 0 && isUnexplainedProcessSignal(omitUndefinedProperties({
								processSignal: result.processSignal,
								interrupted: result.interrupted,
								timedOut: result.timedOut,
								stopped: result.stopped,
								turnBudgetExceeded: result.turnBudgetExceeded,
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
						const cleanup = cleanupWorktrees(worktreeSetup, { kind: "preserve", capturedDiffs: captured.diffs, handoffManifestPath: manifestPath });
						statusPayload.parallelHandoff = writeParallelHandoffGroup({ ...handoff, cleanup });
						previousOutput = `${previousOutput}\n\n${formatParallelHandoffReference(statusPayload.parallelHandoff)}`;
					} catch (error) {
						previousOutput = `${previousOutput}\n\n${formatParallelHandoffError(error)}`;
					}
					writeStatusPayload();
				}

				appendJsonl(eventsPath, JSON.stringify({
					type: "subagent.parallel.completed",
					ts: Date.now(),
					runId: id,
					stepIndex,
					success: parallelResults.every((r) => r.exitCode === 0 || r.exitCode === -1)
						&& parallelResults.every((result, index) => !(isAgentContractV1(group.parallel[index]?.agentContract) && group.parallel[index]?.gateOn === "acceptance" && result.acceptance?.status === "rejected")),
				}));

				const acceptanceGateFailure = parallelResults
					.map((result, index) => ({ result, index, task: group.parallel[index] }))
					.find(({ result, task }) => isAgentContractV1(task?.agentContract) && task?.gateOn === "acceptance" && result.acceptance?.status === "rejected");
				if (acceptanceGateFailure) {
					statusPayload.error = (acceptanceGateFailure.result.acceptance ? acceptanceFailureMessage(acceptanceGateFailure.result.acceptance) : undefined) ?? "Parallel acceptance gate rejected the step.";
					writeStatusPayload();
					break;
				}
				if (parallelResults.some((r) => r.exitCode !== 0 && r.exitCode !== -1)) {
					break;
				}
			} finally {
				if (worktreeSetup && !worktreeFinalized) cleanupWorktrees(worktreeSetup);
			}
		} else {
			const seqStep = step as SubagentStep;
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
			const singleResult = await runSingleStepWithTimeout(seqStep, compactOptional<SingleStepContext>({
				previousOutput, placeholder, cwd, sessionEnabled,
				outputs: statusPayload.mode === "single" ? undefined : outputs,
				sessionDir: config.sessionDir,
				artifactsDir, artifactConfig, id,
				flatIndex, flatStepCount: Math.max(statusPayload.steps.length, 1),
				outputFile: path.join(asyncDir, `output-${flatIndex}.log`),
				steerInboxDir: stepSteerInboxDir(asyncDir, flatIndex),
				steerCapabilityPath: steerCapabilityPath(asyncDir, flatIndex),
				steerAckDir: steerAcksDir(asyncDir, flatIndex),
				piPackageRoot: config.piPackageRoot,
				piArgv1: config.piArgv1,
				childIntercomTarget: config.childIntercomTargets?.[flatIndex],
				orchestratorIntercomTarget: config.controlIntercomTarget,
				nestedRoute: config.nestedRoute,
				capabilityCeiling: config.capabilityCeiling,
				registerInterrupt: (interrupt) => registerStepInterrupt(flatIndex, interrupt),
				registerTimeout: (interrupt) => registerStepTimeout(flatIndex, interrupt),
				registerStop: (stop) => registerStepStop(flatIndex, stop),
				registerTurnBudgetAbort: (abort) => registerStepTurnBudgetAbort(flatIndex, abort),
				timeoutSignal: timeoutAbortController.signal,
				stopSignal: stopAbortController.signal,
				timeoutMessage,
				stopMessage,
				turnBudget: config.turnBudget,
				onAttemptStart: (attempt) => updateStepModel(flatIndex, attempt.model, attempt.thinking),
				onChildEvent: (event) => updateStepFromChildEvent(flatIndex, event),
				onWriterProcess,
				onExternalProcess: (process) => updateExternalProcess(flatIndex, process),
				skipAcceptance: () => timedOut || stopped,
			}), config.deadlineAt);
			if (seqStep.sessionFile) {
				latestSessionFile = seqStep.sessionFile;
			}

			previousOutput = singleResult.output;
			const childStopped = singleResult.stopped === true;
			results.push(omitUndefinedProperties({
				agent: singleResult.agent,
				context: singleResult.context,
				agentContract: singleResult.agentContract,
				launchContractDigest: singleResult.launchContractDigest,
				launchResolvedExtensions: singleResult.launchResolvedExtensions,
				runtimeAcknowledgedExtensions: singleResult.runtimeAcknowledgedExtensions,
				output: stopped || childStopped ? stopMessage : timedOut ? (timeoutMessage ?? "Subagent timed out.") : singleResult.output,
				outputState: singleResult.outputState,
				error: stopped || childStopped ? stopMessage : timedOut ? (timeoutMessage ?? "Subagent timed out.") : singleResult.error,
				protocolError: singleResult.protocolError,
				success: !stopped && !childStopped && !timedOut && singleResult.interrupted !== true && singleResult.exitCode === 0,
				exitCode: stopped || childStopped ? 1 : timedOut ? 1 : singleResult.interrupted === true ? 0 : singleResult.exitCode,
				sessionFile: singleResult.sessionFile,
				intercomTarget: singleResult.intercomTarget,
				model: singleResult.model,
				attemptedModels: singleResult.attemptedModels,
				modelAttempts: singleResult.modelAttempts,
				totalCost: singleResult.totalCost,
				artifactPaths: singleResult.artifactPaths,
				transcriptPath: singleResult.transcriptPath,
				transcriptError: singleResult.transcriptError,
				effects: singleResult.effects,
				execution: singleResult.execution,
				review: singleResult.review,
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
				turnBudget: singleResult.turnBudget,
				turnBudgetExceeded: singleResult.turnBudgetExceeded,
				wrapUpRequested: singleResult.wrapUpRequested,
				toolBudget: singleResult.toolBudget,
				toolBudgetBlocked: singleResult.toolBudgetBlocked,
				runner: singleResult.runner,
				externalProcess: singleResult.externalProcess,
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
					}
				: null;
			if (cumulativeTokens) {
				previousCumulativeTokens = cumulativeTokens;
			} else {
				stepTokens = tokenUsageFromAttempts(singleResult.modelAttempts);
				if (stepTokens) {
					previousCumulativeTokens = {
						input: previousCumulativeTokens.input + stepTokens.input,
						output: previousCumulativeTokens.output + stepTokens.output,
						total: previousCumulativeTokens.total + stepTokens.total,
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
			setOptionalProperty(requiredStatusStep(statusPayload, flatIndex), "turnBudget", singleResult.turnBudget);
			setOptionalProperty(requiredStatusStep(statusPayload, flatIndex), "turnBudgetExceeded", singleResult.turnBudgetExceeded);
			setOptionalProperty(requiredStatusStep(statusPayload, flatIndex), "wrapUpRequested", singleResult.wrapUpRequested);
			setOptionalProperty(requiredStatusStep(statusPayload, flatIndex), "toolBudget", singleResult.toolBudget);
			setOptionalProperty(requiredStatusStep(statusPayload, flatIndex), "toolBudgetBlocked", singleResult.toolBudgetBlocked);
			if (singleResult.toolBudget) statusPayload.toolBudget = singleResult.toolBudget;
			if (singleResult.toolBudgetBlocked) statusPayload.toolBudgetBlocked = true;
			if (singleResult.turnBudget) statusPayload.turnBudget = singleResult.turnBudget;
			if (singleResult.turnBudgetExceeded) statusPayload.turnBudgetExceeded = true;
			if (singleResult.wrapUpRequested) statusPayload.wrapUpRequested = true;
			setOptionalProperty(requiredStatusStep(statusPayload, flatIndex), "model", singleResult.model);
			setOptionalProperty(requiredStatusStep(statusPayload, flatIndex), "thinking", resolveEffectiveThinking(singleResult.model, requiredStatusStep(statusPayload, flatIndex).thinking));
			setOptionalProperty(requiredStatusStep(statusPayload, flatIndex), "attemptedModels", singleResult.attemptedModels);
			setOptionalProperty(requiredStatusStep(statusPayload, flatIndex), "modelAttempts", singleResult.modelAttempts);
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
			if (isAgentContractV1(seqStep.agentContract) && seqStep.gateOn === "acceptance" && singleResult.acceptance?.status === "rejected") {
				statusPayload.error = acceptanceFailureMessage(singleResult.acceptance) ?? "Chain acceptance gate rejected the step.";
				writeStatusPayload();
				break;
			}
			if (singleResult.exitCode !== 0) {
				break;
			}
		}
	}

	let summary = results.map((r) => `${r.agent}:\n${r.output}`).join("\n\n");
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
	const signalTerminated = !stopped && !timedOut && !turnBudgetExceeded && !interrupted && results.some((result) => result.exitCode !== 0 && isUnexplainedProcessSignal(omitUndefinedProperties({
		processSignal: result.processSignal,
		interrupted: result.interrupted,
		timedOut: result.timedOut,
		stopped: result.stopped,
		turnBudgetExceeded: result.turnBudgetExceeded,
	})));
	statusPayload.state = checkpointRejected ? "rejected" : stopped || signalTerminated ? "stopped" : timedOut || turnBudgetExceeded || usageBudgetExceeded || statusPayload.error ? "failed" : interrupted ? "paused" : results.every((r) => r.success) ? "complete" : "failed";
	closeSteerInbox(asyncDir, statusPayload.state);
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
	if (turnBudgetExceeded && !statusPayload.error) {
		const budget = statusPayload.turnBudget;
		statusPayload.error = budget ? turnBudgetExceededMessage(budget, budget.turnCount) : "Subagent exceeded turn budget.";
	}
	if (usageBudgetExceeded && statusPayload.usageBudget && !statusPayload.error) {
		statusPayload.error = usageBudgetExceededMessage(statusPayload.usageBudget);
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
	if (statusPayload.state === "failed" && !statusPayload.error) {
		const failedStep = statusPayload.steps.find((s) => s.status === "failed");
		if (failedStep?.agent) {
			statusPayload.error = `Step failed: ${failedStep.agent}`;
		}
	}
	writeStatusPayload();
	try {
		writeAtomicJson(resultPath, {
			lifecycleArtifactVersion: SUBAGENT_LIFECYCLE_ARTIFACT_VERSION,
			id,
			agent: agentName,
			mode: resultMode,
			success: !checkpointRejected && !stopped && !timedOut && !turnBudgetExceeded && !usageBudgetExceeded && !interrupted && !signalTerminated && results.every((r) => r.success),
			state: checkpointRejected ? "rejected" : stopped || signalTerminated ? "stopped" : timedOut || turnBudgetExceeded || usageBudgetExceeded ? "failed" : interrupted ? "paused" : results.every((r) => r.success) ? "complete" : "failed",
			summary: checkpointRejected ? (statusPayload.error ?? "Checkpoint rejected.") : stopped ? stopMessage : signalTerminated ? (statusPayload.error ?? "Subagent process terminated by signal.") : timedOut ? (timeoutMessage ?? "Subagent timed out.") : turnBudgetExceeded ? (statusPayload.error ?? "Subagent exceeded turn budget.") : usageBudgetExceeded ? (statusPayload.error ?? "Usage budget exhausted.") : interrupted ? "Paused after interrupt. Waiting for explicit next action." : summary,
			...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
			...(config.deadlineAt !== undefined ? { deadlineAt: config.deadlineAt } : {}),
			...(statusPayload.turnBudget ? { turnBudget: statusPayload.turnBudget } : {}),
			...(statusPayload.turnBudgetExceeded ? { turnBudgetExceeded: true } : {}),
			...(statusPayload.wrapUpRequested ? { wrapUpRequested: true } : {}),
			...(statusPayload.toolBudget ? { toolBudget: statusPayload.toolBudget } : {}),
			...(statusPayload.toolBudgetBlocked ? { toolBudgetBlocked: true } : {}),
			...(statusPayload.usageBudget ? { usageBudget: statusPayload.usageBudget } : {}),
			...(statusPayload.checkpoint ? { checkpoint: statusPayload.checkpoint } : {}),
			...(stopped ? { stopped: true, error: stopMessage } : timedOut ? { timedOut: true, error: timeoutMessage ?? "Subagent timed out." } : turnBudgetExceeded ? { error: statusPayload.error ?? "Subagent exceeded turn budget." } : usageBudgetExceeded ? { error: statusPayload.error ?? "Usage budget exhausted." } : {}),
			results: results.map((r) => omitUndefinedProperties({
				agent: r.agent,
				context: r.context,
				output: r.output,
				outputState: r.outputState,
				error: r.error,
				protocolError: r.protocolError,
				success: r.success,
				skipped: r.skipped || undefined,
				interrupted: r.interrupted || undefined,
				timedOut: r.timedOut || undefined,
				stopped: r.stopped || undefined,
				processSignal: r.processSignal || undefined,
				turnBudget: r.turnBudget,
				turnBudgetExceeded: r.turnBudgetExceeded || undefined,
				wrapUpRequested: r.wrapUpRequested || undefined,
				toolBudget: r.toolBudget,
				toolBudgetBlocked: r.toolBudgetBlocked || undefined,
				sessionFile: r.sessionFile,
				intercomTarget: r.intercomTarget,
				model: r.model,
				attemptedModels: r.attemptedModels,
				modelAttempts: r.modelAttempts,
				totalCost: r.totalCost,
				artifactPaths: r.artifactPaths,
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
				execution: r.execution,
				review: r.review,
				effects: r.effects,
				structuredOutput: r.structuredOutput,
				structuredOutputPath: r.structuredOutputPath,
				structuredOutputSchemaPath: r.structuredOutputSchemaPath,
				acceptance: r.acceptance,
				watchdog: r.watchdog,
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
			exitCode: checkpointRejected || stopped || timedOut || turnBudgetExceeded || usageBudgetExceeded ? 1 : interrupted || results.every((r) => r.success) ? 0 : 1,
			timestamp: runEndedAt,
			durationMs: runEndedAt - overallStartTime,
			totalTokens: statusPayload.totalTokens,
			totalCost: finalTotalCost,
			usageBudget: statusPayload.usageBudget,
			checkpoint: statusPayload.checkpoint,
			truncated,
			artifactsDir,
			cwd,
			asyncDir,
			launchContractDigest: config.launchContractDigest,
			launchResolvedExtensions: config.launchResolvedExtensions,
			runtimeAcknowledgedExtensions: singleRuntimeAcknowledgedExtensions,
			sessionId: config.sessionId,
			sessionFile: effectiveSessionFile,
			intercomTarget: config.controlIntercomTarget,
			shareUrl,
			gistUrl,
			shareError,
			...(taskIndex !== undefined && { taskIndex }),
			...(totalTasks !== undefined && { totalTasks }),
		});
	} catch (err) {
		console.error(`Failed to write result file ${resultPath}:`, err);
	}
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
	}));
	if (config.runnerProcessInstanceId) {
		const writers: Record<string, Array<{ processInstanceId: string; kind: "pi-writer"; attempt: number; closeObservedAt: number; exitCode: number | null; signal: string | null }>> = {};
		const expectedWriters: Record<string, number> = {};
		for (const [index, result] of results.entries()) {
			writers[String(index)] = result.writerProcesses ?? [];
			expectedWriters[String(index)] = result.writerAttemptCount ?? 0;
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
			if (payload.token !== token) throw new Error("Runner startup control token does not match the acquired session lease.");
			if (payload.action === action) return;
			if (payload.action !== "ack" && payload.action !== "proceed") throw new Error("Runner startup control action is invalid.");
		}
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error(`Timed out after ${timeoutMs}ms waiting for runner startup control '${action}'.`);
}

async function runConfiguredSubagent(config: SubagentRunConfig): Promise<void> {
	let lease: ReturnType<typeof acquireSessionLease> | undefined;
	let startupCommitted = config.revivalLease === undefined;
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
		if (config.revivalLease) {
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
		await runSubagent(config, lease ? (writer) => lease!.updateWriter(writer) : undefined);
	} catch (error) {
		if (config.revivalLease && !startupCommitted) {
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
	runConfiguredSubagent(config).catch((runErr) => {
		console.error("Subagent runner error:", runErr);
		process.exit(1);
	});
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
