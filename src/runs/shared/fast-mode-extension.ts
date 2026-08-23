import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function withPriorityServiceTier(payload: unknown): unknown {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
	return { ...payload, service_tier: "priority" };
}

export default function registerSubagentFastModeExtension(pi: ExtensionAPI): void {
	pi.on("before_provider_request", (event) => ({ payload: withPriorityServiceTier(event.payload) }));
}
