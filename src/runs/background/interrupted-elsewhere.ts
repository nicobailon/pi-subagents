import { resolvePiSessionId } from "../../shared/session-identity.ts";
import type { AsyncStatus, ForegroundResumeRun } from "../../shared/types.ts";
import { ownerConfirmedDead } from "../foreground/foreground-history.ts";
import { ownerSessionIds } from "../shared/run-ownership.ts";
import type { RawDrainStatusObserver } from "../shared/readonly-drain-observation.ts";
import { currentBootId } from "./boot-id.ts";
import { currentPidNamespaceScope } from "./pid-namespace.ts";
import { checkRecordedPidLiveness } from "./stale-run-reconciler.ts";

/** Runs interrupted longer ago than this are not pointed to. */
const INTERRUPTED_ELSEWHERE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function interruptedElsewhereLine(reopenId: string, count: number): string {
	const command = `\`pi --session ${reopenId}\``;
	return count === 1
		? `1 subagent run was interrupted in another session. Reopen it to resume it: ${command}`
		: `${count} subagent runs were interrupted in another session. Reopen it to resume them: ${command}`;
}

interface InterruptedElsewhereCollector {
	/** Observer for the async statuses session start already reads; keeps foreign ones that may be interrupted. */
	observeStatus: RawDrainStatusObserver;
	/** Receives the foreground records of other sessions that session start already reads. */
	observeForegroundRun: (run: ForegroundResumeRun) => void;
	/** One line per other session that can be reopened and has runs whose Pi is dead. */
	lines: () => string[];
}

/**
 * Collects runs of other sessions in this folder that were cut off because their Pi died, from what
 * session start reads anyway. Read-only: nothing is written to those runs or sessions. The cheap
 * filters run as records arrive; `lines` reads each session file's header once, then probes each
 * candidate's pid once.
 */
export function createInterruptedElsewhereCollector(input: { currentSessionId: string; cwd: string; now: number }): InterruptedElsewhereCollector {
	const ownSessions = ownerSessionIds(input.currentSessionId);
	// sessionId -> runId -> whether its owner is dead; a run seen from both sources counts once.
	const candidates = new Map<string, Map<string, () => boolean>>();
	const recent = (at: unknown) => typeof at === "number" && input.now - at <= INTERRUPTED_ELSEWHERE_MAX_AGE_MS;
	const add = (sessionId: string, runId: string, ownerDead: () => boolean) => {
		if (ownSessions.has(sessionId)) return;
		const runs = candidates.get(sessionId) ?? new Map<string, () => boolean>();
		if (!runs.has(runId)) runs.set(runId, ownerDead);
		candidates.set(sessionId, runs);
	};
	return {
		observeStatus(observed) {
			// The listing passes the status.json values it read.
			const status = observed as Partial<AsyncStatus> | null;
			if (!status || typeof status.sessionId !== "string" || typeof status.runId !== "string" || (status.state !== "running" && status.state !== "queued")) return;
			if (status.parentWorkflowRunId !== undefined || status.cwd !== input.cwd || !recent(status.lastUpdate ?? status.startedAt)) return;
			const { pid, pidNamespaceScope, bootId } = status;
			if (typeof pid !== "number") return;
			add(status.sessionId, status.runId, () => checkRecordedPidLiveness({ pid, pidNamespaceScope, bootId }, { observedScope: currentPidNamespaceScope(), observedBootId: currentBootId() }) === "dead");
		},
		observeForegroundRun(run) {
			if (!run.sessionId || run.parentWorkflowRunId !== undefined || run.cwd !== input.cwd || !recent(run.updatedAt)) return;
			add(run.sessionId, run.runId, () => ownerConfirmedDead(run));
		},
		lines() {
			const lines: string[] = [];
			for (const [sessionId, runs] of candidates) {
				// Only a persisted session can be reopened; its id is then its file path, whose header names
				// the id `pi --session` resolves, so the command needs no quoting in any shell.
				const reopenId = resolvePiSessionId(sessionId);
				if (!reopenId) continue;
				let interrupted = 0;
				for (const ownerDead of runs.values()) if (ownerDead()) interrupted += 1;
				if (interrupted > 0) lines.push(interruptedElsewhereLine(reopenId, interrupted));
			}
			return lines;
		},
	};
}
