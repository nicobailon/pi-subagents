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
	sessionFile?: string;
	revivalLeaseToken?: string;
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

function validInstance(value: unknown): value is ProcessInstanceExitV1 {
	if (!isRecord(value)) return false;
	return typeof value.processInstanceId === "string"
		&& value.processInstanceId.length > 0
		&& value.kind === "pi-writer"
		&& typeof value.closeObservedAt === "number"
		&& Number.isFinite(value.closeObservedAt)
		&& (typeof value.exitCode === "number" || value.exitCode === null)
		&& (typeof value.signal === "string" || value.signal === null);
}

export function processTerminalCandidatePath(asyncDir: string): string {
	return path.join(asyncDir, "process-terminal-candidate.json");
}

export function processTerminalPath(asyncDir: string): string {
	return path.join(asyncDir, "process-terminal.json");
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
		if (raw.sessionFile !== undefined && typeof raw.sessionFile !== "string") throw new Error("Invalid process-terminal candidate sessionFile.");
		if (raw.revivalLeaseToken !== undefined && typeof raw.revivalLeaseToken !== "string") throw new Error("Invalid process-terminal candidate lease token.");
		return {
			version: 1,
			runId: raw.runId,
			runnerProcessInstanceId: raw.runnerProcessInstanceId,
			writers,
			...(raw.sessionFile ? { sessionFile: raw.sessionFile } : {}),
			...(raw.revivalLeaseToken ? { revivalLeaseToken: raw.revivalLeaseToken } : {}),
		};
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

export function writeProcessTerminalCandidate(asyncDir: string, candidate: ProcessTerminalCandidate): void {
	writePrivateAtomicJson(processTerminalCandidatePath(asyncDir), candidate);
}

function unknownProof(runId: string, runnerProcessInstanceId: string, reason: ProcessTerminalReason): ProcessTerminalV1 {
	return { version: 1, state: "unknown", runId, runnerProcessInstanceId, reason };
}

function sessionProjection(candidate: ProcessTerminalCandidate): CanonicalSessionTerminalV1 | undefined {
	if (!candidate.sessionFile) return undefined;
	const lease = inspectSessionLease(candidate.sessionFile);
	if (lease.state !== "free") return undefined;
	return {
		canonicalSessionId: canonicalSessionId(candidate.sessionFile),
		leaseDisposition: candidate.revivalLeaseToken ? "released" : "not-held",
		freeAtObservation: true,
		...(candidate.revivalLeaseToken ? { canonicalSessionLeaseReleased: true } : {}),
	};
}

export function readProcessTerminal(asyncDir: string): ProcessTerminalV1 | undefined {
	try {
		const raw = JSON.parse(fs.readFileSync(processTerminalPath(asyncDir), "utf-8")) as unknown;
		if (!isRecord(raw) || raw.version !== 1 || typeof raw.state !== "string" || typeof raw.runId !== "string" || typeof raw.runnerProcessInstanceId !== "string") throw new Error(`Invalid process-terminal proof in '${asyncDir}'.`);
		return raw as unknown as ProcessTerminalV1;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
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
				step.processTerminal = records.length > 0
					? { ...proof, childIndex: index, instances: records }
					: { version: 1, state: "not-started", runId: proof.runId, childIndex: index, runnerProcessInstanceId: proof.runnerProcessInstanceId };
			}
		}
		writeAtomicJson(statusPath, status);
	} catch {
		// A proof sidecar remains authoritative when terminal status is unavailable.
	}
}

export function finalizeProcessTerminal(
	asyncDir: string,
	runId: string,
	runnerClose: RunnerCloseObservation,
): ProcessTerminalV1 {
	const existing = readProcessTerminal(asyncDir);
	if (existing?.state === "observed" && existing.runnerProcessInstanceId === runnerClose.processInstanceId) return existing;
	let proof: ProcessTerminalV1;
	let candidateForOverlay: ProcessTerminalCandidate | undefined;
	try {
		const candidate = readProcessTerminalCandidate(asyncDir);
		candidateForOverlay = candidate;
		if (!candidate) proof = unknownProof(runId, runnerClose.processInstanceId, "runner-candidate-missing");
		else if (candidate.runId !== runId || candidate.runnerProcessInstanceId !== runnerClose.processInstanceId) proof = unknownProof(runId, runnerClose.processInstanceId, "runner-instance-mismatch");
		else {
			const allWriters = Object.values(candidate.writers).flat();
			const session = candidate.sessionFile ? inspectSessionLease(candidate.sessionFile) : undefined;
			if (session && session.state !== "free") {
				proof = unknownProof(runId, runnerClose.processInstanceId, session.state === "owned" ? "canonical-session-lease-active" : "canonical-session-unavailable");
			} else if (allWriters.some((entry) => !validInstance(entry))) {
				proof = unknownProof(runId, runnerClose.processInstanceId, "writer-close-unverified");
			} else {
				const runner: ProcessInstanceExitV1 = { kind: "runner", ...runnerClose };
				proof = {
					version: 1,
					state: "observed",
					runId,
					runnerProcessInstanceId: runnerClose.processInstanceId,
					observedAt: runnerClose.closeObservedAt,
					instances: [runner, ...allWriters],
					...(sessionProjection(candidate) ? { canonicalSession: sessionProjection(candidate) } : {}),
				};
			}
		}
	} catch {
		proof = unknownProof(runId, runnerClose.processInstanceId, "proof-write-failed");
	}
	try {
		writePrivateAtomicJson(processTerminalPath(asyncDir), proof);
		overlayStatus(asyncDir, proof, candidateForOverlay);
		fs.appendFileSync(path.join(asyncDir, "events.jsonl"), `${JSON.stringify({ type: "subagent.run.process_terminal", lifecycleArtifactVersion: SUBAGENT_LIFECYCLE_ARTIFACT_VERSION, ts: Date.now(), runId, processTerminal: proof })}\n`, "utf-8");
	} catch {
		// The caller still receives the proof; status/event persistence is best effort.
	}
	return proof;
}
