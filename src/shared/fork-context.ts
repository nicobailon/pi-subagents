import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { findModelInfo, type ModelInfo } from "./model-info.ts";

type SubagentExecutionContext = "fresh" | "fork";

interface BranchSessionEntry {
	type: string;
	id?: string;
	parentId?: string | null;
	timestamp?: string;
	message?: {
		role?: string;
		content?: unknown;
		provider?: string;
		api?: string;
		model?: string;
	};
	thinkingLevel?: string;
}

interface BranchSessionManager {
	createBranchedSession(leafId: string): string | undefined;
	getHeader?: () => BranchSessionEntry | null;
	getEntries?: () => BranchSessionEntry[];
}

interface ForkableSessionManager {
	getSessionFile(): string | undefined;
	getLeafId(): string | null;
	getSessionDir?(): string;
	openSession?: (path: string, sessionDir?: string) => BranchSessionManager;
}

interface ForkContextResolverOptions {
	openSession?: (path: string, sessionDir?: string) => BranchSessionManager;
	/** Decide per child index whether a sanitized transcript must also disable the child's
	 * thinking. Defaults to true (the pre-existing conservative behavior) when omitted. */
	forceThinkingOffForIndex?: (index: number) => boolean;
}

interface ForkContextResolution {
	sessionFile: string;
	thinkingOverride?: "off";
}

interface ForkContextResolver {
	sessionFileForIndex(index?: number): string | undefined;
	thinkingOverrideForIndex(index?: number): "off" | undefined;
}

export function resolveSubagentContext(value: unknown): SubagentExecutionContext {
	return value === "fork" ? "fork" : "fresh";
}

/** Decide whether a resolved child model uses Anthropic's provider or message API, which
 * requires the sanitized fork to disable thinking. Unknown models stay conservative. */
export function forkedChildRequiresThinkingOff(
	model: string | undefined,
	availableModels?: ModelInfo[],
	preferredProvider?: string,
): boolean {
	if (!model) return true;
	const info = findModelInfo(model, availableModels, preferredProvider);
	if (!info) return true;
	return info.provider.toLowerCase() === "anthropic"
		|| info.api?.toLowerCase() === "anthropic-messages";
}

function isUnsafeAnthropicThinkingBlock(message: BranchSessionEntry["message"], block: unknown): boolean {
	if (!message || !block || typeof block !== "object" || !("type" in block)) return false;
	const provider = typeof message.provider === "string" ? message.provider.toLowerCase() : "";
	const api = typeof message.api === "string" ? message.api.toLowerCase() : "";
	const model = typeof message.model === "string" ? message.model.toLowerCase() : "";
	const isAnthropic = provider === "anthropic" || api === "anthropic-messages" || model.startsWith("anthropic/");
	if (block.type === "redacted_thinking") return true;
	if (block.type !== "thinking" || !isAnthropic) return false;
	const signature = "thinkingSignature" in block ? block.thinkingSignature : "signature" in block ? block.signature : undefined;
	return block.redacted === true || (typeof signature === "string" && signature.length > 0);
}

function createEntryId(entries: BranchSessionEntry[]): string {
	const ids = new Set(entries.map((entry) => entry.id).filter((id): id is string => typeof id === "string"));
	for (let attempt = 0; attempt < 100; attempt++) {
		const id = randomUUID().slice(0, 8);
		if (!ids.has(id)) return id;
	}
	return randomUUID();
}

function appendThinkingOffEntry(entries: BranchSessionEntry[]): void {
	const last = entries[entries.length - 1];
	if (last?.type === "thinking_level_change" && last.thinkingLevel === "off") return;
	const parent = [...entries].reverse().find((entry) => typeof entry.id === "string");
	entries.push({
		type: "thinking_level_change",
		id: createEntryId(entries),
		parentId: parent?.id ?? null,
		timestamp: new Date().toISOString(),
		thinkingLevel: "off",
	});
}

function sanitizeUnsafeThinkingBlocks(entries: BranchSessionEntry[]): boolean {
	let sanitized = false;
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message?.role !== "assistant" || !Array.isArray(entry.message.content)) continue;
		const filtered = entry.message.content.filter((block) => !isUnsafeAnthropicThinkingBlock(entry.message, block));
		if (filtered.length === entry.message.content.length) continue;
		entry.message.content = filtered;
		sanitized = true;
	}
	return sanitized;
}

function readSessionEntries(sessionFile: string): BranchSessionEntry[] {
	const lines = fs.readFileSync(sessionFile, "utf-8").split("\n").filter((line) => line.trim().length > 0);
	return lines.map((line, index) => {
		try {
			return JSON.parse(line) as BranchSessionEntry;
		} catch (error) {
			const cause = error instanceof Error ? error : new Error(String(error));
			throw new Error(`Unable to inspect forked session ${sessionFile}: invalid JSONL on line ${index + 1}: ${cause.message}`, { cause });
		}
	});
}

export function createForkContextResolver(
	sessionManager: ForkableSessionManager,
	requestedContext: unknown,
	options: ForkContextResolverOptions = {},
): ForkContextResolver {
	if (resolveSubagentContext(requestedContext) !== "fork") {
		return {
			sessionFileForIndex: () => undefined,
			thinkingOverrideForIndex: () => undefined,
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
	const cachedResolutions = new Map<number, ForkContextResolution>();

	const resolveFork = (index = 0): ForkContextResolution => {
		const cached = cachedResolutions.get(index);
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
			const forceThinkingOff = (sanitized: boolean): boolean =>
				sanitized && (options.forceThinkingOffForIndex?.(index) ?? true);
			let thinkingOverride: "off" | undefined;
			if (!fs.existsSync(sessionFile)) {
				const header = sourceManager.getHeader?.();
				const entries = sourceManager.getEntries?.();
				if (!header || !entries) {
					throw new Error(`Session manager returned a forked session file that does not exist and cannot be persisted by fallback: ${sessionFile}`);
				}
				if (forceThinkingOff(sanitizeUnsafeThinkingBlocks(entries))) {
					appendThinkingOffEntry(entries);
					thinkingOverride = "off";
				}
				fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
				fs.writeFileSync(sessionFile, `${[header, ...entries].map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf-8");
			} else {
				const entries = readSessionEntries(sessionFile);
				if (sanitizeUnsafeThinkingBlocks(entries)) {
					if (forceThinkingOff(true)) {
						appendThinkingOffEntry(entries);
						thinkingOverride = "off";
					}
					fs.writeFileSync(sessionFile, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf-8");
				}
			}
			const resolution = { sessionFile, ...(thinkingOverride ? { thinkingOverride } : {}) };
			cachedResolutions.set(index, resolution);
			return resolution;
		} catch (error) {
			const cause = error instanceof Error ? error : new Error(String(error));
			throw new Error(`Failed to create forked subagent session: ${cause.message}`, { cause });
		}
	};

	return {
		sessionFileForIndex(index = 0): string | undefined {
			return resolveFork(index).sessionFile;
		},
		thinkingOverrideForIndex(index = 0): "off" | undefined {
			return resolveFork(index).thinkingOverride;
		},
	};
}
