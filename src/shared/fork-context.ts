import * as fs from "node:fs";
import { CURRENT_SESSION_VERSION, SessionManager, type SessionEntry } from "@earendil-works/pi-coding-agent";

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

	/**
	 * Write the branched session file manually.
	 *
	 * Called when createBranchedSession() returns a path but the file was not
	 * written to disk. This happens when the branched path contains no assistant
	 * messages — SessionManager defers writing until _persist() is called with
	 * the first assistant response.
	 *
	 * After createBranchedSession(), the source manager's internal state has been
	 * switched to the branched session, so getBranch() returns the correct path
	 * and getSessionId() returns the new branched session id.
	 *
	 * Depends on SessionManager internals:
	 * - getBranch() must return the branched path (relies on leafId being updated)
	 * - getSessionId() must return the new session id (runtime-public, TS-private)
	 */
	function writeBranchedSessionFile(sourceManager: ForkableSessionManager & { getBranch(): SessionEntry[]; getSessionId?(): string; getCwd?(): string }, sessionFile: string): void {
		const path = sourceManager.getBranch();
		const header = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: sourceManager.getSessionId?.() ?? "branched",
			timestamp: new Date().toISOString(),
			cwd: sourceManager.getCwd?.() ?? "",
			parentSession: parentSessionFile,
		};
		const lines = [JSON.stringify(header), ...path.map((e) => JSON.stringify(e))];
		fs.writeFileSync(sessionFile, lines.join("\n") + "\n", "utf-8");
	}

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
				// createBranchedSession() may return a path without writing the file
				// when the branched path has no assistant messages (deferred to _persist).
				// Write it ourselves so the file exists for the spawned subagent process.
				if (!fs.existsSync(sessionFile)) {
					writeBranchedSessionFile(sourceManager as ForkableSessionManager & { getBranch(): SessionEntry[] }, sessionFile);
				}
				cachedSessionFiles.set(index, sessionFile);
				return sessionFile;
			} catch (error) {
				const cause = error instanceof Error ? error : new Error(String(error));
				throw new Error(`Failed to create forked subagent session: ${cause.message}`, { cause });
			}
		},
	};
}
