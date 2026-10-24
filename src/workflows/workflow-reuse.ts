import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { readRecentTerminalRunIndex } from "../runs/background/terminal-run-index.ts";
import { reconcileAsyncRun } from "../runs/background/stale-run-reconciler.ts";
import { readStatus } from "../shared/utils.ts";
import type { AsyncStatus } from "../shared/types.ts";
import { workflowResumeClaimState } from "./workflow-resume-claim.ts";
import { workflowRunParamsFingerprint, type WorkflowScriptChildResult } from "./scripted-workflow.ts";
import { isReusableWorkflowStopCause, WORKFLOW_STOP_CAUSE_RUNTIME_REPLACED } from "./workflow-stop-cause.ts";

const WORKFLOW_CHILD_JOURNAL_FILE = "workflow-children.jsonl";

/** What a runtime replacement left; the notice's resume line says how the run continues. */
export const WORKFLOW_RUNTIME_REPLACED_STOP_NOTICE = "Async children that were still running keep running, and finished children are kept.";

/** Abort reason for workflow controllers torn down by runtime replacement; carries the cause as data, not text. */
export function runtimeReplacedAbortReason(): Error {
	return Object.assign(new Error("Workflow stopped because the extension session was replaced or reloaded."), { workflowStopCause: WORKFLOW_STOP_CAUSE_RUNTIME_REPLACED });
}

export function workflowStopCause(reason: unknown): typeof WORKFLOW_STOP_CAUSE_RUNTIME_REPLACED | undefined {
	return reason instanceof Error && "workflowStopCause" in reason && reason.workflowStopCause === WORKFLOW_STOP_CAUSE_RUNTIME_REPLACED
		? WORKFLOW_STOP_CAUSE_RUNTIME_REPLACED
		: undefined;
}

function sha256(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

export function workflowScriptDigest(script: string): string {
	return sha256(script);
}

/** Hash of the canonical launch params the script host uses to detect duplicate keys. */
export function workflowChildFingerprint(params: Record<string, unknown>): string {
	return sha256(workflowRunParamsFingerprint(params));
}

type WorkflowChildJournalRecord =
	| { type: "start"; key: string; fingerprint: string; runId: string }
	| { type: "settle"; key: string; fingerprint: string; result: WorkflowScriptChildResult };

/** Appends synchronously. A lost record only means a later relaunch runs that child again. */
export function appendWorkflowChildJournal(workflowAsyncDir: string, record: WorkflowChildJournalRecord): void {
	const journalPath = path.join(workflowAsyncDir, WORKFLOW_CHILD_JOURNAL_FILE);
	try {
		fs.appendFileSync(journalPath, `${JSON.stringify(record)}\n`, "utf-8");
	} catch (error) {
		console.error(`Failed to append workflow child journal '${journalPath}':`, error);
	}
}

interface WorkflowReuseSource {
	runId: string;
	started: Map<string, { fingerprint: string; runId: string }>;
	settled: Map<string, { fingerprint: string; result: WorkflowScriptChildResult }>;
}

type WorkflowReuseMatch =
	| { kind: "settled"; result: WorkflowScriptChildResult }
	| { kind: "started"; runId: string };

function readWorkflowChildJournal(runId: string, workflowAsyncDir: string): WorkflowReuseSource {
	const source: WorkflowReuseSource = { runId, started: new Map(), settled: new Map() };
	let text = "";
	try {
		text = fs.readFileSync(path.join(workflowAsyncDir, WORKFLOW_CHILD_JOURNAL_FILE), "utf-8");
	} catch {
		return source;
	}
	for (const line of text.split("\n")) {
		let record: Partial<WorkflowChildJournalRecord> | undefined;
		try {
			record = line.trim() ? JSON.parse(line) as Partial<WorkflowChildJournalRecord> : undefined;
		} catch {
			continue;
		}
		if (!record || typeof record.key !== "string" || typeof record.fingerprint !== "string") continue;
		if (record.type === "start" && typeof record.runId === "string") {
			source.started.set(record.key, { fingerprint: record.fingerprint, runId: record.runId });
		} else if (record.type === "settle" && record.result && typeof record.result === "object") {
			source.settled.set(record.key, { fingerprint: record.fingerprint, result: record.result });
		}
	}
	return source;
}
const WORKFLOW_REUSE_CHAIN_MAX_LINKS = 16;

/** A run directory name, never a path; a status file is parsed, not validated, so a corrupt `reusedFrom` may be any JSON value. */
export function isRunName(runId: unknown): runId is string {
	return typeof runId === "string" && runId === path.basename(runId) && runId !== "." && runId !== "..";
}

/**
 * The head run's journal plus the journals of the runs it was relaunched from (`workflow.reusedFrom`).
 * A child's start record is written only once it gets a concurrency slot, so a key the head never
 * reached is still in an earlier run's journal. For each key the newest run that recorded it wins.
 */
function readWorkflowReuseChain(asyncDirRoot: string, headRunId: string, headStatus: AsyncStatus): WorkflowReuseSource {
	const source = readWorkflowChildJournal(headRunId, path.join(asyncDirRoot, headRunId));
	const visited = new Set([headRunId]);
	let next: unknown = headStatus.workflow?.reusedFrom;
	for (let links = 0; isRunName(next) && links < WORKFLOW_REUSE_CHAIN_MAX_LINKS && !visited.has(next); links++) {
		visited.add(next);
		const asyncDir = path.join(asyncDirRoot, next);
		let status: ReturnType<typeof readStatus>;
		try {
			status = readStatus(asyncDir);
		} catch {
			break;
		}
		if (status?.mode !== "workflow" || status.workflow?.scriptDigest !== headStatus.workflow?.scriptDigest) break;
		const link = readWorkflowChildJournal(next, asyncDir);
		for (const key of new Set([...link.started.keys(), ...link.settled.keys()])) {
			if (source.started.has(key) || source.settled.has(key)) continue;
			const started = link.started.get(key);
			const settled = link.settled.get(key);
			if (started) source.started.set(key, started);
			if (settled) source.settled.set(key, settled);
		}
		next = status.workflow?.reusedFrom;
	}
	return source;
}

/** Why a relaunch of `runId` is refused when another relaunch already continues it. */
export function claimedWorkflowRunRefusal(runId: string, claim: { kind: "resumed"; newRunId: string } | { kind: "busy"; pid: number } | { kind: "unreadable" }, named: boolean): string {
	const run = `${named ? "options.reuseFrom: workflow" : "Workflow"} run '${runId}'`;
	if (claim.kind === "resumed") return `${run} was resumed as ${claim.newRunId}; wait on it or stop it.`;
	if (claim.kind === "busy") return `${run} is being resumed by pid ${claim.pid}; wait for it.`;
	return `${run} has a resume claim that cannot be read; wait or remove it.`;
}

function assertWorkflowRunNotClaimed(asyncDir: string, runId: string, named: boolean, claimOwnerRunId?: string): void {
	const claim = workflowResumeClaimState(asyncDir);
	if (claim.kind === "none" || (claim.kind !== "unreadable" && claim.newRunId === claimOwnerRunId)) return;
	throw new Error(claimedWorkflowRunRefusal(runId, claim, named));
}

/**
 * The newest terminal workflow of this session with the same script and args,
 * when that run stopped because its runtime was replaced or its Pi process exited.
 * Throws when another relaunch already continues that run.
 */
export function findWorkflowReuseSource(asyncDirRoot: string, sessionId: string, scriptDigest: string, argsDigest: string | undefined): WorkflowReuseSource | undefined {
	let runIds: string[];
	try {
		runIds = readRecentTerminalRunIndex(asyncDirRoot, { sessionId });
	} catch {
		return undefined;
	}
	for (const runId of runIds) {
		const asyncDir = path.join(asyncDirRoot, runId);
		let status: ReturnType<typeof readStatus>;
		try {
			status = readStatus(asyncDir);
		} catch {
			continue;
		}
		if (status?.mode !== "workflow" || status.workflow?.scriptDigest !== scriptDigest || status.workflow.argsDigest !== argsDigest) continue;
		if (!isReusableWorkflowStopCause(status.workflow.stopCause)) return undefined;
		assertWorkflowRunNotClaimed(asyncDir, runId, false);
		return readWorkflowReuseChain(asyncDirRoot, runId, status);
	}
	return undefined;
}

/**
 * The interrupted workflow run named by `options.reuseFrom`, from any session. Only the script
 * must match: each child is still reused only when its key and launch params match. The run is
 * reconciled first, so a run whose Pi process died is marked `owner-exited` before it is read.
 */
export function readNamedWorkflowReuseSource(asyncDirRoot: string, runId: string, scriptDigest: string, cwd: string, claimOwnerRunId?: string): WorkflowReuseSource {
	// A user-supplied id: it must name one run directory, never a path.
	const runName = isRunName(runId);
	if (runName) reconcileAsyncRun(path.join(asyncDirRoot, runId));
	const status = runName ? readStatus(path.join(asyncDirRoot, runId)) : null;
	if (!status) throw new Error(`options.reuseFrom: workflow run '${runId}' was not found.`);
	if (status.mode !== "workflow") throw new Error(`options.reuseFrom: run '${runId}' is not a workflow run.`);
	if (!isReusableWorkflowStopCause(status.workflow?.stopCause)) throw new Error(`options.reuseFrom: workflow run '${runId}' did not stop because its session was replaced or its Pi process exited, so its children cannot be reused.`);
	if (status.workflow.scriptDigest !== scriptDigest) throw new Error(`options.reuseFrom: workflow run '${runId}' ran a different workflow script.`);
	if (status.cwd !== cwd) throw new Error(`options.reuseFrom: workflow run '${runId}' ran in '${status.cwd}', not '${cwd}'.`);
	assertWorkflowRunNotClaimed(path.join(asyncDirRoot, runId), runId, true, claimOwnerRunId);
	return readWorkflowReuseChain(asyncDirRoot, runId, status);
}

/** A settled match is reusable only when that child succeeded; failed or stopped children run again. */
export function matchWorkflowReuse(source: WorkflowReuseSource, key: string, fingerprint: string): WorkflowReuseMatch | undefined {
	const settled = source.settled.get(key);
	if (settled) return settled.fingerprint === fingerprint && settled.result.ok ? { kind: "settled", result: settled.result } : undefined;
	const started = source.started.get(key);
	return started?.fingerprint === fingerprint ? { kind: "started", runId: started.runId } : undefined;
}
