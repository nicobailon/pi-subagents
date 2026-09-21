import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { SubagentWaitParams } from "../../extension/schemas.ts";
import type { Details, SubagentState } from "../../shared/types.ts";
import { resolveWaitToolConfig, waitForSubagents } from "./subagent-wait.ts";
import type { WaitSubscriptionManager } from "./wait-subscriptions.ts";
import { finalizeToolResult } from "../../extension/tool-result.ts";

export function registerWaitTool(
	pi: ExtensionAPI,
	state: SubagentState,
	enabled = resolveWaitToolConfig().enabled,
	subscriptions?: Pick<WaitSubscriptionManager, "arm">,
	defaultTimeoutMs?: number,
	child?: { nestedRootRunId?: string },
	hasPendingSupervisorRequest?: () => boolean,
): void {
	const description = `Wait for provider or detached work needing same-turn results. ${child ? "This child lacks the root notifier; use blocking waits to collect owned descendants and read result references. agent_end draining keeps work alive but does not synthesize results." : "Ordinary async subagents notify natively; return control instead. Headless runs auto-drain subagent work."} {} returns on first initial completion or attention; all:true waits for all; id targets a run or prefix and returns result references. stopOnAttention:false ignores idle or long-thinking attention, never supervisor requests. Timeout uses waitTool.defaultTimeoutMs or 1800000; expiry is non-error window_elapsed and work continues. Provider extensions must be loaded${child ? " and bg_wait kept in the child tool allowlist" : ""}; grants no tools.${enabled ? "" : " Configured behavior: bg_wait is disabled by config.waitTool or PI_SUBAGENT_WAIT_TOOL_ENABLED and returns immediately without blocking."}`;
	const execute: ToolDefinition<typeof SubagentWaitParams, Details>["execute"] = async (_id, params, signal, onUpdate, ctx) => finalizeToolResult(await waitForSubagents(params, signal, {
		state,
		nestedRootRunId: child?.nestedRootRunId,
		events: pi.events,
		enabled,
		hasPendingSupervisorRequest,
		...(defaultTimeoutMs !== undefined ? { defaultTimeoutMs } : {}),
		onUpdate,
		...(subscriptions && ctx?.hasUI ? { subscribe: (input) => subscriptions.arm(input) } : {}),
	}));
	const primaryTool: ToolDefinition<typeof SubagentWaitParams, Details> = {
		name: "bg_wait",
		label: "Background Wait",
		description,
		parameters: SubagentWaitParams,
		execute,
	};
	pi.registerTool(primaryTool);
}
