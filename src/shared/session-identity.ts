import * as fs from "node:fs";

interface SessionIdentityManager {
	getSessionFile(): string | null | undefined;
	getSessionId(): string | null | undefined;
}

export function resolveCurrentSessionId(sessionManager: SessionIdentityManager): string {
	const sessionId = sessionManager.getSessionFile() ?? sessionManager.getSessionId();
	if (!sessionId) throw new Error("Current session identity is unavailable.");
	return sessionId;
}

/** The id in a Pi session file's header, which `pi --session <id>` resolves; only ids that need no shell quoting. */
export function resolvePiSessionId(sessionFile: string | undefined): string | undefined {
	if (!sessionFile) return undefined;
	try {
		const fd = fs.openSync(sessionFile, "r");
		try {
			const buffer = Buffer.alloc(16 * 1024);
			const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
			const line = buffer.toString("utf-8", 0, bytes).split("\n", 1)[0];
			if (!line) return undefined;
			const header = JSON.parse(line) as { type?: unknown; id?: unknown };
			if (header.type === "session" && typeof header.id === "string" && /^[A-Za-z0-9-]{8,}$/.test(header.id)) return header.id;
			return undefined;
		} finally {
			fs.closeSync(fd);
		}
	} catch {
		return undefined;
	}
}
