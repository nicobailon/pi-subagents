import type { AgentScope } from "./agents.ts";

export function resolveExecutionAgentScope(scope: unknown): AgentScope {
	if (scope === "user" || scope === "project" || scope === "both") return scope;
	return "both";
}

export function projectScopeRequiresTrustMessage(cwd: string): string {
	return `agentScope: "project" requires project trust. This session declined trust for ${cwd}, so project agents and project subagent settings are ignored. Re-run with agentScope: "user" or approve the project folder.`;
}
