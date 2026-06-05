import * as fs from "node:fs";

export interface TranscriptReadResult {
	available: boolean;
	entries: unknown[];
	warnings: string[];
	partialTail: boolean;
	bytes: number;
}

export function readTranscriptEntries(sessionFile: string | undefined): TranscriptReadResult {
	if (!sessionFile) {
		return {
			available: false,
			entries: [],
			warnings: ["Transcript unavailable: no session file was recorded for this agent."],
			partialTail: false,
			bytes: 0,
		};
	}

	let content: string;
	try {
		content = fs.readFileSync(sessionFile, "utf-8");
	} catch (error) {
		const code = error && typeof error === "object" && "code" in error ? (error as NodeJS.ErrnoException).code : undefined;
		const reason = code === "ENOENT" ? "not found" : error instanceof Error ? error.message : String(error);
		return { available: false, entries: [], warnings: [`Transcript unavailable: ${sessionFile} (${reason})`], partialTail: false, bytes: 0 };
	}

	const bytes = Buffer.byteLength(content, "utf-8");
	const partialTail = content.length > 0 && !content.endsWith("\n");
	const completeContent = partialTail ? content.slice(0, content.lastIndexOf("\n") + 1) : content;
	const lines = completeContent.split("\n").filter((line) => line.trim().length > 0);
	const entries: unknown[] = [];
	const warnings: string[] = [];
	for (let index = 0; index < lines.length; index += 1) {
		try {
			entries.push(JSON.parse(lines[index]!));
		} catch (error) {
			warnings.push(`Ignoring malformed transcript JSONL line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return { available: true, entries, warnings, partialTail, bytes };
}
