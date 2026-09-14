import type { ChildHookExtension } from "./child-hooks.ts";

/** Immutable per-invocation carrier; no SDK dependency and no environment writes. */
export interface TraceParentContext {
	traceId?: string;
	spanId?: string;
	rootSessionId?: string;
	parentSessionId: string;
	depth: number;
	runId?: string;
	agent?: string;
	childIndex?: number;
	parentToolCallId?: string;
	sourceRunId?: string;
}
export interface TraceLaunchIdentity {
	parentSessionId?: string;
	depth: number;
	runId?: string;
	agent?: string;
	childIndex?: number;
	parentToolCallId?: string;
	sourceRunId?: string;
}
const contextsKey = Symbol.for("pi.langfuse.contexts.v1");
function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" ? value as Record<string, unknown> : undefined;
}
function validId(value: unknown, size: number): value is string {
	return typeof value === "string" && new RegExp(`^[a-fA-F0-9]{${size}}$`).test(value) && !/^0+$/.test(value);
}
function traceFields(value: unknown): Pick<TraceParentContext, "traceId" | "spanId" | "rootSessionId"> {
	const context = record(value);
	if (!context || !validId(context.traceId, 32) || !validId(context.spanId, 16)
		|| typeof context.rootSessionId !== "string" || !context.rootSessionId
		|| !Number.isSafeInteger(context.depth) || (context.depth as number) < 0) return {};
	return { traceId: context.traceId, spanId: context.spanId, rootSessionId: context.rootSessionId };
}

/** Capture only the exact invoking session. Missing context remains an explicit orphan. */
export function captureTraceParent(parentSessionId: string | undefined, depth: number): Readonly<TraceParentContext> {
	const contexts = (globalThis as unknown as Record<symbol, unknown>)[contextsKey];
	const parent = parentSessionId && contexts instanceof Map ? contexts.get(parentSessionId) : undefined;
	return Object.freeze({ ...traceFields(parent), parentSessionId: parentSessionId ?? "", depth });
}

/** Runner callers disable ambient lookup: absence in persisted config is meaningful. */
export function resolveTraceParent(
	identity: TraceLaunchIdentity, snapshot?: unknown, capture = true,
): Readonly<TraceParentContext> {
	const parentSessionId = identity.parentSessionId ?? "";
	const supplied = record(snapshot);
	const parent = snapshot !== undefined
		? supplied?.parentSessionId === parentSessionId ? traceFields(supplied) : {}
		: capture ? captureTraceParent(identity.parentSessionId, identity.depth) : {};
	return Object.freeze({
		...parent, parentSessionId, depth: identity.depth,
		...(identity.runId !== undefined ? { runId: identity.runId } : {}),
		...(identity.agent !== undefined ? { agent: identity.agent } : {}),
		...(identity.childIndex !== undefined ? { childIndex: identity.childIndex } : {}),
		...(identity.parentToolCallId !== undefined ? { parentToolCallId: identity.parentToolCallId } : {}),
		...(identity.sourceRunId !== undefined ? { sourceRunId: identity.sourceRunId } : {}),
	});
}

/** Factories all load before before_agent_start; synchronous replies avoid load-order races. */
export function traceParentHook(context: Readonly<TraceParentContext>): ChildHookExtension {
	return { name: "pi-subagents:trace-parent", factory: (pi) => {
		pi.events.on("pi:trace-parent-request", (payload: unknown) => {
			const request = record(payload);
			if (typeof request?.reply === "function") request.reply(context);
		});
	} };
}
