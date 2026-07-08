import type { ResolvedWatchdogConfig } from "./types.ts";

export const CHILD_WATCHDOG_CONFIG_ENV = "PI_SUBAGENT_WATCHDOG_CHILD_CONFIG";
export const CHILD_WATCHDOG_STATUS_EVENT = "subagent.watchdog.status";

export const CHILD_WATCHDOG_PHASES = ["idle", "reviewing", "autofollow", "settling", "stale", "failed"] as const;
export type ChildWatchdogPhase = typeof CHILD_WATCHDOG_PHASES[number];

export interface ChildWatchdogConfig {
	enabled: boolean;
	runId?: string;
	agent?: string;
	childIndex?: number;
	watchdogTailTimeoutMs: number;
	agentEndTimeoutMs: number;
	maxWarnings: number | null;
	model?: string;
	thinking?: string | false;
	autoFollowBlockers: boolean;
	autoFollowMaxAttempts: number | null;
	stalemateRepeats: number;
}

export interface ChildWatchdogStatusEvent {
	type: typeof CHILD_WATCHDOG_STATUS_EVENT;
	runId?: string;
	agent?: string;
	childIndex?: number;
	stepIndex?: number;
	seq: number;
	phase: ChildWatchdogPhase;
	ts: number;
	followUpPending: boolean;
	reason?: string;
}

export interface ChildWatchdogStateSnapshot {
	phase: ChildWatchdogPhase;
	seq: number;
	lastUpdate: number;
	followUpPending: boolean;
	reason?: string;
	timedOut?: boolean;
}

export function resolveChildWatchdogConfig(input: {
	config: ResolvedWatchdogConfig;
	agent?: string;
	runId?: string;
	childIndex?: number;
}): ChildWatchdogConfig | undefined {
	const override = input.agent ? input.config.children.overrides[input.agent] : undefined;
	const enabled = input.config.enabled && (override?.enabled ?? input.config.children.enabled);
	if (!enabled) return undefined;
	const model = override?.model ?? input.config.children.model;
	const thinking = override?.thinking ?? input.config.children.thinking;
	return {
		enabled: true,
		...(input.runId ? { runId: input.runId } : {}),
		...(input.agent ? { agent: input.agent } : {}),
		...(input.childIndex !== undefined ? { childIndex: input.childIndex } : {}),
		watchdogTailTimeoutMs: input.config.children.watchdogTailTimeoutMs,
		agentEndTimeoutMs: input.config.agentEndTimeoutMs,
		maxWarnings: input.config.maxWarnings,
		...(model ? { model } : {}),
		...(thinking !== undefined ? { thinking } : {}),
		autoFollowBlockers: input.config.children.autoFollow.blockers,
		autoFollowMaxAttempts: input.config.children.autoFollow.maxAttempts,
		stalemateRepeats: input.config.children.autoFollow.stalemateRepeats,
	};
}

export function encodeChildWatchdogConfig(config: ChildWatchdogConfig | undefined): string | undefined {
	return config ? JSON.stringify(config) : undefined;
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined;
}

function optionalIndex(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

export function decodeChildWatchdogConfig(raw: string | undefined): ChildWatchdogConfig | undefined {
	if (!raw) return undefined;
	const parsed = JSON.parse(raw) as Record<string, unknown>;
	if (!parsed || typeof parsed !== "object" || parsed.enabled !== true) return undefined;
	if (typeof parsed.watchdogTailTimeoutMs !== "number" || !Number.isInteger(parsed.watchdogTailTimeoutMs) || parsed.watchdogTailTimeoutMs < 1) {
		throw new Error("Invalid child watchdog config: watchdogTailTimeoutMs must be a positive integer.");
	}
	if (typeof parsed.agentEndTimeoutMs !== "number" || !Number.isInteger(parsed.agentEndTimeoutMs) || parsed.agentEndTimeoutMs < 1) {
		throw new Error("Invalid child watchdog config: agentEndTimeoutMs must be a positive integer.");
	}
	if (parsed.maxWarnings !== null && (typeof parsed.maxWarnings !== "number" || !Number.isInteger(parsed.maxWarnings) || parsed.maxWarnings < 0)) {
		throw new Error("Invalid child watchdog config: maxWarnings must be null or a non-negative integer.");
	}
	if (parsed.autoFollowMaxAttempts !== null && (typeof parsed.autoFollowMaxAttempts !== "number" || !Number.isInteger(parsed.autoFollowMaxAttempts) || parsed.autoFollowMaxAttempts < 0)) {
		throw new Error("Invalid child watchdog config: autoFollowMaxAttempts must be null or a non-negative integer.");
	}
	const runId = optionalString(parsed.runId);
	const agent = optionalString(parsed.agent);
	const childIndex = optionalIndex(parsed.childIndex);
	const model = optionalString(parsed.model);
	return {
		enabled: true,
		...(runId ? { runId } : {}),
		...(agent ? { agent } : {}),
		...(childIndex !== undefined ? { childIndex } : {}),
		watchdogTailTimeoutMs: parsed.watchdogTailTimeoutMs,
		agentEndTimeoutMs: parsed.agentEndTimeoutMs,
		maxWarnings: parsed.maxWarnings as number | null,
		...(model ? { model } : {}),
		...(typeof parsed.thinking === "string" || parsed.thinking === false ? { thinking: parsed.thinking as string | false } : {}),
		autoFollowBlockers: parsed.autoFollowBlockers === true,
		autoFollowMaxAttempts: parsed.autoFollowMaxAttempts as number | null,
		stalemateRepeats: typeof parsed.stalemateRepeats === "number" && Number.isInteger(parsed.stalemateRepeats) && parsed.stalemateRepeats >= 1 ? parsed.stalemateRepeats : 1,
	};
}

export function isChildWatchdogStatusEvent(value: unknown): value is ChildWatchdogStatusEvent {
	if (!value || typeof value !== "object") return false;
	const event = value as Partial<ChildWatchdogStatusEvent>;
	return event.type === CHILD_WATCHDOG_STATUS_EVENT
		&& typeof event.seq === "number"
		&& Number.isInteger(event.seq)
		&& event.seq >= 0
		&& typeof event.ts === "number"
		&& Number.isFinite(event.ts)
		&& typeof event.followUpPending === "boolean"
		&& typeof event.phase === "string"
		&& (CHILD_WATCHDOG_PHASES as readonly string[]).includes(event.phase);
}

export function childWatchdogIsActive(snapshot: ChildWatchdogStateSnapshot | undefined): boolean {
	if (!snapshot) return false;
	return snapshot.followUpPending || snapshot.phase === "reviewing" || snapshot.phase === "autofollow" || snapshot.phase === "settling";
}

export function acceptChildWatchdogEvent(input: {
	current: ChildWatchdogStateSnapshot | undefined;
	event: ChildWatchdogStatusEvent;
	runId?: string;
	agent?: string;
	childIndex?: number;
}): ChildWatchdogStateSnapshot | undefined {
	if (input.event.runId !== undefined && input.runId !== undefined && input.event.runId !== input.runId) return undefined;
	if (input.event.agent !== undefined && input.agent !== undefined && input.event.agent !== input.agent) return undefined;
	const eventIndex = input.event.childIndex ?? input.event.stepIndex;
	if (eventIndex !== undefined && input.childIndex !== undefined && eventIndex !== input.childIndex) return undefined;
	if (input.current && input.event.seq <= input.current.seq) return undefined;
	return {
		phase: input.event.phase,
		seq: input.event.seq,
		lastUpdate: input.event.ts,
		followUpPending: input.event.followUpPending,
		...(input.event.reason ? { reason: input.event.reason } : {}),
	};
}
