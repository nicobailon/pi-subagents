/**
 * Shared registration of the `subagent_wait` tool.
 *
 * Used by both the parent extension (src/extension/index.ts) and the child
 * subagent runtime (src/runs/shared/subagent-prompt-runtime.ts) so subagents
 * that background a bash/agent job (pi-patty-bg-tasks) or launch their own
 * async runs can block on completion the same way the parent can.
 */

import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { SubagentWaitParams } from "../../extension/schemas.ts";
import type { Details, SubagentState, WaitToolConfig } from "../../shared/types.ts";
import { resolveWaitToolConfig, waitForSubagents } from "./subagent-wait.ts";

function waitDescription(enabled: boolean): string {
	return `Block until background work started in this session finishes, then return.

Use this after launching async subagents or background bash/agent jobs when you have no independent work left and must not end your turn — for example inside a skill that must run to completion, or any non-interactive run (\`pi -p ...\`) where the whole task is a single turn and ending it would abandon the still-running work.

• { } — return as soon as the FIRST piece of work finishes (default): an async subagent run OR a background job (pi-patty-bg-tasks bash_bg/agent_bg). Ideal for a rolling fleet: launch N, wait, spawn a replacement, then call subagent_wait again.
• { all: true } — block until EVERY active subagent run AND background job in this session is finished.
• { id: "..." } — wait for one specific async subagent run or remembered detached foreground run (id or prefix) to finish.
• { timeoutMs: 600000 } — stop waiting after N ms (the work keeps going regardless; default 30 min)

subagent_wait also returns when a subagent run needs attention (a child that went idle or blocked for a decision), not only on completion — so a stuck child never stalls the loop. It wakes the instant a completion/control event arrives (subscribed to Pi's event bus — subagent completions and background-job completions — with a poll fallback), and resolves early if the turn is aborted.${enabled ? "" : "\n\nConfigured behavior: subagent_wait is disabled by config.waitTool or PI_SUBAGENT_WAIT_TOOL_ENABLED and returns immediately without blocking."}`;
}

/**
 * Register the `subagent_wait` tool on `pi` backed by `state`. `state` supplies
 * the current session id (for scoping async runs); background-job tracking reads
 * the pi-patty-bg-tasks process-global live set and needs no state.
 */
export function registerWaitTool(pi: ExtensionAPI, state: SubagentState, options: { waitTool?: WaitToolConfig; enabled?: boolean } = {}): void {
	const enabled = options.enabled ?? resolveWaitToolConfig(options.waitTool).enabled;
	const waitTool: ToolDefinition<typeof SubagentWaitParams, Details> = {
		name: "subagent_wait",
		label: "Subagent Wait",
		description: waitDescription(enabled),
		parameters: SubagentWaitParams,
		execute(_id, params, signal, _onUpdate, _ctx) {
			return waitForSubagents(params, signal, { state, events: pi.events, enabled });
		},
	};
	pi.registerTool(waitTool);
}
