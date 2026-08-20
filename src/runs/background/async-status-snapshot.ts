import { sanitizeDisplayText, truncateDisplayText } from "../../shared/display-text.ts";
import type { AsyncJobState, AsyncJobStep, NestedRunSummary, NestedStepSummary, SubagentRunMode, SubagentState } from "../../shared/types.ts";

export const ASYNC_STATUS_SNAPSHOT_KIND = "pi-subagents.async-status-snapshot";
export const ASYNC_STATUS_SNAPSHOT_VERSION = 1;
export const ASYNC_STATUS_SNAPSHOT_WIDGET_PREFIX = "PI_SUBAGENT_ASYNC_JSON:";

const DEFAULT_MAX_RUNS = 20;
const DEFAULT_MAX_CHILDREN_PER_NODE = 8;
const DEFAULT_MAX_DEPTH = 3;
const DEFAULT_MAX_STRING_LENGTH = 160;
const DEFAULT_MAX_SERIALIZED_BYTES = 32 * 1024;

export type AsyncStatusSnapshotState = "queued" | "running" | "complete" | "failed" | "paused" | "stopped" | "rejected";
export type AsyncStatusSnapshotKind = "subagent" | "workflow" | "step";

export interface AsyncStatusSnapshotActivityV1 {
	state?: string;
	currentTool?: string;
	lastActivityAt?: number;
	currentToolStartedAt?: number;
	turnCount?: number;
	toolCount?: number;
}

export interface AsyncStatusSnapshotNodeV1 {
	id: string;
	kind: AsyncStatusSnapshotKind;
	label: string;
	state: AsyncStatusSnapshotState;
	startedAt?: number;
	updatedAt?: number;
	endedAt?: number;
	activity?: AsyncStatusSnapshotActivityV1;
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

interface BuildContext {
	caps: AsyncStatusSnapshotCapsV1;
	omitted: AsyncStatusSnapshotOmittedV1;
}

function resolveCaps(options: AsyncStatusSnapshotOptions = {}): AsyncStatusSnapshotCapsV1 {
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
	return value as AsyncStatusSnapshotState;
}

function terminalState(state: AsyncStatusSnapshotState): boolean {
	return state === "complete" || state === "failed" || state === "paused" || state === "stopped" || state === "rejected";
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
}, ctx: BuildContext): AsyncStatusSnapshotActivityV1 | undefined {
	const activity: AsyncStatusSnapshotActivityV1 = {
		...(typeof source.activityState === "string" ? { state: publicText(source.activityState, "unknown", ctx.caps.maxStringLength) } : {}),
		...(publicOptionalText(source.currentTool, ctx.caps.maxStringLength) ? { currentTool: publicOptionalText(source.currentTool, ctx.caps.maxStringLength) } : {}),
		...(publicTime(source.lastActivityAt) !== undefined ? { lastActivityAt: publicTime(source.lastActivityAt) } : {}),
		...(publicTime(source.currentToolStartedAt) !== undefined ? { currentToolStartedAt: publicTime(source.currentToolStartedAt) } : {}),
		...(publicCount(source.turnCount) !== undefined ? { turnCount: publicCount(source.turnCount) } : {}),
		...(publicCount(source.toolCount) !== undefined ? { toolCount: publicCount(source.toolCount) } : {}),
	};
	return Object.keys(activity).length ? activity : undefined;
}

function appendBoundedChildren(children: AsyncStatusSnapshotNodeV1[], source: readonly AsyncStatusSnapshotNodeV1[], ctx: BuildContext): void {
	const remaining = Math.max(0, ctx.caps.maxChildrenPerNode - children.length);
	children.push(...source.slice(0, remaining));
	ctx.omitted.children += Math.max(0, source.length - remaining);
}

function buildStepNode(step: AsyncJobStep | NestedStepSummary, index: number, depth: number, ctx: BuildContext): AsyncStatusSnapshotNodeV1 {
	const state = normalizeState(step.status);
	const updatedAt = publicTime(step.endedAt) ?? publicTime(step.lastActivityAt) ?? publicTime(step.startedAt);
	const node: AsyncStatusSnapshotNodeV1 = {
		id: publicText("workflowKey" in step && step.workflowKey ? step.workflowKey : "runId" in step && step.runId ? step.runId : `step:${index}`, `step:${index}`, ctx.caps.maxStringLength),
		kind: "step",
		label: publicText("label" in step && step.label ? step.label : step.agent, "step", ctx.caps.maxStringLength),
		state,
		...(publicTime(step.startedAt) !== undefined ? { startedAt: publicTime(step.startedAt) } : {}),
		...(updatedAt !== undefined ? { updatedAt } : {}),
		...(terminalState(state) && publicTime(step.endedAt) !== undefined ? { endedAt: publicTime(step.endedAt) } : {}),
		...(activityFor(step, ctx) ? { activity: activityFor(step, ctx) } : {}),
	};
	if (depth < ctx.caps.maxDepth && step.children?.length) {
		const nested = step.children.map((child, childIndex) => buildNestedNode(child, childIndex, depth + 1, ctx));
		const bounded: AsyncStatusSnapshotNodeV1[] = [];
		appendBoundedChildren(bounded, nested, ctx);
		if (bounded.length) node.children = bounded;
	} else if (step.children?.length) {
		ctx.omitted.children += step.children.length;
	}
	return node;
}

function buildNestedNode(child: NestedRunSummary, index: number, depth: number, ctx: BuildContext): AsyncStatusSnapshotNodeV1 {
	const state = normalizeState(child.state);
	const updatedAt = publicTime(child.lastUpdate) ?? publicTime(child.endedAt) ?? publicTime(child.lastActivityAt) ?? publicTime(child.startedAt);
	const node: AsyncStatusSnapshotNodeV1 = {
		id: publicText(child.id, `nested:${index}`, ctx.caps.maxStringLength),
		kind: kindForMode(child.mode),
		label: child.agent ? publicText(child.agent, "subagent", ctx.caps.maxStringLength) : labelForAgents(child.agents, child.mode ?? "subagent", ctx.caps.maxStringLength),
		state,
		...(publicTime(child.startedAt) !== undefined ? { startedAt: publicTime(child.startedAt) } : {}),
		...(updatedAt !== undefined ? { updatedAt } : {}),
		...(terminalState(state) && publicTime(child.endedAt) !== undefined ? { endedAt: publicTime(child.endedAt) } : {}),
		...(activityFor(child, ctx) ? { activity: activityFor(child, ctx) } : {}),
	};
	if (depth < ctx.caps.maxDepth) {
		const nestedSteps = child.steps?.map((step, stepIndex) => buildStepNode(step, stepIndex, depth + 1, ctx)) ?? [];
		const nestedChildren = child.children?.map((nested, childIndex) => buildNestedNode(nested, childIndex, depth + 1, ctx)) ?? [];
		const bounded: AsyncStatusSnapshotNodeV1[] = [];
		appendBoundedChildren(bounded, [...nestedSteps, ...nestedChildren], ctx);
		if (bounded.length) node.children = bounded;
	} else {
		ctx.omitted.children += (child.steps?.length ?? 0) + (child.children?.length ?? 0);
	}
	return node;
}

function buildRunNode(job: AsyncJobState, ctx: BuildContext): AsyncStatusSnapshotNodeV1 {
	const state = normalizeState(job.status);
	const updatedAt = publicTime(job.updatedAt) ?? publicTime(job.startedAt);
	const node: AsyncStatusSnapshotNodeV1 = {
		id: publicText(job.asyncId, "async", ctx.caps.maxStringLength),
		kind: kindForMode(job.mode),
		label: labelForAgents(job.agents, job.mode ?? "subagent", ctx.caps.maxStringLength),
		state,
		...(publicTime(job.startedAt) !== undefined ? { startedAt: publicTime(job.startedAt) } : {}),
		...(updatedAt !== undefined ? { updatedAt } : {}),
		...(terminalState(state) && updatedAt !== undefined ? { endedAt: updatedAt } : {}),
		...(activityFor(job, ctx) ? { activity: activityFor(job, ctx) } : {}),
	};
	if (ctx.caps.maxDepth > 0) {
		const stepChildren = job.steps?.map((step, index) => buildStepNode(step, step.index ?? index, 1, ctx)) ?? [];
		const nestedChildren = job.nestedChildren?.map((child, index) => buildNestedNode(child, index, 1, ctx)) ?? [];
		const bounded: AsyncStatusSnapshotNodeV1[] = [];
		appendBoundedChildren(bounded, [...stepChildren, ...nestedChildren], ctx);
		if (bounded.length) node.children = bounded;
	} else {
		ctx.omitted.children += (job.steps?.length ?? 0) + (job.nestedChildren?.length ?? 0);
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

export function buildAsyncStatusSnapshot(jobs: Iterable<AsyncJobState>, options: AsyncStatusSnapshotOptions = {}): AsyncStatusSnapshotV1 {
	const caps = resolveCaps(options);
	const ctx: BuildContext = { caps, omitted: { runs: 0, children: 0, byteLimitExceeded: false } };
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
		runs: sorted.slice(0, caps.maxRuns).map((job) => buildRunNode(job, ctx)),
	};
	enforceByteLimit(snapshot);
	return snapshot;
}

export function asyncStatusSnapshotJobsForState(state: SubagentState | undefined, sessionId: string | null | undefined): AsyncJobState[] {
	if (!state || !sessionId || state.currentSessionId !== sessionId) return [];
	const jobs = new Map<string, AsyncJobState>();
	for (const job of state.asyncJobs.values()) {
		if (job.sessionId === sessionId) jobs.set(job.asyncId, job);
	}
	for (const job of state.fleetJobs?.values() ?? []) {
		if (job.sessionId === sessionId && !jobs.has(job.asyncId)) jobs.set(job.asyncId, job);
	}
	return [...jobs.values()];
}

export function buildAsyncStatusSnapshotForState(state: SubagentState | undefined, sessionId: string | null | undefined, options: AsyncStatusSnapshotOptions = {}): AsyncStatusSnapshotV1 {
	return buildAsyncStatusSnapshot(asyncStatusSnapshotJobsForState(state, sessionId), options);
}

export function encodeAsyncStatusSnapshotWidget(jobs: Iterable<AsyncJobState>, options: AsyncStatusSnapshotOptions = {}): string[] {
	return [`${ASYNC_STATUS_SNAPSHOT_WIDGET_PREFIX}${JSON.stringify(buildAsyncStatusSnapshot(jobs, options))}`];
}
