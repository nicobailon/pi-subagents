/**
 * Smart completion batching with straggler handling.
 *
 * Holds successful async-completion notifications briefly so sibling jobs that
 * finish within a short window arrive as a single grouped message. A hard
 * max-wait cap (measured from the first item in a group) prevents holding
 * notifications indefinitely. After a group is emitted, late-finishing
 * siblings that arrive within the straggler window join a shorter "straggler"
 * group with reduced debounce and max-wait timers.
 *
 * Failure and attention signals bypass this batcher entirely. Callers must
 * flush() held items and emit those signals immediately so failures and
 * needs-attention notices are never delayed.
 */

import type { CompletionBatchConfig } from "../../shared/types.ts";

export type { CompletionBatchConfig };

export interface ResolvedCompletionBatchConfig {
	enabled: boolean;
	debounceMs: number;
	maxWaitMs: number;
	stragglerDebounceMs: number;
	stragglerMaxWaitMs: number;
	stragglerWindowMs: number;
}

export const DEFAULT_COMPLETION_BATCH_CONFIG: ResolvedCompletionBatchConfig = {
	enabled: true,
	debounceMs: 150,
	maxWaitMs: 1000,
	stragglerDebounceMs: 75,
	stragglerMaxWaitMs: 400,
	stragglerWindowMs: 2000,
};

function parsePositiveInt(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value < 1) return undefined;
	return value;
}

export function resolveCompletionBatchConfig(
	globalConfig?: CompletionBatchConfig,
	override?: CompletionBatchConfig,
): ResolvedCompletionBatchConfig {
	const enabled = typeof override?.enabled === "boolean"
		? override.enabled
		: typeof globalConfig?.enabled === "boolean"
			? globalConfig.enabled
			: DEFAULT_COMPLETION_BATCH_CONFIG.enabled;
	return {
		enabled,
		debounceMs: parsePositiveInt(override?.debounceMs) ?? parsePositiveInt(globalConfig?.debounceMs) ?? DEFAULT_COMPLETION_BATCH_CONFIG.debounceMs,
		maxWaitMs: parsePositiveInt(override?.maxWaitMs) ?? parsePositiveInt(globalConfig?.maxWaitMs) ?? DEFAULT_COMPLETION_BATCH_CONFIG.maxWaitMs,
		stragglerDebounceMs: parsePositiveInt(override?.stragglerDebounceMs) ?? parsePositiveInt(globalConfig?.stragglerDebounceMs) ?? DEFAULT_COMPLETION_BATCH_CONFIG.stragglerDebounceMs,
		stragglerMaxWaitMs: parsePositiveInt(override?.stragglerMaxWaitMs) ?? parsePositiveInt(globalConfig?.stragglerMaxWaitMs) ?? DEFAULT_COMPLETION_BATCH_CONFIG.stragglerMaxWaitMs,
		stragglerWindowMs: parsePositiveInt(override?.stragglerWindowMs) ?? parsePositiveInt(globalConfig?.stragglerWindowMs) ?? DEFAULT_COMPLETION_BATCH_CONFIG.stragglerWindowMs,
	};
}

type TimerHandle = unknown;

interface TimerApi {
	setTimeout(handler: () => void, delayMs: number): TimerHandle;
	clearTimeout(handle: TimerHandle): void;
}

const defaultTimers: TimerApi = {
	setTimeout: (handler, delayMs) => setTimeout(handler, delayMs),
	clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

function unrefHandle(handle: TimerHandle): void {
	if (handle && typeof handle === "object" && "unref" in handle && typeof (handle as { unref: unknown }).unref === "function") {
		(handle as { unref: () => void }).unref();
	}
}

export interface CompletionBatcherOptions<T> {
	config: ResolvedCompletionBatchConfig;
	emit: (items: T[]) => void;
	timers?: TimerApi;
	now?: () => number;
}

export interface CompletionBatcher<T> {
	/** Add a batchable item. Emits immediately when batching is disabled. */
	push(item: T): void;
	/** Emit any held items immediately as a single group. */
	flush(): void;
	/** Clear timers without emitting. */
	dispose(): void;
}

/**
 * Create a completion batcher. The batcher is single-use per registration: it
 * holds at most one open group. `flush` forces emission; `dispose` tears down
 * timers for reload/shutdown without emitting.
 */
export function createCompletionBatcher<T>(options: CompletionBatcherOptions<T>): CompletionBatcher<T> {
	const timers = options.timers ?? defaultTimers;
	const now = options.now ?? Date.now;
	const config = options.config;

	if (!config.enabled) {
		return {
			push(item: T) {
				options.emit([item]);
			},
			flush() {},
			dispose() {},
		};
	}

	let pending: T[] = [];
	let debounceTimer: TimerHandle | null = null;
	let maxWaitTimer: TimerHandle | null = null;
	let straggler = false;
	let lastEmitAt: number | null = null;

	const clearTimers = () => {
		if (debounceTimer) {
			timers.clearTimeout(debounceTimer);
			debounceTimer = null;
		}
		if (maxWaitTimer) {
			timers.clearTimeout(maxWaitTimer);
			maxWaitTimer = null;
		}
	};

	const emitGroup = () => {
		clearTimers();
		if (pending.length === 0) return;
		const items = pending;
		pending = [];
		lastEmitAt = now();
		options.emit(items);
	};

	return {
		push(item: T) {
			if (pending.length === 0) {
				straggler = lastEmitAt !== null && (now() - lastEmitAt) < config.stragglerWindowMs;
			}
			pending.push(item);

			if (debounceTimer) timers.clearTimeout(debounceTimer);
			const debounceDelay = straggler ? config.stragglerDebounceMs : config.debounceMs;
			debounceTimer = timers.setTimeout(emitGroup, debounceDelay);
			unrefHandle(debounceTimer);

			if (!maxWaitTimer) {
				const maxWaitDelay = straggler ? config.stragglerMaxWaitMs : config.maxWaitMs;
				maxWaitTimer = timers.setTimeout(emitGroup, maxWaitDelay);
				unrefHandle(maxWaitTimer);
			}
		},
		flush: emitGroup,
		dispose() {
			clearTimers();
			pending = [];
		},
	};
}
