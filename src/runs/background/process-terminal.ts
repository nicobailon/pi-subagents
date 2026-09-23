import * as fs from "node:fs";
import * as path from "node:path";
import { writeAtomicJson } from "../../shared/atomic-json.ts";
import {
	SUBAGENT_LIFECYCLE_ARTIFACT_VERSION,
	type AsyncStatus,
	type CanonicalSessionTerminal,
	type ProcessInstanceExit,
	type ProcessTerminalReason,
	type ProcessTerminal,
} from "../../shared/types.ts";
import { canonicalSessionId, inspectSessionLease } from "../shared/session-lease.ts";
import { releaseActiveRunIndex } from "./active-run-index.ts";
import { isRecord, validProcessInstance, readProcessTerminalCandidate, writeProcessTerminalCandidate, type ProcessTerminalCandidate } from "./process-terminal-candidate.ts";
export { processTerminalCandidatePath, readProcessTerminalCandidate, writeProcessTerminalCandidate, markProcessTerminalCandidateLeaseRelease } from "./process-terminal-candidate.ts";
export type { ProcessTerminalCandidate } from "./process-terminal-candidate.ts";

export interface RunnerCloseObservation {
	processInstanceId: string;
	closeObservedAt: number;
	exitCode: number | null;
	signal: string | null;
}

export function processTerminalPath(asyncDir: string): string {
	return path.join(asyncDir, "process-terminal.json");
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Establish ownership before authorizing a runner to start any child session. */
export function initializeProcessTerminal(asyncDir: string, runId: string, runnerProcessInstanceId: string): void {
	writeProcessTerminalCandidate(asyncDir, {
		version: 1,
		runId,
		runnerProcessInstanceId,
		writers: {},
	});
	writeAtomicJson(processTerminalPath(asyncDir), {
		version: 1,
		state: "pending",
		runId,
		runnerProcessInstanceId,
	});
}

function unknownProof(runId: string, runnerProcessInstanceId: string, reason: ProcessTerminalReason, diagnostic?: string): ProcessTerminal {
	return { version: 1, state: "unknown", runId, runnerProcessInstanceId, reason, ...(diagnostic ? { diagnostic } : {}) };
}

function resumeDisposition(state: string | undefined, sessionFile: string | undefined): "resumable" | "non-resumable" | "unavailable" {
	if (state === "stopped") return "non-resumable";
	if (state !== "complete" && state !== "completed" && state !== "failed" && state !== "paused") return "unavailable";
	return sessionFile && fs.existsSync(sessionFile) ? "resumable" : "unavailable";
}

function sessionProjection(candidate: ProcessTerminalCandidate, lease: ReturnType<typeof inspectSessionLease>): CanonicalSessionTerminal | undefined {
	if (!candidate.sessionFile || lease.state !== "free") return undefined;
	if (candidate.revivalLeaseToken && candidate.revivalLeaseReleaseAcknowledged !== true) return undefined;
	return {
		canonicalSessionId: canonicalSessionId(candidate.sessionFile),
		leaseDisposition: candidate.revivalLeaseToken ? "released" : "not-held",
		freeAtObservation: true,
		...(candidate.revivalLeaseToken ? { canonicalSessionLeaseReleased: true } : {}),
	};
}

function validateProof(raw: unknown, asyncDir: string, fallback?: { runId?: string; runnerProcessInstanceId?: string }): raw is ProcessTerminal {
	if (!isRecord(raw) || raw.version !== 1 || !["pending", "observed", "unknown", "not-started"].includes(String(raw.state)) || typeof raw.runId !== "string" || !raw.runId || typeof raw.runnerProcessInstanceId !== "string" || !raw.runnerProcessInstanceId) {
		throw new Error(`Invalid process-terminal proof in '${asyncDir}'.`);
	}
	if (fallback?.runId && raw.runId !== fallback.runId) throw new Error(`Process-terminal proof in '${asyncDir}' belongs to run '${raw.runId}', expected '${fallback.runId}'.`);
	if (fallback?.runnerProcessInstanceId && raw.runnerProcessInstanceId !== fallback.runnerProcessInstanceId) throw new Error(`Process-terminal proof in '${asyncDir}' belongs to runner '${raw.runnerProcessInstanceId}', expected '${fallback.runnerProcessInstanceId}'.`);
	if (raw.instances !== undefined && (!Array.isArray(raw.instances) || !raw.instances.every((entry) => validProcessInstance(entry)))) {
		throw new Error(`Invalid process-terminal instances in '${asyncDir}'.`);
	}
	if (raw.state === "observed") {
		if (typeof raw.observedAt !== "number" || !Number.isFinite(raw.observedAt)) throw new Error(`Observed process-terminal proof in '${asyncDir}' is missing observedAt.`);
		if (!Array.isArray(raw.instances)) throw new Error(`Observed process-terminal proof in '${asyncDir}' is missing instances.`);
		const runner = raw.instances.find((entry) => isRecord(entry) && entry.kind === "runner");
		if (!validProcessInstance(runner, "runner") || runner.processInstanceId !== raw.runnerProcessInstanceId) throw new Error(`Observed process-terminal proof in '${asyncDir}' has no matching runner instance.`);
	}
	if (raw.resumeDisposition !== undefined && !["resumable", "non-resumable", "unavailable"].includes(String(raw.resumeDisposition))) throw new Error(`Invalid process-terminal resume disposition in '${asyncDir}'.`);
	return true;
}

export function sanitizeProcessTerminal(value: unknown, fallback: { runId?: string; runnerProcessInstanceId?: string }, label = "status"): ProcessTerminal | undefined {
	if (value === undefined) return undefined;
	try {
		validateProof(value, label, fallback);
		return value as ProcessTerminal;
	} catch (error) {
		return unknownProof(fallback.runId ?? label, fallback.runnerProcessInstanceId ?? "unknown", "proof-write-failed", errorMessage(error));
	}
}

export function readProcessTerminal(asyncDir: string, fallback?: { runId?: string; runnerProcessInstanceId?: string }): ProcessTerminal | undefined {
	try {
		const raw = JSON.parse(fs.readFileSync(processTerminalPath(asyncDir), "utf-8")) as unknown;
		validateProof(raw, asyncDir, fallback);
		return raw as ProcessTerminal;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		return unknownProof(fallback?.runId ?? path.basename(asyncDir), fallback?.runnerProcessInstanceId ?? "unknown", "proof-write-failed", errorMessage(error));
	}
}

function stepProcessTerminalProof(
	proof: ProcessTerminal,
	childIndex: number,
	state: ProcessTerminal["state"],
	records: ProcessInstanceExit[],
	resumeDispositionValue: ProcessTerminal["resumeDisposition"],
): ProcessTerminal {
	const base = {
		version: 1 as const,
		runId: proof.runId,
		childIndex,
		runnerProcessInstanceId: proof.runnerProcessInstanceId,
		...(resumeDispositionValue ? { resumeDisposition: resumeDispositionValue } : {}),
	};
	if (state === "observed") {
		return { ...base, state, observedAt: proof.state === "observed" ? proof.observedAt : Date.now(), instances: records };
	}
	if (state === "unknown") {
		return { ...base, state, reason: proof.state === "unknown" ? proof.reason : "writer-close-unverified" };
	}
	return { ...base, state };
}

function overlayStatus(asyncDir: string, proof: ProcessTerminal, candidate?: ProcessTerminalCandidate): void {
	const statusPath = path.join(asyncDir, "status.json");
	try {
		const status = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatus;
		status.processTerminal = proof;
		if (status.steps) {
			for (const [index, step] of status.steps.entries()) {
				const records = candidate?.writers[String(index)] ?? [];
				const expected = candidate?.expectedWriters?.[String(index)] ?? (records.length > 0 ? records.length : 0);
				const stepState = expected === 0 ? "not-started" : proof.state === "observed" && records.length === expected ? "observed" : proof.state === "pending" ? "pending" : "unknown";
				step.processTerminal = stepProcessTerminalProof(proof, index, stepState, records, resumeDisposition(step.status, step.sessionFile ?? candidate?.sessionFile));
			}
		}
		writeAtomicJson(statusPath, status);
	} catch {
		// The proof sidecar remains authoritative when terminal status is unavailable.
	}
}

export function finalizeProcessTerminal(
	asyncDir: string,
	runId: string,
	runnerClose: RunnerCloseObservation,
): ProcessTerminal {
	const existing = readProcessTerminal(asyncDir, { runId, runnerProcessInstanceId: runnerClose.processInstanceId });
	if (existing && fs.existsSync(processTerminalPath(asyncDir))) {
		if (existing.state === "observed" && existing.runId === runId && existing.runnerProcessInstanceId === runnerClose.processInstanceId) return existing;
		if (existing.state === "unknown") {
			// A sticky runner-published unknown proof keeps its reason; only add the observed exit. Unreadable or mismatched sidecars read back as proof-write-failed and stay untouched.
			if (existing.instances?.length || existing.reason === "proof-write-failed") return existing;
			const withExit: ProcessTerminal = { ...existing, instances: [{ kind: "runner", ...runnerClose }] };
			try {
				writeAtomicJson(processTerminalPath(asyncDir), withExit);
				return withExit;
			} catch {
				return existing;
			}
		}
	}
	let proof: ProcessTerminal;
	let candidateForOverlay: ProcessTerminalCandidate | undefined;
	try {
		const candidate = readProcessTerminalCandidate(asyncDir);
		candidateForOverlay = candidate;
		if (!candidate) proof = unknownProof(runId, runnerClose.processInstanceId, "runner-candidate-missing");
		else if (candidate.runId !== runId || candidate.runnerProcessInstanceId !== runnerClose.processInstanceId) proof = unknownProof(runId, runnerClose.processInstanceId, "runner-instance-mismatch");
		else {
			const allWriters = Object.values(candidate.writers).flat();
			const status = (() => {
				try { return JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8")) as AsyncStatus; } catch { return undefined; }
			})();
			const session = candidate.sessionFile ? inspectSessionLease(candidate.sessionFile) : undefined;
			const writerEntries = Object.entries(candidate.writers);
			const expectedWriters = candidate.expectedWriters ?? Object.fromEntries(writerEntries.map(([index, records]) => [index, records.length]));
			const expectedEntries = Object.entries(expectedWriters);
			const expectedIndexes = new Set(expectedEntries.map(([index]) => index));
			const writerIndexes = new Set(writerEntries.map(([index]) => index));
			const inconsistentWriters = writerEntries.some(([index, records]) => !expectedIndexes.has(index) || records.length !== expectedWriters[index])
				|| expectedEntries.some(([index, expected]) => !writerIndexes.has(index) && expected !== 0);
			if (session && session.state !== "free") {
				proof = unknownProof(runId, runnerClose.processInstanceId, session.state === "owned" ? "canonical-session-lease-active" : "canonical-session-unavailable");
			} else if (candidate.revivalLeaseToken && candidate.revivalLeaseReleaseAcknowledged !== true) {
				proof = unknownProof(runId, runnerClose.processInstanceId, "canonical-session-release-unverified");
			} else if (inconsistentWriters || (allWriters.length === 0 && expectedEntries.length === 0)) {
				proof = unknownProof(runId, runnerClose.processInstanceId, "writer-close-unverified");
			} else if (allWriters.some((writer) => writer.kind === "pi-writer" && writer.processTree.state !== "observed")) {
				proof = unknownProof(runId, runnerClose.processInstanceId, "process-tree-unverified");
			} else {
				const runner: ProcessInstanceExit = { kind: "runner", ...runnerClose };
				const canonicalSession = session && sessionProjection(candidate, session);
				proof = {
					version: 1,
					state: "observed",
					runId,
					runnerProcessInstanceId: runnerClose.processInstanceId,
					observedAt: runnerClose.closeObservedAt,
					instances: [runner, ...allWriters],
					resumeDisposition: resumeDisposition(status?.state, candidate.sessionFile ?? status?.sessionFile),
					...(canonicalSession ? { canonicalSession } : {}),
				};
			}
		}
	} catch (error) {
		proof = unknownProof(runId, runnerClose.processInstanceId, "proof-write-failed", errorMessage(error));
	}
	// An unverified process tree still has a directly observed runner exit; keep it for failure reports.
	if (proof.state === "unknown") proof = { ...proof, instances: [{ kind: "runner", ...runnerClose }] };
	let durable = false;
	try {
		writeAtomicJson(processTerminalPath(asyncDir), proof);
		durable = true;
		if (proof.state === "observed") releaseActiveRunIndex(asyncDir);
		overlayStatus(asyncDir, proof, candidateForOverlay);
		fs.appendFileSync(path.join(asyncDir, "events.jsonl"), `${JSON.stringify({ type: "subagent.run.process_terminal", lifecycleArtifactVersion: SUBAGENT_LIFECYCLE_ARTIFACT_VERSION, ts: Date.now(), runId, processTerminal: proof })}\n`, "utf-8");
	} catch {
		// Do not emit a process-terminal event when the proof sidecar was not durable.
	}
	return durable ? proof : unknownProof(runId, runnerClose.processInstanceId, "proof-write-failed", "Failed to persist process-terminal proof.");
}
