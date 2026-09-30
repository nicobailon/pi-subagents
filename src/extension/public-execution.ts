import { normalizeWorktreeBaseRef } from "../runs/shared/worktree.ts";

export interface PublicSubagentExecutionParams {
	action?: unknown;
	capabilities?: unknown;
	mode?: unknown;
	repo?: unknown;
	planId?: unknown;
	agent?: unknown;
	task?: unknown;
	handoffPath?: unknown;
	laneId?: unknown;
	merge?: unknown;
	supersession?: unknown;
	step?: unknown;
	tasks?: unknown;
	chain?: unknown;
	parallel?: unknown;
	concurrency?: unknown;
	chainDir?: unknown;
	chainName?: unknown;
	config?: unknown;
	workflow?: unknown;
	args?: unknown;
	workflowScript?: unknown;
	workflowScriptPath?: unknown;
	sessionOnly?: unknown;
	globalConcurrencyLimit?: unknown;
	maxSubagentSpawnsPerRun?: unknown;
	preflight?: unknown;
	isolation?: unknown;
	worktree?: unknown;
	baseRef?: unknown;
	lane?: unknown;
	async?: unknown;
	output?: unknown;
	resume?: unknown;
	clarify?: unknown;
	workflowParentRunId?: unknown;
	workflowKey?: unknown;
	workflowChildAsyncId?: unknown;
	workflowAwaitAsync?: unknown;
	workflowAwaitDetached?: unknown;
	workflowParentDeadlineAt?: unknown;
	suppressRoutineResultIntercom?: unknown;
	runFanoutBudget?: unknown;
	runFanoutAdmitted?: unknown;
}

export type PublicSubagentExecutionMode = "workflow" | "management";

export type PublicSubagentExecutionNormalization<T> =
	| { ok: true; params: T }
	| { ok: false; error: string; mode: PublicSubagentExecutionMode };

const RAW_SCRIPT_FORMS = "workflow: true or a workflow script path";
const REMOVED_WORKFLOW_SCRIPT = "workflowScript was removed; write the script in one ```js workflow block in this reply and call subagent({ workflow: true }), or pass a script file as workflow: \"./path/to/script.js\".";
const REMOVED_WORKFLOW_SCRIPT_PATH = "workflowScriptPath was removed; pass the script file as workflow: \"./path/to/script.js\" (a workflow value containing '/' is a path).";

/** A workflow value containing "/" or "\" is a script path; named workflow resource names contain neither. */
export function isWorkflowScriptPath(workflow: string): boolean {
	return workflow.includes("/") || workflow.includes("\\");
}

/**
 * Model tool calls supply script text only through workflow: true (the reply block) or a script path.
 * workflowScript remains the internal carrier for slash, prompt-workflow, scheduled, RPC, and named-resource launches.
 */
export function removedModelWorkflowFieldError(params: object): string | undefined {
	if (Object.hasOwn(params, "workflowScript")) return REMOVED_WORKFLOW_SCRIPT;
	if (Object.hasOwn(params, "workflowScriptPath")) return REMOVED_WORKFLOW_SCRIPT_PATH;
	return undefined;
}

export function validateWorkflowCapacityOverrides(params: PublicSubagentExecutionParams): string | undefined {
	for (const [name, value] of [
		["globalConcurrencyLimit", params.globalConcurrencyLimit],
		["maxSubagentSpawnsPerRun", params.maxSubagentSpawnsPerRun],
	] as const) {
		if (value !== undefined && (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)) return `${name} must be a positive safe integer.`;
	}
}

/**
 * Enforce the public execution cutover before requests reach the executor.
 * Internal runs.run children and structured owned delegation bypass this boundary.
 */
export function normalizePublicSubagentExecution<T extends PublicSubagentExecutionParams>(params: T, options: { structuredWorkflows?: boolean } = {}): PublicSubagentExecutionNormalization<T> {
	for (const field of ["resource", "resourceProvenance", "workflowResource", "workflowResourceProvenance", "workflowResourcePermit", "resourcePermit", "permit"] as const) {
		if (Object.hasOwn(params, field) && (params as Record<string, unknown>)[field] !== undefined) {
			return { ok: false, error: "Public execution does not accept workflow resource provenance or permit fields.", mode: params.action === undefined ? "workflow" : "management" };
		}
	}
	if (params.baseRef !== undefined) {
		try {
			normalizeWorktreeBaseRef(params.baseRef);
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error), mode: params.action === undefined ? "workflow" : "management" };
		}
	}
	if (params.workflowScriptPath !== undefined) {
		return { ok: false, error: REMOVED_WORKFLOW_SCRIPT_PATH, mode: params.action === undefined ? "workflow" : "management" };
	}
	const workflow = params.workflow;
	if (workflow !== undefined && workflow !== true && (typeof workflow !== "string" || !workflow.trim())) {
		return { ok: false, error: "workflow must be true (the ```js workflow block in this reply), a script path containing '/', or a named workflow resource.", mode: "workflow" };
	}
	const hasNamedWorkflow = typeof workflow === "string" && !isWorkflowScriptPath(workflow);
	// workflowScript is the internal script carrier; model tool calls cannot set it.
	if (workflow !== undefined && params.workflowScript !== undefined) {
		return { ok: false, error: "workflow cannot be combined with an internal workflowScript.", mode: "workflow" };
	}
	const hasRawScript = params.workflowScript !== undefined || (workflow !== undefined && !hasNamedWorkflow);
	const hasWorkflowInput = hasRawScript || hasNamedWorkflow;
	if (!hasWorkflowInput && params.args !== undefined) {
		return { ok: false, error: "args requires workflow.", mode: "workflow" };
	}
	const hasCapacityOverride = params.globalConcurrencyLimit !== undefined || params.maxSubagentSpawnsPerRun !== undefined;
	if (hasCapacityOverride) {
		const capacityOverrideError = validateWorkflowCapacityOverrides(params);
		if (capacityOverrideError) return { ok: false, error: capacityOverrideError, mode: params.action === undefined ? "workflow" : "management" };
		const validatesSpawnBudget = typeof params.action === "string" && params.action.trim() === "validate"
			&& params.globalConcurrencyLimit === undefined && params.maxSubagentSpawnsPerRun !== undefined;
		if ((params.action !== undefined && !validatesSpawnBudget) || !hasRawScript) {
			return { ok: false, error: `Workflow capacity overrides are only supported on top-level ${RAW_SCRIPT_FORMS} calls; validate accepts maxSubagentSpawnsPerRun for static budget checks.`, mode: params.action === undefined ? "workflow" : "management" };
		}
	}
	if (params.preflight !== undefined && !hasWorkflowInput) {
		return { ok: false, error: `preflight requires ${RAW_SCRIPT_FORMS}.`, mode: params.action === undefined ? "workflow" : "management" };
	}
	if (params.preflight !== undefined && hasNamedWorkflow) {
		return { ok: false, error: "preflight is not supported with named workflow resources.", mode: "workflow" };
	}
	const hasValidWorkflowInput = workflow !== undefined || (typeof params.workflowScript === "string" && Boolean(params.workflowScript.trim()));
	if (params.isolation !== undefined) {
		if (params.isolation !== "none" && params.isolation !== "worktree") {
			return { ok: false, error: "isolation must be 'none' or 'worktree'.", mode: hasWorkflowInput ? "workflow" : "management" };
		}
		const isolationWorktree = params.isolation === "worktree";
		if (params.worktree !== undefined && params.worktree !== isolationWorktree) {
			return { ok: false, error: `isolation '${params.isolation}' conflicts with worktree: ${String(params.worktree)}.`, mode: hasWorkflowInput ? "workflow" : "management" };
		}
		const { isolation: _isolation, ...normalizedParams } = params;
		params = { ...normalizedParams, worktree: isolationWorktree } as T;
	}
	if (params.runFanoutBudget !== undefined || params.runFanoutAdmitted !== undefined) {
		return { ok: false, error: "Public execution does not accept internal run fan-out fields.", mode: hasWorkflowInput ? "workflow" : "management" };
	}
	if (params.workflowParentRunId !== undefined || params.workflowKey !== undefined || params.workflowChildAsyncId !== undefined || params.workflowAwaitAsync !== undefined || params.workflowAwaitDetached !== undefined || params.workflowParentDeadlineAt !== undefined || params.suppressRoutineResultIntercom !== undefined) {
		return { ok: false, error: "Public execution does not accept internal workflow child fields.", mode: hasWorkflowInput ? "workflow" : "management" };
	}
	const action = params.action;
	if (action !== undefined && (typeof action !== "string" || !action.trim())) {
		return { ok: false, error: "action must be a non-empty management/control action, or omit action and use workflow.", mode: "management" };
	}
	const normalizedAction = typeof action === "string" ? action.trim() : undefined;
	if (params.baseRef !== undefined && normalizedAction !== undefined && normalizedAction !== "resume" && normalizedAction !== "schedule.create") {
		return { ok: false, error: "baseRef is only supported for child execution, resume, and schedule.create.", mode: "management" };
	}
	if (normalizedAction !== undefined && hasNamedWorkflow) {
		return { ok: false, error: "Named workflow resource execution must omit action.", mode: "management" };
	}
	if (params.clarify !== undefined) {
		return { ok: false, error: "Public workflow execution does not support clarify UI.", mode: "workflow" };
	}
	if (params.chainName !== undefined) {
		return { ok: false, error: "Durable chain management was removed; use a workflow script or /prompt-workflow for repeatable workflows.", mode: "management" };
	}
	if (params.config && typeof params.config === "object" && !Array.isArray(params.config) && Object.prototype.hasOwnProperty.call(params.config, "steps")) {
		return { ok: false, error: "Durable chain definitions were removed; use a workflow script or /prompt-workflow for repeatable workflows.", mode: "management" };
	}
	if (params.resume !== undefined) {
		return { ok: false, error: "Top-level resume execution is not available. Put resume on a workflow script runs.run/runs.all item.", mode: "workflow" };
	}
	// action: "chain"/"tasks"/"parallel" stays a legacy error even where top-level chain/tasks are accepted.
	const legacyOrchestrationAction = ["parallel", "tasks", "chain"].includes(normalizedAction?.toLowerCase() ?? "");
	const hasStructuredWorkflow = options.structuredWorkflows === true && !legacyOrchestrationAction && (params.tasks !== undefined || params.chain !== undefined);
	const hasLegacyOrchestration = (!hasStructuredWorkflow && (params.tasks !== undefined || params.chain !== undefined)) || params.parallel !== undefined || params.concurrency !== undefined || params.chainDir !== undefined;
	if (hasLegacyOrchestration) {
		return { ok: false, error: `Legacy top-level chain and parallel inputs were removed; use a workflow script (${RAW_SCRIPT_FORMS}).`, mode: normalizedAction ? "management" : "workflow" };
	}
	if (hasStructuredWorkflow) {
		if (params.tasks !== undefined && params.chain !== undefined) {
			return { ok: false, error: "Pass either tasks or chain, not both.", mode: "workflow" };
		}
		const field = params.tasks !== undefined ? "tasks" : "chain";
		// workflow and workflowScript were already rejected by the workflow-scripts feature check.
		for (const [name, value] of [["action", params.action], ["agent", params.agent], ["step", params.step]] as const) {
			if (value !== undefined) return { ok: false, error: `${field} cannot be combined with ${name}.`, mode: normalizedAction ? "management" : "workflow" };
		}
		return { ok: true, params };
	}
	if (normalizedAction !== undefined) {
		const legacyAction = normalizedAction.toLowerCase();
		if (legacyAction === "append-step") {
			return { ok: false, error: "Legacy append-step control was removed from the public subagent tool; use workflow script orchestration.", mode: "management" };
		}
		if (legacyAction === "approve-checkpoint" || legacyAction === "reject-checkpoint") {
			return { ok: false, error: "Legacy checkpoint approval controls were removed from the public subagent tool; use workflow script orchestration.", mode: "management" };
		}
		if (legacyAction === "single") {
			return { ok: false, error: "action='single' is not supported. Omit action and pass { agent, task } for one child.", mode: "workflow" };
		}
		if (legacyAction === "parallel" || legacyAction === "tasks" || legacyAction === "chain") {
			return { ok: false, error: `Legacy top-level chain and parallel inputs were removed; use a workflow script (${RAW_SCRIPT_FORMS}).`, mode: "workflow" };
		}
		if (normalizedAction === "validate") {
			if (params.agent !== undefined || params.task !== undefined || params.step !== undefined) {
				return { ok: false, error: `validate requires ${RAW_SCRIPT_FORMS} and does not accept direct agent, task, or step execution fields.`, mode: "management" };
			}
			if (!hasValidWorkflowInput) {
				return { ok: false, error: `validate requires ${RAW_SCRIPT_FORMS}.`, mode: "management" };
			}
			return { ok: true, params: { ...params, action: normalizedAction } };
		}
		if (normalizedAction === "schedule.create") {
			if (params.agent !== undefined || params.task !== undefined || params.step !== undefined) {
				return { ok: false, error: `schedule.create requires ${RAW_SCRIPT_FORMS} and does not accept direct agent, task, or step execution fields.`, mode: "management" };
			}
			if (!hasValidWorkflowInput) {
				return { ok: false, error: `schedule.create requires ${RAW_SCRIPT_FORMS}.`, mode: "management" };
			}
			return { ok: true, params: { ...params, action: normalizedAction } };
		}
		if (hasWorkflowInput) {
			return { ok: false, error: `Workflow execution must omit action; only validate and schedule.create accept action with ${RAW_SCRIPT_FORMS}.`, mode: "management" };
		}
		if (params.task !== undefined) {
			return { ok: false, error: "Structured single-child task cannot be combined with a management/control action.", mode: "management" };
		}
		return { ok: true, params: { ...params, action: normalizedAction } };
	}
	if (params.step !== undefined) {
		return { ok: false, error: `step is not a public execution field; use a workflow script (${RAW_SCRIPT_FORMS}) for orchestration.`, mode: "workflow" };
	}
	if (hasWorkflowInput && (params.agent !== undefined || params.task !== undefined)) {
		return { ok: false, error: "Structured single-child execution cannot be combined with workflow.", mode: "workflow" };
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
	if (!hasValidWorkflowInput) {
		return { ok: false, error: "Execution requires either { agent, task? } for one child or workflow (true, a script path, or a named workflow resource) for orchestration.", mode: "workflow" };
	}
	return { ok: true, params };
}
