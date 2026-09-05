import * as fs from "node:fs";
import * as path from "node:path";
import { writePrivateAtomicJson } from "../shared/atomic-json.ts";
import type { AcceptanceRecoveryMetadata, ExternalCliReceiptMetadata, WorkflowReceipt, WorkflowReceiptEntry, WorkflowReceiptState, WorkflowRecoveryAction, WorkflowResourceProvenance, WorkflowTerminalOutcome, WorkflowTerminalResolution } from "../shared/types.ts";
import type { WorkflowReceiptResumeReference, WorkflowScriptChildResult } from "./scripted-workflow.ts";
import { parseWorkflowChildSummary } from "./workflow-child-summary.ts";
import { HOST_STEP_MAX_COUNT, assertUniqueHostStepIds, parseHostStepNode } from "../runs/shared/host-step-status.ts";
import { assertWorkflowLaneKey, normalizeWorkflowLaneMetadata } from "../runs/shared/lane-metadata.ts";

export type { WorkflowReceipt, WorkflowReceiptEntry, WorkflowReceiptState } from "../shared/types.ts";

export const WORKFLOW_RECEIPT_VERSION = 1;
export const WORKFLOW_RECEIPT_FILE = "workflow-receipt.json";
const MAX_WORKFLOW_RECEIPT_BYTES = 2 * 1024 * 1024;

const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const RESOURCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

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
	hostSteps?: WorkflowReceipt["hostSteps"];
	workflowChildren?: WorkflowReceipt["workflowChildren"];
	resource?: WorkflowResourceProvenance;
	terminalOutcome?: WorkflowTerminalOutcome;
	createdAt?: number;
}): WorkflowReceipt {
	const workflowRunId = assertSafeRunId(input.workflowRunId, "workflowRunId");
	if (input.workflowChildren?.workflowRunId !== undefined && input.workflowChildren.workflowRunId !== workflowRunId) throw new Error("workflowChildren workflowRunId does not match its receipt.");
	const entries: Record<string, WorkflowReceiptEntry> = Object.create(null) as Record<string, WorkflowReceiptEntry>;
	for (const child of input.children) {
		const key = assertKey(child.key, "workflow receipt child key");
		if (entries[key]) throw new Error(`Workflow receipt has duplicate child key '${key}'.`);
		const lane = normalizeWorkflowLaneMetadata(child.lane, `workflow receipt child '${key}'.lane`);
		assertWorkflowLaneKey(lane, key, `workflow receipt child '${key}'.lane`);
		const runIds = [...new Set((child.continuation?.runIds ?? (child.runId ? [child.runId] : [])).filter((runId) => typeof runId === "string" && runId.trim()).map((runId) => runId.trim()))];
		const latestRunId = runIds.at(-1);
		const resumability = child.resumability ?? { state: "not-resumable", reason: child.runId ? "resumability was not recorded" : "child produced no run id" };
		if (resumability.state === "resumable" && !latestRunId) throw new Error(`Workflow receipt child '${key}' is resumable but has no retained run id.`);
		const base = {
			key,
			...(lane ? { lane } : {}),
			...(child.terminalOutcome ? { terminalOutcome: child.terminalOutcome } : {}),
			...(child.agent ? { agent: child.agent } : {}),
			...(child.requestedContext ? { requestedContext: child.requestedContext } : {}),
			...(child.resolvedContext ? { resolvedContext: child.resolvedContext } : {}),
			...(child.outputReference ? { outputReference: child.outputReference } : {}),
			...(child.recovery ? { acceptanceRecovery: child.recovery } : {}),
			...(child.externalAdapter ? { externalAdapter: child.externalAdapter } : {}),
			continuation: { runIds },
		};
		entries[key] = resumability.state === "resumable"
			? { ...base, latestRunId: latestRunId!, resumability }
			: { ...base, ...(latestRunId ? { latestRunId } : {}), resumability };
	}
	if (input.hostSteps && input.hostSteps.length > HOST_STEP_MAX_COUNT) throw new Error(`Workflow receipt has more than ${HOST_STEP_MAX_COUNT} host steps.`);
	const hostSteps = input.hostSteps?.map((hostStep, index) => parseHostStepNode(hostStep, `workflow receipt hostSteps[${index}]`));
	if (hostSteps) assertUniqueHostStepIds(hostSteps, "workflow receipt");
	const resource = parseWorkflowResource(input.resource, "workflow receipt");
	return { version: WORKFLOW_RECEIPT_VERSION, workflowRunId, state: input.state, createdAt: input.createdAt ?? Date.now(), entries, ...(resource ? { resource } : {}), ...(hostSteps?.length ? { hostSteps } : {}), ...(input.workflowChildren ? { workflowChildren: input.workflowChildren } : {}), ...(input.terminalOutcome ? { terminalOutcome: input.terminalOutcome } : {}) };
}

export function writeWorkflowReceipt(asyncDir: string, receipt: WorkflowReceipt): string {
	const receiptPath = path.join(asyncDir, WORKFLOW_RECEIPT_FILE);
	writePrivateAtomicJson(receiptPath, receipt);
	return receiptPath;
}

function readWorkflowReceiptFile(receiptPath: string): unknown {
	let fd: number | undefined;
	try {
		fd = fs.openSync(receiptPath, "r");
		const stat = fs.fstatSync(fd);
		if (!stat.isFile()) throw new Error("workflow receipt is not a regular file.");
		if (stat.size > MAX_WORKFLOW_RECEIPT_BYTES) throw new Error(`workflow receipt exceeds the ${MAX_WORKFLOW_RECEIPT_BYTES}-byte limit.`);
		const buffer = Buffer.allocUnsafe(stat.size);
		let offset = 0;
		while (offset < buffer.length) {
			const bytesRead = fs.readSync(fd, buffer, offset, buffer.length - offset, null);
			if (bytesRead <= 0) throw new Error("workflow receipt ended before its declared size.");
			offset += bytesRead;
		}
		return JSON.parse(buffer.toString("utf-8")) as unknown;
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
	}
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

function parseTerminalOutcome(value: unknown, label: string): WorkflowTerminalOutcome | undefined {
	if (value === undefined) return undefined;
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
	const outcome = value as Record<string, unknown>;
	if (outcome.state !== "partial" || (outcome.reason !== "budget_exhausted" && outcome.reason !== "timeout")) throw new Error(`${label} is invalid.`);
	return { state: "partial", reason: outcome.reason };
}

function parseAcceptanceRecoveryMetadata(value: unknown, label: string): AcceptanceRecoveryMetadata | undefined {
	if (value === undefined) return undefined;
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
	const recovery = value as Record<string, unknown>;
	if (recovery.status !== "available-for-review" || recovery.reason !== "acceptance-metadata-rejected") throw new Error(`${label} is invalid.`);
	if (typeof recovery.reportPath !== "string" || !recovery.reportPath.trim() || typeof recovery.reportHash !== "string" || !/^[a-f0-9]{64}$/u.test(recovery.reportHash)) throw new Error(`${label} is invalid.`);
	return {
		status: "available-for-review",
		reason: "acceptance-metadata-rejected",
		reportPath: recovery.reportPath,
		reportHash: recovery.reportHash,
	};
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
	const terminalOutcome = parseTerminalOutcome(entry.terminalOutcome, `Invalid workflow receipt '${source}': entry '${key}' terminalOutcome`);
	const acceptanceRecovery = parseAcceptanceRecoveryMetadata(entry.acceptanceRecovery, `Invalid workflow receipt '${source}': entry '${key}' acceptanceRecovery`);
	parseExternalCliReceiptMetadata(entry.externalAdapter, key, source);
	const lane = normalizeWorkflowLaneMetadata(entry.lane, `Invalid workflow receipt '${source}': entry '${key}'.lane`);
	assertWorkflowLaneKey(lane, key, `Invalid workflow receipt '${source}': entry '${key}'.lane`);
	return { ...(value as WorkflowReceiptEntry), ...(lane ? { lane } : {}), ...(terminalOutcome ? { terminalOutcome } : {}), ...(acceptanceRecovery ? { acceptanceRecovery } : {}) };
}

function parseWorkflowResolution(value: unknown, source: string): WorkflowTerminalResolution | undefined {
	if (value === undefined) return undefined;
	if (value !== "settled-awaiting-resume" && value !== "failed-child" && value !== "interrupted-child") throw new Error(`Invalid workflow receipt '${source}': workflowResolution is invalid.`);
	return value;
}

function parseWorkflowResource(value: unknown, source: string): WorkflowResourceProvenance | undefined {
	if (value === undefined) return undefined;
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid workflow receipt '${source}': resource must be an object.`);
	const resource = value as Record<string, unknown>;
	if (resource.kind !== "workflow" || typeof resource.name !== "string" || !KEY_PATTERN.test(resource.name) || !Number.isInteger(resource.version) || (resource.version as number) < 1 || (resource.version as number) > 1_000_000 || resource.invocation !== "named" || resource.expansion !== "resolved" || typeof resource.id !== "string" || !RESOURCE_ID_PATTERN.test(resource.id)) {
		throw new Error(`Invalid workflow receipt '${source}': resource is invalid.`);
	}
	return {
		kind: "workflow",
		name: resource.name,
		version: resource.version as number,
		invocation: "named",
		expansion: "resolved",
		id: resource.id,
	};
}

function parseRecovery(value: unknown, workflowRunId: string, entries: Record<string, WorkflowReceiptEntry>, source: string): WorkflowRecoveryAction[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) throw new Error(`Invalid workflow receipt '${source}': recovery must be an array.`);
	return value.map((item, index) => {
		if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`Invalid workflow receipt '${source}': recovery[${index}] must be an object.`);
		const action = item as Record<string, unknown>;
		const key = action.key;
		const resume = action.resume;
		if (typeof key !== "string" || !entries[key] || action.call !== "runs.run" || action.taskRequired !== true || !resume || typeof resume !== "object" || Array.isArray(resume)) throw new Error(`Invalid workflow receipt '${source}': recovery[${index}] is invalid.`);
		const reference = resume as Record<string, unknown>;
		if (reference.workflowRunId !== workflowRunId || reference.key !== key || reference.latest !== true || entries[key].resumability.state !== "resumable") throw new Error(`Invalid workflow receipt '${source}': recovery[${index}] does not identify a resumable entry.`);
		return { key, call: "runs.run", resume: { workflowRunId, key, latest: true }, taskRequired: true };
	});
}

export function readWorkflowReceipt(asyncDirRoot: string, workflowRunId: string): WorkflowReceipt {
	const receiptPath = workflowReceiptPath(asyncDirRoot, workflowRunId);
	let value: unknown;
	try {
		value = readWorkflowReceiptFile(receiptPath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			const workflowDir = path.dirname(receiptPath);
			if (fs.existsSync(path.join(workflowDir, "status.json")) || fs.existsSync(path.join(workflowDir, "events.jsonl"))) {
				throw new Error(`Workflow receipt '${workflowRunId}' is not available because the workflow may still be active or terminal receipt writing failed. Use direct child run IDs from status/events for direct resume after the normal retained-child checks.`);
			}
			throw new Error(`Workflow receipt '${workflowRunId}' was not found.`);
		}
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
	const workflowChildren = parseWorkflowChildSummary(receipt.workflowChildren);
	if (workflowChildren && workflowChildren.workflowRunId !== workflowRunId) throw new Error(`Workflow receipt '${receiptPath}' is stale: workflowChildren.workflowRunId does not match.`);
	let hostSteps: NonNullable<WorkflowReceipt["hostSteps"]> | undefined;
	if (receipt.hostSteps !== undefined) {
		if (!Array.isArray(receipt.hostSteps)) throw new Error(`Invalid workflow receipt '${receiptPath}': hostSteps must be an array.`);
		if (receipt.hostSteps.length > HOST_STEP_MAX_COUNT) throw new Error(`Invalid workflow receipt '${receiptPath}': hostSteps exceeds ${HOST_STEP_MAX_COUNT} entries.`);
		hostSteps = receipt.hostSteps.map((hostStep, index) => parseHostStepNode(hostStep, `${receiptPath} hostSteps[${index}]`));
		assertUniqueHostStepIds(hostSteps, receiptPath);
	}
	const workflowResolution = parseWorkflowResolution(receipt.workflowResolution, receiptPath);
	const resource = parseWorkflowResource(receipt.resource, receiptPath);
	const terminalOutcome = parseTerminalOutcome(receipt.terminalOutcome, `Invalid workflow receipt '${receiptPath}': terminalOutcome`);
	const recovery = parseRecovery(receipt.recovery, workflowRunId, entries, receiptPath);
	return { version: 1, workflowRunId, state: receipt.state, createdAt: receipt.createdAt, entries, ...(resource ? { resource } : {}), ...(hostSteps?.length ? { hostSteps } : {}), ...(workflowChildren ? { workflowChildren } : {}), ...(workflowResolution ? { workflowResolution } : {}), ...(terminalOutcome ? { terminalOutcome } : {}), ...(recovery ? { recovery } : {}) };
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
