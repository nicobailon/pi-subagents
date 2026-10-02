/**
 * Unfinished assistant text recovered when a child ends abnormally.
 *
 * Final output is built from completed `message_end` messages, so text that was
 * still streaming when a child timed out or its session threw is otherwise lost.
 * The tracker keeps one in-memory reference to the latest unfinished assistant
 * text. Nothing is persisted.
 */
import type { ChildSessionEvent } from "./child-session.ts";
import { extractTextFromContent } from "../../shared/utils.ts";

export type PartialOutputCause = "timeout" | "child error";

export interface PartialOutputTracker {
	observe(event: ChildSessionEvent): void;
	/** Latest unfinished assistant text that is newer than the last completed reply. */
	text(): string | undefined;
}

function assistantText(message: unknown): string {
	if (!message || typeof message !== "object") return "";
	const { role, content } = message as { role?: unknown; content?: unknown };
	return role === "assistant" ? extractTextFromContent(content) : "";
}

function isErroredAssistant(message: unknown): boolean {
	const { stopReason, errorMessage } = message as { stopReason?: unknown; errorMessage?: unknown };
	return stopReason === "error" || (typeof errorMessage === "string" && errorMessage.length > 0);
}

export function createPartialOutputTracker(): PartialOutputTracker {
	let partial: string | undefined;
	return {
		observe(event) {
			if (event.type === "message_update") {
				const text = assistantText(event.message);
				if (text.trim()) partial = text;
				return;
			}
			if (event.type !== "message_end") return;
			const message = event.message;
			const text = assistantText(message);
			if (!text.trim()) return;
			// A completed reply is already part of the final output. A provider-error
			// message is skipped there, so its text is the newest unfinished text.
			partial = isErroredAssistant(message) ? text : undefined;
		},
		text: () => partial,
	};
}

export function formatPartialOutput(text: string, cause: PartialOutputCause): string {
	return `Partial output before ${cause}:\n${text}`;
}
