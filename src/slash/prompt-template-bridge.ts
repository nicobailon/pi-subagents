import {
	SUBAGENT_DELEGATION_CANCEL_EVENT,
	SUBAGENT_DELEGATION_PROTOCOL_VERSION,
	SUBAGENT_DELEGATION_REQUEST_EVENT,
	SUBAGENT_DELEGATION_RESPONSE_EVENT,
	SUBAGENT_DELEGATION_STARTED_EVENT,
	SUBAGENT_DELEGATION_UPDATE_EVENT,
	type SubagentDelegationRequest,
	type SubagentDelegationResponse,
} from "../api/delegation.ts";
import { parseSubagentDelegationRequest } from "./delegation-request.ts";
import {
	parsePromptTemplateRequest,
	toDelegationUpdate,
	toLegacyExecutionParams,
	toPromptTemplateResponse,
	toSubagentDelegationExecutionParams,
	toSubagentDelegationResponse,
	toSubagentDelegationUpdate,
	type DelegatedSubagentExecutionParams,
	type PromptTemplateBridgeResult,
	type PromptTemplateDelegationRequest,
	type PromptTemplateDelegationResponse,
} from "./delegation-adapters.ts";

export const PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT = SUBAGENT_DELEGATION_REQUEST_EVENT;
export const PROMPT_TEMPLATE_SUBAGENT_STARTED_EVENT = SUBAGENT_DELEGATION_STARTED_EVENT;
export const PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT = SUBAGENT_DELEGATION_RESPONSE_EVENT;
export const PROMPT_TEMPLATE_SUBAGENT_UPDATE_EVENT = SUBAGENT_DELEGATION_UPDATE_EVENT;
export const PROMPT_TEMPLATE_SUBAGENT_CANCEL_EVENT = SUBAGENT_DELEGATION_CANCEL_EVENT;

export interface PromptTemplateBridgeEvents {
	on(event: string, handler: (data: unknown) => void): (() => void) | void;
	emit(event: string, data: unknown): void;
}

interface PromptTemplateBridgeOptions<Ctx extends { cwd?: string }> {
	events: PromptTemplateBridgeEvents;
	getContext: () => Ctx | null;
	execute: (
		requestId: string,
		params: DelegatedSubagentExecutionParams,
		signal: AbortSignal,
		ctx: Ctx,
		onUpdate: (result: PromptTemplateBridgeResult) => void,
	) => Promise<PromptTemplateBridgeResult>;
}

export function registerPromptTemplateDelegationBridge<Ctx extends { cwd?: string }>(
	options: PromptTemplateBridgeOptions<Ctx>,
): {
	cancelAll: () => void;
	dispose: () => void;
} {
	const controllers = new Map<string, AbortController>();
	const pendingCancels = new Map<string, true>();
	const subscriptions: Array<() => void> = [];
	let disposed = false;

	const subscribe = (event: string, handler: (data: unknown) => void): void => {
		const unsubscribe = options.events.on(event, handler);
		if (typeof unsubscribe === "function") subscriptions.push(unsubscribe);
	};
	const ownsRequest = (requestId: string, controller: AbortController): boolean =>
		!disposed && controllers.get(requestId) === controller;
	const rememberPendingCancel = (requestId: string): void => {
		pendingCancels.delete(requestId);
		pendingCancels.set(requestId, true);
		while (pendingCancels.size > 256) {
			const oldest = pendingCancels.keys().next().value;
			if (typeof oldest !== "string") break;
			pendingCancels.delete(oldest);
		}
	};

	subscribe(PROMPT_TEMPLATE_SUBAGENT_CANCEL_EVENT, (data) => {
		if (!data || typeof data !== "object" || Array.isArray(data)) return;
		if (Object.hasOwn(data, "version")) {
			const value = data as Record<string, unknown>;
			if (value.version !== SUBAGENT_DELEGATION_PROTOCOL_VERSION) return;
			if (Object.keys(value).some((key) => key !== "version" && key !== "requestId")) return;
		}
		const requestId = (data as { requestId?: unknown }).requestId;
		if (typeof requestId !== "string" || !requestId.trim() || requestId.length > 256 || /[\r\n]/.test(requestId)) return;
		const controller = controllers.get(requestId);
		if (controller) {
			controller.abort();
			return;
		}
		rememberPendingCancel(requestId);
	});

	subscribe(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, async (data) => {
		const isVersioned = !!data && typeof data === "object" && Object.hasOwn(data, "version");
		let requestId: string;
		let params: DelegatedSubagentExecutionParams;
		let versionedRequest: SubagentDelegationRequest | undefined;
		let legacyRequest: PromptTemplateDelegationRequest | undefined;

		if (isVersioned) {
			const parsed = parseSubagentDelegationRequest(data);
			if (parsed.ok === false) {
				if (!disposed && parsed.requestId && !controllers.has(parsed.requestId)) {
					options.events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
						version: SUBAGENT_DELEGATION_PROTOCOL_VERSION,
						requestId: parsed.requestId,
						status: "invalid_request",
						error: parsed.error,
					} satisfies SubagentDelegationResponse);
				}
				return;
			}
			versionedRequest = parsed.request;
			requestId = parsed.request.requestId;
			params = toSubagentDelegationExecutionParams(parsed.request);
		} else {
			legacyRequest = parsePromptTemplateRequest(data);
			if (!legacyRequest) return;
			requestId = legacyRequest.requestId;
			params = toLegacyExecutionParams(legacyRequest);
		}

		// The first request owns its correlation ID until it settles. A duplicate
		// cannot receive a terminal response without stealing the original caller's.
		if (controllers.has(requestId)) return;
		const ctx = options.getContext();
		if (!ctx) {
			if (versionedRequest) {
				options.events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
					version: SUBAGENT_DELEGATION_PROTOCOL_VERSION,
					requestId,
					status: "unavailable_context",
					error: "No active extension context for delegated subagent execution.",
				} satisfies SubagentDelegationResponse);
			} else if (legacyRequest) {
				options.events.emit(PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT, {
					...legacyRequest,
					messages: [],
					isError: true,
					errorText: "No active extension context for delegated subagent execution.",
				} satisfies PromptTemplateDelegationResponse);
			}
			return;
		}

		const controller = new AbortController();
		controllers.set(requestId, controller);
		if (pendingCancels.delete(requestId)) controller.abort();
		if (controller.signal.aborted) {
			if (versionedRequest) {
				options.events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
					version: SUBAGENT_DELEGATION_PROTOCOL_VERSION,
					requestId,
					status: "cancelled",
				} satisfies SubagentDelegationResponse);
			} else if (legacyRequest) {
				options.events.emit(PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT, {
					...legacyRequest,
					messages: [],
					isError: true,
					errorText: "Delegated prompt cancelled.",
				} satisfies PromptTemplateDelegationResponse);
			}
			controllers.delete(requestId);
			return;
		}

		options.events.emit(
			versionedRequest ? SUBAGENT_DELEGATION_STARTED_EVENT : PROMPT_TEMPLATE_SUBAGENT_STARTED_EVENT,
			versionedRequest
				? { version: SUBAGENT_DELEGATION_PROTOCOL_VERSION, requestId }
				: { requestId },
		);

		try {
			const result = await options.execute(
				requestId,
				params,
				controller.signal,
				ctx,
				(update) => {
					if (!ownsRequest(requestId, controller)) return;
					if (versionedRequest) {
						const payload = toSubagentDelegationUpdate(requestId, update);
						if (payload) options.events.emit(SUBAGENT_DELEGATION_UPDATE_EVENT, payload);
						return;
					}
					const payload = toDelegationUpdate(requestId, update);
					if (payload) options.events.emit(PROMPT_TEMPLATE_SUBAGENT_UPDATE_EVENT, payload);
				},
			);
			if (!ownsRequest(requestId, controller)) return;
			if (versionedRequest) {
				options.events.emit(
					SUBAGENT_DELEGATION_RESPONSE_EVENT,
					toSubagentDelegationResponse(requestId, result, controller.signal.aborted),
				);
			} else if (legacyRequest) {
				options.events.emit(
					PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT,
					controller.signal.aborted
						? { ...legacyRequest, messages: [], isError: true, errorText: "Delegated prompt cancelled." }
						: toPromptTemplateResponse(legacyRequest, result),
				);
			}
		} catch (error) {
			if (!ownsRequest(requestId, controller)) return;
			if (versionedRequest) {
				options.events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
					version: SUBAGENT_DELEGATION_PROTOCOL_VERSION,
					requestId,
					status: controller.signal.aborted ? "cancelled" : "failed",
					...(controller.signal.aborted ? {} : { error: error instanceof Error ? error.message : String(error) }),
				} satisfies SubagentDelegationResponse);
			} else if (legacyRequest) {
				options.events.emit(PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT, {
					...legacyRequest,
					messages: [],
					isError: true,
					errorText: error instanceof Error ? error.message : String(error),
				} satisfies PromptTemplateDelegationResponse);
			}
		} finally {
			if (controllers.get(requestId) === controller) controllers.delete(requestId);
		}
	});

	return {
		cancelAll: () => {
			for (const controller of controllers.values()) controller.abort();
			controllers.clear();
			pendingCancels.clear();
		},
		dispose: () => {
			disposed = true;
			for (const controller of controllers.values()) controller.abort();
			controllers.clear();
			for (const unsubscribe of subscriptions) unsubscribe();
			subscriptions.length = 0;
			pendingCancels.clear();
		},
	};
}
