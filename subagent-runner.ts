import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { appendJsonl, getArtifactPaths } from "./artifacts.js";
import {
	type ArtifactConfig,
	type ArtifactPaths,
	DEFAULT_MAX_OUTPUT,
	type MaxOutputConfig,
	truncateOutput,
} from "./types.js";

interface SubagentStep {
	agent: string;
	task: string;
	cwd?: string;
	model?: string;
	tools?: string[];
	systemPrompt?: string | null;
	skills?: string[];
}

interface SubagentRunConfig {
	id: string;
	steps: SubagentStep[];
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
}

interface StepResult {
	agent: string;
	output: string;
	success: boolean;
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
): Promise<{ stdout: string; exitCode: number | null }> {
	return new Promise((resolve) => {
		const outputStream = fs.createWriteStream(outputFile, { flags: "w" });
		const child = spawn("pi", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";

		child.stdout.on("data", (chunk: Buffer) => {
			const text = chunk.toString();
			stdout += text;
			outputStream.write(text);
		});

		child.stderr.on("data", (chunk: Buffer) => {
			outputStream.write(chunk.toString());
		});

		child.on("close", (exitCode) => {
			outputStream.end();
			resolve({ stdout, exitCode });
		});

		child.on("error", () => {
			outputStream.end();
			resolve({ stdout, exitCode: 1 });
		});
	});
}

async function exportSessionHtml(sessionFile: string, outputDir: string): Promise<string> {
	const pkgRoot = path.dirname(require.resolve("@mariozechner/pi-coding-agent/package.json"));
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

	const outputFile = path.join(asyncDir, "output.log");
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
		steps: Array<{
			agent: string;
			status: "pending" | "running" | "complete" | "failed";
			startedAt?: number;
			endedAt?: number;
			durationMs?: number;
			exitCode?: number | null;
			error?: string;
			tokens?: TokenUsage;
			skills?: string[];
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
		mode: steps.length > 1 ? "chain" : "single",
		state: "running",
		startedAt: overallStartTime,
		lastUpdate: overallStartTime,
		pid: process.pid,
		cwd,
		currentStep: 0,
		steps: steps.map((step) => ({ agent: step.agent, status: "pending", skills: step.skills })),
		artifactsDir,
		sessionDir: config.sessionDir,
		outputFile,
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

	for (let stepIndex = 0; stepIndex < steps.length; stepIndex++) {
		const step = steps[stepIndex];
		const stepStartTime = Date.now();
		statusPayload.currentStep = stepIndex;
		statusPayload.steps[stepIndex].status = "running";
		statusPayload.steps[stepIndex].skills = step.skills;
		statusPayload.steps[stepIndex].startedAt = stepStartTime;
		statusPayload.lastUpdate = stepStartTime;
		writeJson(statusPath, statusPayload);
		appendJsonl(
			eventsPath,
			JSON.stringify({
				type: "subagent.step.started",
				ts: stepStartTime,
				runId: id,
				stepIndex,
				agent: step.agent,
			}),
		);
		const args = ["-p"];
		if (!sessionEnabled) {
			args.push("--no-session");
		}
		if (config.sessionDir) {
			try {
				fs.mkdirSync(config.sessionDir, { recursive: true });
			} catch {}
			args.push("--session-dir", config.sessionDir);
		}
		if (step.model) args.push("--model", step.model);
		if (step.tools?.length) {
			const builtinTools: string[] = [];
			const extensionPaths: string[] = [];
			for (const tool of step.tools) {
				if (tool.includes("/") || tool.endsWith(".ts") || tool.endsWith(".js")) {
					extensionPaths.push(tool);
				} else {
					builtinTools.push(tool);
				}
			}
			if (builtinTools.length > 0) args.push("--tools", builtinTools.join(","));
			for (const extPath of extensionPaths) args.push("--extension", extPath);
		}

		let tmpDir: string | null = null;
		if (step.systemPrompt) {
			tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-"));
			const promptPath = path.join(tmpDir, "prompt.md");
			fs.writeFileSync(promptPath, step.systemPrompt);
			args.push("--append-system-prompt", promptPath);
		}

		const placeholderRegex = new RegExp(placeholder.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g");
		const task = step.task.replace(placeholderRegex, () => previousOutput);
		args.push(`Task: ${task}`);

		let artifactPaths: ArtifactPaths | undefined;
		if (artifactsDir && artifactConfig?.enabled !== false) {
			const index = taskIndex !== undefined ? taskIndex : steps.length > 1 ? stepIndex : undefined;
			artifactPaths = getArtifactPaths(artifactsDir, id, step.agent, index);
			fs.mkdirSync(artifactsDir, { recursive: true });

			if (artifactConfig?.includeInput !== false) {
				fs.writeFileSync(artifactPaths.inputPath, `# Task for ${step.agent}\n\n${task}`, "utf-8");
			}
		}

		const result = await runPiStreaming(args, step.cwd ?? cwd, outputFile);

		if (tmpDir) {
			try {
				fs.rmSync(tmpDir, { recursive: true });
			} catch {}
		}

		const output = (result.stdout || "").trim();
		previousOutput = output;

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

		const stepResult: StepResult = {
			agent: step.agent,
			output,
			success: result.exitCode === 0,
			artifactPaths,
		};

		if (artifactPaths && artifactConfig?.enabled !== false) {
			if (artifactConfig?.includeOutput !== false) {
				fs.writeFileSync(artifactPaths.outputPath, output, "utf-8");
			}

			if (artifactConfig?.includeMetadata !== false) {
				fs.writeFileSync(
					artifactPaths.metadataPath,
					JSON.stringify(
						{
							runId: id,
							agent: step.agent,
							task,
							exitCode: result.exitCode,
							durationMs: Date.now() - stepStartTime,
							skills: step.skills,
							timestamp: Date.now(),
						},
						null,
						2,
					),
					"utf-8",
				);
			}
		}

		results.push(stepResult);
		const stepEndTime = Date.now();
		statusPayload.steps[stepIndex].status = result.exitCode === 0 ? "complete" : "failed";
		statusPayload.steps[stepIndex].endedAt = stepEndTime;
		statusPayload.steps[stepIndex].durationMs = stepEndTime - stepStartTime;
		statusPayload.steps[stepIndex].exitCode = result.exitCode;
		if (stepTokens) {
			statusPayload.steps[stepIndex].tokens = stepTokens;
			statusPayload.totalTokens = { ...previousCumulativeTokens };
		}
		statusPayload.lastUpdate = stepEndTime;
		writeJson(statusPath, statusPayload);
		appendJsonl(
			eventsPath,
			JSON.stringify({
				type: result.exitCode === 0 ? "subagent.step.completed" : "subagent.step.failed",
				ts: stepEndTime,
				runId: id,
				stepIndex,
				agent: step.agent,
				exitCode: result.exitCode,
				durationMs: stepEndTime - stepStartTime,
				tokens: stepTokens,
			}),
		);

		if (result.exitCode !== 0) break;
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

	const agentName = steps.length === 1 ? steps[0].agent : `chain:${steps.map((s) => s.agent).join("->")}`;
	let sessionFile: string | undefined;
	let shareUrl: string | undefined;
	let gistUrl: string | undefined;
	let shareError: string | undefined;

	if (shareEnabled && config.sessionDir) {
		sessionFile = findLatestSessionFile(config.sessionDir) ?? undefined;
		if (sessionFile) {
			try {
				const htmlPath = await exportSessionHtml(sessionFile, config.sessionDir);
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
