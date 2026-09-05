import type {
	AsyncStatus,
	HostStepNode,
	HostStepState,
	HostStepVerdict,
	WorkflowGraphNode,
	WorkflowGraphSnapshot,
	WorkflowNodeStatus,
} from "../../shared/types.ts";

export const HOST_STEP_MAX_ID_CHARS = 128;
export const HOST_STEP_MAX_LABEL_CHARS = 80;
export const HOST_STEP_MAX_ROLE_CHARS = 32;
export const HOST_STEP_MAX_PROVIDER_CHARS = 64;
export const HOST_STEP_MAX_REASON_CHARS = 64;
export const HOST_STEP_MAX_DETAIL_CHARS = 200;
export const HOST_STEP_MAX_TARGET_CHARS = 128;
export const HOST_STEP_MAX_REF_CHARS = 128;
export const HOST_STEP_MAX_REPORT_PATH_CHARS = 240;
export const HOST_STEP_MAX_COUNT = 32;

const HOST_STEP_FIELDS = new Set([
	"version",
	"kind",
	"monitorKind",
	"id",
	"label",
	"role",
	"provider",
	"state",
	"verdict",
	"reasonCode",
	"detail",
	"target",
	"freshness",
	"reportPath",
	"exitCode",
	"updatedAt",
	"deadlineAt",
]);

const FRESHNESS_FIELDS = new Set(["expectedRef", "observedRef", "stale"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertBoundedString(value: unknown, field: string, maxChars: number, source: string, required = false): asserts value is string {
	if (value === undefined && !required) return;
	if (typeof value !== "string" || !value.trim()) throw new Error(`Invalid host step '${source}': ${field} must be a non-empty string.`);
	if (value.length > maxChars) throw new Error(`Invalid host step '${source}': ${field} exceeds ${maxChars} characters.`);
	if (/\r|\n/.test(value)) throw new Error(`Invalid host step '${source}': ${field} must be single-line.`);
}

function assertTimestamp(value: unknown, field: string, source: string, required = false): asserts value is number {
	if (value === undefined && !required) return;
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid host step '${source}': ${field} must be a non-negative safe integer.`);
}

function assertFreshness(value: unknown, source: string): asserts value is HostStepNode["freshness"] {
	if (!isRecord(value)) throw new Error(`Invalid host step '${source}': freshness must be an object.`);
	const unknownFields = Object.keys(value).filter((field) => !FRESHNESS_FIELDS.has(field));
	if (unknownFields.length > 0) throw new Error(`Invalid host step '${source}': freshness has unsupported fields: ${unknownFields.join(", ")}.`);
	assertBoundedString(value.expectedRef, "freshness.expectedRef", HOST_STEP_MAX_REF_CHARS, source, true);
	assertBoundedString(value.observedRef, "freshness.observedRef", HOST_STEP_MAX_REF_CHARS, source);
	if (value.stale !== undefined && typeof value.stale !== "boolean") throw new Error(`Invalid host step '${source}': freshness.stale must be a boolean.`);
}

/**
 * Validate the persisted host-step contract. This deliberately rejects unknown
 * fields and unbounded values so status and receipt loaders fail closed.
 */
export function assertHostStepNode(value: unknown, source = "status"): asserts value is HostStepNode {
	if (!isRecord(value)) throw new Error(`Invalid host step '${source}': expected an object.`);
	const unknownFields = Object.keys(value).filter((field) => !HOST_STEP_FIELDS.has(field));
	if (unknownFields.length > 0) throw new Error(`Invalid host step '${source}': unsupported fields: ${unknownFields.join(", ")}.`);
	if (value.version !== 1) throw new Error(`Invalid host step '${source}': version must be 1.`);
	if (value.kind !== "host-step") throw new Error(`Invalid host step '${source}': kind must be 'host-step'.`);
	if (value.monitorKind !== "command" && value.monitorKind !== "ci" && value.monitorKind !== "gate") throw new Error(`Invalid host step '${source}': monitorKind must be 'command', 'ci', or 'gate'.`);
	assertBoundedString(value.id, "id", HOST_STEP_MAX_ID_CHARS, source, true);
	assertBoundedString(value.label, "label", HOST_STEP_MAX_LABEL_CHARS, source, true);
	assertBoundedString(value.role, "role", HOST_STEP_MAX_ROLE_CHARS, source);
	assertBoundedString(value.provider, "provider", HOST_STEP_MAX_PROVIDER_CHARS, source);
	if (value.state !== "pending" && value.state !== "running" && value.state !== "done" && value.state !== "cancelled" && value.state !== "error") {
		throw new Error(`Invalid host step '${source}': state is invalid.`);
	}
	if (value.verdict !== undefined && value.verdict !== "pass" && value.verdict !== "fail" && value.verdict !== "inconclusive") {
		throw new Error(`Invalid host step '${source}': verdict is invalid.`);
	}
	if (value.state !== "done" && value.verdict !== undefined) throw new Error(`Invalid host step '${source}': verdict is only valid for done state.`);
	assertBoundedString(value.reasonCode, "reasonCode", HOST_STEP_MAX_REASON_CHARS, source);
	assertBoundedString(value.detail, "detail", HOST_STEP_MAX_DETAIL_CHARS, source);
	assertBoundedString(value.target, "target", HOST_STEP_MAX_TARGET_CHARS, source);
	if (value.freshness !== undefined) assertFreshness(value.freshness, source);
	if (value.freshness && value.freshness.stale === true && (value.state !== "done" || value.verdict !== "inconclusive")) {
		throw new Error(`Invalid host step '${source}': stale freshness requires done/inconclusive state.`);
	}
	assertBoundedString(value.reportPath, "reportPath", HOST_STEP_MAX_REPORT_PATH_CHARS, source);
	const reportName = hostStepReportName(value.reportPath);
	if (value.reportPath !== undefined && (!reportName || reportName === "." || reportName === "..")) throw new Error(`Invalid host step '${source}': reportPath must name a report.`);
	if (value.exitCode !== undefined && value.exitCode !== null && (typeof value.exitCode !== "number" || !Number.isSafeInteger(value.exitCode) || value.exitCode < 0)) throw new Error(`Invalid host step '${source}': exitCode must be a non-negative safe integer or null.`);
	if (value.monitorKind !== "command" && value.exitCode !== undefined) throw new Error(`Invalid host step '${source}': exitCode is only valid for command steps.`);
	if ((value.state === "pending" || value.state === "running") && value.exitCode !== undefined) throw new Error(`Invalid host step '${source}': exitCode is only valid after command settlement.`);
	assertTimestamp(value.updatedAt, "updatedAt", source, true);
	assertTimestamp(value.deadlineAt, "deadlineAt", source);
}

export function parseHostStepNode(value: unknown, source = "status"): HostStepNode {
	assertHostStepNode(value, source);
	return {
		...value,
		...(value.freshness ? { freshness: { ...value.freshness } } : {}),
	};
}

export function assertUniqueHostStepIds(hostSteps: readonly HostStepNode[], source = "status"): void {
	const ids = new Set<string>();
	for (const hostStep of hostSteps) {
		if (ids.has(hostStep.id)) throw new Error(`Invalid host step '${source}': duplicate host step id '${hostStep.id}'.`);
		ids.add(hostStep.id);
	}
}

/** Return only valid host nodes so an untrusted in-memory projection fails closed. */
export function validHostStepNodes(graph: WorkflowGraphSnapshot | undefined): HostStepNode[] {
	const nodes = graph?.nodes ?? [];
	const nodeIdCounts = new Map<string, number>();
	for (const node of nodes) nodeIdCounts.set(node.id, (nodeIdCounts.get(node.id) ?? 0) + 1);
	const hostSteps: HostStepNode[] = [];
	for (const [index, node] of nodes.entries()) {
		if (node.kind !== "host-step") continue;
		try {
			const hostStep = parseHostStepNode(node.hostStep, `workflowGraph.nodes[${index}].hostStep`);
			if (node.id !== hostStep.id || node.label !== hostStep.label) continue;
			if (nodeIdCounts.get(hostStep.id) !== 1) continue;
			hostSteps.push(hostStep);
		} catch {
			// Renderers must not turn malformed host data into a fake child row.
		}
	}
	return hostSteps.slice(0, HOST_STEP_MAX_COUNT);
}

export function assertWorkflowGraphHostSteps(graph: WorkflowGraphSnapshot | undefined, source = "status", expectedRunId?: string): void {
	if (!graph) return;
	if (expectedRunId !== undefined && graph.runId !== expectedRunId) throw new Error(`Invalid host step '${source}': workflowGraph.runId does not match the status run id.`);
	if (!Array.isArray(graph.nodes)) throw new Error(`Invalid host step '${source}.workflowGraph': nodes must be an array.`);
	const hostStepCount = graph.nodes.filter((node) => node.kind === "host-step").length;
	if (hostStepCount > HOST_STEP_MAX_COUNT) throw new Error(`Invalid host step '${source}': workflowGraph contains more than ${HOST_STEP_MAX_COUNT} host steps.`);
	const hostSteps: HostStepNode[] = [];
	for (const [index, node] of graph.nodes.entries()) {
		if (node.kind !== "host-step") continue;
		const hostStep = parseHostStepNode(node.hostStep, `${source}.workflowGraph.nodes[${index}].hostStep`);
		if (node.id !== hostStep.id) throw new Error(`Invalid host step '${source}': workflowGraph.nodes[${index}].id does not match hostStep.id.`);
		if (node.label !== hostStep.label) throw new Error(`Invalid host step '${source}': workflowGraph.nodes[${index}].label does not match hostStep.label.`);
		hostSteps.push(hostStep);
	}
	assertUniqueHostStepIds(hostSteps, source);
	for (const hostStep of hostSteps) {
		if (graph.nodes.filter((node) => node.id === hostStep.id).length !== 1) throw new Error(`Invalid host step '${source}': workflowGraph id '${hostStep.id}' is not unique.`);
	}
}

export function hostStepWorkflowNode(hostStep: HostStepNode): WorkflowGraphNode {
	assertHostStepNode(hostStep, hostStep.id);
	return {
		id: hostStep.id,
		kind: "host-step",
		label: hostStep.label,
		status: workflowNodeStatus(hostStep),
		hostStep: { ...hostStep, ...(hostStep.freshness ? { freshness: { ...hostStep.freshness } } : {}) },
	};
}

function workflowNodeStatus(hostStep: HostStepNode): WorkflowNodeStatus {
	if (hostStep.state === "pending") return "pending";
	if (hostStep.state === "running") return "running";
	if (hostStep.state === "cancelled") return "stopped";
	if (hostStep.state === "error") return "failed";
	if (hostStep.verdict === undefined || hostStep.verdict === "inconclusive") return "partial";
	return hostStep.verdict === "fail" ? "failed" : "completed";
}

/**
 * Host-only registration/update boundary. The caller supplies the existing
 * status writer; monitor providers never receive a path or write status.json.
 */
export function upsertHostStep(input: {
	status: AsyncStatus;
	hostStep: HostStepNode;
	persist: (status: AsyncStatus) => void;
}): AsyncStatus {
	const hostStep = parseHostStepNode(input.hostStep, input.hostStep.id);
	assertWorkflowGraphHostSteps(input.status.workflowGraph, "host-step", input.status.runId);
	const graph: WorkflowGraphSnapshot = input.status.workflowGraph
		? {
			...input.status.workflowGraph,
			nodes: [...input.status.workflowGraph.nodes],
		}
		: {
			runId: input.status.runId,
			mode: input.status.mode,
			phases: [],
			nodes: [],
		};
	const existingIndex = graph.nodes.findIndex((node) => node.id === hostStep.id);
	const existing = existingIndex >= 0 ? graph.nodes[existingIndex] : undefined;
	if (existing && existing.kind !== "host-step") throw new Error(`Host step '${hostStep.id}' conflicts with an existing workflow node.`);
	if (existingIndex < 0 && graph.nodes.filter((candidate) => candidate.kind === "host-step").length >= HOST_STEP_MAX_COUNT) {
		throw new Error(`Host step limit of ${HOST_STEP_MAX_COUNT} has been reached.`);
	}
	const node = hostStepWorkflowNode(hostStep);
	if (existingIndex >= 0) graph.nodes[existingIndex] = node;
	else graph.nodes.push(node);
	const nextStatus: AsyncStatus = {
		...input.status,
		workflowGraph: graph,
		lastUpdate: Math.max(input.status.lastUpdate ?? 0, hostStep.updatedAt),
	};
	input.persist(nextStatus);
	return nextStatus;
}

export function hostStepVerdictLabel(state: HostStepState, verdict: HostStepVerdict | undefined): string {
	return state === "done" ? verdict ?? "inconclusive" : state;
}

export function hostStepReportName(reportPath: string | undefined): string | undefined {
	if (!reportPath) return undefined;
	return reportPath.split(/[\\/]/).filter(Boolean).at(-1);
}
