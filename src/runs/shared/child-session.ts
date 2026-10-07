/**
 * In-process child sessions.
 *
 * A child is a pi `AgentSession` created inside the process that owns it: the
 * parent pi process for foreground children, the detached runner process for
 * background children. The factory is injectable so tests can script a child
 * without the real runtime; the default implementation wraps
 * `createAgentSession` from a pi package module.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { CHILD_COMMAND_TOOL, createChildCommandRuntime } from "./child-commands.ts";
import { supervisorChannelDir } from "./child-tool-plan.ts";
import { pinChildCacheRetention } from "../../shared/child-cache-retention.ts";
import { getAgentDir, PI_CODING_AGENT_PACKAGE_ROOT_ENV } from "../../shared/utils.ts";
import { resolvePackageSubpath } from "../background/runner-aliases.ts";
import { PI_CODING_AGENT_PACKAGE, resolveInstalledPiPackageRoot, resolvePiPackageRoot } from "./pi-spawn.ts";
import type { ChildRuntimeConfig } from "./child-runtime-config.ts";
import type { RequiredChildExtensionSnapshot } from "../../shared/required-child-extensions.ts";
import type { HerdrMachineReference, HerdrRemoteGitStatus } from "../../shared/types.ts";

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
	/** Resolved pane-native placement. Local launches omit this field. */
	machine?: HerdrMachineReference;
	/** The launching session's project trust; undefined keeps Pi's default for hosts without trust. */
	projectTrusted?: boolean;
	/** Process-local provider source owned by the invoking foreground parent. */
	parentProviderRegistry?: ParentProviderRegistry;
	/** Logical names resolved only by the remote ambient package. */
	remoteResources?: { agent: string; skills?: string[]; toolCeiling?: string[]; reads?: string[] | false };
	storage: ChildSessionStorage;
	/** Model reference as the agent config names it (`provider/id`, optionally `:thinking`). */
	model?: string;
	/** Explicit tool allowlist; undefined keeps pi's defaults. */
	tools?: string[];
	/** Tools of Pi's built-in MCP extension the child must declare to its model directly, with the `mcp:` selector that granted each; `tools` names them too. */
	builtinMcpTools?: Array<{ name: string; selector: string }>;
	excludeTools?: string[];
	/** Extension files loaded for this child in addition to the inline hooks. */
	extensionPaths: string[];
	/** Canonical required paths and safe evidence identities for fail-closed loading. */
	requiredExtensions?: RequiredChildExtensionSnapshot;
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
	/** Final settlement check for commands owned by this child; unfinished commands are cancelled and reject completion. */
	finishCommands?(): Promise<void>;
	/** True while Pi still has steering or follow-up input that has not started a turn. */
	hasQueuedMessages?(): boolean;
	readonly messages: readonly AgentMessage[];
	readonly sessionFile: string | undefined;
	readonly sessionId: string;
	readonly modelId: string | undefined;
	/** Provider id of the selected model when this child inherited that provider from the parent's registry instead of loading its extension. */
	readonly inheritedProvider?: string;
	/** Live provider/id of the selected model when Pi marks it virtual (`api === "pi-virtual"`); assistant messages then name the dispatched physical model. */
	readonly virtualModelId?: string;
	readonly contextWindow?: number;
	readonly machineEvidence?: { machineId: string; initial?: HerdrRemoteGitStatus; final?: HerdrRemoteGitStatus };
	/** Event-updated pane-native status; reading it performs no network work. */
	readonly placementSnapshot?: unknown;
	/** Set by the foreground host once the run detached; `factory.dispose()` leaves such children running. */
	detached?: boolean;
	/** Set by `factory.dispose()` before it aborts the child, so the host can report the stop truthfully. */
	shutDown?: boolean;
}

export function childSessionHasQueuedMessages(session: ChildSession | undefined): boolean {
	try {
		return session?.hasQueuedMessages?.() === true;
	} catch {
		return false;
	}
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
	/** Upper bound on the wait for selected built-in MCP tools to register after the session starts. */
	builtinMcpToolWaitMs?: number;
}

type ModelRuntimeInstance = Awaited<ReturnType<PiCodingAgentModule["ModelRuntime"]["create"]>>;

export type ParentProviderRegistry = Pick<ModelRuntimeInstance, "getRegisteredProviderIds" | "getRegisteredProviderConfig" | "getRegisteredNativeProvider">;

/** Registers the parent's providers this child did not claim itself and returns their ids. */
function inheritParentProviders(modelRuntime: ModelRuntimeInstance, parentProviders: ParentProviderRegistry, claimedProviderIds: ReadonlySet<string>, onError: ((error: ChildSessionExtensionError) => void) | undefined): Set<string> {
	let providerIds: readonly string[];
	try {
		providerIds = parentProviders.getRegisteredProviderIds();
	} catch (error) {
		onError?.({ extensionPath: "<parent-providers>", event: "inherit_provider", error });
		throw new Error(`Failed to enumerate parent providers: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
	}
	const inherited = new Set<string>();
	for (const providerId of new Set(providerIds)) {
		if (claimedProviderIds.has(providerId)) continue;
		try {
			const native = parentProviders.getRegisteredNativeProvider(providerId);
			const config = native ? undefined : parentProviders.getRegisteredProviderConfig(providerId);
			if (native) modelRuntime.registerNativeProvider(native);
			else if (config) modelRuntime.registerProvider(providerId, config);
			else throw new Error(`Parent provider '${providerId}' has no registered native provider or config.`);
			inherited.add(providerId);
		} catch (error) {
			onError?.({ extensionPath: `<parent-provider:${providerId}>`, event: "inherit_provider", error });
			throw new Error(`Failed to inherit parent provider '${providerId}': ${error instanceof Error ? error.message : String(error)}`, { cause: error });
		}
	}
	return inherited;
}

const CHILD_PROMPT_RUNTIME_EXTENSION_PATH = "<inline:pi-subagents:prompt-runtime>";

/** The prompt runtime filters parent-only context before ambient extensions inspect
 *  the child prompt. Other inline hooks keep their normal position after ambient
 *  extensions, and ambient extension order stays unchanged. */
function prioritizeChildPromptRuntime<T extends { extensions: Array<{ path: string }> }>(result: T): T {
	const index = result.extensions.findIndex(({ path }) => path === CHILD_PROMPT_RUNTIME_EXTENSION_PATH);
	if (index <= 0) return result;
	const extensions = [...result.extensions];
	const [promptRuntime] = extensions.splice(index, 1);
	if (!promptRuntime) return result;
	extensions.unshift(promptRuntime);
	return { ...result, extensions };
}

/** Ambient bash overrides keep their original backend and priority. */
function prioritizeChildCommandRuntime<T extends { extensions: Array<{ path: string; tools?: Map<string, unknown> }> }>(result: T): T {
	const index = result.extensions.findIndex(({ path }) => path === "<inline:pi-subagents:commands>");
	if (index < 0) return result;
	if (result.extensions.some((extension, otherIndex) => otherIndex !== index && extension.tools?.has("bash"))) {
		const extensions = result.extensions.filter((_, otherIndex) => otherIndex !== index);
		if (!extensions.some((extension) => extension.tools?.has(CHILD_COMMAND_TOOL))) {
			const commands = result.extensions[index]!;
			const registered = commands.tools!.get(CHILD_COMMAND_TOOL) as { definition: ToolDefinition };
			const reason = "Native command controls are unavailable with the active custom bash backend. Use that backend's own command controls.";
			extensions.push({ ...commands, tools: new Map([[CHILD_COMMAND_TOOL, { ...registered, definition: {
				...registered.definition, description: reason,
				execute: async () => { throw new Error(reason); },
			} }]]) });
		}
		return { ...result, extensions };
	}
	if (index === 0) return result;
	const extensions = [...result.extensions];
	const [commands] = extensions.splice(index, 1);
	extensions.unshift(commands!);
	return { ...result, extensions };
}

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

/**
 * Pi's built-in MCP extension registers server tools with the configured exposure, `codemode` by
 * default, which the child's `tools` allowlist cannot declare. Registering the selected names as
 * `direct` makes them model-declared and callable; `hidden` stays hidden. A name counts only when
 * the tool's raw identity, its `<server>/<tool>` label, matches the granting selector: Pi can give
 * the sanitized name of `srv/a.b` to `srv/a_b`. The selector's server part may be the configured
 * name or its `-`→`_` form, which Pi's namespace uses: Pi refuses two servers whose names differ
 * only in `-` and `_`, so both forms name the same server. Every other tool the extension registers becomes
 * `hidden`, so neither codemode nor `ctx.executeTool()` can call it, independent of the `tools`
 * allowlist. The `builtin` entry loads
 * through the explicit `builtin:mcp` path even with `noExtensions`, and `replaceable` lets an
 * ambient MCP extension that registers `/mcp` replace it, as in the parent.
 */
function selectedBuiltinMcpExtension(pi: PiCodingAgentModule, selections: ReadonlyArray<{ name: string; selector: string }>): ChildHookExtension & { builtin: true; replaceable: true } {
	// Pi 0.99 export; the pinned SDK types predate it.
	const createMcpExtension = (pi as { createMcpExtension?: () => (api: ExtensionAPI) => void | Promise<void> }).createMcpExtension;
	if (typeof createMcpExtension !== "function") throw new Error(`Selected built-in MCP tools (${selections.map(({ name }) => name).join(", ")}) need a Pi version with built-in MCP.`);
	const selectors = new Map(selections.map(({ name, selector }) => [name, selector]));
	const split = (value: string) => {
		const slash = value.indexOf("/");
		return { server: (slash === -1 ? value : value.slice(0, slash)).replace(/-/g, "_"), tool: slash === -1 ? undefined : value.slice(slash + 1) };
	};
	const granted = (tool: { name: string; label?: string; exposure?: string }) => {
		const selector = selectors.get(tool.name);
		if (selector === undefined || tool.exposure === "hidden" || tool.label === undefined) return false;
		const want = split(selector);
		const have = split(tool.label);
		return have.tool !== undefined && have.server === want.server && (want.tool === undefined || want.tool === have.tool);
	};
	const mcp = createMcpExtension();
	const factory = (api: ExtensionAPI) => mcp(new Proxy(api, {
		get(target, prop) {
			if (prop === "registerTool") {
				return (tool: Parameters<ExtensionAPI["registerTool"]>[0] & { exposure?: string }) =>
					target.registerTool({ ...tool, exposure: granted(tool) ? "direct" : "hidden" } as typeof tool);
			}
			const value = Reflect.get(target, prop, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	}));
	return { name: "mcp", factory, builtin: true, replaceable: true };
}

/** MCP connects after `session_start`, so the selected tools register some time after the session binds. */
async function missingBuiltinMcpTools(session: { getAllTools(): Array<{ name: string }>; getActiveToolNames(): string[] }, names: readonly string[], timeoutMs: number, stopped: () => boolean): Promise<string[]> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const active = new Set(session.getActiveToolNames());
		const direct = new Set(session.getAllTools().filter((tool) => (tool as { exposure?: string }).exposure === "direct").map(({ name }) => name));
		const missing = names.filter((name) => !active.has(name) || !direct.has(name));
		if (missing.length === 0 || stopped() || Date.now() >= deadline) return missing;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

function flushQueuedProviderRegistrations(loader: InstanceType<PiCodingAgentModule["DefaultResourceLoader"]>, modelRuntime: ModelRuntimeInstance, onError: ((error: ChildSessionExtensionError) => void) | undefined, requiredPaths: ReadonlySet<string>): { claimedProviderIds: Set<string>; registered: boolean } {
	const claimedProviderIds = new Set<string>();
	if (!("getExtensions" in loader) || typeof loader.getExtensions !== "function") return { claimedProviderIds, registered: false };
	const { runtime } = loader.getExtensions();
	let registered = false;
	for (const { name, config, extensionPath } of runtime.pendingProviderRegistrations ?? []) {
		claimedProviderIds.add(name);
		try {
			modelRuntime.registerProvider(name, config);
			registered = true;
		} catch (error) {
			onError?.({ extensionPath, event: "register_provider", error });
			if (requiredPaths.has(extensionPath)) throw new Error(`Required child extension provider registration failed for '${extensionPath}': ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	if (Array.isArray(runtime.pendingProviderRegistrations)) runtime.pendingProviderRegistrations = [];
	for (const { provider, extensionPath } of runtime.pendingNativeProviderRegistrations ?? []) {
		claimedProviderIds.add(provider.id);
		try {
			modelRuntime.registerNativeProvider(provider);
			registered = true;
		} catch (error) {
			onError?.({ extensionPath, event: "register_provider", error });
			if (requiredPaths.has(extensionPath)) throw new Error(`Required child extension provider registration failed for '${extensionPath}': ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	if (Array.isArray(runtime.pendingNativeProviderRegistrations)) runtime.pendingNativeProviderRegistrations = [];
	// Pi core flushes pendingVirtualModelRegistrations when a session binds extensions
	// (agent-session-services), but this factory resolves the requested model before that
	// binding, so an extension-registered virtual model never resolves for the child. The
	// structural cast keeps compiling against SDK versions that predate virtual models;
	// there the queue is absent and the loop is a no-op.
	const virtualModelRuntime = modelRuntime as ModelRuntimeInstance & { registerVirtualModel?: (definition: unknown) => void };
	const virtualModelQueue = runtime as { pendingVirtualModelRegistrations?: Array<{ definition: unknown; extensionPath: string }> };
	const pendingVirtualModelRegistrations = virtualModelQueue.pendingVirtualModelRegistrations ?? [];
	for (const { definition, extensionPath } of pendingVirtualModelRegistrations) {
		if (typeof virtualModelRuntime.registerVirtualModel !== "function") break;
		try {
			virtualModelRuntime.registerVirtualModel(definition);
			registered = true;
		} catch (error) {
			onError?.({ extensionPath, event: "register_virtual_model", error });
			if (requiredPaths.has(extensionPath)) throw new Error(`Required child extension virtual model registration failed for '${extensionPath}': ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	if (Array.isArray(virtualModelQueue.pendingVirtualModelRegistrations)) virtualModelQueue.pendingVirtualModelRegistrations = [];
	return { claimedProviderIds, registered };
}

/**
 * Load the host-owned pi-coding-agent module by absolute package entry so a
 * child cannot resolve an extension-owned copy. Root precedence is the running
 * host, an explicit override, then the install tree. Once any root is selected,
 * its manifest, package identity, entry, and import must all succeed; the bare
 * specifier is used only when no root resolves.
 */
export async function loadHostPiCodingAgent(): Promise<PiCodingAgentModule> {
	const overrideRoot = process.env[PI_CODING_AGENT_PACKAGE_ROOT_ENV]?.trim() || undefined;
	const runningRoot = resolvePiPackageRoot();
	const selectedOverride = runningRoot === undefined ? overrideRoot : undefined;
	const root = runningRoot ?? selectedOverride ?? resolveInstalledPiPackageRoot();
	if (root) {
		const entry = fs.realpathSync(resolveHostPackageEntry(root, selectedOverride));
		return import(pathToFileURL(entry).href);
	}
	return import(PI_CODING_AGENT_PACKAGE);
}

function resolveHostPackageEntry(root: string, overrideRoot: string | undefined): string {
	const packageJson = path.join(root, "package.json");
	const source = fs.readFileSync(packageJson, "utf8");
	let parsed: unknown;
	try {
		parsed = JSON.parse(source);
	} catch (error) {
		throw new Error(`invalid host SDK manifest at ${packageJson}: malformed JSON`, { cause: error });
	}
	if (!isUnknownRecord(parsed)) throw new Error(`invalid host SDK manifest at ${packageJson}: expected a JSON object`);
	const pkg = parsed;
	if (pkg.name !== PI_CODING_AGENT_PACKAGE) {
		const source = overrideRoot !== undefined ? ` (${PI_CODING_AGENT_PACKAGE_ROOT_ENV} override)` : "";
		throw new Error(`refusing to load the host SDK from ${root}${source}: package.json name is "${String(pkg.name ?? "(none)")}", expected "${PI_CODING_AGENT_PACKAGE}"`);
	}
	const entry = resolvePackageSubpath(root, ".");
	if (!entry) throw new Error(`host SDK manifest at ${packageJson} has no resolvable root export`);
	return entry;
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Default factory: detached/background sessions retain the existing shared
 * runtime; each parent-bound foreground launch gets an isolated runtime.
 */
export function createDefaultChildSessionFactory(options: DefaultChildSessionFactoryOptions = {}): ChildSessionFactory {
	const loadPiCodingAgent = options.loadPiCodingAgent ?? loadHostPiCodingAgent;
	const shutdownTimeoutMs = options.shutdownTimeoutMs ?? 5_000;
	const builtinMcpToolWaitMs = options.builtinMcpToolWaitMs ?? 10_000;
	let runtime: ReturnType<PiCodingAgentModule["ModelRuntime"]["create"]> | undefined;
	const live = new Set<ChildSession>();
	/** Extension shutdowns still running for disposed children; `dispose()` waits for them. */
	const shutdowns = new Set<Promise<void>>();
	/** Launches still waiting for their MCP tools; `dispose()` ends the wait and waits for their shutdown. */
	const mcpWaits = new Set<Promise<void>>();
	let disposals = 0;
	const sharedRuntime = async (pi: PiCodingAgentModule) => {
		runtime ??= pi.ModelRuntime.create().catch((error: unknown) => {
			runtime = undefined;
			throw error;
		});
		return runtime;
	};
	return {
		async create(launch) {
			const disposalsAtStart = disposals;
			const pi = await loadPiCodingAgent();
			const builtinMcpTools = launch.builtinMcpTools ?? [];
			const builtinMcp = builtinMcpTools.length ? selectedBuiltinMcpExtension(pi, builtinMcpTools) : undefined;
			const modelRuntime = launch.parentProviderRegistry
				? await pi.ModelRuntime.create()
				: await sharedRuntime(pi);
			const agentDir = getAgentDir();
			const commands = launch.runtime.runId && launch.runtime.agent && launch.runtime.childIndex !== undefined
				&& launch.tools?.includes("bash") && launch.tools.includes(CHILD_COMMAND_TOOL)
				&& !launch.excludeTools?.includes("bash") && !launch.excludeTools?.includes(CHILD_COMMAND_TOOL)
				&& typeof pi.createBashTool === "function"
				? createChildCommandRuntime(supervisorChannelDir(launch.runtime.runId, launch.runtime.agent, launch.runtime.childIndex)) : undefined;
			const settingsManager = pi.SettingsManager.create(launch.cwd, agentDir, { projectTrusted: launch.projectTrusted });
			// Foreground children share Pi's global theme with the parent, so reinitializing it
			// would overwrite the parent's active light/dark appearance. Detached runners have
			// no initialized theme and must initialize one for headless extension renderers.
			const themeKey = Symbol.for("@earendil-works/pi-coding-agent:theme");
			const themeInitialized = Boolean((globalThis as Record<symbol, unknown>)[themeKey]);
			if (!themeInitialized && typeof pi.initTheme === "function") pi.initTheme(settingsManager.getTheme());
			// SDK sessions do not install Pi's CLI built-ins. Use the host's own
			// codemode factory only when this child can select it; older Pi hosts
			// without that factory retain the strict missing-tool diagnostic.
			const createCodemodeExtension = (pi as PiCodingAgentModule & { createCodemodeExtension?: () => ChildHookExtension["factory"] }).createCodemodeExtension;
			const codemode = typeof createCodemodeExtension === "function" &&
				!launch.runtime.capabilityCeiling?.denyExtensions &&
				(launch.tools === undefined || launch.tools.includes("codemode")) &&
				!launch.excludeTools?.includes("codemode")
				? [{ name: "codemode", factory: createCodemodeExtension(), replaceable: true }]
				: [];
			const loader = new pi.DefaultResourceLoader({
				cwd: launch.cwd,
				agentDir,
				settingsManager,
				noExtensions: !launch.ambientExtensions,
				noSkills: launch.noSkills,
				// Pi merges skills from extensions' resources_discover without checking noSkills.
				skillsOverride: launch.noSkills ? (base) => ({ ...base, skills: [] }) : undefined,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: launch.noContextFiles,
				additionalExtensionPaths: builtinMcp ? [...launch.extensionPaths, "builtin:mcp"] : launch.extensionPaths,
				extensionFactories: [...launch.hooks, ...(commands ? [{ name: "pi-subagents:commands", factory: (api: ExtensionAPI) => {
					api.registerTool(commands.wrap(pi.createBashTool(launch.cwd, { commandPrefix: settingsManager.getShellCommandPrefix(), shellPath: settingsManager.getShellPath() }) as unknown as ToolDefinition));
					api.registerTool(commands.tool());
				} }] : []), ...codemode, ...(builtinMcp ? [builtinMcp] : [])],
				extensionsOverride: (result) => prioritizeChildPromptRuntime(prioritizeChildCommandRuntime(result)),
				...(launch.systemPrompt !== undefined ? { systemPrompt: launch.systemPrompt } : {}),
				...(launch.appendSystemPrompt !== undefined ? { appendSystemPrompt: [launch.appendSystemPrompt] } : {}),
			});
			// pi's own hosts emit `session_shutdown` before disposing a session so the
			// extensions loaded into it (ambient extensions included) release their
			// watchers, servers, and timers. Do the same, then dispose.
			const shutdownSession = async (session: Awaited<ReturnType<PiCodingAgentModule["createAgentSession"]>>["session"]): Promise<void> => {
				try {
					await commands?.shutdown();
					const runner = session.extensionRunner;
					if (runner.hasHandlers("session_shutdown")) {
						await Promise.race([runner.emit({ type: "session_shutdown", reason: "quit" }), new Promise<void>((resolve) => setTimeout(resolve, shutdownTimeoutMs).unref?.())]);
					}
				} catch (error) {
					launch.onExtensionError?.({ extensionPath: "<session>", event: "session_shutdown", error });
				} finally {
					session.dispose();
				}
			};
			let inheritedProviders = new Set<string>();
			const open = async () => {
				const requiredPaths = new Set((launch.requiredExtensions ?? []).map(({ path }) => path));
				applyProcessEnv(launch.processEnv);
				if (!resetExtensionCacheOnReload(loader) && (launch.ambientExtensions || launch.extensionPaths.length)) launch.onExtensionError?.({ extensionPath: "<loader>", event: "load", error: new Error("pi's extension cache reset is unavailable; extensions loaded into this child share module state with other sessions in this process.") });
				await loader.reload();
				const loadErrors = requiredPaths.size > 0
					? loader.getExtensions().errors.filter(({ path }) => requiredPaths.has(path)) : [];
				if (loadErrors.length > 0) throw new Error(`Required child extension failed to load: ${loadErrors.map(({ path, error }) => `${path}: ${error}`).join("; ")}`);
				const queued = flushQueuedProviderRegistrations(loader, modelRuntime, launch.onExtensionError, requiredPaths);
				if (launch.parentProviderRegistry) inheritedProviders = inheritParentProviders(modelRuntime, launch.parentProviderRegistry, queued.claimedProviderIds, launch.onExtensionError);
				if (queued.registered || inheritedProviders.size > 0) {
					try {
						await modelRuntime.refresh({ allowNetwork: false });
					} catch (error) {
						launch.onExtensionError?.({ extensionPath: "<provider-refresh>", event: "refresh_providers", error });
						throw new Error(`Failed to refresh child providers: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
					}
				}
				const sessionManager = launch.storage.kind === "file"
					? pi.SessionManager.open(launch.storage.sessionFile, undefined, launch.cwd)
					: launch.storage.kind === "dir"
						? pi.SessionManager.create(launch.cwd, launch.storage.sessionDir)
						: launch.storage.kind === "memory"
							? pi.SessionManager.inMemory(launch.cwd)
							: pi.SessionManager.create(launch.cwd);
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
				pinChildCacheRetention(session.agent);
				// Pi reports handler failures through onError instead of throwing, so required startup failures must be collected here.
				const requiredStartupErrors: string[] = [];
				let binding = true;
				try {
					await session.bindExtensions({
						mode: "print",
						onError: (error) => {
							if (binding && requiredPaths.has(error.extensionPath)) requiredStartupErrors.push(`${error.extensionPath} (${error.event}): ${error.error}`);
							launch.onExtensionError?.({ extensionPath: error.extensionPath, event: error.event, error: error.error });
						},
					});
				} catch (error) {
					session.dispose();
					throw error;
				} finally {
					binding = false;
				}
				if (requiredStartupErrors.length > 0) {
					// Binding finished, so the other extensions' session_start handlers ran and may hold resources.
					await shutdownSession(session);
					throw new Error(`Required child extension failed during startup: ${requiredStartupErrors.join("; ")}`);
				}
				return session;
			};
			const opened = loading.catch(() => {}).then(open);
			loading = opened;
			const session = await opened;
			let pending: Promise<void> | undefined;
			const shutdown = () => shutdownSession(session);
			// Outside the launch lock: MCP servers connect after `session_start` without reading the per-launch env.
			if (builtinMcpTools.length) {
				const disposed = () => disposals !== disposalsAtStart;
				const ready = missingBuiltinMcpTools(session, builtinMcpTools.map(({ name }) => name), builtinMcpToolWaitMs, disposed).then(async (missing) => {
					if (!missing.length && !disposed()) return;
					await shutdown();
					throw new Error(disposed()
						? "The child session factory was disposed while the child waited for its MCP tools."
						: `Selected built-in MCP tools did not register in the child session: ${missing.join(", ")}. The MCP server may have failed to connect, or the name belongs to a different tool than the selector names; check it with /mcp.`);
				});
				mcpWaits.add(ready);
				try { await ready; } finally { mcpWaits.delete(ready); }
			}
			const child: ChildSession = {
				subscribe: (listener) => session.subscribe((event) => listener(event as unknown as ChildSessionEvent)),
				prompt: (text) => session.prompt(text),
				...(commands ? { finishCommands: () => commands.finish() } : {}),
				steer: (text) => session.steer(text),
				followUp: (text) => session.followUp(text),
				abort: () => session.abort(),
				hasQueuedMessages: () => session.agent?.hasQueuedMessages?.() === true,
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
				get inheritedProvider() { return session.model && inheritedProviders.has(session.model.provider) ? session.model.provider : undefined; },
				get virtualModelId() { return session.model?.api === "pi-virtual" ? `${session.model.provider}/${session.model.id}` : undefined; },
				get contextWindow() { return session.model?.contextWindow; },
			};
			live.add(child);
			return child;
		},
		async dispose() {
			disposals += 1;
			const children = [...live].filter((child) => !child.detached);
			for (const child of children) child.shutDown = true;
			await Promise.allSettled(children.map((child) => child.abort()));
			for (const child of children) {
				try { void child.dispose(); } catch { /* best effort */ }
			}
			await Promise.allSettled([...shutdowns, ...mcpWaits]);
			if (live.size === 0) runtime = undefined;
		},
	};
}

let activeFactory: ChildSessionFactory | undefined;
let activeFactoryModule: string | undefined;

/** The process-wide factory foreground runs use unless a run passes its own. */
export function childSessionFactory(): ChildSessionFactory {
	activeFactory ??= createLazyPlacementFactory(createDefaultChildSessionFactory());
	return activeFactory;
}

function createLazyPlacementFactory(local: ChildSessionFactory): ChildSessionFactory {
	let placed: ChildSessionFactory | undefined;
	const factory = async () => placed ??= (await import("./herdr-placed-run.ts")).createPlacementAwareChildSessionFactory(local);
	return {
		async create(launch) { return launch.machine ? (await factory()).create(launch) : local.create(launch); },
		async dispose() { if (placed) await placed.dispose(); else await local.dispose(); },
	};
}

/** Default factory including pane-native placement; detached runners use the same boundary. */
export function createPlacementChildSessionFactory(options: DefaultChildSessionFactoryOptions = {}): ChildSessionFactory {
	return createLazyPlacementFactory(createDefaultChildSessionFactory(options));
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
