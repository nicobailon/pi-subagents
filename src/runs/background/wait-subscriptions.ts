import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { listAsyncRuns, type AsyncRunSummary } from "./async-status.ts";
import { formatResumeFirstFailedRunDetail } from "./resume-guidance.ts";
import { readCompletionReplay } from "./completion-replay.ts";
import { writeAtomicJson } from "../../shared/atomic-json.ts";
import {
	DIRS,
	INTERCOM_DETACH_REQUEST_EVENT,
	SUBAGENT_ASYNC_COMPLETE_EVENT,
	SUBAGENT_CONTROL_EVENT,
	SUBAGENT_CONTROL_INTERCOM_EVENT,
	SUBAGENT_FOREGROUND_COMPLETE_EVENT,
	SUBAGENT_RESULT_INTERCOM_EVENT,
	type SubagentState,
	type WaitCompletion,
	type WaitSubscriptionRecord,
} from "../../shared/types.ts";

const SUBSCRIPTION_VERSION = 1;
const RECONCILE_INTERVAL_MS = 1_000;
/**
 * How often the subscriptions directory is re-scanned for expired records left
 * by other sessions. Rare compared to RECONCILE_INTERVAL_MS because it costs a
 * directory read, and nothing depends on the sweep being prompt.
 */
const FOREIGN_SWEEP_INTERVAL_MS = 60_000;
/**
 * How far past expiry a record armed by another session is kept before it is
 * swept. The owning session settles its own expired records with a "timed out"
 * notice on the next restore(), so removing one the moment it expires would take
 * that notice away from a session that simply had not resumed yet. A day is long
 * enough for an ordinary return and short enough to bound the directory.
 */
const FOREIGN_SWEEP_GRACE_MS = 24 * 60 * 60 * 1000;

export interface ArmWaitSubscriptionInput {
	targetKind: "async" | "foreground";
	runId: string;
	requestedId: string;
	timeoutMs: number;
}

export interface WaitSubscriptionManager {
	arm(input: ArmWaitSubscriptionInput): WaitSubscriptionRecord;
	restore(): void;
	reconcile(): void;
	dispose(): void;
}

interface WaitSubscriptionManagerOptions {
	asyncDirRoot?: string;
	resultsDir?: string;
	subscriptionsDir?: string;
	now?: () => number;
	pollIntervalMs?: number;
	kill?: (pid: number, signal?: NodeJS.Signals | 0) => boolean;
}

function isNotFound(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function parseRecord(value: unknown): WaitSubscriptionRecord | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Partial<WaitSubscriptionRecord>;
	if (record.version !== SUBSCRIPTION_VERSION
		|| typeof record.token !== "string"
		|| !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(record.token)
		|| typeof record.sessionId !== "string"
		|| (record.targetKind !== "async" && record.targetKind !== "foreground")
		|| typeof record.runId !== "string"
		|| typeof record.requestedId !== "string"
		|| typeof record.createdAt !== "number"
		|| typeof record.expiresAt !== "number") return undefined;
	return record as WaitSubscriptionRecord;
}

function needsAttention(run: AsyncRunSummary): boolean {
	return run.activityState === "needs_attention" || run.steps.some((step) => step.activityState === "needs_attention");
}

function subscriptionFile(dir: string, token: string): string {
	return path.join(dir, `${token}.json`);
}

export function formatWaitSubscriptions(state: Pick<SubagentState, "waitSubscriptions">, now = Date.now()): string | undefined {
	const subscriptions = [...(state.waitSubscriptions?.values() ?? [])].sort((left, right) => left.createdAt - right.createdAt);
	if (subscriptions.length === 0) return undefined;
	const lines = [`Armed wait subscriptions (${subscriptions.length}):`];
	for (const record of subscriptions) {
		lines.push(`- ${record.token}: ${record.targetKind} run ${record.runId}, timeout in ${Math.max(0, record.expiresAt - now)}ms`);
	}
	return lines.join("\n");
}

export function createWaitSubscriptionManager(
	pi: Pick<ExtensionAPI, "events" | "sendMessage">,
	state: SubagentState,
	options: WaitSubscriptionManagerOptions = {},
): WaitSubscriptionManager {
	const asyncDirRoot = options.asyncDirRoot ?? DIRS.async;
	const resultsDir = options.resultsDir ?? DIRS.results;
	const subscriptionsDir = options.subscriptionsDir ?? path.join(path.dirname(asyncDirRoot), "wait-subscriptions");
	const now = options.now ?? Date.now;
	const subscriptions = state.waitSubscriptions ?? new Map<string, WaitSubscriptionRecord>();
	state.waitSubscriptions = subscriptions;
	const unresolvedRestoredForegroundTokens = new Set<string>();
	let disposed = false;
	let lastForeignSweepAt = 0;

	/**
	 * Remove expired records armed by another session.
	 *
	 * Only the owning session can be woken, so restore() never loads a foreign
	 * record into `subscriptions` and reconcileRecord() returns before its
	 * timeout branch. Nothing reconciles such a record and nothing expires it, so
	 * a session that arms a wait and never comes back (forked, renamed, deleted)
	 * leaves one file here per wait, forever.
	 *
	 * Kept for FOREIGN_SWEEP_GRACE_MS past expiry so an owner that resumes late
	 * still finds its record and gets the timeout notice.
	 *
	 * Runs on the reconcile timer as well as at restore(), because a record that
	 * is still live when another session starts would otherwise never be looked
	 * at again: restore() only fires on session_start, and reconcile() walks the
	 * in-memory map, which holds current-session records only. A host that keeps
	 * one session open for hours is exactly where that gap bites.
	 *
	 * Never throws: it runs from the reconcile timer.
	 */
	const sweepExpiredForeignSubscriptions = (force = false) => {
		const sweptAt = now();
		if (!force && sweptAt - lastForeignSweepAt < FOREIGN_SWEEP_INTERVAL_MS) return;
		lastForeignSweepAt = sweptAt;
		let files: string[];
		try {
			files = fs.readdirSync(subscriptionsDir).filter((file) => file.endsWith(".json"));
		} catch (error) {
			if (!isNotFound(error)) console.error(`Failed to scan wait subscriptions in '${subscriptionsDir}':`, error);
			return;
		}
		for (const file of files) {
			const filePath = path.join(subscriptionsDir, file);
			let record: WaitSubscriptionRecord | undefined;
			try {
				record = parseRecord(JSON.parse(fs.readFileSync(filePath, "utf-8")));
			} catch (error) {
				console.error(`Ignoring invalid wait subscription '${filePath}':`, error);
				continue;
			}
			if (!record || file !== `${record.token}.json`) continue;
			// The owning session keeps its own expired records so reconcileRecord()
			// can still settle them with the "timed out" notice callers expect.
			if (record.sessionId === state.currentSessionId) continue;
			if (sweptAt < record.expiresAt + FOREIGN_SWEEP_GRACE_MS) continue;
			try {
				fs.unlinkSync(filePath);
			} catch (error) {
				// Losing this race is harmless: another session may have swept the
				// same expired record. Anything else is reported and retried on the
				// next sweep rather than interrupting the caller.
				if (!isNotFound(error)) console.error(`Failed to remove expired wait subscription '${filePath}':`, error);
			}
		}
	};

	const remove = (record: WaitSubscriptionRecord) => {
		try {
			fs.unlinkSync(subscriptionFile(subscriptionsDir, record.token));
		} catch (error) {
			if (!isNotFound(error)) throw error;
		}
		subscriptions.delete(record.token);
		unresolvedRestoredForegroundTokens.delete(record.token);
	};

	const settle = (record: WaitSubscriptionRecord, outcome: string, detail: string, completion?: WaitCompletion) => {
		if (disposed || state.currentSessionId !== record.sessionId) return;
		try {
			remove(record);
		} catch (error) {
			console.error(`Failed to clear wait subscription '${record.token}'; it remains armed:`, error);
			return;
		}
		try {
			pi.sendMessage({
				customType: "subagent-wait-subscription",
				content: `Wait subscription ${record.token} fired for run ${record.runId}: ${outcome}. ${detail}`,
				display: true,
				details: {
					token: record.token,
					runId: record.runId,
					outcome,
					...(completion ? { completions: [completion] } : {}),
				},
			}, { triggerTurn: true });
		} catch (error) {
			console.error(`Failed to deliver wait subscription '${record.token}' after clearing it:`, error);
		}
	};

	const reconcileRecord = (record: WaitSubscriptionRecord) => {
		if (record.sessionId !== state.currentSessionId) return;
		if (now() >= record.expiresAt) {
			settle(record, "timed out", "The targeted run may still be active; inspect its status before taking follow-up action.");
			return;
		}
		if (record.targetKind === "foreground") {
			const run = state.foregroundRuns?.get(record.runId);
			if (!run && unresolvedRestoredForegroundTokens.has(record.token)) return;
			if (run) unresolvedRestoredForegroundTokens.delete(record.token);
			if (!run || run.sessionId !== record.sessionId) {
				settle(record, "could not be reconciled", "The remembered foreground run disappeared before completion was confirmed.");
				return;
			}
			const detached = run.children.filter((child) => child.status === "detached");
			if (detached.some((child) => child.activityState === "needs_attention")) {
				settle(record, "needs attention", "Reply to the pending supervisor request or inspect the run status.");
				return;
			}
			if (detached.length === 0) {
				const failed = run.children.some((child) => child.status === "failed");
				settle(record, failed ? "failed" : "completed", "Inspect the run status for its final output.");
			}
			return;
		}

		const runs = listAsyncRuns(asyncDirRoot, {
			sessionId: record.sessionId,
			runId: record.runId,
			resultsDir,
			kill: options.kill,
			now,
		});
		const run = runs.find((candidate) => candidate.id === record.runId);
		if (!run) {
			settle(record, "could not be reconciled", "The exact async run disappeared before a terminal result was confirmed.");
			return;
		}
		if (needsAttention(run)) {
			settle(record, "needs attention", "Inspect the run status and answer any pending supervisor request.");
			return;
		}
		if (run.state !== "queued" && run.state !== "running") {
			let completion: WaitCompletion | undefined;
			try {
				completion = readCompletionReplay(resultsDir, record.runId, { sessionId: record.sessionId, now: now() })?.completion;
			} catch (error) {
				console.error(`Failed to read completion replay for wait subscription '${record.token}':`, error);
			}
			const detail = formatResumeFirstFailedRunDetail(run) ?? "Inspect the run status for its final output.";
			const archiveDetail = completion?.archivePath ? ` Completion archive: ${completion.archivePath}.` : "";
			settle(record, run.state === "complete" ? "completed" : run.state, `${detail}${archiveDetail}`, completion);
		}
	};

	const reconcile = () => {
		if (disposed) return;
		// Before the session check: with no current session every record is
		// foreign, and expired ones should still be cleaned up.
		sweepExpiredForeignSubscriptions();
		if (!state.currentSessionId) return;
		for (const record of [...subscriptions.values()]) {
			try {
				reconcileRecord(record);
			} catch (error) {
				console.error(`Failed to reconcile wait subscription '${record.token}':`, error);
				settle(record, "reconciliation failed", "The targeted run could not be reconciled. Inspect its status before taking follow-up action.");
			}
		}
	};

	const wakeChannels = [
		INTERCOM_DETACH_REQUEST_EVENT,
		SUBAGENT_ASYNC_COMPLETE_EVENT,
		SUBAGENT_FOREGROUND_COMPLETE_EVENT,
		SUBAGENT_CONTROL_EVENT,
		SUBAGENT_CONTROL_INTERCOM_EVENT,
		SUBAGENT_RESULT_INTERCOM_EVENT,
	];
	const unsubscribes = wakeChannels.map((channel) => pi.events.on(channel, reconcile));
	const interval = setInterval(reconcile, options.pollIntervalMs ?? RECONCILE_INTERVAL_MS);
	interval.unref?.();

	return {
		arm(input) {
			const sessionId = state.currentSessionId;
			if (!sessionId) throw new Error("A wait subscription requires an active session identity.");
			const createdAt = now();
			const record: WaitSubscriptionRecord = {
				version: SUBSCRIPTION_VERSION,
				token: randomUUID(),
				sessionId,
				targetKind: input.targetKind,
				runId: input.runId,
				requestedId: input.requestedId,
				createdAt,
				expiresAt: createdAt + input.timeoutMs,
			};
			fs.mkdirSync(subscriptionsDir, { recursive: true });
			writeAtomicJson(subscriptionFile(subscriptionsDir, record.token), record);
			subscriptions.set(record.token, record);
			return record;
		},
		restore() {
			subscriptions.clear();
			unresolvedRestoredForegroundTokens.clear();
			// Unconditional: a process that starts without a session identity should
			// still clear records nobody can act on.
			sweepExpiredForeignSubscriptions(true);
			if (!state.currentSessionId) return;
			let files: string[];
			try {
				files = fs.readdirSync(subscriptionsDir).filter((file) => file.endsWith(".json"));
			} catch (error) {
				if (isNotFound(error)) return;
				throw error;
			}
			for (const file of files) {
				try {
					const record = parseRecord(JSON.parse(fs.readFileSync(path.join(subscriptionsDir, file), "utf-8")));
					if (!record || file !== `${record.token}.json`) continue;
					if (record.sessionId === state.currentSessionId) {
						subscriptions.set(record.token, record);
						if (record.targetKind === "foreground" && !state.foregroundRuns?.has(record.runId)) unresolvedRestoredForegroundTokens.add(record.token);
					}
				} catch (error) {
					console.error(`Ignoring invalid wait subscription '${path.join(subscriptionsDir, file)}':`, error);
				}
			}
			reconcile();
		},
		reconcile,
		dispose() {
			if (disposed) return;
			disposed = true;
			clearInterval(interval);
			for (const unsubscribe of unsubscribes) {
				try { unsubscribe(); } catch { /* best effort */ }
			}
			subscriptions.clear();
		},
	};
}
