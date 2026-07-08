import { createHash } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { computeWatchdogRepoChangeSignature, eventIndicatesRepoEdit, type WatchdogRepoChangeSignature } from "./change-signature.ts";
import { WatchdogEmissionGuard } from "./emission-guard.ts";
import {
	collectWatchdogLspDiagnostics,
	formatWatchdogLspDiagnosticsBlock,
	WatchdogLspDiagnosticsLedger,
	watchdogWarningFromLspDiagnostics,
	type WatchdogLspDiagnosticsFunction,
} from "./lsp-diagnostics.ts";
import { resolveWatchdogConfig } from "./settings.ts";
import { formatWatchdogTurnDelta } from "./turn-delta.ts";
import {
	type ResolvedWatchdogConfig,
	type WatchdogEndpointConfig,
	type WatchdogLspRuntimeSnapshot,
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
	lsp: WatchdogLspRuntimeSnapshot;
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
	lspDiagnostics?: WatchdogLspDiagnosticsFunction;
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
	private readonly lspDiagnostics: WatchdogLspDiagnosticsFunction;
	private readonly lspLedger = new WatchdogLspDiagnosticsLedger();
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
	private agentEndIdCounter = 0;
	private activeAgentEndId: number | undefined;
	private activeAgentEndAbortController: AbortController | undefined;
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
	private lastLspSnapshot: WatchdogLspRuntimeSnapshot | undefined;
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
		this.lspDiagnostics = options.lspDiagnostics ?? collectWatchdogLspDiagnostics;
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
		this.reset("session_start", { clearReviewInputSignature: true, resetChangeSignature: true, clearLspLedger: true });
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

	setSessionModel(patch: { model?: string | null; thinking?: WatchdogEndpointConfig["thinking"] | null }, cwd = this.cwd): WatchdogRuntimeSnapshot {
		const next = { ...(this.sessionModelOverride ?? {}) };
		if (patch.model === null) delete next.model;
		else if (patch.model !== undefined) next.model = patch.model;
		if (patch.thinking === null) delete next.thinking;
		else if (patch.thinking !== undefined) next.thinking = patch.thinking;
		this.sessionModelOverride = next.model === undefined && next.thinking === undefined ? undefined : next;
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

	reset(_reason = "reset", options: { clearReviewInputSignature?: boolean; resetChangeSignature?: boolean; clearLspLedger?: boolean } = {}): void {
		this.abortActiveAgentEnd();
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
		if (options.clearLspLedger) {
			this.lspLedger.reset();
			this.lastLspSnapshot = undefined;
		}
		if (options.clearReviewInputSignature) this.lastReviewInputSignature = undefined;
		if (options.resetChangeSignature) this.resetRepoChangeBaseline({ reviewed: true });
		this.guard.reset();
		this.resolveWaiters(true);
	}

	dispose(): void {
		this.disposed = true;
		this.abortActiveAgentEnd();
		this.epoch++;
		this.status = "idle";
		this.clearPendingDeltas();
		this.reviewing = false;
		this.waitingAtAgentEnd = false;
		this.activeReviewId = undefined;
		this.activeReviewWarning = undefined;
		this.lastReviewInputSignature = undefined;
		this.currentChangedPaths = undefined;
		this.lastLspSnapshot = undefined;
		this.lspLedger.reset();
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
		if (changeSignature && changeSignature.key === this.lastReviewedChangeSignature) {
			this.clearPendingDeltas();
			this.status = "idle";
			this.resolveWaiters(true);
			return;
		}
		this.waitingAtAgentEnd = true;
		const agentEndEpoch = this.epoch;
		const agentEndId = ++this.agentEndIdCounter;
		const lspAbortController = new AbortController();
		this.activeAgentEndId = agentEndId;
		this.activeAgentEndAbortController = lspAbortController;
		try {
			this.guard.startModelUpdate();
			const lspBlock = await this.collectLspDiagnostics(changeSignature, {
				epoch: agentEndEpoch,
				agentEndId,
				signal: lspAbortController.signal,
			});
			if (this.activeAgentEndAbortController === lspAbortController) this.activeAgentEndAbortController = undefined;
			if (!this.isAgentEndCurrent(agentEndEpoch, agentEndId)) return;
			const delta = this.buildReviewInput(changeSignature, lspBlock);
			this.clearPendingDeltas();
			if (!delta.trim()) {
				this.waitingAtAgentEnd = false;
				if (this.status === "queued") this.status = "idle";
				this.resolveWaiters(true);
				return;
			}
			const signature = reviewInputSignature(delta);
			if (!this.reviewChangesOnly && signature === this.lastReviewInputSignature) {
				this.waitingAtAgentEnd = false;
				this.status = "idle";
				this.resolveWaiters(true);
				return;
			}
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
		} finally {
			if (this.activeAgentEndAbortController === lspAbortController) this.activeAgentEndAbortController = undefined;
			if (this.activeAgentEndId === agentEndId) this.activeAgentEndId = undefined;
		}
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
			lsp: this.lspSnapshot(),
		};
	}

	async waitForIdle(timeoutMs = 1_000): Promise<boolean> {
		return this.waitForSettled(timeoutMs);
	}

	private isEnabled(): boolean {
		return this.configResult.ok && this.configResult.config.main.enabled;
	}

	private abortActiveAgentEnd(): void {
		this.activeAgentEndAbortController?.abort();
		this.activeAgentEndAbortController = undefined;
		this.activeAgentEndId = undefined;
	}

	private isAgentEndCurrent(epoch: number, agentEndId: number): boolean {
		return !this.disposed && this.epoch === epoch && this.activeAgentEndId === agentEndId && this.waitingAtAgentEnd && this.isEnabled();
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

	private displayBoundaryWarning(warning: WatchdogWarning): boolean {
		if (!this.isEnabled()) return false;
		const decision = this.guard.evaluate(warning);
		if (!decision.accepted) return false;
		const details = normalizeWatchdogWarningDetails(warning, {
			state: "displayed",
			source: warning.source ?? "main",
			identity: decision.identity,
			displayedAt: new Date().toISOString(),
		});
		this.lastWarning = details;
		this.displayWarning?.(details);
		return true;
	}

	private invalidateActiveReview(_reason: string): void {
		this.abortActiveAgentEnd();
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

	private async collectLspDiagnostics(changeSignature: WatchdogRepoChangeSignature | undefined, current: { epoch: number; agentEndId: number; signal: AbortSignal }): Promise<string> {
		const config = this.configResult.config.lsp;
		if (!config.enabled || !changeSignature?.changedPaths.length) {
			this.lastLspSnapshot = {
				enabled: config.enabled,
				status: config.enabled ? "skipped" : "disabled",
				checkedPaths: [],
				skippedPaths: [],
				diagnostics: [],
				diagnosticCount: 0,
				freshDiagnosticCount: 0,
				updatedAt: new Date().toISOString(),
			};
			return "";
		}
		try {
			const raw = await this.lspDiagnostics({
				cwd: this.cwd,
				root: changeSignature.root,
				changedPaths: changeSignature.changedPaths,
				config,
				signal: current.signal,
			});
			if (!this.isAgentEndCurrent(current.epoch, current.agentEndId)) return "";
			const diagnosticCount = raw.diagnostics.length;
			const fresh = this.lspLedger.reduce(raw);
			this.lastLspSnapshot = {
				...fresh,
				enabled: true,
				diagnosticCount,
				freshDiagnosticCount: fresh.diagnostics.length,
				updatedAt: new Date().toISOString(),
			};
			const warning = watchdogWarningFromLspDiagnostics(fresh);
			if (warning) this.displayBoundaryWarning(warning);
			return formatWatchdogLspDiagnosticsBlock(fresh);
		} catch (error) {
			if (!this.isAgentEndCurrent(current.epoch, current.agentEndId)) return "";
			this.lastLspSnapshot = {
				enabled: true,
				status: "failed",
				checkedPaths: [],
				skippedPaths: changeSignature.changedPaths,
				diagnostics: [],
				diagnosticCount: 0,
				freshDiagnosticCount: 0,
				message: `LSP diagnostics failed: ${errorMessage(error)}`,
				updatedAt: new Date().toISOString(),
			};
			return "";
		}
	}

	private lspSnapshot(): WatchdogLspRuntimeSnapshot {
		if (this.lastLspSnapshot) return {
			...this.lastLspSnapshot,
			checkedPaths: [...this.lastLspSnapshot.checkedPaths],
			skippedPaths: [...this.lastLspSnapshot.skippedPaths],
			diagnostics: [...this.lastLspSnapshot.diagnostics],
		};
		const enabled = this.isEnabled() && this.configResult.config.lsp.enabled;
		return {
			enabled,
			status: enabled ? "skipped" : "disabled",
			checkedPaths: [],
			skippedPaths: [],
			diagnostics: [],
			diagnosticCount: 0,
			freshDiagnosticCount: 0,
		};
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

	private buildReviewInput(changeSignature?: WatchdogRepoChangeSignature, lspBlock = ""): string {
		const input = this.pendingDeltas.join(REVIEW_DELTA_SEPARATOR);
		const changes = changeSignature?.changedPaths.length
			? ["Changed repo paths:", ...changeSignature.changedPaths.slice(0, 200).map((file) => `- ${file}`)].join("\n")
			: "";
		const contextPieces = [changes, lspBlock].filter(Boolean);
		if (!contextPieces.length) return input.length > MAX_REVIEW_INPUT_CHARS ? input.slice(-MAX_REVIEW_INPUT_CHARS) : input;

		const maxContextLength = Math.floor(MAX_REVIEW_INPUT_CHARS / 2);
		const maxPieceLength = Math.max(1_000, Math.floor(maxContextLength / contextPieces.length));
		const boundedContext = contextPieces.map((piece) => piece.length > maxPieceLength
			? `${piece.slice(0, maxPieceLength - 6)}\n- ...`
			: piece).join(REVIEW_DELTA_SEPARATOR);
		const separatorLength = input ? REVIEW_DELTA_SEPARATOR.length : 0;
		const inputBudget = MAX_REVIEW_INPUT_CHARS - boundedContext.length - separatorLength;
		const boundedInput = inputBudget <= 0
			? ""
			: input.length > inputBudget
				? input.slice(-inputBudget)
				: input;
		return [boundedContext, boundedInput].filter(Boolean).join(REVIEW_DELTA_SEPARATOR);
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
		if (!this.lastWarning || this.lastWarning.state === "displayed") return;
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
