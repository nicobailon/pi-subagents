import {
	type ActivityState,
	type ControlConfig,
	type ControlEvent,
	type ControlEventType,
	type ControlNotificationChannel,
	type ResolvedControlConfig,
} from "../../shared/types.ts";
import { isToolTimeoutExempt } from "./tool-timeout.ts";
import { createHash } from "node:crypto";
import { previewDisplayText } from "../../shared/display-text.ts";

const CONTROL_EVENT_TYPES: ControlEventType[] = ["active_long_running", "needs_attention"];
const CONTROL_NOTIFICATION_CHANNELS: ControlNotificationChannel[] = ["event", "async", "intercom"];
const DEFAULT_NOTIFY_ON: ControlEventType[] = ["active_long_running", "needs_attention"];

export const DEFAULT_CONTROL_CONFIG: ResolvedControlConfig = {
	enabled: true,
	needsAttentionAfterMs: 60_000,
	needsAttentionAfterMsIsExplicit: false,
	activeNoticeAfterMs: 240_000,
	failedToolAttemptsBeforeAttention: 3,
	notifyOn: DEFAULT_NOTIFY_ON,
	notifyChannels: CONTROL_NOTIFICATION_CHANNELS,
};

function parsePositiveInt(value: unknown): number | undefined {
	if (typeof value !== "number") return undefined;
	if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1) return undefined;
	return value;
}

function parseControlList<T extends string>(value: unknown, allowed: readonly T[]): T[] | undefined {
	if (!Array.isArray(value)) return undefined;
	if (value.length === 0) return [];
	const allowedSet = new Set(allowed);
	const parsed = value.filter((entry): entry is T => typeof entry === "string" && allowedSet.has(entry as T));
	return parsed.length > 0 ? Array.from(new Set(parsed)) : undefined;
}

export function resolveControlConfig(
	globalConfig?: ControlConfig,
	override?: ControlConfig,
): ResolvedControlConfig {
	const enabled = override?.enabled ?? globalConfig?.enabled ?? DEFAULT_CONTROL_CONFIG.enabled;
	const overrideNeedsAttentionAfterMs = parsePositiveInt(override?.needsAttentionAfterMs);
	const globalNeedsAttentionAfterMs = parsePositiveInt(globalConfig?.needsAttentionAfterMs);
	const needsAttentionAfterMs = overrideNeedsAttentionAfterMs
		?? globalNeedsAttentionAfterMs
		?? DEFAULT_CONTROL_CONFIG.needsAttentionAfterMs;
	const needsAttentionAfterMsIsExplicit = overrideNeedsAttentionAfterMs !== undefined
		|| globalNeedsAttentionAfterMs !== undefined;
	const activeNoticeAfterMs = parsePositiveInt(override?.activeNoticeAfterMs)
		?? parsePositiveInt(globalConfig?.activeNoticeAfterMs)
		?? DEFAULT_CONTROL_CONFIG.activeNoticeAfterMs;
	const activeNoticeAfterTurns = parsePositiveInt(override?.activeNoticeAfterTurns)
		?? parsePositiveInt(globalConfig?.activeNoticeAfterTurns);
	const activeNoticeAfterTokens = parsePositiveInt(override?.activeNoticeAfterTokens)
		?? parsePositiveInt(globalConfig?.activeNoticeAfterTokens);
	const failedToolAttemptsBeforeAttention = parsePositiveInt(override?.failedToolAttemptsBeforeAttention)
		?? parsePositiveInt(globalConfig?.failedToolAttemptsBeforeAttention)
		?? DEFAULT_CONTROL_CONFIG.failedToolAttemptsBeforeAttention;
	const notifyOn = parseControlList(override?.notifyOn, CONTROL_EVENT_TYPES)
		?? parseControlList(globalConfig?.notifyOn, CONTROL_EVENT_TYPES)
		?? DEFAULT_CONTROL_CONFIG.notifyOn;
	const notifyChannels = parseControlList(override?.notifyChannels, CONTROL_NOTIFICATION_CHANNELS)
		?? parseControlList(globalConfig?.notifyChannels, CONTROL_NOTIFICATION_CHANNELS)
		?? DEFAULT_CONTROL_CONFIG.notifyChannels;
	return {
		enabled,
		needsAttentionAfterMs,
		needsAttentionAfterMsIsExplicit,
		activeNoticeAfterMs,
		activeNoticeAfterTurns,
		activeNoticeAfterTokens,
		failedToolAttemptsBeforeAttention,
		notifyOn: [...notifyOn],
		notifyChannels: [...notifyChannels],
	};
}

function scaledNeedsAttentionAfterMs(config: ResolvedControlConfig, thinking?: string | false): number {
	if (config.needsAttentionAfterMsIsExplicit !== false) return config.needsAttentionAfterMs;
	switch (thinking) {
		case "medium":
			return config.needsAttentionAfterMs * 2;
		case "high":
			return config.needsAttentionAfterMs * 5;
		case "xhigh":
		case "max":
			return config.needsAttentionAfterMs * 10;
		default:
			return config.needsAttentionAfterMs;
	}
}

export function deriveActivityState(input: {
	config: ResolvedControlConfig;
	startedAt: number;
	lastActivityAt?: number;
	currentTool?: string;
	thinking?: string | false;
	now?: number;
}): ActivityState | undefined {
	if (!input.config.enabled || input.currentTool) return undefined;
	const now = input.now ?? Date.now();
	const lastActivity = input.lastActivityAt ?? input.startedAt;
	const ageMs = Math.max(0, now - lastActivity);
	return ageMs > scaledNeedsAttentionAfterMs(input.config, input.thinking) ? "needs_attention" : undefined;
}

export function shouldEmitOpenToolAttention(input: {
	config: ResolvedControlConfig;
	currentTool?: string;
	currentToolStartedAt?: number;
	now?: number;
}): boolean {
	if (!input.config.enabled || !input.currentTool || input.currentToolStartedAt === undefined) return false;
	if (isToolTimeoutExempt(input.currentTool)) return false;
	const now = input.now ?? Date.now();
	return Math.max(0, now - input.currentToolStartedAt) >= input.config.activeNoticeAfterMs;
}

export function buildControlEvent(input: {
	type?: ControlEventType;
	from?: ActivityState;
	to: ActivityState;
	runId: string;
	agent: string;
	index?: number;
	ts?: number;
	lastActivityAt?: number;
	message?: string;
	reason?: ControlEvent["reason"];
	turns?: number;
	tokens?: number;
	toolCount?: number;
	currentTool?: string;
	currentToolDurationMs?: number;
	currentPath?: string;
	elapsedMs?: number;
	recentFailureSummary?: string;
	workflowKey?: string;
	phase?: string;
	label?: string;
	taskPreview?: string;
}): ControlEvent {
	const ts = input.ts ?? Date.now();
	const type = input.type ?? (input.to === "active_long_running" ? "active_long_running" : "needs_attention");
	const elapsedMs = input.elapsedMs ?? (input.lastActivityAt ? Math.max(0, ts - input.lastActivityAt) : undefined);
	const elapsedSeconds = elapsedMs !== undefined ? Math.floor(elapsedMs / 1000) : undefined;
	const message = input.message ?? (type === "active_long_running"
		? `${input.agent} is still active but long-running`
		: elapsedSeconds !== undefined
			? `${input.agent} needs attention (no observed activity for ${elapsedSeconds}s)`
			: `${input.agent} needs attention`);
	return {
		type,
		...(input.from ? { from: input.from } : {}),
		to: input.to,
		ts,
		runId: input.runId,
		agent: input.agent,
		...(input.index !== undefined ? { index: input.index } : {}),
		message,
		reason: input.reason ?? (type === "active_long_running" ? "active_long_running" : "idle"),
		...(input.turns !== undefined ? { turns: input.turns } : {}),
		...(input.tokens !== undefined ? { tokens: input.tokens } : {}),
		...(input.toolCount !== undefined ? { toolCount: input.toolCount } : {}),
		...(input.currentTool ? { currentTool: input.currentTool } : {}),
		...(input.currentToolDurationMs !== undefined ? { currentToolDurationMs: input.currentToolDurationMs } : {}),
		...(input.currentPath ? { currentPath: input.currentPath } : {}),
		...(elapsedMs !== undefined ? { elapsedMs } : {}),
		...(input.recentFailureSummary ? { recentFailureSummary: input.recentFailureSummary } : {}),
		...(input.workflowKey ? { workflowKey: input.workflowKey } : {}),
		...(input.phase ? { phase: input.phase } : {}),
		...(input.label ? { label: input.label } : {}),
		...(input.taskPreview ? { taskPreview: previewDisplayText(input.taskPreview, 160) } : {}),
	};
}

export function shouldNotifyControlEvent(config: ResolvedControlConfig, event: ControlEvent): boolean {
	return config.enabled && config.notifyOn.includes(event.type);
}

export function controlNotificationKey(event: ControlEvent, childIntercomTarget?: string): string {
	const childKey = childIntercomTarget ?? (event.index !== undefined ? `${event.runId}:${event.index}` : event.runId);
	const contextHash = createHash("sha256").update(formatControlNudge(event)).digest("hex").slice(0, 8);
	return `${childKey}:${event.type}:${event.reason ?? "idle"}:${contextHash}`;
}

export function claimControlNotification(config: ResolvedControlConfig, event: ControlEvent, seenKeys: Set<string>, childIntercomTarget?: string): boolean {
	if (!shouldNotifyControlEvent(config, event)) return false;
	const key = controlNotificationKey(event, childIntercomTarget);
	if (seenKeys.has(key)) return false;
	seenKeys.add(key);
	return true;
}

function formatLongRunningFacts(event: ControlEvent): string | undefined {
	const facts: string[] = [];
	if (event.elapsedMs !== undefined) facts.push(`elapsed ${Math.floor(Math.max(0, event.elapsedMs) / 1000)}s`);
	if (event.turns !== undefined) facts.push(`${event.turns} turns`);
	if (event.tokens !== undefined) facts.push(`${event.tokens} tokens`);
	if (event.toolCount !== undefined) facts.push(`${event.toolCount} tools`);
	if (event.currentTool) facts.push(`tool ${event.currentTool}${event.currentToolDurationMs !== undefined ? ` ${Math.floor(Math.max(0, event.currentToolDurationMs) / 1000)}s` : ""}`);
	if (event.currentPath) facts.push(`path ${event.currentPath}`);
	return facts.length > 0 ? facts.join(" | ") : undefined;
}

export function formatControlNudge(event: ControlEvent): string {
	const scope = event.label ?? event.phase ?? event.workflowKey ?? event.taskPreview;
	if (event.recentFailureSummary) return previewDisplayText(`Resolve the recent failure${scope ? ` for ${scope}` : ""}: ${event.recentFailureSummary}. Report the smallest next step or ask for a decision.`, 160);
	if (event.currentTool || event.currentPath) {
		const current = [event.currentTool ? `tool ${event.currentTool}` : undefined, event.currentPath ? `path ${event.currentPath}` : undefined].filter(Boolean).join(" at ");
		return previewDisplayText(`Check ${current}${scope ? ` for ${scope}` : ""}. Report the smallest next step or ask for a decision.`, 160);
	}
	if (scope) return previewDisplayText(`Continue ${scope}. Report the smallest next step or ask for a decision.`, 160);
	return "What are you blocked on? Reply with the smallest next step or ask for a decision.";
}

export function formatControlNoticeMessage(event: ControlEvent, childIntercomTarget?: string): string {
	const runTarget = event.runId;
	if (event.reason === "completion_guard") {
		return [
			`Subagent failed: ${event.agent}`,
			`Run: ${runTarget}${event.index !== undefined ? ` step ${event.index + 1}` : ""}`,
			`Signal: ${event.message}`,
			"Next: read the output artifact or session from the subagent result, then retry with a more explicit implementation prompt or handle the fix directly.",
			childIntercomTarget ? `Run intercom target (may be inactive): ${childIntercomTarget}` : undefined,
		].filter((line): line is string => Boolean(line)).join("\n");
	}

	const nudgeMessage = formatControlNudge(event);
	const steerCommand = `subagent({ action: "steer", id: "${runTarget}", ${event.index !== undefined ? `index: ${event.index}, ` : ""}message: ${JSON.stringify(nudgeMessage)} })`;
	const nestedResumeCommand = `subagent({ action: "resume", id: "${runTarget}", message: ${JSON.stringify(nudgeMessage)} })`;
	if (event.type === "active_long_running") {
		const facts = formatLongRunningFacts(event);
		return [
			`Subagent active but long-running: ${event.agent}`,
			`Run: ${runTarget}${event.index !== undefined ? ` step ${event.index + 1}` : ""}`,
			`Signal: ${event.message}`,
			facts ? `Facts: ${facts}` : undefined,
			"Hint: Inspect status first. Use steer for a top-level live async child, routed resume for a live nested child, or resume to revive a paused/completed/failed child.",
			`Top-level live async nudge: ${steerCommand}`,
			`Routed live nested nudge: ${nestedResumeCommand}`,
			childIntercomTarget ? `Direct intercom target: ${childIntercomTarget}` : undefined,
			`Status: subagent({ action: "status", id: "${runTarget}" })`,
			`Interrupt: subagent({ action: "interrupt", id: "${runTarget}" })`,
		].filter((line): line is string => Boolean(line)).join("\n");
	}

	const supervisorHint = event.reason === "supervisor_request"
		? "Supervisor request: reply to the pending request. If subagent_supervisor pending is empty, check intercom pending because an external intercom tool may own the request."
		: undefined;
	const facts = formatLongRunningFacts(event);
	return [
		`Subagent needs attention: ${event.agent}`,
		`Run: ${runTarget}${event.index !== undefined ? ` step ${event.index + 1}` : ""}`,
		`Signal: ${event.message}`,
		facts ? `Facts: ${facts}` : undefined,
		event.recentFailureSummary ? `Recent failures: ${event.recentFailureSummary}` : undefined,
		supervisorHint,
		"Hint: Inspect status first unless the run is clearly blocked. Use steer for a top-level live async child, routed resume for a live nested child, or resume to revive a paused/completed/failed child.",
		`Top-level live async nudge: ${steerCommand}`,
		`Routed live nested nudge: ${nestedResumeCommand}`,
		childIntercomTarget ? `Direct intercom target: ${childIntercomTarget}` : undefined,
		`Status: subagent({ action: "status", id: "${runTarget}" })`,
		`Interrupt: subagent({ action: "interrupt", id: "${runTarget}" })`,
	].filter((line): line is string => Boolean(line)).join("\n");
}

export function formatControlIntercomMessage(event: ControlEvent, childIntercomTarget?: string): string {
	const statusLabel = event.reason === "completion_guard"
		? "subagent failed"
		: event.type === "active_long_running"
			? "subagent active but long-running"
			: "subagent needs attention";
	return [
		statusLabel,
		"",
		event.reason === "completion_guard"
			? `${event.agent} failed in run ${event.runId}.`
			: event.type === "active_long_running"
				? `${event.agent} is still active but long-running in run ${event.runId}.`
				: `${event.agent} needs attention in run ${event.runId}.`,
		"",
		formatControlNoticeMessage(event, childIntercomTarget),
	].join("\n");
}
