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

export interface SessionUsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	turns: number;
}

function sessionUsageNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function sessionUsageCostTotal(cost: unknown): number {
	if (typeof cost === "number") return sessionUsageNumber(cost);
	if (cost !== null && typeof cost === "object") {
		// SAFETY: cost blocks are plain JSON records; only `total` is read.
		return sessionUsageNumber((cost as { total?: unknown }).total);
	}
	return 0;
}

/**
 * Cumulative usage totals over a child session file: full-fidelity sibling of
 * parseSessionTokens that also aggregates cache splits, cost, and assistant
 * turns. Returns null when no session file exists. Never throws.
 */
export function parseSessionUsage(sessionDir: string): SessionUsageTotals | null {
	const sessionFile = findLatestSessionFile(sessionDir);
	if (!sessionFile) return null;
	try {
		const content = fs.readFileSync(sessionFile, "utf-8");
		const totals: SessionUsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
		for (const line of content.split("\n")) {
			if (!line.trim()) continue;
			try {
				const entry = JSON.parse(line) as { message?: unknown; usage?: unknown };
				const message = entry.message !== null && typeof entry.message === "object"
					? (entry.message as { role?: unknown; usage?: unknown })
					: undefined;
				const usage = message?.usage ?? entry.usage;
				if (!usage || typeof usage !== "object") continue;
				// SAFETY: session usage blocks are plain JSON records with numeric fields.
				const record = usage as {
					input?: unknown; inputTokens?: unknown;
					output?: unknown; outputTokens?: unknown;
					cacheRead?: unknown; cacheReadTokens?: unknown;
					cacheWrite?: unknown; cacheWriteTokens?: unknown;
					cost?: unknown;
				};
				totals.input += sessionUsageNumber(record.input ?? record.inputTokens);
				totals.output += sessionUsageNumber(record.output ?? record.outputTokens);
				totals.cacheRead += sessionUsageNumber(record.cacheRead ?? record.cacheReadTokens);
				totals.cacheWrite += sessionUsageNumber(record.cacheWrite ?? record.cacheWriteTokens);
				totals.cost += sessionUsageCostTotal(record.cost);
				if (message?.role === "assistant") totals.turns++;
			} catch {
				// Ignore malformed lines while scanning usage entries.
			}
		}
		return totals;
	} catch {
		// Usage extraction should not fail the run.
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
