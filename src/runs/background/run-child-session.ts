/**
 * Drives one in-process child session for the detached async runner: creates
 * the session through the runner's `ChildSessionFactory`, mirrors its events
 * into `events.jsonl`, the transcript, and the step output log, applies
 * interrupt, timeout, stop, and steer requests, and folds the run into the
 * step result the runner finalizes.
 */
import type { Message } from "@earendil-works/pi-ai";
import type { ChildTranscriptWriter } from "../../shared/child-transcript.ts";
import { extractTextFromContent, extractToolArgsPreview, getFinalOutput, hasEmptyTerminalAssistantResponse } from "../../shared/utils.ts";
import type { EffectsProjection, RuntimeAcknowledgedChildExtensions, SubagentOutputState, ToolBudgetState, Usage } from "../../shared/types.ts";
import {
	acceptChildWatchdogEvent,
	applyChildWatchdogMessage,
	childWatchdogIsActive,
	isChildWatchdogStatusEvent,
	type ChildWatchdogConfig,
	type ChildWatchdogStateSnapshot,
	type ChildWatchdogStatusEvent,
} from "../../watchdog/child-status.ts";
import { projectChildLifecycle, type ChildLifecycleAction, type ChildLifecycleState } from "../shared/child-lifecycle.ts";
import { formatSubagentModelVerificationError } from "../shared/model-fallback.ts";
import { isMutatingTool, resolveCurrentPath } from "../shared/long-running-guard.ts";
import { effectiveToolTimeoutMs, formatToolTimeoutMessage, toolTimeoutCallKey } from "../shared/tool-timeout.ts";
import type { InProcessChildLaunch } from "../shared/child-launch.ts";
import { projectChildSessionEventForJson, type ChildSession, type ChildSessionEvent, type ChildSessionFactory } from "../shared/child-session.ts";
import { formatSteerMessage } from "../shared/subagent-prompt-runtime.ts";
import type { SteerDeliveryStatus, SteerRequest } from "./control-channel.ts";

export interface ChildEventContext {
	runId: string;
	stepIndex: number;
	agent: string;
}

export interface ChildUsage {
	input?: number;
	inputTokens?: number;
	output?: number;
	outputTokens?: number;
	cacheRead?: number;
	cacheReadTokens?: number;
	cacheWrite?: number;
	cost?: { total?: number };
}

export type ChildMessage = Message & {
	model?: string;
	errorMessage?: string;
	usage?: ChildUsage;
};

export interface ChildEvent {
	type?: string;
	message?: ChildMessage;
	toolName?: string;
	toolCallId?: string;
	args?: Record<string, unknown>;
	willRetry?: unknown;
}

/** Outcome of handing a steer request to a live child session. */
export interface SteerDelivery {
	state: "delivered" | "queued" | "failed";
	deliveryStatus?: SteerDeliveryStatus;
	message: string;
}

export type StepSteerHandler = (request: SteerRequest) => Promise<SteerDelivery>;

export interface RunChildSessionInput {
	factory: ChildSessionFactory;
	launch: InProcessChildLaunch;
	/** Prompt text; the task with its `Task:` prefix. */
	prompt: string;
	childWatchdog?: ChildWatchdogConfig;
	childEventContext?: ChildEventContext;
	/** Persist one child event into `events.jsonl`; the runner owns the bounded log. */
	appendChildEvent: (event: Record<string, unknown>) => void;
	/** Append one line to the step output log and the progress tab. */
	writeOutputLine: (line: string) => void;
	registerInterrupt?: (interrupt: (() => void) | undefined) => void;
	registerTimeout?: (interrupt: (() => void) | undefined) => void;
	registerStop?: (stop: (() => void) | undefined) => void;
	registerSteer?: (steer: StepSteerHandler | undefined) => void;
	/** Receives the sink the child's watchdog hook reports status through; the launch's `watchdogStatus` must forward to it. */
	registerWatchdogStatus?: (sink: ((event: ChildWatchdogStatusEvent) => void) | undefined) => void;
	timeoutMessage?: string;
	stopMessage?: string;
	onChildEvent?: (event: ChildEvent) => void;
	transcriptWriter?: ChildTranscriptWriter;
	toolTimeoutMs?: number;
	runDeadlineAt?: number;
	expectedModelForVerification?: string;
	modelVerificationRegistry?: Array<{ provider: string; id: string; fullId: string }>;
	modelResponseAliases?: Record<string, string[]>;
	mutationTools?: readonly string[];
}

export interface RunChildSessionResult {
	exitCode: number;
	messages: Message[];
	usage: Usage;
	toolCount: number;
	durationMs: number;
	model?: string;
	error?: string;
	finalOutput: string;
	outputState: SubagentOutputState;
	interrupted?: boolean;
	timedOut?: boolean;
	stopped?: boolean;
	observedMutationAttempt?: boolean;
	structuredOutputToolInvoked?: boolean;
	structuredOutputMessageStartIndex?: number;
	watchdog?: ChildWatchdogStateSnapshot;
	sessionFile?: string;
	currentTool?: string;
	currentToolArgs?: string;
	currentPath?: string;
	afterCompactionSettlement?: boolean;
	/** Set by the runner while it finalizes the attempt. */
	toolBudget?: ToolBudgetState;
	toolBudgetBlocked?: boolean;
	structuredOutput?: unknown;
	runtimeAcknowledgedExtensions?: RuntimeAcknowledgedChildExtensions;
	abortRecoveryDiagnostic?: string;
	effects?: EffectsProjection;
}

/** Events the child emits while the model streams; not persisted into the diagnostic log. */
function shouldPersistChildEvent(event: Record<string, unknown>): boolean {
	return event.type !== "message_update";
}

function assistantStartsToolCall(message: Message): boolean {
	return Array.isArray(message.content)
		&& message.content.some((part) => (part as { type?: string }).type === "toolCall");
}

function isTerminalAssistantStop(message: Message): boolean {
	return (message as { stopReason?: string }).stopReason === "stop" && !assistantStartsToolCall(message);
}

function emptyUsage(): Usage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
}

function omitUndefined<T extends object>(value: T): T {
	for (const key of Object.keys(value) as Array<keyof T>) {
		if (value[key] === undefined) delete value[key];
	}
	return value;
}

const FINAL_STOP_GRACE_MS = 1000;
const HARD_FINISH_MS = 3000;
const ABORT_SETTLE_MS = 3000;

export function runChildSession(input: RunChildSessionInput): Promise<RunChildSessionResult> {
	return new Promise((resolve) => {
		const startedAt = Date.now();
		const messages: Message[] = [];
		const usage = emptyUsage();
		let model: string | undefined;
		let error: string | undefined;
		let assistantError: string | undefined;
		let interrupted = false;
		let timedOut = false;
		let stopped = false;
		let observedMutationAttempt = false;
		let structuredOutputToolInvoked = false;
		let structuredOutputMessageStartIndex: number | undefined;
		let currentTool: string | undefined;
		let currentToolArgs: string | undefined;
		let currentPath: string | undefined;
		let toolCount = 0;
		let session: ChildSession | undefined;
		let unsubscribe: (() => void) | undefined;
		let settled = false;
		let promptSettled = false;
		let forcedTermination = false;
		let cleanTerminalAssistantStopReceived = false;
		let agentSettledReceived = false;
		let compactionStartedReceived = false;
		let afterCompactionSettlement = false;
		let finalDrainTimer: NodeJS.Timeout | undefined;
		let finalHardFinishTimer: NodeJS.Timeout | undefined;
		let watchdogTailTimer: NodeJS.Timeout | undefined;
		let abortSettleTimer: NodeJS.Timeout | undefined;
		let childWatchdogState: ChildWatchdogStateSnapshot | undefined;
		const childLifecycleState: ChildLifecycleState = { compactionRetryActive: false };
		const timeoutMessage = () => input.timeoutMessage ?? "Subagent timed out.";
		const stopMessage = () => input.stopMessage ?? "Subagent stopped by user.";

		type ActiveToolCall = { key: string; tool: string; args?: string; path?: string };
		let activeToolSequence = 0;
		const activeToolCalls = new Map<string, ActiveToolCall>();
		const activeToolKeysByName = new Map<string, string[]>();
		const refreshCurrentTool = (): void => {
			const active = [...activeToolCalls.values()].at(-1);
			currentTool = active?.tool;
			currentToolArgs = active?.args;
			currentPath = active?.path;
		};
		const recordActiveToolCall = (event: { toolCallId?: unknown; toolName: string; args?: Record<string, unknown> }): void => {
			const key = toolTimeoutCallKey(event, ++activeToolSequence);
			const active = omitUndefined({
				key,
				tool: event.toolName,
				args: extractToolArgsPreview(event.args ?? {}),
				path: resolveCurrentPath(event.toolName, event.args),
			});
			activeToolCalls.set(key, active);
			const keys = activeToolKeysByName.get(active.tool) ?? [];
			keys.push(key);
			activeToolKeysByName.set(active.tool, keys);
			refreshCurrentTool();
		};
		const removeActiveToolCall = (event: { toolCallId?: unknown; toolName?: unknown }): void => {
			const key = typeof event.toolCallId === "string" && event.toolCallId.length > 0
				? `id:${event.toolCallId}`
				: typeof event.toolName === "string"
					? activeToolKeysByName.get(event.toolName)?.[0]
					: activeToolCalls.size === 1
						? [...activeToolCalls.keys()][0]
						: undefined;
			if (!key) return;
			const active = activeToolCalls.get(key);
			if (!active) return;
			activeToolCalls.delete(key);
			const keys = activeToolKeysByName.get(active.tool)?.filter((candidate) => candidate !== key) ?? [];
			if (keys.length > 0) activeToolKeysByName.set(active.tool, keys);
			else activeToolKeysByName.delete(active.tool);
			refreshCurrentTool();
		};

		const abortChild = (): void => {
			if (!session || settled || promptSettled) return;
			void session.abort().catch(() => {
				// The run settles through its prompt promise; abort failures are not separately actionable.
			});
			if (!abortSettleTimer) {
				abortSettleTimer = setTimeout(() => {
					abortSettleTimer = undefined;
					if (!settled && !promptSettled) settle(undefined, true);
				}, ABORT_SETTLE_MS);
				abortSettleTimer.unref?.();
			}
		};

		const writeOutputText = (text: string) => {
			for (const line of text.split("\n")) {
				if (line.trim()) input.writeOutputLine(line);
			}
		};
		const appendChildEvent = (event: Record<string, unknown>) => {
			if (!input.childEventContext) return;
			if (!shouldPersistChildEvent(event)) return;
			input.appendChildEvent({
				...event,
				subagentSource: "child",
				subagentRunId: input.childEventContext.runId,
				subagentStepIndex: input.childEventContext.stepIndex,
				subagentAgent: input.childEventContext.agent,
				observedAt: Date.now(),
			});
		};

		const clearWatchdogTailTimer = (): void => {
			if (watchdogTailTimer) {
				clearTimeout(watchdogTailTimer);
				watchdogTailTimer = undefined;
			}
		};
		const clearFinalDrainTimers = (): void => {
			if (finalDrainTimer) {
				clearTimeout(finalDrainTimer);
				finalDrainTimer = undefined;
			}
			if (finalHardFinishTimer) {
				clearTimeout(finalHardFinishTimer);
				finalHardFinishTimer = undefined;
			}
		};
		function armWatchdogTail(): void {
			if ((!cleanTerminalAssistantStopReceived && !agentSettledReceived) || watchdogTailTimer || settled || promptSettled) return;
			watchdogTailTimer = setTimeout(() => {
				watchdogTailTimer = undefined;
				childWatchdogState = {
					phase: "stale",
					seq: (childWatchdogState?.seq ?? 0) + 1,
					lastUpdate: Date.now(),
					reason: "child watchdog tail timeout",
					timedOut: true,
				};
				startFinalDrain();
			}, input.childWatchdog?.watchdogTailTimeoutMs ?? 120_000);
			watchdogTailTimer.unref?.();
		}
		// If the child emits its terminal event but its run never settles (a hook
		// is stuck), abort it after a short grace period and then finish without it.
		function startFinalDrain(): void {
			if (childWatchdogIsActive(childWatchdogState)) {
				armWatchdogTail();
				return;
			}
			if (promptSettled || finalDrainTimer || settled) return;
			finalDrainTimer = setTimeout(() => {
				if (settled || promptSettled) return;
				forcedTermination = true;
				if (!cleanTerminalAssistantStopReceived && !agentSettledReceived && !error && !assistantError) {
					error = `Subagent session did not settle within ${FINAL_STOP_GRACE_MS}ms after its terminal event. Aborting it.`;
				}
				abortChild();
				finalHardFinishTimer = setTimeout(() => {
					if (settled || promptSettled) return;
					settle(undefined, true);
				}, HARD_FINISH_MS);
				finalHardFinishTimer.unref?.();
			}, FINAL_STOP_GRACE_MS);
			finalDrainTimer.unref?.();
		}
		const applyChildLifecycle = (action: ChildLifecycleAction): void => {
			if (action === "cancel-drain") {
				clearFinalDrainTimers();
				clearWatchdogTailTimer();
				return;
			}
			if (action === "start-drain") startFinalDrain();
		};

		let toolTimeoutSequence = 0;
		const activeToolTimeouts = new Map<string, { toolName: string; timer: ReturnType<typeof setTimeout> }>();
		const activeToolTimeoutKeysByName = new Map<string, string[]>();
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
		};
		const terminateForTimeout = (message: string): void => {
			if (settled || promptSettled || timedOut || stopped) return;
			timedOut = true;
			interrupted = false;
			error = message;
			abortChild();
		};
		const armToolTimeout = (event: { toolCallId?: unknown; toolName: string }): void => {
			const timeoutForTool = effectiveToolTimeoutMs(event.toolName, input.toolTimeoutMs);
			if (timeoutForTool === undefined) return;
			const runRemaining = input.runDeadlineAt === undefined ? undefined : Math.max(0, input.runDeadlineAt - Date.now());
			if (runRemaining !== undefined && timeoutForTool >= runRemaining) return;
			const key = toolTimeoutCallKey(event, ++toolTimeoutSequence);
			const toolName = event.toolName;
			const timer = setTimeout(() => {
				removeToolTimeoutKey(key);
				terminateForTimeout(formatToolTimeoutMessage(toolName, timeoutForTool));
			}, timeoutForTool);
			timer.unref?.();
			activeToolTimeouts.set(key, { toolName, timer });
			const keys = activeToolTimeoutKeysByName.get(toolName) ?? [];
			keys.push(key);
			activeToolTimeoutKeysByName.set(toolName, keys);
		};

		const processEvent = (raw: ChildSessionEvent): void => {
			if (settled) return;
			const event = raw as ChildSessionEvent & ChildEvent;
			appendChildEvent(projectChildSessionEventForJson(raw) as Record<string, unknown>);
			input.transcriptWriter?.writeChildEvent(projectChildSessionEventForJson(raw) as ChildEvent);
			if (event.type === "compaction_start") compactionStartedReceived = true;
			if (event.type === "compaction_end" && event.willRetry === true) {
				compactionStartedReceived = false;
				afterCompactionSettlement = false;
			}
			if (event.type === "agent_start" || event.type === "auto_retry_start") {
				compactionStartedReceived = false;
				afterCompactionSettlement = false;
			}
			const lifecycleAction = projectChildLifecycle(event, false, childLifecycleState);
			if (event.type === "agent_settled" && lifecycleAction === "start-drain") {
				agentSettledReceived = true;
				afterCompactionSettlement = compactionStartedReceived;
			}
			applyChildLifecycle(lifecycleAction);

			if (isChildWatchdogStatusEvent(event)) {
				if (!input.childWatchdog) return;
				const next = acceptChildWatchdogEvent({
					current: childWatchdogState,
					event,
					...(input.childEventContext ? {
						runId: input.childEventContext.runId,
						agent: input.childEventContext.agent,
						childIndex: input.childEventContext.stepIndex,
					} : {}),
				});
				if (!next) return;
				childWatchdogState = next;
				input.onChildEvent?.(event);
				if (childWatchdogIsActive(next)) {
					clearFinalDrainTimers();
					armWatchdogTail();
				} else {
					clearWatchdogTailTimer();
					if (cleanTerminalAssistantStopReceived || agentSettledReceived) startFinalDrain();
				}
				return;
			}

			input.onChildEvent?.(event);

			if (event.type === "tool_execution_end") {
				clearActiveToolTimeout(event);
				removeActiveToolCall(event);
				return;
			}

			if (event.type === "tool_execution_start" && event.toolName) {
				toolCount += 1;
				const toolArgs = event.args && typeof event.args === "object" && !Array.isArray(event.args) ? event.args : {};
				armToolTimeout({ toolCallId: event.toolCallId, toolName: event.toolName });
				recordActiveToolCall({ toolCallId: event.toolCallId, toolName: event.toolName, args: toolArgs });
				if (event.toolName === "structured_output") {
					structuredOutputToolInvoked = true;
					structuredOutputMessageStartIndex = messages.length;
				}
				observedMutationAttempt = observedMutationAttempt || isMutatingTool(event.toolName, toolArgs, input.mutationTools);
				const preview = extractToolArgsPreview(toolArgs);
				input.writeOutputLine(preview ? `${event.toolName}: ${preview}` : event.toolName);
				return;
			}

			if ((event.type === "message_end" || event.type === "tool_result_end") && event.message) {
				if (event.type === "tool_result_end") {
					clearActiveToolTimeout(event);
					removeActiveToolCall({
						toolCallId: (event.message as { toolCallId?: unknown }).toolCallId ?? event.toolCallId,
						toolName: (event.message as { toolName?: unknown }).toolName ?? event.toolName,
					});
				}
				messages.push(event.message);
				const text = extractTextFromContent(event.message.content);
				if (text) writeOutputText(text);

				if (input.childWatchdog && event.type === "message_end") {
					const next = applyChildWatchdogMessage(childWatchdogState, event.message);
					if (next) childWatchdogState = next;
				}
				if (event.type !== "message_end" || event.message.role !== "assistant") return;
				const hasToolCall = assistantStartsToolCall(event.message);
				if (event.message.model) {
					model = event.message.model;
					if (input.expectedModelForVerification && !hasToolCall) {
						const modelVerificationError = formatSubagentModelVerificationError(input.expectedModelForVerification, event.message.model, input.modelVerificationRegistry, input.modelResponseAliases);
						if (modelVerificationError && !error) error = modelVerificationError;
					}
				}
				if (event.message.errorMessage) assistantError = event.message.errorMessage;
				else if (hasToolCall && event.message.stopReason === "toolUse") {
					// A recovered request can finish via a terminating tool, without a text stop.
					assistantError = undefined;
				}
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
					clearAllToolTimeouts();
					activeToolCalls.clear();
					activeToolKeysByName.clear();
					refreshCurrentTool();
					applyChildLifecycle(projectChildLifecycle(event, true, childLifecycleState));
				}
			}
		};

		/** Stops observing the child and returns when its extensions have shut down. */
		const finish = (): Promise<void> => {
			clearFinalDrainTimers();
			clearWatchdogTailTimer();
			clearAllToolTimeouts();
			if (abortSettleTimer) {
				clearTimeout(abortSettleTimer);
				abortSettleTimer = undefined;
			}
			input.registerInterrupt?.(undefined);
			input.registerTimeout?.(undefined);
			input.registerStop?.(undefined);
			input.registerSteer?.(undefined);
			input.registerWatchdogStatus?.(undefined);
			unsubscribe?.();
			return Promise.resolve().then(() => session?.dispose()).catch(() => undefined);
		};

		/** The child run ended (or was forced to end); fold in the outcome once the child's shutdown work is done. */
		const settle = (promptError: unknown, forced = false): void => {
			if (settled) return;
			settled = true;
			const closed = finish();
			const finalOutput = getFinalOutput(messages);
			let finalError = error ?? assistantError;
			if (!finalError && promptError !== undefined) {
				finalError = promptError instanceof Error ? promptError.message : String(promptError);
			}
			const forcedDrainAfterFinalSuccess = (forced || forcedTermination) && (cleanTerminalAssistantStopReceived || agentSettledReceived) && !finalError;
			const forcedDrainAfterEmptyTerminal = forcedDrainAfterFinalSuccess && hasEmptyTerminalAssistantResponse(messages);
			if (!finalError && forced && !forcedDrainAfterFinalSuccess && !interrupted && !timedOut && !stopped) {
				finalError = "Subagent session did not settle after it was aborted.";
			}
			const exitCode = timedOut || stopped
				? 1
				: interrupted || (forcedDrainAfterFinalSuccess && !forcedDrainAfterEmptyTerminal)
					? 0
					: finalError || promptError !== undefined ? 1 : 0;
			void closed.then(() => resolve(omitUndefined({
				exitCode,
				messages,
				usage,
				toolCount,
				durationMs: Date.now() - startedAt,
				model,
				error: stopped ? stopMessage() : timedOut ? (error ?? timeoutMessage()) : interrupted || (forcedDrainAfterFinalSuccess && !forcedDrainAfterEmptyTerminal) ? undefined : finalError,
				finalOutput: (timedOut || stopped) && !finalOutput.trim() ? (stopped ? stopMessage() : error ?? timeoutMessage()) : finalOutput,
				outputState: finalOutput.trim() ? "present" : "absent",
				interrupted: interrupted || undefined,
				timedOut: timedOut || undefined,
				stopped: stopped || undefined,
				observedMutationAttempt,
				structuredOutputToolInvoked,
				structuredOutputMessageStartIndex,
				watchdog: childWatchdogState,
				sessionFile: session?.sessionFile,
				currentTool,
				currentToolArgs,
				currentPath,
				afterCompactionSettlement: afterCompactionSettlement || undefined,
			})));
		};

		input.registerInterrupt?.(() => {
			if (settled || promptSettled || timedOut || stopped) return;
			interrupted = true;
			if (!error) error = "Interrupted. Waiting for explicit next action.";
			abortChild();
		});
		input.registerTimeout?.(() => terminateForTimeout(timeoutMessage()));
		input.registerStop?.(() => {
			if (settled || promptSettled || timedOut || stopped) return;
			stopped = true;
			interrupted = false;
			error = stopMessage();
			abortChild();
		});

		void (async () => {
			try {
				const created = await input.factory.create({
					...input.launch.session,
					onExtensionError: (extensionError) => {
						input.transcriptWriter?.writeStderrLine(`Extension error (${extensionError.extensionPath}, ${extensionError.event}): ${extensionError.error instanceof Error ? extensionError.error.message : String(extensionError.error)}`);
					},
				});
				if (settled) {
					void created.dispose();
					return;
				}
				session = created;
				unsubscribe = created.subscribe(processEvent);
				input.registerWatchdogStatus?.((event) => processEvent(event as unknown as ChildSessionEvent));
				input.registerSteer?.(async (request) => {
					const text = formatSteerMessage(request);
					const followUp = request.mode === "follow_up";
					try {
						if (followUp) await created.followUp(text);
						else await created.steer(text);
					} catch (steerError) {
						return { state: "failed", message: steerError instanceof Error ? steerError.message : String(steerError) };
					}
					return followUp
						? { state: "queued", deliveryStatus: "queued", message: "Pi queued the follow-up input." }
						: { state: "delivered", deliveryStatus: "delivered", message: "Pi accepted the steering input." };
				});
				if (interrupted || timedOut || stopped) abortChild();
				await created.prompt(input.prompt);
				promptSettled = true;
				settle(undefined);
			} catch (promptError) {
				promptSettled = true;
				settle(promptError ?? new Error("Child session failed."));
			}
		})();
	});
}
