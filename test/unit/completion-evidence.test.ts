import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	MISSING_IMPLEMENTATION_MUTATION_ERROR,
	MISSING_IMPLEMENTATION_MUTATION_MESSAGE,
	planCompletionEvidence,
	projectSettlementDiagnostic,
} from "../../src/runs/shared/completion-evidence.ts";

const evidence = {
	source: "tracked-files" as const,
	trackedOnly: true as const,
	changedFiles: [],
	attemptedMutation: false,
};

describe("planCompletionEvidence", () => {
	it("fails closed when expected mutation evidence is missing", () => {
		const plan = planCompletionEvidence({
			guard: { expectedMutation: true, attemptedMutation: false, triggered: true, blocked: false },
			completionGuardEnabled: true,
			mutationCapable: true,
			implementationMutationExpected: true,
			mutationAttemptObserved: false,
			mutationEvidence: evidence,
			agentContractV1: false,
		});

		assert.equal(plan.guardTriggered, true);
		assert.equal(plan.legacyFailureError, MISSING_IMPLEMENTATION_MUTATION_ERROR);
		assert.deepEqual(plan.fileMutation, {
			status: "missing",
			expected: true,
			attempted: false,
			evidence,
			message: MISSING_IMPLEMENTATION_MUTATION_MESSAGE,
		});
	});

	it("keeps agent contract v1 rejection in evidence without forcing execution failure", () => {
		const plan = planCompletionEvidence({
			guard: { expectedMutation: true, attemptedMutation: false, triggered: true, blocked: false },
			completionGuardEnabled: true,
			mutationCapable: true,
			implementationMutationExpected: true,
			mutationAttemptObserved: false,
			agentContractV1: true,
		});

		assert.equal(plan.guardTriggered, true);
		assert.equal(plan.fileMutation?.status, "missing");
		assert.equal(plan.legacyFailureError, undefined);
	});

	it("projects blocked tool availability and arbiter rescue consistently", () => {
		const blocked = planCompletionEvidence({
			guard: { expectedMutation: true, attemptedMutation: false, triggered: false, blocked: true, message: "tools unavailable" },
			completionGuardEnabled: true,
			mutationCapable: false,
			implementationMutationExpected: true,
			mutationAttemptObserved: true,
			agentContractV1: false,
		});
		assert.deepEqual(blocked.fileMutation, {
			status: "blocked",
			expected: true,
			attempted: false,
			message: "tools unavailable",
		});
		assert.equal(blocked.mutationAttempted, true);
		assert.deepEqual(projectSettlementDiagnostic(blocked, {
			terminalFailed: true,
			finalTextPresent: false,
			mutationObserved: true,
		}), {
			finalTextPresent: false,
			mutation: { expected: true, attempted: true, observed: true },
			afterCompactionSettlement: false,
		});

		const rescued = planCompletionEvidence({
			guard: { expectedMutation: true, attemptedMutation: false, triggered: true, blocked: false },
			guardTriggered: false,
			completionGuardEnabled: true,
			mutationCapable: true,
			implementationMutationExpected: true,
			mutationAttemptObserved: false,
			arbiterRescued: true,
			agentContractV1: false,
		});
		assert.deepEqual(rescued.fileMutation, {
			status: "not-applicable",
			expected: true,
			attempted: false,
			resolvedBy: "llm-intent-arbiter",
		});
		assert.equal(rescued.legacyFailureError, undefined);
	});

	it("derives fallback expectation when terminal failure prevents guard evaluation", () => {
		const plan = planCompletionEvidence({
			completionGuardEnabled: true,
			mutationCapable: true,
			implementationMutationExpected: true,
			mutationAttemptObserved: false,
			agentContractV1: false,
		});
		assert.equal(plan.mutationExpected, true);
		assert.equal(plan.fileMutation, undefined);
	});
});

describe("projectSettlementDiagnostic", () => {
	it("emits explicit missing-output and mutation evidence on terminal failure", () => {
		const plan = planCompletionEvidence({
			completionGuardEnabled: true,
			mutationCapable: true,
			implementationMutationExpected: true,
			mutationAttemptObserved: false,
			agentContractV1: false,
		});
		assert.deepEqual(projectSettlementDiagnostic(plan, {
			terminalFailed: true,
			finalTextPresent: false,
			mutationObserved: false,
			requiredOutput: { kind: "file-only", path: "/tmp/report.md", missing: true },
			afterCompactionSettlement: false,
		}), {
			finalTextPresent: false,
			mutation: { expected: true, attempted: false, observed: false },
			requiredOutput: { kind: "file-only", path: "/tmp/report.md", missing: true },
			afterCompactionSettlement: false,
		});
	});

	it("omits diagnostics for accepted completion with no guard finding", () => {
		const plan = planCompletionEvidence({
			completionGuardEnabled: false,
			mutationCapable: false,
			implementationMutationExpected: false,
			mutationAttemptObserved: false,
			agentContractV1: false,
		});
		assert.equal(projectSettlementDiagnostic(plan, {
			terminalFailed: false,
			finalTextPresent: true,
			mutationObserved: false,
		}), undefined);
	});
});
