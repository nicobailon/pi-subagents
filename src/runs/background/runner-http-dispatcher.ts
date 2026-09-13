import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import { createRequire } from "node:module";
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
			// Pi rejects the merged value outright; a malformed override must not
			// silently fall through to a different scope's setting.
			warnings.push(`invalid httpIdleTimeoutMs in ${candidate.file}: ${String(read.value)}`);
			return { timeoutMs: DEFAULT_HTTP_IDLE_TIMEOUT_MS, source: "default", warning: warnings.join("; ") };
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

/**
 * Installs the runner's proxy-aware undici dispatcher as the process global and
 * routes global fetch through it, with header/body idle clocks taken from Pi's
 * `httpIdleTimeoutMs`. Detached runners skip Pi's CLI dispatcher setup: the Node
 * entrypoint never runs it, and the binary bootstrap runs inside the extension
 * factory, before Pi applies the setting to its own dispatcher. Best effort: a
 * failure logs and leaves the existing dispatcher in place.
 */
export function installRunnerHttpDispatcher(options: { agentDir: string; cwd: string }): void {
	try {
		// SAFETY: require loads the pinned direct dependency described by these types.
		const undici = createRequire(import.meta.url)("undici") as typeof import("undici");
		const idle = resolveHttpIdleTimeoutMs(options);
		if (idle.warning) console.error(`[pi-subagents] httpIdleTimeoutMs: ${idle.warning}; using ${idle.timeoutMs}ms`);
		const dispatcher = new undici.EnvHttpProxyAgent(runnerHttpDispatcherOptions(idle.timeoutMs));
		// Fetch rejects stream errors; the listener prevents an unhandled EventEmitter error.
		EventEmitter.prototype.on.call(dispatcher, "error", () => {});
		undici.setGlobalDispatcher(dispatcher);
		undici.install();
	} catch (error) {
		console.error(`[pi-subagents] proxy-aware HTTP dispatcher not installed: ${error instanceof Error ? error.message : String(error)}`);
	}
}
