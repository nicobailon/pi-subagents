import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Details, SubagentState } from "../../shared/types.ts";
import { waitForSubagents, type SubagentWaitParams } from "./subagent-wait.ts";
import type { WaitSubscriptionManager } from "./wait-subscriptions.ts";
import { finalizeToolResult } from "../../extension/tool-result.ts";

export type WaitExecute = (id: string, params: SubagentWaitParams, signal: AbortSignal | undefined, onUpdate: ((result: AgentToolResult<Details>) => void) | undefined, ctx: ExtensionContext | undefined) => Promise<AgentToolResult<Details>>;

export function createWaitExecute(
	pi: ExtensionAPI,
	state: SubagentState,
	subscriptions?: Pick<WaitSubscriptionManager, "arm">,
	child?: { nestedRootRunId?: string },
	hasPendingSupervisorRequest?: () => boolean,
): WaitExecute {
	// Messages typed while the agent is busy (steer or follow-up) end open waits so they reach the model.
	const userInputWaits = new Set<AbortController>();
	pi.on("input", (event) => {
		if (event.source === "extension" || !event.streamingBehavior) return;
		for (const controller of userInputWaits) controller.abort();
	});
	return async (_id, params, signal, onUpdate, ctx) => {
		const userInput = new AbortController();
		userInputWaits.add(userInput);
		try {
			return finalizeToolResult(await waitForSubagents(params, signal, {
				state,
				nestedRootRunId: child?.nestedRootRunId,
				events: pi.events,
				hasPendingSupervisorRequest,
				userInputSignal: userInput.signal,
				onUpdate,
				...(subscriptions && ctx?.hasUI ? { subscribe: (input) => subscriptions.arm(input) } : {}),
			}));
		} finally {
			userInputWaits.delete(userInput);
		}
	};
}
