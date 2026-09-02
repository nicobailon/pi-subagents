import { spawnSync } from "node:child_process";
import * as path from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type, type Static } from "typebox";

export const WATCHDOG_DIFF_TOOL_NAME = "watchdog_diff";
export const WATCHDOG_DIFF_MAX_CHARS = 24_000;
const MAX_UNTRACKED_FILES = 50;

export interface WatchdogDiffBaseline {
	root: string;
	ref: string;
}

const WatchdogDiffParams = Type.Object({
	path: Type.Optional(Type.String({ description: "Restrict the diff to one file or directory, relative to the repo root." })),
	stat: Type.Optional(Type.Boolean({ description: "Return per-file change counts instead of the full diff." })),
}, { additionalProperties: false });

type WatchdogDiffParams = Static<typeof WatchdogDiffParams>;

function runGit(root: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
	const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf-8", maxBuffer: 16 * 1024 * 1024, windowsHide: true });
	return { ok: result.status === 0, stdout: result.stdout ?? "", stderr: (result.stderr ?? "").trim() };
}

/** HEAD at session start, so later child commits still show in the diff. */
export function captureWatchdogDiffBaseline(cwd: string): WatchdogDiffBaseline | undefined {
	const toplevel = runGit(cwd, ["rev-parse", "--show-toplevel"]);
	if (!toplevel.ok) return undefined;
	const head = runGit(cwd, ["rev-parse", "HEAD"]);
	if (!head.ok) return undefined;
	const root = toplevel.stdout.trim();
	const ref = head.stdout.trim();
	return root && ref ? { root, ref } : undefined;
}

function validatePath(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	if (!trimmed) return undefined;
	if (trimmed.startsWith("-")) throw new Error("watchdog_diff path must not start with '-'.");
	if (path.isAbsolute(trimmed)) throw new Error("watchdog_diff path must be relative to the repo root.");
	if (trimmed.split(/[\\/]/).includes("..")) throw new Error("watchdog_diff path must not contain '..'.");
	return trimmed;
}

function bound(text: string): string {
	if (text.length <= WATCHDOG_DIFF_MAX_CHARS) return text;
	const marker = `\n\n[... ${text.length - WATCHDOG_DIFF_MAX_CHARS} characters omitted; call again with a narrower path ...]`;
	return `${text.slice(0, WATCHDOG_DIFF_MAX_CHARS - marker.length)}${marker}`;
}

/** In a shared cwd, changes already pending when the session started also appear. */
export function createWatchdogDiffTool(baseline: WatchdogDiffBaseline): AgentTool<typeof WatchdogDiffParams, { chars: number }> {
	return {
		name: WATCHDOG_DIFF_TOOL_NAME,
		label: "Watchdog diff",
		description: "Show the repository diff since the review baseline, plus untracked file paths. Optional path narrows it; stat:true returns per-file counts only.",
		parameters: WatchdogDiffParams,
		executionMode: "sequential",
		async execute(_toolCallId, params: WatchdogDiffParams) {
			const pathFilter = validatePath(params.path);
			const diff = runGit(baseline.root, ["diff", "--no-color", "--no-ext-diff", ...(params.stat === true ? ["--stat"] : []), baseline.ref, "--", ...(pathFilter ? [pathFilter] : [])]);
			if (!diff.ok) throw new Error(`git diff failed: ${diff.stderr || "unknown error"}`);
			const untrackedResult = runGit(baseline.root, ["ls-files", "--others", "--exclude-standard", "-z", "--", ...(pathFilter ? [pathFilter] : [])]);
			const untracked = untrackedResult.ok ? untrackedResult.stdout.split("\0").filter(Boolean) : [];
			const sections = [diff.stdout.trimEnd()];
			if (untracked.length) {
				const shown = untracked.slice(0, MAX_UNTRACKED_FILES);
				sections.push(["Untracked files (use read to inspect):", ...shown.map((file) => ` ${file}`)].join("\n"));
				if (untracked.length > shown.length) sections.push(`... ${untracked.length - shown.length} more untracked files`);
			}
			const text = bound(sections.filter(Boolean).join("\n\n")) || `No changes since baseline ${baseline.ref.slice(0, 12)}.`;
			return { content: [{ type: "text", text }], details: { chars: text.length } };
		},
	};
}
