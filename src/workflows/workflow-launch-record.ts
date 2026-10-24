import * as fs from "node:fs";
import * as path from "node:path";
import { writeAtomicJson } from "../shared/atomic-json.ts";

const WORKFLOW_LAUNCH_RECORD_FILE = "launch.json";

/**
 * The public launch of an async top-level workflow, saved in its run directory so the run can be
 * relaunched later. A named resource is saved by name (its `runs.host` permit cannot be saved);
 * structured tasks/chain launches save no params, so they cannot be relaunched from this record.
 */
export type WorkflowLaunchRecord =
	| { version: 1; source: "script" | "resource"; params: Record<string, unknown>; scriptDigest: string }
	| { version: 1; source: "structured"; scriptDigest: string };

type WorkflowLaunchRecordRead =
	| { ok: true; record: WorkflowLaunchRecord }
	| { ok: false; missing: boolean; error: string };

function launchRecordPath(asyncDir: string): string {
	return path.join(asyncDir, WORKFLOW_LAUNCH_RECORD_FILE);
}

/** Throws on a write failure; the launch must fail rather than start a run it cannot relaunch. */
export function writeWorkflowLaunchRecord(asyncDir: string, record: WorkflowLaunchRecord): void {
	writeAtomicJson(launchRecordPath(asyncDir), record);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function invalid(error: string): WorkflowLaunchRecordRead {
	return { ok: false, missing: false, error };
}

export function readWorkflowLaunchRecord(asyncDir: string): WorkflowLaunchRecordRead {
	let text: string;
	try {
		text = fs.readFileSync(launchRecordPath(asyncDir), "utf-8");
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
	if (value.version !== 1) return invalid("version must be 1");
	if (typeof value.scriptDigest !== "string" || !value.scriptDigest) return invalid("scriptDigest must be a non-empty string");
	if (value.source === "structured") return { ok: true, record: { version: 1, source: "structured", scriptDigest: value.scriptDigest } };
	if (value.source !== "script" && value.source !== "resource") return invalid("source must be \"script\", \"resource\", or \"structured\"");
	if (!isPlainObject(value.params)) return invalid("params must be an object");
	return { ok: true, record: { version: 1, source: value.source, params: value.params, scriptDigest: value.scriptDigest } };
}
