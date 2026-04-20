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
			.sort();
		if (files.length === 0) return null;
		return path.join(sessionDir, files[files.length - 1]!);
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
