import { sanitizeDisplayText, truncateDisplayText } from "../shared/display-text.ts";
import type { AsyncJobState, AsyncJobStep, ForegroundChildControl, ForegroundRunControl, ForegroundResumeRun, SubagentState, TokenUsage } from "../shared/types.ts";
import {
	CURRENT_WORK_MAX_CHILDREN,
	CURRENT_WORK_MAX_DEPTH,
	CURRENT_WORK_MAX_ROOTS,
	CURRENT_WORK_MAX_SERIALIZED_BYTES,
	CURRENT_WORK_MAX_STRING_LENGTH,
	CURRENT_WORK_PROJECTION_KIND,
	CURRENT_WORK_PROJECTION_VERSION,
	type CurrentWorkActivityV1,
	type CurrentWorkCapsV1,
	type CurrentWorkMode,
	type CurrentWorkNodeV1,
	type CurrentWorkProjectionV1,
	type CurrentWorkState,
	type CurrentWorkTokensV1,
} from "../api/current-work.ts";
import type { CurrentWorkAttentionState } from "../api/current-work.ts";

export {
	CURRENT_WORK_MAX_CHILDREN,
	CURRENT_WORK_MAX_DEPTH,
	CURRENT_WORK_MAX_ROOTS,
	CURRENT_WORK_MAX_SERIALIZED_BYTES,
	CURRENT_WORK_MAX_STRING_LENGTH,
	CURRENT_WORK_PROJECTION_KIND,
	CURRENT_WORK_PROJECTION_VERSION,
	type CurrentWorkActivityV1,
	type CurrentWorkCapsV1,
	type CurrentWorkMode,
	type CurrentWorkNodeV1,
	type CurrentWorkOmittedV1,
	type CurrentWorkProjectionV1,
	type CurrentWorkState,
	type CurrentWorkTokensV1,
} from "../api/current-work.ts";
export type { CurrentWorkAttentionState } from "../api/current-work.ts";

export interface CurrentWorkKeyState {
	sessionId: string | null;
	next: number;
	keys: Map<string, string>;
}

export interface CurrentWorkProjectionOptions {
	generatedAt?: number;
	maxRoots?: number;
	maxChildrenPerNode?: number;
	maxDepth?: number;
	maxStringLength?: number;
	maxSerializedBytes?: number;
	keys?: CurrentWorkKeyState;
}

interface BuildContext {
	caps: CurrentWorkCapsV1;
	omitted: { roots: number; children: number; byteLimitExceeded: boolean };
	keys: CurrentWorkKeyState;
}

interface SourceNode {
	internalKey: string;
	goal?: unknown;
	agent?: unknown;
	role?: unknown;
	mode?: unknown;
	state?: unknown;
	startedAt?: unknown;
	updatedAt?: unknown;
	endedAt?: unknown;
	activityState?: unknown;
	currentTool?: unknown;
	lastActivityAt?: unknown;
	currentToolStartedAt?: unknown;
	turnCount?: unknown;
	toolCount?: unknown;
	tokens?: unknown;
	children?: SourceNode[];
}

const TERMINAL_STATES = new Set(["complete", "completed", "failed", "paused", "stopped", "rejected"]);
const ACTIVE_STATES = new Set(["queued", "pending", "running"]);

function caps(options: CurrentWorkProjectionOptions): CurrentWorkCapsV1 {
	const nonNegative = (value: number | undefined, fallback: number) => Math.max(0, Math.floor(value ?? fallback));
	return {
		maxRoots: nonNegative(options.maxRoots, CURRENT_WORK_MAX_ROOTS),
		maxChildrenPerNode: nonNegative(options.maxChildrenPerNode, CURRENT_WORK_MAX_CHILDREN),
		maxDepth: nonNegative(options.maxDepth, CURRENT_WORK_MAX_DEPTH),
		maxStringLength: nonNegative(options.maxStringLength, CURRENT_WORK_MAX_STRING_LENGTH),
		maxSerializedBytes: Math.max(256, Math.floor(options.maxSerializedBytes ?? CURRENT_WORK_MAX_SERIALIZED_BYTES)),
	};
}

function text(value: unknown, fallback: string | undefined, limit: number): string | undefined {
	if (typeof value !== "string") return fallback;
	const clean = sanitizeDisplayText(value.slice(0, Math.max(0, limit * 4)));
	return clean ? truncateDisplayText(clean, limit) : fallback;
}

function time(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function count(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.min(Number.MAX_SAFE_INTEGER, Math.floor(value)) : undefined;
}

function tokens(value: unknown): CurrentWorkTokensV1 | undefined {
	if (typeof value === "number") {
		const total = count(value);
		return total === undefined ? undefined : { input: 0, output: 0, total };
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const source = value as Partial<TokenUsage>;
	const input = count(source.input) ?? 0;
	const output = count(source.output) ?? 0;
	const total = Math.max(input + output, count(source.total) ?? 0);
	if (input === 0 && output === 0 && total === 0 && source.input === undefined && source.output === undefined && source.total === undefined) return undefined;
	return { input, output, total: Math.min(Number.MAX_SAFE_INTEGER, total) };
}

function state(value: unknown, fallback: CurrentWorkState = "running"): CurrentWorkState {
	if (value === "completed") return "complete";
	if (value === "pending") return "queued";
	if (value === "detached") return "running";
	return value === "queued" || value === "running" || value === "complete" || value === "failed" || value === "paused" || value === "stopped" || value === "rejected" ? value : fallback;
}

function mode(value: unknown): CurrentWorkMode {
	return value === "chain" || value === "parallel" ? value : "single";
}

function keyFor(ctx: BuildContext, internalKey: string): string {
	let key = ctx.keys.keys.get(internalKey);
	if (!key) {
		key = `work-${++ctx.keys.next}`;
		ctx.keys.keys.set(internalKey, key);
	}
	return key;
}

function activity(source: SourceNode, maxStringLength: number): CurrentWorkActivityV1 | undefined {
	const currentTool = text(source.currentTool, undefined, maxStringLength);
	const attentionState: CurrentWorkAttentionState | undefined = source.activityState === "active_long_running" || source.activityState === "needs_attention" ? source.activityState : undefined;
	const output: CurrentWorkActivityV1 = {
		...(attentionState ? { state: attentionState } : {}),
		...(currentTool ? { currentTool } : {}),
		...(time(source.lastActivityAt) !== undefined ? { lastActivityAt: time(source.lastActivityAt) } : {}),
		...(time(source.currentToolStartedAt) !== undefined ? { currentToolStartedAt: time(source.currentToolStartedAt) } : {}),
		...(count(source.turnCount) !== undefined ? { turnCount: count(source.turnCount) } : {}),
		...(count(source.toolCount) !== undefined ? { toolCount: count(source.toolCount) } : {}),
	};
	return Object.keys(output).length ? output : undefined;
}

function node(source: SourceNode, depth: number, ctx: BuildContext): CurrentWorkNodeV1 {
	const currentState = state(source.state);
	const startedAt = time(source.startedAt);
	const updatedAt = time(source.updatedAt) ?? time(source.lastActivityAt) ?? time(source.endedAt) ?? startedAt;
	const endedAt = TERMINAL_STATES.has(String(source.state)) ? time(source.endedAt) ?? updatedAt : undefined;
	const output: CurrentWorkNodeV1 = {
		key: keyFor(ctx, source.internalKey),
		...(text(source.goal, undefined, ctx.caps.maxStringLength) ? { goal: text(source.goal, undefined, ctx.caps.maxStringLength) } : {}),
		...(text(source.agent, undefined, ctx.caps.maxStringLength) ? { agent: text(source.agent, undefined, ctx.caps.maxStringLength) } : {}),
		...(text(source.role, undefined, ctx.caps.maxStringLength) ? { role: text(source.role, undefined, ctx.caps.maxStringLength) } : {}),
		mode: mode(source.mode),
		state: currentState,
		...(startedAt !== undefined ? { startedAt } : {}),
		...(updatedAt !== undefined ? { updatedAt } : {}),
		...(endedAt !== undefined ? { endedAt } : {}),
		...(activity(source, ctx.caps.maxStringLength) ? { activity: activity(source, ctx.caps.maxStringLength) } : {}),
		...(tokens(source.tokens) ? { tokens: tokens(source.tokens) } : {}),
	};
	if (source.children?.length) {
		if (depth >= ctx.caps.maxDepth) {
			ctx.omitted.children += source.children.length;
		} else {
			const allowed = source.children.slice(0, ctx.caps.maxChildrenPerNode);
			output.children = allowed.map((child) => node(child, depth + 1, ctx));
			ctx.omitted.children += Math.max(0, source.children.length - allowed.length);
		}
	}
	return output;
}

function childNode(internalKey: string, child: Record<string, unknown>, _rootMode: CurrentWorkMode): SourceNode {
	const nested = Array.isArray(child.children)
		? child.children.filter((value): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value) && !workflowOwned(value))
			.map((value, index) => childNode(`${internalKey}:child:${index}`, value, "single"))
		: undefined;
	return {
		internalKey,
		goal: child.description,
		agent: child.agent,
		role: child.label,
		mode: mode(child.mode),
		state: child.status ?? child.state,
		startedAt: child.startedAt,
		endedAt: child.endedAt,
		updatedAt: child.updatedAt ?? child.lastActivityAt,
		activityState: child.activityState,
		currentTool: child.currentTool,
		lastActivityAt: child.lastActivityAt,
		currentToolStartedAt: child.currentToolStartedAt,
		turnCount: child.turnCount,
		toolCount: child.toolCount,
		tokens: child.tokens,
		children: nested,
	};
}

function foregroundControlSource(control: ForegroundRunControl): SourceNode {
	const rootMode = mode(control.mode);
	const children = control.activeChildren ? [...control.activeChildren.values()].map((child: ForegroundChildControl) => childNode(`foreground:${control.runId}:child:${child.index}`, child as unknown as Record<string, unknown>, rootMode)) : undefined;
	return {
		internalKey: `foreground:${control.runId}`,
		goal: control.description,
		agent: control.currentAgent,
		mode: rootMode,
		state: "running",
		startedAt: control.startedAt,
		updatedAt: control.updatedAt,
		activityState: control.currentActivityState,
		currentTool: control.currentTool,
		lastActivityAt: control.lastActivityAt,
		currentToolStartedAt: control.currentToolStartedAt,
		turnCount: control.turnCount,
		toolCount: control.toolCount,
		tokens: { input: control.inputTokens ?? 0, output: control.outputTokens ?? 0, total: control.tokens ?? 0 },
		children,
	};
}

function asyncSource(job: AsyncJobState): SourceNode {
	const rootMode = mode(job.mode);
	const steps = job.steps?.length ? job.steps : job.agents?.map((agent, index) => ({ agent, index, status: job.status === "queued" ? "pending" : job.status } as AsyncJobStep));
	const visibleSteps = steps?.filter((step) => !workflowOwned(step));
	const children = visibleSteps?.map((step, index) => childNode(`async:${job.asyncId}:step:${step.index ?? index}`, step as unknown as Record<string, unknown>, rootMode));
	const nested = job.nestedChildren?.filter((child) => !workflowOwned(child)).map((child, index) => childNode(`async:${job.asyncId}:nested:${index}`, child as unknown as Record<string, unknown>, rootMode));
	return {
		internalKey: `async:${job.asyncId}`,
		goal: job.description,
		agent: job.agents?.[job.currentStep ?? 0],
		mode: rootMode,
		state: job.status,
		startedAt: job.startedAt,
		updatedAt: job.updatedAt,
		activityState: job.activityState,
		currentTool: job.currentTool,
		lastActivityAt: job.lastActivityAt,
		currentToolStartedAt: job.currentToolStartedAt,
		turnCount: job.turnCount,
		toolCount: job.toolCount,
		tokens: job.totalTokens,
		children: [...(children ?? []), ...(nested ?? [])],
	};
}

function foregroundHistorySource(run: ForegroundResumeRun): SourceNode {
	const children = run.children.map((child) => childNode(`foreground:${run.runId}:child:${child.index}`, child as unknown as Record<string, unknown>, mode(run.mode)));
	const childStates = children.map((child) => state(child.state, "complete"));
	const aggregate = childStates.some((item) => item === "running") ? "running"
		: childStates.some((item) => item === "failed") ? "failed"
		: childStates.some((item) => item === "paused") ? "paused"
		: childStates.some((item) => item === "stopped") ? "stopped"
		: "complete";
	return {
		internalKey: `foreground:${run.runId}`,
		mode: mode(run.mode),
		state: aggregate,
		updatedAt: run.updatedAt,
		endedAt: run.updatedAt,
		children,
	};
}

function workflowOwned(source: { mode?: unknown; parentWorkflowRunId?: unknown; workflowKey?: unknown }): boolean {
	return source.mode === "workflow" || typeof source.parentWorkflowRunId === "string" || typeof source.workflowKey === "string";
}

function rootPriority(source: SourceNode): number {
	const normalized = state(source.state);
	if (source.activityState === "needs_attention" || normalized === "paused") return 3;
	if (normalized === "running") return 2;
	if (normalized === "queued") return 1;
	return 0;
}

function serializedBytes(value: CurrentWorkProjectionV1): number {
	return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function resolveKeys(options: CurrentWorkProjectionOptions, sessionId: string | null): CurrentWorkKeyState {
	const keys = options.keys ?? { sessionId: null, next: 0, keys: new Map<string, string>() };
	if (keys.sessionId !== sessionId) {
		keys.sessionId = sessionId;
		keys.next = 0;
		keys.keys.clear();
	}
	return keys;
}

export function buildCurrentWorkProjection(state: SubagentState | undefined, sessionId: string | null | undefined, options: CurrentWorkProjectionOptions = {}): CurrentWorkProjectionV1 {
	const resolvedSessionId = sessionId ?? null;
	const resolvedCaps = caps(options);
	const projection: CurrentWorkProjectionV1 = {
		kind: CURRENT_WORK_PROJECTION_KIND,
		version: CURRENT_WORK_PROJECTION_VERSION,
		generatedAt: Date.now(),
		caps: resolvedCaps,
		omitted: { roots: 0, children: 0, byteLimitExceeded: false },
		roots: [],
	};
	if (options.generatedAt !== undefined && time(options.generatedAt) !== undefined) projection.generatedAt = options.generatedAt;
	const ctx: BuildContext = { caps: resolvedCaps, omitted: projection.omitted, keys: resolveKeys(options, resolvedSessionId) };
	if (!state || !resolvedSessionId || state.currentSessionId !== resolvedSessionId) return projection;

	const sources: SourceNode[] = [];
	const activeForeground = new Set<string>();
	for (const control of state.foregroundControls.values()) {
		if (control.sessionId !== resolvedSessionId || workflowOwned(control)) continue;
		activeForeground.add(control.runId);
		sources.push(foregroundControlSource(control));
	}
	const jobs = new Map<string, AsyncJobState>();
	for (const job of state.asyncJobs.values()) jobs.set(job.asyncId, job);
	for (const job of state.fleetJobs?.values() ?? []) if (!jobs.has(job.asyncId)) jobs.set(job.asyncId, job);
	for (const job of jobs.values()) {
		if (job.sessionId !== resolvedSessionId || workflowOwned(job) || ![...ACTIVE_STATES, ...TERMINAL_STATES].some((item) => item === job.status)) continue;
		sources.push(asyncSource(job));
	}
	for (const run of state.foregroundRuns?.values() ?? []) {
		if (run.sessionId !== resolvedSessionId || activeForeground.has(run.runId) || workflowOwned(run)) continue;
		sources.push(foregroundHistorySource(run));
	}
	sources.sort((left, right) => (rootPriority(right) - rootPriority(left)) || ((time(right.updatedAt) ?? 0) - (time(left.updatedAt) ?? 0)) || left.internalKey.localeCompare(right.internalKey));
	const allowed = sources.slice(0, resolvedCaps.maxRoots);
	projection.roots = allowed.map((source) => node(source, 0, ctx));
	projection.omitted.roots += Math.max(0, sources.length - allowed.length);
	while (projection.roots.length && serializedBytes(projection) > resolvedCaps.maxSerializedBytes) {
		projection.roots.pop();
		projection.omitted.roots += 1;
		projection.omitted.byteLimitExceeded = true;
	}
	if (serializedBytes(projection) > resolvedCaps.maxSerializedBytes) projection.omitted.byteLimitExceeded = true;
	return projection;
}
