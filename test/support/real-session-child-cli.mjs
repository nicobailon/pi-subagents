#!/usr/bin/env node
import { mkdtempSync, rmSync } from "node:fs";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	fauxAssistantMessage,
	fauxText,
	fauxToolCall,
	registerFauxProvider,
} from "@earendil-works/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

function readText(filePath) {
	return fs.readFileSync(filePath, "utf-8");
}

function parseArgs(argv) {
	const parsed = {
		mode: "text",
		extensions: [],
		appendSystemPrompts: [],
		noSession: false,
		noSkills: false,
	};

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--mode") {
			parsed.mode = argv[++i] ?? "text";
			continue;
		}
		if (arg === "-p" || arg === "--print") continue;
		if (arg === "--no-session") {
			parsed.noSession = true;
			continue;
		}
		if (arg === "--session") {
			parsed.sessionFile = argv[++i];
			continue;
		}
		if (arg === "--session-dir") {
			parsed.sessionDir = argv[++i];
			continue;
		}
		if (arg === "--model") {
			parsed.model = argv[++i];
			continue;
		}
		if (arg === "--tools") {
			parsed.tools = (argv[++i] ?? "").split(",").map((tool) => tool.trim()).filter(Boolean);
			continue;
		}
		if (arg === "--extension") {
			const extensionPath = argv[++i];
			if (extensionPath) parsed.extensions.push(extensionPath);
			continue;
		}
		if (arg === "--no-extensions") continue;
		if (arg === "--no-skills") {
			parsed.noSkills = true;
			continue;
		}
		if (arg === "--system-prompt") {
			const promptPath = argv[++i];
			if (promptPath) parsed.systemPrompt = readText(promptPath);
			continue;
		}
		if (arg === "--append-system-prompt") {
			const promptPath = argv[++i];
			if (promptPath) parsed.appendSystemPrompts.push(readText(promptPath));
			continue;
		}
		if (arg?.startsWith("--")) continue;
		parsed.prompt = arg;
	}

	if (parsed.prompt?.startsWith("@")) {
		parsed.prompt = readText(parsed.prompt.slice(1));
	}
	return parsed;
}

function createModelRegistry(model) {
	return {
		find: (provider, id) => provider === model.provider && id === model.id ? model : undefined,
		getAll: () => [model],
		getAvailable: () => [model],
		hasConfiguredAuth: () => true,
		isUsingOAuth: () => false,
		getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "faux", headers: {} }),
		registerProvider: () => {},
		unregisterProvider: () => {},
	};
}

function createSessionManager(parsed, cwd) {
	if (parsed.sessionFile) {
		const sessionDir = parsed.sessionDir ?? path.dirname(parsed.sessionFile);
		const manager = SessionManager.create(cwd, sessionDir);
		manager.setSessionFile(parsed.sessionFile);
		return manager;
	}
	if (parsed.noSession) return SessionManager.inMemory(cwd);
	return SessionManager.create(cwd, parsed.sessionDir);
}

async function main() {
	const parsed = parseArgs(process.argv.slice(2));
	const responseText = process.env.PI_SUBAGENTS_E2E_CHILD_TEXT ?? "CHILD_REAL_SESSION_OK";
	const reportChildTools = process.env.PI_SUBAGENTS_E2E_REPORT_CHILD_TOOLS === "1";
	const cwd = process.cwd();
	const ownedAgentDir = process.env.PI_CODING_AGENT_DIR
		? undefined
		: mkdtempSync(path.join(os.tmpdir(), "pi-e2e-agent-dir-"));
	const agentDir = process.env.PI_CODING_AGENT_DIR ?? ownedAgentDir;

	const faux = registerFauxProvider({
		provider: "faux-e2e-child",
		models: [{ id: "child", contextWindow: 200_000 }],
	});
	const model = faux.getModel();
	let session;
	faux.setResponses([
		() => process.env.PI_SUBAGENT_STRUCTURED_OUTPUT_CAPTURE
			? fauxAssistantMessage(fauxToolCall("structured_output", { value: { marker: "STRUCTURED_OUTPUT_OK" } }), { stopReason: "toolUse" })
			: fauxAssistantMessage(fauxText(reportChildTools ? `ACTIVE_TOOLS:${session?.getActiveToolNames().sort().join(",") ?? ""}` : responseText), { stopReason: "stop" }),
	]);

	const settingsManager = SettingsManager.inMemory({
		compaction: { enabled: false },
		retry: { enabled: false },
	});
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		additionalExtensionPaths: parsed.extensions,
		noSkills: parsed.noSkills,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		systemPrompt: parsed.systemPrompt,
		appendSystemPrompt: parsed.appendSystemPrompts,
	});

	try {
		await loader.reload();
		const created = await createAgentSession({
			cwd,
			agentDir,
			model,
			modelRegistry: createModelRegistry(model),
			resourceLoader: loader,
			sessionManager: createSessionManager(parsed, cwd),
			settingsManager,
			tools: parsed.tools,
		});
		session = created.session;

		session.subscribe((event) => {
			if (
				event.type === "message_end"
				|| event.type === "tool_execution_start"
				|| event.type === "tool_execution_end"
				|| event.type === "tool_result_end"
			) {
				process.stdout.write(`${JSON.stringify(event)}\n`);
			}
		});

		await session.bindExtensions({});
		await session.prompt(parsed.prompt ?? "", { expandPromptTemplates: false });
		await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		session.dispose();
	} finally {
		faux.unregister();
		if (ownedAgentDir) rmSync(ownedAgentDir, { recursive: true, force: true });
	}
}

main().catch((error) => {
	process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
	process.exit(1);
});
