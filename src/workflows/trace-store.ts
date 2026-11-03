/**
 * Bounded store for `workflow.trace`.
 *
 * The trace is an append-only journal rendered into `status.json` and mirrored into
 * `events.jsonl` on every change. Two properties of the current writer make that
 * dangerous:
 *
 * 1. `runs.run(key)` is idempotent: re-delivering the same launch for an existing key
 *    appends a byte-identical `{ operation: "run", state: "reused" }` entry every time.
 *    A caller that re-delivers in a loop therefore grows the trace without bound.
 * 2. Each change serializes the **whole** trace, so total bytes are `Σ|trace_i| = O(n²)`.
 *
 * Observed in the field: 14,116 entries (14,112 of them byte-identical), a 2.3 MB
 * `status.json`, ~11 GB of cumulative `events.jsonl` writes, and a host process at
 * 10-11 GB RSS pinning one core before it stopped responding. A second run wrote 28 GB
 * in 33 minutes.
 *
 * This store fixes the first half at the source:
 *
 * - `push` folds **consecutive duplicate** entries, so a repeated `reused` delivery
 *   leaves the array unchanged;
 * - `signature` exposes a content fingerprint so callers can skip re-serializing an
 *   unchanged trace;
 * - a hard entry cap (default 4,000, `PI_SUBAGENTS_TRACE_MAX_ENTRIES`) drops the
 *   **oldest** entries and warns once, keeping the recency semantics every `findLast`
 *   consumer depends on.
 */

const DEFAULT_MAX_ENTRIES = 4_000;

export interface TraceStoreOptions<T> {
	/** Hard cap on retained entries. Defaults to `PI_SUBAGENTS_TRACE_MAX_ENTRIES`, then 4,000. */
	maxEntries?: number;
	/** Receives the one-time cap warning. Defaults to `console.error`. */
	onWarn?: (message: string) => void;
	/** Stable per-entry serialization used for duplicate detection. Defaults to `JSON.stringify`. */
	fingerprint?: (entry: T) => string;
}

export interface TraceStore<T> {
	/** The live array. Mutate only through `push`. */
	readonly trace: T[];
	/** @returns `true` when the entry was retained, `false` when folded as a duplicate or dropped at the cap. */
	push(entry: T): boolean;
	/** Content fingerprint of the retained trace; changes only when the content changes. */
	signature(): string;
	readonly length: number;
	readonly capped: boolean;
	readonly dropped: number;
	readonly maxEntries: number;
}

function resolveMaxEntries(explicit: number | undefined): number {
	if (typeof explicit === "number" && Number.isFinite(explicit) && explicit > 0) return Math.floor(explicit);
	const raw = process.env.PI_SUBAGENTS_TRACE_MAX_ENTRIES;
	const parsed = Number(raw);
	if (raw !== undefined && raw !== "" && Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
	return DEFAULT_MAX_ENTRIES;
}

/**
 * Fingerprint of a trace's content.
 *
 * Valid because the trace only appends and consecutive duplicates are folded, so
 * `(length, last entry)` identifies the array a consumer would serialize.
 */
export function traceContentSignature(trace: readonly unknown[]): string {
	if (trace.length === 0) return "0|";
	return `${trace.length}|${JSON.stringify(trace[trace.length - 1])}`;
}

export function createTraceStore<T>(options: TraceStoreOptions<T> = {}): TraceStore<T> {
	const maxEntries = resolveMaxEntries(options.maxEntries);
	const onWarn = options.onWarn ?? ((message: string) => console.error(message));
	const fingerprint = options.fingerprint ?? ((entry: T) => JSON.stringify(entry));
	const trace: T[] = [];
	let capped = false;
	let dropped = 0;

	const push = (entry: T): boolean => {
		const last = trace[trace.length - 1];
		if (last !== undefined && fingerprint(last) === fingerprint(entry)) return false;
		if (trace.length >= maxEntries) {
			// Drop the oldest entry so the newest state still wins for `findLast` consumers.
			trace.shift();
			dropped += 1;
			if (!capped) {
				capped = true;
				onWarn(`Workflow trace reached its ${maxEntries}-entry cap; the oldest entries are dropped (consecutive duplicates were already folded).`);
			}
		}
		trace.push(entry);
		return true;
	};

	return {
		trace,
		push,
		signature: () => traceContentSignature(trace),
		get length() {
			return trace.length;
		},
		get capped() {
			return capped;
		},
		get dropped() {
			return dropped;
		},
		maxEntries,
	};
}
