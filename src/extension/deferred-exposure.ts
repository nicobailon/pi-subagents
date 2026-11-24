import type { SubagentParamsLike } from "../runs/foreground/subagent-executor.ts";

/** System prompt section that replaces the undeclared `subagent` tool with `toolExposure: "deferred"`. It carries the delegation authorization rule. */
export const DEFERRED_SUBAGENT_PROMPT = 'pi-subagents: start child agents from codemode with tools.subagent({agent,task}) (async only); describeTool("subagent") for usage. Delegate only when the operator asked.';

export const DEFERRED_SUBAGENT_PROMPT_SECTION = "subagents_codemode";

export const DEFERRED_WITHOUT_CODEMODE_ERROR = 'pi-subagents: toolExposure "deferred" needs the codemode tool, which this session does not have active, so subagent cannot be reached. Enable codemode or set toolExposure to "direct" in config.json.';

// A script ends when its last awaited call returns and Pi then cancels the rest, so a nested call may only
// do work that returns at once: launch async runs and control or inspect existing ones. Anything that waits
// on a child or on the user would block the script or be cancelled with it.
const NESTED_ACTIONS = new Set(["status", "list", "get", "models", "guide", "doctor", "validate", "steer", "stop", "interrupt", "resume", "children.list", "debug.run"]);

/** Why a call from a codemode script (or any other tool) cannot run, or undefined when it can. */
export function nestedSubagentRefusal(params: SubagentParamsLike, asyncByDefault: boolean): string | undefined {
	const action = typeof params.action === "string" ? params.action.trim() : undefined;
	if (action) {
		return NESTED_ACTIONS.has(action)
			? undefined
			: `subagent action '${action}' cannot run from a codemode script. Script calls may only launch async runs or use ${[...NESTED_ACTIONS].join(", ")}.`;
	}
	if ((params.workflow === true || params.workflow === "true") && params.workflowScript === undefined) {
		return "subagent workflow:true reads a ```js block from the reply, which a codemode script has none of. Pass the script source as options.script, or a script path as workflow.";
	}
	if (params.clarify === true || params.foregroundOnly === true || (params.async ?? asyncByDefault) !== true) {
		return "subagent launches from a codemode script must be async: pass async:true. A foreground child would block the script until it finished, and be cancelled when the script ends.";
	}
	return undefined;
}
