import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Static } from "typebox";
import { SubagentWaitParams } from "../../extension/schemas.ts";
import type { Details, SubagentState } from "../../shared/types.ts";
import { resolveWaitToolConfig, waitForSubagents } from "./subagent-wait.ts";
import type { WaitSubscriptionManager } from "./wait-subscriptions.ts";
import { finalizeToolResult } from "../../extension/tool-result.ts";
import { registerPinnedTool } from "../../extension/declaration-pinning.ts";
import { waitToolName } from "../../shared/wait-tool-name.ts";

export type WaitExecute = (id: string, params: Static<typeof SubagentWaitParams>, signal: AbortSignal | undefined, onUpdate: ((result: AgentToolResult<Details>) => void) | undefined, ctx: ExtensionContext | undefined) => Promise<AgentToolResult<Details>>;

/** What a wait call runs, for the wait tool and for subagent's `action: "wait"`. */
export function createWaitExecute(
	pi: ExtensionAPI,
	state: SubagentState,
	enabled = resolveWaitToolConfig().enabled,
	subscriptions?: Pick<WaitSubscriptionManager, "arm">,
	defaultTimeoutMs?: number,
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
				enabled,
				hasPendingSupervisorRequest,
				userInputSignal: userInput.signal,
				...(defaultTimeoutMs !== undefined ? { defaultTimeoutMs } : {}),
				onUpdate,
				...(subscriptions && ctx?.hasUI ? { subscribe: (input) => subscriptions.arm(input) } : {}),
			}));
		} finally {
			userInputWaits.delete(userInput);
		}
	};
}

export function registerWaitTool(
	pi: ExtensionAPI,
	state: SubagentState,
	enabled = resolveWaitToolConfig().enabled,
	subscriptions?: Pick<WaitSubscriptionManager, "arm">,
	defaultTimeoutMs?: number,
	child?: { nestedRootRunId?: string },
	hasPendingSupervisorRequest?: () => boolean,
): void {
	const name = waitToolName();
	const description = `Wait for background work, then return. ${child ? `This child runtime has no native completion notifier: use blocking ${name} to collect your owned descendants this turn and read their result references; agent_end draining does not synthesize results.` : `Ordinary async subagent runs already wake this session natively; use ${name} only for provider, detached, or other background work without native notification, when a same-turn result is needed.`}
{} — first active run or provider item to finish or need attention.
{all:true} — all work active at call time.
{id} — one run; a finished async run returns its result references.
{id,nonBlocking:true} — subscribe to that run's wake and return now.
Timeout or a user message ends the wait without error; work keeps running.${enabled ? "" : "\nDisabled by config.waitTool or PI_SUBAGENT_WAIT_TOOL_ENABLED: returns immediately."}`;
	const primaryTool: ToolDefinition<typeof SubagentWaitParams, Details> = {
		name,
		label: "Background Wait",
		description,
		parameters: SubagentWaitParams,
		execute: createWaitExecute(pi, state, enabled, subscriptions, defaultTimeoutMs, child, hasPendingSupervisorRequest),
	};
	registerPinnedTool(pi, primaryTool);
}
