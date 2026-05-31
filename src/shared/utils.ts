/**
 * General utility functions for the subagent extension
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import { formatToolCall } from "./formatters.ts";
import type { AgentProgress, AsyncStatus, Details, DisplayItem, ErrorInfo, SingleResult, ToolCallSummary } from "./types.ts";

// ============================================================================
// File System Utilities
// ============================================================================

export function getAgentDir(): string {
	const configured = process.env.PI_CODING_AGENT_DIR;
	if (configured === "~") return os.homedir();
	if (configured?.startsWith("~/")) return path.join(os.homedir(), configured.slice(2));
	return configured || path.join(os.homedir(), ".pi", "agent");
}

const statusCache = new Map<string, { mtime: number; status: AsyncStatus }>();

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
	const statusPath = path.join(asyncDir, "status.json");

	let stat: fs.Stats;
	try {
		stat = fs.statSync(statusPath);
	} catch (error) {
		if (isNotFoundError(error)) return null;
		throw new Error(`Failed to inspect async status file '${statusPath}': ${getErrorMessage(error)}`, {
			cause: error instanceof Error ? error : undefined,
		});
	}

	const cached = statusCache.get(statusPath);
	if (cached && cached.mtime === stat.mtimeMs) {
		return cached.status;
	}

	let content: string;
	try {
		content = fs.readFileSync(statusPath, "utf-8");
	} catch (error) {
		if (isNotFoundError(error)) return null;
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

	statusCache.set(statusPath, { mtime: stat.mtimeMs, status });
	if (statusCache.size > 50) {
		const firstKey = statusCache.keys().next().value;
		if (firstKey) statusCache.delete(firstKey);
	}
	return status;
}

const outputTailCache = new Map<string, { mtime: number; size: number; lines: string[] }>();

/**
 * Get the last N lines from an output file (with mtime/size-based caching)
 */
function getOutputTail(outputFile: string | undefined, maxLines: number = 3): string[] {
	if (!outputFile) return [];
	let fd: number | null = null;
	try {
		const stat = fs.statSync(outputFile);
		if (stat.size === 0) return [];

		const cached = outputTailCache.get(outputFile);
		if (cached && cached.mtime === stat.mtimeMs && cached.size === stat.size) {
			return cached.lines;
		}

		const tailBytes = 4096;
		const start = Math.max(0, stat.size - tailBytes);
		fd = fs.openSync(outputFile, "r");
		const buffer = Buffer.alloc(Math.min(tailBytes, stat.size));
		fs.readSync(fd, buffer, 0, buffer.length, start);
		const content = buffer.toString("utf-8");
		const allLines = content.split("\n").filter((l) => l.trim());
		const lines = allLines.slice(-maxLines).map((l) => l.slice(0, 120) + (l.length > 120 ? "..." : ""));

		outputTailCache.set(outputFile, { mtime: stat.mtimeMs, size: stat.size, lines });
		if (outputTailCache.size > 20) {
			const firstKey = outputTailCache.keys().next().value;
			if (firstKey) outputTailCache.delete(firstKey);
		}

		return lines;
	} catch {
		// Output tails are UI-only hints; unreadable or missing files should render as no tail.
		return [];
	} finally {
		if (fd !== null) {
			try {
				fs.closeSync(fd);
			} catch {
				// Closing the best-effort tail file handle should not surface over the main status view.
			}
		}
	}
}

/**
 * Get human-readable last activity time for a file
 */
	export function getLastActivity(outputFile: string | undefined): string {
	if (!outputFile) return "";
	try {
		const stat = fs.statSync(outputFile);
		const ago = Date.now() - stat.mtimeMs;
		if (ago < 1000) return "active now";
		if (ago < 60000) return `active ${Math.floor(ago / 1000)}s ago`;
		return `active ${Math.floor(ago / 60000)}m ago`;
	} catch {
		// Last-activity text is best effort; missing files should simply omit the hint.
		return "";
	}
}

/**
 * Find the latest session file in a directory
 */
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
	return files.length > 0 ? files[0].path : null;
}

/**
 * Write a prompt to a temporary file
 */
function writePrompt(agent: string, prompt: string): { dir: string; path: string } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-"));
	const p = path.join(dir, `${agent.replace(/[^\w.-]/g, "_")}.md`);
	fs.writeFileSync(p, prompt, { mode: 0o600 });
	return { dir, path: p };
}

// ============================================================================
// Message Parsing Utilities
// ============================================================================

/**
 * Get the final text output from a list of messages
 */
export function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			const hasAssistantError = ("errorMessage" in msg && typeof msg.errorMessage === "string" && msg.errorMessage.length > 0)
				|| ("stopReason" in msg && msg.stopReason === "error");
			if (hasAssistantError) continue;
			for (let j = msg.content.length - 1; j >= 0; j--) {
				const part = msg.content[j];
				if (part.type === "text" && part.text.trim().length > 0) return part.text;
			}
		}
	}
	return "";
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
		status: progress.status,
		activityState: progress.activityState,
		task: progress.task,
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

export function compactForegroundResult(result: SingleResult): SingleResult {
	if (result.progress?.status === "running") return result;
	const toolCalls = result.toolCalls?.length ? result.toolCalls : extractToolCallSummaries(result.messages);
	return {
		...result,
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
 * Detect errors in subagent execution from messages (only errors with no subsequent success)
 */
export function detectSubagentError(messages: Message[]): ErrorInfo {
	let lastAssistantTextIndex = -1;
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
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
		if (msg.role !== "toolResult") continue;
		const toolName = "toolName" in msg && typeof msg.toolName === "string" ? msg.toolName : undefined;
		const isError = "isError" in msg && msg.isError === true;

		if (isError) {
			const text = msg.content.find((c) => c.type === "text");
			const details = text && "text" in text ? text.text : undefined;
			const exitMatch = details?.match(/exit(?:ed)?\s*(?:with\s*)?(?:code|status)?\s*[:\s]?\s*(\d+)/i);
			return {
				hasError: true,
				exitCode: exitMatch ? parseInt(exitMatch[1], 10) : 1,
				errorType: toolName || "tool",
				details: details?.slice(0, 200),
			};
		}

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

		// NOTE: These patterns can match legitimate output (grep results, logs,
		// testing). With the assistant-message check above, most false positives
		// are mitigated since the agent will have responded after routine errors.
		const fatalPatterns = [
			/command not found/i,
			/permission denied/i,
			/no such file or directory/i,
			/segmentation fault/i,
			/killed|terminated/i,
			/out of memory/i,
			/connection refused/i,
			/timeout/i,
		];
		for (const pattern of fatalPatterns) {
			if (pattern.test(output)) {
				return { hasError: true, exitCode: 1, errorType: "bash", details: output.slice(0, 200) };
			}
		}
	}

	return { hasError: false };
}

/**
 * Extract a preview of tool arguments for display
 */
export function extractToolArgsPreview(args: Record<string, unknown>): string {
	const truncatePreview = (value: string, maxLength: number): string =>
		value.length > maxLength ? `${value.slice(0, maxLength - 3)}...` : value;

	const stringifyPreviewValue = (value: unknown): string | undefined => {
		if (typeof value === "string" && value.trim().length > 0) return value;
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

	// Handle MCP tool calls - show server/tool info
	if (args.tool && typeof args.tool === "string") {
		const server = args.server && typeof args.server === "string" ? `${args.server}/` : "";
		const toolArgs = args.args && typeof args.args === "string" ? ` ${args.args.slice(0, 40)}` : "";
		return `${server}${args.tool}${toolArgs}`;
	}

	const queriesPreview = previewArray(args.queries);
	if (queriesPreview) return truncatePreview(queriesPreview, 60);
	if (typeof args.query === "string" && args.query.trim().length > 0) return truncatePreview(args.query, 60);
	if (typeof args.workflow === "string" && args.workflow.trim().length > 0) return `workflow=${truncatePreview(args.workflow, 48)}`;

	if (typeof args.url === "string" && args.url.trim().length > 0) return truncatePreview(args.url, 60);
	const urlsPreview = previewArray(args.urls);
	if (urlsPreview) return truncatePreview(urlsPreview, 60);
	if (typeof args.prompt === "string" && args.prompt.trim().length > 0) return truncatePreview(args.prompt, 60);
	
	const previewKeys = ["command", "path", "file_path", "pattern", "query", "url", "task", "describe", "search"];
	for (const key of previewKeys) {
		if (args[key] && typeof args[key] === "string") {
			const value = args[key] as string;
			return truncatePreview(value, 60);
		}
	}
	
	// Fallback: show first string value found
	for (const [key, value] of Object.entries(args)) {
		const arrayPreview = previewArray(value);
		if (arrayPreview) return `${key}=${truncatePreview(arrayPreview, 50)}`;
		if (typeof value === "string" && value.length > 0) {
			const preview = truncatePreview(value, 50);
			return `${key}=${preview}`;
		}
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
