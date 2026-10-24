import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { PlacementMachineReference, RexLocalMachineReference } from "../../shared/types.ts";

/** `machine: "local"` is reserved: this machine, in a Rex pane of the parent's own Rex session. It never consults the Herdr catalog. */
export const REX_LOCAL_MACHINE = "local";
/** Rex CLI exit codes: 3 means the target is gone, 4 means the server is unreachable (state unknown, never "gone"). */
export const REX_EXIT_GONE = 3, REX_EXIT_UNREACHABLE = 4;

/** A `local` child edits this machine's disk; every other placed child edits the remote one. */
export function isRexLocalMachine(machine: PlacementMachineReference | undefined): machine is RexLocalMachineReference { return machine?.provider === "rex" && !("target" in machine); }
/** The Rex server bundle's CLI, relative to the home directory. */
export const REX_BUNDLE_BIN = "Library/Application Support/com.superlogical.rex/RexServer/Versions/Current/Rex Server.app/Contents/MacOS/rex";
export const REX_CALL_TIMEOUT_MS = 15_000, REX_MAX_OUTPUT = 1024 * 1024;

/** Global rex flags: never start a server, and use the recorded one when there is one. */
export function rexGlobalArgs(server: string | undefined): string[] { return server ? ["--autostart=false", "-S", server] : ["--autostart=false"]; }

function executable(file: string): boolean { try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile(); } catch { return false; } }

/** `$REX_BIN_DIR/rex`, then `rex` on PATH, then the Rex server bundle. */
export function resolveRexBinary(env: NodeJS.ProcessEnv = process.env): string {
	const fromDir = env.REX_BIN_DIR ? [path.join(env.REX_BIN_DIR, "rex")] : [];
	const fromPath = (env.PATH ?? "").split(path.delimiter).filter((dir) => path.isAbsolute(dir)).map((dir) => path.join(dir, "rex"));
	const found = [...fromDir, ...fromPath, path.join(os.homedir(), REX_BUNDLE_BIN)].find(executable);
	if (!found) throw new Error("The Rex CLI was not found: set REX_BIN_DIR, put rex on PATH, or install Rex.");
	return found;
}

/** Every Rex selector comes from the recorded machine reference, never from the calling process's own Rex pane variables. */
export function rexCommandEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const { REX_SESSION: _session, REX_BLOCK: _block, REX_SERVER: _server, ...env } = source;
	return env;
}

function sessionConfirmed(stdout: string, session: string): boolean {
	try { const parsed: { session_id?: string } | null = JSON.parse(stdout); return parsed?.session_id === session; } catch { return false; }
}

/**
 * Resolves `machine: "local"` in the parent: records its Rex session (confirmed by the server) and server address, and the real
 * launch directory. `stepCwd` is absolute, `~`, or relative to the parent's launch directory `cwd`.
 */
export function resolveRexLocalPlacement(input: { cwd: string; stepCwd?: string; env?: NodeJS.ProcessEnv }): RexLocalMachineReference {
	if (process.platform === "win32") throw new Error("Machine 'local' runs the child in a Rex pane, which is not supported on Windows.");
	const env = input.env ?? process.env, session = env.REX_SESSION?.trim(), server = env.REX_SERVER?.trim();
	if (!session) throw new Error("Machine 'local' opens the child in a new tab of this Rex session, but this Pi is not running inside Rex (REX_SESSION is not set).");
	const result = spawnSync(resolveRexBinary(env), [...rexGlobalArgs(server), "session", "inspect", session, "--json"], { encoding: "utf8", env: rexCommandEnv(env), timeout: REX_CALL_TIMEOUT_MS, maxBuffer: REX_MAX_OUTPUT, windowsHide: true });
	if (result.error) throw new Error(`Could not ask Rex about this session: ${result.error.message}`, { cause: result.error });
	if (result.status === REX_EXIT_GONE) throw new Error(`Machine 'local' needs this Pi's Rex session, but the Rex server does not know session ${session}.`);
	if (result.status === REX_EXIT_UNREACHABLE) throw new Error("Machine 'local' needs the Rex server, but it is unreachable.");
	if (result.status !== 0) throw new Error(`rex session inspect exited with code ${result.status}: ${(result.stderr || result.stdout).trim().slice(0, 512)}`);
	if (!sessionConfirmed(result.stdout, session)) throw new Error(`The Rex server did not confirm session ${session}.`);
	const stepCwd = input.stepCwd?.trim();
	const home = stepCwd === "~" || stepCwd?.startsWith("~/") ? path.join(os.homedir(), stepCwd.slice(1)) : undefined;
	const requested = home ?? (stepCwd ? path.resolve(input.cwd, stepCwd) : input.cwd);
	let cwd: string;
	try { cwd = fs.realpathSync(requested); } catch (error) { throw new Error(`Machine 'local' cwd does not exist: ${requested}.`, { cause: error }); }
	if (!fs.statSync(cwd).isDirectory()) throw new Error(`Machine 'local' cwd is not a directory: ${requested}.`);
	const machine: RexLocalMachineReference = { provider: "rex", id: REX_LOCAL_MACHINE, session, cwd };
	if (server) machine.server = server;
	return machine;
}
