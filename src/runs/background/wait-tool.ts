import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { SubagentWaitParams } from "../../extension/schemas.ts";
import type { Details, SubagentState } from "../../shared/types.ts";
import { resolveWaitToolConfig, waitForSubagents } from "./subagent-wait.ts";
import type { WaitSubscriptionManager } from "./wait-subscriptions.ts";
import { finalizeToolResult } from "../../extension/tool-result.ts";

export function registerWaitTool(pi: ExtensionAPI, state: SubagentState, enabled = resolveWaitToolConfig().enabled, subscriptions?: Pick<WaitSubscriptionManager, "arm">): void {
	const tool: ToolDefinition<typeof SubagentWaitParams, Details> = {
		name: "subagent_wait",
		label: "Subagent Wait",
		description: `Block until background work owned by this session changes, then return.

In an interactive chat, do not call this merely to wait: return control to the user and let Pi wake the session on completion. Override that default and call it when the current request is run-to-completion — for example, the user asked you to report results back before continuing or a skill cannot return before its work finishes. Headless runs auto-drain current-session work at agent_end; call this when the current turn must receive results before it ends.

• { } — return when the first initially active async run or registered provider item finishes, or when a subagent needs attention.
• { all: true } — wait for every async run and provider item that was active when the call began.
• { id: "..." } — wait for one async or remembered detached foreground subagent run (id or prefix).
• { id: "...", nonBlocking: true } — resolve the prefix once, persist an exact-run wake subscription, and return immediately. The originating interactive session wakes on completion, failure, attention, reconciliation failure, or timeout.
• { stopOnAttention: false } — for blocking waits only, keep waiting through idle or long-thinking attention; supervisor/contact requests still stop the wait.
• { timeoutMs: 600000 } — stop waiting after N ms; active work keeps running.

Non-blocking subscriptions are visible in subagent status and differ from disabling waitTool: waitTool.enabled=false returns immediately without registering any future wake. Provider jobs are session-scoped and identified exactly, so replacing one job with another cannot hide a completion. Provider extensions must be explicitly loaded in this process. In a child agent, keep \`subagent_wait\` in the child tool allowlist and load each provider through the agent's extensions or subagentOnlyExtensions; this tool never loads providers or grants tools itself.${enabled ? "" : "\n\nConfigured behavior: subagent_wait is disabled by config.waitTool or PI_SUBAGENT_WAIT_TOOL_ENABLED and returns immediately without blocking."}`,
		parameters: SubagentWaitParams,
		async execute(_id, params, signal, onUpdate, ctx) {
			return finalizeToolResult(await waitForSubagents(params, signal, {
				state,
				events: pi.events,
				enabled,
				onUpdate,
				...(subscriptions && ctx?.hasUI ? { subscribe: (input) => subscriptions.arm(input) } : {}),
			}));
		},
	};
	pi.registerTool(tool);
}
