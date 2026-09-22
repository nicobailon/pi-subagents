import * as fs from "node:fs";
import * as path from "node:path";
import { writeAtomicJson, writePrivateAtomicJson } from "../../shared/atomic-json.ts";
import { acquireSessionLease, type SessionLeaseHandle, type SessionLeaseRequest } from "../shared/session-lease.ts";

/**
 * Early startup phase of the detached async runner.
 *
 * The parent waits a fixed `RUNNER_STARTUP_TIMEOUT_MS` budget for the `ready`
 * handshake. A cold module cache on a Windows host can spend that whole budget
 * just reading the runner's execution graph, so the handshake lives here: the
 * bootstrap entry completes it with this module's small import graph before the
 * heavy execution graph is imported.
 */
export interface RunnerStartupConfig {
	/** Directory holding this run's handshake/status artifacts. */
	asyncDir: string;
	/** Fresh-launch barrier token: the runner waits for the parent's `proceed`. */
	launchBarrierToken?: string;
	/** Revival ownership request: the lease is acquired before `ready` is published. */
	revivalLease?: SessionLeaseRequest;
	/** Written with the acquired lease token so later artifacts report the same owner. */
	revivalLeaseToken?: string;
}

export interface RunnerStartupPaths {
	startupPath: string;
	ackPath: string;
	confirmPath: string;
	proceedPath: string;
}

export interface RunnerStartupOutcome {
	/** Acquired revival lease; the run owns it until the runner exits. */
	lease?: SessionLeaseHandle;
}

export function runnerStartupPaths(asyncDir: string): RunnerStartupPaths {
	return {
		startupPath: path.join(asyncDir, "runner-startup.json"),
		ackPath: path.join(asyncDir, "runner-startup-ack.json"),
		confirmPath: path.join(asyncDir, "runner-startup-confirm.json"),
		proceedPath: path.join(asyncDir, "runner-startup-proceed.json"),
	};
}

export async function waitForStartupControl(
	controlPath: string,
	token: string,
	action: "ack" | "confirm" | "proceed",
	timeoutMs = 30_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() <= deadline) {
		if (fs.existsSync(controlPath)) {
			let payload: { action?: unknown; token?: unknown };
			try {
				payload = JSON.parse(fs.readFileSync(controlPath, "utf-8")) as { action?: unknown; token?: unknown };
			} catch (error) {
				throw new Error(`Failed to read runner startup control '${controlPath}': ${error instanceof Error ? error.message : String(error)}`);
			}
			if (payload.token !== token) throw new Error("Runner startup control token does not match.");
			if (payload.action === action) return;
			if (payload.action !== "ack" && payload.action !== "confirm" && payload.action !== "proceed") throw new Error("Runner startup control action is invalid.");
		}
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error(`Timed out after ${timeoutMs}ms waiting for runner startup control '${action}'.`);
}

/** Test hook: exit when the supervising test process is gone. */
export function monitorTestParent(): void {
	const parentPid = Number(process.env.PI_SUBAGENTS_TEST_PARENT_PID);
	if (!Number.isSafeInteger(parentPid) || parentPid <= 0 || parentPid === process.pid) return;
	const check = () => {
		try { process.kill(parentPid, 0); }
		catch { process.exit(1); }
	};
	check();
	setInterval(check, 250).unref();
}

/**
 * Complete the parent's startup handshake — the fresh-launch barrier or the
 * revival lease protocol — and hand the acquired lease back to the caller.
 *
 * Failures before the parent commits are published as `state: "error"` so the
 * parent reports the real cause instead of a bare startup timeout, and the
 * lease is released unless the run took ownership.
 */
export async function performRunnerStartupHandshake(config: RunnerStartupConfig): Promise<RunnerStartupOutcome> {
	const { startupPath, ackPath, confirmPath, proceedPath } = runnerStartupPaths(config.asyncDir);
	let committed = config.launchBarrierToken === undefined && config.revivalLease === undefined;
	let lease: SessionLeaseHandle | undefined;
	try {
		if (config.launchBarrierToken) {
			await waitForStartupControl(proceedPath, config.launchBarrierToken, "proceed");
			committed = true;
			try {
				fs.rmSync(proceedPath, { force: true });
			} catch {
				// Startup control cleanup is best effort after the parent commits the run.
			}
		} else if (config.revivalLease) {
			lease = acquireSessionLease(config.revivalLease);
			config.revivalLeaseToken = lease.owner.token;
			writeAtomicJson(startupPath, { state: "ready", token: lease.owner.token, pid: process.pid, owner: lease.owner });
			await waitForStartupControl(ackPath, lease.owner.token, "ack");
			writeAtomicJson(startupPath, { state: "acknowledged", token: lease.owner.token, pid: process.pid });
			await waitForStartupControl(confirmPath, lease.owner.token, "confirm");
			writeAtomicJson(startupPath, { state: "confirmed", token: lease.owner.token, pid: process.pid });
			await waitForStartupControl(proceedPath, lease.owner.token, "proceed");
			committed = true;
			for (const controlPath of [ackPath, confirmPath, proceedPath]) {
				try {
					fs.rmSync(controlPath, { force: true });
				} catch {
					// Startup control cleanup is best effort after the parent commits the run.
				}
			}
		}
	} catch (error) {
		if (!committed) {
			try {
				writeAtomicJson(startupPath, { state: "error", pid: process.pid, error: error instanceof Error ? error.message : String(error) });
			} catch {
				// The parent will time out and terminate this runner if the handshake cannot be written.
			}
		}
		releaseStartupLease(lease);
		throw error;
	}
	return lease ? { lease } : {};
}

/**
 * Release a lease whose run never took ownership — a failed handshake or a
 * failed execution-graph import. Best effort: a dead-owner lease is reclaimed
 * on the next revival. Terminal-candidate bookkeeping for a started run stays
 * with the runner.
 */
export function releaseStartupLease(lease?: SessionLeaseHandle): void {
	if (!lease) return;
	try {
		lease.release();
	} catch {
		// A dead-owner lease is reclaimed on the next revival.
	}
}

export interface RunnerStartupFailureConfig {
	asyncDir: string;
	/** Fallbacks for a status file that is missing or unreadable. */
	runId?: string;
	runnerProcessInstanceId?: string;
}

/** Status states that already carry a verdict for the run. */
const SETTLED_RUN_STATES = new Set(["complete", "failed", "partial", "stopped", "rejected"]);

/**
 * Publish a durable failure for a run whose startup the parent already
 * committed but whose execution graph never loaded.
 *
 * Without this the run keeps its non-terminal status, so nothing but stale-run
 * reconciliation reports the failure, and async capacity holds the slot until
 * the abandoned-slot timeout (20 minutes by default). The written shape matches
 * the parent's pre-proceed startup failure: `state: "failed"` with the real
 * error, a `not-started` process proof, and a process-terminal candidate that
 * expects no writers. Both the status proof and the runner-close finalization
 * then report the run as failed before any child started, which releases the
 * slot immediately.
 */
export function publishCommittedStartupFailure(config: RunnerStartupFailureConfig, error: unknown): void {
	const statusPath = path.join(config.asyncDir, "status.json");
	let status: Record<string, unknown> = {};
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(statusPath, "utf-8"));
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) status = parsed as Record<string, unknown>;
	} catch {
		// A run without a readable status file still gets the failure publication below.
	}
	if (typeof status.state === "string" && SETTLED_RUN_STATES.has(status.state)) return;
	const statusProcessTerminal = status.processTerminal as { runnerProcessInstanceId?: unknown } | undefined;
	const runId = typeof status.runId === "string" && status.runId ? status.runId : config.runId;
	const runnerProcessInstanceId = typeof statusProcessTerminal?.runnerProcessInstanceId === "string"
		? statusProcessTerminal.runnerProcessInstanceId
		: config.runnerProcessInstanceId;
	writePrivateAtomicJson(statusPath, {
		...status,
		...(runId ? { runId } : {}),
		state: "failed",
		lastUpdate: Date.now(),
		error: `Failed to load the async runner execution graph: ${error instanceof Error ? error.message : String(error)}`,
		...(runId && runnerProcessInstanceId
			? { processTerminal: { version: 1, state: "not-started", runId, runnerProcessInstanceId } }
			: {}),
	});
	if (!runId || !runnerProcessInstanceId) return;
	// The graph never loaded, so no child session can exist: declare the empty
	// writer set the runner-close observation needs to finalize an observed proof.
	writePrivateAtomicJson(path.join(config.asyncDir, "process-terminal-candidate.json"), {
		version: 1,
		runId,
		runnerProcessInstanceId,
		writers: {},
		expectedWriters: { 0: 0 },
	});
}
