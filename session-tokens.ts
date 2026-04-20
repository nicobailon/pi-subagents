import * as fs from "node:fs";
import * as path from "node:path";

export interface TokenUsage {
	input: number;
	output: number;
	total: number;
}

function findLatestSessionFile(sessionDir: string): string | null {
	try {
		const files = fs.readdirSync(sessionDir)
			.filter((f) => f.endsWith(".jsonl"))
			.map((f) => path.join(sessionDir, f));
		if (files.length === 0) return null;
		files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
		return files[0] ?? null;
	} catch {
		return null;
	}
}

export function parseSessionTokens(sessionDir: string): TokenUsage | null {
	const sessionFile = findLatestSessionFile(sessionDir);
	if (!sessionFile) return null;
	try {
		const content = fs.readFileSync(sessionFile, "utf-8");
		let input = 0;
		let output = 0;
		for (const line of content.split("\n")) {
			if (!line.trim()) continue;
			try {
				const entry = JSON.parse(line);
				const usage = entry.usage ?? entry.message?.usage;
				if (usage) {
					input += usage.inputTokens ?? usage.input ?? 0;
					output += usage.outputTokens ?? usage.output ?? 0;
				}
			} catch {
				// Ignore malformed lines while scanning usage entries.
			}
		}
		return { input, output, total: input + output };
	} catch {
		// Usage extraction should not fail the run.
		return null;
	}
}
