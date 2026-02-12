import type { AgentScope, AgentConfig } from "./agents.js";

export function mergeAgentsForScope(
	scope: AgentScope,
	userAgents: AgentConfig[],
	projectAgents: AgentConfig[],
): AgentConfig[] {
	const agentMap = new Map<string, AgentConfig>();

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
