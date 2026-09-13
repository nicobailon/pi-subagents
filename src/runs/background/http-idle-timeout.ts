import * as fs from "node:fs";
import * as path from "node:path";
import { getConfigDirName } from "../../shared/utils.ts";

/** Pi's default undici header/body idle timeout. */
export const DEFAULT_HTTP_IDLE_TIMEOUT_MS = 300_000;

export interface HttpIdleTimeoutResolution {
	timeoutMs: number;
	source: "project" | "global" | "default";
	warning?: string;
}

/**
 * Mirrors pi-coding-agent's `parseHttpIdleTimeoutMs`: numbers (or numeric
 * strings) are floored, `"disabled"` means 0, anything else is invalid.
 */
export function parseHttpIdleTimeoutMs(value: unknown): number | undefined {
	if (typeof value === "string") {
		const trimmed = value.trim();
		if (trimmed.toLowerCase() === "disabled") return 0;
		if (trimmed.length === 0) return undefined;
		return parseHttpIdleTimeoutMs(Number(trimmed));
	}
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
	return Math.floor(value);
}

function readSetting(file: string): { present: boolean; value?: unknown; error?: string } {
	let raw: string;
	try {
		raw = fs.readFileSync(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { present: false };
		return { present: false, error: `cannot read ${file}: ${error instanceof Error ? error.message : String(error)}` };
	}
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { present: false };
		if (!Object.hasOwn(parsed, "httpIdleTimeoutMs")) return { present: false };
		return { present: true, value: (parsed as Record<string, unknown>).httpIdleTimeoutMs };
	} catch (error) {
		return { present: false, error: `cannot parse ${file}: ${error instanceof Error ? error.message : String(error)}` };
	}
}

/**
 * Resolves Pi's `httpIdleTimeoutMs` the way the host does: the project
 * `.pi/settings.json` overrides the global `<agentDir>/settings.json`, and an
 * unset value falls back to 300 000 ms. Detached runners install their own
 * undici dispatcher before pi-coding-agent is loaded, so they cannot borrow
 * Pi's SettingsManager and must read the setting themselves.
 */
export function resolveHttpIdleTimeoutMs(options: { agentDir: string; cwd: string }): HttpIdleTimeoutResolution {
	const candidates: Array<{ source: "project" | "global"; file: string }> = [
		{ source: "project", file: path.join(options.cwd, getConfigDirName(), "settings.json") },
		{ source: "global", file: path.join(options.agentDir, "settings.json") },
	];
	const warnings: string[] = [];
	for (const candidate of candidates) {
		const read = readSetting(candidate.file);
		if (read.error) {
			warnings.push(read.error);
			continue;
		}
		if (!read.present) continue;
		const timeoutMs = parseHttpIdleTimeoutMs(read.value);
		if (timeoutMs === undefined) {
			warnings.push(`invalid httpIdleTimeoutMs in ${candidate.file}: ${String(read.value)}`);
			continue;
		}
		return { timeoutMs, source: candidate.source, ...(warnings.length ? { warning: warnings.join("; ") } : {}) };
	}
	return { timeoutMs: DEFAULT_HTTP_IDLE_TIMEOUT_MS, source: "default", ...(warnings.length ? { warning: warnings.join("; ") } : {}) };
}

/** Dispatcher options shared by the runner and its regression test. */
export function runnerHttpDispatcherOptions(timeoutMs: number): {
	allowH2: false;
	proxyTunnel: true;
	headersTimeout: number;
	bodyTimeout: number;
} {
	return {
		allowH2: false,
		// Keep HTTP origins on CONNECT tunnels, matching Pi's dispatcher.
		proxyTunnel: true,
		headersTimeout: timeoutMs,
		bodyTimeout: timeoutMs,
	};
}
