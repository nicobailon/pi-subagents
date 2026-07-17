import {
	type ActivityState,
	type ControlConfig,
	type ControlEvent,
	type ControlEventType,
	type ControlNotificationChannel,
	type ResolvedControlConfig,
} from "../../shared/types.ts";

const CONTROL_EVENT_TYPES: ControlEventType[] = ["active_long_running", "needs_attention"];
const CONTROL_NOTIFICATION_CHANNELS: ControlNotificationChannel[] = ["event", "async", "intercom"];
const DEFAULT_NOTIFY_ON: ControlEventType[] = ["active_long_running", "needs_attention"];

export const DEFAULT_CONTROL_CONFIG: ResolvedControlConfig = {
	enabled: true,
	needsAttentionAfterMs: 60_000,
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
	const needsAttentionAfterMs = parsePositiveInt(override?.needsAttentionAfterMs)
		?? parsePositiveInt(globalConfig?.needsAttentionAfterMs)
		?? DEFAULT_CONTROL_CONFIG.needsAttentionAfterMs;
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
		activeNoticeAfterMs,
		activeNoticeAfterTurns,
		activeNoticeAfterTokens,
		failedToolAttemptsBeforeAttention,
		notifyOn: [...notifyOn],
		notifyChannels: [...notifyChannels],
	};
}

export function deriveActivityState(input: {
	config: ResolvedControlConfig;
	startedAt: number;
	lastActivityAt?: number;
	currentTool?: string;
	now?: number;
}): ActivityState | undefined {
	if (!input.config.enabled || input.currentTool) return undefined;
	const now = input.now ?? Date.now();
	const lastActivity = input.lastActivityAt ?? input.startedAt;
	const ageMs = Math.max(0, now - lastActivity);
	return ageMs > input.config.needsAttentionAfterMs ? "needs_attention" : undefined;
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
	};
}

export function shouldNotifyControlEvent(config: ResolvedControlConfig, event: ControlEvent): boolean {
	return config.enabled && config.notifyOn.includes(event.type);
}

export function controlNotificationKey(event: ControlEvent, childIntercomTarget?: string): string {
	const childKey = childIntercomTarget ?? (event.index !== undefined ? `${event.runId}:${event.index}` : event.runId);
	return `${childKey}:${event.type}:${event.reason ?? "idle"}`;
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

	const nudgeMessage = "What are you blocked on? Reply with the smallest next step or ask for a decision.";
	const steerCommand = `subagent({ action: "steer", id: "${runTarget}", ${event.index !== undefined ? `index: ${event.index}, ` : ""}message: "${nudgeMessage}" })`;
	const nestedResumeCommand = `subagent({ action: "resume", id: "${runTarget}", message: "${nudgeMessage}" })`;
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

	return [
		`Subagent needs attention: ${event.agent}`,
		`Run: ${runTarget}${event.index !== undefined ? ` step ${event.index + 1}` : ""}`,
		`Signal: ${event.message}`,
		event.recentFailureSummary ? `Recent failures: ${event.recentFailureSummary}` : undefined,
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
