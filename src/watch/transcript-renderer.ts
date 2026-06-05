import type { AssistantMessage, UserMessage } from "@earendil-works/pi-ai";
import {
	AssistantMessageComponent,
	BranchSummaryMessageComponent,
	CompactionSummaryMessageComponent,
	CustomMessageComponent,
	UserMessageComponent,
	getMarkdownTheme,
	initTheme,
} from "@earendil-works/pi-coding-agent";
import { Markdown, Text, type Component } from "@earendil-works/pi-tui";

interface RenderTranscriptOptions {
	warnings: string[];
}

function textContent(value: unknown): string {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) {
		return value
			.map((part) => part && typeof part === "object" && "text" in part && typeof part.text === "string" ? part.text : "")
			.filter(Boolean)
			.join("\n");
	}
	return "";
}

let themeInitialized = false;

function markdownTheme() {
	if (!themeInitialized) {
		initTheme(undefined, false);
		themeInitialized = true;
	}
	return getMarkdownTheme();
}

function fallback(label: string, text: string): Component {
	return new Markdown(`**${label}**\n\n${text || "(empty)"}`, 1, 0, markdownTheme());
}

export function renderTranscriptComponents(entries: unknown[], options: RenderTranscriptOptions): Component[] {
	const components: Component[] = [];
	for (const warning of options.warnings) components.push(new Text(`Warning: ${warning}`, 1, 0));

	for (const entry of entries) {
		if (!entry || typeof entry !== "object") continue;
		const raw = entry as Record<string, unknown>;
		if (raw.type === "message" && raw.message && typeof raw.message === "object") {
			const message = raw.message as { role?: unknown; content?: unknown; toolName?: unknown };
			if (message.role === "user") {
				components.push(new UserMessageComponent(textContent((message as UserMessage).content), markdownTheme()));
			} else if (message.role === "assistant") {
				components.push(new AssistantMessageComponent(message as AssistantMessage, false, markdownTheme()));
			} else if (message.role === "toolResult") {
				components.push(fallback(`tool result: ${String(message.toolName ?? "tool")}`, textContent(message.content)));
			} else if (message.role === "custom") {
				components.push(new CustomMessageComponent(message as never, undefined, markdownTheme()));
			} else {
				components.push(fallback(String(message.role ?? "message"), JSON.stringify(message, null, 2)));
			}
			continue;
		}
		if (raw.type === "custom_message") {
			components.push(new CustomMessageComponent({
				role: "custom",
				customType: String(raw.customType ?? "custom"),
				content: raw.content as never,
				display: raw.display !== false,
				details: raw.details,
				timestamp: Date.now(),
			} as never, undefined, markdownTheme()));
			continue;
		}
		if (raw.type === "compaction") {
			components.push(new CompactionSummaryMessageComponent({
				role: "compactionSummary",
				summary: String(raw.summary ?? ""),
				tokensBefore: Number(raw.tokensBefore ?? 0),
				timestamp: Date.now(),
			} as never, markdownTheme()));
			continue;
		}
		if (raw.type === "branch_summary") {
			components.push(new BranchSummaryMessageComponent({
				role: "branchSummary",
				summary: String(raw.summary ?? ""),
				fromId: String(raw.fromId ?? ""),
				timestamp: Date.now(),
			} as never, markdownTheme()));
		}
	}
	return components;
}

export function renderTranscriptLines(entries: unknown[], options: RenderTranscriptOptions, width: number): string[] {
	const components = renderTranscriptComponents(entries, options);
	if (components.length === 0) return ["Transcript is empty."];
	return components.flatMap((component) => component.render(width));
}
