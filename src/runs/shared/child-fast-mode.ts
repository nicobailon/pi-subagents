import type { AgentSession, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../../extension/config.ts";

export function installChildFastMode(
	session: Pick<AgentSession, "agent" | "model">,
	modelRuntime: Pick<ModelRuntime, "getRegisteredNativeProvider" | "getRegisteredProviderConfig">,
): void {
	const { agent } = session;
	// A bad config must not turn an explicitly configured tier into Priority.
	const serviceTier = loadConfig({ strict: true }).fastServiceTier ?? "priority";
	const unsupported = (reason: string) => new Error(
		`Cannot forward fast mode service_tier '${serviceTier}': ${reason}. Select a model using Pi's OpenAI Responses or Codex Responses adapter, or set fast: false.`,
	);
	function assertAdapter(model: AgentSession["model"]): void {
		if (!model) throw unsupported("no resolved model adapter");
		const { api, provider, id } = model;
		if (api !== "openai-responses" && api !== "openai-codex-responses") {
			throw unsupported(`'${provider}/${id}' uses '${api}'`);
		}
		// A provider extension can replace the stream on an otherwise compatible API id.
		const config = modelRuntime.getRegisteredProviderConfig(provider);
		if (modelRuntime.getRegisteredNativeProvider(provider) || (config?.streamSimple && config.api === api)) {
			throw unsupported(`'${provider}/${id}' uses an unverified custom stream for '${api}'`);
		}
	}
	assertAdapter(session.model);

	// Guard dispatch even for adapters that never call onPayload. Keep Pi's own
	// request preparation and use its resulting model, not the launch string.
	const prepareRequest = agent.prepareRequest;
	agent.prepareRequest = async (request, signal) => {
		const prepared = await prepareRequest?.call(agent, request, signal);
		assertAdapter(prepared?.model ?? request.model);
		return prepared ?? undefined;
	};
	// Unlike before_provider_request, the SDK callback sees the adapter's model
	// and a thrown error stops serialization rather than being logged and ignored.
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
