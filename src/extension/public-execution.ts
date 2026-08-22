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
	chainName?: unknown;
	config?: unknown;
	workflowScript?: unknown;
	isolation?: unknown;
	worktree?: unknown;
	async?: unknown;
	output?: unknown;
	resume?: unknown;
	clarify?: unknown;
	workflowParentRunId?: unknown;
	workflowKey?: unknown;
	workflowChildAsyncId?: unknown;
	workflowAwaitAsync?: unknown;
	workflowParentDeadlineAt?: unknown;
	suppressRoutineResultIntercom?: unknown;
	runFanoutBudget?: unknown;
	runFanoutAdmitted?: unknown;
}

export type PublicSubagentExecutionMode = "workflow" | "management";

export type PublicSubagentExecutionNormalization<T> =
	| { ok: true; params: T }
	| { ok: false; error: string; mode: PublicSubagentExecutionMode };

/**
 * Enforce the public execution cutover before requests reach the executor.
 * Internal runs.run children and structured owned delegation bypass this boundary.
 */
export function normalizePublicSubagentExecution<T extends PublicSubagentExecutionParams>(params: T, options: { asyncByDefault?: boolean } = {}): PublicSubagentExecutionNormalization<T> {
	if (params.isolation !== undefined) {
		if (params.isolation !== "none" && params.isolation !== "worktree") {
			return { ok: false, error: "isolation must be 'none' or 'worktree'.", mode: params.workflowScript !== undefined ? "workflow" : "management" };
		}
		const isolationWorktree = params.isolation === "worktree";
		if (params.worktree !== undefined && params.worktree !== isolationWorktree) {
			return { ok: false, error: `isolation '${params.isolation}' conflicts with worktree: ${String(params.worktree)}.`, mode: params.workflowScript !== undefined ? "workflow" : "management" };
		}
		const { isolation: _isolation, ...normalizedParams } = params;
		params = { ...normalizedParams, worktree: isolationWorktree } as T;
	}
	if (params.runFanoutBudget !== undefined || params.runFanoutAdmitted !== undefined) {
		return { ok: false, error: "Public execution does not accept internal run fan-out fields.", mode: params.workflowScript !== undefined ? "workflow" : "management" };
	}
	if (params.workflowParentRunId !== undefined || params.workflowKey !== undefined || params.workflowChildAsyncId !== undefined || params.workflowAwaitAsync !== undefined || params.workflowParentDeadlineAt !== undefined || params.suppressRoutineResultIntercom !== undefined) {
		return { ok: false, error: "Public execution does not accept internal workflow child fields.", mode: params.workflowScript !== undefined ? "workflow" : "management" };
	}
	const action = params.action;
	if (action !== undefined && (typeof action !== "string" || !action.trim())) {
		return { ok: false, error: "action must be a non-empty management/control action, or omit action and use workflowScript.", mode: "management" };
	}
	const normalizedAction = typeof action === "string" ? action.trim() : undefined;
	if (params.clarify !== undefined) {
		return { ok: false, error: "Public workflowScript execution does not support clarify UI.", mode: "workflow" };
	}
	if (params.chainName !== undefined) {
		return { ok: false, error: "Durable chain management was removed; use workflowScript or /prompt-workflow for repeatable workflows.", mode: "management" };
	}
	if (params.config && typeof params.config === "object" && !Array.isArray(params.config) && Object.prototype.hasOwnProperty.call(params.config, "steps")) {
		return { ok: false, error: "Durable chain definitions were removed; use workflowScript or /prompt-workflow for repeatable workflows.", mode: "management" };
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
		if (legacyAction === "append-step") {
			return { ok: false, error: "Legacy append-step control was removed from the public subagent tool; use current workflowScript orchestration.", mode: "management" };
		}
		if (legacyAction === "approve-checkpoint" || legacyAction === "reject-checkpoint") {
			return { ok: false, error: "Legacy checkpoint approval controls were removed from the public subagent tool; use current workflowScript orchestration.", mode: "management" };
		}
		if (legacyAction === "single") {
			return { ok: false, error: "action='single' is not supported. Omit action and pass { agent, task } for one child.", mode: "workflow" };
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
		if (params.task !== undefined) {
			return { ok: false, error: "Structured single-child task cannot be combined with a management/control action.", mode: "management" };
		}
		return { ok: true, params: { ...params, action: normalizedAction } };
	}
	if (params.step !== undefined) {
		return { ok: false, error: "step is not a public execution field; use workflowScript for orchestration.", mode: "workflow" };
	}
	if (params.workflowScript !== undefined && (params.agent !== undefined || params.task !== undefined)) {
		return { ok: false, error: "Structured single-child execution cannot be combined with workflowScript.", mode: "workflow" };
	}
	if (params.agent !== undefined || params.task !== undefined) {
		if (typeof params.agent !== "string" || !params.agent.trim()) {
			return { ok: false, error: "Structured single-child execution requires agent to be a non-empty string.", mode: "workflow" };
		}
		if (params.task !== undefined && typeof params.task !== "string") {
			return { ok: false, error: "Structured single-child task must be a string when provided.", mode: "workflow" };
		}
		return {
			ok: true,
			params: {
				...params,
				agent: params.agent.trim(),
				output: params.output === undefined ? true : params.output,
			} as T,
		};
	}
	if (typeof params.workflowScript !== "string" || !params.workflowScript.trim()) {
		return { ok: false, error: "Execution requires either { agent, task? } for one child or a non-empty workflowScript for orchestration.", mode: "workflow" };
	}
	return { ok: true, params };
}
