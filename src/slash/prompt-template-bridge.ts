export const PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT = "prompt-template:subagent:request";
export const PROMPT_TEMPLATE_SUBAGENT_STARTED_EVENT = "prompt-template:subagent:started";
export const PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT = "prompt-template:subagent:response";
export const PROMPT_TEMPLATE_SUBAGENT_UPDATE_EVENT = "prompt-template:subagent:update";
export const PROMPT_TEMPLATE_SUBAGENT_CANCEL_EVENT = "prompt-template:subagent:cancel";

interface PromptTemplateDelegationTask {
	agent: string;
	task: string;
	model?: string;
	cwd?: string;
}

interface PromptTemplateDelegationParallelResult {
	agent: string;
	messages: unknown[];
	isError: boolean;
	errorText?: string;
}

interface PromptTemplateDelegationRequest {
	requestId: string;
	agent: string;
	task: string;
	tasks?: PromptTemplateDelegationTask[];
	context: "fresh" | "fork";
	model: string;
	cwd: string;
	worktree?: boolean;
}

interface PromptTemplateDelegationResponse extends PromptTemplateDelegationRequest {
	messages: unknown[];
	parallelResults?: PromptTemplateDelegationParallelResult[];
	contentText?: string;
	isError: boolean;
	errorText?: string;
}

interface PromptTemplateDelegationTaskProgress {
	index?: number;
	agent: string;
	status?: string;
	currentTool?: string;
	currentToolArgs?: string;
	recentOutput?: string;
	recentOutputLines?: string[];
	recentTools?: Array<{ tool: string; args: string }>;
	model?: string;
	toolCount?: number;
	durationMs?: number;
	tokens?: number;
}

interface PromptTemplateDelegationUpdate {
	requestId: string;
	currentTool?: string;
	currentToolArgs?: string;
	recentOutput?: string;
	recentOutputLines?: string[];
	recentTools?: Array<{ tool: string; args: string }>;
	model?: string;
	toolCount?: number;
	durationMs?: number;
	tokens?: number;
	taskProgress?: PromptTemplateDelegationTaskProgress[];
}

export interface PromptTemplateBridgeEvents {
	on(event: string, handler: (data: unknown) => void): (() => void) | void;
	emit(event: string, data: unknown): void;
}

interface PromptTemplateBridgeResult {
	isError?: boolean;
	content?: unknown;
	details?: {
		results?: Array<{
			agent?: string;
			messages?: unknown[];
			finalOutput?: string;
			toolCalls?: Array<{ text?: string; expandedText?: string }>;
			exitCode?: number;
			error?: string;
			model?: string;
		}>;
		progress?: Array<{
			index?: number;
			agent?: string;
			status?: string;
			currentTool?: string;
			currentToolArgs?: string;
			recentOutput?: string[];
			recentTools?: Array<{ tool?: string; args?: string }>;
			toolCount?: number;
			durationMs?: number;
			tokens?: number;
		}>;
	};
}

interface PromptTemplateBridgeOptions<Ctx extends { cwd?: string }> {
	events: PromptTemplateBridgeEvents;
	getContext: () => Ctx | null;
	execute: (
		requestId: string,
		request: PromptTemplateDelegationRequest,
		signal: AbortSignal,
		ctx: Ctx,
		onUpdate: (result: PromptTemplateBridgeResult) => void,
	) => Promise<PromptTemplateBridgeResult>;
}

function parseDelegationTasks(tasks: unknown): PromptTemplateDelegationTask[] {
	if (!Array.isArray(tasks)) return [];
	const parsed: PromptTemplateDelegationTask[] = [];
	for (const item of tasks) {
		if (!item || typeof item !== "object") return [];
		const value = item as Partial<PromptTemplateDelegationTask>;
		if (typeof value.agent !== "string" || !value.agent.trim()) return [];
		if (typeof value.task !== "string" || !value.task.trim()) return [];
		const model = typeof value.model === "string" && value.model.trim().length > 0 ? value.model : undefined;
		const cwd = typeof value.cwd === "string" && value.cwd.trim().length > 0 ? value.cwd : undefined;
		parsed.push({
			agent: value.agent,
			task: value.task,
			...(model ? { model } : {}),
			...(cwd ? { cwd } : {}),
		});
	}
	return parsed;
}

function parsePromptTemplateRequest(data: unknown): PromptTemplateDelegationRequest | undefined {
	if (!data || typeof data !== "object") return undefined;
	const value = data as Partial<PromptTemplateDelegationRequest> & { tasks?: unknown };
	if (typeof value.requestId !== "string" || !value.requestId) return undefined;
	if (typeof value.model !== "string" || !value.model) return undefined;
	if (typeof value.cwd !== "string" || !value.cwd) return undefined;
	if (value.context !== "fresh" && value.context !== "fork") return undefined;
	const tasks = parseDelegationTasks(value.tasks);
	const worktree = value.worktree === true ? true : undefined;
	const hasSingle =
		typeof value.agent === "string" &&
		value.agent.length > 0 &&
		typeof value.task === "string" &&
		value.task.length > 0;
	if (!hasSingle && tasks.length === 0) return undefined;

	const fallbackTask = tasks[0];
	return {
		requestId: value.requestId,
		agent: hasSingle ? value.agent : fallbackTask!.agent,
		task: hasSingle ? value.task : fallbackTask!.task,
		...(tasks.length > 0 ? { tasks } : {}),
		context: value.context,
		model: value.model,
		cwd: value.cwd,
		...(worktree ? { worktree } : {}),
	};
}

function firstTextContent(content: unknown): string | undefined {
	if (!Array.isArray(content)) return undefined;
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		if ((part as { type?: string }).type !== "text") continue;
		const text = (part as { text?: unknown }).text;
		if (typeof text === "string" && text.trim()) return text.trim();
	}
	return undefined;
}

function filterRecentOutput(lines: string[] | undefined): string[] | undefined {
	if (!lines || lines.length === 0) return undefined;
	const filtered = lines.filter((line) => typeof line === "string" && line.trim() && line.trim() !== "(running...)");
	if (filtered.length === 0) return undefined;
	return filtered;
}

function sanitizeRecentTools(
	tools: Array<{ tool?: string; args?: string }> | undefined,
): Array<{ tool: string; args: string }> | undefined {
	if (!tools || tools.length === 0) return undefined;
	const sanitized = tools.flatMap((entry) => {
		if (typeof entry.tool !== "string" || entry.tool.trim().length === 0) return [];
		return [{
			tool: entry.tool,
			args: typeof entry.args === "string" ? entry.args : String(entry.args ?? ""),
		}];
	});
	return sanitized.length > 0 ? sanitized : undefined;
}

function resolveProgressModel(
	update: PromptTemplateBridgeResult,
	entry: { index?: number; agent?: string },
): string | undefined {
	const results = update.details?.results;
	if (!results || results.length === 0) return undefined;
	if (typeof entry.index === "number" && entry.index >= 0) {
		const byIndex = results[entry.index];
		if (typeof byIndex?.model === "string") return byIndex.model;
	}
	if (entry.agent) {
		const byAgent = results.find((result) => result.agent === entry.agent && typeof result.model === "string");
		if (byAgent?.model) return byAgent.model;
	}
	const firstWithModel = results.find((result) => typeof result.model === "string");
	return firstWithModel?.model;
}

function toolCallNameFromSummary(summary: { text?: string; expandedText?: string }): string | undefined {
	const text = typeof summary.expandedText === "string" && summary.expandedText.trim().length > 0
		? summary.expandedText.trim()
		: typeof summary.text === "string"
			? summary.text.trim()
			: "";
	if (!text) return undefined;
	if (text.startsWith("$ ")) return "bash";
	return text.match(/^[A-Za-z_][\w.-]*/)?.[0];
}

function buildDelegationMessages(
	result: { messages?: unknown[]; finalOutput?: string; toolCalls?: Array<{ text?: string; expandedText?: string }> },
	fallbackText?: string,
): unknown[] {
	if (Array.isArray(result.messages) && result.messages.length > 0) return result.messages;
	const toolCallParts = (result.toolCalls ?? []).flatMap((summary) => {
		const name = toolCallNameFromSummary(summary);
		return name ? [{ type: "toolCall", name, arguments: { summary: summary.expandedText ?? summary.text ?? "" } }] : [];
	});
	const text = typeof result.finalOutput === "string" && result.finalOutput.trim().length > 0
		? result.finalOutput.trim()
		: fallbackText;
	const content = [
		...toolCallParts,
		...(text ? [{ type: "text", text }] : []),
	];
	if (content.length === 0) return [];
	return [{ role: "assistant", content }];
}

function toDelegationUpdate(requestId: string, update: PromptTemplateBridgeResult): PromptTemplateDelegationUpdate | undefined {
	const progress = update.details?.progress?.[0];
	const taskProgress = update.details?.progress?.map((entry) => {
		const lastOutput = entry.recentOutput?.[entry.recentOutput.length - 1];
		const safeLastOutput =
			typeof lastOutput === "string" && lastOutput.trim() && lastOutput !== "(running...)"
				? lastOutput
				: undefined;
		return {
			index: entry.index,
			agent: entry.agent ?? "delegate",
			status: entry.status,
			currentTool: entry.currentTool,
			currentToolArgs: entry.currentToolArgs,
			recentOutput: safeLastOutput,
			recentOutputLines: filterRecentOutput(entry.recentOutput),
			recentTools: sanitizeRecentTools(entry.recentTools),
			model: resolveProgressModel(update, entry),
			toolCount: entry.toolCount,
			durationMs: entry.durationMs,
			tokens: entry.tokens,
		};
	});
	if (!progress && (!taskProgress || taskProgress.length === 0)) return undefined;
	const lastOutput = progress?.recentOutput?.[progress.recentOutput.length - 1];
	const safeLastOutput =
		typeof lastOutput === "string" && lastOutput.trim() && lastOutput !== "(running...)"
			? lastOutput
			: undefined;
	return {
		requestId,
		currentTool: progress?.currentTool,
		currentToolArgs: progress?.currentToolArgs,
		recentOutput: safeLastOutput,
		recentOutputLines: filterRecentOutput(progress?.recentOutput),
		recentTools: sanitizeRecentTools(progress?.recentTools),
		model: progress ? resolveProgressModel(update, progress) : undefined,
		toolCount: progress?.toolCount,
		durationMs: progress?.durationMs,
		tokens: progress?.tokens,
		taskProgress,
	};
}

export function registerPromptTemplateDelegationBridge<Ctx extends { cwd?: string }>(
	options: PromptTemplateBridgeOptions<Ctx>,
): {
	cancelAll: () => void;
	dispose: () => void;
} {
	const controllers = new Map<string, AbortController>();
	const pendingCancels = new Set<string>();
	const subscriptions: Array<() => void> = [];

	const subscribe = (event: string, handler: (data: unknown) => void): void => {
		const unsubscribe = options.events.on(event, handler);
		if (typeof unsubscribe === "function") subscriptions.push(unsubscribe);
	};

	subscribe(PROMPT_TEMPLATE_SUBAGENT_CANCEL_EVENT, (data) => {
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

	subscribe(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, async (data) => {
		const request = parsePromptTemplateRequest(data);
		if (!request) return;

		const ctx = options.getContext();
		if (!ctx) {
			const response: PromptTemplateDelegationResponse = {
				...request,
				messages: [],
				isError: true,
				errorText: "No active extension context for delegated subagent execution.",
			};
			options.events.emit(PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT, response);
			return;
		}

		const controller = new AbortController();
		controllers.set(request.requestId, controller);

		if (pendingCancels.delete(request.requestId)) {
			controller.abort();
			const response: PromptTemplateDelegationResponse = {
				...request,
				messages: [],
				isError: true,
				errorText: "Delegated prompt cancelled.",
			};
			options.events.emit(PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT, response);
			controllers.delete(request.requestId);
			return;
		}

		options.events.emit(PROMPT_TEMPLATE_SUBAGENT_STARTED_EVENT, { requestId: request.requestId });

		try {
			const result = await options.execute(
				request.requestId,
				request,
				controller.signal,
				ctx,
				(update) => {
					const payload = toDelegationUpdate(request.requestId, update);
					if (!payload) return;
					options.events.emit(PROMPT_TEMPLATE_SUBAGENT_UPDATE_EVENT, payload);
				},
			);
			const contentText = firstTextContent(result.content);
			const messages = buildDelegationMessages(result.details?.results?.[0] ?? {}, contentText);
			const parallelResults = request.tasks
				? request.tasks.map<PromptTemplateDelegationParallelResult>((task, index) => {
					const step = result.details?.results?.[index];
					if (!step) {
						return {
							agent: task.agent,
							messages: [],
							isError: true,
							errorText: "Missing result for delegated parallel task.",
						};
					}
					const exitCode = typeof step.exitCode === "number" ? step.exitCode : undefined;
					const errorText = step.error;
					return {
						agent: step.agent ?? task.agent,
						messages: buildDelegationMessages(step),
						isError: (exitCode !== undefined && exitCode !== 0) || !!errorText,
						errorText: errorText || undefined,
					};
				})
				: undefined;
			const response: PromptTemplateDelegationResponse = {
				...request,
				messages,
				...(parallelResults ? { parallelResults } : {}),
				...(contentText ? { contentText } : {}),
				isError: result.isError === true,
				errorText: result.isError ? contentText : undefined,
			};
			options.events.emit(PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT, response);
		} catch (error) {
			const response: PromptTemplateDelegationResponse = {
				...request,
				messages: [],
				isError: true,
				errorText: error instanceof Error ? error.message : String(error),
			};
			options.events.emit(PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT, response);
		} finally {
			controllers.delete(request.requestId);
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
