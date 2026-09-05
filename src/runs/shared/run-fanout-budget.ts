import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { DEFAULT_FILE_SYSTEM_RETRY_DELAYS_MS, waitForFileSystemRetry } from "../../shared/file-system-retry.ts";
import {
	TEMP_ROOT_DIR,
	type RunFanoutBudgetDescriptor,
	type RunFanoutBudgetSnapshot,
	type RunFanoutRejection,
} from "../../shared/types.ts";

const RUN_FANOUT_ROOT = path.join(TEMP_ROOT_DIR, "run-fanout-budgets");

interface FanoutBudgetManifest {
	version: 1;
	rootRunId: string;
	limit: number;
	createdAt: number;
}

interface FanoutBudgetClaim {
	version: 1;
	claimId: string;
	path: string;
	claimedAt: number;
}

export class RunFanoutLimitError extends Error {
	readonly rejection: RunFanoutRejection;
	readonly snapshot: RunFanoutBudgetSnapshot;

	constructor(rejection: RunFanoutRejection) {
		super(formatRunFanoutRejection(rejection));
		this.name = "RunFanoutLimitError";
		this.rejection = rejection;
		this.snapshot = { used: rejection.used, limit: rejection.limit, remaining: rejection.remaining };
	}
}

function safeRootRunId(rootRunId: string): string {
	return rootRunId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || randomUUID();
}

function parseManifest(value: unknown): FanoutBudgetManifest | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const manifest = value as Partial<FanoutBudgetManifest>;
	if (manifest.version !== 1 || typeof manifest.rootRunId !== "string" || !manifest.rootRunId
		|| !Number.isInteger(manifest.limit) || (manifest.limit ?? 0) <= 0
		|| typeof manifest.createdAt !== "number" || !Number.isFinite(manifest.createdAt)) return undefined;
	return manifest as FanoutBudgetManifest;
}

function readManifest(directory: string): FanoutBudgetManifest {
	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(path.join(directory, "manifest.json"), "utf-8"));
	} catch (error) {
		throw new Error(`Run fan-out budget manifest is unreadable at '${directory}': ${error instanceof Error ? error.message : String(error)}`);
	}
	const manifest = parseManifest(parsed);
	if (!manifest) throw new Error(`Run fan-out budget manifest is invalid at '${directory}'.`);
	return manifest;
}

function validateDirectory(directory: string): string {
	let realDirectory: string;
	let realRoot: string;
	try {
		realDirectory = fs.realpathSync(path.resolve(directory));
		realRoot = fs.realpathSync(path.resolve(RUN_FANOUT_ROOT));
	} catch (error) {
		throw new Error(`Run fan-out budget directory is unavailable: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (realDirectory !== realRoot && !realDirectory.startsWith(`${realRoot}${path.sep}`)) {
		throw new Error("Run fan-out budget directory resolves outside the managed budget root.");
	}
	return realDirectory;
}

export function createRunFanoutBudget(rootRunId: string, limit: number): RunFanoutBudgetDescriptor {
	if (!Number.isInteger(limit) || limit <= 0) throw new Error("Run fan-out limit must be a positive integer.");
	fs.mkdirSync(RUN_FANOUT_ROOT, { recursive: true, mode: 0o700 });
	let directory: string;
	do directory = path.join(RUN_FANOUT_ROOT, `${safeRootRunId(rootRunId)}-${randomUUID()}`);
	while (fs.existsSync(directory));
	fs.mkdirSync(path.join(directory, "claims"), { recursive: true, mode: 0o700 });
	const manifest: FanoutBudgetManifest = { version: 1, rootRunId, limit, createdAt: Date.now() };
	fs.writeFileSync(path.join(directory, "manifest.json"), `${JSON.stringify(manifest)}\n`, { mode: 0o600, flag: "wx" });
	return { version: 1, rootRunId, directory, limit };
}

export function validateRunFanoutBudgetDescriptor(value: unknown): RunFanoutBudgetDescriptor {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Run fan-out budget descriptor is missing or invalid.");
	const descriptor = value as Partial<RunFanoutBudgetDescriptor>;
	if (descriptor.version !== 1 || typeof descriptor.rootRunId !== "string" || !descriptor.rootRunId
		|| typeof descriptor.directory !== "string" || !descriptor.directory
		|| !Number.isInteger(descriptor.limit) || (descriptor.limit ?? 0) <= 0
		|| (descriptor.parentPath !== undefined && typeof descriptor.parentPath !== "string")) {
		throw new Error("Run fan-out budget descriptor is invalid.");
	}
	const directory = validateDirectory(descriptor.directory);
	const manifest = readManifest(directory);
	if (manifest.rootRunId !== descriptor.rootRunId || manifest.limit !== descriptor.limit) {
		throw new Error("Run fan-out budget descriptor does not match its manifest.");
	}
	return { version: 1, rootRunId: descriptor.rootRunId, directory, limit: descriptor.limit, ...(descriptor.parentPath ? { parentPath: descriptor.parentPath } : {}) };
}

export function writeRunFanoutBudgetDescriptor(asyncDir: string, descriptor: RunFanoutBudgetDescriptor): void {
	const valid = validateRunFanoutBudgetDescriptor(descriptor);
	fs.mkdirSync(asyncDir, { recursive: true });
	fs.writeFileSync(path.join(asyncDir, "run-fanout-budget.json"), `${JSON.stringify(valid)}\n`, { mode: 0o600 });
}

export function readRunFanoutBudgetDescriptor(asyncDir: string | undefined): RunFanoutBudgetDescriptor | undefined {
	if (!asyncDir) return undefined;
	const descriptorPath = path.join(asyncDir, "run-fanout-budget.json");
	if (!fs.existsSync(descriptorPath)) return undefined;
	try {
		return validateRunFanoutBudgetDescriptor(JSON.parse(fs.readFileSync(descriptorPath, "utf-8")));
	} catch (error) {
		throw new Error(`Invalid persisted run fan-out budget '${descriptorPath}': ${error instanceof Error ? error.message : String(error)}`);
	}
}


interface AdmissionLockOwner {
	pid: number;
	token: string;
}

const ADMISSION_LOCK_STALE_MS = 60_000;

function readAdmissionLockOwner(lockPath: string): AdmissionLockOwner | undefined {
	try {
		const owner = JSON.parse(fs.readFileSync(path.join(lockPath, "owner.json"), "utf-8")) as Partial<AdmissionLockOwner>;
		if (Number.isSafeInteger(owner.pid) && (owner.pid ?? 0) > 0 && typeof owner.token === "string" && owner.token) return owner as AdmissionLockOwner;
	} catch {}
	return undefined;
}

function admissionLockIsStale(lockPath: string): boolean {
	const owner = readAdmissionLockOwner(lockPath);
	if (owner) {
		try {
			process.kill(owner.pid, 0);
			return false;
		} catch (error) {
			return (error as NodeJS.ErrnoException).code !== "EPERM";
		}
	}
	try { return Date.now() - fs.statSync(lockPath).mtimeMs > ADMISSION_LOCK_STALE_MS; }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

function withAdmissionLock<T>(directory: string, operation: () => T): T {
	const lockPath = path.join(directory, "admission.lock");
	const owner: AdmissionLockOwner = { pid: process.pid, token: randomUUID() };
	for (let attempt = 0; ; attempt++) {
		try {
			fs.mkdirSync(lockPath, { mode: 0o700 });
			try { fs.writeFileSync(path.join(lockPath, "owner.json"), JSON.stringify(owner), { mode: 0o600 }); }
			catch (error) {
				fs.rmSync(lockPath, { recursive: true, force: true });
				throw error;
			}
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			if (admissionLockIsStale(lockPath)) {
				const stalePath = path.join(directory, `admission.stale-${randomUUID()}`);
				try {
					fs.renameSync(lockPath, stalePath);
					fs.rmSync(stalePath, { recursive: true, force: true });
					continue;
				} catch (reclaimError) {
					if ((reclaimError as NodeJS.ErrnoException).code !== "ENOENT") throw reclaimError;
				}
			}
			const delay = DEFAULT_FILE_SYSTEM_RETRY_DELAYS_MS[attempt];
			if (delay === undefined) throw new Error(`Timed out acquiring run fan-out admission lock at '${directory}'.`);
			waitForFileSystemRetry(delay);
		}
	}
	try { return operation(); }
	finally {
		if (readAdmissionLockOwner(lockPath)?.token === owner.token) fs.rmSync(lockPath, { recursive: true, force: true });
	}
}

function claimCount(directory: string): number {
	const claimsDir = path.join(directory, "claims");
	let entries: fs.Dirent[];
	try { entries = fs.readdirSync(claimsDir, { withFileTypes: true }); }
	catch (error) {
		throw new Error(`Run fan-out claims directory is unreadable at '${claimsDir}': ${error instanceof Error ? error.message : String(error)}`);
	}
	return entries.filter((entry) => /^\d{6}\.json$/.test(entry.name)).length;
}

export function getRunFanoutBudgetSnapshot(descriptor: RunFanoutBudgetDescriptor): RunFanoutBudgetSnapshot {
	const valid = validateRunFanoutBudgetDescriptor(descriptor);
	const used = claimCount(valid.directory);
	return { used, limit: valid.limit, remaining: Math.max(0, valid.limit - used) };
}

function qualifyRunFanoutPaths(descriptor: RunFanoutBudgetDescriptor, paths: string[]): string[] {
	const prefix = descriptor.parentPath?.trim();
	return paths.map((item) => prefix ? `${prefix}/${item}` : item);
}

function commitRunFanoutBatch<T>(descriptor: RunFanoutBudgetDescriptor, paths: string[], commit: (snapshot: RunFanoutBudgetSnapshot) => T): T {
	const valid = validateRunFanoutBudgetDescriptor(descriptor);
	if (paths.length === 0) return commit(getRunFanoutBudgetSnapshot(valid));
	const qualified = qualifyRunFanoutPaths(valid, paths);
	return withAdmissionLock(valid.directory, () => {
		const before = getRunFanoutBudgetSnapshot(valid);
		if (qualified.length > before.remaining) {
			throw new RunFanoutLimitError({ code: "RUN_FANOUT_LIMIT", path: qualified[before.remaining] ?? qualified[0]!, requested: qualified.length, ...before });
		}
		const created: string[] = [];
		try {
			for (const claimPath of qualified) {
				for (let slot = 0; slot < valid.limit; slot++) {
					const slotPath = path.join(valid.directory, "claims", `${String(slot).padStart(6, "0")}.json`);
					try {
						const fd = fs.openSync(slotPath, "wx", 0o600);
						created.push(slotPath);
						try {
							const claim: FanoutBudgetClaim = { version: 1, claimId: randomUUID(), path: claimPath, claimedAt: Date.now() };
							fs.writeFileSync(fd, `${JSON.stringify(claim)}\n`, "utf-8");
						} finally { fs.closeSync(fd); }
						break;
					} catch (error) {
						if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
						throw error;
					}
				}
			}
			return commit(getRunFanoutBudgetSnapshot(valid));
		} catch (error) {
			for (const slotPath of created) {
				try { fs.unlinkSync(slotPath); } catch {}
			}
			throw error;
		}
	});
}

export function claimRunFanoutBatch(descriptor: RunFanoutBudgetDescriptor, paths: string[]): RunFanoutBudgetSnapshot {
	return commitRunFanoutBatch(descriptor, paths, (snapshot) => snapshot);
}

export function claimRunFanoutBatchWithCommit<T>(descriptor: RunFanoutBudgetDescriptor, paths: string[], commit: () => T): T {
	return commitRunFanoutBatch(descriptor, paths, commit);
}

export function formatRunFanoutBudget(snapshot: RunFanoutBudgetSnapshot): string {
	return `Run fan-out: ${snapshot.used}/${snapshot.limit} used, ${snapshot.remaining} remaining`;
}

function formatRunFanoutRejection(rejection: RunFanoutRejection): string {
	return `Run fan-out limit reached at ${rejection.path} (${rejection.used}/${rejection.limit} used; ${rejection.requested} requested, ${rejection.remaining} remaining). No children from this admission group were started. Start a new top-level run or raise config.maxSubagentSpawnsPerRun.`;
}
