import type { StreamFn } from "@earendil-works/pi-agent-core";

export function agentStreamOptions(streamFn: StreamFn): { streamFunction: StreamFn; streamFn: StreamFn } {
	return { streamFunction: streamFn, streamFn };
}
