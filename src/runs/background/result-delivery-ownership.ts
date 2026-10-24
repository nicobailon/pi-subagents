import { ownsRun } from "../shared/run-ownership.ts";
import { inheritedSessionIds } from "../../shared/session-succession.ts";
import { OWNING_SESSION_COMPLETION_OWNER } from "../../shared/completion-owner.ts";
import type { SubagentState } from "../../shared/types.ts";
import { currentBootId } from "./boot-id.ts";
import { currentPidNamespaceScope } from "./pid-namespace.ts";
import { checkRecordedPidLiveness, type RecordedPid } from "./stale-run-reconciler.ts";

type ResultDeliveryState = Pick<SubagentState, "currentSessionId" | "completionOwnerId">;

export interface ResultDeliveryOwnership {
	owns(sessionId: string, completionOwnerId: unknown): boolean;
	/**
	 * The completion owner a result is delivered under: `owning-session` when its own owner is another Pi
	 * process that is confirmed dead and this session owns the run, so nothing else can ever deliver it;
	 * otherwise `completionOwnerId`.
	 */
	deliveryOwnerId(sessionId: string | undefined, completionOwnerId: string | null | undefined, ownerProcess: unknown, parentWorkflowRunId: unknown): string | null | undefined;
	claimedSessionIds(): readonly string[];
}

// A dead process cannot come back, so only that verdict is kept.
const deadCompletionOwnerIds = new Set<string>();

function isRecordedPid(value: unknown): value is RecordedPid {
	if (!value || typeof value !== "object") return false;
	const { pid, pidNamespaceScope, bootId } = value as Record<string, unknown>;
	return typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0
		&& (pidNamespaceScope === undefined || typeof pidNamespaceScope === "string")
		&& (bootId === undefined || typeof bootId === "string");
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
		deliveryOwnerId(sessionId, completionOwnerId, ownerProcess, parentWorkflowRunId) {
			const owner = currentOwner();
			// A workflow child is reported by its workflow, which has its own owner-exited notice.
			if (!owner || typeof completionOwnerId !== "string" || completionOwnerId === owner
				|| completionOwnerId === OWNING_SESSION_COMPLETION_OWNER || parentWorkflowRunId
				|| !ownsRun(state.currentSessionId, sessionId)) return completionOwnerId;
			if (!deadCompletionOwnerIds.has(completionOwnerId)) {
				if (!isRecordedPid(ownerProcess)) return completionOwnerId;
				const liveness = checkRecordedPidLiveness(ownerProcess, { observedScope: currentPidNamespaceScope(), observedBootId: currentBootId() });
				if (liveness !== "dead") return completionOwnerId;
				deadCompletionOwnerIds.add(completionOwnerId);
			}
			return OWNING_SESSION_COMPLETION_OWNER;
		},
		claimedSessionIds() {
			if (!currentOwner() || !state.currentSessionId) return [];
			return inheritedSessionIds(state.currentSessionId);
		},
	};
}
