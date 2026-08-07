export interface PublicSubagentExecutionParams {
	action?: unknown;
	agent?: unknown;
	task?: unknown;
	step?: unknown;
	tasks?: unknown;
	chain?: unknown;
	parallel?: unknown;
	concurrency?: unknown;
	chainDir?: unknown;
	workflowScript?: unknown;
	resume?: unknown;
	clarify?: unknown;
}

export type PublicSubagentExecutionMode = "workflow" | "management";

export type PublicSubagentExecutionNormalization<T> =
	| { ok: true; params: T }
	| { ok: false; error: string; mode: PublicSubagentExecutionMode };

/**
 * Enforce the public execution cutover before requests reach the executor.
 * Internal runs.run children and structured owned delegation bypass this boundary.
 */
export function normalizePublicSubagentExecution<T extends PublicSubagentExecutionParams>(params: T): PublicSubagentExecutionNormalization<T> {
	const action = params.action;
	if (action !== undefined && (typeof action !== "string" || !action.trim())) {
		return { ok: false, error: "action must be a non-empty management/control action, or omit action and use workflowScript.", mode: "management" };
	}
	const normalizedAction = typeof action === "string" ? action.trim() : undefined;
	if (params.clarify !== undefined) {
		return { ok: false, error: "Public workflowScript execution does not support clarify UI.", mode: "workflow" };
	}
	if (params.resume !== undefined) {
		return { ok: false, error: "Top-level resume execution is not available. Put resume on a workflowScript runs.run/runs.all item.", mode: "workflow" };
	}
	const hasLegacyOrchestration = params.tasks !== undefined || params.chain !== undefined || params.parallel !== undefined || params.concurrency !== undefined || params.chainDir !== undefined;
	if (hasLegacyOrchestration) {
		return { ok: false, error: "Legacy top-level chain and parallel inputs were removed; use workflowScript.", mode: normalizedAction ? "management" : "workflow" };
	}
	if (normalizedAction !== undefined) {
		const legacyAction = normalizedAction.toLowerCase();
		if (legacyAction === "single") {
			return { ok: false, error: "Direct execution was removed. Use workflowScript: \"return runs.run('main', { agent, task })\".", mode: "workflow" };
		}
		if (legacyAction === "parallel" || legacyAction === "tasks" || legacyAction === "chain") {
			return { ok: false, error: "Legacy top-level chain and parallel inputs were removed; use workflowScript.", mode: "workflow" };
		}
		if (normalizedAction === "schedule.create") {
			if (params.agent !== undefined || params.task !== undefined || params.step !== undefined) {
				return { ok: false, error: "schedule.create requires workflowScript and does not accept direct agent, task, or step execution fields.", mode: "management" };
			}
			if (typeof params.workflowScript !== "string" || !params.workflowScript.trim()) {
				return { ok: false, error: "schedule.create requires a non-empty workflowScript.", mode: "management" };
			}
			return { ok: true, params: { ...params, action: normalizedAction } };
		}
		if (params.workflowScript !== undefined) {
			return { ok: false, error: "workflowScript execution must omit action; only schedule.create accepts action with workflowScript.", mode: "management" };
		}
		return { ok: true, params: { ...params, action: normalizedAction } };
	}
	if (params.agent !== undefined || params.task !== undefined || params.step !== undefined) {
		return { ok: false, error: "Direct execution was removed. Use workflowScript: \"return runs.run('main', { agent, task })\".", mode: "workflow" };
	}
	if (typeof params.workflowScript !== "string" || !params.workflowScript.trim()) {
		return { ok: false, error: "Execution requires a non-empty workflowScript. Direct execution was removed; use workflowScript: \"return runs.run('main', { agent, task })\".", mode: "workflow" };
	}
	return { ok: true, params };
}
