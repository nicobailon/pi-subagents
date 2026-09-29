import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { readRecentTerminalRunIndex } from "../runs/background/terminal-run-index.ts";
import { readStatus } from "../shared/utils.ts";
import { workflowRunParamsFingerprint, type WorkflowScriptChildResult } from "./scripted-workflow.ts";

/** Stop cause recorded when the extension runtime that owned the workflow was replaced (/reload, resume, project switch). */
const WORKFLOW_STOP_CAUSE_RUNTIME_REPLACED = "runtime-replaced";
type WorkflowStopCause = typeof WORKFLOW_STOP_CAUSE_RUNTIME_REPLACED;

const WORKFLOW_CHILD_JOURNAL_FILE = "workflow-children.jsonl";

export const WORKFLOW_RUNTIME_REPLACED_RELAUNCH_NOTICE = "Async children that were still running keep running; relaunch the same workflowScript with the same args to reuse finished children and re-attach to running ones.";

/** Abort reason for workflow controllers torn down by runtime replacement; carries the cause as data, not text. */
export function runtimeReplacedAbortReason(): Error {
	return Object.assign(new Error("Workflow stopped because the extension session was replaced or reloaded."), { workflowStopCause: WORKFLOW_STOP_CAUSE_RUNTIME_REPLACED });
}

export function workflowStopCause(reason: unknown): WorkflowStopCause | undefined {
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
			// SAFETY: every field is type-checked below before a record is stored.
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

/**
 * The newest terminal workflow of this session with the same script and args,
 * when that run stopped because its runtime was replaced.
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
		return status.workflow.stopCause === WORKFLOW_STOP_CAUSE_RUNTIME_REPLACED ? readWorkflowChildJournal(runId, asyncDir) : undefined;
	}
	return undefined;
}

/** A settled match is reusable only when that child succeeded; failed or stopped children run again. */
export function matchWorkflowReuse(source: WorkflowReuseSource, key: string, fingerprint: string): WorkflowReuseMatch | undefined {
	const settled = source.settled.get(key);
	if (settled) return settled.fingerprint === fingerprint && settled.result.ok ? { kind: "settled", result: settled.result } : undefined;
	const started = source.started.get(key);
	return started?.fingerprint === fingerprint ? { kind: "started", runId: started.runId } : undefined;
}
