import * as fs from "node:fs";
import * as path from "node:path";
import { writePrivateAtomicJson } from "../shared/atomic-json.ts";
import type { WorkflowReceipt, WorkflowReceiptEntry, WorkflowReceiptState } from "../shared/types.ts";
import type { WorkflowReceiptResumeReference, WorkflowScriptChildResult } from "./scripted-workflow.ts";

export type { WorkflowReceipt, WorkflowReceiptEntry, WorkflowReceiptState } from "../shared/types.ts";

export const WORKFLOW_RECEIPT_VERSION = 1;
export const WORKFLOW_RECEIPT_FILE = "workflow-receipt.json";

const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function assertSafeRunId(value: string, label: string): string {
	const normalized = value.trim();
	if (!normalized || path.basename(normalized) !== normalized || normalized === "." || normalized === "..") {
		throw new Error(`${label} must be an exact workflow run id, not a path or prefix.`);
	}
	return normalized;
}

function assertKey(value: string, label: string): string {
	if (!KEY_PATTERN.test(value)) throw new Error(`${label} is invalid.`);
	return value;
}

export function workflowReceiptPath(asyncDirRoot: string, workflowRunId: string): string {
	return path.join(asyncDirRoot, assertSafeRunId(workflowRunId, "workflowRunId"), WORKFLOW_RECEIPT_FILE);
}

export function buildWorkflowReceipt(input: {
	workflowRunId: string;
	state: WorkflowReceiptState;
	children: WorkflowScriptChildResult[];
	createdAt?: number;
}): WorkflowReceipt {
	const workflowRunId = assertSafeRunId(input.workflowRunId, "workflowRunId");
	const entries: Record<string, WorkflowReceiptEntry> = Object.create(null) as Record<string, WorkflowReceiptEntry>;
	for (const child of input.children) {
		const key = assertKey(child.key, "workflow receipt child key");
		if (entries[key]) throw new Error(`Workflow receipt has duplicate child key '${key}'.`);
		const runIds = [...new Set((child.continuation?.runIds ?? (child.runId ? [child.runId] : [])).filter((runId) => typeof runId === "string" && runId.trim()).map((runId) => runId.trim()))];
		const latestRunId = runIds.at(-1);
		entries[key] = {
			key,
			...(child.agent ? { agent: child.agent } : {}),
			...(child.requestedContext ? { requestedContext: child.requestedContext } : {}),
			...(child.resolvedContext ? { resolvedContext: child.resolvedContext } : {}),
			...(latestRunId ? { latestRunId } : {}),
			resumability: child.resumability ?? { state: "not-resumable", reason: child.runId ? "resumability was not recorded" : "child produced no run id" },
			...(child.outputReference ? { outputReference: child.outputReference } : {}),
			continuation: { runIds },
		};
	}
	return { version: WORKFLOW_RECEIPT_VERSION, workflowRunId, state: input.state, createdAt: input.createdAt ?? Date.now(), entries };
}

export function writeWorkflowReceipt(asyncDir: string, receipt: WorkflowReceipt): string {
	const receiptPath = path.join(asyncDir, WORKFLOW_RECEIPT_FILE);
	writePrivateAtomicJson(receiptPath, receipt);
	return receiptPath;
}

function parseEntry(value: unknown, key: string, source: string): WorkflowReceiptEntry {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid workflow receipt '${source}': entry '${key}' must be an object.`);
	const entry = value as Record<string, unknown>;
	if (entry.key !== key) throw new Error(`Invalid workflow receipt '${source}': entry '${key}' has a mismatched key.`);
	const latestRunId = entry.latestRunId;
	if (latestRunId !== undefined && (typeof latestRunId !== "string" || !latestRunId.trim())) throw new Error(`Invalid workflow receipt '${source}': entry '${key}' latestRunId must be non-empty.`);
	const continuation = entry.continuation;
	if (!continuation || typeof continuation !== "object" || Array.isArray(continuation) || !Array.isArray((continuation as Record<string, unknown>).runIds)) {
		throw new Error(`Invalid workflow receipt '${source}': entry '${key}' continuation is missing.`);
	}
	const runIds = (continuation as { runIds: unknown[] }).runIds;
	if (runIds.some((runId) => typeof runId !== "string" || !runId.trim())) throw new Error(`Invalid workflow receipt '${source}': entry '${key}' continuation contains an invalid run id.`);
	if (latestRunId !== undefined && runIds.at(-1) !== latestRunId) throw new Error(`Workflow receipt '${source}' entry '${key}' is stale: latestRunId does not match its continuation lineage.`);
	const resumability = entry.resumability;
	if (!resumability || typeof resumability !== "object" || Array.isArray(resumability)) throw new Error(`Invalid workflow receipt '${source}': entry '${key}' resumability is missing.`);
	const state = (resumability as Record<string, unknown>).state;
	if (state !== "resumable" && state !== "not-resumable") throw new Error(`Invalid workflow receipt '${source}': entry '${key}' resumability state is invalid.`);
	const reason = (resumability as Record<string, unknown>).reason;
	if (state === "not-resumable" && (typeof reason !== "string" || !reason.trim())) throw new Error(`Invalid workflow receipt '${source}': entry '${key}' non-resumable reason is missing.`);
	return value as WorkflowReceiptEntry;
}

export function readWorkflowReceipt(asyncDirRoot: string, workflowRunId: string): WorkflowReceipt {
	const receiptPath = workflowReceiptPath(asyncDirRoot, workflowRunId);
	let value: unknown;
	try {
		value = JSON.parse(fs.readFileSync(receiptPath, "utf-8")) as unknown;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`Workflow receipt '${workflowRunId}' was not found.`);
		throw new Error(`Workflow receipt '${workflowRunId}' could not be read: ${error instanceof Error ? error.message : String(error)}`, { cause: error instanceof Error ? error : undefined });
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid workflow receipt '${receiptPath}': expected an object.`);
	const receipt = value as Record<string, unknown>;
	if (receipt.version !== WORKFLOW_RECEIPT_VERSION) throw new Error(`Invalid workflow receipt '${receiptPath}': unsupported version.`);
	if (receipt.workflowRunId !== workflowRunId) throw new Error(`Workflow receipt '${receiptPath}' is stale: workflowRunId does not match.`);
	if (receipt.state !== "complete" && receipt.state !== "failed" && receipt.state !== "paused" && receipt.state !== "stopped") {
		throw new Error(`Workflow receipt '${receiptPath}' is stale: workflow is not terminal.`);
	}
	if (typeof receipt.createdAt !== "number" || !Number.isFinite(receipt.createdAt)) throw new Error(`Invalid workflow receipt '${receiptPath}': createdAt is invalid.`);
	if (!receipt.entries || typeof receipt.entries !== "object" || Array.isArray(receipt.entries)) throw new Error(`Invalid workflow receipt '${receiptPath}': entries must be an object.`);
	const entries: Record<string, WorkflowReceiptEntry> = Object.create(null) as Record<string, WorkflowReceiptEntry>;
	for (const [key, entry] of Object.entries(receipt.entries as Record<string, unknown>)) entries[assertKey(key, "workflow receipt key")] = parseEntry(entry, key, receiptPath);
	return { version: 1, workflowRunId, state: receipt.state, createdAt: receipt.createdAt, entries };
}

export function resolveWorkflowReceiptResumeEntry(input: {
	reference: WorkflowReceiptResumeReference;
	asyncDirRoot: string;
	assertResumable?: (runId: string) => void;
}): WorkflowReceiptEntry {
	if (input.reference.latest !== true) throw new Error("Keyed workflow receipt resume requires latest: true.");
	const key = assertKey(input.reference.key, "keyed resume key");
	const receipt = readWorkflowReceipt(input.asyncDirRoot, input.reference.workflowRunId.trim());
	const entry = receipt.entries[key];
	if (!entry) throw new Error(`Workflow receipt '${receipt.workflowRunId}' has no child key '${key}'.`);
	if (entry.resumability.state !== "resumable") throw new Error(`Workflow receipt '${receipt.workflowRunId}' child '${key}' is not resumable: ${entry.resumability.reason}.`);
	const runId = entry.latestRunId;
	if (!runId) throw new Error(`Workflow receipt '${receipt.workflowRunId}' child '${key}' has no retained run id.`);
	input.assertResumable?.(runId);
	return entry;
}

export function resolveWorkflowReceiptResume(input: {
	reference: WorkflowReceiptResumeReference;
	asyncDirRoot: string;
	assertResumable?: (runId: string) => void;
}): string {
	const entry = resolveWorkflowReceiptResumeEntry(input);
	const runId = entry.latestRunId;
	if (!runId) throw new Error(`Workflow receipt child '${entry.key}' has no retained run id.`);
	return runId;
}
