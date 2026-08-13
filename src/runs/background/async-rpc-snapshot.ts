import { randomUUID } from "node:crypto";
import type { AsyncJobState, AsyncJobStep, NestedRunSummary, NestedStepSummary } from "../../shared/types.ts";

export const ASYNC_RPC_WIDGET_PREFIX = "PI_SUBAGENT_ASYNC_JSON:";
const MAX_RUNS = 64;
const MAX_CHILDREN = 256;
const MAX_DEPTH = 4;
const MAX_TEXT = 2_000;

export interface AsyncRpcChildSnapshot {
	key: string;
	index: number;
	agent?: string;
	label?: string;
	task?: string;
	status: string;
	model?: string;
	thinking?: string;
	currentTool?: string;
	durationMs?: number;
	startedAt?: number;
	endedAt?: number;
	runId?: string;
	children?: AsyncRpcChildSnapshot[];
}

export interface AsyncRpcRunSnapshot {
	asyncId: string;
	sessionId?: string;
	mode?: string;
	status: AsyncJobState["status"];
	description?: string;
	startedAt?: number;
	updatedAt?: number;
	currentStep?: number;
	stepsTotal?: number;
	children: AsyncRpcChildSnapshot[];
}

export interface AsyncRpcSnapshot {
	version: 1;
	sourceId: string;
	revision: number;
	generatedAt: number;
	runs: AsyncRpcRunSnapshot[];
}

function text(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim().slice(0, MAX_TEXT) : undefined;
}

function finite(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function nestedStep(step: NestedStepSummary, index: number, depth: number): AsyncRpcChildSnapshot {
	return {
		key: text((step as { workflowKey?: unknown }).workflowKey) ?? `step:${index}`,
		index,
		status: step.status,
		...(text(step.agent) ? { agent: text(step.agent) } : {}),
		...(text(step.model) ? { model: text(step.model) } : {}),
		...(text(step.thinking) ? { thinking: text(step.thinking) } : {}),
		...(text(step.currentTool) ? { currentTool: text(step.currentTool) } : {}),
		...(finite(step.startedAt) !== undefined ? { startedAt: finite(step.startedAt) } : {}),
		...(finite(step.endedAt) !== undefined ? { endedAt: finite(step.endedAt) } : {}),
		...(depth < MAX_DEPTH && step.children?.length
			? { children: step.children.slice(0, MAX_CHILDREN).map((child, childIndex) => nestedRun(child, childIndex, depth + 1)) }
			: {}),
	};
}

function nestedRun(run: NestedRunSummary, index: number, depth: number): AsyncRpcChildSnapshot {
	return {
		key: text(run.id) ?? `nested:${index}`,
		index,
		status: run.state,
		...(text(run.agent) ? { agent: text(run.agent) } : {}),
		...(finite(run.startedAt) !== undefined ? { startedAt: finite(run.startedAt) } : {}),
		...(finite(run.endedAt) !== undefined ? { endedAt: finite(run.endedAt) } : {}),
		...(depth < MAX_DEPTH && run.steps?.length
			? { children: run.steps.slice(0, MAX_CHILDREN).map((step, stepIndex) => nestedStep(step, stepIndex, depth + 1)) }
			: {}),
	};
}

function child(step: AsyncJobStep, fallbackIndex: number): AsyncRpcChildSnapshot {
	const index = finite(step.index) ?? fallbackIndex;
	return {
		key: text(step.workflowKey) ?? `step:${index}`,
		index,
		status: step.status,
		...(text(step.agent) ? { agent: text(step.agent) } : {}),
		...(text(step.label) ? { label: text(step.label) } : {}),
		...(text(step.description) ? { task: text(step.description) } : {}),
		...(text(step.model) ? { model: text(step.model) } : {}),
		...(text(step.thinking) ? { thinking: text(step.thinking) } : {}),
		...(text(step.currentTool) ? { currentTool: text(step.currentTool) } : {}),
		...(finite(step.durationMs) !== undefined ? { durationMs: finite(step.durationMs) } : {}),
		...(finite(step.startedAt) !== undefined ? { startedAt: finite(step.startedAt) } : {}),
		...(finite(step.endedAt) !== undefined ? { endedAt: finite(step.endedAt) } : {}),
		...(text(step.runId) ? { runId: text(step.runId) } : {}),
		...(step.children?.length
			? { children: step.children.slice(0, MAX_CHILDREN).map((nested, nestedIndex) => nestedRun(nested, nestedIndex, 1)) }
			: {}),
	};
}

function jobChildren(job: AsyncJobState): AsyncRpcChildSnapshot[] {
	const steps = (job.steps ?? []).slice(0, MAX_CHILDREN);
	const attached = new Set(steps.flatMap((step) => step.children?.map((nested) => nested.id) ?? []));
	const unattached = (job.nestedChildren ?? []).filter((nested) => !attached.has(nested.id));
	return [
		...steps.map(child),
		...unattached.slice(0, Math.max(0, MAX_CHILDREN - steps.length)).map((nested, index) => nestedRun(nested, steps.length + index, 1)),
	];
}

export function buildAsyncRpcRunSnapshot(job: AsyncJobState): AsyncRpcRunSnapshot {
	return {
		asyncId: job.asyncId,
		status: job.status,
		children: jobChildren(job),
		...(text(job.sessionId) ? { sessionId: text(job.sessionId) } : {}),
		...(text(job.mode) ? { mode: text(job.mode) } : {}),
		...(text(job.description) ? { description: text(job.description) } : {}),
		...(finite(job.startedAt) !== undefined ? { startedAt: finite(job.startedAt) } : {}),
		...(finite(job.updatedAt) !== undefined ? { updatedAt: finite(job.updatedAt) } : {}),
		...(finite(job.currentStep) !== undefined ? { currentStep: finite(job.currentStep) } : {}),
		...(finite(job.stepsTotal) !== undefined ? { stepsTotal: finite(job.stepsTotal) } : {}),
	};
}

const sourceId = randomUUID();
let revision = 0;

export function buildAsyncRpcSnapshotFromRuns(runs: AsyncRpcRunSnapshot[], now = Date.now()): AsyncRpcSnapshot {
	return { version: 1, sourceId, revision: ++revision, generatedAt: now, runs: runs.slice(0, MAX_RUNS) };
}

export function buildAsyncRpcSnapshot(jobs: AsyncJobState[], now = Date.now()): AsyncRpcSnapshot {
	return buildAsyncRpcSnapshotFromRuns(jobs.map(buildAsyncRpcRunSnapshot), now);
}

export function encodeAsyncRpcWidgetLines(jobs: AsyncJobState[], now = Date.now()): string[] {
	return [`${ASYNC_RPC_WIDGET_PREFIX}${JSON.stringify(buildAsyncRpcSnapshot(jobs, now))}`];
}
