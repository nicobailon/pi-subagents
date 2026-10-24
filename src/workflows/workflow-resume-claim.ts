import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { writeAtomicJson } from "../shared/atomic-json.ts";
import { currentBootId } from "../runs/background/boot-id.ts";
import { currentPidNamespaceScope } from "../runs/background/pid-namespace.ts";
import { checkRecordedPidLiveness, type PidLiveness } from "../runs/background/stale-run-reconciler.ts";

const CLAIM_FILE = "resumed-by.json";
const REFUSAL_FILE = "resume-refused.json";
const MAX_CLAIM_ROUNDS = 4;

/**
 * Who continues a stopped workflow run. At most one claim file exists per run, and only its
 * owner launches; once the claimed new run's status.json exists the claim is permanent.
 */
export interface WorkflowResumeClaim {
	version: 1;
	pid: number;
	pidNamespaceScope?: string;
	bootId?: string;
	claimedAt: number;
	newRunId: string;
	trigger: "auto" | "manual" | "reuse";
}

export interface WorkflowResumeRefusal {
	version: 1;
	reason: string;
	byHand: string;
	newRunId?: string;
	refusedAt: number;
}

export type WorkflowResumeClaimOutcome =
	| { kind: "owner" }
	| { kind: "resumed"; newRunId: string }
	| { kind: "busy"; pid: number };

export type WorkflowResumeClaimState =
	| { kind: "none" }
	| { kind: "resumed"; newRunId: string }
	| { kind: "busy"; pid: number; newRunId: string };

type ClaimLiveness = (claim: WorkflowResumeClaim) => PidLiveness;

// Claims this process holds, shared by every runtime in the process so a reload keeps them.
const heldClaimsKey = Symbol.for("pi-subagents.workflow-resume-claims.v1");
const heldClaimsGlobal = globalThis as typeof globalThis & { [heldClaimsKey]?: Set<string> };
const heldClaims = heldClaimsGlobal[heldClaimsKey] ?? (heldClaimsGlobal[heldClaimsKey] = new Set<string>());

function claimPath(asyncDir: string): string {
	return path.join(asyncDir, CLAIM_FILE);
}

function isClaim(value: unknown): value is WorkflowResumeClaim {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const claim = value as Partial<WorkflowResumeClaim>;
	return claim.version === 1
		&& typeof claim.pid === "number" && Number.isSafeInteger(claim.pid) && claim.pid > 0
		&& (claim.pidNamespaceScope === undefined || typeof claim.pidNamespaceScope === "string")
		&& (claim.bootId === undefined || typeof claim.bootId === "string")
		&& typeof claim.claimedAt === "number"
		&& typeof claim.newRunId === "string" && claim.newRunId.length > 0
		&& (claim.trigger === "auto" || claim.trigger === "manual" || claim.trigger === "reuse");
}

type ClaimRead = { kind: "missing" } | { kind: "invalid" } | { kind: "claim"; claim: WorkflowResumeClaim };

function readClaimFile(filePath: string): ClaimRead {
	let text: string;
	try {
		text = fs.readFileSync(filePath, "utf-8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
		// Unreadable is treated like a corrupt body: nothing can prove a live claimant.
		return { kind: "invalid" };
	}
	try {
		const value = JSON.parse(text) as unknown;
		return isClaim(value) ? { kind: "claim", claim: value } : { kind: "invalid" };
	} catch {
		return { kind: "invalid" };
	}
}

export function readWorkflowResumeClaim(asyncDir: string): WorkflowResumeClaim | undefined {
	const read = readClaimFile(claimPath(asyncDir));
	return read.kind === "claim" ? read.claim : undefined;
}

function claimedRunStarted(asyncDir: string, claim: WorkflowResumeClaim): boolean {
	return path.basename(claim.newRunId) === claim.newRunId
		&& fs.existsSync(path.join(path.dirname(asyncDir), claim.newRunId, "status.json"));
}

function claimantLiveness(filePath: string, claim: WorkflowResumeClaim, liveness: ClaimLiveness | undefined): PidLiveness {
	// A reload keeps the pid, so this process's own claim counts only while one of its runtimes holds it.
	if (claim.pid === process.pid && claim.bootId === currentBootId()) return heldClaims.has(filePath) ? "alive" : "dead";
	return liveness
		? liveness(claim)
		: checkRecordedPidLiveness({ pid: claim.pid, pidNamespaceScope: claim.pidNamespaceScope, bootId: claim.bootId }, { observedScope: currentPidNamespaceScope(), observedBootId: currentBootId() });
}

/** Read-only view for reuse readers: a claim with a dead claimant blocks nothing. */
export function workflowResumeClaimState(asyncDir: string, options: { liveness?: ClaimLiveness } = {}): WorkflowResumeClaimState {
	const filePath = claimPath(asyncDir);
	const read = readClaimFile(filePath);
	if (read.kind !== "claim") return { kind: "none" };
	if (claimedRunStarted(asyncDir, read.claim)) return { kind: "resumed", newRunId: read.claim.newRunId };
	return claimantLiveness(filePath, read.claim, options.liveness) === "dead" ? { kind: "none" } : { kind: "busy", pid: read.claim.pid, newRunId: read.claim.newRunId };
}

/** Creates the claim file only if none exists, with its whole body in place at once. */
function createClaimFile(filePath: string, claim: WorkflowResumeClaim): boolean {
	const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
	try {
		fs.writeFileSync(tempPath, JSON.stringify(claim, null, 2), "utf-8");
		fs.linkSync(tempPath, filePath);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
		throw error;
	} finally {
		fs.rmSync(tempPath, { force: true });
	}
}

/**
 * Claims the right to continue the stopped run in `asyncDir` as `newRunId`. A claimant whose
 * process is dead is moved aside and the create is retried, so of several takers exactly one wins.
 */
export function claimWorkflowResume(asyncDir: string, input: { newRunId: string; trigger: WorkflowResumeClaim["trigger"]; now?: number; liveness?: ClaimLiveness }): WorkflowResumeClaimOutcome {
	const filePath = claimPath(asyncDir);
	const claim: WorkflowResumeClaim = {
		version: 1,
		pid: process.pid,
		...(currentPidNamespaceScope() !== undefined ? { pidNamespaceScope: currentPidNamespaceScope() } : {}),
		...(currentBootId() !== undefined ? { bootId: currentBootId() } : {}),
		claimedAt: input.now ?? Date.now(),
		newRunId: input.newRunId,
		trigger: input.trigger,
	};
	for (let round = 0; round < MAX_CLAIM_ROUNDS; round++) {
		if (createClaimFile(filePath, claim)) {
			heldClaims.add(filePath);
			return { kind: "owner" };
		}
		const read = readClaimFile(filePath);
		if (read.kind === "missing") continue;
		if (read.kind === "claim") {
			// Already claimed for this exact new run, as a resume does before it launches.
			if (read.claim.newRunId === input.newRunId && read.claim.pid === process.pid) {
				heldClaims.add(filePath);
				return { kind: "owner" };
			}
			if (claimedRunStarted(asyncDir, read.claim)) return { kind: "resumed", newRunId: read.claim.newRunId };
			if (claimantLiveness(filePath, read.claim, input.liveness) !== "dead") return { kind: "busy", pid: read.claim.pid };
		}
		try {
			fs.renameSync(filePath, `${filePath}.stale-${randomUUID()}`);
		} catch (error) {
			// Another taker moved it first; the next create decides who owns it.
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	// Every round lost a takeover race to another claimant.
	const last = readClaimFile(filePath);
	return { kind: "busy", pid: last.kind === "claim" ? last.claim.pid : 0 };
}

/** Gives up this process's claim on a launch that did not start, so the run can be continued again. */
export function releaseWorkflowResumeClaim(asyncDir: string, newRunId: string): void {
	const filePath = claimPath(asyncDir);
	const read = readClaimFile(filePath);
	if (read.kind !== "claim" || read.claim.newRunId !== newRunId) return;
	try {
		fs.renameSync(filePath, `${filePath}.released-${randomUUID()}`);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	heldClaims.delete(filePath);
}

export function recordWorkflowResumeRefusal(asyncDir: string, refusal: Omit<WorkflowResumeRefusal, "version" | "refusedAt">, now = Date.now()): void {
	writeAtomicJson(path.join(asyncDir, REFUSAL_FILE), { version: 1, ...refusal, refusedAt: now } satisfies WorkflowResumeRefusal);
}

export function readWorkflowResumeRefusal(asyncDir: string): WorkflowResumeRefusal | undefined {
	try {
		const value = JSON.parse(fs.readFileSync(path.join(asyncDir, REFUSAL_FILE), "utf-8")) as Partial<WorkflowResumeRefusal>;
		return value?.version === 1 && typeof value.reason === "string" && typeof value.byHand === "string" && typeof value.refusedAt === "number"
			&& (value.newRunId === undefined || typeof value.newRunId === "string")
			? value as WorkflowResumeRefusal
			: undefined;
	} catch {
		return undefined;
	}
}
