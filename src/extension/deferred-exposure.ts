import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { resolveAuthorityDecision, type AuthorityAction, type AuthorityPolicyConfig } from "../policy/authority.ts";
import type { SubagentParamsLike } from "../runs/foreground/subagent-executor.ts";

/** System prompt section that replaces the undeclared `subagent` tool with `toolExposure: "deferred"`. It carries the delegation authorization rule. */
export const DEFERRED_SUBAGENT_PROMPT = 'pi-subagents: codemode tools.subagent({agent,task}) starts an async child; {action:"list"} lists agents; describeTool("subagent") for usage. Delegate only when the operator asked.';

export const DEFERRED_SUBAGENT_PROMPT_SECTION = "subagents_codemode";

export const DEFERRED_WITHOUT_CODEMODE_ERROR = 'pi-subagents: toolExposure "deferred" needs the codemode tool, which this session does not have active, so subagent cannot be reached. Enable codemode or set toolExposure to "direct" in config.json.';

// Actions the executor gates on an authority decision, which asks the user through ctx.ui.confirm when the decision is
// "confirm" (subagent-executor.ts: worktree.cleanup apply, worktree.discard, the policyAction gate, grant-spawn-budget).
// A script is cancelled when it ends, so a call must not wait on the user.
function confirmingAuthority(action: string, params: SubagentParamsLike): AuthorityAction | undefined {
	switch (action) {
		case "worktree.cleanup": return params.mode === "apply" ? "discardWorktree" : undefined;
		case "worktree.discard": return "discardWorktree";
		case "grant-spawn-budget": return "spawnBudgetGrant";
		case "stop": case "command.cancel": return "stopRun";
		case "steer": case "command.yield": return "steerRun";
		case "schedule.create": return "scheduleCreate";
		case "inspector.open": return "inspectorOpen";
		case "project.open": return "projectOpen";
		default: return undefined;
	}
}

/** Why a call from a codemode script (or any other tool) cannot run, or undefined when it can. */
export function nestedSubagentRefusal(params: SubagentParamsLike, asyncByDefault: boolean, authorityPolicy: AuthorityPolicyConfig | undefined): string | undefined {
	const action = typeof params.action === "string" ? params.action.trim() : undefined;
	if (action === "refine") {
		return "subagent action 'refine' cannot run from a codemode script: it waits for a foreground reviewer child to finish.";
	}
	if (action) {
		const authority = confirmingAuthority(action, params);
		if (authority && resolveAuthorityDecision({ action: authority, ...(authorityPolicy ? { policy: authorityPolicy } : {}) }) === "confirm") {
			return `subagent action '${action}' cannot run from a codemode script: authorityPolicy.${authority} is "confirm", so it would wait for the user to confirm.`;
		}
		return undefined;
	}
	if ((params.workflow === true || params.workflow === "true") && params.workflowScript === undefined) {
		return "subagent workflow:true reads a ```js block from the reply, which a codemode script has none of. Pass the script source as options.script, or a script path as workflow.";
	}
	if (params.clarify === true || params.foregroundOnly === true || (params.async ?? asyncByDefault) !== true) {
		return "subagent launches from a codemode script must be async: pass async:true. A foreground child would block the script until it finished, and be cancelled when the script ends.";
	}
	return undefined;
}

/** A script calls subagent as tools.subagent, so text returned to it names calls that way. */
export function inScriptForm<T>(result: AgentToolResult<T>): AgentToolResult<T> {
	return { ...result, content: result.content.map((part) => part.type === "text" ? { ...part, text: part.text.replace(/(?<![\w.])subagent\(\{/g, "tools.subagent({") } : part) };
}
