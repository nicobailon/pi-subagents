import { createHash } from "node:crypto";
import * as path from "node:path";
import {
	PLACED_MANIFEST_READ_SCRIPT,
	PlacedRunOwner,
	createPlacedRuntimeDir,
	getPiSpawnCommand,
	localMachineAccess,
	remoteShellCommand,
	removePlacedRuntimeDir,
	sshMachineAccess,
	withHerdrPaneAllocationLock,
	type HerdrRunIdentity,
	type PlacementCommandResult,
	type PlacementEvidenceProof,
	type PlacementMachineAccess,
	type PlacementMachineReference,
	type PlacementOwnedPane,
	type PlacementPaneHost,
	type PlacementReconnectCheck,
	type PlacementSockets,
} from "../../../src/api/placement.ts";
import { isTmuxLocalMachine, TMUX_PROVIDER, TMUX_SESSION_LABEL, type TmuxMachineReference, type TmuxSshMachineReference } from "./tmux-machine.ts";

const TMUX_CALL_TIMEOUT_MS = 15_000, TMUX_MAX_OUTPUT = 256 * 1024;
const TMUX_CLOSE_POLLS = 20, TMUX_CLOSE_POLL_MS = 50;

/** The pane user option that pairs a placed pane with its run id and tmux server: pane ids (%N) are reused only after a server restart, which the recorded server pid inside the marker catches. */
const TMUX_OWNER_OPTION = "@pi-subagents-owner";
const TMUX_PANE_FORMAT = `#{pane_id}|#{pane_pid}|#{server_pid}|#{${TMUX_OWNER_OPTION}}`;

interface TmuxRecord { paneId: string; panePid: number; serverPid: string; ownerMarker: string }

interface TmuxEndpoint { access: PlacementMachineAccess; bin: string; socket?: string; session: string }
export interface TmuxConnection extends TmuxEndpoint, PlacementSockets {
	/** The run id whose panes this connection may close; stamped by the owner that created the connection. Falsy means cleanup refuses. */
	ownerRunId?: string;
}
export interface TmuxPaneCandidate { present: boolean; panePid?: number; serverPid?: string; ownerMarker?: string; bridgePid?: number }

function asTmuxMachine(machine: PlacementMachineReference | TmuxMachineReference): TmuxMachineReference { if ((machine as { provider?: string }).provider !== TMUX_PROVIDER) throw new Error("The tmux pane host only places runs on tmux machines."); return machine as unknown as TmuxMachineReference; }

/** Local tmux calls run with the parent's environment except TMPDIR: the bridge runtime lives under /tmp so the socket path fits the unix socket limit. */
function tmuxAccess(): PlacementMachineAccess { return localMachineAccess({ env: { ...process.env, TMPDIR: "/tmp" } }); }
/** The same /tmp rule on the remote, whatever TMPDIR its SSH session has. */
function tmuxSshAccess(machine: TmuxSshMachineReference, access: PlacementMachineAccess = sshMachineAccess(machine)): PlacementMachineAccess { return { ...access, shellCommand: (script, args) => remoteShellCommand(`TMPDIR=/tmp; export TMPDIR; ${script}`, args) }; }

/** One tmux call on the pane machine, always naming the recorded session; TMUX/TMUX_PANE are scrubbed so a parent living inside tmux cannot leak its own server into the calls. */
async function runTmux(endpoint: Pick<TmuxEndpoint, "access" | "bin" | "socket">, args: string[], what: string): Promise<PlacementCommandResult & { status: number }> {
	const socketArgs = endpoint.socket ? ["-S", endpoint.socket] : [];
	const result = await endpoint.access.runAsync(endpoint.access.shellCommand('exec /usr/bin/env -u TMUX -u TMUX_PANE "$@"', [endpoint.bin, ...socketArgs, ...args]), { timeout: TMUX_CALL_TIMEOUT_MS, maxBuffer: TMUX_MAX_OUTPUT });
	if (result.error) throw new Error(`tmux ${what} failed: ${result.error.message}`, { cause: result.error });
	if (result.status === null) throw new Error(`tmux ${what} did not finish; the placed pane's state is unknown.`);
	return { ...result, status: result.status };
}

function requireTmuxSuccess(result: PlacementCommandResult, what: string): void {
	if (result.status !== 0) throw new Error(`tmux ${what} exited with code ${result.status}: ${result.stderr.trim().slice(0, 512)}`);
}

/** tmux reports a missing target as exit 1 with "can't find pane/window/session". */
function tmuxGone(result: { status: number; stderr: string }): boolean { return result.status === 1 && /can't find (pane|window|session)/iu.test(result.stderr); }

function parseTmuxRecord(text: string, what: string): TmuxRecord {
	const parts = text.trim().split("|");
	const [paneId, panePid, serverPid, ownerMarker] = parts;
	if (!/^%\d+$/u.test(paneId ?? "") || !/^\d+$/u.test(panePid ?? "") || !/^\d+$/u.test(serverPid ?? "")) throw new Error(`tmux ${what} returned an unreadable pane record: ${text.trim().slice(0, 256)}`);
	return { paneId: paneId!, panePid: Number(panePid), serverPid: serverPid!, ownerMarker: ownerMarker ?? "" };
}

async function readPaneRecord(endpoint: TmuxEndpoint, paneId: string, what: string): Promise<TmuxRecord> {
	const shown = await runTmux(endpoint, ["display", "-p", "-t", paneId, "-F", TMUX_PANE_FORMAT], `display (${what})`);
	if (tmuxGone(shown)) throw new Error(`tmux ${what}: pane ${paneId} disappeared.`);
	requireTmuxSuccess(shown, `display (${what})`);
	const record = parseTmuxRecord(shown.stdout, what);
	if (record.paneId !== paneId) throw new Error(`tmux ${what} reported pane ${record.paneId} instead of ${paneId}.`);
	return record;
}

async function panePresent(connection: TmuxConnection, paneId: string): Promise<boolean> {
	const shown = await runTmux(connection, ["display", "-p", "-t", paneId, "-F", TMUX_PANE_FORMAT], "display");
	if (tmuxGone(shown)) return false;
	requireTmuxSuccess(shown, "display");
	return true;
}

async function readBridgePid(connection: TmuxConnection, runtimeDir: string): Promise<number | undefined> {
	const manifest = await connection.access.runAsync(connection.access.shellCommand(PLACED_MANIFEST_READ_SCRIPT, [runtimeDir]), { timeout: 5_000, maxBuffer: 64 * 1024 });
	if (manifest.status !== 0) return undefined;
	try { const parsed = JSON.parse(manifest.stdout) as { pid?: unknown }; return typeof parsed.pid === "number" ? parsed.pid : undefined; } catch { return undefined; }
}

/** The remote Pi as a tmux window's shell finds it: the login shell's PATH. */
async function resolveRemotePi(access: PlacementMachineAccess, machine: TmuxSshMachineReference): Promise<string> {
	const found = await access.runAsync(access.shellCommand(`exec "\${SHELL:-/bin/sh}" -lc 'command -v pi'`), { timeout: TMUX_CALL_TIMEOUT_MS, maxBuffer: 64 * 1024 });
	if (found.error) throw new Error(`Could not look for Pi on ${machine.id}: ${found.error.message}`, { cause: found.error });
	const pi = found.stdout.trim().split("\n").at(-1)?.trim() ?? "";
	if (found.status !== 0 || !path.posix.isAbsolute(pi)) throw new Error(`Pi was not found on ${machine.id}: its login shell has no pi on PATH. Install Pi there.`);
	return pi;
}

async function resolveTmuxBinary(access: PlacementMachineAccess, machine: TmuxSshMachineReference): Promise<string> {
	const found = await access.runAsync(access.shellCommand("command -v tmux"), { timeout: TMUX_CALL_TIMEOUT_MS, maxBuffer: 64 * 1024 });
	if (found.error) throw new Error(`Could not look for tmux on ${machine.id}: ${found.error.message}`, { cause: found.error });
	const bin = found.stdout.trim();
	if (found.status !== 0 || !path.posix.isAbsolute(bin) || bin.includes("\n")) throw new Error(`tmux was not found on ${machine.id}. Install tmux there, or put tmux on its PATH.`);
	return bin;
}

/** The pane's cwd as the remote Pi will report it: `~` expanded and symlinks resolved. tmux does not expand `~` itself. */
async function resolveRemoteCwd(access: PlacementMachineAccess, machine: TmuxSshMachineReference): Promise<string> {
	const script = `case "$1" in "~") d=$HOME;; "~/"*) d=$HOME/\${1#"~/"};; *) d=$1;; esac; cd -P -- "$d" 2>/dev/null && pwd -P`;
	const resolved = await access.runAsync(access.shellCommand(script, [machine.cwd]), { timeout: TMUX_CALL_TIMEOUT_MS, maxBuffer: 64 * 1024 });
	if (resolved.error) throw new Error(`Could not check ${machine.cwd} on ${machine.id}: ${resolved.error.message}`, { cause: resolved.error });
	const cwd = resolved.stdout.trim();
	if (resolved.status !== 0 || !path.posix.isAbsolute(cwd) || cwd.includes("\n")) throw new Error(`Nothing at ${machine.cwd} on ${machine.id}. Clone the repo there first; pi-subagents never clones, pulls, or checks out on a machine.`);
	return cwd;
}

async function ensureTmuxSession(endpoint: TmuxEndpoint, machine: TmuxMachineReference): Promise<void> {
	// Session names are unique on a tmux server, so creation needs no duplicate-label arbitration — the lock only serializes concurrent first uses.
	return withHerdrPaneAllocationLock(JSON.stringify(["tmux-session", isTmuxLocalMachine(machine) ? machine.id : machine.target, machine.socket ?? "", TMUX_SESSION_LABEL]), async () => {
		const existing = await runTmux(endpoint, ["has-session", "-t", endpoint.session], "has-session");
		if (existing.status === 0) return;
		requireTmuxSuccess(await runTmux(endpoint, ["new-session", "-d", "-s", endpoint.session, "-n", "housekeeping", "-c", "$HOME"], "new-session"), "new-session");
	});
}

/** The server must confirm the recorded session; a missing session fails closed. A tmux machine's session is the one recorded at launch. */
export async function connectTmux(machine: PlacementMachineReference | TmuxMachineReference, options: { access?: PlacementMachineAccess; bin?: string; session?: string } = {}): Promise<TmuxConnection> {
	const tmux = asTmuxMachine(machine);
	let endpoint: TmuxEndpoint;
	if (isTmuxLocalMachine(tmux)) {
		const access = options.access ?? tmuxAccess();
		endpoint = { access, bin: options.bin ?? await resolveTmuxBinary(access, { ...tmux, id: "local machine", target: "local" }), session: options.session ?? tmux.session };
		if (tmux.socket) endpoint.socket = tmux.socket;
	} else {
		if (!options.session) throw new Error(`tmux machine '${tmux.id}' has no recorded session; a placed run never picks one by label after launch.`);
		const access = options.access ?? tmuxSshAccess(tmux);
		endpoint = { access, bin: options.bin ?? await resolveTmuxBinary(access, tmux), session: options.session };
		if (tmux.socket) endpoint.socket = tmux.socket;
	}
	await ensureTmuxSession(endpoint, tmux);
	return { ...endpoint, ...endpoint.access.openSockets() };
}

/**
 * `new-window` failed, timed out, or printed something unreadable, so the server may still have opened this run's window.
 * Find it by the run's window name in the recorded session and close it with the same kill-then-prove-gone rule.
 */
async function closeUntrackedTmuxWindow(connection: TmuxConnection, label: string, failure: Error): Promise<never> {
	try {
		const listed = await runTmux(connection, ["list-windows", "-t", connection.session, "-F", "#{window_id}|#{window_name}"], "list-windows");
		if (tmuxGone(listed)) throw failure;
		requireTmuxSuccess(listed, "list-windows");
		const windows = listed.stdout.trim().split("\n").filter(Boolean).map((line) => { const [windowId, name] = line.split("|"); return { windowId, name: name ?? "" }; }).filter((window) => window.name === label);
		if (windows.length > 1) throw new Error(`The tmux session has ${windows.length} windows named ${label}; refusing to guess which one this run opened.`);
		for (const window of windows) {
			const closed = await runTmux(connection, ["kill-window", "-t", window.windowId!], "kill-window");
			if (!tmuxGone(closed)) requireTmuxSuccess(closed, "kill-window");
		}
	} catch (cleanupError) {
		if (cleanupError === failure) throw failure;
		throw new AggregateError([failure, cleanupError], `tmux new-window failed, and the window named ${label} that it may have opened could not be closed.`, { cause: failure });
	}
	throw failure;
}

/** Ownership is the pane's never-reused-in-a-server-lifetime id, paired with the server pid recorded at launch in the pane's owner option. */
export async function closeOwnedTmuxPane(connection: TmuxConnection, owned: PlacementOwnedPane): Promise<void> {
	if (owned.workspaceId !== connection.session) throw new Error("Refusing tmux cleanup: the owned pane belongs to a different tmux session.");
	if (connection.ownerRunId === undefined) throw new Error("Refusing tmux cleanup: the connection carries no run id to prove pane ownership.");
	if (!(await panePresent(connection, owned.paneId))) return;
	const record = await readPaneRecord(connection, owned.paneId, "close");
	if (record.ownerMarker !== `${connection.ownerRunId}:${record.serverPid}`) throw new Error(`Refusing tmux cleanup: pane ${owned.paneId}'s ownership marker ${record.ownerMarker || "(unset)"} does not match run ${connection.ownerRunId} and server pid ${record.serverPid}; the pane may belong to another run or another tmux server lifetime.`);
	const killed = await runTmux(connection, ["kill-pane", "-t", owned.paneId], "kill-pane");
	if (!tmuxGone(killed)) requireTmuxSuccess(killed, "kill-pane");
	for (let poll = 0; poll < TMUX_CLOSE_POLLS; poll++) {
		if (!(await panePresent(connection, owned.paneId))) return;
		await new Promise((resolve) => setTimeout(resolve, TMUX_CLOSE_POLL_MS));
	}
	throw new Error(`tmux pane ${owned.paneId} still exists after kill; refusing to report the placed pane closed.`);
}

function reconcileTmuxPlacedRun(identity: HerdrRunIdentity, candidate: TmuxPaneCandidate, proveEvidence: () => PlacementEvidenceProof): PlacementReconnectCheck {
	if (!candidate.present) return { ok: false, reason: "Owned tmux pane is gone." };
	if (candidate.ownerMarker !== `${identity.runId}:${candidate.serverPid}`) return { ok: false, reason: "The owned tmux pane's ownership marker does not match this run and tmux server; the server may have restarted." };
	if (candidate.panePid === undefined || candidate.panePid !== candidate.bridgePid) return { ok: false, reason: "The owned tmux pane's process is not the placed Pi." };
	const proof = proveEvidence();
	if (!proof.ok) return proof;
	return { ok: true, state: "unknown", paneId: identity.paneId, cursor: proof.cursor };
}

/**
 * tmux pane host: tmux CLI calls, always against the recorded session. A local child opens as a window in the parent's
 * `pi-subagents` session; a tmux SSH child in the remote session of the same name, with every tmux call run over SSH.
 * Pi starts through `exec`, so the pane's process IS the placed Pi (the pane pid proves it at reconnect). There is no
 * status subscription: a dead Pi closes the bridge socket, and the reconnect that follows checks the pane record and
 * fails closed.
 */
export const tmuxPaneHost = {
	connect: connectTmux,
	sessionOf(connection) { return connection.session; },
	async launch(connection, machine, runId, _runtimeDir, request, onPane) {
		if (request.kind !== "pi") throw new Error("tmux supports native Pi children only.");
		const environment = Object.entries(request.environment ?? {});
		if (environment.some(([name]) => !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name))) throw new Error("tmux launch environment names must be shell variable names.");
		const tmux = asTmuxMachine(machine);
		let pi: { command: string; args: string[] };
		if (isTmuxLocalMachine(tmux)) {
			pi = getPiSpawnCommand(request.args);
			if (!path.isAbsolute(pi.command)) throw new Error("tmux placement needs an absolute Pi executable; set PI_SUBAGENT_PI_BINARY to the Pi binary path.");
		} else pi = { command: await resolveRemotePi(connection.access, tmux), args: request.args };
		const label = `subagent-${runId.slice(-8)}`;
		const paneId = await openTmuxWindow(connection, label, tmux.cwd, [...environment.map(([name, value]) => `${name}=${value}`), pi.command, ...pi.args]);
		const owned: PlacementOwnedPane = { workspaceId: connection.session, tabId: paneId, paneId };
		try {
			// Keep the window name stable for untracked-window cleanup, then stamp the run:server pid ownership marker.
			requireTmuxSuccess(await runTmux(connection, ["set-window-option", "-t", paneId, "automatic-rename", "off"], "set-window-option"), "set-window-option");
			const record = await readPaneRecord(connection, paneId, "launch");
			requireTmuxSuccess(await runTmux(connection, ["set-option", "-p", "-t", paneId, TMUX_OWNER_OPTION, `${runId}:${record.serverPid}`], "set-option"), "set-option");
		} catch (error) { return closeUntrackedTmuxWindow(connection, label, error instanceof Error ? error : new Error(String(error))); }
		await onPane(owned);
		return { owned, terminalId: owned.paneId };
	},
	async prompt(connection, identity, text) {
		requireTmuxSuccess(await runTmux(connection, ["send-keys", "-t", identity.paneId, "-l", "--", text], "send-keys"), "send-keys");
		requireTmuxSuccess(await runTmux(connection, ["send-keys", "-t", identity.paneId, "Enter"], "send-key"), "send-key");
	},
	async subscribe() { return () => {}; },
	paneEvent() { return undefined; },
	async panes(connection, identity) {
		const shown = await runTmux(connection, ["display", "-p", "-t", identity.paneId, "-F", TMUX_PANE_FORMAT], "display");
		if (tmuxGone(shown)) return { present: false };
		requireTmuxSuccess(shown, "display");
		const record = parseTmuxRecord(shown.stdout, "display");
		const candidate: TmuxPaneCandidate = { present: true, panePid: record.panePid, serverPid: record.serverPid, ownerMarker: record.ownerMarker };
		candidate.bridgePid = await readBridgePid(connection, identity.runtimeDir);
		return candidate;
	},
	reconcile: reconcileTmuxPlacedRun,
	closeOwnedPane: closeOwnedTmuxPane,
} satisfies PlacementPaneHost<TmuxConnection, TmuxPaneCandidate>;

/** Opens the run's window and returns its single pane id; on any failure, closes the window the server may have opened before rethrowing. */
async function openTmuxWindow(connection: TmuxConnection, label: string, cwd: string, argv: string[]): Promise<string> {
	try {
		const created = await runTmux(connection, ["new-window", "-d", "-t", `${connection.session}:`, "-n", label, "-c", cwd, "-P", "-F", "#{pane_id}", "sh", "-c", 'exec /usr/bin/env "$@"', "sh", ...argv], "new-window");
		requireTmuxSuccess(created, "new-window");
		const paneId = created.stdout.trim().split("\n").at(-1)?.trim() ?? "";
		if (!/^%\d+$/u.test(paneId)) throw new Error(`tmux new-window did not return a pane id: ${created.stdout.trim().slice(0, 512)}`);
		return paneId;
	} catch (error) { return closeUntrackedTmuxWindow(connection, label, error instanceof Error ? error : new Error(String(error))); }
}

export class TmuxPlacedRunOwner extends PlacedRunOwner<TmuxConnection, TmuxMachineReference> {
	private constructor(machine: TmuxMachineReference, runId: string, runtimeDir: string, connection: TmuxConnection, access: PlacementMachineAccess, host: PlacementPaneHost<TmuxConnection, TmuxPaneCandidate>, ownerRunId: string) { connection.ownerRunId = ownerRunId; super(machine, runId, runtimeDir, connection, host, access, () => removePlacedRuntimeDir(access, runtimeDir)); }
	/** A tmux SSH owner's machine carries the resolved remote cwd, and its host reconnects only to the session recorded here. */
	static async create(machine: TmuxMachineReference, runId: string, options: { access?: PlacementMachineAccess; sshAccess?: PlacementMachineAccess } = {}): Promise<TmuxPlacedRunOwner> {
		// A short hash names the directory, matching the core placed-runtime naming, so bridge socket paths stay short.
		const hash = createHash("sha256").update(runId).digest("hex").slice(0, 12);
		if (isTmuxLocalMachine(machine)) {
			const access = options.access ?? tmuxAccess();
			const runtimeDir = await createPlacedRuntimeDir(access, hash);
			try { return new TmuxPlacedRunOwner(machine, runId, runtimeDir, await connectTmux(machine, { access }), access, tmuxPaneHost, runId); }
			catch (error) { try { removePlacedRuntimeDir(access, runtimeDir); } catch (cleanupError) { throw new AggregateError([error, cleanupError], "tmux owner creation failed and runtime cleanup also failed.", { cause: error }); } throw error; }
		}
		const access = options.sshAccess ?? tmuxSshAccess(machine);
		const bin = await resolveTmuxBinary(access, machine);
		const placed: TmuxSshMachineReference = { ...machine, cwd: await resolveRemoteCwd(access, machine) };
		const session = TMUX_SESSION_LABEL;
		await ensureTmuxSession({ access, bin, session, socket: placed.socket }, placed);
		const host = { ...tmuxPaneHost, connect: (target: PlacementMachineReference | TmuxMachineReference) => connectTmux(target, { access, bin, session }) } satisfies PlacementPaneHost<TmuxConnection, TmuxPaneCandidate>;
		const runtimeDir = await createPlacedRuntimeDir(access, hash);
		try { return new TmuxPlacedRunOwner(placed, runId, runtimeDir, await host.connect(placed), access, host, runId); }
		catch (error) { try { removePlacedRuntimeDir(access, runtimeDir); } catch (cleanupError) { throw new AggregateError([error, cleanupError], "tmux owner creation failed and runtime cleanup also failed.", { cause: error }); } throw error; }
	}
}
