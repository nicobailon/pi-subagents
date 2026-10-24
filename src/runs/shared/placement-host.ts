import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { PlacementMachineReference } from "../../shared/types.ts";
import type { HerdrRunIdentity } from "./herdr-placed-run.ts";
import { getAgentDir } from "../../shared/utils.ts";

export type PlacementRunState = "ready" | "working" | "blocked" | "settled" | "unknown";
export type PlacementAgentKind = "pi" | "claude" | "cursor" | "codex";
export interface PlacementOwnedPane { workspaceId: string; tabId: string; paneId: string }
export interface PlacementBridgeIdentity { runId?: string; nativeSessionId?: string; packageVersion?: string; protocol?: number; evidenceCursor?: number; evidenceFloor?: number }
export type PlacementEvidenceProof = { ok: true; cursor: number } | { ok: false; reason: string };
export type PlacementReconnectCheck = { ok: true; state: PlacementRunState; paneId: string; cursor: number } | { ok: false; reason: string };
export interface PlacementStartOptions { timeoutMs?: number; pollMs?: number; clock?: { now(): number; wait(ms: number): Promise<void> } }
/** What to start in a new pane; the pane is created in the machine's cwd with this environment. */
export interface PlacementLaunchRequest { kind: PlacementAgentKind; name: string; args: string[]; environment?: Record<string, string> }
export interface PlacementCommandOptions { timeout?: number; maxBuffer?: number }
export interface PlacementCommandResult { status: number | null; stdout: string; stderr: string; error?: Error }
export interface PlacementSocketForward { socketPath: string; close(): Promise<void> }
/** Unix sockets on the pane machine made reachable from the parent; close() ends every forward opened through it. */
export interface PlacementSockets { forwardRemoteSocket(remotePath: string, name: string): Promise<PlacementSocketForward>; close(): Promise<void> }

/** Runs commands on, and reaches unix sockets on, the machine that hosts the pane: over SSH (`sshMachineAccess`) or directly (`localMachineAccess`). */
export interface PlacementMachineAccess {
	shellCommand(script: string, args?: string[]): string;
	run(command: string, options?: PlacementCommandOptions): PlacementCommandResult;
	runAsync(command: string, options?: PlacementCommandOptions): Promise<PlacementCommandResult>;
	openSockets(): PlacementSockets;
}

/** Every pane operation a placed native run and its owner need. The connection carries the host's socket forwarding; P is the host's reconnect view of its panes. */
export interface PlacementPaneHost<C extends PlacementSockets = PlacementSockets, P extends object = object> {
	connect(machine: PlacementMachineReference): Promise<C>;
	sessionOf(connection: C): string | null;
	/** Create the pane and start the agent in it; call onPane after the pane exists and before the agent starts. */
	launch(connection: C, machine: PlacementMachineReference, runId: string, runtimeDir: string, request: PlacementLaunchRequest, onPane: (owned: PlacementOwnedPane) => Promise<void>, options?: PlacementStartOptions): Promise<{ owned: PlacementOwnedPane; terminalId: string }>;
	prompt(connection: C, identity: HerdrRunIdentity, text: string): Promise<void>;
	subscribe(connection: C, paneId: string, listener: (event: unknown) => void, onDisconnect: (error: Error) => void): Promise<() => void>;
	paneEvent(event: unknown, fallback: PlacementRunState): { terminalId: unknown; paneId: unknown; state: PlacementRunState } | undefined;
	panes(connection: C, identity: HerdrRunIdentity): Promise<P>;
	reconcile(identity: HerdrRunIdentity, panes: P, proveEvidence: () => PlacementEvidenceProof): PlacementReconnectCheck;
	closeOwnedPane(connection: C, owned: PlacementOwnedPane, terminalId: string | undefined, agentName: string | undefined): Promise<void>;
}

const HERDR_ALLOCATION_LOCK_TIMEOUT_MS = 10_000, HERDR_ALLOCATION_LOCK_POLL_MS = 25;
export function herdrPaneAllocationKey(target: string, session: string | null, cwd: string): string { return JSON.stringify([target, session, cwd]); }
function assertPrivateDir(directory: string): void { const stat = fs.lstatSync(directory); if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700 || (typeof process.getuid === "function" && stat.uid !== process.getuid())) throw new Error("Herdr allocation path is not a mode-0700 agent-private owned directory."); }
function ensurePrivateChild(parent: string, name: string): string { const directory = path.join(parent, name); try { fs.mkdirSync(directory, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; } assertPrivateDir(directory); return directory; }
function allocationLockRoot(): string { const agentDir = getAgentDir(); fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 }); assertPrivateDir(agentDir); const packageDir = ensurePrivateChild(agentDir, "pi-subagents"); return ensurePrivateChild(packageDir, "herdr-allocation-locks"); }
function livePid(pid: number): boolean { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; } }
interface AllocationOwner { pid: number; token: string; dev: number; ino: number }
function readAllocationOwner(ownerPath: string): AllocationOwner { const descriptor = fs.openSync(ownerPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0)); try { const stat = fs.fstatSync(descriptor); if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || (typeof process.getuid === "function" && stat.uid !== process.getuid())) throw new Error("Herdr allocation lock owner record is unsafe."); const value = JSON.parse(fs.readFileSync(descriptor, "utf8")) as { pid?: unknown; token?: unknown }; if (typeof value.pid !== "number" || !Number.isSafeInteger(value.pid) || value.pid <= 0 || typeof value.token !== "string" || !/^[a-f0-9]{32}$/u.test(value.token)) throw new Error("Herdr allocation lock owner record is malformed."); return { pid: value.pid, token: value.token, dev: stat.dev, ino: stat.ino }; } finally { fs.closeSync(descriptor); } }
function sameOwner(left: AllocationOwner, right: AllocationOwner): boolean { return left.token === right.token && left.dev === right.dev && left.ino === right.ino; }
export async function withHerdrPaneAllocationLock<T>(key: string, action: () => Promise<T>, options: { timeoutMs?: number; pollMs?: number } = {}): Promise<T> {
	const root = allocationLockRoot(), digest = createHash("sha256").update(key).digest("hex"), lockPath = path.join(root, `${digest}.lock`), recoveryPath = path.join(root, `${digest}.recovery`), token = randomBytes(16).toString("hex"), tempPath = path.join(root, `.${digest}.${token}.tmp`), deadline = Date.now() + (options.timeoutMs ?? HERDR_ALLOCATION_LOCK_TIMEOUT_MS); let published: AllocationOwner | undefined;
	try {
		fs.writeFileSync(tempPath, JSON.stringify({ pid: process.pid, token, createdAt: Date.now() }), { mode: 0o600, flag: "wx" }); const tempOwner = readAllocationOwner(tempPath);
		for (;;) {
			let recovering = false; try { readAllocationOwner(recoveryPath); recovering = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
			if (!recovering) {
				let linked = false;
				try {
					fs.linkSync(tempPath, lockPath); linked = true;
					try { readAllocationOwner(recoveryPath); const current = readAllocationOwner(lockPath); if (!sameOwner(current, tempOwner)) throw new Error("Herdr allocation lock changed during publication."); fs.unlinkSync(lockPath); }
					catch (recoveryError) { if ((recoveryError as NodeJS.ErrnoException).code !== "ENOENT") throw recoveryError; published = readAllocationOwner(lockPath); if (!sameOwner(published, tempOwner)) throw new Error("Herdr allocation lock publication identity changed."); break; }
				} catch (publishError) { if (linked) { try { const current = readAllocationOwner(lockPath); if (sameOwner(current, tempOwner)) fs.unlinkSync(lockPath); } catch {} } if ((publishError as NodeJS.ErrnoException).code !== "EEXIST" && (publishError as NodeJS.ErrnoException).code !== "ENOENT") throw publishError; }
			}
			if (published) break;
			try { const current = readAllocationOwner(lockPath); if (!livePid(current.pid)) { let claimed = false; try { fs.linkSync(lockPath, recoveryPath); claimed = true; const recovery = readAllocationOwner(recoveryPath), latest = readAllocationOwner(lockPath); if (!sameOwner(recovery, current) || !sameOwner(latest, current)) throw new Error("Herdr stale lock identity changed during recovery."); fs.unlinkSync(lockPath); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST" && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } finally { if (claimed) fs.unlinkSync(recoveryPath); } if (claimed) continue; } } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
			if (Date.now() >= deadline) throw new Error("Timed out waiting for the Herdr pane allocation lock."); await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? HERDR_ALLOCATION_LOCK_POLL_MS));
		}
		fs.unlinkSync(tempPath);
		let value: T | undefined, actionError: unknown, releaseError: unknown, actionFailed = false, releaseFailed = false; try { value = await action(); } catch (error) { actionFailed = true; actionError = error; }
		try { const current = readAllocationOwner(lockPath); if (!published || !sameOwner(current, published)) throw new Error("Herdr pane allocation lock ownership changed before release."); fs.unlinkSync(lockPath); } catch (error) { releaseFailed = true; releaseError = error; }
		if (actionFailed && releaseFailed) throw new AggregateError([actionError, releaseError], "Herdr pane allocation action and release both failed.", { cause: actionError }); if (actionFailed) throw actionError; if (releaseFailed) throw releaseError; return value as T;
	} finally { try { fs.unlinkSync(tempPath); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
}
