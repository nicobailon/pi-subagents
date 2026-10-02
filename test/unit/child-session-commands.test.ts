import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Type } from "typebox";
import { randomUUID } from "node:crypto";
import { createBashTool, type ExtensionContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createDefaultChildSessionFactory, type ChildSessionLaunch, type PiCodingAgentModule } from "../../src/runs/shared/child-session.ts";
import { supervisorChannelDir } from "../../src/runs/shared/child-tool-plan.ts";
import { evaluateChildToolDiagnostic } from "../../src/runs/shared/child-runtime-config.ts";
import { readChildCommandState } from "../../src/runs/shared/child-commands.ts";

function fakePi(override?: ToolDefinition, commandOverride?: ToolDefinition) {
	const tools = new Map<string, ToolDefinition>();
	let order: string[] = [];
	const pi = {
		createBashTool,
		ModelRuntime: { create: async () => ({}) },
		SettingsManager: { create: () => ({ getTheme: () => "dark", getShellPath: () => undefined, getShellCommandPrefix: () => "printf prefix; " }) },
		DefaultResourceLoader: class {
			result;
			options;
			constructor(options) { this.options = options; }
			async reload() {
				const extensions = [{ path: "/ambient.ts", tools: new Map([...(override ? [["bash", { definition: override }]] as const : []), ...(commandOverride ? [["subagent_command", { definition: commandOverride }]] as const : [])]) }];
				for (const hook of this.options.extensionFactories) {
					const registered = new Map();
					await hook.factory({ registerTool(tool) { registered.set(tool.name, { definition: tool }); } });
					extensions.push({ path: `<inline:${hook.name}>`, tools: registered });
				}
				this.result = this.options.extensionsOverride({ extensions, errors: [], runtime: {} });
				order = this.result.extensions.map((extension) => extension.path);
			}
			getExtensions() { return this.result; }
		},
		SessionManager: { inMemory: () => ({}) },
		createAgentSession: async ({ cwd, resourceLoader }) => {
			for (const extension of resourceLoader.getExtensions().extensions) for (const { definition } of extension.tools.values()) if (!tools.has(definition.name)) tools.set(definition.name, definition);
			if (!tools.has("bash")) tools.set("bash", createBashTool(cwd));
			const ctx = { sessionManager: { getSessionId: () => "child", getSessionFile: () => undefined } } as ExtensionContext;
			return { session: {
				agent: { hasQueuedMessages: () => false },
				bindExtensions: async () => {},
				dispose() {}, extensionRunner: { hasHandlers: () => false }, subscribe: () => () => {},
				prompt: async (text) => { await tools.get("bash")!.execute("command", { command: text, ...(text.includes("sleep") ? { yieldTimeMs: 0 } : {}) }, undefined, undefined, ctx); },
				abort: async () => {}, steer: async () => {}, followUp: async () => {}, messages: [], sessionId: "child",
			} };
		},
	} as unknown as PiCodingAgentModule;
	return { pi, tools, order: () => order };
}
function ctxForTest(): ExtensionContext {
	return { sessionManager: { getSessionId: () => "child", getSessionFile: () => undefined } } as ExtensionContext;
}
function launch(dir: string, runId: string): ChildSessionLaunch {
	return {
		cwd: dir, storage: { kind: "memory" }, tools: ["bash", "subagent_command"], extensionPaths: [], ambientExtensions: true,
		hooks: [{ name: "pi-subagents:prompt-runtime", factory() {} }], noSkills: true, noContextFiles: true,
		runtime: { runId, agent: "worker", childIndex: 0, fanoutChild: false, depth: 1, waitTool: { enabled: false }, fast: false } as ChildSessionLaunch["runtime"],
	};
}

describe("default child factory command integration", () => {
	it("uses the host bash with shell settings and cancels unfinished commands before declaring completion", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-command-factory-"));
		const runId = `factory-${randomUUID()}`;
		const channel = supervisorChannelDir(runId, "worker", 0);
		const fake = fakePi();
		const factory = createDefaultChildSessionFactory({ loadPiCodingAgent: async () => fake.pi });
		try {
			const child = await factory.create(launch(dir, runId));
			assert.equal(fake.tools.has("subagent_command"), true);
			assert.deepEqual(fake.order().slice(0, 2), ["<inline:pi-subagents:prompt-runtime>", "<inline:pi-subagents:commands>"]);
			const result = await fake.tools.get("bash")!.execute("settings", { command: "printf settings" }, undefined, undefined, { sessionManager: { getSessionId: () => "child", getSessionFile: () => undefined } } as ExtensionContext);
			assert.equal(result.content[0].text, "prefixsettings");
			await child.prompt("sleep 10");
			assert.equal(readChildCommandState(channel)?.commands.find((command) => command.toolCallId === "command")?.state, "yielded", "prompt return must not clean up before authoritative settlement");
			await assert.rejects(child.finishCommands!(), /unfinished commands: command/);
			assert.equal(readChildCommandState(channel)?.commands.find((command) => command.toolCallId === "command")?.state, "cancelled");
		} finally { await factory.dispose(); await fs.promises.rm(channel, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
	});

	it("leaves an ambient custom bash backend in control", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-command-override-"));
		const runId = `override-${randomUUID()}`;
		const channel = supervisorChannelDir(runId, "worker", 0);
		const original: ToolDefinition = { ...createBashTool(dir), execute: async () => ({ content: [{ type: "text", text: "custom backend" }], details: undefined }) };
		const fake = fakePi(original);
		const factory = createDefaultChildSessionFactory({ loadPiCodingAgent: async () => fake.pi });
		try {
			const input = launch(dir, runId);
			input.tools = ["bash"];
			const child = await factory.create(input);
			assert.equal(fake.tools.get("bash"), original);
			assert.equal(fake.tools.has("subagent_command"), false, "custom backends must not expose an unusable native controller");
			await child.prompt("custom command");
			assert.equal(readChildCommandState(channel), undefined, "custom backend must not be advertised as a controllable native command");
		} finally { await factory.dispose(); await fs.promises.rm(channel, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
	});
	it("keeps an explicitly required command tool available without claiming control of custom bash", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-command-explicit-override-"));
		const runId = `explicit-override-${randomUUID()}`;
		const channel = supervisorChannelDir(runId, "worker", 0);
		const original: ToolDefinition = { ...createBashTool(dir), execute: async () => ({ content: [{ type: "text", text: "custom backend" }], details: undefined }) };
		const fake = fakePi(original);
		const factory = createDefaultChildSessionFactory({ loadPiCodingAgent: async () => fake.pi });
		const input = launch(dir, runId);
		input.runtime.requiredTools = ["bash", "subagent_command"];
		try {
			const child = await factory.create(input);
			assert.equal(fake.tools.get("bash"), original);
			assert.equal(evaluateChildToolDiagnostic(input.runtime, [...fake.tools.keys()]), undefined);
			const commandTool = fake.tools.get("subagent_command")!;
			assert.match(commandTool.description, /unavailable.*custom bash/);
			await assert.rejects(commandTool.execute("status", { action: "status" }, undefined, undefined, {} as ExtensionContext), /unavailable.*custom bash/);
			await child.prompt("custom command");
			assert.equal(readChildCommandState(channel), undefined);
		} finally { await factory.dispose(); await fs.promises.rm(channel, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
	});

	for (const tools of [undefined, ["bash"]]) {
		it(`does not wrap bash or register command controls without opt-in (${tools ? "explicit bash" : "default tools"})`, async () => {
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-command-disabled-"));
			const runId = `disabled-${randomUUID()}`;
			const channel = supervisorChannelDir(runId, "worker", 0);
			const fake = fakePi();
			const factory = createDefaultChildSessionFactory({ loadPiCodingAgent: async () => fake.pi });
			const input = launch(dir, runId);
			input.tools = tools;
			try {
				await factory.create(input);
				assert.equal(fake.tools.has("subagent_command"), false);
				assert.equal(fake.order().includes("<inline:pi-subagents:commands>"), false);
				assert.equal("yieldTimeMs" in (fake.tools.get("bash")!.parameters as { properties: object }).properties, false);
				const result = await fake.tools.get("bash")!.execute("plain", { command: "printf plain" }, undefined, undefined, ctxForTest());
				assert.equal(result.content[0].text, "plain");
				assert.equal(readChildCommandState(channel), undefined);
			} finally { await factory.dispose(); await fs.promises.rm(channel, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
		});
	}

	it("preserves a custom backend's explicitly required command tool", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-command-collision-"));
		const runId = `collision-${randomUUID()}`;
		const channel = supervisorChannelDir(runId, "worker", 0);
		const original: ToolDefinition = { ...createBashTool(dir), execute: async () => ({ content: [{ type: "text", text: "custom backend" }], details: undefined }) };
		const custom: ToolDefinition = { name: "subagent_command", label: "Custom commands", description: "Custom backend command controls", parameters: Type.Object({ action: Type.String() }), execute: async () => ({ content: [{ type: "text", text: "custom controls" }], details: undefined }) };
		const fake = fakePi(original, custom);
		const factory = createDefaultChildSessionFactory({ loadPiCodingAgent: async () => fake.pi });
		const input = launch(dir, runId);
		input.runtime.requiredTools = ["bash", "subagent_command"];
		try {
			await factory.create(input);
			assert.equal(fake.tools.get("bash"), original);
			assert.equal(fake.tools.get("subagent_command"), custom);
			assert.equal(evaluateChildToolDiagnostic(input.runtime, [...fake.tools.keys()]), undefined);
			assert.equal(readChildCommandState(channel), undefined);
		} finally { await factory.dispose(); await fs.promises.rm(channel, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
	});

});
