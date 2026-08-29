import { sanitizeDisplayText, truncateDisplayText } from "../../shared/display-text.ts";
import { formatModelThinking } from "../../shared/formatters.ts";
import type { AsyncJobState, AsyncJobStep, HostStepFreshnessV1, HostStepMonitorKind, HostStepNodeV1, HostStepState, HostStepVerdict, NestedRunSummary, NestedStepSummary, SubagentRunMode, WorkflowGraphSnapshot, WorkflowPreflightLaneV1, WorkflowPreflightV1 } from "../../shared/types.ts";
import { HOST_STEP_MAX_COUNT, HOST_STEP_MAX_DETAIL_CHARS, HOST_STEP_MAX_LABEL_CHARS, HOST_STEP_MAX_PROVIDER_CHARS, HOST_STEP_MAX_REASON_CHARS, HOST_STEP_MAX_REF_CHARS, HOST_STEP_MAX_ROLE_CHARS, HOST_STEP_MAX_TARGET_CHARS, hostStepReportName, parseHostStepNode, validHostStepNodes } from "./host-step-status.ts";
import { workflowGraphStageNodes } from "./workflow-graph.ts";

export const ASYNC_STATUS_SNAPSHOT_KIND = "pi-subagents.async-status-snapshot";
export const ASYNC_STATUS_SNAPSHOT_VERSION = 1;

const DEFAULT_MAX_RUNS = 20;
const DEFAULT_MAX_CHILDREN_PER_NODE = 8;
const DEFAULT_MAX_DEPTH = 3;
const DEFAULT_MAX_STRING_LENGTH = 160;
const DEFAULT_MAX_SERIALIZED_BYTES = 32 * 1024;

export type AsyncStatusSnapshotState = "queued" | "running" | "complete" | "failed" | "partial" | "paused" | "stopped" | "rejected";
export type AsyncStatusSnapshotKind = "subagent" | "workflow" | "step";

const ASYNC_STATUS_SNAPSHOT_STATES: Record<AsyncStatusSnapshotState, true> = {
	queued: true,
	running: true,
	complete: true,
	failed: true,
	partial: true,
	paused: true,
	stopped: true,
	rejected: true,
};

function isAsyncStatusSnapshotState(value: string): value is AsyncStatusSnapshotState {
	return Object.hasOwn(ASYNC_STATUS_SNAPSHOT_STATES, value);
}

export interface AsyncStatusSnapshotActivityV1 {
	state?: string;
	currentTool?: string;
	lastActivityAt?: number;
	currentToolStartedAt?: number;
	turnCount?: number;
	toolCount?: number;
}

export interface AsyncStatusSnapshotHostStepV1 {
	kind: HostStepMonitorKind;
	provider?: string;
	role?: string;
	state: HostStepState;
	verdict?: HostStepVerdict;
	reasonCode?: string;
	detail?: string;
	target?: string;
	stale?: boolean;
	report?: string;
}

export interface AsyncStatusSnapshotNodeV1 {
	id: string;
	kind: AsyncStatusSnapshotKind | "host-step";
	label: string;
	state: AsyncStatusSnapshotState;
	startedAt?: number;
	updatedAt?: number;
	endedAt?: number;
	activity?: AsyncStatusSnapshotActivityV1;
	hostStep?: AsyncStatusSnapshotHostStepV1;
	children?: AsyncStatusSnapshotNodeV1[];
}

export interface AsyncStatusSnapshotCapsV1 {
	maxRuns: number;
	maxChildrenPerNode: number;
	maxDepth: number;
	maxStringLength: number;
	maxSerializedBytes: number;
}

export interface AsyncStatusSnapshotOmittedV1 {
	runs: number;
	children: number;
	byteLimitExceeded: boolean;
}

export interface AsyncStatusSnapshotV1 {
	kind: typeof ASYNC_STATUS_SNAPSHOT_KIND;
	version: typeof ASYNC_STATUS_SNAPSHOT_VERSION;
	generatedAt: number;
	caps: AsyncStatusSnapshotCapsV1;
	omitted: AsyncStatusSnapshotOmittedV1;
	runs: AsyncStatusSnapshotNodeV1[];
}

export interface AsyncStatusSnapshotOptions {
	generatedAt?: number;
	maxRuns?: number;
	maxChildrenPerNode?: number;
	maxDepth?: number;
	maxStringLength?: number;
	maxSerializedBytes?: number;
}

export interface AsyncStatusWorkflowRow {
	name: string;
	state: AsyncJobStep["status"] | HostStepState | "planned";
	/** Present only for typed host-owned monitor rows; legacy child rows omit it. */
	kind?: HostStepMonitorKind;
	context?: AsyncJobStep["context"];
	modelThinking?: string;
	activity?: string;
	startedAt?: number;
	tokens?: number;
	window?: number;
	overflow?: number;
	provider?: string;
	role?: string;
	verdict?: HostStepVerdict;
	reasonCode?: string;
	detail?: string;
	target?: string;
	freshness?: HostStepFreshnessV1;
	reportPath?: string;
	preflight?: WorkflowPreflightLaneV1;
}

interface ProjectionContext {
	caps: AsyncStatusSnapshotCapsV1;
	omitted: AsyncStatusSnapshotOmittedV1;
}

function validHostStepList(source: readonly HostStepNodeV1[] | WorkflowGraphSnapshot | undefined): HostStepNodeV1[] {
	if (source && "nodes" in source) return validHostStepNodes(source);
	const hostSteps: HostStepNodeV1[] = [];
	for (const [index, value] of (source ?? []).slice(0, HOST_STEP_MAX_COUNT).entries()) {
		try {
			hostSteps.push(parseHostStepNode(value, `hostSteps[${index}]`));
		} catch {
			// Renderers must not turn malformed host data into a fake child row.
		}
	}
	return hostSteps;
}

function resolveCaps(options: AsyncStatusSnapshotOptions): AsyncStatusSnapshotCapsV1 {
	return {
		maxRuns: Math.max(0, Math.floor(options.maxRuns ?? DEFAULT_MAX_RUNS)),
		maxChildrenPerNode: Math.max(0, Math.floor(options.maxChildrenPerNode ?? DEFAULT_MAX_CHILDREN_PER_NODE)),
		maxDepth: Math.max(0, Math.floor(options.maxDepth ?? DEFAULT_MAX_DEPTH)),
		maxStringLength: Math.max(0, Math.floor(options.maxStringLength ?? DEFAULT_MAX_STRING_LENGTH)),
		maxSerializedBytes: Math.max(256, Math.floor(options.maxSerializedBytes ?? DEFAULT_MAX_SERIALIZED_BYTES)),
	};
}

function publicText(value: unknown, fallback: string, maxLength: number): string {
	if (typeof value !== "string") return fallback;
	const normalized = sanitizeDisplayText(value.slice(0, Math.max(0, maxLength * 4)));
	return truncateDisplayText(normalized || fallback, maxLength);
}

function publicOptionalText(value: unknown, maxLength: number): string | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = sanitizeDisplayText(value.slice(0, Math.max(0, maxLength * 4)));
	return normalized ? truncateDisplayText(normalized, maxLength) : undefined;
}

function publicTime(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function publicCount(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function normalizeState(value: string): AsyncStatusSnapshotState {
	if (value === "completed") return "complete";
	if (value === "pending") return "queued";
	if (isAsyncStatusSnapshotState(value)) return value;
	return "partial";
}

function terminalState(state: AsyncStatusSnapshotState): boolean {
	return state === "complete" || state === "failed" || state === "partial" || state === "paused" || state === "stopped" || state === "rejected";
}

function kindForMode(mode: SubagentRunMode | undefined): AsyncStatusSnapshotKind {
	return mode === "workflow" ? "workflow" : "subagent";
}

function labelForAgents(agents: readonly string[] | undefined, fallback: string, maxLength: number): string {
	if (!agents?.length) return publicText(fallback, fallback, maxLength);
	const visible = agents.slice(0, 3).map((agent) => publicText(agent, "agent", maxLength)).join(", ");
	const suffix = agents.length > 3 ? `, +${agents.length - 3} more` : "";
	return truncateDisplayText(`${visible}${suffix}`, maxLength);
}

function activityFor(source: {
	activityState?: unknown;
	currentTool?: unknown;
	lastActivityAt?: unknown;
	currentToolStartedAt?: unknown;
	turnCount?: unknown;
	toolCount?: unknown;
}, ctx: ProjectionContext): AsyncStatusSnapshotActivityV1 | undefined {
	const currentTool = publicOptionalText(source.currentTool, ctx.caps.maxStringLength);
	const lastActivityAt = publicTime(source.lastActivityAt);
	const currentToolStartedAt = publicTime(source.currentToolStartedAt);
	const turnCount = publicCount(source.turnCount);
	const toolCount = publicCount(source.toolCount);
	const activity: AsyncStatusSnapshotActivityV1 = {
		...(typeof source.activityState === "string" ? { state: publicText(source.activityState, "unknown", ctx.caps.maxStringLength) } : {}),
		...(currentTool ? { currentTool } : {}),
		...(lastActivityAt !== undefined ? { lastActivityAt } : {}),
		...(currentToolStartedAt !== undefined ? { currentToolStartedAt } : {}),
		...(turnCount !== undefined ? { turnCount } : {}),
		...(toolCount !== undefined ? { toolCount } : {}),
	};
	return Object.keys(activity).length ? activity : undefined;
}

function appendBoundedChildren(children: AsyncStatusSnapshotNodeV1[], source: readonly AsyncStatusSnapshotNodeV1[], ctx: ProjectionContext): void {
	const remaining = Math.max(0, ctx.caps.maxChildrenPerNode - children.length);
	children.push(...source.slice(0, remaining));
	ctx.omitted.children += Math.max(0, source.length - remaining);
}

function projectStep(step: AsyncJobStep | NestedStepSummary, index: number, depth: number, ctx: ProjectionContext): AsyncStatusSnapshotNodeV1 {
	const state = normalizeState(step.status);
	const startedAt = publicTime(step.startedAt);
	const endedAt = publicTime(step.endedAt);
	const updatedAt = endedAt ?? publicTime(step.lastActivityAt) ?? startedAt;
	const activity = activityFor(step, ctx);
	const node: AsyncStatusSnapshotNodeV1 = {
		id: publicText("workflowKey" in step && step.workflowKey ? step.workflowKey : "runId" in step && step.runId ? step.runId : `step:${index}`, `step:${index}`, ctx.caps.maxStringLength),
		kind: "step",
		label: publicText("label" in step && step.label ? step.label : step.agent, "step", ctx.caps.maxStringLength),
		state,
		...(startedAt !== undefined ? { startedAt } : {}),
		...(updatedAt !== undefined ? { updatedAt } : {}),
		...(terminalState(state) && endedAt !== undefined ? { endedAt } : {}),
		...(activity ? { activity } : {}),
	};
	if (depth < ctx.caps.maxDepth && step.children?.length) {
		const nested = step.children.map((child, childIndex) => projectNestedRun(child, childIndex, depth + 1, ctx));
		const bounded: AsyncStatusSnapshotNodeV1[] = [];
		appendBoundedChildren(bounded, nested, ctx);
		if (bounded.length) node.children = bounded;
	} else if (step.children?.length) {
		ctx.omitted.children += step.children.length;
	}
	return node;
}

function projectWorkflowGraphNode(node: WorkflowGraphSnapshot["nodes"][number], index: number, depth: number, ctx: ProjectionContext): AsyncStatusSnapshotNodeV1 {
	const step: AsyncJobStep = {
		agent: node.agent ?? node.label,
		status: workflowGraphStepStatus(node.status),
		workflowKey: node.id,
		label: node.label,
	};
	return projectStep(step, node.flatIndex ?? index, depth, ctx);
}

function projectNestedRun(child: NestedRunSummary, index: number, depth: number, ctx: ProjectionContext): AsyncStatusSnapshotNodeV1 {
	const state = normalizeState(child.state);
	const startedAt = publicTime(child.startedAt);
	const endedAt = publicTime(child.endedAt);
	const updatedAt = publicTime(child.lastUpdate) ?? endedAt ?? publicTime(child.lastActivityAt) ?? startedAt;
	const activity = activityFor(child, ctx);
	const node: AsyncStatusSnapshotNodeV1 = {
		id: publicText(child.id, `nested:${index}`, ctx.caps.maxStringLength),
		kind: kindForMode(child.mode),
		label: child.agent ? publicText(child.agent, "subagent", ctx.caps.maxStringLength) : labelForAgents(child.agents, child.mode ?? "subagent", ctx.caps.maxStringLength),
		state,
		...(startedAt !== undefined ? { startedAt } : {}),
		...(updatedAt !== undefined ? { updatedAt } : {}),
		...(terminalState(state) && endedAt !== undefined ? { endedAt } : {}),
		...(activity ? { activity } : {}),
	};
	if (depth < ctx.caps.maxDepth) {
		const nestedSteps = child.steps?.map((step, stepIndex) => projectStep(step, stepIndex, depth + 1, ctx)) ?? [];
		const nestedChildren = child.children?.map((nested, childIndex) => projectNestedRun(nested, childIndex, depth + 1, ctx)) ?? [];
		const bounded: AsyncStatusSnapshotNodeV1[] = [];
		appendBoundedChildren(bounded, [...nestedSteps, ...nestedChildren], ctx);
		if (bounded.length) node.children = bounded;
	} else {
		ctx.omitted.children += (child.steps?.length ?? 0) + (child.children?.length ?? 0);
	}
	return node;
}

function hostStepSnapshotState(state: HostStepState, verdict: HostStepVerdict | undefined): AsyncStatusSnapshotState {
	if (state === "pending") return "queued";
	if (state === "running") return "running";
	if (state === "cancelled") return "stopped";
	if (state === "error" || verdict === "fail") return "failed";
	return verdict === undefined || verdict === "inconclusive" ? "partial" : "complete";
}

function projectHostStep(hostStep: HostStepNodeV1, ctx: ProjectionContext): AsyncStatusSnapshotNodeV1 {
	const state = hostStepSnapshotState(hostStep.state, hostStep.verdict);
	const detail = publicOptionalText(hostStep.detail, ctx.caps.maxStringLength);
	const report = publicOptionalText(hostStepReportName(hostStep.reportPath), ctx.caps.maxStringLength);
	const hostMetadata: AsyncStatusSnapshotHostStepV1 = {
		kind: hostStep.monitorKind,
		state: hostStep.state,
		...(hostStep.provider ? { provider: publicText(hostStep.provider, "provider", ctx.caps.maxStringLength) } : {}),
		...(hostStep.role ? { role: publicText(hostStep.role, "role", ctx.caps.maxStringLength) } : {}),
		...(hostStep.verdict ? { verdict: hostStep.verdict } : {}),
		...(hostStep.reasonCode ? { reasonCode: publicText(hostStep.reasonCode, "reason", ctx.caps.maxStringLength) } : {}),
		...(detail ? { detail } : {}),
		...(hostStep.target ? { target: publicText(hostStep.target, "target", ctx.caps.maxStringLength) } : {}),
		...(hostStep.freshness?.stale !== undefined ? { stale: hostStep.freshness.stale } : {}),
		...(report ? { report } : {}),
	};
	return {
		id: publicText(hostStep.id, "host-step", ctx.caps.maxStringLength),
		kind: "host-step",
		label: publicText(hostStep.label, "host step", ctx.caps.maxStringLength),
		state,
		updatedAt: hostStep.updatedAt,
		...(terminalState(state) ? { endedAt: hostStep.updatedAt } : {}),
		hostStep: hostMetadata,
	};
}

function projectRun(job: AsyncJobState, ctx: ProjectionContext): AsyncStatusSnapshotNodeV1 {
	const state = normalizeState(job.status);
	const startedAt = publicTime(job.startedAt);
	const updatedAt = publicTime(job.updatedAt) ?? startedAt;
	const activity = activityFor(job, ctx);
	const node: AsyncStatusSnapshotNodeV1 = {
		id: publicText(job.asyncId, "async", ctx.caps.maxStringLength),
		kind: kindForMode(job.mode),
		label: labelForAgents(job.agents, job.mode ?? "subagent", ctx.caps.maxStringLength),
		state,
		...(startedAt !== undefined ? { startedAt } : {}),
		...(updatedAt !== undefined ? { updatedAt } : {}),
		...(terminalState(state) && updatedAt !== undefined ? { endedAt: updatedAt } : {}),
		...(activity ? { activity } : {}),
	};
	if (ctx.caps.maxDepth > 0) {
		const stepChildren = job.steps?.map((step, index) => projectStep(step, step.index ?? index, 1, ctx)) ?? [];
		const loadedKeys = new Set(job.steps?.flatMap((step) => step.workflowKey ? [step.workflowKey] : []) ?? []);
		const graphStages = job.mode === "workflow" ? workflowGraphStageNodes(job.workflowGraph) : [];
		const graphChildren = graphStages
			.filter((graphNode) => !loadedKeys.has(graphNode.id))
			.map((graphNode, index) => projectWorkflowGraphNode(graphNode, index, 1, ctx));
		const nestedChildren = job.nestedChildren?.map((child, index) => projectNestedRun(child, index, 1, ctx)) ?? [];
		const hostStepChildren = validHostStepList(job.hostSteps).map((hostStep) => projectHostStep(hostStep, ctx));
		const ordinaryChildren = [...stepChildren, ...graphChildren, ...nestedChildren];
		const retainedHostSteps = hostStepChildren.slice(0, ctx.caps.maxChildrenPerNode);
		const retainedOrdinaryChildren = ordinaryChildren.slice(0, ctx.caps.maxChildrenPerNode - retainedHostSteps.length);
		const bounded: AsyncStatusSnapshotNodeV1[] = [];
		bounded.push(...retainedOrdinaryChildren, ...retainedHostSteps);
		ctx.omitted.children += ordinaryChildren.length - retainedOrdinaryChildren.length + hostStepChildren.length - retainedHostSteps.length;
		if (bounded.length) node.children = bounded;
	} else {
		const loadedKeys = new Set(job.steps?.flatMap((step) => step.workflowKey ? [step.workflowKey] : []) ?? []);
		const graphStages = job.mode === "workflow" ? workflowGraphStageNodes(job.workflowGraph) : [];
		const graphCount = graphStages.filter((graphNode) => !loadedKeys.has(graphNode.id)).length;
		ctx.omitted.children += (job.steps?.length ?? 0) + graphCount + (job.nestedChildren?.length ?? 0) + validHostStepList(job.hostSteps).length;
	}
	return node;
}

function snapshotBytes(snapshot: AsyncStatusSnapshotV1): number {
	return Buffer.byteLength(JSON.stringify(snapshot), "utf8");
}

function enforceByteLimit(snapshot: AsyncStatusSnapshotV1): void {
	if (snapshotBytes(snapshot) <= snapshot.caps.maxSerializedBytes) return;
	snapshot.omitted.byteLimitExceeded = true;
	const runs = snapshot.runs;
	const initialOmittedRuns = snapshot.omitted.runs;
	let lower = 0;
	let upper = Math.max(0, runs.length - 1);
	while (lower < upper) {
		const retained = Math.ceil((lower + upper) / 2);
		snapshot.runs = runs.slice(0, retained);
		snapshot.omitted.runs = initialOmittedRuns + runs.length - retained;
		if (snapshotBytes(snapshot) <= snapshot.caps.maxSerializedBytes) lower = retained;
		else upper = retained - 1;
	}
	snapshot.runs = runs.slice(0, lower);
	snapshot.omitted.runs = initialOmittedRuns + runs.length - lower;
}

function workflowStepActivity(step: AsyncJobStep): string | undefined {
	if (step.currentTool) return `tool ${step.currentTool}`;
	if (step.currentPath) return step.currentPath.split(/[\\/]/).at(-1);
	if (step.activityState === "needs_attention") return "needs attention";
	if (step.activityState === "active_long_running") return "long-running";
	if (step.turnCount !== undefined) return `${step.turnCount} turns`;
	if (step.toolCount !== undefined) return `${step.toolCount} tools`;
	return undefined;
}

function workflowStepName(step: AsyncJobStep, index: number): string {
	const key = step.workflowKey ?? `step ${index + 1}`;
	const label = step.label && step.label !== key ? ` · ${step.label}` : "";
	const phase = step.phase ? `${step.phase}: ` : "";
	return `${phase}${key}${label} (${step.agent})`;
}

function hostStepRow(hostStep: HostStepNodeV1): AsyncStatusWorkflowRow {
	const freshness = hostStep.freshness
		? {
			expectedRef: publicText(hostStep.freshness.expectedRef, "ref", HOST_STEP_MAX_REF_CHARS),
			...(hostStep.freshness.observedRef ? { observedRef: publicText(hostStep.freshness.observedRef, "ref", HOST_STEP_MAX_REF_CHARS) } : {}),
			...(hostStep.freshness.stale !== undefined ? { stale: hostStep.freshness.stale } : {}),
		}
		: undefined;
	return {
		name: publicText(hostStep.label, "host step", HOST_STEP_MAX_LABEL_CHARS),
		kind: hostStep.monitorKind,
		state: hostStep.state,
		...(hostStep.role ? { role: publicText(hostStep.role, "role", HOST_STEP_MAX_ROLE_CHARS) } : {}),
		...(hostStep.provider ? { provider: publicText(hostStep.provider, "provider", HOST_STEP_MAX_PROVIDER_CHARS) } : {}),
		...(hostStep.verdict ? { verdict: hostStep.verdict } : {}),
		...(hostStep.reasonCode ? { reasonCode: publicText(hostStep.reasonCode, "reason", HOST_STEP_MAX_REASON_CHARS) } : {}),
		...(hostStep.detail ? { detail: publicText(hostStep.detail, "detail", HOST_STEP_MAX_DETAIL_CHARS) } : {}),
		...(hostStep.target ? { target: publicText(hostStep.target, "target", HOST_STEP_MAX_TARGET_CHARS) } : {}),
		...(freshness ? { freshness } : {}),
		...(hostStep.reportPath ? { reportPath: hostStepReportName(hostStep.reportPath) } : {}),
	};
}


function isWorkflowPreflight(value: readonly HostStepNodeV1[] | WorkflowGraphSnapshot | WorkflowPreflightV1 | undefined): value is WorkflowPreflightV1 {
	return value !== undefined && !Array.isArray(value) && "lanes" in value;
}

function isWorkflowGraph(value: readonly HostStepNodeV1[] | WorkflowGraphSnapshot | WorkflowPreflightV1 | undefined): value is WorkflowGraphSnapshot {
	return value !== undefined && !Array.isArray(value) && "nodes" in value;
}

function workflowGraphRowState(status: WorkflowGraphSnapshot["nodes"][number]["status"]): AsyncStatusWorkflowRow["state"] {
	switch (status) {
		case "pending":
			return "planned";
		case "completed":
			return "complete";
		case "detached":
			return "paused";
		default:
			return status;
	}
}

function workflowGraphStepStatus(status: WorkflowGraphSnapshot["nodes"][number]["status"]): AsyncJobStep["status"] {
	switch (status) {
		case "completed":
			return "complete";
		case "detached":
			return "paused";
		default:
			return status;
	}
}

function workflowGraphRowName(node: WorkflowGraphSnapshot["nodes"][number]): string {
	const key = publicText(node.id, "stage", HOST_STEP_MAX_LABEL_CHARS);
	const label = publicOptionalText(node.label, HOST_STEP_MAX_LABEL_CHARS);
	const phase = publicOptionalText(node.phase, HOST_STEP_MAX_LABEL_CHARS);
	const agent = publicOptionalText(node.agent, HOST_STEP_MAX_LABEL_CHARS);
	return `${phase ? `${phase}: ` : ""}${key}${label && label !== node.id ? ` · ${label}` : ""}${agent ? ` (${agent})` : ""}`;
}

function projectWorkflowGraphRow(node: WorkflowGraphSnapshot["nodes"][number], preflight?: WorkflowPreflightLaneV1): AsyncStatusWorkflowRow {
	return {
		name: workflowGraphRowName(node),
		state: workflowGraphRowState(node.status),
		...(preflight ? { preflight } : {}),
	};
}

/** Project loaded workflow child facts plus stored preflight hints into compact rows. */
export function projectAsyncWorkflowRows(
	steps: readonly AsyncJobStep[] | undefined,
	hostStepsOrPreflight?: readonly HostStepNodeV1[] | WorkflowGraphSnapshot | WorkflowPreflightV1,
	preflightOverride?: WorkflowPreflightV1,
): AsyncStatusWorkflowRow[] {
	const preflight = preflightOverride ?? (isWorkflowPreflight(hostStepsOrPreflight) ? hostStepsOrPreflight : undefined);
	const graph = isWorkflowGraph(hostStepsOrPreflight) ? hostStepsOrPreflight : undefined;
	const hostSteps = isWorkflowPreflight(hostStepsOrPreflight) || graph ? undefined : hostStepsOrPreflight;
	const loaded = steps ?? [];
	const declared = new Map<string, WorkflowPreflightLaneV1>();
	if (graph) {
		const loadedIndexesByKey = new Map<string, number[]>();
		for (const [index, step] of loaded.entries()) {
			if (!step.workflowKey) continue;
			const indexes = loadedIndexesByKey.get(step.workflowKey) ?? [];
			indexes.push(index);
			loadedIndexesByKey.set(step.workflowKey, indexes);
		}
		const consumed = new Set<number>();
		const childRows: AsyncStatusWorkflowRow[] = [];
		for (const lane of preflight?.lanes ?? []) declared.set(lane.key, lane);
		const graphStages = workflowGraphStageNodes(graph);
		const graphKeys = new Set(graphStages.map((node) => node.id));
		const graphPhaseByNodeId = new Map<string, string>();
		for (const phase of graph.phases) {
			for (const nodeId of phase.nodeIds) {
				if (graphKeys.has(nodeId) && !graphPhaseByNodeId.has(nodeId)) graphPhaseByNodeId.set(nodeId, phase.title);
			}
		}
		const graphLaneKeys = new Set(graphPhaseByNodeId.values());
		const preflightForNode = (node: WorkflowGraphSnapshot["nodes"][number]): WorkflowPreflightLaneV1 | undefined => {
			const phaseTitle = graphPhaseByNodeId.get(node.id);
			return declared.get(node.id) ?? (node.phase ? declared.get(node.phase) : undefined) ?? (phaseTitle ? declared.get(phaseTitle) : undefined);
		};
		for (const node of graphStages) {
			const indexes = (loadedIndexesByKey.get(node.id) ?? []).filter((index) => !consumed.has(index));
			if (indexes.length > 0) {
				for (const index of indexes) {
					consumed.add(index);
					childRows.push(projectLoadedWorkflowRow(loaded[index]!, index, preflightForNode(node)));
				}
			} else {
				childRows.push(projectWorkflowGraphRow(node, preflightForNode(node)));
			}
		}
		for (const lane of preflight?.lanes ?? []) {
			if (graphKeys.has(lane.key) || graphLaneKeys.has(lane.key)) continue;
			const indexes = (loadedIndexesByKey.get(lane.key) ?? []).filter((index) => !consumed.has(index));
			if (indexes.length > 0) {
				for (const index of indexes) {
					consumed.add(index);
					childRows.push(projectLoadedWorkflowRow(loaded[index]!, index, lane));
				}
			} else {
				childRows.push({ name: lane.key, state: "planned", preflight: lane });
			}
		}
		for (const [index, step] of loaded.entries()) {
			if (!consumed.has(index)) childRows.push(projectLoadedWorkflowRow(step, index, step.workflowKey ? declared.get(step.workflowKey) : undefined));
		}
		return [...childRows, ...validHostStepList(graph).map(hostStepRow)];
	}
	const loadedIndexByKey = new Map<string, number>();
	for (const [index, step] of loaded.entries()) {
		if (step.workflowKey !== undefined && !loadedIndexByKey.has(step.workflowKey)) loadedIndexByKey.set(step.workflowKey, index);
	}
	const consumed = new Set<number>();
	const childRows: AsyncStatusWorkflowRow[] = [];
	for (const lane of preflight?.lanes ?? []) {
		declared.set(lane.key, lane);
		const index = loadedIndexByKey.get(lane.key);
		if (index === undefined) {
			childRows.push({ name: lane.key, state: "planned", preflight: lane });
			continue;
		}
		consumed.add(index);
		childRows.push(projectLoadedWorkflowRow(loaded[index]!, index, lane));
	}
	for (const [index, step] of loaded.entries()) {
		if (consumed.has(index)) continue;
		childRows.push(projectLoadedWorkflowRow(step, index, step.workflowKey ? declared.get(step.workflowKey) : undefined));
	}
	return [...childRows, ...validHostStepList(hostSteps).map(hostStepRow)];
}

function projectLoadedWorkflowRow(step: AsyncJobStep, index: number, preflight?: WorkflowPreflightLaneV1): AsyncStatusWorkflowRow {
	const modelThinking = formatModelThinking(step.model, step.thinking) || undefined;
	const activity = workflowStepActivity(step);
	return {
		name: workflowStepName(step, index),
		state: step.status,
		...(step.context ? { context: step.context } : {}),
		...(modelThinking ? { modelThinking } : {}),
		...(activity ? { activity } : {}),
		...(step.startedAt !== undefined ? { startedAt: step.startedAt } : {}),
		...(step.tokens?.total !== undefined ? { tokens: step.tokens.total } : {}),
		...(step.tokens?.window !== undefined ? { window: step.tokens.window } : {}),
		...(preflight ? { preflight } : {}),
	};
}

/** Project already-loaded async status facts into the bounded public snapshot shape. */
export function projectAsyncStatusSnapshot(jobs: Iterable<AsyncJobState>, options: AsyncStatusSnapshotOptions = {}): AsyncStatusSnapshotV1 {
	const caps = resolveCaps(options);
	const ctx: ProjectionContext = { caps, omitted: { runs: 0, children: 0, byteLimitExceeded: false } };
	const sorted = [...jobs].sort((left, right) => {
		const leftUpdated = left.updatedAt ?? left.startedAt ?? 0;
		const rightUpdated = right.updatedAt ?? right.startedAt ?? 0;
		return rightUpdated - leftUpdated || left.asyncId.localeCompare(right.asyncId);
	});
	ctx.omitted.runs += Math.max(0, sorted.length - caps.maxRuns);
	const snapshot: AsyncStatusSnapshotV1 = {
		kind: ASYNC_STATUS_SNAPSHOT_KIND,
		version: ASYNC_STATUS_SNAPSHOT_VERSION,
		generatedAt: options.generatedAt ?? Date.now(),
		caps,
		omitted: ctx.omitted,
		runs: sorted.slice(0, caps.maxRuns).map((job) => projectRun(job, ctx)),
	};
	enforceByteLimit(snapshot);
	return snapshot;
}
