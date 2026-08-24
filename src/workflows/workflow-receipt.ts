import * as fs from "node:fs";
import * as path from "node:path";
import { writePrivateAtomicJson } from "../shared/atomic-json.ts";
import type { ExternalCliReceiptMetadata, WorkflowReceipt, WorkflowReceiptEntry, WorkflowReceiptState } from "../shared/types.ts";
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
		const resumability = child.resumability ?? { state: "not-resumable", reason: child.runId ? "resumability was not recorded" : "child produced no run id" };
		if (resumability.state === "resumable" && !latestRunId) throw new Error(`Workflow receipt child '${key}' is resumable but has no retained run id.`);
		const base = {
			key,
			...(child.agent ? { agent: child.agent } : {}),
			...(child.requestedContext ? { requestedContext: child.requestedContext } : {}),
			...(child.resolvedContext ? { resolvedContext: child.resolvedContext } : {}),
			...(child.outputReference ? { outputReference: child.outputReference } : {}),
			...(child.externalAdapter ? { externalAdapter: child.externalAdapter } : {}),
			continuation: { runIds },
		};
		entries[key] = resumability.state === "resumable"
			? { ...base, latestRunId: latestRunId!, resumability }
			: { ...base, ...(latestRunId ? { latestRunId } : {}), resumability };
	}
	return { version: WORKFLOW_RECEIPT_VERSION, workflowRunId, state: input.state, createdAt: input.createdAt ?? Date.now(), entries };
}

export function writeWorkflowReceipt(asyncDir: string, receipt: WorkflowReceipt): string {
	const receiptPath = path.join(asyncDir, WORKFLOW_RECEIPT_FILE);
	writePrivateAtomicJson(receiptPath, receipt);
	return receiptPath;
}

const EXTERNAL_CLI_CAPABILITIES = {
	stop: true,
	steer: false,
	resume: false,
	structuredOutput: false,
	toolEvents: false,
	supervisor: "unsupported",
	forkContext: false,
	extensionBindings: false,
} as const;

function parseExternalCliReceiptMetadata(value: unknown, key: string, source: string): ExternalCliReceiptMetadata | undefined {
	if (value === undefined) return undefined;
	const label = `Invalid workflow receipt '${source}': entry '${key}' externalAdapter`;
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
	const metadata = value as Record<string, unknown>;
	const unknownMetadata = Object.keys(metadata).filter((field) => !["adapter", "capabilities", "safety", "outputArtifacts", "handoff", "supervisor", "nonResumableReason"].includes(field));
	if (unknownMetadata.length > 0) throw new Error(`${label} has unsupported fields: ${unknownMetadata.join(", ")}.`);
	const adapter = metadata.adapter;
	if (!adapter || typeof adapter !== "object" || Array.isArray(adapter)) throw new Error(`${label}.adapter must be an object.`);
	const adapterRecord = adapter as Record<string, unknown>;
	const unknownAdapter = Object.keys(adapterRecord).filter((field) => !["id", "version", "executionMode"].includes(field));
	if (unknownAdapter.length > 0) throw new Error(`${label}.adapter has unsupported fields: ${unknownAdapter.join(", ")}.`);
	if ((adapterRecord.id !== "external-cli" && adapterRecord.id !== "codex-exec" && adapterRecord.id !== "codex-exec-writer" && adapterRecord.id !== "claude-code" && adapterRecord.id !== "claude-code-writer" && adapterRecord.id !== "cursor-agent" && adapterRecord.id !== "cursor-agent-writer" && adapterRecord.id !== "grok-build") || adapterRecord.version !== 1 || adapterRecord.executionMode !== (adapterRecord.id === "cursor-agent" || adapterRecord.id === "cursor-agent-writer" || adapterRecord.id === "grok-build" ? "one-shot-prompt-file" : "one-shot-stdin")) throw new Error(`${label}.adapter is invalid.`);
	const capabilities = metadata.capabilities;
	if (!capabilities || typeof capabilities !== "object" || Array.isArray(capabilities)) throw new Error(`${label}.capabilities must be an object.`);
	const capabilityRecord = capabilities as Record<string, unknown>;
	const unknownCapabilities = Object.keys(capabilityRecord).filter((field) => !(field in EXTERNAL_CLI_CAPABILITIES));
	if (unknownCapabilities.length > 0) throw new Error(`${label}.capabilities has unsupported fields: ${unknownCapabilities.join(", ")}.`);
	for (const [capability, expected] of Object.entries(EXTERNAL_CLI_CAPABILITIES)) {
		if (capabilityRecord[capability] !== expected) throw new Error(`${label}.capabilities.${capability} is invalid.`);
	}
	const safety = metadata.safety;
	if (adapterRecord.id === "codex-exec") {
		if (!safety || typeof safety !== "object" || Array.isArray(safety)) throw new Error(`${label}.safety is missing.`);
		const safetyRecord = safety as Record<string, unknown>;
		const unknownSafety = Object.keys(safetyRecord).filter((field) => !["sandbox", "approvalPolicy", "ephemeral"].includes(field));
		if (unknownSafety.length > 0) throw new Error(`${label}.safety has unsupported fields: ${unknownSafety.join(", ")}.`);
		if (safetyRecord.sandbox !== "read-only" || safetyRecord.approvalPolicy !== "never" || safetyRecord.ephemeral !== true) throw new Error(`${label}.safety is invalid.`);
	} else if (adapterRecord.id === "codex-exec-writer") {
		if (!safety || typeof safety !== "object" || Array.isArray(safety)) throw new Error(`${label}.safety is missing.`);
		const safetyRecord = safety as Record<string, unknown>;
		const unknownSafety = Object.keys(safetyRecord).filter((field) => !["access", "sandbox", "approvalPolicy", "ephemeral"].includes(field));
		if (unknownSafety.length > 0) throw new Error(`${label}.safety has unsupported fields: ${unknownSafety.join(", ")}.`);
		if (safetyRecord.access !== "workspace-write" || safetyRecord.sandbox !== "workspace-write" || safetyRecord.approvalPolicy !== "never" || safetyRecord.ephemeral !== true) throw new Error(`${label}.safety is invalid.`);
	} else if (adapterRecord.id === "claude-code") {
		if (!safety || typeof safety !== "object" || Array.isArray(safety)) throw new Error(`${label}.safety is missing.`);
		const safetyRecord = safety as Record<string, unknown>;
		const legacy = safetyRecord.authentication === undefined;
		const unknownSafety = Object.keys(safetyRecord).filter((field) => !(legacy
			? ["permissionMode", "tools", "mcp", "settingSources", "sessionPersistence"]
			: ["access", "authentication", "permissionMode", "tools", "mcp", "settingSources", "userSettingsTrust", "sessionPersistence"]).includes(field));
		if (unknownSafety.length > 0) throw new Error(`${label}.safety has unsupported fields: ${unknownSafety.join(", ")}.`);
		if (legacy) {
			if (safetyRecord.permissionMode !== "plan" || safetyRecord.tools !== "none" || safetyRecord.mcp !== "empty-strict" || safetyRecord.settingSources !== "none" || safetyRecord.sessionPersistence !== false) throw new Error(`${label}.safety is invalid.`);
		} else if (safetyRecord.access !== "read-only" || safetyRecord.authentication !== "existing-cli-required" || safetyRecord.permissionMode !== "plan" || safetyRecord.tools !== "none" || safetyRecord.mcp !== "empty-strict" || safetyRecord.settingSources !== "user" || safetyRecord.userSettingsTrust !== "required" || safetyRecord.sessionPersistence !== false) throw new Error(`${label}.safety is invalid.`);
	} else if (adapterRecord.id === "claude-code-writer") {
		if (!safety || typeof safety !== "object" || Array.isArray(safety)) throw new Error(`${label}.safety is missing.`);
		const safetyRecord = safety as Record<string, unknown>;
		const unknownSafety = Object.keys(safetyRecord).filter((field) => !["access", "authentication", "permissionMode", "tools", "mcp", "settingSources", "userSettingsTrust", "sessionPersistence"].includes(field));
		if (unknownSafety.length > 0) throw new Error(`${label}.safety has unsupported fields: ${unknownSafety.join(", ")}.`);
		if (safetyRecord.access !== "workspace-write" || safetyRecord.authentication !== "existing-cli-required" || safetyRecord.permissionMode !== "acceptEdits" || safetyRecord.tools !== "Read,Write,Edit,Glob,Grep" || safetyRecord.mcp !== "empty-strict" || safetyRecord.settingSources !== "user" || safetyRecord.userSettingsTrust !== "required" || safetyRecord.sessionPersistence !== false) throw new Error(`${label}.safety is invalid.`);
	} else if (adapterRecord.id === "cursor-agent" || adapterRecord.id === "cursor-agent-writer") {
		if (!safety || typeof safety !== "object" || Array.isArray(safety)) throw new Error(`${label}.safety is missing.`);
		const safetyRecord = safety as Record<string, unknown>;
		const unknownSafety = Object.keys(safetyRecord).filter((field) => !["access", "authentication", "mode", "sandbox", "workspaceTrust", "sessionReuse"].includes(field));
		if (unknownSafety.length > 0) throw new Error(`${label}.safety has unsupported fields: ${unknownSafety.join(", ")}.`);
		const writer = adapterRecord.id === "cursor-agent-writer";
		if (safetyRecord.access !== (writer ? "workspace-write" : "read-only") || safetyRecord.authentication !== "cursor-api-key-or-existing-login" || safetyRecord.mode !== (writer ? "print" : "ask") || safetyRecord.sandbox !== "enabled" || safetyRecord.workspaceTrust !== "existing-required" || safetyRecord.sessionReuse !== false) throw new Error(`${label}.safety is invalid.`);
	} else if (adapterRecord.id === "grok-build") {
		if (!safety || typeof safety !== "object" || Array.isArray(safety)) throw new Error(`${label}.safety is missing.`);
		const safetyRecord = safety as Record<string, unknown>;
		const unknownSafety = Object.keys(safetyRecord).filter((field) => !["access", "authentication", "permissionMode", "tools", "deniedTools", "sandbox", "webSearch", "subagents", "config", "updates", "sessionPersistence"].includes(field));
		if (unknownSafety.length > 0) throw new Error(`${label}.safety has unsupported fields: ${unknownSafety.join(", ")}.`);
		if (safetyRecord.access !== "read-only" || safetyRecord.authentication !== "xai-api-key-required" || safetyRecord.permissionMode !== "plan" || safetyRecord.tools !== "read_file,grep,list_dir" || safetyRecord.deniedTools !== "run_terminal_cmd,search_replace,Agent,Bash,Edit,Write,MCPTool" || safetyRecord.sandbox !== "read-only" || safetyRecord.webSearch !== false || safetyRecord.subagents !== false || safetyRecord.config !== "temporary-home" || safetyRecord.updates !== "disabled" || safetyRecord.sessionPersistence !== false) throw new Error(`${label}.safety is invalid.`);
	} else if (safety !== undefined) throw new Error(`${label}.safety is invalid for the generic adapter.`);
	const handoff = metadata.handoff;
	if (!handoff || typeof handoff !== "object" || Array.isArray(handoff)) throw new Error(`${label}.handoff must be an object.`);
	const handoffRecord = handoff as Record<string, unknown>;
	const unknownHandoff = Object.keys(handoffRecord).filter((field) => field !== "mode");
	if (unknownHandoff.length > 0) throw new Error(`${label}.handoff has unsupported fields: ${unknownHandoff.join(", ")}.`);
	if (handoffRecord.mode !== "fresh") throw new Error(`${label}.handoff is invalid.`);
	const supervisor = metadata.supervisor;
	if (!supervisor || typeof supervisor !== "object" || Array.isArray(supervisor)) throw new Error(`${label}.supervisor must be an object.`);
	const supervisorRecord = supervisor as Record<string, unknown>;
	const unknownSupervisor = Object.keys(supervisorRecord).filter((field) => !["mode", "reason"].includes(field));
	if (unknownSupervisor.length > 0) throw new Error(`${label}.supervisor has unsupported fields: ${unknownSupervisor.join(", ")}.`);
	if (supervisorRecord.mode !== "unsupported" || typeof supervisorRecord.reason !== "string" || !supervisorRecord.reason.trim()) throw new Error(`${label}.supervisor is invalid.`);
	if (typeof metadata.nonResumableReason !== "string" || !metadata.nonResumableReason.trim()) throw new Error(`${label}.nonResumableReason is missing.`);
	const outputArtifacts = metadata.outputArtifacts;
	if (outputArtifacts !== undefined) {
		if (!outputArtifacts || typeof outputArtifacts !== "object" || Array.isArray(outputArtifacts)) throw new Error(`${label}.outputArtifacts must be an object.`);
		const unknownArtifacts = Object.keys(outputArtifacts).filter((field) => !["stdoutPath", "stderrPath", "finalOutputPath"].includes(field));
		if (unknownArtifacts.length > 0) throw new Error(`${label}.outputArtifacts has unsupported fields: ${unknownArtifacts.join(", ")}.`);
		for (const field of ["stdoutPath", "stderrPath", "finalOutputPath"] as const) {
			const artifactPath = (outputArtifacts as Record<string, unknown>)[field];
			if (artifactPath !== undefined && (typeof artifactPath !== "string" || !artifactPath.trim())) throw new Error(`${label}.outputArtifacts.${field} must be a non-empty string.`);
		}
	}
	return value as ExternalCliReceiptMetadata;
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
	if (state === "resumable" && latestRunId === undefined) throw new Error(`Invalid workflow receipt '${source}': entry '${key}' resumable entry has no retained run id.`);
	if (state === "not-resumable" && (typeof reason !== "string" || !reason.trim())) throw new Error(`Invalid workflow receipt '${source}': entry '${key}' non-resumable reason is missing.`);
	parseExternalCliReceiptMetadata(entry.externalAdapter, key, source);
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
}): WorkflowReceiptEntry & { latestRunId: string; resumability: { state: "resumable" } } {
	if (input.reference.latest !== true) throw new Error("Keyed workflow receipt resume requires latest: true.");
	const key = assertKey(input.reference.key, "keyed resume key");
	const receipt = readWorkflowReceipt(input.asyncDirRoot, input.reference.workflowRunId.trim());
	const entry = receipt.entries[key];
	if (!entry) throw new Error(`Workflow receipt '${receipt.workflowRunId}' has no child key '${key}'.`);
	assertResumableEntry(entry, receipt.workflowRunId, key);
	input.assertResumable?.(entry.latestRunId);
	return entry;
}

function assertResumableEntry(entry: WorkflowReceiptEntry, workflowRunId: string, key: string): asserts entry is WorkflowReceiptEntry & { latestRunId: string; resumability: { state: "resumable" } } {
	if (entry.resumability.state !== "resumable") throw new Error(`Workflow receipt '${workflowRunId}' child '${key}' is not resumable: ${entry.resumability.reason}.`);
	if (!entry.latestRunId) throw new Error(`Workflow receipt '${workflowRunId}' child '${key}' has no retained run id.`);
}

export function resolveWorkflowReceiptResume(input: {
	reference: WorkflowReceiptResumeReference;
	asyncDirRoot: string;
	assertResumable?: (runId: string) => void;
}): string {
	const entry = resolveWorkflowReceiptResumeEntry(input);
	return entry.latestRunId;
}
