import type { ChildSession } from "./child-session.ts";
import { getReadonlySessionEvidence, type SettledReadonlyEvidence } from "./readonly-session-evidence.ts";

/** Owned by the logical host run, shared with abort recovery; never reset per attempt. */
export type LogicalRecoveryState = "unused" | "abort-recovery" | "readonly-continuation";

export interface ReadonlyContinuationCandidate {
	/** Actual resolved identity, not an alias or a parsed display reference. */
	readonly resolved: { readonly provider: string; readonly model: string; readonly api: string } | undefined;
	readonly tried: boolean;
	/** Host assessment of retained input support AND context capacity, including prompt overhead. */
	readonly compatibility: "compatible" | "incompatible" | "unknown";
}

export interface ReadonlyContinuationInput {
	/** Retain the source child privately: its live accessor detects revoked receipts. */
	readonly source: ChildSession | undefined;
	readonly recoveryState: LogicalRecoveryState;
	/** Ordered, already authorized and exclusion-filtered. This planner never resolves models. */
	readonly candidates: readonly ReadonlyContinuationCandidate[];
	readonly currentIndex: number;
	/** False includes success, stop/interrupt/detach/handoff, deadline, or workflow-permit veto. */
	readonly lifecycleAllowsContinuation: boolean;
	/** False includes completion/structured/acceptance failures, pending input or other effects. */
	readonly effectsAllowContinuation: boolean;
	/** Configured tool budgets are unsupported; unknown authoritative usage allowance denies. */
	readonly budget: "unconfigured" | "available" | "exhausted" | "unknown" | "tool-budget-configured";
	readonly knownContextOverflow: boolean;
}

export const READONLY_CONTINUATION_PROMPT = "The previous provider request failed with HTTP 429 after read-only progress. Continue from the retained transcript and completed tool results. Do not restart or repeat completed work. Use only the existing read-only tools and finish the requested response.";

export type ReadonlyContinuationPlan =
	| { readonly kind: "deny"; readonly reason: "recovery-consumed" | "veto" | "no-evidence" | "unresolved-identity" | "incompatible" | "no-sibling" }
	| { readonly kind: "continue"; readonly candidateIndex: number; readonly expected: SettledReadonlyEvidence;
		readonly prompt: typeof READONLY_CONTINUATION_PROMPT; readonly recoveryState: "readonly-continuation" };

/**
 * Pure decision: no disk reads, dispatch, receipt minting, or state mutation.
 * The host MUST recheck live source proof and lifecycle/budget at handoff, then store the
 * returned consumed state BEFORE creation (even if creation subsequently fails),
 * and pass expected to requestReadonlySessionEvidence on the exact-file sibling launch.
 * That factory guard owns checkpoint/configured-provider revalidation before open/prompt/dispatch.
 * The host must also verify the actual sibling model matches the selected resolved identity;
 * a plan is not a dispatch authorization and any create/guard failure terminates recovery.
 */
export function planReadonlyModelContinuation(input: ReadonlyContinuationInput): ReadonlyContinuationPlan {
	if (input.recoveryState !== "unused") return { kind: "deny", reason: "recovery-consumed" };
	if (!input.lifecycleAllowsContinuation || !input.effectsAllowContinuation || input.knownContextOverflow
		|| (input.budget !== "unconfigured" && input.budget !== "available")) return { kind: "deny", reason: "veto" };
	const expected = input.source && getReadonlySessionEvidence(input.source);
	if (!expected || input.source?.detached || input.source?.shutDown) return { kind: "deny", reason: "no-evidence" };
	const current = Number.isInteger(input.currentIndex) && input.currentIndex >= 0 ? input.candidates[input.currentIndex]?.resolved : undefined;
	if (!current || current.provider !== expected.provider || current.model !== expected.model || current.api !== expected.api) {
		return { kind: "deny", reason: "unresolved-identity" };
	}
	for (let index = input.currentIndex + 1; index < input.candidates.length; index++) {
		const candidate = input.candidates[index];
		if (!candidate) return { kind: "deny", reason: "unresolved-identity" };
		if (candidate.tried) continue;
		const resolved = candidate.resolved;
		if (!resolved?.provider || !resolved.model || !resolved.api) return { kind: "deny", reason: "unresolved-identity" };
		if (resolved.provider !== expected.provider || resolved.model === expected.model) continue;
		if (input.candidates.some((other) => other.tried && other.resolved?.provider === resolved.provider && other.resolved.model === resolved.model)) continue;
		if (resolved.api !== expected.api || candidate.compatibility !== "compatible") return { kind: "deny", reason: "incompatible" };
		return { kind: "continue", candidateIndex: index, expected, prompt: READONLY_CONTINUATION_PROMPT, recoveryState: "readonly-continuation" };
	}
	return { kind: "deny", reason: "no-sibling" };
}
