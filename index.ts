/**
 * Async Subagent Tool
 *
 * Full-featured subagent with sync and async modes.
 * - Sync: Streams output, renders markdown, tracks usage
 * - Async: Background execution, emits events when done
 *
 * Modes: single (agent + task), parallel (tasks[]), chain (chain[] with {previous})
 * Toggle: async parameter (default: true)
 */

import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { Message } from "@mariozechner/pi-ai";
import { StringEnum } from "@mariozechner/pi-ai";
import { type ExtensionAPI, type ExtensionContext, type ToolDefinition, getMarkdownTheme } from "@mariozechner/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { type AgentConfig, type AgentScope, discoverAgents } from "./agents.js";
import {
	appendJsonl,
	cleanupOldArtifacts,
	ensureArtifactsDir,
	getArtifactPaths,
	getArtifactsDir,
	writeArtifact,
	writeMetadata,
} from "./artifacts.js";
import {
	type AgentProgress,
	type ArtifactConfig,
	type ArtifactPaths,
	DEFAULT_ARTIFACT_CONFIG,
	DEFAULT_MAX_OUTPUT,
	type MaxOutputConfig,
	type ProgressSummary,
	type TruncationResult,
	truncateOutput,
} from "./types.js";

const MAX_PARALLEL = 8;
const MAX_CONCURRENCY = 4;
const COLLAPSED_ITEMS = 8;
const RESULTS_DIR = "/tmp/pi-async-subagent-results";
const ASYNC_DIR = "/tmp/pi-async-subagent-runs";
const WIDGET_KEY = "subagent-async";
const POLL_INTERVAL_MS = 1000;
const MAX_WIDGET_JOBS = 4;

const require = createRequire(import.meta.url);
const jitiCliPath: string | undefined = (() => {
	try {
		return path.join(path.dirname(require.resolve("jiti/package.json")), "lib/jiti-cli.mjs");
	} catch {
		return undefined;
	}
})();

interface Usage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	turns: number;
}

interface SingleResult {
	agent: string;
	task: string;
	exitCode: number;
	messages: Message[];
	usage: Usage;
	model?: string;
	error?: string;
	sessionFile?: string;
	shareUrl?: string;
	gistUrl?: string;
	shareError?: string;
	progress?: AgentProgress;
	progressSummary?: ProgressSummary;
	artifactPaths?: ArtifactPaths;
	truncation?: TruncationResult;
}

interface Details {
	mode: "single" | "parallel" | "chain";
	results: SingleResult[];
	asyncId?: string;
	asyncDir?: string;
	progress?: AgentProgress[];
	progressSummary?: ProgressSummary;
	artifacts?: {
		dir: string;
		files: ArtifactPaths[];
	};
	truncation?: {
		truncated: boolean;
		originalBytes?: number;
		originalLines?: number;
		artifactPath?: string;
	};
}

type DisplayItem = { type: "text"; text: string } | { type: "tool"; name: string; args: Record<string, unknown> };

interface AsyncStatus {
	runId: string;
	mode: "single" | "chain";
	state: "queued" | "running" | "complete" | "failed";
	startedAt: number;
	endedAt?: number;
	lastUpdate?: number;
	currentStep?: number;
	steps?: Array<{ agent: string; status: string; durationMs?: number }>;
	sessionFile?: string;
	shareUrl?: string;
	shareError?: string;
}

interface AsyncJobState {
	asyncId: string;
	asyncDir: string;
	status: "queued" | "running" | "complete" | "failed";
	mode?: "single" | "chain";
	agents?: string[];
	currentStep?: number;
	stepsTotal?: number;
	startedAt?: number;
	updatedAt?: number;
	sessionFile?: string;
	shareUrl?: string;
}

function formatTokens(n: number): string {
	return n < 1000 ? String(n) : n < 10000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n / 1000)}k`;
}

function formatUsage(u: Usage, model?: string): string {
	const parts: string[] = [];
	if (u.turns) parts.push(`${u.turns} turn${u.turns > 1 ? "s" : ""}`);
	if (u.input) parts.push(`in:${formatTokens(u.input)}`);
	if (u.output) parts.push(`out:${formatTokens(u.output)}`);
	if (u.cacheRead) parts.push(`R${formatTokens(u.cacheRead)}`);
	if (u.cacheWrite) parts.push(`W${formatTokens(u.cacheWrite)}`);
	if (u.cost) parts.push(`$${u.cost.toFixed(4)}`);
	if (model) parts.push(model);
	return parts.join(" ");
}

function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
	return `${Math.floor(ms / 60000)}m${Math.floor((ms % 60000) / 1000)}s`;
}

function readStatus(asyncDir: string): AsyncStatus | null {
	const statusPath = path.join(asyncDir, "status.json");
	if (!fs.existsSync(statusPath)) return null;
	try {
		const content = fs.readFileSync(statusPath, "utf-8");
		return JSON.parse(content) as AsyncStatus;
	} catch {
		return null;
	}
}

function renderWidget(ctx: ExtensionContext, jobs: AsyncJobState[]): void {
	if (!ctx.hasUI) return;
	if (jobs.length === 0) {
		ctx.ui.setWidget(WIDGET_KEY, undefined);
		return;
	}

	const theme = ctx.ui.theme;
	const lines: string[] = [];
	lines.push(theme.fg("accent", "Async subagents"));

	for (const job of jobs.slice(0, MAX_WIDGET_JOBS)) {
		const id = job.asyncId.slice(0, 6);
		const status =
			job.status === "complete"
				? theme.fg("success", "complete")
				: job.status === "failed"
					? theme.fg("error", "failed")
					: theme.fg("warning", "running");

		const stepsTotal = job.stepsTotal ?? (job.agents?.length ?? 1);
		const stepIndex = job.currentStep !== undefined ? job.currentStep + 1 : undefined;
		const stepText = stepIndex !== undefined ? `step ${stepIndex}/${stepsTotal}` : `steps ${stepsTotal}`;
		const mode = job.mode ?? (stepsTotal > 1 ? "chain" : "single");
		const endTime = (job.status === "complete" || job.status === "failed") ? job.updatedAt : Date.now();
		const elapsed = job.startedAt ? formatDuration(endTime - job.startedAt) : "";
		const agentLabel = job.agents ? job.agents.join(" -> ") : mode;

		lines.push(`- ${id} ${status} | ${agentLabel} | ${stepText}${elapsed ? ` | ${elapsed}` : ""}`);
	}

	ctx.ui.setWidget(WIDGET_KEY, lines);
}

function findByPrefix(dir: string, prefix: string, suffix?: string): string | null {
	if (!fs.existsSync(dir)) return null;
	const entries = fs.readdirSync(dir).filter((entry) => entry.startsWith(prefix));
	if (suffix) {
		const withSuffix = entries.filter((entry) => entry.endsWith(suffix));
		if (withSuffix.length > 0) return path.join(dir, withSuffix.sort()[0]);
	}
	if (entries.length === 0) return null;
	return path.join(dir, entries.sort()[0]);
}

function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "";
}

interface ErrorInfo {
	hasError: boolean;
	exitCode?: number;
	errorType?: string;
	details?: string;
}

function detectSubagentError(messages: Message[]): ErrorInfo {
	for (const msg of messages) {
		if (msg.role === "toolResult" && (msg as any).isError) {
			const text = msg.content.find((c) => c.type === "text");
			const details = text && "text" in text ? text.text : undefined;
			const exitMatch = details?.match(/exit(?:ed)?\s*(?:with\s*)?(?:code|status)?\s*[:\s]?\s*(\d+)/i);
			return {
				hasError: true,
				exitCode: exitMatch ? parseInt(exitMatch[1], 10) : 1,
				errorType: (msg as any).toolName || "tool",
				details: details?.slice(0, 200),
			};
		}
	}

	for (const msg of messages) {
		if (msg.role !== "toolResult") continue;
		const toolName = (msg as any).toolName;
		if (toolName !== "bash") continue;

		const text = msg.content.find((c) => c.type === "text");
		if (!text || !("text" in text)) continue;
		const output = text.text;

		const exitMatch = output.match(/exit(?:ed)?\s*(?:with\s*)?(?:code|status)?\s*[:\s]?\s*(\d+)/i);
		if (exitMatch) {
			const code = parseInt(exitMatch[1], 10);
			if (code !== 0) {
				return { hasError: true, exitCode: code, errorType: "bash", details: output.slice(0, 200) };
			}
		}

		const errorPatterns = [
			/command not found/i,
			/permission denied/i,
			/no such file or directory/i,
			/segmentation fault/i,
			/killed|terminated/i,
			/out of memory/i,
			/connection refused/i,
			/timeout/i,
		];
		for (const pattern of errorPatterns) {
			if (pattern.test(output)) {
				return { hasError: true, exitCode: 1, errorType: "bash", details: output.slice(0, 200) };
			}
		}
	}

	return { hasError: false };
}

function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") items.push({ type: "text", text: part.text });
				else if (part.type === "toolCall") items.push({ type: "tool", name: part.name, args: part.arguments });
			}
		}
	}
	return items;
}

function shortenPath(p: string): string {
	const home = os.homedir();
	return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

function formatToolCall(name: string, args: Record<string, unknown>): string {
	switch (name) {
		case "bash":
			return `$ ${((args.command as string) || "").slice(0, 60)}${(args.command as string)?.length > 60 ? "..." : ""}`;
		case "read":
			return `read ${shortenPath((args.path || args.file_path || "") as string)}`;
		case "write":
			return `write ${shortenPath((args.path || args.file_path || "") as string)}`;
		case "edit":
			return `edit ${shortenPath((args.path || args.file_path || "") as string)}`;
		default: {
			const s = JSON.stringify(args);
			return `${name} ${s.slice(0, 40)}${s.length > 40 ? "..." : ""}`;
		}
	}
}

function extractToolArgsPreview(args: Record<string, unknown>): string {
	const previewKeys = ["command", "path", "file_path", "pattern", "query", "url", "task"];
	for (const key of previewKeys) {
		if (args[key] && typeof args[key] === "string") {
			const value = args[key] as string;
			return value.length > 60 ? `${value.slice(0, 57)}...` : value;
		}
	}
	return "";
}

function extractTextFromContent(content: unknown): string {
	if (!Array.isArray(content)) return "";
	for (const part of content) {
		if (part && typeof part === "object" && "type" in part && part.type === "text" && "text" in part) {
			return String(part.text);
		}
	}
	return "";
}

function writePrompt(agent: string, prompt: string): { dir: string; path: string } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-"));
	const p = path.join(dir, `${agent.replace(/[^\w.-]/g, "_")}.md`);
	fs.writeFileSync(p, prompt, { mode: 0o600 });
	return { dir, path: p };
}

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

interface RunSyncOptions {
	cwd?: string;
	signal?: AbortSignal;
	onUpdate?: (r: AgentToolResult<Details>) => void;
	maxOutput?: MaxOutputConfig;
	artifactsDir?: string;
	artifactConfig?: ArtifactConfig;
	runId: string;
	index?: number;
	sessionDir?: string;
	share?: boolean;
}

async function runSync(
	runtimeCwd: string,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	options: RunSyncOptions,
): Promise<SingleResult> {
	const { cwd, signal, onUpdate, maxOutput, artifactsDir, artifactConfig, runId, index } = options;
	const agent = agents.find((a) => a.name === agentName);
	if (!agent) {
		return {
			agent: agentName,
			task,
			exitCode: 1,
			messages: [],
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
			error: `Unknown agent: ${agentName}`,
		};
	}

	const args = ["--mode", "json", "-p"];
	const shareEnabled = options.share === true;
	const sessionEnabled = Boolean(options.sessionDir) || shareEnabled;
	if (!sessionEnabled) {
		args.push("--no-session");
	}
	if (options.sessionDir) {
		try {
			fs.mkdirSync(options.sessionDir, { recursive: true });
		} catch {}
		args.push("--session-dir", options.sessionDir);
	}
	if (agent.model) args.push("--model", agent.model);
	if (agent.tools?.length) {
		const builtinTools: string[] = [];
		const extensionPaths: string[] = [];
		for (const tool of agent.tools) {
			if (tool.includes("/") || tool.endsWith(".ts") || tool.endsWith(".js")) {
				extensionPaths.push(tool);
			} else {
				builtinTools.push(tool);
			}
		}
		if (builtinTools.length > 0) {
			args.push("--tools", builtinTools.join(","));
		}
		for (const extPath of extensionPaths) {
			args.push("--extension", extPath);
		}
	}

	let tmpDir: string | null = null;
	if (agent.systemPrompt?.trim()) {
		const tmp = writePrompt(agent.name, agent.systemPrompt);
		tmpDir = tmp.dir;
		args.push("--append-system-prompt", tmp.path);
	}
	args.push(`Task: ${task}`);

	const result: SingleResult = {
		agent: agentName,
		task,
		exitCode: 0,
		messages: [],
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
	};

	const progress: AgentProgress = {
		index: index ?? 0,
		agent: agentName,
		status: "running",
		task,
		recentTools: [],
		recentOutput: [],
		toolCount: 0,
		tokens: 0,
		durationMs: 0,
	};

	const startTime = Date.now();
	const jsonlLines: string[] = [];

	let artifactPathsResult: ArtifactPaths | undefined;
	if (artifactsDir && artifactConfig?.enabled !== false) {
		artifactPathsResult = getArtifactPaths(artifactsDir, runId, agentName, index);
		ensureArtifactsDir(artifactsDir);
		if (artifactConfig?.includeInput !== false) {
			writeArtifact(artifactPathsResult.inputPath, `# Task for ${agentName}\n\n${task}`);
		}
	}

	const exitCode = await new Promise<number>((resolve) => {
		const proc = spawn("pi", args, { cwd: cwd ?? runtimeCwd, stdio: ["ignore", "pipe", "pipe"] });
		let buf = "";

		const processLine = (line: string) => {
			if (!line.trim()) return;
			jsonlLines.push(line);
			try {
				const evt = JSON.parse(line) as { type?: string; message?: Message; toolName?: string; args?: unknown };
				const now = Date.now();
				progress.durationMs = now - startTime;

				if (evt.type === "tool_execution_start") {
					progress.toolCount++;
					progress.currentTool = evt.toolName;
					progress.currentToolArgs = extractToolArgsPreview((evt.args || {}) as Record<string, unknown>);
				}

				if (evt.type === "tool_execution_end") {
					if (progress.currentTool) {
						progress.recentTools.unshift({
							tool: progress.currentTool,
							args: progress.currentToolArgs || "",
							endMs: now,
						});
						if (progress.recentTools.length > 5) {
							progress.recentTools.pop();
						}
					}
					progress.currentTool = undefined;
					progress.currentToolArgs = undefined;
				}

				if (evt.type === "message_end" && evt.message) {
					result.messages.push(evt.message);
					if (evt.message.role === "assistant") {
						result.usage.turns++;
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

						const text = extractTextFromContent(evt.message.content);
						if (text) {
							const lines = text
								.split("\n")
								.filter((l) => l.trim())
								.slice(-8);
							progress.recentOutput = lines;
						}
					}
					if (onUpdate)
						onUpdate({
							content: [{ type: "text", text: getFinalOutput(result.messages) || "(running...)" }],
							details: { mode: "single", results: [result], progress: [progress] },
						});
				}
				if (evt.type === "tool_result_end" && evt.message) {
					result.messages.push(evt.message);
					if (onUpdate)
						onUpdate({
							content: [{ type: "text", text: getFinalOutput(result.messages) || "(running...)" }],
							details: { mode: "single", results: [result], progress: [progress] },
						});
				}
			} catch {}
		};

		let stderrBuf = "";
		proc.stdout.on("data", (d) => {
			buf += d.toString();
			const lines = buf.split("\n");
			buf = lines.pop() || "";
			lines.forEach(processLine);
		});
		proc.stderr.on("data", (d) => {
			stderrBuf += d.toString();
		});
		proc.on("close", (code) => {
			if (buf.trim()) processLine(buf);
			if (code !== 0 && stderrBuf.trim() && !result.error) {
				result.error = stderrBuf.trim();
			}
			resolve(code ?? 0);
		});
		proc.on("error", () => resolve(1));

		if (signal) {
			const kill = () => {
				proc.kill("SIGTERM");
				setTimeout(() => !proc.killed && proc.kill("SIGKILL"), 3000);
			};
			if (signal.aborted) kill();
			else signal.addEventListener("abort", kill, { once: true });
		}
	});

	if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
	result.exitCode = exitCode;

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

	result.progress = progress;
	result.progressSummary = {
		toolCount: progress.toolCount,
		tokens: progress.tokens,
		durationMs: progress.durationMs,
	};

	if (artifactPathsResult && artifactConfig?.enabled !== false) {
		result.artifactPaths = artifactPathsResult;
		const fullOutput = getFinalOutput(result.messages);

		if (artifactConfig?.includeOutput !== false) {
			writeArtifact(artifactPathsResult.outputPath, fullOutput);
		}
		if (artifactConfig?.includeJsonl !== false) {
			for (const line of jsonlLines) {
				appendJsonl(artifactPathsResult.jsonlPath, line);
			}
		}
		if (artifactConfig?.includeMetadata !== false) {
			writeMetadata(artifactPathsResult.metadataPath, {
				runId,
				agent: agentName,
				task,
				exitCode: result.exitCode,
				usage: result.usage,
				model: result.model,
				durationMs: progress.durationMs,
				toolCount: progress.toolCount,
				error: result.error,
				timestamp: Date.now(),
			});
		}

		if (maxOutput) {
			const config = { ...DEFAULT_MAX_OUTPUT, ...maxOutput };
			const truncationResult = truncateOutput(fullOutput, config, artifactPathsResult.outputPath);
			if (truncationResult.truncated) {
				result.truncation = truncationResult;
			}
		}
	} else if (maxOutput) {
		const config = { ...DEFAULT_MAX_OUTPUT, ...maxOutput };
		const fullOutput = getFinalOutput(result.messages);
		const truncationResult = truncateOutput(fullOutput, config);
		if (truncationResult.truncated) {
			result.truncation = truncationResult;
		}
	}

	if (shareEnabled && options.sessionDir) {
		const sessionFile = findLatestSessionFile(options.sessionDir);
		if (sessionFile) {
			result.sessionFile = sessionFile;
			try {
				const htmlPath = await exportSessionHtml(sessionFile, options.sessionDir);
				const share = createShareLink(htmlPath);
				if ("error" in share) {
					result.shareError = share.error;
				} else {
					result.shareUrl = share.shareUrl;
					result.gistUrl = share.gistUrl;
				}
			} catch (err) {
				result.shareError = String(err);
			}
		} else {
			result.shareError = "Session file not found.";
		}
	}

	return result;
}

async function mapConcurrent<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let next = 0;
	await Promise.all(
		Array(Math.min(limit, items.length))
			.fill(0)
			.map(async () => {
				while (next < items.length) {
					const i = next++;
					results[i] = await fn(items[i], i);
				}
			}),
	);
	return results;
}

const TaskItem = Type.Object({ agent: Type.String(), task: Type.String(), cwd: Type.Optional(Type.String()) });
const ChainItem = Type.Object({
	agent: Type.String(),
	task: Type.String({ description: "Use {previous} for prior output" }),
	cwd: Type.Optional(Type.String()),
});

const MaxOutputSchema = Type.Optional(
	Type.Object({
		bytes: Type.Optional(Type.Number({ description: "Max bytes (default: 204800)" })),
		lines: Type.Optional(Type.Number({ description: "Max lines (default: 5000)" })),
	}),
);

const Params = Type.Object({
	agent: Type.Optional(Type.String({ description: "Agent name (single mode)" })),
	task: Type.Optional(Type.String({ description: "Task (single mode)" })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Parallel tasks" })),
	chain: Type.Optional(Type.Array(ChainItem, { description: "Sequential chain" })),
	async: Type.Optional(Type.Boolean({ description: "Run in background (default: true)", default: true })),
	agentScope: Type.Optional(StringEnum(["user", "project", "both"] as const, { default: "user" })),
	cwd: Type.Optional(Type.String()),
	maxOutput: MaxOutputSchema,
	artifacts: Type.Optional(Type.Boolean({ description: "Write debug artifacts (default: true)" })),
	includeProgress: Type.Optional(Type.Boolean({ description: "Include full progress in result (default: false)" })),
	share: Type.Optional(Type.Boolean({ description: "Create shareable session log (default: true)", default: true })),
	sessionDir: Type.Optional(
		Type.String({ description: "Directory to store session logs (default: temp; enables sessions even if share=false)" }),
	),
});

const StatusParams = Type.Object({
	id: Type.Optional(Type.String({ description: "Async run id or prefix" })),
	dir: Type.Optional(Type.String({ description: "Async run directory (overrides id search)" })),
});

export default function registerSubagentExtension(pi: ExtensionAPI): void {
	fs.mkdirSync(RESULTS_DIR, { recursive: true });
	fs.mkdirSync(ASYNC_DIR, { recursive: true });

	const tempArtifactsDir = getArtifactsDir(null);
	cleanupOldArtifacts(tempArtifactsDir, DEFAULT_ARTIFACT_CONFIG.cleanupDays);
	let baseCwd = process.cwd();
	const asyncJobs = new Map<string, AsyncJobState>();
	let lastUiContext: ExtensionContext | null = null;
	let poller: NodeJS.Timeout | null = null;

	const ensurePoller = () => {
		if (poller) return;
		poller = setInterval(() => {
			if (!lastUiContext || !lastUiContext.hasUI) return;
			if (asyncJobs.size === 0) {
				renderWidget(lastUiContext, []);
				clearInterval(poller);
				poller = null;
				return;
			}

			for (const job of asyncJobs.values()) {
				const status = readStatus(job.asyncDir);
				if (status) {
					job.status = status.state;
					job.mode = status.mode;
					job.currentStep = status.currentStep ?? job.currentStep;
					job.stepsTotal = status.steps?.length ?? job.stepsTotal;
					job.startedAt = status.startedAt ?? job.startedAt;
					job.updatedAt = status.lastUpdate ?? Date.now();
					if (status.steps?.length) {
						job.agents = status.steps.map((step) => step.agent);
					}
					job.sessionFile = status.sessionFile ?? job.sessionFile;
					job.shareUrl = status.shareUrl ?? job.shareUrl;
				} else {
					job.status = job.status === "queued" ? "running" : job.status;
					job.updatedAt = Date.now();
				}
			}

			renderWidget(lastUiContext, Array.from(asyncJobs.values()));
		}, POLL_INTERVAL_MS);
	};

	const handleResult = (file: string) => {
		const p = path.join(RESULTS_DIR, file);
		if (!fs.existsSync(p)) return;
		try {
			const data = JSON.parse(fs.readFileSync(p, "utf-8"));
			if (data.cwd && data.cwd !== baseCwd) return;
			pi.events.emit("subagent:complete", data);
			pi.events.emit("subagent_enhanced:complete", data);
			fs.unlinkSync(p);
		} catch {}
	};

	const watcher = fs.watch(RESULTS_DIR, (ev, file) => {
		if (ev === "rename" && file?.toString().endsWith(".json")) setTimeout(() => handleResult(file.toString()), 50);
	});
	fs.readdirSync(RESULTS_DIR)
		.filter((f) => f.endsWith(".json"))
		.forEach(handleResult);

	const tool: ToolDefinition<typeof Params, Details> = {
		name: "subagent",
		label: "Subagent",
		description: "Delegate tasks to subagents (single, parallel, chain) with optional async mode, artifacts, and truncation.",
		parameters: Params,

		async execute(_id, params, onUpdate, ctx, signal) {
			const scope: AgentScope = params.agentScope ?? "user";
			baseCwd = ctx.cwd;
			const agents = discoverAgents(ctx.cwd, scope).agents;
			const runId = randomUUID().slice(0, 8);
			const shareEnabled = params.share !== false;
			const sessionEnabled = shareEnabled || Boolean(params.sessionDir);
			const sessionRoot = sessionEnabled
				? params.sessionDir
					? path.resolve(params.sessionDir)
					: fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-session-"))
				: undefined;
			if (sessionRoot) {
				try {
					fs.mkdirSync(sessionRoot, { recursive: true });
				} catch {}
			}
			const sessionDirForIndex = (idx?: number) =>
				sessionRoot ? path.join(sessionRoot, `run-${idx ?? 0}`) : undefined;

			const hasChain = (params.chain?.length ?? 0) > 0;
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = Boolean(params.agent && params.task);

			const requestedAsync = params.async !== false;
			const parallelDowngraded = hasTasks && requestedAsync;
			const isAsync = requestedAsync && !hasTasks;

			const artifactConfig: ArtifactConfig = {
				...DEFAULT_ARTIFACT_CONFIG,
				enabled: params.artifacts !== false,
			};

			const sessionFile = ctx.sessionManager.getSessionFile() ?? null;
			const artifactsDir = isAsync ? tempArtifactsDir : getArtifactsDir(sessionFile);

			if (Number(hasChain) + Number(hasTasks) + Number(hasSingle) !== 1) {
				return {
					content: [
						{
							type: "text",
							text: `Provide exactly one mode. Agents: ${agents.map((a) => a.name).join(", ") || "none"}`,
						},
					],
					isError: true,
					details: { mode: "single" as const, results: [] },
				};
			}

			if (isAsync) {
				if (!jitiCliPath)
					return {
						content: [{ type: "text", text: "jiti not found" }],
						isError: true,
						details: { mode: "single" as const, results: [] },
					};
				const id = randomUUID();
				const asyncDir = path.join(ASYNC_DIR, id);
				try {
					fs.mkdirSync(asyncDir, { recursive: true });
				} catch {}
				const runner = path.join(path.dirname(fileURLToPath(import.meta.url)), "subagent-runner.ts");

				const spawnRunner = (cfg: object, suffix: string): number | undefined => {
					const cfgPath = path.join(os.tmpdir(), `pi-async-cfg-${suffix}.json`);
					fs.writeFileSync(cfgPath, JSON.stringify(cfg));
					const proc = spawn("node", [jitiCliPath!, runner, cfgPath], {
						cwd: (cfg as any).cwd ?? ctx.cwd,
						detached: true,
						stdio: "ignore",
					});
					proc.unref();
					return proc.pid;
				};

				if (hasChain && params.chain) {
					const steps = params.chain.map((s) => {
						const a = agents.find((x) => x.name === s.agent);
						if (!a) throw new Error(`Unknown: ${s.agent}`);
						return {
							agent: s.agent,
							task: s.task,
							cwd: s.cwd,
							model: a.model,
							tools: a.tools,
							systemPrompt: a.systemPrompt?.trim() || null,
						};
					});
					const pid = spawnRunner(
						{
							id,
							steps,
							resultPath: path.join(RESULTS_DIR, `${id}.json`),
							cwd: params.cwd ?? ctx.cwd,
							placeholder: "{previous}",
							maxOutput: params.maxOutput,
							artifactsDir: artifactConfig.enabled ? artifactsDir : undefined,
							artifactConfig,
							share: shareEnabled,
							sessionDir: sessionRoot ? path.join(sessionRoot, `async-${id}`) : undefined,
							asyncDir,
						},
						id,
					);
					if (pid) {
						pi.events.emit("subagent_enhanced:started", {
							id,
							pid,
							agent: params.chain[0].agent,
							task: params.chain[0].task?.slice(0, 50),
							chain: params.chain.map((s) => s.agent),
							cwd: params.cwd ?? ctx.cwd,
							asyncDir,
						});
						pi.events.emit("subagent:started", {
							id,
							pid,
							agent: params.chain[0].agent,
							task: params.chain[0].task?.slice(0, 50),
							chain: params.chain.map((s) => s.agent),
							cwd: params.cwd ?? ctx.cwd,
							asyncDir,
						});
					}
					return {
						content: [
							{ type: "text", text: `Async chain: ${params.chain.map((s) => s.agent).join(" -> ")} [${id}]` },
						],
						details: { mode: "chain", results: [], asyncId: id, asyncDir },
					};
				}

				if (hasSingle) {
					const a = agents.find((x) => x.name === params.agent);
					if (!a)
						return {
							content: [{ type: "text", text: `Unknown: ${params.agent}` }],
							isError: true,
							details: { mode: "single" as const, results: [] },
						};
					const pid = spawnRunner(
						{
							id,
							steps: [
								{
									agent: params.agent,
									task: params.task,
									cwd: params.cwd,
									model: a.model,
									tools: a.tools,
									systemPrompt: a.systemPrompt?.trim() || null,
								},
							],
							resultPath: path.join(RESULTS_DIR, `${id}.json`),
							cwd: params.cwd ?? ctx.cwd,
							placeholder: "{previous}",
							maxOutput: params.maxOutput,
							artifactsDir: artifactConfig.enabled ? artifactsDir : undefined,
							artifactConfig,
							share: shareEnabled,
							sessionDir: sessionRoot ? path.join(sessionRoot, `async-${id}`) : undefined,
							asyncDir,
						},
						id,
					);
					if (pid) {
						pi.events.emit("subagent_enhanced:started", {
							id,
							pid,
							agent: params.agent,
							task: params.task?.slice(0, 50),
							cwd: params.cwd ?? ctx.cwd,
							asyncDir,
						});
						pi.events.emit("subagent:started", {
							id,
							pid,
							agent: params.agent,
							task: params.task?.slice(0, 50),
							cwd: params.cwd ?? ctx.cwd,
							asyncDir,
						});
					}
					return {
						content: [{ type: "text", text: `Async: ${params.agent} [${id}]` }],
						details: { mode: "single", results: [], asyncId: id, asyncDir },
					};
				}
			}

			const allProgress: AgentProgress[] = [];
			const allArtifactPaths: ArtifactPaths[] = [];

			if (hasChain && params.chain) {
				const results: SingleResult[] = [];
				let prev = "";
				for (let i = 0; i < params.chain.length; i++) {
					const step = params.chain[i];
					const taskWithPrev = step.task.replace(/\{previous\}/g, prev);
					const r = await runSync(ctx.cwd, agents, step.agent, taskWithPrev, {
						cwd: step.cwd ?? params.cwd,
						signal,
						runId,
						index: i,
						sessionDir: sessionDirForIndex(i),
						share: shareEnabled,
						artifactsDir: artifactConfig.enabled ? artifactsDir : undefined,
						artifactConfig,
						onUpdate: onUpdate
							? (p) =>
									onUpdate({
										...p,
										details: {
											mode: "chain",
											results: [...results, ...(p.details?.results || [])],
											progress: [...allProgress, ...(p.details?.progress || [])],
										},
									})
							: undefined,
					});
					results.push(r);
					if (r.progress) allProgress.push(r.progress);
					if (r.artifactPaths) allArtifactPaths.push(r.artifactPaths);
					if (r.exitCode !== 0)
						return {
							content: [{ type: "text", text: r.error || "Chain failed" }],
							details: {
								mode: "chain",
								results,
								progress: params.includeProgress ? allProgress : undefined,
								artifacts: allArtifactPaths.length ? { dir: artifactsDir, files: allArtifactPaths } : undefined,
							},
							isError: true,
						};
					prev = getFinalOutput(r.messages);
				}

				let finalOutput = prev;
				let truncationInfo: Details["truncation"];
				if (params.maxOutput) {
					const config = { ...DEFAULT_MAX_OUTPUT, ...params.maxOutput };
					const outputPath = allArtifactPaths[allArtifactPaths.length - 1]?.outputPath;
					const truncResult = truncateOutput(prev, config, outputPath);
					if (truncResult.truncated) {
						finalOutput = truncResult.text;
						truncationInfo = truncResult;
					}
				}

				return {
					content: [{ type: "text", text: finalOutput || "(no output)" }],
					details: {
						mode: "chain",
						results,
						progress: params.includeProgress ? allProgress : undefined,
						artifacts: allArtifactPaths.length ? { dir: artifactsDir, files: allArtifactPaths } : undefined,
						truncation: truncationInfo,
					},
				};
			}

			if (hasTasks && params.tasks) {
				if (params.tasks.length > MAX_PARALLEL)
					return {
						content: [{ type: "text", text: `Max ${MAX_PARALLEL} tasks` }],
						isError: true,
						details: { mode: "single" as const, results: [] },
					};
				const results = await mapConcurrent(params.tasks, MAX_CONCURRENCY, async (t, i) =>
					runSync(ctx.cwd, agents, t.agent, t.task, {
						cwd: t.cwd ?? params.cwd,
						signal,
						runId,
						index: i,
						sessionDir: sessionDirForIndex(i),
						share: shareEnabled,
						artifactsDir: artifactConfig.enabled ? artifactsDir : undefined,
						artifactConfig,
						maxOutput: params.maxOutput,
					}),
				);

				for (const r of results) {
					if (r.progress) allProgress.push(r.progress);
					if (r.artifactPaths) allArtifactPaths.push(r.artifactPaths);
				}

				const ok = results.filter((r) => r.exitCode === 0).length;
				const downgradeNote = parallelDowngraded ? " (async not supported for parallel)" : "";
				return {
					content: [{ type: "text", text: `${ok}/${results.length} succeeded${downgradeNote}` }],
					details: {
						mode: "parallel",
						results,
						progress: params.includeProgress ? allProgress : undefined,
						artifacts: allArtifactPaths.length ? { dir: artifactsDir, files: allArtifactPaths } : undefined,
					},
				};
			}

			if (hasSingle) {
				const r = await runSync(ctx.cwd, agents, params.agent!, params.task!, {
					cwd: params.cwd,
					signal,
					runId,
					sessionDir: sessionDirForIndex(0),
					share: shareEnabled,
					artifactsDir: artifactConfig.enabled ? artifactsDir : undefined,
					artifactConfig,
					maxOutput: params.maxOutput,
					onUpdate,
				});

				if (r.progress) allProgress.push(r.progress);
				if (r.artifactPaths) allArtifactPaths.push(r.artifactPaths);

				const output = r.truncation?.text || getFinalOutput(r.messages);

				if (r.exitCode !== 0)
					return {
						content: [{ type: "text", text: r.error || "Failed" }],
						details: {
							mode: "single",
							results: [r],
							progress: params.includeProgress ? allProgress : undefined,
							artifacts: allArtifactPaths.length ? { dir: artifactsDir, files: allArtifactPaths } : undefined,
							truncation: r.truncation,
						},
						isError: true,
					};
				return {
					content: [{ type: "text", text: output || "(no output)" }],
					details: {
						mode: "single",
						results: [r],
						progress: params.includeProgress ? allProgress : undefined,
						artifacts: allArtifactPaths.length ? { dir: artifactsDir, files: allArtifactPaths } : undefined,
						truncation: r.truncation,
					},
				};
			}

			return {
				content: [{ type: "text", text: "Invalid params" }],
				isError: true,
				details: { mode: "single" as const, results: [] },
			};
		},

		renderCall(args, theme) {
			const isParallel = (args.tasks?.length ?? 0) > 0;
			const asyncLabel = args.async !== false && !isParallel ? theme.fg("warning", " [async]") : "";
			if (args.chain?.length)
				return new Text(
					`${theme.fg("toolTitle", theme.bold("subagent "))}chain (${args.chain.length})${asyncLabel}`,
					0,
					0,
				);
			if (isParallel)
				return new Text(
					`${theme.fg("toolTitle", theme.bold("subagent "))}parallel (${args.tasks!.length})`,
					0,
					0,
				);
			return new Text(
				`${theme.fg("toolTitle", theme.bold("subagent "))}${theme.fg("accent", args.agent || "?")}${asyncLabel}`,
				0,
				0,
			);
		},

		renderResult(result, { expanded }, theme) {
			const d = result.details;
			if (!d || !d.results.length) {
				const t = result.content[0];
				return new Text(t?.type === "text" ? t.text : "(no output)", 0, 0);
			}

			const mdTheme = getMarkdownTheme();

			if (d.mode === "single" && d.results.length === 1) {
				const r = d.results[0];
				const icon = r.exitCode === 0 ? theme.fg("success", "ok") : theme.fg("error", "X");
				const output = r.truncation?.text || getFinalOutput(r.messages);

				const progressInfo = r.progressSummary
					? ` | ${r.progressSummary.toolCount} tools, ${formatTokens(r.progressSummary.tokens)} tokens, ${formatDuration(r.progressSummary.durationMs)}`
					: "";

				if (expanded) {
					const c = new Container();
					c.addChild(new Text(`${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${progressInfo}`, 0, 0));
					c.addChild(new Spacer(1));
					c.addChild(
						new Text(theme.fg("dim", `Task: ${r.task.slice(0, 100)}${r.task.length > 100 ? "..." : ""}`), 0, 0),
					);
					c.addChild(new Spacer(1));

					const items = getDisplayItems(r.messages);
					for (const item of items) {
						if (item.type === "tool")
							c.addChild(new Text(theme.fg("muted", formatToolCall(item.name, item.args)), 0, 0));
					}
					if (items.length) c.addChild(new Spacer(1));

					if (output) c.addChild(new Markdown(output, 0, 0, mdTheme));
					c.addChild(new Spacer(1));
					c.addChild(new Text(theme.fg("dim", formatUsage(r.usage, r.model)), 0, 0));
					if (r.sessionFile) {
						c.addChild(new Text(theme.fg("dim", `Session: ${shortenPath(r.sessionFile)}`), 0, 0));
					}
					if (r.shareUrl) {
						c.addChild(new Text(theme.fg("dim", `Share: ${r.shareUrl}`), 0, 0));
					} else if (r.shareError) {
						c.addChild(new Text(theme.fg("warning", `Share error: ${r.shareError}`), 0, 0));
					}

					if (r.artifactPaths) {
						c.addChild(new Spacer(1));
						c.addChild(new Text(theme.fg("dim", `Artifacts: ${shortenPath(r.artifactPaths.outputPath)}`), 0, 0));
					}
					return c;
				}

				const items = getDisplayItems(r.messages).slice(-COLLAPSED_ITEMS);
				const lines = [`${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${progressInfo}`];
				for (const item of items) {
					if (item.type === "tool") lines.push(theme.fg("muted", formatToolCall(item.name, item.args)));
					else lines.push(item.text.slice(0, 80) + (item.text.length > 80 ? "..." : ""));
				}
				lines.push(theme.fg("dim", formatUsage(r.usage, r.model)));
				return new Text(lines.join("\n"), 0, 0);
			}

			const ok = d.results.filter((r) => r.exitCode === 0).length;
			const icon = ok === d.results.length ? theme.fg("success", "ok") : theme.fg("error", "X");

			const totalSummary =
				d.progressSummary ||
				d.results.reduce(
					(acc, r) => {
						if (r.progressSummary) {
							acc.toolCount += r.progressSummary.toolCount;
							acc.tokens += r.progressSummary.tokens;
							acc.durationMs =
								d.mode === "chain"
									? acc.durationMs + r.progressSummary.durationMs
									: Math.max(acc.durationMs, r.progressSummary.durationMs);
						}
						return acc;
					},
					{ toolCount: 0, tokens: 0, durationMs: 0 },
				);

			const summaryStr =
				totalSummary.toolCount || totalSummary.tokens
					? ` | ${totalSummary.toolCount} tools, ${formatTokens(totalSummary.tokens)} tokens, ${formatDuration(totalSummary.durationMs)}`
					: "";

			const modeLabel = d.mode === "parallel" ? "parallel (no live progress)" : d.mode;

			if (expanded) {
				const c = new Container();
				c.addChild(
					new Text(
						`${icon} ${theme.fg("toolTitle", theme.bold(modeLabel))} ${ok}/${d.results.length}${summaryStr}`,
						0,
						0,
					),
				);
				for (const r of d.results) {
					c.addChild(new Spacer(1));
					const rIcon = r.exitCode === 0 ? theme.fg("success", "ok") : theme.fg("error", "X");
					const rProgress = r.progressSummary
						? ` | ${r.progressSummary.toolCount} tools, ${formatDuration(r.progressSummary.durationMs)}`
						: "";
					c.addChild(new Text(`${rIcon} ${theme.bold(r.agent)}${rProgress}`, 0, 0));
					const out = r.truncation?.text || getFinalOutput(r.messages);
					if (out) c.addChild(new Markdown(out, 0, 0, mdTheme));
					c.addChild(new Text(theme.fg("dim", formatUsage(r.usage, r.model)), 0, 0));
					if (r.sessionFile) {
						c.addChild(new Text(theme.fg("dim", `Session: ${shortenPath(r.sessionFile)}`), 0, 0));
					}
					if (r.shareUrl) {
						c.addChild(new Text(theme.fg("dim", `Share: ${r.shareUrl}`), 0, 0));
					} else if (r.shareError) {
						c.addChild(new Text(theme.fg("warning", `Share error: ${r.shareError}`), 0, 0));
					}
				}

				if (d.artifacts) {
					c.addChild(new Spacer(1));
					c.addChild(new Text(theme.fg("dim", `Artifacts dir: ${shortenPath(d.artifacts.dir)}`), 0, 0));
				}
				return c;
			}

			return new Text(
				`${icon} ${theme.fg("toolTitle", theme.bold(modeLabel))} ${ok}/${d.results.length}${summaryStr}`,
				0,
				0,
			);
		},

	};

	const statusTool: ToolDefinition<typeof StatusParams, Details> = {
		name: "subagent_status",
		label: "Subagent Status",
		description: "Inspect async subagent run status and artifacts",
		parameters: StatusParams,

		async execute(_id, params) {
			let asyncDir: string | null = null;
			let resolvedId = params.id;

			if (params.dir) {
				asyncDir = path.resolve(params.dir);
			} else if (params.id) {
				const direct = path.join(ASYNC_DIR, params.id);
				if (fs.existsSync(direct)) {
					asyncDir = direct;
				} else {
					const match = findByPrefix(ASYNC_DIR, params.id);
					if (match) {
						asyncDir = match;
						resolvedId = path.basename(match);
					}
				}
			}

			const resultPath =
				params.id && !asyncDir ? findByPrefix(RESULTS_DIR, params.id, ".json") : null;

			if (!asyncDir && !resultPath) {
				return {
					content: [{ type: "text", text: "Async run not found. Provide id or dir." }],
					isError: true,
					details: { mode: "single" as const, results: [] },
				};
			}

			if (asyncDir) {
				const status = readStatus(asyncDir);
				const logPath = path.join(asyncDir, `subagent-log-${resolvedId ?? "unknown"}.md`);
				const eventsPath = path.join(asyncDir, "events.jsonl");
				if (status) {
					const stepsTotal = status.steps?.length ?? 1;
					const current = status.currentStep !== undefined ? status.currentStep + 1 : undefined;
					const stepLine =
						current !== undefined ? `Step: ${current}/${stepsTotal}` : `Steps: ${stepsTotal}`;
					const started = new Date(status.startedAt).toISOString();
					const updated = status.lastUpdate ? new Date(status.lastUpdate).toISOString() : "n/a";

					const lines = [
						`Run: ${status.runId}`,
						`State: ${status.state}`,
						`Mode: ${status.mode}`,
						stepLine,
						`Started: ${started}`,
						`Updated: ${updated}`,
						`Dir: ${asyncDir}`,
					];
					if (status.sessionFile) lines.push(`Session: ${status.sessionFile}`);
					if (status.shareUrl) lines.push(`Share: ${status.shareUrl}`);
					if (status.shareError) lines.push(`Share error: ${status.shareError}`);
					if (fs.existsSync(logPath)) lines.push(`Log: ${logPath}`);
					if (fs.existsSync(eventsPath)) lines.push(`Events: ${eventsPath}`);

					return { content: [{ type: "text", text: lines.join("\n") }], details: { mode: "single", results: [] } };
				}
			}

			if (resultPath) {
				try {
					const raw = fs.readFileSync(resultPath, "utf-8");
					const data = JSON.parse(raw) as { id?: string; success?: boolean; summary?: string };
					const status = data.success ? "complete" : "failed";
					const lines = [`Run: ${data.id ?? params.id}`, `State: ${status}`, `Result: ${resultPath}`];
					if (data.summary) lines.push("", data.summary);
					return { content: [{ type: "text", text: lines.join("\n") }], details: { mode: "single", results: [] } };
				} catch {}
			}

			return {
				content: [{ type: "text", text: "Status file not found." }],
				isError: true,
				details: { mode: "single" as const, results: [] },
			};
		},
	};

	pi.registerTool(tool);
	pi.registerTool(statusTool);

	pi.events.on("subagent:started", (data) => {
		const info = data as {
			id?: string;
			asyncDir?: string;
			agent?: string;
			chain?: string[];
		};
		if (!info.id) return;
		const asyncDir = info.asyncDir ?? path.join(ASYNC_DIR, info.id);
		const agents = info.chain && info.chain.length > 0 ? info.chain : info.agent ? [info.agent] : undefined;
		asyncJobs.set(info.id, {
			asyncId: info.id,
			asyncDir,
			status: "queued",
			mode: info.chain ? "chain" : "single",
			agents,
			stepsTotal: agents?.length,
			startedAt: Date.now(),
		});
		if (lastUiContext) {
			renderWidget(lastUiContext, Array.from(asyncJobs.values()));
			ensurePoller();
		}
	});

	pi.events.on("subagent:complete", (data) => {
		const result = data as { id?: string; success?: boolean; asyncDir?: string };
		const asyncId = result.id;
		if (!asyncId) return;
		const job = asyncJobs.get(asyncId);
		if (job) {
			job.status = result.success ? "complete" : "failed";
			job.updatedAt = Date.now();
			if (result.asyncDir) job.asyncDir = result.asyncDir;
		}
		if (lastUiContext) {
			renderWidget(lastUiContext, Array.from(asyncJobs.values()));
		}
		setTimeout(() => {
			asyncJobs.delete(asyncId);
			if (lastUiContext) renderWidget(lastUiContext, Array.from(asyncJobs.values()));
		}, 10000);
	});

	pi.on("tool_result", (event, ctx) => {
		if (event.toolName !== "subagent") return;
		if (!ctx.hasUI) return;
		lastUiContext = ctx;
		if (asyncJobs.size > 0) {
			renderWidget(ctx, Array.from(asyncJobs.values()));
			ensurePoller();
		}
	});

	pi.on("session_start", (_event, ctx) => {
		baseCwd = ctx.cwd;
	});
	pi.on("session_switch", (_event, ctx) => {
		baseCwd = ctx.cwd;
	});
	pi.on("session_shutdown", () => {
		watcher.close();
		if (poller) clearInterval(poller);
		poller = null;
		asyncJobs.clear();
		if (lastUiContext?.hasUI) {
			lastUiContext.ui.setWidget(WIDGET_KEY, undefined);
		}
	});
}
