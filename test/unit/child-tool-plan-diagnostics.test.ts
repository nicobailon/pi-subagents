import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolvePiLaunchToolPlan } from "../../src/api/child-tool-plan.ts";
import { formatReviewLaneToolContractFailure } from "../../src/runs/shared/child-tool-plan.ts";

describe("public child tool plan diagnostics", () => {
	it("fails a review/scout launch when host pruning drops permitted repository tools", () => {
		assert.throws(
			() => resolvePiLaunchToolPlan({
				agentName: "scout",
				tools: ["read", "grep", "find", "ls", "bash"],
				hostToolNames: [],
			}),
			(error: unknown) => {
				assert.ok(error instanceof Error);
				assert.equal(error.message, formatReviewLaneToolContractFailure({
					agentName: "scout",
					missingTools: ["read", "grep", "find", "ls", "bash"],
					requestedTools: ["read", "grep", "find", "ls", "bash"],
					effectiveTools: [],
				}));
				assert.match(error.message, /lane infrastructure failure, not a completed review\/scout result/);
				return true;
			},
		);
	});

	it("fails a reviewer when a ceiling-permitted repository tool is host-missing", () => {
		assert.throws(
			() => resolvePiLaunchToolPlan({
				agentName: "reviewer",
				tools: ["read", "grep", "bash", "write"],
				hostToolNames: ["bash", "write"],
				excludeTools: ["write"],
				capabilityCeiling: { version: 1, allowedTools: ["read", "bash", "write"], denyExtensions: false, sources: ["plan-mode"] },
				inheritedCapabilityCeiling: { version: 1, allowedTools: ["read", "grep", "write"], denyExtensions: false, sources: ["parent-policy"] },
			}),
			(error: unknown) => {
				assert.ok(error instanceof Error);
				assert.match(error.message, /Agent 'reviewer': tool contract could not be satisfied/);
				assert.match(error.message, /permitted required repository tools \[read\]/);
				assert.match(error.message, /Active capability ceiling sources: \[parent-policy, plan-mode\]/);
				assert.match(error.message, /Explicit excludeTools: \[write\]/);
				assert.match(error.message, /lane infrastructure failure/);
				return true;
			},
		);
	});

	it("keeps host-pruned warnings for non-review agents, including an empty effective menu", () => {
		const plan = resolvePiLaunchToolPlan({
			agentName: "worker",
			tools: ["read", "grep", "find", "ls", "bash"],
			hostToolNames: [],
		});
		assert.deepEqual(plan.warnings, [
			"Agent 'worker': host runtime tool availability omitted [read, grep, find, ls, bash]. Requested tool names: [read, grep, find, ls, bash]; effective tool allowlist: []. This is a non-fatal tool-plan diagnostic, not verification of the child's runtime tool menu.",
		]);
		assert.deepEqual(plan.effectiveToolAllowlist, []);
		assert.deepEqual(plan.requiredChildTools, []);
		assert.equal(plan.capabilityAudit, undefined);
	});

	it("does not invent an explicit request, agent name, or ceiling source when absent", () => {
		const plan = resolvePiLaunchToolPlan({
			hostToolNames: [],
			capabilityCeiling: { version: 1, allowedTools: ["read"], denyExtensions: false, sources: [] },
		});
		assert.deepEqual(plan.warnings, [
			"Subagent: host runtime tool availability omitted [read]. Requested tool names: not explicitly specified; effective tool allowlist: []. Active capability ceiling sources: [unknown source]. This is a non-fatal tool-plan diagnostic, not verification of the child's runtime tool menu.",
		]);
	});

	it("does not invent host omissions when availability is unknown or a ceiling alone prunes tools", () => {
		for (const input of [
			{},
			{ hostToolNames: ["read"] },
			{ hostToolNames: [], capabilityCeiling: { version: 1 as const, allowedTools: [], denyExtensions: false, sources: ["plan-mode"] } },
		]) {
			const plan = resolvePiLaunchToolPlan({ tools: ["read"], ...input });
			assert.deepEqual(plan.warnings, []);
		}
	});

	it("does not reject an intentionally empty or ceiling-restricted review allowlist", () => {
		const emptyAllowlist = resolvePiLaunchToolPlan({
			agentName: "scout",
			tools: [],
			hostToolNames: [],
		});
		assert.deepEqual(emptyAllowlist.effectiveToolAllowlist, []);
		assert.deepEqual(emptyAllowlist.requiredChildTools, []);
		assert.deepEqual(emptyAllowlist.unavailableHostBuiltins, []);
		assert.deepEqual(emptyAllowlist.warnings, []);

		const emptyCeiling = resolvePiLaunchToolPlan({
			agentName: "reviewer",
			tools: ["read", "grep"],
			hostToolNames: [],
			capabilityCeiling: { version: 1, allowedTools: [], denyExtensions: false, sources: ["plan-mode"] },
		});
		assert.deepEqual(emptyCeiling.effectiveToolAllowlist, []);
		assert.deepEqual(emptyCeiling.requiredChildTools, []);
		assert.deepEqual(emptyCeiling.unavailableHostBuiltins, []);
		assert.deepEqual(emptyCeiling.warnings, []);
	});

	it("does not treat excluded repository tools as a missing review-lane contract", () => {
		const restricted = resolvePiLaunchToolPlan({
			agentName: "scout",
			tools: ["read", "grep", "bash"],
			excludeTools: ["read", "grep"],
			hostToolNames: ["read", "grep", "bash"],
		});
		assert.deepEqual(restricted.effectiveToolAllowlist, ["bash"]);
		assert.deepEqual(restricted.requiredChildTools, ["bash"]);
		assert.deepEqual(restricted.unavailableHostBuiltins, []);
		assert.deepEqual(restricted.warnings, []);

		const hostMissingExcluded = resolvePiLaunchToolPlan({
			agentName: "reviewer",
			tools: ["read", "grep"],
			excludeTools: ["read", "grep"],
			hostToolNames: [],
		});
		assert.deepEqual(hostMissingExcluded.effectiveToolAllowlist, []);
		assert.deepEqual(hostMissingExcluded.requiredChildTools, []);
		assert.deepEqual(hostMissingExcluded.unavailableHostBuiltins, ["read", "grep"]);
		assert.match(hostMissingExcluded.warnings[0] ?? "", /host runtime tool availability omitted \[read, grep\]/);
	});

	it("keeps a scout launch when only a non-repository requested tool is host-pruned", () => {
		const plan = resolvePiLaunchToolPlan({
			agentName: "scout",
			tools: ["read", "grep", "find", "ls", "bash", "write"],
			hostToolNames: ["read", "grep", "find", "ls", "bash"],
		});
		assert.deepEqual(plan.effectiveToolAllowlist, ["read", "grep", "find", "ls", "bash"]);
		assert.deepEqual(plan.unavailableHostBuiltins, ["write"]);
		assert.match(plan.warnings[0] ?? "", /host runtime tool availability omitted \[write\]/);
	});
});
