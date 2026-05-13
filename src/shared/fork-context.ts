import * as fs from "node:fs";
import { SessionManager } from "@earendil-works/pi-coding-agent";

const VALID_TOOL_ID = /^[a-zA-Z0-9_-]+$/;

function sanitizeForkedSession(sessionFile: string): void {
	const lines = fs.readFileSync(sessionFile, "utf-8").split("\n");
	const mapping = new Map<string, string>();
	const seen = new Set<string>();

	function getSanitized(id: string): string {
		if (VALID_TOOL_ID.test(id)) return id;
		if (mapping.has(id)) return mapping.get(id)!;
		let sanitized = id.replace(/[^a-zA-Z0-9_-]/g, "_");
		let counter = 1;
		const base = sanitized;
		while (seen.has(sanitized)) {
			sanitized = `${base}_${counter++}`;
		}
		seen.add(sanitized);
		mapping.set(id, sanitized);
		return sanitized;
	}

	function sanitizeValue(value: unknown): unknown {
		if (Array.isArray(value)) {
			return value.map(sanitizeValue);
		}
		if (value && typeof value === "object") {
			const result: Record<string, unknown> = {};
			for (const [key, val] of Object.entries(value)) {
				if (
					key === "toolCallId" ||
					key === "tool_use_id" ||
					(key === "id" && typeof val === "string" && !VALID_TOOL_ID.test(val))
				) {
					result[key] = getSanitized(val);
				} else if (key === "thinkingSignature") {
					// Strip thinkingSignature — Pi maps this to `signature` in the Anthropic
					// API payload, but the value (e.g. "reasoning") is not a valid cryptographic
					// signature. Anthropic rejects it with:
					// "Invalid `signature` in `thinking` block"
					continue;
				} else {
					result[key] = sanitizeValue(val);
				}
			}
			return result;
		}
		return value;
	}

	const sanitizedLines: string[] = [];
	for (const line of lines) {
		if (!line.trim()) {
			sanitizedLines.push(line);
			continue;
		}
		try {
			const entry = JSON.parse(line);
			if (entry.type === "message" && entry.message) {
				entry.message = sanitizeValue(entry.message);
			}
			sanitizedLines.push(JSON.stringify(entry));
		} catch {
			sanitizedLines.push(line);
		}
	}

	fs.writeFileSync(sessionFile, sanitizedLines.join("\n"), "utf-8");
}

type SubagentExecutionContext = "fresh" | "fork";

interface ForkableSessionManager {
	getSessionFile(): string | undefined;
	getLeafId(): string | null;
	getSessionDir?(): string;
	openSession?: (path: string, sessionDir?: string) => { createBranchedSession(leafId: string): string | undefined };
}

interface ForkContextResolverOptions {
	openSession?: (path: string, sessionDir?: string) => { createBranchedSession(leafId: string): string | undefined };
}

interface ForkContextResolver {
	sessionFileForIndex(index?: number): string | undefined;
}

export function resolveSubagentContext(value: unknown): SubagentExecutionContext {
	return value === "fork" ? "fork" : "fresh";
}

export function createForkContextResolver(
	sessionManager: ForkableSessionManager,
	requestedContext: unknown,
	options: ForkContextResolverOptions = {},
): ForkContextResolver {
	if (resolveSubagentContext(requestedContext) !== "fork") {
		return {
			sessionFileForIndex: () => undefined,
		};
	}

	const parentSessionFile = sessionManager.getSessionFile();
	if (!parentSessionFile) {
		throw new Error("Forked subagent context requires a persisted parent session.");
	}

	const leafId = sessionManager.getLeafId();
	if (!leafId) {
		throw new Error("Forked subagent context requires a current leaf to fork from.");
	}

	const openSession = options.openSession
		?? sessionManager.openSession
		?? ((file: string, dir?: string) => SessionManager.open(file, dir));
	const sessionDir = sessionManager.getSessionDir?.();
	const cachedSessionFiles = new Map<number, string>();

	return {
		sessionFileForIndex(index = 0): string | undefined {
			const cached = cachedSessionFiles.get(index);
			if (cached) return cached;
			try {
				if (!fs.existsSync(parentSessionFile)) {
					throw new Error(`Parent session file does not exist: ${parentSessionFile}. Pi has not persisted enough history to fork yet.`);
				}
				const sourceManager = openSession(parentSessionFile, sessionDir);
				const sessionFile = sourceManager.createBranchedSession(leafId);
				if (!sessionFile) {
					throw new Error("Session manager did not return a forked session file.");
				}
				if (!fs.existsSync(sessionFile)) {
					throw new Error(`Session manager returned a forked session file that does not exist: ${sessionFile}`);
				}
				sanitizeForkedSession(sessionFile);
				cachedSessionFiles.set(index, sessionFile);
				return sessionFile;
			} catch (error) {
				const cause = error instanceof Error ? error : new Error(String(error));
				throw new Error(`Failed to create forked subagent session: ${cause.message}`, { cause });
			}
		},
	};
}
