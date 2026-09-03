/**
 * In-process child sessions for foreground runs.
 *
 * A foreground child is a pi `AgentSession` created inside the parent process.
 * The factory is injectable so tests can script a child without the real
 * runtime; the default implementation wraps `createAgentSession` from the host
 * pi package and shares one `ModelRuntime` across every child it creates.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "../../shared/utils.ts";
import type { ChildRuntimeConfig } from "../shared/child-runtime-config.ts";

export interface ChildSessionEvent {
	type: string;
	[key: string]: unknown;
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
	hooks: ChildHookExtension[];
	noSkills: boolean;
	noContextFiles: boolean;
	systemPrompt?: string;
	appendSystemPrompt?: string;
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
	dispose(): void;
	readonly messages: readonly AgentMessage[];
	readonly sessionFile: string | undefined;
	readonly sessionId: string;
	readonly modelId: string | undefined;
}

export interface ChildSessionFactory {
	create(launch: ChildSessionLaunch): Promise<ChildSession>;
	/** Abort and dispose every live child and release the shared runtime. */
	dispose(): Promise<void>;
}

type PiCodingAgentModule = typeof import("@earendil-works/pi-coding-agent");

async function loadPiCodingAgent(): Promise<PiCodingAgentModule> {
	return import("@earendil-works/pi-coding-agent");
}

/**
 * Default factory: real pi sessions sharing one `ModelRuntime`, created lazily
 * on the first child launch and dropped on `dispose()`.
 */
export function createDefaultChildSessionFactory(): ChildSessionFactory {
	let runtime: ReturnType<PiCodingAgentModule["ModelRuntime"]["create"]> | undefined;
	const live = new Set<ChildSession>();
	const sharedRuntime = async (pi: PiCodingAgentModule) => {
		runtime ??= pi.ModelRuntime.create().catch((error: unknown) => {
			runtime = undefined;
			throw error;
		});
		return runtime;
	};
	return {
		async create(launch) {
			const pi = await loadPiCodingAgent();
			const modelRuntime = await sharedRuntime(pi);
			const agentDir = getAgentDir();
			const settingsManager = pi.SettingsManager.create(launch.cwd, agentDir);
			const loader = new pi.DefaultResourceLoader({
				cwd: launch.cwd,
				agentDir,
				settingsManager,
				noExtensions: true,
				noSkills: launch.noSkills,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: launch.noContextFiles,
				additionalExtensionPaths: launch.extensionPaths,
				extensionFactories: launch.hooks,
				...(launch.systemPrompt !== undefined ? { systemPrompt: launch.systemPrompt } : {}),
				...(launch.appendSystemPrompt !== undefined ? { appendSystemPrompt: [launch.appendSystemPrompt] } : {}),
			});
			await loader.reload();
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
			await session.bindExtensions({
				mode: "print",
				onError: (error) => launch.onExtensionError?.({ extensionPath: error.extensionPath, event: error.event, error: error.error }),
			});
			let disposed = false;
			const child: ChildSession = {
				subscribe: (listener) => session.subscribe((event) => listener(event as unknown as ChildSessionEvent)),
				prompt: (text) => session.prompt(text),
				steer: (text) => session.steer(text),
				followUp: (text) => session.followUp(text),
				abort: () => session.abort(),
				dispose: () => {
					if (disposed) return;
					disposed = true;
					live.delete(child);
					session.dispose();
				},
				get messages() { return session.messages; },
				get sessionFile() { return session.sessionFile; },
				get sessionId() { return session.sessionId; },
				get modelId() { return session.model ? `${session.model.provider}/${session.model.id}` : undefined; },
			};
			live.add(child);
			return child;
		},
		async dispose() {
			const children = [...live];
			live.clear();
			await Promise.allSettled(children.map((child) => child.abort()));
			for (const child of children) {
				try { child.dispose(); } catch { /* best effort */ }
			}
			runtime = undefined;
		},
	};
}

let activeFactory: ChildSessionFactory | undefined;

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

/** Abort and dispose every live in-process child and release the shared runtime. */
export async function disposeChildSessions(): Promise<void> {
	const factory = activeFactory;
	if (!factory) return;
	await factory.dispose();
}
