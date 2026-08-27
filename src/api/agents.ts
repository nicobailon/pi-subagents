import type { RegisterRuntimeAgentInput, RuntimeAgentDefinition, RuntimeAgentRegistration } from "../agents/runtime-agent-registry.ts";
export { registerRuntimeAgent as registerAgent } from "../agents/runtime-agent-registry.ts";
export {
	RUNTIME_AGENT_REGISTER_EVENT,
	RUNTIME_AGENT_REGISTER_VERSION,
	registerAgentViaEvents,
	type RegisterRuntimeAgentViaEventsInput,
	type RuntimeAgentRegistrationRequest,
	type RuntimeAgentRegistrationResult,
} from "../agents/runtime-agent-events.ts";

export type { RegisterRuntimeAgentInput, RuntimeAgentDefinition, RuntimeAgentRegistration };
