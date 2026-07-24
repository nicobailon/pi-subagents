import {
	SUBAGENT_DELEGATION_CANCEL_EVENT,
	SUBAGENT_DELEGATION_PROTOCOL_VERSION,
	SUBAGENT_DELEGATION_V2_PROTOCOL_VERSION,
	SUBAGENT_DELEGATION_REQUEST_EVENT,
	SUBAGENT_DELEGATION_RESPONSE_EVENT,
	SUBAGENT_DELEGATION_STARTED_EVENT,
	SUBAGENT_DELEGATION_UPDATE_EVENT,
	type SubagentDelegationRequest,
	type SubagentDelegationResponse,
	type SubagentDelegationV2InvalidResponse,
	type SubagentDelegationV2Request,
	type SubagentDelegationV2Response,
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
	toSubagentDelegationV2ExecutionParams,
	toSubagentDelegationV2Response,
	toSubagentDelegationV2Update,
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
	/**
	 * Concurrent-safe executor for strict versioned delegation requests.
	 * Non-versioned prompt-template requests retain the ordinary single-dispatch guard.
	 */
	executeVersioned?: (
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
	// Legacy and V1 retain requestId-only correlation. V2 attempts are isolated by
	// their complete wire identity, while logical-node ownership is tracked separately.
	const controllers = new Map<string, AbortController>();
	const pendingCancels = new Map<string, true>();
	const v2Controllers = new Map<string, AbortController>();
	const pendingV2Cancels = new Map<string, true>();
	const activeV2Nodes = new Map<string, { attemptKey: string; controller: AbortController }>();
	const settledV2Attempts = new Map<string, true>();
	const subscriptions: Array<() => void> = [];
	let disposed = false;
	let v2IdentitySaturated = false;

	const subscribe = (event: string, handler: (data: unknown) => void): void => {
		const unsubscribe = options.events.on(event, handler);
		if (typeof unsubscribe === "function") subscriptions.push(unsubscribe);
	};
	const ownsRequest = (requestId: string, controller: AbortController): boolean =>
		!disposed && controllers.get(requestId) === controller;
	const ownsV2Attempt = (attemptKey: string, controller: AbortController): boolean =>
		!disposed && v2Controllers.get(attemptKey) === controller;
	const boundedRemember = (map: Map<string, true>, key: string): void => {
		map.delete(key);
		map.set(key, true);
		while (map.size > 256) {
			const oldest = map.keys().next().value;
			if (typeof oldest !== "string") break;
			map.delete(oldest);
		}
	};
	const rememberV2Identity = (map: Map<string, true>, key: string): void => {
		if (map.has(key) || v2IdentitySaturated) return;
		if (map.size >= 8_192) {
			v2IdentitySaturated = true;
			return;
		}
		map.set(key, true);
		if (map.size === 8_192) {
			// V2 identity facts are security state, not an LRU cache. Saturate as
			// soon as the bounded history fills so no later untracked attempt can
			// start, rather than evicting a cancellation or settled-attempt fact.
			v2IdentitySaturated = true;
		}
	};
	const v2NodeKey = (ownerRunId: string, nodeId: string): string => JSON.stringify([ownerRunId, nodeId]);
	const v2AttemptKey = (requestId: string, ownerRunId: string, nodeId: string): string => JSON.stringify([requestId, ownerRunId, nodeId]);
	const rememberPendingCancel = (requestId: string): void => {
		boundedRemember(pendingCancels, requestId);
	};
	const emitV2Terminal = (attemptKey: string, payload: SubagentDelegationV2Response): void => {
		if (disposed || settledV2Attempts.has(attemptKey)) return;
		rememberV2Identity(settledV2Attempts, attemptKey);
		options.events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, payload);
	};

	subscribe(PROMPT_TEMPLATE_SUBAGENT_CANCEL_EVENT, (data) => {
		if (!data || typeof data !== "object" || Array.isArray(data)) return;
		const value = data as Record<string, unknown>;
		const requestId = value.requestId;
		if (typeof requestId !== "string" || !requestId.trim() || requestId.length > 256 || /[\r\n]/.test(requestId)) return;
		if (Object.hasOwn(value, "version")) {
			if (value.version === SUBAGENT_DELEGATION_V2_PROTOCOL_VERSION) {
				if (Object.keys(value).some((key) => key !== "version" && key !== "requestId" && key !== "ownerRunId" && key !== "nodeId")) return;
				const ownerRunId = value.ownerRunId;
				const nodeId = value.nodeId;
				if (typeof ownerRunId !== "string" || !ownerRunId.trim() || ownerRunId.length > 256 || /[\r\n]/.test(ownerRunId)) return;
				if (typeof nodeId !== "string" || !nodeId.trim() || nodeId.length > 256 || /[\r\n]/.test(nodeId)) return;
				const attemptKey = v2AttemptKey(requestId, ownerRunId, nodeId);
				const controller = v2Controllers.get(attemptKey);
				if (controller) controller.abort();
				else rememberV2Identity(pendingV2Cancels, attemptKey);
				return;
			}
			if (value.version !== SUBAGENT_DELEGATION_PROTOCOL_VERSION) return;
			if (Object.keys(value).some((key) => key !== "version" && key !== "requestId")) return;
		}
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
		let versionedRequest: SubagentDelegationRequest | SubagentDelegationV2Request | undefined;
		let v2Request: SubagentDelegationV2Request | undefined;
		let v2Key: string | undefined;
		let legacyRequest: PromptTemplateDelegationRequest | undefined;

		if (isVersioned) {
			const parsed = parseSubagentDelegationRequest(data);
			if (parsed.ok === false) {
				if (!disposed && parsed.requestId) {
					if (parsed.version === SUBAGENT_DELEGATION_V2_PROTOCOL_VERSION) {
						const payload = {
							version: SUBAGENT_DELEGATION_V2_PROTOCOL_VERSION,
							requestId: parsed.requestId,
							...(parsed.ownerRunId ? { ownerRunId: parsed.ownerRunId } : {}),
							...(parsed.nodeId ? { nodeId: parsed.nodeId } : {}),
							status: "invalid_request",
							error: parsed.error,
						} satisfies SubagentDelegationV2InvalidResponse;
						if (parsed.ownerRunId && parsed.nodeId) {
							const attemptKey = v2AttemptKey(parsed.requestId, parsed.ownerRunId, parsed.nodeId);
							if (!v2Controllers.has(attemptKey)) emitV2Terminal(attemptKey, payload);
						} else {
							options.events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, payload);
						}
					} else if (!controllers.has(parsed.requestId)) {
						options.events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
							version: SUBAGENT_DELEGATION_PROTOCOL_VERSION,
							requestId: parsed.requestId,
							status: "invalid_request",
							error: parsed.error,
						} satisfies SubagentDelegationResponse);
					}
				}
				return;
			}
			versionedRequest = parsed.request;
			requestId = parsed.request.requestId;
			if (parsed.request.version === SUBAGENT_DELEGATION_V2_PROTOCOL_VERSION) {
				v2Request = parsed.request;
				v2Key = v2AttemptKey(requestId, parsed.request.ownerRunId, parsed.request.nodeId);
				params = toSubagentDelegationV2ExecutionParams(parsed.request);
			} else {
				params = toSubagentDelegationExecutionParams(parsed.request);
			}
		} else {
			legacyRequest = parsePromptTemplateRequest(data);
			if (!legacyRequest) return;
			requestId = legacyRequest.requestId;
			params = toLegacyExecutionParams(legacyRequest);
		}

		// Legacy and V1 keep requestId-only ownership. V2 retransmission and terminal
		// suppression use the full tuple, independently from logical-node ownership.
		if (!v2Request && controllers.has(requestId)) return;
		if (v2Request && v2Key) {
			if (v2Controllers.has(v2Key) || settledV2Attempts.has(v2Key)) return;
			if (pendingV2Cancels.delete(v2Key)) {
				emitV2Terminal(v2Key, {
					version: SUBAGENT_DELEGATION_V2_PROTOCOL_VERSION,
					requestId,
					ownerRunId: v2Request.ownerRunId,
					nodeId: v2Request.nodeId,
					status: "cancelled",
				});
				return;
			}
			if (v2IdentitySaturated) {
				options.events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
					version: SUBAGENT_DELEGATION_V2_PROTOCOL_VERSION,
					requestId,
					ownerRunId: v2Request.ownerRunId,
					nodeId: v2Request.nodeId,
					status: "unavailable_context",
					error: "Delegation v2 identity capacity is exhausted for this extension context.",
				} satisfies SubagentDelegationV2Response);
				return;
			}
			const active = activeV2Nodes.get(v2NodeKey(v2Request.ownerRunId, v2Request.nodeId));
			if (active) {
				emitV2Terminal(v2Key, {
					version: SUBAGENT_DELEGATION_V2_PROTOCOL_VERSION,
					requestId,
					ownerRunId: v2Request.ownerRunId,
					nodeId: v2Request.nodeId,
					status: "duplicate_node",
				});
				return;
			}
		}
		const ctx = options.getContext();
		if (!ctx) {
			if (v2Request && v2Key) {
				emitV2Terminal(v2Key, {
					version: SUBAGENT_DELEGATION_V2_PROTOCOL_VERSION,
					requestId,
					ownerRunId: v2Request.ownerRunId,
					nodeId: v2Request.nodeId,
					status: "unavailable_context",
					error: "No active extension context for delegated subagent execution.",
				});
			} else if (versionedRequest) {
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
		if (v2Request && v2Key) {
			v2Controllers.set(v2Key, controller);
			activeV2Nodes.set(v2NodeKey(v2Request.ownerRunId, v2Request.nodeId), { attemptKey: v2Key, controller });
		} else {
			controllers.set(requestId, controller);
			if (pendingCancels.delete(requestId)) controller.abort();
		}
		if (controller.signal.aborted) {
			if (v2Request && v2Key) {
				emitV2Terminal(v2Key, {
					version: SUBAGENT_DELEGATION_V2_PROTOCOL_VERSION,
					requestId,
					ownerRunId: v2Request.ownerRunId,
					nodeId: v2Request.nodeId,
					status: "cancelled",
				});
				activeV2Nodes.delete(v2NodeKey(v2Request.ownerRunId, v2Request.nodeId));
			} else if (versionedRequest) {
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
			if (v2Key) v2Controllers.delete(v2Key);
			else controllers.delete(requestId);
			return;
		}

		options.events.emit(
			versionedRequest ? SUBAGENT_DELEGATION_STARTED_EVENT : PROMPT_TEMPLATE_SUBAGENT_STARTED_EVENT,
			v2Request
				? { version: SUBAGENT_DELEGATION_V2_PROTOCOL_VERSION, requestId, ownerRunId: v2Request.ownerRunId, nodeId: v2Request.nodeId }
				: versionedRequest
					? { version: SUBAGENT_DELEGATION_PROTOCOL_VERSION, requestId }
					: { requestId },
		);

		try {
			const executeRequest = versionedRequest && options.executeVersioned
				? options.executeVersioned
				: options.execute;
			const result = await executeRequest(
				requestId,
				params,
				controller.signal,
				ctx,
				(update) => {
					if (v2Key ? !ownsV2Attempt(v2Key, controller) : !ownsRequest(requestId, controller)) return;
					if (v2Request) {
						const payload = toSubagentDelegationV2Update(v2Request, update);
						if (payload) options.events.emit(SUBAGENT_DELEGATION_UPDATE_EVENT, payload);
						return;
					}
					if (versionedRequest) {
						const payload = toSubagentDelegationUpdate(requestId, update);
						if (payload) options.events.emit(SUBAGENT_DELEGATION_UPDATE_EVENT, payload);
						return;
					}
					const payload = toDelegationUpdate(requestId, update);
					if (payload) options.events.emit(PROMPT_TEMPLATE_SUBAGENT_UPDATE_EVENT, payload);
				},
			);
			if (v2Key ? !ownsV2Attempt(v2Key, controller) : !ownsRequest(requestId, controller)) return;
			if (v2Request && v2Key) {
				emitV2Terminal(v2Key, toSubagentDelegationV2Response(v2Request, result, controller.signal.aborted));
			} else if (versionedRequest) {
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
			if (v2Key ? !ownsV2Attempt(v2Key, controller) : !ownsRequest(requestId, controller)) return;
			if (v2Request && v2Key) {
				emitV2Terminal(v2Key, {
					version: SUBAGENT_DELEGATION_V2_PROTOCOL_VERSION,
					requestId,
					ownerRunId: v2Request.ownerRunId,
					nodeId: v2Request.nodeId,
					status: controller.signal.aborted ? "cancelled" : "failed",
					...(controller.signal.aborted ? {} : { error: error instanceof Error ? error.message : String(error) }),
				});
			} else if (versionedRequest) {
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
			if (v2Key) {
				if (v2Controllers.get(v2Key) === controller) v2Controllers.delete(v2Key);
			} else if (controllers.get(requestId) === controller) controllers.delete(requestId);
			if (v2Request) {
				const key = v2NodeKey(v2Request.ownerRunId, v2Request.nodeId);
				if (activeV2Nodes.get(key)?.controller === controller) activeV2Nodes.delete(key);
			}
		}
	});

	return {
		cancelAll: () => {
			for (const controller of controllers.values()) controller.abort();
			for (const controller of v2Controllers.values()) controller.abort();
			controllers.clear();
			v2Controllers.clear();
			pendingCancels.clear();
			pendingV2Cancels.clear();
			activeV2Nodes.clear();
			settledV2Attempts.clear();
			v2IdentitySaturated = false;
		},
		dispose: () => {
			disposed = true;
			for (const controller of controllers.values()) controller.abort();
			for (const controller of v2Controllers.values()) controller.abort();
			controllers.clear();
			v2Controllers.clear();
			for (const unsubscribe of subscriptions) unsubscribe();
			subscriptions.length = 0;
			pendingCancels.clear();
			pendingV2Cancels.clear();
			activeV2Nodes.clear();
			settledV2Attempts.clear();
		},
	};
}
