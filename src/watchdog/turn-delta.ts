import { SUBAGENT_WATCHDOG_WARNING_TYPE } from "./types.ts";

type MessageLike = {
	role?: string;
	content?: unknown;
	customType?: string;
	toolName?: string;
	name?: string;
	input?: unknown;
	args?: unknown;
	arguments?: unknown;
	error?: unknown;
	isError?: boolean;
	details?: unknown;
	stopReason?: string;
};

export interface WatchdogTurnDeltaInput {
	userPrompt?: string;
	includeUserPrompt?: boolean;
	messages?: unknown[];
	events?: unknown[];
	finalAssistantStop?: boolean;
}

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content.map((block) => {
			if (typeof block === "string") return block;
			if (block && typeof block === "object") {
				const item = block as { type?: string; text?: unknown; thinking?: unknown; content?: unknown; name?: unknown; input?: unknown; args?: unknown; arguments?: unknown };
				if (item.type === "text" && typeof item.text === "string") return item.text;
				if (item.type === "thinking" && typeof item.thinking === "string") return ["Thinking:", item.thinking].join("\n");
				if (item.type === "toolCall") return formatToolCall(item.name, item.input ?? item.args ?? item.arguments);
				if (typeof item.content === "string") return item.content;
			}
			return "";
		}).filter(Boolean).join("\n");
	}
	if (content === undefined || content === null) return "";
	return formatValue(content);
}

function formatValue(value: unknown, indent = ""): string {
	if (typeof value === "string") return value;
	if (value === undefined) return "undefined";
	if (value === null || typeof value === "number" || typeof value === "boolean") return JSON.stringify(value);
	if (Array.isArray(value)) {
		return value.map((item, index) => `${indent}- ${formatValue(item, `${indent}  `)}`).join("\n");
	}
	if (typeof value === "object") {
		const lines: string[] = [];
		for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
			if (typeof item === "string" && item.includes("\n")) lines.push(`${indent}${key}:\n${item}`);
			else lines.push(`${indent}${key}: ${formatValue(item, `${indent}  `)}`);
		}
		return lines.join("\n");
	}
	return String(value);
}

function redactEditWriteInput(input: unknown): unknown {
	if (Array.isArray(input)) return input.map(redactEditWriteInput);
	if (!input || typeof input !== "object") return input;
	const sanitized: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
		sanitized[key] = ["oldText", "newText", "content"].includes(key) && typeof value === "string"
			? `[omitted ${value.length} chars; use tool result diff]`
			: redactEditWriteInput(value);
	}
	return sanitized;
}

function formatToolArguments(name: string, input: unknown): string {
	if (name === "edit" || name === "write") return formatValue(redactEditWriteInput(input));
	return formatValue(input);
}

function formatToolCall(name: unknown, input: unknown): string {
	const toolName = typeof name === "string" && name ? name : "tool";
	return [`Tool call: ${toolName}`, "Arguments:", formatToolArguments(toolName, input ?? {})].join("\n");
}

function formatToolResult(name: string, content: unknown, details: unknown, error: unknown, isError: boolean | undefined): string {
	const failed = isError === true || Boolean(error);
	const lines = [`Tool result: ${name}`];
	if (failed) lines.push(`Error: ${error ? (typeof error === "string" ? error : formatValue(error)) : "tool reported an error"}`);
	if (!failed && details && typeof details === "object" && "diff" in details && typeof (details as { diff?: unknown }).diff === "string") {
		lines.push("Diff:", (details as { diff: string }).diff);
	} else {
		const body = textFromContent(content);
		if (body) lines.push(failed ? "Output:" : "Result:", body);
	}
	return lines.join("\n");
}

function messagesFromEvent(event: unknown): unknown[] {
	if (!event || typeof event !== "object") return [];
	const input = event as Record<string, unknown>;
	if (input.type === "turn_end" || input.event === "turn_end") {
		return [input.message, ...(Array.isArray(input.toolResults) ? input.toolResults : [])].filter(Boolean);
	}
	if (input.message) return [input.message];
	if (input.type === "tool_execution_start" || input.event === "tool_execution_start") {
		return [{ role: "toolCall", name: input.toolName ?? input.name, input: input.args ?? input.input }];
	}
	if (input.type === "tool_execution_end" || input.event === "tool_execution_end") {
		const result = input.result && typeof input.result === "object" && !Array.isArray(input.result) ? input.result as Record<string, unknown> : undefined;
		return [{
			role: "toolResult",
			toolName: input.toolName ?? input.name,
			content: result?.content ?? input.content ?? input.result,
			details: result?.details ?? input.details,
			error: input.error,
			isError: input.isError,
		}];
	}
	if (input.type === "tool_result" || input.event === "tool_result") {
		return [{ role: "toolResult", toolName: input.toolName ?? input.name, content: input.content, details: input.details, error: input.error, isError: input.isError }];
	}
	return [];
}

export function formatWatchdogReviewMessage(message: unknown): string | undefined {
	if (!message || typeof message !== "object") return undefined;
	const input = message as MessageLike;
	if (input.role === "custom" && input.customType === SUBAGENT_WATCHDOG_WARNING_TYPE) return undefined;
	if (input.role === "assistant") {
		const text = textFromContent(input.content);
		const lines = text ? ["Assistant:", text] : ["Assistant: (no text)"];
		if (input.stopReason === "stop") lines.push("Assistant stop: stop");
		return lines.join("\n");
	}
	if (input.role === "toolCall") return formatToolCall(input.name ?? input.toolName, input.input ?? input.args ?? input.arguments);
	if (input.role === "toolResult" || input.role === "tool") {
		return formatToolResult(input.toolName ?? input.name ?? "tool", input.content, input.details, input.error, input.isError);
	}
	if (input.role === "user") {
		const text = textFromContent(input.content);
		return text ? ["User:", text].join("\n") : undefined;
	}
	return undefined;
}

export function formatWatchdogTurnDelta(input: WatchdogTurnDeltaInput): string {
	const sections: string[] = [];
	if (input.includeUserPrompt && input.userPrompt?.trim()) sections.push(["User prompt:", input.userPrompt].join("\n"));
	for (const message of input.messages ?? []) {
		const section = formatWatchdogReviewMessage(message);
		if (section) sections.push(section);
	}
	for (const event of input.events ?? []) {
		for (const message of messagesFromEvent(event)) {
			const section = formatWatchdogReviewMessage(message);
			if (section) sections.push(section);
		}
	}
	if (input.finalAssistantStop) sections.push("Final assistant stop: stop without tool call");
	return sections.join("\n\n---\n\n");
}
