import type { HerdrCoreLocalMachineReference, PlacementMachineReference } from "../../shared/types.ts";
import { SocketRpcClient, type HerdrRpcClient } from "./herdr-connection.ts";
import type { HerdrRunIdentity } from "./herdr-placed-run.ts";
import { localMachineAccess } from "./local-machine-access.ts";
import { getPiSpawnCommand } from "./pi-spawn.ts";
import { createPlacedRuntimeDir, hashedRuntimeDirName, PlacedRunOwner } from "./placed-run-owner.ts";
import type { PlacementEvidenceProof, PlacementMachineAccess, PlacementOwnedPane, PlacementOwnedRun, PlacementPaneHost, PlacementPromptOptions, PlacementReconnectCheck, PlacementRunState, PlacementSockets } from "./placement-host.ts";

interface HcTerminal {
	address?: string;
	parent?: string | null;
	state?: string;
	status?: { state?: string } | null;
	labels?: Record<string, string>;
}

export interface HerdrCoreConnection extends PlacementSockets {
	client: HerdrRpcClient;
	parentTerminal: string;
	close(): Promise<void>;
}

interface HerdrCoreCandidate {
	terminals: HcTerminal[];
}

function asCoreMachine(machine: PlacementMachineReference): HerdrCoreLocalMachineReference {
	if (machine.provider !== "herdr-core") throw new Error("The Herdr Core host only places runs in Herdr Core terminals.");
	return machine;
}

function coreRunState(terminal: HcTerminal): PlacementRunState {
	if (terminal.state === "finished") return "settled";
	const status = terminal.status?.state;
	return status === "working" ? "working" : status === "blocked" ? "blocked" : status === "idle" || status === "done" ? "settled" : "unknown";
}

function ownedBy(terminal: HcTerminal, parent: string, runId: string, agentName: string): boolean {
	return terminal.parent === parent && terminal.labels?.["pi-subagents.run"] === runId && terminal.labels?.["pi-subagents.agent"] === agentName;
}

export function reconcileHerdrCoreRun(identity: HerdrRunIdentity, candidate: HerdrCoreCandidate, proveEvidence: () => PlacementEvidenceProof): PlacementReconnectCheck {
	const matches = candidate.terminals.filter((terminal) => terminal.address === identity.terminalId);
	if (matches.length !== 1) return { ok: false, reason: matches.length ? "Terminal identity is ambiguous." : "Owned terminal is missing." };
	const terminal = matches[0]!;
	if (!ownedBy(terminal, identity.target, identity.runId, identity.agentName)) return { ok: false, reason: "Herdr Core terminal ownership changed." };
	const proof = proveEvidence();
	if (!proof.ok) return proof;
	return { ok: true, state: coreRunState(terminal), paneId: identity.terminalId, cursor: proof.cursor };
}

function connectHerdrCore(machine: HerdrCoreLocalMachineReference): HerdrCoreConnection {
	const sockets = localMachineAccess().openSockets();
	return { client: new SocketRpcClient(machine.socket), parentTerminal: machine.parentTerminal, ...sockets };
}

const EVENT_STATES = new Map<unknown, PlacementRunState>([["finished", "settled"], ["lost", "unknown"], ["removed", "unknown"], ["restarted", "ready"], ["created", "ready"]]);

function eventTerminal(event: unknown): { terminalId: unknown; paneId: unknown; state: PlacementRunState } | undefined {
	const { method, params: value } = (event ?? {}) as { method?: unknown; params?: { type?: unknown; terminal?: unknown; data?: { status?: HcTerminal["status"] } | null } | null };
	if (method !== "event" || !value || typeof value !== "object") return undefined;
	const state = value.type === "status" ? coreRunState({ state: "live", status: value.data?.status }) : EVENT_STATES.get(value.type);
	return state ? { terminalId: value.terminal, paneId: value.terminal, state } : undefined;
}

async function closeOwnedCoreTerminal(connection: HerdrCoreConnection, owned: PlacementOwnedPane, run: PlacementOwnedRun): Promise<void> {
	const terminal = owned.paneId;
	if (!run.agentName || (run.terminalId !== undefined && run.terminalId !== terminal)) throw new Error("Refusing Herdr Core cleanup because terminal ownership is incomplete.");
	const current = await connection.client.call<HcTerminal>("terminal.get", { terminal });
	if (current.address !== terminal || !ownedBy(current, connection.parentTerminal, run.runId, run.agentName)) throw new Error("Refusing Herdr Core cleanup because terminal ownership changed.");
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
	paneEvent: eventTerminal,
	async panes(connection, identity) { return { terminals: [await connection.client.call<HcTerminal>("terminal.get", { terminal: identity.terminalId })] }; },
	reconcile: reconcileHerdrCoreRun,
	closeOwnedPane: closeOwnedCoreTerminal,
} satisfies PlacementPaneHost<HerdrCoreConnection, HerdrCoreCandidate>;

export class HerdrCorePlacedRunOwner extends PlacedRunOwner<HerdrCoreConnection, HerdrCoreLocalMachineReference> {
	private constructor(machine: HerdrCoreLocalMachineReference, runId: string, runtimeDir: string, connection: HerdrCoreConnection, access: PlacementMachineAccess) {
		super(machine, runId, runtimeDir, connection, herdrCoreHost, access);
	}
	override cleanup(): Promise<void> { return super.cleanup(true); }
	static async create(machine: HerdrCoreLocalMachineReference, runId: string): Promise<HerdrCorePlacedRunOwner> {
		const access = localMachineAccess({ env: { ...process.env, TMPDIR: "/tmp" } });
		const runtimeDir = await createPlacedRuntimeDir(access, hashedRuntimeDirName(runId));
		return new HerdrCorePlacedRunOwner(machine, runId, runtimeDir, connectHerdrCore(machine), access);
	}
}
