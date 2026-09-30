import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * Declares a tool to the model but keeps it out of codemode scripts and other `ctx.executeTool()`
 * callers. These tools need model-issued calls: nested calls hide their progress, block the script
 * on supervisor replies, and drop `terminate`. Pi 0.99 reads `exposure`; the pinned SDK types
 * predate it and older hosts ignore it.
 */
export const MODEL_ONLY_TOOL = { exposure: "model-only" } as const;

/** Pi exposes replaced extension contexts as ordinary Errors without a stable code. */
export function isStaleExtensionContextError(error: unknown): boolean {
	return error instanceof Error
		&& /extension ctx is stale|extension context no longer active|stale after session replacement or reload/i.test(error.message);
}

/** Pi throws this from action methods while extensions are still loading, before it binds the runtime. */
export function isUnboundExtensionRuntimeError(error: unknown): boolean {
	return error instanceof Error && /extension runtime not initialized/i.test(error.message);
}

/** Run a synchronous operation against a cached UI context without leaking replacement errors. */
export function withCachedUiContext<T>(
	ctx: ExtensionContext | null | undefined,
	onStale: () => void,
	run: (ctx: ExtensionContext) => T,
): T | undefined {
	if (!ctx) return undefined;
	try {
		if (!ctx.hasUI) return undefined;
		return run(ctx);
	} catch (error) {
		if (!isStaleExtensionContextError(error)) throw error;
		onStale();
		return undefined;
	}
}
