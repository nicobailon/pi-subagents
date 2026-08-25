import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "../../shared/utils.ts";
import { isUnexplainedProcessSignal } from "./process-signal.ts";

export type RunOutcome = "completed" | "failed" | "timed_out" | "stopped" | "interrupted";

export interface RunEntry {
	agent: string;
	task: string;
	taskHash?: string;
	ts: number;
	status: "ok" | "error";
	outcome?: RunOutcome;
	duration: number;
	exit?: number;
}

const ROTATE_READ_THRESHOLD = 1200;
const ROTATE_KEEP = 1000;
const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const REDACTED_TASK = "[redacted]";
const historyFileStates = new Map<string, { mtimeMs: number; ctimeMs: number; size: number; ino: number; lineCount: number }>();

function getHistoryPath(): string {
	return path.join(getAgentDir(), "run-history.jsonl");
}

function hashTask(task: string): string {
	return createHash("sha256").update(task).digest("hex");
}

function hardenHistoryStorage(historyPath: string): void {
	const historyDir = path.dirname(historyPath);
	fs.mkdirSync(historyDir, { recursive: true, mode: PRIVATE_DIR_MODE });
	try {
		if ((fs.statSync(historyDir).mode & 0o777) !== PRIVATE_DIR_MODE) fs.chmodSync(historyDir, PRIVATE_DIR_MODE);
	} catch {}
	try {
		if ((fs.statSync(historyPath).mode & 0o777) !== PRIVATE_FILE_MODE) fs.chmodSync(historyPath, PRIVATE_FILE_MODE);
	} catch {}
}

function sanitizeHistoryLine(line: string): string | undefined {
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (!value || typeof value !== "object") return undefined;

	const record = value as Record<string, unknown>;
	const task = typeof record.task === "string" ? record.task : "";
	const taskHash = typeof record.taskHash === "string" && record.taskHash
		? record.taskHash
		: task && task !== REDACTED_TASK
			? hashTask(task)
			: undefined;

	return JSON.stringify({
		...record,
		task: REDACTED_TASK,
		...(taskHash ? { taskHash } : {}),
	});
}

function sanitizeHistoryLines(raw: string): { lines: string[]; changed: boolean } {
	const lines: string[] = [];
	let changed = false;
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		const sanitized = sanitizeHistoryLine(trimmed);
		if (!sanitized) {
			changed = true;
			continue;
		}
		if (sanitized !== trimmed) changed = true;
		lines.push(sanitized);
	}
	return { lines, changed };
}

function writePrivateHistory(historyPath: string, lines: string[]): void {
	fs.writeFileSync(historyPath, lines.length ? `${lines.join("\n")}\n` : "", { encoding: "utf-8", mode: PRIVATE_FILE_MODE });
	try { fs.chmodSync(historyPath, PRIVATE_FILE_MODE); } catch {}
}

function rememberHistoryFile(historyPath: string, lineCount: number): void {
	const stat = fs.statSync(historyPath);
	historyFileStates.set(historyPath, {
		mtimeMs: stat.mtimeMs,
		ctimeMs: stat.ctimeMs,
		size: stat.size,
		ino: stat.ino,
		lineCount,
	});
	if (historyFileStates.size > 8) historyFileStates.delete(historyFileStates.keys().next().value!);
}

function sanitizeHistoryFile(historyPath: string): number {
	let stat: fs.Stats;
	try {
		stat = fs.statSync(historyPath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
		throw error;
	}
	const cached = historyFileStates.get(historyPath);
	if (cached
		&& cached.mtimeMs === stat.mtimeMs
		&& cached.ctimeMs === stat.ctimeMs
		&& cached.size === stat.size
		&& cached.ino === stat.ino) {
		return cached.lineCount;
	}
	const raw = fs.readFileSync(historyPath, "utf-8");
	const { lines, changed } = sanitizeHistoryLines(raw);
	if (changed) writePrivateHistory(historyPath, lines);
	rememberHistoryFile(historyPath, lines.length);
	return lines.length;
}

function appendPrivateHistoryLine(historyPath: string, line: string): void {
	const fd = fs.openSync(historyPath, fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_WRONLY, PRIVATE_FILE_MODE);
	try {
		fs.writeSync(fd, `${line}\n`);
	} finally {
		fs.closeSync(fd);
	}
}

export function recordRun(
	agent: string,
	task: string,
	exitCode: number,
	durationMs: number,
	terminal: { interrupted?: boolean; processSignal?: string | null; stopped?: boolean; timedOut?: boolean; turnBudgetExceeded?: boolean } = {},
): void {
	try {
		const outcome: RunOutcome = terminal.stopped
			? "stopped"
			: terminal.interrupted
				? "interrupted"
				: terminal.timedOut
					? "timed_out"
					: exitCode !== 0 && isUnexplainedProcessSignal(terminal)
						? "stopped"
						: exitCode === 0 ? "completed" : "failed";
		const entry: RunEntry = {
			agent,
			task: REDACTED_TASK,
			taskHash: hashTask(task),
			ts: Math.floor(Date.now() / 1000),
			status: exitCode === 0 ? "ok" : "error",
			outcome,
			duration: durationMs,
			...(exitCode !== 0 ? { exit: exitCode } : {}),
		};
		const historyPath = getHistoryPath();
		hardenHistoryStorage(historyPath);
		let lineCount: number | undefined;
		try { lineCount = sanitizeHistoryFile(historyPath); } catch {}
		appendPrivateHistoryLine(historyPath, JSON.stringify(entry));
		if (lineCount === undefined) historyFileStates.delete(historyPath);
		else rememberHistoryFile(historyPath, lineCount + 1);
	} catch {
		// Best-effort — never crash the execution flow for history recording
	}
}

export function loadRunsForAgent(agent: string): RunEntry[] {
	const historyPath = getHistoryPath();
	try { hardenHistoryStorage(historyPath); } catch {}
	if (!fs.existsSync(historyPath)) return [];
	let raw: string;
	try {
		raw = fs.readFileSync(historyPath, "utf-8");
	} catch {
		return [];
	}

	let { lines, changed } = sanitizeHistoryLines(raw);

	if (lines.length > ROTATE_READ_THRESHOLD) {
		lines = lines.slice(-ROTATE_KEEP);
		changed = true;
	}
	try {
		if (changed) writePrivateHistory(historyPath, lines);
		rememberHistoryFile(historyPath, lines.length);
	} catch {}

	return lines
		.map((line) => { try { return JSON.parse(line) as RunEntry; } catch { return undefined; } })
		.filter((entry): entry is RunEntry => entry !== undefined && entry.agent === agent)
		.reverse();
}
