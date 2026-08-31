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
): void {
	const description = `Wait for background, provider, or detached work that has no native completion notification, then return.

Ordinary async subagent runs already notify this session natively when they complete or need attention. In an interactive chat, return control instead of calling this merely to wait. Use this tool for provider jobs, remembered detached foreground runs, or other background work without a native notification path. Headless runs auto-drain current-session subagent work at agent_end; use this tool only when the current turn must receive non-notifying background work results.

• { } — return when the first initially active async run or registered provider item finishes, or when a subagent needs attention.
• { all: true } — wait for every async run and provider item that was active when the call began.
• { id: "..." } — wait for one async or remembered detached foreground subagent run (id or prefix).
• { id: "...", nonBlocking: true } — resolve the prefix once, persist an exact-run wake subscription, and return immediately. Use this for detached work without native completion delivery; the originating interactive session wakes on completion, failure, attention, reconciliation failure, or timeout.
• { stopOnAttention: false } — for blocking waits only, keep waiting through idle or long-thinking attention; supervisor/contact requests still stop the wait.
• { timeoutMs: 600000 } — stop waiting after N ms; active work keeps running. Omitted values use waitTool.defaultTimeoutMs, then 30 minutes. Window expiry returns a non-error window_elapsed result with active work identities.

Non-blocking subscriptions are visible in subagent status and differ from disabling waitTool: waitTool.enabled=false returns immediately without registering any future wake. Provider jobs are session-scoped and identified exactly, so replacing one job with another cannot hide a completion. Provider extensions must be explicitly loaded in this process. In a child agent, keep \`bg_wait\` in the child tool allowlist and load each provider through the agent's extensions or subagentOnlyExtensions; this tool never loads providers or grants tools itself.${enabled ? "" : "\n\nConfigured behavior: bg_wait is disabled by config.waitTool or PI_SUBAGENT_WAIT_TOOL_ENABLED and returns immediately without blocking."}`;
	const execute: ToolDefinition<typeof SubagentWaitParams, Details>["execute"] = async (_id, params, signal, onUpdate, ctx) => finalizeToolResult(await waitForSubagents(params, signal, {
		state,
		events: pi.events,
		enabled,
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
