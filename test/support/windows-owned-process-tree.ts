import { spawnSync } from "node:child_process";
import type { ProcessTreeTerminal } from "../../src/shared/types.ts";
import type { OwnedProcessTreeController } from "../../src/runs/background/owned-process-tree.ts";

const VERIFY_INTERVAL_MS = 25;

export interface WindowsProcessRecord {
	pid: number;
	parentPid: number;
	creationIdentity: string;
}

export interface WindowsTestProcessOps {
	processTable(): WindowsProcessRecord[] | { diagnostic: string };
	terminateExact(pid: number, expectedCreationIdentity: string, timeoutMs: number): ExactTerminationResult;
}

export type ExactTerminationStatus = "terminated" | "absent" | "identity-mismatch" | "access-denied" | "query-failed" | "terminate-failed" | "wait-timeout";
export interface ExactTerminationResult { status: ExactTerminationStatus; diagnostic?: string }

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function defaultProcessTable(): WindowsProcessRecord[] | { diagnostic: string } {
	const script = [
		"$ErrorActionPreference = 'Stop'",
		"$rows = @(Get-CimInstance Win32_Process | ForEach-Object {",
		"  [PSCustomObject]@{ pid = [int64]$_.ProcessId; parentPid = [int64]$_.ParentProcessId; creationIdentity = $_.CreationDate.ToUniversalTime().Ticks.ToString([Globalization.CultureInfo]::InvariantCulture) }",
		"})",
		"ConvertTo-Json -Compress -InputObject $rows",
	].join("\n");
	const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", script], { encoding: "utf-8", windowsHide: true, timeout: 1000 });
	if (result.error || result.status !== 0) return { diagnostic: result.error ? message(result.error) : result.stderr.trim() || `PowerShell exited with ${result.status}` };
	try {
		const raw = JSON.parse(result.stdout) as unknown;
		if (!Array.isArray(raw)) throw new Error("process table was not an array");
		const rows: WindowsProcessRecord[] = [];
		for (const item of raw) {
			const row = item as Partial<WindowsProcessRecord>;
			if (!Number.isSafeInteger(row.pid) || !Number.isSafeInteger(row.parentPid) || typeof row.creationIdentity !== "string" || !/^\d+$/.test(row.creationIdentity)) throw new Error("process table contained an invalid row");
			rows.push({ pid: row.pid!, parentPid: row.parentPid!, creationIdentity: row.creationIdentity });
		}
		return rows;
	} catch (error) {
		return { diagnostic: `Invalid PowerShell process table: ${message(error)}` };
	}
}

const defaultOps: WindowsTestProcessOps = {
	processTable: defaultProcessTable,
	terminateExact(pid, expectedCreationIdentity, timeoutMs) {
		return runExactTerminationHelper(pid, expectedCreationIdentity, timeoutMs);
	},
};

type HelperCommandResult = { status: number | null; stdout: string; stderr: string; error?: Error };

export function mapExactTerminationHelperResult(result: HelperCommandResult): ExactTerminationResult {
	if (result.error || result.status !== 0) return { status: "query-failed", diagnostic: result.error ? message(result.error) : result.stderr.trim() || `PowerShell exited with ${result.status}` };
	try {
		const raw = JSON.parse(result.stdout) as { status?: unknown; diagnostic?: unknown };
		const statuses: ExactTerminationStatus[] = ["terminated", "absent", "identity-mismatch", "access-denied", "query-failed", "terminate-failed", "wait-timeout"];
		if (!statuses.includes(raw.status as ExactTerminationStatus)) throw new Error("unknown helper status");
		return { status: raw.status as ExactTerminationStatus, ...(typeof raw.diagnostic === "string" && raw.diagnostic ? { diagnostic: raw.diagnostic } : {}) };
	} catch (error) {
		return { status: "query-failed", diagnostic: `Invalid exact-termination helper output: ${message(error)}` };
	}
}

function runExactTerminationHelper(pid: number, expectedCreationIdentity: string, timeoutMs: number): ExactTerminationResult {
	const source = String.raw`
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class PiExactProcessTerminator {
  const uint PROCESS_TERMINATE = 0x0001, PROCESS_QUERY_LIMITED_INFORMATION = 0x1000, SYNCHRONIZE = 0x00100000;
  const uint WAIT_OBJECT_0 = 0, WAIT_TIMEOUT = 258;
  const long FILETIME_TO_DATETIME_TICKS = 504911232000000000L;
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(IntPtr handle, out long creation, out long exit, out long kernel, out long user);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr handle, uint exitCode);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  static string Json(string status, string diagnostic) { return "{\"status\":\"" + status + "\",\"diagnostic\":\"" + diagnostic.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"}"; }
  public static string Run(int pid, long expectedTicks, uint timeoutMs) {
    IntPtr handle = OpenProcess(PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, false, pid);
    if (handle == IntPtr.Zero) { int error = Marshal.GetLastWin32Error(); return Json(error == 5 ? "access-denied" : error == 87 || error == 1168 ? "absent" : "query-failed", "OpenProcess error " + error); }
    try {
      long creation, exit, kernel, user;
      if (!GetProcessTimes(handle, out creation, out exit, out kernel, out user)) return Json("query-failed", "GetProcessTimes error " + Marshal.GetLastWin32Error());
      long ticks = checked(creation + FILETIME_TO_DATETIME_TICKS);
      if (ticks != expectedTicks) return Json("identity-mismatch", "creation ticks " + ticks + " did not match " + expectedTicks);
      if (!TerminateProcess(handle, 1)) return Json("terminate-failed", "TerminateProcess error " + Marshal.GetLastWin32Error());
      uint wait = WaitForSingleObject(handle, timeoutMs);
      if (wait == WAIT_OBJECT_0) return Json("terminated", "handle signalled");
      return Json(wait == WAIT_TIMEOUT ? "wait-timeout" : "terminate-failed", "WaitForSingleObject result " + wait);
    } catch (Exception error) { return Json("query-failed", error.Message); }
    finally { CloseHandle(handle); }
  }
}`;
	const script = `Add-Type -TypeDefinition @'\n${source}\n'@\n[PiExactProcessTerminator]::Run(${pid}, [long]${expectedCreationIdentity}, [uint32]${Math.max(0, timeoutMs)})`;
	const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", script], { encoding: "utf-8", windowsHide: true, timeout: timeoutMs + 2000 });
	return mapExactTerminationHelperResult({ status: result.status, stdout: result.stdout, stderr: result.stderr, ...(result.error ? { error: result.error } : {}) });
}

function identityKey(record: WindowsProcessRecord): string {
	return `${record.pid}@${record.creationIdentity}`;
}

function addDescendants(owned: Map<string, WindowsProcessRecord>, rows: readonly WindowsProcessRecord[]): number {
	let added = 0;
	for (;;) {
		const additions = rows.filter((row) => {
			if (owned.has(identityKey(row))) return false;
			if ([...owned.values()].some((candidate) => candidate.pid === row.pid)) return false;
			const parent = [...owned.values()].find((candidate) => candidate.pid === row.parentPid);
			if (!parent || BigInt(row.creationIdentity) <= BigInt(parent.creationIdentity)) return false;
			const currentParent = rows.find((candidate) => candidate.pid === parent.pid);
			return currentParent?.creationIdentity === parent.creationIdentity;
		});
		if (additions.length === 0) return added;
		for (const row of additions) {
			owned.set(identityKey(row), row);
			added++;
		}
	}
}

function depthOf(target: WindowsProcessRecord, owned: Map<string, WindowsProcessRecord>): number {
	let depth = 0;
	let current = target;
	const visited = new Set<string>();
	while (!visited.has(identityKey(current))) {
		visited.add(identityKey(current));
		const parent = [...owned.values()].find((candidate) => candidate.pid === current.parentPid);
		if (!parent) return depth;
		depth++;
		current = parent;
	}
	return depth;
}

function unknown(diagnostic: string): ProcessTreeTerminal {
	return { state: "unknown", reason: "verification-failed", diagnostic };
}

/** Strict Windows controller used only by integration fixtures. */
export function createWindowsTestProcessTreeController(
	pid: number,
	options: { verifyMs?: number; commandTimeoutMs?: number; ops?: WindowsTestProcessOps } = {},
): OwnedProcessTreeController {
	const ops = options.ops ?? defaultOps;
	const initial = ops.processTable();
	const initialRoot = Array.isArray(initial) ? initial.find((row) => row.pid === pid) : undefined;
	const captureFailure = !Array.isArray(initial)
		? `Could not capture Windows process identity for ${pid}: ${initial.diagnostic}`
		: !initialRoot ? `Could not capture Windows process identity for ${pid}: root absent.` : undefined;
	let termination: Promise<ProcessTreeTerminal> | undefined;
	const terminate = () => {
		if (termination) return termination;
		termination = (async (): Promise<ProcessTreeTerminal> => {
			if (captureFailure || !initialRoot) return unknown(captureFailure ?? `Windows root ${pid} identity unavailable.`);
			const deadline = Date.now() + (options.verifyMs ?? 2000);
			const owned = new Map<string, WindowsProcessRecord>([[identityKey(initialRoot), initialRoot]]);
			const signalled = new Set<string>();
			const seen = new Set(Array.isArray(initial) ? initial.map(identityKey) : []);
			const readTable = (purpose: string): WindowsProcessRecord[] | string => {
				const table = ops.processTable();
				if (!Array.isArray(table)) return `Could not ${purpose} Windows process tree ${pid}: ${table.diagnostic}`;
				return table;
			};
			const reused = (table: readonly WindowsProcessRecord[]): string | undefined => {
				for (const target of owned.values()) {
					const current = table.find((row) => row.pid === target.pid);
					if (current && current.creationIdentity !== target.creationIdentity) return `Windows process ${target.pid} creation identity changed; refusing to signal a reused PID.`;
				}
			};
			const kill = (target: WindowsProcessRecord): string | undefined => {
				const killed = ops.terminateExact(target.pid, target.creationIdentity, options.commandTimeoutMs ?? 2000);
				if (killed.status !== "terminated") return `Exact handle termination for ${identityKey(target)} returned ${killed.status}${killed.diagnostic ? `: ${killed.diagnostic}` : "."}`;
				signalled.add(identityKey(target));
			};

			// Keep the root alive while discovering and draining only descendants whose
			// exact parent identity is concurrently visible.
			while (true) {
				const snapshot = readTable("snapshot");
				if (typeof snapshot === "string") return unknown(snapshot);
				const reuse = reused(snapshot);
				if (reuse) return unknown(reuse);
				const root = snapshot.find((row) => identityKey(row) === identityKey(initialRoot));
				if (!root) return unknown(`Windows root ${identityKey(initialRoot)} disappeared before exact termination.`);
				addDescendants(owned, snapshot);
				for (const row of snapshot) seen.add(identityKey(row));
				const aliveDescendants = [...owned.values()]
					.filter((target) => target.pid !== root.pid && snapshot.some((row) => identityKey(row) === identityKey(target)));
				const descendants = aliveDescendants
					.filter((target) => !signalled.has(identityKey(target)))
					.sort((a, b) => depthOf(b, owned) - depthOf(a, owned));
				if (descendants.length === 0) {
					if (aliveDescendants.length > 0) {
						const waitMs = deadline - Date.now();
						if (waitMs <= 0) return unknown(`Signalled Windows descendants still active before root termination: ${aliveDescendants.map(identityKey).join(", ")}.`);
						await new Promise<void>((resolve) => setTimeout(resolve, Math.min(VERIFY_INTERVAL_MS, waitMs)));
						continue;
					}
					const finalRootCheck = readTable("revalidate root in");
					if (typeof finalRootCheck === "string") return unknown(finalRootCheck);
					const finalReuse = reused(finalRootCheck);
					if (finalReuse) return unknown(finalReuse);
					addDescendants(owned, finalRootCheck);
					for (const row of finalRootCheck) seen.add(identityKey(row));
					const appeared = [...owned.values()].some((target) => target.pid !== root.pid && finalRootCheck.some((row) => identityKey(row) === identityKey(target)));
					if (appeared) continue;
					if (!finalRootCheck.some((row) => identityKey(row) === identityKey(root))) return unknown(`Windows root ${identityKey(root)} disappeared before exact termination.`);
					const failure = kill(root);
					if (failure) return unknown(failure);
					break;
				}

				const target = descendants[0]!;
				const revalidation = readTable(`revalidate ${identityKey(target)} in`);
				if (typeof revalidation === "string") return unknown(revalidation);
				const reuseAtSignal = reused(revalidation);
				if (reuseAtSignal) return unknown(reuseAtSignal);
				const parent = [...owned.values()].find((candidate) => candidate.pid === target.parentPid);
				const exactParentPresent = parent && revalidation.some((row) => identityKey(row) === identityKey(parent));
				if (!exactParentPresent) return unknown(`Exact parent identity for ${identityKey(target)} disappeared before signalling; child was not signalled.`);
				const additions = addDescendants(owned, revalidation);
				for (const row of revalidation) seen.add(identityKey(row));
				if (additions > 0 || revalidation.some((row) => row.parentPid === target.pid && owned.has(identityKey(row)))) continue;
				if (!revalidation.some((row) => identityKey(row) === identityKey(target))) continue;
				const failure = kill(target);
				if (failure) return unknown(failure);
				if (Date.now() >= deadline) return unknown(`Timed out draining exact Windows descendant ${identityKey(target)} before root termination.`);
			}

			let stableAbsentScans = 0;
			while (true) {
				const verification = readTable("verify");
				if (typeof verification === "string") return unknown(verification);
				const reuse = reused(verification);
				if (reuse) return unknown(reuse);
				const ambiguous = verification.find((row) => !seen.has(identityKey(row)) && [...owned.values()].some((parent) => parent.pid === row.parentPid));
				if (ambiguous) return unknown(`Ambiguous late descendant ${identityKey(ambiguous)} references absent known parent PID ${ambiguous.parentPid}; it was not signalled.`);
				for (const row of verification) seen.add(identityKey(row));
				const remaining = [...owned.values()].filter((target) => verification.some((row) => identityKey(row) === identityKey(target)));
				if (remaining.length === 0) stableAbsentScans++;
				else stableAbsentScans = 0;
				if (stableAbsentScans >= 2) return { state: "observed", mechanism: "windows-process-handle", pid, verifiedAt: Date.now() };
				const waitMs = deadline - Date.now();
				if (waitMs <= 0) return unknown(`Captured Windows process identities still active after exact termination: ${remaining.map(identityKey).join(", ")}.`);
				await new Promise<void>((resolve) => setTimeout(resolve, Math.min(VERIFY_INTERVAL_MS, waitMs)));
			}
		})();
		return termination;
	};
	return { terminate, finishAfterWriterClose: terminate };
}
