/**
 * Core execution logic for running subagents
 */

import { spawn } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";
import * as path from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import type { AgentConfig } from "../../agents/agents.ts";
import {
	ensureArtifactsDir,
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
	extractToolArgsPreview,
	extractTextFromContent,
} from "../../shared/utils.ts";
import { buildSkillInjection, resolveSkillsWithFallback } from "../../agents/skills.ts";
import { buildAgentMemoryInjection } from "../../agents/agent-memory.ts";
import { evaluateCompletionMutationGuard } from "../shared/completion-guard.ts";
import { getPiSpawnCommand } from "../shared/pi-spawn.ts";
import { createJsonlWriter } from "../../shared/jsonl-writer.ts";
import { attachPostExitStdioGuard, trySignalChild } from "../../shared/post-exit-stdio-guard.ts";
import { applyThinkingSuffix, buildPiArgs, cleanupTempDir } from "../shared/pi-args.ts";
import { readStructuredOutput } from "../shared/structured-output.ts";
import { readChildToolDiagnosticError } from "../shared/tool-availability.ts";
import { captureSingleOutputSnapshot, extractChildWrittenOutput, formatSavedOutputReference, injectOutputPathSystemPrompt, resolveSingleOutput, validateFileOnlyOutputMode, type SingleOutputSnapshot } from "../shared/single-output.ts";
import {
	buildModelCandidates,
	formatModelAttemptNote,
	isRetryableModelFailure,
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
import { acceptanceFailureMessage, buildSkippedAcceptanceLedger, evaluateAcceptance, formatAcceptancePrompt, resolveEffectiveAcceptance, stripAcceptanceReport } from "../shared/acceptance.ts";
import { appendTurnBudgetSystemPrompt, formatTurnBudgetOutput, initialTurnBudgetState, turnBudgetDecision, turnBudgetDeferredNote, turnBudgetDeferredState, turnBudgetExceededMessage, turnBudgetSoftNote, turnBudgetState } from "../shared/turn-budget.ts";
import { initialToolBudgetState, toolBudgetState } from "../shared/tool-budget.ts";
import { resolveWatchdogConfig } from "../../watchdog/settings.ts";
import { createBoundedByteTail, createBoundedLineReader, formatProtocolOutputLimit, MAX_CHILD_STDERR_BYTES, projectChildLifecycle, type ChildLifecycleAction, type ProtocolOutputLimit } from "../shared/child-protocol.ts";
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

function sumUsage(target: Usage, source: Usage): void {
	target.input += source.input;
	target.output += source.output;
	target.cacheRead += source.cacheRead;
	target.cacheWrite += source.cacheWrite;
	target.cost += source.cost;
	target.turns += source.turns;
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
		explicit: acceptance.explicit,
		effectiveAcceptance: acceptance,
		inferredReason: acceptance.inferredReason,
		criteria: acceptance.criteria,
		runtimeChecks: [],
		verifyRuns: [],
	};
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
		recentTools: progress.recentTools.map((tool) => ({ ...tool })),
		recentOutput: [...progress.recentOutput],
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
	const watchdogConfig = resolveWatchdogConfig(options.cwd ?? runtimeCwd);
	const childWatchdog = watchdogConfig.ok
		? resolveChildWatchdogConfig({
			config: watchdogConfig.config,
			agent: agent.name,
			runId: options.runId,
			childIndex: options.index ?? 0,
		})
		: undefined;
	const { args, env: sharedEnv, tempDir, toolDiagnosticPath } = buildPiArgs({
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
		childWatchdog,
		waitToolEnabled: options.waitToolEnabled,
	});

	const result: SingleResult = {
		agent: agent.name,
		task: shared.originalTask ?? task,
		exitCode: 0,
		messages: [],
		usage: emptyUsage(),
		model: modelArg,
		artifactPaths: shared.artifactPaths,
		transcriptPath: shared.transcriptWriter ? shared.artifactPaths?.transcriptPath : undefined,
		skills: shared.resolvedSkillNames,
		skillsWarning: shared.skillsWarning,
		...(options.turnBudget ? { turnBudget: initialTurnBudgetState(options.turnBudget) } : {}),
		...(options.toolBudget ? { toolBudget: initialToolBudgetState(options.toolBudget) } : {}),
	};
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
		let settled = false;
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

		const detachForIntercom = () => {
			detached = true;
			processClosed = true;
			result.detached = true;
			result.detachedReason = "intercom coordination";
			progress.status = "detached";
			progress.durationMs = Date.now() - startTime;
			result.progressSummary = {
				toolCount: progress.toolCount,
				tokens: progress.tokens,
				durationMs: progress.durationMs,
			};
			finish(-2);
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
			if (childExited || finalDrainTimer || settled || processClosed || detached) return;
			finalDrainTimer = setTimeout(() => {
				if (settled || processClosed || detached) return;
				const termSent = trySignalChild(proc, "SIGTERM");
				if (!termSent) return;
				forcedTerminationSignal = true;
				if (!cleanTerminalAssistantStopReceived && !agentSettledReceived && !assistantError) {
					result.error = result.error ?? `Subagent process did not exit within ${FINAL_STOP_GRACE_MS}ms after its terminal event. Forcing termination.`;
				}
				finalHardKillTimer = setTimeout(() => {
					if (settled || processClosed || detached) return;
					forcedTerminationSignal = trySignalChild(proc, "SIGKILL") || forcedTerminationSignal;
				}, HARD_KILL_MS);
				finalHardKillTimer.unref?.();
			}, FINAL_STOP_GRACE_MS);
			finalDrainTimer.unref?.();
		};
		function armWatchdogTail(): void {
			if ((!cleanTerminalAssistantStopReceived && !agentSettledReceived) || watchdogTailTimer || settled || processClosed || detached) return;
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
			if (!options.allowIntercomDetach || detached || processClosed) return;
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
			options.intercomEvents?.emit(INTERCOM_DETACH_RESPONSE_EVENT, { requestId, accepted: true, runId: options.runId, agent: agent.name, childIndex: options.index ?? 0 });
			detachForIntercom();
		});

		const finish = (code: number) => {
			if (settled) return;
			settled = true;
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
			if (!budget || result.timedOut || result.turnBudgetExceeded || interruptedByControl || processClosed || settled || detached) return;
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
				if (processClosed || settled || detached || result.timedOut) return;
				trySignalChild(proc, "SIGTERM");
			}, 1000);
			turnBudgetTerminationTimer.unref?.();
			turnBudgetHardKillTimer = setTimeout(() => {
				if (processClosed || settled || detached || result.timedOut) return;
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
			const decision = turnBudgetDecision(budget, turnCount, terminalAssistantStop, toolWorkActiveOrStarting);
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
			const resultSnapshot = snapshotResult(result, progressSnapshot);
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
			const output = (result.timedOut || result.turnBudgetExceeded) && result.finalOutput ? result.finalOutput : getFinalOutput(result.messages);
			emitUpdateSnapshot(output || "(running...)");
		};

		const processLine = (line: string) => {
			if (!line.trim()) return;
			jsonlWriter.writeLine(line);
			let evt: { type?: string; message?: Message; toolName?: string; args?: unknown; willRetry?: unknown };
			try {
				evt = JSON.parse(line) as { type?: string; message?: Message; toolName?: string; args?: unknown; willRetry?: unknown };
			} catch {
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
				result.messages.push(evt.message);
				if (evt.message.role === "assistant") {
					result.usage.turns++;
					progress.turnCount = result.usage.turns;
					const stopReason = (evt.message as { stopReason?: string }).stopReason;
					const hasToolCall = Array.isArray(evt.message.content)
						&& evt.message.content.some((part) => (part as { type?: string }).type === "toolCall");
					const terminalAssistantStop = stopReason === "stop" && !hasToolCall;
					updateTurnBudget(result.usage.turns, terminalAssistantStop, hasToolCall || Boolean(progress.currentTool));
					const u = evt.message.usage;
					if (u) {
						result.usage.input += u.input || 0;
						result.usage.output += u.output || 0;
						result.usage.cacheRead += u.cacheRead || 0;
						result.usage.cacheWrite += u.cacheWrite || 0;
						result.usage.cost += u.cost?.total || 0;
						progress.tokens = result.usage.input + result.usage.output;
					}
					if (!result.model && evt.message.model) result.model = evt.message.model;
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
				result.messages.push(evt.message);
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

		if (controlConfig.enabled) {
			activityTimer = setInterval(() => {
				if (processClosed || settled || detached) return;
				const now = Date.now();
				if (updateActivityState(now)) {
					progress.durationMs = now - startTime;
					fireUpdate();
				}
			}, 1000);
			activityTimer.unref?.();
		}

		if (attemptTimeout) {
			timeoutTimer = setTimeout(() => {
				if (processClosed || settled || detached || interruptedByControl) return;
				result.timedOut = true;
				result.error = attemptTimeout.message;
				result.finalOutput = attemptTimeout.message;
				progress.status = "failed";
				progress.error = attemptTimeout.message;
				progress.durationMs = Date.now() - startTime;
				fireUpdate();
				trySignalChild(proc, "SIGINT");
				timeoutTerminationTimer = setTimeout(() => {
					if (processClosed || settled || detached) return;
					trySignalChild(proc, "SIGTERM");
				}, 1000);
				timeoutTerminationTimer.unref?.();
				timeoutHardKillTimer = setTimeout(() => {
					if (processClosed || settled || detached) return;
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
		const stdoutReader = createBoundedLineReader({ onLine: processLine, onLimit: failProtocol });
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
			clearFinalDrainTimers();
			clearStdioGuard();
			void jsonlWriter.close().catch(() => {
				// JSONL artifact flush is best effort.
			});
			const toolDiagnosticError = readChildToolDiagnosticError(toolDiagnosticPath);
			cleanupTempDir(tempDir);
			stdoutReader.end();
			stderrReader.end();
			const stderr = stderrTail.text();
			let closeError = result.error ?? toolDiagnosticError ?? assistantError;
			const forcedDrainAfterFinalSuccess = forcedTerminationSignal && (cleanTerminalAssistantStopReceived || agentSettledReceived) && !closeError;
			if (code !== 0 && stderr.trim() && !closeError && !forcedDrainAfterFinalSuccess) {
				closeError = stderr.trim();
			}
			const finalCode = forcedDrainAfterFinalSuccess ? 0 : forcedTerminationSignal || signal ? (code ?? 1) : (code ?? 0);
			if (detached) {
				const recoveredProgress = snapshotProgress(progress);
				const recoveredResult = snapshotResult(result, recoveredProgress);
				if (!recoveredResult.error && closeError) recoveredResult.error = closeError;
				recoveredResult.exitCode = recoveredResult.error && finalCode === 0 ? 1 : finalCode;
				recoveredProgress.status = recoveredResult.exitCode === 0 ? "completed" : "failed";
				recoveredProgress.durationMs = Date.now() - startTime;
				if (recoveredResult.error) recoveredProgress.error = recoveredResult.error;
				recoveredResult.progressSummary = {
					toolCount: recoveredProgress.toolCount,
					tokens: recoveredProgress.tokens,
					durationMs: recoveredProgress.durationMs,
				};
				const acceptanceOutput = getFinalOutput(recoveredResult.messages ?? []).trim()
					|| recoveredResult.error
					|| recoveredResult.finalOutput
					|| "Detached child exited without final output.";
				acceptanceOutputByResult.set(recoveredResult, acceptanceOutput);
				let fullOutput = stripAcceptanceReport(acceptanceOutput);
				fullOutput = fullOutput.trim() || recoveredResult.error || recoveredResult.finalOutput || "Detached child exited without final output.";
				recoveredResult.outputMode = options.outputMode ?? "inline";
				if (options.outputPath && recoveredResult.exitCode === 0) {
					const resolvedOutput = resolveSingleOutput(options.outputPath, fullOutput, shared.outputSnapshot);
					fullOutput = stripAcceptanceReport(resolvedOutput.fullOutput);
					recoveredResult.savedOutputPath = resolvedOutput.savedPath;
					recoveredResult.outputSaveError = resolvedOutput.saveError;
					if (resolvedOutput.savedPath) {
						recoveredResult.outputReference = formatSavedOutputReference(resolvedOutput.savedPath, fullOutput);
					} else {
						recoveredResult.exitCode = 1;
						recoveredResult.error = `Output file was not finalized after detached child exit: ${resolvedOutput.saveError ?? options.outputPath}`;
						recoveredProgress.status = "failed";
						recoveredProgress.error = recoveredResult.error;
					}
				}
				recoveredResult.finalOutput = options.outputMode === "file-only" && recoveredResult.savedOutputPath && recoveredResult.outputReference
					? recoveredResult.outputReference.message
					: fullOutput;
				if (recoveredResult.artifactPaths && options.artifactConfig?.enabled !== false && options.artifactConfig?.includeOutput !== false) {
					try {
						writeArtifact(recoveredResult.artifactPaths.outputPath, fullOutput);
					} catch {
						// Detached children may outlive test/temp cleanup; recovered status is best-effort.
					}
				}
				options.onDetachedExit?.(recoveredResult);
				finish(-2);
				return;
			}
			if (!result.error && closeError) result.error = closeError;
			processClosed = true;
			finish(finalCode);
		});
		proc.on("error", (error) => {
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
				if (processClosed || detached) return;
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
				if (processClosed || detached || settled) return;
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
					if (settled || processClosed || detached) return;
					trySignalChild(proc, "SIGTERM");
				}, 1000).unref?.();
			};
			if (options.interruptSignal.aborted) interrupt();
			else {
				options.interruptSignal.addEventListener("abort", interrupt, { once: true });
				removeInterruptListener = () => options.interruptSignal?.removeEventListener("abort", interrupt);
			}
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
	if (result.detached) {
		result.exitCode = -2;
		result.finalOutput = "Detached for intercom coordination before task completion.";
		result.outputMode = options.outputMode ?? "inline";
		if (options.outputPath) {
			result.outputSaveError = "Output file was not finalized because the subagent detached for intercom coordination.";
		}
		return result;
	}

	if (result.error && result.exitCode === 0) {
		result.exitCode = 1;
	}
	if (result.exitCode === 0 && !result.error) {
		const errInfo = detectSubagentError(result.messages);
		if (errInfo.hasError) {
			result.exitCode = errInfo.exitCode ?? 1;
			result.error = errInfo.details
				? `${errInfo.errorType} failed (exit ${errInfo.exitCode}): ${errInfo.details}`
				: `${errInfo.errorType} failed with exit code ${errInfo.exitCode}`;
		}
	}
	if (result.exitCode === 0 && !result.error) {
		const finalText = getFinalOutput(result.messages);
		const missingStructuredOutput = options.structuredOutput
			? !existsSync(options.structuredOutput.outputPath)
			: false;
		if (!finalText?.trim() && (!options.structuredOutput || missingStructuredOutput)) {
			result.exitCode = 1;
			result.error = "Subagent produced no output (possible model cold-start or empty response).";
		}
	}
	if (options.structuredOutput && result.exitCode === 0 && !result.error) {
		const structured = readStructuredOutput({
			schema: options.structuredOutput.schema,
			schemaPath: options.structuredOutput.schemaPath,
			outputPath: options.structuredOutput.outputPath,
		});
		result.structuredOutputSchemaPath = options.structuredOutput.schemaPath;
		result.structuredOutputPath = options.structuredOutput.outputPath;
		if (structured.error) {
			result.exitCode = 1;
			result.error = structured.error;
		} else {
			result.structuredOutput = structured.value;
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

	const acceptanceOutput = getFinalOutput(result.messages);
	let fullOutput = stripAcceptanceReport(acceptanceOutput);
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
	const completionGuard = result.exitCode === 0 && !result.error && agent.completionGuard !== false
		? evaluateCompletionMutationGuard({
			agent: agent.name,
			task: shared.originalTask ?? task,
			messages: result.messages,
			tools: agent.tools,
			mcpDirectTools: agent.mcpDirectTools,
		})
		: undefined;
	if (completionGuard?.triggered && !observedMutationAttempt) {
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
		const resultSnapshot = snapshotResult(result, progressSnapshot);
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
export async function runSync(
	runtimeCwd: string,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	options: RunSyncOptions,
): Promise<SingleResult> {
	const agent = agents.find((a) => a.name === agentName);
	if (!agent) {
		return {
			agent: agentName,
			task,
			exitCode: 1,
			messages: [],
			usage: emptyUsage(),
			error: `Unknown agent: ${agentName}`,
		};
	}
	const outputModeValidationError = validateFileOnlyOutputMode(options.outputMode, options.outputPath, `Single run (${agentName})`);
	if (outputModeValidationError) {
		return {
			agent: agentName,
			task,
			exitCode: 1,
			messages: [],
			usage: emptyUsage(),
			outputMode: options.outputMode,
			error: outputModeValidationError,
		};
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
	});
	const acceptancePrompt = formatAcceptancePrompt(effectiveAcceptance);
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
		return {
			agent: agentName,
			task,
			exitCode: 1,
			messages: [],
			usage: emptyUsage(),
			error: "Skills not found: pi-subagents",
		};
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
		if (!artifactPathsResult || options.artifactConfig?.enabled === false || options.artifactConfig?.includeMetadata === false) return;
		writeMetadata(artifactPathsResult.metadataPath, {
			runId: options.runId,
			agent: agentName,
			task,
			exitCode: target.exitCode,
			usage: target.usage,
			model: target.model,
			attemptedModels: target.attemptedModels,
			modelAttempts: target.modelAttempts,
			durationMs: target.progressSummary?.durationMs,
			toolCount: target.progressSummary?.toolCount,
			error: target.error,
			acceptance: target.acceptance,
			...(transcriptWriter ? { transcriptPath: artifactPathsResult.transcriptPath } : {}),
			transcriptError: target.transcriptError,
			skills: target.skills,
			skillsWarning: target.skillsWarning,
			timestamp: Date.now(),
		});
	};

	const detachedAwareOptions: RunSyncOptions = options.onDetachedExit
		? {
			...options,
			onDetachedExit: (recoveredResult) => {
				void (async () => {
					const childWrittenOutput = options.outputPath
						? extractChildWrittenOutput(recoveredResult.messages, options.outputPath, options.cwd ?? runtimeCwd)
						: undefined;
					recoveredResult.acceptance = await evaluateAcceptance({
						acceptance: effectiveAcceptance,
						output: acceptanceOutputByResult.get(recoveredResult) ?? recoveredResult.finalOutput ?? "",
						fileOutput: childWrittenOutput !== undefined && options.outputPath
							? { content: childWrittenOutput, path: options.outputPath, authoritative: options.outputMode === "file-only" }
							: undefined,
						cwd: options.cwd ?? runtimeCwd,
					});
					const acceptanceFailure = acceptanceFailureMessage(recoveredResult.acceptance);
					stripAcceptanceReportsFromMessages(recoveredResult.messages);
					if (acceptanceFailure && recoveredResult.acceptance.explicit && recoveredResult.exitCode === 0) {
						recoveredResult.exitCode = 1;
						recoveredResult.error = recoveredResult.error ? `${recoveredResult.error}\n${acceptanceFailure}` : acceptanceFailure;
						if (recoveredResult.progress) {
							recoveredResult.progress.status = "failed";
							recoveredResult.progress.error = recoveredResult.error;
						}
					}
					persistResultMetadata(recoveredResult);
					options.onDetachedExit?.(recoveredResult);
				})().catch((error) => {
					const message = error instanceof Error ? error.message : String(error);
					recoveredResult.exitCode = 1;
					recoveredResult.error = recoveredResult.error ? `${recoveredResult.error}\nAcceptance evaluation failed: ${message}` : `Acceptance evaluation failed: ${message}`;
					options.onDetachedExit?.(recoveredResult);
				});
			},
		}
		: options;

	let lastResult: SingleResult | undefined;
	const modelsToTry = candidates.length > 0 ? candidates : [undefined];
	for (let i = 0; i < modelsToTry.length; i++) {
		const candidate = modelsToTry[i];
		const outputSnapshot = captureSingleOutputSnapshot(options.outputPath);
		const result = await runSingleAttempt(runtimeCwd, agent, taskWithAcceptance, candidate, detachedAwareOptions, {
			sessionEnabled,
			systemPrompt,
			resolvedSkillNames: resolvedSkills.length > 0 ? resolvedSkills.map((skill) => skill.name) : undefined,
			skillsWarning: missingSkills.length > 0 ? `Skills not found: ${missingSkills.join(", ")}` : undefined,
			jsonlPath,
			artifactPaths: artifactPathsResult,
			transcriptWriter,
			attemptNotes,
			outputSnapshot,
			originalTask: task,
		});
		lastResult = result;
		if (result.model) attemptedModels.push(result.model);
		else if (candidate) attemptedModels.push(candidate);
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
		if (result.detached || result.timedOut || result.turnBudgetExceeded) {
			break;
		}
		if (attemptSucceeded) {
			break;
		}
		if (!isRetryableModelFailure(result.error) || i === modelsToTry.length - 1) {
			break;
		}
		attemptNotes.push(formatModelAttemptNote(attempt, modelsToTry[i + 1]));
	}

	const result = lastResult ?? {
		agent: agentName,
		task,
		exitCode: 1,
		messages: [],
		usage: emptyUsage(),
		error: "Subagent did not produce a result.",
	} satisfies SingleResult;

	result.usage = aggregateUsage;
	result.attemptedModels = attemptedModels.length > 0 ? attemptedModels : undefined;
	result.modelAttempts = modelAttempts.length > 0 ? modelAttempts : undefined;
	result.progressSummary = {
		toolCount: totalToolCount,
		tokens: aggregateUsage.input + aggregateUsage.output,
		durationMs: totalDurationMs,
	};
	if (attemptNotes.length > 0 && result.progress) {
		result.progress.recentOutput = [...attemptNotes, ...result.progress.recentOutput];
		if (result.progress.recentOutput.length > 50) {
			result.progress.recentOutput.splice(50);
		}
	}

	if (transcriptWriter) result.transcriptPath = artifactPathsResult?.transcriptPath;
	if (transcriptWriter?.getError()) result.transcriptError = transcriptWriter.getError();

	if (artifactPathsResult && options.artifactConfig?.enabled !== false) {
		result.artifactPaths = artifactPathsResult;
		if (options.artifactConfig?.includeOutput !== false) {
			writeArtifact(artifactPathsResult.outputPath, artifactOutputByResult.get(result) ?? result.finalOutput ?? "");
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

	if (options.sessionFile && (existsSync(options.sessionFile) || result.messages?.length)) {
		result.sessionFile = options.sessionFile;
	} else if (shareEnabled && options.sessionDir) {
		const sessionFile = findLatestSessionFile(options.sessionDir);
		if (sessionFile) result.sessionFile = sessionFile;
	}

	const childWrittenOutput = options.outputPath
		? extractChildWrittenOutput(result.messages, options.outputPath, options.cwd ?? runtimeCwd)
		: undefined;
	if (result.detached) {
		result.acceptance = buildPendingAcceptanceLedger(effectiveAcceptance);
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
		});
	}
	const acceptanceFailure = acceptanceFailureMessage(result.acceptance);
	stripAcceptanceReportsFromMessages(result.messages);
	if (acceptanceFailure && result.acceptance.explicit && result.exitCode === 0 && !result.detached && !result.interrupted && !result.timedOut) {
		result.exitCode = 1;
		result.error = result.error ? `${result.error}\n${acceptanceFailure}` : acceptanceFailure;
		if (result.progress) {
			result.progress.status = "failed";
			result.progress.error = result.error;
		}
	}
	persistResultMetadata(result);

	return result;
}
