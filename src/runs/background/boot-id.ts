import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { currentPidNamespaceScope } from "./pid-namespace.ts";
import type { RecordedPid } from "./stale-run-reconciler.ts";

function readBootIdFromOs(): string | undefined {
	try {
		if (process.platform === "linux") return fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf-8").trim() || undefined;
		if (process.platform === "darwin") {
			return execFileSync("sysctl", ["-n", "kern.bootsessionuuid"], { encoding: "utf-8", timeout: 1000, stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined;
		}
	} catch {
		// An unreadable boot id only means liveness falls back to probing the pid.
	}
	return undefined;
}

// Process-wide, so the bundled extension and the compiled runner modules share one value.
const BOOT_ID_KEY = Symbol.for("pi-subagents.boot-id.v1");
const runtime = globalThis as typeof globalThis & { [BOOT_ID_KEY]?: { value: string | undefined } };

let reader: () => string | undefined = readBootIdFromOs;

/**
 * Identity of the current machine boot, read once per process. A pid recorded under a
 * different boot id cannot still be running. Undefined when the platform has none.
 */
export function currentBootId(): string | undefined {
	const cached = runtime[BOOT_ID_KEY];
	if (cached) return cached.value;
	const value = reader();
	runtime[BOOT_ID_KEY] = { value };
	return value;
}

/** This process as a recorded pid, without the fields the platform does not have. */
export function currentRecordedPid(): RecordedPid {
	const pidNamespaceScope = currentPidNamespaceScope();
	const bootId = currentBootId();
	return { pid: process.pid, ...(pidNamespaceScope ? { pidNamespaceScope } : {}), ...(bootId ? { bootId } : {}) };
}

/** Fixes the boot id without reading the OS; runners take Pi's value from their config. */
export function primeBootId(value: string | undefined): void {
	runtime[BOOT_ID_KEY] = { value };
}

/** Clears the cache so the next read calls `nextReader` (default: the OS reader). */
export function resetBootIdForTesting(nextReader?: () => string | undefined): void {
	reader = nextReader ?? readBootIdFromOs;
	delete runtime[BOOT_ID_KEY];
}
