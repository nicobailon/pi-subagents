import { getMarkdownTheme, keyText, type Theme, type ThemeColor } from "@earendil-works/pi-coding-agent";
import { Box, Container, Markdown, MouseRegion, Spacer, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { SUBAGENT_CONTROL_MESSAGE_TYPE } from "../extension/control-notices.ts";
import { SUBAGENT_STEERING_MESSAGE_TYPE } from "../extension/steering-notices.ts";
import { parseSupervisorReplyData, parseSupervisorRequestDetails, SUPERVISOR_REPLY_ENTRY_TYPE, SUPERVISOR_REQUEST_MESSAGE_TYPE } from "../intercom/supervisor-ui.ts";
import { parseSubagentNotifyContent } from "../runs/background/notify.ts";
import { safeTerminalText } from "../shared/display-text.ts";
import { formatWatchdogWarningRenderText, stateLabels } from "../watchdog/render.ts";
import { SUBAGENT_WATCHDOG_WARNING_TYPE, WATCHDOG_WARNING_IMPORTANCES, WATCHDOG_WARNING_SEVERITIES, type WatchdogWarning } from "../watchdog/types.ts";
import { normalizeWatchdogWarningDetails } from "../watchdog/warning-format.ts";

interface SubagentMessage {
	customType: string;
	content: unknown;
	details?: unknown;
}

interface SubagentEntry {
	customType: string;
	data?: unknown;
}

/** Plain text, plus status words that take the theme's status color. */
type Headline = ReadonlyArray<string | { status: string }>;

type MessageKind = "ask" | "reply" | "result" | "attention" | "watchdog";

/**
 * Theme colors for the label. Pi's themes offer few non-status colors that read
 * apart, so asks and attention notices, both a child needing the parent, share one,
 * and replies, the parent's own words, take the quiet text color.
 */
const KIND_LABEL_COLORS = {
	ask: "customMessageLabel",
	attention: "customMessageLabel",
	reply: "customMessageText",
	result: "mdLink",
	watchdog: "toolTitle",
} as const satisfies Record<MessageKind, ThemeColor>;

interface BlockView {
	kind: MessageKind;
	headline: Headline;
	/** Markdown shown when the block is expanded. */
	body: string;
}

type StatusTone = "success" | "error" | "warning";

/** A Map, so a status word read from session data never resolves to an Object prototype key. */
const STATUS_TONES = new Map<string, StatusTone>([
	["completed", "success"],
	["failed", "error"],
	["partial", "error"],
	["blocked", "error"],
	["unhandled", "error"],
	["blocker", "error"],
	["save failed", "error"],
	["reconciliation failed", "error"],
	["could not be reconciled", "error"],
	["paused", "warning"],
	["stopped", "warning"],
	["recovered", "warning"],
	["unanswered", "warning"],
	["concern", "warning"],
	["timed out", "warning"],
	["needs attention", "warning"],
	["needs a decision", "warning"],
	["needs clarification", "warning"],
	["asks for structured answers", "warning"],
]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The text Pi sends to the model for a custom message. */
function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.flatMap((part: unknown) => isRecord(part) && typeof part.text === "string" ? [part.text] : []).join("\n");
}

/** A message that expands to the text the main agent read. */
function readsContent(kind: MessageKind, headline: (message: SubagentMessage) => Headline): (message: SubagentMessage) => BlockView {
	return (message) => ({ kind, headline: headline(message), body: contentText(message.content) });
}

function supervisorRequestHeadline(details: unknown): Headline {
	const request = parseSupervisorRequestDetails(details);
	if (!request?.agent) return ["supervisor request"];
	if (request.reason === "interview_request") return [`${request.agent} `, { status: "asks for structured answers" }];
	if (request.reason === "progress_update") return [`${request.agent} sent a progress update`];
	return [`${request.agent} `, { status: "needs a decision" }];
}

function controlNoticeHeadline(details: unknown): Headline {
	const event = isRecord(details) ? details.event : undefined;
	if (!isRecord(event) || typeof event.agent !== "string" || typeof event.type !== "string") return ["subagent notice"];
	if (event.type === "needs_attention") return [`${event.agent} `, { status: "needs attention" }];
	return [`${event.agent} ${event.type.replaceAll("_", " ")}`];
}

function steeringNoticeHeadline(details: unknown): Headline {
	if (!isRecord(details) || typeof details.runId !== "string") return ["steering notice"];
	const { state } = details;
	if (state !== "failed" && state !== "partial" && state !== "recovered") return ["steering notice"];
	return [`steering for run ${details.runId} `, { status: state }];
}

const RUN_STATUSES = ["completed", "failed", "paused", "stopped"] as const;
type RunStatus = typeof RUN_STATUSES[number];

function isRunStatus(value: unknown): value is RunStatus {
	return RUN_STATUSES.some((status) => status === value);
}

/** Agents and outcomes of a completion notice; notices saved before render details existed are read from their text. */
function completionRuns(message: SubagentMessage): Array<{ agent: string; status: RunStatus }> | undefined {
	const runs = isRecord(message.details) ? message.details.runs : undefined;
	if (Array.isArray(runs)) {
		const parsed = runs.flatMap((run: unknown) => isRecord(run) && typeof run.agent === "string" && isRunStatus(run.status) ? [{ agent: run.agent, status: run.status }] : []);
		if (parsed.length === runs.length && parsed.length > 0) return parsed;
	}
	const saved = parseSubagentNotifyContent(contentText(message.content));
	return saved ? [{ agent: saved.agent, status: saved.status }] : undefined;
}

function completionHeadline(message: SubagentMessage): Headline {
	const runs = completionRuns(message);
	if (runs?.length === 1) return [`${runs[0]!.agent} `, { status: runs[0]!.status }];
	if (runs) {
		if (runs.every((run) => run.status === "completed")) return [`${runs.length} background runs `, { status: "completed" }];
		const counts = (["failed", "paused", "stopped"] as const).flatMap((status) => {
			const count = runs.filter((run) => run.status === status).length;
			return count ? [` · ${count} `, { status }] : [];
		});
		return [`${runs.length} background runs finished`, ...counts];
	}
	const grouped = /^Background tasks completed \((\d+)\):/.exec(contentText(message.content));
	return grouped ? [`${grouped[1]} background runs finished`] : ["background run finished"];
}

function supervisorReminderHeadline(details: unknown, status: "unanswered" | "blocked"): Headline {
	const ids = isRecord(details) ? details.requestIds : undefined;
	if (!Array.isArray(ids) || ids.length === 0) return ["supervisor requests ", { status }];
	return [`${ids.length} supervisor ${ids.length === 1 ? "request" : "requests"} `, { status }];
}

function waitSubscriptionHeadline(details: unknown): Headline {
	if (!isRecord(details) || typeof details.runId !== "string" || typeof details.outcome !== "string") return ["bg_wait fired"];
	return [`bg_wait: run ${details.runId} `, { status: details.outcome }];
}

/** Workflow child notices saved before render details existed are read from their first line. */
function workflowChildHeadline(message: SubagentMessage): Headline {
	const { details } = message;
	if (isRecord(details) && typeof details.childKey === "string" && isRunStatus(details.outcome)) {
		return [`workflow child ${details.childKey} `, { status: details.outcome }];
	}
	const saved = /^Workflow child (completed|failed|paused|stopped)(?: \(needs attention\))?: \*\*(.+)\*\*$/m.exec(contentText(message.content));
	return saved ? [`workflow child ${saved[2]} `, { status: saved[1]! }] : ["workflow child update"];
}

function isWatchdogWarning(value: unknown): value is WatchdogWarning {
	if (!isRecord(value)) return false;
	return WATCHDOG_WARNING_SEVERITIES.some((known) => known === value.severity)
		&& WATCHDOG_WARNING_IMPORTANCES.some((known) => known === value.importance)
		&& (value.category === undefined || typeof value.category === "string")
		&& typeof value.summary === "string"
		&& typeof value.evidence === "string"
		&& typeof value.recommendedAction === "string";
}

/** The model reads watchdog warnings as XML; people get the watchdog's readable text. */
function watchdogWarningView(details: unknown, fallbackBody: string): BlockView {
	if (!isWatchdogWarning(details)) return { kind: "watchdog", headline: ["watchdog warning"], body: fallbackBody };
	// Every shown warning is "displayed"; the other labels say the run was held or the review went wrong.
	const labels = stateLabels(details).filter((label) => label !== "displayed");
	return {
		kind: "watchdog",
		headline: ["watchdog ", { status: details.severity }, ...(labels.length ? [` · ${labels.join(", ")}`] : [])],
		body: formatWatchdogWarningRenderText(normalizeWatchdogWarningDetails(details)),
	};
}

function supervisorReplyView(data: unknown): BlockView {
	const reply = parseSupervisorReplyData(data);
	if (!reply) return { kind: "reply", headline: ["supervisor reply"], body: "" };
	return {
		kind: "reply",
		headline: [`reply sent to ${reply.agent}`],
		body: [
			`Request: ${reply.requestId}`,
			`Run: ${reply.runId}`,
			`Child index: ${reply.childIndex}`,
			...(reply.childTarget ? [`Child target: ${reply.childTarget}`] : []),
			"",
			reply.message,
		].join("\n"),
	};
}

const MESSAGE_VIEWS = new Map<string, (message: SubagentMessage) => BlockView>([
	[SUPERVISOR_REQUEST_MESSAGE_TYPE, readsContent("ask", (message) => supervisorRequestHeadline(message.details))],
	["subagent-supervisor-unanswered", readsContent("ask", (message) => supervisorReminderHeadline(message.details, "unanswered"))],
	["subagent-supervisor-blocked", readsContent("ask", (message) => supervisorReminderHeadline(message.details, "blocked"))],
	["subagent-notify", readsContent("result", completionHeadline)],
	["subagent-completion-unanswered", readsContent("result", () => ["completion results ", { status: "unanswered" }])],
	["subagent-completion-unhandled", readsContent("result", () => ["completion results ", { status: "unhandled" }])],
	["subagent-wait-subscription", readsContent("result", (message) => waitSubscriptionHeadline(message.details))],
	["subagent-incremental-child-notify", readsContent("result", workflowChildHeadline)],
	["subagent-workflow-result-write-failed", readsContent("result", () => ["workflow result ", { status: "save failed" }])],
	[SUBAGENT_CONTROL_MESSAGE_TYPE, readsContent("attention", (message) => controlNoticeHeadline(message.details))],
	[SUBAGENT_STEERING_MESSAGE_TYPE, readsContent("attention", (message) => steeringNoticeHeadline(message.details))],
	[SUBAGENT_WATCHDOG_WARNING_TYPE, (message) => watchdogWarningView(message.details, contentText(message.content))],
	["subagent_watchdog_clarification", readsContent("watchdog", () => ["watchdog ", { status: "needs clarification" }])],
]);

const ENTRY_VIEWS = new Map<string, (entry: SubagentEntry) => BlockView>([
	[SUPERVISOR_REPLY_ENTRY_TYPE, (entry) => supervisorReplyView(entry.data)],
	[SUBAGENT_WATCHDOG_WARNING_TYPE, (entry) => watchdogWarningView(entry.data, "")],
]);

/** Every message type pi-subagents shows in the main chat. */
export const SUBAGENT_MESSAGE_TYPES: readonly string[] = [...MESSAGE_VIEWS.keys()];

/** Every session entry type pi-subagents shows in the main chat. */
export const SUBAGENT_ENTRY_TYPES: readonly string[] = [...ENTRY_VIEWS.keys()];

function headlineText(headline: Headline, theme: Theme): string {
	let text = "";
	let plain = "";
	for (const part of headline) {
		const word = typeof part === "string" ? part : part.status;
		const tone = typeof part === "string" ? undefined : STATUS_TONES.get(part.status);
		if (!tone) {
			plain += word;
			continue;
		}
		if (plain) text += theme.fg("customMessageText", safeTerminalText(plain));
		plain = "";
		text += theme.fg(tone, word);
	}
	return plain ? text + theme.fg("customMessageText", safeTerminalText(plain)) : text;
}

function oneLine(text: string): Component {
	return {
		render: (width) => [truncateToWidth(text, width, "…")],
		invalidate() {},
	};
}

/**
 * A click toggles one block until Pi's expand key changes the state of every
 * block. Keyed by the message or entry object, which Pi keeps across rebuilds.
 */
const clickedBlocks = new WeakMap<SubagentMessage | SubagentEntry, { expandedByPi: boolean; expanded: boolean }>();

/** The block Pi draws for its own [skill] and [compaction] messages. */
class SubagentMessageBlock extends Box {
	private readonly source: SubagentMessage | SubagentEntry;
	private readonly view: BlockView;
	private readonly expandedByPi: boolean;
	private readonly theme: Theme;

	constructor(source: SubagentMessage | SubagentEntry, view: BlockView, expandedByPi: boolean, theme: Theme) {
		super(1, 1, (text) => theme.bg("customMessageBg", text));
		this.source = source;
		this.view = view;
		this.expandedByPi = expandedByPi;
		this.theme = theme;
		const clicked = clickedBlocks.get(source);
		if (clicked && clicked.expandedByPi !== expandedByPi) clickedBlocks.delete(source);
		this.rebuild();
	}

	private isExpanded(): boolean {
		return clickedBlocks.get(this.source)?.expanded ?? this.expandedByPi;
	}

	private rebuild(): void {
		const { theme, view } = this;
		const content = new Container();
		const title = `${theme.fg(KIND_LABEL_COLORS[view.kind], theme.bold("[subagent]"))} ${headlineText(view.headline, theme)}`;
		const expanded = this.isExpanded();
		content.addChild(oneLine(expanded ? title : `${title} ${theme.fg("dim", `(${keyText("app.tools.expand") || "click"} to expand)`)}`));
		if (expanded && view.body.trim()) {
			content.addChild(new Spacer(1));
			content.addChild(new Markdown(safeTerminalText(view.body), 0, 0, getMarkdownTheme(), { color: (text) => theme.fg("customMessageText", text) }));
		}
		this.clear();
		this.addChild(new MouseRegion(content, (event) => {
			if (event.type !== "click" || event.button !== "left") return undefined;
			clickedBlocks.set(this.source, { expandedByPi: this.expandedByPi, expanded: !this.isExpanded() });
			this.rebuild();
			return { handled: true };
		}));
	}
}

export function renderSubagentMessage(message: SubagentMessage, options: { expanded: boolean }, theme: Theme): Component | undefined {
	const view = MESSAGE_VIEWS.get(message.customType)?.(message);
	return view ? new SubagentMessageBlock(message, view, options.expanded, theme) : undefined;
}

export function renderSubagentEntry(entry: SubagentEntry, options: { expanded: boolean }, theme: Theme): Component | undefined {
	const view = ENTRY_VIEWS.get(entry.customType)?.(entry);
	return view ? new SubagentMessageBlock(entry, view, options.expanded, theme) : undefined;
}
