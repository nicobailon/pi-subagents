/**
 * orchestrator-session.ts
 *
 * Persystowanie sesji dla orchestratora — odpowiednik persistSlashSessionSnapshot
 * z slash-commands.ts. Wymagane, żeby agenty z defaultContext: fork (worker, planner,
 * oracle) mogły tworzyć forkowane sesje z sesji rodzica.
 *
 * Dodatkowo appenduje syntetyczny wpis assistant message, ponieważ Pi's
 * createBranchedSession odmawia zapisu pliku jeśli branched path nie zawiera
 * żadnego wpisu typu "message" z rolą "assistant". Przy sesji z --session-dir
 * uruchamianej przez -c (command mode) sesja zawiera tylko custom_message.
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export function persistOrchSessionSnapshot(ctx: ExtensionContext): void {
	try {
		if (!ctx.sessionManager) return;
		const sessionManager = ctx.sessionManager as typeof ctx.sessionManager & {
			_rewriteFile?: () => void;
			flushed?: boolean;
			getLeafId?: () => string | null;
			getSessionFile?: () => string | null;
			fileEntries?: Array<{ type?: string; id?: string; message?: { role?: string; usage?: { totalTokens?: number } | null } }>;
		};
		const sessionFile = sessionManager.getSessionFile?.();
		if (!sessionFile || typeof sessionManager._rewriteFile !== "function") return;
		fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
		sessionManager._rewriteFile();
		sessionManager.flushed = true;

		// Append a synthetic assistant message when the session lacks an assistant
		// with valid usage data. Pi's createBranchedSession skips file creation if
		// hasAssistant is false (session only has custom_message entries), and
		// forked child processes crash when inheriting an assistant with usage=null
		// (totalTokens read on null).
		const leafId = typeof sessionManager.getLeafId === "function"
			? sessionManager.getLeafId()
			: null;
		const hasValidUsage = sessionManager.fileEntries?.some(
			(e) => e.type === "message" && e.message?.role === "assistant"
				&& e.message?.usage != null && typeof e.message.usage.totalTokens === "number",
		);
		if (leafId && !hasValidUsage) {
			const placeholderId = randomUUID().replace(/-/g, "").slice(0, 8);
			const now = new Date().toISOString();
			const assistantEntry = JSON.stringify({
				type: "message",
				id: placeholderId,
				parentId: leafId,
				timestamp: now,
				message: {
					role: "assistant",
					content: [{ type: "text", text: "[orchestrator initialization]" }],
					api: "openai-completions",
					provider: "placeholder",
					model: "placeholder",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					timestamp: Date.now(),
				},
			});
			fs.appendFileSync(sessionFile, assistantEntry + "\n", "utf-8");
		}
	} catch (error) {
		console.error("Failed to persist orchestrator session snapshot:", error);
	}
}
