import { createHash } from "node:crypto";
import * as path from "node:path";
import { Type, type StaticEncode, type TSchema } from "typebox";
import { Compile, type Validator } from "typebox/compile";
import type { PlacementMachineReference, RexMachineReference, RexSshMachineReference } from "../../shared/types.ts";
import { remoteShellCommand, sshMachineAccess } from "./herdr-connection.ts";
import type { HerdrRunIdentity } from "./herdr-placed-run.ts";
import { localMachineAccess } from "./local-machine-access.ts";
import { getPiSpawnCommand } from "./pi-spawn.ts";
import { createPlacedRuntimeDir, PLACED_MANIFEST_READ_SCRIPT, PlacedRunOwner, removePlacedRuntimeDir } from "./placed-run-owner.ts";
import { withHerdrPaneAllocationLock, type PlacementCommandResult, type PlacementEvidenceProof, type PlacementMachineAccess, type PlacementOwnedPane, type PlacementPaneHost, type PlacementReconnectCheck, type PlacementSockets } from "./placement-host.ts";
import { isRexLocalMachine, REX_BUNDLE_BIN, REX_CALL_TIMEOUT_MS, REX_EXIT_GONE, REX_EXIT_UNREACHABLE, REX_MAX_OUTPUT, resolveRexBinary, rexCommandEnv, rexGlobalArgs } from "./rex-machine.ts";

const REX_CLOSE_POLLS = 20, REX_CLOSE_POLL_MS = 50;
/** On a Rex SSH machine, placed tabs open in the one session with this label. */
export const REX_SSH_SESSION_LABEL = "subagents";
const sessionInspection = Compile(Type.Object({ session_id: Type.String() }));
const sessionList = Compile(Type.Object({ sessions: Type.Array(Type.Object({ session_id: Type.String(), label: Type.Optional(Type.String()) })) }));
const createdWindow = Compile(Type.Object({ window_id: Type.String(), block_ids: Type.Tuple([Type.String()]) }));
const sessionWindows = Compile(Type.Object({ windows: Type.Array(Type.Object({ window_id: Type.String(), label: Type.Optional(Type.String()), layers: Type.Array(Type.Object({ blocks: Type.Array(Type.Object({ block_id: Type.String() })) })) })) }));
const blockProcess = Compile(Type.Object({ foreground: Type.Object({ pid: Type.Integer() }) }));
const bridgeManifestPid = Compile(Type.Object({ pid: Type.Integer() }));

/** Rex runtime directories go under /tmp: the bridge socket path inside a macOS TMPDIR exceeds the unix socket path limit. */
function rexAccess(): PlacementMachineAccess { return localMachineAccess({ env: { ...rexCommandEnv(), TMPDIR: "/tmp" } }); }
/** The same /tmp rule on the remote, whatever TMPDIR its SSH session has. */
function rexSshAccess(machine: RexSshMachineReference, access: PlacementMachineAccess = sshMachineAccess(machine)): PlacementMachineAccess { return { ...access, shellCommand: (script, args) => remoteShellCommand(`TMPDIR=/tmp; export TMPDIR; ${script}`, args) }; }

interface RexEndpoint { access: PlacementMachineAccess; bin: string; session: string; server?: string }
export interface RexConnection extends RexEndpoint, PlacementSockets {}
export interface RexPaneCandidate { present: boolean; foregroundPid?: number; bridgePid?: number }

function asRexMachine(machine: PlacementMachineReference): RexMachineReference { if (machine.provider !== "rex") throw new Error("The Rex pane host only places runs on Rex machines."); return machine; }

/** Runs one rex command on the pane machine with --autostart=false, the recorded server, and no inherited Rex selectors; exit 4 always throws. */
async function runRex(endpoint: Pick<RexEndpoint, "access" | "bin" | "server">, args: string[], what: string): Promise<PlacementCommandResult & { status: number }> {
	const result = await endpoint.access.runAsync(endpoint.access.shellCommand('exec /usr/bin/env -u REX_SESSION -u REX_BLOCK -u REX_SERVER "$@"', [endpoint.bin, ...rexGlobalArgs(endpoint.server), ...args]), { timeout: REX_CALL_TIMEOUT_MS, maxBuffer: REX_MAX_OUTPUT });
	if (result.error) throw new Error(`Rex ${what} failed: ${result.error.message}`, { cause: result.error });
	if (result.status === REX_EXIT_UNREACHABLE) throw new Error(`The Rex server is unreachable (rex ${what} exited 4); the placed pane's state is unknown.`);
	if (result.status === null) throw new Error(`Rex ${what} did not finish; the placed pane's state is unknown.`);
	return { ...result, status: result.status };
}

function requireRexSuccess(result: PlacementCommandResult, what: string): void {
	if (result.status === REX_EXIT_GONE) throw new Error(`Rex ${what} failed because its target no longer exists (exit 3): ${result.stderr.trim().slice(0, 512)}`);
	if (result.status !== 0) throw new Error(`Rex ${what} exited with code ${result.status}: ${result.stderr.trim().slice(0, 512)}`);
}

/** Parses rex's JSON output against its schema; undefined when the shape does not match. */
function parseRexJson<T extends TSchema>(text: string, validator: Validator<{}, T>, what: string): StaticEncode<T, {}> | undefined {
	let value: unknown; try { value = JSON.parse(text); } catch { throw new Error(`Rex ${what} returned malformed JSON.`); }
	return validator.Check(value) ? value : undefined;
}

/** One remote lookup, matching resolveRexBinary: `$REX_BIN_DIR/rex`, then `rex` on PATH, then the Rex server bundle under the remote home. */
async function resolveRemoteRexBinary(access: PlacementMachineAccess, machine: RexSshMachineReference): Promise<string> {
	const script = `for c in "\${REX_BIN_DIR:+$REX_BIN_DIR/rex}" "$(command -v rex 2>/dev/null)" "$HOME/${REX_BUNDLE_BIN}"; do if [ -n "$c" ] && [ -f "$c" ] && [ -x "$c" ]; then printf '%s\\n' "$c"; exit 0; fi; done; exit 1`;
	const found = await access.runAsync(access.shellCommand(script), { timeout: REX_CALL_TIMEOUT_MS, maxBuffer: 64 * 1024 });
	if (found.error) throw new Error(`Could not look for the Rex CLI on ${machine.id}: ${found.error.message}`, { cause: found.error });
	const bin = found.stdout.trim();
	if (found.status !== 0 || !path.posix.isAbsolute(bin) || bin.includes("\n")) throw new Error(`The Rex CLI was not found on ${machine.id}. Install Rex there or put rex on its PATH.`);
	return bin;
}

/** The pane's cwd as the remote Pi will report it: `~` expanded and symlinks resolved. Rex does not expand `~` itself. */
async function resolveRemoteCwd(access: PlacementMachineAccess, machine: RexSshMachineReference): Promise<string> {
	const script = `case "$1" in "~") d=$HOME;; "~/"*) d=$HOME/\${1#"~/"};; *) d=$1;; esac; cd -P -- "$d" 2>/dev/null && pwd -P`;
	const resolved = await access.runAsync(access.shellCommand(script, [machine.cwd]), { timeout: REX_CALL_TIMEOUT_MS, maxBuffer: 64 * 1024 });
	if (resolved.error) throw new Error(`Could not check ${machine.cwd} on ${machine.id}: ${resolved.error.message}`, { cause: resolved.error });
	const cwd = resolved.stdout.trim();
	if (resolved.status !== 0 || !path.posix.isAbsolute(cwd) || cwd.includes("\n")) throw new Error(`Nothing at ${machine.cwd} on ${machine.id}. Clone the repo there first; pi-subagents never clones, pulls, or checks out on a machine.`);
	return cwd;
}

/** The remote Pi as a Rex tab's login environment finds it. */
async function resolveRemotePi(access: PlacementMachineAccess, machine: RexSshMachineReference): Promise<string> {
	const found = await access.runAsync(access.shellCommand(`exec "\${SHELL:-/bin/sh}" -lc 'command -v pi'`), { timeout: REX_CALL_TIMEOUT_MS, maxBuffer: 64 * 1024 });
	if (found.error) throw new Error(`Could not look for Pi on ${machine.id}: ${found.error.message}`, { cause: found.error });
	const pi = found.stdout.trim().split("\n").at(-1)?.trim() ?? "";
	if (found.status !== 0 || !path.posix.isAbsolute(pi)) throw new Error(`Pi was not found on ${machine.id}: its login shell has no pi on PATH. Install Pi there.`);
	return pi;
}

async function labeledSessions(endpoint: Pick<RexEndpoint, "access" | "bin">): Promise<string[]> {
	const listed = await runRex(endpoint, ["ls", "--json"], "ls");
	requireRexSuccess(listed, "ls");
	const parsed = parseRexJson(listed.stdout, sessionList, "ls");
	if (!parsed) throw new Error("Rex ls did not list the server's sessions.");
	return parsed.sessions.filter((session) => session.label === REX_SSH_SESSION_LABEL).map((session) => session.session_id);
}

/**
 * The session labeled `subagents` on the SSH machine, created when there is none. Rex allows duplicate labels, so two or
 * more fail closed, also after creating one. Only launch calls this; reconnect and cleanup use the recorded session id.
 */
async function subagentsSession(endpoint: Pick<RexEndpoint, "access" | "bin">, machine: RexSshMachineReference): Promise<string> {
	return withHerdrPaneAllocationLock(JSON.stringify(["rex-session", machine.target, REX_SSH_SESSION_LABEL]), async () => {
		let sessions = await labeledSessions(endpoint);
		if (sessions.length === 0) {
			requireRexSuccess(await runRex(endpoint, ["new", REX_SSH_SESSION_LABEL, "--json"], "new"), "new");
			sessions = await labeledSessions(endpoint);
		}
		const [session] = sessions;
		if (sessions.length > 1) throw new Error(`Rex on ${machine.id} has ${sessions.length} sessions labeled ${REX_SSH_SESSION_LABEL}; close or rename the extras so placed runs have one session to open in.`);
		if (!session) throw new Error(`Rex on ${machine.id} did not list the ${REX_SSH_SESSION_LABEL} session it just created.`);
		return session;
	});
}

/** The server must confirm the recorded session; a missing session fails closed. A Rex SSH machine's session is the one recorded at launch. */
export async function connectRex(machine: PlacementMachineReference, options: { bin?: string; access?: PlacementMachineAccess; session?: string } = {}): Promise<RexConnection> {
	const rex = asRexMachine(machine);
	let endpoint: RexEndpoint;
	if (isRexLocalMachine(rex)) {
		endpoint = { access: options.access ?? rexAccess(), bin: options.bin ?? resolveRexBinary(), session: rex.session };
		if (rex.server) endpoint.server = rex.server;
	} else {
		if (!options.session) throw new Error(`Rex machine '${rex.id}' has no recorded session; a placed run never picks one by label after launch.`);
		const access = options.access ?? rexSshAccess(rex);
		endpoint = { access, bin: options.bin ?? await resolveRemoteRexBinary(access, rex), session: options.session };
	}
	const inspected = await runRex(endpoint, ["session", "inspect", endpoint.session, "--json"], "session inspect");
	if (inspected.status === REX_EXIT_GONE) throw new Error(`Rex session ${endpoint.session} no longer exists on the Rex server.`);
	requireRexSuccess(inspected, "session inspect");
	if (parseRexJson(inspected.stdout, sessionInspection, "session inspect")?.session_id !== endpoint.session) throw new Error("Rex session identity changed: the server reported a different session id.");
	return { ...endpoint, ...endpoint.access.openSockets() };
}

async function inspectBlock(connection: RexConnection, blockId: string): Promise<"present" | "gone"> {
	const inspected = await runRex(connection, ["block", "inspect", "-s", connection.session, blockId], "block inspect");
	if (inspected.status === REX_EXIT_GONE) return "gone";
	requireRexSuccess(inspected, "block inspect");
	return "present";
}

/** Ownership is the never-reused block id in the recorded session. The block counts as closed only once `block inspect` exits 3. */
export async function closeOwnedRexPane(connection: RexConnection, owned: PlacementOwnedPane): Promise<void> {
	if (owned.workspaceId !== connection.session) throw new Error("Refusing Rex cleanup: the owned pane belongs to a different Rex session.");
	if (await inspectBlock(connection, owned.paneId) === "gone") return;
	const closed = await runRex(connection, ["block", "close", "-s", connection.session, owned.paneId], "block close");
	if (closed.status !== REX_EXIT_GONE) requireRexSuccess(closed, "block close");
	for (let poll = 0; poll < REX_CLOSE_POLLS; poll++) {
		if (await inspectBlock(connection, owned.paneId) === "gone") return;
		await new Promise((resolve) => setTimeout(resolve, REX_CLOSE_POLL_MS));
	}
	throw new Error(`Rex block ${owned.paneId} still exists after close; refusing to report the placed pane closed.`);
}

function reconcileRexPlacedRun(identity: HerdrRunIdentity, candidate: RexPaneCandidate, proveEvidence: () => PlacementEvidenceProof): PlacementReconnectCheck {
	if (!candidate.present) return { ok: false, reason: "Owned Rex block is gone." };
	if (candidate.foregroundPid === undefined || candidate.foregroundPid !== candidate.bridgePid) return { ok: false, reason: "The owned Rex block's foreground process is not the placed Pi." };
	const proof = proveEvidence(); if (!proof.ok) return proof;
	return { ok: true, state: "unknown", paneId: identity.paneId, cursor: proof.cursor };
}

async function readBridgePid(connection: RexConnection, runtimeDir: string): Promise<number | undefined> {
	const manifest = await connection.access.runAsync(connection.access.shellCommand(PLACED_MANIFEST_READ_SCRIPT, [runtimeDir]), { timeout: 5_000, maxBuffer: 64 * 1024 });
	if (manifest.status !== 0) return undefined;
	return parseRexJson(manifest.stdout, bridgeManifestPid, "bridge manifest")?.pid;
}

/**
 * `window new` failed, timed out, or printed something unreadable, so the server may still have opened this run's window.
 * Find it by the run's tab label in the recorded session and close its blocks with the same close-then-prove-gone rule.
 */
async function closeUntrackedRexWindow(connection: RexConnection, label: string, failure: Error): Promise<never> {
	try {
		const inspected = await runRex(connection, ["session", "inspect", connection.session, "--json"], "session inspect");
		if (inspected.status === REX_EXIT_GONE) throw failure;
		requireRexSuccess(inspected, "session inspect");
		const windows = parseRexJson(inspected.stdout, sessionWindows, "session inspect")?.windows.filter((window) => window.label === label);
		if (!windows) throw new Error("Rex session inspect did not list the session's windows.");
		if (windows.length > 1) throw new Error(`The Rex session has ${windows.length} windows labeled ${label}; refusing to guess which one this run opened.`);
		for (const window of windows) for (const layer of window.layers) for (const block of layer.blocks) await closeOwnedRexPane(connection, { workspaceId: connection.session, tabId: window.window_id, paneId: block.block_id });
	} catch (cleanupError) {
		if (cleanupError === failure) throw failure;
		throw new AggregateError([failure, cleanupError], `Rex window new failed, and the window labeled ${label} that it may have opened could not be closed.`, { cause: failure });
	}
	throw failure;
}

/** Opens the run's background window; on any failure, closes the window the server may have opened before rethrowing. */
async function openRexWindow(connection: RexConnection, label: string, cwd: string, argv: string[]) {
	try {
		const created = await runRex(connection, ["window", "new", "-s", connection.session, label, "-c", cwd, "--focus=false", "--json", "--", ...argv], "window new");
		requireRexSuccess(created, "window new");
		const window = parseRexJson(created.stdout, createdWindow, "window new");
		if (!window) throw new Error(`Rex window new did not return exactly one block: ${created.stdout.trim().slice(0, 512)}`);
		return window;
	} catch (error) { return closeUntrackedRexWindow(connection, label, error instanceof Error ? error : new Error(String(error))); }
}

/**
 * Rex pane host: rex CLI calls on this machine, always with an explicit session. A local child opens as a background
 * window in the parent's session; a Rex SSH child in the remote `subagents` session, with every rex call run over SSH.
 * Pi starts through the login shell's environment (as Rex starts any window) with the bridge variables set by
 * /usr/bin/env. There is no status subscription: a dead Pi closes the bridge socket (directly, or through the SSH
 * forward), and the reconnect that follows checks the block with `rex block call process` and fails closed.
 */
export const rexPaneHost = {
	connect: connectRex,
	sessionOf(connection) { return connection.session; },
	async launch(connection, machine, runId, _runtimeDir, request, onPane) {
		if (request.kind !== "pi") throw new Error("Rex supports native Pi children only.");
		const environment = Object.entries(request.environment ?? {});
		if (environment.some(([name]) => !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name))) throw new Error("Rex launch environment names must be shell variable names.");
		const rex = asRexMachine(machine);
		let pi: { command: string; args: string[] };
		if (isRexLocalMachine(rex)) {
			pi = getPiSpawnCommand(request.args);
			if (!path.isAbsolute(pi.command)) throw new Error("Rex placement needs an absolute Pi executable; set PI_SUBAGENT_PI_BINARY to the Pi binary path.");
		} else pi = { command: await resolveRemotePi(connection.access, rex), args: request.args };
		const window = await openRexWindow(connection, `subagent-${runId.slice(-8)}`, rex.cwd, ["/usr/bin/env", ...environment.map(([name, value]) => `${name}=${value}`), pi.command, ...pi.args]);
		const owned = { workspaceId: connection.session, tabId: window.window_id, paneId: window.block_ids[0] };
		await onPane(owned);
		return { owned, terminalId: owned.paneId };
	},
	async prompt(connection, identity, text) {
		requireRexSuccess(await runRex(connection, ["send", "-s", connection.session, "-b", identity.paneId, "--", text], "send"), "send");
		requireRexSuccess(await runRex(connection, ["send-key", "-s", connection.session, "-b", identity.paneId, "enter"], "send-key"), "send-key");
	},
	async subscribe() { return () => {}; },
	paneEvent() { return undefined; },
	async panes(connection, identity) {
		const processInfo = await runRex(connection, ["block", "call", "-s", connection.session, "-b", identity.paneId, "process"], "block process");
		if (processInfo.status === REX_EXIT_GONE) return { present: false };
		requireRexSuccess(processInfo, "block process");
		const candidate: RexPaneCandidate = { present: true };
		const foregroundPid = parseRexJson(processInfo.stdout, blockProcess, "block process")?.foreground.pid;
		if (foregroundPid !== undefined) candidate.foregroundPid = foregroundPid;
		const bridgePid = await readBridgePid(connection, identity.runtimeDir);
		if (bridgePid !== undefined) candidate.bridgePid = bridgePid;
		return candidate;
	},
	reconcile: reconcileRexPlacedRun,
	closeOwnedPane: closeOwnedRexPane,
} satisfies PlacementPaneHost<RexConnection, RexPaneCandidate>;

function runtimeDirPresent(access: PlacementMachineAccess, runtimeDir: string): boolean {
	const result = access.run(access.shellCommand('test -e "$1" || test -L "$1"', [runtimeDir]), { timeout: 10_000, maxBuffer: 4096 });
	if (result.error) throw new Error(`Could not check the owned runtime directory: ${result.error.message}`, { cause: result.error });
	return result.status === 0;
}

/** A closed local Pi removes its own runtime directory on shutdown, so already-removed counts as removed. */
function removeRexRuntimeDir(access: PlacementMachineAccess, runtimeDir: string): void {
	if (!runtimeDirPresent(access, runtimeDir)) return;
	try { removePlacedRuntimeDir(access, runtimeDir); } catch (error) { if (runtimeDirPresent(access, runtimeDir)) throw error; }
}

/** The placed-run owner bound to Rex and the pane machine's access. */
export class RexPlacedRunOwner extends PlacedRunOwner<RexConnection, RexMachineReference> {
	private constructor(machine: RexMachineReference, runId: string, runtimeDir: string, connection: RexConnection, access: PlacementMachineAccess, host: PlacementPaneHost<RexConnection, RexPaneCandidate>) { super(machine, runId, runtimeDir, connection, host, access, () => removeRexRuntimeDir(access, runtimeDir)); }
	/** A Rex SSH owner's machine carries the resolved remote cwd, and its host reconnects only to the session recorded here. */
	static async create(machine: RexMachineReference, runId: string, options: { sshAccess?: PlacementMachineAccess } = {}): Promise<RexPlacedRunOwner> {
		// A short hash names the directory, so /tmp/pi-subagents-herdr-<hash>-XXXXXXXX/bridge.sock (57 bytes) fits the 103-byte macOS socket path limit for any run id.
		const hash = createHash("sha256").update(runId).digest("hex").slice(0, 12);
		if (isRexLocalMachine(machine)) {
			const access = rexAccess(), runtimeDir = await createPlacedRuntimeDir(access, hash);
			try { return new RexPlacedRunOwner(machine, runId, runtimeDir, await connectRex(machine, { access }), access, rexPaneHost); }
			catch (error) { try { removeRexRuntimeDir(access, runtimeDir); } catch (cleanupError) { throw new AggregateError([error, cleanupError], "Rex owner creation failed and runtime cleanup also failed.", { cause: error }); } throw error; }
		}
		const access = rexSshAccess(machine, options.sshAccess), bin = await resolveRemoteRexBinary(access, machine);
		const placed: RexSshMachineReference = { ...machine, cwd: await resolveRemoteCwd(access, machine) };
		const session = await subagentsSession({ access, bin }, placed);
		const host = { ...rexPaneHost, connect: (target: PlacementMachineReference) => connectRex(target, { access, bin, session }) } satisfies PlacementPaneHost<RexConnection, RexPaneCandidate>;
		const runtimeDir = await createPlacedRuntimeDir(access, hash);
		try { return new RexPlacedRunOwner(placed, runId, runtimeDir, await host.connect(placed), access, host); }
		catch (error) { try { removeRexRuntimeDir(access, runtimeDir); } catch (cleanupError) { throw new AggregateError([error, cleanupError], "Rex owner creation failed and runtime cleanup also failed.", { cause: error }); } throw error; }
	}
}
