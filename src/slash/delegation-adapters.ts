import {
	SUBAGENT_DELEGATION_PROTOCOL_VERSION,
	type SubagentDelegationAcceptanceResult,
	type SubagentDelegationRequest,
	type SubagentDelegationResponse,
	type SubagentDelegationStatus,
	type SubagentDelegationUpdate,
} from "../api/delegation.ts";
import type { AcceptanceInput, ToolBudgetConfig, TurnBudgetConfig } from "../shared/types.ts";

export interface PromptTemplateDelegationTask {
	agent: string;
	task: string;
	model?: string;
	cwd?: string;
}

export interface PromptTemplateDelegationParallelResult {
	agent: string;
	messages: unknown[];
	isError: boolean;
	errorText?: string;
}

export interface PromptTemplateDelegationRequest {
	requestId: string;
	agent: string;
	task: string;
	tasks?: PromptTemplateDelegationTask[];
	context: "fresh" | "fork";
	model: string;
	cwd: string;
	worktree?: boolean;
}

export interface PromptTemplateDelegationResponse extends PromptTemplateDelegationRequest {
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

export interface PromptTemplateDelegationUpdate {
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

export interface PromptTemplateBridgeResult {
	isError?: boolean;
	content?: unknown;
	details?: {
		mode?: "single" | "parallel" | "chain" | "management";
		runId?: string;
		timedOut?: boolean;
		stopped?: boolean;
		results?: Array<{
			agent?: string;
			messages?: unknown[];
			finalOutput?: string;
			toolCalls?: Array<{ text?: string; expandedText?: string }>;
			exitCode?: number;
			error?: string;
			model?: string;
			interrupted?: boolean;
			timedOut?: boolean;
			stopped?: boolean;
			turnBudgetExceeded?: boolean;
			toolBudgetBlocked?: boolean;
			savedOutputPath?: string;
			sessionFile?: string;
			acceptance?: SubagentDelegationAcceptanceResult;
			usage?: { turns?: number };
			progressSummary?: { toolCount?: number; durationMs?: number; tokens?: number };
			skillsWarning?: string;
			outputSaveError?: string;
			transcriptError?: string;
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

export interface DelegatedSubagentExecutionParams {
	agent?: string;
	task?: string;
	tasks?: PromptTemplateDelegationTask[];
	context: "fresh" | "fork";
	model?: string;
	cwd: string;
	worktree?: boolean;
	timeoutMs?: number;
	turnBudget?: TurnBudgetConfig;
	toolBudget?: ToolBudgetConfig;
	skill?: string | string[] | boolean;
	output?: string | boolean;
	outputMode?: "inline" | "file-only";
	acceptance?: AcceptanceInput;
	artifacts?: boolean;
	async: false;
	foregroundOnly: true;
	clarify: false;
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

export function parsePromptTemplateRequest(data: unknown): PromptTemplateDelegationRequest | undefined {
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

export function toDelegationUpdate(requestId: string, update: PromptTemplateBridgeResult): PromptTemplateDelegationUpdate | undefined {
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

export function toLegacyExecutionParams(request: PromptTemplateDelegationRequest): DelegatedSubagentExecutionParams {
	if (request.tasks && request.tasks.length > 0) {
		return {
			tasks: request.tasks,
			context: request.context,
			cwd: request.cwd,
			worktree: request.worktree,
			async: false,
			foregroundOnly: true,
			clarify: false,
		};
	}
	return {
		agent: request.agent,
		task: request.task,
		context: request.context,
		model: request.model,
		cwd: request.cwd,
		async: false,
		foregroundOnly: true,
		clarify: false,
	};
}

export function toSubagentDelegationExecutionParams(request: SubagentDelegationRequest): DelegatedSubagentExecutionParams {
	return {
		agent: request.agent,
		task: request.task,
		context: request.context,
		cwd: request.cwd,
		model: request.model,
		timeoutMs: request.timeoutMs,
		turnBudget: request.turnBudget,
		toolBudget: request.toolBudget,
		skill: request.skill,
		output: request.output,
		outputMode: request.outputMode,
		acceptance: request.acceptance,
		artifacts: request.artifacts,
		async: false,
		foregroundOnly: true,
		clarify: false,
	};
}

export function toSubagentDelegationUpdate(requestId: string, result: PromptTemplateBridgeResult): SubagentDelegationUpdate | undefined {
	const legacy = toDelegationUpdate(requestId, result);
	if (!legacy) return undefined;
	return {
		version: SUBAGENT_DELEGATION_PROTOCOL_VERSION,
		requestId,
		...(legacy.currentTool ? { currentTool: legacy.currentTool } : {}),
		...(legacy.currentToolArgs ? { currentToolArgs: legacy.currentToolArgs } : {}),
		...(legacy.recentOutput ? { recentOutput: legacy.recentOutput } : {}),
		...(legacy.recentOutputLines ? { recentOutputLines: legacy.recentOutputLines } : {}),
		...(legacy.recentTools ? { recentTools: legacy.recentTools } : {}),
		...(legacy.model ? { model: legacy.model } : {}),
		...(typeof legacy.toolCount === "number" ? { toolCount: legacy.toolCount } : {}),
		...(typeof legacy.durationMs === "number" ? { durationMs: legacy.durationMs } : {}),
		...(typeof legacy.tokens === "number" ? { tokens: legacy.tokens } : {}),
	};
}

function resolveSubagentDelegationStatus(
	result: PromptTemplateBridgeResult,
	aborted: boolean,
): SubagentDelegationStatus {
	if (aborted) return "cancelled";
	const child = result.details?.results?.[0];
	if (!child) return "failed";
	if (result.details?.timedOut || child.timedOut) return "timed_out";
	if (child?.turnBudgetExceeded) return "turn_budget_exhausted";
	if (child?.toolBudgetBlocked) return "tool_budget_exhausted";
	if (child?.acceptance?.status === "rejected" && child.acceptance.explicit) return "acceptance_failed";
	if (result.details?.stopped || child?.stopped || child?.interrupted) return "interrupted";
	if (result.isError || child?.error || (typeof child?.exitCode === "number" && child.exitCode !== 0)) return "failed";
	return "completed";
}

export function toSubagentDelegationResponse(
	requestId: string,
	result: PromptTemplateBridgeResult,
	aborted: boolean,
): SubagentDelegationResponse {
	const child = result.details?.results?.[0];
	const progress = child?.progressSummary ?? result.details?.progress?.[0];
	const warnings = [child?.skillsWarning, child?.outputSaveError, child?.transcriptError]
		.filter((warning): warning is string => typeof warning === "string" && warning.length > 0);
	const status = resolveSubagentDelegationStatus(result, aborted);
	const fallbackError = status === "failed" ? firstTextContent(result.content) : undefined;
	return {
		version: SUBAGENT_DELEGATION_PROTOCOL_VERSION,
		requestId,
		status,
		...(child?.error || fallbackError ? { error: child?.error ?? fallbackError } : {}),
		...(result.details?.runId ? { runId: result.details.runId } : {}),
		...(child ? { childIndex: 0 } : {}),
		...(child?.agent ? { agent: child.agent } : {}),
		...(child?.model ? { model: child.model } : {}),
		...(typeof child?.exitCode === "number" ? { exitCode: child.exitCode } : {}),
		...(child?.finalOutput ? { output: child.finalOutput } : {}),
		...(child?.savedOutputPath ? { outputPath: child.savedOutputPath } : {}),
		...(child?.sessionFile ? { sessionFile: child.sessionFile } : {}),
		...(child?.acceptance ? { acceptance: { status: child.acceptance.status, explicit: child.acceptance.explicit } } : {}),
		...(typeof child?.usage?.turns === "number" ? { turns: child.usage.turns } : {}),
		...(typeof progress?.toolCount === "number" ? { toolCount: progress.toolCount } : {}),
		...(typeof progress?.durationMs === "number" ? { durationMs: progress.durationMs } : {}),
		...(typeof progress?.tokens === "number" ? { tokens: progress.tokens } : {}),
		...(warnings.length > 0 ? { warnings } : {}),
	};
}

export function toPromptTemplateResponse(
	request: PromptTemplateDelegationRequest,
	result: PromptTemplateBridgeResult,
): PromptTemplateDelegationResponse {
	const contentText = firstTextContent(result.content);
	const messages = buildDelegationMessages(result.details?.results?.[0] ?? {}, contentText);
	const parallelResults = request.tasks?.map<PromptTemplateDelegationParallelResult>((task, index) => {
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
		return {
			agent: step.agent ?? task.agent,
			messages: buildDelegationMessages(step),
			isError: (exitCode !== undefined && exitCode !== 0) || !!step.error,
			errorText: step.error || undefined,
		};
	});
	return {
		...request,
		messages,
		...(parallelResults ? { parallelResults } : {}),
		...(contentText ? { contentText } : {}),
		isError: result.isError === true,
		errorText: result.isError ? contentText : undefined,
	};
}
