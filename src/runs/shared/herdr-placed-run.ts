import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import packageJson from "../../../package.json" with { type: "json" };
import type { HerdrRemoteGitStatus, PlacementMachineReference } from "../../shared/types.ts";
import type { ChildSession, ChildSessionEvent, ChildSessionFactory, ChildSessionLaunch } from "./child-session.ts";
import type { ChildRuntimeConfig } from "./child-runtime-config.ts";
import { herdrPaneHost, HerdrPlacedRunOwner } from "./herdr-pane-host.ts";
import { encodeHerdrPiFrame, HERDR_PI_MODE_ENV, HERDR_PI_PROTOCOL, HERDR_PI_RUN_ENV, HERDR_PI_RUNTIME_DIR_ENV, HerdrPiFrameDecoder, validateHerdrPiRunId, type HerdrPiFrame } from "./herdr-pi-protocol.ts";
import { discoverPlacedBridgeManifest, type PlacedBridgeManifest, type PlacedRunOwner } from "./placed-run-owner.ts";
import type { PlacementBridgeIdentity, PlacementPaneHost, PlacementReconnectCheck, PlacementRunState, PlacementSockets } from "./placement-host.ts";
import { RexPlacedRunOwner } from "./rex-pane-host.ts";
import { isRexLocalMachine } from "./rex-machine.ts";

export interface HerdrRunIdentity { runId: string; machineId: string; target: string; session: string | null; workspaceId: string; tabId: string; paneId: string; terminalId: string; agentName: string; nativeSessionId: string; cwd: string; runtimeDir: string }
export interface HerdrRunSnapshot { connection: "connected" | "unknown" | "closed"; state: PlacementRunState; identity?: HerdrRunIdentity; revision: number }

/** The pane half comes from the host; the bridge half (run, package, protocol, native session, evidence cursor) is host-neutral. */
export function reconcileHerdrReconnect(identity: HerdrRunIdentity, candidate: { bridge: PlacementBridgeIdentity }, lastEvidenceCursor: number, host: Pick<PlacementPaneHost, "reconcile"> = herdrPaneHost): PlacementReconnectCheck {
	return host.reconcile(identity, candidate, () => { const bridge = candidate.bridge; if (bridge.runId !== identity.runId || bridge.nativeSessionId !== identity.nativeSessionId || bridge.packageVersion !== packageJson.version || bridge.protocol !== HERDR_PI_PROTOCOL) return { ok: false, reason: "Bridge run, package, protocol, or native session identity changed." }; if (typeof bridge.evidenceCursor !== "number" || typeof bridge.evidenceFloor !== "number" || bridge.evidenceCursor < lastEvidenceCursor || bridge.evidenceFloor > lastEvidenceCursor + 1) return { ok: false, reason: "Bridge evidence has a gap after reconnect." }; return { ok: true, cursor: bridge.evidenceCursor }; });
}

export async function boundedHerdrReconnect(identity: HerdrRunIdentity, lastEvidenceCursor: number, attempt: (number: number) => Promise<{ bridge: PlacementBridgeIdentity }>, options: { attempts?: number; deadlineMs?: number; disposed?: () => boolean; host?: Pick<PlacementPaneHost, "reconcile"> } = {}) {
	const deadline = Date.now() + (options.deadlineMs ?? 15_000); let last = "Reconnect did not run.";
	for (let number = 1; number <= (options.attempts ?? 3) && Date.now() < deadline; number++) {
		if (options.disposed?.()) return { ok: false as const, reason: "Reconnect was disposed." };
		try { const result = reconcileHerdrReconnect(identity, await attempt(number), lastEvidenceCursor, options.host); if (result.ok) return result; last = result.reason; } catch (error) { last = error instanceof Error ? error.message : String(error); }
		await new Promise((resolve) => setTimeout(resolve, Math.min(number * 100, Math.max(0, deadline - Date.now()))));
	}
	return { ok: false as const, reason: last };
}

function safeRunId(value: string | undefined): string { const prefix = value?.replace(/[^A-Za-z0-9_-]/gu, "_").slice(0, 48) ?? "run"; return validateHerdrPiRunId(`${prefix}_${randomBytes(8).toString("hex")}`); }

export function serializeHerdrPiLaunch(launch: ChildSessionLaunch): { args: string[]; resources: { agent: string; skills?: string[]; toolCeiling?: string[]; reads?: string[] | false } } {
	if (launch.storage.kind === "file") throw new Error("Pane-native remote Pi does not support fork, resume, or revival; use fresh context.");
	if (launch.extensionPaths.length || launch.requiredExtensions?.length) throw new Error("Pane-native remote Pi cannot transfer local extension paths; install/configure pi-subagents on the remote machine.");
	if (launch.processEnv && Object.values(launch.processEnv).some((value) => value !== undefined && value !== "__none__")) throw new Error("Pane-native remote Pi cannot transfer local bindings, MCP selections, or process environment.");
	if (launch.runtime.nestedRoute || launch.runtime.fanoutChild || launch.runtime.depth > 1) throw new Error("Nested delegation from a pane-native remote Pi is not supported.");
	if (launch.excludeTools?.length || launch.runtime.permissions || launch.runtime.toolBudget || launch.runtime.requiredExtensions || launch.runtime.requiredTools?.length || launch.runtime.mcpDirectTools?.length) throw new Error("Pane-native remote Pi cannot yet represent exclusions, permission rules, tool budgets, MCP direct tools, or required-tool/extension contracts; remove machine placement.");
	const resources = launch.remoteResources;
	if (!resources || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(resources.agent) || resources.skills?.some((name) => !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(name)) || resources.toolCeiling?.some((name) => !/^[A-Za-z0-9_-]{1,64}$/u.test(name)) || (resources.reads !== undefined && resources.reads !== false && resources.reads.some((read) => typeof read !== "string" || Buffer.byteLength(read) > 4096))) throw new Error("Pane-native remote resources require bounded logical agent, skill, tool, and read names.");
	const args: string[] = [];
	if (launch.noSkills) args.push("--no-skills", "--no-prompt-templates");
	if (launch.noContextFiles) args.push("--no-context-files");
	if (launch.model) args.push("--model", launch.model);
	return { args, resources: { agent: resources.agent, ...(resources.skills ? { skills: [...resources.skills] } : {}), ...(resources.toolCeiling ? { toolCeiling: [...resources.toolCeiling] } : {}), ...(resources.reads !== undefined ? { reads: resources.reads === false ? false : [...resources.reads] } : {}) } };
}

export class BridgeChannel {
	readonly socket: net.Socket; readonly decoder = new HerdrPiFrameDecoder(); readonly listeners = new Set<(frame: HerdrPiFrame) => void>(); readonly waiters = new Map<string, { resolve(frame: HerdrPiFrame): void; reject(error: Error): void }>(); readonly runId: string; readonly frames: HerdrPiFrame[] = [];
	readonly failure: Promise<never>; #rejectFailure!: (error: Error) => void; #failed = false; #adopted = false;
	constructor(socketPath: string, runId: string) { this.runId = runId; this.failure = new Promise<never>((_resolve, reject) => { this.#rejectFailure = reject; }); this.failure.catch(() => {}); this.socket = net.createConnection(socketPath); this.socket.on("data", (chunk: Buffer) => { try { for (const frame of this.decoder.push(chunk)) { if (frame.runId !== runId) throw new Error("Bridge run identity mismatch."); if (!this.#adopted) { this.frames.push(frame); if (this.frames.length > 1024) throw new Error("Bridge replay queue exceeded its bound."); } const key = typeof frame.requestId === "string" ? `${frame.type}:${frame.requestId}` : ""; const waiter = this.waiters.get(key); if (waiter) { this.waiters.delete(key); waiter.resolve(frame); } for (const listener of this.listeners) listener(frame); } } catch (error) { this.fail(error as Error); } }); this.socket.on("error", (error) => this.fail(error)); this.socket.on("close", () => { if (!this.#failed) this.fail(new Error("Remote Pi bridge connection was lost; task state is unknown.")); }); }
	fail(error: Error) { if (this.#failed) return; this.#failed = true; this.#rejectFailure(error); for (const waiter of this.waiters.values()) waiter.reject(error); this.waiters.clear(); }
	get failed() { return this.#failed; }
	adopt(listener: (frame: HerdrPiFrame) => void): HerdrPiFrame[] { this.#adopted = true; this.listeners.add(listener); return this.frames.splice(0); }
	wait(type: string, requestId: string): Promise<HerdrPiFrame> { return new Promise((resolve, reject) => this.waiters.set(`${type}:${requestId}`, { resolve, reject })); }
	configure(resources: { agent: string; skills?: string[]; toolCeiling?: string[]; reads?: string[] | false }) { const requestId = `cfg_${randomBytes(6).toString("hex")}`; const waiting = this.wait("configured", requestId); this.socket.write(encodeHerdrPiFrame({ protocol: HERDR_PI_PROTOCOL, runId: this.runId, type: "configure", requestId, resources })); return waiting; }
	supervisorDelivered(requestId: string) { this.socket.write(encodeHerdrPiFrame({ protocol: HERDR_PI_PROTOCOL, runId: this.runId, type: "supervisor-delivered", requestId })); }
	prepare(requestId: string, operation: string, text?: string, supervisorId?: string, supervisorError?: string) { const waiting = this.wait("prepared", requestId); this.socket.write(encodeHerdrPiFrame({ protocol: HERDR_PI_PROTOCOL, runId: this.runId, type: "prepare", requestId, operation, ...(text !== undefined ? { text } : {}), ...(supervisorId ? { supervisorId } : {}), ...(supervisorError !== undefined ? { error: supervisorError } : {}) })); return waiting; }
	close() { this.socket.destroy(); }
}

function waitForReadyBridgeFrame(bridge: BridgeChannel, timeoutMs: number, timeoutMessage: string, configured = false): Promise<HerdrPiFrame> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
		const listener = (frame: HerdrPiFrame) => {
			if (frame.type !== "ready" || configured && frame.configured !== true) return;
			clearTimeout(timer);
			bridge.listeners.delete(listener);
			resolve(frame);
		};
		bridge.listeners.add(listener);
	});
}

export class HerdrPiSession<C extends PlacementSockets = PlacementSockets> implements ChildSession {
	readonly #listeners = new Set<(event: ChildSessionEvent) => void>(); #messages: AgentMessage[] = []; #sequence = 0; #disposed = false; #aborted = false; #initialGit?: HerdrRemoteGitStatus; #finalGit?: HerdrRemoteGitStatus;
	readonly #operations = new Map<string, { resolve(): void; reject(error: Error): void; accepted: boolean; settled: boolean }>();
	bridgeForward: { close(): Promise<void> }; bridge: BridgeChannel; readonly requestedTools: string[] | undefined; readonly model: string | undefined; #evidenceCursor = 0; #reconnecting?: Promise<void>; #reconnectFactory?: () => Promise<void>; #reconnectFailure?: Error;
	#replyTimer?: NodeJS.Timeout; readonly supervisorDir: string | undefined; readonly runtime: ChildRuntimeConfig; readonly owner: PlacedRunOwner<C>;
	constructor(owner: PlacedRunOwner<C>, bridgeForward: { close(): Promise<void> }, bridge: BridgeChannel, requestedTools: string[] | undefined, model: string | undefined, runtime: ChildRuntimeConfig, initialGit?: HerdrRemoteGitStatus) { this.owner = owner; this.bridgeForward = bridgeForward; this.bridge = bridge; this.requestedTools = requestedTools; this.model = model; this.runtime = runtime; this.supervisorDir = runtime.supervisorChannelDir; this.#initialGit = initialGit; bridge.adopt((frame) => this.#frame(frame)); if (this.supervisorDir) { this.#replyTimer = setInterval(() => { const replies = path.join(this.supervisorDir!, "replies"); for (const name of fs.existsSync(replies) ? fs.readdirSync(replies) : []) { const file = path.join(replies, name); try { const value = JSON.parse(fs.readFileSync(file, "utf8")) as { message?: unknown; requestId?: unknown; error?: unknown }; if (typeof value.message === "string" && typeof value.requestId === "string") void this.#operation("supervisor-reply", value.message, value.requestId, typeof value.error === "string" ? value.error : undefined).then(() => fs.rmSync(file, { force: true })); } catch {} } }, 50); this.#replyTimer.unref?.(); } }
	get host(): PlacementPaneHost<C> { return this.owner.host; }
	get identity(): HerdrRunIdentity { return this.owner.identity!; } set identity(value: HerdrRunIdentity) { this.owner.identity = value; }
	get connection(): C { return this.owner.connection; } set connection(value: C) { this.owner.connection = value; }
	armReconnect(factory: () => Promise<void>) { this.#reconnectFactory = factory; const observed = this.bridge; observed.failure.catch(() => { if (this.bridge === observed) void this.reconnect(); }); }
	get evidenceCursor() { return this.#evidenceCursor; }
	async reconnect() { if (this.#disposed || !this.#reconnectFactory || this.#reconnectFailure) return; this.#reconnecting ??= this.#reconnectFactory().catch((error) => { const unknown = this.#reconnectFailure = new Error(`Remote Pi reconciliation failed; task state is unknown: ${error instanceof Error ? error.message : String(error)}`); for (const operation of this.#operations.values()) if (!operation.settled) { operation.settled = true; operation.reject(unknown); } }).finally(() => { this.#reconnecting = undefined; }); await this.#reconnecting; }
	async replaceTransport(input: { connection: C; bridgeForward: { close(): Promise<void> }; bridge: BridgeChannel; unsubscribe: () => void; paneId: string; cursor: number; state: HerdrRunSnapshot["state"] }) { if (this.#disposed) { input.unsubscribe(); input.bridge.close(); await input.bridgeForward.close(); await input.connection.close(); return; } const old = { bridgeForward: this.bridgeForward, bridge: this.bridge }; this.bridgeForward = input.bridgeForward; this.bridge = input.bridge; this.identity = { ...this.identity, paneId: input.paneId }; this.#reconnectFailure = undefined; for (const frame of input.bridge.adopt((frame) => this.#frame(frame))) if (typeof frame.cursor === "number" && frame.cursor > this.#evidenceCursor) this.#frame(frame); for (const operation of this.#operations.values()) if (!operation.accepted && !operation.settled) { operation.settled = true; operation.reject(new Error("Remote operation was not accepted before transport loss; task state is unknown.")); } this.#evidenceCursor = Math.max(this.#evidenceCursor, input.cursor); const ownerReplacement = this.owner.replaceConnection({ connection: input.connection, unsubscribe: input.unsubscribe, paneId: input.paneId, state: input.state }); old.bridge.close(); await old.bridgeForward.close(); await ownerReplacement; if (this.#disposed) { await this.owner.cleanup(this.#aborted); return; } this.armReconnect(this.#reconnectFactory!); }
	#frame(frame: HerdrPiFrame) { if (typeof frame.cursor === "number") { if (frame.cursor <= this.#evidenceCursor) return; this.#evidenceCursor = frame.cursor; } if (frame.nativeSessionId !== this.identity.nativeSessionId) { this.bridge.fail(new Error("Remote Pi native session identity changed.")); void this.connection.close(); return; } if (frame.type === "accepted" && typeof frame.requestId === "string") { const operation = this.#operations.get(frame.requestId); if (operation) operation.accepted = true; } if (frame.type === "supervisor-request" && this.supervisorDir && typeof frame.requestId === "string") this.#relaySupervisor(frame); if (frame.type === "event" && frame.event && typeof frame.event === "object") { const event = frame.event as ChildSessionEvent; const message = event.message as AgentMessage | undefined; if (event.type === "message_end" && message) this.#messages.push(message); for (const listener of this.#listeners) listener(event); } if (frame.type === "settled" && typeof frame.requestId === "string") { if (frame.finalAssistant && typeof frame.finalAssistant === "object") { const message = frame.finalAssistant as AgentMessage; if (!this.#messages.includes(message)) this.#messages.push(message); } if (frame.finalGit && typeof frame.finalGit === "object") this.#finalGit = frame.finalGit as HerdrRemoteGitStatus; const operation = this.#operations.get(frame.requestId); if (operation && !operation.settled) { operation.accepted = true; operation.settled = true; frame.idle === true && frame.pending === false ? operation.resolve() : operation.reject(new Error("Remote Pi did not settle with an empty native queue.")); } for (const listener of this.#listeners) listener({ type: "agent_settled" }); } }
	#relaySupervisor(frame: HerdrPiFrame) { if (!this.supervisorDir || typeof frame.requestId !== "string") return; const reason = frame.reason; if (reason !== "need_decision" && reason !== "interview_request" && reason !== "progress_update") return; const createdAt = Date.now(); const file = path.join(this.supervisorDir, "requests", `${path.basename(frame.requestId)}.json`); const request = { type: "subagent.supervisor.request", id: frame.requestId, createdAt, ...(reason !== "progress_update" ? { expiresAt: createdAt + 10 * 60_000 } : {}), reason, message: typeof frame.message === "string" ? frame.message : "", ...(frame.interview && typeof frame.interview === "object" ? { interview: frame.interview } : {}), expectsReply: reason !== "progress_update", runId: this.runtime.runId ?? this.identity.runId, agent: this.runtime.agent ?? "remote", childIndex: this.runtime.childIndex ?? 0, orchestratorSessionId: this.runtime.orchestratorSessionId }; try { fs.writeFileSync(file, JSON.stringify(request), { mode: 0o600, flag: "wx" }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; const existing = JSON.parse(fs.readFileSync(file, "utf8")) as { id?: unknown; reason?: unknown }; if (existing.id !== frame.requestId || existing.reason !== reason) throw new Error("Supervisor relay identity changed during replay."); } if (reason === "progress_update") this.bridge.supervisorDelivered(frame.requestId); }
	async #operation(operation: string, text?: string, supervisorId?: string, supervisorError?: string): Promise<void> { const requestId = `${++this.#sequence}_${randomBytes(5).toString("hex")}`; let completion: Promise<void> = Promise.resolve(); if (operation === "prompt") completion = new Promise<void>((resolve, reject) => this.#operations.set(requestId, { resolve, reject, accepted: false, settled: false })); try { await Promise.race([this.bridge.prepare(requestId, operation, text, supervisorId, supervisorError), this.bridge.failure]); await this.host.prompt(this.connection, this.identity, `/pi-subagents-bridge ${requestId}`); await completion; } catch (error) { if (operation === "prompt" && this.bridge.failed) { await this.reconnect(); await completion; return; } const pending = this.#operations.get(requestId); if (pending) pending.settled = true; throw error; } finally { if (operation === "prompt") this.#operations.delete(requestId); } }
	subscribe(listener: (event: ChildSessionEvent) => void) { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }
	prompt(text: string) { return this.#operation("prompt", text); } steer(text: string) { return this.#operation("steer", text); } followUp(text: string) { return this.#operation("follow-up", text); } async abort() { this.#aborted = true; await this.#operation("abort"); }
	async dispose() { if (this.#disposed) return; this.#disposed = true; if (this.#replyTimer) clearInterval(this.#replyTimer); this.bridge.close(); await this.bridgeForward.close(); await this.owner.cleanup(this.#aborted); }
	get messages() { return this.#messages; } get sessionFile() { return undefined; } get sessionId() { return this.identity.nativeSessionId; } get modelId() { return this.model; }
	get machineEvidence() { return { provider: this.owner.machine.provider, machineId: this.identity.machineId, ...(this.#initialGit ? { initial: this.#initialGit } : {}), ...(this.#finalGit ? { final: this.#finalGit } : {}) }; }
	get placementSnapshot() { return this.owner.snapshot; }
}

export async function reconnectHerdrPiSession<C extends PlacementSockets>(session: HerdrPiSession<C>, launch: ChildSessionLaunch, dependencies: { connect?: (machine: PlacementMachineReference) => Promise<C>; discoverManifest?: (runId: string, runtimeDir: string) => Promise<PlacedBridgeManifest>; createBridge?: (socketPath: string, runId: string) => BridgeChannel } = {}): Promise<void> {
	const host = session.host, connect = dependencies.connect ?? ((machine: PlacementMachineReference) => host.connect(machine)), discoverManifest = dependencies.discoverManifest ?? ((runId: string, runtimeDir: string) => discoverPlacedBridgeManifest(session.owner.access, runId, runtimeDir)), createBridge = dependencies.createBridge ?? ((socketPath: string, runId: string) => new BridgeChannel(socketPath, runId));
	let validated: { connection: C; unsubscribe: () => void; bridgeForward: { socketPath: string; close(): Promise<void> }; bridge: BridgeChannel; candidate: { adopted: boolean; lost?: Error } } | undefined;
	const result = await boundedHerdrReconnect(session.identity, session.evidenceCursor, async () => {
		const connection = await connect(launch.machine!); let unsubscribe = () => {}; let bridgeForward: { socketPath: string; close(): Promise<void> } | undefined; let bridge: BridgeChannel | undefined; const generation: { adopted: boolean; lost?: Error } = { adopted: false };
		try {
			const panes = await host.panes(connection, session.identity);
			const manifest = await discoverManifest(session.identity.runId, session.identity.runtimeDir); bridgeForward = await connection.forwardRemoteSocket(manifest.socketPath, "bridge-reconnect"); bridge = createBridge(bridgeForward.socketPath, session.identity.runId);
			const ready = await waitForReadyBridgeFrame(bridge, 8_000, "Reconnected bridge handshake timed out.", true);
			const candidate = { ...panes, bridge: { runId: ready.runId, nativeSessionId: ready.nativeSessionId as string | undefined, packageVersion: ready.packageVersion as string | undefined, protocol: ready.protocol, evidenceCursor: ready.evidenceCursor as number | undefined, evidenceFloor: ready.evidenceFloor as number | undefined } };
			const check = reconcileHerdrReconnect(session.identity, candidate, session.evidenceCursor, host); if (!check.ok) throw new Error(check.reason);
			unsubscribe = await host.subscribe(connection, check.paneId, (event) => session.owner.observeEvent(event), (error) => { if (!generation.adopted) { generation.lost ??= error; return; } session.owner.markConnectionUnknown(connection); void session.reconnect(); });
			if (generation.lost) throw generation.lost; validated = { connection, unsubscribe, bridgeForward, bridge, candidate: generation }; return candidate;
		} catch (error) { unsubscribe(); bridge?.close(); await bridgeForward?.close(); await connection.close(); throw error; }
	}, { attempts: 3, deadlineMs: 15_000, disposed: () => session.placementSnapshot.connection === "closed", host });
	if (!result.ok) throw new Error(`Pane-native reconnect remains unknown: ${result.reason}`);
	if (!validated) throw new Error("Pane-native reconnect produced no validated transport.");
	if (validated.candidate.lost) { validated.unsubscribe(); validated.bridge.close(); await validated.bridgeForward.close(); await validated.connection.close(); throw validated.candidate.lost; }
	validated.candidate.adopted = true;
	await session.replaceTransport({ ...validated, paneId: result.paneId, cursor: result.cursor, state: result.state });
}

export async function createHerdrPiSession(launch: ChildSessionLaunch): Promise<ChildSession> {
	if (!launch.machine) throw new Error("Pane-native Pi launch requires a saved machine.");
	if (launch.machine.provider !== "herdr") throw new Error("Herdr pane-native Pi launch requires a Herdr saved machine.");
	const policy = serializeHerdrPiLaunch(launch); const runId = safeRunId(launch.runtime.runId);
	return startPlacedPiSession(launch, await HerdrPlacedRunOwner.create(launch.machine, runId), policy);
}

/** A Rex machine: the same bridge session, with the Rex pane host and local (`machine: "local"`) or SSH machine access. */
export async function createRexPiSession(launch: ChildSessionLaunch): Promise<ChildSession> {
	if (launch.machine?.provider !== "rex") throw new Error("Rex pane-native Pi launch requires a Rex machine.");
	const policy = serializeHerdrPiLaunch(launch); const runId = safeRunId(launch.runtime.runId);
	return startPlacedPiSession(launch, await RexPlacedRunOwner.create(launch.machine, runId), policy);
}

async function startPlacedPiSession<C extends PlacementSockets>(launch: ChildSessionLaunch, owner: PlacedRunOwner<C>, policy: ReturnType<typeof serializeHerdrPiLaunch>): Promise<ChildSession> {
	const machine = owner.machine, runId = owner.runId, runtimeDir = owner.runtimeDir, connection = owner.connection;
	try {
		let reconnectSession: { reconnect(): Promise<void> } | undefined; const agentName = `pi-${runId.slice(-20)}`;
		const { owned, terminalId } = await owner.launch({ kind: "pi", name: agentName, args: policy.args, environment: { [HERDR_PI_MODE_ENV]: "1", [HERDR_PI_RUN_ENV]: runId, [HERDR_PI_RUNTIME_DIR_ENV]: runtimeDir } }, () => owner.subscribe(() => {}, () => void reconnectSession?.reconnect()));
		const manifest = await discoverPlacedBridgeManifest(owner.access, runId, runtimeDir, "The placed Pi did not start the pi-subagents bridge, so its pane was closed. Start pi in a new pane on that machine to see why: it may wait on a prompt (such as a macOS folder-access prompt for the terminal app), exit at startup, or not load the same pi-subagents version as an extension."); if (manifest.protocol !== HERDR_PI_PROTOCOL || manifest.packageVersion !== packageJson.version) throw new Error(`Remote pi-subagents bridge version mismatch (remote ${manifest.packageVersion}, local ${packageJson.version}).`);
		const bridgeForward = await connection.forwardRemoteSocket(manifest.socketPath, "bridge"); const bridge = new BridgeChannel(bridgeForward.socketPath, runId);
		const ready = await waitForReadyBridgeFrame(bridge, 15_000, "Remote Pi bridge handshake timed out.");
		if (ready.packageVersion !== packageJson.version || ready.nativeSessionId !== manifest.nativeSessionId || ready.cwd !== machine.cwd) throw new Error("Remote Pi bridge handshake identity mismatch.");
		const configured = await Promise.race([bridge.configure(policy.resources), bridge.failure]);
		if (configured.nativeSessionId !== manifest.nativeSessionId || configured.agent !== policy.resources.agent) throw new Error("Remote Pi resource resolution identity mismatch.");
		if (!Array.isArray(configured.tools) || (policy.resources.toolCeiling && configured.tools.some((tool) => !policy.resources.toolCeiling!.includes(String(tool))))) throw new Error("Remote Pi active-tool ceiling acknowledgement mismatch.");
		if (launch.model && configured.model !== launch.model.split(":")[0]) throw new Error(`Remote Pi model '${launch.model}' did not resolve to the requested provider/model.`);
		const identity: HerdrRunIdentity = { runId, machineId: machine.id, target: isRexLocalMachine(machine) ? machine.id : machine.target, session: owner.host.sessionOf(connection), workspaceId: owned.workspaceId, tabId: owned.tabId, paneId: owned.paneId, terminalId, agentName, nativeSessionId: manifest.nativeSessionId, cwd: machine.cwd, runtimeDir };
		owner.journal(identity);
		const session = new HerdrPiSession(owner, bridgeForward, bridge, (configured.tools as string[] | undefined), typeof ready.model === "string" ? ready.model : undefined, launch.runtime, ready.initialGit as HerdrRemoteGitStatus | undefined); reconnectSession = session; session.armReconnect(() => reconnectHerdrPiSession(session, launch)); return session;
	} catch (error) { await owner.cleanup(); throw error; }
}

function createPlacedPiSession(launch: ChildSessionLaunch): Promise<ChildSession> { return launch.machine?.provider === "rex" ? createRexPiSession(launch) : createHerdrPiSession(launch); }

export function createPlacementAwareChildSessionFactory(local: ChildSessionFactory, createRemote: (launch: ChildSessionLaunch) => Promise<ChildSession> = createPlacedPiSession): ChildSessionFactory {
	const remote = new Set<ChildSession>(); return { async create(launch) { if (!launch.machine) return local.create(launch); serializeHerdrPiLaunch(launch); const child = await createRemote(launch); remote.add(child); return child; }, async dispose() { await Promise.allSettled([...remote].map((child) => child.dispose())); remote.clear(); await local.dispose(); } };
}
