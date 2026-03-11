import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { appendJsonl, getArtifactPaths } from "./artifacts.js";
import { getPiSpawnCommand } from "./pi-spawn.js";
import { persistSingleOutput } from "./single-output.js";
import {
	type ArtifactConfig,
	type ArtifactPaths,
	type AsyncStepStatus,
	type ModelAttempt,
	DEFAULT_MAX_OUTPUT,
	type MaxOutputConfig,
	truncateOutput,
	getSubagentDepthEnv,
} from "./types.js";
import {
	type RunnerSubagentStep as SubagentStep,
	type RunnerStep,
	isParallelGroup,
	flattenSteps,
	mapConcurrent,
	aggregateParallelOutputs,
	MAX_PARALLEL_CONCURRENCY,
} from "./parallel-utils.js";
import { executeWithRuntimeModelFallback, type ModelAttemptExecutionResult } from "./runtime-model-fallback.js";

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
}

interface StepResult {
	agent: string;
	output: string;
	success: boolean;
	exitCode?: number | null;
	error?: string;
	skipped?: boolean;
	requestedModel?: string;
	finalModel?: string;
	modelAttempts?: ModelAttempt[];
	fallbackSummary?: string;
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
		return null;
	}
}

interface TokenUsage {
	input: number;
	output: number;
	total: number;
}

function parseSessionTokens(sessionDir: string): TokenUsage | null {
	const sessionFile = findLatestSessionFile(sessionDir);
	if (!sessionFile) return null;
	try {
		const content = fs.readFileSync(sessionFile, "utf-8");
		let input = 0;
		let output = 0;
		for (const line of content.split("\n")) {
			if (!line.trim()) continue;
			try {
				const entry = JSON.parse(line);
				if (entry.usage) {
					input += entry.usage.inputTokens ?? entry.usage.input ?? 0;
					output += entry.usage.outputTokens ?? entry.usage.output ?? 0;
				}
			} catch {}
		}
		return { input, output, total: input + output };
	} catch {
		return null;
	}
}

function runPiStreaming(
	args: string[],
	cwd: string,
	outputFile: string,
	env?: Record<string, string | undefined>,
	piPackageRoot?: string,
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
	return new Promise((resolve) => {
		const outputStream = fs.createWriteStream(outputFile, { flags: "w" });
		const spawnEnv = { ...process.env, ...(env ?? {}), ...getSubagentDepthEnv() };
		const spawnSpec = getPiSpawnCommand(args, piPackageRoot ? { piPackageRoot } : undefined);
		const child = spawn(spawnSpec.command, spawnSpec.args, { cwd, stdio: ["ignore", "pipe", "pipe"], env: spawnEnv });
		let stdout = "";
		let stderr = "";

		child.stdout.on("data", (chunk: Buffer) => {
			const text = chunk.toString();
			stdout += text;
			outputStream.write(text);
		});

		child.stderr.on("data", (chunk: Buffer) => {
			const text = chunk.toString();
			stderr += text;
			outputStream.write(text);
		});

		child.on("close", (exitCode) => {
			outputStream.end();
			resolve({ stdout, stderr, exitCode });
		});

		child.on("error", () => {
			outputStream.end();
			resolve({ stdout, stderr, exitCode: 1 });
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
		} catch {}
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
	fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf-8");
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
			requestedModel?: string;
			finalModel?: string;
			modelAttempts?: ModelAttempt[];
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
	lines.push("## Model Attempts");
	for (const [i, step] of input.steps.entries()) {
		lines.push(`### Step ${i + 1}: ${step.agent}`);
		if (step.requestedModel) lines.push(`- Requested: ${step.requestedModel}`);
		if (step.finalModel) lines.push(`- Final: ${step.finalModel}`);
		if (step.modelAttempts?.length) {
			lines.push("- Attempts:");
			for (const attempt of step.modelAttempts) {
				const parts = [attempt.outcome.toUpperCase(), attempt.model, `(source: ${attempt.source})`];
				if (attempt.classification) parts.push(`[${attempt.classification}]`);
				if (attempt.reason) parts.push(`- ${attempt.reason}`);
				lines.push(`  - ${parts.join(" ")}`);
			}
		} else {
			lines.push("- Attempts: none recorded");
		}
		lines.push("");
	}
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
	stepStatus?: AsyncStepStatus;
	flushStatus?: () => void;
}

function buildFailedStepResult(step: SubagentStep, task: string, error: string): StepResult {
	return {
		agent: step.agent,
		output: error,
		success: false,
		exitCode: 1,
		error,
	};
}

async function runSingleStepAttempt(
	step: SubagentStep,
	ctx: SingleStepContext,
	attemptModel?: string,
): Promise<ModelAttemptExecutionResult<StepResult>> {
	const args = ["-p"];
	if (!ctx.sessionEnabled) {
		args.push("--no-session");
	}
	if (ctx.sessionDir) {
		try { fs.mkdirSync(ctx.sessionDir, { recursive: true }); } catch {}
		args.push("--session-dir", ctx.sessionDir);
	}
	if (attemptModel) args.push("--models", attemptModel);

	const toolExtensionPaths: string[] = [];
	if (step.tools?.length) {
		const builtinTools: string[] = [];
		for (const tool of step.tools) {
			if (tool.includes("/") || tool.endsWith(".ts") || tool.endsWith(".js")) {
				toolExtensionPaths.push(tool);
			} else {
				builtinTools.push(tool);
			}
		}
		if (builtinTools.length > 0) args.push("--tools", builtinTools.join(","));
	}
	if (step.extensions !== undefined) {
		args.push("--no-extensions");
		for (const extPath of step.extensions) args.push("--extension", extPath);
	} else {
		for (const extPath of toolExtensionPaths) args.push("--extension", extPath);
	}

	let tmpDir: string | null = null;
	if (step.systemPrompt) {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-"));
		const promptPath = path.join(tmpDir, "prompt.md");
		fs.writeFileSync(promptPath, step.systemPrompt);
		args.push("--append-system-prompt", promptPath);
	}

	const placeholderRegex = new RegExp(ctx.placeholder.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g");
	const task = step.task.replace(placeholderRegex, () => ctx.previousOutput);

	const TASK_ARG_LIMIT = 8000;
	if (task.length > TASK_ARG_LIMIT) {
		if (!tmpDir) tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-"));
		const taskFilePath = path.join(tmpDir, "task.md");
		fs.writeFileSync(taskFilePath, `Task: ${task}`, { mode: 0o600 });
		args.push(`@${taskFilePath}`);
	} else {
		args.push(`Task: ${task}`);
	}

	let artifactPaths: ArtifactPaths | undefined;
	if (ctx.artifactsDir && ctx.artifactConfig?.enabled !== false) {
		const index = ctx.flatStepCount > 1 ? ctx.flatIndex : undefined;
		artifactPaths = getArtifactPaths(ctx.artifactsDir, ctx.id, step.agent, index);
		fs.mkdirSync(ctx.artifactsDir, { recursive: true });
		if (ctx.artifactConfig?.includeInput !== false) {
			fs.writeFileSync(artifactPaths.inputPath, `# Task for ${step.agent}\n\n${task}`, "utf-8");
		}
	}

	const mcpEnv: Record<string, string | undefined> = {};
	if (step.mcpDirectTools?.length) {
		mcpEnv.MCP_DIRECT_TOOLS = step.mcpDirectTools.join(",");
	} else {
		mcpEnv.MCP_DIRECT_TOOLS = "__none__";
	}

	const result = await runPiStreaming(args, step.cwd ?? ctx.cwd, ctx.outputFile, mcpEnv, ctx.piPackageRoot);

	if (tmpDir) {
		try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
	}

	const output = (result.stdout || "").trim();
	let outputForSummary = output;
	if (step.outputPath && result.exitCode === 0) {
		const persisted = persistSingleOutput(step.outputPath, output);
		if (persisted.savedPath) {
			outputForSummary = output
				? `${output}\n\n📄 Output saved to: ${persisted.savedPath}`
				: `📄 Output saved to: ${persisted.savedPath}`;
		} else if (persisted.error) {
			outputForSummary = output
				? `${output}\n\n⚠️ Failed to save output to: ${step.outputPath}\n${persisted.error}`
				: `⚠️ Failed to save output to: ${step.outputPath}\n${persisted.error}`;
		}
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
					exitCode: result.exitCode,
					model: attemptModel,
					skills: step.skills,
					timestamp: Date.now(),
				}, null, 2),
				"utf-8",
			);
		}
	}

	const stepResult: StepResult = {
		agent: step.agent,
		output: outputForSummary,
		success: result.exitCode === 0,
		exitCode: result.exitCode,
		error: result.exitCode === 0 ? undefined : (result.stderr || outputForSummary || "Step failed"),
		artifactPaths,
		finalModel: attemptModel,
	};
	return {
		ok: result.exitCode === 0,
		result: stepResult,
		exitCode: result.exitCode,
		error: stepResult.error,
		stderr: result.stderr,
		stdout: result.stdout,
		output: outputForSummary,
	};
}

/** Run a single pi agent step, returning output and metadata */
async function runSingleStep(
	step: SubagentStep,
	ctx: SingleStepContext,
): Promise<StepResult> {
	const execution = await executeWithRuntimeModelFallback<StepResult>({
		context: step.runtimeModelContext,
		modelOverride: step.modelOverride,
		agentModel: step.agentModel,
		agentThinking: step.thinking,
		makeFailureResult: (message) => buildFailedStepResult(step, step.task, message),
		executeAttempt: async (candidate) => runSingleStepAttempt(step, ctx, candidate?.normalizedModel ?? candidate?.model),
		onAttemptEvent: (event) => {
			if (!ctx.stepStatus) return;
			if (event.type === "retry") {
				ctx.stepStatus.lastFallbackReason = event.attempt.reason;
			} else if (event.type === "stop") {
				ctx.stepStatus.lastFallbackReason = event.attempt.reason;
			} else if (event.type === "exhausted") {
				ctx.stepStatus.lastFallbackReason = event.lastFailure?.reason;
			}
			ctx.flushStatus?.();
		},
	});

	const result = execution.result;
	result.requestedModel = execution.requestedModel;
	result.finalModel = result.finalModel ?? execution.finalModel;
	result.modelAttempts = execution.modelAttempts;
	result.fallbackSummary = execution.fallbackSummary;
	if (ctx.stepStatus) {
		ctx.stepStatus.requestedModel = result.requestedModel;
		ctx.stepStatus.finalModel = result.finalModel;
		ctx.stepStatus.modelAttempts = result.modelAttempts;
		ctx.stepStatus.lastFallbackReason = result.modelAttempts?.at(-1)?.reason;
		ctx.flushStatus?.();
	}
	return result;
}

async function runSubagent(config: SubagentRunConfig): Promise<void> {
	const { id, steps, resultPath, cwd, placeholder, taskIndex, totalTasks, maxOutput, artifactsDir, artifactConfig } =
		config;
	let previousOutput = "";
	const results: StepResult[] = [];
	const overallStartTime = Date.now();
	const shareEnabled = config.share === true;
	const sessionEnabled = Boolean(config.sessionDir) || shareEnabled;
	const asyncDir = config.asyncDir;
	const statusPath = path.join(asyncDir, "status.json");
	const eventsPath = path.join(asyncDir, "events.jsonl");
	const logPath = path.join(asyncDir, `subagent-log-${id}.md`);
	let previousCumulativeTokens: TokenUsage = { input: 0, output: 0, total: 0 };

	// Flatten steps for status tracking (parallel groups expand to individual entries)
	const flatSteps = flattenSteps(steps);
	const statusPayload: {
		runId: string;
		mode: "single" | "chain";
		state: "queued" | "running" | "complete" | "failed";
		startedAt: number;
		endedAt?: number;
		lastUpdate: number;
		pid: number;
		cwd: string;
		currentStep: number;
		steps: Array<AsyncStepStatus & {
			status: "pending" | "running" | "complete" | "failed";
			startedAt?: number;
			endedAt?: number;
			durationMs?: number;
			exitCode?: number | null;
			error?: string;
			tokens?: TokenUsage;
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
	} = {
		runId: id,
		mode: flatSteps.length > 1 ? "chain" : "single",
		state: "running",
		startedAt: overallStartTime,
		lastUpdate: overallStartTime,
		pid: process.pid,
		cwd,
		currentStep: 0,
		steps: flatSteps.map((step) => ({ agent: step.agent, status: "pending", skills: step.skills })),
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

	const flushStatus = () => {
		statusPayload.lastUpdate = Date.now();
		writeJson(statusPath, statusPayload);
	};

	// Track the flat index into statusPayload.steps across sequential + parallel steps
	let flatIndex = 0;

	for (let stepIndex = 0; stepIndex < steps.length; stepIndex++) {
		const step = steps[stepIndex];

		if (isParallelGroup(step)) {
			// === PARALLEL STEP GROUP ===
			const group = step;
			const concurrency = group.concurrency ?? MAX_PARALLEL_CONCURRENCY;
			const failFast = group.failFast ?? false;
			const groupStartFlatIndex = flatIndex;
			let aborted = false;

			// Mark all tasks in the group as running
			const groupStartTime = Date.now();
			for (let t = 0; t < group.parallel.length; t++) {
				const fi = groupStartFlatIndex + t;
				statusPayload.steps[fi].status = "running";
				statusPayload.steps[fi].startedAt = groupStartTime;
			}
			statusPayload.currentStep = groupStartFlatIndex;
			statusPayload.lastUpdate = groupStartTime;
			statusPayload.outputFile = path.join(asyncDir, `output-${groupStartFlatIndex}.log`);
			writeJson(statusPath, statusPayload);

			appendJsonl(eventsPath, JSON.stringify({
				type: "subagent.parallel.started",
				ts: groupStartTime,
				runId: id,
				stepIndex,
				agents: group.parallel.map((t) => t.agent),
				count: group.parallel.length,
			}));

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

					// Each parallel task gets its own session subdirectory to avoid conflicts
					const taskSessionDir = config.sessionDir
						? path.join(config.sessionDir, `parallel-${taskIdx}`)
						: undefined;

					const singleResult = await runSingleStep(task, {
						previousOutput, placeholder, cwd, sessionEnabled,
						sessionDir: taskSessionDir,
						artifactsDir, artifactConfig, id,
						flatIndex: fi, flatStepCount: flatSteps.length,
						outputFile: path.join(asyncDir, `output-${fi}.log`),
						piPackageRoot: config.piPackageRoot,
						stepStatus: statusPayload.steps[fi],
						flushStatus,
					});

					const taskEndTime = Date.now();
					const taskDuration = taskEndTime - taskStartTime;

					statusPayload.steps[fi].status = singleResult.exitCode === 0 ? "complete" : "failed";
					statusPayload.steps[fi].endedAt = taskEndTime;
					statusPayload.steps[fi].durationMs = taskDuration;
					statusPayload.steps[fi].exitCode = singleResult.exitCode;
					statusPayload.steps[fi].error = singleResult.error;
					statusPayload.steps[fi].requestedModel = singleResult.requestedModel;
					statusPayload.steps[fi].finalModel = singleResult.finalModel;
					statusPayload.steps[fi].modelAttempts = singleResult.modelAttempts;
					statusPayload.steps[fi].lastFallbackReason = singleResult.fallbackSummary ?? singleResult.modelAttempts?.at(-1)?.reason;
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

			// Aggregate token usage from parallel task session dirs
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

			// Collect results
			for (const pr of parallelResults) {
				results.push({
					agent: pr.agent,
					output: pr.output,
					success: pr.exitCode === 0,
					exitCode: pr.exitCode,
					error: pr.error,
					skipped: pr.skipped,
					requestedModel: pr.requestedModel,
					finalModel: pr.finalModel,
					modelAttempts: pr.modelAttempts,
					fallbackSummary: pr.fallbackSummary,
					artifactPaths: pr.artifactPaths,
				});
			}

			// Aggregate parallel outputs for {previous}
			previousOutput = aggregateParallelOutputs(
				parallelResults.map((r) => ({ agent: r.agent, output: r.output, exitCode: r.exitCode, error: r.error })),
			);

			appendJsonl(eventsPath, JSON.stringify({
				type: "subagent.parallel.completed",
				ts: Date.now(),
				runId: id,
				stepIndex,
				success: parallelResults.every((r) => r.exitCode === 0 || r.exitCode === -1),
			}));

			// If any parallel task failed (not skipped), stop the chain
			if (parallelResults.some((r) => r.exitCode !== 0 && r.exitCode !== -1)) {
				break;
			}
		} else {
			// === SEQUENTIAL STEP ===
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
				stepStatus: statusPayload.steps[flatIndex],
				flushStatus,
			});

			previousOutput = singleResult.output;
			results.push({
				agent: singleResult.agent,
				output: singleResult.output,
				success: singleResult.exitCode === 0,
				exitCode: singleResult.exitCode,
				error: singleResult.error,
				requestedModel: singleResult.requestedModel,
				finalModel: singleResult.finalModel,
				modelAttempts: singleResult.modelAttempts,
				fallbackSummary: singleResult.fallbackSummary,
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
			statusPayload.steps[flatIndex].error = singleResult.error;
			statusPayload.steps[flatIndex].requestedModel = singleResult.requestedModel;
			statusPayload.steps[flatIndex].finalModel = singleResult.finalModel;
			statusPayload.steps[flatIndex].modelAttempts = singleResult.modelAttempts;
			statusPayload.steps[flatIndex].lastFallbackReason = singleResult.fallbackSummary ?? singleResult.modelAttempts?.at(-1)?.reason;
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

	if (shareEnabled && config.sessionDir) {
		sessionFile = findLatestSessionFile(config.sessionDir) ?? undefined;
		if (sessionFile) {
			try {
				const htmlPath = await exportSessionHtml(sessionFile, config.sessionDir, config.piPackageRoot);
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

	const runEndedAt = Date.now();
	statusPayload.state = results.every((r) => r.success) ? "complete" : "failed";
	statusPayload.endedAt = runEndedAt;
	statusPayload.lastUpdate = runEndedAt;
	statusPayload.sessionFile = sessionFile;
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
			requestedModel: step.requestedModel,
			finalModel: step.finalModel,
			modelAttempts: step.modelAttempts,
		})),
		summary,
		truncated,
		artifactsDir,
		sessionFile,
		shareUrl,
		shareError,
	});

	try {
		fs.mkdirSync(path.dirname(resultPath), { recursive: true });
		fs.writeFileSync(
			resultPath,
			JSON.stringify({
				id,
				agent: agentName,
				success: results.every((r) => r.success),
				summary,
				results: results.map((r) => ({
					agent: r.agent,
					output: r.output,
					success: r.success,
					exitCode: r.exitCode,
					error: r.error,
					skipped: r.skipped || undefined,
					requestedModel: r.requestedModel,
					finalModel: r.finalModel,
					modelAttempts: r.modelAttempts,
					fallbackSummary: r.fallbackSummary,
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
				sessionFile,
				shareUrl,
				gistUrl,
				shareError,
				...(taskIndex !== undefined && { taskIndex }),
				...(totalTasks !== undefined && { totalTasks }),
			}),
		);
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
		} catch {}
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
