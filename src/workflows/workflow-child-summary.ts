import type { AgentProgress, AsyncStatus, WorkflowChildActivity, WorkflowChildSummary } from "../shared/types.ts";
import type { WorkflowScriptChildResult, WorkflowScriptTraceEntry } from "./scripted-workflow.ts";

const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const TERMINAL_STATES = new Set(["completed", "failed", "paused", "stopped", "rejected", "detached"]);
const MAX_REQUIRED_ID_BYTES = 4_096;
const ACTIVITY_COUNTERS = ["currentToolStartedAt", "lastActivityAt", "durationMs", "toolCount", "turnCount", "tokens", "inputTokens", "outputTokens"] as const;
type WorkflowChildLiveProgress = WorkflowChildActivity & Pick<AgentProgress, "agent" | "sessionName" | "model" | "thinking">;

export function workflowChildProgress(progress: AgentProgress): WorkflowChildLiveProgress {
	return {
		...workflowChildActivity(progress),
		agent: bounded(progress.agent, 256) ?? "",
		...(bounded(progress.sessionName, 256) ? { sessionName: progress.sessionName } : {}),
		...(bounded(progress.model, 256) ? { model: progress.model } : {}),
		...(bounded(progress.thinking, 32) ? { thinking: progress.thinking } : {}),
	};
}

/** Fixed field count and a 256 UTF-8 byte tool name keep JSON activity below 2 KiB, including escaping. */
export function workflowChildActivity(progress: WorkflowChildActivity): WorkflowChildActivity {
	const activity: WorkflowChildActivity = {};
	if (bounded(progress.currentTool, 256)) activity.currentTool = progress.currentTool;
	for (const field of ACTIVITY_COUNTERS) {
		const value = progress[field];
		if (typeof value === "number" && Number.isFinite(value) && value >= 0) activity[field] = value;
	}
	return activity;
}

function parseActivity(value: unknown): WorkflowChildActivity | undefined {
	if (value === undefined) return undefined;
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("workflowChildren child activity is invalid.");
	const input = value as Record<string, unknown>;
	for (const [key, value] of Object.entries(input)) {
		if (key === "currentTool" ? !bounded(value, 256) : !ACTIVITY_COUNTERS.includes(key as typeof ACTIVITY_COUNTERS[number]) || typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error("workflowChildren child activity is invalid.");
	}
	return { ...input } as WorkflowChildActivity;
}

function bounded(value: unknown, maxBytes: number): string | undefined {
	if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value, "utf8") > maxBytes) return undefined;
	return value;
}

function requiredId(value: string, label: string): string {
	const id = bounded(value, MAX_REQUIRED_ID_BYTES);
	if (!id) throw new Error(`${label} must be a non-empty identifier of at most ${MAX_REQUIRED_ID_BYTES} UTF-8 bytes.`);
	return id;
}

export function workflowChildSummary(input: {
	parentToolCallId: string;
	workflowRunId: string;
	workflowState: WorkflowChildSummary["workflowState"];
	inventoryComplete: boolean;
	trace?: WorkflowScriptTraceEntry[];
	children?: WorkflowScriptChildResult[];
	steps?: NonNullable<AsyncStatus["steps"]>;
	/** In-memory snapshots from synchronous child callbacks, keyed by workflow key. */
	progress?: ReadonlyMap<string, WorkflowChildLiveProgress>;
}): WorkflowChildSummary {
	const rows = new Map<string, WorkflowChildSummary["children"][number]>();
	for (const entry of input.trace ?? []) {
		if (entry.operation !== "run" || !KEY_PATTERN.test(entry.key)) continue;
		const previous = rows.get(entry.key);
		const state = entry.state === "completed" ? "completed"
			: entry.state === "failed" ? "failed"
				: entry.state === "stopped" ? "stopped"
					: entry.state === "detached" ? "detached"
						: previous?.state ?? "running";
		rows.set(entry.key, {
			childId: entry.key,
			state,
			...(bounded(entry.runId, 256) ? { runId: bounded(entry.runId, 256) } : {}),
			...(previous?.agent ? { agent: previous.agent } : {}),
			...(previous?.sessionName ? { sessionName: previous.sessionName } : {}),
			...(previous?.model ? { model: previous.model } : {}),
			...(previous?.thinking ? { thinking: previous.thinking } : {}),
		});
	}
	for (const step of input.steps ?? []) {
		const key = step.workflowKey;
		if (!key || !KEY_PATTERN.test(key)) continue;
		const state = step.status === "complete" || step.status === "completed" ? "completed"
			: step.status === "failed" ? "failed"
				: step.status === "paused" ? "paused"
					: step.status === "stopped" ? "stopped"
						: step.status === "rejected" ? "rejected"
							: step.status === "pending" ? "pending" : "running";
		const launchResolved = step.async !== undefined || step.sessionFile !== undefined || step.runId !== undefined || step.model !== undefined;
		rows.set(key, {
			childId: key,
			state,
			...(bounded(step.runId, 256) ? { runId: bounded(step.runId, 256) } : {}),
			...(launchResolved && bounded(step.agent, 256) ? { agent: bounded(step.agent, 256) } : {}),
			...(bounded(step.sessionName, 256) ? { sessionName: bounded(step.sessionName, 256) } : {}),
			...(bounded(step.model, 256) ? { model: bounded(step.model, 256) } : {}),
			...(bounded(step.thinking, 32) ? { thinking: bounded(step.thinking, 32) } : {}),
		});
	}
	for (const child of input.children ?? []) {
		if (!KEY_PATTERN.test(child.key)) continue;
		const result = Array.isArray(child.results) ? child.results.find((value) => value && typeof value === "object") as Record<string, unknown> | undefined : undefined;
		const state = child.detached ? "detached" : child.stopped ? "stopped" : child.interrupted ? "paused" : child.ok ? "completed" : result?.acceptance && typeof result.acceptance === "object" && (result.acceptance as { status?: unknown }).status === "rejected" ? "rejected" : "failed";
		rows.set(child.key, {
			childId: child.key,
			state,
			...(bounded(child.runId, 256) ? { runId: bounded(child.runId, 256) } : {}),
			...(bounded(child.agent, 256) ? { agent: bounded(child.agent, 256) } : {}),
			...(bounded(result?.sessionName, 256) ? { sessionName: bounded(result?.sessionName, 256) } : {}),
			...(bounded(result?.model, 256) ? { model: bounded(result?.model, 256) } : {}),
			...(bounded(result?.thinking, 32) ? { thinking: bounded(result?.thinking, 32) } : {}),
		});
	}
	if (input.inventoryComplete) {
		for (const [key, row] of rows) {
			if (!TERMINAL_STATES.has(row.state)) rows.set(key, { ...row, state: input.workflowState === "stopped" ? "stopped" : "failed" });
		}
	}
	for (const [key, progress] of input.progress ?? []) {
		const row = rows.get(key);
		if (!row || row.state !== "running") continue;
		rows.set(key, {
			...row,
			...(bounded(progress.agent, 256) ? { agent: progress.agent } : {}),
			...(bounded(progress.sessionName, 256) ? { sessionName: progress.sessionName } : {}),
			...(bounded(progress.model, 256) ? { model: progress.model } : {}),
			...(bounded(progress.thinking, 32) ? { thinking: progress.thinking } : {}),
			activity: workflowChildActivity(progress),
		});
	}
	return {
		version: 1,
		parentToolCallId: requiredId(input.parentToolCallId, "parentToolCallId"),
		workflowRunId: requiredId(input.workflowRunId, "workflowRunId"),
		inventoryComplete: input.inventoryComplete,
		workflowState: input.workflowState,
		children: [...rows.values()],
	};
}

export function parseWorkflowChildSummary(value: unknown): WorkflowChildSummary | undefined {
	if (value === undefined) return undefined;
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("workflowChildren must be an object.");
	const input = value as Record<string, unknown>;
	const allowed = new Set(["version", "parentToolCallId", "workflowRunId", "inventoryComplete", "workflowState", "children"]);
	if (Object.keys(input).some((key) => !allowed.has(key))) throw new Error("workflowChildren has unsupported fields.");
	if (input.version !== 1 || typeof input.inventoryComplete !== "boolean" || !Array.isArray(input.children)) throw new Error("workflowChildren is invalid.");
	const workflowState = input.workflowState;
	if (workflowState !== "queued" && workflowState !== "running" && workflowState !== "completed" && workflowState !== "failed" && workflowState !== "paused" && workflowState !== "stopped") throw new Error("workflowChildren.workflowState is invalid.");
	const children = input.children.map((row): WorkflowChildSummary["children"][number] => {
		if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error("workflowChildren child row is invalid.");
		const child = row as Record<string, unknown>;
		if (Object.keys(child).some((key) => !["childId", "runId", "agent", "sessionName", "model", "thinking", "state", "activity"].includes(key))) throw new Error("workflowChildren child row has unsupported fields.");
		if (typeof child.childId !== "string" || !KEY_PATTERN.test(child.childId)) throw new Error("workflowChildren childId is invalid.");
		const state = child.state;
		if (state !== "pending" && state !== "running" && state !== "completed" && state !== "failed" && state !== "paused" && state !== "stopped" && state !== "rejected" && state !== "detached") throw new Error("workflowChildren child state is invalid.");
		for (const [field, maxBytes] of [["runId", 256], ["agent", 256], ["sessionName", 256], ["model", 256], ["thinking", 32]] as const) {
			if (child[field] !== undefined && bounded(child[field], maxBytes) === undefined) throw new Error(`workflowChildren child ${field} is invalid.`);
		}
		const activity = parseActivity(child.activity);
		if (activity && state !== "running") throw new Error("workflowChildren child activity requires running state.");
		return { childId: child.childId, state, ...(activity ? { activity } : {}), ...(child.runId ? { runId: child.runId as string } : {}), ...(child.agent ? { agent: child.agent as string } : {}), ...(child.sessionName ? { sessionName: child.sessionName as string } : {}), ...(child.model ? { model: child.model as string } : {}), ...(child.thinking ? { thinking: child.thinking as string } : {}) };
	});
	if (new Set(children.map((child) => child.childId)).size !== children.length) throw new Error("workflowChildren has duplicate childId values.");
	if (typeof input.parentToolCallId !== "string") throw new Error("workflowChildren.parentToolCallId is invalid.");
	if (typeof input.workflowRunId !== "string") throw new Error("workflowChildren.workflowRunId is invalid.");
	return { version: 1, parentToolCallId: requiredId(input.parentToolCallId, "workflowChildren.parentToolCallId"), workflowRunId: requiredId(input.workflowRunId, "workflowChildren.workflowRunId"), inventoryComplete: input.inventoryComplete, workflowState, children };
}
