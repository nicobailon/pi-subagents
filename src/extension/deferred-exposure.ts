import { managementActionAuthority, type AuthorityPolicyConfig } from "../policy/authority.ts";
import type { SubagentParamsLike } from "../runs/foreground/subagent-executor.ts";

/** System prompt section that replaces the undeclared `subagent` tool with `toolExposure: "deferred"`. It carries the delegation authorization rule. */
export const DEFERRED_SUBAGENT_PROMPT = 'pi-subagents: codemode tools.subagent({agent,task}) starts an async child; {action:"list"} lists agents; describeTool("subagent") for usage. Delegate only when the operator asked.';

export const DEFERRED_SUBAGENT_PROMPT_SECTION = "subagents_codemode";

export const DEFERRED_WITHOUT_CODEMODE_ERROR = 'pi-subagents: toolExposure "deferred" needs the codemode tool for tools.subagent, and this session does not have it active; only Pi\'s tool_search can still activate subagent. Enable codemode or set toolExposure to "direct" in config.json.';

/**
 * The request a call from a codemode script (or any other tool) runs, or why it cannot run. Pi cancels a script's
 * calls when the script ends, so a call must not wait on a child or the user: launches run async, even for an agent
 * whose frontmatter defaults to foreground.
 */
export function nestedSubagentRequest(params: SubagentParamsLike, authorityPolicy: AuthorityPolicyConfig | undefined): SubagentParamsLike | string {
	const action = params.action?.trim();
	if (action === "refine") {
		return "subagent action 'refine' cannot run from a codemode script: it waits for a foreground reviewer child to finish.";
	}
	if (action) {
		const authority = managementActionAuthority(action, params.mode, authorityPolicy);
		return authority?.decision === "confirm"
			? `subagent action '${action}' cannot run from a codemode script: authorityPolicy.${authority.authority} is "confirm", so it would wait for the user to confirm.`
			: params;
	}
	if ((params.workflow === true || params.workflow === "true") && params.workflowScript === undefined) {
		return "subagent workflow:true reads a ```js block from the reply, which a codemode script has none of. Pass the script source as options.script, or a script path as workflow.";
	}
	if (params.async === false || params.clarify === true || params.foregroundOnly === true) {
		return "subagent launches from a codemode script must be async: omit async or pass async:true. A foreground child would block the script until it finished, and be cancelled when the script ends.";
	}
	return { ...params, async: true };
}
