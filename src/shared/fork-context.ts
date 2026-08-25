import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { findModelInfo, type ModelInfo } from "./model-info.ts";

type SubagentExecutionContext = "fresh" | "fork";

interface BranchSessionEntry {
	type: string;
	id?: string;
	cwd?: string;
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
	/** Rewrite a created fork before its path can be used to spawn a child. */
	pruneSession?: (sessionFile: string) => Promise<void>;
	/** Decide per child index whether a sanitized transcript must also disable the child's
	 * thinking. Defaults to true (the pre-existing conservative behavior) when omitted. */
	forceThinkingOffForIndex?: (index: number) => boolean;
}

interface ForkContextResolution {
	sessionFile: string;
	thinkingOverride?: "off";
}

interface ForkContextResolver {
	prepareSessionForIndex(index?: number): Promise<void>;
	sessionFileForIndex(index?: number): string | undefined;
	thinkingOverrideForIndex(index?: number): "off" | undefined;
}

export function resolveSubagentContext(value: unknown): SubagentExecutionContext {
	return value === "fork" ? "fork" : "fresh";
}

export interface PreferredForkAvailability {
	getSessionFile(): string | undefined;
	getLeafId?: () => string | null;
}

export interface PreferredForkSnapshot {
	parentSessionFile?: string | null;
	leafId?: string | null;
}

export interface SubagentLaunchContextInput {
	explicitContext?: SubagentExecutionContext;
	agentDefaultContext?: SubagentExecutionContext;
	defaultSubagentContext?: SubagentExecutionContext;
	canUseImplicitFork: boolean;
}

/** Resolve the actual launch context from explicit, global, and agent preferences. */
export function resolveSubagentLaunchContext(input: SubagentLaunchContextInput): SubagentExecutionContext {
	if (input.explicitContext !== undefined) return input.explicitContext;
	const preferredContext = input.defaultSubagentContext ?? input.agentDefaultContext ?? "fresh";
	return preferredContext === "fork" && input.canUseImplicitFork ? "fork" : "fresh";
}

/** True when an implicit `defaultContext: fork` can create a real branch now.
 * Explicit `context: "fork"` stays strict and does not use this preference. */
export function canPreferFork(sessionManager: PreferredForkAvailability): boolean {
	return canPreferForkFromSnapshot({
		parentSessionFile: sessionManager.getSessionFile(),
		leafId: sessionManager.getLeafId?.() ?? null,
	});
}

export function canPreferForkFromSnapshot(input: PreferredForkSnapshot): boolean {
	if (!input.parentSessionFile || !input.leafId) return false;
	try {
		return fs.existsSync(input.parentSessionFile);
	} catch {
		return false;
	}
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
	const record = block as Record<string, unknown>;
	const signature = "thinkingSignature" in record ? record.thinkingSignature : "signature" in record ? record.signature : undefined;
	return record.redacted === true || (typeof signature === "string" && signature.length > 0);
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

/** Keep Pi from restoring a forked session into the parent's cwd instead of the child launch cwd. */
export function alignForkedSessionCwd(sessionFile: string, cwd: string): void {
	const entries = readSessionEntries(sessionFile);
	const header = entries[0];
	if (header?.type !== "session") throw new Error(`Forked session ${sessionFile} does not start with a session header.`);
	const resolvedCwd = path.resolve(cwd);
	const effectiveCwd = fs.realpathSync.native(resolvedCwd);
	if (header.cwd === effectiveCwd) return;
	header.cwd = effectiveCwd;
	fs.writeFileSync(sessionFile, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf-8");
}

export function createForkContextResolver(
	sessionManager: ForkableSessionManager,
	requestedContext: unknown,
	options: ForkContextResolverOptions = {},
): ForkContextResolver {
	if (resolveSubagentContext(requestedContext) !== "fork") {
		return {
			prepareSessionForIndex: async () => {},
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
	// Fork files must not land in the parent's top-level session directory.
	// Pi's recent-session discovery (`pi -c` → findMostRecentSession) is
	// non-recursive and picks the largest-mtime *.jsonl in that directory, so
	// a still-running forked subagent — which keeps appending after the parent
	// went idle — would hijack the next `pi -c` away from the conversation the
	// user actually left. Nesting fork sessions in a per-parent directory keeps
	// them invisible to that discovery; the `parentSession` header still
	// records the tree relationship. The directory mirrors
	// getSubagentSessionRoot() plus a "forks" level so fork files never sit
	// loose next to run-N/ result directories. Derived from the file path
	// rather than getSessionDir() so it also works when the manager cannot
	// report its directory.
	const sessionDir = path.join(
		path.dirname(parentSessionFile),
		path.basename(parentSessionFile, ".jsonl"),
		"forks",
	);
	const cachedResolutions = new Map<number, ForkContextResolution>();
	const preparedIndexes = new Set<number>();
	const preparationPromises = new Map<number, Promise<void>>();

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
		async prepareSessionForIndex(index = 0): Promise<void> {
			const resolution = resolveFork(index);
			if (!options.pruneSession || preparedIndexes.has(index)) return;
			let preparation = preparationPromises.get(index);
			if (!preparation) {
				preparation = options.pruneSession(resolution.sessionFile).then(() => {
					preparedIndexes.add(index);
				});
				preparationPromises.set(index, preparation);
			}
			await preparation;
		},
		sessionFileForIndex(index = 0): string | undefined {
			if (options.pruneSession && !preparedIndexes.has(index)) {
				throw new Error(`Pruned fork session ${index} was used before pruning completed.`);
			}
			return resolveFork(index).sessionFile;
		},
		thinkingOverrideForIndex(index = 0): "off" | undefined {
			return resolveFork(index).thinkingOverride;
		},
	};
}
