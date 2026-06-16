import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Details } from "../shared/types.ts";

interface SubagentToolResultEventLike {
	toolName: string;
	toolCallId?: string;
	details?: unknown;
}

interface SubagentAsyncCompleteEventLike {
	id?: string;
	runId?: string;
	results?: unknown;
}

interface SessionMessageEntryLike {
	type?: string;
	message?: unknown;
}

export interface SubagentStatusbarCostLedger {
	pendingCost: number;
	countedToolCallIds: Set<string>;
}

export function createSubagentStatusbarCostLedger(): SubagentStatusbarCostLedger {
	return {
		pendingCost: 0,
		countedToolCallIds: new Set(),
	};
}

export function resetSubagentStatusbarCostLedger(ledger: SubagentStatusbarCostLedger): void {
	ledger.pendingCost = 0;
	ledger.countedToolCallIds.clear();
}

function finitePositive(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function hasResultArray(value: unknown): value is { results: unknown[] } {
	return typeof value === "object"
		&& value !== null
		&& Array.isArray((value as { results?: unknown }).results);
}

function isDetails(value: unknown): value is Details {
	return hasResultArray(value);
}

function getResultUsageCost(result: unknown): number {
	if (typeof result !== "object" || result === null) return 0;
	const usage = (result as { usage?: { cost?: unknown } }).usage;
	return finitePositive(usage?.cost);
}

export function getSubagentDetailsCost(details: unknown): number {
	if (!isDetails(details)) return 0;
	return details.results.reduce((sum, result) => sum + getResultUsageCost(result), 0);
}

export function recordSubagentToolResultCost(
	ledger: SubagentStatusbarCostLedger,
	event: SubagentToolResultEventLike,
): number {
	if (event.toolName !== "subagent") return 0;
	if (event.toolCallId && ledger.countedToolCallIds.has(event.toolCallId)) return 0;

	const cost = getSubagentDetailsCost(event.details);
	if (cost <= 0) return 0;

	if (event.toolCallId) ledger.countedToolCallIds.add(event.toolCallId);
	ledger.pendingCost += cost;
	return cost;
}

export function recordSubagentAsyncCompleteCost(
	ledger: SubagentStatusbarCostLedger,
	event: SubagentAsyncCompleteEventLike,
): number {
	const key = typeof event.id === "string" && event.id
		? `async:${event.id}`
		: typeof event.runId === "string" && event.runId
			? `async:${event.runId}`
			: undefined;
	if (key && ledger.countedToolCallIds.has(key)) return 0;

	const cost = hasResultArray(event) ? event.results.reduce((sum, result) => sum + getResultUsageCost(result), 0) : 0;
	if (cost <= 0) return 0;

	if (key) ledger.countedToolCallIds.add(key);
	ledger.pendingCost += cost;
	return cost;
}

export function applyPendingSubagentCostToMessage(
	ledger: SubagentStatusbarCostLedger,
	message: AgentMessage,
): number {
	const pendingCost = ledger.pendingCost;
	if (pendingCost <= 0 || message.role !== "assistant") return 0;

	message.usage.cost = {
		input: message.usage.cost?.input ?? 0,
		output: message.usage.cost?.output ?? 0,
		cacheRead: message.usage.cost?.cacheRead ?? 0,
		cacheWrite: message.usage.cost?.cacheWrite ?? 0,
		total: (message.usage.cost?.total ?? 0) + pendingCost,
	};
	ledger.pendingCost = 0;
	return pendingCost;
}

export function applyPendingSubagentCostToLatestAssistantEntry(
	ledger: SubagentStatusbarCostLedger,
	entries: readonly SessionMessageEntryLike[],
): number {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry?.type !== "message") continue;
		const message = entry.message;
		if (typeof message !== "object" || message === null || (message as { role?: unknown }).role !== "assistant") continue;
		return applyPendingSubagentCostToMessage(ledger, message as AgentMessage);
	}
	return 0;
}
