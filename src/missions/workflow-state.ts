import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { writePrivateAtomicJson } from "../shared/atomic-json.ts";
import { DEFAULT_FILE_SYSTEM_RETRY_DELAYS_MS, waitForFileSystemRetry } from "../shared/file-system-retry.ts";
import { assertWorkflowJsonValue } from "../workflows/scripted-workflow.ts";
import type { MissionStoreLocation } from "./types.ts";
import { validateMissionId } from "./store.ts";

const STATE_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const STATE_LOCK_STALE_MS = 60_000;
export const MISSION_STATE_MAX_BYTES = 256 * 1024;

export interface MissionWorkflowState {
	path: string;
	get(key: string): unknown;
	set(key: string, value: unknown): void;
}

export function missionStatePath(location: MissionStoreLocation, missionId: string): string {
	return path.join(location.missionDir, validateMissionId(missionId), "state.json");
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

interface StateLockOwner {
	pid: number;
	token: string;
	createdAt: number;
	processKey?: string;
}

function linuxProcessStartKey(pid: number): string | undefined {
	try {
		const raw = fs.readFileSync(`/proc/${pid}/stat`, "utf-8");
		const tail = raw.slice(raw.lastIndexOf(")") + 2).trim().split(/\s+/);
		return tail[19] ? `linux:${tail[19]}` : undefined;
	} catch {
		return undefined;
	}
}

function psProcessStartKey(pid: number): string | undefined {
	try {
		const raw = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 1000 }).trim();
		return raw ? `ps:${raw}` : undefined;
	} catch {
		return undefined;
	}
}

function windowsProcessStartKey(pid: number): string | undefined {
	try {
		const raw = execFileSync("powershell.exe", ["-NoProfile", "-Command", `(Get-CimInstance Win32_Process -Filter \"ProcessId=${pid}\").CreationDate`], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 1000 }).trim();
		return raw ? `win:${raw}` : undefined;
	} catch {
		return undefined;
	}
}

function processStartKey(pid: number): string | undefined {
	if (process.platform === "linux") return linuxProcessStartKey(pid) ?? psProcessStartKey(pid);
	if (process.platform === "win32") return windowsProcessStartKey(pid);
	return psProcessStartKey(pid);
}

const CURRENT_PROCESS_KEY = processStartKey(process.pid);

function readStateLockOwner(lockPath: string): StateLockOwner | undefined {
	try {
		const owner = JSON.parse(fs.readFileSync(path.join(lockPath, "owner.json"), "utf-8")) as { pid?: unknown; token?: unknown; createdAt?: unknown; processKey?: unknown };
		if (Number.isSafeInteger(owner.pid) && (owner.pid as number) > 0 && typeof owner.token === "string" && owner.token && Number.isSafeInteger(owner.createdAt)) {
			return {
				pid: owner.pid as number,
				token: owner.token,
				createdAt: owner.createdAt as number,
				...(typeof owner.processKey === "string" && owner.processKey ? { processKey: owner.processKey } : {}),
			};
		}
	} catch {
		return undefined;
	}
	return undefined;
}

function stateLockIsStale(lockPath: string, now = Date.now()): boolean {
	const owner = readStateLockOwner(lockPath);
	if (owner) {
		if (!isProcessAlive(owner.pid)) return true;
		const currentProcessKey = processStartKey(owner.pid);
		return Boolean(owner.processKey && currentProcessKey && owner.processKey !== currentProcessKey);
	}
	try {
		return now - fs.statSync(lockPath).mtimeMs > STATE_LOCK_STALE_MS;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

function removeOwnedStateLock(lockPath: string, owner: StateLockOwner): void {
	const current = readStateLockOwner(lockPath);
	if (current?.token !== owner.token) return;
	fs.rmSync(lockPath, { recursive: true, force: true });
}

function staleDirectoryExists(dirPath: string, now = Date.now()): boolean {
	try {
		return now - fs.statSync(dirPath).mtimeMs > STATE_LOCK_STALE_MS;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

function tryMakeDirectory(dirPath: string, mode: number): boolean {
	try {
		fs.mkdirSync(dirPath, { mode });
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
		throw error;
	}
}

function waitForStateLock(delayMs: number | undefined, lockPath: string): void {
	if (delayMs === undefined) throw new Error(`Timed out acquiring mission state lock '${lockPath}'.`);
	waitForFileSystemRetry(delayMs);
}

function reclaimStaleStateLock(lockPath: string, reclaimPath: string): boolean {
	if (!stateLockIsStale(lockPath)) return false;
	if (!tryMakeDirectory(reclaimPath, 0o700)) return false;
	try {
		if (!stateLockIsStale(lockPath)) return false;
		fs.rmSync(lockPath, { recursive: true, force: true });
		return true;
	} finally {
		fs.rmSync(reclaimPath, { recursive: true, force: true });
	}
}

function withStateFileLock<T>(filePath: string, operation: () => T): T {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	const lockPath = `${filePath}.lock`;
	const reclaimPath = `${lockPath}.reclaim`;
	let owner: StateLockOwner | undefined;
	for (let attempt = 0; ; attempt++) {
		if (fs.existsSync(reclaimPath)) {
			if (staleDirectoryExists(reclaimPath)) {
				fs.rmSync(reclaimPath, { recursive: true, force: true });
				continue;
			}
			waitForStateLock(DEFAULT_FILE_SYSTEM_RETRY_DELAYS_MS[attempt], lockPath);
			continue;
		}
		try {
			fs.mkdirSync(lockPath, { mode: 0o700 });
			owner = { pid: process.pid, token: randomUUID(), createdAt: Date.now(), ...(CURRENT_PROCESS_KEY ? { processKey: CURRENT_PROCESS_KEY } : {}) };
			try {
				fs.writeFileSync(path.join(lockPath, "owner.json"), JSON.stringify(owner), { encoding: "utf-8", mode: 0o600 });
			} catch (error) {
				removeOwnedStateLock(lockPath, owner);
				owner = undefined;
				throw error;
			}
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
				throw new Error(`Failed to acquire mission state lock '${lockPath}': ${error instanceof Error ? error.message : String(error)}`);
			}
			if (reclaimStaleStateLock(lockPath, reclaimPath)) continue;
			waitForStateLock(DEFAULT_FILE_SYSTEM_RETRY_DELAYS_MS[attempt], lockPath);
		}
	}
	try {
		return operation();
	} finally {
		if (owner) removeOwnedStateLock(lockPath, owner);
	}
}

function validateStateKey(value: unknown): string {
	if (typeof value !== "string" || !STATE_KEY_PATTERN.test(value)) {
		throw new Error("state key must be 1-128 characters using letters, numbers, '.', '_' or '-', and start with a letter or number.");
	}
	return value;
}

export function createMissionWorkflowState(location: MissionStoreLocation, missionId: string): MissionWorkflowState {
	const filePath = missionStatePath(location, missionId);
	let loaded = false;
	let values: Record<string, unknown> = Object.create(null) as Record<string, unknown>;

	const readStateFile = (): Record<string, unknown> => {
		let raw: string;
		try {
			raw = fs.readFileSync(filePath, "utf-8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return Object.create(null) as Record<string, unknown>;
			throw new Error(`Failed to read mission state '${filePath}': ${error instanceof Error ? error.message : String(error)}`);
		}
		const bytes = Buffer.byteLength(raw);
		if (bytes > MISSION_STATE_MAX_BYTES) throw new Error(`Mission state file '${filePath}' exceeds the 256 KiB limit (${bytes} bytes).`);
		try {
			const parsed: unknown = JSON.parse(raw);
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("root must be a JSON object");
			assertWorkflowJsonValue(parsed, "mission state");
			return Object.assign(Object.create(null) as Record<string, unknown>, parsed);
		} catch (error) {
			throw new Error(`Invalid mission state file '${filePath}': ${error instanceof Error ? error.message : String(error)}`);
		}
	};

	const load = (): Record<string, unknown> => {
		if (loaded) return values;
		values = readStateFile();
		loaded = true;
		return values;
	};

	return {
		path: filePath,
		get(key) {
			const validKey = validateStateKey(key);
			const current = load();
			return Object.hasOwn(current, validKey) ? current[validKey] : undefined;
		},
		set(key, value) {
			const validKey = validateStateKey(key);
			assertWorkflowJsonValue(value, `state.set('${validKey}') value`);
			withStateFileLock(filePath, () => {
				const next = Object.assign(Object.create(null) as Record<string, unknown>, readStateFile(), { [validKey]: value });
				const bytes = Buffer.byteLength(JSON.stringify(next, null, 2));
				if (bytes > MISSION_STATE_MAX_BYTES) throw new Error(`Mission state exceeds the 256 KiB limit (${bytes} bytes; maximum ${MISSION_STATE_MAX_BYTES} bytes).`);
				writePrivateAtomicJson(filePath, next);
				values = next;
				loaded = true;
			});
		},
	};
}
