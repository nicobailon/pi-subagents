import type { ResolvedWatchdogConfig, WatchdogLspConfig } from "./types.ts";

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
	lsp: WatchdogLspConfig;
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
		lsp: { ...input.config.lsp },
		autoFollowBlockers: input.config.children.autoFollow.blockers,
		autoFollowMaxAttempts: input.config.children.autoFollow.maxAttempts,
		stalemateRepeats: input.config.children.autoFollow.stalemateRepeats,
	};
}

export function encodeChildWatchdogConfig(config: ChildWatchdogConfig | undefined): string | undefined {
	return config ? JSON.stringify(config) : undefined;
}

function childConfigObject(value: unknown, field: string): Record<string, unknown> {
	if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
	throw new Error(`Invalid child watchdog config: ${field} must be an object.`);
}

function childConfigOptionalString(input: Record<string, unknown>, field: string): string | undefined {
	if (!(field in input)) return undefined;
	const value = input[field];
	if (typeof value === "string" && value.trim()) return value;
	throw new Error(`Invalid child watchdog config: ${field} must be a non-empty string.`);
}

function childConfigOptionalIndex(input: Record<string, unknown>, field: string): number | undefined {
	if (!(field in input)) return undefined;
	const value = input[field];
	if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
	throw new Error(`Invalid child watchdog config: ${field} must be a non-negative integer.`);
}

function childConfigPositiveInteger(input: Record<string, unknown>, field: string): number {
	const value = input[field];
	if (typeof value === "number" && Number.isInteger(value) && value >= 1) return value;
	throw new Error(`Invalid child watchdog config: ${field} must be a positive integer.`);
}

function childConfigNullableNonNegativeInteger(input: Record<string, unknown>, field: string): number | null {
	const value = input[field];
	if (value === null) return null;
	if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
	throw new Error(`Invalid child watchdog config: ${field} must be null or a non-negative integer.`);
}

function childConfigBoolean(input: Record<string, unknown>, field: string): boolean {
	const value = input[field];
	if (typeof value === "boolean") return value;
	throw new Error(`Invalid child watchdog config: ${field} must be a boolean.`);
}

function childConfigLsp(value: unknown): WatchdogLspConfig {
	const input = childConfigObject(value, "lsp");
	if (typeof input.enabled !== "boolean") throw new Error("Invalid child watchdog config: lsp.enabled must be a boolean.");
	if (typeof input.timeoutMs !== "number" || !Number.isInteger(input.timeoutMs) || input.timeoutMs < 1) {
		throw new Error("Invalid child watchdog config: lsp.timeoutMs must be a positive integer.");
	}
	if (typeof input.maxFiles !== "number" || !Number.isInteger(input.maxFiles) || input.maxFiles < 1) {
		throw new Error("Invalid child watchdog config: lsp.maxFiles must be a positive integer.");
	}
	if (typeof input.maxDiagnostics !== "number" || !Number.isInteger(input.maxDiagnostics) || input.maxDiagnostics < 0) {
		throw new Error("Invalid child watchdog config: lsp.maxDiagnostics must be a non-negative integer.");
	}
	return {
		enabled: input.enabled,
		timeoutMs: input.timeoutMs,
		maxFiles: input.maxFiles,
		maxDiagnostics: input.maxDiagnostics,
	};
}

export function decodeChildWatchdogConfig(raw: string | undefined): ChildWatchdogConfig | undefined {
	if (!raw) return undefined;
	const parsed = childConfigObject(JSON.parse(raw), "root");
	if (parsed.enabled === false) return undefined;
	if (parsed.enabled !== true) throw new Error("Invalid child watchdog config: enabled must be true or false.");
	const thinking = parsed.thinking;
	if (thinking !== undefined && typeof thinking !== "string" && thinking !== false) {
		throw new Error("Invalid child watchdog config: thinking must be a string or false.");
	}
	const runId = childConfigOptionalString(parsed, "runId");
	const agent = childConfigOptionalString(parsed, "agent");
	const childIndex = childConfigOptionalIndex(parsed, "childIndex");
	const model = childConfigOptionalString(parsed, "model");
	return {
		enabled: true,
		...(runId ? { runId } : {}),
		...(agent ? { agent } : {}),
		...(childIndex !== undefined ? { childIndex } : {}),
		watchdogTailTimeoutMs: childConfigPositiveInteger(parsed, "watchdogTailTimeoutMs"),
		agentEndTimeoutMs: childConfigPositiveInteger(parsed, "agentEndTimeoutMs"),
		maxWarnings: childConfigNullableNonNegativeInteger(parsed, "maxWarnings"),
		...(model ? { model } : {}),
		...(thinking !== undefined ? { thinking: thinking as string | false } : {}),
		lsp: childConfigLsp(parsed.lsp),
		autoFollowBlockers: childConfigBoolean(parsed, "autoFollowBlockers"),
		autoFollowMaxAttempts: childConfigNullableNonNegativeInteger(parsed, "autoFollowMaxAttempts"),
		stalemateRepeats: childConfigPositiveInteger(parsed, "stalemateRepeats"),
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
	if (input.runId !== undefined && input.event.runId !== input.runId) return undefined;
	if (input.agent !== undefined && input.event.agent !== input.agent) return undefined;
	const eventIndex = input.event.childIndex ?? input.event.stepIndex;
	if (input.childIndex !== undefined && eventIndex !== input.childIndex) return undefined;
	if (input.current && input.event.seq <= input.current.seq) return undefined;
	return {
		phase: input.event.phase,
		seq: input.event.seq,
		lastUpdate: input.event.ts,
		followUpPending: input.event.followUpPending,
		...(input.event.reason ? { reason: input.event.reason } : {}),
	};
}
