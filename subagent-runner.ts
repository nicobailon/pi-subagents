import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type { Message } from "@mariozechner/pi-ai";
import { appendJsonl, getArtifactPaths } from "./artifacts.ts";
import { getPiSpawnCommand } from "./pi-spawn.ts";
import { captureSingleOutputSnapshot, resolveSingleOutput } from "./single-output.ts";
import {
	type ArtifactConfig,
	type ArtifactPaths,
	type ModelAttempt,
	type Usage,
	DEFAULT_MAX_OUTPUT,
	type MaxOutputConfig,
	truncateOutput,
	getSubagentDepthEnv,
} from "./types.ts";
import {
	type RunnerSubagentStep as SubagentStep,
	type RunnerStep,
	isParallelGroup,
	flattenSteps,
	mapConcurrent,
	aggregateParallelOutputs,
	MAX_PARALLEL_CONCURRENCY,
} from "./parallel-utils.ts";
import { buildPiArgs, cleanupTempDir } from "./pi-args.ts";
import { formatModelAttemptNote, isRetryableModelFailure } from "./model-fallback.ts";
import { detectSubagentError, extractTextFromContent, extractToolArgsPreview, getFinalOutput } from "./utils.ts";
import { parseSessionTokens, type TokenUsage } from "./session-tokens.ts";
import {
	cleanupWorktrees,
	createWorktrees,
	diffWorktrees,
	findWorktreeTaskCwdConflict,
	formatWorktreeDiffSummary,
	formatWorktreeTaskCwdConflict,
	type WorktreeSetup,
} from "./worktree.ts";

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
}

interface StepResult {
	agent: string;
	output: string;
	success: boolean;
	skipped?: boolean;
	model?: string;
	attemptedModels?: string[];
	modelAttempts?: ModelAttempt[];
	artifactPaths?: ArtifactPaths;
	truncated?: boolean;
}

const require = createRequire(import.meta.url);

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

			if (event.type === "tool_execution_start" && event.toolName) {
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
				if (!eventUsage) return;
				usage.turns++;
				usage.input += eventUsage.input ?? eventUsage.inputTokens ?? 0;
				usage.output += eventUsage.output ?? eventUsage.outputTokens ?? 0;
				usage.cacheRead += eventUsage.cacheRead ?? 0;
				usage.cacheWrite += eventUsage.cacheWrite ?? 0;
				usage.cost += eventUsage.cost?.total ?? 0;
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

		child.on("close", (exitCode) => {
			if (stdoutBuf.trim()) processStdoutLine(stdoutBuf);
			if (stderrBuf.trim()) appendChildLine("subagent.child.stderr", stderrBuf);
			outputStream.end();
			const finalOutput = getFinalOutput(messages) || rawStdoutLines.join("\n").trim();
			resolve({ stderr, exitCode, messages, usage, model, error, finalOutput });
		});

		child.on("error", (spawnError) => {
			outputStream.end();
			const finalOutput = getFinalOutput(messages) || rawStdoutLines.join("\n").trim();
			const spawnErrorMessage = spawnError instanceof Error ? spawnError.message : String(spawnError);
			resolve({ stderr, exitCode: 1, messages, usage, model, error: error ?? spawnErrorMessage, finalOutput });
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

function writeJson(filePath: string, payload: object): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	const tempPath = path.join(
		path.dirname(filePath),
		`.${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`,
	);
	try {
		fs.writeFileSync(tempPath, JSON.stringify(payload, null, 2), "utf-8");
		fs.renameSync(tempPath, filePath);
	} finally {
		if (fs.existsSync(tempPath)) {
			try {
				fs.unlinkSync(tempPath);
			} catch {}
		}
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
		mode: "single" | "chain";
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

	for (let index = 0; index < candidates.length; index++) {
		const candidate = candidates[index];
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
		);
		cleanupTempDir(tempDir);

		const hiddenError = run.exitCode === 0 && !run.error ? detectSubagentError(run.messages) : null;
		const effectiveExitCode = hiddenError?.hasError ? (hiddenError.exitCode ?? 1) : run.exitCode;
		const error = hiddenError?.hasError
			? hiddenError.details
				? `${hiddenError.errorType} failed (exit ${effectiveExitCode}): ${hiddenError.details}`
				: `${hiddenError.errorType} failed with exit code ${effectiveExitCode}`
			: run.error || (run.exitCode !== 0 && run.stderr.trim() ? run.stderr.trim() : undefined);
		const attempt: ModelAttempt = {
			model: candidate ?? run.model ?? step.model ?? "default",
			success: effectiveExitCode === 0 && !error,
			exitCode: effectiveExitCode,
			error,
			usage: run.usage,
		};
		modelAttempts.push(attempt);
		if (candidate) attemptedModels.push(candidate);
		finalResult = { ...run, exitCode: effectiveExitCode, model: candidate ?? run.model, error };
		if (attempt.success) break;
		if (!isRetryableModelFailure(error) || index === candidates.length - 1) break;
		attemptNotes.push(formatModelAttemptNote(attempt, candidates[index + 1]));
	}

	const rawOutput = finalResult?.finalOutput ?? "";
	const resolvedOutput = step.outputPath && finalResult?.exitCode === 0
		? resolveSingleOutput(step.outputPath, rawOutput, outputSnapshot)
		: { fullOutput: rawOutput };
	const output = resolvedOutput.fullOutput;
	let outputForSummary = output;
	if (attemptNotes.length > 0) {
		outputForSummary = `${attemptNotes.join("\n")}\n\n${outputForSummary}`.trim();
	}
	if (resolvedOutput.savedPath) {
		outputForSummary = outputForSummary
			? `${outputForSummary}\n\nOutput saved to: ${resolvedOutput.savedPath}`
			: `Output saved to: ${resolvedOutput.savedPath}`;
	} else if (resolvedOutput.saveError && step.outputPath && finalResult?.exitCode === 0) {
		outputForSummary = outputForSummary
			? `${outputForSummary}\n\nFailed to save output to: ${step.outputPath}\n${resolvedOutput.saveError}`
			: `Failed to save output to: ${step.outputPath}\n${resolvedOutput.saveError}`;
	}

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
		model: finalResult?.model,
		attemptedModels: attemptedModels.length > 0 ? attemptedModels : undefined,
		modelAttempts,
		artifactPaths,
	};
}

type RunnerStatusPayload = {
	runId: string;
	mode: "single" | "chain";
	state: "queued" | "running" | "complete" | "failed";
	startedAt: number;
	endedAt?: number;
	lastUpdate: number;
	pid: number;
	cwd: string;
	currentStep: number;
	steps: Array<{
		agent: string;
		status: "pending" | "running" | "complete" | "failed";
		startedAt?: number;
		endedAt?: number;
		durationMs?: number;
		exitCode?: number | null;
		tokens?: TokenUsage;
		skills?: string[];
		model?: string;
		attemptedModels?: string[];
		modelAttempts?: ModelAttempt[];
		error?: string;
	}>;
	artifactsDir?: string;
	sessionDir?: string;
	outputFile?: string;
	totalTokens?: TokenUsage;
	sessionFile?: string;
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
	writeJson(input.statusPath, input.statusPayload);
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
		input.statusPayload.steps[flatTaskIndex].status = "running";
		input.statusPayload.steps[flatTaskIndex].startedAt = input.groupStartTime;
	}
	input.statusPayload.currentStep = input.groupStartFlatIndex;
	input.statusPayload.lastUpdate = input.groupStartTime;
	input.statusPayload.outputFile = path.join(input.asyncDir, `output-${input.groupStartFlatIndex}.log`);
	writeJson(input.statusPath, input.statusPayload);
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
	let previousCumulativeTokens: TokenUsage = { input: 0, output: 0, total: 0 };
	let latestSessionFile: string | undefined;

	const flatSteps = flattenSteps(steps);
	const sessionEnabled = Boolean(config.sessionDir)
		|| shareEnabled
		|| flatSteps.some((step) => Boolean(step.sessionFile));
	const statusPayload: RunnerStatusPayload = {
		runId: id,
		mode: flatSteps.length > 1 ? "chain" : "single",
		state: "running",
		startedAt: overallStartTime,
		lastUpdate: overallStartTime,
		pid: process.pid,
		cwd,
		currentStep: 0,
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
	writeJson(statusPath, statusPayload);
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
						if (aborted && failFast) {
							return { agent: task.agent, output: "(skipped — fail-fast)", exitCode: -1 as number | null, skipped: true };
						}

						const fi = groupStartFlatIndex + taskIdx;
						const taskStartTime = Date.now();

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
						writeJson(statusPath, statusPayload);

						appendJsonl(eventsPath, JSON.stringify({
							type: singleResult.exitCode === 0 ? "subagent.step.completed" : "subagent.step.failed",
							ts: taskEndTime, runId: id, stepIndex: fi, agent: task.agent,
							exitCode: singleResult.exitCode, durationMs: taskDuration,
						}));

						if (singleResult.exitCode !== 0 && failFast) aborted = true;
						return { ...singleResult, skipped: false };
					},
				);

				flatIndex += group.parallel.length;

				if (config.sessionDir) {
					for (let t = 0; t < group.parallel.length; t++) {
						const taskSessionDir = path.join(config.sessionDir, `parallel-${t}`);
						const taskTokens = parseSessionTokens(taskSessionDir);
						if (taskTokens) {
							const fi = groupStartFlatIndex + t;
							statusPayload.steps[fi].tokens = taskTokens;
							previousCumulativeTokens = {
								input: previousCumulativeTokens.input + taskTokens.input,
								output: previousCumulativeTokens.output + taskTokens.output,
								total: previousCumulativeTokens.total + taskTokens.total,
							};
						}
					}
					statusPayload.totalTokens = { ...previousCumulativeTokens };
					statusPayload.lastUpdate = Date.now();
					writeJson(statusPath, statusPayload);
				}

				for (const pr of parallelResults) {
					results.push({
						agent: pr.agent,
						output: pr.output,
						success: pr.exitCode === 0,
						skipped: pr.skipped,
						model: pr.model,
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
			statusPayload.steps[flatIndex].skills = seqStep.skills;
			statusPayload.steps[flatIndex].startedAt = stepStartTime;
			statusPayload.lastUpdate = stepStartTime;
			statusPayload.outputFile = path.join(asyncDir, `output-${flatIndex}.log`);
			writeJson(statusPath, statusPayload);

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
			});
			if (seqStep.sessionFile) {
				latestSessionFile = seqStep.sessionFile;
			}

			previousOutput = singleResult.output;
			results.push({
				agent: singleResult.agent,
				output: singleResult.output,
				success: singleResult.exitCode === 0,
				model: singleResult.model,
				attemptedModels: singleResult.attemptedModels,
				modelAttempts: singleResult.modelAttempts,
				artifactPaths: singleResult.artifactPaths,
			});

			const cumulativeTokens = config.sessionDir ? parseSessionTokens(config.sessionDir) : null;
			const stepTokens: TokenUsage | null = cumulativeTokens
				? {
						input: cumulativeTokens.input - previousCumulativeTokens.input,
						output: cumulativeTokens.output - previousCumulativeTokens.output,
						total: cumulativeTokens.total - previousCumulativeTokens.total,
					}
				: null;
			if (cumulativeTokens) {
				previousCumulativeTokens = cumulativeTokens;
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
			writeJson(statusPath, statusPayload);

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

	const effectiveSessionFile = sessionFile ?? latestSessionFile;
	const runEndedAt = Date.now();
	statusPayload.state = results.every((r) => r.success) ? "complete" : "failed";
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
	writeJson(statusPath, statusPayload);
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
		writeJson(resultPath, {
			id,
			agent: agentName,
			success: results.every((r) => r.success),
			summary,
			results: results.map((r) => ({
				agent: r.agent,
				output: r.output,
				success: r.success,
				skipped: r.skipped || undefined,
				model: r.model,
				attemptedModels: r.attemptedModels,
				modelAttempts: r.modelAttempts,
				artifactPaths: r.artifactPaths,
				truncated: r.truncated,
			})),
			exitCode: results.every((r) => r.success) ? 0 : 1,
			timestamp: runEndedAt,
			durationMs: runEndedAt - overallStartTime,
			truncated,
			artifactsDir,
			cwd,
			asyncDir,
			sessionId: config.sessionId,
			sessionFile: effectiveSessionFile,
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
