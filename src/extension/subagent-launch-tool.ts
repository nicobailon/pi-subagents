import type { ExtensionAPI, ExtensionContext, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

const SUBAGENT_LAUNCH_TOOL = "subagent_launch";

const parameters = Type.Object({
	workflowRunId: Type.String(),
	key: Type.String(),
	agent: Type.Optional(Type.String()),
	task: Type.Optional(Type.String()),
	cwd: Type.Optional(Type.String()),
	model: Type.Optional(Type.String()),
	async: Type.Optional(Type.Boolean()),
	worktree: Type.Optional(Type.Boolean()),
	resume: Type.Optional(Type.String()),
	commands: Type.Optional(Type.Array(Type.Object({
		command: Type.String(),
		cwd: Type.Optional(Type.String()),
		env: Type.Optional(Type.Record(Type.String(), Type.String())),
	}))),
	output: Type.Optional(Type.String()),
});

export type SubagentLaunchArgs = Static<typeof parameters>;

/** Not declared to the model, so the system prompt and tool list stay unchanged. */
export function registerSubagentLaunchTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: SUBAGENT_LAUNCH_TOOL,
		label: "Subagent launch",
		description: "A workflow is about to start this subagent. Blocking this call stops that child from starting.",
		parameters,
		exposure: "deferred",
		async execute() {
			return { content: [{ type: "text", text: "Records approval for a workflow child launch; it starts nothing itself." }], details: {} };
		},
	});
}

/** Offers a workflow child start to the session's `tool_call` handlers; returns the refusal, if any. */
export async function approveWorkflowChildLaunch(ctx: ExtensionContext, describe: () => SubagentLaunchArgs, signal: AbortSignal): Promise<string | undefined> {
	// Starts with no tool call behind them (schedule ticks, auto-resume, RPC) have no executeTool, and a tool
	// allowlist that leaves the tool out unregisters it: no handler could see the call in either case.
	if (!("executeTool" in ctx)) return undefined;
	const toolCtx = ctx as ExtensionToolContext;
	if (!toolCtx.tools.some((tool) => tool.name === SUBAGENT_LAUNCH_TOOL)) return undefined;
	const args = describe();
	const outcome = await toolCtx.executeTool(SUBAGENT_LAUNCH_TOOL, args, { signal });
	if (!outcome.isError) return undefined;
	const reason = outcome.result.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n").trim();
	return `Workflow child '${args.key}' was not started: the ${SUBAGENT_LAUNCH_TOOL} call was refused${reason ? `: ${reason}` : "."}`;
}
