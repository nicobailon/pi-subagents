import type { BeforeProviderRequestEvent, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../../extension/config.ts";
import type { FastServiceTier } from "../../shared/types.ts";

export function rewriteFastModeProviderRequest(event: BeforeProviderRequestEvent, serviceTier: FastServiceTier): unknown {
	if (!event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) return event.payload;
	return { ...event.payload, service_tier: serviceTier };
}

export default function registerSubagentFastModeExtension(pi: ExtensionAPI): void {
	const serviceTier = loadConfig().fastServiceTier ?? "priority";
	pi.on("before_provider_request", (event) => rewriteFastModeProviderRequest(event, serviceTier));
}
