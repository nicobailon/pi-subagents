/**
 * In-process child sessions.
 *
 * A child is a pi `AgentSession` created inside the process that owns it: the
 * parent pi process for foreground children, the detached runner process for
 * background children. The factory is injectable so tests can script a child
 * without the real runtime; the default implementation wraps
 * `createAgentSession` from a pi package module and shares one `ModelRuntime`
 * across every child it creates.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "../../shared/utils.ts";
import type { ChildRuntimeConfig } from "./child-runtime-config.ts";
import { prepareReadonlySessionEvidence } from "./readonly-session-evidence.ts";
import { toModelInfo, type ModelInfo } from "../../shared/model-info.ts";

// Private runtime authority for host continuation planning; injected factories have none.
const readonlyModels = new WeakMap<ChildSession, { current: ModelInfo; resolve(reference: string): ModelInfo | undefined; requestBytes: number }>();
export function getReadonlyChildModels(child: ChildSession) {
	return readonlyModels.get(child);
}

export interface ChildSessionEvent {
	type: string;
	[key: string]: unknown;
}

/** Mirror pi's JSON event projection: `message_update` drops the partial message. */
export function projectChildSessionEventForJson(event: ChildSessionEvent): unknown {
	if (event.type !== "message_update") return event;
	const assistantMessageEvent = event.assistantMessageEvent as Record<string, unknown> | undefined;
	if (!assistantMessageEvent || typeof assistantMessageEvent !== "object") return event;
	const { partial: _partial, ...delta } = assistantMessageEvent;
	return { type: "message_update", usage: (event.message as { usage?: unknown } | undefined)?.usage, assistantMessageEvent: delta };
}

export interface ChildSessionExtensionError {
	extensionPath: string;
	event: string;
	error: unknown;
}

export interface ChildHookExtension {
	name: string;
	factory: (pi: ExtensionAPI) => void;
}

export type ChildSessionStorage =
	| { kind: "file"; sessionFile: string }
	| { kind: "dir"; sessionDir: string }
	| { kind: "default" }
	| { kind: "memory" };

export interface ChildSessionLaunch {
	cwd: string;
	storage: ChildSessionStorage;
	/** Model reference as the agent config names it (`provider/id`, optionally `:thinking`). */
	model?: string;
	/** Explicit tool allowlist; undefined keeps pi's defaults. */
	tools?: string[];
	excludeTools?: string[];
	/** Extension files loaded for this child in addition to the inline hooks. */
	extensionPaths: string[];
	/**
	 * Discover the ambient extensions (agent dir, project, settings) the way a
	 * `pi` process would. False loads only `extensionPaths` and `hooks`.
	 */
	ambientExtensions: boolean;
	hooks: ChildHookExtension[];
	noSkills: boolean;
	noContextFiles: boolean;
	systemPrompt?: string;
	appendSystemPrompt?: string;
	/**
	 * Environment values that extensions loaded into the child read from
	 * `process.env`. Applied to the hosting process while the session is created
	 * and its extensions load and start; launches in one process take that
	 * window one at a time. An undefined value removes the variable.
	 */
	processEnv?: Record<string, string | undefined>;
	/** The typed runtime config the hooks were built from; informational for factories. */
	runtime: ChildRuntimeConfig;
	onExtensionError?: (error: ChildSessionExtensionError) => void;
}

export interface ChildSession {
	subscribe(listener: (event: ChildSessionEvent) => void): () => void;
	/** Resolves when the run ends, including after abort. */
	prompt(text: string): Promise<void>;
	steer(text: string): Promise<void>;
	followUp(text: string): Promise<void>;
	abort(): Promise<void>;
	/** Emits `session_shutdown` to the child's extensions and disposes the session; resolves once that shutdown work is done. */
	dispose(): Promise<void>;
	readonly messages: readonly AgentMessage[];
	readonly sessionFile: string | undefined;
	readonly sessionId: string;
	readonly modelId: string | undefined;
	/** Set by the foreground host once the run detached; `factory.dispose()` leaves such children running. */
	detached?: boolean;
	/** Set by `factory.dispose()` before it aborts the child, so the host can report the stop truthfully. */
	shutDown?: boolean;
}

export interface ChildSessionFactory {
	create(launch: ChildSessionLaunch): Promise<ChildSession>;
	/** Abort and dispose every live attached child; detached children keep running and hold the shared runtime. */
	dispose(): Promise<void>;
}

export type PiCodingAgentModule = typeof import("@earendil-works/pi-coding-agent");

export interface DefaultChildSessionFactoryOptions {
	/**
	 * Loads the pi package the sessions are created from. The parent process
	 * uses the host's in-process module; the detached runner imports the
	 * installed package by absolute path.
	 */
	loadPiCodingAgent?: () => Promise<PiCodingAgentModule>;
	/** Upper bound on a disposed child's `session_shutdown` handlers before the session is dropped anyway. */
	shutdownTimeoutMs?: number;
}

type ModelRuntimeInstance = Awaited<ReturnType<PiCodingAgentModule["ModelRuntime"]["create"]>>;

/** One launch at a time from env application through `session_start`, so parallel launches never observe each other's `processEnv` while their extensions load and start. */
let loading: Promise<unknown> = Promise.resolve();

/**
 * pi caches extension factories per process and clears that cache only when a
 * loader reloads a second time, so every child in one process would share each
 * extension's module state. Marking the child's loader as already loaded makes
 * its first `reload()` clear the cache, so the child gets its own instances the
 * way a separate process had them. The flag is a private field of pi's loader.
 */
function resetExtensionCacheOnReload(loader: object): boolean {
	if (!("loaded" in loader)) return false;
	(loader as { loaded: boolean }).loaded = true;
	return true;
}

function applyProcessEnv(values: Record<string, string | undefined> | undefined): void {
	if (!values) return;
	for (const [name, value] of Object.entries(values)) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
}

async function flushQueuedProviderRegistrations(loader: InstanceType<PiCodingAgentModule["DefaultResourceLoader"]>, modelRuntime: ModelRuntimeInstance, onError: ((error: ChildSessionExtensionError) => void) | undefined): Promise<void> {
	if (!("getExtensions" in loader) || typeof loader.getExtensions !== "function") return;
	const { runtime } = loader.getExtensions();
	let registered = false;
	for (const { name, config, extensionPath } of runtime.pendingProviderRegistrations ?? []) {
		try {
			modelRuntime.registerProvider(name, config);
			registered = true;
		} catch (error) {
			onError?.({ extensionPath, event: "register_provider", error });
		}
	}
	if (Array.isArray(runtime.pendingProviderRegistrations)) runtime.pendingProviderRegistrations = [];
	for (const { provider, extensionPath } of runtime.pendingNativeProviderRegistrations ?? []) {
		try {
			modelRuntime.registerNativeProvider(provider);
			registered = true;
		} catch (error) {
			onError?.({ extensionPath, event: "register_provider", error });
		}
	}
	if (Array.isArray(runtime.pendingNativeProviderRegistrations)) runtime.pendingNativeProviderRegistrations = [];
	if (registered) await modelRuntime.refresh({ allowNetwork: false });
}

/**
 * Default factory: real pi sessions sharing one `ModelRuntime`, created lazily
 * on the first child launch and dropped on `dispose()`.
 */
export function createDefaultChildSessionFactory(options: DefaultChildSessionFactoryOptions = {}): ChildSessionFactory {
	const loadPiCodingAgent = options.loadPiCodingAgent ?? (() => import("@earendil-works/pi-coding-agent"));
	const shutdownTimeoutMs = options.shutdownTimeoutMs ?? 5_000;
	let runtime: ReturnType<PiCodingAgentModule["ModelRuntime"]["create"]> | undefined;
	const live = new Set<ChildSession>();
	/** Extension shutdowns still running for disposed children; `dispose()` waits for them. */
	const shutdowns = new Set<Promise<void>>();
	const sharedRuntime = async (pi: PiCodingAgentModule) => {
		runtime ??= pi.ModelRuntime.create().catch((error: unknown) => {
			runtime = undefined;
			throw error;
		});
		return runtime;
	};
	return {
		async create(launch) {
			const observeReadonly = prepareReadonlySessionEvidence(launch);
			const pi = await loadPiCodingAgent();
			const modelRuntime = await sharedRuntime(pi);
			const agentDir = getAgentDir();
			const settingsManager = pi.SettingsManager.create(launch.cwd, agentDir);
			// Headless sessions skip Pi's CLI theme setup; extensions still need ctx.ui.theme.
			if (typeof pi.initTheme === "function") pi.initTheme(settingsManager.getTheme());
			const loader = new pi.DefaultResourceLoader({
				cwd: launch.cwd,
				agentDir,
				settingsManager,
				noExtensions: !launch.ambientExtensions,
				noSkills: launch.noSkills,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: launch.noContextFiles,
				additionalExtensionPaths: launch.extensionPaths,
				extensionFactories: launch.hooks,
				...(launch.systemPrompt !== undefined ? { systemPrompt: launch.systemPrompt } : {}),
				...(launch.appendSystemPrompt !== undefined ? { appendSystemPrompt: [launch.appendSystemPrompt] } : {}),
			});
			const open = async () => {
				applyProcessEnv(launch.processEnv);
				if (!resetExtensionCacheOnReload(loader) && (launch.ambientExtensions || launch.extensionPaths.length)) launch.onExtensionError?.({ extensionPath: "<loader>", event: "load", error: new Error("pi's extension cache reset is unavailable; extensions loaded into this child share module state with other sessions in this process.") });
				observeReadonly?.loadingHooks(true);
				try { await loader.reload(); } finally { observeReadonly?.loadingHooks(false); }
				await flushQueuedProviderRegistrations(loader, modelRuntime, launch.onExtensionError);
				// No await between receipt validation and the SDK's permissive file open.
				observeReadonly?.beforeOpen();
				const sessionManager = launch.storage.kind === "file"
					? pi.SessionManager.open(launch.storage.sessionFile, undefined, launch.cwd)
					: launch.storage.kind === "dir"
						? pi.SessionManager.create(launch.cwd, launch.storage.sessionDir)
						: launch.storage.kind === "memory"
							? pi.SessionManager.inMemory(launch.cwd)
							: pi.SessionManager.create(launch.cwd);
				observeReadonly?.opened(sessionManager);
				const resolvedModel = launch.model
					? pi.resolveCliModel({ cliModel: launch.model, modelRuntime })
					: undefined;
				if (resolvedModel?.error) throw new Error(resolvedModel.error);
				const { session } = await pi.createAgentSession({
					cwd: launch.cwd,
					agentDir,
					modelRuntime,
					...(resolvedModel?.model ? { model: resolvedModel.model } : {}),
					...(resolvedModel?.thinkingLevel ? { thinkingLevel: resolvedModel.thinkingLevel } : {}),
					...(launch.tools ? { tools: launch.tools } : {}),
					...(launch.excludeTools?.length ? { excludeTools: launch.excludeTools } : {}),
					resourceLoader: loader,
					sessionManager,
					settingsManager,
					sessionStartEvent: { type: "session_start", reason: "startup" },
				});
				try {
					await session.bindExtensions({
						mode: "print",
						onError: (error) => launch.onExtensionError?.({ extensionPath: error.extensionPath, event: error.event, error: error.error }),
					});
				} catch (error) {
					session.dispose();
					throw error;
				}
				return session;
			};
			const opened = loading.catch(() => {}).then(open);
			loading = opened;
			const session = await opened;
			let evidence: ReturnType<NonNullable<typeof observeReadonly>["observe"]>;
			try { evidence = observeReadonly?.observe(pi, modelRuntime, session); }
			catch (error) { session.dispose(); throw error; }
			let pending: Promise<void> | undefined;
			// pi's own hosts emit `session_shutdown` before disposing a session so the
			// extensions loaded into it (ambient extensions included) release their
			// watchers, servers, and timers. Do the same, then dispose.
			const shutdown = async (): Promise<void> => {
				try {
					const runner = session.extensionRunner;
					if (runner.hasHandlers("session_shutdown")) {
						evidence?.beforeShutdown();
						const settled = await Promise.race([runner.emit({ type: "session_shutdown", reason: "quit" }).then(() => true), new Promise<false>((resolve) => setTimeout(() => resolve(false), shutdownTimeoutMs).unref?.())]);
						if (!settled) evidence?.invalidate();
					}
				} catch (error) {
					evidence?.invalidate();
					launch.onExtensionError?.({ extensionPath: "<session>", event: "session_shutdown", error });
				} finally {
					session.dispose();
					evidence?.finish(child);
				}
			};
			const child: ChildSession = {
				subscribe: (listener) => session.subscribe((event) => listener(event as unknown as ChildSessionEvent)),
				prompt: (text) => {
					if (!evidence) return session.prompt(text);
					try { evidence.start(); } catch (error) { return Promise.reject(error); }
					return session.prompt(text).then(() => evidence?.settled(), (error) => { evidence?.invalidate(); throw error; });
				},
				steer: (text) => { evidence?.invalidate(); return session.steer(text); },
				followUp: (text) => { evidence?.invalidate(); return session.followUp(text); },
				abort: () => { evidence?.invalidate(); return session.abort(); },
				dispose: () => {
					if (!pending) {
						live.delete(child);
						const shutdownDone = shutdown();
						pending = shutdownDone;
						shutdowns.add(shutdownDone);
						void shutdownDone.finally(() => shutdowns.delete(shutdownDone));
					}
					return pending;
				},
				get messages() { return session.messages; },
				get sessionFile() { return session.sessionFile; },
				get sessionId() { return session.sessionId; },
				get modelId() { return session.model ? `${session.model.provider}/${session.model.id}` : undefined; },
			};
			if (evidence && session.model) readonlyModels.set(child, {
				current: toModelInfo(session.model),
				requestBytes: Buffer.byteLength(session.systemPrompt) + Buffer.byteLength(JSON.stringify(session.agent.state.tools)),
				resolve(reference) {
					try {
						const resolved = pi.resolveCliModel({ cliModel: reference, modelRuntime });
						return !resolved.error && resolved.model ? toModelInfo(resolved.model) : undefined;
					} catch { return undefined; }
				},
			});
			live.add(child);
			return child;
		},
		async dispose() {
			const children = [...live].filter((child) => !child.detached);
			for (const child of children) child.shutDown = true;
			await Promise.allSettled(children.map((child) => child.abort()));
			for (const child of children) {
				try { void child.dispose(); } catch { /* best effort */ }
			}
			await Promise.allSettled([...shutdowns]);
			if (live.size === 0) runtime = undefined;
		},
	};
}

let activeFactory: ChildSessionFactory | undefined;
let activeFactoryModule: string | undefined;

/** The process-wide factory foreground runs use unless a run passes its own. */
export function childSessionFactory(): ChildSessionFactory {
	activeFactory ??= createDefaultChildSessionFactory();
	return activeFactory;
}

/**
 * Replace the process-wide factory. Tests install a scripted factory; passing
 * undefined restores the default on next use.
 */
export function setChildSessionFactory(factory: ChildSessionFactory | undefined): void {
	activeFactory = factory;
}

/**
 * Module path the detached background runner imports its child session factory
 * from. Tests point it at a scripted factory; production launches leave it
 * unset and the runner creates real sessions from the installed pi package.
 */
export function childSessionFactoryModule(): string | undefined {
	return activeFactoryModule;
}

export function setChildSessionFactoryModule(modulePath: string | undefined): void {
	activeFactoryModule = modulePath;
}

/** Abort and dispose every live in-process child and release the shared runtime. */
export async function disposeChildSessions(): Promise<void> {
	const factory = activeFactory;
	if (!factory) return;
	await factory.dispose();
}
