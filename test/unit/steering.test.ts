import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { actionResultFromSteeringStatus, claimSteeringRecovery, createSteeringStatus, recordSteeringRequest, remainingSteeringRecoveryLimits, terminalSteeringNoticeState, updateSteeringTarget } from "../../src/runs/background/steering.ts";
import { applySteeringRecoveryAgentConfig } from "../../src/runs/background/async-resume.ts";
import type { AgentConfig } from "../../src/agents/agents.ts";

describe("steering lifecycle ledger", () => {
	it("retains 20 recent requests while aggregate totals remain monotonic", () => {
		const status = createSteeringStatus();
		for (let index = 0; index < 21; index++) {
			recordSteeringRequest(status, {
				id: `request-${index}`,
				requestedAt: index + 1,
				message: "guidance",
				targets: [{ index: 0, state: "routed" }],
			});
		}
		assert.equal(status.requested, 21);
		assert.equal(status.pending, 21);
		assert.equal(status.recent.length, 20);
		assert.equal(status.recent[0]?.id, "request-1");
	});

	it("classifies mixed target outcomes as partial", () => {
		const status = createSteeringStatus();
		recordSteeringRequest(status, {
			id: "mixed",
			requestedAt: 1,
			message: "correct course",
			targets: [{ index: 0, state: "routed" }, { index: 1, state: "routed" }],
		});
		updateSteeringTarget(status, "mixed", 0, "delivered", 2);
		updateSteeringTarget(status, "mixed", 1, "failed", 3, { reason: "unsupported" });
		const partial = actionResultFromSteeringStatus(status, "run", "mixed");
		assert.equal(partial?.state, "partial");
		assert.deepEqual(partial?.targets.map((target) => target.state), ["delivered", "failed"]);
	});

	it("classifies terminal mixed outcomes regardless of acknowledgment order", () => {
		for (const order of [["failed", "delivered"], ["delivered", "failed"]] as const) {
			const status = createSteeringStatus();
			recordSteeringRequest(status, {
				id: "notice",
				requestedAt: 1,
				message: "correct course",
				targets: [{ index: 0, state: "routed" }, { index: 1, state: "routed" }],
			});
			updateSteeringTarget(status, "notice", 0, order[0], 2);
			assert.equal(terminalSteeringNoticeState(status, "notice"), undefined);
			updateSteeringTarget(status, "notice", 1, order[1], 3);
			assert.equal(terminalSteeringNoticeState(status, "notice"), "partial");
		}
	});

	it("classifies an immediately failed request as terminal", () => {
		const status = createSteeringStatus();
		recordSteeringRequest(status, {
			id: "unsupported",
			requestedAt: 1,
			message: "correct course",
			targets: [{ index: 0, state: "failed", reason: "unsupported" }],
		});
		assert.equal(terminalSteeringNoticeState(status, "unsupported"), "failed");
	});

	it("allows only one committed recovery claim per source run", () => {
		const asyncDir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-steering-claim-"));
		try {
			const first = claimSteeringRecovery(asyncDir, { requestId: "first", sourceRunId: "source", committedAt: 1 });
			assert.equal(fs.existsSync(first.claimPath), true);
			assert.equal(fs.existsSync(first.markerPath), true);
			if (process.platform !== "win32") {
				assert.equal(fs.statSync(first.claimPath).mode & 0o777, 0o600);
				assert.equal(fs.statSync(first.markerPath).mode & 0o777, 0o600);
			}
			assert.throws(
				() => claimSteeringRecovery(asyncDir, { requestId: "second", sourceRunId: "source", committedAt: 2 }),
				/Another steering recovery is already committed/,
			);
		} finally {
			fs.rmSync(asyncDir, { recursive: true, force: true });
		}
	});

	it("keeps recovery authoritative when delivery is acknowledged late", () => {
		const status = createSteeringStatus();
		recordSteeringRequest(status, { id: "recover", requestedAt: 1, message: "guidance", targets: [{ index: 0, state: "routed" }] });
		updateSteeringTarget(status, "recover", 0, "recovered", 4, { replacementRunId: "replacement" });
		updateSteeringTarget(status, "recover", 0, "late", 5, { reason: "after recovery commit" });
		const result = actionResultFromSteeringStatus(status, "source", "recover", "replacement");
		assert.equal(result?.state, "recovered");
		assert.equal(result?.replacementRunId, "replacement");
		assert.equal(result?.targets[0]?.state, "recovered");
		assert.equal(result?.targets[0]?.replacementRunId, "replacement");
		assert.equal(result?.targets[0]?.lateDeliveredAt, 5);
	});

	it("preserves only remaining deadline, turn, and tool budgets", () => {
		assert.deepEqual(remainingSteeringRecoveryLimits({
			absoluteDeadlineAt: 10_000,
			initialTurnBudget: { maxTurns: 20, graceTurns: 3 },
			initialToolBudget: { soft: 45, hard: 65, block: ["read"] },
		}, {
			turnBudget: { maxTurns: 20, graceTurns: 3, turnCount: 21, outcome: "wrap-up-requested" },
			toolBudget: { soft: 45, hard: 65, block: ["read"], toolCount: 50, outcome: "soft-reached" },
		}, 4_000), {
			timeoutMs: 6_000,
			absoluteDeadlineAt: 10_000,
			turnBudget: { maxTurns: 1, graceTurns: 1 },
			toolBudget: { hard: 15, block: ["read"] },
		});
	});

	it("reconstructs the original agent contract without leaking changed current fields", () => {
		const current = {
			name: "worker",
			description: "current",
			model: "current/model",
			fallbackModels: ["current/fallback"],
			thinking: "high",
			tools: ["write"],
			extensions: ["current-extension"],
			subagentOnlyExtensions: ["current-child-extension"],
			mcpDirectTools: ["current_mcp"],
			systemPrompt: "current prompt",
			systemPromptMode: "append",
			inheritProjectContext: true,
			inheritSkills: true,
			skills: ["current-skill"],
			skillPath: ["current-skill-path"],
			filePath: "/current/agent.md",
			completionGuard: true,
			memory: { scope: "user", path: "/current/memory.md" },
			output: "/current/output.md",
			toolBudget: { hard: 99, block: "*" },
			maxSubagentDepth: 9,
		} as AgentConfig;
		const recovered = applySteeringRecoveryAgentConfig(current, {
			version: 1,
			sourceRunId: "source",
			agent: "worker",
			cwd: "/original",
			model: "original/model",
			tools: ["read"],
			systemPrompt: "original prompt",
			systemPromptMode: "replace",
			inheritProjectContext: false,
			inheritSkills: false,
			outputMode: "inline",
			initialToolBudget: { hard: 7, block: ["read"] },
			maxSubagentDepth: 2,
			share: false,
		});
		assert.equal(recovered.model, "original/model");
		assert.deepEqual(recovered.tools, ["read"]);
		assert.equal(recovered.systemPrompt, "original prompt");
		assert.equal(recovered.inheritProjectContext, false);
		assert.deepEqual(recovered.toolBudget, { hard: 7, block: ["read"] });
		assert.equal(recovered.maxSubagentDepth, 2);
		for (const field of ["fallbackModels", "extensions", "subagentOnlyExtensions", "mcpDirectTools", "skills", "skillPath", "filePath", "completionGuard", "memory", "output"] as const) {
			assert.equal(recovered[field], undefined, `${field} leaked from current config`);
		}
	});

	it("rejects recovery when any configured hard budget is exhausted", () => {
		assert.throws(() => remainingSteeringRecoveryLimits({ absoluteDeadlineAt: 5 }, {}, 5), /deadline budget/);
		assert.throws(() => remainingSteeringRecoveryLimits({ initialTurnBudget: { maxTurns: 2, graceTurns: 1 } }, { turnCount: 3 }), /turn budget/);
		assert.throws(() => remainingSteeringRecoveryLimits({ initialToolBudget: { hard: 2, block: "*" } }, { toolCount: 2 }), /tool budget/);
	});
});
