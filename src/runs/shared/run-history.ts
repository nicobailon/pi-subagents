import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "../../shared/utils.ts";

export interface RunEntry {
	agent: string;
	task: string;
	taskHash?: string;
	ts: number;
	status: "ok" | "error";
	duration: number;
	exit?: number;
}

const ROTATE_READ_THRESHOLD = 1200;
const ROTATE_KEEP = 1000;
const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const REDACTED_TASK = "[redacted]";

function getHistoryPath(): string {
	return path.join(getAgentDir(), "run-history.jsonl");
}

function hashTask(task: string): string {
	return createHash("sha256").update(task).digest("hex");
}

function hardenHistoryStorage(historyPath: string): void {
	const historyDir = path.dirname(historyPath);
	fs.mkdirSync(historyDir, { recursive: true, mode: PRIVATE_DIR_MODE });
	try { fs.chmodSync(historyDir, PRIVATE_DIR_MODE); } catch {}
	try { if (fs.existsSync(historyPath)) fs.chmodSync(historyPath, PRIVATE_FILE_MODE); } catch {}
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

function sanitizeHistoryFile(historyPath: string): void {
	if (!fs.existsSync(historyPath)) return;
	const raw = fs.readFileSync(historyPath, "utf-8");
	const { lines, changed } = sanitizeHistoryLines(raw);
	if (changed) writePrivateHistory(historyPath, lines);
}

function appendPrivateHistoryLine(historyPath: string, line: string): void {
	const fd = fs.openSync(historyPath, fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_WRONLY, PRIVATE_FILE_MODE);
	try {
		fs.writeSync(fd, `${line}\n`);
	} finally {
		fs.closeSync(fd);
	}
	try { fs.chmodSync(historyPath, PRIVATE_FILE_MODE); } catch {}
}

export function recordRun(agent: string, task: string, exitCode: number, durationMs: number): void {
	try {
		const entry: RunEntry = {
			agent,
			task: REDACTED_TASK,
			taskHash: hashTask(task),
			ts: Math.floor(Date.now() / 1000),
			status: exitCode === 0 ? "ok" : "error",
			duration: durationMs,
			...(exitCode !== 0 ? { exit: exitCode } : {}),
		};
		const historyPath = getHistoryPath();
		hardenHistoryStorage(historyPath);
		try { sanitizeHistoryFile(historyPath); } catch {}
		appendPrivateHistoryLine(historyPath, JSON.stringify(entry));
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
	if (changed) {
		try { writePrivateHistory(historyPath, lines); } catch {}
	}

	return lines
		.map((line) => { try { return JSON.parse(line) as RunEntry; } catch { return undefined; } })
		.filter((entry): entry is RunEntry => Boolean(entry) && entry.agent === agent)
		.reverse();
}
