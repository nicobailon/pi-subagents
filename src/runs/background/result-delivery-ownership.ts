import { ownsRun } from "../shared/run-ownership.ts";
import { inheritedSessionIds } from "../../shared/session-succession.ts";
import type { SubagentState } from "../../shared/types.ts";

type ResultDeliveryState = Pick<SubagentState, "currentSessionId" | "completionOwnerId">;

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
			if (!owner || completionOwnerId !== owner) return false;
			return ownsRun(state.currentSessionId, sessionId);
		},
		claimedSessionIds() {
			if (!currentOwner() || !state.currentSessionId) return [];
			return inheritedSessionIds(state.currentSessionId);
		},
	};
}
