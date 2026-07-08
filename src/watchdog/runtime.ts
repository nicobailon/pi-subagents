import { createHash } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { computeWatchdogRepoChangeSignature, eventIndicatesRepoEdit, type WatchdogRepoChangeSignature } from "./change-signature.ts";
import { WatchdogEmissionGuard } from "./emission-guard.ts";
import { resolveWatchdogConfig } from "./settings.ts";
import { formatWatchdogTurnDelta } from "./turn-delta.ts";
import {
	type ResolvedWatchdogConfig,
	type WatchdogEndpointConfig,
	type WatchdogRuntimeStatus,
	type WatchdogSettingsError,
	type WatchdogSettingsResult,
	type WatchdogSettingsSource,
	type WatchdogWarning,
	type WatchdogWarningDetails,
} from "./types.ts";
import { normalizeWatchdogWarningDetails } from "./warning-format.ts";

type ReviewStopReason = "stop" | "error" | "aborted" | "length";

export interface WatchdogReviewResult {
	warnings?: WatchdogWarning[];
	stopReason?: ReviewStopReason;
}

export interface WatchdogReviewRequest {
	delta: string;
	epoch: number;
	reviewId: number;
	config: ResolvedWatchdogConfig;
	emitWarning(warning: WatchdogWarning): boolean;
	signal?: AbortSignal;
}

export type WatchdogReviewFunction = (request: WatchdogReviewRequest) => Promise<WatchdogReviewResult | void> | WatchdogReviewResult | void;

export interface WatchdogRuntimeSnapshot {
	status: WatchdogRuntimeStatus;
	enabled: boolean;
	config: ResolvedWatchdogConfig;
	configOk: boolean;
	errors: WatchdogSettingsError[];
	sources: WatchdogSettingsSource[];
	bufferedDeltas: number;
	epoch: number;
	activeReviewId?: number;
	sessionOverride?: boolean;
	sessionModelOverride?: Partial<Pick<WatchdogEndpointConfig, "model" | "thinking">>;
	lastWarning?: WatchdogWarningDetails;
	lastError?: string;
	failedReviews: number;
	staleReviews: number;
	reviewConnected: boolean;
	reviewDescription: string;
	autoFollowQueued: false;
	reviewTrigger: "turn-delta" | "repo-edits";
	changedPaths?: string[];
}

interface Waiter {
	resolve(settled: boolean): void;
	timer: ReturnType<typeof setTimeout>;
}

interface MainWatchdogRuntimeOptions {
	cwd?: string;
	resolveConfig?: (cwd: string, options?: { session?: Record<string, unknown> }) => WatchdogSettingsResult;
	review?: WatchdogReviewFunction;
	reviewDescription?: string;
	displayWarning?: (warning: WatchdogWarningDetails) => void;
	reviewChangesOnly?: boolean;
}

type ContextLike = Pick<ExtensionContext, "cwd">;
type ReviewDeltaOutcome = "completed" | "timeout" | "stale";

const DEFAULT_REVIEW: WatchdogReviewFunction = () => ({ warnings: [] });
const MAX_REVIEW_INPUT_CHARS = 24_000;
const REVIEW_DELTA_SEPARATOR = "\n\n---\n\n";

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function promptFromBeforeAgentStart(event: unknown): string | undefined {
	if (!event || typeof event !== "object") return undefined;
	const input = event as { prompt?: unknown; systemPrompt?: unknown };
	if (typeof input.prompt === "string") return input.prompt;
	if (typeof input.systemPrompt === "string") return input.systemPrompt;
	return undefined;
}

function reviewInputSignature(input: string): string {
	return createHash("sha256").update(input).digest("hex");
}

export class MainWatchdogRuntime {
	private cwd: string;
	private readonly resolveConfig: (cwd: string, options?: { session?: Record<string, unknown> }) => WatchdogSettingsResult;
	private readonly review: WatchdogReviewFunction;
	private readonly reviewConnected: boolean;
	private readonly reviewDescription: string;
	private readonly displayWarning: ((warning: WatchdogWarningDetails) => void) | undefined;
	private readonly reviewChangesOnly: boolean;
	private configResult: WatchdogSettingsResult;
	private sessionOverrideEnabled: boolean | undefined;
	private sessionModelOverride: Partial<Pick<WatchdogEndpointConfig, "model" | "thinking">> | undefined;
	private status: WatchdogRuntimeStatus = "idle";
	private pendingDeltas: string[] = [];
	private pendingDeltaChars = 0;
	private guard = new WatchdogEmissionGuard();
	private guardMaxWarnings: number | null = null;
	private epoch = 0;
	private reviewIdCounter = 0;
	private activeReviewId: number | undefined;
	private activeReviewWarning: WatchdogWarningDetails | undefined;
	private reviewing = false;
	private waitingAtAgentEnd = false;
	private disposed = false;
	private includeUserPromptInNextDelta = false;
	private userPrompt: string | undefined;
	private waiters: Waiter[] = [];
	private lastWarning: WatchdogWarningDetails | undefined;
	private lastError: string | undefined;
	private lastReviewInputSignature: string | undefined;
	private turnStartChangeSignature: WatchdogRepoChangeSignature | undefined;
	private lastReviewedChangeSignature: string | undefined;
	private currentChangedPaths: string[] | undefined;
	private observedRepoEditThisTurn = false;
	private failedReviews = 0;
	private staleReviews = 0;

	constructor(options: MainWatchdogRuntimeOptions = {}) {
		this.cwd = options.cwd ?? process.cwd();
		this.resolveConfig = options.resolveConfig ?? resolveWatchdogConfig;
		this.review = options.review ?? DEFAULT_REVIEW;
		this.reviewConnected = Boolean(options.review);
		this.reviewDescription = options.reviewDescription ?? (options.review ? "injected seam" : "not wired");
		this.displayWarning = options.displayWarning;
		this.reviewChangesOnly = options.reviewChangesOnly === true;
		this.configResult = this.resolveConfig(this.cwd);
		this.guardMaxWarnings = this.configResult.config.maxWarnings;
		this.guard = new WatchdogEmissionGuard({ maxWarnings: this.guardMaxWarnings });
		this.turnStartChangeSignature = this.currentRepoChangeSignature();
		this.lastReviewedChangeSignature = this.turnStartChangeSignature?.key;
	}

	bindSession(ctx: ContextLike): void {
		this.cwd = ctx.cwd;
		this.sessionOverrideEnabled = undefined;
		this.sessionModelOverride = undefined;
		this.reset("session_start", { clearReviewInputSignature: true, resetChangeSignature: true });
		this.refreshConfig(ctx.cwd);
		this.resetRepoChangeBaseline();
	}

	refreshConfig(cwd = this.cwd): WatchdogSettingsResult {
		this.cwd = cwd;
		const wasEnabled = this.isEnabled();
		const session = this.sessionOverrideEnabled === undefined && this.sessionModelOverride === undefined
			? undefined
			: {
				...(this.sessionOverrideEnabled === undefined ? {} : { enabled: this.sessionOverrideEnabled }),
				main: {
					...(this.sessionOverrideEnabled === undefined ? {} : { enabled: this.sessionOverrideEnabled }),
					...(this.sessionModelOverride ?? {}),
				},
			};
		this.configResult = this.resolveConfig(this.cwd, session === undefined ? undefined : { session });
		if (this.configResult.config.maxWarnings !== this.guardMaxWarnings) {
			this.guardMaxWarnings = this.configResult.config.maxWarnings;
			this.guard = new WatchdogEmissionGuard({ maxWarnings: this.guardMaxWarnings });
		}
		if (wasEnabled && !this.isEnabled()) this.invalidateActiveReview("watchdog disabled");
		return this.configResult;
	}

	setSessionEnabled(enabled: boolean, cwd = this.cwd): WatchdogRuntimeSnapshot {
		this.sessionOverrideEnabled = enabled;
		this.reset("session override");
		this.refreshConfig(cwd);
		return this.getSnapshot();
	}

	setSessionModel(model: string | undefined, thinking: WatchdogEndpointConfig["thinking"] | undefined, cwd = this.cwd): WatchdogRuntimeSnapshot {
		this.sessionModelOverride = {
			...(model ? { model } : {}),
			...(thinking !== undefined ? { thinking } : {}),
		};
		this.reset("session model override");
		this.refreshConfig(cwd);
		return this.getSnapshot();
	}

	clearSessionModel(cwd = this.cwd): WatchdogRuntimeSnapshot {
		this.sessionModelOverride = undefined;
		this.reset("session model override cleared");
		this.refreshConfig(cwd);
		return this.getSnapshot();
	}

	clearSessionOverride(cwd = this.cwd): WatchdogRuntimeSnapshot {
		this.sessionOverrideEnabled = undefined;
		this.sessionModelOverride = undefined;
		this.reset("session override cleared");
		this.refreshConfig(cwd);
		return this.getSnapshot();
	}

	reset(_reason = "reset", options: { clearReviewInputSignature?: boolean; resetChangeSignature?: boolean } = {}): void {
		this.epoch++;
		this.status = "idle";
		this.clearPendingDeltas();
		this.reviewing = false;
		this.waitingAtAgentEnd = false;
		this.activeReviewId = undefined;
		this.activeReviewWarning = undefined;
		this.includeUserPromptInNextDelta = false;
		this.userPrompt = undefined;
		this.lastError = undefined;
		this.currentChangedPaths = undefined;
		this.observedRepoEditThisTurn = false;
		if (options.clearReviewInputSignature) this.lastReviewInputSignature = undefined;
		if (options.resetChangeSignature) this.resetRepoChangeBaseline({ reviewed: true });
		this.guard.reset();
		this.resolveWaiters(true);
	}

	dispose(): void {
		this.disposed = true;
		this.epoch++;
		this.status = "idle";
		this.clearPendingDeltas();
		this.reviewing = false;
		this.waitingAtAgentEnd = false;
		this.activeReviewId = undefined;
		this.activeReviewWarning = undefined;
		this.lastReviewInputSignature = undefined;
		this.currentChangedPaths = undefined;
		this.observedRepoEditThisTurn = false;
		this.resolveWaiters(false);
	}

	handleBeforeAgentStart(event: unknown, ctx: ContextLike): void {
		if (this.disposed) return;
		this.reset("before_agent_start");
		this.refreshConfig(ctx.cwd);
		this.userPrompt = promptFromBeforeAgentStart(event);
		this.includeUserPromptInNextDelta = Boolean(this.userPrompt?.trim());
		this.resetRepoChangeBaseline();
	}

	handleTurnEnd(event: unknown, ctx: ContextLike): void {
		if (this.disposed) return;
		this.refreshConfig(ctx.cwd);
		if (!this.isEnabled()) return;
		try {
			this.observedRepoEditThisTurn ||= eventIndicatesRepoEdit(event);
			const delta = formatWatchdogTurnDelta({
				includeUserPrompt: this.includeUserPromptInNextDelta,
				userPrompt: this.userPrompt,
				events: [event],
			});
			this.includeUserPromptInNextDelta = false;
			this.enqueueDelta(delta);
		} catch (error) {
			this.fail(`Failed to format watchdog turn delta: ${errorMessage(error)}`);
		}
	}

	enqueueDelta(delta: string): void {
		if (this.disposed || !delta.trim() || !this.isEnabled()) return;
		this.appendBoundedDelta(delta);
		if (!this.reviewing && !this.waitingAtAgentEnd) this.status = "queued";
	}

	async handleAgentEnd(_event: unknown, ctx: ContextLike): Promise<void> {
		if (this.disposed) return;
		this.refreshConfig(ctx.cwd);
		if (!this.isEnabled()) return;
		const changeSignature = this.resolveReviewChangeSignature(ctx.cwd);
		if (this.reviewChangesOnly && !changeSignature) {
			this.clearPendingDeltas();
			if (this.status === "queued") this.status = "idle";
			this.resolveWaiters(true);
			return;
		}
		const delta = this.buildReviewInput(changeSignature);
		this.clearPendingDeltas();
		if (!delta.trim()) {
			if (this.status === "queued") this.status = "idle";
			this.resolveWaiters(true);
			return;
		}
		const signature = reviewInputSignature(delta);
		if (changeSignature && changeSignature.key === this.lastReviewedChangeSignature) {
			this.status = "idle";
			this.resolveWaiters(true);
			return;
		}
		if (!this.reviewChangesOnly && signature === this.lastReviewInputSignature) {
			this.status = "idle";
			this.resolveWaiters(true);
			return;
		}
		this.waitingAtAgentEnd = true;
		const outcome = await this.reviewDelta(delta, this.configResult.config.agentEndTimeoutMs);
		this.waitingAtAgentEnd = false;
		if (outcome === "timeout") {
			this.staleReviews++;
			this.invalidateActiveReview("agent-end timeout");
			this.status = "stale";
			this.markLastWarningStale();
			this.resolveWaiters(true);
			return;
		}
		if (outcome === "completed" && this.status !== "failed" && this.status !== "stale") {
			this.lastReviewInputSignature = signature;
			if (changeSignature) this.lastReviewedChangeSignature = changeSignature.key;
			this.currentChangedPaths = changeSignature?.changedPaths;
			this.status = "idle";
		}
		this.resolveWaiters(true);
	}

	recordDisplayedWarning(warning: WatchdogWarning): WatchdogWarningDetails {
		const details = normalizeWatchdogWarningDetails(warning, { state: "displayed", source: warning.source ?? "main" });
		this.lastWarning = details;
		return details;
	}

	getSnapshot(cwd?: string): WatchdogRuntimeSnapshot {
		if (cwd) this.refreshConfig(cwd);
		return {
			status: this.status,
			enabled: this.isEnabled(),
			config: this.configResult.config,
			configOk: this.configResult.ok,
			errors: [...this.configResult.errors],
			sources: [...this.configResult.sources],
			bufferedDeltas: this.pendingDeltas.length,
			epoch: this.epoch,
			...(this.activeReviewId !== undefined ? { activeReviewId: this.activeReviewId } : {}),
			...(this.sessionOverrideEnabled !== undefined ? { sessionOverride: this.sessionOverrideEnabled } : {}),
			...(this.sessionModelOverride !== undefined ? { sessionModelOverride: { ...this.sessionModelOverride } } : {}),
			...(this.lastWarning ? { lastWarning: this.lastWarning } : {}),
			...(this.lastError ? { lastError: this.lastError } : {}),
			failedReviews: this.failedReviews,
			staleReviews: this.staleReviews,
			reviewConnected: this.reviewConnected,
			reviewDescription: this.reviewDescription,
			autoFollowQueued: false,
			reviewTrigger: this.reviewChangesOnly ? "repo-edits" : "turn-delta",
			...(this.currentChangedPaths?.length ? { changedPaths: [...this.currentChangedPaths] } : {}),
		};
	}

	async waitForIdle(timeoutMs = 1_000): Promise<boolean> {
		return this.waitForSettled(timeoutMs);
	}

	private isEnabled(): boolean {
		return this.configResult.ok && this.configResult.config.main.enabled;
	}

	private isCurrent(epoch: number, reviewId: number): boolean {
		return !this.disposed && this.epoch === epoch && this.activeReviewId === reviewId;
	}

	private acceptWarning(epoch: number, reviewId: number, warning: WatchdogWarning): boolean {
		if (!this.isCurrent(epoch, reviewId) || !this.isEnabled()) return false;
		const decision = this.guard.evaluate(warning);
		if (!decision.accepted) return false;
		const details = normalizeWatchdogWarningDetails(warning, {
			state: "candidate",
			source: warning.source ?? "main",
			identity: decision.identity,
		});
		this.lastWarning = details;
		this.activeReviewWarning = details;
		return true;
	}

	private invalidateActiveReview(_reason: string): void {
		this.epoch++;
		this.status = "idle";
		this.clearPendingDeltas();
		this.reviewing = false;
		this.waitingAtAgentEnd = false;
		this.activeReviewId = undefined;
		this.activeReviewWarning = undefined;
	}

	private async reviewDelta(delta: string, timeoutMs: number): Promise<ReviewDeltaOutcome> {
		if (this.reviewing || this.disposed) return "stale";
		this.reviewing = true;
		const reviewEpoch = this.epoch;
		const reviewId = ++this.reviewIdCounter;
		this.activeReviewId = reviewId;
		this.activeReviewWarning = undefined;
		this.status = "reviewing";
		this.guard.startModelUpdate();
		let timeout: ReturnType<typeof setTimeout> | undefined;
		const abortController = new AbortController();
		const reviewPromise = Promise.resolve().then(() => this.review({
			delta,
			epoch: reviewEpoch,
			reviewId,
			config: this.configResult.config,
			signal: abortController.signal,
			emitWarning: (warning) => this.acceptWarning(reviewEpoch, reviewId, warning),
		}));
		try {
			const result = await Promise.race([
				reviewPromise,
				new Promise<"timeout">((resolve) => {
					timeout = setTimeout(() => resolve("timeout"), timeoutMs);
				}),
			]);
			if (result === "timeout") {
				abortController.abort();
				return "timeout";
			}
			if (!this.isCurrent(reviewEpoch, reviewId)) return "stale";
			for (const warning of result?.warnings ?? []) this.acceptWarning(reviewEpoch, reviewId, warning);
			if (result?.stopReason && result.stopReason !== "stop") {
				this.fail(`Watchdog review ended with stop reason '${result.stopReason}'.`);
				return "completed";
			}
			this.displayAcceptedReviewWarning();
			return "completed";
		} catch (error) {
			if (this.isCurrent(reviewEpoch, reviewId)) {
				this.fail(`Watchdog review failed: ${errorMessage(error)}`);
				return "completed";
			}
			return "stale";
		} finally {
			if (timeout) clearTimeout(timeout);
			if (this.epoch === reviewEpoch && this.activeReviewId === reviewId) {
				this.reviewing = false;
				this.activeReviewId = undefined;
				this.activeReviewWarning = undefined;
			}
			this.resolveWaiters(this.isSettled());
		}
	}

	private displayAcceptedReviewWarning(): void {
		if (!this.activeReviewWarning) return;
		const details: WatchdogWarningDetails = {
			...this.activeReviewWarning,
			state: "displayed",
			displayedAt: new Date().toISOString(),
		};
		this.lastWarning = details;
		this.displayWarning?.(details);
	}

	private currentRepoChangeSignature(cwd = this.cwd): WatchdogRepoChangeSignature | undefined {
		return this.reviewChangesOnly ? computeWatchdogRepoChangeSignature(cwd) : undefined;
	}

	private resetRepoChangeBaseline(options: { cwd?: string; reviewed?: boolean } = {}): void {
		this.turnStartChangeSignature = this.currentRepoChangeSignature(options.cwd ?? this.cwd);
		if (options.reviewed) this.lastReviewedChangeSignature = this.turnStartChangeSignature?.key;
		else this.lastReviewedChangeSignature ??= this.turnStartChangeSignature?.key;
		this.currentChangedPaths = this.turnStartChangeSignature?.changedPaths;
		this.observedRepoEditThisTurn = false;
	}

	private resolveReviewChangeSignature(cwd = this.cwd): WatchdogRepoChangeSignature | undefined {
		if (!this.reviewChangesOnly) return undefined;
		const current = this.currentRepoChangeSignature(cwd);
		if (current) {
			this.currentChangedPaths = current.changedPaths;
			if (current.key === this.turnStartChangeSignature?.key) return undefined;
			if (current.changedPaths.length === 0) return undefined;
			return current;
		}
		return this.observedRepoEditThisTurn
			? { root: cwd, key: `observed-edit:${this.epoch}:${this.reviewIdCounter}:${this.pendingDeltaChars}`, changedPaths: [] }
			: undefined;
	}

	private appendBoundedDelta(delta: string): void {
		let entry = delta.trim();
		if (!entry) return;
		if (entry.length > MAX_REVIEW_INPUT_CHARS) entry = entry.slice(-MAX_REVIEW_INPUT_CHARS);
		this.pendingDeltas.push(entry);
		this.pendingDeltaChars += entry.length;
		while (this.pendingDeltas.length > 1 && this.pendingDeltaChars + (this.pendingDeltas.length - 1) * REVIEW_DELTA_SEPARATOR.length > MAX_REVIEW_INPUT_CHARS) {
			const removed = this.pendingDeltas.shift();
			if (removed) this.pendingDeltaChars -= removed.length;
		}
	}

	private buildReviewInput(changeSignature?: WatchdogRepoChangeSignature): string {
		const input = this.pendingDeltas.join(REVIEW_DELTA_SEPARATOR);
		const changes = changeSignature?.changedPaths.length
			? ["Changed repo paths:", ...changeSignature.changedPaths.slice(0, 200).map((file) => `- ${file}`)].join("\n")
			: "";
		if (!changes) return input.length > MAX_REVIEW_INPUT_CHARS ? input.slice(-MAX_REVIEW_INPUT_CHARS) : input;

		const maxChangesLength = Math.floor(MAX_REVIEW_INPUT_CHARS / 3);
		const boundedChanges = changes.length > maxChangesLength
			? `${changes.slice(0, maxChangesLength - 6)}\n- ...`
			: changes;
		const separatorLength = input ? REVIEW_DELTA_SEPARATOR.length : 0;
		const inputBudget = MAX_REVIEW_INPUT_CHARS - boundedChanges.length - separatorLength;
		const boundedInput = inputBudget <= 0
			? ""
			: input.length > inputBudget
				? input.slice(-inputBudget)
				: input;
		return [boundedChanges, boundedInput].filter(Boolean).join(REVIEW_DELTA_SEPARATOR);
	}

	private clearPendingDeltas(): void {
		this.pendingDeltas = [];
		this.pendingDeltaChars = 0;
	}

	private fail(message: string): void {
		this.failedReviews++;
		this.lastError = message;
		this.status = "failed";
		this.clearPendingDeltas();
		this.resolveWaiters(true);
	}

	private markLastWarningStale(): void {
		if (!this.lastWarning) return;
		this.lastWarning = { ...this.lastWarning, stale: true, state: "stale" };
	}

	private isSettled(): boolean {
		return !this.reviewing && this.pendingDeltas.length === 0;
	}

	private waitForSettled(timeoutMs: number): Promise<boolean> {
		if (this.isSettled()) return Promise.resolve(true);
		return new Promise((resolve) => {
			const waiter: Waiter = {
				resolve,
				timer: setTimeout(() => {
					this.waiters = this.waiters.filter((entry) => entry !== waiter);
					resolve(false);
				}, timeoutMs),
			};
			this.waiters.push(waiter);
		});
	}

	private resolveWaiters(settled: boolean): void {
		if (!settled && !this.disposed) return;
		const waiters = this.waiters;
		this.waiters = [];
		for (const waiter of waiters) {
			clearTimeout(waiter.timer);
			waiter.resolve(settled);
		}
	}
}
