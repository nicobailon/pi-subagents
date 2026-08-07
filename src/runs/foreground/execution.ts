/**
 * Core execution logic for running subagents
 */

import { spawn } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";
import * as path from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import type { AgentConfig } from "../../agents/agents.ts";
import { appendAgentRefinementOverlay } from "../../agents/agent-refinements.ts";
import {
	ensureArtifactsDir,
	formatOutputArtifactContent,
	getArtifactPaths,
	writeArtifact,
	writeMetadata,
} from "../../shared/artifacts.ts";
import { createChildTranscriptWriter, type ChildTranscriptWriter } from "../../shared/child-transcript.ts";
import {
	type AgentProgress,
	type ArtifactPaths,
	type ControlEvent,
	type ModelAttempt,
	type RunSyncOptions,
	type SingleResult,
	type Usage,
	DEFAULT_MAX_OUTPUT,
	INTERCOM_DETACH_REQUEST_EVENT,
	INTERCOM_DETACH_RESPONSE_EVENT,
	type AcceptanceLedger,
	type ResolvedAcceptanceConfig,
	truncateOutput,
	getSubagentDepthEnv,
} from "../../shared/types.ts";
import {
	DEFAULT_CONTROL_CONFIG,
	buildControlEvent,
	claimControlNotification,
	deriveActivityState,
	shouldNotifyControlEvent,
} from "../shared/subagent-control.ts";
import {
	getFinalOutput,
	findLatestSessionFile,
	detectSubagentError,
	hasEmptyTerminalAssistantResponse,
	extractToolArgsPreview,
	extractTextFromContent,
	boundStreamedRecentTools,
	boundStreamedRecentOutput,
	boundStreamedToolCalls,
} from "../../shared/utils.ts";
import { buildSkillInjection, resolveSkillsWithFallback } from "../../agents/skills.ts";
import { buildAgentMemoryInjection } from "../../agents/agent-memory.ts";
import { evaluateCompletionMutationGuard } from "../shared/completion-guard.ts";
import { getPiSpawnCommand } from "../shared/pi-spawn.ts";
import { createJsonlWriter } from "../../shared/jsonl-writer.ts";
import { attachPostExitStdioGuard, trySignalChild } from "../../shared/post-exit-stdio-guard.ts";
import { resolvePermissionRules } from "../shared/permissions.ts";
import { applyThinkingSuffix, buildPiArgs, cleanupTempDir, projectLaunchResolvedChildExtensions, resolvePiLaunchToolPlan } from "../shared/pi-args.ts";
import { readRuntimeAcknowledgedExtensions } from "../shared/runtime-acknowledged-extensions.ts";
import { assertAgentAllowedByCapabilityCeiling, decodeSubagentCapabilityCeiling, intersectSubagentCapabilityCeilings, resolveCurrentSubagentCapabilityCeiling, SUBAGENT_CAPABILITY_CEILING_ENV } from "../shared/capability-ceiling.ts";
import { resolveEffectiveThinking } from "../../shared/model-info.ts";
import { MISSING_STRUCTURED_OUTPUT_CALL_ERROR, readStructuredOutput } from "../shared/structured-output.ts";
import { formatProcessSignalError, isUnexplainedProcessSignal } from "../shared/process-signal.ts";
import { readChildToolDiagnosticError } from "../shared/tool-availability.ts";
import { captureSingleOutputSnapshot, extractChildWrittenOutput, formatSavedOutputReference, injectOutputPathSystemPrompt, resolveSingleOutput, validateFileOnlyOutputMode, type SingleOutputSnapshot } from "../shared/single-output.ts";
import {
	buildModelCandidates,
	formatModelAttemptNote,
	isRetryableModelFailure,
} from "../shared/model-fallback.ts";
import {
	SUBAGENT_STARTUP_RETRY_DELAYS_MS,
	formatSubagentStartupRetryExhaustedError,
	formatSubagentStartupRetryNote,
	isRetryableSubagentStartupFailure,
	waitForSubagentStartupRetry,
} from "../shared/subagent-startup-retry.ts";
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
import { acceptanceFailureMessage, buildSkippedAcceptanceLedger, evaluateAcceptance, formatAcceptancePrompt, resolveEffectiveAcceptance, stripAcceptanceReport, validateAcceptanceInput } from "../shared/acceptance.ts";
import { attachContractProjections, isAgentContractV1 } from "../shared/agent-contract.ts";
import { appendTurnBudgetSystemPrompt, formatTurnBudgetOutput, initialTurnBudgetState, turnBudgetDecision, turnBudgetDeferredNote, turnBudgetDeferredState, turnBudgetExceededMessage, turnBudgetSoftNote, turnBudgetState } from "../shared/turn-budget.ts";
import { initialToolBudgetState, toolBudgetState } from "../shared/tool-budget.ts";
import { resolveWatchdogConfig } from "../../watchdog/settings.ts";
import { agentDefinitionDigest, launchBindingDigest } from "../../shared/launch-contract.ts";
import { createBoundedByteTail, createBoundedLineReader, formatProtocolOutputLimit, MAX_CHILD_STDERR_BYTES, PI_AGGREGATE_EVENT_PROJECTOR, projectChildLifecycle, type ChildLifecycleAction, type ProtocolOutputLimit } from "../shared/child-protocol.ts";
import {
	acceptChildWatchdogEvent,
	childWatchdogIsActive,
	isChildWatchdogStatusEvent,
	resolveChildWatchdogConfig,
	type ChildWatchdogStateSnapshot,
} from "../../watchdog/child-status.ts";

const artifactOutputByResult = new WeakMap<SingleResult, string>();
const acceptanceOutputByResult = new WeakMap<SingleResult, string>();

function emptyUsage(): Usage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
}

function withRunContext<T extends SingleResult>(result: T, context: RunSyncOptions["context"]): T {
	if (!context) return result;
	result.context = context;
	return result;
}

function sumUsage(target: Usage, source: Usage): void {
	target.input += source.input;
	target.output += source.output;
	target.cacheRead += source.cacheRead;
	target.cacheWrite += source.cacheWrite;
	target.cost += source.cost;
	target.turns += source.turns;
}

function persistSingleResultMetadata(input: {
	metadataPath?: string;
	enabled: boolean;
	runId?: string;
	agent: string;
	task: string;
	result: SingleResult;
}): void {
	if (!input.enabled || !input.metadataPath) return;
	const target = input.result;
	writeMetadata(input.metadataPath, {
		runId: input.runId,
		agent: input.agent,
		task: input.task,
		exitCode: target.exitCode,
		processSignal: target.processSignal,
		usage: target.usage,
		model: target.model,
		attemptedModels: target.attemptedModels,
		modelAttempts: target.modelAttempts,
		durationMs: target.progressSummary?.durationMs,
		toolCount: target.progressSummary?.toolCount,
		error: target.error,
		agentContract: target.agentContract,
		launchContractDigest: target.launchContractDigest,
		launchResolvedExtensions: target.launchResolvedExtensions,
		runtimeAcknowledgedExtensions: target.runtimeAcknowledgedExtensions,
		execution: target.execution,
		acceptance: target.acceptance,
		capabilityCeiling: target.capabilityCeiling,
		capabilityAudit: target.capabilityAudit,
		review: target.review,
		effects: target.effects,
		transcriptPath: target.transcriptPath,
		transcriptError: target.transcriptError,
		skills: target.skills,
		skillsWarning: target.skillsWarning,
		timestamp: Date.now(),
	});
}

function formatTimeoutMessage(timeoutMs: number): string {
	return `Subagent timed out after ${timeoutMs}ms.`;
}

function resolveAttemptTimeout(options: RunSyncOptions): { timeoutMs: number; remainingMs: number; message: string } | undefined {
	if (options.timeoutMs === undefined) return undefined;
	const deadlineAt = options.deadlineAt ?? Date.now() + options.timeoutMs;
	return {
		timeoutMs: options.timeoutMs,
		remainingMs: Math.max(0, deadlineAt - Date.now()),
		message: formatTimeoutMessage(options.timeoutMs),
	};
}

function buildPendingAcceptanceLedger(acceptance: ResolvedAcceptanceConfig): AcceptanceLedger {
	return {
		status: "pending",
		evidenceStatus: "pending",
		explicit: acceptance.explicit,
		effectiveAcceptance: acceptance,
		inferredReason: acceptance.inferredReason,
		criteria: acceptance.criteria,
		runtimeChecks: [],
		verifyRuns: [],
	};
}

function buildInterruptedAcceptanceLedger(acceptance: ResolvedAcceptanceConfig): AcceptanceLedger {
	const pending = buildPendingAcceptanceLedger(acceptance);
	if (acceptance.level === "none") {
		pending.status = "not-required";
		pending.evidenceStatus = "not-required";
	} else {
		pending.runtimeChecks = [{
			id: "interrupted",
			status: "not-applicable",
			message: "Acceptance was not evaluated because the subagent was interrupted.",
		}];
	}
	return pending;
}

function appendRecentOutput(progress: AgentProgress, lines: string[]): void {
	if (lines.length === 0) return;
	progress.recentOutput.push(...lines.filter((line) => line.trim()));
	if (progress.recentOutput.length > 50) {
		progress.recentOutput.splice(0, progress.recentOutput.length - 50);
	}
}

function stripAcceptanceReportsFromMessages(messages: Message[] | undefined): void {
	for (const message of messages ?? []) {
		if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (const part of message.content) {
			if (part.type === "text" && "text" in part && typeof part.text === "string") {
				part.text = stripAcceptanceReport(part.text);
			}
		}
	}
}

function snapshotProgress(progress: AgentProgress): AgentProgress {
	return {
		...progress,
		skills: progress.skills ? [...progress.skills] : undefined,
		recentTools: boundStreamedRecentTools(progress.recentTools),
		recentOutput: boundStreamedRecentOutput(progress.recentOutput),
	};
}

function snapshotResult(result: SingleResult, progress: AgentProgress): SingleResult {
	return {
		...result,
		messages: result.outputMode === "file-only" && result.savedOutputPath ? undefined : result.messages ? [...result.messages] : undefined,
		usage: { ...result.usage },
		skills: result.skills ? [...result.skills] : undefined,
		attemptedModels: result.attemptedModels ? [...result.attemptedModels] : undefined,
		modelAttempts: result.modelAttempts
			? result.modelAttempts.map((attempt) => ({
				...attempt,
				usage: attempt.usage ? { ...attempt.usage } : undefined,
			}))
			: undefined,
		controlEvents: result.controlEvents ? result.controlEvents.map((event) => ({ ...event })) : undefined,
		progress,
		progressSummary: result.progressSummary ? { ...result.progressSummary } : undefined,
		artifactPaths: result.artifactPaths ? { ...result.artifactPaths } : undefined,
		truncation: result.truncation ? { ...result.truncation } : undefined,
		outputReference: result.outputReference ? { ...result.outputReference } : undefined,
	};
}

/**
 * Streaming variant of snapshotResult for `onUpdate` progress events: it drops the
 * unbounded `messages` transcript in favour of compact tool-call summaries so a
 * single `tool_execution_update` line stays well under the child-stdout protocol
 * cap (`MAX_CHILD_PENDING_LINE_BYTES`). Non-streaming consumers such as
 * foreground detach receipts and terminal consumers use snapshotResult directly.
 */
function snapshotStreamResult(result: SingleResult, progress: AgentProgress): SingleResult {
	const snapshot = snapshotResult(result, progress);
	snapshot.messages = undefined;
	snapshot.toolCalls = boundStreamedToolCalls(result);
	return snapshot;
}

async function runSingleAttempt(
	runtimeCwd: string,
	agent: AgentConfig,
	task: string,
	model: string | undefined,
	options: RunSyncOptions,
	shared: {
		sessionEnabled: boolean;
		systemPrompt: string;
		resolvedSkillNames?: string[];
		modelCandidates?: string[];
		skillsWarning?: string;
		jsonlPath?: string;
		artifactPaths?: ArtifactPaths;
		transcriptWriter?: ChildTranscriptWriter;
		attemptNotes: string[];
		outputSnapshot?: SingleOutputSnapshot;
		originalTask?: string;
	},
): Promise<SingleResult> {
	const effectiveThinking = options.thinkingOverride ?? agent.thinking;
	const modelArg = applyThinkingSuffix(model, effectiveThinking, options.thinkingOverride !== undefined);
	const resolvedThinking = resolveEffectiveThinking(modelArg, effectiveThinking);
	const watchdogConfig = resolveWatchdogConfig(options.cwd ?? runtimeCwd);
	const childWatchdog = watchdogConfig.ok
		? resolveChildWatchdogConfig({
			config: watchdogConfig.config,
			agent: agent.name,
			runId: options.runId,
			childIndex: options.index ?? 0,
		})
		: undefined;
	const permissionRules = resolvePermissionRules(options.permissions, agent.permissions);
	const permissionAuditPath = permissionRules && options.artifactsDir
		? path.join(options.artifactsDir, "permission-audit", `${options.runId}-${options.index ?? 0}.jsonl`)
		: undefined;
	const { args, env: sharedEnv, tempDir, toolDiagnosticPath, runtimeAcknowledgedExtensionsPath, capabilityAudit } = buildPiArgs({
		baseArgs: ["--mode", "json", "-p"],
		task,
		sessionEnabled: shared.sessionEnabled,
		sessionDir: options.sessionDir,
		sessionFile: options.sessionFile,
		model: modelArg,
		thinking: effectiveThinking,
		systemPromptMode: agent.systemPromptMode,
		inheritProjectContext: agent.inheritProjectContext,
		inheritSkills: agent.inheritSkills,
		requireReadTool: Boolean(shared.resolvedSkillNames?.length),
		tools: agent.tools,
		extensions: agent.extensions,
		subagentOnlyExtensions: agent.subagentOnlyExtensions,
		systemPrompt: appendTurnBudgetSystemPrompt(shared.systemPrompt, options.turnBudget),
		mcpDirectTools: agent.mcpDirectTools,
		cwd: options.cwd ?? runtimeCwd,
		promptFileStem: agent.name,
		intercomSessionName: options.intercomSessionName,
		orchestratorIntercomTarget: options.orchestratorIntercomTarget,
		runId: options.runId,
		childAgentName: agent.name,
		childIndex: options.index ?? 0,
		parentEventSink: options.nestedRoute?.eventSink,
		parentControlInbox: options.nestedRoute?.controlInbox,
		parentRootRunId: options.nestedRoute?.rootRunId,
		parentCapabilityToken: options.nestedRoute?.capabilityToken,
		parentSessionId: options.parentSessionId,
		structuredOutput: options.structuredOutput,
		toolBudget: options.toolBudget,
		allowZeroToolBudget: options.allowZeroToolBudget,
		permissionRules,
		permissionAuditPath,
		childWatchdog,
		waitToolEnabled: options.waitToolEnabled,
		capabilityCeiling: options.capabilityCeiling,
	});

	const effectiveSystemPrompt = appendTurnBudgetSystemPrompt(shared.systemPrompt, options.turnBudget);
	const toolPlan = resolvePiLaunchToolPlan({
		tools: agent.tools,
		extensions: agent.extensions,
		subagentOnlyExtensions: agent.subagentOnlyExtensions,
		mcpDirectTools: agent.mcpDirectTools,
		cwd: options.cwd ?? runtimeCwd,
		requireReadTool: Boolean(shared.resolvedSkillNames?.length),
		structuredOutput: Boolean(options.structuredOutput),
		capabilityCeiling: options.capabilityCeiling,
		inheritedCapabilityCeiling: decodeSubagentCapabilityCeiling(process.env[SUBAGENT_CAPABILITY_CEILING_ENV]),
		agentName: agent.name,
	});
	const launchResolvedExtensions = projectLaunchResolvedChildExtensions(toolPlan);
	const launchContractDigest = launchBindingDigest({
		definitionDigest: agentDefinitionDigest(agent),
		task: shared.originalTask ?? task,
		...(modelArg ? { model: modelArg } : {}),
		modelCandidates: shared.modelCandidates,
		...(resolvedThinking ? { thinking: resolvedThinking } : {}),
		systemPrompt: effectiveSystemPrompt,
		systemPromptMode: agent.systemPromptMode,
		inheritProjectContext: agent.inheritProjectContext,
		inheritSkills: agent.inheritSkills,
		skills: shared.resolvedSkillNames ?? [],
		tools: toolPlan.effectiveToolAllowlist,
		extensions: toolPlan.extensionArgs,
		mcpDirectTools: toolPlan.effectiveMcpTools,
		...(options.outputPath ? { outputPath: options.outputPath } : {}),
		outputMode: options.outputMode ?? "inline",
		...(options.structuredOutput ? { structuredOutputSchema: options.structuredOutput.schema } : {}),
	});
	const result: SingleResult = withRunContext({
		index: options.index ?? 0,
		agent: agent.name,
		task: shared.originalTask ?? task,
		...(options.agentContract ? { agentContract: options.agentContract } : {}),
		launchContractDigest,
		launchResolvedExtensions,
		exitCode: 0,
		outputState: "absent",
		messages: [],
		usage: emptyUsage(),
		model: modelArg,
		...(resolvedThinking ? { thinking: resolvedThinking } : {}),
		artifactPaths: shared.artifactPaths,
		transcriptPath: shared.transcriptWriter ? shared.artifactPaths?.transcriptPath : undefined,
		skills: shared.resolvedSkillNames,
		skillsWarning: shared.skillsWarning,
		...(options.turnBudget ? { turnBudget: initialTurnBudgetState(options.turnBudget) } : {}),
		...(options.toolBudget ? { toolBudget: initialToolBudgetState(options.toolBudget) } : {}),
		...(options.capabilityCeiling ? { capabilityCeiling: options.capabilityCeiling } : {}),
		...(capabilityAudit ? { capabilityAudit } : {}),
	}, options.context);
	const startTime = Date.now();
	if (options.structuredOutput) {
		try {
			if (existsSync(options.structuredOutput.outputPath)) unlinkSync(options.structuredOutput.outputPath);
		} catch {
			// Missing/stale structured-output files are handled after the child exits.
		}
	}
	const controlConfig = options.controlConfig ?? DEFAULT_CONTROL_CONFIG;
	let interruptedByControl = false;
	const allControlEvents: ControlEvent[] = [];
	let pendingControlEvents: ControlEvent[] = [];
	const emittedControlEventKeys = new Set<string>();
	const emitControlEvent = (event: ControlEvent) => {
		if (!shouldNotifyControlEvent(controlConfig, event)) return;
		if (!claimControlNotification(controlConfig, event, emittedControlEventKeys)) return;
		allControlEvents.push(event);
		pendingControlEvents.push(event);
		options.onControlEvent?.(event);
	};

	const progress: AgentProgress = {
		index: options.index ?? 0,
		agent: agent.name,
		status: "running",
		task,
		skills: shared.resolvedSkillNames,
		recentTools: [],
		recentOutput: [...shared.attemptNotes],
		toolCount: 0,
		tokens: 0,
		...(modelArg ? { model: modelArg } : {}),
		...(resolvedThinking ? { thinking: resolvedThinking } : {}),
		inputTokens: 0,
		outputTokens: 0,
		durationMs: 0,
		lastActivityAt: startTime,
	};
	result.progress = progress;
	const attemptTimeout = resolveAttemptTimeout(options);
	if (attemptTimeout?.remainingMs === 0) {
		cleanupTempDir(tempDir);
		result.exitCode = 1;
		result.timedOut = true;
		result.error = attemptTimeout.message;
		result.finalOutput = attemptTimeout.message;
		progress.status = "failed";
		progress.error = attemptTimeout.message;
		result.progressSummary = {
			toolCount: progress.toolCount,
			tokens: progress.tokens,
			durationMs: progress.durationMs,
		};
		return result;
	}
	const spawnEnv = { ...process.env, ...sharedEnv, ...getSubagentDepthEnv(options.maxSubagentDepth) };
	let observedMutationAttempt = false;
	let structuredOutputToolInvoked = false;
	let structuredOutputMessageStartIndex: number | undefined;

	const exitCode = await new Promise<number>((resolve) => {
		const spawnSpec = getPiSpawnCommand(args);
		const proc = spawn(spawnSpec.command, spawnSpec.args, {
			cwd: options.cwd ?? runtimeCwd,
			env: spawnEnv,
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		const jsonlWriter = createJsonlWriter(shared.jsonlPath, proc.stdout);
		let processClosed = false;
		let lifecycleFinished = false;
		let detached = false;
		let intercomStarted = false;
		let assistantError: string | undefined;
		let removeAbortListener: (() => void) | undefined;
		let removeInterruptListener: (() => void) | undefined;
		let activityTimer: NodeJS.Timeout | undefined;
		let timeoutTimer: NodeJS.Timeout | undefined;
		let timeoutTerminationTimer: NodeJS.Timeout | undefined;
		let timeoutHardKillTimer: NodeJS.Timeout | undefined;
		let turnBudgetSoftReached = false;
		let turnBudgetTerminationTimer: NodeJS.Timeout | undefined;
		let turnBudgetHardKillTimer: NodeJS.Timeout | undefined;
		let protocolHardKillTimer: NodeJS.Timeout | undefined;
		const clearTurnBudgetTimers = () => {
			if (turnBudgetTerminationTimer) {
				clearTimeout(turnBudgetTerminationTimer);
				turnBudgetTerminationTimer = undefined;
			}
			if (turnBudgetHardKillTimer) {
				clearTimeout(turnBudgetHardKillTimer);
				turnBudgetHardKillTimer = undefined;
			}
		};
		const clearTimeoutTimers = () => {
			if (timeoutTimer) {
				clearTimeout(timeoutTimer);
				timeoutTimer = undefined;
			}
			if (timeoutTerminationTimer) {
				clearTimeout(timeoutTerminationTimer);
				timeoutTerminationTimer = undefined;
			}
			if (timeoutHardKillTimer) {
				clearTimeout(timeoutHardKillTimer);
				timeoutHardKillTimer = undefined;
			}
		};

		const detachForeground = (reason: string): boolean => {
			if (detached || processClosed || lifecycleFinished || options.signal?.aborted) return false;
			const receiptProgress = snapshotProgress(progress);
			receiptProgress.status = "detached";
			receiptProgress.durationMs = Date.now() - startTime;
			const receipt = snapshotResult(result, receiptProgress);
			receipt.exitCode = -2;
			receipt.detached = true;
			receipt.detachedReason = reason;
			receipt.finalOutput = reason === "intercom coordination"
				? "Detached for intercom coordination before task completion."
				: reason === "user request"
					? "Detached at user request before task completion."
					: `Detached for ${reason} before task completion.`;
			receipt.outputMode = options.outputMode ?? "inline";
			if (options.outputPath) {
				receipt.outputSaveError = reason === "user request"
					? "Output file was not finalized because the subagent detached at user request."
					: `Output file was not finalized because the subagent detached for ${reason}.`;
			}
			receipt.progressSummary = {
				toolCount: receiptProgress.toolCount,
				tokens: receiptProgress.tokens,
				durationMs: receiptProgress.durationMs,
			};
			// The attempt is not detached until the outer coordinator has accepted and
			// synchronously published the receipt. A persistence/callback failure must
			// leave this attempt attached and abortable rather than orphaning it.
			let accepted = false;
			try {
				accepted = options.onDetachReceipt?.(receipt) === true;
			} catch {
				return false;
			}
			if (!accepted) return false;
			detached = true;
			return true;
		};

		// If the child emits a terminal assistant stop but never exits,
		// give it a short grace period to flush naturally, then clean it up.
		const FINAL_STOP_GRACE_MS = 1000;
		const HARD_KILL_MS = 3000;
		let childExited = false;
		let forcedTerminationSignal = false;
		let cleanTerminalAssistantStopReceived = false;
		let agentSettledReceived = false;
		let finalDrainTimer: NodeJS.Timeout | undefined;
		let finalHardKillTimer: NodeJS.Timeout | undefined;
		let watchdogTailTimer: NodeJS.Timeout | undefined;
		let childWatchdogState: ChildWatchdogStateSnapshot | undefined;
		const updateChildWatchdogState = (snapshot: ChildWatchdogStateSnapshot): void => {
			childWatchdogState = snapshot;
			result.watchdog = snapshot;
			progress.watchdog = snapshot;
		};
		const clearWatchdogTailTimer = () => {
			if (watchdogTailTimer) {
				clearTimeout(watchdogTailTimer);
				watchdogTailTimer = undefined;
			}
		};
		const clearFinalDrainTimers = () => {
			if (finalDrainTimer) {
				clearTimeout(finalDrainTimer);
				finalDrainTimer = undefined;
			}
			if (finalHardKillTimer) {
				clearTimeout(finalHardKillTimer);
				finalHardKillTimer = undefined;
			}
		};
		const startFinalDrain = () => {
			if (childWatchdogIsActive(childWatchdogState)) {
				armWatchdogTail();
				return;
			}
			if (childExited || finalDrainTimer || lifecycleFinished || processClosed) return;
			finalDrainTimer = setTimeout(() => {
				if (lifecycleFinished || processClosed) return;
				const termSent = trySignalChild(proc, "SIGTERM");
				if (!termSent) return;
				forcedTerminationSignal = true;
				if (!cleanTerminalAssistantStopReceived && !agentSettledReceived && !assistantError) {
					result.error = result.error ?? `Subagent process did not exit within ${FINAL_STOP_GRACE_MS}ms after its terminal event. Forcing termination.`;
				}
				finalHardKillTimer = setTimeout(() => {
					if (lifecycleFinished || processClosed) return;
					forcedTerminationSignal = trySignalChild(proc, "SIGKILL") || forcedTerminationSignal;
				}, HARD_KILL_MS);
				finalHardKillTimer.unref?.();
			}, FINAL_STOP_GRACE_MS);
			finalDrainTimer.unref?.();
		};
		function armWatchdogTail(): void {
			if ((!cleanTerminalAssistantStopReceived && !agentSettledReceived) || watchdogTailTimer || lifecycleFinished || processClosed) return;
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
				fireUpdate();
			}, childWatchdog?.watchdogTailTimeoutMs ?? 120_000);
			watchdogTailTimer.unref?.();
		}
		const applyChildLifecycle = (action: ChildLifecycleAction): void => {
			if (action === "cancel-drain") {
				clearFinalDrainTimers();
				clearWatchdogTailTimer();
				return;
			}
			if (action === "start-drain") startFinalDrain();
		};

		const unsubscribeIntercomDetach = options.intercomEvents?.on?.(INTERCOM_DETACH_REQUEST_EVENT, (payload) => {
			if (!options.allowIntercomDetach || processClosed) return;
			if (!payload || typeof payload !== "object") return;
			const event = payload as { requestId?: unknown; runId?: unknown; agent?: unknown; childIndex?: unknown };
			const requestId = event.requestId;
			if (typeof requestId !== "string" || requestId.length === 0) return;
			const hasRoute = event.runId !== undefined || event.agent !== undefined || event.childIndex !== undefined;
			if (hasRoute) {
				if (typeof event.runId === "string" && event.runId !== options.runId) return;
				if (typeof event.agent === "string" && event.agent !== agent.name) return;
				if (typeof event.childIndex === "number" && event.childIndex !== (options.index ?? 0)) return;
			} else if (!intercomStarted) return;
			const accepted = detachForeground("intercom coordination");
			options.intercomEvents?.emit(INTERCOM_DETACH_RESPONSE_EVENT, { requestId, accepted, runId: options.runId, agent: agent.name, childIndex: options.index ?? 0 });
		});

		const finish = (code: number) => {
			if (lifecycleFinished) return;
			lifecycleFinished = true;
			clearFinalDrainTimers();
			clearWatchdogTailTimer();
			clearStdioGuard();
			clearTimeoutTimers();
			clearTurnBudgetTimers();
			if (protocolHardKillTimer) {
				clearTimeout(protocolHardKillTimer);
				protocolHardKillTimer = undefined;
			}
			if (activityTimer) {
				clearInterval(activityTimer);
				activityTimer = undefined;
			}
			unsubscribeIntercomDetach?.();
			removeAbortListener?.();
			removeInterruptListener?.();
			resolve(code);
		};

		const drainPendingControlEvents = (): ControlEvent[] | undefined => {
			if (pendingControlEvents.length === 0) return undefined;
			const events = pendingControlEvents;
			pendingControlEvents = [];
			return events;
		};

		let activeLongRunningNotified = false;
		let pendingToolResult: { tool: string; path?: string; mutates: boolean; startedAt?: number } | undefined;
		const mutatingFailures = createMutatingFailureState();
		const mutatingFailureWindowMs = 5 * 60_000;
		const currentToolDurationMs = (now: number) => progress.currentToolStartedAt ? Math.max(0, now - progress.currentToolStartedAt) : undefined;
		const emitNeedsAttention = (now: number, input: { message?: string; reason?: ControlEvent["reason"]; recentFailureSummary?: string; currentTool?: string; currentPath?: string; currentToolDurationMs?: number } = {}): boolean => {
			if (!controlConfig.enabled) return false;
			const previous = progress.activityState;
			progress.activityState = "needs_attention";
			const event = buildControlEvent({
				type: "needs_attention",
				from: previous,
				to: "needs_attention",
				runId: options.runId,
				agent: agent.name,
				index: options.index,
				ts: now,
				lastActivityAt: progress.lastActivityAt,
				message: input.message,
				reason: input.reason ?? "idle",
				turns: result.usage.turns,
				tokens: progress.tokens,
				toolCount: progress.toolCount,
				currentTool: input.currentTool ?? progress.currentTool,
				currentToolDurationMs: input.currentToolDurationMs ?? currentToolDurationMs(now),
				currentPath: input.currentPath ?? progress.currentPath,
				recentFailureSummary: input.recentFailureSummary,
			});
			emitControlEvent(event);
			return previous !== "needs_attention";
		};
		const emitActiveLongRunning = (now: number, reason: ControlEvent["reason"]): boolean => {
			if (!controlConfig.enabled || activeLongRunningNotified || progress.activityState === "needs_attention") return false;
			activeLongRunningNotified = true;
			const previous = progress.activityState;
			progress.activityState = "active_long_running";
			emitControlEvent(buildControlEvent({
				type: "active_long_running",
				from: previous,
				to: "active_long_running",
				runId: options.runId,
				agent: agent.name,
				index: options.index,
				ts: now,
				message: `${agent.name} is still active but long-running`,
				reason,
				turns: result.usage.turns,
				tokens: progress.tokens,
				toolCount: progress.toolCount,
				currentTool: progress.currentTool,
				currentToolDurationMs: currentToolDurationMs(now),
				currentPath: progress.currentPath,
				elapsedMs: now - startTime,
			}));
			return true;
		};
		const requestTurnBudgetAbort = (turnCount: number) => {
			const budget = options.turnBudget;
			if (!budget || result.timedOut || result.turnBudgetExceeded || interruptedByControl || processClosed || lifecycleFinished) return;
			const message = turnBudgetExceededMessage(budget, turnCount);
			result.turnBudgetExceeded = true;
			result.wrapUpRequested = true;
			result.turnBudget = turnBudgetState(budget, turnCount, true);
			result.error = message;
			result.finalOutput = message;
			progress.status = "failed";
			progress.error = message;
			progress.durationMs = Date.now() - startTime;
			fireUpdate();
			trySignalChild(proc, "SIGINT");
			turnBudgetTerminationTimer = setTimeout(() => {
				if (processClosed || lifecycleFinished || result.timedOut) return;
				trySignalChild(proc, "SIGTERM");
			}, 1000);
			turnBudgetTerminationTimer.unref?.();
			turnBudgetHardKillTimer = setTimeout(() => {
				if (processClosed || lifecycleFinished || result.timedOut) return;
				trySignalChild(proc, "SIGKILL");
			}, 4000);
			turnBudgetHardKillTimer.unref?.();
		};

		const updateTurnBudget = (turnCount: number, terminalAssistantStop: boolean, toolWorkActiveOrStarting: boolean) => {
			const budget = options.turnBudget;
			if (!budget || result.timedOut || result.turnBudgetExceeded) return;
			if (turnCount < budget.maxTurns) {
				result.turnBudget = { ...budget, outcome: "within-budget", turnCount };
				return;
			}
			if (!turnBudgetSoftReached) {
				turnBudgetSoftReached = true;
				result.wrapUpRequested = true;
				appendRecentOutput(progress, [turnBudgetSoftNote(budget, turnCount)]);
			}
			const decision = turnBudgetDecision(budget, turnCount, terminalAssistantStop, toolWorkActiveOrStarting, options.enforceHardTurnLimit);
			if (decision === "defer") {
				result.turnBudget = turnBudgetDeferredState(
					budget,
					turnCount,
					result.turnBudget?.terminationDeferredAtTurn,
				);
				return;
			}
			result.turnBudget = turnBudgetState(budget, turnCount, false);
			if (decision === "abort") requestTurnBudgetAbort(turnCount);
		};

		const updateActivityState = (now: number): boolean => {
			if (!controlConfig.enabled) return false;
			const idleState = deriveActivityState({
				config: controlConfig,
				startedAt: startTime,
				lastActivityAt: progress.lastActivityAt,
				currentTool: progress.currentTool,
				now,
			});
			if (idleState === "needs_attention") {
				return progress.activityState === "needs_attention" ? false : emitNeedsAttention(now);
			}
			const activeReason = nextLongRunningTrigger(controlConfig, {
				startedAt: startTime,
				now,
				turns: result.usage.turns,
				tokens: progress.tokens,
			});
			return activeReason ? emitActiveLongRunning(now, activeReason) : false;
		};


		const emitUpdateSnapshot = (text: string) => {
			if (!options.onUpdate || processClosed) return;
			const progressSnapshot = snapshotProgress(progress);
			const resultSnapshot = snapshotStreamResult(result, progressSnapshot);
			const controlEvents = drainPendingControlEvents();
			options.onUpdate({
				content: [{ type: "text", text }],
				details: {
					mode: "single",
					results: [resultSnapshot],
					progress: [progressSnapshot],
					controlEvents,
				},
			});
		};

		const fireUpdate = () => {
			if (!options.onUpdate || processClosed) return;
			progress.durationMs = Date.now() - startTime;
			const output = (result.timedOut || result.turnBudgetExceeded) && result.finalOutput ? result.finalOutput : getFinalOutput(result.messages ?? []);
			emitUpdateSnapshot(output || "(running...)");
		};

		const rawStdoutTail = createBoundedByteTail();
		const processLine = (line: string) => {
			if (!line.trim()) return;
			jsonlWriter.writeLine(line);
			let evt: { type?: string; message?: Message; toolName?: string; args?: unknown; willRetry?: unknown };
			try {
				evt = JSON.parse(line) as { type?: string; message?: Message; toolName?: string; args?: unknown; willRetry?: unknown };
			} catch {
				rawStdoutTail.push(`${line}\n`);
				shared.transcriptWriter?.writeStdoutLine(line);
				// Non-JSON stdout lines are expected; only structured events are parsed.
				return;
			}
			shared.transcriptWriter?.writeChildEvent(evt);
			if (evt.type === "agent_settled") agentSettledReceived = true;
			applyChildLifecycle(projectChildLifecycle(evt));

			if (isChildWatchdogStatusEvent(evt)) {
				if (!childWatchdog) return;
				const next = acceptChildWatchdogEvent({
					current: childWatchdogState,
					event: evt,
					runId: options.runId,
					agent: agent.name,
					childIndex: options.index ?? 0,
				});
				if (!next) return;
				updateChildWatchdogState(next);
				if (childWatchdogIsActive(next)) {
					clearFinalDrainTimers();
					armWatchdogTail();
				} else {
					clearWatchdogTailTimer();
					if (cleanTerminalAssistantStopReceived || agentSettledReceived) startFinalDrain();
				}
				fireUpdate();
				return;
			}

			const now = Date.now();
			progress.durationMs = now - startTime;
			progress.lastActivityAt = now;
			updateActivityState(now);

			if (evt.type === "tool_execution_start") {
				const toolArgs = evt.args && typeof evt.args === "object" && !Array.isArray(evt.args)
					? evt.args as Record<string, unknown>
					: {};
				if (options.structuredOutput && evt.toolName === "structured_output") {
					structuredOutputToolInvoked = true;
					structuredOutputMessageStartIndex = result.messages?.length ?? 0;
				}
				if (options.allowIntercomDetach && (evt.toolName === "intercom" || evt.toolName === "contact_supervisor")) {
					intercomStarted = true;
				}
				progress.toolCount++;
				if (options.toolBudget) {
					result.toolBudget = toolBudgetState(options.toolBudget, progress.toolCount);
				}
				progress.currentTool = evt.toolName;
				progress.currentToolArgs = extractToolArgsPreview(toolArgs);
				progress.currentToolStartedAt = now;
				progress.currentPath = resolveCurrentPath(evt.toolName, toolArgs);
				const mutates = isMutatingTool(evt.toolName, toolArgs);
				observedMutationAttempt = observedMutationAttempt || mutates;
				pendingToolResult = { tool: evt.toolName ?? "tool", path: progress.currentPath, mutates, startedAt: now };
				fireUpdate();
			}

			if (evt.type === "tool_execution_end") {
				if (progress.currentTool) {
					progress.recentTools.push({
						tool: progress.currentTool,
						args: progress.currentToolArgs || "",
						endMs: now,
					});
				}
				progress.currentTool = undefined;
				progress.currentToolArgs = undefined;
				progress.currentToolStartedAt = undefined;
				progress.currentPath = undefined;
				fireUpdate();
			}

			if (evt.type === "message_end" && evt.message) {
				result.messages!.push(evt.message);
				if (evt.message.role === "assistant") {
					result.usage.turns++;
					progress.turnCount = result.usage.turns;
					const stopReason = (evt.message as { stopReason?: string }).stopReason;
					const toolCalls = Array.isArray(evt.message.content)
						? evt.message.content.filter((part) => (part as { type?: string }).type === "toolCall")
						: [];
					const hasToolCall = toolCalls.length > 0;
					const terminalAssistantStop = stopReason === "stop" && !hasToolCall;
					const terminalStructuredOutputCall = Boolean(options.structuredOutput)
						&& toolCalls.length === 1
						&& (toolCalls[0] as { name?: string }).name === "structured_output";
					updateTurnBudget(result.usage.turns, terminalAssistantStop || terminalStructuredOutputCall, hasToolCall || Boolean(progress.currentTool));
					const u = evt.message.usage;
					if (u) {
						result.usage.input += u.input || 0;
						result.usage.output += u.output || 0;
						result.usage.cacheRead += u.cacheRead || 0;
						result.usage.cacheWrite += u.cacheWrite || 0;
						result.usage.cost += u.cost?.total || 0;
						progress.tokens = result.usage.input + result.usage.output;
						progress.inputTokens = result.usage.input;
						progress.outputTokens = result.usage.output;
					}
					if (evt.message.model) {
						progress.model = evt.message.model;
						if (!result.model) result.model = evt.message.model;
					}
					if (evt.message.errorMessage) assistantError = evt.message.errorMessage;
					const assistantText = extractTextFromContent(evt.message.content);
					appendRecentOutput(progress, assistantText.split("\n").slice(-10));
					// Final assistant message: start the exit drain window.
					if (terminalAssistantStop) {
						if (!evt.message.errorMessage && assistantText.trim()) assistantError = undefined;
						cleanTerminalAssistantStopReceived ||= !evt.message.errorMessage;
						applyChildLifecycle(projectChildLifecycle(evt, true));
					}
				}
				updateActivityState(now);
				fireUpdate();
			}

			if (evt.type === "tool_result_end" && evt.message) {
				result.messages!.push(evt.message);
				const resultText = extractTextFromContent(evt.message.content);
				if (options.toolBudget && pendingToolResult && resultText.includes("Tool budget hard limit reached")) {
					result.toolBudgetBlocked = true;
					result.toolBudget = toolBudgetState(options.toolBudget, progress.toolCount, pendingToolResult.tool);
				}
				appendRecentOutput(progress, resultText.split("\n").slice(-10));
				const toolSnapshot = pendingToolResult;
				pendingToolResult = undefined;
				if (toolSnapshot?.mutates && didMutatingToolFail(resultText)) {
					recordMutatingFailure(mutatingFailures, {
						tool: toolSnapshot.tool,
						path: toolSnapshot.path,
						error: resultText.split("\n").find((line) => line.trim())?.trim().slice(0, 180) ?? "mutating tool failed",
						ts: now,
					}, mutatingFailureWindowMs);
					if (shouldEscalateMutatingFailures(mutatingFailures, controlConfig.failedToolAttemptsBeforeAttention)) {
						emitNeedsAttention(now, {
							message: `${agent.name} needs attention after repeated mutating tool failures`,
							reason: "tool_failures",
							currentTool: toolSnapshot.tool,
							currentPath: toolSnapshot.path,
							currentToolDurationMs: toolSnapshot.startedAt ? Math.max(0, now - toolSnapshot.startedAt) : undefined,
							recentFailureSummary: summarizeRecentMutatingFailures(mutatingFailures),
						});
					}
				} else if (toolSnapshot?.mutates) {
					resetMutatingFailureState(mutatingFailures);
				}
				fireUpdate();
			}
		};

		fireUpdate();
		if (controlConfig.enabled || options.onUpdate) {
			activityTimer = setInterval(() => {
				if (processClosed || lifecycleFinished) {
					return;
				}
				updateActivityState(Date.now());
				fireUpdate();
			}, 1000);
			activityTimer.unref?.();
		}

		if (attemptTimeout) {
			timeoutTimer = setTimeout(() => {
				if (processClosed || lifecycleFinished || interruptedByControl) return;
				result.timedOut = true;
				result.error = attemptTimeout.message;
				result.finalOutput = attemptTimeout.message;
				progress.status = "failed";
				progress.error = attemptTimeout.message;
				progress.durationMs = Date.now() - startTime;
				fireUpdate();
				trySignalChild(proc, "SIGINT");
				timeoutTerminationTimer = setTimeout(() => {
					if (processClosed || lifecycleFinished) return;
					trySignalChild(proc, "SIGTERM");
				}, 1000);
				timeoutTerminationTimer.unref?.();
				timeoutHardKillTimer = setTimeout(() => {
					if (processClosed || lifecycleFinished) return;
					trySignalChild(proc, "SIGKILL");
				}, 4000);
				timeoutHardKillTimer.unref?.();
			}, attemptTimeout.remainingMs);
			timeoutTimer.unref?.();
		}

		const stderrTail = createBoundedByteTail();
		const failProtocol = (limit: ProtocolOutputLimit): void => {
			if (result.protocolError) return;
			result.protocolError = limit;
			result.error = formatProtocolOutputLimit(limit);
			progress.status = "failed";
			progress.error = result.error;
			progress.durationMs = Date.now() - startTime;
			fireUpdate();
			if (!childExited) {
				trySignalChild(proc, "SIGTERM");
				protocolHardKillTimer = setTimeout(() => {
					if (!childExited) trySignalChild(proc, "SIGKILL");
				}, 3000);
				protocolHardKillTimer.unref?.();
			}
		};
		const stdoutReader = createBoundedLineReader({
			oversizedLineProjector: PI_AGGREGATE_EVENT_PROJECTOR,
			onLine: processLine,
			onLimit: failProtocol,
		});
		const stderrReader = createBoundedLineReader({
			stream: "stderr",
			maxPendingLineBytes: MAX_CHILD_STDERR_BYTES,
			onLine: (line) => shared.transcriptWriter?.writeStderrLine(line),
			onLimit: (limit) => shared.transcriptWriter?.writeStderrLine(formatProtocolOutputLimit(limit)),
		});

		const clearStdioGuard = attachPostExitStdioGuard(proc, { idleMs: 2000, hardMs: 8000 });
		proc.stdout.on("data", (chunk: Buffer) => stdoutReader.push(chunk));
		proc.stderr.on("data", (chunk: Buffer) => {
			stderrTail.push(chunk);
			stderrReader.push(chunk);
		});
		proc.on("exit", () => {
			childExited = true;
			clearFinalDrainTimers();
		});
		proc.on("close", (code, signal) => {
			if (lifecycleFinished) return;
			processClosed = true;
			clearFinalDrainTimers();
			clearStdioGuard();
			void jsonlWriter.close().catch(() => {
				// JSONL artifact flush is best effort.
			});
			const toolDiagnosticError = readChildToolDiagnosticError(toolDiagnosticPath);
			result.runtimeAcknowledgedExtensions = readRuntimeAcknowledgedExtensions(runtimeAcknowledgedExtensionsPath);
			cleanupTempDir(tempDir);
			stdoutReader.end();
			stderrReader.end();
			const stderr = stderrTail.text();
			const rawStdout = rawStdoutTail.text();
			let closeError = result.error ?? toolDiagnosticError ?? assistantError;
			const forcedDrainAfterFinalSuccess = Boolean(forcedTerminationSignal || signal) && (cleanTerminalAssistantStopReceived || agentSettledReceived) && !closeError;
			if (signal) result.processSignal = signal;
			if (!closeError && isUnexplainedProcessSignal({
				processSignal: signal,
				interrupted: result.interrupted,
				timedOut: result.timedOut,
				stopped: result.stopped,
				turnBudgetExceeded: result.turnBudgetExceeded,
				forcedDrainAfterFinalSuccess,
			})) {
				closeError = formatProcessSignalError(signal!);
			}
			if (code !== 0 && rawStdout.trim() && !closeError && !forcedDrainAfterFinalSuccess) {
				closeError = rawStdout.trim();
			}
			if (code !== 0 && stderr.trim() && !closeError && !forcedDrainAfterFinalSuccess) {
				closeError = stderr.trim();
			}
			const finalCode = forcedDrainAfterFinalSuccess ? 0 : forcedTerminationSignal || signal ? (code ?? 1) : (code ?? 0);
			if (!result.error && closeError) result.error = closeError;
			finish(finalCode);
		});
		proc.on("error", (error) => {
			if (lifecycleFinished) return;
			processClosed = true;
			clearFinalDrainTimers();
			clearStdioGuard();
			void jsonlWriter.close().catch(() => {
				// JSONL artifact flush is best effort.
			});
			cleanupTempDir(tempDir);
			stdoutReader.end();
			stderrReader.end();
			if (!result.error) {
				result.error = error instanceof Error ? error.message : String(error);
			}
			finish(1);
		});

		if (options.signal) {
			const kill = () => {
				if (processClosed || lifecycleFinished) return;
				proc.kill("SIGTERM");
				setTimeout(() => !proc.killed && proc.kill("SIGKILL"), 3000);
			};
			if (options.signal.aborted) kill();
			else {
				options.signal.addEventListener("abort", kill, { once: true });
				removeAbortListener = () => options.signal?.removeEventListener("abort", kill);
			}
		}

		if (options.interruptSignal) {
			const interrupt = () => {
				if (processClosed || lifecycleFinished) return;
				if (result.timedOut) return;
				interruptedByControl = true;
				clearTimeoutTimers();
				progress.status = "running";
				progress.durationMs = Date.now() - startTime;
				result.interrupted = true;
				result.finalOutput = "Interrupted. Waiting for explicit next action.";
				progress.activityState = undefined;
				fireUpdate();
				trySignalChild(proc, "SIGINT");
				setTimeout(() => {
					if (lifecycleFinished || processClosed) return;
					trySignalChild(proc, "SIGTERM");
				}, 1000).unref?.();
			};
			if (options.interruptSignal.aborted) interrupt();
			else {
				options.interruptSignal.addEventListener("abort", interrupt, { once: true });
				removeInterruptListener = () => options.interruptSignal?.removeEventListener("abort", interrupt);
			}
		}

		// Publish only after every callback and cleanup guard captured by detach or
		// later lifecycle events has initialized. Consumers may invoke synchronously.
		try {
			options.onDetachReady?.((reason = "user request") => detachForeground(reason));
		} catch (error) {
			// A consumer callback is advisory. Keep the child attached and observable
			// rather than rejecting this attempt and orphaning its live process.
			appendRecentOutput(progress, [`Foreground detach callback failed: ${error instanceof Error ? error.message : String(error)}`]);
		}
	});
	result.exitCode = exitCode;
	if (interruptedByControl) {
		result.exitCode = 0;
		result.interrupted = true;
		result.error = undefined;
		result.finalOutput = result.finalOutput || "Interrupted. Waiting for explicit next action.";
		result.controlEvents = allControlEvents.length ? allControlEvents : undefined;
		progress.activityState = undefined;
		progress.durationMs = Date.now() - startTime;
		result.progressSummary = {
			toolCount: progress.toolCount,
			tokens: progress.tokens,
			durationMs: progress.durationMs,
		};
		return result;
	}
	if (result.error && result.exitCode === 0) {
		result.exitCode = 1;
	}
	let validatedStructuredOutput = false;
	if (options.structuredOutput && result.exitCode === 0 && !result.error) {
		result.structuredOutputSchemaPath = options.structuredOutput.schemaPath;
		result.structuredOutputPath = options.structuredOutput.outputPath;
		if (!structuredOutputToolInvoked) {
			result.exitCode = 1;
			result.error = MISSING_STRUCTURED_OUTPUT_CALL_ERROR;
			result.structuredOutputFailed = true;
		} else {
			const structured = await readStructuredOutput({
				schema: options.structuredOutput.schema,
				schemaPath: options.structuredOutput.schemaPath,
				outputPath: options.structuredOutput.outputPath,
			});
			if (structured.error) {
				result.exitCode = 1;
				result.error = structured.error;
				result.structuredOutputFailed = true;
			} else {
				result.structuredOutput = structured.value;
				validatedStructuredOutput = true;
			}
		}
	}
	if (result.exitCode === 0 && !result.error) {
		const messages = result.messages ?? [];
		const finalText = getFinalOutput(messages);
		const errorMessages = validatedStructuredOutput
			? messages.slice(structuredOutputMessageStartIndex ?? messages.length)
			: messages;
		const errInfo = detectSubagentError(errorMessages);
		const missingOutput = !finalText?.trim() && !validatedStructuredOutput;
		if (missingOutput && (!errInfo.hasError || hasEmptyTerminalAssistantResponse(messages))) {
			result.exitCode = 1;
			result.error = "Subagent produced no output (possible model cold-start or empty response).";
		} else if (errInfo.hasError) {
			result.exitCode = errInfo.exitCode ?? 1;
			result.error = errInfo.details
				? `${errInfo.errorType} failed (exit ${errInfo.exitCode}): ${errInfo.details}`
				: `${errInfo.errorType} failed with exit code ${errInfo.exitCode}`;
		}
	}

	progress.status = result.exitCode === 0 ? "completed" : "failed";
	progress.durationMs = Date.now() - startTime;
	if (result.error) {
		progress.error = result.error;
		if (progress.currentTool) {
			progress.failedTool = progress.currentTool;
		}
	}

	result.progressSummary = {
		toolCount: progress.toolCount,
		tokens: progress.tokens,
		durationMs: progress.durationMs,
	};

	const acceptanceOutput = getFinalOutput(result.messages ?? []);
	let fullOutput = stripAcceptanceReport(acceptanceOutput);
	if (!fullOutput.trim() && result.structuredOutput !== undefined) fullOutput = JSON.stringify(result.structuredOutput, null, 2);
	result.outputState = fullOutput.trim() || result.structuredOutput !== undefined ? "present" : "absent";
	if (result.timedOut) {
		const timeoutMessage = formatTimeoutMessage(options.timeoutMs ?? 0);
		fullOutput = fullOutput.trim()
			? `${timeoutMessage}\n\nPartial output before timeout:\n${fullOutput}`
			: timeoutMessage;
	} else if (result.turnBudgetExceeded && result.turnBudget) {
		fullOutput = formatTurnBudgetOutput(turnBudgetExceededMessage(result.turnBudget, result.turnBudget.turnCount), fullOutput);
	} else if (result.turnBudget?.outcome === "termination-deferred") {
		const note = turnBudgetDeferredNote(result.turnBudget, result.turnBudget.terminationDeferredAtTurn ?? result.turnBudget.turnCount);
		fullOutput = fullOutput.trim() ? `${note}\n\n${fullOutput}` : note;
	} else if (result.wrapUpRequested && result.turnBudget?.outcome === "wrap-up-requested") {
		const note = turnBudgetSoftNote(result.turnBudget, result.turnBudget.wrapUpRequestedAtTurn ?? result.turnBudget.turnCount);
		fullOutput = fullOutput.trim() ? `${note}\n\n${fullOutput}` : note;
	}
	const completionGuardEnabled = isAgentContractV1(options.agentContract) ? agent.completionGuard === true : agent.completionGuard !== false;
	const completionGuard = result.exitCode === 0 && !result.error && completionGuardEnabled
		? evaluateCompletionMutationGuard({
			agent: agent.name,
			task: shared.originalTask ?? task,
			messages: result.messages ?? [],
			tools: agent.tools,
			mcpDirectTools: agent.mcpDirectTools,
		})
		: undefined;
	const completionGuardTriggered = completionGuard?.triggered === true && !observedMutationAttempt;
	if (completionGuard) {
		result.effects = {
			...(result.effects ?? {}),
			fileMutation: {
				status: completionGuard.expectedMutation ? completionGuardTriggered ? "missing" : "observed" : "not-applicable",
				expected: completionGuard.expectedMutation,
				attempted: completionGuard.attemptedMutation || observedMutationAttempt,
				...(completionGuardTriggered ? { message: "Subagent completed without making edits for an implementation task." } : {}),
			},
		};
	}
	if (completionGuardTriggered && !isAgentContractV1(options.agentContract)) {
		result.exitCode = 1;
		result.error = "Subagent completed without making edits for an implementation task.\nIt appears to have returned planning or scratchpad output instead of applying changes.";
		progress.status = "failed";
		progress.error = result.error;
		emitControlEvent(buildControlEvent({
			from: progress.activityState,
			to: "needs_attention",
			runId: options.runId ?? agent.name,
			agent: agent.name,
			index: options.index,
			ts: Date.now(),
			message: `${agent.name} completed without making edits for an implementation task`,
			reason: "completion_guard",
		}));
	}
		if (options.outputPath && result.exitCode === 0) {
			const resolvedOutput = resolveSingleOutput(options.outputPath, fullOutput, shared.outputSnapshot);
			fullOutput = stripAcceptanceReport(resolvedOutput.fullOutput);
			result.savedOutputPath = resolvedOutput.savedPath;
			result.outputSaveError = resolvedOutput.saveError;
			if (resolvedOutput.savedPath) {
				result.outputReference = formatSavedOutputReference(resolvedOutput.savedPath, fullOutput);
				if (result.outputState === "absent") result.outputState = "unknown";
			}
	}
		artifactOutputByResult.set(result, fullOutput);
		acceptanceOutputByResult.set(result, acceptanceOutput);
	result.outputMode = options.outputMode ?? "inline";
	result.finalOutput = options.outputMode === "file-only" && result.savedOutputPath && result.outputReference
		? result.outputReference.message
		: fullOutput;
	result.controlEvents = allControlEvents.length ? allControlEvents : undefined;
	if (options.onUpdate) {
		const finalText = result.finalOutput || result.error || "(no output)";
		const progressSnapshot = snapshotProgress(progress);
		const resultSnapshot = snapshotStreamResult(result, progressSnapshot);
		options.onUpdate({
			content: [{ type: "text", text: finalText }],
			details: {
				mode: "single",
				results: [resultSnapshot],
				progress: [progressSnapshot],
				controlEvents: allControlEvents.length ? allControlEvents : undefined,
			},
		});
	}
	return result;
}

/**
 * Run a subagent synchronously (blocking until complete)
 */
async function runSyncCompletion(
	runtimeCwd: string,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	options: RunSyncOptions,
): Promise<SingleResult> {
	options = {
		...options,
		capabilityCeiling: intersectSubagentCapabilityCeilings(options.capabilityCeiling ?? resolveCurrentSubagentCapabilityCeiling(options.parentSessionId), decodeSubagentCapabilityCeiling(process.env[SUBAGENT_CAPABILITY_CEILING_ENV])),
	};
	const agent = agents.find((a) => a.name === agentName);
	if (!agent) {
		return withRunContext({
			index: options.index ?? 0,
			agent: agentName,
			task,
			exitCode: 1,
			messages: [],
			usage: emptyUsage(),
			error: `Unknown agent: ${agentName}`,
		}, options.context);
	}
	try {
		assertAgentAllowedByCapabilityCeiling(agent.name, options.capabilityCeiling);
	} catch (error) {
		return withRunContext({
			index: options.index ?? 0,
			agent: agent.name,
			task,
			exitCode: 1,
			messages: [],
			usage: emptyUsage(),
			error: error instanceof Error ? error.message : String(error),
			...(options.capabilityCeiling ? { capabilityCeiling: options.capabilityCeiling } : {}),
		}, options.context);
	}
	const acceptanceErrors = validateAcceptanceInput(options.acceptance);
	if (acceptanceErrors.length > 0) {
		return withRunContext({
			index: options.index ?? 0,
			agent: agentName,
			task,
			exitCode: 1,
			messages: [],
			usage: emptyUsage(),
			error: acceptanceErrors.join(" "),
		}, options.context);
	}
	const outputModeValidationError = validateFileOnlyOutputMode(options.outputMode, options.outputPath, `Single run (${agentName})`);
	if (outputModeValidationError) {
		return withRunContext({
			index: options.index ?? 0,
			agent: agentName,
			task,
			exitCode: 1,
			messages: [],
			usage: emptyUsage(),
			outputMode: options.outputMode,
			error: outputModeValidationError,
		}, options.context);
	}

	const shareEnabled = options.share === true;
	const effectiveAcceptance = resolveEffectiveAcceptance({
		explicit: options.acceptance,
		agentName,
		acceptanceRole: agent.acceptanceRole,
		task,
		mode: options.acceptanceContext?.mode ?? "single",
		async: options.acceptanceContext?.async,
		dynamic: options.acceptanceContext?.dynamic,
		dynamicGroup: options.acceptanceContext?.dynamicGroup,
		agentContract: options.agentContract,
	});
	const acceptancePrompt = formatAcceptancePrompt(effectiveAcceptance, { reportOptional: isAgentContractV1(options.agentContract) });
	const taskWithAcceptance = acceptancePrompt ? `${task}\n${acceptancePrompt}` : task;
	const sessionEnabled = Boolean(options.sessionFile || options.sessionDir) || shareEnabled;
	const skillNames = options.skills ?? agent.skills ?? [];
	const skillCwd = options.cwd ?? runtimeCwd;
	const { resolved: resolvedSkills, missing: missingSkills } = resolveSkillsWithFallback(
		skillNames,
		skillCwd,
		runtimeCwd,
		agent.skillPath,
		agent.filePath ? path.dirname(agent.filePath) : skillCwd,
	);
	if (skillNames.some((skill) => skill.trim() === "pi-subagents") && missingSkills.includes("pi-subagents")) {
		return withRunContext({
			index: options.index ?? 0,
			agent: agentName,
			task,
			exitCode: 1,
			messages: [],
			usage: emptyUsage(),
			error: "Skills not found: pi-subagents",
		}, options.context);
	}
	let systemPrompt = agent.systemPrompt?.trim() || "";
	if (resolvedSkills.length > 0) {
		const skillInjection = buildSkillInjection(resolvedSkills);
		systemPrompt = systemPrompt ? `${systemPrompt}\n\n${skillInjection}` : skillInjection;
	}
	const memoryInjection = buildAgentMemoryInjection(agent, skillCwd);
	if (memoryInjection) {
		systemPrompt = systemPrompt ? `${systemPrompt}\n\n${memoryInjection}` : memoryInjection;
	}
	systemPrompt = appendAgentRefinementOverlay(systemPrompt, { cwd: skillCwd, agentName });
	systemPrompt = injectOutputPathSystemPrompt(systemPrompt, options.outputPath, agent);

	const candidates = buildModelCandidates(
		options.modelOverride ?? agent.model,
		agent.fallbackModels,
		options.availableModels,
		options.preferredModelProvider,
		{ scope: options.modelScope },
	);
	const attemptedModels: string[] = [];
	const modelAttempts: ModelAttempt[] = [];
	const aggregateUsage = emptyUsage();
	const attemptNotes: string[] = [];
	let totalToolCount = 0;
	let totalDurationMs = 0;

	let artifactPathsResult: ArtifactPaths | undefined;
	let jsonlPath: string | undefined;
	let transcriptWriter: ChildTranscriptWriter | undefined;
	if (options.artifactsDir && options.artifactConfig?.enabled !== false) {
		artifactPathsResult = getArtifactPaths(options.artifactsDir, options.runId, agentName, options.index);
		ensureArtifactsDir(options.artifactsDir);
		if (options.artifactConfig?.includeInput !== false) {
				writeArtifact(artifactPathsResult.inputPath, `# Task for ${agentName}\n\n${taskWithAcceptance}`);
		}
		if (options.artifactConfig?.includeJsonl !== false) {
			jsonlPath = artifactPathsResult.jsonlPath;
		}
		if (options.artifactConfig?.includeTranscript !== false) {
			transcriptWriter = createChildTranscriptWriter({
				transcriptPath: artifactPathsResult.transcriptPath,
				source: "foreground",
				runId: options.runId,
				agent: agentName,
				childIndex: options.index,
				cwd: options.cwd ?? runtimeCwd,
			});
			transcriptWriter.writeInitialUserMessage(taskWithAcceptance);
		}
	}

	const persistResultMetadata = (target: SingleResult): void => {
		persistSingleResultMetadata({
			metadataPath: artifactPathsResult?.metadataPath,
			enabled: options.artifactConfig?.enabled !== false && options.artifactConfig?.includeMetadata !== false,
			runId: options.runId,
			agent: agentName,
			task,
			result: target,
		});
	};

	let intercomDetached = false;
	let detachedReason: string | undefined;
	const attemptOptions: RunSyncOptions = {
		...options,
		onDetachReceipt: (receipt) => {
			receipt.acceptance = buildPendingAcceptanceLedger(effectiveAcceptance);
			try {
				persistResultMetadata(receipt);
			} catch (error) {
				receipt.metadataSaveError = error instanceof Error ? error.message : String(error);
			}
			const accepted = options.onDetachReceipt?.(receipt) === true;
			if (accepted) {
				detachedReason = receipt.detachedReason;
				if (receipt.detachedReason === "intercom coordination") intercomDetached = true;
			}
			return accepted;
		},
	};
	let lastResult: SingleResult | undefined;
	const modelsToTry = candidates.length > 0 ? candidates : [undefined];
	modelAttemptsLoop: for (let modelIndex = 0; modelIndex < modelsToTry.length; modelIndex++) {
		const candidate = modelsToTry[modelIndex];
		for (let startupAttemptIndex = 0; ; startupAttemptIndex++) {
			const outputSnapshot = captureSingleOutputSnapshot(options.outputPath);
			const result = await runSingleAttempt(runtimeCwd, agent, taskWithAcceptance, candidate, attemptOptions, {
				sessionEnabled,
				systemPrompt,
				resolvedSkillNames: resolvedSkills.length > 0 ? resolvedSkills.map((skill) => skill.name) : undefined,
				skillsWarning: missingSkills.length > 0 ? `Skills not found: ${missingSkills.join(", ")}` : undefined,
				jsonlPath,
				artifactPaths: artifactPathsResult,
				transcriptWriter,
				attemptNotes,
				modelCandidates: candidates
					.map((modelCandidate) => applyThinkingSuffix(modelCandidate, options.thinkingOverride ?? agent.thinking, options.thinkingOverride !== undefined))
					.filter((modelCandidate): modelCandidate is string => Boolean(modelCandidate)),
				outputSnapshot,
				originalTask: task,
			});
			lastResult = result;
			if (startupAttemptIndex === 0) {
				if (result.model) attemptedModels.push(result.model);
				else if (candidate) attemptedModels.push(candidate);
			}
			sumUsage(aggregateUsage, result.usage);
			totalToolCount += result.progressSummary?.toolCount ?? 0;
			totalDurationMs += result.progressSummary?.durationMs ?? 0;
			const attemptSucceeded = result.exitCode === 0 && !result.error;
			const attempt: ModelAttempt = {
				model: result.model ?? candidate ?? agent.model ?? "default",
				success: attemptSucceeded,
				exitCode: result.exitCode,
				error: result.error,
				usage: { ...result.usage },
			};
			modelAttempts.push(attempt);
			// Preserve the legacy intercom handoff contract: once this logical run has
			// been handed to a supervisor, terminating that attempt must not launch a
			// startup retry or model fallback. Explicit user detach retains fallback.
			if (intercomDetached || result.timedOut || result.turnBudgetExceeded) break modelAttemptsLoop;
			if (attemptSucceeded) break modelAttemptsLoop;

			const startupFailure = isRetryableSubagentStartupFailure({
				exitCode: result.exitCode,
				error: result.error,
				finalOutput: result.finalOutput,
				messageCount: result.messages?.length ?? 0,
				toolCount: result.progressSummary?.toolCount ?? 0,
				usage: result.usage,
				durationMs: result.progressSummary?.durationMs ?? Number.POSITIVE_INFINITY,
				protocolError: result.protocolError,
				processSignal: result.processSignal,
				detached: result.detached,
				interrupted: result.interrupted,
				timedOut: result.timedOut,
				stopped: result.stopped,
				turnBudgetExceeded: result.turnBudgetExceeded,
			});
			const retryDelayMs = SUBAGENT_STARTUP_RETRY_DELAYS_MS[startupAttemptIndex];
			if (startupFailure && retryDelayMs !== undefined) {
				const retryNote = formatSubagentStartupRetryNote({
					model: attempt.model,
					attempt: startupAttemptIndex + 1,
					maxAttempts: SUBAGENT_STARTUP_RETRY_DELAYS_MS.length + 1,
					delayMs: retryDelayMs,
				});
				const shouldRetry = await waitForSubagentStartupRetry(retryDelayMs, [options.signal, options.interruptSignal]);
				if (!shouldRetry) {
					if (options.interruptSignal?.aborted) {
						result.exitCode = 0;
						result.interrupted = true;
						result.error = undefined;
						result.finalOutput = "Interrupted. Waiting for explicit next action.";
						if (result.progress) {
							result.progress.status = "running";
							result.progress.error = undefined;
						}
					} else {
						const cancellationError = "Subagent startup retry cancelled before relaunch.";
						result.error = cancellationError;
						result.finalOutput = cancellationError;
						attempt.error = cancellationError;
						if (result.progress) result.progress.error = cancellationError;
					}
					break modelAttemptsLoop;
				}
				attempt.error = retryNote;
				attemptNotes.push(retryNote);
				continue;
			}
			if (startupFailure) {
				const startupError = formatSubagentStartupRetryExhaustedError({
					model: attempt.model,
					attempts: startupAttemptIndex + 1,
				});
				result.error = startupError;
				result.finalOutput = startupError;
				if (result.progress) {
					result.progress.error = startupError;
					result.progress.status = "failed";
				}
				attempt.error = startupError;
				break modelAttemptsLoop;
			}
			if (!isRetryableModelFailure(result.error) || modelIndex === modelsToTry.length - 1) break modelAttemptsLoop;
			attemptNotes.push(formatModelAttemptNote(attempt, modelsToTry[modelIndex + 1]));
			break;
		}
	}

	const result = withRunContext(lastResult ?? {
		index: options.index ?? 0,
		agent: agentName,
		task,
		exitCode: 1,
		messages: [],
		usage: emptyUsage(),
		error: "Subagent did not produce a result.",
	} satisfies SingleResult, options.context);

	result.usage = aggregateUsage;
	result.attemptedModels = attemptedModels.length > 0 ? attemptedModels : undefined;
	result.modelAttempts = modelAttempts.length > 0 ? modelAttempts : undefined;
	result.progressSummary = {
		toolCount: totalToolCount,
		tokens: aggregateUsage.input + aggregateUsage.output,
		durationMs: totalDurationMs,
	};
	if (transcriptWriter) result.transcriptPath = artifactPathsResult?.transcriptPath;
	if (transcriptWriter?.getError()) result.transcriptError = transcriptWriter.getError();

	try {
		if (artifactPathsResult && options.artifactConfig?.enabled !== false) {
			result.artifactPaths = artifactPathsResult;
			if (options.artifactConfig?.includeOutput !== false) {
				writeArtifact(artifactPathsResult.outputPath, formatOutputArtifactContent({
					output: artifactOutputByResult.get(result) ?? result.finalOutput ?? "",
					error: result.error,
					transcriptPath: result.transcriptPath,
					metadataPath: options.artifactConfig?.includeMetadata === false ? undefined : artifactPathsResult.metadataPath,
				}));
			}
			if (options.maxOutput) {
				const config = { ...DEFAULT_MAX_OUTPUT, ...options.maxOutput };
				const truncationResult = truncateOutput(result.finalOutput ?? "", config, artifactPathsResult.outputPath);
				if (truncationResult.truncated) result.truncation = truncationResult;
			}
		} else if (options.maxOutput) {
			const config = { ...DEFAULT_MAX_OUTPUT, ...options.maxOutput };
			const truncationResult = truncateOutput(result.finalOutput ?? "", config);
			if (truncationResult.truncated) result.truncation = truncationResult;
		}
	} catch (error) {
		const message = `Artifact output post-processing failed: ${error instanceof Error ? error.message : String(error)}`;
		result.outputSaveError = result.outputSaveError ? `${result.outputSaveError}\n${message}` : message;
	}

	if (options.sessionFile && (existsSync(options.sessionFile) || result.messages?.length)) {
		result.sessionFile = options.sessionFile;
	} else if (shareEnabled && options.sessionDir) {
		const sessionFile = findLatestSessionFile(options.sessionDir);
		if (sessionFile) result.sessionFile = sessionFile;
	}

	const childWrittenOutput = options.outputPath
		? extractChildWrittenOutput(result.messages, options.outputPath, options.cwd ?? runtimeCwd)
		: undefined;
	try {
		if (result.interrupted && detachedReason === "user request") {
			// Only an accepted user-detach receipt needs a non-rejecting terminal
			// ledger. Attached and background execution retain their baseline
			// acceptance behavior.
			result.acceptance = buildInterruptedAcceptanceLedger(effectiveAcceptance);
		} else if (result.stopped) {
			result.acceptance = buildSkippedAcceptanceLedger(effectiveAcceptance, { id: "stopped", message: "Acceptance was not evaluated because the subagent was stopped." });
		} else if (result.timedOut) {
			result.acceptance = buildSkippedAcceptanceLedger(effectiveAcceptance, { id: "timeout", message: "Acceptance was not evaluated because the subagent timed out." });
		} else if (result.turnBudgetExceeded) {
			result.acceptance = buildSkippedAcceptanceLedger(effectiveAcceptance, { id: "turn-budget", message: "Acceptance was not evaluated because the subagent exceeded its turn budget." });
		} else {
			result.acceptance = await evaluateAcceptance({
				acceptance: effectiveAcceptance,
				output: acceptanceOutputByResult.get(result) ?? result.finalOutput ?? "",
				fileOutput: childWrittenOutput !== undefined && options.outputPath
					? { content: childWrittenOutput, path: options.outputPath, authoritative: options.outputMode === "file-only" }
					: undefined,
				cwd: options.cwd ?? runtimeCwd,
				reportOptional: isAgentContractV1(options.agentContract),
				artifactsDir: options.artifactsDir,
				runId: options.runId,
			});
		}
	} catch (error) {
		const message = `Acceptance evaluation failed: ${error instanceof Error ? error.message : String(error)}`;
		result.acceptance = buildSkippedAcceptanceLedger(effectiveAcceptance, { id: "acceptance-evaluation", message });
	}
	const acceptanceFailure = acceptanceFailureMessage(result.acceptance);
	stripAcceptanceReportsFromMessages(result.messages);
	if (acceptanceFailure && result.acceptance.explicit && result.exitCode === 0 && !result.interrupted && !result.timedOut && !isAgentContractV1(options.agentContract)) {
		result.exitCode = 1;
		result.error = result.error ? `${result.error}\n${acceptanceFailure}` : acceptanceFailure;
		if (result.progress) {
			result.progress.status = "failed";
			result.progress.error = result.error;
		}
	}
	if (isAgentContractV1(options.agentContract)) attachContractProjections(result);
	try {
		persistResultMetadata(result);
	} catch (error) {
		result.metadataSaveError = error instanceof Error ? error.message : String(error);
	}

	return result;
}

/**
 * Runs the authoritative completion pipeline independently from the foreground
 * receipt. Detachment is same-runtime only: it does not adopt or daemonize work.
 */
export async function runSync(
	runtimeCwd: string,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	options: RunSyncOptions,
): Promise<SingleResult> {
	// Capture the strict contract before consumer-owned objects can be mutated
	// after a detached receipt is published.
	const strictContract = isAgentContractV1(options.agentContract);
	let detachedReason: string | undefined;
	let publishedReceipt: SingleResult | undefined;
	let activeDetachAttempt: ((reason?: string) => boolean) | undefined;
	let detachReadyPublished = false;
	let resolveReceipt!: (result: SingleResult) => void;
	const receipt = new Promise<SingleResult>((resolve) => { resolveReceipt = resolve; });
	const originSignal = options.signal;
	const originController = new AbortController();
	const forwardOriginAbort = () => {
		if (!detachedReason) originController.abort(originSignal?.reason);
	};
	if (originSignal?.aborted) forwardOriginAbort();
	else originSignal?.addEventListener("abort", forwardOriginAbort, { once: true });

	const completion = runSyncCompletion(runtimeCwd, agents, agentName, task, {
		...options,
		signal: originController.signal,
		onDetachedExit: undefined,
		onDetachReceipt: (detachedReceipt) => {
			if (detachedReason || publishedReceipt) return false;
			// Keep the authoritative result, fallback snapshot, and caller receipt
			// separately owned while the completion pipeline remains live.
			publishedReceipt = structuredClone(detachedReceipt);
			const callerReceipt = structuredClone(detachedReceipt);
			// A strict contract was already validated before detach; normalize private
			// and caller snapshots to the only safely known version.
			publishedReceipt.agentContract = strictContract ? { version: 1 } : undefined;
			callerReceipt.agentContract = strictContract ? { version: 1 } : undefined;
			detachedReason = detachedReceipt.detachedReason ?? "user request";
			resolveReceipt(callerReceipt);
			return true;
		},
		onDetachReady: (detachAttempt) => {
			activeDetachAttempt = detachAttempt;
			if (detachReadyPublished) return;
			detachReadyPublished = true;
			options.onDetachReady?.((reason = "user request") => {
				if (detachedReason || originController.signal.aborted) return false;
				return activeDetachAttempt?.(reason) ?? false;
			});
		},
	});

	const authoritativeCompletion = completion.catch((error: unknown) => {
		if (!publishedReceipt || !detachedReason) throw error;
		const message = error instanceof Error ? error.message : String(error);
		const failureMessage = `Detached completion pipeline failed after receipt: ${message}`;
		const failedProgress: AgentProgress = publishedReceipt.progress
			? { ...publishedReceipt.progress, status: "failed", error: failureMessage }
			: {
				index: options.index ?? 0,
				agent: publishedReceipt.agent,
				status: "failed",
				task: publishedReceipt.task,
				recentTools: [],
				recentOutput: [],
				toolCount: publishedReceipt.progressSummary?.toolCount ?? 0,
				tokens: publishedReceipt.progressSummary?.tokens ?? 0,
				durationMs: publishedReceipt.progressSummary?.durationMs ?? 0,
				error: failureMessage,
			};
		const failedResult: SingleResult = {
			...publishedReceipt,
			detached: undefined,
			detachedReason,
			exitCode: 1,
			error: failureMessage,
			finalOutput: failureMessage,
			progress: failedProgress,
			progressSummary: {
				toolCount: failedProgress.toolCount,
				tokens: failedProgress.tokens,
				durationMs: failedProgress.durationMs,
			},
			acceptance: publishedReceipt.acceptance
				? buildSkippedAcceptanceLedger(publishedReceipt.acceptance.effectiveAcceptance, { id: "completion-pipeline", message: failureMessage })
				: undefined,
		};
		if (strictContract) attachContractProjections(failedResult);
		try {
			// Replace the provisional detach receipt metadata with the authoritative
			// terminal failure. Persistence remains best-effort and cannot orphan work.
			persistSingleResultMetadata({
				metadataPath: failedResult.artifactPaths?.metadataPath,
				enabled: options.artifactConfig?.enabled !== false && options.artifactConfig?.includeMetadata !== false,
				runId: options.runId,
				agent: failedResult.agent,
				task: failedResult.task,
				result: failedResult,
			});
		} catch (metadataError) {
			failedResult.metadataSaveError = metadataError instanceof Error ? metadataError.message : String(metadataError);
		}
		return failedResult;
	});

	let terminalCallbackInvoked = false;
	void authoritativeCompletion.then((terminalResult) => {
		if (!detachedReason || terminalCallbackInvoked) return;
		terminalCallbackInvoked = true;
		terminalResult.detached = undefined;
		terminalResult.detachedReason = detachedReason;
		try {
			options.onDetachedExit?.(terminalResult);
		} catch {
			// The authoritative result has settled. Consumer callback failures are
			// contained here; each consumer owns cleanup through its own finally block.
		}
	}).catch(() => {
		// Attached completion rejection remains observable through the returned
		// promise without becoming an unhandled side-channel rejection.
	}).finally(() => {
		originSignal?.removeEventListener("abort", forwardOriginAbort);
	});

	return Promise.race([authoritativeCompletion, receipt]);
}
