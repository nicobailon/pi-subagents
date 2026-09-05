import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { writePrivateAtomicJson } from "../../shared/atomic-json.ts";
import { TEMP_ROOT_DIR, type ActiveAsyncCapacitySnapshot, type AsyncStatus } from "../../shared/types.ts";
import { readStatus } from "../../shared/utils.ts";
import { checkPidLiveness, type PidLiveness } from "./stale-run-reconciler.ts";
import { readProcessTerminal } from "./process-terminal.ts";

export const ACTIVE_ASYNC_CAPACITY_DIR = path.join(TEMP_ROOT_DIR, "session-active-async-capacity");
export const DEFAULT_ABANDONED_SLOT_RELEASE_AFTER_MS = 20 * 60 * 1000;
export const MIN_ABANDONED_SLOT_RELEASE_AFTER_MS = 5 * 60 * 1000;
export const MAX_ABANDONED_SLOT_RELEASE_AFTER_MS = 24 * 60 * 60 * 1000;

export interface ActiveAsyncCapacityOwner {
	version: 1;
	reservationToken: string;
	ownerSessionId: string;
	ownerSessionKey: string;
	slot: number;
	runId: string;
	sourceRunId?: string;
	generation: number;
	kind: "runner" | "workflow";
	asyncDir: string;
	reservedAt: number;
	runnerProcessInstanceId?: string;
	runnerStartedAt?: number;
}

export interface ActiveAsyncCapacityHandle {
	readonly owner: ActiveAsyncCapacityOwner;
	markStarted(runnerProcessInstanceId: string): void;
	markWorkflowStarted(): void;
	rollback(): boolean;
	rollbackBeforeRunnerProceed(runnerProcessInstanceId: string): boolean;
	reconcile(liveWorkflowRunIds?: ReadonlySet<string>): ActiveAsyncCapacitySnapshot;
}

interface CapacityOptions {
	rootDir?: string;
	now?: () => number;
	token?: () => string;
	abandonedSlotReleaseAfterMs?: number | false;
	pidLiveness?: (pid: number) => PidLiveness;
	afterSlotRename?: (releasedDir: string) => void;
	writeOwner?: (filePath: string, owner: ActiveAsyncCapacityOwner) => void;
}

export interface ActiveAsyncCapacityReleaseEvidence {
	releasedBy: "abandoned-timeout";
	processProof: "unknown";
	runnerPid: "gone";
	lastActivityAgeMs: number;
	abandonedSlotReleaseAfterMs: number;
}

export type ActiveAsyncCapacityReleaseVerdict =
	| { state: "releasable"; reason: string; evidence?: ActiveAsyncCapacityReleaseEvidence }
	| { state: "retained"; reason: string }
	| { state: "not-owned"; reason: string };

export interface ActiveAsyncCapacityInspection {
	owner?: ActiveAsyncCapacityOwner;
	relation: "current" | "source" | "none";
	slotDir?: string;
	release: ActiveAsyncCapacityReleaseVerdict;
}

export class ActiveAsyncCapacityError extends Error {
	readonly snapshot: ActiveAsyncCapacitySnapshot;

	constructor(snapshot: ActiveAsyncCapacitySnapshot) {
		super(`Active async run capacity exhausted: ${snapshot.used}/${snapshot.limit} used.`);
		this.name = "ActiveAsyncCapacityError";
		this.snapshot = snapshot;
	}
}

export function resolveMaxActiveAsyncRunsPerSession(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isInteger(value) || value < 0) return undefined;
	return value === 0 ? undefined : value;
}

export function resolveAbandonedSlotReleaseAfterMs(value: unknown): number | false {
	if (value === false) return false;
	if (typeof value !== "number" || !Number.isInteger(value) || value < 1) return DEFAULT_ABANDONED_SLOT_RELEASE_AFTER_MS;
	return value;
}

export function activeAsyncCapacitySessionKey(sessionId: string): string {
	return createHash("sha256").update(sessionId).digest("hex");
}

function sessionDir(sessionId: string, rootDir: string): string {
	return path.join(rootDir, activeAsyncCapacitySessionKey(sessionId));
}

function slotDir(poolDir: string, slot: number): string {
	return path.join(poolDir, `slot-${slot}`);
}

function parseOwner(value: unknown): ActiveAsyncCapacityOwner | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const owner = value as Partial<ActiveAsyncCapacityOwner>;
	if (owner.version !== 1
		|| typeof owner.reservationToken !== "string" || !owner.reservationToken
		|| typeof owner.ownerSessionId !== "string" || !owner.ownerSessionId
		|| typeof owner.ownerSessionKey !== "string" || !owner.ownerSessionKey
		|| typeof owner.slot !== "number" || !Number.isInteger(owner.slot) || owner.slot < 0
		|| typeof owner.runId !== "string" || !owner.runId
		|| typeof owner.generation !== "number" || !Number.isInteger(owner.generation) || owner.generation < 0
		|| (owner.kind !== "runner" && owner.kind !== "workflow")
		|| typeof owner.asyncDir !== "string" || !owner.asyncDir
		|| typeof owner.reservedAt !== "number" || !Number.isFinite(owner.reservedAt)) return undefined;
	if (owner.sourceRunId !== undefined && typeof owner.sourceRunId !== "string") return undefined;
	if (owner.runnerProcessInstanceId !== undefined && (typeof owner.runnerProcessInstanceId !== "string" || !owner.runnerProcessInstanceId)) return undefined;
	if (owner.runnerStartedAt !== undefined && (typeof owner.runnerStartedAt !== "number" || !Number.isFinite(owner.runnerStartedAt))) return undefined;
	return owner as ActiveAsyncCapacityOwner;
}

function readOwner(dir: string): ActiveAsyncCapacityOwner | undefined {
	try {
		return parseOwner(JSON.parse(fs.readFileSync(path.join(dir, "owner.json"), "utf-8")));
	} catch {
		return undefined;
	}
}

function occupiedSlots(poolDir: string): string[] {
	try {
		return fs.readdirSync(poolDir, { withFileTypes: true })
			.filter((entry) => entry.isDirectory() && /^slot-\d+$/.test(entry.name))
			.map((entry) => path.join(poolDir, entry.name));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}

function snapshotFor(sessionId: string, limit: number | undefined, rootDir: string): ActiveAsyncCapacitySnapshot {
	return { used: occupiedSlots(sessionDir(sessionId, rootDir)).length, limit: limit ?? 0 };
}

function matchingOwner(dir: string, expected: ActiveAsyncCapacityOwner): ActiveAsyncCapacityOwner | undefined {
	const owner = readOwner(dir);
	return owner?.reservationToken === expected.reservationToken
		&& owner.runId === expected.runId
		&& owner.generation === expected.generation
		? owner
		: undefined;
}

function withSlotClaim<T>(dir: string, operation: () => T): { acquired: true; value: T } | { acquired: false } {
	const claimPath = path.join(dir, "capacity.claim");
	const claimToken = randomUUID();
	let claim: number | undefined;
	try {
		claim = fs.openSync(claimPath, "wx", 0o600);
		fs.writeFileSync(claim, claimToken, "utf-8");
		fs.closeSync(claim);
		claim = undefined;
	} catch (error) {
		if (claim !== undefined) fs.closeSync(claim);
		if ((error as NodeJS.ErrnoException).code === "EEXIST" || (error as NodeJS.ErrnoException).code === "ENOENT") return { acquired: false };
		throw error;
	}
	try {
		return { acquired: true, value: operation() };
	} finally {
		try {
			if (fs.readFileSync(claimPath, "utf-8") === claimToken) fs.rmSync(claimPath, { force: true });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
}

function removeOwnedSlot(dir: string, expected: ActiveAsyncCapacityOwner, options: CapacityOptions, requireUnstarted = false, release?: ActiveAsyncCapacityReleaseVerdict): boolean {
	if (requireUnstarted && (expected.runnerProcessInstanceId || expected.runnerStartedAt)) return false;
	const claimed = withSlotClaim(dir, () => {
		const current = matchingOwner(dir, expected);
		if (!current || (requireUnstarted && (current.runnerProcessInstanceId || current.runnerStartedAt))) return false;
		const releasedDir = path.join(path.dirname(dir), `.${path.basename(dir)}.released-${randomUUID()}`);
		fs.renameSync(dir, releasedDir);
		options.afterSlotRename?.(releasedDir);
		if (release?.state === "releasable" && release.evidence) {
			appendAbandonedReleaseEvent(expected.asyncDir, expected, release.evidence, options.now?.() ?? Date.now());
		}
		fs.rmSync(releasedDir, { recursive: true, force: true });
		return true;
	});
	return claimed.acquired && claimed.value;
}

function appendAbandonedReleaseEvent(asyncDir: string, owner: ActiveAsyncCapacityOwner, evidence: ActiveAsyncCapacityReleaseEvidence, now: number): void {
	try {
		const eventsPath = path.join(asyncDir, "events.jsonl");
		fs.mkdirSync(path.dirname(eventsPath), { recursive: true });
		fs.appendFileSync(eventsPath, `${JSON.stringify({
			type: "subagent.capacity.released",
			ts: now,
			runId: owner.runId,
			sessionId: owner.ownerSessionId,
			...evidence,
		})}\n`, "utf-8");
	} catch {
		// Capacity release must not fail because its diagnostic event cannot be written.
	}
}

function terminalState(state: AsyncStatus["state"]): boolean {
	return state !== "queued" && state !== "running" && state !== "paused";
}

function runnerReleaseVerdict(owner: ActiveAsyncCapacityOwner, status: AsyncStatus | null, options: CapacityOptions): ActiveAsyncCapacityReleaseVerdict {
	if (!status) return { state: "retained", reason: "status file is missing or unreadable" };
	if (!owner.runnerProcessInstanceId) return { state: "retained", reason: "runner process identity has not been recorded" };
	if (status.sessionId !== owner.ownerSessionId) return { state: "retained", reason: `status session ${status.sessionId ?? "unknown"} does not match owner session ${owner.ownerSessionId}` };
	if (status.runId !== owner.runId) return { state: "retained", reason: `status run ${status.runId} does not match owner run ${owner.runId}` };
	if (!terminalState(status.state)) return { state: "retained", reason: `run is still ${status.state}` };
	if (status.processTerminal?.state === "not-started"
		&& status.processTerminal.runId === owner.runId
		&& status.processTerminal.runnerProcessInstanceId === owner.runnerProcessInstanceId
		&& typeof status.error === "string"
		&& status.error) return { state: "releasable", reason: "run failed before child startup completed" };
	const proof = readProcessTerminal(owner.asyncDir, {
		runId: owner.runId,
		runnerProcessInstanceId: owner.runnerProcessInstanceId,
	});
	return proof?.state === "observed"
		&& proof.runId === owner.runId
		&& proof.runnerProcessInstanceId === owner.runnerProcessInstanceId
		? { state: "releasable", reason: "matching observed process-terminal proof is present" }
		: abandonedRunnerReleaseVerdict(status, proof?.state ?? "missing", options);
}

function abandonedRunnerReleaseVerdict(status: AsyncStatus, proofState: string, options: CapacityOptions): ActiveAsyncCapacityReleaseVerdict {
	const proofReason = `process-terminal proof is ${proofState}`;
	const thresholdMs = resolveAbandonedSlotReleaseAfterMs(options.abandonedSlotReleaseAfterMs);
	if (thresholdMs === false) return { state: "retained", reason: `${proofReason}; abandoned-timeout policy is disabled` };
	if (status.state !== "failed") return { state: "retained", reason: `${proofReason}; abandoned-timeout policy requires a failed run, not ${status.state}` };
	if (typeof status.pid !== "number" || !Number.isInteger(status.pid) || status.pid < 1) return { state: "retained", reason: `${proofReason}; runner PID is missing or invalid` };
	const liveness = (options.pidLiveness ?? checkPidLiveness)(status.pid);
	if (liveness !== "dead") return { state: "retained", reason: `${proofReason}; runner PID liveness is ${liveness}` };
	const lastActivityAt = status.lastActivityAt ?? status.lastUpdate ?? status.endedAt;
	if (typeof lastActivityAt !== "number" || !Number.isFinite(lastActivityAt)) return { state: "retained", reason: `${proofReason}; last activity timestamp is missing or invalid` };
	const now = options.now?.() ?? Date.now();
	const lastActivityAgeMs = Math.max(0, now - lastActivityAt);
	if (lastActivityAgeMs <= thresholdMs) return { state: "retained", reason: `${proofReason}; last activity age ${lastActivityAgeMs}ms has not exceeded abandoned-timeout ${thresholdMs}ms` };
	const evidence: ActiveAsyncCapacityReleaseEvidence = {
		releasedBy: "abandoned-timeout",
		processProof: "unknown",
		runnerPid: "gone",
		lastActivityAgeMs,
		abandonedSlotReleaseAfterMs: thresholdMs,
	};
	return {
		state: "releasable",
		reason: `${evidence.releasedBy}: ${proofReason}; runner PID is gone; process proof unknown; last activity age ${lastActivityAgeMs}ms exceeds ${thresholdMs}ms`,
		evidence,
	};
}

function workflowReleaseVerdict(owner: ActiveAsyncCapacityOwner, status: AsyncStatus | null, liveWorkflowRunIds: ReadonlySet<string>): ActiveAsyncCapacityReleaseVerdict {
	if (!status) return { state: "retained", reason: "status file is missing or unreadable" };
	if (status.sessionId !== owner.ownerSessionId) return { state: "retained", reason: `status session ${status.sessionId ?? "unknown"} does not match owner session ${owner.ownerSessionId}` };
	if (status.runId !== owner.runId) return { state: "retained", reason: `status run ${status.runId} does not match owner run ${owner.runId}` };
	if (status.mode !== "workflow") return { state: "retained", reason: `status mode is ${status.mode}, not workflow` };
	if (!terminalState(status.state)) return { state: "retained", reason: `workflow is still ${status.state}` };
	if (liveWorkflowRunIds.has(owner.runId)) return { state: "retained", reason: "workflow controller is still live" };
	for (const step of status.steps ?? []) {
		const label = step.workflowKey ?? step.agent;
		if (typeof step.async !== "boolean") return { state: "retained", reason: `workflow child ${label} is missing async classification` };
		if (!step.async) continue;
		if (!step.runId) return { state: "retained", reason: `async workflow child ${label} is missing run id` };
		const childDir = path.join(path.dirname(owner.asyncDir), step.runId);
		if (!fs.existsSync(childDir)) return { state: "retained", reason: `async workflow child ${label} directory is missing` };
		const childStatus = readStatus(childDir);
		if (!childStatus) return { state: "retained", reason: `async workflow child ${label} status is missing or unreadable` };
		if (!terminalState(childStatus.state)) return { state: "retained", reason: `async workflow child ${label} is still ${childStatus.state}` };
		if (!childStatus.processTerminal?.runnerProcessInstanceId) return { state: "retained", reason: `async workflow child ${label} has no runner process identity` };
		const proof = readProcessTerminal(childDir, {
			runId: step.runId,
			runnerProcessInstanceId: childStatus.processTerminal.runnerProcessInstanceId,
		});
		if (proof?.state !== "observed" || proof.runId !== step.runId) return { state: "retained", reason: `async workflow child ${label} process-terminal proof is ${proof?.state ?? "missing"}` };
	}
	return { state: "releasable", reason: "workflow is terminal, controller is gone, and async children have observed proof" };
}

function ownerReleaseVerdict(owner: ActiveAsyncCapacityOwner, liveWorkflowRunIds: ReadonlySet<string>, options: CapacityOptions): ActiveAsyncCapacityReleaseVerdict {
	const status = readStatus(owner.asyncDir);
	return owner.kind === "runner"
		? runnerReleaseVerdict(owner, status, options)
		: workflowReleaseVerdict(owner, status, liveWorkflowRunIds);
}

function capacitySessionDirs(rootDir: string, sessionId?: string): string[] {
	if (sessionId) return [sessionDir(sessionId, rootDir)];
	try {
		return fs.readdirSync(rootDir, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => path.join(rootDir, entry.name));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}

export function inspectActiveAsyncCapacityOwner(
	input: { runId: string; sessionId?: string; asyncDir?: string },
	options: CapacityOptions & { liveWorkflowRunIds?: ReadonlySet<string> } = {},
): ActiveAsyncCapacityInspection {
	const rootDir = options.rootDir ?? ACTIVE_ASYNC_CAPACITY_DIR;
	const liveWorkflowRunIds = options.liveWorkflowRunIds ?? new Set<string>();
	for (const poolDir of capacitySessionDirs(rootDir, input.sessionId)) {
		for (const dir of occupiedSlots(poolDir)) {
			const owner = readOwner(dir);
			if (!owner) continue;
			const sameRun = owner.runId === input.runId || (input.asyncDir !== undefined && path.resolve(owner.asyncDir) === path.resolve(input.asyncDir));
			const sourceRun = owner.sourceRunId === input.runId;
			if (!sameRun && !sourceRun) continue;
			if (sourceRun && !sameRun) {
				return {
					owner,
					relation: "source",
					slotDir: dir,
					release: { state: "not-owned", reason: `slot was transferred to ${owner.runId}` },
				};
			}
			return { owner, relation: "current", slotDir: dir, release: ownerReleaseVerdict(owner, liveWorkflowRunIds, options) };
		}
	}
	return { relation: "none", release: { state: "not-owned", reason: "no active-capacity slot records this run" } };
}

export function reconcileActiveAsyncCapacity(
	sessionId: string,
	limit: number | undefined,
	options: CapacityOptions & { liveWorkflowRunIds?: ReadonlySet<string> } = {},
): ActiveAsyncCapacitySnapshot {
	const rootDir = options.rootDir ?? ACTIVE_ASYNC_CAPACITY_DIR;
	const poolDir = sessionDir(sessionId, rootDir);
	const liveWorkflowRunIds = options.liveWorkflowRunIds ?? new Set<string>();
	for (const dir of occupiedSlots(poolDir)) {
		const owner = readOwner(dir);
		if (!owner
			|| owner.ownerSessionId !== sessionId
			|| owner.ownerSessionKey !== activeAsyncCapacitySessionKey(sessionId)
			|| path.basename(dir) !== `slot-${owner.slot}`) continue;
		const release = ownerReleaseVerdict(owner, liveWorkflowRunIds, options);
		if (release.state !== "releasable") continue;
		removeOwnedSlot(dir, owner, options, false, release);
	}
	return snapshotFor(sessionId, limit, rootDir);
}

export function getActiveAsyncCapacitySnapshot(
	sessionId: string,
	limit: number | undefined,
	options: CapacityOptions & { liveWorkflowRunIds?: ReadonlySet<string> } = {},
): ActiveAsyncCapacitySnapshot {
	return reconcileActiveAsyncCapacity(sessionId, limit, options);
}

function createSlot(poolDir: string, owner: ActiveAsyncCapacityOwner): boolean {
	const destination = slotDir(poolDir, owner.slot);
	fs.mkdirSync(poolDir, { recursive: true, mode: 0o700 });
	try {
		fs.mkdirSync(destination, { mode: 0o700 });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
		throw error;
	}
	// If owner persistence fails, the corrupt occupied directory remains and
	// fails closed instead of becoming available to another admission.
	fs.writeFileSync(path.join(destination, "owner.json"), `${JSON.stringify(owner, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
	return true;
}

function handleFor(owner: ActiveAsyncCapacityOwner, limit: number, options: CapacityOptions, rollbackOwner?: ActiveAsyncCapacityOwner): ActiveAsyncCapacityHandle {
	const rootDir = options.rootDir ?? ACTIVE_ASYNC_CAPACITY_DIR;
	const writeOwner = options.writeOwner ?? writePrivateAtomicJson;
	const dir = slotDir(sessionDir(owner.ownerSessionId, rootDir), owner.slot);
	return {
		owner,
		markStarted(runnerProcessInstanceId) {
			const claimed = withSlotClaim(dir, () => {
				const current = matchingOwner(dir, owner);
				if (!current) return false;
				const next = { ...current, runnerProcessInstanceId, runnerStartedAt: options.now?.() ?? Date.now() };
				// Mark memory first so pre-proceed cleanup can distinguish a failed durable
				// bind from an unrelated unstarted reservation.
				Object.assign(owner, next);
				writeOwner(path.join(dir, "owner.json"), next);
				return true;
			});
			if (!claimed.acquired || !claimed.value) throw new Error(`Active async capacity ownership changed for run '${owner.runId}'.`);
		},
		markWorkflowStarted() {
			const claimed = withSlotClaim(dir, () => {
				const current = matchingOwner(dir, owner);
				if (!current || current.kind !== "workflow") return false;
				const next = { ...current, runnerStartedAt: options.now?.() ?? Date.now() };
				Object.assign(owner, next);
				try {
					writePrivateAtomicJson(path.join(dir, "owner.json"), next);
				} catch (error) {
					console.error(`Failed to mark async workflow '${owner.runId}' started; capacity will remain occupied:`, error);
				}
				return true;
			});
			if (!claimed.acquired || !claimed.value) throw new Error(`Active async capacity ownership changed for workflow '${owner.runId}'.`);
		},
		rollback() {
			if (!rollbackOwner) return removeOwnedSlot(dir, owner, options, true);
			if (owner.runnerProcessInstanceId || owner.runnerStartedAt) return false;
			const claimed = withSlotClaim(dir, () => {
				const current = matchingOwner(dir, owner);
				if (!current || current.runnerProcessInstanceId || current.runnerStartedAt) return false;
				writePrivateAtomicJson(path.join(dir, "owner.json"), rollbackOwner);
				Object.assign(owner, rollbackOwner);
				return true;
			});
			return claimed.acquired && claimed.value;
		},
		rollbackBeforeRunnerProceed(runnerProcessInstanceId) {
			const claimed = withSlotClaim(dir, () => {
				const current = matchingOwner(dir, owner);
				if (!current) return false;
				const boundToRunner = current.runnerProcessInstanceId === runnerProcessInstanceId;
				const bindingFailedBeforeProceed = current.runnerProcessInstanceId === undefined && current.runnerStartedAt === undefined && owner.runnerProcessInstanceId === runnerProcessInstanceId;
				if (!boundToRunner && !bindingFailedBeforeProceed) return false;
				if (rollbackOwner) {
					writePrivateAtomicJson(path.join(dir, "owner.json"), rollbackOwner);
					Object.assign(owner, rollbackOwner);
					return true;
				}
				const releasedDir = path.join(path.dirname(dir), `.${path.basename(dir)}.released-${randomUUID()}`);
				fs.renameSync(dir, releasedDir);
				options.afterSlotRename?.(releasedDir);
				fs.rmSync(releasedDir, { recursive: true, force: true });
				return true;
			});
			return claimed.acquired && claimed.value;
		},
		reconcile(liveWorkflowRunIds) {
			return reconcileActiveAsyncCapacity(owner.ownerSessionId, limit, { ...options, rootDir, liveWorkflowRunIds });
		},
	};
}

export function acquireActiveAsyncCapacity(
	input: { sessionId: string; limit: number | undefined; runId: string; kind: "runner" | "workflow"; asyncDir: string },
	options: CapacityOptions & { liveWorkflowRunIds?: ReadonlySet<string> } = {},
): ActiveAsyncCapacityHandle | undefined {
	if (input.limit === undefined) return undefined;
	const rootDir = options.rootDir ?? ACTIVE_ASYNC_CAPACITY_DIR;
	const reconciled = reconcileActiveAsyncCapacity(input.sessionId, input.limit, options);
	if (reconciled.used >= input.limit) throw new ActiveAsyncCapacityError(reconciled);
	const poolDir = sessionDir(input.sessionId, rootDir);
	const token = options.token?.() ?? randomUUID();
	for (let slot = 0; slot < input.limit; slot++) {
		const owner: ActiveAsyncCapacityOwner = {
			version: 1,
			reservationToken: token,
			ownerSessionId: input.sessionId,
			ownerSessionKey: activeAsyncCapacitySessionKey(input.sessionId),
			slot,
			runId: input.runId,
			generation: 0,
			kind: input.kind,
			asyncDir: input.asyncDir,
			reservedAt: options.now?.() ?? Date.now(),
		};
		if (createSlot(poolDir, owner)) return handleFor(owner, input.limit, { ...options, rootDir });
	}
	throw new ActiveAsyncCapacityError(snapshotFor(input.sessionId, input.limit, rootDir));
}

export function transferActiveAsyncCapacity(
	input: { sessionId: string; limit: number | undefined; sourceRunId: string; runId: string; asyncDir: string },
	options: CapacityOptions = {},
): ActiveAsyncCapacityHandle | undefined {
	const limit = input.limit ?? 0;
	const rootDir = options.rootDir ?? ACTIVE_ASYNC_CAPACITY_DIR;
	const poolDir = sessionDir(input.sessionId, rootDir);
	for (const dir of occupiedSlots(poolDir)) {
		const source = readOwner(dir);
		if (!source || source.ownerSessionId !== input.sessionId || source.runId !== input.sourceRunId) continue;
		const claimed = withSlotClaim(dir, () => {
			const current = matchingOwner(dir, source);
			const status = readStatus(source.asyncDir);
			if (!current || !status || status.runId !== input.sourceRunId || status.state === "queued" || status.state === "running") {
				throw new Error(`Active async capacity source '${input.sourceRunId}' is not transferable.`);
			}
			const next: ActiveAsyncCapacityOwner = {
				...current,
				runId: input.runId,
				sourceRunId: input.sourceRunId,
				generation: current.generation + 1,
				kind: "runner",
				asyncDir: input.asyncDir,
				reservedAt: options.now?.() ?? Date.now(),
			};
			delete next.runnerProcessInstanceId;
			delete next.runnerStartedAt;
			writePrivateAtomicJson(path.join(dir, "owner.json"), next);
			return handleFor(next, limit, { ...options, rootDir }, current);
		});
		if (!claimed.acquired) throw new Error(`Active async capacity transfer is already in progress for run '${input.sourceRunId}'.`);
		return claimed.value;
	}
	return acquireActiveAsyncCapacity({ sessionId: input.sessionId, limit: input.limit, runId: input.runId, kind: "runner", asyncDir: input.asyncDir }, options);
}
