import { EventEmitter } from "node:events";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { EnvHttpProxyAgent, fetch as undiciFetch } from "undici";

// Pi 0.85 carries the per-request fetch seam; upstream's development types are 0.81.
type TransportOptions = NonNullable<Parameters<StreamFn>[2]> & { fetch?: typeof globalThis.fetch; timeoutMs?: number };

/** A child-owned transport; never replaces the parent process's global dispatcher. */
export function createLocalInferenceTransport() {
	const dispatcher = new EnvHttpProxyAgent({
		allowH2: false,
		proxyTunnel: true,
		headersTimeout: 0,
		bodyTimeout: 0,
		connect: { timeout: 0, autoSelectFamilyAttemptTimeout: 2_000 },
	});
	// Transport errors still reject fetch/body reads; prevent only EventEmitter's fatal default.
	EventEmitter.prototype.on.call(dispatcher, "error", () => {});
	return {
		wrap(original: StreamFn): StreamFn {
			return (model, context, options) => {
				// Pi's signal is the child/operator cancellation channel. The SDK creates a
				// DIFFERENT signal for its request clock. Never forward that clock to HTTP.
				const cancellation = options?.signal;
				const upstreamFetch = ((options as TransportOptions | undefined)?.fetch ?? undiciFetch) as typeof undiciFetch;
				const fetch: typeof globalThis.fetch = async (input, init) => {
					return await upstreamFetch(input as Parameters<typeof undiciFetch>[0], {
						...init as Parameters<typeof undiciFetch>[1],
						dispatcher,
						signal: cancellation ?? null,
					}) as unknown as Response;
				};
				// No giant finite deadline. SDK timeout=0 may abort its own controller;
				// that controller is intentionally not the transport's cancellation signal.
				const protectedOptions: TransportOptions = { ...options, timeoutMs: 0, fetch };
				return original(model, context, protectedOptions);
			};
		},
		async close(): Promise<void> { await dispatcher.close(); },
	};
}
