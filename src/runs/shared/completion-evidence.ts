import type {
	FileMutationEffect,
	SettlementDiagnostic,
	TrackedMutationEvidence,
} from "../../shared/types.ts";
import type { CompletionMutationGuardResult } from "./completion-guard.ts";

export const MISSING_IMPLEMENTATION_MUTATION_MESSAGE = "Subagent completed without making edits for an implementation task.";
export const MISSING_IMPLEMENTATION_MUTATION_ERROR = `${MISSING_IMPLEMENTATION_MUTATION_MESSAGE}\nIt appears to have returned planning or scratchpad output instead of applying changes.`;

export interface CompletionEvidencePlan {
	guardTriggered: boolean;
	guardBlocked: boolean;
	mutationExpected: boolean;
	mutationAttempted: boolean;
	fileMutation?: FileMutationEffect;
	legacyFailureError?: string;
}

export function planCompletionEvidence(input: {
	guard?: CompletionMutationGuardResult;
	guardTriggered?: boolean;
	completionGuardEnabled: boolean;
	mutationCapable: boolean;
	implementationMutationExpected: boolean;
	mutationAttemptObserved: boolean;
	mutationEvidence?: TrackedMutationEvidence;
	arbiterRescued?: boolean;
	agentContractEnabled: boolean;
}): CompletionEvidencePlan {
	const guardBlocked = input.guard?.blocked === true;
	const guardTriggered = input.guardTriggered
		?? (input.guard?.triggered === true && !input.mutationAttemptObserved);
	const mutationExpected = input.guard?.expectedMutation
		?? (input.completionGuardEnabled && input.mutationCapable && input.implementationMutationExpected);
	const mutationAttempted = input.guard?.attemptedMutation === true || input.mutationAttemptObserved;
	const fileMutation = input.guard
		? {
			status: guardBlocked
				? "blocked" as const
				: input.guard.expectedMutation
					? guardTriggered
						? "missing" as const
						: input.arbiterRescued
							? "not-applicable" as const
							: "observed" as const
					: "not-applicable" as const,
			expected: input.guard.expectedMutation,
			attempted: guardBlocked ? false : mutationAttempted,
			...(input.mutationEvidence ? { evidence: input.mutationEvidence } : {}),
			...(guardBlocked && input.guard.message ? { message: input.guard.message } : {}),
			...(guardTriggered ? { message: MISSING_IMPLEMENTATION_MUTATION_MESSAGE } : {}),
			...(input.arbiterRescued ? { resolvedBy: "llm-intent-arbiter" as const } : {}),
		}
		: undefined;
	return {
		guardTriggered,
		guardBlocked,
		mutationExpected,
		mutationAttempted,
		fileMutation,
		legacyFailureError: guardTriggered && !input.agentContractEnabled
			? MISSING_IMPLEMENTATION_MUTATION_ERROR
			: undefined,
	};
}

export function projectSettlementDiagnostic(
	plan: Pick<CompletionEvidencePlan, "guardTriggered" | "guardBlocked" | "mutationExpected" | "mutationAttempted">,
	input: {
		terminalFailed: boolean;
		finalTextPresent: boolean;
		mutationObserved: boolean;
		requiredOutput?: SettlementDiagnostic["requiredOutput"];
		afterCompactionSettlement?: boolean;
	},
): SettlementDiagnostic | undefined {
	if (!input.terminalFailed && !plan.guardTriggered && !plan.guardBlocked) return undefined;
	return {
		finalTextPresent: input.finalTextPresent,
		mutation: {
			expected: plan.mutationExpected,
			attempted: plan.mutationAttempted,
			observed: input.mutationObserved,
		},
		...(input.requiredOutput ? { requiredOutput: input.requiredOutput } : {}),
		afterCompactionSettlement: input.afterCompactionSettlement === true,
	};
}
