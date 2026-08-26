import {
	type SubagentDelegationRequest,
	type SubagentDelegationResponse,
	type SubagentDelegationStatus,
	type SubagentDelegationThinking,
	type SubagentDelegationUpdate,
	type SubagentDelegationValue,
} from "../api/delegation.ts";
import type { AcceptanceInput, AgentContract, EffectsProjection, ExecutionProjection, JsonSchemaObject, ReviewProjection, ToolBudgetConfig, TurnBudgetConfig, Usage } from "../shared/types.ts";
import { cloneJsonWithinByteLimit } from "./delegation-json.ts";

export interface PromptTemplateDelegationRequest {
	requestId: string;
	agent: string;
	task: string;
	context: "fresh" | "fork";
	model: string;
	cwd: string;
}

export interface PromptTemplateDelegationResponse extends PromptTemplateDelegationRequest {
	messages: unknown[];
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
	runId?: string;
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

interface DelegationAcceptanceSnapshot {
	status: string;
	evidenceStatus?: string;
	explicit?: boolean;
}

export interface PromptTemplateBridgeResult {
	isError?: boolean;
	content?: unknown;
	details?: {
		mode?: "single" | "parallel" | "chain" | "workflow" | "management";
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
			thinking?: string;
			structuredOutput?: unknown;
			interrupted?: boolean;
			timedOut?: boolean;
			stopped?: boolean;
			turnBudgetExceeded?: boolean;
			toolBudgetBlocked?: boolean;
			structuredOutputFailed?: boolean;
			savedOutputPath?: string;
			sessionFile?: string;
			agentContract?: AgentContract;
			execution?: ExecutionProjection;
			acceptance?: DelegationAcceptanceSnapshot;
			review?: ReviewProjection;
			effects?: EffectsProjection;
			usage?: Usage;
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
	context: "fresh" | "fork";
	model?: string;
	cwd: string;
	timeoutMs?: number;
	turnBudget?: TurnBudgetConfig;
	/** Internal-only strict turn-boundary enforcement for structured foreground delegation. */
	enforceHardTurnLimit?: boolean;
	toolBudget?: ToolBudgetConfig;
	skill?: string | string[] | boolean;
	output?: string | boolean;
	outputMode?: "inline" | "file-only";
	outputSchema?: JsonSchemaObject;
	agentContract?: AgentContract;
	acceptance?: AcceptanceInput;
	artifacts?: boolean;
	/** Internal-only thinking override accepted by executeDelegated. */
	delegatedThinkingOverride?: SubagentDelegationThinking;
	/** Internal-only capability accepted and stripped by executeDelegated. */
	delegatedAllowZeroToolBudget?: true;
	async: false;
	foregroundOnly: true;
	clarify: false;
}

export function parsePromptTemplateRequest(data: unknown): PromptTemplateDelegationRequest | undefined {
	if (!data || typeof data !== "object") return undefined;
	const value = data as Partial<PromptTemplateDelegationRequest> & { tasks?: unknown; worktree?: unknown };
	if (value.tasks !== undefined || value.worktree !== undefined) return undefined;
	if (typeof value.requestId !== "string" || !value.requestId) return undefined;
	if (typeof value.agent !== "string" || !value.agent) return undefined;
	if (typeof value.task !== "string" || !value.task) return undefined;
	if (typeof value.model !== "string" || !value.model) return undefined;
	if (typeof value.cwd !== "string" || !value.cwd) return undefined;
	if (value.context !== "fresh" && value.context !== "fork") return undefined;
	return {
		requestId: value.requestId,
		agent: value.agent,
		task: value.task,
		context: value.context,
		model: value.model,
		cwd: value.cwd,
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
		...(update.details?.runId ? { runId: update.details.runId } : {}),
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

export function toSubagentDelegationExecutionParams(request: SubagentDelegationRequest): DelegatedSubagentExecutionParams {
	return {
		agent: request.agent,
		task: request.task,
		context: request.context,
		cwd: request.cwd,
		model: request.model,
		timeoutMs: request.timeoutMs,
		turnBudget: request.turnBudget,
		enforceHardTurnLimit: true,
		toolBudget: request.toolBudget,
		skill: request.skill,
		...(request.result.kind === "structured" ? { outputSchema: request.result.schema } : {}),
		acceptance: false,
		artifacts: request.artifacts,
		delegatedThinkingOverride: request.thinking,
		delegatedAllowZeroToolBudget: true,
		async: false,
		foregroundOnly: true,
		clarify: false,
	};
}

export function toSubagentDelegationUpdate(
	request: SubagentDelegationRequest,
	result: PromptTemplateBridgeResult,
): SubagentDelegationUpdate | undefined {
	const legacy = toDelegationUpdate(request.requestId, result);
	if (!legacy) return undefined;
	return {
		requestId: request.requestId,
		ownerRunId: request.ownerRunId,
		nodeId: request.nodeId,
		...(legacy.runId ? { runId: legacy.runId } : {}),
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
	if (child?.structuredOutputFailed) return "structured_output_failed";
	if (child?.turnBudgetExceeded) return "turn_budget_exhausted";
	if (child?.toolBudgetBlocked) return "tool_budget_exhausted";
	if (child?.acceptance?.status === "rejected" && child.acceptance.explicit) return "acceptance_failed";
	if (result.details?.stopped || child?.stopped || child?.interrupted) return "interrupted";
	if (result.isError || child?.error || (typeof child?.exitCode === "number" && child.exitCode !== 0)) return "failed";
	return "completed";
}

const MAX_RESULT_BYTES = 1024 * 1024;

export function toSubagentDelegationResponse(
	request: SubagentDelegationRequest,
	result: PromptTemplateBridgeResult,
	aborted: boolean,
): SubagentDelegationResponse {
	const child = result.details?.results?.[0];
	const progress = child?.progressSummary ?? result.details?.progress?.[0];
	let status = resolveSubagentDelegationStatus(result, aborted);
	let error = child?.error ?? (status === "failed" ? firstTextContent(result.content) : undefined);
	let projectedResult: SubagentDelegationValue | undefined;
	if (status === "completed") {
		if (request.result.kind === "text") {
			if (typeof child?.finalOutput !== "string") {
				status = "failed";
				error = "Delegated subagent did not capture a text result.";
			} else if (Buffer.byteLength(child.finalOutput, "utf8") > MAX_RESULT_BYTES) {
				status = "failed";
				error = "Delegated text result exceeds 1 MiB when UTF-8 encoded.";
			} else {
				projectedResult = { kind: "text", text: child.finalOutput };
			}
		} else if (child?.structuredOutput === undefined) {
			status = "failed";
			error = "Delegated subagent did not capture the requested structured result.";
		} else {
			const inspected = cloneJsonWithinByteLimit(child.structuredOutput, MAX_RESULT_BYTES);
			if (inspected.ok === false) {
				status = "failed";
				error = inspected.reason === "too_large"
					? "Delegated structured result exceeds 1 MiB when encoded."
					: "Delegated structured result is not plain JSON data.";
			} else {
				projectedResult = { kind: "structured", value: inspected.value };
			}
		}
	}
	const usage = child?.usage;
	const childLaunchContractDigest = (child as { launchContractDigest?: string } | undefined)?.launchContractDigest;
	return {
		requestId: request.requestId,
		ownerRunId: request.ownerRunId,
		nodeId: request.nodeId,
		status,
		...(error ? { error } : {}),
		...(result.details?.runId ? { runId: result.details.runId } : {}),
		...(child?.agent ? { agent: child.agent } : {}),
		...(child?.model ? { model: child.model } : {}),
		...(child?.thinking ? { thinking: child.thinking } : {}),
		...(typeof child?.exitCode === "number" ? { exitCode: child.exitCode } : {}),
		...(childLaunchContractDigest ? { launchContractDigest: childLaunchContractDigest } : {}),
		...(projectedResult ? { result: projectedResult } : {}),
		...(usage ? {
			usage: {
				input: usage.input,
				output: usage.output,
				cacheRead: usage.cacheRead,
				cacheWrite: usage.cacheWrite,
				cost: usage.cost,
				turns: usage.turns,
				toolCalls: progress?.toolCount ?? 0,
				durationMs: progress?.durationMs ?? 0,
			},
		} : {}),
	};
}

export function toPromptTemplateResponse(
	request: PromptTemplateDelegationRequest,
	result: PromptTemplateBridgeResult,
): PromptTemplateDelegationResponse {
	const contentText = firstTextContent(result.content);
	const messages = buildDelegationMessages(result.details?.results?.[0] ?? {}, contentText);
	return {
		...request,
		messages,
		...(contentText ? { contentText } : {}),
		isError: result.isError === true,
		errorText: result.isError ? contentText : undefined,
	};
}
