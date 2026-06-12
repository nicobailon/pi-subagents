import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type { Message } from "@earendil-works/pi-ai";
import { writeAtomicJson } from "../../shared/atomic-json.ts";
import { appendJsonl, getArtifactPaths } from "../../shared/artifacts.ts";
import { PI_CODING_AGENT_PACKAGE, getPiSpawnCommand, resolveInstalledPiPackageRoot } from "../shared/pi-spawn.ts";
import { captureSingleOutputSnapshot, finalizeSingleOutput, formatSavedOutputReference, resolveSingleOutput, type SingleOutputSnapshot } from "../shared/single-output.ts";
import {
	type AcceptanceFinalizationTurn,
	type AcceptanceLedger,
	type ActivityState,
	type ArtifactConfig,
	type ArtifactPaths,
	type AsyncParallelGroupStatus,
	type AsyncStatus,
	type ChainOutputMap,
	type ModelAttempt,
	type NestedRouteInfo,
	type ResolvedControlConfig,
	type ResourceLimitExceeded,
	type SubagentRunMode,
	type TokenUsage,
	type Usage,
	type WorkflowGraphSnapshot,
	DEFAULT_MAX_OUTPUT,
	type MaxOutputConfig,
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
	isDynamicRunnerGroup,
	isParallelGroup,
	flattenSteps,
	mapConcurrent,
	aggregateParallelOutputs,
	MAX_PARALLEL_CONCURRENCY,
} from "../shared/parallel-utils.ts";
import { buildPiArgs, cleanupTempDir } from "../shared/pi-args.ts";
import { outputEntryFromAsyncResult, resolveOutputReferences } from "../shared/chain-outputs.ts";
import { createStructuredOutputRuntime, readStructuredOutput } from "../shared/structured-output.ts";
import { collectDynamicResults, DynamicFanoutError, materializeDynamicParallelStep, validateDynamicCollection } from "../shared/dynamic-fanout.ts";
import { nestedSummaryFromAsyncStatus, writeNestedEvent } from "../shared/nested-events.ts";
import { formatModelAttemptNote, isRetryableModelFailure } from "../shared/model-fallback.ts";
import { attachPostExitStdioGuard, trySignalChild } from "../../shared/post-exit-stdio-guard.ts";
import { detectSubagentError, extractTextFromContent, extractToolArgsPreview, formatResourceLimitExceeded, getFinalOutput } from "../../shared/utils.ts";
import { evaluateCompletionMutationGuard, resolveCompletionPolicy } from "../shared/completion-guard.ts";
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
import { writeInitialProgressFile } from "../../shared/settings.ts";
import { resolveSubagentIntercomTarget } from "../../intercom/intercom-bridge.ts";
import {
	acceptanceFailureMessage,
	acceptanceSelfReviewConfig,
	attachFinalizationToLedger,
	buildFinalizationProcessFailureLedger,
	createFinalizationProcessFailureTurn,
	createFinalizationTurn,
	evaluateAcceptance,
	formatAcceptanceFinalizationPrompt,
	formatAcceptancePrompt,
	shouldRunAcceptanceFinalization,
	stripAcceptanceReport,
} from "../shared/acceptance.ts";

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
	controlConfig?: ResolvedControlConfig;
	controlIntercomTarget?: string;
	childIntercomTargets?: Array<string | undefined>;
	resultMode?: SubagentRunMode;
	dynamicFanoutMaxItems?: number;
	workflowGraph?: WorkflowGraphSnapshot;
	nestedRoute?: NestedRouteInfo;
	nestedSelf?: { parentRunId: string; parentStepIndex?: number; depth: number; path?: Array<{ runId: string; stepIndex?: number; agent?: string }> };
}

interface StepResult {
	agent: string;
	output: string;
	error?: string;
	success: boolean;
	exitCode?: number | null;
	skipped?: boolean;
	sessionFile?: string;
	intercomTarget?: string;
	model?: string;
	attemptedModels?: string[];
	modelAttempts?: ModelAttempt[];
	artifactPaths?: ArtifactPaths;
	truncated?: boolean;
	structuredOutput?: unknown;
	structuredOutputPath?: string;
	structuredOutputSchemaPath?: string;
	acceptance?: AcceptanceLedger;
	resourceLimitExceeded?: ResourceLimitExceeded;
}

const ASYNC_INTERRUPT_SIGNAL: NodeJS.Signals = process.platform === "win32" ? "SIGBREAK" : "SIGUSR2";

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

function appendRecentStepOutput(step: RunnerStatusStep, lines: string[]): void {
	const nonEmpty = lines.filter((line) => line.trim());
	if (nonEmpty.length === 0) return;
	step.recentOutput ??= [];
	step.recentOutput.push(...nonEmpty);
	if (step.recentOutput.length > 50) {
		step.recentOutput.splice(0, step.recentOutput.length - 50);
	}
}

function resetStepLiveDetail(step: RunnerStatusStep): void {
	step.currentTool = undefined;
	step.currentToolArgs = undefined;
	step.currentToolStartedAt = undefined;
	step.currentPath = undefined;
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
}

interface RunPiStreamingResult {
	stderr: string;
	exitCode: number | null;
	messages: Message[];
	usage: Usage;
	model?: string;
	error?: string;
	finalOutput: string;
	interrupted?: boolean;
	observedMutationAttempt?: boolean;
	resourceLimitExceeded?: ResourceLimitExceeded;
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
	maxExecutionTimeMs?: number,
	maxTokens?: number,
): Promise<RunPiStreamingResult> {
	return new Promise((resolve) => {
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
		let stderr = "";
		let stdoutBuf = "";
		let stderrBuf = "";
		const messages: Message[] = [];
		const usage = emptyUsage();
		let model: string | undefined;
		let error: string | undefined;
		let assistantError: string | undefined;
		let interrupted = false;
		let resourceLimitExceeded: ResourceLimitExceeded | undefined;
		let observedMutationAttempt = false;
		let resourceLimitTimer: NodeJS.Timeout | undefined;
		let resourceLimitEscalationTimer: NodeJS.Timeout | undefined;
		const rawStdoutLines: string[] = [];

		const writeOutputLine = (line: string) => {
			if (!line.trim()) return;
			outputStream.write(`${line}\n`);
		};

		const writeOutputText = (text: string) => {
			for (const line of text.split("\n")) {
				writeOutputLine(line);
			}
		};

		const triggerResourceLimit = (kind: ResourceLimitExceeded["kind"], limit: number, observed?: number) => {
			if (settled || resourceLimitExceeded) return;
			const message = formatResourceLimitExceeded({ agent: childEventContext?.agent ?? "subagent", kind, limit, observed });
			resourceLimitExceeded = { kind, limit, ...(observed !== undefined ? { observed } : {}), message };
			error = message;
			writeOutputLine(message);
			trySignalChild(child, "SIGINT");
			resourceLimitEscalationTimer = setTimeout(() => {
				if (!settled) trySignalChild(child, "SIGTERM");
			}, 1000);
			resourceLimitEscalationTimer.unref?.();
		};

		const appendChildEvent = (event: Record<string, unknown>) => {
			if (!childEventContext) return;
			appendJsonl(childEventContext.eventsPath, JSON.stringify({
				...event,
				subagentSource: "child",
				subagentRunId: childEventContext.runId,
				subagentStepIndex: childEventContext.stepIndex,
				subagentAgent: childEventContext.agent,
				observedAt: Date.now(),
			}));
		};

		const appendChildLine = (type: "subagent.child.stdout" | "subagent.child.stderr", line: string) => {
			appendChildEvent({ type, line });
		};

		const processStdoutLine = (line: string) => {
			if (!line.trim()) return;
			let event: ChildEvent;
			try {
				event = JSON.parse(line) as ChildEvent;
			} catch {
				rawStdoutLines.push(line);
				writeOutputLine(line);
				appendChildLine("subagent.child.stdout", line);
				return;
			}

			appendChildEvent(event);
			onChildEvent?.(event);

			if (event.type === "tool_execution_start" && event.toolName) {
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
					const observedTokens = usage.input + usage.output;
					if (maxTokens !== undefined && observedTokens >= maxTokens) {
						triggerResourceLimit("maxTokens", maxTokens, observedTokens);
					}
				}
				const stopReason = (event.message as { stopReason?: string }).stopReason;
				const hasToolCall = Array.isArray(event.message.content)
					&& event.message.content.some((part) => (part as { type?: string }).type === "toolCall");
				if (stopReason === "stop" && !hasToolCall) {
					if (!event.message.errorMessage && extractTextFromContent(event.message.content).trim()) assistantError = undefined;
					cleanTerminalAssistantStopReceived ||= !event.message.errorMessage;
					startFinalDrain();
				}
			}
		};

		const processStderrText = (text: string) => {
			stderr += text;
			stderrBuf += text;
			outputStream.write(text);
			if (!childEventContext) return;
			const lines = stderrBuf.split("\n");
			stderrBuf = lines.pop() || "";
			for (const line of lines) {
				if (!line.trim()) continue;
				appendChildLine("subagent.child.stderr", line);
			}
		};

		// Guard both cases that can leave the parent waiting on `close` forever:
		// a lingering stdio holder after `exit`, or a child that never exits.
		const FINAL_STOP_GRACE_MS = 1000;
		const HARD_KILL_MS = 3000;
		let childExited = false;
		let forcedTerminationSignal = false;
		let cleanTerminalAssistantStopReceived = false;
		let finalDrainTimer: NodeJS.Timeout | undefined;
		let finalHardKillTimer: NodeJS.Timeout | undefined;
		let settled = false;
		if (maxExecutionTimeMs !== undefined) {
			resourceLimitTimer = setTimeout(() => {
				triggerResourceLimit("maxExecutionTimeMs", maxExecutionTimeMs);
			}, maxExecutionTimeMs);
			resourceLimitTimer.unref?.();
		}
		const clearStdioGuard = attachPostExitStdioGuard(child, { idleMs: 2000, hardMs: 8000 });
		child.stdout.on("data", (chunk: Buffer) => {
			const text = chunk.toString();
			stdoutBuf += text;
			const lines = stdoutBuf.split("\n");
			stdoutBuf = lines.pop() || "";
			for (const line of lines) processStdoutLine(line);
		});

		child.stderr.on("data", (chunk: Buffer) => {
			processStderrText(chunk.toString());
		});
		registerInterrupt?.(() => {
			if (settled || resourceLimitExceeded) return;
			interrupted = true;
			if (!error) error = "Interrupted. Waiting for explicit next action.";
			trySignalChild(child, "SIGINT");
			setTimeout(() => {
				if (!settled) trySignalChild(child, "SIGTERM");
			}, 1000).unref?.();
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
			if (resourceLimitTimer) {
				clearTimeout(resourceLimitTimer);
				resourceLimitTimer = undefined;
			}
			if (resourceLimitEscalationTimer) {
				clearTimeout(resourceLimitEscalationTimer);
				resourceLimitEscalationTimer = undefined;
			}
		};
		function startFinalDrain(): void {
			if (childExited || finalDrainTimer || settled) return;
			finalDrainTimer = setTimeout(() => {
				if (settled) return;
				const termSent = trySignalChild(child, "SIGTERM");
				if (!termSent) return;
				forcedTerminationSignal = true;
				if (!cleanTerminalAssistantStopReceived && !error && !assistantError) {
					error = `Subagent process did not exit within ${FINAL_STOP_GRACE_MS}ms after its final message. Forcing termination.`;
				}
				finalHardKillTimer = setTimeout(() => {
					if (settled) return;
					forcedTerminationSignal = trySignalChild(child, "SIGKILL") || forcedTerminationSignal;
				}, HARD_KILL_MS);
				finalHardKillTimer.unref?.();
			}, FINAL_STOP_GRACE_MS);
			finalDrainTimer.unref?.();
		}
		child.on("exit", () => {
			childExited = true;
			clearDrainTimers();
		});
		child.on("close", (exitCode, signal) => {
			settled = true;
			registerInterrupt?.(undefined);
			clearDrainTimers();
			clearStdioGuard();
			if (stdoutBuf.trim()) processStdoutLine(stdoutBuf);
			if (stderrBuf.trim()) appendChildLine("subagent.child.stderr", stderrBuf);
			outputStream.end();
			const finalOutput = resourceLimitExceeded?.message ?? (getFinalOutput(messages) || rawStdoutLines.join("\n").trim());
			const finalError = resourceLimitExceeded?.message ?? error ?? assistantError;
			const forcedDrainAfterFinalSuccess = forcedTerminationSignal && cleanTerminalAssistantStopReceived && !finalError;
			resolve({
				stderr,
				exitCode: resourceLimitExceeded ? 1 : interrupted || forcedDrainAfterFinalSuccess ? 0 : forcedTerminationSignal || signal ? (exitCode ?? 1) : exitCode,
				messages,
				usage,
				model,
				error: interrupted || forcedDrainAfterFinalSuccess ? undefined : finalError,
				finalOutput,
				interrupted,
				observedMutationAttempt,
				resourceLimitExceeded,
			});
		});

		child.on("error", (spawnError) => {
			settled = true;
			registerInterrupt?.(undefined);
			clearDrainTimers();
			clearStdioGuard();
			outputStream.end();
			const finalOutput = resourceLimitExceeded?.message ?? (getFinalOutput(messages) || rawStdoutLines.join("\n").trim());
			const spawnErrorMessage = spawnError instanceof Error ? spawnError.message : String(spawnError);
			resolve({ stderr, exitCode: 1, messages, usage, model, error: resourceLimitExceeded?.message ?? error ?? assistantError ?? spawnErrorMessage, finalOutput, observedMutationAttempt, resourceLimitExceeded });
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
	piPackageRoot?: string;
	piArgv1?: string;
	registerInterrupt?: (interrupt: (() => void) | undefined) => void;
	childIntercomTarget?: string;
	orchestratorIntercomTarget?: string;
	nestedRoute?: NestedRouteInfo;
	onAttemptStart?: (attempt: { model?: string; thinking?: string }) => void;
	onChildEvent?: (event: ChildEvent) => void;
}

/** Run a single pi agent step, returning output and metadata */
async function runSingleStep(
	step: SubagentStep,
	ctx: SingleStepContext,
): Promise<{
	agent: string;
	output: string;
	exitCode: number | null;
	error?: string;
	model?: string;
	attemptedModels?: string[];
	modelAttempts?: ModelAttempt[];
	artifactPaths?: ArtifactPaths;
	interrupted?: boolean;
	sessionFile?: string;
	intercomTarget?: string;
	completionGuardTriggered?: boolean;
	structuredOutput?: unknown;
	structuredOutputPath?: string;
	structuredOutputSchemaPath?: string;
	acceptance?: AcceptanceLedger;
	resourceLimitExceeded?: ResourceLimitExceeded;
}> {
	const effectiveStructuredOutput = step.structuredOutput ?? (step.structuredOutputSchema
		? createStructuredOutputRuntime(step.structuredOutputSchema, path.join(path.dirname(ctx.outputFile), "structured-output"))
		: undefined);
	const placeholderRegex = new RegExp(ctx.placeholder.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g");
	let task = step.task.replace(placeholderRegex, () => ctx.previousOutput);
	task = resolveOutputReferences(task, ctx.outputs ?? {});
	const taskForCompletionGuard = task;
	if (step.effectiveAcceptance) {
		const acceptancePrompt = formatAcceptancePrompt(step.effectiveAcceptance);
		if (acceptancePrompt) task = `${task}\n${acceptancePrompt}`;
	}
	const sessionEnabled = Boolean(step.sessionFile) || ctx.sessionEnabled;
	const sessionDir = step.sessionFile ? undefined : ctx.sessionDir;

	let artifactPaths: ArtifactPaths | undefined;
	if (ctx.artifactsDir && ctx.artifactConfig?.enabled !== false) {
		const index = ctx.flatStepCount > 1 ? ctx.flatIndex : undefined;
		artifactPaths = getArtifactPaths(ctx.artifactsDir, ctx.id, step.agent, index);
		fs.mkdirSync(ctx.artifactsDir, { recursive: true });
		if (ctx.artifactConfig?.includeInput !== false) {
			fs.writeFileSync(artifactPaths.inputPath, `# Task for ${step.agent}\n\n${task}`, "utf-8");
		}
	}

	const candidates = step.modelCandidates && step.modelCandidates.length > 0
		? step.modelCandidates
		: step.model
			? [step.model]
			: [undefined];
	const attemptedModels: string[] = [];
	const modelAttempts: ModelAttempt[] = [];
	const attemptNotes: string[] = [];
	const eventsPath = path.join(path.dirname(ctx.outputFile), "events.jsonl");
	let finalResult: RunPiStreamingResult | undefined;
	let finalOutputSnapshot: SingleOutputSnapshot | undefined;
	let completionGuardTriggeredFinal = false;

	for (let index = 0; index < candidates.length; index++) {
		const candidate = candidates[index];
		ctx.onAttemptStart?.({ model: candidate, thinking: resolveEffectiveThinking(candidate, step.thinking) });
		const outputSnapshot = captureSingleOutputSnapshot(step.outputPath);
		if (effectiveStructuredOutput) {
			try {
				if (fs.existsSync(effectiveStructuredOutput.outputPath)) fs.unlinkSync(effectiveStructuredOutput.outputPath);
			} catch {
				// Missing/stale structured-output files are handled after the child exits.
			}
		}
		const { args, env, tempDir } = buildPiArgs({
			baseArgs: ["--mode", "json", "-p"],
			task,
			sessionEnabled,
			sessionDir,
			sessionFile: step.sessionFile,
			model: candidate,
			inheritProjectContext: step.inheritProjectContext,
			inheritSkills: step.inheritSkills,
			tools: step.tools,
			extensions: step.extensions,
			systemPrompt: step.systemPrompt,
			systemPromptMode: step.systemPromptMode,
			mcpDirectTools: step.mcpDirectTools,
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
			structuredOutput: effectiveStructuredOutput,
		});
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
			step.maxExecutionTimeMs,
			step.maxTokens,
		);
		cleanupTempDir(tempDir);

		const hiddenError = run.exitCode === 0 && !run.error ? detectSubagentError(run.messages) : null;
		let structuredOutput: unknown;
		let structuredError: string | undefined;
		if (effectiveStructuredOutput && run.exitCode === 0 && !run.error && !hiddenError?.hasError) {
			const structured = readStructuredOutput({
				schema: effectiveStructuredOutput.schema,
				schemaPath: effectiveStructuredOutput.schemaPath,
				outputPath: effectiveStructuredOutput.outputPath,
			});
			if (structured.error) structuredError = structured.error;
			else structuredOutput = structured.value;
		}
		const completionPolicy = resolveCompletionPolicy({
			agent: step.agent,
			task: taskForCompletionGuard,
			completionGuardEnabled: step.completionGuard !== false,
			usesAcceptanceContract: step.effectiveAcceptance?.explicit === true,
			tools: step.tools,
			mcpDirectTools: step.mcpDirectTools,
		});
		const completionGuard = run.exitCode === 0 && !run.error && !hiddenError?.hasError && completionPolicy === "mutation-guard"
			? evaluateCompletionMutationGuard({
				agent: step.agent,
				task: taskForCompletionGuard,
				messages: run.messages,
				tools: step.tools,
				mcpDirectTools: step.mcpDirectTools,
			})
			: undefined;
		const completionGuardTriggered = completionGuard?.triggered === true && !run.observedMutationAttempt;
		const completionGuardError = completionGuardTriggered
			? "Subagent completed without making edits for an implementation task.\nIt appears to have returned planning or scratchpad output instead of applying changes."
			: undefined;
		const effectiveExitCode = completionGuardError
			? 1
			: structuredError
				? 1
				: hiddenError?.hasError
				? (hiddenError.exitCode ?? 1)
				: run.error && run.exitCode === 0
					? 1
					: run.exitCode;
		const error = completionGuardError
			?? structuredError
			?? (hiddenError?.hasError
				? hiddenError.details
					? `${hiddenError.errorType} failed (exit ${effectiveExitCode}): ${hiddenError.details}`
					: `${hiddenError.errorType} failed with exit code ${effectiveExitCode}`
				: run.error || (run.exitCode !== 0 && run.stderr.trim() ? run.stderr.trim() : undefined));
		const attempt: ModelAttempt = {
			model: candidate ?? run.model ?? step.model ?? "default",
			success: effectiveExitCode === 0 && !error,
			exitCode: effectiveExitCode,
			error,
			usage: run.usage,
		};
		modelAttempts.push(attempt);
		if (candidate) attemptedModels.push(candidate);
		completionGuardTriggeredFinal = completionGuardTriggered;
		finalOutputSnapshot = outputSnapshot;
		finalResult = { ...run, exitCode: effectiveExitCode, model: candidate ?? run.model, error, structuredOutput } as RunPiStreamingResult & { structuredOutput?: unknown };
		if (attempt.success || completionGuardError) break;
		if (run.resourceLimitExceeded || !isRetryableModelFailure(error) || index === candidates.length - 1) break;
		attemptNotes.push(formatModelAttemptNote(attempt, candidates[index + 1]));
	}

	const rawOutput = finalResult?.finalOutput ?? "";
	const outputForPersistence = stripAcceptanceReport(rawOutput);
	const resolvedOutput = step.outputPath && finalResult?.exitCode === 0
		? resolveSingleOutput(step.outputPath, outputForPersistence, finalOutputSnapshot)
		: { fullOutput: outputForPersistence };
	const output = resolvedOutput.fullOutput;
	const outputReference = resolvedOutput.savedPath ? formatSavedOutputReference(resolvedOutput.savedPath, output) : undefined;
	let outputForSummary = output;
	if (attemptNotes.length > 0) {
		outputForSummary = `${attemptNotes.join("\n")}\n\n${outputForSummary}`.trim();
	}
	const outputForAcceptance = rawOutput;
	const finalizedOutput = finalizeSingleOutput({
		fullOutput: outputForSummary,
		outputPath: step.outputPath,
		outputMode: step.outputMode,
		exitCode: finalResult?.exitCode ?? 1,
		savedPath: resolvedOutput.savedPath,
		outputReference,
		saveError: resolvedOutput.saveError,
	});
	outputForSummary = finalizedOutput.displayOutput;
	const acceptanceForInitialReport = step.effectiveAcceptance && shouldRunAcceptanceFinalization(step.effectiveAcceptance)
		? acceptanceSelfReviewConfig(step.effectiveAcceptance)
		: step.effectiveAcceptance;
	let acceptance = acceptanceForInitialReport
		? await evaluateAcceptance({
			acceptance: acceptanceForInitialReport,
			output: outputForAcceptance,
			cwd: step.cwd ?? ctx.cwd,
		})
		: undefined;
	if (acceptance && step.effectiveAcceptance && shouldRunAcceptanceFinalization(step.effectiveAcceptance) && (finalResult?.exitCode ?? 1) === 0 && !finalResult?.interrupted) {
		const sessionFile = step.sessionFile ?? (sessionDir ? findLatestSessionFile(sessionDir) ?? undefined : undefined);
		const maxTurns = step.effectiveAcceptance.finalization.maxTurns;
		const turns: AcceptanceFinalizationTurn[] = [];
		if (!sessionFile) {
			const message = "Acceptance finalization requires a session file for same-session continuation.";
			turns.push(createFinalizationProcessFailureTurn({ turn: 1, prompt: "", message }));
			acceptance = buildFinalizationProcessFailureLedger({ initialLedger: acceptance, turns, maxTurns, message });
		} else {
			const selfReviewAcceptance = acceptanceSelfReviewConfig(step.effectiveAcceptance);
			let previousFailure = acceptanceFailureMessage(acceptance);
			let authoritativeLedger = acceptance;
			for (let turn = 1; turn <= maxTurns; turn++) {
				const prompt = formatAcceptanceFinalizationPrompt({
					acceptance: step.effectiveAcceptance,
					initialOutput: outputForAcceptance,
					initialLedger: acceptance,
					turn,
					maxTurns,
					...(previousFailure ? { previousFailure } : {}),
				});
				const { args, env, tempDir } = buildPiArgs({
					baseArgs: ["--mode", "json", "-p"],
					task: prompt,
					sessionEnabled: true,
					sessionFile,
					model: finalResult?.model ?? step.model,
					thinking: step.thinking,
					inheritProjectContext: step.inheritProjectContext,
					inheritSkills: step.inheritSkills,
					tools: step.tools,
					extensions: step.extensions,
					systemPrompt: step.systemPrompt,
					systemPromptMode: step.systemPromptMode,
					mcpDirectTools: step.mcpDirectTools,
					cwd: step.cwd ?? ctx.cwd,
					promptFileStem: `${step.agent}-acceptance-finalization`,
					intercomSessionName: ctx.childIntercomTarget,
					orchestratorIntercomTarget: ctx.orchestratorIntercomTarget,
					runId: ctx.id,
					childAgentName: step.agent,
					childIndex: ctx.flatIndex,
					parentEventSink: ctx.nestedRoute?.eventSink,
					parentControlInbox: ctx.nestedRoute?.controlInbox,
					parentRootRunId: ctx.nestedRoute?.rootRunId,
					parentCapabilityToken: ctx.nestedRoute?.capabilityToken,
				});
				ctx.onAttemptStart?.({ model: finalResult?.model ?? step.model, thinking: resolveEffectiveThinking(finalResult?.model ?? step.model, step.thinking) });
				const finalizationRun = await runPiStreaming(
					args,
					step.cwd ?? ctx.cwd,
					`${ctx.outputFile}.finalization-${turn}.log`,
					env,
					ctx.piPackageRoot,
					ctx.piArgv1,
					step.maxSubagentDepth,
					{ eventsPath, runId: ctx.id, stepIndex: ctx.flatIndex, agent: step.agent },
					ctx.registerInterrupt,
					ctx.onChildEvent,
					step.maxExecutionTimeMs,
					step.maxTokens,
				);
				cleanupTempDir(tempDir);
				modelAttempts.push({
					model: finalResult?.model ?? finalizationRun.model ?? step.model ?? "default",
					success: finalizationRun.exitCode === 0 && !finalizationRun.error,
					exitCode: finalizationRun.exitCode,
					error: finalizationRun.error,
					usage: finalizationRun.usage,
				});
				const finalizationOutput = finalizationRun.finalOutput;
				if (finalizationRun.exitCode !== 0 || finalizationRun.error || finalizationRun.interrupted) {
					const message = finalizationRun.error ?? "Acceptance finalization turn did not complete successfully.";
					turns.push(createFinalizationProcessFailureTurn({ turn, prompt, rawOutput: finalizationOutput, message }));
					acceptance = buildFinalizationProcessFailureLedger({ initialLedger: acceptance, turns, maxTurns, message });
					break;
				}
				const selfReviewLedger = await evaluateAcceptance({
					acceptance: selfReviewAcceptance,
					output: finalizationOutput,
					cwd: step.cwd ?? ctx.cwd,
				});
				authoritativeLedger = selfReviewLedger;
				turns.push(createFinalizationTurn({ turn, prompt, rawOutput: finalizationOutput, ledger: selfReviewLedger }));
				const failure = acceptanceFailureMessage(selfReviewLedger);
				if (!failure) {
					authoritativeLedger = step.effectiveAcceptance === selfReviewAcceptance
						? selfReviewLedger
						: await evaluateAcceptance({
							acceptance: step.effectiveAcceptance,
							output: finalizationOutput,
							cwd: step.cwd ?? ctx.cwd,
						});
					acceptance = attachFinalizationToLedger({ initialLedger: acceptance, authoritativeLedger, turns, status: "completed", maxTurns });
					break;
				}
				previousFailure = failure;
				if (turn === maxTurns) acceptance = attachFinalizationToLedger({ initialLedger: acceptance, authoritativeLedger, turns, status: "failed", maxTurns });
			}
		}
	}
	const acceptanceFailure = acceptance ? acceptanceFailureMessage(acceptance) : undefined;
	const acceptanceCanFailRun = acceptanceFailure && acceptance?.explicit && (finalResult?.exitCode ?? 1) === 0 && !finalResult?.interrupted;
	const effectiveFinalExitCode = acceptanceCanFailRun ? 1 : finalResult?.exitCode ?? 1;
	const effectiveFinalError = acceptanceCanFailRun
		? (finalResult?.error ? `${finalResult.error}\n${acceptanceFailure}` : acceptanceFailure)
		: finalResult?.error;

	if (artifactPaths && ctx.artifactConfig?.enabled !== false) {
		if (ctx.artifactConfig?.includeOutput !== false) {
			fs.writeFileSync(artifactPaths.outputPath, output, "utf-8");
		}
		if (ctx.artifactConfig?.includeMetadata !== false) {
			fs.writeFileSync(
				artifactPaths.metadataPath,
				JSON.stringify({
					runId: ctx.id,
					agent: step.agent,
					task,
					exitCode: effectiveFinalExitCode,
					model: finalResult?.model,
					attemptedModels: attemptedModels.length > 0 ? attemptedModels : undefined,
					modelAttempts,
					resourceLimitExceeded: finalResult?.resourceLimitExceeded,
					skills: step.skills,
					timestamp: Date.now(),
				}, null, 2),
				"utf-8",
			);
		}
	}

	return {
		agent: step.agent,
		output: outputForSummary,
		exitCode: effectiveFinalExitCode,
		error: effectiveFinalError,
		sessionFile: step.sessionFile,
		intercomTarget: ctx.childIntercomTarget,
		model: finalResult?.model,
		attemptedModels: attemptedModels.length > 0 ? attemptedModels : undefined,
		modelAttempts,
		artifactPaths,
		interrupted: finalResult?.interrupted,
		completionGuardTriggered: completionGuardTriggeredFinal,
		structuredOutput: (finalResult as (RunPiStreamingResult & { structuredOutput?: unknown }) | undefined)?.structuredOutput,
		structuredOutputPath: effectiveStructuredOutput?.outputPath,
		structuredOutputSchemaPath: effectiveStructuredOutput?.schemaPath,
		acceptance,
		resourceLimitExceeded: finalResult?.resourceLimitExceeded,
	};
}

type RunnerStatusStep = NonNullable<AsyncStatus["steps"]>[number] & {
	exitCode?: number | null;
};

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
		input.statusPayload.steps[flatTaskIndex].status = "failed";
		input.statusPayload.steps[flatTaskIndex].startedAt = input.failedAt;
		input.statusPayload.steps[flatTaskIndex].endedAt = input.failedAt;
		input.statusPayload.steps[flatTaskIndex].durationMs = 0;
		input.statusPayload.steps[flatTaskIndex].exitCode = 1;
		input.results.push({ agent: input.group.parallel[taskIndex].agent, output: input.setupError, success: false, exitCode: 1, sessionFile: input.group.parallel[taskIndex].sessionFile });
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
		input.statusPayload.steps[flatTaskIndex].status = "pending";
		input.statusPayload.steps[flatTaskIndex].startedAt = undefined;
		input.statusPayload.steps[flatTaskIndex].endedAt = undefined;
		input.statusPayload.steps[flatTaskIndex].durationMs = undefined;
		input.statusPayload.steps[flatTaskIndex].lastActivityAt = undefined;
		input.statusPayload.steps[flatTaskIndex].activityState = undefined;
		input.statusPayload.steps[flatTaskIndex].error = undefined;
	}
	input.statusPayload.currentStep = input.groupStartFlatIndex;
	input.statusPayload.activityState = undefined;
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
	return {
		taskForRun: { ...task, cwd: undefined },
		taskCwd: worktreeSetup.worktrees[taskIndex]!.agentCwd,
	};
}

function appendParallelWorktreeSummary(
	previousOutput: string,
	worktreeSetup: WorktreeSetup | undefined,
	asyncDir: string,
	stepIndex: number,
	group: Extract<RunnerStep, { parallel: SubagentStep[] }>,
): string {
	if (!worktreeSetup) return previousOutput;
	const diffsDir = path.join(asyncDir, "worktree-diffs", `step-${stepIndex}`);
	const diffs = diffWorktrees(worktreeSetup, group.parallel.map((task) => task.agent), diffsDir);
	const diffSummary = formatWorktreeDiffSummary(diffs);
	if (!diffSummary) return previousOutput;
	return `${previousOutput}\n\n${diffSummary}`;
}

function ensureParallelProgressFile(cwd: string, group: Extract<RunnerStep, { parallel: SubagentStep[] }>): void {
	const progressPath = path.join(cwd, "progress.md");
	if (!group.parallel.some((task) => task.task.includes(`Update progress at: ${progressPath}`))) return;
	writeInitialProgressFile(cwd);
}

async function runSubagent(config: SubagentRunConfig): Promise<void> {
	const { id, steps, resultPath, cwd, placeholder, taskIndex, totalTasks, maxOutput, artifactsDir, artifactConfig } =
		config;
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
	let activeChildInterrupt: (() => void) | undefined;
	let interrupted = false;
	let currentActivityState: ActivityState | undefined;
	let activityTimer: NodeJS.Timeout | undefined;
	let previousCumulativeTokens: TokenUsage = { input: 0, output: 0, total: 0 };
	let latestSessionFile: string | undefined;

	const parallelGroups: Array<{ start: number; count: number; stepIndex: number }> = [];
	const initialStatusSteps: RunnerStatusStep[] = [];
	let flatStepCount = 0;
	for (let stepIndex = 0; stepIndex < steps.length; stepIndex++) {
		const step = steps[stepIndex]!;
		if (isParallelGroup(step)) {
			parallelGroups.push({ start: flatStepCount, count: step.parallel.length, stepIndex });
			for (const task of step.parallel) {
				initialStatusSteps.push({
					agent: task.agent,
					phase: task.phase,
					label: task.label,
					outputName: task.outputName,
					structured: task.structured,
					status: "pending",
					...(task.sessionFile ? { sessionFile: task.sessionFile } : {}),
					skills: task.skills,
					model: task.model,
					thinking: task.thinking,
					attemptedModels: task.modelCandidates && task.modelCandidates.length > 0 ? task.modelCandidates : task.model ? [task.model] : undefined,
					recentTools: [],
					recentOutput: [],
				});
			}
			flatStepCount += step.parallel.length;
		} else if (isDynamicRunnerGroup(step)) {
			parallelGroups.push({ start: flatStepCount, count: 1, stepIndex });
			initialStatusSteps.push({
				agent: `expand:${step.parallel.agent}`,
				phase: step.phase ?? step.parallel.phase,
				label: step.label ?? step.parallel.label ?? `Dynamic fanout (${step.collect.as})`,
				outputName: step.collect.as,
				structured: Boolean(step.collect.outputSchema),
				status: "pending",
				recentTools: [],
				recentOutput: [],
			});
			flatStepCount++;
		} else {
			initialStatusSteps.push({
				agent: step.agent,
				phase: step.phase,
				label: step.label,
				outputName: step.outputName,
				structured: step.structured,
				status: "pending",
				...(step.sessionFile ? { sessionFile: step.sessionFile } : {}),
				skills: step.skills,
				model: step.model,
				thinking: step.thinking,
				attemptedModels: step.modelCandidates && step.modelCandidates.length > 0 ? step.modelCandidates : step.model ? [step.model] : undefined,
				recentTools: [],
				recentOutput: [],
			});
			flatStepCount++;
		}
	}
	const flatSteps = flattenSteps(steps);
	const sessionEnabled = Boolean(config.sessionDir)
		|| shareEnabled
		|| flatSteps.some((step) => Boolean(step.sessionFile));
	const statusPayload: RunnerStatusPayload = {
		runId: id,
		...(config.sessionId ? { sessionId: config.sessionId } : {}),
		mode: config.resultMode ?? (flatSteps.length > 1 ? "chain" : "single"),
		state: "running",
		lastActivityAt: overallStartTime,
		startedAt: overallStartTime,
		lastUpdate: overallStartTime,
		pid: process.pid,
		cwd,
		currentStep: 0,
		chainStepCount: steps.length,
		parallelGroups,
		workflowGraph: config.workflowGraph,
		steps: initialStatusSteps,
		artifactsDir,
		sessionDir: config.sessionDir,
		outputFile: path.join(asyncDir, "output-0.log"),
	};

	fs.mkdirSync(asyncDir, { recursive: true });
	writeAtomicJson(statusPath, statusPayload);
	const emitNestedSelfEvent = (type: "subagent.nested.updated" | "subagent.nested.completed"): void => {
		if (!config.nestedRoute || !config.nestedSelf) return;
		try {
			writeNestedEvent(config.nestedRoute, {
				type,
				ts: Date.now(),
				parentRunId: config.nestedSelf.parentRunId,
				parentStepIndex: config.nestedSelf.parentStepIndex,
				child: nestedSummaryFromAsyncStatus(statusPayload, asyncDir, {
					id,
					parentRunId: config.nestedSelf.parentRunId,
					parentStepIndex: config.nestedSelf.parentStepIndex,
					depth: config.nestedSelf.depth,
					path: config.nestedSelf.path,
					mode: statusPayload.mode,
					ts: Date.now(),
				}),
			});
		} catch (error) {
			console.error("Failed to emit nested async status event:", error);
		}
	};
	const refreshWorkflowGraph = (): void => {
		if (!config.workflowGraph) return;
		const graph = structuredClone(statusPayload.workflowGraph ?? config.workflowGraph);
		const normalize = (status: RunnerStatusStep["status"]): "pending" | "running" | "completed" | "failed" | "paused" | "detached" => {
			if (status === "complete" || status === "completed") return "completed";
			if (status === "running" || status === "failed" || status === "paused" || status === "pending") return status;
			return "pending";
		};
		const updateNode = (node: NonNullable<typeof graph.nodes>[number]): void => {
			if (node.flatIndex !== undefined) {
				const step = statusPayload.steps[node.flatIndex];
				if (step) {
					node.status = normalize(step.status);
					node.error = step.error;
					node.acceptanceStatus = step.acceptance?.status;
				}
				if (statusPayload.currentStep === node.flatIndex) graph.currentNodeId = node.id;
			}
			for (const child of node.children ?? []) updateNode(child);
			if (node.children?.length) {
				if (node.children.every((child) => child.status === "completed")) node.status = "completed";
				else if (node.children.some((child) => child.status === "running")) node.status = "running";
				else if (node.children.some((child) => child.status === "failed")) node.status = "failed";
				else if (node.children.some((child) => child.status === "paused")) node.status = "paused";
			}
			if (node.error) node.status = "failed";
		};
		for (const node of graph.nodes) updateNode(node);
		statusPayload.workflowGraph = graph;
	};
	const writeStatusPayload = (): void => {
		refreshWorkflowGraph();
		writeAtomicJson(statusPath, statusPayload);
		emitNestedSelfEvent(statusPayload.state === "running" || statusPayload.state === "queued" ? "subagent.nested.updated" : "subagent.nested.completed");
	};
	const markDynamicGraphGroup = (stepIndex: number, status: "completed" | "failed" | "running", error?: string, acceptance?: AcceptanceLedger): void => {
		const groupNode = statusPayload.workflowGraph?.nodes.find((node) => node.id === `step-${stepIndex}`);
		if (!groupNode) return;
		groupNode.status = status;
		groupNode.error = error;
		groupNode.acceptanceStatus = acceptance?.status ?? groupNode.acceptanceStatus;
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
		statusPayload.currentTool = activeStep?.currentTool;
		statusPayload.currentToolStartedAt = activeStep?.currentToolStartedAt;
		statusPayload.currentPath = activeStep?.currentPath;
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
		const event = buildControlEvent({
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
		});
		appendControlEvent(event);
		return true;
	};
	const updateStepModel = (flatIndex: number, model: string | undefined, thinking: string | undefined, now = Date.now()): void => {
		const step = statusPayload.steps[flatIndex];
		if (!step) return;
		step.model = model;
		step.thinking = thinking;
		statusPayload.lastUpdate = now;
		writeStatusPayload();
	};
	const updateStepFromChildEvent = (flatIndex: number, event: ChildEvent): void => {
		const step = statusPayload.steps[flatIndex];
		if (!step) return;
		const now = Date.now();
		statusPayload.currentStep = flatIndex;
		if (event.type === "tool_execution_start" && event.toolName) {
			const mutates = isMutatingTool(event.toolName, event.args);
			const currentPath = resolveCurrentPath(event.toolName, event.args);
			step.toolCount = (step.toolCount ?? 0) + 1;
			step.currentTool = event.toolName;
			step.currentToolArgs = extractToolArgsPreview(event.args ?? {});
			step.currentToolStartedAt = now;
			step.currentPath = currentPath;
			pendingToolResults[flatIndex] = { tool: event.toolName, path: currentPath, mutates, startedAt: now };
			statusPayload.toolCount = (statusPayload.toolCount ?? 0) + 1;
			syncTopLevelCurrentTool();
		} else if (event.type === "tool_execution_end") {
			if (step.currentTool) {
				step.recentTools ??= [];
				step.recentTools.push({ tool: step.currentTool, args: step.currentToolArgs || "", endMs: now });
			}
			step.currentTool = undefined;
			step.currentToolArgs = undefined;
			step.currentToolStartedAt = undefined;
			step.currentPath = undefined;
			syncTopLevelCurrentTool();
		} else if (event.type === "tool_result_end" && event.message) {
			const toolSnapshot = pendingToolResults[flatIndex];
			pendingToolResults[flatIndex] = undefined;
			const resultText = extractTextFromContent(event.message.content);
			appendRecentStepOutput(step, resultText.split("\n").slice(-10));
			if (toolSnapshot?.mutates && didMutatingToolFail(resultText)) {
				const state = mutatingFailureStates[flatIndex]!;
				recordMutatingFailure(state, {
					tool: toolSnapshot.tool,
					path: toolSnapshot.path,
					error: resultText.split("\n").find((line) => line.trim())?.trim().slice(0, 180) ?? "mutating tool failed",
					ts: now,
				}, mutatingFailureWindowMs);
				if (controlConfig.enabled && shouldEscalateMutatingFailures(state, controlConfig.failedToolAttemptsBeforeAttention) && step.activityState !== "needs_attention") {
					const previous = step.activityState;
					step.activityState = "needs_attention";
					statusPayload.activityState = "needs_attention";
					appendControlEvent(buildControlEvent({
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
					}));
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
			}
			statusPayload.turnCount = Math.max(statusPayload.turnCount ?? 0, step.turnCount);
		}
		syncTopLevelCurrentTool();
		step.lastActivityAt = now;
		statusPayload.lastActivityAt = now;
		statusPayload.lastUpdate = now;
		maybeEmitActiveLongRunning(flatIndex, now);
		writeStatusPayload();
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
			const idleState = deriveActivityState({
				config: controlConfig,
				startedAt: step.startedAt ?? overallStartTime,
				lastActivityAt,
				now,
			});
			if (idleState === "needs_attention") {
				const previous = step.activityState;
				step.activityState = "needs_attention";
				if (previous !== "needs_attention") {
					appendControlEvent(buildControlEvent({
						from: previous,
						to: "needs_attention",
						runId: id,
						agent: step.agent,
						index,
						ts: now,
						lastActivityAt,
					}));
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
			statusPayload.activityState = nextRunState;
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
		if (interrupted || statusPayload.state !== "running") return;
		interrupted = true;
		const now = Date.now();
		statusPayload.state = "paused";
		currentActivityState = undefined;
		statusPayload.activityState = undefined;
		statusPayload.lastUpdate = now;
		for (const step of statusPayload.steps) {
			if (step.status === "running") {
				step.status = "paused";
				step.activityState = undefined;
				step.endedAt = now;
				step.durationMs = step.startedAt ? now - step.startedAt : undefined;
				step.lastActivityAt = now;
			}
		}
		writeStatusPayload();
		appendJsonl(eventsPath, JSON.stringify({
			type: "subagent.run.paused",
			ts: now,
			runId: id,
		}));
		activeChildInterrupt?.();
	};
	process.on(ASYNC_INTERRUPT_SIGNAL, interruptRunner);
	appendJsonl(
		eventsPath,
		JSON.stringify({
			type: "subagent.run.started",
			ts: overallStartTime,
			runId: id,
			mode: statusPayload.mode,
			cwd,
			pid: process.pid,
		}),
	);

	let flatIndex = 0;

	for (let stepIndex = 0; stepIndex < steps.length; stepIndex++) {
		if (interrupted) break;
		const step = steps[stepIndex];

		if (isDynamicRunnerGroup(step)) {
			const groupStartFlatIndex = flatIndex;
			let materialized: ReturnType<typeof materializeDynamicParallelStep>;
			try {
				materialized = materializeDynamicParallelStep(step as Parameters<typeof materializeDynamicParallelStep>[0], outputs, stepIndex, { maxItems: config.dynamicFanoutMaxItems, allowRunnerFields: true });
				if (materialized.collectedOnEmpty) validateDynamicCollection(step.collect.outputSchema, materialized.collectedOnEmpty);
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
				results.push({ agent: step.parallel.agent, output: message, error: message, success: false, exitCode: 1 });
				break;
			}

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
				flatIndex++;
				statusPayload.lastUpdate = now;
				markDynamicGraphGroup(stepIndex, "completed");
				writeStatusPayload();
				continue;
			}

			const dynamicSteps = materialized.parallel.map((task, itemIndex) => ({
				...step.parallel,
				task: task.task ?? step.parallel.task,
				label: task.label ?? step.parallel.label,
				structuredOutput: undefined,
				structuredOutputSchema: step.parallel.structuredOutputSchema ?? step.parallel.structuredOutput?.schema,
			}));
			const dynamicStatusSteps: RunnerStatusStep[] = dynamicSteps.map((task) => ({
					agent: task.agent,
					phase: task.phase ?? step.phase,
					label: task.label,
					outputName: undefined,
					structured: Boolean(task.structuredOutputSchema),
					status: "pending",
					...(task.sessionFile ? { sessionFile: task.sessionFile } : {}),
					skills: task.skills,
					model: task.model,
					thinking: task.thinking,
					attemptedModels: task.modelCandidates && task.modelCandidates.length > 0 ? task.modelCandidates : task.model ? [task.model] : undefined,
					recentTools: [],
					recentOutput: [],
				}));
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
					groupNode.children = materialized.items.map((item, itemIndex) => ({
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
			const parallelResults = await mapConcurrent(dynamicSteps, concurrency, async (task, taskIdx) => {
				const fi = groupStartFlatIndex + taskIdx;
				if (aborted && failFast) {
					const skippedAt = Date.now();
					statusPayload.steps[fi].status = "failed";
					statusPayload.steps[fi].error = "Skipped due to fail-fast";
					statusPayload.steps[fi].startedAt = skippedAt;
					statusPayload.steps[fi].endedAt = skippedAt;
					statusPayload.steps[fi].durationMs = 0;
					statusPayload.steps[fi].exitCode = -1;
					statusPayload.lastUpdate = skippedAt;
					writeStatusPayload();
					return { agent: task.agent, output: "(skipped — fail-fast)", exitCode: -1 as number | null, skipped: true };
				}
				const taskStartTime = Date.now();
				statusPayload.currentStep = fi;
				statusPayload.steps[fi].status = "running";
				statusPayload.steps[fi].error = undefined;
				statusPayload.steps[fi].activityState = undefined;
				resetStepLiveDetail(statusPayload.steps[fi]);
				statusPayload.steps[fi].startedAt = taskStartTime;
				statusPayload.steps[fi].lastActivityAt = taskStartTime;
				statusPayload.outputFile = path.join(asyncDir, `output-${fi}.log`);
				statusPayload.lastActivityAt = taskStartTime;
				statusPayload.lastUpdate = taskStartTime;
				writeStatusPayload();
				appendJsonl(eventsPath, JSON.stringify({ type: "subagent.step.started", ts: taskStartTime, runId: id, stepIndex: fi, agent: task.agent }));
				const singleResult = await runSingleStep(task, {
					previousOutput, placeholder, cwd, sessionEnabled,
					outputs,
					sessionDir: config.sessionDir ? path.join(config.sessionDir, `dynamic-${stepIndex}-${taskIdx}`) : undefined,
					artifactsDir, artifactConfig, id,
					flatIndex: fi, flatStepCount: Math.max(statusPayload.steps.length, 1),
					outputFile: path.join(asyncDir, `output-${fi}.log`),
					piPackageRoot: config.piPackageRoot,
					piArgv1: config.piArgv1,
					childIntercomTarget: config.childIntercomTargets?.[fi],
					orchestratorIntercomTarget: config.controlIntercomTarget,
					nestedRoute: config.nestedRoute,
					registerInterrupt: (interrupt) => {
						activeChildInterrupt = interrupt;
					},
					onAttemptStart: (attempt) => updateStepModel(fi, attempt.model, attempt.thinking),
					onChildEvent: (event) => updateStepFromChildEvent(fi, event),
				});
				const taskEndTime = Date.now();
				statusPayload.steps[fi].status = singleResult.exitCode === 0 ? "complete" : "failed";
				statusPayload.steps[fi].endedAt = taskEndTime;
				statusPayload.steps[fi].durationMs = taskEndTime - taskStartTime;
				statusPayload.steps[fi].exitCode = singleResult.exitCode;
				statusPayload.steps[fi].model = singleResult.model;
				statusPayload.steps[fi].thinking = resolveEffectiveThinking(singleResult.model, statusPayload.steps[fi].thinking);
				statusPayload.steps[fi].attemptedModels = singleResult.attemptedModels;
				statusPayload.steps[fi].modelAttempts = singleResult.modelAttempts;
				statusPayload.steps[fi].error = singleResult.error;
				statusPayload.steps[fi].structuredOutput = singleResult.structuredOutput;
				statusPayload.steps[fi].structuredOutputPath = singleResult.structuredOutputPath;
				statusPayload.steps[fi].structuredOutputSchemaPath = singleResult.structuredOutputSchemaPath;
				statusPayload.steps[fi].acceptance = singleResult.acceptance;
				statusPayload.steps[fi].resourceLimitExceeded = singleResult.resourceLimitExceeded;
				statusPayload.lastUpdate = taskEndTime;
				writeStatusPayload();
				appendJsonl(eventsPath, JSON.stringify({
					type: singleResult.exitCode === 0 ? "subagent.step.completed" : "subagent.step.failed",
					ts: taskEndTime, runId: id, stepIndex: fi, agent: task.agent,
					exitCode: singleResult.exitCode, durationMs: taskEndTime - taskStartTime,
					resourceLimitExceeded: singleResult.resourceLimitExceeded,
				}));
				if (singleResult.exitCode !== 0 && failFast) aborted = true;
				return { ...singleResult, skipped: false };
			});

			flatIndex += dynamicSteps.length;
			for (const pr of parallelResults) {
				results.push({
					agent: pr.agent,
					output: pr.output,
					error: pr.error,
					success: pr.exitCode === 0,
					exitCode: pr.exitCode,
					skipped: pr.skipped,
					sessionFile: pr.sessionFile,
					intercomTarget: pr.intercomTarget,
					model: pr.model,
					attemptedModels: pr.attemptedModels,
					modelAttempts: pr.modelAttempts,
					artifactPaths: pr.artifactPaths,
					structuredOutput: pr.structuredOutput,
					structuredOutputPath: pr.structuredOutputPath,
					structuredOutputSchemaPath: pr.structuredOutputSchemaPath,
					acceptance: pr.acceptance,
					resourceLimitExceeded: pr.resourceLimitExceeded,
				});
			}
			const collection = collectDynamicResults(step as Parameters<typeof collectDynamicResults>[0], materialized.items, parallelResults);
			const failures = parallelResults.filter((result) => result.exitCode !== 0 && result.exitCode !== -1);
			if (failures.length === 0) {
				try {
					validateDynamicCollection(step.collect.outputSchema, collection);
					outputs[step.collect.as] = {
						text: JSON.stringify(collection),
						structured: collection,
						agent: step.parallel.agent,
						stepIndex,
					};
					statusPayload.outputs = outputs;
					markDynamicGraphGroup(stepIndex, "completed");
				} catch (error) {
					const message = error instanceof DynamicFanoutError ? error.message : error instanceof Error ? error.message : String(error);
					results.push({ agent: step.parallel.agent, output: message, error: message, success: false, exitCode: 1, structuredOutput: collection });
					statusPayload.error = message;
					markDynamicGraphGroup(stepIndex, "failed", message);
				}
			}
			previousOutput = aggregateParallelOutputs(
				parallelResults.map((r, i) => ({
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
				success: failures.length === 0,
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
					worktreeSetup = createWorktrees(cwd, `${id}-s${stepIndex}`, group.parallel.length, {
						agents: group.parallel.map((task) => task.agent),
						setupHook: config.worktreeSetupHook
							? { hookPath: config.worktreeSetupHook, timeoutMs: config.worktreeSetupHookTimeoutMs }
							: undefined,
					});
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
					async (task, taskIdx) => {
						const fi = groupStartFlatIndex + taskIdx;
						if (aborted && failFast) {
							const skippedAt = Date.now();
							statusPayload.steps[fi].status = "failed";
							statusPayload.steps[fi].error = "Skipped due to fail-fast";
							statusPayload.steps[fi].startedAt = skippedAt;
							statusPayload.steps[fi].endedAt = skippedAt;
							statusPayload.steps[fi].durationMs = 0;
							statusPayload.steps[fi].exitCode = -1;
							statusPayload.steps[fi].activityState = undefined;
							statusPayload.lastUpdate = skippedAt;
							writeStatusPayload();
							appendJsonl(eventsPath, JSON.stringify({
								type: "subagent.step.failed", ts: skippedAt, runId: id, stepIndex: fi, agent: task.agent, exitCode: -1, durationMs: 0,
							}));
							return { agent: task.agent, output: "(skipped — fail-fast)", exitCode: -1 as number | null, skipped: true };
						}

						const taskStartTime = Date.now();
						statusPayload.currentStep = fi;
						statusPayload.steps[fi].status = "running";
						statusPayload.steps[fi].error = undefined;
						statusPayload.steps[fi].activityState = undefined;
						resetStepLiveDetail(statusPayload.steps[fi]);
						statusPayload.steps[fi].startedAt = taskStartTime;
						statusPayload.steps[fi].endedAt = undefined;
						statusPayload.steps[fi].durationMs = undefined;
						statusPayload.steps[fi].lastActivityAt = taskStartTime;
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

						const singleResult = await runSingleStep(taskForRun, {
							previousOutput, placeholder, cwd: taskCwd, sessionEnabled,
							outputs,
							sessionDir: taskSessionDir,
							artifactsDir, artifactConfig, id,
							flatIndex: fi, flatStepCount: flatSteps.length,
							outputFile: path.join(asyncDir, `output-${fi}.log`),
							piPackageRoot: config.piPackageRoot,
							piArgv1: config.piArgv1,
							childIntercomTarget: config.childIntercomTargets?.[fi],
							orchestratorIntercomTarget: config.controlIntercomTarget,
							nestedRoute: config.nestedRoute,
							registerInterrupt: (interrupt) => {
								activeChildInterrupt = interrupt;
							},
							onAttemptStart: (attempt) => updateStepModel(fi, attempt.model, attempt.thinking),
							onChildEvent: (event) => updateStepFromChildEvent(fi, event),
						});
						if (task.sessionFile) {
							latestSessionFile = task.sessionFile;
						}

						const taskEndTime = Date.now();
						const taskDuration = taskEndTime - taskStartTime;

						statusPayload.steps[fi].status = singleResult.exitCode === 0 ? "complete" : "failed";
						statusPayload.steps[fi].endedAt = taskEndTime;
						statusPayload.steps[fi].durationMs = taskDuration;
						statusPayload.steps[fi].exitCode = singleResult.exitCode;
						statusPayload.steps[fi].model = singleResult.model;
						statusPayload.steps[fi].thinking = resolveEffectiveThinking(singleResult.model, statusPayload.steps[fi].thinking);
						statusPayload.steps[fi].attemptedModels = singleResult.attemptedModels;
						statusPayload.steps[fi].modelAttempts = singleResult.modelAttempts;
						statusPayload.steps[fi].error = singleResult.error;
						statusPayload.steps[fi].structuredOutput = singleResult.structuredOutput;
						statusPayload.steps[fi].structuredOutputPath = singleResult.structuredOutputPath;
						statusPayload.steps[fi].structuredOutputSchemaPath = singleResult.structuredOutputSchemaPath;
						statusPayload.steps[fi].acceptance = singleResult.acceptance;
						statusPayload.steps[fi].resourceLimitExceeded = singleResult.resourceLimitExceeded;
						statusPayload.lastUpdate = taskEndTime;
						writeStatusPayload();

						appendJsonl(eventsPath, JSON.stringify({
							type: singleResult.exitCode === 0 ? "subagent.step.completed" : "subagent.step.failed",
							ts: taskEndTime, runId: id, stepIndex: fi, agent: task.agent,
							exitCode: singleResult.exitCode, durationMs: taskDuration,
							resourceLimitExceeded: singleResult.resourceLimitExceeded,
						}));
						if (singleResult.completionGuardTriggered) {
							const event = buildControlEvent({
								from: statusPayload.steps[fi].activityState,
								to: "needs_attention",
								runId: id,
								agent: task.agent,
								index: fi,
								ts: taskEndTime,
								message: `${task.agent} completed without making edits for an implementation task`,
								reason: "completion_guard",
							});
							appendControlEvent(event);
						}

						if (singleResult.exitCode !== 0 && failFast) aborted = true;
						return { ...singleResult, skipped: false };
					},
				);

				flatIndex += group.parallel.length;

				for (let t = 0; t < group.parallel.length; t++) {
					const fi = groupStartFlatIndex + t;
					const sessionTokens = config.sessionDir
						? parseSessionTokens(path.join(config.sessionDir, `parallel-${t}`))
						: null;
					const taskTokens = sessionTokens ?? tokenUsageFromAttempts(parallelResults[t]?.modelAttempts);
					if (!taskTokens) continue;
					statusPayload.steps[fi].tokens = taskTokens;
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
					results.push({
						agent: pr.agent,
						output: pr.output,
						error: pr.error,
						success: pr.exitCode === 0,
						exitCode: pr.exitCode,
						skipped: pr.skipped,
						sessionFile: pr.sessionFile,
						intercomTarget: pr.intercomTarget,
						model: pr.model,
						attemptedModels: pr.attemptedModels,
						modelAttempts: pr.modelAttempts,
						artifactPaths: pr.artifactPaths,
							structuredOutput: pr.structuredOutput,
							structuredOutputPath: pr.structuredOutputPath,
							structuredOutputSchemaPath: pr.structuredOutputSchemaPath,
							acceptance: pr.acceptance,
							resourceLimitExceeded: pr.resourceLimitExceeded,
						});
					}
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
					parallelResults.map((r) => ({
					agent: r.agent,
					output: r.output,
					exitCode: r.exitCode,
					error: r.error,
					model: r.model,
					attemptedModels: r.attemptedModels,
				})),
				);
				previousOutput = appendParallelWorktreeSummary(previousOutput, worktreeSetup, asyncDir, stepIndex, group);

				appendJsonl(eventsPath, JSON.stringify({
					type: "subagent.parallel.completed",
					ts: Date.now(),
					runId: id,
					stepIndex,
					success: parallelResults.every((r) => r.exitCode === 0 || r.exitCode === -1),
				}));

				if (parallelResults.some((r) => r.exitCode !== 0 && r.exitCode !== -1)) {
					break;
				}
			} finally {
				if (worktreeSetup) cleanupWorktrees(worktreeSetup);
			}
		} else {
			const seqStep = step as SubagentStep;
			const stepStartTime = Date.now();
			statusPayload.currentStep = flatIndex;
			statusPayload.steps[flatIndex].status = "running";
			statusPayload.steps[flatIndex].activityState = undefined;
			statusPayload.activityState = undefined;
			resetStepLiveDetail(statusPayload.steps[flatIndex]);
			statusPayload.steps[flatIndex].skills = seqStep.skills;
			statusPayload.steps[flatIndex].startedAt = stepStartTime;
			statusPayload.steps[flatIndex].lastActivityAt = stepStartTime;
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

			const singleResult = await runSingleStep(seqStep, {
				previousOutput, placeholder, cwd, sessionEnabled,
				outputs,
				sessionDir: config.sessionDir,
				artifactsDir, artifactConfig, id,
				flatIndex, flatStepCount: flatSteps.length,
				outputFile: path.join(asyncDir, `output-${flatIndex}.log`),
				piPackageRoot: config.piPackageRoot,
				piArgv1: config.piArgv1,
				childIntercomTarget: config.childIntercomTargets?.[flatIndex],
				orchestratorIntercomTarget: config.controlIntercomTarget,
				nestedRoute: config.nestedRoute,
				registerInterrupt: (interrupt) => {
					activeChildInterrupt = interrupt;
				},
				onAttemptStart: (attempt) => updateStepModel(flatIndex, attempt.model, attempt.thinking),
				onChildEvent: (event) => updateStepFromChildEvent(flatIndex, event),
			});
			if (seqStep.sessionFile) {
				latestSessionFile = seqStep.sessionFile;
			}

			previousOutput = singleResult.output;
			results.push({
				agent: singleResult.agent,
				output: singleResult.output,
				error: singleResult.error,
				success: singleResult.exitCode === 0,
				exitCode: singleResult.exitCode,
				sessionFile: singleResult.sessionFile,
				intercomTarget: singleResult.intercomTarget,
				model: singleResult.model,
				attemptedModels: singleResult.attemptedModels,
				modelAttempts: singleResult.modelAttempts,
				artifactPaths: singleResult.artifactPaths,
				structuredOutput: singleResult.structuredOutput,
				structuredOutputPath: singleResult.structuredOutputPath,
				structuredOutputSchemaPath: singleResult.structuredOutputSchemaPath,
				acceptance: singleResult.acceptance,
				resourceLimitExceeded: singleResult.resourceLimitExceeded,
			});
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
			statusPayload.steps[flatIndex].status = singleResult.exitCode === 0 ? "complete" : "failed";
			statusPayload.steps[flatIndex].endedAt = stepEndTime;
			statusPayload.steps[flatIndex].durationMs = stepEndTime - stepStartTime;
			statusPayload.steps[flatIndex].exitCode = singleResult.exitCode;
			statusPayload.steps[flatIndex].model = singleResult.model;
			statusPayload.steps[flatIndex].thinking = resolveEffectiveThinking(singleResult.model, statusPayload.steps[flatIndex].thinking);
			statusPayload.steps[flatIndex].attemptedModels = singleResult.attemptedModels;
			statusPayload.steps[flatIndex].modelAttempts = singleResult.modelAttempts;
			statusPayload.steps[flatIndex].error = singleResult.error;
			statusPayload.steps[flatIndex].structuredOutput = singleResult.structuredOutput;
			statusPayload.steps[flatIndex].structuredOutputPath = singleResult.structuredOutputPath;
			statusPayload.steps[flatIndex].structuredOutputSchemaPath = singleResult.structuredOutputSchemaPath;
			statusPayload.steps[flatIndex].acceptance = singleResult.acceptance;
			statusPayload.steps[flatIndex].resourceLimitExceeded = singleResult.resourceLimitExceeded;
			if (stepTokens) {
				statusPayload.steps[flatIndex].tokens = stepTokens;
				statusPayload.totalTokens = { ...previousCumulativeTokens };
			}
			statusPayload.lastUpdate = stepEndTime;
			writeStatusPayload();

			appendJsonl(eventsPath, JSON.stringify({
				type: singleResult.exitCode === 0 ? "subagent.step.completed" : "subagent.step.failed",
				ts: stepEndTime,
				runId: id,
				stepIndex: flatIndex,
				agent: seqStep.agent,
				exitCode: singleResult.exitCode,
				durationMs: stepEndTime - stepStartTime,
				tokens: stepTokens,
				resourceLimitExceeded: singleResult.resourceLimitExceeded,
			}));
			if (singleResult.completionGuardTriggered) {
				const event = buildControlEvent({
					from: statusPayload.steps[flatIndex].activityState,
					to: "needs_attention",
					runId: id,
					agent: seqStep.agent,
					index: flatIndex,
					ts: stepEndTime,
					message: `${seqStep.agent} completed without making edits for an implementation task`,
					reason: "completion_guard",
				});
				appendControlEvent(event);
			}

			flatIndex++;
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
	const agentName = flatSteps.length === 1
		? flatSteps[0].agent
		: resultMode === "parallel"
			? `parallel:${flatSteps.map((s) => s.agent).join("+")}`
			: `chain:${flatSteps.map((s) => s.agent).join("->")}`;
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
	const effectiveSessionFile = sessionFile ?? latestSessionFile;
	const runEndedAt = Date.now();
	statusPayload.state = interrupted ? "paused" : results.every((r) => r.success) ? "complete" : "failed";
	statusPayload.activityState = undefined;
	statusPayload.endedAt = runEndedAt;
	statusPayload.lastUpdate = runEndedAt;
	statusPayload.sessionFile = effectiveSessionFile;
	statusPayload.shareUrl = shareUrl;
	statusPayload.gistUrl = gistUrl;
	statusPayload.shareError = shareError;
	if (statusPayload.state === "failed" && !statusPayload.error) {
		const failedStep = statusPayload.steps.find((s) => s.status === "failed");
		if (failedStep?.agent) {
			statusPayload.error = `Step failed: ${failedStep.agent}`;
		}
	}
	writeStatusPayload();
	appendJsonl(
		eventsPath,
		JSON.stringify({
			type: "subagent.run.completed",
			ts: runEndedAt,
			runId: id,
			status: statusPayload.state,
			durationMs: runEndedAt - overallStartTime,
		}),
	);
	writeRunLog(logPath, {
		id,
		mode: statusPayload.mode,
		cwd,
		startedAt: overallStartTime,
		endedAt: runEndedAt,
		steps: statusPayload.steps.map((step) => ({
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
	});

	try {
		writeAtomicJson(resultPath, {
			id,
			agent: agentName,
			mode: resultMode,
			success: !interrupted && results.every((r) => r.success),
			state: interrupted ? "paused" : results.every((r) => r.success) ? "complete" : "failed",
			summary: interrupted ? "Paused after interrupt. Waiting for explicit next action." : summary,
			results: results.map((r) => ({
				agent: r.agent,
				output: r.output,
				error: r.error,
				success: r.success,
				skipped: r.skipped || undefined,
				sessionFile: r.sessionFile,
				intercomTarget: r.intercomTarget,
				model: r.model,
				attemptedModels: r.attemptedModels,
				modelAttempts: r.modelAttempts,
				artifactPaths: r.artifactPaths,
				truncated: r.truncated,
				structuredOutput: r.structuredOutput,
				structuredOutputPath: r.structuredOutputPath,
				structuredOutputSchemaPath: r.structuredOutputSchemaPath,
				acceptance: r.acceptance,
				resourceLimitExceeded: r.resourceLimitExceeded,
			})),
			outputs,
			workflowGraph: statusPayload.workflowGraph,
			exitCode: interrupted || results.every((r) => r.success) ? 0 : 1,
			timestamp: runEndedAt,
			durationMs: runEndedAt - overallStartTime,
			truncated,
			artifactsDir,
			cwd,
			asyncDir,
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
		runSubagent(config).catch((runErr) => {
			console.error("Subagent runner error:", runErr);
			process.exit(1);
		});
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
			runSubagent(config).catch((runErr) => {
				console.error("Subagent runner error:", runErr);
				process.exit(1);
			});
		} catch (err) {
			console.error("Subagent runner error:", err);
			process.exit(1);
		}
	});
}
