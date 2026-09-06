/**
 * Core execution logic for running subagents
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import { discoverAgents, formatUnknownAgentError, unknownAgentDiagnosticContext, type AgentConfig } from "../../agents/agents.ts";
import { appendAgentRefinementOverlay } from "../../agents/agent-refinements.ts";
import { alignForkedSessionCwd } from "../../shared/fork-session-cwd.ts";
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
} from "../../shared/types.ts";
import {
	DEFAULT_CONTROL_CONFIG,
	buildControlEvent,
	claimControlNotification,
	deriveActivityState,
	shouldEmitOpenToolAttention,
	shouldNotifyControlEvent,
} from "../shared/subagent-control.ts";
import {
	getFinalOutput,
	findLatestSessionFile,
	detectSubagentError,
	hasEmptyTerminalAssistantResponse,
	formatEmptyTerminalAssistantResponseError,
	extractToolArgsPreview,
	extractTextFromContent,
	MAX_STREAMED_RECENT_TOOLS,
	boundStreamedRecentTools,
	boundStreamedRecentOutput,
	boundStreamedToolCalls,
} from "../../shared/utils.ts";
import { buildSkillInjection, resolveSkillsWithFallback } from "../../agents/skills.ts";
import { buildAgentMemoryInjection } from "../../agents/agent-memory.ts";
import { effectiveToolTimeoutMs, formatToolTimeoutMessage, resolveToolTimeoutMs, toolTimeoutCallKey, toolTimeoutFromEnv } from "../shared/tool-timeout.ts";
import { evaluateCompletionMutationGuard, expectsImplementationMutation, hasMutationToolCapability, validateImplementationToolContract } from "../shared/completion-guard.ts";
import { planCompletionEvidence } from "../shared/completion-evidence.ts";
import { planAbortRecovery } from "../shared/abort-recovery.ts";
import { planReadonlyModelContinuation, type LogicalRecoveryState } from "../shared/readonly-model-continuation.ts";
import { getReadonlySessionEvidence, requestReadonlySessionEvidence, type SettledReadonlyEvidence } from "../shared/readonly-session-evidence.ts";
import { getReadonlyChildModels } from "../shared/child-session.ts";
import { arbitrateCompletionGuardRescue } from "../shared/llm-intent-arbiter.ts";
import { preflightLaunchCwd } from "../shared/launch-cwd.ts";
import { createJsonlWriter } from "../../shared/jsonl-writer.ts";
import { createOrcaProgressTab, type OrcaProgressTab } from "../shared/orca-progress-tabs.ts";
import { resolvePermissionRules } from "../shared/permissions.ts";
import { applyThinkingSuffix, deriveForkPromptCacheKey } from "../shared/child-tool-plan.ts";
import { deriveChildSessionName } from "../../shared/child-session-name.ts";
import { assertAgentAllowedByCapabilityCeiling, intersectSubagentCapabilityCeilings, resolveCurrentSubagentCapabilityCeiling } from "../shared/capability-ceiling.ts";
import { resolveEffectiveThinking } from "../../shared/model-info.ts";
import { assertThinkingWithinCeiling, intersectThinkingCeilings } from "../../shared/thinking-ceiling.ts";
import { MISSING_STRUCTURED_ACCEPTANCE_REPORT_ERROR, MISSING_STRUCTURED_OUTPUT_CALL_ERROR } from "../shared/structured-output.ts";
import { formatMidToolExitError, isOrdinaryToolForMidToolExit } from "../shared/process-signal.ts";
import { formatChildToolDiagnostic } from "../shared/tool-availability.ts";
import { buildTimeoutRecoverySummary, collectTrackedMutationEvidence, snapshotTrackedMutations } from "../shared/mutation-evidence.ts";
import { captureSingleOutputSnapshot, extractChildWrittenOutput, finalizeSingleOutput, formatSavedOutputReference, hasSingleOutputChangedSinceSnapshot, injectOutputPathSystemPrompt, resolveSingleOutput, validateFileOnlyOutputMode, type SingleOutputSnapshot } from "../shared/single-output.ts";
import {
	buildModelCandidates,
	formatSubagentModelVerificationError,
	formatModelAttemptNote,
	isContextOverflow,
	isRetryableModelFailureAttempt,
	recordRetryableModelFailure,
} from "../shared/model-fallback.ts";
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
import { PROMPT_REDACTED } from "../../shared/utils.ts";
import { attachContractProjections, isAgentContract } from "../shared/agent-contract.ts";
import { initialToolBudgetState, toolBudgetState } from "../shared/tool-budget.ts";
import { resolveWatchdogConfig } from "../../watchdog/settings.ts";
import { agentDefinitionDigest, launchBindingDigest } from "../../shared/launch-contract.ts";
import { consumeWorkflowChildPermit } from "../../shared/workflow-child-permit.ts";
import { projectChildLifecycle, type ChildLifecycleAction, type ChildLifecycleState } from "../shared/child-lifecycle.ts";
import {
	acceptChildWatchdogEvent,
	applyChildWatchdogMessage,
	childWatchdogIsActive,
	isChildWatchdogStatusEvent,
	resolveChildWatchdogConfig,
	type ChildWatchdogStateSnapshot,
	type ChildWatchdogStatusEvent,
} from "../../watchdog/child-status.ts";
import { buildInProcessChildLaunch, createReportedChildSessionInput } from "../shared/child-launch.ts";
import { childSessionFactory, projectChildSessionEventForJson, type ChildSession, type ChildSessionEvent } from "../shared/child-session.ts";

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

function redactResultPrompt<T extends SingleResult>(result: T): T {
	result.task = PROMPT_REDACTED;
	if (result.progress) result.progress.task = PROMPT_REDACTED;
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
		task: PROMPT_REDACTED,
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
		task: PROMPT_REDACTED,
		skills: progress.skills ? [...progress.skills] : undefined,
		recentTools: boundStreamedRecentTools(progress.recentTools),
		recentOutput: boundStreamedRecentOutput(progress.recentOutput),
	};
}

function snapshotResult(result: SingleResult, progress: AgentProgress): SingleResult {
	return {
		...result,
		task: PROMPT_REDACTED,
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
 * single `tool_execution_update` event stays small; the parent records every
 * one in its transcript and `events.jsonl`. Non-streaming consumers such as
 * foreground detach receipts and terminal consumers use snapshotResult directly.
 */
function snapshotStreamResult(result: SingleResult, progress: AgentProgress): SingleResult {
	const snapshot = snapshotResult(result, progress);
	snapshot.messages = undefined;
	snapshot.toolCalls = boundStreamedToolCalls(result);
	return snapshot;
}

interface StructuredDelegationProgressState {
	currentTool?: string;
	currentToolArgs?: string;
	recentOutput: string[];
	recentTools: Array<{ tool: string; args: string }>;
	activityState?: AgentProgress["activityState"];
	model?: string;
	toolCount: number;
	tokens: number;
}

function captureStructuredDelegationProgressState(progress: AgentProgress, result: SingleResult): StructuredDelegationProgressState {
	return {
		currentTool: progress.currentTool,
		currentToolArgs: progress.currentToolArgs,
		recentOutput: [...progress.recentOutput],
		recentTools: progress.recentTools.slice(-MAX_STREAMED_RECENT_TOOLS).map(({ tool, args }) => ({ tool, args })),
		activityState: progress.activityState,
		model: progress.model ?? result.model,
		toolCount: progress.toolCount,
		tokens: progress.tokens,
	};
}

function structuredDelegationProgressChanged(
	previous: StructuredDelegationProgressState,
	progress: AgentProgress,
	result: SingleResult,
): boolean {
	if (previous.currentTool !== progress.currentTool
		|| previous.currentToolArgs !== progress.currentToolArgs
		|| previous.activityState !== progress.activityState
		|| previous.model !== (progress.model ?? result.model)
		|| previous.toolCount !== progress.toolCount
		|| previous.tokens !== progress.tokens
		|| previous.recentOutput.length !== progress.recentOutput.length) return true;
	for (let index = 0; index < progress.recentOutput.length; index++) {
		if (previous.recentOutput[index] !== progress.recentOutput[index]) return true;
	}
	const recentToolsStart = Math.max(0, progress.recentTools.length - MAX_STREAMED_RECENT_TOOLS);
	if (previous.recentTools.length !== progress.recentTools.length - recentToolsStart) return true;
	for (let index = recentToolsStart; index < progress.recentTools.length; index++) {
		const previousTool = previous.recentTools[index - recentToolsStart];
		const currentTool = progress.recentTools[index];
		if (previousTool?.tool !== currentTool?.tool || previousTool?.args !== currentTool?.args) return true;
	}
	return false;
}

const AFTER_COMPACTION_SETTLEMENT = Symbol("afterCompactionSettlement");
type AbortRecoverySingleResult = SingleResult & { [AFTER_COMPACTION_SETTLEMENT]?: true };
const settledReadonlySource = new WeakMap<SingleResult, ChildSession>();

const STOPPED_BEFORE_COMPLETION_ERROR = "Subagent stopped before completion.";


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
		orcaProgressTab?: OrcaProgressTab;
		launchWarnings: { emitted: boolean };
		verifyModel: boolean;
		readonlyExpected?: SettledReadonlyEvidence;
		readonlyModel?: string;
		readonlyHandoffAllowed?: () => boolean;
	},
): Promise<SingleResult> {
	const effectiveThinking = options.thinkingOverride ?? agent.thinking;
	const modelArg = applyThinkingSuffix(model, effectiveThinking, options.thinkingOverride !== undefined);
	assertThinkingWithinCeiling({ model: modelArg, configThinking: effectiveThinking, ceiling: options.thinkingCeiling, agent: agent.name, runId: options.runId });
	const expectedModelForVerification = shared.verifyModel ? modelArg : undefined;
	const resolvedThinking = resolveEffectiveThinking(modelArg, effectiveThinking);
	// Display name for the child session: applied inside the child through its
	// runtime config and echoed back on the result payload so hosts can label
	// this run without reading the child's session file.
	const childSessionName = deriveChildSessionName({ agent: agent.name, task: shared.originalTask ?? task });
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
	let onWatchdogStatus: ((event: ChildWatchdogStatusEvent) => void) | undefined;
	const launch = buildInProcessChildLaunch({
		sessionEnabled: shared.sessionEnabled,
		sessionDir: options.sessionDir,
		sessionFile: options.sessionFile,
		model: modelArg,
		systemPromptMode: agent.systemPromptMode,
		inheritProjectContext: agent.inheritProjectContext,
		inheritGlobalContext: agent.inheritGlobalContext,
		inheritSkills: agent.inheritSkills,
		requireReadTool: Boolean(shared.resolvedSkillNames?.length),
		tools: agent.tools,
		excludeTools: agent.excludeTools,
		allowNestedSubagents: agent.allowNestedSubagents,
		extensions: agent.extensions,
		subagentOnlyExtensions: agent.subagentOnlyExtensions,
		systemPrompt: shared.systemPrompt,
		mcpDirectTools: agent.mcpDirectTools,
		cwd: options.cwd ?? runtimeCwd,
		intercomSessionName: options.intercomSessionName,
		sessionName: childSessionName,
		orchestratorIntercomTarget: options.orchestratorIntercomTarget,
		runId: options.runId,
		childAgentName: agent.name,
		childIndex: options.index ?? 0,
		nestedRoute: options.nestedRoute,
		runFanoutBudget: options.runFanoutBudget,
		parentSessionId: options.parentSessionId,
		forkCacheKey: options.context === "fork" ? deriveForkPromptCacheKey(options.parentSessionId) : undefined,
		structuredOutput: options.structuredOutput,
		fast: options.fast ?? agent.fast,
		modelCandidates: shared.modelCandidates,
		toolBudget: options.toolBudget,
		permissionRules,
		permissionAuditPath,
		childWatchdog,
		// registerChildWatchdog returns before reading the sink when no watchdog exists.
		watchdogStatus: childWatchdog ? (event) => onWatchdogStatus?.(event) : undefined,
		waitToolEnabled: options.waitToolEnabled,
		waitToolDefaultTimeoutMs: options.waitToolDefaultTimeoutMs,
		capabilityCeiling: options.capabilityCeiling,
		thinkingCeiling: options.thinkingCeiling,
		maxSubagentDepth: options.maxSubagentDepth,
		runtimeSnapshotHost: options.runtimeSnapshotHost,
		inherited: options.childRuntime,
		host: "parent",
	});
	const { toolPlan, capabilityAudit, warnings, launchResolvedExtensions, capture } = launch;
	if (!shared.launchWarnings.emitted && warnings.length > 0) {
		for (const warning of warnings) console.warn(`[pi-subagents] ${warning}`);
		shared.launchWarnings.emitted = true;
	}

	const effectiveSystemPrompt = shared.systemPrompt;
	const contractTools = toolPlan.explicitToolAllowlist ? toolPlan.effectiveToolAllowlist : undefined;
	const contractError = validateImplementationToolContract({
		agent: agent.name,
		task: shared.originalTask ?? task,
		tools: contractTools,
		mcpDirectTools: toolPlan.effectiveMcpTools,
		configuredExtensions: toolPlan.configuredExtensions,
		requestedTools: toolPlan.requestedBuiltinTools,
		acceptanceRole: agent.acceptanceRole,
		completionGuard: agent.completionGuard,
	});
	if (contractError) {
		return {
			index: options.index ?? 0,
			agent: agent.name,
			task,
			...(childSessionName ? { sessionName: childSessionName } : {}),
			messages: [],
			finalOutput: "",
			exitCode: 1,
			error: contractError,
			usage: emptyUsage(),
			model: modelArg,
			modelAttempts: [],
			attemptedModels: [],
			progressSummary: { status: "failed", toolCount: 0, tokens: 0, durationMs: 0 },
			...(toolPlan.capabilityCeiling ? { capabilityCeiling: toolPlan.capabilityCeiling } : {}),
			...(toolPlan.capabilityAudit ? { capabilityAudit: toolPlan.capabilityAudit } : {}),
		};
	}
	const launchContractDigest = launchBindingDigest({
		definitionDigest: agentDefinitionDigest(agent),
		task: shared.originalTask ?? task,
		...(modelArg ? { model: modelArg } : {}),
		modelCandidates: shared.modelCandidates,
		...((options.fast ?? agent.fast) !== undefined ? { fast: options.fast ?? agent.fast } : {}),
		...(resolvedThinking ? { thinking: resolvedThinking } : {}),
		...(options.thinkingCeiling ? { thinkingCeiling: options.thinkingCeiling } : {}),
		systemPrompt: effectiveSystemPrompt,
		systemPromptMode: agent.systemPromptMode,
		inheritProjectContext: agent.inheritProjectContext,
		inheritGlobalContext: agent.inheritGlobalContext,
		inheritSkills: agent.inheritSkills,
		skills: shared.resolvedSkillNames ?? [],
		tools: toolPlan.effectiveToolAllowlist,
		...(toolPlan.excludeTools.length > 0 ? { excludeTools: toolPlan.excludeTools } : {}),
		extensions: toolPlan.extensionArgs,
		mcpDirectTools: toolPlan.effectiveMcpTools,
		...(options.outputPath ? { outputPath: options.outputPath } : {}),
		outputMode: options.outputMode ?? "inline",
		...(options.structuredOutput ? { structuredOutputSchema: options.structuredOutput.schema } : {}),
		...(options.extensionBindings ? { extensionBindings: options.extensionBindings } : {}),
	});
	const result: SingleResult = withRunContext({
		index: options.index ?? 0,
		agent: agent.name,
		task: shared.originalTask ?? task,
		...(childSessionName ? { sessionName: childSessionName } : {}),
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
		...(options.toolBudget ? { toolBudget: initialToolBudgetState(options.toolBudget) } : {}),
		...(options.capabilityCeiling ? { capabilityCeiling: options.capabilityCeiling } : {}),
		...(capabilityAudit ? { capabilityAudit } : {}),
	}, options.context);
	const startTime = Date.now();
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
		...(childSessionName ? { sessionName: childSessionName } : {}),
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
	const mutationSnapshot = snapshotTrackedMutations(options.cwd ?? runtimeCwd);
	let observedMutationAttempt = false;
	let structuredOutputToolInvoked = false;
	let structuredOutputMessageStartIndex: number | undefined;
	let toolAvailabilityError: string | undefined;
	let abortedBySignal = options.signal?.aborted === true;

	if (options.workflowChildPermitLaunch) {
		const permitError = consumeWorkflowChildPermit(options.workflowChildPermitLaunch.permit, {
			workflowRunId: options.workflowChildPermitLaunch.workflowRunId,
			childKey: options.workflowChildPermitLaunch.childKey,
			agent: agent.name,
			launchContractDigest,
			context: options.context ?? "fresh",
			runner: "pi",
		});
		if (permitError) {
			result.exitCode = 1;
			result.error = permitError;
			result.finalOutput = permitError;
			progress.status = "failed";
			progress.error = permitError;
			return result;
		}
	}
	const childSessions = options.childSessionFactory ?? childSessionFactory();
	let afterCompactionSettlement = false;
	const exitCode = await new Promise<number>((resolve) => {
		const jsonlWriter = createJsonlWriter(shared.jsonlPath, { pause() {}, resume() {} });
		let session: ChildSession | undefined;
		let unsubscribe: (() => void) | undefined;
		let sessionSettled = false;
		let lifecycleFinished = false;
		let detached = false;
		let intercomStarted = false;
		let assistantError: string | undefined;
		let removeAbortListener: (() => void) | undefined;
		let removeInterruptListener: (() => void) | undefined;
		let activityTimer: NodeJS.Timeout | undefined;
		let timeoutTimer: NodeJS.Timeout | undefined;
		let timeoutHardFinishTimer: NodeJS.Timeout | undefined;
		const clearTimeoutTimers = () => {
			if (timeoutTimer) {
				clearTimeout(timeoutTimer);
				timeoutTimer = undefined;
			}
			if (timeoutHardFinishTimer) {
				clearTimeout(timeoutHardFinishTimer);
				timeoutHardFinishTimer = undefined;
			}
		};
		const abortChild = (): void => {
			if (!session || sessionSettled || lifecycleFinished) return;
			void session.abort().catch(() => {
				// The session settles through its prompt promise; abort failures are not separately actionable.
			});
		};

		const detachForeground = (reason: string): boolean => {
			if (detached || sessionSettled || lifecycleFinished || options.signal?.aborted) return false;
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
			if (session) session.detached = true;
			return true;
		};

		// If the child emits a terminal assistant stop but its run never settles
		// (a hook is stuck), abort it after a short grace period and then finish
		// without it.
		const FINAL_STOP_GRACE_MS = 1000;
		const HARD_FINISH_MS = 3000;
		let forcedTermination = false;
		let cleanTerminalAssistantStopReceived = false;
		let agentSettledReceived = false;
		let compactionStartedReceived = false;
		let finalDrainTimer: NodeJS.Timeout | undefined;
		let finalHardFinishTimer: NodeJS.Timeout | undefined;
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
			if (finalHardFinishTimer) {
				clearTimeout(finalHardFinishTimer);
				finalHardFinishTimer = undefined;
			}
		};
		const startFinalDrain = () => {
			if (childWatchdogIsActive(childWatchdogState)) {
				armWatchdogTail();
				return;
			}
			if (sessionSettled || finalDrainTimer || lifecycleFinished) return;
			finalDrainTimer = setTimeout(() => {
				if (lifecycleFinished || sessionSettled) return;
				forcedTermination = true;
				if (!cleanTerminalAssistantStopReceived && !agentSettledReceived && !assistantError) {
					result.error = result.error ?? `Subagent session did not settle within ${FINAL_STOP_GRACE_MS}ms after its terminal event. Aborting it.`;
				}
				abortChild();
				finalHardFinishTimer = setTimeout(() => {
					if (lifecycleFinished || sessionSettled) return;
					settle(undefined, true);
				}, HARD_FINISH_MS);
				finalHardFinishTimer.unref?.();
			}, FINAL_STOP_GRACE_MS);
			finalDrainTimer.unref?.();
		};
		function armWatchdogTail(): void {
			if ((!cleanTerminalAssistantStopReceived && !agentSettledReceived) || watchdogTailTimer || lifecycleFinished || sessionSettled) return;
			watchdogTailTimer = setTimeout(() => {
				watchdogTailTimer = undefined;
				updateChildWatchdogState({
					phase: "stale",
					seq: (childWatchdogState?.seq ?? 0) + 1,
					lastUpdate: Date.now(),
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
		const childLifecycleState: ChildLifecycleState = { compactionRetryActive: false };

		const unsubscribeIntercomDetach = options.intercomEvents?.on?.(INTERCOM_DETACH_REQUEST_EVENT, (payload) => {
			if (!options.allowIntercomDetach || sessionSettled) return;
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
			clearTimeoutTimers();
			clearAllToolTimeouts();
			if (activityTimer) {
				clearInterval(activityTimer);
				activityTimer = undefined;
			}
			unsubscribeIntercomDetach?.();
			removeAbortListener?.();
			removeInterruptListener?.();
			unsubscribe?.();
			onWatchdogStatus = undefined;
			void jsonlWriter.close().catch(() => {
				// JSONL artifact flush is best effort.
			});
			// Report the run only after the child's extensions have shut down.
			void Promise.resolve().then(() => session?.dispose()).catch(() => undefined).then(() => {
				if (session && getReadonlySessionEvidence(session)) settledReadonlySource.set(result, session);
				resolve(code);
			});
		};

		const drainPendingControlEvents = (): ControlEvent[] | undefined => {
			if (pendingControlEvents.length === 0) return undefined;
			const events = pendingControlEvents;
			pendingControlEvents = [];
			return events;
		};

		let activeLongRunningNotified = false;
		let pendingToolResult: { tool: string; path?: string; mutates: boolean; startedAt?: number } | undefined;
		type ActiveToolCall = { key: string; tool: string; args: string; startedAt: number; path?: string };
		let activeToolSequence = 0;
		const activeToolCalls = new Map<string, ActiveToolCall>();
		const activeToolKeysByName = new Map<string, string[]>();
		const latestActiveToolCall = (): ActiveToolCall | undefined => [...activeToolCalls.values()].sort((left, right) => right.startedAt - left.startedAt)[0];
		const refreshCurrentTool = (): void => {
			const active = latestActiveToolCall();
			if (!active) {
				progress.currentTool = undefined;
				progress.currentToolArgs = undefined;
				progress.currentToolStartedAt = undefined;
				progress.currentPath = undefined;
				return;
			}
			progress.currentTool = active.tool;
			progress.currentToolArgs = active.args;
			progress.currentToolStartedAt = active.startedAt;
			progress.currentPath = active.path;
		};
		const recordActiveToolCall = (event: { toolCallId?: unknown; toolName: string }, args: Record<string, unknown>, now: number): ActiveToolCall => {
			const key = toolTimeoutCallKey(event, ++activeToolSequence);
			const path = resolveCurrentPath(event.toolName, args);
			const active: ActiveToolCall = {
				key,
				tool: event.toolName,
				args: extractToolArgsPreview(args),
				startedAt: now,
				...(path !== undefined ? { path } : {}),
			};
			activeToolCalls.set(key, active);
			const keys = activeToolKeysByName.get(active.tool) ?? [];
			keys.push(key);
			activeToolKeysByName.set(active.tool, keys);
			refreshCurrentTool();
			return active;
		};
		const removeActiveToolCallKey = (key: string): ActiveToolCall | undefined => {
			const active = activeToolCalls.get(key);
			if (!active) return undefined;
			activeToolCalls.delete(key);
			const keys = activeToolKeysByName.get(active.tool)?.filter((candidate) => candidate !== key) ?? [];
			if (keys.length > 0) activeToolKeysByName.set(active.tool, keys);
			else activeToolKeysByName.delete(active.tool);
			return active;
		};
		const removeActiveToolCall = (event: { toolCallId?: unknown; toolName?: unknown }): ActiveToolCall | undefined => {
			const key = typeof event.toolCallId === "string" && event.toolCallId.length > 0
				? `id:${event.toolCallId}`
				: typeof event.toolName === "string"
					? activeToolKeysByName.get(event.toolName)?.[0]
					: activeToolCalls.size === 1
						? [...activeToolCalls.keys()][0]
						: undefined;
			return key ? removeActiveToolCallKey(key) : undefined;
		};
		const openToolAttentionTarget = (now: number): ActiveToolCall | undefined => [...activeToolCalls.values()]
			.filter((active) => shouldEmitOpenToolAttention({ config: controlConfig, currentTool: active.tool, currentToolStartedAt: active.startedAt, now }))
			.sort((left, right) => left.startedAt - right.startedAt)[0];
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
				taskPreview: task,
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
				taskPreview: task,
			}));
			return true;
		};
		const updateActivityState = (now: number): boolean => {
			if (!controlConfig.enabled) return false;
			const idleState = deriveActivityState({
				config: controlConfig,
				startedAt: startTime,
				lastActivityAt: progress.lastActivityAt,
				turnCount: progress.turnCount,
				currentTool: progress.currentTool,
				thinking: resolvedThinking,
				now,
			});
			if (idleState === "needs_attention") {
				return progress.activityState === "needs_attention" ? false : emitNeedsAttention(now);
			}
			const toolAttentionTarget = progress.activityState !== "needs_attention" ? openToolAttentionTarget(now) : undefined;
			if (toolAttentionTarget) {
				const durationMs = Math.max(0, now - toolAttentionTarget.startedAt);
				return emitNeedsAttention(now, {
					message: `${agent.name} has had tool '${toolAttentionTarget.tool}' open for ${Math.floor(durationMs / 1000)}s`,
					reason: "tool_open_threshold",
					currentTool: toolAttentionTarget.tool,
					currentPath: toolAttentionTarget.path,
					currentToolDurationMs: durationMs,
				});
			}
			const activeReason = nextLongRunningTrigger(controlConfig, {
				startedAt: startTime,
				now,
				turns: result.usage.turns,
				tokens: progress.tokens,
			});
			return activeReason ? emitActiveLongRunning(now, activeReason) : false;
		};


		let lastStructuredDelegationProgressState: StructuredDelegationProgressState | undefined;
		const emitUpdateSnapshot = (text: string) => {
			if (!options.onUpdate || sessionSettled) return;
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
			if (!options.onUpdate || sessionSettled) return;
			progress.durationMs = Date.now() - startTime;
			if (options.suppressUnchangedDelegationUpdates) {
				if (lastStructuredDelegationProgressState && !structuredDelegationProgressChanged(lastStructuredDelegationProgressState, progress, result)) return;
				lastStructuredDelegationProgressState = captureStructuredDelegationProgressState(progress, result);
			}
			const output = result.timedOut && result.finalOutput ? result.finalOutput : getFinalOutput(result.messages ?? []);
			emitUpdateSnapshot(output || "(running...)");
		};

		const processEvent = (evt: ChildSessionEvent & { message?: Message; toolName?: string; toolCallId?: string; args?: unknown; willRetry?: unknown }) => {
			if (lifecycleFinished) return;
			jsonlWriter.writeLine(JSON.stringify(projectChildSessionEventForJson(evt)));
			shared.transcriptWriter?.writeChildEvent(evt);
			shared.orcaProgressTab?.event(evt);
			if (evt.type === "compaction_start") compactionStartedReceived = true;
			if (evt.type === "compaction_end" && evt.willRetry === true) {
				compactionStartedReceived = false;
				afterCompactionSettlement = false;
			}
			if (evt.type === "agent_start" || evt.type === "auto_retry_start") {
				compactionStartedReceived = false;
				afterCompactionSettlement = false;
			}
			if (evt.type === "agent_start") {
				const diagnostic = capture.toolDiagnostic();
				if (diagnostic) {
					const message = formatChildToolDiagnostic(diagnostic, { host: "parent" });
					toolAvailabilityError = message;
					result.error = message;
					result.finalOutput = message;
					progress.status = "failed";
					progress.error = message;
					fireUpdate();
					abortChild();
					return;
				}
			}
			const lifecycleAction = projectChildLifecycle(evt, false, childLifecycleState);
			if (evt.type === "agent_settled" && lifecycleAction === "start-drain") {
				agentSettledReceived = true;
				afterCompactionSettlement = compactionStartedReceived;
			}
			applyChildLifecycle(lifecycleAction);

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
				const activeTool = evt.toolName !== undefined ? recordActiveToolCall(evt as { toolCallId?: unknown; toolName: string }, toolArgs, now) : undefined;
				if (evt.toolName !== undefined) armToolTimeout(evt as { toolCallId?: unknown; toolName: string });
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
				const mutates = isMutatingTool(evt.toolName, toolArgs, agent.mutationTools);
				observedMutationAttempt = observedMutationAttempt || mutates;
				pendingToolResult = { tool: evt.toolName ?? "tool", path: activeTool?.path, mutates, startedAt: now };
				fireUpdate();
			}

			if (evt.type === "tool_execution_end") {
				clearActiveToolTimeout(evt);
				const endedTool = removeActiveToolCall(evt);
				if (endedTool) {
					progress.recentTools.push({
						tool: endedTool.tool,
						args: endedTool.args,
						endMs: now,
					});
				}
				refreshCurrentTool();
				fireUpdate();
			}

			if (evt.type === "message_end" && evt.message) {
				result.messages!.push(evt.message);
				if (childWatchdog) {
					const next = applyChildWatchdogMessage(childWatchdogState, evt.message);
					if (next) updateChildWatchdogState(next);
				}
				if (evt.message.role === "assistant") {
					result.usage.turns++;
					progress.turnCount = result.usage.turns;
					const toolCalls = Array.isArray(evt.message.content)
						? evt.message.content.filter((part) => (part as { type?: string }).type === "toolCall")
						: [];
					const hasToolCall = toolCalls.length > 0;
					const terminalAssistantStop = (evt.message as { stopReason?: string }).stopReason === "stop" && !hasToolCall;
					const u = evt.message.usage;
					if (u) {
						const window = (u.input || 0) + (u.cacheRead || 0);
						result.usage.input += u.input || 0;
						result.usage.output += u.output || 0;
						result.usage.cacheRead += u.cacheRead || 0;
						result.usage.cacheWrite += u.cacheWrite || 0;
						result.usage.cost += u.cost?.total || 0;
						progress.tokens = result.usage.input + result.usage.output;
						progress.inputTokens = result.usage.input;
						progress.outputTokens = result.usage.output;
						progress.window = window;
						progress.windowPeak = Math.max(progress.windowPeak ?? 0, window);
					}
					if (evt.message.model) {
						progress.model = evt.message.model;
						if (!result.model) result.model = evt.message.model;
						if (expectedModelForVerification && !hasToolCall) {
							const modelVerificationError = formatSubagentModelVerificationError(expectedModelForVerification, evt.message.model, options.availableModels, options.modelResponseAliases);
							if (modelVerificationError && !result.error) result.error = modelVerificationError;
						}
					}
					if (evt.message.errorMessage) assistantError = evt.message.errorMessage;
					else if (hasToolCall && evt.message.stopReason === "toolUse") {
						// A recovered request can finish via a terminating tool, without a text stop.
						assistantError = undefined;
					}
					const assistantText = extractTextFromContent(evt.message.content);
					appendRecentOutput(progress, assistantText.split("\n").slice(-10));
					// Final assistant message: start the settle drain window.
					if (terminalAssistantStop) {
						if (!evt.message.errorMessage && assistantText.trim()) assistantError = undefined;
						cleanTerminalAssistantStopReceived ||= !evt.message.errorMessage;
						clearAllToolTimeouts();
						activeToolCalls.clear();
						activeToolKeysByName.clear();
						refreshCurrentTool();
						applyChildLifecycle(projectChildLifecycle(evt, true, childLifecycleState));
					}
				}
				updateActivityState(now);
				fireUpdate();
			}

			if (evt.type === "tool_result_end" && evt.message) {
				const toolResultCompletion = {
					toolCallId: (evt.message as { toolCallId?: unknown }).toolCallId ?? (evt as { toolCallId?: unknown }).toolCallId,
					toolName: (evt.message as { toolName?: unknown }).toolName ?? (evt as { toolName?: unknown }).toolName,
				};
				clearActiveToolTimeout(toolResultCompletion);
				const endedTool = removeActiveToolCall(toolResultCompletion);
				if (endedTool) {
					progress.recentTools.push({
						tool: endedTool.tool,
						args: endedTool.args,
						endMs: now,
					});
					refreshCurrentTool();
				}
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
		onWatchdogStatus = (event) => processEvent(event as unknown as Parameters<typeof processEvent>[0]);

		fireUpdate();
		if (controlConfig.enabled || options.onUpdate) {
			activityTimer = setInterval(() => {
				if (sessionSettled || lifecycleFinished) {
					return;
				}
				updateActivityState(Date.now());
				fireUpdate();
			}, 1000);
			activityTimer.unref?.();
		}

		if (attemptTimeout) {
			timeoutTimer = setTimeout(() => {
				if (sessionSettled || lifecycleFinished || interruptedByControl) return;
				result.timedOut = true;
				clearAllToolTimeouts();
				result.error = attemptTimeout.message;
				result.finalOutput = attemptTimeout.message;
				progress.status = "failed";
				progress.error = attemptTimeout.message;
				progress.durationMs = Date.now() - startTime;
				fireUpdate();
				abortChild();
				timeoutHardFinishTimer = setTimeout(() => {
					if (sessionSettled || lifecycleFinished) return;
					settle(undefined, true);
				}, 4000);
				timeoutHardFinishTimer.unref?.();
			}, attemptTimeout.remainingMs);
			timeoutTimer.unref?.();
		}

		let toolTimeoutSequence = 0;
		const activeToolTimeouts = new Map<string, { toolName: string; timer: ReturnType<typeof setTimeout> }>();
		const activeToolTimeoutKeysByName = new Map<string, string[]>();
		let toolTimeoutHardFinishTimer: ReturnType<typeof setTimeout> | undefined;
		const removeToolTimeoutKey = (key: string): void => {
			const active = activeToolTimeouts.get(key);
			if (!active) return;
			clearTimeout(active.timer);
			activeToolTimeouts.delete(key);
			const keys = activeToolTimeoutKeysByName.get(active.toolName)?.filter((candidate) => candidate !== key) ?? [];
			if (keys.length > 0) activeToolTimeoutKeysByName.set(active.toolName, keys);
			else activeToolTimeoutKeysByName.delete(active.toolName);
		};
		const clearActiveToolTimeout = (event: { toolCallId?: unknown; toolName?: unknown }): void => {
			const key = typeof event.toolCallId === "string" && event.toolCallId.length > 0
				? `id:${event.toolCallId}`
				: typeof event.toolName === "string"
					? activeToolTimeoutKeysByName.get(event.toolName)?.[0]
					: activeToolTimeouts.size === 1
						? [...activeToolTimeouts.keys()][0]
						: undefined;
			if (key) removeToolTimeoutKey(key);
		};
		const clearAllToolTimeouts = (): void => {
			for (const key of [...activeToolTimeouts.keys()]) removeToolTimeoutKey(key);
			if (toolTimeoutHardFinishTimer) {
				clearTimeout(toolTimeoutHardFinishTimer);
				toolTimeoutHardFinishTimer = undefined;
			}
		};
		const terminateForToolTimeout = (message: string): void => {
			if (sessionSettled || lifecycleFinished || interruptedByControl) return;
			result.timedOut = true;
			result.error = message;
			result.finalOutput = message;
			progress.status = "failed";
			progress.error = message;
			progress.durationMs = Date.now() - startTime;
			fireUpdate();
			abortChild();
			toolTimeoutHardFinishTimer = setTimeout(() => {
				if (sessionSettled || lifecycleFinished) return;
				settle(undefined, true);
			}, 4000);
			toolTimeoutHardFinishTimer.unref?.();
		};
		const armToolTimeout = (event: { toolCallId?: unknown; toolName: string }): void => {
			const timeoutForTool = effectiveToolTimeoutMs(event.toolName, options.toolTimeoutMs);
			if (timeoutForTool === undefined) return;
			const elapsed = Date.now() - startTime;
			const runRemaining = attemptTimeout ? Math.max(0, attemptTimeout.remainingMs - elapsed) : undefined;
			if (runRemaining !== undefined && timeoutForTool >= runRemaining) return;
			const key = toolTimeoutCallKey(event, ++toolTimeoutSequence);
			const toolName = event.toolName;
			const timer = setTimeout(() => {
				removeToolTimeoutKey(key);
				terminateForToolTimeout(formatToolTimeoutMessage(toolName, timeoutForTool));
			}, timeoutForTool);
			timer.unref?.();
			activeToolTimeouts.set(key, { toolName, timer });
			const keys = activeToolTimeoutKeysByName.get(toolName) ?? [];
			keys.push(key);
			activeToolTimeoutKeysByName.set(toolName, keys);
		};

		/** The child run ended (or was forced to end); fold in the captures and finish. */
		const settle = (promptError: unknown, forced = false): void => {
			if (lifecycleFinished || sessionSettled) return;
			sessionSettled = true;
			clearFinalDrainTimers();
			const diagnostic = capture.toolDiagnostic();
			const toolDiagnosticError = diagnostic ? formatChildToolDiagnostic(diagnostic, { host: "parent" }) : undefined;
			toolAvailabilityError = toolDiagnosticError;
			result.runtimeAcknowledgedExtensions = capture.runtimeAcknowledgedExtensions();
			let closeError = result.error ?? toolDiagnosticError ?? assistantError;
			if (!closeError && promptError !== undefined) {
				closeError = promptError instanceof Error ? promptError.message : String(promptError);
			}
			const forcedDrainAfterFinalSuccess = (forced || forcedTermination) && (cleanTerminalAssistantStopReceived || agentSettledReceived) && !closeError;
			const forcedDrainAfterEmptyTerminal = forcedDrainAfterFinalSuccess && hasEmptyTerminalAssistantResponse(result.messages ?? []);
			if (!closeError && (abortedBySignal || session?.shutDown) && !result.interrupted && !result.timedOut) {
				closeError = session?.shutDown ? "Subagent stopped because the parent session shut down." : STOPPED_BEFORE_COMPLETION_ERROR;
			}
			if (!closeError && forced && !forcedDrainAfterFinalSuccess) {
				closeError = "Subagent session did not settle after it was aborted.";
			}
			const finalCode = forcedDrainAfterFinalSuccess && !forcedDrainAfterEmptyTerminal ? 0 : closeError || promptError !== undefined ? 1 : 0;
			if (!result.error && closeError) result.error = closeError;
			finish(finalCode);
		};

		if (options.signal) {
			const kill = () => {
				if (sessionSettled || lifecycleFinished) return;
				abortedBySignal = true;
				abortChild();
				const hardTimer = setTimeout(() => {
					if (sessionSettled || lifecycleFinished) return;
					settle(undefined, true);
				}, 3000);
				hardTimer.unref?.();
			};
			if (options.signal.aborted) kill();
			else {
				options.signal.addEventListener("abort", kill, { once: true });
				removeAbortListener = () => options.signal?.removeEventListener("abort", kill);
			}
		}

		if (options.interruptSignal) {
			const interrupt = () => {
				if (sessionSettled || lifecycleFinished) return;
				if (result.timedOut) return;
				interruptedByControl = true;
				clearTimeoutTimers();
				clearAllToolTimeouts();
				progress.status = "running";
				progress.durationMs = Date.now() - startTime;
				result.interrupted = true;
				result.finalOutput = "Interrupted. Waiting for explicit next action.";
				progress.activityState = undefined;
				fireUpdate();
				abortChild();
				const hardTimer = setTimeout(() => {
					if (sessionSettled || lifecycleFinished) return;
					settle(undefined, true);
				}, 3000);
				hardTimer.unref?.();
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
			// rather than rejecting this attempt and orphaning its live session.
			appendRecentOutput(progress, [`Foreground detach callback failed: ${error instanceof Error ? error.message : String(error)}`]);
		}

		void (async () => {
			try {
				const input = createReportedChildSessionInput(launch, shared.transcriptWriter);
				requestReadonlySessionEvidence(input, shared.readonlyExpected);
				if (shared.readonlyHandoffAllowed && !shared.readonlyHandoffAllowed()) throw new Error("Read-only continuation handoff vetoed.");
				const created = await childSessions.create(input);
				if (lifecycleFinished) {
					void created.dispose();
					return;
				}
				session = created;
				created.detached = detached;
				unsubscribe = created.subscribe((event) => processEvent(event as Parameters<typeof processEvent>[0]));
				if (abortedBySignal || interruptedByControl || result.timedOut) {
					abortChild();
				}
				options.onChildSession?.({ steer: (text) => created.steer(text), followUp: (text) => created.followUp(text) });
				const actualReadonlyModel = shared.readonlyExpected && getReadonlyChildModels(created)?.current;
				if (shared.readonlyExpected && (!actualReadonlyModel || actualReadonlyModel.fullId !== shared.readonlyModel
					|| actualReadonlyModel.api !== shared.readonlyExpected.api || created.modelId !== shared.readonlyModel || abortedBySignal || interruptedByControl || result.timedOut
					|| !shared.readonlyHandoffAllowed?.())) throw new Error("Read-only continuation handoff vetoed.");
				await created.prompt(`Task: ${task}`);
				settle(undefined);
			} catch (error) {
				settle(error ?? new Error("Child session failed."));
			}
		})();
	});
	result.exitCode = exitCode;
	if (afterCompactionSettlement) {
		(result as AbortRecoverySingleResult)[AFTER_COMPACTION_SETTLEMENT] = true;
	}
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
	if (progress.currentTool
		&& isOrdinaryToolForMidToolExit(progress.currentTool)
		&& !abortedBySignal
		&& !result.timedOut
		&& !result.stopped
		&& !toolAvailabilityError) {
		result.exitCode = 1;
		result.error = formatMidToolExitError({ toolName: progress.currentTool });
	}
	if (result.error && result.exitCode === 0) {
		result.exitCode = 1;
	}
	let validatedStructuredOutput = false;
	if (options.structuredOutput && result.exitCode === 0 && !result.error) {
		result.structuredOutputSchemaPath = options.structuredOutput.schemaPath;
		result.structuredOutputPath = options.structuredOutput.outputPath;
		const structured = capture.structuredOutput();
		if (!structuredOutputToolInvoked || !structured.called) {
			result.exitCode = 1;
			result.error = MISSING_STRUCTURED_OUTPUT_CALL_ERROR;
			result.structuredOutputFailed = true;
		} else {
			result.structuredOutput = structured.value;
			const acceptanceMode = options.structuredOutput.acceptanceReportPath
				? options.structuredOutput.acceptanceReportRequired ? "required" : "optional"
				: undefined;
			const acceptanceReportError = acceptanceMode === "required" && !structured.acceptanceReportProvided
				? MISSING_STRUCTURED_ACCEPTANCE_REPORT_ERROR
				: undefined;
			(result as SingleResult & { structuredAcceptanceReport?: unknown; structuredAcceptanceReportError?: string }).structuredAcceptanceReport = acceptanceMode ? structured.acceptanceReport : undefined;
			(result as SingleResult & { structuredAcceptanceReport?: unknown; structuredAcceptanceReportError?: string }).structuredAcceptanceReportError = acceptanceReportError;
			writeStructuredOutputArtifacts(options.structuredOutput, structured.value, acceptanceMode ? structured.acceptanceReport : undefined);
			validatedStructuredOutput = true;
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
		const terminalEmptyAfterUsefulWork = !validatedStructuredOutput
			&& hasEmptyTerminalAssistantResponse(messages)
			&& (progress.toolCount > 0 || Boolean(finalText?.trim()));
		if ((missingOutput || terminalEmptyAfterUsefulWork) && (!errInfo.hasError || hasEmptyTerminalAssistantResponse(messages))) {
			result.exitCode = 1;
			result.error = formatEmptyTerminalAssistantResponseError(messages);
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
		...(childSessionName ? { sessionName: childSessionName } : {}),
		toolCount: progress.toolCount,
		tokens: progress.tokens,
		durationMs: progress.durationMs,
	};
	const mutationEvidence = collectTrackedMutationEvidence(mutationSnapshot, options.cwd ?? runtimeCwd);

	const acceptanceOutput = getFinalOutput(result.messages ?? []);
	let fullOutput = stripAcceptanceReport(acceptanceOutput);
	if (!fullOutput.trim() && result.structuredOutput !== undefined) fullOutput = JSON.stringify(result.structuredOutput, null, 2);
	result.outputState = fullOutput.trim() || result.structuredOutput !== undefined ? "present" : "absent";
	if (result.timedOut) {
		const timeoutMessage = formatTimeoutMessage(options.timeoutMs ?? 0);
		let requiredOutputMissing: boolean | undefined;
		if (options.outputMode === "file-only" && options.outputPath) {
			const outputChanged = hasSingleOutputChangedSinceSnapshot(options.outputPath, shared.outputSnapshot);
			requiredOutputMissing = outputChanged === undefined ? undefined : !outputChanged;
		} else if (options.structuredOutput) {
			requiredOutputMissing = !capture.structuredOutput().called;
		}
		result.timeoutRecovery = buildTimeoutRecoverySummary({
			termination: "timed-out",
			evidence: mutationEvidence,
			requiredOutputMissing,
			currentTool: progress.currentTool,
			currentToolArgs: progress.currentToolArgs,
			currentPath: progress.currentPath,
			sessionFile: options.sessionFile,
			transcriptPath: shared.transcriptWriter ? shared.artifactPaths?.transcriptPath : undefined,
			artifactPaths: shared.artifactPaths,
		});
		fullOutput = fullOutput.trim()
			? `${timeoutMessage}\n\n${result.timeoutRecovery.message}\n\nPartial output before timeout:\n${fullOutput}`
			: `${timeoutMessage}\n\n${result.timeoutRecovery.message}`;
	}
	const completionGuardEnabled = isAgentContract(options.agentContract) ? agent.completionGuard === true : agent.completionGuard !== false;
	const completionGuard = ((result.exitCode === 0 && !result.error) || toolAvailabilityError) && completionGuardEnabled
		? evaluateCompletionMutationGuard({
			agent: agent.name,
			task: shared.originalTask ?? task,
			messages: result.messages ?? [],
			tools: contractTools,
			mcpDirectTools: toolPlan.effectiveMcpTools,
			mutationTools: agent.mutationTools,
			toolAvailabilityError,
			mutationEvidence,
		})
		: undefined;
	const mutationAttemptObserved = observedMutationAttempt || mutationEvidence.attemptedMutation;
	let completionGuardTriggered = completionGuard?.triggered === true && !mutationAttemptObserved;
	// The classifier is deliberately narrow, so a read-only review task can
	// still be misread as implementation. Arbitrate BEFORE any failure side
	// effect is published (effects, exit code, progress, notifications,
	// acceptance, output persistence): only a confident read-only verdict
	// rescues, and the task text alone is evidence — never the child's own
	// final message.
	let arbiterRescued = false;
	if (completionGuardTriggered) {
		const arbitration = await arbitrateCompletionGuardRescue({
			guardTriggered: true,
			task: shared.originalTask ?? task,
			arbiter: options.llmIntentArbiter,
		});
		completionGuardTriggered = arbitration.triggered;
		arbiterRescued = arbitration.rescued;
	}
	const completionEvidence = planCompletionEvidence({
		guard: completionGuard,
		guardTriggered: completionGuardTriggered,
		completionGuardEnabled,
		mutationCapable: hasMutationToolCapability(contractTools, toolPlan.effectiveMcpTools),
		implementationMutationExpected: expectsImplementationMutation(agent.name, shared.originalTask ?? task),
		mutationAttemptObserved,
		mutationEvidence,
		arbiterRescued,
		agentContractEnabled: isAgentContract(options.agentContract),
	});
	if (completionEvidence.fileMutation) {
		result.effects = {
			...(result.effects ?? {}),
			fileMutation: completionEvidence.fileMutation,
		};
	}
	if (completionEvidence.legacyFailureError) {
		result.exitCode = 1;
		result.error = completionEvidence.legacyFailureError;
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
			const resolvedOutput = resolveSingleOutput(options.outputPath, fullOutput, shared.outputSnapshot, options.outputClaimPath);
			fullOutput = stripAcceptanceReport(resolvedOutput.fullOutput);
			result.savedOutputPath = resolvedOutput.savedPath;
			result.outputSaveError = resolvedOutput.saveError;
			if (resolvedOutput.fatalError) {
				result.exitCode = 1;
				result.error = result.error ? `${result.error}\n${resolvedOutput.saveError}` : resolvedOutput.saveError;
			}
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

/** Keep the structured output artifact files other consumers read by path. */
function writeStructuredOutputArtifacts(runtime: NonNullable<RunSyncOptions["structuredOutput"]>, value: unknown, acceptanceReport: unknown): void {
	try {
		mkdirSync(path.dirname(runtime.outputPath), { recursive: true });
		writeFileSync(runtime.outputPath, JSON.stringify(value), { mode: 0o600 });
		if (runtime.acceptanceReportPath) {
			if (acceptanceReport !== undefined) writeFileSync(runtime.acceptanceReportPath, JSON.stringify(acceptanceReport), { mode: 0o600 });
			else rmSync(runtime.acceptanceReportPath, { force: true });
		}
	} catch {
		// The captured value is already on the result; the file is observability only.
	}
}

/**
 * Run a subagent synchronously (blocking until complete)
 */
async function runSyncCompletionInner(
	runtimeCwd: string,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	options: RunSyncOptions,
): Promise<SingleResult> {
	const effectiveCwd = options.cwd ?? runtimeCwd;
	const cwdError = preflightLaunchCwd(options.requestedCwd ?? effectiveCwd, effectiveCwd);
	if (cwdError) {
		return redactResultPrompt(withRunContext({
			index: options.index ?? 0,
			agent: agentName,
			task,
			exitCode: 1,
			messages: [],
			usage: emptyUsage(),
			error: cwdError,
		}, options.context));
	}
	options = {
		...options,
		capabilityCeiling: intersectSubagentCapabilityCeilings(options.capabilityCeiling ?? resolveCurrentSubagentCapabilityCeiling(options.parentSessionId), options.childRuntime?.capabilityCeiling),
	};
	const childSessionName = deriveChildSessionName({ agent: agentName, task });
	const agent = agents.find((a) => a.name === agentName);
	if (!agent) {
		const diagnosticContext = options.unknownAgentDiagnosticContext
			?? unknownAgentDiagnosticContext(discoverAgents(path.resolve(options.cwd ?? runtimeCwd), "both"));
		return redactResultPrompt(withRunContext({
			index: options.index ?? 0,
			agent: agentName,
			task,
			exitCode: 1,
			messages: [],
			usage: emptyUsage(),
			error: formatUnknownAgentError(agentName, diagnosticContext),
		}, options.context));
	}
	options = {
		...options,
		thinkingCeiling: intersectThinkingCeilings(
			options.thinkingCeiling,
			agent.maxThinking,
			options.childRuntime?.thinkingCeiling,
		),
	};
	try {
		assertAgentAllowedByCapabilityCeiling(agent.name, options.capabilityCeiling);
	} catch (error) {
		return redactResultPrompt(withRunContext({
			index: options.index ?? 0,
			agent: agent.name,
			task,
			exitCode: 1,
			messages: [],
			usage: emptyUsage(),
			error: error instanceof Error ? error.message : String(error),
			...(options.capabilityCeiling ? { capabilityCeiling: options.capabilityCeiling } : {}),
		}, options.context));
	}
	const acceptanceErrors = validateAcceptanceInput(options.acceptance);
	if (acceptanceErrors.length > 0) {
		return redactResultPrompt(withRunContext({
			index: options.index ?? 0,
			agent: agentName,
			task,
			exitCode: 1,
			messages: [],
			usage: emptyUsage(),
			error: acceptanceErrors.join(" "),
		}, options.context));
	}
	const toolTimeout = resolveToolTimeoutMs({
		callValue: options.toolTimeoutMs,
		agentValue: agent.defaultToolTimeoutMs,
		configValue: options.configToolTimeoutMs,
		envValue: toolTimeoutFromEnv(),
	});
	if (toolTimeout.error) {
		return redactResultPrompt(withRunContext({
			index: options.index ?? 0,
			agent: agentName,
			task,
			exitCode: 1,
			messages: [],
			usage: emptyUsage(),
			error: toolTimeout.error,
		}, options.context));
	}
	options = { ...options, toolTimeoutMs: toolTimeout.toolTimeoutMs };
	const outputModeValidationError = validateFileOnlyOutputMode(options.outputMode, options.outputPath, `Single run (${agentName})`);
	if (outputModeValidationError) {
		return redactResultPrompt(withRunContext({
			index: options.index ?? 0,
			agent: agentName,
			task,
			exitCode: 1,
			messages: [],
			usage: emptyUsage(),
			outputMode: options.outputMode,
			error: outputModeValidationError,
		}, options.context));
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
	const acceptancePrompt = formatAcceptancePrompt(effectiveAcceptance, { reportOptional: isAgentContract(options.agentContract), structuredOutput: Boolean(options.structuredOutput?.acceptanceReportPath) });
	const taskWithAcceptance = acceptancePrompt ? `${task}\n${acceptancePrompt}` : task;
	options.onEffectivePrompt?.(taskWithAcceptance);
	const sessionEnabled = Boolean(options.sessionFile || options.sessionDir) || shareEnabled;
	if (options.context === "fork" && options.sessionFile && existsSync(options.sessionFile)) {
		alignForkedSessionCwd(options.sessionFile, options.cwd ?? runtimeCwd);
	}
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
		return redactResultPrompt(withRunContext({
			index: options.index ?? 0,
			agent: agentName,
			task,
			exitCode: 1,
			messages: [],
			usage: emptyUsage(),
			error: "Skills not found: pi-subagents",
		}, options.context));
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
		agent.modelProvider ?? options.preferredModelProvider,
		{
			scope: options.modelScope,
			primaryModelFromParent: options.modelOverrideFromParent,
			origin: options.modelOrigin ?? (options.modelOverrideFromParent ? "inherited" : "configured"),
		},
	);
	if (options.workflowChildPermitLaunch && candidates.length > 1) {
		const error = "Workflow child permit does not support model fallback.";
		return redactResultPrompt(withRunContext({
			index: options.index ?? 0,
			agent: agent.name,
			task,
			exitCode: 1,
			messages: [],
			usage: emptyUsage(),
			error,
		}, options.context));
	}
	try {
		for (const candidate of candidates) {
			const model = applyThinkingSuffix(candidate, options.thinkingOverride ?? agent.thinking, options.thinkingOverride !== undefined);
			assertThinkingWithinCeiling({ model, configThinking: options.thinkingOverride ?? agent.thinking, ceiling: options.thinkingCeiling, agent: agent.name, runId: options.runId });
		}
	} catch (error) {
		return redactResultPrompt(withRunContext({
			index: options.index ?? 0,
			agent: agent.name,
			task,
			exitCode: 1,
			messages: [],
			usage: emptyUsage(),
			error: error instanceof Error ? error.message : String(error),
		}, options.context));
	}
	const attemptedModels: string[] = [];
	const modelAttempts: ModelAttempt[] = [];
	const aggregateUsage = emptyUsage();
	const attemptNotes: string[] = [];
	const launchWarnings = { emitted: false };
	let totalToolCount = 0;
	let totalDurationMs = 0;

	let artifactPathsResult: ArtifactPaths | undefined;
	let jsonlPath: string | undefined;
	let transcriptWriter: ChildTranscriptWriter | undefined;
	if (options.artifactsDir && options.artifactConfig?.enabled !== false) {
		artifactPathsResult = getArtifactPaths(options.artifactsDir, options.runId, agentName, options.index);
		ensureArtifactsDir(options.artifactsDir);
		if (options.artifactConfig?.includeInput !== false) {
			writeArtifact(artifactPathsResult.inputPath, `# Task for ${agentName}\n\n${PROMPT_REDACTED}; live Prompt Audit only.\n`);
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
			transcriptWriter.writeInitialUserMessage(`${PROMPT_REDACTED}; live Prompt Audit only.`);
		}
	}

	const orcaProgressTab = createOrcaProgressTab({
		cwd: options.cwd ?? runtimeCwd,
		runId: options.runId,
		agent: agentName,
		index: options.index ?? 0,
	});
	if (orcaProgressTab) options.onOrcaProgressTabCreated?.(orcaProgressTab);

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
	let recoveryState: LogicalRecoveryState = "unused";
	let readonlyExpected: SettledReadonlyEvidence | undefined;
	let readonlyModel: string | undefined;
	let readonlySource: ChildSession | undefined;
	// Ordinary startup retries retain their per-attempt timeout. Only retained
	// continuation uses the original logical deadline, never a renewed allowance.
	const continuationDeadline = options.deadlineAt ?? (options.timeoutMs === undefined ? undefined : Date.now() + options.timeoutMs);
	const readonlyHandoffAllowed = () => !options.signal?.aborted && !options.interruptSignal?.aborted
		&& !intercomDetached && !detachedReason && !options.workflowChildPermitLaunch
		&& options.usageBudget === undefined && options.toolBudget === undefined
		&& (continuationDeadline === undefined || Date.now() < continuationDeadline)
		&& (!readonlySource || getReadonlySessionEvidence(readonlySource) === readonlyExpected)
		&& !readonlySource?.detached && !readonlySource?.shutDown;
	let nextAttemptTask = taskWithAcceptance;
	modelAttemptsLoop: for (let modelIndex = 0; modelIndex < modelsToTry.length; modelIndex++) {
		const candidate = modelsToTry[modelIndex];
		// The inner loop re-runs the same candidate at most once, for abort recovery.
		for (;;) {
			const recoveringAbort = recoveryState === "abort-recovery";
			const attemptTask = nextAttemptTask;
			const verifyModel = Boolean(candidate) && !(options.modelOverrideFromParent && modelIndex === 0);
			const outputSnapshot = captureSingleOutputSnapshot(options.outputPath);
			if (recoveryState === "readonly-continuation") attemptOptions.deadlineAt = continuationDeadline;
			const result = await runSingleAttempt(runtimeCwd, agent, attemptTask, candidate, attemptOptions, {
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
				orcaProgressTab,
				launchWarnings,
				verifyModel,
				readonlyExpected,
				readonlyModel,
				readonlyHandoffAllowed: readonlyExpected ? readonlyHandoffAllowed : undefined,
			});
			lastResult = result;
			if (!recoveringAbort) {
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
			// A consumed retained continuation is terminal even on a startup error or abort.
			if (recoveryState === "readonly-continuation") break modelAttemptsLoop;
			const source = settledReadonlySource.get(result);
			const evidence = source && getReadonlySessionEvidence(source);
			const models = source && getReadonlyChildModels(source);
			// Deny non-text retained inputs, including unknown blocks. Count bytes once,
			// not restored usage (the latter belongs to earlier attempts/runs).
			const textOnly = evidence && (JSON.parse(evidence.contextJson) as Array<{ role: string; content: unknown }>).every((message) =>
				typeof message.content === "string" || Array.isArray(message.content) && message.content.every((block) =>
					block?.type === "text" || message.role === "assistant" && block?.type === "toolCall"));
			const retainedBytes = evidence && models ? Buffer.byteLength(evidence.contextJson) + models.requestBytes : Infinity;
			const resolvedCandidates = modelsToTry.map((reference, index) => index === modelIndex ? models?.current : reference ? models?.resolve(reference) : undefined);
			const continuation = planReadonlyModelContinuation({
				source, recoveryState, currentIndex: modelIndex,
				candidates: resolvedCandidates.map((resolved, index) => {
					// A conservative byte ceiling includes serialized history, actual system
					// prompt/tools, framing/continuation headroom and full output allowance.
					const required = resolved?.maxTokens ? retainedBytes + 4096 + resolved.maxTokens : Infinity;
					return {
						resolved: resolved?.api ? { provider: resolved.provider, model: resolved.id, api: resolved.api } : undefined,
						tried: index <= modelIndex,
						compatibility: textOnly && resolved?.input?.includes("text") && (resolved.contextWindow ?? 0) >= required ? "compatible" as const : "unknown" as const,
					};
				}),
				lifecycleAllowsContinuation: !attemptSucceeded && readonlyHandoffAllowed() && !result.stopped && !result.detached && !result.interrupted && !result.timedOut,
				effectsAllowContinuation: !result.structuredOutputFailed && !result.toolBudgetBlocked && !result.progress?.currentTool
					&& !result.outputSaveError && (!result.effects?.fileMutation || result.effects.fileMutation.status === "not-applicable"),
				budget: options.toolBudget ? "tool-budget-configured" : options.usageBudget ? "unknown" : "unconfigured",
				knownContextOverflow: Boolean(result.contextOverflow || isContextOverflow(result.error)),
			});
			if (continuation.kind === "continue") {
				recoveryState = continuation.recoveryState; // consume BEFORE any sibling creation
				readonlyExpected = continuation.expected;
				readonlySource = source;
				readonlyModel = resolvedCandidates[continuation.candidateIndex]?.fullId;
				nextAttemptTask = continuation.prompt;
				attemptNotes.push(`[readonly-continuation] ${attempt.model} failed with HTTP 429 after read-only progress; continuing retained session once with ${readonlyModel}.`);
				modelIndex = continuation.candidateIndex - 1;
				continue modelAttemptsLoop;
			}
			if (!attemptSucceeded) {
				const afterCompactionSettlement = (result as AbortRecoverySingleResult)[AFTER_COMPACTION_SETTLEMENT];
				const abortRecovery = planAbortRecovery({
					messages: result.messages ?? [],
					error: result.error,
					processSignal: result.processSignal,
					sessionAvailable: Boolean(options.sessionFile && existsSync(options.sessionFile)),
					alreadyResumed: recoveryState !== "unused",
					stopped: result.stopped || result.detached || options.signal?.aborted,
					interrupted: result.interrupted || intercomDetached || options.interruptSignal?.aborted,
					timedOut: result.timedOut,
					toolBudgetExhausted: result.toolBudgetBlocked,
					usageBudgetExhausted: false,
					structuredOutputFailed: result.structuredOutputFailed,
					acceptanceFailed: false,
					currentTool: result.progress?.currentTool,
					afterCompactionSettlement,
				});
				if (abortRecovery.action === "resume") {
					recoveryState = "abort-recovery";
					nextAttemptTask = abortRecovery.prompt;
					attemptNotes.push("[abort-recovery] provider/transport abort after useful progress; resuming the retained child session once.");
					continue;
				}
				if (abortRecovery.diagnostic) {
					result.error = result.error ? `${result.error}\n${abortRecovery.diagnostic}` : abortRecovery.diagnostic;
					attempt.error = result.error;
					break modelAttemptsLoop;
				}
			}
			if (recoveringAbort && !attemptSucceeded) break modelAttemptsLoop;
			if (options.workflowChildPermitLaunch && !attemptSucceeded) break modelAttemptsLoop;
			// Preserve the legacy intercom handoff contract: once this logical run has
			// been handed to a supervisor, terminating that attempt must not launch a
			// model fallback. Explicit user detach retains fallback.
			if (intercomDetached || result.timedOut) break modelAttemptsLoop;
			if (attemptSucceeded) break modelAttemptsLoop;

			const retryableModelFailure = isRetryableModelFailureAttempt({ error: result.error, messages: result.messages, toolCount: result.progressSummary?.toolCount });
			if (retryableModelFailure) recordRetryableModelFailure(result.model ?? candidate, result.error);
			if (isContextOverflow(result.error)) {
				result.contextOverflow = true;
				attemptNotes.push(`[fallback] ${attempt.model} failed: context overflow — the input exceeds this model's context window. Reduce the task input or use a model with a larger context window.`);
				break modelAttemptsLoop;
			}
			if (!retryableModelFailure || modelIndex === modelsToTry.length - 1) break modelAttemptsLoop;
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
	result.task = task;

	result.usage = aggregateUsage;
	result.attemptedModels = attemptedModels.length > 0 ? attemptedModels : undefined;
	result.modelAttempts = modelAttempts.length > 0 ? modelAttempts : undefined;
	result.progressSummary = {
		...(childSessionName ? { sessionName: childSessionName } : {}),
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
		} else {
			result.acceptance = await evaluateAcceptance({
				acceptance: effectiveAcceptance,
				output: acceptanceOutputByResult.get(result) ?? result.finalOutput ?? "",
				report: (result as SingleResult & { structuredAcceptanceReport?: import("../../shared/types.ts").AcceptanceReport; structuredAcceptanceReportError?: string }).structuredAcceptanceReport,
				reportError: (result as SingleResult & { structuredAcceptanceReport?: import("../../shared/types.ts").AcceptanceReport; structuredAcceptanceReportError?: string }).structuredAcceptanceReportError,
				fileOutput: childWrittenOutput !== undefined && options.outputPath
					? { content: childWrittenOutput, path: options.outputPath, authoritative: options.outputMode === "file-only", durable: result.savedOutputPath !== undefined }
					: undefined,
				cwd: options.cwd ?? runtimeCwd,
				reportOptional: isAgentContract(options.agentContract),
				artifactsDir: options.artifactsDir,
				runId: options.runId,
				watchdog: result.watchdog,
			});
		}
	} catch (error) {
		const message = `Acceptance evaluation failed: ${error instanceof Error ? error.message : String(error)}`;
		result.acceptance = buildSkippedAcceptanceLedger(effectiveAcceptance, { id: "acceptance-evaluation", message });
	}
	const acceptanceFailure = acceptanceFailureMessage(result.acceptance);
	stripAcceptanceReportsFromMessages(result.messages);
	if (acceptanceFailure && result.acceptance.explicit && result.exitCode === 0 && !result.interrupted && !result.timedOut && !isAgentContract(options.agentContract)) {
		result.exitCode = 1;
		if (result.savedOutputPath) {
			result.finalOutput = finalizeSingleOutput({
				fullOutput: result.finalOutput ?? "",
				outputPath: options.outputPath,
				outputMode: result.outputMode,
				exitCode: result.exitCode,
				preserveSavedOutput: true,
				savedPath: result.savedOutputPath,
				outputReference: result.outputReference,
			}).displayOutput;
			artifactOutputByResult.set(result, result.finalOutput);
		}
		result.error = result.error ? `${result.error}\n${acceptanceFailure}` : acceptanceFailure;
		if (artifactPathsResult && options.artifactConfig?.enabled !== false && options.artifactConfig?.includeOutput !== false) {
			try {
				writeArtifact(artifactPathsResult.outputPath, formatOutputArtifactContent({
					output: artifactOutputByResult.get(result) ?? result.finalOutput ?? "",
					error: result.error,
					transcriptPath: result.transcriptPath,
					metadataPath: options.artifactConfig?.includeMetadata === false ? undefined : artifactPathsResult.metadataPath,
				}));
			} catch (error) {
				const message = `Artifact output post-processing failed: ${error instanceof Error ? error.message : String(error)}`;
				result.outputSaveError = result.outputSaveError ? `${result.outputSaveError}\n${message}` : message;
			}
		}
		if (result.progress) {
			result.progress.status = "failed";
			result.progress.error = result.error;
		}
	}
	if (isAgentContract(options.agentContract)) attachContractProjections(result);
	redactResultPrompt(result);
	try {
		persistResultMetadata(result);
	} catch (error) {
		result.metadataSaveError = error instanceof Error ? error.message : String(error);
	}

	return result;
}

async function runSyncCompletion(
	runtimeCwd: string,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	options: RunSyncOptions,
): Promise<SingleResult> {
	let orcaProgressTab: OrcaProgressTab | undefined;
	try {
		const result = await runSyncCompletionInner(runtimeCwd, agents, agentName, task, {
			...options,
			onOrcaProgressTabCreated: (tab) => { orcaProgressTab = tab; },
		});
		orcaProgressTab?.finish(result.stopped ? "stopped" : result.exitCode === 0 && !result.error ? "completed" : "failed", result.sessionFile);
		return result;
	} catch (error) {
		orcaProgressTab?.finish("failed");
		throw error;
	}
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
	const strictContract = isAgentContract(options.agentContract);
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
		const failedResult: SingleResult = redactResultPrompt({
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
		});
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
	void authoritativeCompletion.then(async (terminalResult) => {
		if (!detachedReason || terminalCallbackInvoked) return;
		terminalCallbackInvoked = true;
		terminalResult.detached = undefined;
		terminalResult.detachedReason = detachedReason;
		try {
			await options.onDetachedExit?.(terminalResult);
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
