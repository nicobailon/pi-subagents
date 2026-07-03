import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Compile } from "typebox/compile";
import { resolveAsyncRunLocation } from "../runs/background/async-resume.ts";
import { deliverTimeoutRequest } from "../runs/background/control-channel.ts";
import { reconcileAsyncRun } from "../runs/background/stale-run-reconciler.ts";
import type { SubagentParamsLike } from "../runs/foreground/subagent-executor.ts";
import { type Details, ASYNC_DIR, RESULTS_DIR } from "../shared/types.ts";
import { readStatus } from "../shared/utils.ts";
import { SubagentParams } from "./schemas.ts";

export const SUBAGENT_RPC_PROTOCOL_VERSION = 1;
export const SUBAGENT_RPC_REQUEST_EVENT = "subagents:rpc:v1:request";
export const SUBAGENT_RPC_READY_EVENT = "subagents:rpc:v1:ready";
export const SUBAGENT_RPC_REPLY_EVENT_PREFIX = "subagents:rpc:v1:reply:";

export const SUBAGENT_RPC_METHODS = ["ping", "status", "spawn", "interrupt", "stop"] as const;
export type SubagentRpcMethod = typeof SUBAGENT_RPC_METHODS[number];

export interface SubagentRpcRequestEnvelope {
	version: typeof SUBAGENT_RPC_PROTOCOL_VERSION;
	requestId: string;
	method: SubagentRpcMethod;
	params?: unknown;
	source?: {
		extension?: string;
		[key: string]: unknown;
	};
}

export type SubagentRpcReplyEnvelope<T = unknown> = {
	version: typeof SUBAGENT_RPC_PROTOCOL_VERSION;
	requestId: string;
	method?: SubagentRpcMethod;
	success: true;
	data: T;
} | {
	version: typeof SUBAGENT_RPC_PROTOCOL_VERSION;
	requestId: string;
	method?: SubagentRpcMethod;
	success: false;
	error: {
		code: SubagentRpcErrorCode;
		message: string;
	};
};

type SubagentRpcErrorCode =
	| "invalid_request"
	| "invalid_params"
	| "unsupported_version"
	| "unsupported_method"
	| "no_active_session"
	| "execution_failed"
	| "not_found"
	| "invalid_state";

interface EventBus {
	on(event: string, handler: (data: unknown) => void): (() => void) | void;
	emit(event: string, data: unknown): void;
}

interface RegisterSubagentRpcBridgeOptions {
	events: EventBus;
	getContext: () => ExtensionContext | null;
	execute: (
		id: string,
		params: SubagentParamsLike,
		signal: AbortSignal,
		onUpdate: ((result: AgentToolResult<Details>) => void) | undefined,
		ctx: ExtensionContext,
	) => Promise<AgentToolResult<Details>>;
	asyncDirRoot?: string;
	resultsDir?: string;
	kill?: (pid: number, signal?: NodeJS.Signals | 0) => boolean;
	now?: () => number;
}

class SubagentRpcError extends Error {
	readonly code: SubagentRpcErrorCode;

	constructor(code: SubagentRpcErrorCode, message: string) {
		super(message);
		this.name = "SubagentRpcError";
		this.code = code;
	}
}

const subagentParamsValidator = Compile(SubagentParams);

export function subagentRpcReplyEvent(requestId: string): string {
	return `${SUBAGENT_RPC_REPLY_EVENT_PREFIX}${requestId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertRequestId(value: unknown): string {
	if (typeof value !== "string" || value.trim().length === 0 || /[\r\n]/.test(value)) {
		throw new SubagentRpcError("invalid_request", "RPC requestId must be a non-empty string without newlines.");
	}
	return value;
}

function assertRecordParams(params: unknown, method: SubagentRpcMethod): Record<string, unknown> {
	if (params === undefined) return {};
	if (!isRecord(params)) throw new SubagentRpcError("invalid_params", `RPC ${method} params must be an object.`);
	return params;
}

function assertSubagentParams(params: SubagentParamsLike, label: string): void {
	if (subagentParamsValidator.Check(params)) return;
	const messages = [...subagentParamsValidator.Errors(params)]
		.slice(0, 4)
		.map((error) => error.message);
	throw new SubagentRpcError("invalid_params", `${label}: ${messages.join("; ") || "invalid subagent parameters"}`);
}

function textFromToolResult(result: AgentToolResult<Details>): string {
	return result.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

function dataFromToolResult(result: AgentToolResult<Details>): { text: string; details?: Details; isError?: boolean } {
	return {
		text: textFromToolResult(result),
		...(result.details ? { details: result.details } : {}),
		...(result.isError ? { isError: true } : {}),
	};
}

function failIfToolError(result: AgentToolResult<Details>): void {
	if (!result.isError) return;
	throw new SubagentRpcError("execution_failed", textFromToolResult(result) || "Subagent RPC execution failed.");
}

function normalizeTargetParams(params: unknown, method: SubagentRpcMethod): Pick<SubagentParamsLike, "id" | "runId" | "dir" | "index"> {
	const input = assertRecordParams(params, method);
	const output: Pick<SubagentParamsLike, "id" | "runId" | "dir" | "index"> = {};
	if (input.id !== undefined) output.id = input.id as string;
	if (input.runId !== undefined) output.runId = input.runId as string;
	if (input.dir !== undefined) output.dir = input.dir as string;
	if (input.index !== undefined) output.index = input.index as number;
	return output;
}

function sessionData(ctx: ExtensionContext | null): { cwd?: string; sessionId?: string; sessionFile?: string | null } {
	if (!ctx) return {};
	return {
		cwd: ctx.cwd,
		sessionId: ctx.sessionManager.getSessionId() ?? undefined,
		sessionFile: ctx.sessionManager.getSessionFile() ?? null,
	};
}

function pingData(ctx: ExtensionContext | null) {
	return {
		version: SUBAGENT_RPC_PROTOCOL_VERSION,
		methods: [...SUBAGENT_RPC_METHODS],
		capabilities: {
			status: true,
			asyncSpawn: true,
			interrupt: true,
			stop: true,
		},
		events: {
			ready: SUBAGENT_RPC_READY_EVENT,
			request: SUBAGENT_RPC_REQUEST_EVENT,
			replyPrefix: SUBAGENT_RPC_REPLY_EVENT_PREFIX,
		},
		session: sessionData(ctx),
	};
}

async function executeChecked(
	options: RegisterSubagentRpcBridgeOptions,
	ctx: ExtensionContext,
	requestId: string,
	method: SubagentRpcMethod,
	params: SubagentParamsLike,
): Promise<{ text: string; details?: Details; isError?: boolean }> {
	assertSubagentParams(params, `RPC ${method} params`);
	const controller = new AbortController();
	const result = await options.execute(`rpc-${method}-${requestId}`, params, controller.signal, undefined, ctx);
	failIfToolError(result);
	return dataFromToolResult(result);
}

function spawnParams(params: unknown): SubagentParamsLike {
	const input = assertRecordParams(params, "spawn");
	if (input.action !== undefined) {
		throw new SubagentRpcError("invalid_params", "RPC spawn does not accept management/control actions. Use status or interrupt RPC methods instead.");
	}
	if (input.async === false) {
		throw new SubagentRpcError("invalid_params", "RPC spawn only supports detached async launches; omit async or set async: true.");
	}
	if (input.clarify === true) {
		throw new SubagentRpcError("invalid_params", "RPC spawn cannot open the clarify UI; omit clarify or set clarify: false.");
	}
	return { ...(input as SubagentParamsLike), async: true, clarify: false };
}

function stopAsyncRun(
	params: unknown,
	options: RegisterSubagentRpcBridgeOptions,
	ctx: ExtensionContext,
): { runId: string; asyncDir: string; previousState: string; state: "stopping"; message: string } {
	const target = normalizeTargetParams(params, "stop");
	assertSubagentParams({ action: "status", ...target }, "RPC stop target params");
	const asyncDirRoot = options.asyncDirRoot ?? ASYNC_DIR;
	const resultsDir = options.resultsDir ?? RESULTS_DIR;
	let location;
	try {
		location = resolveAsyncRunLocation(target, asyncDirRoot, resultsDir);
	} catch (error) {
		throw new SubagentRpcError("invalid_params", error instanceof Error ? error.message : String(error));
	}
	if (!location.asyncDir) {
		throw new SubagentRpcError("not_found", "Async run not found or already completed; stop requires a live async run directory.");
	}

	const currentSessionId = ctx.sessionManager.getSessionId();
	const initialStatus = readStatus(location.asyncDir);
	const initialRunId = initialStatus?.runId ?? location.resolvedId ?? path.basename(location.asyncDir);
	if (!initialStatus) throw new SubagentRpcError("not_found", `Status file not found for async run '${initialRunId}'.`);
	if (!currentSessionId || initialStatus.sessionId !== currentSessionId) {
		throw new SubagentRpcError("not_found", `Async run '${initialRunId}' was not found in the active session.`);
	}

	let status;
	try {
		status = reconcileAsyncRun(location.asyncDir, { resultsDir, kill: options.kill, now: options.now }).status;
	} catch (error) {
		throw new SubagentRpcError("execution_failed", error instanceof Error ? error.message : String(error));
	}
	const runId = status?.runId ?? initialRunId;
	if (!status) throw new SubagentRpcError("not_found", `Status file not found for async run '${runId}'.`);
	if (status.sessionId !== currentSessionId) {
		throw new SubagentRpcError("not_found", `Async run '${runId}' was not found in the active session.`);
	}
	if (status.state !== "running") {
		throw new SubagentRpcError("invalid_state", `Async run ${runId} is ${status.state}; stop only supports running async runs.`);
	}

	try {
		deliverTimeoutRequest({
			asyncDir: location.asyncDir,
			pid: status.pid,
			kill: options.kill,
			now: options.now,
			source: "rpc-stop",
		});
	} catch (error) {
		throw new SubagentRpcError("execution_failed", error instanceof Error ? error.message : String(error));
	}

	return {
		runId,
		asyncDir: location.asyncDir,
		previousState: status.state,
		state: "stopping",
		message: `Stop requested for async run ${runId}.`,
	};
}

async function handleRequest(
	request: SubagentRpcRequestEnvelope,
	options: RegisterSubagentRpcBridgeOptions,
): Promise<unknown> {
	const ctx = options.getContext();
	if (request.method === "ping") return pingData(ctx);
	if (!ctx) throw new SubagentRpcError("no_active_session", "No active extension context for subagent RPC.");

	if (request.method === "spawn") {
		return executeChecked(options, ctx, request.requestId, request.method, spawnParams(request.params));
	}
	if (request.method === "status") {
		return executeChecked(options, ctx, request.requestId, request.method, { action: "status", ...normalizeTargetParams(request.params, "status") });
	}
	if (request.method === "interrupt") {
		return executeChecked(options, ctx, request.requestId, request.method, { action: "interrupt", ...normalizeTargetParams(request.params, "interrupt") });
	}
	if (request.method === "stop") {
		return stopAsyncRun(request.params, options, ctx);
	}
	throw new SubagentRpcError("unsupported_method", `Unsupported subagent RPC method: ${String(request.method)}`);
}

function parseRequest(raw: unknown): SubagentRpcRequestEnvelope {
	if (!isRecord(raw)) throw new SubagentRpcError("invalid_request", "Subagent RPC request must be an object.");
	const requestId = assertRequestId(raw.requestId);
	if (raw.version !== SUBAGENT_RPC_PROTOCOL_VERSION) {
		throw new SubagentRpcError("unsupported_version", `Unsupported subagent RPC version: ${String(raw.version)}.`);
	}
	if (typeof raw.method !== "string" || !(SUBAGENT_RPC_METHODS as readonly string[]).includes(raw.method)) {
		throw new SubagentRpcError("unsupported_method", `Unsupported subagent RPC method: ${String(raw.method)}.`);
	}
	return {
		version: SUBAGENT_RPC_PROTOCOL_VERSION,
		requestId,
		method: raw.method as SubagentRpcMethod,
		...(raw.params !== undefined ? { params: raw.params } : {}),
		...(isRecord(raw.source) ? { source: raw.source as SubagentRpcRequestEnvelope["source"] } : {}),
	};
}

function safeReplyRequestId(raw: unknown): string {
	if (!isRecord(raw)) return "unknown";
	const requestId = raw.requestId;
	return typeof requestId === "string" && requestId.trim().length > 0 && !/[\r\n]/.test(requestId)
		? requestId
		: "unknown";
}

function errorReply(raw: unknown, error: unknown): SubagentRpcReplyEnvelope {
	const requestId = safeReplyRequestId(raw);
	const method = isRecord(raw) && typeof raw.method === "string" && (SUBAGENT_RPC_METHODS as readonly string[]).includes(raw.method)
		? raw.method as SubagentRpcMethod
		: undefined;
	const rpcError = error instanceof SubagentRpcError
		? error
		: new SubagentRpcError("execution_failed", error instanceof Error ? error.message : String(error));
	return {
		version: SUBAGENT_RPC_PROTOCOL_VERSION,
		requestId,
		...(method ? { method } : {}),
		success: false,
		error: {
			code: rpcError.code,
			message: rpcError.message,
		},
	};
}

export function registerSubagentRpcBridge(options: RegisterSubagentRpcBridgeOptions): {
	emitReady: (ctx?: ExtensionContext | null) => void;
	dispose: () => void;
} {
	const unsubscribe = options.events.on(SUBAGENT_RPC_REQUEST_EVENT, async (raw) => {
		let request: SubagentRpcRequestEnvelope | undefined;
		try {
			request = parseRequest(raw);
			const data = await handleRequest(request, options);
			options.events.emit(subagentRpcReplyEvent(request.requestId), {
				version: SUBAGENT_RPC_PROTOCOL_VERSION,
				requestId: request.requestId,
				method: request.method,
				success: true,
				data,
			} satisfies SubagentRpcReplyEnvelope);
		} catch (error) {
			const reply = errorReply(request ?? raw, error);
			options.events.emit(subagentRpcReplyEvent(reply.requestId), reply);
		}
	});

	return {
		emitReady: (ctx) => {
			options.events.emit(SUBAGENT_RPC_READY_EVENT, pingData(ctx ?? options.getContext()));
		},
		dispose: () => {
			if (typeof unsubscribe === "function") unsubscribe();
		},
	};
}
