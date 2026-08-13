import { Agent, type StreamFn, type ThinkingLevel } from "@earendil-works/pi-agent-core";
import { convertToLlm, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import type { Model, ProviderHeaders } from "@earendil-works/pi-ai";
import { agentStreamOptions } from "../../shared/agent-stream-options.ts";
import type { ForegroundRunControl } from "../../shared/types.ts";
export type PromptAuditView = "authored" | "runtime" | "effective";

export interface PromptAuditRerunContract {
	params: Record<string, unknown>;
}

export interface LivePromptAudit {
	authoredTask: string;
	runtimeAdditions: string;
	finalEffectivePrompt: string;
	cwd?: string;
	outputPath?: string;
	rerun?: PromptAuditRerunContract;
}

const livePrompts = new WeakMap<ForegroundRunControl, Map<number, LivePromptAudit>>();

type RegistryModel = Model<any>;

function fullModelId(model: Pick<RegistryModel, "provider" | "id">): string {
	return `${model.provider}/${model.id}`;
}

function textContent(value: unknown): string {
	if (typeof value === "string") return value;
	if (!Array.isArray(value)) return "";
	return value.map((item) => item && typeof item === "object" && (item as { type?: unknown }).type === "text" ? String((item as { text?: unknown }).text ?? "") : "").join("");
}

function finalAssistantText(agent: Agent): string {
	for (let index = agent.state.messages.length - 1; index >= 0; index--) {
		const message = agent.state.messages[index];
		if (message && typeof message === "object" && (message as { role?: unknown }).role === "assistant") {
			return textContent((message as { content?: unknown }).content).trim();
		}
	}
	return "";
}

async function resolveRewriteAuth(ctx: ExtensionContext, model: RegistryModel): Promise<{ apiKey?: string; headers?: ProviderHeaders; env?: Record<string, string> }> {
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (auth.ok === false) throw new Error(`Prompt redo model auth failed for ${fullModelId(model)}: ${auth.error}`);
	return {
		...(auth.apiKey ? { apiKey: auth.apiKey } : {}),
		...(auth.headers ? { headers: auth.headers } : {}),
		...(auth.env ? { env: auth.env } : {}),
	};
}

export async function rewritePromptWithGuidance(input: {
	ctx: ExtensionContext;
	authoredTask: string;
	runtimeAdditions: string;
	finalEffectivePrompt: string;
	guidance: string;
	signal?: AbortSignal;
	streamFn?: StreamFn;
}): Promise<string> {
	const model = input.ctx.model;
	if (!model) throw new Error("Prompt redo needs the current session model to rewrite the authored task.");
	const auth = await resolveRewriteAuth(input.ctx, model);
	const registeredProvider = (input.ctx.modelRegistry as {
		getRegisteredProviderConfig?: (provider: string) => { api?: string; streamSimple?: StreamFn } | undefined;
	}).getRegisteredProviderConfig?.(model.provider);
	const baseStreamFn = input.streamFn ?? (registeredProvider?.streamSimple && registeredProvider.api === model.api
		? registeredProvider.streamSimple
		: streamSimple);
	const streamFn: StreamFn = (nextModel, context, streamOptions) => baseStreamFn(nextModel, context, {
		...streamOptions,
		...(auth.apiKey ? { apiKey: auth.apiKey } : {}),
		env: auth.env || streamOptions?.env ? { ...(auth.env ?? {}), ...(streamOptions?.env ?? {}) } : undefined,
		headers: { ...(streamOptions?.headers ?? {}), ...(auth.headers ?? {}) },
	});
	const ctxThinking = (input.ctx as { getThinkingLevel?: () => ThinkingLevel }).getThinkingLevel?.();
	const agent = new Agent({
		initialState: {
			systemPrompt: [
				"Rewrite one subagent authored task from Prompt Audit context.",
				"Return only the revised authored task text.",
				"Do not add Markdown fences, explanations, labels, or commentary.",
				"Preserve the original intent unless the guidance explicitly changes it.",
				"Do not include runtime additions unless they are needed as ordinary task context.",
			].join("\n"),
			model,
			thinkingLevel: ctxThinking ?? "off",
			tools: [],
		},
		convertToLlm,
		...agentStreamOptions(streamFn),
		getApiKey: (providerName) => providerName === model.provider ? auth.apiKey : undefined,
		toolExecution: "sequential",
	});
	const abort = () => agent.abort();
	input.ctx.signal?.addEventListener("abort", abort, { once: true });
	input.signal?.addEventListener("abort", abort, { once: true });
	try {
		await agent.prompt([
			"Guidance from the human:",
			input.guidance.trim(),
			"",
			"Authored task:",
			input.authoredTask,
			"",
			"Runtime additions for context only:",
			input.runtimeAdditions,
			"",
			"Final effective prompt for context only:",
			input.finalEffectivePrompt,
		].join("\n"));
	} finally {
		input.ctx.signal?.removeEventListener("abort", abort);
		input.signal?.removeEventListener("abort", abort);
	}
	const rewritten = finalAssistantText(agent);
	if (!rewritten) throw new Error("Prompt redo rewrite returned an empty prompt.");
	return rewritten;
}

function runtimeAdditions(authoredTask: string, effectivePrompt: string): string {
	if (!authoredTask) return effectivePrompt;
	const authoredIndex = effectivePrompt.indexOf(authoredTask);
	if (authoredIndex < 0) return "(runtime additions unavailable)";
	const before = effectivePrompt.slice(0, authoredIndex).trim();
	const after = effectivePrompt.slice(authoredIndex + authoredTask.length).trim();
	return [before, after].filter(Boolean).join("\n\n") || "(none)";
}

export function registerLivePromptAudit(
	control: ForegroundRunControl,
	index: number,
	authoredTask: string,
	effectivePrompt: string,
	metadata: { cwd?: string; outputPath?: string; rerun?: PromptAuditRerunContract } = {},
): void {
	let prompts = livePrompts.get(control);
	if (!prompts) {
		prompts = new Map();
		livePrompts.set(control, prompts);
	}
	prompts.set(index, {
		authoredTask,
		runtimeAdditions: runtimeAdditions(authoredTask, effectivePrompt),
		finalEffectivePrompt: effectivePrompt,
		...(metadata.cwd ? { cwd: metadata.cwd } : {}),
		...(metadata.outputPath ? { outputPath: metadata.outputPath } : {}),
		...(metadata.rerun ? { rerun: metadata.rerun } : {}),
	});
}

export function updateLiveEffectivePrompt(control: ForegroundRunControl, index: number, effectivePrompt: string): void {
	const prompt = livePrompts.get(control)?.get(index);
	if (!prompt) return;
	prompt.finalEffectivePrompt = effectivePrompt;
	prompt.runtimeAdditions = runtimeAdditions(prompt.authoredTask, effectivePrompt);
}

export function getLivePromptAudit(control: ForegroundRunControl, index: number): LivePromptAudit | undefined {
	return livePrompts.get(control)?.get(index);
}

export function removeLivePromptAudit(control: ForegroundRunControl, index: number): void {
	const prompts = livePrompts.get(control);
	if (!prompts) return;
	prompts.delete(index);
	if (prompts.size === 0) livePrompts.delete(control);
}
