import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type { Message } from "@mariozechner/pi-ai";
import { writeAtomicJson } from "../../shared/atomic-json.ts";
import { appendJsonl, getArtifactPaths } from "../../shared/artifacts.ts";
import { getPiSpawnCommand } from "../shared/pi-spawn.ts";
import { captureSingleOutputSnapshot, finalizeSingleOutput, formatSavedOutputReference, resolveSingleOutput } from "../shared/single-output.ts";
import {
	type ActivityState,
	type ArtifactConfig,
	type ArtifactPaths,
	type AsyncParallelGroupStatus,
	type AsyncStatus,
	type ModelAttempt,
	type ResolvedControlConfig,
	type SubagentRunMode,
	type Usage,
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
	isParallelGroup,
	flattenSteps,
	mapConcurrent,
	aggregateParallelOutputs,
	MAX_PARALLEL_CONCURRENCY,
} from "../shared/parallel-utils.ts";
import { buildPiArgs, cleanupTempDir } from "../shared/pi-args.ts";
import { formatModelAttemptNote, isRetryableModelFailure } from "../shared/model-fallback.ts";
import { attachPostExitStdioGuard, trySignalChild } from "../../shared/post-exit-stdio-guard.ts";
import { detectSubagentError, extractTextFromContent, extractToolArgsPreview, getFinalOutput } from "../../shared/utils.ts";
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
import { writeInitialProgressFile } from "../../shared/settings.ts";

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
}

interface StepResult {
	agent: string;
	output: string;
	error?: string;
	success: boolean;
	skipped?: boolean;
	intercomTarget?: string;
	model?: string;
	preferredModel?: string;
	attemptedModels?: string[];
	modelAttempts?: ModelAttempt[];
	artifactPaths?: ArtifactPaths;
	truncated?: boolean;
}

const require = createRequire(import.meta.url);
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
): Promise<RunPiStreamingResult> {
	return new Promise((resolve) => {
		const outputStream = fs.createWriteStream(outputFile, { flags: "w" });
		const spawnEnv = { ...process.env, ...(env ?? {}), ...getSubagentDepthEnv(maxSubagentDepth) };
		const spawnSpec = getPiSpawnCommand(args, {
			...(piPackageRoot ? { piPackageRoot } : {}),
			...(piArgv1 ? { argv1: piArgv1 } : {}),
		});
		const child = spawn(spawnSpec.command, spawnSpec.args, { cwd, stdio: ["ignore", "pipe", "pipe"], env: spawnEnv });
		let stderr = "";
		let stdoutBuf = "";
		let stderrBuf = "";
		const messages: Message[] = [];
		const usage = emptyUsage();
		let model: string | undefined;
		let error: string | undefined;
		let interrupted = false;
		let observedMutationAttempt = false;
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
				if (event.message.errorMessage) error = event.message.errorMessage;
				const eventUsage = event.message.usage;
				if (eventUsage) {
					usage.turns++;
					usage.input += eventUsage.input ?? eventUsage.inputTokens ?? 0;
					usage.output += eventUsage.output ?? eventUsage.outputTokens ?? 0;
					usage.cacheRead += eventUsage.cacheRead ?? 0;
					usage.cacheWrite += eventUsage.cacheWrite ?? 0;
					usage.cost += eventUsage.cost?.total ?? 0;
				}
				const stopReason = (event.message as { stopReason?: string }).stopReason;
				const hasToolCall = Array.isArray(event.message.content)
					&& event.message.content.some((part) => (part as { type?: string }).type === "toolCall");
				if (stopReason === "stop" && !hasToolCall) {
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
			if (settled) return;
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
		};
		function startFinalDrain(): void {
			if (childExited || finalDrainTimer || settled) return;
			finalDrainTimer = setTimeout(() => {
				if (settled) return;
				const termSent = trySignalChild(child, "SIGTERM");
				if (!termSent) return;
				forcedTerminationSignal = true;
				if (!cleanTerminalAssistantStopReceived && !error) {
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
			const finalOutput = getFinalOutput(messages) || rawStdoutLines.join("\n").trim();
			const forcedDrainAfterFinalSuccess = forcedTerminationSignal && cleanTerminalAssistantStopReceived && !error;
			resolve({
				stderr,
				exitCode: interrupted || forcedDrainAfterFinalSuccess ? 0 : forcedTerminationSignal || signal ? (exitCode ?? 1) : exitCode,
				messages,
				usage,
				model,
				error: interrupted || forcedDrainAfterFinalSuccess ? undefined : error,
				finalOutput,
				interrupted,
				observedMutationAttempt,
			});
		});

		child.on("error", (spawnError) => {
			settled = true;
			registerInterrupt?.(undefined);
			clearDrainTimers();
			clearStdioGuard();
			outputStream.end();
			const finalOutput = getFinalOutput(messages) || rawStdoutLines.join("\n").trim();
			const spawnErrorMessage = spawnError instanceof Error ? spawnError.message : String(spawnError);
			resolve({ stderr, exitCode: 1, messages, usage, model, error: error ?? spawnErrorMessage, finalOutput, observedMutationAttempt });
		});
	});
}

function resolvePiPackageRootFallback(): string {
	// Try to resolve the main entry point and walk up to find the package root
	const entryPoint = require.resolve("@mariozechner/pi-coding-agent");
	// Entry point is typically /path/to/dist/index.js, so go up to find package root
	let dir = path.dirname(entryPoint);
	while (dir !== path.dirname(dir)) {
		const pkgJsonPath = path.join(dir, "package.json");
		try {
			const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8"));
			if (pkg.name === "@mariozechner/pi-coding-agent") return dir;
		} catch {
			// Keep walking up until a readable package.json is found.
		}
		dir = path.dirname(dir);
	}
	throw new Error("Could not resolve @mariozechner/pi-coding-agent package root");
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
	preferredModel?: string;
	attemptedModels?: string[];
	modelAttempts?: ModelAttempt[];
	artifactPaths?: ArtifactPaths;
	interrupted?: boolean;
	intercomTarget?: string;
	completionGuardTriggered?: boolean;
}> {
	const placeholderRegex = new RegExp(ctx.placeholder.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g");
	const task = step.task.replace(placeholderRegex, () => ctx.previousOutput);
	const sessionEnabled = Boolean(step.sessionFile) || ctx.sessionEnabled;
	const sessionDir = step.sessionFile ? undefined : ctx.sessionDir;
	const outputSnapshot = captureSingleOutputSnapshot(step.outputPath);

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
	let finalPreferredModel: string | undefined;
	let completionGuardTriggeredFinal = false;

	for (let index = 0; index < candidates.length; index++) {
		const candidate = candidates[index];
		const preferredModel = candidate ?? step.model;
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
			promptFileStem: step.agent,
			intercomSessionName: ctx.childIntercomTarget,
			orchestratorIntercomTarget: ctx.orchestratorIntercomTarget,
			runId: ctx.id,
			childAgentName: step.agent,
			childIndex: ctx.flatIndex,
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
		);
		cleanupTempDir(tempDir);

		const hiddenError = run.exitCode === 0 && !run.error ? detectSubagentError(run.messages) : null;
		const completionGuard = run.exitCode === 0 && !run.error && !hiddenError?.hasError
			? evaluateCompletionMutationGuard({
				agent: step.agent,
				task,
				messages: run.messages,
			})
			: undefined;
		const completionGuardTriggered = completionGuard?.triggered === true && !run.observedMutationAttempt;
		const completionGuardError = completionGuardTriggered
			? "Subagent completed without making edits for an implementation task.\nIt appears to have returned planning or scratchpad output instead of applying changes."
			: undefined;
		const effectiveExitCode = completionGuardTriggered
			? 1
			: hiddenError?.hasError
				? (hiddenError.exitCode ?? 1)
				: run.exitCode;
		const error = completionGuardError
			?? (hiddenError?.hasError
				? hiddenError.details
					? `${hiddenError.errorType} failed (exit ${effectiveExitCode}): ${hiddenError.details}`
					: `${hiddenError.errorType} failed with exit code ${effectiveExitCode}`
				: run.error || (run.exitCode !== 0 && run.stderr.trim() ? run.stderr.trim() : undefined));
		const attempt: ModelAttempt = {
			model: preferredModel ?? run.model ?? "default",
			success: effectiveExitCode === 0 && !error,
			exitCode: effectiveExitCode,
			error,
			usage: run.usage,
		};
		modelAttempts.push(attempt);
		if (candidate) attemptedModels.push(candidate);
		completionGuardTriggeredFinal = completionGuardTriggered;
		finalPreferredModel = preferredModel;
		finalResult = { ...run, exitCode: effectiveExitCode, model: run.model ?? preferredModel, error };
		if (attempt.success || completionGuardTriggered) break;
		if (!isRetryableModelFailure(error) || index === candidates.length - 1) break;
		attemptNotes.push(formatModelAttemptNote(attempt, candidates[index + 1]));
	}

	const rawOutput = finalResult?.finalOutput ?? "";
	const resolvedOutput = step.outputPath && finalResult?.exitCode === 0
		? resolveSingleOutput(step.outputPath, rawOutput, outputSnapshot)
		: { fullOutput: rawOutput };
	const output = resolvedOutput.fullOutput;
	const outputReference = resolvedOutput.savedPath ? formatSavedOutputReference(resolvedOutput.savedPath, output) : undefined;
	let outputForSummary = output;
	if (attemptNotes.length > 0) {
		outputForSummary = `${attemptNotes.join("\n")}\n\n${outputForSummary}`.trim();
	}
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
					exitCode: finalResult?.exitCode,
					model: finalResult?.model,
					preferredModel: finalPreferredModel,
					attemptedModels: attemptedModels.length > 0 ? attemptedModels : undefined,
					modelAttempts,
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
		exitCode: finalResult?.exitCode ?? 1,
		error: finalResult?.error,
		intercomTarget: ctx.childIntercomTarget,
		model: finalResult?.model,
		preferredModel: finalPreferredModel,
		attemptedModels: attemptedModels.length > 0 ? attemptedModels : undefined,
		modelAttempts,
		artifactPaths,
		interrupted: finalResult?.interrupted,
		completionGuardTriggered: completionGuardTriggeredFinal,
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
		input.results.push({ agent: input.group.parallel[taskIndex].agent, output: input.setupError, success: false });
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
	let flatStepCount = 0;
	for (let stepIndex = 0; stepIndex < steps.length; stepIndex++) {
		const step = steps[stepIndex]!;
		if (isParallelGroup(step)) {
			parallelGroups.push({ start: flatStepCount, count: step.parallel.length, stepIndex });
			flatStepCount += step.parallel.length;
		} else {
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
		steps: flatSteps.map((step) => ({
			agent: step.agent,
			status: "pending",
			skills: step.skills,
			model: step.model,
			attemptedModels: step.modelCandidates && step.modelCandidates.length > 0 ? step.modelCandidates : step.model ? [step.model] : undefined,
		})),
		artifactsDir,
		sessionDir: config.sessionDir,
		outputFile: path.join(asyncDir, "output-0.log"),
	};

	fs.mkdirSync(asyncDir, { recursive: true });
	writeAtomicJson(statusPath, statusPayload);

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
	const mutatingFailureStates = flatSteps.map(() => createMutatingFailureState());
	const pendingToolResults: Array<{ tool: string; path?: string; mutates: boolean; startedAt?: number } | undefined> = [];
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
			step.currentToolStartedAt = now;
			step.currentPath = currentPath;
			pendingToolResults[flatIndex] = { tool: event.toolName, path: currentPath, mutates, startedAt: now };
			statusPayload.toolCount = (statusPayload.toolCount ?? 0) + 1;
			syncTopLevelCurrentTool();
		} else if (event.type === "tool_execution_end") {
			step.currentTool = undefined;
			step.currentToolStartedAt = undefined;
			step.currentPath = undefined;
			syncTopLevelCurrentTool();
		} else if (event.type === "tool_result_end" && event.message) {
			const toolSnapshot = pendingToolResults[flatIndex];
			pendingToolResults[flatIndex] = undefined;
			const resultText = extractTextFromContent(event.message.content);
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
		writeAtomicJson(statusPath, statusPayload);
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
		if (changed) writeAtomicJson(statusPath, statusPayload);
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
		writeAtomicJson(statusPath, statusPayload);
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
							writeAtomicJson(statusPath, statusPayload);
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
						statusPayload.steps[fi].startedAt = taskStartTime;
						statusPayload.steps[fi].endedAt = undefined;
						statusPayload.steps[fi].durationMs = undefined;
						statusPayload.steps[fi].lastActivityAt = taskStartTime;
						statusPayload.outputFile = path.join(asyncDir, `output-${fi}.log`);
						statusPayload.lastActivityAt = taskStartTime;
						statusPayload.lastUpdate = taskStartTime;
						writeAtomicJson(statusPath, statusPayload);

						appendJsonl(eventsPath, JSON.stringify({
							type: "subagent.step.started", ts: taskStartTime, runId: id, stepIndex: fi, agent: task.agent,
						}));

						const taskSessionDir = config.sessionDir
							? path.join(config.sessionDir, `parallel-${taskIdx}`)
							: undefined;
						const { taskForRun, taskCwd } = prepareParallelTaskRun(task, cwd, worktreeSetup, taskIdx);

						const singleResult = await runSingleStep(taskForRun, {
							previousOutput, placeholder, cwd: taskCwd, sessionEnabled,
							sessionDir: taskSessionDir,
							artifactsDir, artifactConfig, id,
							flatIndex: fi, flatStepCount: flatSteps.length,
							outputFile: path.join(asyncDir, `output-${fi}.log`),
							piPackageRoot: config.piPackageRoot,
							piArgv1: config.piArgv1,
							childIntercomTarget: config.childIntercomTargets?.[fi],
							orchestratorIntercomTarget: config.controlIntercomTarget,
							registerInterrupt: (interrupt) => {
								activeChildInterrupt = interrupt;
							},
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
						statusPayload.steps[fi].attemptedModels = singleResult.attemptedModels;
						statusPayload.steps[fi].modelAttempts = singleResult.modelAttempts;
						statusPayload.steps[fi].error = singleResult.error;
						statusPayload.lastUpdate = taskEndTime;
						writeAtomicJson(statusPath, statusPayload);

						appendJsonl(eventsPath, JSON.stringify({
							type: singleResult.exitCode === 0 ? "subagent.step.completed" : "subagent.step.failed",
							ts: taskEndTime, runId: id, stepIndex: fi, agent: task.agent,
							exitCode: singleResult.exitCode, durationMs: taskDuration,
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
				writeAtomicJson(statusPath, statusPayload);

				for (const pr of parallelResults) {
					results.push({
						agent: pr.agent,
						output: pr.output,
						error: pr.error,
						success: pr.exitCode === 0,
						skipped: pr.skipped,
						intercomTarget: pr.intercomTarget,
						model: pr.model,
						preferredModel: pr.preferredModel,
						attemptedModels: pr.attemptedModels,
						modelAttempts: pr.modelAttempts,
						artifactPaths: pr.artifactPaths,
					});
				}

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
			statusPayload.steps[flatIndex].skills = seqStep.skills;
			statusPayload.steps[flatIndex].startedAt = stepStartTime;
			statusPayload.steps[flatIndex].lastActivityAt = stepStartTime;
			statusPayload.lastActivityAt = stepStartTime;
			statusPayload.lastUpdate = stepStartTime;
			statusPayload.outputFile = path.join(asyncDir, `output-${flatIndex}.log`);
			writeAtomicJson(statusPath, statusPayload);

			appendJsonl(eventsPath, JSON.stringify({
				type: "subagent.step.started",
				ts: stepStartTime,
				runId: id,
				stepIndex: flatIndex,
				agent: seqStep.agent,
			}));

			const singleResult = await runSingleStep(seqStep, {
				previousOutput, placeholder, cwd, sessionEnabled,
				sessionDir: config.sessionDir,
				artifactsDir, artifactConfig, id,
				flatIndex, flatStepCount: flatSteps.length,
				outputFile: path.join(asyncDir, `output-${flatIndex}.log`),
				piPackageRoot: config.piPackageRoot,
				piArgv1: config.piArgv1,
				childIntercomTarget: config.childIntercomTargets?.[flatIndex],
				orchestratorIntercomTarget: config.controlIntercomTarget,
				registerInterrupt: (interrupt) => {
					activeChildInterrupt = interrupt;
				},
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
				intercomTarget: singleResult.intercomTarget,
				model: singleResult.model,
				preferredModel: singleResult.preferredModel,
				attemptedModels: singleResult.attemptedModels,
				modelAttempts: singleResult.modelAttempts,
				artifactPaths: singleResult.artifactPaths,
			});

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
			statusPayload.steps[flatIndex].attemptedModels = singleResult.attemptedModels;
			statusPayload.steps[flatIndex].modelAttempts = singleResult.modelAttempts;
			statusPayload.steps[flatIndex].error = singleResult.error;
			if (stepTokens) {
				statusPayload.steps[flatIndex].tokens = stepTokens;
				statusPayload.totalTokens = { ...previousCumulativeTokens };
			}
			statusPayload.lastUpdate = stepEndTime;
			writeAtomicJson(statusPath, statusPayload);

			appendJsonl(eventsPath, JSON.stringify({
				type: singleResult.exitCode === 0 ? "subagent.step.completed" : "subagent.step.failed",
				ts: stepEndTime,
				runId: id,
				stepIndex: flatIndex,
				agent: seqStep.agent,
				exitCode: singleResult.exitCode,
				durationMs: stepEndTime - stepStartTime,
				tokens: stepTokens,
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

	const agentName = flatSteps.length === 1
		? flatSteps[0].agent
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
	if (statusPayload.state === "failed") {
		const failedStep = statusPayload.steps.find((s) => s.status === "failed");
		if (failedStep?.agent) {
			statusPayload.error = `Step failed: ${failedStep.agent}`;
		}
	}
	writeAtomicJson(statusPath, statusPayload);
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
			mode: config.resultMode ?? statusPayload.mode,
			success: !interrupted && results.every((r) => r.success),
			state: interrupted ? "paused" : results.every((r) => r.success) ? "complete" : "failed",
			summary: interrupted ? "Paused after interrupt. Waiting for explicit next action." : summary,
			results: results.map((r) => ({
				agent: r.agent,
				output: r.output,
				error: r.error,
				success: r.success,
				skipped: r.skipped || undefined,
				intercomTarget: r.intercomTarget,
				model: r.model,
				preferredModel: r.preferredModel,
				attemptedModels: r.attemptedModels,
				modelAttempts: r.modelAttempts,
				artifactPaths: r.artifactPaths,
				truncated: r.truncated,
			})),
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
