import { randomUUID } from "node:crypto";

const COMPLETION_OWNER_KEY = Symbol.for("pi-subagents.completion-owner-id");

type CompletionOwnerGlobal = typeof globalThis & {
	[COMPLETION_OWNER_KEY]?: string;
};

/** Stable for one parent Pi process across extension reloads. */
export function currentCompletionOwnerId(): string {
	const runtime = globalThis as CompletionOwnerGlobal;
	runtime[COMPLETION_OWNER_KEY] ??= randomUUID();
	return runtime[COMPLETION_OWNER_KEY];
}
