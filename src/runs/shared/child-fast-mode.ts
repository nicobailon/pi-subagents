import type { AgentSession, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../../extension/config.ts";
import { fastModeUnsupportedError, isFastModeAdapter } from "./child-tool-plan.ts";

export function installChildFastMode(
	session: Pick<AgentSession, "agent" | "model">,
	modelRuntime: Pick<ModelRuntime, "getRegisteredNativeProvider" | "getRegisteredProviderConfig">,
): void {
	const { agent } = session;
	const serviceTier = loadConfig({ strict: true }).fastServiceTier ?? "priority";
	const unsupported = (reason: string) => fastModeUnsupportedError(reason, serviceTier);
	function assertAdapter(model: AgentSession["model"]): void {
		if (!model) throw unsupported("no resolved model adapter");
		const { api, provider, id } = model;
		if (!isFastModeAdapter(api)) throw unsupported(`'${provider}/${id}' uses '${api}'`);
		const config = modelRuntime.getRegisteredProviderConfig(provider);
		if (modelRuntime.getRegisteredNativeProvider(provider) || (config?.streamSimple && config.api === api)) {
			throw unsupported(`'${provider}/${id}' uses an unverified custom stream for '${api}'`);
		}
	}
	assertAdapter(session.model);

	const prepareRequest = agent.prepareRequest;
	agent.prepareRequest = async (request, signal) => {
		const prepared = await prepareRequest?.call(agent, request, signal);
		assertAdapter(prepared?.model ?? request.model);
		return prepared ?? undefined;
	};
	const onPayload = agent.onPayload;
	agent.onPayload = async (payload, model) => {
		assertAdapter(model);
		const next = await onPayload?.call(agent, payload, model);
		const body = next === undefined ? payload : next;
		if (!body || typeof body !== "object" || Array.isArray(body)) throw unsupported("the adapter did not produce an object payload");
		if (Object.hasOwn(body, "service_tier") && (body as { service_tier?: unknown }).service_tier !== undefined) return body;
		return { ...body, service_tier: serviceTier };
	};
}
