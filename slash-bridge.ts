import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { SubagentParamsLike } from "./subagent-executor.js";
import {
	SLASH_SUBAGENT_CANCEL_EVENT,
	SLASH_SUBAGENT_REQUEST_EVENT,
	SLASH_SUBAGENT_RESPONSE_EVENT,
	SLASH_SUBAGENT_STARTED_EVENT,
	SLASH_SUBAGENT_UPDATE_EVENT,
	type Details,
} from "./types.js";
import { resolveChainDirPath } from "./settings.js";

export interface SlashSubagentRequest {
	requestId: string;
	params: SubagentParamsLike;
}

export interface SlashSubagentResponse {
	requestId: string;
	chainId?: string;
	chainDir?: string;
	result: AgentToolResult<Details>;
	isError: boolean;
	errorText?: string;
}

export interface SlashSubagentUpdate {
	requestId: string;
	progress?: Details["progress"];
	currentTool?: string;
	toolCount?: number;
}

interface SlashChainMetadata {
	chainId?: string;
	chainDir?: string;
}

interface EventBus {
	on(event: string, handler: (data: unknown) => void): (() => void) | void;
	emit(event: string, data: unknown): void;
}

interface SlashBridgeOptions {
	events: EventBus;
	getContext: () => ExtensionContext | null;
	execute: (
		id: string,
		params: SubagentParamsLike,
		signal: AbortSignal,
		onUpdate: ((r: AgentToolResult<Details>) => void) | undefined,
		ctx: ExtensionContext,
	) => Promise<AgentToolResult<Details>>;
}

export function registerSlashSubagentBridge(options: SlashBridgeOptions): {
	cancelAll: () => void;
	dispose: () => void;
} {
	const controllers = new Map<string, AbortController>();
	const pendingCancels = new Set<string>();
	const subscriptions: Array<() => void> = [];

	const getChainMetadata = (requestId: string, params: SubagentParamsLike): SlashChainMetadata => {
		if (!params.chain || params.chain.length === 0) return {};
		return {
			chainId: requestId,
			chainDir: resolveChainDirPath(requestId, params.chainDir),
		};
	};

	const subscribe = (event: string, handler: (data: unknown) => void): void => {
		const unsubscribe = options.events.on(event, handler);
		if (typeof unsubscribe === "function") subscriptions.push(unsubscribe);
	};

	subscribe(SLASH_SUBAGENT_CANCEL_EVENT, (data) => {
		if (!data || typeof data !== "object") return;
		const requestId = (data as { requestId?: unknown }).requestId;
		if (typeof requestId !== "string") return;
		const controller = controllers.get(requestId);
		if (controller) {
			controller.abort();
			return;
		}
		pendingCancels.add(requestId);
	});

	subscribe(SLASH_SUBAGENT_REQUEST_EVENT, async (data) => {
		if (!data || typeof data !== "object") return;
		const request = data as Partial<SlashSubagentRequest>;
		if (typeof request.requestId !== "string" || !request.params) return;
		const { requestId, params } = request as SlashSubagentRequest;

		const ctx = options.getContext();
		if (!ctx) {
			const response: SlashSubagentResponse = {
				requestId,
				...getChainMetadata(requestId, params),
				result: {
					content: [{ type: "text", text: "No active extension context for slash subagent execution." }],
					details: { mode: "single" as const, results: [] },
				},
				isError: true,
				errorText: "No active extension context.",
			};
			options.events.emit(SLASH_SUBAGENT_RESPONSE_EVENT, response);
			return;
		}

		const controller = new AbortController();
		controllers.set(requestId, controller);

		if (pendingCancels.delete(requestId)) {
			controller.abort();
			const response: SlashSubagentResponse = {
				requestId,
				...getChainMetadata(requestId, params),
				result: {
					content: [{ type: "text", text: "Cancelled." }],
					details: { mode: "single" as const, results: [] },
				},
				isError: true,
				errorText: "Cancelled before start.",
			};
			options.events.emit(SLASH_SUBAGENT_RESPONSE_EVENT, response);
			controllers.delete(requestId);
			return;
		}

		options.events.emit(SLASH_SUBAGENT_STARTED_EVENT, { requestId, ...getChainMetadata(requestId, params) });

		try {
			const result = await options.execute(
				requestId,
				params,
				controller.signal,
				(update) => {
					const progress = update.details?.progress;
					const first = progress?.[0];
					const payload: SlashSubagentUpdate = {
						requestId,
						progress,
						currentTool: first?.currentTool,
						toolCount: first?.toolCount,
					};
					options.events.emit(SLASH_SUBAGENT_UPDATE_EVENT, payload);
				},
				ctx,
			);

			const response: SlashSubagentResponse = {
				requestId,
				...getChainMetadata(requestId, params),
				result,
				isError: (result as { isError?: boolean }).isError === true,
				errorText: (result as { isError?: boolean }).isError
					? result.content.find((c) => c.type === "text")?.text
					: undefined,
			};
			options.events.emit(SLASH_SUBAGENT_RESPONSE_EVENT, response);
		} catch (error) {
			const response: SlashSubagentResponse = {
				requestId,
				...getChainMetadata(requestId, params),
				result: {
					content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
					details: { mode: "single" as const, results: [] },
				},
				isError: true,
				errorText: error instanceof Error ? error.message : String(error),
			};
			options.events.emit(SLASH_SUBAGENT_RESPONSE_EVENT, response);
		} finally {
			controllers.delete(requestId);
		}
	});

	return {
		cancelAll: () => {
			for (const controller of controllers.values()) {
				controller.abort();
			}
			controllers.clear();
			pendingCancels.clear();
		},
		dispose: () => {
			for (const unsubscribe of subscriptions) unsubscribe();
			subscriptions.length = 0;
			pendingCancels.clear();
		},
	};
}
