import type { ChildWatchdogProgress, ChildWatchdogWarningSummary } from "../shared/types.ts";
import { SUBAGENT_WATCHDOG_WARNING_TYPE, type ResolvedWatchdogConfig, type WatchdogCadenceConfig, type WatchdogCategory, type WatchdogLspConfig } from "./types.ts";

export const CHILD_WATCHDOG_WARNING_LIMIT = 20;

export const CHILD_WATCHDOG_STATUS_EVENT = "subagent.watchdog.status";

export const CHILD_WATCHDOG_PHASES = ["idle", "reviewing", "stale", "failed"] as const;
export type ChildWatchdogPhase = typeof CHILD_WATCHDOG_PHASES[number];

export interface ChildWatchdogConfig {
	runId?: string;
	agent?: string;
	childIndex?: number;
	watchdogTailTimeoutMs: number;
	agentEndTimeoutMs: number;
	maxWarnings: number | null;
	model?: string;
	thinking?: string | false;
	lsp: WatchdogLspConfig;
	stalemateRepeats: number;
	/** Mid-run review cadence; everyNTools null means boundary reviews only. */
	cadence: WatchdogCadenceConfig;
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
	reason?: string;
}

export type ChildWatchdogStateSnapshot = ChildWatchdogProgress;

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
	const cadence = override?.cadence ?? input.config.children.cadence ?? input.config.cadence;
	return {
		...(input.runId ? { runId: input.runId } : {}),
		...(input.agent ? { agent: input.agent } : {}),
		...(input.childIndex !== undefined ? { childIndex: input.childIndex } : {}),
		watchdogTailTimeoutMs: input.config.children.watchdogTailTimeoutMs,
		agentEndTimeoutMs: input.config.agentEndTimeoutMs,
		maxWarnings: input.config.maxWarnings,
		...(model ? { model } : {}),
		...(thinking !== undefined ? { thinking } : {}),
		lsp: { ...input.config.lsp },
		stalemateRepeats: input.config.stalemateRepeats,
		cadence: { everyNTools: cadence.everyNTools ?? null },
	};
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

function childConfigCadence(value: unknown): WatchdogCadenceConfig {
	const input = childConfigObject(value, "cadence");
	const everyNTools = input.everyNTools;
	if (everyNTools === null) return { everyNTools: null };
	if (typeof everyNTools === "number" && Number.isInteger(everyNTools) && everyNTools >= 5) return { everyNTools };
	throw new Error("Invalid child watchdog config: cadence.everyNTools must be null or an integer >= 5.");
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
	if ("enabled" in parsed && parsed.enabled !== true) throw new Error("Invalid child watchdog config: enabled must be true or false.");
	const thinking = parsed.thinking;
	if (thinking !== undefined && typeof thinking !== "string" && thinking !== false) {
		throw new Error("Invalid child watchdog config: thinking must be a string or false.");
	}
	const runId = childConfigOptionalString(parsed, "runId");
	const agent = childConfigOptionalString(parsed, "agent");
	const childIndex = childConfigOptionalIndex(parsed, "childIndex");
	const model = childConfigOptionalString(parsed, "model");
	return {
		...(runId ? { runId } : {}),
		...(agent ? { agent } : {}),
		...(childIndex !== undefined ? { childIndex } : {}),
		watchdogTailTimeoutMs: childConfigPositiveInteger(parsed, "watchdogTailTimeoutMs"),
		agentEndTimeoutMs: childConfigPositiveInteger(parsed, "agentEndTimeoutMs"),
		maxWarnings: childConfigNullableNonNegativeInteger(parsed, "maxWarnings"),
		...(model ? { model } : {}),
		...(thinking !== undefined ? { thinking: thinking as string | false } : {}),
		lsp: childConfigLsp(parsed.lsp),
		stalemateRepeats: childConfigPositiveInteger(parsed, "stalemateRepeats"),
		cadence: childConfigCadence(parsed.cadence),
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
		&& typeof event.phase === "string"
		&& (CHILD_WATCHDOG_PHASES as readonly string[]).includes(event.phase);
}

export function childWatchdogIsActive(snapshot: ChildWatchdogStateSnapshot | undefined): boolean {
	if (!snapshot) return false;
	return snapshot.phase === "reviewing";
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
		...(input.event.reason ? { reason: input.event.reason } : {}),
		...(input.current?.warnings?.length ? { warnings: input.current.warnings } : {}),
	};
}

function childWatchdogWarningFromMessage(message: unknown): ChildWatchdogWarningSummary | undefined {
	const candidate = message as { role?: unknown; customType?: unknown; details?: Record<string, unknown> } | undefined;
	if (candidate?.role !== "custom" || candidate.customType !== SUBAGENT_WATCHDOG_WARNING_TYPE) return undefined;
	const details = candidate.details ?? {};
	if (details.severity !== "concern" && details.severity !== "blocker") return undefined;
	if (typeof details.summary !== "string" || typeof details.evidence !== "string" || typeof details.recommendedAction !== "string") return undefined;
	return {
		severity: details.severity,
		category: details.category as WatchdogCategory,
		summary: details.summary,
		evidence: details.evidence,
		recommendedAction: details.recommendedAction,
		...(typeof details.displayedAt === "string" ? { displayedAt: details.displayedAt } : {}),
		addressed: false,
		stalemate: details.state === "stalemate",
	};
}

/** A watchdog warning message is appended; an assistant turn marks earlier warnings addressed. Undefined when unchanged. */
export function applyChildWatchdogMessage(current: ChildWatchdogStateSnapshot | undefined, message: unknown, now = Date.now()): ChildWatchdogStateSnapshot | undefined {
	const warning = childWatchdogWarningFromMessage(message);
	if (warning) {
		const warnings = [...(current?.warnings ?? []), warning].slice(-CHILD_WATCHDOG_WARNING_LIMIT);
		return current ? { ...current, warnings } : { phase: "idle", seq: 0, lastUpdate: now, warnings };
	}
	if ((message as { role?: unknown } | undefined)?.role !== "assistant" || !current?.warnings?.some((entry) => !entry.addressed)) return undefined;
	return { ...current, warnings: current.warnings.map((entry) => entry.addressed ? entry : { ...entry, addressed: true }) };
}

export function unresolvedChildWatchdogBlockers(progress: Pick<ChildWatchdogProgress, "warnings"> | undefined): ChildWatchdogWarningSummary[] {
	return (progress?.warnings ?? []).filter((warning) => warning.severity === "blocker" && (!warning.addressed || warning.stalemate));
}
