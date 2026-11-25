import type { HerdrCoreLocalMachineReference, PlacementMachineReference } from "../../shared/types.ts";
import { SocketRpcClient, type HerdrRpcClient } from "./herdr-connection.ts";
import type { HerdrRunIdentity } from "./herdr-placed-run.ts";
import { localMachineAccess } from "./local-machine-access.ts";
import { getPiSpawnCommand } from "./pi-spawn.ts";
import { createPlacedRuntimeDir, hashedRuntimeDirName, PlacedRunOwner, removePlacedRuntimeDir } from "./placed-run-owner.ts";
import type { PlacementBridgeIdentity, PlacementEvidenceProof, PlacementMachineAccess, PlacementOwnedPane, PlacementOwnedRun, PlacementPaneHost, PlacementPromptOptions, PlacementReconnectCheck, PlacementRunState, PlacementSockets } from "./placement-host.ts";

interface HcTerminal {
	address?: string;
	parent?: string | null;
	state?: string;
	status?: { state?: string } | null;
	labels?: Record<string, string>;
}

export interface HerdrCoreConnection extends PlacementSockets {
	client: HerdrRpcClient;
	socketPath: string;
	parentTerminal: string;
	close(): Promise<void>;
}

export interface HerdrCoreCandidate {
	terminals: HcTerminal[];
	bridge?: PlacementBridgeIdentity;
}

function asCoreMachine(machine: PlacementMachineReference): HerdrCoreLocalMachineReference {
	if (machine.provider !== "herdr-core") throw new Error("The Herdr Core host only places runs in Herdr Core terminals.");
	return machine;
}

function coreRunState(terminal: HcTerminal | undefined, fallback: PlacementRunState = "unknown"): PlacementRunState {
	if (!terminal) return "unknown";
	if (terminal.state === "finished") return "settled";
	const status = terminal.status?.state;
	return status === "working" ? "working" : status === "blocked" ? "blocked" : status === "idle" || status === "done" ? "settled" : fallback;
}

export function reconcileHerdrCoreRun(identity: HerdrRunIdentity, candidate: HerdrCoreCandidate, proveEvidence: () => PlacementEvidenceProof): PlacementReconnectCheck {
	const matches = candidate.terminals.filter((terminal) => terminal.address === identity.terminalId);
	if (matches.length !== 1) return { ok: false, reason: matches.length ? "Terminal identity is ambiguous." : "Owned terminal is missing." };
	const terminal = matches[0]!;
	if (terminal.parent !== identity.target || terminal.labels?.["pi-subagents.run"] !== identity.runId || terminal.labels?.["pi-subagents.agent"] !== identity.agentName) return { ok: false, reason: "Herdr Core terminal ownership changed." };
	const proof = proveEvidence();
	if (!proof.ok) return proof;
	return { ok: true, state: coreRunState(terminal), paneId: identity.terminalId, cursor: proof.cursor };
}

export function connectHerdrCore(machine: HerdrCoreLocalMachineReference): HerdrCoreConnection {
	const sockets = localMachineAccess().openSockets();
	return { client: new SocketRpcClient(machine.socket), socketPath: machine.socket, parentTerminal: machine.parentTerminal, ...sockets };
}

function eventTerminal(event: unknown): { terminalId: unknown; state: PlacementRunState } | undefined {
	const params = event && typeof event === "object" ? (event as { method?: unknown; params?: unknown }) : undefined;
	if (params?.method !== "event" || !params.params || typeof params.params !== "object") return undefined;
	const value = params.params as { type?: unknown; terminal?: unknown; data?: unknown };
	const data = value.data && typeof value.data === "object" ? value.data as Record<string, unknown> : {};
	if (value.type === "status") return { terminalId: value.terminal, state: coreRunState({ state: "live", status: data.status as HcTerminal["status"] }) };
	if (value.type === "finished") return { terminalId: value.terminal, state: "settled" };
	if (value.type === "lost" || value.type === "removed") return { terminalId: value.terminal, state: "unknown" };
	if (value.type === "restarted" || value.type === "created") return { terminalId: value.terminal, state: "ready" };
	return undefined;
}

async function closeOwnedCoreTerminal(connection: HerdrCoreConnection, owned: PlacementOwnedPane, run: PlacementOwnedRun): Promise<void> {
	const terminal = owned.paneId;
	if (!run.agentName || (run.terminalId !== undefined && run.terminalId !== terminal)) throw new Error("Refusing Herdr Core cleanup because terminal ownership is incomplete.");
	const current = await connection.client.call<HcTerminal>("terminal.get", { terminal });
	if (current.address !== terminal || current.parent !== connection.parentTerminal || current.labels?.["pi-subagents.run"] !== run.runId || current.labels?.["pi-subagents.agent"] !== run.agentName) throw new Error("Refusing Herdr Core cleanup because terminal ownership changed.");
	if (current.state === "live") await connection.client.call("terminal.kill", { terminal });
}

export const herdrCoreHost = {
	connect(machine) { return Promise.resolve(connectHerdrCore(asCoreMachine(machine))); },
	sessionOf() { return null; },
	async launch(connection, machine, runId, _runtimeDir, request, onTerminal) {
		const core = asCoreMachine(machine);
		if (request.kind !== "pi") throw new Error("Herdr Core local placement supports native Pi children only.");
		const pi = getPiSpawnCommand(request.args);
		const terminal = await connection.client.call<HcTerminal>("terminal.run", {
			argv: [pi.command, ...pi.args],
			cwd: core.cwd,
			env: request.environment ?? {},
			name: request.name,
			parent: core.parentTerminal,
			caller: core.parentTerminal,
			no_notify: true,
			labels: { "pi-subagents.run": runId, "pi-subagents.agent": request.name },
		});
		if (typeof terminal.address !== "string" || terminal.parent !== core.parentTerminal || terminal.state !== "live") throw new Error("Herdr Core returned an invalid child terminal identity.");
		const owned = { workspaceId: terminal.address, tabId: terminal.address, paneId: terminal.address };
		await onTerminal(owned);
		return { owned, terminalId: terminal.address };
	},
	async prompt(connection, identity, text, options: PlacementPromptOptions = {}) {
		if (options.stopped?.()) throw new Error("Herdr Core prompt was not sent because the run was stopped.");
		await connection.client.call("terminal.send", { terminal: identity.terminalId, text, force: true }, options.timeoutMs ?? 20_000);
	},
	subscribe(connection, terminalId, listener, onDisconnect) {
		if (!connection.client.subscribeParams) throw new Error("Herdr Core event subscriptions are unavailable.");
		return connection.client.subscribeParams({ terminal: terminalId }, listener, onDisconnect, (result) => Boolean(result && typeof result === "object" && Array.isArray((result as { terminals?: unknown }).terminals)));
	},
	paneEvent(event) { const found = eventTerminal(event); return found ? { terminalId: found.terminalId, paneId: found.terminalId, state: found.state } : undefined; },
	async panes(connection, identity) { return { terminals: [await connection.client.call<HcTerminal>("terminal.get", { terminal: identity.terminalId })] }; },
	reconcile: reconcileHerdrCoreRun,
	closeOwnedPane: closeOwnedCoreTerminal,
} satisfies PlacementPaneHost<HerdrCoreConnection, HerdrCoreCandidate>;

export class HerdrCorePlacedRunOwner extends PlacedRunOwner<HerdrCoreConnection, HerdrCoreLocalMachineReference> {
	private constructor(machine: HerdrCoreLocalMachineReference, runId: string, runtimeDir: string, connection: HerdrCoreConnection, access: PlacementMachineAccess) {
		super(machine, runId, runtimeDir, connection, herdrCoreHost, access, true);
	}
	static async create(machine: HerdrCoreLocalMachineReference, runId: string): Promise<HerdrCorePlacedRunOwner> {
		const access = localMachineAccess({ env: { ...process.env, TMPDIR: "/tmp" } });
		const runtimeDir = await createPlacedRuntimeDir(access, hashedRuntimeDirName(runId));
		try { return new HerdrCorePlacedRunOwner(machine, runId, runtimeDir, connectHerdrCore(machine), access); }
		catch (error) { removePlacedRuntimeDir(access, runtimeDir); throw error; }
	}
}
