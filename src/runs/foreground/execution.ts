/**
 * Core execution logic for running subagents
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import type { Message } from "@mariozechner/pi-ai";
import type { AgentConfig } from "../../agents/agents.ts";
import {
	ensureArtifactsDir,
	getArtifactPaths,
	writeArtifact,
	writeMetadata,
} from "../../shared/artifacts.ts";
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
import { evaluateCompletionMutationGuard } from "../shared/completion-guard.ts";
import { getPiSpawnCommand } from "../shared/pi-spawn.ts";
import { createJsonlWriter } from "../../shared/jsonl-writer.ts";
import { attachPostExitStdioGuard, trySignalChild } from "../../shared/post-exit-stdio-guard.ts";
import { applyThinkingSuffix, buildPiArgs, cleanupTempDir } from "../shared/pi-args.ts";
import { captureSingleOutputSnapshot, formatSavedOutputReference, resolveSingleOutput, validateFileOnlyOutputMode, type SingleOutputSnapshot } from "../shared/single-output.ts";
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

const artifactOutputByResult = new WeakMap<SingleResult, string>();

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

function appendRecentOutput(progress: AgentProgress, lines: string[]): void {
	if (lines.length === 0) return;
	progress.recentOutput.push(...lines.filter((line) => line.trim()));
	if (progress.recentOutput.length > 50) {
		progress.recentOutput.splice(0, progress.recentOutput.length - 50);
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
		attemptNotes: string[];
		outputSnapshot?: SingleOutputSnapshot;
	},
): Promise<SingleResult> {
	const modelArg = applyThinkingSuffix(model, agent.thinking);
	const { args, env: sharedEnv, tempDir } = buildPiArgs({
		baseArgs: ["--mode", "json", "-p"],
		task,
		sessionEnabled: shared.sessionEnabled,
		sessionDir: options.sessionDir,
		sessionFile: options.sessionFile,
		model,
		thinking: agent.thinking,
		systemPromptMode: agent.systemPromptMode,
		inheritProjectContext: agent.inheritProjectContext,
		inheritSkills: agent.inheritSkills,
		tools: agent.tools,
		extensions: agent.extensions,
		systemPrompt: shared.systemPrompt,
		mcpDirectTools: agent.mcpDirectTools,
		promptFileStem: agent.name,
		intercomSessionName: options.intercomSessionName,
		orchestratorIntercomTarget: options.orchestratorIntercomTarget,
		runId: options.runId,
		childAgentName: agent.name,
		childIndex: options.index ?? 0,
	});

	const result: SingleResult = {
		agent: agent.name,
		task,
		exitCode: 0,
		messages: [],
		usage: emptyUsage(),
		model: modelArg,
		artifactPaths: shared.artifactPaths,
		skills: shared.resolvedSkillNames,
		skillsWarning: shared.skillsWarning,
	};
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
	const spawnEnv = { ...process.env, ...sharedEnv, ...getSubagentDepthEnv(options.maxSubagentDepth) };
	let observedMutationAttempt = false;

	const exitCode = await new Promise<number>((resolve) => {
		const spawnSpec = getPiSpawnCommand(args);
		const proc = spawn(spawnSpec.command, spawnSpec.args, {
			cwd: options.cwd ?? runtimeCwd,
			env: spawnEnv,
			stdio: ["ignore", "pipe", "pipe"],
		});
		const jsonlWriter = createJsonlWriter(shared.jsonlPath, proc.stdout);
		let buf = "";
		let processClosed = false;
		let settled = false;
		let detached = false;
		let intercomStarted = false;
		let removeAbortListener: (() => void) | undefined;
		let removeInterruptListener: (() => void) | undefined;
		let activityTimer: NodeJS.Timeout | undefined;

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
		let finalDrainTimer: NodeJS.Timeout | undefined;
		let finalHardKillTimer: NodeJS.Timeout | undefined;
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
			if (childExited || finalDrainTimer || settled || processClosed || detached) return;
			finalDrainTimer = setTimeout(() => {
				if (settled || processClosed || detached) return;
				const termSent = trySignalChild(proc, "SIGTERM");
				if (!termSent) return;
				forcedTerminationSignal = true;
				if (!cleanTerminalAssistantStopReceived) {
					result.error = result.error ?? `Subagent process did not exit within ${FINAL_STOP_GRACE_MS}ms after its final message. Forcing termination.`;
				}
				finalHardKillTimer = setTimeout(() => {
					if (settled || processClosed || detached) return;
					forcedTerminationSignal = trySignalChild(proc, "SIGKILL") || forcedTerminationSignal;
				}, HARD_KILL_MS);
				finalHardKillTimer.unref?.();
			}, FINAL_STOP_GRACE_MS);
			finalDrainTimer.unref?.();
		};

		const unsubscribeIntercomDetach = options.intercomEvents?.on?.(INTERCOM_DETACH_REQUEST_EVENT, (payload) => {
			if (!options.allowIntercomDetach || detached || processClosed || !intercomStarted) return;
			if (!payload || typeof payload !== "object") return;
			const requestId = (payload as { requestId?: unknown }).requestId;
			if (typeof requestId !== "string" || requestId.length === 0) return;
			options.intercomEvents?.emit(INTERCOM_DETACH_RESPONSE_EVENT, { requestId, accepted: true });
			detachForIntercom();
		});

		const finish = (code: number) => {
			if (settled) return;
			settled = true;
			clearFinalDrainTimers();
			clearStdioGuard();
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
		const updateActivityState = (now: number): boolean => {
			if (!controlConfig.enabled) return false;
			const idleState = deriveActivityState({
				config: controlConfig,
				startedAt: startTime,
				lastActivityAt: progress.lastActivityAt,
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
			emitUpdateSnapshot(getFinalOutput(result.messages) || "(running...)");
		};

		const processLine = (line: string) => {
			if (!line.trim()) return;
			jsonlWriter.writeLine(line);
			let evt: { type?: string; message?: Message; toolName?: string; args?: unknown };
			try {
				evt = JSON.parse(line) as { type?: string; message?: Message; toolName?: string; args?: unknown };
			} catch {
				// Non-JSON stdout lines are expected; only structured events are parsed.
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
				if (options.allowIntercomDetach && evt.toolName === "intercom") {
					intercomStarted = true;
				}
				progress.toolCount++;
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
					if (evt.message.errorMessage) result.error = evt.message.errorMessage;
					appendRecentOutput(progress, extractTextFromContent(evt.message.content).split("\n").slice(-10));
					// Final assistant message: start the exit drain window.
					const stopReason = (evt.message as { stopReason?: string }).stopReason;
					const hasToolCall = Array.isArray(evt.message.content)
						&& evt.message.content.some((part) => (part as { type?: string }).type === "toolCall");
					if (stopReason === "stop" && !hasToolCall) {
						cleanTerminalAssistantStopReceived ||= !evt.message.errorMessage;
						startFinalDrain();
					}
				}
				updateActivityState(now);
				fireUpdate();
			}

			if (evt.type === "tool_result_end" && evt.message) {
				result.messages.push(evt.message);
				const resultText = extractTextFromContent(evt.message.content);
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

		let stderrBuf = "";

		const clearStdioGuard = attachPostExitStdioGuard(proc, { idleMs: 2000, hardMs: 8000 });
		proc.stdout.on("data", (d) => {
			buf += d.toString();
			const lines = buf.split("\n");
			buf = lines.pop() || "";
			lines.forEach(processLine);
		});
		proc.stderr.on("data", (d) => {
			stderrBuf += d.toString();
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
			cleanupTempDir(tempDir);
			if (detached) {
				finish(-2);
				return;
			}
			processClosed = true;
			if (buf.trim()) processLine(buf);
			const forcedDrainAfterFinalSuccess = forcedTerminationSignal && cleanTerminalAssistantStopReceived && !result.error;
			if (code !== 0 && stderrBuf.trim() && !result.error && !forcedDrainAfterFinalSuccess) {
				result.error = stderrBuf.trim();
			}
			const finalCode = forcedDrainAfterFinalSuccess ? 0 : forcedTerminationSignal || signal ? (code ?? 1) : (code ?? 0);
			finish(finalCode);
		});
		proc.on("error", (error) => {
			clearFinalDrainTimers();
			clearStdioGuard();
			void jsonlWriter.close().catch(() => {
				// JSONL artifact flush is best effort.
			});
			cleanupTempDir(tempDir);
			if (!result.error) {
				result.error = error instanceof Error ? error.message : String(error);
			}
			finish(1);
		});

		if (options.signal) {
			const kill = () => {
				if (processClosed || detached) return;
				if (options.allowIntercomDetach && intercomStarted && !detached) {
					detachForIntercom();
					return;
				}
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
				interruptedByControl = true;
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
		result.exitCode = 0;
		result.finalOutput = "Detached for intercom coordination.";
		return result;
	}

	if (exitCode === 0 && !result.error) {
		const errInfo = detectSubagentError(result.messages);
		if (errInfo.hasError) {
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

	let fullOutput = getFinalOutput(result.messages);
	const completionGuard = result.exitCode === 0 && !result.error
		? evaluateCompletionMutationGuard({ agent: agent.name, task, messages: result.messages })
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
		fullOutput = resolvedOutput.fullOutput;
		result.savedOutputPath = resolvedOutput.savedPath;
		result.outputSaveError = resolvedOutput.saveError;
		if (resolvedOutput.savedPath) {
			result.outputReference = formatSavedOutputReference(resolvedOutput.savedPath, fullOutput);
		}
	}
	artifactOutputByResult.set(result, fullOutput);
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
	const sessionEnabled = Boolean(options.sessionFile || options.sessionDir) || shareEnabled;
	const outputSnapshot = captureSingleOutputSnapshot(options.outputPath);
	const skillNames = options.skills ?? agent.skills ?? [];
	const skillCwd = options.cwd ?? runtimeCwd;
	const { resolved: resolvedSkills, missing: missingSkills } = resolveSkillsWithFallback(skillNames, skillCwd, runtimeCwd);
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

	const candidates = buildModelCandidates(
		options.modelOverride ?? agent.model,
		agent.fallbackModels,
		options.availableModels,
		options.preferredModelProvider,
	);
	const attemptedModels: string[] = [];
	const modelAttempts: ModelAttempt[] = [];
	const aggregateUsage = emptyUsage();
	const attemptNotes: string[] = [];
	let totalToolCount = 0;
	let totalDurationMs = 0;

	let artifactPathsResult: ArtifactPaths | undefined;
	let jsonlPath: string | undefined;
	if (options.artifactsDir && options.artifactConfig?.enabled !== false) {
		artifactPathsResult = getArtifactPaths(options.artifactsDir, options.runId, agentName, options.index);
		ensureArtifactsDir(options.artifactsDir);
		if (options.artifactConfig?.includeInput !== false) {
			writeArtifact(artifactPathsResult.inputPath, `# Task for ${agentName}\n\n${task}`);
		}
		if (options.artifactConfig?.includeJsonl !== false) {
			jsonlPath = artifactPathsResult.jsonlPath;
		}
	}

	let lastResult: SingleResult | undefined;
	const modelsToTry = candidates.length > 0 ? candidates : [undefined];
	for (let i = 0; i < modelsToTry.length; i++) {
		const candidate = modelsToTry[i];
		if (candidate) attemptedModels.push(candidate);
		const result = await runSingleAttempt(runtimeCwd, agent, task, candidate, options, {
			sessionEnabled,
			systemPrompt,
			resolvedSkillNames: resolvedSkills.length > 0 ? resolvedSkills.map((skill) => skill.name) : undefined,
			skillsWarning: missingSkills.length > 0 ? `Skills not found: ${missingSkills.join(", ")}` : undefined,
			jsonlPath,
			artifactPaths: artifactPathsResult,
			attemptNotes,
			outputSnapshot,
		});
		lastResult = result;
		sumUsage(aggregateUsage, result.usage);
		totalToolCount += result.progressSummary?.toolCount ?? 0;
		totalDurationMs += result.progressSummary?.durationMs ?? 0;
		const attemptSucceeded = result.exitCode === 0 && !result.error;
		const attempt: ModelAttempt = {
			model: candidate ?? result.model ?? agent.model ?? "default",
			success: attemptSucceeded,
			exitCode: result.exitCode,
			error: result.error,
			usage: { ...result.usage },
		};
		modelAttempts.push(attempt);
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

	if (artifactPathsResult && options.artifactConfig?.enabled !== false) {
		result.artifactPaths = artifactPathsResult;
		if (options.artifactConfig?.includeOutput !== false) {
			writeArtifact(artifactPathsResult.outputPath, artifactOutputByResult.get(result) ?? result.finalOutput ?? "");
		}
		if (options.artifactConfig?.includeMetadata !== false) {
			writeMetadata(artifactPathsResult.metadataPath, {
				runId: options.runId,
				agent: agentName,
				task,
				exitCode: result.exitCode,
				usage: result.usage,
				model: result.model,
				attemptedModels: result.attemptedModels,
				modelAttempts: result.modelAttempts,
				durationMs: result.progressSummary?.durationMs,
				toolCount: result.progressSummary?.toolCount,
				error: result.error,
				skills: result.skills,
				skillsWarning: result.skillsWarning,
				timestamp: Date.now(),
			});
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

	return result;
}
