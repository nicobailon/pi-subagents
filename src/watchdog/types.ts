export const SUBAGENT_WATCHDOG_WARNING_TYPE = "subagent_watchdog_warning";

export const WATCHDOG_WARNING_SEVERITIES = ["concern", "blocker"] as const;
export type WatchdogSeverity = typeof WATCHDOG_WARNING_SEVERITIES[number];

export const WATCHDOG_WARNING_CATEGORIES = [
	"correctness",
	"missed-constraint",
	"test-gap",
	"unsafe-change",
	"scope-drift",
	"stale-fact",
	"loop-risk",
	"other",
] as const;
export type WatchdogCategory = typeof WATCHDOG_WARNING_CATEGORIES[number];

export const WATCHDOG_WARNING_CONFIDENCES = ["medium", "high"] as const;
export type WatchdogConfidence = typeof WATCHDOG_WARNING_CONFIDENCES[number];

export const WATCHDOG_WARNING_SOURCES = ["main", "child", "async-completion", "lsp"] as const;
export type WatchdogWarningSource = typeof WATCHDOG_WARNING_SOURCES[number];

export const WATCHDOG_LSP_DIAGNOSTIC_SEVERITIES = ["error", "warning", "info", "hint"] as const;
export type WatchdogLspDiagnosticSeverity = typeof WATCHDOG_LSP_DIAGNOSTIC_SEVERITIES[number];

export const WATCHDOG_LSP_STATUSES = ["disabled", "ok", "skipped", "unavailable", "timeout", "failed"] as const;
export type WatchdogLspStatus = typeof WATCHDOG_LSP_STATUSES[number];

export const WATCHDOG_RUNTIME_STATUSES = ["idle", "queued", "reviewing", "waiting-at-agent-end", "stale", "failed"] as const;
export type WatchdogRuntimeStatus = typeof WATCHDOG_RUNTIME_STATUSES[number];

export const WATCHDOG_WARNING_STATES = [
	"candidate",
	"confirmed",
	"displayed",
	"stale",
	"failed",
	"resolved",
	"stalemate",
	"suppressed",
] as const;
export type WatchdogWarningState = typeof WATCHDOG_WARNING_STATES[number];

export const WATCHDOG_LATE_WARNING_POLICIES = ["show-stale-no-autofollow"] as const;
export type WatchdogLateWarningPolicy = typeof WATCHDOG_LATE_WARNING_POLICIES[number];

export const WATCHDOG_DELIVERY_MODES = ["held"] as const;
export type WatchdogDeliveryMode = typeof WATCHDOG_DELIVERY_MODES[number];

export type WatchdogSyncBacklog = "off" | number;

export interface WatchdogWarning {
	severity: WatchdogSeverity;
	summary: string;
	evidence: string;
	recommendedAction: string;
	category?: WatchdogCategory;
	confidence?: WatchdogConfidence;
	source?: WatchdogWarningSource;
	agent?: string;
	runId?: string;
	stale?: boolean;
	autoFollowAttempt?: number;
	state?: WatchdogWarningState;
}

export interface WatchdogWarningDetails extends WatchdogWarning {
	category: WatchdogCategory;
	source: WatchdogWarningSource;
	identity?: string;
	displayedAt?: string;
	error?: string;
	stalemateRepeats?: number;
}

export interface WatchdogWarningMessage {
	customType: typeof SUBAGENT_WATCHDOG_WARNING_TYPE;
	content: string;
	display: boolean;
	details: WatchdogWarningDetails;
}

export interface WatchdogAutoFollowConfig {
	blockers: boolean;
	maxAttempts: number | null;
	stalemateRepeats: number;
}

export interface WatchdogGuidanceConfig {
	watchdogMd: boolean;
	systemPromptPath: string | null;
}

export interface WatchdogEndpointConfig {
	enabled: boolean;
	model?: string;
	thinking?: string | false;
}

export interface WatchdogChildOverrideConfig {
	enabled?: boolean;
	model?: string;
	thinking?: string | false;
}

export interface WatchdogChildrenConfig extends WatchdogEndpointConfig {
	watchdogTailTimeoutMs: number;
	autoFollow: WatchdogAutoFollowConfig;
	overrides: Record<string, WatchdogChildOverrideConfig>;
}

export interface WatchdogAsyncCompletionConfig {
	enabled: boolean;
	autoFollowBlockers: boolean;
}

export interface WatchdogLspConfig {
	enabled: boolean;
	timeoutMs: number;
	maxFiles: number;
	maxDiagnostics: number;
}

export interface WatchdogLspDiagnostic {
	path: string;
	line: number;
	column: number;
	severity: WatchdogLspDiagnosticSeverity;
	source: string;
	code?: string;
	message: string;
}

export interface WatchdogLspResult {
	status: WatchdogLspStatus;
	provider?: string;
	checkedPaths: string[];
	skippedPaths: string[];
	diagnostics: WatchdogLspDiagnostic[];
	message?: string;
}

export interface WatchdogLspRuntimeSnapshot extends WatchdogLspResult {
	enabled: boolean;
	diagnosticCount: number;
	freshDiagnosticCount: number;
	updatedAt?: string;
}

export interface ResolvedWatchdogConfig {
	enabled: boolean;
	delivery: WatchdogDeliveryMode;
	showDuringRun: boolean;
	syncBacklog: WatchdogSyncBacklog;
	agentEndTimeoutMs: number;
	lateWarningPolicy: WatchdogLateWarningPolicy;
	severityThreshold: WatchdogSeverity;
	maxWarnings: number | null;
	guidance: WatchdogGuidanceConfig;
	autoFollow: WatchdogAutoFollowConfig;
	main: WatchdogEndpointConfig;
	children: WatchdogChildrenConfig;
	asyncCompletion: WatchdogAsyncCompletionConfig;
	lsp: WatchdogLspConfig;
	compactAtPercent: number;
	reviewRetryDelayMs: number;
	maxReviewFailures: number;
}

export interface WatchdogSettingsError {
	scope: "user" | "project" | "session";
	path?: string;
	message: string;
}

export interface WatchdogSettingsSource {
	scope: "user" | "project" | "session";
	path?: string;
	exists: boolean;
}

export interface WatchdogSettingsResult {
	ok: boolean;
	config: ResolvedWatchdogConfig;
	errors: WatchdogSettingsError[];
	sources: WatchdogSettingsSource[];
}
