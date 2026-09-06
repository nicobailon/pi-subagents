/** Internal, opt-in factory evidence. No runner enables continuation through this module. */
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { AgentSession, SessionEntry, SessionHeader } from "@earendil-works/pi-coding-agent";
import type { ChildSession, ChildSessionLaunch, PiCodingAgentModule } from "./child-session.ts";
import { captureReadonlyChildDrain, isReadonlyChildHookProfile, isReadonlyChildSessionReporting, observeReadonlyChildHookDrain } from "./child-hooks.ts";

type Runtime = Awaited<ReturnType<PiCodingAgentModule["ModelRuntime"]["create"]>>;
type Model = NonNullable<AgentSession["model"]>;

export interface SettledReadonlyEvidence {
	readonly sessionFile: string;
	readonly sessionId: string;
	readonly leafId: string;
	readonly provider: string;
	readonly model: string;
	readonly api: string;
	readonly status: 429;
	/** Complete active context, not the host's attempt-only event projection. */
	readonly contextJson: string;
	readonly completedToolResults: number;
	readonly fileDigest: string;
}

const requested = new WeakMap<ChildSessionLaunch, SettledReadonlyEvidence | null>();
const receipts = new WeakMap<ChildSession, SettledReadonlyEvidence>();
// Opaque configured-provider continuity, never an implementation-origin attestation.
const providers = new WeakMap<SettledReadonlyEvidence, object>();

/** Internal integration seam: opt in before factory creation. Ordinary launches do no evidence I/O. */
export function requestReadonlySessionEvidence(launch: ChildSessionLaunch, expected?: SettledReadonlyEvidence): void {
	requested.set(launch, expected ?? null);
}

/** Only the default factory can produce a receipt; duck-typed fake child properties are ignored. */
export function getReadonlySessionEvidence(child: ChildSession): SettledReadonlyEvidence | undefined {
	return receipts.get(child);
}

function digest(bytes: string): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function absent(file: string): boolean {
	try { lstatSync(file); return false; }
	catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT"; }
}

function sameStored(disk: unknown, live: unknown): boolean {
	// The SDK keeps optional undefined fields in memory which JSONL intentionally omits.
	return isDeepStrictEqual(disk, JSON.parse(JSON.stringify(live)));
}

/** Must run before opening a retained file. Never repairs, truncates, or creates it. */
export function validateReadonlySessionCheckpoint(evidence: SettledReadonlyEvidence): boolean {
	if (!providers.has(evidence)) return false;
	try { return digest(readFileSync(evidence.sessionFile, "utf8")) === evidence.fileDigest; }
	catch { return false; }
}

function readHistory(file: string): { header: SessionHeader; entries: SessionEntry[]; bytes: string } {
	const bytes = readFileSync(file, "utf8");
	if (!bytes.endsWith("\n")) throw new Error("Incomplete session file");
	const rows = bytes.slice(0, -1).split("\n").map((line) => JSON.parse(line));
	const [header, ...entries] = rows;
	if (header?.type !== "session" || header.version !== 3 || typeof header.id !== "string" || !header.id || typeof header.cwd !== "string" || !entries.length) throw new Error("Unsupported session header");
	const ids = new Set<string>();
	for (const entry of entries) {
		if (!entry || typeof entry.id !== "string" || !entry.id || ids.has(entry.id) || typeof entry.type !== "string" || typeof entry.timestamp !== "string" || (entry.parentId !== null && !ids.has(entry.parentId))) throw new Error("Broken session chain");
		ids.add(entry.id);
	}
	return { header, entries, bytes };
}

function activeMessages(branch: SessionEntry[]): AgentSession["messages"] {
	const messages = branch.flatMap((entry) => {
		if (entry.type === "message") return [entry.message];
		// Compaction/branch summaries and custom context need their own proof; do not reconstruct them.
		if (!["model_change", "thinking_level_change", "session_info", "label"].includes(entry.type)) throw new Error("Unsupported active context");
		return [];
	});
	// Snapshot the persisted representation, not mutable SDK message references.
	return JSON.parse(JSON.stringify(messages));
}

function completedResults(messages: AgentSession["messages"]): number {
	const pending = new Map<string, string>();
	const seen = new Set<string>();
	let completed = 0;
	for (const message of messages) {
		if (message.role === "toolResult") {
			if (typeof message.toolCallId !== "string" || !pending.has(message.toolCallId) || pending.get(message.toolCallId) !== message.toolName || !Array.isArray(message.content)) throw new Error("Unmatched tool result");
			pending.delete(message.toolCallId);
			if (!message.isError && message.content.length) completed++;
		} else {
			if (pending.size) throw new Error("Unresolved tool call");
			if (message.role === "assistant") {
				if (!Array.isArray(message.content)) throw new Error("Invalid assistant content");
				for (const block of message.content) {
					if (block.type !== "toolCall") continue;
					if (!block.id || typeof block.id !== "string" || seen.has(block.id) || !["read", "ls"].includes(block.name)) throw new Error("Uncertified tool call");
					seen.add(block.id);
					pending.set(block.id, block.name);
				}
			} else if (message.role !== "user") throw new Error("Unsupported context message");
		}
	}
	if (pending.size) throw new Error("Unresolved tool call");
	return completed;
}

function eligibleLaunch(launch: ChildSessionLaunch): boolean {
	const r = launch.runtime;
	return launch.ambientExtensions === false && !launch.extensionPaths.length
		&& isReadonlyChildSessionReporting(launch)
		&& (!launch.hooks.length || (launch.storage.kind === "file" && isReadonlyChildHookProfile(launch.hooks, r)))
		&& launch.tools !== undefined && launch.tools.every((tool) => tool === "read" || tool === "ls")
		&& !r.toolBudget && !r.permissions && !r.childWatchdog && !r.watchdogStatus && !r.structuredOutput
		&& !r.waitTool.enabled && !r.fanoutChild && !r.fast && !r.nestedRoute && !r.nestedParent && !r.runFanoutBudget
		&& !r.supervisorChannelDir && !r.mcpDirectTools?.length;
}

export interface ReadonlyEvidenceObserver {
	start(): void;
	settled(): void;
	invalidate(): void;
	beforeShutdown(): void;
	finish(child: ChildSession): void;
}

/** Called only on the explicit opt-in path, before SessionManager.open can permissively repair input. */
export function prepareReadonlySessionEvidence(launch: ChildSessionLaunch): { loadingHooks(enabled: boolean): void; beforeOpen(): void; opened(manager: AgentSession["sessionManager"]): void; observe(pi: PiCodingAgentModule, runtime: Runtime, session: AgentSession): ReadonlyEvidenceObserver | undefined } | undefined {
	if (!requested.has(launch)) return undefined;
	const expected = requested.get(launch);
	requested.delete(launch);
	const deny = (): undefined => {
		if (expected) throw new Error("Unsupported read-only continuation session");
		return undefined;
	};
	const checkExpected = (): void => {
		if (expected && (launch.storage.kind !== "file" || resolve(launch.storage.sessionFile) !== expected.sessionFile || !validateReadonlySessionCheckpoint(expected))) throw new Error("Read-only continuation checkpoint changed");
	};
	checkExpected();
	if (!eligibleLaunch(launch) || launch.storage.kind !== "file") return deny();
	const file = resolve(launch.storage.sessionFile);
	// Only an initially absent *assigned exact file* may use SDK initialization.
	// Empty files, dangling symlinks, inaccessible and corrupt inputs are not fresh.
	let fresh = !expected && absent(file);
	let initialHeader: SessionHeader | undefined;
	try { if (!fresh) initialHeader = readHistory(file).header; }
	catch { return deny(); }
	const beforeOpen = (): void => {
		checkExpected();
		if (fresh) fresh = absent(file);
	};
	const opened = (manager: AgentSession["sessionManager"]): void => {
		if (fresh && manager.getSessionFile() === file && manager.getEntries().length === 0 && manager.getLeafId() === null) {
			// Capture the real SDK-generated identity immediately after open, before hooks.
			initialHeader = JSON.parse(JSON.stringify(manager.getHeader()));
		}
	};
	const observe = (pi: PiCodingAgentModule, runtime: Runtime, session: AgentSession): ReadonlyEvidenceObserver | undefined => {
		const drainSettled = captureReadonlyChildDrain(launch.hooks);
		// A deliberately tested capability floor, not an attestation of installed code origin.
		if (!initialHeader || pi.VERSION !== "0.85.1" || !session.model || !session.agent.streamFunction) return deny();
		const header = initialHeader;
		const model = { ...session.model };
		const provider = runtime.getProvider(model.provider);
		if (expected && provider !== providers.get(expected)) return deny();
		// Coverage is namespace/API plus the observed POST topology below, not builtin provider origin.
		const supported = (m: Model): boolean => m.provider === "baseten" && m.api === "openai-completions"
			&& runtime.getProvider(m.provider) === provider
			&& !runtime.getRegisteredNativeProvider(m.provider) && !runtime.getRegisteredProviderConfig(m.provider);
		const allowed = launch.tools!.filter((name) => !launch.excludeTools?.includes(name)).sort();
		const toolsMatch = (): boolean => {
			const tools = session.getAllTools();
			return isDeepStrictEqual(session.getActiveToolNames().sort(), allowed)
				&& isDeepStrictEqual(tools.map((tool) => tool.name).sort(), allowed)
				&& tools.every((tool) => tool.sourceInfo?.source === "builtin");
		};
		const idle = (): boolean => session.isIdle && !session.isRetrying && !session.agent.hasQueuedMessages()
			&& session.agent.state.pendingToolCalls.size === 0 && !session.hasPendingBashMessages;
		const continuity = (): boolean => eligibleLaunch(launch) && toolsMatch() && session.model !== undefined
			&& session.model.id === model.id && session.model.provider === model.provider && session.model.api === model.api && supported(session.model);
		const history = () => {
			const disk = readHistory(file);
			const manager = session.sessionManager;
			const leaf = manager.getLeafId();
			if (session.sessionFile !== file || session.sessionId !== header.id || !leaf || leaf !== disk.entries.at(-1)?.id
				|| !isDeepStrictEqual(disk.header, header) || !sameStored(disk.header, manager.getHeader())
				|| !sameStored(disk.entries, manager.getEntries())) throw new Error("Session checkpoint mismatch");
			// The disk chain and live entries already agree; use the SDK's raw branch walk.
			const messages = activeMessages(manager.getBranch());
			if (!sameStored(messages, session.messages)) throw new Error("Incomplete active context");
			return { ...disk, messages, leaf, completed: completedResults(messages) };
		};
		const startingHistory = () => {
			// SDK defers persistence until its first assistant response. This exception
			// is for the empty source baseline only; settlement always reads strict disk history.
			if (fresh && absent(file)) {
				const manager = session.sessionManager;
				if (session.sessionFile !== file || session.sessionId !== header.id || !sameStored(header, manager.getHeader())
					|| session.messages.length
					|| manager.getEntries().some((entry) => !["model_change", "thinking_level_change", "session_info", "label"].includes(entry.type))) throw new Error("Fresh session initialization changed");
				return { messages: [] as AgentSession["messages"], completed: 0 };
			}
			return history();
		};
		if (!provider || !eligibleLaunch(launch) || !supported(model) || !toolsMatch() || !idle()) return deny();
		try {
			const restored = startingHistory();
			if (expected && (model.provider !== expected.provider || JSON.stringify(restored.messages) !== expected.contextJson)) throw new Error("Restored continuation context changed");
		} catch (error) {
			if (expected) throw error;
			return undefined;
		}
		let invalid = false;
		let phase: "new" | "running" | "settled" = "new";
		let owner: ChildSession | undefined;
		let baseline = 0;
		let before: AgentSession["messages"] = [];
		let inFlight = 0;
		type Invocation = { status?: number; pending: number; ambiguous: boolean; result?: Awaited<ReturnType<Awaited<ReturnType<typeof session.agent.streamFunction>>["result"]>> };
		let latest: Invocation | undefined;
		const original = session.agent.streamFunction;
		const wrapped: typeof original = async (m, context, options) => {
			const invocation: Invocation = { pending: 0, ambiguous: false };
			latest = invocation;
			if (inFlight++ || phase !== "running" || !eligibleLaunch(launch) || !supported(m) || m.id !== model.id || !toolsMatch()) invalid = true;
			if (expected && (!continuity() || session.agent.streamFunction !== wrapped)) invalid = true;
			// The repository's older agent-core types omit this documented 0.85.1 request option.
			const transport = (options as (typeof options & { fetch?: typeof fetch }))?.fetch ?? globalThis.fetch;
			const observedFetch: typeof fetch = async (...args) => {
				invocation.status = undefined; // Starting even a rejected retry invalidates any earlier 429.
				if (invocation.pending++ || invocation.result) invocation.ambiguous = true;
				try {
					try {
						const [input, init] = args;
						const url = new URL(input instanceof Request ? input.url : String(input));
						// Only the tested completions POST topology. Radius /messages and auxiliary requests deny.
						if (init?.method !== "POST" || !url.pathname.endsWith("/chat/completions") || typeof init.body !== "string") invocation.ambiguous = true;
					} catch { invocation.ambiguous = true; }
					const response = await transport(...args);
					invocation.status = response.status;
					return response;
				} catch (error) {
					invocation.status = undefined;
					throw error;
				} finally { invocation.pending--; }
			};
			try {
				// Guarded continuations must veto known changes before entering configured SDK dispatch.
				if (expected && invalid) throw new Error("Read-only continuation changed before dispatch");
				const stream = await original.call(session.agent, m, context, { ...options, fetch: observedFetch });
				// Observe result without consuming or replacing the event stream.
				void stream.result().then((result) => {
					invocation.result = result;
					inFlight--;
				}, () => { invalid = true; inFlight--; });
				return stream;
			} catch (error) { invalid = true; inFlight--; throw error; }
		};
		session.agent.streamFunction = wrapped;
		return {
			start() {
				if (owner) receipts.delete(owner);
				if (phase !== "new" || !idle()) invalid = true;
				if (expected && (!continuity() || session.agent.streamFunction !== wrapped)) invalid = true;
				phase = "running";
				latest = undefined;
				try {
					const h = startingHistory(); baseline = h.completed; before = h.messages;
					if (expected && JSON.stringify(h.messages) !== expected.contextJson) invalid = true;
				} catch { invalid = true; }
				if (expected && invalid) throw new Error("Read-only continuation changed before prompt");
			},
			settled() { phase = "settled"; },
			invalidate() { invalid = true; if (owner) receipts.delete(owner); },
			beforeShutdown() {
				// Only the identity-certified prompt runtime may finalize owned acknowledgements.
				if (!launch.hooks.length || !continuity()) invalid = true;
			},
			finish(child) {
				owner = child;
				if (!drainSettled()) return;
				if (invalid || child.detached || child.shutDown || phase !== "settled" || inFlight || !eligibleLaunch(launch) || !idle() || !supported(model) || !toolsMatch() || session.agent.streamFunction !== wrapped
					|| session.model?.id !== model.id || session.model.provider !== model.provider || session.model.api !== model.api) return;
				const invocation = latest;
				const terminal = invocation?.result;
				if (!invocation || invocation.ambiguous || invocation.pending || invocation.status !== 429 || terminal?.stopReason !== "error"
					|| terminal.content.length || terminal.provider !== model.provider || terminal.model !== model.id || terminal.api !== model.api) return;
				try {
					const h = history();
					if (h.completed <= baseline || !isDeepStrictEqual(h.messages.slice(0, before.length), before) || !sameStored(h.messages.at(-1), terminal)) return;
					const receipt: SettledReadonlyEvidence = Object.freeze({ sessionFile: file, sessionId: session.sessionId, leafId: h.leaf,
						provider: model.provider, model: model.id, api: model.api, status: 429, contextJson: JSON.stringify(h.messages),
						completedToolResults: h.completed, fileDigest: digest(h.bytes) });
					providers.set(receipt, provider);
					receipts.set(child, receipt);
				} catch { /* Strict checkpoint failures only deny evidence; never repair storage. */ }
			},
		};
	};
	return { beforeOpen, opened, observe, loadingHooks: (enabled) => observeReadonlyChildHookDrain(launch.hooks, enabled, file) };
}
