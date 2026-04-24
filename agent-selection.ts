import type { AgentScope, AgentConfig } from "./agents.ts";

/**
 * Merge agents with priority (last writer wins):
 *   builtin < package < user < project
 *
 * "package" agents are registered at runtime by external pi packages via EventBus.
 * They sit above pi-subagents' own builtins but below anything the user explicitly places.
 */
export function mergeAgentsForScope(
	scope: AgentScope,
	userAgents: AgentConfig[],
	projectAgents: AgentConfig[],
	builtinAgents: AgentConfig[] = [],
	packageAgents: AgentConfig[] = [],
): AgentConfig[] {
	const agentMap = new Map<string, AgentConfig>();

	for (const agent of builtinAgents) agentMap.set(agent.name, agent);
	for (const agent of packageAgents) agentMap.set(agent.name, agent);

	if (scope === "both") {
		for (const agent of userAgents) agentMap.set(agent.name, agent);
		for (const agent of projectAgents) agentMap.set(agent.name, agent);
	} else if (scope === "user") {
		for (const agent of userAgents) agentMap.set(agent.name, agent);
	} else {
		for (const agent of projectAgents) agentMap.set(agent.name, agent);
	}

	return Array.from(agentMap.values());
}
