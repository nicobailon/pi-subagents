import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Message, Usage as PiUsage } from "@earendil-works/pi-ai";
import { previewDisplayText, sanitizeDisplayText, truncateDisplayText } from "./display-text.ts";
import { formatToolCall } from "./formatters.ts";
import type { AgentProgress, AsyncStatus, Details, DisplayItem, ErrorInfo, NestedRunSummary, SingleResult, ToolCallSummary, Usage } from "./types.ts";
import { validateAsyncStatusLaneMetadata } from "../runs/shared/lane-metadata.ts";

const DEFAULT_CONFIG_DIR_NAME = ".pi";
const PI_CODING_AGENT_PACKAGE_NAME = "@earendil-works/pi-coding-agent";
export const PI_CODING_AGENT_PACKAGE_ROOT_ENV = "PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT";
export const PROMPT_REDACTED = "[prompt redacted]";

export function resolveWatchPath(
	watchPath: string,
	nativeRealpath: (filePath: string) => string = fs.realpathSync.native,
): string {
	// libuv's Windows watcher cannot mix 8.3 registration paths with long event paths.
	try {
		return nativeRealpath(watchPath);
	} catch {
		return watchPath;
	}
}

function validConfigDirName(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined;
}

function readConfigDirNameFromPackageRoot(packageRoot: string | undefined): string | undefined {
	if (!packageRoot) return undefined;
	try {
		const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf-8")) as {
			name?: unknown;
			piConfig?: { configDir?: unknown };
		};
		if (pkg.name !== PI_CODING_AGENT_PACKAGE_NAME) return undefined;
		return validConfigDirName(pkg.piConfig?.configDir);
	} catch {
		return undefined;
	}
}

function resolveConfigDirNameFromPackageJson(entryPoint = process.argv[1], packageRoot = process.env[PI_CODING_AGENT_PACKAGE_ROOT_ENV]): string | undefined {
	const packageRootValue = readConfigDirNameFromPackageRoot(packageRoot);
	if (packageRootValue) return packageRootValue;
	if (!entryPoint) return undefined;
	try {
		let dir = path.dirname(fs.realpathSync(entryPoint));
		while (dir !== path.dirname(dir)) {
			const value = readConfigDirNameFromPackageRoot(dir);
			if (value) return value;
			dir = path.dirname(dir);
		}
	} catch {
		// Package metadata lookup is best-effort; detached runners must not fail here.
	}
	return undefined;
}

export function resolveConfigDirName(codingAgentModule?: unknown, entryPoint?: string, packageRoot?: string): string {
	const moduleValue = codingAgentModule && typeof codingAgentModule === "object"
		? validConfigDirName((codingAgentModule as { CONFIG_DIR_NAME?: unknown }).CONFIG_DIR_NAME)
		: undefined;
	return moduleValue
		?? resolveConfigDirNameFromPackageJson(entryPoint, packageRoot)
		?? DEFAULT_CONFIG_DIR_NAME;
}

let cachedConfigDirName: { entryPoint: string | undefined; packageRoot: string | undefined; value: string } | undefined;

export function getConfigDirName(): string {
	const entryPoint = process.argv[1];
	const packageRoot = process.env[PI_CODING_AGENT_PACKAGE_ROOT_ENV];
	if (cachedConfigDirName
		&& cachedConfigDirName.entryPoint === entryPoint
		&& cachedConfigDirName.packageRoot === packageRoot) {
		return cachedConfigDirName.value;
	}
	const value = resolveConfigDirName(undefined, entryPoint, packageRoot);
	cachedConfigDirName = { entryPoint, packageRoot, value };
	return value;
}

export function getProjectConfigDir(projectRoot: string): string {
	return path.join(projectRoot, getConfigDirName());
}

export function getAgentDir(): string {
	const configured = process.env.PI_CODING_AGENT_DIR;
	const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
	if (configured === "~") return home;
	if (configured?.startsWith("~/") || configured?.startsWith("~\\")) return path.join(home, configured.slice(2));
	return configured || path.join(home, getConfigDirName(), "agent");
}

const statusCache = new Map<string, { mtime: number; ctime: number; size: number; ino: number; status: AsyncStatus }>();
const MAX_STATUS_CACHE_ENTRIES = 512;

export function pruneStatusCacheForAsyncRoot(asyncDirRoot: string, runIds: Iterable<string>): number {
	const root = path.resolve(asyncDirRoot);
	const currentStatusPaths = new Set(
		Array.from(runIds, (runId) => path.resolve(root, runId, "status.json")),
	);
	let removed = 0;
	for (const statusPath of statusCache.keys()) {
		const resolved = path.resolve(statusPath);
		const relative = path.relative(root, resolved);
		if (relative && !relative.startsWith("..") && !path.isAbsolute(relative) && !currentStatusPaths.has(resolved)) {
			statusCache.delete(statusPath);
			removed++;
		}
	}
	return removed;
}

function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function resolveChildCwd(baseCwd: string, childCwd: string | undefined): string {
	if (!childCwd) return baseCwd;
	return path.isAbsolute(childCwd) ? childCwd : path.resolve(baseCwd, childCwd);
}

function isNotFoundError(error: unknown): boolean {
	return typeof error === "object"
		&& error !== null
		&& "code" in error
		&& (error as NodeJS.ErrnoException).code === "ENOENT";
}

/**
 * Read async job status from disk (with mtime-based caching)
 */
export function readStatus(asyncDir: string): AsyncStatus | null {
	if (Buffer.byteLength(path.basename(asyncDir), "utf-8") > 255) {
		return null;
	}
	const statusPath = path.join(asyncDir, "status.json");

	let stat: fs.Stats;
	try {
		stat = fs.statSync(statusPath);
	} catch (error) {
		if (isNotFoundError(error)) {
			statusCache.delete(statusPath);
			return null;
		}
		throw new Error(`Failed to inspect async status file '${statusPath}': ${getErrorMessage(error)}`, {
			cause: error instanceof Error ? error : undefined,
		});
	}

	const cached = statusCache.get(statusPath);
	if (
		cached
		&& cached.mtime === stat.mtimeMs
		&& cached.ctime === stat.ctimeMs
		&& cached.size === stat.size
		&& cached.ino === stat.ino
	) {
		statusCache.delete(statusPath);
		statusCache.set(statusPath, cached);
		return cached.status;
	}

	let content: string;
	try {
		content = fs.readFileSync(statusPath, "utf-8");
	} catch (error) {
		if (isNotFoundError(error)) {
			statusCache.delete(statusPath);
			return null;
		}
		throw new Error(`Failed to read async status file '${statusPath}': ${getErrorMessage(error)}`, {
			cause: error instanceof Error ? error : undefined,
		});
	}

	let status: AsyncStatus;
	try {
		status = JSON.parse(content) as AsyncStatus;
	} catch (error) {
		throw new Error(`Failed to parse async status file '${statusPath}': ${getErrorMessage(error)}`, {
			cause: error instanceof Error ? error : undefined,
		});
	}
	try {
		validateAsyncStatusLaneMetadata(status, `Invalid async status '${statusPath}'`);
	} catch (error) {
		throw new Error(`Failed to validate async status file '${statusPath}': ${getErrorMessage(error)}`, {
			cause: error instanceof Error ? error : undefined,
		});
	}

	statusCache.set(statusPath, {
		mtime: stat.mtimeMs,
		ctime: stat.ctimeMs,
		size: stat.size,
		ino: stat.ino,
		status,
	});
	while (statusCache.size > MAX_STATUS_CACHE_ENTRIES) {
		const oldest = statusCache.keys().next().value as string | undefined;
		if (oldest === undefined) break;
		statusCache.delete(oldest);
	}
	return status;
}

export function getLastActivity(outputFile: string | undefined): string {
	if (!outputFile) return "";
	try {
		const stat = fs.statSync(outputFile);
		const ago = Date.now() - stat.mtimeMs;
		if (ago < 1000) return "active now";
		if (ago < 60000) return `active ${Math.floor(ago / 1000)}s ago`;
		return `active ${Math.floor(ago / 60000)}m ago`;
	} catch {
		// Last-activity text is best effort; missing files should omit the hint.
		return "";
	}
}

export function findLatestSessionFile(sessionDir: string): string | null {
	if (!fs.existsSync(sessionDir)) return null;
	const files = fs.readdirSync(sessionDir)
		.filter((f) => f.endsWith(".jsonl"))
		.map((f) => {
			const filePath = path.join(sessionDir, f);
			return {
				path: filePath,
				mtime: fs.statSync(filePath).mtimeMs,
			};
		})
		.sort((a, b) => b.mtime - a.mtime);
	const latest = files[0];
	return latest ? latest.path : null;
}

const PI_TURN_TIMING_FOOTER = /(?:\r?\n)*\x1b\[38;2;136;136;136m✻ Turn took [^()\r\n]+ \(Total time [^·\r\n]+ · \d+ turns?\)\x1b\[0m[ \t]*$/u;

function stripPiTurnTimingFooter(text: string): string {
	return text.replace(PI_TURN_TIMING_FOOTER, "");
}

export function getFinalOutput(messages: Message[]): string {
	const validTextParts: string[] = [];
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (!msg || msg.role !== "assistant") continue;
		const hasAssistantError = ("errorMessage" in msg && typeof msg.errorMessage === "string" && msg.errorMessage.length > 0)
			|| ("stopReason" in msg && msg.stopReason === "error");
		if (hasAssistantError) continue;
		const messageText = msg.content
			.flatMap((part) => {
				if (part.type !== "text") return [];
				const text = stripPiTurnTimingFooter(part.text);
				return text.trim().length > 0 ? [text] : [];
			})
			.join("\n");
		for (let j = msg.content.length - 1; j >= 0; j--) {
			const part = msg.content[j];
			if (!part || part.type !== "text") continue;
			const text = stripPiTurnTimingFooter(part.text);
			if (text.trim().length === 0) continue;
			validTextParts.push(text);
			if (/```acceptance[-_]report\s*\n[\s\S]*?```/i.test(text)) return messageText;
			for (const match of text.matchAll(/```(?:json|jsonc|json5)\s*\n([\s\S]*?)```/gi)) {
				const body = match[1] ?? "";
				if (/"(?:criteriaSatisfied|criteria_satisfied)"/.test(body) && /"(?:changedFiles|changed_files|testsAddedOrUpdated|tests_added_or_updated|commandsRun|commands_run|validationOutput|validation_output|residualRisks|residual_risks|noStagedFiles|no_staged_files|diffSummary|diff_summary|reviewFindings|review_findings|manualNotes|manual_notes)"/.test(body)) {
					return messageText;
				}
			}
			if (/ACCEPTANCE_REPORT\s*:/i.test(text)) return messageText;
		}
	}
	return validTextParts[0] ?? "";
}

export function getSingleResultOutput(result: Pick<SingleResult, "finalOutput" | "messages">): string {
	return result.finalOutput ?? getFinalOutput(result.messages ?? []);
}

/**
 * Extract display items (text and tool calls) from messages
 */
export function getDisplayItems(messages: Message[] | undefined): DisplayItem[] {
	if (!messages || messages.length === 0) return [];
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

function compactCompletedProgress(progress: AgentProgress): AgentProgress {
	if (progress.status === "running") return progress;
	return {
		index: progress.index,
		agent: progress.agent,
		...(progress.sessionName ? { sessionName: progress.sessionName } : {}),
		status: progress.status,
		activityState: progress.activityState,
		task: "[prompt redacted]",
		skills: progress.skills,
		toolCount: progress.toolCount,
		tokens: progress.tokens,
		durationMs: progress.durationMs,
		error: progress.error,
		failedTool: progress.failedTool,
		recentTools: [],
		recentOutput: [],
	};
}

function extractToolCallSummaries(messages: Message[] | undefined): ToolCallSummary[] {
	if (!messages?.length) return [];
	const summaries: ToolCallSummary[] = [];
	for (const msg of messages) {
		if (msg.role !== "assistant") continue;
		for (const part of msg.content) {
			if (part.type !== "toolCall") continue;
			const args = typeof part.arguments === "object" && part.arguments !== null && !Array.isArray(part.arguments)
				? part.arguments
				: {};
			summaries.push({
				text: formatToolCall(part.name, args),
				expandedText: formatToolCall(part.name, args, true),
			});
		}
	}
	return summaries;
}

export function sumResultsUsage(results: SingleResult[]): Usage {
	const usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
	for (const result of results) {
		usage.input += result.usage.input;
		usage.output += result.usage.output;
		usage.cacheRead += result.usage.cacheRead;
		usage.cacheWrite += result.usage.cacheWrite;
		usage.cost += result.usage.cost;
		usage.turns += result.usage.turns;
	}
	return usage;
}

export function toAgentToolUsage(usage: Usage): PiUsage {
	return {
		input: usage.input,
		output: usage.output,
		cacheRead: usage.cacheRead,
		cacheWrite: usage.cacheWrite,
		totalTokens: usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: usage.cost },
	};
}

function addNestedCost(total: NonNullable<Details["totalCost"]>, children: NestedRunSummary[] | undefined): void {
	for (const child of children ?? []) {
		if (child.totalCost) {
			total.inputTokens += child.totalCost.inputTokens;
			total.outputTokens += child.totalCost.outputTokens;
			total.costUsd += child.totalCost.costUsd;
			continue;
		}
		addNestedCost(total, child.children);
		for (const step of child.steps ?? []) addNestedCost(total, step.children);
	}
}

/** Sum input tokens, output tokens, and cost across a set of SingleResults. */
export function sumResultsCost(results: SingleResult[]): NonNullable<Details["totalCost"]> {
	const total = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
	for (const result of results) {
		total.inputTokens += result.usage.input;
		total.outputTokens += result.usage.output;
		total.costUsd += result.usage.cost;
		addNestedCost(total, result.children);
	}
	return total;
}

export function compactForegroundResult(result: SingleResult): SingleResult {
	if (result.progress?.status === "running") return result;
	const toolCalls = result.toolCalls?.length ? result.toolCalls : extractToolCallSummaries(result.messages);
	return {
		...result,
		task: "[prompt redacted]",
		messages: undefined,
		progress: undefined,
		toolCalls: toolCalls.length ? toolCalls : undefined,
	};
}

export function compactForegroundDetails(details: Details): Details {
	return {
		...details,
		results: details.results.map(compactForegroundResult),
		progress: details.progress
			? details.progress.map(compactCompletedProgress)
			: undefined,
	};
}

/**
 * Streaming counterparts to compactForegroundResult / compactCompletedProgress.
 *
 * The completed-compaction helpers above bail out while a child is still
 * `running`, so a long or deeply nested fan-out streams full, unbounded progress on
 * every tick. The parent records every streamed `tool_execution_update` in its
 * transcript and `events.jsonl`, so an unbounded running snapshot grows those
 * artifacts and the live display state without bound.
 *
 * These bound the STREAMED snapshot only. The final returned result keeps the full
 * live progress and message transcript, and every live-display consumer already
 * reads just the last few entries (`recentTools.slice(-3)`, `recentOutput.slice(-5)`).
 */
export const MAX_STREAMED_RECENT_TOOLS = 32;
export const MAX_STREAMED_TOOL_CALLS = 64;
export const MAX_STREAMED_OUTPUT_LINE_CHARS = 2000;

/** Keep only the most recent tool-history entries in a streamed snapshot. */
export function boundStreamedRecentTools(recentTools: AgentProgress["recentTools"]): AgentProgress["recentTools"] {
	return recentTools.slice(-MAX_STREAMED_RECENT_TOOLS).map((tool) => ({ ...tool }));
}

/** Cap per-line length of recent output so one long line can't inflate a snapshot. */
export function boundStreamedRecentOutput(recentOutput: string[]): string[] {
	return recentOutput.map((line) =>
		line.length > MAX_STREAMED_OUTPUT_LINE_CHARS
			? `${line.slice(0, MAX_STREAMED_OUTPUT_LINE_CHARS)}… [truncated]`
			: line,
	);
}

/**
 * Compact tool-call summaries for a streamed snapshot, standing in for the
 * unbounded `messages` transcript. Prefers an existing `toolCalls` summary, else
 * derives one from `messages`; bounded to the most recent calls.
 */
export function boundStreamedToolCalls(result: Pick<SingleResult, "toolCalls" | "messages">): ToolCallSummary[] | undefined {
	const summaries = result.toolCalls?.length ? result.toolCalls : extractToolCallSummaries(result.messages);
	if (!summaries.length) return undefined;
	return summaries.slice(-MAX_STREAMED_TOOL_CALLS).map((summary) => ({ ...summary }));
}

export function hasEmptyTerminalAssistantResponse(messages: Message[]): boolean {
	const lastAssistant = messages.findLast((message) => message.role === "assistant");
	return lastAssistant?.role === "assistant"
		&& Array.isArray(lastAssistant.content)
		&& ((lastAssistant.content.length === 0 && lastAssistant.usage.output === 0)
			|| (messages.at(-1) === lastAssistant
				&& lastAssistant.stopReason === "stop"
				&& !lastAssistant.errorMessage
				&& lastAssistant.content.length > 0
				// Token accounting can be nonzero even when no response text was emitted.
				&& lastAssistant.content.every((part) => part.type === "text" && part.text === "")));
}

export function formatEmptyTerminalAssistantResponseError(messages: Message[]): string {
	const lastAssistant = messages.findLast((message) => message.role === "assistant");
	const errorMessage = lastAssistant && "errorMessage" in lastAssistant && typeof lastAssistant.errorMessage === "string" && lastAssistant.errorMessage.trim()
		? lastAssistant.errorMessage.trim()
		: undefined;
	if (errorMessage) return errorMessage;
	const stopReason = lastAssistant && "stopReason" in lastAssistant && typeof lastAssistant.stopReason === "string" && lastAssistant.stopReason.trim()
		? lastAssistant.stopReason.trim()
		: undefined;
	return stopReason && stopReason !== "stop"
		? `Subagent produced no output after terminal assistant stopReason "${stopReason}".`
		: "Subagent produced no output (possible model cold-start or empty response).";
}

/**
 * Detect errors in subagent execution from messages (only errors with no subsequent success)
 */
export function detectSubagentError(messages: Message[]): ErrorInfo {
	let lastAssistantTextIndex = -1;
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg?.role === "assistant") {
			const hasText = Array.isArray(msg.content) && msg.content.some(
				(c) => c.type === "text" && "text" in c && typeof c.text === "string" && c.text.trim().length > 0,
			);
			if (hasText) {
				lastAssistantTextIndex = i;
				break;
			}
		}
	}

	const scanStart = lastAssistantTextIndex >= 0 ? lastAssistantTextIndex + 1 : 0;

	for (let i = messages.length - 1; i >= scanStart; i--) {
		const msg = messages[i];
		if (!msg || msg.role !== "toolResult") continue;
		const toolName = "toolName" in msg && typeof msg.toolName === "string" ? msg.toolName : undefined;
		const isError = "isError" in msg && msg.isError === true;

		if (!isError) continue;

		const text = msg.content.find((c) => c.type === "text");
		const details = text && "text" in text ? text.text : undefined;
		const exitMatch = details?.match(/exit(?:ed)?\s*(?:with\s*)?(?:code|status)?\s*[:\s]?\s*(\d+)/i);
		const exitCodeText = exitMatch?.[1];
		return {
			hasError: true,
			exitCode: exitCodeText ? parseInt(exitCodeText, 10) : 1,
			errorType: toolName || "tool",
			details: details?.slice(0, 200),
		};
	}

	return { hasError: false };
}

/**
 * Extract a preview of tool arguments for display
 */
export function extractToolArgsPreview(args: Record<string, unknown>): string {
	const stringifyPreviewValue = (value: unknown): string | undefined => {
		if (typeof value === "string" && value.trim().length > 0) return sanitizeDisplayText(value);
		if (typeof value === "number" || typeof value === "boolean") return String(value);
		return undefined;
	};

	const previewArray = (value: unknown): string | undefined => {
		if (!Array.isArray(value) || value.length === 0) return undefined;
		const first = stringifyPreviewValue(value[0]);
		if (!first) return undefined;
		const suffix = value.length > 1 ? ` (+${value.length - 1} more)` : "";
		return `${first}${suffix}`;
	};

	if (typeof args.tool === "string") {
		const server = typeof args.server === "string" ? `${sanitizeDisplayText(args.server)}/` : "";
		const toolArgs = typeof args.args === "string" ? ` ${truncateDisplayText(sanitizeDisplayText(args.args), 40)}` : "";
		return sanitizeDisplayText(`${server}${args.tool}${toolArgs}`);
	}

	const queriesPreview = previewArray(args.queries);
	if (queriesPreview) return previewDisplayText(queriesPreview, 60);
	if (typeof args.query === "string" && args.query.trim().length > 0) return previewDisplayText(args.query, 60);
	if (typeof args.workflow === "string" && args.workflow.trim().length > 0) return `workflow=${previewDisplayText(args.workflow, 48)}`;

	if (typeof args.url === "string" && args.url.trim().length > 0) return previewDisplayText(args.url, 60);
	const urlsPreview = previewArray(args.urls);
	if (urlsPreview) return previewDisplayText(urlsPreview, 60);
	if (typeof args.prompt === "string" && args.prompt.trim().length > 0) return previewDisplayText(args.prompt, 60);

	const previewKeys = ["command", "path", "file_path", "pattern", "query", "url", "task", "describe", "search"];
	for (const key of previewKeys) {
		if (typeof args[key] === "string") return previewDisplayText(args[key], 60);
	}

	for (const [key, value] of Object.entries(args)) {
		const displayKey = sanitizeDisplayText(key);
		const arrayPreview = previewArray(value);
		if (arrayPreview) return `${displayKey}=${previewDisplayText(arrayPreview, 50)}`;
		if (typeof value === "string" && value.length > 0) return `${displayKey}=${previewDisplayText(value, 50)}`;
	}
	return "";
}

/**
 * Extract text content from various message content formats
 */
export function extractTextFromContent(content: unknown): string {
	if (!content) return "";
	// Handle string content directly
	if (typeof content === "string") return content;
	// Handle array content
	if (!Array.isArray(content)) return "";
	const texts: string[] = [];
	for (const part of content) {
		if (part && typeof part === "object") {
			// Handle { type: "text", text: "..." }
			if ("type" in part && part.type === "text" && "text" in part) {
				texts.push(String(part.text));
			}
			// Handle { type: "tool_result", content: "..." }
			else if ("type" in part && part.type === "tool_result" && "content" in part) {
				const inner = extractTextFromContent(part.content);
				if (inner) texts.push(inner);
			}
			// Handle { text: "..." } without type
			else if ("text" in part) {
				texts.push(String(part.text));
			}
		}
	}
	return texts.join("\n");
}

// ============================================================================
// Concurrency Utilities
// ============================================================================

export { mapConcurrent } from "../runs/shared/parallel-utils.ts";
