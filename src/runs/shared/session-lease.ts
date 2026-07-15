import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createAtomicJsonWriter } from "../../shared/atomic-json.ts";
import { TEMP_ROOT_DIR } from "../../shared/types.ts";

export const SESSION_LEASES_DIR = path.join(TEMP_ROOT_DIR, "session-leases");

export interface SessionLeaseRequest {
	sessionFile: string;
	runId: string;
	sourceRunId: string;
	parentSessionId?: string;
}

export interface SessionLeaseOwner {
	version: 1;
	token: string;
	canonicalSessionFile: string;
	runId: string;
	sourceRunId: string;
	parentSessionId?: string;
	pid: number;
	hostname: string;
	processStartIdentity?: string;
	writerState: "none" | "spawning" | "running";
	writerPid?: number;
	writerProcessStartIdentity?: string;
	acquiredAt: string;
	acquiredAtMs: number;
	updatedAtMs: number;
}

export interface SessionLeaseHandle {
	leaseDir: string;
	owner: SessionLeaseOwner;
	updateWriter(writer: { state: "none" | "spawning" } | { state: "running"; pid: number }): void;
	release(): void;
}

interface SessionLeaseOptions {
	rootDir?: string;
	now?: () => number;
	token?: () => string;
	pid?: number;
	hostname?: string;
	processStartIdentity?: string;
	isProcessAlive?: (pid: number) => boolean | undefined;
	getProcessStartIdentity?: (pid: number) => string | undefined;
}

export class SessionLeaseConflictError extends Error {
	readonly owner?: SessionLeaseOwner;

	constructor(message: string, owner?: SessionLeaseOwner) {
		super(message);
		this.name = "SessionLeaseConflictError";
		this.owner = owner;
	}
}

function getProcessStartIdentity(pid: number): string | undefined {
	if (process.platform === "linux") {
		try {
			const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf-8");
			const commandEnd = stat.lastIndexOf(")");
			if (commandEnd === -1) return undefined;
			const fields = stat.slice(commandEnd + 1).trim().split(/\s+/);
			const startTicks = fields[19];
			return startTicks ? `linux:${startTicks}` : undefined;
		} catch {
			return undefined;
		}
	}
	if (process.platform === "darwin" || process.platform === "freebsd") {
		const result = spawnSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf-8" });
		const started = result.status === 0 ? result.stdout.trim() : "";
		return started ? `${process.platform}:${started}` : undefined;
	}
	return undefined;
}

function processIsAlive(pid: number): boolean | undefined {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ESRCH") return false;
		if (code === "EPERM") return true;
		return undefined;
	}
}

export function canonicalSessionFilePath(sessionFile: string): string {
	return fs.realpathSync.native(path.resolve(sessionFile));
}

export function sessionLeaseDir(sessionFile: string, rootDir = SESSION_LEASES_DIR): string {
	const canonical = canonicalSessionFilePath(sessionFile);
	const key = process.platform === "win32" ? canonical.toLowerCase() : canonical;
	const digest = createHash("sha256").update(key).digest("hex");
	return path.join(rootDir, digest);
}

function parseOwner(value: unknown): SessionLeaseOwner | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const owner = value as Partial<SessionLeaseOwner>;
	if (owner.version !== 1
		|| typeof owner.token !== "string"
		|| typeof owner.canonicalSessionFile !== "string"
		|| typeof owner.runId !== "string"
		|| typeof owner.sourceRunId !== "string"
		|| typeof owner.pid !== "number"
		|| !Number.isInteger(owner.pid)
		|| owner.pid <= 0
		|| typeof owner.hostname !== "string"
		|| (owner.writerState !== "none" && owner.writerState !== "spawning" && owner.writerState !== "running")
		|| typeof owner.acquiredAt !== "string"
		|| typeof owner.acquiredAtMs !== "number"
		|| typeof owner.updatedAtMs !== "number") return undefined;
	if (owner.parentSessionId !== undefined && typeof owner.parentSessionId !== "string") return undefined;
	if (owner.processStartIdentity !== undefined && typeof owner.processStartIdentity !== "string") return undefined;
	if (owner.writerPid !== undefined && (typeof owner.writerPid !== "number" || !Number.isInteger(owner.writerPid) || owner.writerPid <= 0)) return undefined;
	if (owner.writerProcessStartIdentity !== undefined && typeof owner.writerProcessStartIdentity !== "string") return undefined;
	if (owner.writerState === "running" && owner.writerPid === undefined) return undefined;
	if (owner.writerState !== "running" && (owner.writerPid !== undefined || owner.writerProcessStartIdentity !== undefined)) return undefined;
	return owner as SessionLeaseOwner;
}

function readLeaseOwner(leaseDir: string): SessionLeaseOwner | undefined {
	try {
		return parseOwner(JSON.parse(fs.readFileSync(path.join(leaseDir, "owner.json"), "utf-8")));
	} catch {
		return undefined;
	}
}

function conflictMessage(canonicalSessionFile: string, owner: SessionLeaseOwner | undefined): string {
	if (!owner) {
		return `Direct revival of session '${canonicalSessionFile}' is blocked by an existing lease with unreadable owner metadata. Refusing to reclaim it without proof that the owner is stale.`;
	}
	const parent = owner.parentSessionId ? `, parent session '${owner.parentSessionId}'` : "";
	return `Direct revival of session '${canonicalSessionFile}' is already owned by run '${owner.runId}' (source run '${owner.sourceRunId}'${parent}, pid ${owner.pid} on ${owner.hostname}). Wait for that revival to finish or start a separate continuation without reusing this session file.`;
}

function processDemonstrablyGone(
	pid: number,
	startIdentity: string | undefined,
	options: Required<Pick<SessionLeaseOptions, "isProcessAlive" | "getProcessStartIdentity">>,
): boolean {
	const alive = options.isProcessAlive(pid);
	if (alive === false) return true;
	if (alive !== true || !startIdentity) return false;
	const currentIdentity = options.getProcessStartIdentity(pid);
	return currentIdentity !== undefined && currentIdentity !== startIdentity;
}

function demonstrablyStale(owner: SessionLeaseOwner, options: Required<Pick<SessionLeaseOptions, "hostname" | "isProcessAlive" | "getProcessStartIdentity">>): boolean {
	if (owner.hostname !== options.hostname) return false;
	if (!processDemonstrablyGone(owner.pid, owner.processStartIdentity, options)) return false;
	if (owner.writerState === "spawning") return false;
	if (owner.writerState === "none") return true;
	return owner.writerPid !== undefined
		&& processDemonstrablyGone(owner.writerPid, owner.writerProcessStartIdentity, options);
}

function createLeaseDirectory(leaseDir: string, owner: SessionLeaseOwner): boolean {
	const tempDir = `${leaseDir}.candidate-${owner.token}`;
	fs.mkdirSync(path.dirname(leaseDir), { recursive: true, mode: 0o700 });
	fs.rmSync(tempDir, { recursive: true, force: true });
	fs.mkdirSync(tempDir, { mode: 0o700 });
	try {
		fs.writeFileSync(path.join(tempDir, "owner.json"), JSON.stringify(owner, null, 2), { encoding: "utf-8", mode: 0o600 });
		try {
			fs.renameSync(tempDir, leaseDir);
			return true;
		} catch (error) {
			if (fs.existsSync(leaseDir)) return false;
			throw error;
		}
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
}

export function acquireSessionLease(request: SessionLeaseRequest, options: SessionLeaseOptions = {}): SessionLeaseHandle {
	const canonicalSessionFile = canonicalSessionFilePath(request.sessionFile);
	const rootDir = options.rootDir ?? SESSION_LEASES_DIR;
	const leaseDir = sessionLeaseDir(canonicalSessionFile, rootDir);
	const now = options.now ?? Date.now;
	const pid = options.pid ?? process.pid;
	const hostname = options.hostname ?? os.hostname();
	const getIdentity = options.getProcessStartIdentity ?? getProcessStartIdentity;
	const processStartIdentity = options.processStartIdentity
		?? getIdentity(pid)
		?? (pid === process.pid ? `runtime:${Math.round(Date.now() - process.uptime() * 1000)}` : undefined);
	const acquiredAtMs = now();
	const owner: SessionLeaseOwner = {
		version: 1,
		token: options.token?.() ?? randomUUID(),
		canonicalSessionFile,
		runId: request.runId,
		sourceRunId: request.sourceRunId,
		...(request.parentSessionId ? { parentSessionId: request.parentSessionId } : {}),
		pid,
		hostname,
		...(processStartIdentity ? { processStartIdentity } : {}),
		writerState: "none",
		acquiredAt: new Date(acquiredAtMs).toISOString(),
		acquiredAtMs,
		updatedAtMs: acquiredAtMs,
	};
	const staleOptions = {
		hostname,
		isProcessAlive: options.isProcessAlive ?? processIsAlive,
		getProcessStartIdentity: getIdentity,
	};

	for (let attempt = 0; attempt < 4; attempt++) {
		if (createLeaseDirectory(leaseDir, owner)) {
			const writeOwner = createAtomicJsonWriter();
			return {
				leaseDir,
				owner,
				updateWriter(writer) {
					const currentOwner = readLeaseOwner(leaseDir);
					if (!currentOwner || currentOwner.token !== owner.token) {
						throw new Error(`Session revival lease ownership changed for run '${owner.runId}'.`);
					}
					const writerProcessStartIdentity = writer.state === "running" ? getIdentity(writer.pid) : undefined;
					const nextOwner: SessionLeaseOwner = {
						...owner,
						writerState: writer.state,
						...(writer.state === "running" ? { writerPid: writer.pid } : {}),
						...(writerProcessStartIdentity ? { writerProcessStartIdentity } : {}),
						updatedAtMs: now(),
					};
					delete nextOwner.writerPid;
					delete nextOwner.writerProcessStartIdentity;
					if (writer.state === "running") {
						nextOwner.writerPid = writer.pid;
						if (writerProcessStartIdentity) nextOwner.writerProcessStartIdentity = writerProcessStartIdentity;
					}
					writeOwner(path.join(leaseDir, "owner.json"), nextOwner);
					delete owner.writerPid;
					delete owner.writerProcessStartIdentity;
					Object.assign(owner, nextOwner);
				},
				release() {
					const currentOwner = readLeaseOwner(leaseDir);
					if (!currentOwner || currentOwner.token !== owner.token) return;
					fs.rmSync(leaseDir, { recursive: true, force: true });
				},
			};
		}

		const existingOwner = readLeaseOwner(leaseDir);
		if (!existingOwner || !demonstrablyStale(existingOwner, staleOptions)) {
			throw new SessionLeaseConflictError(conflictMessage(canonicalSessionFile, existingOwner), existingOwner);
		}
		// The per-owner tombstone is retained. Every contender that observed this
		// stale token targets the same occupied destination, so only the first can
		// rename it and later contenders cannot move a successor lease by mistake.
		const tombstone = `${leaseDir}.stale-${existingOwner.token.replace(/[^A-Za-z0-9._-]/g, "-")}`;
		try {
			fs.renameSync(leaseDir, tombstone);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ENOENT" || fs.existsSync(tombstone)) continue;
			throw error;
		}
	}

	const existingOwner = readLeaseOwner(leaseDir);
	throw new SessionLeaseConflictError(conflictMessage(canonicalSessionFile, existingOwner), existingOwner);
}
