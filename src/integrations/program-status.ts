import { createHash } from "node:crypto";
import type { AsyncJobState } from "../shared/types.ts";
import { sanitizeDisplayText } from "../shared/display-text.ts";

/**
 * Reports each subagent run to the terminal with OSC 7501, the Program Status Protocol
 * (https://www.superlogical.com/rex/docs/build/program-status). Pi owns the root record;
 * runs live under `subagents/`.
 */

type ProgramState = "working" | "blocked" | "done" | "error" | "idle";

const ID_ROOT = "subagents";
const MAX_RECORDS = 64;
const MAX_MSG_BYTES = 2048;
const MAX_TITLE_BYTES = 192;
const RUN_SEGMENT_CHARS = 12;
// 32-character segment limit, minus the run part and the `.` separator.
const MAX_KEY_CHARS = 32 - RUN_SEGMENT_CHARS - 1;

export interface ProgramStatusReporterOptions {
	/** `programStatus` from the user config; only `false` turns it off. */
	enabled: boolean;
	getJobs: () => Iterable<AsyncJobState>;
	/** Pending native supervisor requests that expect a reply. */
	getPendingRequests: () => Iterable<{ id: string; runId: string }>;
	write?: (data: string) => void;
	isTTY?: boolean;
	env?: Record<string, string | undefined>;
}

export interface ProgramStatusReporter {
	/** Only the interactive TUI session on a real terminal reports. */
	sessionStarted(input: { hasUI: boolean; mode?: string }): void;
	sync(): void;
	agentStarted(): void;
	agentSettled(): void;
	/**
	 * Stops reporting. Unless Pi is quitting, clears every record sent, since the runtime that replaces
	 * this one cannot clear them. On quit, finished records stay for the user, as the spec intends.
	 */
	dispose(shutdownReason?: string): void;
}

// `.` is left out so it can only appear as the run/key separator.
function segment(value: string): string {
	return value.replace(/[^A-Za-z0-9_+-]/g, "-");
}

function runSegment(runId: string): string {
	return segment(runId.replace(/-/g, "").slice(0, RUN_SEGMENT_CHARS));
}

// A clear removes the record's descendants too, so workflow children are siblings of their run,
// never nested under another record of ours: `subagents/<run>.<key>`, one segment of at most 32 characters.
// A key that needs any change gets a hash of the original, so keys differing only in replaced characters stay distinct.
function keySegment(key: string): string {
	if (key.length <= MAX_KEY_CHARS && /^[A-Za-z0-9_+-]+$/.test(key)) return key;
	return `${segment(key).slice(0, 12)}-${createHash("sha1").update(key).digest("hex").slice(0, 6)}`;
}

function recordId(job: AsyncJobState): string | undefined {
	if (job.parentWorkflowRunId && job.workflowKey) {
		const parent = runSegment(job.parentWorkflowRunId);
		return parent ? `${ID_ROOT}/${parent}.${keySegment(job.workflowKey)}` : undefined;
	}
	const run = runSegment(job.asyncId);
	return run ? `${ID_ROOT}/${run}` : undefined;
}

function programState(job: AsyncJobState, blocked: boolean): ProgramState {
	switch (job.status) {
		case "queued":
		case "running":
			return blocked ? "blocked" : "working";
		case "complete":
			return "done";
		case "failed":
		case "partial":
		case "rejected":
			return "error";
		case "stopped":
		case "paused":
			return "idle";
	}
}

function jobLabel(job: AsyncJobState): string {
	if (job.workflowKey) return job.workflowKey;
	if (job.mode === "workflow") return "workflow";
	const agents = [...new Set(job.agents ?? [])];
	if (agents.length === 0) return "subagent";
	return agents.length > 3 ? `${agents.slice(0, 3).join(", ")} +${agents.length - 3}` : agents.join(", ");
}

// Prompt text never goes into the record: it is shown outside the terminal grid.
function message(job: AsyncJobState, state: ProgramState): string {
	switch (state) {
		case "working":
			return job.currentTool ? `Running ${job.currentTool}` : "Running";
		case "blocked":
			return "Waiting for a reply";
		case "done":
			return "Finished";
		case "error":
			return job.status === "partial" ? "Finished with failures" : job.status === "rejected" ? "Rejected" : "Failed";
		case "idle":
			return job.status === "paused" ? "Paused" : "Stopped";
	}
}

function encodeText(text: string, maxBytes: number): string {
	let bytes = Buffer.from(sanitizeDisplayText(text), "utf-8");
	if (bytes.length > maxBytes) {
		let end = maxBytes;
		while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
		bytes = bytes.subarray(0, end);
	}
	return bytes.toString("base64");
}

function programStatusReport(fields: { state: ProgramState | "clear"; id: string; kind?: "question"; title?: string; msg?: string }): string {
	const pairs = [`state=${fields.state}`, `id=${fields.id}`];
	if (fields.state !== "clear") pairs.push("app=pi-subagents");
	if (fields.kind) pairs.push(`kind=${fields.kind}`);
	if (fields.title !== undefined) pairs.push(`title=${encodeText(fields.title, MAX_TITLE_BYTES)}`);
	if (fields.msg !== undefined) pairs.push(`msg=${encodeText(fields.msg, MAX_MSG_BYTES)}`);
	return `\x1b]7501;${pairs.join(":")}\x1b\\`;
}

export function registerProgramStatusReporter(options: ProgramStatusReporterOptions): ProgramStatusReporter {
	const write = options.write ?? ((data: string) => { process.stdout.write(data); });
	const env = options.env ?? process.env;
	const isTTY = options.isTTY ?? process.stdout.isTTY === true;
	const sent = new Map<string, string>();
	let active = false;
	let parentIdle = true;
	// A request counts as waiting on the user only after the parent settled without answering it.
	let unansweredAtSettle = new Set<string>();
	// Pi clears every OSC 7501 record when it suspends on Ctrl+Z and re-reports only its own root
	// record on resume, so the records this extension shows are sent again.
	const resend = (): void => {
		if (!active) return;
		for (const report of sent.values()) write(report);
	};
	let listeningForResume = false;

	// The shown records are recomputed from the current jobs on every sync: active runs first, then
	// finished ones, each most recently updated first, up to the cap. Only the difference is written.
	const sync = (): void => {
		if (!active) return;
		const blockedRuns = new Set<string>();
		if (parentIdle) {
			for (const request of options.getPendingRequests()) {
				if (unansweredAtSettle.has(request.id)) blockedRuns.add(request.runId);
			}
		}
		const candidates: Array<{ id: string; report: string; active: boolean; updatedAt: number }> = [];
		for (const job of options.getJobs()) {
			const id = recordId(job);
			if (!id) continue;
			const state = programState(job, blockedRuns.has(job.asyncId));
			const report = programStatusReport({ state, id, ...(state === "blocked" ? { kind: "question" as const } : {}), title: jobLabel(job), msg: message(job, state) });
			candidates.push({ id, report, active: state === "working" || state === "blocked", updatedAt: job.updatedAt ?? job.startedAt ?? 0 });
		}
		candidates.sort((left, right) => Number(right.active) - Number(left.active) || right.updatedAt - left.updatedAt || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
		const desired = new Map<string, string>();
		for (const candidate of candidates) {
			if (desired.size === MAX_RECORDS) break;
			if (!desired.has(candidate.id)) desired.set(candidate.id, candidate.report);
		}
		for (const id of sent.keys()) {
			if (desired.has(id)) continue;
			sent.delete(id);
			write(programStatusReport({ state: "clear", id }));
		}
		for (const [id, report] of desired) {
			if (sent.get(id) === report) continue;
			sent.set(id, report);
			write(report);
		}
	};

	return {
		sessionStarted({ hasUI, mode }) {
			active = options.enabled && hasUI && mode === "tui" && isTTY && env.TERM !== "dumb" && env.PI_PROGRAM_STATUS !== "0";
			if (active && !listeningForResume && process.platform !== "win32") {
				process.on("SIGCONT", resend);
				listeningForResume = true;
			}
			sync();
		},
		sync,
		agentStarted() {
			parentIdle = false;
			sync();
		},
		agentSettled() {
			parentIdle = true;
			unansweredAtSettle = new Set([...options.getPendingRequests()].map((request) => request.id));
			sync();
		},
		dispose(shutdownReason) {
			if (active && shutdownReason !== "quit") {
				for (const id of sent.keys()) write(programStatusReport({ state: "clear", id }));
			}
			sent.clear();
			active = false;
			if (listeningForResume) {
				process.off("SIGCONT", resend);
				listeningForResume = false;
			}
		},
	};
}
