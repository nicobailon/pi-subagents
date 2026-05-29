import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "../../shared/utils.ts";

export interface RunEntry {
	agent: string;
	task: string;
	ts: number;
	status: "ok" | "error";
	duration: number;
	exit?: number;
	model?: string;
	cwd?: string;
	error_excerpt?: string;
	tool_calls?: number;
}

const ROTATE_READ_THRESHOLD = 1200;
const ROTATE_KEEP = 1000;

function getHistoryPath(): string {
	return path.join(getAgentDir(), "run-history.jsonl");
}

// Best-effort GC: when the log outgrows the threshold, trim to the last ROTATE_KEEP by
// writing a per-process-unique temp file and atomically renaming it into place. Concurrent
// rotators each write a unique temp and rename; the last rename wins, and the file is a
// complete valid snapshot either way — no duplication, no corruption. An append landing in
// a rotate's read->rename window is dropped (acceptable for telemetry); trimming also
// intentionally discards the oldest entries.
function maybeRotate(historyPath: string): void {
	const lines = fs.readFileSync(historyPath, "utf-8").split("\n").filter((l) => l.trim().length > 0);
	if (lines.length <= ROTATE_READ_THRESHOLD) return;
	const tmp = `${historyPath}.${process.pid}.${Date.now()}.tmp`;
	fs.writeFileSync(tmp, `${lines.slice(-ROTATE_KEEP).join("\n")}\n`);
	fs.renameSync(tmp, historyPath);
}

// Appends one JSON line via O_APPEND: on a local POSIX filesystem the kernel serializes
// concurrent appends from separate processes, so they never interleave or tear (telemetry
// entries are small — comfortably within a single atomic write()). Synchronous and
// best-effort: it never waits on a lock, and it swallows I/O errors rather than disrupting
// the agent flow (a swallowed error simply drops that one entry).
export function recordRun(
	agent: string,
	task: string,
	exitCode: number,
	durationMs: number,
	extra?: { model?: string; cwd?: string; tool_calls?: number; error_excerpt?: string },
): void {
	try {
		const entry: RunEntry = {
			agent,
			task: task.slice(0, 200),
			ts: Math.floor(Date.now() / 1000),
			status: exitCode === 0 ? "ok" : "error",
			duration: durationMs,
			...(exitCode !== 0 ? { exit: exitCode } : {}),
			...(extra?.model ? { model: extra.model } : {}),
			...(extra?.cwd ? { cwd: extra.cwd } : {}),
			...(extra?.tool_calls !== undefined ? { tool_calls: extra.tool_calls } : {}),
			...(extra?.error_excerpt ? { error_excerpt: extra.error_excerpt.slice(0, 300) } : {}),
		};
		const historyPath = getHistoryPath();
		fs.mkdirSync(path.dirname(historyPath), { recursive: true });
		fs.appendFileSync(historyPath, `${JSON.stringify(entry)}\n`);
		maybeRotate(historyPath);
	} catch {
		// Best-effort — never crash the execution flow for history recording
	}
}

export function loadRunsForAgent(agent: string): RunEntry[] {
	const historyPath = getHistoryPath();
	if (!fs.existsSync(historyPath)) return [];
	let raw: string;
	try {
		raw = fs.readFileSync(historyPath, "utf-8");
	} catch {
		return [];
	}

	return raw
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.map((line) => {
			try {
				return JSON.parse(line) as RunEntry;
			} catch {
				return undefined;
			}
		})
		.filter((entry): entry is RunEntry => Boolean(entry) && entry.agent === agent)
		.reverse();
}
