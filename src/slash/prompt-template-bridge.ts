import {
	SUBAGENT_DELEGATION_CANCEL_EVENT,
	SUBAGENT_DELEGATION_REQUEST_EVENT,
	SUBAGENT_DELEGATION_RESPONSE_EVENT,
	SUBAGENT_DELEGATION_STARTED_EVENT,
	SUBAGENT_DELEGATION_UPDATE_EVENT,
	type SubagentDelegationInvalidResponse,
	type SubagentDelegationRequest,
	type SubagentDelegationResponse,
	type SubagentDelegationUpdate,
} from "../api/delegation.ts";
import { parseSubagentDelegationRequest } from "./delegation-request.ts";
import {
	parsePromptTemplateRequest,
	toDelegationUpdate,
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
	/** Concurrent-safe executor for structured delegation requests. */
	executeStructured?: (
		requestId: string,
		params: DelegatedSubagentExecutionParams,
		signal: AbortSignal,
		ctx: Ctx,
		onUpdate: (result: PromptTemplateBridgeResult) => void,
	) => Promise<PromptTemplateBridgeResult>;
}

function hasStructuredDelegationMarker(data: unknown): boolean {
	if (!data || typeof data !== "object" || Array.isArray(data)) return false;
	const value = data as Record<string, unknown>;
	return Object.hasOwn(value, "ownerRunId")
		|| Object.hasOwn(value, "nodeId")
		|| Object.hasOwn(value, "result")
		|| Object.hasOwn(value, "version");
}

function validId(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0 && value.length <= 256 && !/[\r\n]/.test(value);
}

function sameStringArray(left: string[] | undefined, right: string[] | undefined): boolean {
	if (left === right) return true;
	if (!left || !right || left.length !== right.length) return false;
	return left.every((value, index) => value === right[index]);
}

function sameRecentTools(
	left: Array<{ tool: string; args: string }> | undefined,
	right: Array<{ tool: string; args: string }> | undefined,
): boolean {
	if (left === right) return true;
	if (!left || !right || left.length !== right.length) return false;
	return left.every((tool, index) => tool.tool === right[index]?.tool && tool.args === right[index]?.args);
}

/** Duration is a heartbeat clock, not delegation-visible progress; terminal usage remains authoritative. */
function sameStructuredDelegationUpdateProgress(left: SubagentDelegationUpdate, right: SubagentDelegationUpdate): boolean {
	return left.requestId === right.requestId
		&& left.ownerRunId === right.ownerRunId
		&& left.nodeId === right.nodeId
		&& left.runId === right.runId
		&& left.currentTool === right.currentTool
		&& left.currentToolArgs === right.currentToolArgs
		&& left.recentOutput === right.recentOutput
		&& sameStringArray(left.recentOutputLines, right.recentOutputLines)
		&& sameRecentTools(left.recentTools, right.recentTools)
		&& left.model === right.model
		&& left.toolCount === right.toolCount
		&& left.tokens === right.tokens;
}

export function registerPromptTemplateDelegationBridge<Ctx extends { cwd?: string }>(
	options: PromptTemplateBridgeOptions<Ctx>,
): {
	cancelAll: () => void;
	dispose: () => void;
} {
	const legacyControllers = new Map<string, AbortController>();
	const pendingLegacyCancels = new Map<string, true>();
	const attemptControllers = new Map<string, AbortController>();
	const pendingAttemptCancels = new Map<string, true>();
	const activeOwnedNodes = new Map<string, { attemptKey: string; controller: AbortController }>();
	const settledAttempts = new Map<string, true>();
	const subscriptions: Array<() => void> = [];
	let disposed = false;
	let identitySaturated = false;

	const subscribe = (event: string, handler: (data: unknown) => void): void => {
		const unsubscribe = options.events.on(event, handler);
		if (typeof unsubscribe === "function") subscriptions.push(unsubscribe);
	};
	const ownsLegacyRequest = (requestId: string, controller: AbortController): boolean =>
		!disposed && legacyControllers.get(requestId) === controller;
	const ownsAttempt = (attemptKey: string, controller: AbortController): boolean =>
		!disposed && attemptControllers.get(attemptKey) === controller;
	const boundedRemember = (map: Map<string, true>, key: string): void => {
		map.delete(key);
		map.set(key, true);
		while (map.size > 256) {
			const oldest = map.keys().next().value;
			if (typeof oldest !== "string") break;
			map.delete(oldest);
		}
	};
	const rememberIdentity = (map: Map<string, true>, key: string): void => {
		if (map.has(key) || identitySaturated) return;
		if (map.size >= 8_192) {
			identitySaturated = true;
			return;
		}
		map.set(key, true);
		if (map.size === 8_192) {
			// Exact cancellation and terminal-attempt facts are security state, not an
			// LRU cache. Once full, fail closed rather than evicting identity facts.
			identitySaturated = true;
		}
	};
	const nodeKey = (ownerRunId: string, nodeId: string): string => JSON.stringify([ownerRunId, nodeId]);
	const attemptKey = (requestId: string, ownerRunId: string, nodeId: string): string => JSON.stringify([requestId, ownerRunId, nodeId]);
	const rememberPendingLegacyCancel = (requestId: string): void => {
		boundedRemember(pendingLegacyCancels, requestId);
	};
	const emitTerminal = (key: string, payload: SubagentDelegationResponse): void => {
		if (disposed || settledAttempts.has(key)) return;
		rememberIdentity(settledAttempts, key);
		options.events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, payload);
	};

	subscribe(PROMPT_TEMPLATE_SUBAGENT_CANCEL_EVENT, (data) => {
		if (!data || typeof data !== "object" || Array.isArray(data)) return;
		const value = data as Record<string, unknown>;
		const requestId = value.requestId;
		if (!validId(requestId)) return;
		if (hasStructuredDelegationMarker(data)) {
			if (Object.keys(value).some((key) => key !== "requestId" && key !== "ownerRunId" && key !== "nodeId")) return;
			const ownerRunId = value.ownerRunId;
			const nodeId = value.nodeId;
			if (!validId(ownerRunId) || !validId(nodeId)) return;
			const key = attemptKey(requestId, ownerRunId, nodeId);
			const controller = attemptControllers.get(key);
			if (controller) controller.abort();
			else rememberIdentity(pendingAttemptCancels, key);
			return;
		}
		const controller = legacyControllers.get(requestId);
		if (controller) {
			controller.abort();
			return;
		}
		rememberPendingLegacyCancel(requestId);
	});

	subscribe(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, async (data) => {
		const structuredPayload = hasStructuredDelegationMarker(data);
		let requestId: string;
		let params: DelegatedSubagentExecutionParams;
		let structuredRequest: SubagentDelegationRequest | undefined;
		let key: string | undefined;
		let legacyRequest: PromptTemplateDelegationRequest | undefined;

		if (structuredPayload) {
			const parsed = parseSubagentDelegationRequest(data);
			if (parsed.ok === false) {
				if (!disposed && parsed.requestId) {
					const payload = {
						requestId: parsed.requestId,
						...(parsed.ownerRunId ? { ownerRunId: parsed.ownerRunId } : {}),
						...(parsed.nodeId ? { nodeId: parsed.nodeId } : {}),
						status: "invalid_request",
						error: parsed.error,
					} satisfies SubagentDelegationInvalidResponse;
					if (parsed.ownerRunId && parsed.nodeId) {
						const attemptedKey = attemptKey(parsed.requestId, parsed.ownerRunId, parsed.nodeId);
						if (!attemptControllers.has(attemptedKey)) emitTerminal(attemptedKey, payload);
					} else {
						options.events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, payload);
					}
				}
				return;
			}
			structuredRequest = parsed.request;
			requestId = parsed.request.requestId;
			key = attemptKey(requestId, parsed.request.ownerRunId, parsed.request.nodeId);
			params = toSubagentDelegationExecutionParams(parsed.request);
		} else {
			if (data && typeof data === "object" && !Array.isArray(data)) {
				const legacy = data as Record<string, unknown>;
				if ((legacy.tasks !== undefined || legacy.worktree !== undefined) && typeof legacy.requestId === "string" && legacy.requestId) {
					options.events.emit(PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT, {
						requestId: legacy.requestId,
						messages: [],
						isError: true,
						errorText: "Legacy prompt-template tasks/worktree orchestration was removed; use workflowScript.",
					});
					return;
				}
			}
			legacyRequest = parsePromptTemplateRequest(data);
			if (!legacyRequest) return;
			options.events.emit(PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT, {
				...legacyRequest,
				messages: [],
				isError: true,
				errorText: "Legacy prompt-template direct delegation was removed; use workflowScript through the subagent tool or structured delegation.",
			} satisfies PromptTemplateDelegationResponse);
			return;
		}

		if (!structuredRequest && legacyControllers.has(requestId)) return;
		if (structuredRequest && key) {
			if (attemptControllers.has(key) || settledAttempts.has(key)) return;
			if (pendingAttemptCancels.delete(key)) {
				emitTerminal(key, {
					requestId,
					ownerRunId: structuredRequest.ownerRunId,
					nodeId: structuredRequest.nodeId,
					status: "cancelled",
				});
				return;
			}
			if (identitySaturated) {
				options.events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
					requestId,
					ownerRunId: structuredRequest.ownerRunId,
					nodeId: structuredRequest.nodeId,
					status: "unavailable_context",
					error: "Delegation identity capacity is exhausted for this extension context.",
				} satisfies SubagentDelegationResponse);
				return;
			}
			const active = activeOwnedNodes.get(nodeKey(structuredRequest.ownerRunId, structuredRequest.nodeId));
			if (active) {
				emitTerminal(key, {
					requestId,
					ownerRunId: structuredRequest.ownerRunId,
					nodeId: structuredRequest.nodeId,
					status: "duplicate_node",
				});
				return;
			}
		}
		const ctx = options.getContext();
		if (!ctx) {
			if (structuredRequest && key) {
				emitTerminal(key, {
					requestId,
					ownerRunId: structuredRequest.ownerRunId,
					nodeId: structuredRequest.nodeId,
					status: "unavailable_context",
					error: "No active extension context for delegated subagent execution.",
				});
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
		if (structuredRequest && key) {
			attemptControllers.set(key, controller);
			activeOwnedNodes.set(nodeKey(structuredRequest.ownerRunId, structuredRequest.nodeId), { attemptKey: key, controller });
		} else {
			legacyControllers.set(requestId, controller);
			if (pendingLegacyCancels.delete(requestId)) controller.abort();
		}
		if (controller.signal.aborted) {
			if (structuredRequest && key) {
				emitTerminal(key, {
					requestId,
					ownerRunId: structuredRequest.ownerRunId,
					nodeId: structuredRequest.nodeId,
					status: "cancelled",
				});
				activeOwnedNodes.delete(nodeKey(structuredRequest.ownerRunId, structuredRequest.nodeId));
			} else if (legacyRequest) {
				options.events.emit(PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT, {
					...legacyRequest,
					messages: [],
					isError: true,
					errorText: "Delegated prompt cancelled.",
				} satisfies PromptTemplateDelegationResponse);
			}
			if (key) attemptControllers.delete(key);
			else legacyControllers.delete(requestId);
			return;
		}

		options.events.emit(
			structuredRequest ? SUBAGENT_DELEGATION_STARTED_EVENT : PROMPT_TEMPLATE_SUBAGENT_STARTED_EVENT,
			structuredRequest
				? { requestId, ownerRunId: structuredRequest.ownerRunId, nodeId: structuredRequest.nodeId }
				: { requestId },
		);

		try {
			const executeRequest = structuredRequest && options.executeStructured
				? options.executeStructured
				: options.execute;
			let lastStructuredUpdate: SubagentDelegationUpdate | undefined;
			const result = await executeRequest(
				requestId,
				params,
				controller.signal,
				ctx,
				(update) => {
					if (key ? !ownsAttempt(key, controller) : !ownsLegacyRequest(requestId, controller)) return;
					if (structuredRequest) {
						const payload = toSubagentDelegationUpdate(structuredRequest, update);
						if (payload && (!lastStructuredUpdate || !sameStructuredDelegationUpdateProgress(lastStructuredUpdate, payload))) {
							lastStructuredUpdate = payload;
							options.events.emit(SUBAGENT_DELEGATION_UPDATE_EVENT, payload);
						}
						return;
					}
					const payload = toDelegationUpdate(requestId, update);
					if (payload) options.events.emit(PROMPT_TEMPLATE_SUBAGENT_UPDATE_EVENT, payload);
				},
			);
			if (key ? !ownsAttempt(key, controller) : !ownsLegacyRequest(requestId, controller)) return;
			if (structuredRequest && key) {
				emitTerminal(key, toSubagentDelegationResponse(structuredRequest, result, controller.signal.aborted));
			} else if (legacyRequest) {
				options.events.emit(
					PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT,
					controller.signal.aborted
						? { ...legacyRequest, messages: [], isError: true, errorText: "Delegated prompt cancelled." }
						: toPromptTemplateResponse(legacyRequest, result),
				);
			}
		} catch (error) {
			if (key ? !ownsAttempt(key, controller) : !ownsLegacyRequest(requestId, controller)) return;
			if (structuredRequest && key) {
				emitTerminal(key, {
					requestId,
					ownerRunId: structuredRequest.ownerRunId,
					nodeId: structuredRequest.nodeId,
					status: controller.signal.aborted ? "cancelled" : "failed",
					...(controller.signal.aborted ? {} : { error: error instanceof Error ? error.message : String(error) }),
				});
			} else if (legacyRequest) {
				options.events.emit(PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT, {
					...legacyRequest,
					messages: [],
					isError: true,
					errorText: error instanceof Error ? error.message : String(error),
				} satisfies PromptTemplateDelegationResponse);
			}
		} finally {
			if (key) {
				if (attemptControllers.get(key) === controller) attemptControllers.delete(key);
			} else if (legacyControllers.get(requestId) === controller) legacyControllers.delete(requestId);
			if (structuredRequest) {
				const ownedNodeKey = nodeKey(structuredRequest.ownerRunId, structuredRequest.nodeId);
				if (activeOwnedNodes.get(ownedNodeKey)?.controller === controller) activeOwnedNodes.delete(ownedNodeKey);
			}
		}
	});

	return {
		cancelAll: () => {
			for (const controller of legacyControllers.values()) controller.abort();
			for (const controller of attemptControllers.values()) controller.abort();
			legacyControllers.clear();
			attemptControllers.clear();
			pendingLegacyCancels.clear();
			pendingAttemptCancels.clear();
			activeOwnedNodes.clear();
			settledAttempts.clear();
			identitySaturated = false;
		},
		dispose: () => {
			disposed = true;
			for (const controller of legacyControllers.values()) controller.abort();
			for (const controller of attemptControllers.values()) controller.abort();
			legacyControllers.clear();
			attemptControllers.clear();
			for (const unsubscribe of subscriptions) unsubscribe();
			subscriptions.length = 0;
			pendingLegacyCancels.clear();
			pendingAttemptCancels.clear();
			activeOwnedNodes.clear();
			settledAttempts.clear();
		},
	};
}
