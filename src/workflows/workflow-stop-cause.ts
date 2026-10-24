// Leaf module with no imports, so any module can use it without an import cycle.

/** The extension runtime that owned the workflow was replaced (/reload, resume, project switch). */
export const WORKFLOW_STOP_CAUSE_RUNTIME_REPLACED = "runtime-replaced";
/** Stale-run reconciliation found the Pi process that ran the workflow dead (crash, kill, reboot). */
export const WORKFLOW_STOP_CAUSE_OWNER_EXITED = "owner-exited";
export type WorkflowStopCause = typeof WORKFLOW_STOP_CAUSE_RUNTIME_REPLACED | typeof WORKFLOW_STOP_CAUSE_OWNER_EXITED;

export function isReusableWorkflowStopCause(cause: unknown): cause is WorkflowStopCause {
	return cause === WORKFLOW_STOP_CAUSE_RUNTIME_REPLACED || cause === WORKFLOW_STOP_CAUSE_OWNER_EXITED;
}
