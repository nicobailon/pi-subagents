import { MAX_ASYNC_TOOL_ACTIVITIES, MAX_ASYNC_VISIBLE_TEXT, type AsyncToolActivity } from "../../shared/types.ts";

/** Remove terminal escapes and non-printing controls before a snapshot reaches a TUI. */
export function sanitizeObservableText(value: unknown, max = MAX_ASYNC_VISIBLE_TEXT): string | undefined {
	if (typeof value !== "string") return undefined;
	const clean = value
		.replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "") // OSC
		.replace(/\x1b[PX^_][\s\S]*?\x1b\\/g, "") // DCS/APC/PM/SOS
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "") // CSI
		.replace(/\x1b./g, "")
		.replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
		.replace(/\s+/g, " ").trim();
	return clean ? Array.from(clean).slice(0, max).join("") : undefined;
}

/** Only explicitly visible assistant text is eligible for the widget. */
export function visibleAssistantText(event: { type?: unknown; message?: { role?: unknown; content?: unknown }; assistantMessageEvent?: { type?: unknown; delta?: unknown; text?: unknown } }): string | undefined {
	const message = event.message;
	if (message?.role !== "assistant") return undefined;
	if (event.type === "message_update") {
		const update = event.assistantMessageEvent;
		if (update?.type !== "text_delta") return undefined;
		return sanitizeObservableText(typeof update.delta === "string" ? update.delta : update.text);
	}
	if (event.type !== "message_end" || !Array.isArray(message.content)) return undefined;
	return sanitizeObservableText(message.content.filter((part): part is { type: "text"; text: string } => Boolean(part && typeof part === "object" && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string")).map((part) => part.text).join(" "));
}

export const ACCEPTANCE_PREVIEW_MARKERS = [
	"```acceptance-report",
	"ACCEPTANCE_REPORT:",
] as const;
const MAX_ASSISTANT_PREVIEW_BUFFER = 4_000;

export interface StreamingAcceptancePreviewState {
	visibleText: string;
	pendingMarker: string;
	protocolOpen: boolean;
}

export function emptyStreamingAcceptancePreviewState(): StreamingAcceptancePreviewState {
	return { visibleText: "", pendingMarker: "", protocolOpen: false };
}

/**
 * Reduce one assistant text delta into bounded preview state. Once a protocol
 * marker opens, all later deltas in that message remain hidden even after the
 * marker leaves the bounded visible buffer. pendingMarker retains only a
 * possible split-marker suffix.
 */
export function appendStreamingAcceptancePreview(state: StreamingAcceptancePreviewState, delta: string): StreamingAcceptancePreviewState {
	if (state.protocolOpen || !delta) return state;
	const candidate = state.pendingMarker + delta;
	const lower = candidate.toLowerCase();
	let markerAt = candidate.length;
	for (const marker of ACCEPTANCE_PREVIEW_MARKERS) {
		const index = lower.indexOf(marker.toLowerCase());
		if (index >= 0) markerAt = Math.min(markerAt, index);
	}
	if (markerAt < candidate.length) {
		return {
			visibleText: `${state.visibleText}${candidate.slice(0, markerAt)}`.trimEnd().slice(-MAX_ASSISTANT_PREVIEW_BUFFER),
			pendingMarker: "",
			protocolOpen: true,
		};
	}
	let pendingLength = 0;
	for (const marker of ACCEPTANCE_PREVIEW_MARKERS) {
		// Every non-empty prefix can be the start of a marker split across deltas.
		// Retain the longest matching suffix so no split position can leak.
		for (let length = 1; length < marker.length; length++) {
			if (lower.endsWith(marker.slice(0, length).toLowerCase())) pendingLength = Math.max(pendingLength, length);
		}
	}
	return {
		visibleText: `${state.visibleText}${candidate.slice(0, candidate.length - pendingLength)}`.slice(-MAX_ASSISTANT_PREVIEW_BUFFER),
		pendingMarker: pendingLength ? candidate.slice(-pendingLength) : "",
		protocolOpen: false,
	};
}

/**
 * Finish one assistant message. A suffix that never became a complete marker is
 * ordinary visible text and must be restored before the per-message state is
 * discarded. An opened protocol remains suppressed.
 */
export function finalizeStreamingAcceptancePreview(state: StreamingAcceptancePreviewState): StreamingAcceptancePreviewState {
	if (state.protocolOpen || !state.pendingMarker) return state;
	return {
		visibleText: `${state.visibleText}${state.pendingMarker}`.slice(-MAX_ASSISTANT_PREVIEW_BUFFER),
		pendingMarker: "",
		protocolOpen: false,
	};
}

/** Compatibility helper for callers that already hold a complete buffer. */
export function suppressStreamingAcceptanceProtocol(value: string): string {
	const state = finalizeStreamingAcceptancePreview(appendStreamingAcceptancePreview(emptyStreamingAcceptancePreviewState(), value));
	return state.visibleText.trimEnd();
}

export function appendToolActivity(history: AsyncToolActivity[] | undefined, activity: AsyncToolActivity): AsyncToolActivity[] {
	return [...(history ?? []).filter((item) => item.toolCallId !== activity.toolCallId || !activity.toolCallId), activity].slice(-MAX_ASYNC_TOOL_ACTIVITIES);
}
