import { registerRuntimeAgent, type RegisterRuntimeAgentInput, type RuntimeAgentDefinition, type RuntimeAgentRegistration } from "../agents/runtime-agent-registry.ts";

export type { RegisterRuntimeAgentInput, RuntimeAgentDefinition, RuntimeAgentRegistration };

export function registerAgent(input: RegisterRuntimeAgentInput): RuntimeAgentRegistration {
	return registerRuntimeAgent(input);
}
