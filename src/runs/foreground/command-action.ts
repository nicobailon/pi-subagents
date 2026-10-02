import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Details, SubagentState } from "../../shared/types.ts";
import { readStatus } from "../../shared/utils.ts";
import type { ResolvedSubagentRunId } from "../background/run-id-resolver.ts";
import { supervisorChannelDir } from "../shared/child-tool-plan.ts";
import { controlChildCommand, type CommandOperation } from "../shared/child-commands.ts";

function commandChildren(state: SubagentState, target: ResolvedSubagentRunId): Array<{ index: number; agent: string }> {
	if (!state.currentSessionId) throw new Error("Command controls require an owning parent session.");
	if (target.kind === "nested") throw new Error("Command controls support direct local Pi children only.");
	if (target.kind === "foreground") {
		const live = state.foregroundControls.get(target.id);
		const retained = state.foregroundRuns?.get(target.id);
		if ((live?.sessionId ?? retained?.sessionId) !== state.currentSessionId) throw new Error("Run is not owned by this session.");
		if (live?.activeChildren?.size) return [...live.activeChildren.values()].map(({ index, agent }) => ({ index, agent }));
		if (live?.currentAgent) return [{ index: live.currentIndex ?? 0, agent: live.currentAgent }];
		return retained?.children.map(({ index, agent }) => ({ index, agent })) ?? [];
	}
	const status = target.location.asyncDir ? readStatus(target.location.asyncDir) : undefined;
	if (status?.sessionId !== state.currentSessionId) throw new Error("Run is not owned by this session.");
	return status.steps?.map((step, index) => ({ index, agent: step.agent })) ?? [];
}

export async function commandAction(input: {
	state: SubagentState;
	target: ResolvedSubagentRunId;
	operation: CommandOperation;
	index?: number;
	toolCallId?: string;
	signal?: AbortSignal;
}): Promise<AgentToolResult<Details>> {
	const children = commandChildren(input.state, input.target);
	if (input.index === undefined && children.length !== 1) throw new Error("Command controls require an explicit child index for multi-child runs.");
	const child = input.index === undefined ? children[0] : children.find(({ index }) => index === input.index);
	if (!child) throw new Error(`No child index ${input.index ?? 0} in this run.`);
	const result = await controlChildCommand(supervisorChannelDir(input.target.id, child.agent, child.index), input.operation, input.toolCallId, input.signal);
	return {
		content: [{ type: "text", text: JSON.stringify({ runId: input.target.id, index: child.index, commands: result.commands, closed: result.closed }) }],
		details: { mode: "management", results: [], commands: result.commands },
	};
}
