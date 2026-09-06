import type { AsyncStatus, SubagentState } from "../../shared/types.ts";

/** Projection-only guidance, not a control route or proof of current child liveness. */
export function workflowAsyncChildSteeringGuidance(status: AsyncStatus, state?: SubagentState): string[] {
	if (status.mode !== "workflow" || (status.state !== "running" && status.state !== "queued")
		|| !state?.currentSessionId || status.sessionId !== state.currentSessionId
		|| !state.workflowControllers?.has(status.runId)) return [];
	const ids = new Set((status.steps ?? []).flatMap((step) =>
		step.async === true && step.status === "running"
		&& step.runner?.type !== "external-cli" && step.runner?.type !== "external-job"
		&& typeof step.runId === "string" && /^[A-Za-z0-9_-]+$/.test(step.runId) && step.runId !== status.runId
			? [step.runId] : []));
	if (ids.size === 0) return [];
	return [
		"Async children recorded as running; direct steering rechecks controls. Choose an exact child ID (queued does not mean consumed):",
		...[...ids].map((id) => `  subagent({ action: "steer", id: "${id}", mode: "follow_up", message: "..." })`),
	];
}
