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

function backgroundRunHistoryTask(steps: readonly unknown[], resultMode: string): string {
	const step = steps.length === 1 && typeof steps[0] === "object" && steps[0] !== null
		? (steps[0] as { task?: unknown; launchBindingTask?: unknown })
		: undefined;
	if (step) {
		const task = typeof step.launchBindingTask === "string" && step.launchBindingTask ? step.launchBindingTask : step.task;
		if (typeof task === "string" && task) return task;
	}
	return resultMode || "run";
}

export interface BackgroundRunHistoryEntry {
	agent: string;
	task: string;
	exitCode: number;
	durationMs: number;
	terminal: { stopped?: boolean; interrupted?: boolean; timedOut?: boolean; processSignal?: string | null };
}

const TERMINAL_STEP_STATUSES = new Set(["complete", "completed"]);
/** Steps that reached THEIR OWN terminal state — run-wide flags must not relabel them. */
const SELF_TERMINAL_STEP_STATUSES = new Set(["complete", "completed", "failed", "rejected"]);

/**
 * Census rows for one finished background run. Single-step runs keep the exact
 * foreground shape (agent + task text). Multi-step runs record ONE ROW PER CHILD
 * STEP so `loadRunsForAgent(agent)` sees every child — a composite-only row would
 * stay invisible to per-agent lookups. Per-step prompts are never hashed:
 * multi-step rows hash the mode label only.
 *
 * Fidelity rules:
 * - a row is recorded only for children that actually LAUNCHED (a child
 *   session was dispatched). Status alone cannot decide this: `stopRunner()`,
 *   `timeoutRunner()`, fail-fast skips, and usage-budget skips all relabel
 *   never-launched steps to terminal statuses (`stopped`, `failed`+`timedOut,
 *   `failed`+`skipped) before the run ends — the runner therefore threads an
 *   explicit `launched` fact per step. `pending` and `launched: false` steps
 *   get no row — unrun agents must not accumulate attempts or failures;
 * - run-level terminal flags (stopped/interrupted/timedOut) apply only to steps
 *   that did not reach a terminal state of their own — a child that completed
 *   or failed BEFORE a sibling was interrupted keeps its own outcome, because
 *   recordRun() lets those flags override the exit code;
 * - self-terminal steps carry their own timedOut/stopped flags instead.
 */
export function planBackgroundRunHistory(input: {
	steps: readonly unknown[];
	resultMode: string;
	statusSteps: ReadonlyArray<{ agent?: unknown; status?: unknown; durationMs?: number; timedOut?: boolean; stopped?: boolean; launched?: boolean }>;
	stepResults?: ReadonlyArray<{ processSignal?: unknown } | undefined>;
	runDurationMs: number;
	stopped?: boolean;
	interrupted?: boolean;
	timedOut?: boolean;
}): BackgroundRunHistoryEntry[] {
	const runTerminal: BackgroundRunHistoryEntry["terminal"] = {
		...(input.stopped ? { stopped: true } : {}),
		...(input.interrupted ? { interrupted: true } : {}),
		...(input.timedOut ? { timedOut: true } : {}),
	};
	const task = backgroundRunHistoryTask(input.steps, input.resultMode);
	const rows: BackgroundRunHistoryEntry[] = [];
	for (const [index, step] of input.statusSteps.entries()) {
		if (typeof step.agent !== "string" || !step.agent) continue;
		// `launched === false` marks steps the runner never dispatched a child
		// session for, regardless of the status they were later relabeled to.
		if (step.status === "pending" || step.launched === false) continue;
		const succeeded = TERMINAL_STEP_STATUSES.has(step.status as string);
		const ownTerminal: BackgroundRunHistoryEntry["terminal"] = {
			...(step.timedOut === true ? { timedOut: true } : {}),
			...(step.stopped === true ? { stopped: true } : {}),
		};
		// A step that reached its own terminal state (completed, or failed/rejected
		// before a sibling was interrupted) keeps its own outcome; run-wide flags
		// would relabel it in recordRun().
		const terminal = SELF_TERMINAL_STEP_STATUSES.has(step.status as string) ? ownTerminal : { ...runTerminal, ...ownTerminal };
		const processSignal = input.stepResults?.[index]?.processSignal;
		rows.push({
			agent: step.agent,
			task,
			exitCode: succeeded ? 0 : 1,
			durationMs: typeof step.durationMs === "number" ? step.durationMs : input.runDurationMs,
			terminal: processSignal === undefined ? terminal : { ...terminal, processSignal: typeof processSignal === "string" ? processSignal : null },		});
	}
	return rows;
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
