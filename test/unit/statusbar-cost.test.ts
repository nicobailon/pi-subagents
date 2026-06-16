import test from "node:test";
import assert from "node:assert/strict";

import {
	applyPendingSubagentCostToLatestAssistantEntry,
	applyPendingSubagentCostToMessage,
	createSubagentStatusbarCostLedger,
	getSubagentDetailsCost,
	recordSubagentAsyncCompleteCost,
	recordSubagentToolResultCost,
	resetSubagentStatusbarCostLedger,
} from "../../src/extension/statusbar-cost.ts";

function detailsWithCosts(costs: number[]) {
	return {
		mode: "parallel",
		results: costs.map((cost, index) => ({
			agent: `agent-${index}`,
			task: "test",
			exitCode: 0,
			usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost, turns: 1 },
		})),
	};
}

function assistantMessage(cost = 0.002) {
	return {
		role: "assistant",
		content: [{ type: "text", text: "done" }],
		api: "openai",
		provider: "openai",
		model: "mock-model",
		usage: {
			input: 100,
			output: 50,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 150,
			cost: { input: 0.001, output: 0.001, cacheRead: 0, cacheWrite: 0, total: cost },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function assertApproxEqual(actual: number, expected: number): void {
	assert.ok(Math.abs(actual - expected) < 1e-12, `expected ${actual} to equal ${expected}`);
}

test("extracts aggregate cost from subagent result details", () => {
	assertApproxEqual(getSubagentDetailsCost(detailsWithCosts([0.01, 0.02, 0])), 0.03);
	assert.equal(getSubagentDetailsCost({ mode: "management", results: [] }), 0);
	assert.equal(getSubagentDetailsCost(undefined), 0);
});

test("records each subagent tool result cost once", () => {
	const ledger = createSubagentStatusbarCostLedger();
	const event = { toolName: "subagent", toolCallId: "call-1", details: detailsWithCosts([0.01, 0.02]) };

	assertApproxEqual(recordSubagentToolResultCost(ledger, event), 0.03);
	assertApproxEqual(ledger.pendingCost, 0.03);
	assert.equal(recordSubagentToolResultCost(ledger, event), 0);
	assertApproxEqual(ledger.pendingCost, 0.03);
	assert.equal(recordSubagentToolResultCost(ledger, { toolName: "bash", toolCallId: "call-2", details: detailsWithCosts([1]) }), 0);
});

test("applies pending subagent cost to assistant usage without changing tokens", () => {
	const ledger = createSubagentStatusbarCostLedger();
	recordSubagentToolResultCost(ledger, { toolName: "subagent", toolCallId: "call-1", details: detailsWithCosts([0.01, 0.02]) });
	const message = assistantMessage(0.002);

	assertApproxEqual(applyPendingSubagentCostToMessage(ledger, message as any), 0.03);
	assertApproxEqual(message.usage.cost.total, 0.032);
	assert.equal(message.usage.input, 100);
	assert.equal(message.usage.output, 50);
	assert.equal(ledger.pendingCost, 0);
	assert.equal(applyPendingSubagentCostToMessage(ledger, message as any), 0);
});

test("records async completion cost once and applies it to the latest assistant entry", () => {
	const ledger = createSubagentStatusbarCostLedger();
	const event = { id: "async-1", results: detailsWithCosts([0.015, 0.025]).results };
	const olderMessage = assistantMessage(0.001);
	const latestMessage = assistantMessage(0.002);
	const entries = [
		{ type: "message", message: olderMessage },
		{ type: "message", message: { role: "toolResult", content: [] } },
		{ type: "message", message: latestMessage },
	];

	assertApproxEqual(recordSubagentAsyncCompleteCost(ledger, event), 0.04);
	assert.equal(recordSubagentAsyncCompleteCost(ledger, event), 0);
	assertApproxEqual(applyPendingSubagentCostToLatestAssistantEntry(ledger, entries as any), 0.04);
	assertApproxEqual(olderMessage.usage.cost.total, 0.001);
	assertApproxEqual(latestMessage.usage.cost.total, 0.042);
});

test("reset clears pending and seen tool call IDs", () => {
	const ledger = createSubagentStatusbarCostLedger();
	const event = { toolName: "subagent", toolCallId: "call-1", details: detailsWithCosts([0.01]) };
	recordSubagentToolResultCost(ledger, event);
	resetSubagentStatusbarCostLedger(ledger);

	assert.equal(ledger.pendingCost, 0);
	assertApproxEqual(recordSubagentToolResultCost(ledger, event), 0.01);
});
