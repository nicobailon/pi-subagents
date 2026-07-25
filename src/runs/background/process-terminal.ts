import * as fs from "node:fs";
import * as path from "node:path";
import { writeAtomicJson, writePrivateAtomicJson } from "../../shared/atomic-json.ts";
import {
	SUBAGENT_LIFECYCLE_ARTIFACT_VERSION,
	type AsyncStatus,
	type CanonicalSessionTerminalV1,
	type ProcessInstanceExitV1,
	type ProcessTerminalReason,
	type ProcessTerminalV1,
} from "../../shared/types.ts";
import { canonicalSessionId, inspectSessionLease } from "../shared/session-lease.ts";

export interface ProcessTerminalCandidate {
	version: 1;
	runId: string;
	runnerProcessInstanceId: string;
	writers: Record<string, ProcessInstanceExitV1[]>;
	expectedWriters?: Record<string, number>;
	sessionFile?: string;
	revivalLeaseToken?: string;
	revivalLeaseReleaseAcknowledged?: boolean;
}

export interface RunnerCloseObservation {
	processInstanceId: string;
	closeObservedAt: number;
	exitCode: number | null;
	signal: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validProcessInstance(value: unknown, kind?: "runner" | "pi-writer"): value is ProcessInstanceExitV1 {
	if (!isRecord(value)) return false;
	return typeof value.processInstanceId === "string"
		&& value.processInstanceId.length > 0
		&& (kind ? value.kind === kind : (value.kind === "runner" || value.kind === "pi-writer"))
		&& typeof value.closeObservedAt === "number"
		&& Number.isFinite(value.closeObservedAt)
		&& (typeof value.exitCode === "number" || value.exitCode === null)
		&& (typeof value.signal === "string" || value.signal === null);
}

function validInstance(value: unknown): value is ProcessInstanceExitV1 {
	return validProcessInstance(value, "pi-writer");
}

export function processTerminalCandidatePath(asyncDir: string): string {
	return path.join(asyncDir, "process-terminal-candidate.json");
}

export function processTerminalPath(asyncDir: string): string {
	return path.join(asyncDir, "process-terminal.json");
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function readProcessTerminalCandidate(asyncDir: string): ProcessTerminalCandidate | undefined {
	try {
		const raw = JSON.parse(fs.readFileSync(processTerminalCandidatePath(asyncDir), "utf-8")) as unknown;
		if (!isRecord(raw) || raw.version !== 1 || typeof raw.runId !== "string" || typeof raw.runnerProcessInstanceId !== "string" || !isRecord(raw.writers)) {
			throw new Error(`Invalid process-terminal candidate in '${asyncDir}'.`);
		}
		const writers: Record<string, ProcessInstanceExitV1[]> = {};
		for (const [index, entries] of Object.entries(raw.writers)) {
			if (!Array.isArray(entries) || !entries.every(validInstance)) throw new Error(`Invalid writer process records for child '${index}'.`);
			writers[index] = entries;
		}
		let expectedWriters: Record<string, number> | undefined;
		if (raw.expectedWriters !== undefined) {
			if (!isRecord(raw.expectedWriters)) throw new Error("Invalid expected writer process records.");
			expectedWriters = {};
			for (const [index, count] of Object.entries(raw.expectedWriters)) {
				if (typeof count !== "number" || !Number.isInteger(count) || count < 0) throw new Error(`Invalid expected writer count for child '${index}'.`);
				expectedWriters[index] = count;
			}
		}
		if (raw.sessionFile !== undefined && typeof raw.sessionFile !== "string") throw new Error("Invalid process-terminal candidate sessionFile.");
		if (raw.revivalLeaseToken !== undefined && typeof raw.revivalLeaseToken !== "string") throw new Error("Invalid process-terminal candidate lease token.");
		if (raw.revivalLeaseReleaseAcknowledged !== undefined && typeof raw.revivalLeaseReleaseAcknowledged !== "boolean") throw new Error("Invalid process-terminal lease release acknowledgement.");
		return {
			version: 1,
			runId: raw.runId,
			runnerProcessInstanceId: raw.runnerProcessInstanceId,
			writers,
			...(expectedWriters ? { expectedWriters } : {}),
			...(raw.sessionFile ? { sessionFile: raw.sessionFile } : {}),
			...(raw.revivalLeaseToken ? { revivalLeaseToken: raw.revivalLeaseToken } : {}),
			...(raw.revivalLeaseReleaseAcknowledged !== undefined ? { revivalLeaseReleaseAcknowledged: raw.revivalLeaseReleaseAcknowledged } : {}),
		};
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

export function writeProcessTerminalCandidate(asyncDir: string, candidate: ProcessTerminalCandidate): void {
	writePrivateAtomicJson(processTerminalCandidatePath(asyncDir), candidate);
}

export function markProcessTerminalCandidateLeaseRelease(asyncDir: string, token: string, acknowledged: boolean): void {
	const candidate = readProcessTerminalCandidate(asyncDir);
	if (!candidate || candidate.revivalLeaseToken !== token) return;
	writeProcessTerminalCandidate(asyncDir, { ...candidate, revivalLeaseReleaseAcknowledged: acknowledged });
}

function unknownProof(runId: string, runnerProcessInstanceId: string, reason: ProcessTerminalReason, diagnostic?: string): ProcessTerminalV1 {
	return { version: 1, state: "unknown", runId, runnerProcessInstanceId, reason, ...(diagnostic ? { diagnostic } : {}) };
}

function resumeDisposition(state: string | undefined, sessionFile: string | undefined): "resumable" | "non-resumable" | "unavailable" {
	if (state === "stopped") return "non-resumable";
	if (state !== "complete" && state !== "completed" && state !== "failed" && state !== "paused") return "unavailable";
	return sessionFile && fs.existsSync(sessionFile) ? "resumable" : "unavailable";
}

function sessionProjection(candidate: ProcessTerminalCandidate, lease: ReturnType<typeof inspectSessionLease>): CanonicalSessionTerminalV1 | undefined {
	if (!candidate.sessionFile || lease.state !== "free") return undefined;
	if (candidate.revivalLeaseToken && candidate.revivalLeaseReleaseAcknowledged !== true) return undefined;
	return {
		canonicalSessionId: canonicalSessionId(candidate.sessionFile),
		leaseDisposition: candidate.revivalLeaseToken ? "released" : "not-held",
		freeAtObservation: true,
		...(candidate.revivalLeaseToken ? { canonicalSessionLeaseReleased: true } : {}),
	};
}

function validateProof(raw: unknown, asyncDir: string, fallback?: { runId?: string; runnerProcessInstanceId?: string }): raw is ProcessTerminalV1 {
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

export function sanitizeProcessTerminal(value: unknown, fallback: { runId?: string; runnerProcessInstanceId?: string }, label = "status"): ProcessTerminalV1 | undefined {
	if (value === undefined) return undefined;
	try {
		validateProof(value, label, fallback);
		return value;
	} catch (error) {
		return unknownProof(fallback.runId ?? label, fallback.runnerProcessInstanceId ?? "unknown", "proof-write-failed", errorMessage(error));
	}
}

export function readProcessTerminal(asyncDir: string, fallback?: { runId?: string; runnerProcessInstanceId?: string }): ProcessTerminalV1 | undefined {
	try {
		const raw = JSON.parse(fs.readFileSync(processTerminalPath(asyncDir), "utf-8")) as unknown;
		validateProof(raw, asyncDir, fallback);
		return raw;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		return unknownProof(fallback?.runId ?? path.basename(asyncDir), fallback?.runnerProcessInstanceId ?? "unknown", "proof-write-failed", errorMessage(error));
	}
}

function overlayStatus(asyncDir: string, proof: ProcessTerminalV1, candidate?: ProcessTerminalCandidate): void {
	const statusPath = path.join(asyncDir, "status.json");
	try {
		const status = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatus;
		status.processTerminal = proof;
		if (status.steps) {
			for (const [index, step] of status.steps.entries()) {
				const records = candidate?.writers[String(index)] ?? [];
				const expected = candidate?.expectedWriters?.[String(index)] ?? (records.length > 0 ? records.length : 0);
				const stepState = expected === 0 ? "not-started" : proof.state === "observed" && records.length === expected ? "observed" : proof.state === "pending" ? "pending" : "unknown";
				step.processTerminal = {
					...proof,
					state: stepState,
					childIndex: index,
					...(records.length ? { instances: records } : {}),
					resumeDisposition: resumeDisposition(step.status, step.sessionFile ?? candidate?.sessionFile),
				};
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
): ProcessTerminalV1 {
	const existing = readProcessTerminal(asyncDir, { runId, runnerProcessInstanceId: runnerClose.processInstanceId });
	if (existing && fs.existsSync(processTerminalPath(asyncDir))) {
		if (existing.state === "observed" && existing.runId === runId && existing.runnerProcessInstanceId === runnerClose.processInstanceId) return existing;
		if (existing.state === "unknown") return existing;
	}
	let proof: ProcessTerminalV1;
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
			} else {
				const runner: ProcessInstanceExitV1 = { kind: "runner", ...runnerClose };
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
	let durable = false;
	try {
		writeAtomicJson(processTerminalPath(asyncDir), proof);
		durable = true;
		overlayStatus(asyncDir, proof, candidateForOverlay);
		fs.appendFileSync(path.join(asyncDir, "events.jsonl"), `${JSON.stringify({ type: "subagent.run.process_terminal", lifecycleArtifactVersion: SUBAGENT_LIFECYCLE_ARTIFACT_VERSION, ts: Date.now(), runId, processTerminal: proof })}\n`, "utf-8");
	} catch {
		// Do not emit a process-terminal event when the proof sidecar was not durable.
	}
	return durable ? proof : unknownProof(runId, runnerClose.processInstanceId, "proof-write-failed", "Failed to persist process-terminal proof.");
}
