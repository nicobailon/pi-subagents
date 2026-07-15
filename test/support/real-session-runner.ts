import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	type AssistantMessage,
	type Context,
	type FauxContentBlock,
	type FauxResponseStep,
	fauxAssistantMessage,
	fauxText,
	fauxToolCall,
	registerFauxProvider,
	type ToolCall,
} from "@earendil-works/pi-ai";
import {
	type AgentSession,
	type AgentSessionEvent,
	type ModelRegistry,
	createAgentSession,
	DefaultResourceLoader,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

const EXTENSION_PATH = fileURLToPath(new URL("../../src/extension/index.ts", import.meta.url));
const CHILD_CLI_PATH = fileURLToPath(new URL("./real-session-child-cli.mjs", import.meta.url));

export type FauxReply = string | FauxContentBlock | FauxContentBlock[] | AssistantMessage;
export type FauxResponder = (context: Context, state: { callCount: number }) => FauxReply | Promise<FauxReply>;

export interface RealSessionRunOptions {
	prompt: string;
	childText: string;
	respond: FauxResponder;
	timeoutMs?: number;
	projectFiles?: Record<string, string>;
	reportChildTools?: boolean;
}

export interface RealSessionRun {
	responseText: string;
	parentSession: AgentSession;
	modelCalls: number;
	dispose: () => Promise<void>;
}

export function subagentCall(args: Record<string, unknown>, id = "call-subagent-e2e"): ToolCall {
	return fauxToolCall("subagent", args, { id });
}

export function routeParentThroughSubagent(input: {
	childMarker: string;
	subagentArgs: Record<string, unknown>;
}): FauxResponder {
	return (context) => {
		const isParent = (context.tools ?? []).some((tool) => tool.name === "subagent");
		if (!isParent) return "Unexpected non-parent model call.";
		const resultText = latestSubagentToolResultText(context.messages as Array<{ role?: string; toolName?: string; content?: unknown }>);
		if (resultText !== undefined) {
			return `Parent relays: ${resultText.includes(input.childMarker) ? input.childMarker : "CHILD_MISSING"}`;
		}
		return subagentCall(input.subagentArgs);
	};
}

export function subagentToolResults(session: AgentSession): string[] {
	const results: string[] = [];
	for (const message of session.messages) {
		if (message.role !== "toolResult") continue;
		if ((message as { toolName?: string }).toolName !== "subagent") continue;
		results.push(textFromContent((message as { content?: unknown }).content));
	}
	return results;
}

function latestSubagentToolResultText(messages: Array<{ role?: string; toolName?: string; content?: unknown }>): string | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i]!;
		if (message.role === "toolResult" && message.toolName === "subagent") {
			return textFromContent(message.content);
		}
	}
	return undefined;
}

function textFromContent(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => part && typeof part === "object" && (part as { type?: unknown }).type === "text"
			? String((part as { text?: unknown }).text ?? "")
			: "")
		.join("");
}

function toAssistantMessage(reply: FauxReply): AssistantMessage {
	if (reply && typeof reply === "object" && "role" in reply) return reply as AssistantMessage;
	const content: FauxContentBlock[] = typeof reply === "string" ? [fauxText(reply)] : Array.isArray(reply) ? reply : [reply];
	const hasToolCall = content.some((block) => (block as { type?: string }).type === "toolCall");
	return fauxAssistantMessage(content, { stopReason: hasToolCall ? "toolUse" : "stop" });
}

function createModelRegistry(model: { provider: string; id: string }) {
	return {
		find: (provider: string, id: string) => provider === model.provider && id === model.id ? model : undefined,
		getAll: () => [model],
		getAvailable: () => [model],
		hasConfiguredAuth: () => true,
		isUsingOAuth: () => false,
		getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "faux", headers: {} }),
		registerProvider: () => {},
		unregisterProvider: () => {},
	};
}

function installChildPiShim(childText: string, reportChildTools = false): () => void {
	const rootDir = mkdtempSync(path.join(os.tmpdir(), "pi-real-session-cli-"));
	const binDir = path.join(rootDir, "bin");
	const piPackageDir = path.join(rootDir, "pi-package");
	const childCliPath = path.join(piPackageDir, "dist", "cli.mjs");
	const previousPath = process.env.PATH;
	const previousPiBinary = process.env.PI_SUBAGENT_PI_BINARY;
	const previousChildText = process.env.PI_SUBAGENTS_E2E_CHILD_TEXT;
	const previousReportTools = process.env.PI_SUBAGENTS_E2E_REPORT_CHILD_TOOLS;
	const previousArgv1 = process.argv[1];

	writeFileSync(path.join(rootDir, ".keep"), "");
	mkdirSync(binDir, { recursive: true });
	mkdirSync(path.dirname(childCliPath), { recursive: true });
	writeFileSync(childCliPath, `import ${JSON.stringify(pathToFileURL(CHILD_CLI_PATH).href)};\n`);
	writeFileSync(
		path.join(piPackageDir, "package.json"),
		JSON.stringify({ name: "@earendil-works/pi-coding-agent" }),
	);
	writeFileSync(
		path.join(binDir, "pi"),
		`#!/bin/sh\nexec "${process.execPath}" "${childCliPath}" "$@"\n`,
		{ mode: 0o755 },
	);
	writeFileSync(
		path.join(binDir, "pi.cmd"),
		`@echo off\r\n"${process.execPath}" "${childCliPath}" %*\r\n`,
	);

	process.env.PATH = `${binDir}${path.delimiter}${previousPath ?? ""}`;
	if (process.platform === "win32") {
		delete process.env.PI_SUBAGENT_PI_BINARY;
		process.argv[1] = childCliPath;
	} else {
		process.env.PI_SUBAGENT_PI_BINARY = path.join(binDir, "pi");
	}
	process.env.PI_SUBAGENTS_E2E_CHILD_TEXT = childText;
	if (reportChildTools) process.env.PI_SUBAGENTS_E2E_REPORT_CHILD_TOOLS = "1";
	else delete process.env.PI_SUBAGENTS_E2E_REPORT_CHILD_TOOLS;

	return () => {
		if (previousPath === undefined) delete process.env.PATH;
		else process.env.PATH = previousPath;
		if (previousPiBinary === undefined) delete process.env.PI_SUBAGENT_PI_BINARY;
		else process.env.PI_SUBAGENT_PI_BINARY = previousPiBinary;
		if (process.platform === "win32") {
			if (previousArgv1 === undefined) delete process.argv[1];
			else process.argv[1] = previousArgv1;
		}
		if (previousChildText === undefined) delete process.env.PI_SUBAGENTS_E2E_CHILD_TEXT;
		else process.env.PI_SUBAGENTS_E2E_CHILD_TEXT = previousChildText;
		if (previousReportTools === undefined) delete process.env.PI_SUBAGENTS_E2E_REPORT_CHILD_TOOLS;
		else process.env.PI_SUBAGENTS_E2E_REPORT_CHILD_TOOLS = previousReportTools;
		rmSync(rootDir, { recursive: true, force: true });
	};
}

function setEnv(name: string, value: string | undefined): void {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

function restoreEnv(snapshot: Map<string, string | undefined>): void {
	for (const [name, value] of snapshot) setEnv(name, value);
}

export async function runRealSubagentSession(options: RealSessionRunOptions): Promise<RealSessionRun> {
	const cwd = mkdtempSync(path.join(os.tmpdir(), "pi-real-session-cwd-"));
	const home = mkdtempSync(path.join(os.tmpdir(), "pi-real-session-home-"));
	const previousCwd = process.cwd();
	const envSnapshot = new Map([
		["HOME", process.env.HOME],
		["USERPROFILE", process.env.USERPROFILE],
		["PI_CODING_AGENT_DIR", process.env.PI_CODING_AGENT_DIR],
		["PI_SUBAGENT_EXTRA_AGENT_DIRS", process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS],
		["PI_SUBAGENT_CHILD", process.env.PI_SUBAGENT_CHILD],
		["PI_SUBAGENT_FANOUT_CHILD", process.env.PI_SUBAGENT_FANOUT_CHILD],
		["PI_SUBAGENT_DEPTH", process.env.PI_SUBAGENT_DEPTH],
		["PI_SUBAGENT_MAX_DEPTH", process.env.PI_SUBAGENT_MAX_DEPTH],
		["PI_SUBAGENT_PARENT_SESSION", process.env.PI_SUBAGENT_PARENT_SESSION],
		["PI_SUBAGENT_PI_BINARY", process.env.PI_SUBAGENT_PI_BINARY],
		["PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT", process.env.PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT],
	]);
	const uninstallChildPi = installChildPiShim(options.childText, options.reportChildTools);
	let session: AgentSession | undefined;
	let faux: ReturnType<typeof registerFauxProvider> | undefined;
	let disposed = false;

	const dispose = async () => {
		if (disposed) return;
		disposed = true;
		try {
			await session?.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		} catch {}
		try {
			session?.dispose();
		} catch {}
		faux?.unregister();
		uninstallChildPi();
		restoreEnv(envSnapshot);
		try {
			process.chdir(previousCwd);
		} catch {}
		rmSync(cwd, { recursive: true, force: true });
		rmSync(home, { recursive: true, force: true });
	};

	try {
		process.chdir(cwd);
		process.env.HOME = home;
		process.env.USERPROFILE = home;
		process.env.PI_CODING_AGENT_DIR = home;
		delete process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS;
		delete process.env.PI_SUBAGENT_CHILD;
		delete process.env.PI_SUBAGENT_FANOUT_CHILD;
		delete process.env.PI_SUBAGENT_DEPTH;
		delete process.env.PI_SUBAGENT_MAX_DEPTH;
		delete process.env.PI_SUBAGENT_PARENT_SESSION;
		delete process.env.PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT;
		for (const [relativePath, content] of Object.entries(options.projectFiles ?? {})) {
			const target = path.resolve(cwd, relativePath);
			if (target !== cwd && !target.startsWith(`${cwd}${path.sep}`)) throw new Error(`E2E project file escapes cwd: ${relativePath}`);
			mkdirSync(path.dirname(target), { recursive: true });
			writeFileSync(target, content, "utf-8");
		}

		faux = registerFauxProvider({
			provider: "faux-e2e-parent",
			models: [{ id: "parent", contextWindow: 200_000 }],
		});
		const model = faux.getModel();
		const respond = options.respond;
		const responseFactory: FauxResponseStep = async (context, _streamOptions, state) => toAssistantMessage(await respond(context, state));
		faux.setResponses(Array.from({ length: 8 }, () => responseFactory));

		const settingsManager = SettingsManager.inMemory({
			compaction: { enabled: false },
			retry: { enabled: false },
		});
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir: home,
			settingsManager,
			additionalExtensionPaths: [EXTENSION_PATH],
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			systemPrompt: "You are an E2E parent. Delegate with the subagent tool, then report the tool result.",
		});
		await loader.reload();

		const created = await createAgentSession({
			cwd,
			agentDir: home,
			model,
			modelRegistry: createModelRegistry(model) as unknown as ModelRegistry,
			resourceLoader: loader,
			sessionManager: SessionManager.create(cwd, path.join(home, "sessions")),
			settingsManager,
		});
		session = created.session;
		session.setSessionName("real-session-e2e-parent");

		let responseText = "";
		const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
			if (event.type === "message_start") responseText = "";
			if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
				responseText += event.assistantMessageEvent.delta;
			}
		});

		await session.bindExtensions({});
		const timeoutMs = options.timeoutMs ?? 30_000;
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				session.prompt(options.prompt, { expandPromptTemplates: false }),
				new Promise<never>((_, reject) => {
					timer = setTimeout(() => reject(new Error(`real-session E2E timed out after ${timeoutMs}ms`)), timeoutMs);
				}),
			]);
		} finally {
			if (timer) clearTimeout(timer);
			unsubscribe();
		}

		return {
			responseText: responseText.trim() || session.getLastAssistantText()?.trim() || "",
			parentSession: session,
			modelCalls: faux.state.callCount,
			dispose,
		};
	} catch (error) {
		await dispose();
		throw error;
	}
}
