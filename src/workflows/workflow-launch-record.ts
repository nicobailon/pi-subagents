import * as fs from "node:fs";
import * as path from "node:path";
import { parseSubagentCapabilityCeiling, type ResolvedSubagentCapabilityCeiling } from "../runs/shared/capability-ceiling.ts";
import { runLaunchDir } from "../runs/shared/run-launch-folder.ts";
import { writeAtomicJson } from "../shared/atomic-json.ts";

const WORKFLOW_LAUNCH_RECORD_FILE = "launch.json";

/**
 * The public launch of an async top-level workflow, saved so the run can be relaunched later. A
 * named resource is saved by name (its `runs.host` permit cannot be saved); structured tasks/chain
 * launches and internal ones (schedule ticks, prompt-template delegation) save no params, so they
 * cannot be relaunched from this record; their record still gives a child revive its ceiling.
 * The record is the only source of a relaunch's owner and capability ceiling. It lives outside the
 * run directory because a run behind a runner launcher can write its own directory.
 */
export type WorkflowLaunch = { source: "script" | "resource"; params: Record<string, unknown> } | { source: "structured" } | { source: "internal" };
export type WorkflowLaunchRecord = WorkflowLaunch & {
	version: 2;
	scriptDigest: string;
	/** The session that launched the run; only it, or a session that replaced it, may relaunch it. */
	sessionId: string;
	admissionCapabilityCeiling?: ResolvedSubagentCapabilityCeiling;
};

type WorkflowLaunchRecordRead =
	| { ok: true; record: WorkflowLaunchRecord }
	| { ok: false; missing: boolean; error: string };

function launchRecordPath(asyncDirRoot: string, runId: string): string {
	return path.join(runLaunchDir(asyncDirRoot, runId), WORKFLOW_LAUNCH_RECORD_FILE);
}

/** Throws on a write failure; the launch must fail rather than start a run it cannot relaunch. */
export function writeWorkflowLaunchRecord(asyncDirRoot: string, runId: string, record: WorkflowLaunchRecord): void {
	writeAtomicJson(launchRecordPath(asyncDirRoot, runId), record);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function invalid(error: string): WorkflowLaunchRecordRead {
	return { ok: false, missing: false, error };
}

export function readWorkflowLaunchRecord(asyncDirRoot: string, runId: string): WorkflowLaunchRecordRead {
	let text: string;
	try {
		text = fs.readFileSync(launchRecordPath(asyncDirRoot, runId), "utf-8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ok: false, missing: true, error: "launch.json is missing" };
		return invalid(`could not be read: ${error instanceof Error ? error.message : String(error)}`);
	}
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (error) {
		return invalid(`not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!isPlainObject(value)) return invalid("not a JSON object");
	if (value.version !== 2) return invalid("version must be 2");
	if (typeof value.scriptDigest !== "string" || !value.scriptDigest) return invalid("scriptDigest must be a non-empty string");
	if (typeof value.sessionId !== "string" || !value.sessionId) return invalid("sessionId must be a non-empty string");
	let admissionCapabilityCeiling: ResolvedSubagentCapabilityCeiling | undefined;
	try {
		if (value.admissionCapabilityCeiling !== undefined) admissionCapabilityCeiling = parseSubagentCapabilityCeiling(value.admissionCapabilityCeiling, "admissionCapabilityCeiling");
	} catch (error) {
		return invalid(error instanceof Error ? error.message : String(error));
	}
	const owner = {
		version: 2 as const,
		scriptDigest: value.scriptDigest,
		sessionId: value.sessionId,
		...(admissionCapabilityCeiling ? { admissionCapabilityCeiling } : {}),
	};
	if (value.source === "structured" || value.source === "internal") return { ok: true, record: { ...owner, source: value.source } };
	if (value.source !== "script" && value.source !== "resource") return invalid("source must be \"script\", \"resource\", \"structured\", or \"internal\"");
	if (!isPlainObject(value.params)) return invalid("params must be an object");
	return { ok: true, record: { ...owner, source: value.source, params: value.params } };
}
