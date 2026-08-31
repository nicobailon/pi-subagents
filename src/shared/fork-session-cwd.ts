import * as fs from "node:fs";
import * as path from "node:path";

interface SessionEntry {
	type?: string;
	cwd?: string;
	[key: string]: unknown;
}

/** Keep Pi from restoring a forked session into the parent's cwd instead of the child launch cwd. */
export function alignForkedSessionCwd(sessionFile: string, cwd: string): void {
	const lines = fs.readFileSync(sessionFile, "utf-8").split("\n").filter((line) => line.trim().length > 0);
	const entries = lines.map((line, index) => {
		try {
			return JSON.parse(line) as SessionEntry;
		} catch (error) {
			const cause = error instanceof Error ? error : new Error(String(error));
			throw new Error(`Unable to inspect forked session ${sessionFile}: invalid JSONL on line ${index + 1}: ${cause.message}`, { cause });
		}
	});
	const header = entries[0];
	if (header?.type !== "session") throw new Error(`Forked session ${sessionFile} does not start with a session header.`);
	const effectiveCwd = fs.realpathSync.native(path.resolve(cwd));
	if (header.cwd === effectiveCwd) return;
	header.cwd = effectiveCwd;
	fs.writeFileSync(sessionFile, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf-8");
}
