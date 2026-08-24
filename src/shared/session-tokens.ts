import * as fs from "node:fs";
import * as path from "node:path";
import type { TokenUsage } from "./types.ts";

function findLatestSessionFile(sessionDir: string): string | null {
	try {
		const files = fs.readdirSync(sessionDir)
			.filter((f) => f.endsWith(".jsonl"))
			.map((f) => path.join(sessionDir, f));
		if (files.length === 0) return null;
		files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
		return files[0] ?? null;
	} catch {
		// Session token lookup is optional metadata.
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
		let window: number | undefined;
		let windowPeak: number | undefined;
		for (const line of content.split("\n")) {
			if (!line.trim()) continue;
			try {
				const entry = JSON.parse(line);
				const usage = entry.usage ?? entry.message?.usage;
				if (usage) {
					const inputValue = usage.inputTokens ?? usage.input;
					const outputValue = usage.outputTokens ?? usage.output;
					const cacheReadValue = usage.cacheReadTokens ?? usage.cacheRead;
					const turnInput = typeof inputValue === "number" && Number.isFinite(inputValue) ? inputValue : 0;
					const turnOutput = typeof outputValue === "number" && Number.isFinite(outputValue) ? outputValue : 0;
					const cacheRead = typeof cacheReadValue === "number" && Number.isFinite(cacheReadValue) ? cacheReadValue : 0;
					const turnWindow = turnInput + cacheRead;
					input += turnInput;
					output += turnOutput;
					window = turnWindow;
					windowPeak = Math.max(windowPeak ?? 0, turnWindow);
				}
			} catch {
				// Ignore malformed lines while scanning usage entries.
			}
		}
		return { input, output, total: input + output, ...(window !== undefined ? { window, windowPeak } : {}) };
	} catch {
		// Usage extraction should not fail the run.
		return null;
	}
}
