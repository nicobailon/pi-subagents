import type { WatchdogSeverity, WatchdogWarning } from "./types.ts";

export type WatchdogEmissionSuppressionReason = "content-free" | "duplicate" | "max-warnings" | "update-budget";

export type WatchdogEmissionDecision = {
	accepted: true;
	identity: string;
	underlyingIdentity: string;
	escalation: boolean;
} | {
	accepted: false;
	reason: WatchdogEmissionSuppressionReason;
	identity?: string;
	underlyingIdentity?: string;
};

export interface WatchdogEmissionGuardOptions {
	maxWarnings?: number | null;
	dedupeHistoryLimit?: number;
}

const CONTENT_FREE_PHRASES = new Set([
	"stop",
	"done",
	"complete",
	"completed",
	"no issue",
	"no issues",
	"no concern",
	"no concerns",
	"nothing to add",
	"lgtm",
	"looks good",
	"looks good to me",
	"all good",
	"ok",
	"okay",
	"none",
	"n a",
]);

export function normalizeWatchdogEmissionText(value: string): string {
	return value
		.normalize("NFKC")
		.toLowerCase()
		.replace(/[’'`]/g, "")
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.replace(/\s+/g, " ")
		.trim();
}

export function watchdogWarningUnderlyingIdentity(warning: Pick<WatchdogWarning, "summary" | "evidence">): string {
	return [normalizeWatchdogEmissionText(warning.summary), normalizeWatchdogEmissionText(warning.evidence)].join("\n");
}

export function watchdogWarningIdentity(warning: Pick<WatchdogWarning, "severity" | "summary" | "evidence">): string {
	return [warning.severity, watchdogWarningUnderlyingIdentity(warning)].join("\n");
}

function isContentFree(value: string): boolean {
	const normalized = normalizeWatchdogEmissionText(value);
	return !normalized || CONTENT_FREE_PHRASES.has(normalized);
}

export class WatchdogEmissionGuard {
	private maxWarnings: number | null;
	private dedupeHistoryLimit: number;
	private acceptedCount = 0;
	private acceptedByUnderlyingIdentity = new Map<string, WatchdogSeverity>();
	private historyOrder: string[] = [];
	private updateAcceptedUnderlyingIdentity: string | undefined;
	private updateAcceptedSeverity: WatchdogSeverity | undefined;

	constructor(options: WatchdogEmissionGuardOptions = {}) {
		this.maxWarnings = options.maxWarnings ?? null;
		this.dedupeHistoryLimit = options.dedupeHistoryLimit ?? 200;
	}

	startModelUpdate(): void {
		this.updateAcceptedUnderlyingIdentity = undefined;
		this.updateAcceptedSeverity = undefined;
	}

	reset(): void {
		this.acceptedCount = 0;
		this.acceptedByUnderlyingIdentity.clear();
		this.historyOrder = [];
		this.startModelUpdate();
	}

	evaluate(warning: WatchdogWarning): WatchdogEmissionDecision {
		if (isContentFree(warning.summary) || isContentFree(warning.evidence) || isContentFree(warning.recommendedAction)) {
			return { accepted: false, reason: "content-free" };
		}
		const underlyingIdentity = watchdogWarningUnderlyingIdentity(warning);
		const identity = watchdogWarningIdentity(warning);
		const priorSeverity = this.acceptedByUnderlyingIdentity.get(underlyingIdentity);
		const escalation = priorSeverity === "concern" && warning.severity === "blocker";
		if (this.updateAcceptedUnderlyingIdentity !== undefined) {
			const updateEscalation = this.updateAcceptedUnderlyingIdentity === underlyingIdentity
				&& this.updateAcceptedSeverity === "concern"
				&& warning.severity === "blocker";
			if (!updateEscalation) return { accepted: false, reason: "update-budget", identity, underlyingIdentity };
		}
		if (priorSeverity !== undefined && !escalation) return { accepted: false, reason: "duplicate", identity, underlyingIdentity };
		if (this.maxWarnings !== null && this.acceptedCount >= this.maxWarnings && !escalation) {
			return { accepted: false, reason: "max-warnings", identity, underlyingIdentity };
		}

		this.acceptedByUnderlyingIdentity.set(underlyingIdentity, warning.severity);
		if (!priorSeverity) {
			this.acceptedCount++;
			this.historyOrder.push(underlyingIdentity);
		}
		while (this.historyOrder.length > this.dedupeHistoryLimit) {
			const stale = this.historyOrder.shift();
			if (stale) this.acceptedByUnderlyingIdentity.delete(stale);
		}
		this.updateAcceptedUnderlyingIdentity = underlyingIdentity;
		this.updateAcceptedSeverity = warning.severity;
		return { accepted: true, identity, underlyingIdentity, escalation };
	}
}
