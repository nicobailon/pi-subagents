import { ownsRun } from "../shared/run-ownership.ts";
import { inheritedSessionIds } from "../../shared/session-succession.ts";
import type { SubagentState } from "../../shared/types.ts";

type ResultDeliveryState = Pick<SubagentState, "currentSessionId" | "completionOwnerId">;

/**
 * The completion owner of a workflow whose Pi exited, repaired where no owning session could adopt
 * it: its own owner is dead, so whichever session owns the run delivers it. Delivery consumes the result.
 */
export const OWNING_SESSION_COMPLETION_OWNER = "owning-session";

export interface ResultDeliveryOwnership {
	owns(sessionId: string, completionOwnerId: unknown): boolean;
	claimedSessionIds(): readonly string[];
}

export function createResultDeliveryOwnership(state: ResultDeliveryState): ResultDeliveryOwnership {
	const currentOwner = (): string | undefined => typeof state.completionOwnerId === "string" && state.completionOwnerId
		? state.completionOwnerId
		: undefined;

	return {
		owns(sessionId, completionOwnerId) {
			const owner = currentOwner();
			if (!owner || (completionOwnerId !== owner && completionOwnerId !== OWNING_SESSION_COMPLETION_OWNER)) return false;
			return ownsRun(state.currentSessionId, sessionId);
		},
		claimedSessionIds() {
			if (!currentOwner() || !state.currentSessionId) return [];
			return inheritedSessionIds(state.currentSessionId);
		},
	};
}
