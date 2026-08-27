import type { BeforeProviderRequestEvent, ExtensionAPI } from "@earendil-works/pi-coding-agent";

export function rewriteFastModeProviderRequest(event: BeforeProviderRequestEvent): unknown {
	if (!event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) return event.payload;
	return { ...event.payload, service_tier: "priority" };
}

export default function registerSubagentFastModeExtension(pi: ExtensionAPI): void {
	pi.on("before_provider_request", rewriteFastModeProviderRequest);
}
