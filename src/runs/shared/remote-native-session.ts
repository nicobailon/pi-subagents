import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import packageJson from "../../../package.json" with { type: "json" };
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { herdrNativeRemoteCommand, herdrSshArgs, nativeRemoteHostDiscoveryBody } from "./herdr-machine.ts";
import { NativeRemoteJsonlDecoder, encodeNativeRemoteRpcRecord, validateNativeRemoteHandshake } from "./native-remote-rpc.ts";
import type { ChildSession, ChildSessionEvent, ChildSessionFactory, ChildSessionLaunch } from "./child-session.ts";
import { MCP_DIRECT_TOOLS_ENV } from "./child-launch.ts";
import { PI_SUBAGENT_EXTENSION_BINDINGS_ENV } from "./extension-bindings.ts";
import type { ChildRuntimeConfig } from "./child-runtime-config.ts";
import type { ChildToolDiagnostic } from "./tool-availability.ts";
import { sanitizeRuntimeAcknowledgedExtensions } from "./runtime-acknowledged-extensions.ts";
import type { ExternalCliMachineStatus, HerdrMachineReference, HerdrRemoteGitStatus, RuntimeAcknowledgedChildExtensions } from "../../shared/types.ts";

interface Pending { resolve(value: unknown): void; reject(error: Error): void; timer?: NodeJS.Timeout }
const COMMAND_TIMEOUT_MS = 15_000;
export const NATIVE_REMOTE_MAX_TRANSPORT_BYTES = 32 * 1024 * 1024;

type RemoteChildRuntime = Pick<ChildRuntimeConfig,
	"runId" | "agent" | "childIndex" | "fanoutChild" | "sessionName" | "intercomSessionName" |
	"orchestratorTarget" | "orchestratorSessionId" | "parentSessionId" | "depth" | "maxDepth" |
	"capabilityCeiling" | "thinkingCeiling" | "inheritProjectContext" | "inheritGlobalContext" |
	"inheritSkills" | "permissions" | "toolBudget" | "waitTool" | "requiredTools" | "fast"
>;

export function serializeNativeRemoteLaunch(launch: ChildSessionLaunch): Record<string, unknown> {
	if (!launch.machine) throw new Error("Remote native launch requires a saved machine.");
	if (launch.storage.kind === "file") throw new Error("Remote native Pi does not support forked, resumed, or revived session files; use fresh context.");
	if (launch.requiredExtensions?.length || launch.extensionPaths.length) throw new Error("Remote native Pi cannot transfer local extension resources. Configure extensions on the saved machine and omit local required paths.");
	if (launch.runtime.structuredOutput || launch.runtime.childWatchdog) throw new Error("Remote native Pi does not support structured output or child watchdog callbacks in this version.");
	if (launch.runtime.nestedRoute) throw new Error("Remote native Pi does not transfer nested-route paths or capability tokens; nested remote fanout requires a scoped relay.");
	if (launch.runtime.mcpDirectTools?.length || (launch.processEnv?.[MCP_DIRECT_TOOLS_ENV] && launch.processEnv[MCP_DIRECT_TOOLS_ENV] !== "__none__")) throw new Error("Remote native Pi does not transfer local MCP selections.");
	if (launch.processEnv?.[PI_SUBAGENT_EXTENSION_BINDINGS_ENV]) throw new Error("Remote native Pi does not transfer local extension bindings.");
	if (launch.skillNames?.some((name) => !name.trim() || path.isAbsolute(name) || name.startsWith("~") || name.includes("/") || name.includes("\\"))) throw new Error("Remote native Pi skill requests must use logical names, not local paths.");
	const promptSpec = launch.remotePromptSpec;
	if (promptSpec?.skillNames?.some((name) => !name.trim() || path.isAbsolute(name) || name.startsWith("~") || name.includes("/") || name.includes("\\"))) throw new Error("Remote native Pi skill requests must use logical names, not local paths.");
	if (promptSpec?.memory && (path.isAbsolute(promptSpec.memory.path) || path.win32.isAbsolute(promptSpec.memory.path) || promptSpec.memory.path.startsWith("~") || promptSpec.memory.path.split(/[/\\]/u).some((segment) => !segment || segment === "." || segment === ".." || segment.includes(":")))) throw new Error("Remote native Pi memory configuration must use a safe relative logical path.");
	const source = launch.runtime;
	const runtime: RemoteChildRuntime = {
		...(source.runId ? { runId: source.runId } : {}), ...(source.agent ? { agent: source.agent } : {}),
		...(source.childIndex !== undefined ? { childIndex: source.childIndex } : {}), fanoutChild: source.fanoutChild,
		...(source.sessionName ? { sessionName: source.sessionName } : {}), ...(source.intercomSessionName ? { intercomSessionName: source.intercomSessionName } : {}),
		...(source.orchestratorTarget ? { orchestratorTarget: source.orchestratorTarget } : {}), ...(source.orchestratorSessionId ? { orchestratorSessionId: source.orchestratorSessionId } : {}),
		...(source.parentSessionId ? { parentSessionId: source.parentSessionId } : {}), depth: source.depth, ...(source.maxDepth !== undefined ? { maxDepth: source.maxDepth } : {}),
		...(source.capabilityCeiling ? { capabilityCeiling: source.capabilityCeiling } : {}), ...(source.thinkingCeiling ? { thinkingCeiling: source.thinkingCeiling } : {}),
		...(source.inheritProjectContext !== undefined ? { inheritProjectContext: source.inheritProjectContext } : {}), ...(source.inheritGlobalContext !== undefined ? { inheritGlobalContext: source.inheritGlobalContext } : {}),
		...(source.inheritSkills !== undefined ? { inheritSkills: source.inheritSkills } : {}), ...(source.permissions ? { permissions: { rules: source.permissions.rules } } : {}),
		...(source.toolBudget ? { toolBudget: source.toolBudget } : {}), waitTool: source.waitTool, ...(source.requiredTools ? { requiredTools: source.requiredTools } : {}), fast: source.fast,
	};
	const remoteSupervision = Boolean(source.supervisorChannelDir);
	return {
		cwd: launch.machine.cwd,
		storage: { kind: "memory" },
		...(launch.model ? { model: launch.model } : {}),
		...(launch.thinking ? { thinking: launch.thinking } : {}),
		...(launch.tools ? { tools: launch.tools } : {}),
		...(launch.excludeTools ? { excludeTools: launch.excludeTools } : {}),
		extensionPaths: [],
		ambientExtensions: true,
		noSkills: launch.noSkills,
		noContextFiles: launch.noContextFiles,
		...(promptSpec ? { remotePromptSpec: promptSpec } : {
			...(launch.systemPrompt ? { systemPrompt: launch.systemPrompt } : {}),
			...(launch.appendSystemPrompt ? { appendSystemPrompt: launch.appendSystemPrompt } : {}),
			...(launch.skillNames?.length ? { skillNames: [...launch.skillNames] } : {}),
		}),
		runtime,
		remoteSupervision,
	};
}

export function projectNativeMachineEvidence(machine: HerdrMachineReference, evidence: ChildSession["machineEvidence"]): ExternalCliMachineStatus {
	if (!evidence?.initial) return machine;
	return { ...machine, remoteGit: evidence.final ?? evidence.initial, nativeGit: { initial: evidence.initial, ...(evidence.final ? { final: evidence.final } : {}) } };
}

class RemoteNativeSession implements ChildSession {
	readonly #process: ChildProcessWithoutNullStreams;
	readonly #decoder = new NativeRemoteJsonlDecoder();
	readonly #listeners = new Set<(event: ChildSessionEvent) => void>();
	readonly #pending = new Map<string, Pending>();
	readonly #supervisorDir?: string;
	#replyTimer?: NodeJS.Timeout;
	#sequence = 0;
	#messages: AgentMessage[] = [];
	#sessionId = "remote-pending";
	#modelId?: string;
	#closedError?: Error;
	#disposed = false;
	#disposeAcknowledged = false;
	#transportBytes = 0;
	#exitOutcome?: { code: number | null; signal: NodeJS.Signals | null };
	#initialGit?: HerdrRemoteGitStatus;
	#finalGit?: HerdrRemoteGitStatus;
	#toolDiagnostic?: ChildToolDiagnostic;
	#runtimeAcknowledgedExtensions?: RuntimeAcknowledgedChildExtensions;
	#requiredTools: readonly string[] = [];
	readonly #commandTimeoutMs: number;
	readonly #closed: Promise<void>;
	#resolveClosed!: () => void;

	private constructor(process: ChildProcessWithoutNullStreams, supervisorDir?: string, commandTimeoutMs = COMMAND_TIMEOUT_MS) {
		this.#process = process;
		this.#supervisorDir = supervisorDir;
		this.#commandTimeoutMs = commandTimeoutMs;
		this.#closed = new Promise((resolve) => { this.#resolveClosed = resolve; });
		process.stdout.on("data", (chunk: Buffer) => {
			this.#transportBytes += chunk.byteLength;
			if (this.#transportBytes > NATIVE_REMOTE_MAX_TRANSPORT_BYTES) { this.#fail(new Error(`Remote native Pi transport exceeded ${NATIVE_REMOTE_MAX_TRANSPORT_BYTES} aggregate bytes.`)); return; }
			try { for (const record of this.#decoder.push(chunk)) this.#record(record); }
			catch (error) { this.#fail(error instanceof Error ? error : new Error(String(error))); }
		});
		process.on("error", (error) => this.#fail(error));
		process.stdin.on("error", (error) => this.#fail(new Error(`Remote native Pi stdin failed: ${error.message}`)));
		process.on("exit", (code, signal) => {
			this.#exitOutcome = { code, signal };
		});
		process.on("close", (code, signal) => {
			try { this.#decoder.end(); } catch (error) { this.#fail(error instanceof Error ? error : new Error(String(error))); this.#resolveClosed(); return; }
			const outcome = this.#exitOutcome ?? { code, signal };
			if (!this.#disposeAcknowledged) this.#fail(new Error(`Remote native Pi transport exited prematurely with code ${String(outcome.code)}${outcome.signal ? ` (${outcome.signal})` : ""}; remote termination is unknown and the run will not be resumed automatically.`));
			this.#resolveClosed();
		});
		if (supervisorDir) {
			const replies = path.join(supervisorDir, "replies");
			this.#replyTimer = setInterval(() => {
				for (const name of fs.existsSync(replies) ? fs.readdirSync(replies) : []) {
					try {
						const file = path.join(replies, name);
						const value = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
						void this.#command("supervisor-reply", { name, value }).then(() => fs.rmSync(file, { force: true }));
					} catch { /* bounded polling retries incomplete writes */ }
				}
			}, 25);
			this.#replyTimer.unref?.();
		}
	}

	static async create(launch: ChildSessionLaunch, options: { commandTimeoutMs?: number } = {}): Promise<RemoteNativeSession> {
		const machine = launch.machine!;
		const launchFrame = encodeNativeRemoteRpcRecord({ type: "launch", protocol: 1, packageVersion: packageJson.version, launch: serializeNativeRemoteLaunch(launch) });
		const child = spawn("ssh", [...herdrSshArgs(machine), herdrNativeRemoteCommand(machine, launch.machineEnv, nativeRemoteHostDiscoveryBody())], {
			env: Object.fromEntries(["PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "SSH_AUTH_SOCK"].flatMap((name) => process.env[name] === undefined ? [] : [[name, process.env[name]!]])),
			stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
		});
		let stderr = "";
		child.stderr.on("data", (chunk: Buffer) => { stderr = `${stderr}${chunk.toString("utf8")}`.slice(-8192); });
		const session = new RemoteNativeSession(child, launch.runtime.supervisorChannelDir, options.commandTimeoutMs);
		session.#requiredTools = launch.runtime.requiredTools ?? [];
		const handshakePending = session.#waitHandshake();
		child.stdin.write(launchFrame);
		const handshake = await handshakePending.catch((error) => { session.#fail(error instanceof Error ? error : new Error(String(error))); throw new Error(`${error instanceof Error ? error.message : String(error)}${stderr.trim() ? ` Remote stderr: ${stderr.trim()}` : ""}`); });
		session.#sessionId = `remote:${machine.id}:${Date.now()}`;
		session.#modelId = handshake.model;
		return session;
	}

	#handshakeResolve?: (value: ReturnType<typeof validateNativeRemoteHandshake>) => void;
	#handshakeReject?: (error: Error) => void;
	#waitHandshake(): Promise<ReturnType<typeof validateNativeRemoteHandshake>> {
		return new Promise((resolve, reject) => {
			this.#handshakeResolve = resolve; this.#handshakeReject = reject;
			const timer = setTimeout(() => reject(new Error("Remote native Pi handshake timed out.")), COMMAND_TIMEOUT_MS); timer.unref?.();
		});
	}
	#record(value: unknown): void {
		if (this.#handshakeResolve) {
			const resolve = this.#handshakeResolve; this.#handshakeResolve = undefined;
			const handshake = validateNativeRemoteHandshake(value, { packageVersion: packageJson.version, requiredCapabilities: ["settlement", "steer", "follow-up", "abort", ...(this.#supervisorDir ? ["supervision"] : [])], requiredTools: this.#requiredTools });
			this.#initialGit = handshake.initialGit;
			resolve(handshake); return;
		}
		if (!value || typeof value !== "object") throw new Error("Remote native Pi emitted a non-object record.");
		const record = value as Record<string, unknown>;
		if (record.type === "event" && record.event && typeof record.event === "object") {
			const event = record.event as ChildSessionEvent;
			if (event.type === "message_end" && event.message && typeof event.message === "object") this.#messages.push(event.message as AgentMessage);
			if (event.type === "agent_end" && Array.isArray(event.messages)) this.#messages = event.messages as AgentMessage[];
			for (const listener of this.#listeners) listener(event); return;
		}
		if (record.type === "supervisor-request" && this.#supervisorDir && typeof record.name === "string") {
			fs.writeFileSync(path.join(this.#supervisorDir, "requests", path.basename(record.name)), JSON.stringify(record.value), { mode: 0o600 }); return;
		}
		if (record.type === "response" && typeof record.id === "string") {
			const pending = this.#pending.get(record.id); if (!pending) throw new Error(`Remote native Pi returned unknown response '${record.id}'.`);
			const data = record.data as { finalGit?: HerdrRemoteGitStatus; toolDiagnostic?: ChildToolDiagnostic; runtimeAcknowledgedExtensions?: RuntimeAcknowledgedChildExtensions } | undefined;
			if (data?.finalGit) this.#finalGit = data.finalGit;
			if (data?.toolDiagnostic && (![data.toolDiagnostic.required, data.toolDiagnostic.available, data.toolDiagnostic.missing].every((items) => Array.isArray(items) && items.every((item) => typeof item === "string")))) throw new Error("Remote native Pi returned a malformed tool diagnostic.");
			this.#toolDiagnostic = data?.toolDiagnostic;
			if (data?.runtimeAcknowledgedExtensions) {
				const acknowledged = sanitizeRuntimeAcknowledgedExtensions(data.runtimeAcknowledgedExtensions);
				if (!acknowledged) throw new Error("Remote native Pi returned malformed extension acknowledgements.");
				this.#runtimeAcknowledgedExtensions = acknowledged;
			}
			if (pending.timer) clearTimeout(pending.timer); this.#pending.delete(record.id);
			if (record.success === true) {
				if (record.command === "dispose") this.#disposeAcknowledged = true;
				pending.resolve(record.data);
			} else pending.reject(new Error(String(record.error ?? "Remote command failed."))); return;
		}
		throw new Error(`Unexpected remote native Pi record '${String(record.type)}'.`);
	}
	#fail(error: Error): void {
		if (this.#closedError) return;
		this.#closedError = error; this.#handshakeReject?.(error);
		for (const pending of this.#pending.values()) { if (pending.timer) clearTimeout(pending.timer); pending.reject(error); }
		this.#pending.clear(); this.#process.stdin.destroy();
		if (this.#process.exitCode === null && this.#process.signalCode === null) {
			this.#process.kill("SIGTERM");
			const timer = setTimeout(() => { if (this.#process.exitCode === null && this.#process.signalCode === null) this.#process.kill("SIGKILL"); }, 1_000); timer.unref?.();
		}
	}
	#command(type: string, extra: Record<string, unknown> = {}, timeout = true): Promise<unknown> {
		if (this.#closedError) return Promise.reject(this.#closedError);
		const id = String(++this.#sequence);
		return new Promise((resolve, reject) => {
			const timer = timeout ? setTimeout(() => { const error = new Error(`Remote native Pi command '${type}' timed out.`); reject(error); this.#fail(error); }, this.#commandTimeoutMs) : undefined; timer?.unref?.();
			this.#pending.set(id, { resolve, reject, timer });
			this.#process.stdin.write(encodeNativeRemoteRpcRecord({ type, id, ...extra }), (error) => { if (error) this.#fail(new Error(`Remote native Pi command '${type}' write failed: ${error.message}`)); });
		});
	}
	subscribe(listener: (event: ChildSessionEvent) => void): () => void { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }
	async prompt(text: string): Promise<void> { await this.#command("prompt", { message: text }, false); }
	async steer(text: string): Promise<void> { await this.#command("steer", { message: text }); }
	async followUp(text: string): Promise<void> { await this.#command("follow_up", { message: text }); }
	async abort(): Promise<void> { if (!this.#disposed) await this.#command("abort"); }
	async dispose(): Promise<void> {
		if (this.#disposed) return;
		if (this.#replyTimer) clearInterval(this.#replyTimer);
		if (!this.#closedError) await this.#command("dispose").catch(() => {});
		this.#disposed = true;
		this.#process.stdin.end();
		const wait = (ms: number) => Promise.race([this.#closed.then(() => true), new Promise<false>((resolve) => { const timer = setTimeout(() => resolve(false), ms); timer.unref?.(); })]);
		if (!await wait(500) && this.#process.exitCode === null && this.#process.signalCode === null) this.#process.kill("SIGTERM");
		if (!await wait(1_000) && this.#process.exitCode === null && this.#process.signalCode === null) this.#process.kill("SIGKILL");
		await this.#closed;
	}
	get messages(): readonly AgentMessage[] { return this.#messages; }
	get sessionFile(): undefined { return undefined; }
	get sessionId(): string { return this.#sessionId; }
	get modelId(): string | undefined { return this.#modelId; }
	get machineEvidence() { return { ...(this.#initialGit ? { initial: this.#initialGit } : {}), ...(this.#finalGit ? { final: this.#finalGit } : {}) }; }
	get toolDiagnostic() { return this.#toolDiagnostic; }
	get runtimeAcknowledgedExtensions() { return this.#runtimeAcknowledgedExtensions; }
}

export function createPlacementAwareChildSessionFactory(local: ChildSessionFactory, options: {
	/** Test seam for the SSH-backed constructor. */
	createRemote?: (launch: ChildSessionLaunch) => Promise<ChildSession>;
	remoteCommandTimeoutMs?: number;
} = {}): ChildSessionFactory {
	const remote = new Set<RemoteNativeSession>();
	return {
		async create(launch) {
			if (!launch.machine) return local.create(launch);
			const child = await (options.createRemote ?? ((input) => RemoteNativeSession.create(input, { commandTimeoutMs: options.remoteCommandTimeoutMs })))(launch);
			if (child instanceof RemoteNativeSession) remote.add(child);
			return child;
		},
		async dispose() { await Promise.allSettled([...remote].map(async (child) => { try { await child.abort(); } finally { await child.dispose(); } })); remote.clear(); await local.dispose(); },
	};
}
