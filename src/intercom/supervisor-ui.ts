import type { EntryRenderOptions, MessageRenderOptions, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import { safeTerminalText } from "../shared/display-text.ts";

export const SUPERVISOR_REQUEST_MESSAGE_TYPE = "subagent_supervisor_request";
export const SUPERVISOR_REPLY_ENTRY_TYPE = "subagent_supervisor_reply";

export type SupervisorReason = "need_decision" | "interview_request" | "progress_update";

export interface SupervisorRequestMessageDetails {
	id?: string;
	requestId?: string;
	reason?: SupervisorReason;
	expectsReply?: boolean;
	runId?: string;
	agent?: string;
	childIndex?: number;
	childTarget?: string;
	interview?: unknown;
	requestBody?: string;
	replyHint?: string;
}

export interface SupervisorReplyEntryData {
	requestId: string;
	reason?: SupervisorReason;
	runId: string;
	agent: string;
	childIndex: number;
	childTarget?: string;
	message: string;
	createdAt: number;
}

interface SupervisorMessageLike {
	content: unknown;
	details?: unknown;
}

interface SupervisorEntryLike {
	data?: unknown;
}

const MAX_FIELD_CHARS = 512;
const MAX_BODY_CHARS = 8_000;
const MAX_INTERVIEW_CHARS = 4_000;
const MAX_RENDER_LINES = 36;
const TRUNCATION_MARKER = "[truncated]";

export function supervisorReplyHint(requestId: string): string {
	return `subagent_supervisor({ action: "reply", replyTo: "${requestId}", message: "..." })`;
}

function boundedText(value: string, maxChars: number): string {
	const safe = safeTerminalText(value);
	if (safe.length <= maxChars) return safe;
	const prefixLength = Math.max(0, maxChars - TRUNCATION_MARKER.length - 1);
	let prefix = "";
	for (const character of safe) {
		if (prefix.length + character.length > prefixLength) break;
		prefix += character;
	}
	return `${prefix} ${TRUNCATION_MARKER}`;
}

function displayText(value: string, maxChars: number, expanded: boolean): string {
	return expanded ? safeTerminalText(value) : boundedText(value, maxChars);
}

function boundedField(value: unknown, fallback = "unknown"): string {
	return boundedText(typeof value === "string" ? value : value === undefined ? fallback : String(value), MAX_FIELD_CHARS);
}

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			if (!part || typeof part !== "object") return "";
			const text = (part as { text?: unknown }).text;
			return typeof text === "string" ? text : "";
		})
		.filter(Boolean)
		.join("\n");
}

function interviewText(interview: unknown, expanded: boolean): string {
	let serialized: string;
	try {
		serialized = JSON.stringify(interview, null, 2) ?? String(interview);
	} catch {
		serialized = "[unavailable]";
	}
	return displayText(serialized, MAX_INTERVIEW_CHARS, expanded);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isSupervisorReason(value: unknown): value is SupervisorReason {
	return value === "need_decision" || value === "interview_request" || value === "progress_update";
}

function optionalString(value: unknown): boolean {
	return value === undefined || typeof value === "string";
}

function requestDetails(value: unknown): SupervisorRequestMessageDetails | undefined {
	if (!isRecord(value)) return undefined;
	if (!optionalString(value.id) || !optionalString(value.requestId) || !optionalString(value.replyHint) || !optionalString(value.requestBody) || !optionalString(value.runId) || !optionalString(value.agent) || !optionalString(value.childTarget)) return undefined;
	if (value.reason !== undefined && !isSupervisorReason(value.reason)) return undefined;
	if (value.expectsReply !== undefined && typeof value.expectsReply !== "boolean") return undefined;
	if (value.childIndex !== undefined && (typeof value.childIndex !== "number" || !Number.isFinite(value.childIndex))) return undefined;
	return value;
}

function replyData(value: unknown): SupervisorReplyEntryData | undefined {
	if (!isRecord(value)) return undefined;
	if (typeof value.requestId !== "string" || typeof value.runId !== "string" || typeof value.agent !== "string" || typeof value.message !== "string") return undefined;
	if (value.reason !== undefined && !isSupervisorReason(value.reason)) return undefined;
	if (value.childTarget !== undefined && typeof value.childTarget !== "string") return undefined;
	if (typeof value.childIndex !== "number" || !Number.isFinite(value.childIndex) || typeof value.createdAt !== "number" || !Number.isFinite(value.createdAt)) return undefined;
	return {
		requestId: value.requestId,
		...(value.reason === undefined ? {} : { reason: value.reason }),
		runId: value.runId,
		agent: value.agent,
		childIndex: value.childIndex,
		...(value.childTarget === undefined ? {} : { childTarget: value.childTarget }),
		message: value.message,
		createdAt: value.createdAt,
	};
}

function withRequestId(details: SupervisorRequestMessageDetails): string {
	return boundedField(details.requestId ?? details.id);
}

function requestHeading(reason: SupervisorReason | undefined): string {
	if (reason === "interview_request") return "⚠ Supervisor interview request";
	if (reason === "progress_update") return "ℹ Supervisor progress update";
	return "⚠ Supervisor decision request";
}

function requestLines(message: SupervisorMessageLike, details: SupervisorRequestMessageDetails, expanded: boolean): string[] {
	const requestId = withRequestId(details);
	const lines = [
		`Reason: ${boundedField(details.reason)}`,
		`Run: ${boundedField(details.runId)}`,
		`Agent: ${boundedField(details.agent)}`,
		`Child index: ${boundedField(details.childIndex)}`,
	];
	if (details.childTarget) lines.push(`Child target: ${boundedField(details.childTarget)}`);
	lines.push(`Request ID: ${requestId}`);
	if (details.expectsReply) lines.push(`Reply with: ${displayText(details.replyHint ?? supervisorReplyHint(requestId), MAX_BODY_CHARS, expanded)}`);
	lines.push("", "Request:", displayText((details.requestBody ?? contentText(message.content)) || "(no request body)", MAX_BODY_CHARS, expanded));
	if (details.interview !== undefined) lines.push("", "Interview shape:", interviewText(details.interview, expanded));
	return lines;
}

function replyLines(data: SupervisorReplyEntryData, expanded: boolean): string[] {
	const requestId = boundedField(data.requestId);
	const lines = [
		...(data.reason ? [`Reason: ${boundedField(data.reason)}`] : []),
		`Run: ${boundedField(data.runId)}`,
		`Agent: ${boundedField(data.agent)}`,
		`Child index: ${boundedField(data.childIndex)}`,
	];
	if (data.childTarget) lines.push(`Child target: ${boundedField(data.childTarget)}`);
	lines.push(`Reply to: ${requestId}`, "", "Reply:", displayText(data.message || "(empty reply)", MAX_BODY_CHARS, expanded));
	return lines;
}

function renderCard(lines: string[], heading: string, theme: Theme, width: number, expanded: boolean): string[] {
	const safeWidth = Math.max(0, Math.floor(width));
	if (safeWidth < 3) return [truncateToWidth(heading, safeWidth, "")];
	const bodyWidth = safeWidth - 2;
	const headerText = truncateToWidth(` ${heading} `, bodyWidth, "");
	const headerPadding = Math.max(0, bodyWidth - visibleWidth(headerText));
	const border = (text: string) => theme.fg("accent", text);
	const rendered = [border(`╭${headerText}${"─".repeat(headerPadding)}╮`)];
	let hidden = false;
	let interiorLines = 0;
	for (const line of lines) {
		const wrapped = wrapTextWithAnsi(line, Math.max(1, bodyWidth));
		for (const wrappedLine of wrapped.length > 0 ? wrapped : [""]) {
			if (!expanded && interiorLines >= MAX_RENDER_LINES) {
				hidden = true;
				break;
			}
			const text = truncateToWidth(wrappedLine, bodyWidth, "");
			rendered.push(border(`│${text}${" ".repeat(Math.max(0, bodyWidth - visibleWidth(text)))}│`));
			interiorLines++;
		}
		if (hidden) break;
	}
	if (hidden) {
		const text = truncateToWidth(TRUNCATION_MARKER, bodyWidth, "");
		rendered.push(border(`│${text}${" ".repeat(Math.max(0, bodyWidth - visibleWidth(text)))}│`));
	}
	rendered.push(border(`╰${"─".repeat(bodyWidth)}╯`));
	return rendered;
}

class SupervisorCardComponent implements Component {
	private readonly expanded: boolean;
	private readonly heading: string;
	private readonly lines: string[];
	private readonly theme: Theme;

	constructor(heading: string, lines: string[], theme: Theme, expanded: boolean) {
		this.expanded = expanded;
		this.heading = heading;
		this.lines = lines;
		this.theme = theme;
	}

	invalidate(): void {}

	render(width: number): string[] {
		return renderCard(this.lines, this.heading, this.theme, width, this.expanded);
	}
}

export function renderSupervisorRequest(
	message: SupervisorMessageLike,
	options: MessageRenderOptions,
	theme: Theme,
): Component | undefined {
	const details = requestDetails(message.details);
	if (!details) return undefined;
	return new SupervisorCardComponent(requestHeading(details.reason), requestLines(message, details, options.expanded), theme, options.expanded);
}

export function renderSupervisorReply(
	entry: SupervisorEntryLike,
	options: EntryRenderOptions,
	theme: Theme,
): Component | undefined {
	const data = replyData(entry.data);
	if (!data) return undefined;
	return new SupervisorCardComponent("↩ Supervisor reply to child", replyLines(data, options.expanded), theme, options.expanded);
}
