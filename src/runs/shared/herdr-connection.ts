import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import type { HerdrMachineReference } from "../../shared/types.ts";

const MAX_DISCOVERY_BYTES = 256 * 1024;
const MAX_RPC_BYTES = 4 * 1024 * 1024;
const SUBSCRIPTION_ACK_TIMEOUT_MS = 15_000;
export const HERDR_REMOTE_PATH = "$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
export const HERDR_SSH_BASE = ["-T", "-o", "BatchMode=yes", "-o", "NumberOfPasswordPrompts=0", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=10", "-o", "ConnectionAttempts=1", "-o", "ForwardAgent=no", "-o", "ExitOnForwardFailure=yes", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=4", "-o", "SendEnv=-*", "-o", "SetEnv=PI_SUBAGENTS_SSH_GUARD="] as const;
export function hardenedSshEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv { return { PATH: process.platform === "win32" ? source.PATH : "/usr/bin:/bin:/usr/sbin:/sbin", ...(source.SystemRoot ? { SystemRoot: source.SystemRoot } : {}), ...(source.WINDIR ? { WINDIR: source.WINDIR } : {}) }; }
export function herdrSshArgs(source: NodeJS.ProcessEnv = process.env): string[] { return [...HERDR_SSH_BASE, ...(source.SSH_AUTH_SOCK ? ["-o", `IdentityAgent=${source.SSH_AUTH_SOCK}`] : [])]; }

export interface HerdrEndpoint { socket: string; session: string | null; version: string; protocol: number; compatible: boolean; running: boolean }
export interface HerdrRpcClient {
	call<T>(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<T>;
	subscribe(subscriptions: unknown[], listener: (event: unknown) => void, onDisconnect?: (error: Error) => void): Promise<() => void>;
}
export class HerdrRpcError extends Error {
	readonly code?: string; readonly requestId: string;
	constructor(message: string, requestId: string, code?: string) { super(message); this.name = "HerdrRpcError"; this.requestId = requestId; this.code = code; }
}
export class HerdrTransportError extends Error { constructor(message: string, options?: ErrorOptions) { super(message, options); this.name = "HerdrTransportError"; } }
export interface HerdrForwardedConnection { endpoint: HerdrEndpoint; socketPath: string; client: HerdrRpcClient; forwardRemoteSocket(remotePath: string, name: string): Promise<{ socketPath: string; close(): Promise<void> }>; close(): Promise<void> }
export function decodeHerdrJsonLine(line: Buffer): unknown { try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line)) as unknown; } catch { throw new Error("Herdr emitted malformed JSON or UTF-8."); } }

export function shellQuoteRemote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }
export function remoteShellCommand(script: string, args: string[] = []): string { return `sh -c ${shellQuoteRemote(`PATH="${HERDR_REMOTE_PATH}"; export PATH; ${script}`)} sh${args.map((arg) => ` ${shellQuoteRemote(arg)}`).join("")}`; }
function canonicalHerdrSession(session: string | null | undefined): string | null { return session && session !== "default" ? session : null; }
function sshEnvCommand(session: string | undefined, command: string): string { const selected = canonicalHerdrSession(session), assignment = selected ? ` HERDR_SESSION=${shellQuoteRemote(selected)}` : ""; return `/usr/bin/env -u HERDR_SOCKET_PATH -u HERDR_SESSION${assignment} ${remoteShellCommand(command)}`; }

export function runHerdrRemoteCommand(machine: HerdrMachineReference, command: string, options: { sshBin?: string; env?: NodeJS.ProcessEnv; timeout?: number; maxBuffer?: number } = {}) { return spawnSync(options.sshBin ?? "ssh", [...herdrSshArgs(options.env), machine.target, command], { encoding: "utf8", env: hardenedSshEnv(options.env), timeout: options.timeout ?? 15_000, maxBuffer: options.maxBuffer ?? MAX_DISCOVERY_BYTES, windowsHide: true }); }

export function parseHerdrEndpoint(value: string, expectedSession?: string): HerdrEndpoint {
	let parsed: unknown;
	try { parsed = JSON.parse(value) as unknown; } catch { throw new Error("Remote Herdr endpoint discovery returned malformed JSON."); }
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Remote Herdr endpoint discovery returned no endpoint.");
	const p = parsed as Record<string, unknown>;
	if (typeof p.socket !== "string" || !path.posix.isAbsolute(p.socket) || typeof p.version !== "string" || typeof p.protocol !== "number") throw new Error("Remote Herdr endpoint discovery returned incomplete identity.");
	const session = canonicalHerdrSession(typeof p.session === "string" ? p.session : null), expected = canonicalHerdrSession(expectedSession);
	if (expected !== session) throw new Error(`Remote Herdr session identity mismatch: expected ${expected ?? "default"}, received ${session ?? "default"}.`);
	if (p.running !== true || p.compatible !== true || p.endpoint_compatible === false) throw new Error("The selected remote Herdr session is stopped or incompatible.");
	return { socket: p.socket, session, version: p.version, protocol: p.protocol, compatible: true, running: true };
}

export function discoverHerdrEndpoint(machine: HerdrMachineReference, options: { sshBin?: string; env?: NodeJS.ProcessEnv } = {}): HerdrEndpoint {
	const discovery = 'herdr_path=$(command -v herdr) || exit 127; case "$herdr_path" in /*/herdr) ;; *) exit 126;; esac; exec "$herdr_path" status server --json';
	const result = runHerdrRemoteCommand(machine, sshEnvCommand(machine.session, discovery), { ...options, timeout: 15_000, maxBuffer: MAX_DISCOVERY_BYTES });
	if (result.error) throw new Error(`Remote Herdr discovery failed: ${result.error.message}`);
	if (result.status !== 0) throw new Error(`Remote Herdr discovery failed with code ${result.status}: ${(result.stderr || result.stdout).trim()}`);
	return parseHerdrEndpoint(result.stdout, machine.session);
}

export class SocketRpcClient implements HerdrRpcClient {
	readonly #socketPath: string;
	readonly #subscriptionAckTimeoutMs: number;
	#next = 0;
	constructor(socketPath: string, subscriptionAckTimeoutMs = SUBSCRIPTION_ACK_TIMEOUT_MS) { this.#socketPath = socketPath; this.#subscriptionAckTimeoutMs = subscriptionAckTimeoutMs; }
	call<T>(method: string, params: Record<string, unknown> = {}, timeoutMs = 15_000): Promise<T> {
		return new Promise((resolve, reject) => {
			const socket = net.createConnection(this.#socketPath); let bytes = 0; let data = Buffer.alloc(0); let finished = false; const id = String(++this.#next);
			const timer = setTimeout(() => finish(new HerdrTransportError(`Herdr RPC '${method}' timed out.`)), timeoutMs); timer.unref?.();
			const finish = (error?: Error, value?: T) => { if (finished) return; finished = true; clearTimeout(timer); socket.destroy(); error ? reject(error) : resolve(value as T); };
			socket.on("connect", () => socket.write(`${JSON.stringify({ id, method, params })}\n`));
			socket.on("data", (chunk: Buffer) => {
				bytes += chunk.byteLength; if (bytes > MAX_RPC_BYTES) { finish(new Error("Herdr RPC response exceeded its byte bound.")); return; }
				data = Buffer.concat([data, chunk]); const newline = data.indexOf(10); if (newline < 0) return;
				let frame: unknown; try { frame = decodeHerdrJsonLine(data.subarray(0, newline)); } catch { finish(new Error("Herdr RPC returned malformed JSON or UTF-8.")); return; }
				const record = frame as { id?: unknown; result?: T; error?: { message?: unknown; code?: unknown } };
				if (record.id !== id) { finish(new Error("Herdr RPC response identity mismatch.")); return; }
				if (record.error) finish(new HerdrRpcError(String(record.error.message ?? "Herdr RPC failed."), id, typeof record.error.code === "string" ? record.error.code : undefined)); else finish(undefined, record.result);
			});
			socket.on("error", (error) => finish(new HerdrTransportError(error.message, { cause: error })));
			socket.on("close", () => finish(new HerdrTransportError(`Herdr RPC '${method}' ended before a response.`)));
		});
	}
	async subscribe(subscriptions: unknown[], listener: (event: unknown) => void, onDisconnect?: (error: Error) => void): Promise<() => void> {
		const socket = net.createConnection(this.#socketPath); const id = String(++this.#next); let buffer = Buffer.alloc(0), bytes = 0, acknowledged = false, intentional = false, notified = false, settled = false;
		let resolveAck!: () => void, rejectAck!: (error: Error) => void;
		const acknowledgement = new Promise<void>((resolve, reject) => { resolveAck = resolve; rejectAck = reject; });
		const failHandshake = (error: Error) => { if (settled) return; settled = true; clearTimeout(timer); socket.destroy(); rejectAck(error); };
		const disconnect = (error: Error) => { if (intentional || notified) return; notified = true; if (!acknowledged) failHandshake(error); else onDisconnect?.(error); };
		const timer = setTimeout(() => failHandshake(new Error("Herdr subscription acknowledgement timed out.")), this.#subscriptionAckTimeoutMs); timer.unref?.();
		socket.on("data", (chunk: Buffer) => { bytes += chunk.byteLength; if (bytes > (acknowledged ? MAX_RPC_BYTES * 32 : MAX_RPC_BYTES)) { disconnect(new Error("Herdr subscription exceeded its byte bound.")); socket.destroy(); return; } buffer = Buffer.concat([buffer, chunk]); for (;;) { const i = buffer.indexOf(10); if (i < 0) break; const line = buffer.subarray(0, i); buffer = buffer.subarray(i + 1); let value: unknown; try { value = decodeHerdrJsonLine(line); } catch { disconnect(new Error("Herdr subscription emitted malformed JSON or UTF-8.")); socket.destroy(); return; } const record = value as { id?: unknown; result?: { type?: unknown }; error?: { message?: unknown; code?: unknown } }; if (!acknowledged) { if (record.id === id) { if (record.error) { failHandshake(new HerdrRpcError(String(record.error.message ?? "Herdr subscription failed."), id, typeof record.error.code === "string" ? record.error.code : undefined)); return; } if (record.result?.type !== "subscription_started") { failHandshake(new Error("Herdr subscription returned an invalid acknowledgement.")); return; } acknowledged = true; settled = true; clearTimeout(timer); resolveAck(); continue; } if (record.id === "" && record.error && record.error.code === "invalid_request") { failHandshake(new HerdrRpcError(String(record.error.message ?? "Herdr subscription request was invalid."), "", "invalid_request")); return; } failHandshake(new Error("Herdr subscription emitted an event before acknowledgement.")); return; } if (record.error) { disconnect(new HerdrRpcError(String(record.error.message ?? "Herdr subscription failed."), typeof record.id === "string" ? record.id : "", typeof record.error.code === "string" ? record.error.code : undefined)); socket.destroy(); return; } listener(value); } });
		socket.on("error", (error) => disconnect(error));
		socket.on("close", () => disconnect(new Error("Herdr subscription connection was lost.")));
		socket.on("connect", () => socket.write(`${JSON.stringify({ id, method: "events.subscribe", params: { subscriptions } })}\n`));
		await acknowledgement;
		return () => { intentional = true; clearTimeout(timer); socket.destroy(); };
	}
}

async function waitForSocket(socketPath: string, child: ChildProcess): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (child.exitCode !== null) throw new Error(`SSH StreamLocal forwarding exited with code ${child.exitCode}.`);
		try { const stat = fs.lstatSync(socketPath); if (stat.isSocket()) { fs.chmodSync(socketPath, 0o600); return; } } catch {}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error("SSH StreamLocal forwarding did not create its local socket.");
}
async function terminateChild(child: ChildProcess): Promise<void> { const wait = (ms: number) => child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : Promise.race([new Promise<void>((resolve) => child.once("exit", () => resolve())), new Promise<void>((resolve) => setTimeout(resolve, ms))]); if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM"); await wait(1_000); if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await wait(1_000); } }

export async function connectHerdrMachine(machine: HerdrMachineReference, options: { sshBin?: string; env?: NodeJS.ProcessEnv } = {}): Promise<HerdrForwardedConnection> {
	if (process.platform === "win32") throw new Error("Pane-native Herdr placement requires OpenSSH StreamLocal forwarding and is not supported on Windows.");
	const endpoint = discoverHerdrEndpoint(machine, options);
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-herdr-")); fs.chmodSync(dir, 0o700);
	const children = new Set<ChildProcess>();
	const forward = async (remotePath: string, name: string) => {
		if (!path.posix.isAbsolute(remotePath)) throw new Error("Remote socket path must be absolute.");
		const local = path.join(dir, `${name}.sock`);
		const child = spawn(options.sshBin ?? "ssh", [...herdrSshArgs(options.env), "-N", "-o", "StreamLocalBindUnlink=yes", "-L", `${local}:${remotePath}`, machine.target], { env: hardenedSshEnv(options.env), stdio: "ignore", windowsHide: true }); children.add(child);
		const stop = async () => { await terminateChild(child); children.delete(child); try { fs.rmSync(local, { force: true }); } catch {} };
		try { await waitForSocket(local, child); } catch (error) { await stop(); throw error; }
		return { socketPath: local, close: stop };
	};
	const primary = await forward(endpoint.socket, "herdr").catch((error) => { fs.rmSync(dir, { recursive: true, force: true }); throw error; });
	return { endpoint, socketPath: primary.socketPath, client: new SocketRpcClient(primary.socketPath), forwardRemoteSocket: forward, close: async () => { await Promise.all([...children].map(terminateChild)); children.clear(); fs.rmSync(dir, { recursive: true, force: true }); } };
}
