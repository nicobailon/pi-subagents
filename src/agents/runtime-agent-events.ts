import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerRuntimeAgent, type RuntimeAgentDefinition, type RuntimeAgentRegistration } from "./runtime-agent-registry.ts";

export const RUNTIME_AGENT_REGISTER_EVENT = "pi-subagents:runtime-agent-register:v1";
export const RUNTIME_AGENT_REGISTER_VERSION = 1;

export type RuntimeAgentRegistrationResult =
	| { ok: true; registration: RuntimeAgentRegistration }
	| { ok: false; error: Error };

export interface RuntimeAgentRegistrationRequest {
	version: 1;
	name: string;
	definition: RuntimeAgentDefinition;
	result?: RuntimeAgentRegistrationResult;
}

export interface RegisterRuntimeAgentViaEventsInput {
	pi: Pick<ExtensionAPI, "events">;
	name: string;
	definition: RuntimeAgentDefinition;
}

function errorFrom(value: unknown): Error {
	return value instanceof Error ? value : new Error(String(value));
}

/** Register through the installed pi-subagents owner in this Pi process. */
export function registerAgentViaEvents(input: RegisterRuntimeAgentViaEventsInput): RuntimeAgentRegistration {
	const request: RuntimeAgentRegistrationRequest = {
		version: RUNTIME_AGENT_REGISTER_VERSION,
		name: input.name,
		definition: input.definition,
	};
	input.pi.events.emit(RUNTIME_AGENT_REGISTER_EVENT, request);
	const result = request.result as unknown;
	if (result === undefined) {
		throw new Error("pi-subagents is not installed, not ready, or does not support runtime agent event registration.");
	}
	if (result && typeof result === "object" && !Array.isArray(result)) {
		const candidate = result as Record<string, unknown>;
		if (candidate.ok === true && candidate.registration && typeof candidate.registration === "object" && typeof (candidate.registration as { dispose?: unknown }).dispose === "function") {
			return candidate.registration as RuntimeAgentRegistration;
		}
		if (candidate.ok === false && candidate.error instanceof Error) throw candidate.error;
	}
	throw new Error("pi-subagents returned a malformed runtime agent registration result.");
}

/** Install the process-local registration listener for the owning pi-subagents runtime. */
export function registerRuntimeAgentEventListener(pi: ExtensionAPI): () => void {
	return pi.events.on(RUNTIME_AGENT_REGISTER_EVENT, (rawRequest) => {
		if (!rawRequest || typeof rawRequest !== "object" || Array.isArray(rawRequest)) return;
		const request = rawRequest as Record<string, unknown>;
		if (request.result !== undefined) return;
		try {
			if (request.version !== RUNTIME_AGENT_REGISTER_VERSION) {
				throw new Error(`Unsupported runtime agent registration event version '${String(request.version)}'.`);
			}
			const registration = registerRuntimeAgent({
				pi,
				name: request.name as string,
				definition: request.definition as RuntimeAgentDefinition,
			});
			request.result = { ok: true, registration } satisfies RuntimeAgentRegistrationResult;
		} catch (error) {
			request.result = { ok: false, error: errorFrom(error) } satisfies RuntimeAgentRegistrationResult;
		}
	});
}
