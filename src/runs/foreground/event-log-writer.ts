/**
 * Bounded writer for a run's `events.jsonl`.
 *
 * The event log is an append-only audit journal, not workflow truth: truth lives in
 * `status.json` and in each child run's own `status.json`. That distinction matters
 * because the `subagent.workflow.trace` event carries the **entire** trace array on
 * every change, so a producer that keeps emitting trace changes can grow this file
 * without bound — a field incident wrote 28 GB in 33 minutes, and a later one 44.7 GB.
 *
 * This writer accounts bytes so no journal can fill a disk:
 *
 * - **warn line** (default 50 MiB, `PI_SUBAGENTS_EVENT_LOG_WARN_BYTES`): writes one
 *   `subagent.workflow.event_log_warn` event and keeps writing, so a looping producer
 *   surfaces before it becomes an outage;
 * - **hard cap** (default 256 MiB, `PI_SUBAGENTS_EVENT_LOG_LIMIT_BYTES`): writes one
 *   `subagent.workflow.event_log_capped` marker and suppresses everything after it.
 *
 * Both thresholds are env-overridable so the guards can be exercised end-to-end.
 */

import * as fs from "node:fs";

const DEFAULT_LIMIT_BYTES = 256 * 1024 * 1024;
const DEFAULT_WARN_BYTES = 50 * 1024 * 1024;

export interface EventLogWriterOptions {
	eventsPath: string;
	runId?: string;
	/** Hard cap in bytes. Defaults to `PI_SUBAGENTS_EVENT_LOG_LIMIT_BYTES`, then 256 MiB. */
	limitBytes?: number;
	/** Warn line in bytes. Defaults to `PI_SUBAGENTS_EVENT_LOG_WARN_BYTES`, then 50 MiB. Never exceeds `limitBytes`. */
	warnBytes?: number;
	/** Receives the warn/cap notices. Defaults to `console.error`. */
	onWarn?: (message: string) => void;
	/** Test seams. Defaults to `Date.now`, `fs.statSync(...).size`, `fs.appendFileSync`. */
	now?: () => number;
	sizeOf?: (filePath: string) => number;
	appendLine?: (filePath: string, line: string) => void;
}

export interface EventLogWriter {
	/** @returns `true` when the event was written, `false` when suppressed by the hard cap. */
	append(event: Record<string, unknown>): boolean;
	readonly bytesUsed: number;
	readonly capped: boolean;
	readonly warned: boolean;
	readonly limitBytes: number;
	readonly warnBytes: number;
}

function resolveBytes(envName: string, explicit: number | undefined, fallback: number): number {
	if (typeof explicit === "number" && Number.isFinite(explicit) && explicit > 0) return Math.floor(explicit);
	const raw = process.env[envName];
	const parsed = Number(raw);
	if (raw !== undefined && raw !== "" && Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
	return fallback;
}

function defaultSizeOf(filePath: string): number {
	try {
		return fs.statSync(filePath).size;
	} catch {
		// Not created yet, or unreadable: start accounting at zero rather than throw.
		return 0;
	}
}

export function createEventLogWriter(options: EventLogWriterOptions): EventLogWriter {
	const { eventsPath, runId } = options;
	const now = options.now ?? Date.now;
	const sizeOf = options.sizeOf ?? defaultSizeOf;
	const appendLine = options.appendLine ?? ((filePath: string, line: string) => fs.appendFileSync(filePath, line, "utf-8"));
	const onWarn = options.onWarn ?? ((message: string) => console.error(message));
	const limitBytes = resolveBytes("PI_SUBAGENTS_EVENT_LOG_LIMIT_BYTES", options.limitBytes, DEFAULT_LIMIT_BYTES);
	const warnBytes = Math.min(resolveBytes("PI_SUBAGENTS_EVENT_LOG_WARN_BYTES", options.warnBytes, DEFAULT_WARN_BYTES), limitBytes);

	let bytes: number | undefined;
	let capped = false;
	let warned = false;

	const currentBytes = (): number => {
		bytes ??= sizeOf(eventsPath);
		return bytes;
	};

	const writeBestEffort = (event: Record<string, unknown>): void => {
		const line = `${JSON.stringify({ ts: now(), ...(runId ? { runId } : {}), ...event })}\n`;
		try {
			appendLine(eventsPath, line);
			bytes = currentBytes() + Buffer.byteLength(line, "utf-8");
		} catch {
			// A journal notice that cannot be written must not fail the run it is recording.
		}
	};

	const append = (event: Record<string, unknown>): boolean => {
		if (capped) return false;
		const line = `${JSON.stringify({ ts: now(), ...(runId ? { runId } : {}), ...event })}\n`;
		const lineBytes = Buffer.byteLength(line, "utf-8");
		const used = currentBytes();
		if (used + lineBytes > limitBytes) {
			capped = true;
			writeBestEffort({ type: "subagent.workflow.event_log_capped", limitBytes, bytes: used });
			onWarn(`Async workflow event log '${eventsPath}' reached its ${limitBytes}-byte cap; further events are suppressed.`);
			return false;
		}
		if (!warned && used + lineBytes > warnBytes) {
			warned = true;
			writeBestEffort({ type: "subagent.workflow.event_log_warn", warnBytes, limitBytes, bytes: used });
			onWarn(`Async workflow event log '${eventsPath}' passed its ${warnBytes}-byte warn line (hard cap ${limitBytes}); if it keeps growing, the producer is likely looping.`);
		}
		appendLine(eventsPath, line);
		// `writeBestEffort` above already counted the warn line. Re-read the running count instead
		// of the pre-warn snapshot in `used`: adding `lineBytes` to `used` would drop that line from
		// the accounting, so `bytesUsed` would disagree with the journal and later events could pass
		// the hard cap by up to one warn line.
		bytes = currentBytes() + lineBytes;
		return true;
	};

	return {
		append,
		get bytesUsed() {
			return currentBytes();
		},
		get capped() {
			return capped;
		},
		get warned() {
			return warned;
		},
		limitBytes,
		warnBytes,
	};
}
