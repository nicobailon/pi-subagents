import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { validateToolArguments } from "@earendil-works/pi-ai";
import registerSubagentExtension from "../../src/extension/index.ts";
import { PI_CODING_AGENT_PACKAGE_ROOT_ENV } from "../../src/shared/utils.ts";
import { resolvePiPackageRoot } from "../../src/runs/shared/pi-spawn.ts";

type Handler = (event: any, context: any) => any;
type Tool = { name: string; description?: string; promptSnippet?: string; parameters?: unknown; execute?: (...args: any[]) => any };

const runtimes: Array<{ handlers: Map<string, Handler[]>; context: any }> = [];

type RuntimeOptions = { config?: Record<string, unknown>; model?: unknown };
const DYNAMIC: RuntimeOptions = { config: { toolActivation: "dynamic" } };

function createRuntime(messages: any[] = [], excluded: string[] = [], missingApis: string[] = [], options: RuntimeOptions = {}) {
	const handlers = new Map<string, Handler[]>();
	const tools = new Map<string, Tool>();
	let activeNames = ["read"];
	const excludedNames = new Set(excluded);
	const missingApiNames = new Set(missingApis);
	const pi = new Proxy({
		events: { on() { return () => {}; }, emit() {} },
		on(name: string, handler: Handler) {
			const registered = handlers.get(name) ?? [];
			registered.push(handler);
			handlers.set(name, registered);
		},
		registerTool(tool: Tool) {
			tools.set(tool.name, tool);
			if (!excludedNames.has(tool.name)) activeNames = [...new Set([...activeNames, tool.name])];
		},
		getAllTools() {
			return [...tools.values()].filter((tool) => !excludedNames.has(tool.name));
		},
		getActiveTools() { return [...activeNames]; },
		setActiveTools(names: string[]) {
			const available = new Set([...tools.keys(), "read"].filter((name) => !excludedNames.has(name)));
			activeNames = [...new Set(names.filter((name) => available.has(name)))];
		},
		registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {}, sendMessage() {}, getSessionName() {},
	}, { get(target, property) {
		if (missingApiNames.has(String(property))) return undefined;
		return property in target ? target[property as keyof typeof target] : () => undefined;
	} });
	const context = {
		cwd: process.cwd(), hasUI: false, model: options.model as any,
		ui: { setWidget() {}, theme: { fg(_name: string, text: string) { return text; }, bg(_name: string, text: string) { return text; }, bold(text: string) { return text; } } },
		sessionManager: {
			getSessionId() { return "activation-session"; }, getSessionFile() { return null; }, getEntries() { return []; },
			buildSessionContext() { return { messages }; },
		},
		modelRegistry: { getAvailable() { return []; } },
	};
	const childEnv = process.env.PI_SUBAGENT_CHILD;
	const priorAgentDir = process.env.PI_CODING_AGENT_DIR;
	const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "tool-activation-agent-"));
	if (options.config) {
		fs.mkdirSync(path.join(agentDir, "extensions", "subagent"), { recursive: true });
		fs.writeFileSync(path.join(agentDir, "extensions", "subagent", "config.json"), JSON.stringify(options.config));
	}
	process.env.PI_CODING_AGENT_DIR = agentDir;
	delete process.env.PI_SUBAGENT_CHILD;
	try {
		registerSubagentExtension(pi as any);
	} finally {
		if (childEnv === undefined) delete process.env.PI_SUBAGENT_CHILD;
		else process.env.PI_SUBAGENT_CHILD = childEnv;
		if (priorAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = priorAgentDir;
	}
	runtimes.push({ handlers, context });
	return {
		handlers, tools, context,
		active: () => [...activeNames],
		select: (names: string[]) => { activeNames = [...names]; },
		async emit(name: string, event: any) {
			for (const handler of handlers.get(name) ?? []) await handler(event, context);
		},
	};
}

afterEach(async () => {
	for (const runtime of runtimes.splice(0)) {
		for (const handler of runtime.handlers.get("session_shutdown") ?? []) await handler({ type: "session_shutdown", reason: "quit" }, runtime.context);
	}
});

describe("subagent tool activation", () => {
	it("keeps subagent eager unless the host provides the complete dynamic-tool API", async () => {
		for (const missing of ["getAllTools", "getActiveTools", "setActiveTools"]) {
			const runtime = createRuntime([], [], [missing], DYNAMIC);
			await runtime.emit("session_start", { type: "session_start", reason: "startup" });
			assert.ok(runtime.active().includes("subagent"), `${missing} must fail closed to eager subagent`);
			assert.equal(runtime.tools.has("subagents_enable"), false);
		}
	});

	it("starts fresh parents with a compact self-service loader and keeps support tools active", async () => {
		const runtime = createRuntime([], [], [], DYNAMIC);
		await runtime.emit("session_start", { type: "session_start", reason: "startup" });

		assert.equal(runtime.active().includes("subagent"), false);
		assert.ok(runtime.active().includes("subagents_enable"));
		assert.ok(runtime.active().includes("bg_wait"));
		assert.ok(runtime.active().includes("subagent_supervisor"));
		const loader = runtime.tools.get("subagents_enable");
		assert.ok(loader);
		assert.match(loader.description ?? "", /current request|applicable .*instructions/i);
		assert.deepEqual(validateToolArguments(loader as never, { type: "toolCall", id: "call-1", name: "subagents_enable", arguments: { action: "enable" } }), { action: "enable" });

		const result = await loader.execute?.("enable", {}, new AbortController().signal, undefined, runtime.context);
		assert.notEqual(result?.isError, true);
		assert.ok(runtime.active().includes("subagent"));
		assert.ok(runtime.active().includes("read"));
		const enabled = runtime.active();
		await loader.execute?.("enable-again", {}, new AbortController().signal, undefined, runtime.context);
		assert.deepEqual(runtime.active(), enabled);
	});

	it("restores native cold and warm transcript selections across start, reload, and tree navigation", async () => {
		const tool = { name: "subagent", description: "historical", parameters: { type: "object" } };
		const history = [{ role: "system", content: "", toolsAdded: [], timestamp: 1 }];
		const cold = createRuntime(history, [], [], DYNAMIC);
		await cold.emit("session_start", { type: "session_start", reason: "reload" });
		assert.equal(cold.active().includes("subagent"), false);
		await cold.emit("session_tree", { type: "session_tree", newLeafId: null, oldLeafId: null });
		assert.equal(cold.active().includes("subagent"), false);
		history.push({ role: "system", content: "", toolsAdded: [tool], timestamp: 2 });
		await cold.emit("session_tree", { type: "session_tree", newLeafId: null, oldLeafId: null });
		assert.ok(cold.active().includes("subagent"));

		const warm = createRuntime([{ role: "system", content: "", toolsAdded: [tool], timestamp: 1 }], [], [], DYNAMIC);
		await warm.emit("session_start", { type: "session_start", reason: "resume" });
		assert.ok(warm.active().includes("subagent"));
		assert.ok(warm.active().includes("subagents_enable"));
	});

	it("keeps eager compatibility for legacy history and when the loader is restricted", async () => {
		const legacy = createRuntime([{ role: "user", content: "continue", timestamp: 1 }], [], [], DYNAMIC);
		await legacy.emit("session_start", { type: "session_start", reason: "startup" });
		assert.ok(legacy.active().includes("subagent"));
		assert.ok(legacy.active().includes("subagents_enable"));

		const restricted = createRuntime([], ["subagents_enable"], [], DYNAMIC);
		await restricted.emit("session_start", { type: "session_start", reason: "startup" });
		assert.ok(restricted.active().includes("subagent"));
		assert.equal(restricted.active().includes("subagents_enable"), false);
	});

	it("does not activate delegation from prompt keywords and reports an unavailable target", async () => {
		const runtime = createRuntime([], [], [], DYNAMIC);
		await runtime.emit("session_start", { type: "session_start", reason: "startup" });
		runtime.select(["read"]);
		const selectedTools = runtime.active();
		await runtime.emit("before_agent_start", {
			type: "before_agent_start", prompt: "delegate this complex task", systemPrompt: "base",
			systemPromptOptions: { selectedTools, sections: {}, promptGuidelines: [] },
		});
		assert.equal(runtime.active().includes("subagent"), false);
		assert.ok(runtime.active().includes("subagents_enable"));
		assert.ok(selectedTools.includes("subagents_enable"));
		const defaultSelectionEvent = {
			type: "before_agent_start", prompt: "continue", systemPrompt: "base",
			systemPromptOptions: { selectedTools: runtime.active(), sections: {}, promptGuidelines: [] },
		};
		await runtime.emit("before_agent_start", defaultSelectionEvent);
		assert.ok(defaultSelectionEvent.systemPromptOptions.selectedTools?.includes("read"));
		assert.ok(defaultSelectionEvent.systemPromptOptions.selectedTools?.includes("subagents_enable"));

		(runtime.tools as Map<string, Tool>).delete("subagent");
		const loader = runtime.tools.get("subagents_enable");
		const result = await loader?.execute?.("missing", {}, new AbortController().signal, undefined, runtime.context);
		assert.equal(result?.isError, true);
		assert.match(result?.content?.[0]?.text ?? "", /unavailable.*subagent/i);
	});
});

describe("host dynamic tool support detection", () => {
	it("activates the loader on an in-process host with no Pi package root evidence", async () => {
		const prior = process.env[PI_CODING_AGENT_PACKAGE_ROOT_ENV];
		const priorPiPackageDir = process.env.PI_PACKAGE_DIR;
		delete process.env[PI_CODING_AGENT_PACKAGE_ROOT_ENV];
		delete process.env.PI_PACKAGE_DIR;
		try {
			assert.equal(resolvePiPackageRoot(), undefined, "the test process must not look like a running host package");
			const runtime = createRuntime([], [], [], DYNAMIC);
			await runtime.emit("session_start", { type: "session_start", reason: "startup" });
			assert.ok(runtime.tools.has("subagents_enable"));
			assert.equal(runtime.active().includes("subagent"), false);
		} finally {
			if (prior !== undefined) process.env[PI_CODING_AGENT_PACKAGE_ROOT_ENV] = prior;
			if (priorPiPackageDir !== undefined) process.env.PI_PACKAGE_DIR = priorPiPackageDir;
		}
	});
});

const tool = (name: string) => ({ name, description: name, parameters: { type: "object" } });
const selection = (added: string[], removed: string[] = [], timestamp = 1) => ({
	role: "system", content: "", toolsAdded: added.map(tool), ...(removed.length ? { toolsRemoved: removed.map((name) => ({ name })) } : {}), timestamp,
});
const model = (api: string, compat?: Record<string, boolean>) => ({ id: "m", provider: "p", api, ...(compat ? { compat } : {}) });
const COMPATIBLE = model("anthropic-messages", { supportsMidConvoSystemMessages: true, supportsMidConvoToolChanges: true });
const INCOMPATIBLE = model("openai-completions", { supportsMidConvoSystemMessages: false, supportsMidConvoToolAdditions: true });

async function startAgent(runtime: ReturnType<typeof createRuntime>) {
	const event = {
		type: "before_agent_start", prompt: "continue", systemPrompt: "base",
		systemPromptOptions: { selectedTools: runtime.active(), sections: {}, promptGuidelines: [] },
	};
	await runtime.emit("before_agent_start", event);
	return event.systemPromptOptions.selectedTools;
}

describe("toolActivation modes", () => {
	it("defaults to auto and starts a new session with subagent active when the model cannot add tools mid-conversation", async () => {
		for (const options of [{}, { config: { toolActivation: "auto" } }, { model: INCOMPATIBLE }]) {
			const runtime = createRuntime([], [], [], options);
			await runtime.emit("session_start", { type: "session_start", reason: "startup" });
			assert.ok(runtime.tools.has("subagents_enable"), "auto keeps the loader registered");
			const first = await startAgent(runtime);
			assert.ok(first.includes("subagent"));
			assert.equal(first.includes("subagents_enable"), false);
			assert.ok(first.includes("read"));
			assert.ok(first.includes("bg_wait"));
			const selected = runtime.active();
			assert.ok(selected.includes("subagent"));
			assert.equal(selected.includes("subagents_enable"), false);
			for (let turn = 0; turn < 3; turn++) {
				assert.deepEqual(await startAgent(runtime), selected);
				assert.deepEqual(runtime.active(), selected);
			}
			// A later model switch does not change the session's tools.
			runtime.context.model = COMPATIBLE;
			await runtime.emit("model_select", { type: "model_select", model: COMPATIBLE, previousModel: undefined, source: "set" });
			assert.deepEqual(await startAgent(runtime), selected);
		}
	});

	it("starts with the loader in auto when the model can add tools mid-conversation", async () => {
		const runtime = createRuntime([], [], [], { model: COMPATIBLE });
		await runtime.emit("session_start", { type: "session_start", reason: "startup" });
		assert.equal(runtime.active().includes("subagent"), false);
		runtime.select(["read"]);
		const selectedTools = await startAgent(runtime);
		assert.ok(selectedTools.includes("subagents_enable"));
		assert.ok(runtime.active().includes("subagents_enable"));
		assert.equal(runtime.active().includes("subagent"), false);
		const result = await runtime.tools.get("subagents_enable")?.execute?.("enable", {}, new AbortController().signal, undefined, runtime.context);
		assert.notEqual(result?.isError, true);
		assert.ok(runtime.active().includes("subagent"));
	});

	it("applies the per-API capability rule", async () => {
		const system = { supportsMidConvoSystemMessages: true };
		const all = { ...system, supportsMidConvoToolChanges: true, supportsMidConvoToolAdditions: true, supportsAdditionalTools: true, supportsToolSearch: true };
		const cases: Array<[string, unknown, boolean]> = [
			["undefined model", undefined, false],
			["model without compat", model("anthropic-messages"), false],
			["anthropic", model("anthropic-messages", { ...system, supportsMidConvoToolChanges: true }), true],
			["anthropic, system false", model("anthropic-messages", { supportsMidConvoSystemMessages: false, supportsMidConvoToolChanges: true }), false],
			["anthropic, system unset", model("anthropic-messages", { supportsMidConvoToolChanges: true }), false],
			["anthropic, tool changes unset", model("anthropic-messages", system), false],
			["anthropic, wrong flag", model("anthropic-messages", { ...system, supportsMidConvoToolAdditions: true }), false],
			["completions", model("openai-completions", { ...system, supportsMidConvoToolAdditions: true }), true],
			["completions, system false", model("openai-completions", { supportsMidConvoSystemMessages: false, supportsMidConvoToolAdditions: true }), false],
			["completions, wrong flag", model("openai-completions", { ...system, supportsMidConvoToolChanges: true }), false],
			["responses, additional tools", model("openai-responses", { ...system, supportsAdditionalTools: true }), true],
			["responses, tool search", model("openai-responses", { ...system, supportsToolSearch: true }), true],
			["responses, neither", model("openai-responses", system), false],
			["responses, system false", model("openai-responses", { supportsMidConvoSystemMessages: false, supportsAdditionalTools: true }), false],
			["codex responses", model("openai-codex-responses", { ...system, supportsToolSearch: true }), true],
			["codex responses, neither", model("openai-codex-responses", system), false],
			["azure responses", model("azure-openai-responses", { ...system, supportsAdditionalTools: true }), true],
			["azure responses, neither", model("azure-openai-responses", system), false],
			["other api", model("google-generative-ai", all), false],
		];
		for (const [label, caseModel, compatible] of cases) {
			const runtime = createRuntime([], [], [], { model: caseModel });
			await runtime.emit("session_start", { type: "session_start", reason: "startup" });
			await startAgent(runtime);
			assert.equal(runtime.active().includes("subagents_enable"), compatible, `${label}: loader`);
			assert.equal(runtime.active().includes("subagent"), !compatible, `${label}: subagent`);
		}
	});

	it("keeps today's loader behavior for explicit dynamic, whatever the model", async () => {
		const runtime = createRuntime([], [], [], { ...DYNAMIC, model: INCOMPATIBLE });
		await runtime.emit("session_start", { type: "session_start", reason: "startup" });
		await startAgent(runtime);
		assert.ok(runtime.active().includes("subagents_enable"));
		assert.equal(runtime.active().includes("subagent"), false);

		const recordedEager = createRuntime([selection(["read", "subagent"])], [], [], { ...DYNAMIC, model: INCOMPATIBLE });
		await recordedEager.emit("session_start", { type: "session_start", reason: "resume" });
		assert.ok((await startAgent(recordedEager)).includes("subagents_enable"));
		assert.ok(recordedEager.active().includes("subagent"));
	});

	it("registers no loader for explicit eager, even with a capable model or recorded loader history", async () => {
		for (const messages of [[], [selection(["read", "subagents_enable"])]]) {
			const runtime = createRuntime(messages, [], [], { config: { toolActivation: "eager" }, model: COMPATIBLE });
			await runtime.emit("session_start", { type: "session_start", reason: "resume" });
			assert.equal(runtime.tools.has("subagents_enable"), false);
			const selectedTools = await startAgent(runtime);
			assert.ok(selectedTools.includes("subagent"));
			assert.equal(selectedTools.includes("subagents_enable"), false);
			assert.ok(runtime.active().includes("bg_wait"));
		}
	});

	it("replays recorded cold, warm, and eager sessions in auto without adding or removing tools", async () => {
		const cases: Array<[string, any[], string[]]> = [
			["cold", [selection(["read", "subagents_enable"])], ["subagents_enable"]],
			["warm", [selection(["read", "subagents_enable"]), selection(["subagent"], [], 2)], ["subagents_enable", "subagent"]],
			["eager", [selection(["read", "subagent"])], ["subagent"]],
			["eager, then subagent removed", [selection(["read", "subagent"]), selection([], ["subagent"], 2)], []],
			["loader removed", [selection(["read", "subagents_enable", "subagent"]), selection([], ["subagents_enable"], 2)], ["subagent"]],
		];
		for (const caseModel of [COMPATIBLE, INCOMPATIBLE, undefined]) {
			for (const [label, messages, expected] of cases) {
				const runtime = createRuntime(messages, [], [], { model: caseModel });
				for (const event of [
					{ type: "session_start", reason: "resume" },
					{ type: "session_start", reason: "reload" },
					{ type: "session_tree", newLeafId: null, oldLeafId: null },
				]) {
					await runtime.emit(event.type, event);
					for (let turn = 0; turn < 2; turn++) {
						const selectedTools = await startAgent(runtime);
						const active = runtime.active();
						for (const name of ["subagents_enable", "subagent"]) {
							assert.equal(active.includes(name), expected.includes(name), `${label} (${caseModel?.api ?? "no model"}) ${event.type}: ${name}`);
							assert.equal(selectedTools.includes(name), expected.includes(name), `${label} selectedTools: ${name}`);
						}
						assert.ok(active.includes("read"));
					}
				}
			}
		}
	});

	it("keeps legacy undeclared history eager with the loader in auto", async () => {
		const legacy = createRuntime([{ role: "user", content: "continue", timestamp: 1 }], [], [], { model: INCOMPATIBLE });
		await legacy.emit("session_start", { type: "session_start", reason: "resume" });
		await startAgent(legacy);
		assert.ok(legacy.active().includes("subagent"));
		assert.ok(legacy.active().includes("subagents_enable"));
	});

	it("rejects an unknown toolActivation value instead of falling back", () => {
		assert.throws(() => createRuntime([], [], [], { config: { toolActivation: "lazy" } }), /config\.toolActivation must be "auto", "dynamic", or "eager"/);
	});
});
