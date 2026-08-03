import { Agent, type AgentTool, type StreamFn } from "@earendil-works/pi-agent-core";
import { convertToLlm, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { Type, type Static } from "typebox";
import { appendPermissionAudit, permissionArgsPreview } from "../runs/shared/permissions.ts";
import { decodeChildWatchdogConfig } from "./child-status.ts";
import { childResolvedConfig } from "./register-child.ts";
import { resolveWatchdogReviewModel } from "./review.ts";

const PermissionDecisionParams = Type.Object({
	decision: Type.String({ enum: ["approve", "deny"] }),
	reason: Type.String({ description: "One concise reason for this exact decision." }),
}, { additionalProperties: false });

type PermissionDecisionParams = Static<typeof PermissionDecisionParams>;

export interface WatchdogPermissionResult {
	approved: boolean;
	reason: string;
	source: "watchdog";
}

export interface WatchdogPermissionRequest {
	ctx: ExtensionContext;
	toolName: string;
	args: unknown;
	rawWatchdogConfig?: string;
	auditPath?: string;
	signal?: AbortSignal;
}

export interface WatchdogPermissionArbiterOptions {
	streamFn?: StreamFn;
}

function conciseReason(value: string): string {
	const trimmed = value.trim();
	return trimmed ? trimmed.slice(0, 500) : "Watchdog returned an empty reason.";
}

export function createWatchdogPermissionArbiter(options: WatchdogPermissionArbiterOptions = {}) {
	return async (request: WatchdogPermissionRequest): Promise<WatchdogPermissionResult> => {
		const preview = permissionArgsPreview(request.args);
		const createdAt = Date.now();
		const auditBase = { type: "permission.request", createdAt, toolName: request.toolName, preview, matchedRule: "ask", decisionSource: "watchdog" };
		appendPermissionAudit(request.auditPath, auditBase);
		const finish = (approved: boolean, reason: string, decision: string): WatchdogPermissionResult => {
			appendPermissionAudit(request.auditPath, {
				type: "permission.decision",
				createdAt: Date.now(),
				requestCreatedAt: createdAt,
				toolName: request.toolName,
				decision,
				approved,
				decisionSource: "watchdog",
				reason: conciseReason(reason),
			});
			return { approved, reason: conciseReason(reason), source: "watchdog" };
		};

		let childConfig;
		try {
			childConfig = decodeChildWatchdogConfig(request.rawWatchdogConfig);
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			return finish(false, `Watchdog permission arbiter configuration is invalid: ${reason}`, "unavailable");
		}
		if (!childConfig) return finish(false, "Watchdog permission arbiter is unavailable because the child watchdog is disabled.", "unavailable");
		if (request.signal?.aborted || request.ctx.signal?.aborted) return finish(false, "Watchdog permission decision was cancelled.", "cancelled");

		let decision: PermissionDecisionParams | undefined;
		const tool: AgentTool<typeof PermissionDecisionParams, { recorded: boolean }> = {
			name: "watchdog_permission_decision",
			label: "Watchdog permission decision",
			description: "Approve or deny this exact child tool call. Call exactly once.",
			parameters: PermissionDecisionParams,
			executionMode: "sequential",
			async execute(_toolCallId, params) {
				if (!decision) decision = params;
				return { content: [{ type: "text", text: "Permission decision recorded." }], details: { recorded: true } };
			},
		};

		let timeout: ReturnType<typeof setTimeout> | undefined;
		let agent: Agent | undefined;
		try {
			const config = childResolvedConfig(childConfig);
			const selection = await resolveWatchdogReviewModel(request.ctx, config);
			const auth = selection.auth;
			const registeredProvider = (request.ctx.modelRegistry as {
				getRegisteredProviderConfig?: (provider: string) => { api?: string; streamSimple?: StreamFn } | undefined;
			}).getRegisteredProviderConfig?.(selection.model.provider);
			const baseStreamFn = options.streamFn ?? (registeredProvider?.streamSimple && registeredProvider.api === selection.model.api
				? registeredProvider.streamSimple
				: streamSimple);
			const streamFn: StreamFn = (model, context, streamOptions) => baseStreamFn(model, context, {
				...streamOptions,
				...(auth.apiKey ? { apiKey: auth.apiKey } : {}),
				env: auth.env || streamOptions?.env ? { ...(auth.env ?? {}), ...(streamOptions?.env ?? {}) } : undefined,
				headers: { ...(streamOptions?.headers ?? {}), ...(auth.headers ?? {}) },
			});
			agent = new Agent({
				initialState: {
					systemPrompt: [
						"You are the pi-subagents watchdog permission arbiter.",
						"Decide only whether this exact non-bash child tool call should proceed.",
						"Call watchdog_permission_decision exactly once with approve or deny and a concise reason.",
						"Deny when uncertain. Do not produce freeform advice or ask the parent orchestrator.",
					].join("\n"),
					model: selection.model,
					thinkingLevel: selection.thinkingLevel,
					tools: [tool],
				},
				convertToLlm,
				streamFunction: streamFn,
				getApiKey: (providerName) => providerName === selection.model.provider ? auth.apiKey : undefined,
				beforeToolCall: async ({ toolCall }) => toolCall.name === tool.name ? undefined : { block: true, reason: `Permission arbiter tool '${toolCall.name}' is not allowed.` },
				toolExecution: "sequential",
			});
			const abort = () => agent?.abort();
			request.signal?.addEventListener("abort", abort, { once: true });
			request.ctx.signal?.addEventListener("abort", abort, { once: true });
			try {
				const prompt = `Tool: ${request.toolName}\nRedacted arguments: ${preview}`;
				await Promise.race([
					agent.prompt(prompt),
					new Promise<never>((_, reject) => { timeout = setTimeout(() => { agent?.abort(); reject(new Error("Watchdog permission decision timed out.")); }, childConfig.agentEndTimeoutMs); }),
				]);
			} finally {
				request.signal?.removeEventListener("abort", abort);
				request.ctx.signal?.removeEventListener("abort", abort);
			}
			if (!decision) return finish(false, "Watchdog permission arbiter returned no decision.", "malformed");
			const approved = decision.decision === "approve";
			return finish(approved, decision.reason, decision.decision);
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			return finish(false, `Watchdog permission arbiter failed closed: ${reason}`, reason.includes("timed out") ? "timeout" : "error");
		} finally {
			if (timeout) clearTimeout(timeout);
		}
	};
}

export const requestWatchdogPermission = createWatchdogPermissionArbiter();
