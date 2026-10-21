import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { toToolDeclaration, validateToolArguments } from "@earendil-works/pi-ai";
import { ensureSupervisorChannelDir, registerNativeSupervisorClient, resolveSupervisorChannelDir, TOP_LEVEL_SUPERVISOR_REFUSAL } from "../../src/intercom/native-supervisor-channel.ts";
import registerSubagentExtension from "../../src/extension/index.ts";
import { PI_CODING_AGENT_PACKAGE_ROOT_ENV } from "../../src/shared/utils.ts";
import { resolvePiPackageRoot } from "../../src/runs/shared/pi-spawn.ts";
import { registerBackgroundWorkProvider } from "../../src/api/background-work.ts";

type Handler = (event: any, context: any) => any;
type Tool = { name: string; description?: string; promptSnippet?: string; parameters?: unknown; execute?: (...args: any[]) => any; sourceInfo?: { path: string } };

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
			return [...tools.values()].filter((tool) => !excludedNames.has(tool.name)).map((tool) => ({ sourceInfo: { path: "pi-subagents" }, ...tool }));
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
		cwd: process.cwd(), isIdle() { return false; }, hasUI: false, model: options.model as any,
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
	it("starts fresh parents with a compact self-service loader and declares bg_wait and subagent_supervisor only with subagent", async () => {
		const runtime = createRuntime([], [], [], DYNAMIC);
		await runtime.emit("session_start", { type: "session_start", reason: "startup" });

		assert.equal(runtime.active().includes("subagent"), false);
		assert.ok(runtime.active().includes("subagents_enable"));
		assert.equal(runtime.active().includes("bg_wait"), false);
		assert.equal(runtime.active().includes("subagent_supervisor"), false);
		const loader = runtime.tools.get("subagents_enable");
		assert.ok(loader);
		assert.match(loader.description ?? "", /current request|applicable .*instructions/i);
		assert.deepEqual(validateToolArguments(loader as never, { type: "toolCall", id: "call-1", name: "subagents_enable", arguments: { action: "enable" } }), { action: "enable" });

		const result = await loader.execute?.("enable", {}, new AbortController().signal, undefined, runtime.context);
		assert.notEqual(result?.isError, true);
		assert.ok(runtime.active().includes("subagent"));
		assert.ok(runtime.active().includes("subagent_supervisor"));
		assert.ok(runtime.active().includes("bg_wait"));
		assert.ok(runtime.active().includes("read"));
		const enabled = runtime.active();
		await loader.execute?.("enable-again", {}, new AbortController().signal, undefined, runtime.context);
		assert.deepEqual(runtime.active(), enabled);
	});

	it("restores native cold and warm transcript selections across start, reload, and tree navigation", async () => {
		const tool = { name: "subagent", description: "historical", parameters: { type: "object" } };
		const history = [{ role: "system", content: "", toolsAdded: [], timestamp: 1 }];
		const cold = createRuntime(history, [], [], DYNAMIC);
		// Real Pi restores the session's tool state on start; a cold transcript restores loader only.
		cold.select(["read", "subagents_enable"]);
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
		assert.ok(legacy.active().includes("bg_wait"));

		const restricted = createRuntime([], ["subagents_enable"], [], DYNAMIC);
		await restricted.emit("session_start", { type: "session_start", reason: "startup" });
		assert.ok(restricted.active().includes("subagent"));
		assert.ok(restricted.active().includes("bg_wait"));
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
const declared = (added: string[], removed: string[] = []) => ({
	role: "system", content: "", toolsAdded: added.map(tool), ...(removed.length ? { toolsRemoved: removed.map((name) => ({ name })) } : {}), timestamp: 1,
});
const model = (api: string, compat?: Record<string, boolean>) => ({ id: "m", provider: "p", api, compat });
const system = { supportsMidConvoSystemMessages: true };
const COMPATIBLE = model("anthropic-messages", { ...system, supportsMidConvoToolChanges: true });
const INCOMPATIBLE = model("openai-completions", { supportsMidConvoToolAdditions: true });

async function startAgent(runtime: ReturnType<typeof createRuntime>): Promise<string[]> {
	const event = {
		type: "before_agent_start", prompt: "continue", systemPrompt: "base",
		systemPromptOptions: { selectedTools: runtime.active(), sections: {}, promptGuidelines: [] },
	};
	await runtime.emit("before_agent_start", event);
	return event.systemPromptOptions.selectedTools;
}

type Runtime = ReturnType<typeof createRuntime>;
// A compaction that kept no tool checkpoint, placed as Pi's buildSessionContext places it: first, with no system message before it.
const compacted = { role: "compactionSummary", summary: "", tokensBefore: 0, timestamp: 0 };
const other = declared(["read", "other_extension_tool"]);
const OWNED = ["subagents_enable", "subagent", "contact_supervisor", "bg_wait"];
const RESUME = { type: "session_start", reason: "resume" };
const RELOAD = { type: "session_start", reason: "reload" };
const TREE = { type: "session_tree", newLeafId: null, oldLeafId: null };
// The host's live set before a replay: /reload activates every extension tool; resume and session_tree restore the transcript's tools.
const allOn = (runtime: Runtime) => runtime.select(["read", ...runtime.tools.keys()]);
const replays = (current: string[]): Array<[string, (runtime: Runtime) => void, { type: string }]> => [
	["resume", (runtime) => runtime.select(["read", ...current]), RESUME],
	["reload", allOn, RELOAD],
	["tree", (runtime) => runtime.select(["read", ...current]), TREE],
];

// Asserts what the replay applied, then that before_agent_start declares the same.
async function assertOwned(runtime: Runtime, label: string, expected: Record<string, boolean>): Promise<void> {
	const active = runtime.active();
	for (const [name, on] of Object.entries(expected)) assert.equal(active.includes(name), on, `${label}: active ${name}`);
	const selectedTools = await startAgent(runtime);
	for (const [name, on] of Object.entries(expected)) assert.equal(selectedTools.includes(name), on, `${label}: ${name}`);
}

async function replayAll(messages: any[], options: RuntimeOptions, current: string[], label: string, expected: Record<string, boolean>): Promise<void> {
	const runtime = createRuntime(messages, [], [], options);
	for (const [event, prepare, payload] of replays(current)) {
		prepare(runtime);
		await runtime.emit(payload.type, payload);
		await assertOwned(runtime, `${label}, ${(options.model as { api?: string } | undefined)?.api}, ${event}`, expected);
	}
}

describe("toolActivation modes", () => {
	it("defaults to auto, which starts a new session with subagent and no loader when the model cannot add tools", async () => {
		for (const options of [{}, { config: { toolActivation: "auto" }, model: INCOMPATIBLE }]) {
			const runtime = createRuntime([], [], [], options);
			await runtime.emit("session_start", { type: "session_start", reason: "startup" });
			const first = await startAgent(runtime);
			assert.ok(first.includes("subagent") && first.includes("read"));
			assert.equal(first.includes("subagents_enable"), false);
			// Switching to a capable model mid-session changes nothing.
			runtime.context.model = COMPATIBLE;
			assert.deepEqual(await startAgent(runtime), first);
		}
	});

	it("offers the loader in auto only when the model's API can add tools mid-conversation", async () => {
		const cases: Array<[unknown, boolean]> = [
			[undefined, false],
			[model("anthropic-messages"), false],
			[model("anthropic-messages", { ...system, supportsMidConvoToolChanges: true }), true],
			[model("anthropic-messages", { supportsMidConvoSystemMessages: false, supportsMidConvoToolChanges: true }), false],
			[model("anthropic-messages", { supportsMidConvoToolChanges: true }), false],
			[model("anthropic-messages", system), false],
			[model("openai-completions", { ...system, supportsMidConvoToolAdditions: true }), true],
			[model("openai-completions", { ...system, supportsMidConvoToolChanges: true }), false],
			[model("openai-responses", { ...system, supportsAdditionalTools: true }), true],
			[model("openai-responses", { ...system, supportsToolSearch: true }), true],
			[model("openai-responses", system), false],
			[model("openai-codex-responses", { ...system, supportsToolSearch: true }), true],
			[model("azure-openai-responses", { ...system, supportsAdditionalTools: true }), true],
			[model("google-generative-ai", { ...system, supportsMidConvoToolChanges: true, supportsMidConvoToolAdditions: true, supportsAdditionalTools: true }), false],
		];
		for (const [caseModel, compatible] of cases) {
			const runtime = createRuntime([], [], [], { model: caseModel });
			await runtime.emit("session_start", { type: "session_start", reason: "startup" });
			const selectedTools = await startAgent(runtime);
			assert.equal(selectedTools.includes("subagents_enable"), compatible, JSON.stringify(caseModel));
			assert.equal(selectedTools.includes("subagent"), !compatible, JSON.stringify(caseModel));
		}
	});

	it("always offers the loader in dynamic, even to a recorded session without it", async () => {
		for (const messages of [[], [declared(["read", "subagent"])]]) {
			const runtime = createRuntime(messages, [], [], { ...DYNAMIC, model: INCOMPATIBLE });
			await runtime.emit("session_start", { type: "session_start", reason: "resume" });
			assert.ok((await startAgent(runtime)).includes("subagents_enable"));
			assert.equal(runtime.active().includes("subagent"), messages.length > 0);
		}
	});

	it("registers no loader in eager, even with a capable model or recorded loader history", async () => {
		for (const messages of [[], [declared(["read", "subagents_enable"])]]) {
			const runtime = createRuntime(messages, [], [], { config: { toolActivation: "eager" }, model: COMPATIBLE });
			await runtime.emit("session_start", { type: "session_start", reason: "resume" });
			assert.equal(runtime.tools.has("subagents_enable"), false);
			const selectedTools = await startAgent(runtime);
			assert.ok(selectedTools.includes("bg_wait"));
			assert.ok(selectedTools.includes("subagent"));
			assert.equal(selectedTools.includes("subagents_enable"), false);
		}
	});

	it("replays recorded sessions in auto without adding or removing tools, whatever the model", async () => {
		const cases: Array<[string, any[], string[]]> = [
			["cold", [declared(["read", "subagents_enable"])], ["subagents_enable"]],
			["warm", [declared(["read", "subagents_enable"]), declared(["subagent"])], ["subagents_enable", "subagent"]],
			["eager", [declared(["read", "subagent"])], ["subagent"]],
			["loader removed", [declared(["read", "subagents_enable", "subagent"]), declared([], ["subagents_enable"])], ["subagent"]],
			["legacy", [{ role: "user", content: "continue", timestamp: 1 }], ["subagents_enable", "subagent"]],
		];
		for (const caseModel of [COMPATIBLE, INCOMPATIBLE]) {
			for (const [label, messages, expected] of cases) {
				const runtime = createRuntime(messages, [], [], { model: caseModel });
				for (const event of [
					{ type: "session_start", reason: "resume" },
					{ type: "session_start", reason: "reload" },
					{ type: "session_tree", newLeafId: null, oldLeafId: null },
				]) {
					await runtime.emit(event.type, event);
					const selectedTools = await startAgent(runtime);
					for (const name of ["subagents_enable", "subagent"]) {
						assert.equal(selectedTools.includes(name), expected.includes(name), `${label}, ${caseModel.api}, ${event.type}: ${name}`);
						assert.equal(runtime.active().includes(name), expected.includes(name), `${label}, ${caseModel.api}, ${event.type}: active ${name}`);
					}
				}
			}
		}
	});

	it("keeps the selection from before an extension unload when the session starts again", async () => {
		const extensionTools = ["bg_wait", "subagent_supervisor"];
		const unload = (names: string[]) => declared([], [...names, ...extensionTools]);
		const cases: Array<[string, RuntimeOptions, any[], string[]]> = [
			["warm unload", {}, [declared(["read", "subagent", "contact_supervisor", ...extensionTools]), unload(["subagent", "contact_supervisor"])], ["subagent"]],
			["warm unload, support tools re-added", {}, [declared(["read", "subagent", ...extensionTools]), unload(["subagent"]), declared(extensionTools)], ["subagent"]],
			["cold unload", {}, [declared(["read", "subagents_enable", ...extensionTools]), unload(["subagents_enable"])], ["subagents_enable"]],
			["dynamic warm unload", DYNAMIC, [declared(["read", "subagent", ...extensionTools]), unload(["subagent"])], ["subagents_enable", "subagent"]],
			["deliberate removal", {}, [declared(["read", "subagent", ...extensionTools]), declared([], ["subagent", "contact_supervisor"])], []],
			["bg_wait redefined", {}, [declared(["read", "subagent", ...extensionTools]), declared(["bg_wait"], ["subagent", "bg_wait"])], []],
		];
		for (const [label, options, messages, expected] of cases) {
			const runtime = createRuntime(messages, [], [], { ...options, model: COMPATIBLE });
			await runtime.emit("session_start", { type: "session_start", reason: "reload" });
			const selectedTools = await startAgent(runtime);
			for (const name of ["subagents_enable", "subagent"]) assert.equal(selectedTools.includes(name), expected.includes(name), `${label}: ${name}`);
		}
	});

	it("brings back the extension's tools an unload left off when a new process restores the transcript", async () => {
		const extensionTools = ["subagent", "contact_supervisor", "bg_wait", "subagent_supervisor"];
		// A new process (`pi --continue`) starts with the transcript's tools, which the unload left without this extension's.
		const restart = async (messages: any[], excluded: string[] = [], restored = ["read"]) => {
			const runtime = createRuntime(messages, excluded, [], { model: COMPATIBLE });
			runtime.tools.set("plan_tool", { name: "plan_tool", sourceInfo: { path: "other-extension" } });
			runtime.select(restored);
			await runtime.emit("session_start", { type: "session_start", reason: "resume" });
			return runtime;
		};
		const firstUpdate = [declared(["read", "plan_tool", ...extensionTools]), declared([], ["plan_tool", ...extensionTools])];
		const continued = await restart(firstUpdate);
		assert.deepEqual(continued.active().sort(), ["bg_wait", "contact_supervisor", "read", "subagent", "subagent_supervisor"]);

		// The next turn declares what is active; a second update then removes it again.
		const redeclared = continued.active().filter((name) => name !== "read");
		const again = await restart([...firstUpdate, declared(redeclared), declared([], redeclared)]);
		assert.ok(again.active().includes("subagent"), "second update: subagent");
		assert.ok(again.active().includes("bg_wait"), "second update: bg_wait");

		const excluded = await restart(firstUpdate, ["subagent_supervisor"]);
		assert.ok(excluded.active().includes("bg_wait"), "excluded: bg_wait");
		assert.equal(excluded.active().includes("subagent_supervisor"), false, "excluded: subagent_supervisor");

		// Without an unload, the transcript's tools stand: bg_wait was never declared here.
		const unaffected = await restart([declared(["read", "subagent", "contact_supervisor"])], [], ["read", "subagent", "contact_supervisor"]);
		assert.equal(unaffected.active().includes("bg_wait"), false, "unaffected: bg_wait");
		assert.ok(unaffected.active().includes("subagent"), "unaffected: subagent");
	});

	it("decides a session whose activation record a compaction lost as a new session, and honours a later removal", async () => {
		// A compaction without a checkpoint drops the session-start declaration while other extensions'
		// tool-selection messages survive. The activation state is then decided by the new-session rule:
		// eager on a model that cannot add tools (no loader), cold on one that can. A removal recorded after
		// the compaction boundary is honoured.
		const surviving = declared(["read", "other_extension_tool"]);
		const eagerAuto = ["read", "subagent", "contact_supervisor", "bg_wait", "subagent_supervisor"];

		const resumed = createRuntime([compacted, surviving], [], [], { model: INCOMPATIBLE });
		resumed.select(eagerAuto);
		await resumed.emit("session_start", { type: "session_start", reason: "resume" });
		for (const name of eagerAuto) assert.ok(resumed.active().includes(name), `resume: ${name}`);
		assert.equal((await startAgent(resumed)).includes("subagents_enable"), false, "resume: no loader added");

		const coldAuto = createRuntime([compacted, surviving], [], [], { model: COMPATIBLE });
		coldAuto.select(["read", "subagents_enable"]);
		await coldAuto.emit("session_start", { type: "session_start", reason: "resume" });
		assert.equal(coldAuto.active().includes("subagent"), false, "cold: stays cold");
		assert.equal(coldAuto.active().includes("bg_wait"), false, "cold: no bg_wait");
		assert.ok((await startAgent(coldAuto)).includes("subagents_enable"), "cold: loader kept");

		// Synthetic: Pi cannot remove a tool that was never declared. It pins that such a removal is a choice, not an unload.
		const removedAfterCompaction = createRuntime([compacted, surviving, declared([], ["subagent", "contact_supervisor"])], [], [], { model: INCOMPATIBLE });
		removedAfterCompaction.select(["read"]);
		await removedAfterCompaction.emit("session_start", { type: "session_start", reason: "resume" });
		assert.equal(removedAfterCompaction.active().includes("subagent"), false, "removal echo honored");

		const dynamicSession = createRuntime([compacted, surviving], [], [], { ...DYNAMIC, model: INCOMPATIBLE });
		dynamicSession.select(["read", "subagents_enable"]);
		await dynamicSession.emit("session_start", { type: "session_start", reason: "resume" });
		assert.equal(dynamicSession.active().includes("subagent"), false, "dynamic: stays off");
		assert.ok((await startAgent(dynamicSession)).includes("subagents_enable"), "dynamic: loader kept");
	});

	it("re-decides the activation state a compaction lost, whatever other tools survive", async () => {
		// The loader's declaration is compacted away, then a background-work provider declares bg_wait.
		const messages = [compacted, other, declared(["bg_wait"])];
		const dispose = registerBackgroundWorkProvider({ name: "tool-activation-lost-loader", listActiveWork: () => [] });
		try {
			await replayAll(messages, { model: COMPATIBLE }, ["other_extension_tool", "bg_wait"], "lost cold",
				{ subagents_enable: true, subagent: false, contact_supervisor: false, bg_wait: true, subagent_supervisor: false });
			await replayAll(messages, { model: INCOMPATIBLE }, ["other_extension_tool", "bg_wait"], "lost eager",
				{ subagents_enable: false, subagent: true, contact_supervisor: true, bg_wait: true, subagent_supervisor: true });
		} finally {
			dispose();
		}
	});

	it("treats a compaction that kept a tool checkpoint as an intact transcript", async () => {
		// guard: the checkpoint system message precedes the summary and re-declares the active tools.
		const messages = [declared(["read", "other_extension_tool"]), compacted, declared(["bg_wait"])];
		for (const caseModel of [COMPATIBLE, INCOMPATIBLE]) {
			await replayAll(messages, { model: caseModel }, ["other_extension_tool", "bg_wait"], "checkpointed",
				{ subagents_enable: false, subagent: false, contact_supervisor: false, bg_wait: true });
		}
		await replayAll([declared(["read", "subagents_enable"]), compacted, declared(["bg_wait"])], { model: COMPATIBLE }, ["subagents_enable", "bg_wait"], "checkpointed cold",
			{ subagents_enable: true, subagent: false, bg_wait: true });
	});

	it("keeps the loader of a lost activation state across an unload recorded after the compaction", async () => {
		// Both the old and the new unload rule call this an unload; it pins the loader and the bg_wait restore.
		const runtime = createRuntime([compacted, other, declared(["bg_wait", "subagent_supervisor"]), declared([], ["bg_wait", "subagent_supervisor"])], [], [], { model: COMPATIBLE });
		runtime.select(["read"]);
		await runtime.emit(RESUME.type, RESUME);
		await assertOwned(runtime, "lost unload", { subagents_enable: true, subagent: false, bg_wait: true });
	});

	it("keeps a surviving activation record after a compaction, whatever the model", async () => {
		// guard: the loader and subagent are one activation state; either surviving declares it.
		await replayAll([compacted, declared(["read", "subagents_enable"])], { model: INCOMPATIBLE }, ["subagents_enable"], "lost, loader survives",
			{ subagents_enable: true, subagent: false, contact_supervisor: false, bg_wait: false });
		await replayAll([compacted, declared(["read", "subagent", "contact_supervisor", "bg_wait"])], { model: COMPATIBLE }, ["subagent", "contact_supervisor", "bg_wait"], "lost, subagent survives",
			{ subagents_enable: false, subagent: true, bg_wait: true });
		const enabled = ["subagent", "contact_supervisor", "bg_wait", "subagent_supervisor"];
		const messages = [compacted, other, declared(enabled)];
		for (const caseModel of [COMPATIBLE, INCOMPATIBLE]) {
			await replayAll(messages, { model: caseModel }, ["other_extension_tool", ...enabled], "lost, enable survives",
				{ subagents_enable: false, subagent: true, contact_supervisor: true, bg_wait: true });
		}
		await replayAll(messages, { ...DYNAMIC, model: COMPATIBLE }, ["other_extension_tool", ...enabled], "dynamic, enable survives",
			{ subagents_enable: true, subagent: true });
	});

	it("replays a transcript that never declared this extension's tools without adding them", async () => {
		// The harness starts with every registered tool active, as /reload does.
		const auto = createRuntime([other], [], [], { model: COMPATIBLE });
		await auto.emit(RELOAD.type, RELOAD);
		await assertOwned(auto, "intact, never declared", { subagents_enable: false, subagent: false, bg_wait: false });

		const dynamic = createRuntime([other], [], [], { ...DYNAMIC, model: INCOMPATIBLE });
		await dynamic.emit(RELOAD.type, RELOAD);
		await assertOwned(dynamic, "dynamic, never declared", { subagents_enable: true, subagent: false });
	});

	it("tells an unload from a deliberate removal after a compaction", async () => {
		const removed = createRuntime([compacted, declared(["bg_wait", "subagent", "contact_supervisor"]), declared([], ["subagent", "contact_supervisor"])], [], [], { model: INCOMPATIBLE });
		await removed.emit(RELOAD.type, RELOAD);
		await assertOwned(removed, "deliberate removal", { subagents_enable: false, subagent: false, bg_wait: true });

		const redefined = createRuntime([compacted, other, declared(["subagent", "contact_supervisor", "bg_wait"]), declared(["bg_wait"], ["bg_wait"])], [], [], { model: COMPATIBLE });
		await redefined.emit(RELOAD.type, RELOAD);
		await assertOwned(redefined, "bg_wait redefined", { subagents_enable: false, subagent: true, bg_wait: true });
	});

	it("always offers the loader in dynamic after a compaction", async () => {
		await replayAll([compacted, other, declared(["bg_wait"])], { ...DYNAMIC, model: INCOMPATIBLE }, ["other_extension_tool", "bg_wait"], "dynamic lost",
			{ subagents_enable: true, subagent: false });
		await replayAll([compacted, declared(["read", "subagent", "contact_supervisor"])], { ...DYNAMIC, model: COMPATIBLE }, ["subagent", "contact_supervisor"], "dynamic lost warm",
			{ subagents_enable: true, subagent: true });
	});

	it("leaves the channel's subagent_supervisor off in a lost cold session without a pending request", async () => {
		const runtime = createRuntime([compacted, other, declared(["bg_wait"])], [], [], { model: COMPATIBLE });
		await runtime.emit(RESUME.type, RESUME);
		await assertOwned(runtime, "lost cold", { subagents_enable: true, subagent_supervisor: false });
	});

	it("decides a compacted session's tools from its transcript alone", async () => {
		const unit = ["subagent", "contact_supervisor", "bg_wait", "subagent_supervisor"];
		const scenarios: Array<[string, any[], RuntimeOptions, string[]]> = [
			["lost cold", [compacted, other, declared(["bg_wait"])], { model: COMPATIBLE }, ["other_extension_tool", "bg_wait"]],
			["lost eager", [compacted, other, declared(["bg_wait"])], { model: INCOMPATIBLE }, ["other_extension_tool", "bg_wait"]],
			["checkpointed", [other, compacted, declared(["bg_wait"])], { model: COMPATIBLE }, ["other_extension_tool", "bg_wait"]],
			["checkpointed", [other, compacted, declared(["bg_wait"])], { model: INCOMPATIBLE }, ["other_extension_tool", "bg_wait"]],
			["lost unload", [compacted, other, declared(["bg_wait", "subagent_supervisor"]), declared([], ["bg_wait", "subagent_supervisor"])], { model: COMPATIBLE }, []],
			["lost, loader survives", [compacted, declared(["read", "subagents_enable"])], { model: INCOMPATIBLE }, ["subagents_enable"]],
			["lost, subagent survives", [compacted, declared(["read", "subagent", "contact_supervisor", "bg_wait"])], { model: COMPATIBLE }, ["subagent", "contact_supervisor", "bg_wait"]],
			["lost, enable survives", [compacted, other, declared(unit)], { model: INCOMPATIBLE }, ["other_extension_tool", ...unit]],
			["lost, nothing survives", [compacted, other], { model: INCOMPATIBLE }, []],
			["lost, nothing survives", [compacted, other], { model: COMPATIBLE }, []],
			["lost, no tool selection survives", [compacted, { role: "user", content: "next", timestamp: 0 }], { model: INCOMPATIBLE }, []],
			["lost, no tool selection survives", [compacted, { role: "user", content: "next", timestamp: 0 }], { model: COMPATIBLE }, []],
			["deliberate removal", [compacted, declared(["bg_wait", "subagent", "contact_supervisor"]), declared([], ["subagent", "contact_supervisor"])], { model: INCOMPATIBLE }, ["bg_wait"]],
			["dynamic lost", [compacted, other, declared(["bg_wait"])], { ...DYNAMIC, model: INCOMPATIBLE }, ["other_extension_tool", "bg_wait"]],
			["intact, never declared", [other], { model: COMPATIBLE }, ["other_extension_tool"]],
		];
		const owned = (names: string[]) => {
			// subagent_supervisor follows the live set while subagent is off, so it is compared only with subagent on.
			const compared = names.includes("subagent") ? [...OWNED, "subagent_supervisor"] : OWNED;
			return compared.filter((name) => names.includes(name)).sort();
		};
		for (const [label, messages, options, current] of scenarios) {
			const message = `${label}, ${(options.model as { api: string }).api}`;
			const reloaded = createRuntime(messages, [], [], options);
			await reloaded.emit(RELOAD.type, RELOAD);
			const reloadedActive = owned(reloaded.active());
			const reloadedSelected = owned(await startAgent(reloaded));

			const resumed = createRuntime(messages, [], [], options);
			resumed.select(["read", ...current]);
			await resumed.emit(RESUME.type, RESUME);
			assert.deepEqual(owned(resumed.active()), reloadedActive, `${message}: active`);
			assert.deepEqual(owned(await startAgent(resumed)), reloadedSelected, `${message}: selectedTools`);

			reloaded.select(["read"]);
			await reloaded.emit(TREE.type, TREE);
			assert.deepEqual(owned(reloaded.active()), reloadedActive, `${message}: tree active`);
			assert.deepEqual(owned(await startAgent(reloaded)), reloadedSelected, `${message}: tree selectedTools`);
		}
	});

	it("keeps bg_wait and subagent_supervisor as a resumed transcript recorded them, and recognises an unload without bg_wait", async () => {
		const cases: Array<[string, string[], boolean, boolean]> = [
			["cold, bg_wait only", ["read", "subagents_enable", "bg_wait"], true, false],
			["cold, neither", ["read", "subagents_enable"], false, false],
			["cold, both", ["read", "subagents_enable", "bg_wait", "subagent_supervisor"], true, true],
			["warm, no bg_wait", ["read", "subagent", "contact_supervisor", "subagent_supervisor"], false, true],
		];
		for (const [label, tools, wait, supervisor] of cases) {
			const runtime = createRuntime([declared(tools)], [], [], { model: COMPATIBLE });
			await runtime.emit("session_start", { type: "session_start", reason: "resume" });
			const selected = await startAgent(runtime);
			assert.equal(selected.includes("bg_wait"), wait, `${label}: bg_wait`);
			assert.equal(selected.includes("subagent_supervisor"), supervisor, `${label}: subagent_supervisor`);
		}

		// A cold session that never declared bg_wait: its unload removes the loader, and a new process brings it back.
		const unloaded = createRuntime([declared(["read", "subagents_enable", "subagent_supervisor"]), declared([], ["subagents_enable", "subagent_supervisor"])], [], [], { model: COMPATIBLE });
		unloaded.select(["read"]);
		await unloaded.emit("session_start", { type: "session_start", reason: "resume" });
		assert.ok((await startAgent(unloaded)).includes("subagents_enable"), "unload: loader restored");
		assert.equal(unloaded.active().includes("bg_wait"), false, "unload: bg_wait stays undeclared");
		assert.ok(unloaded.active().includes("subagent_supervisor"), "unload: subagent_supervisor restored");

		const eager = createRuntime([], [], [], { config: { toolActivation: "eager" } });
		await eager.emit("session_start", { type: "session_start", reason: "startup" });
		assert.ok((await startAgent(eager)).includes("subagent_supervisor"), "eager");
	});

	it("declares bg_wait without subagent once a background-work provider is registered", async () => {
		const runtime = createRuntime([], [], [], DYNAMIC);
		await runtime.emit("session_start", { type: "session_start", reason: "startup" });
		assert.equal((await startAgent(runtime)).includes("bg_wait"), false);
		const dispose = registerBackgroundWorkProvider({ name: "tool-activation-test", listActiveWork: () => [] });
		try {
			assert.ok((await startAgent(runtime)).includes("bg_wait"));
			assert.ok(runtime.active().includes("bg_wait"));
			assert.equal(runtime.active().includes("subagent"), false);
		} finally {
			dispose();
		}
	});

	it("rejects an unknown toolActivation value instead of falling back", () => {
		assert.throws(() => createRuntime([], [], [], { config: { toolActivation: "lazy" } }), /config\.toolActivation must be "auto", "dynamic", or "eager"/);
	});

	it("keeps subagent_supervisor declared for a child request already pending when the session starts", async () => {
		const runId = `run-${randomUUID()}`;
		const channelDir = resolveSupervisorChannelDir(runId, "worker", 0);
		ensureSupervisorChannelDir(channelDir);
		const requestId = randomUUID();
		fs.writeFileSync(path.join(channelDir, "requests", `${requestId}.json`), JSON.stringify({
			type: "subagent.supervisor.request", id: requestId, createdAt: Date.now(), reason: "need_decision", message: "Proceed?",
			expectsReply: true, orchestratorSessionId: "activation-session", runId, agent: "worker", childIndex: 0,
		}));
		try {
			const runtime = createRuntime([declared(["read", "subagents_enable", "bg_wait"])], [], [], DYNAMIC);
			await runtime.emit("session_start", { type: "session_start", reason: "resume" });
			assert.ok(runtime.active().includes("subagent_supervisor"));
			assert.equal(runtime.active().includes("subagent"), false);
			// Pi restores a branch's own tools before session_tree; a branch that never had the tool loses it.
			runtime.select(["read", "subagents_enable", "bg_wait"]);
			await runtime.emit("session_tree", { type: "session_tree", newLeafId: null, oldLeafId: null });
			assert.ok(runtime.active().includes("subagent_supervisor"), "branch switch while a reply is owed");
		} finally {
			fs.rmSync(channelDir, { recursive: true, force: true });
		}
	});
});

describe("contact_supervisor in a top-level session", () => {
	it("is declared exactly when subagent is, right after it", async () => {
		const lazy = createRuntime([], [], [], DYNAMIC);
		await lazy.emit("session_start", { type: "session_start", reason: "startup" });
		assert.equal(lazy.active().includes("contact_supervisor"), false);
		await lazy.tools.get("subagents_enable")!.execute?.("enable", {}, new AbortController().signal, undefined, lazy.context);
		assert.equal(lazy.active().indexOf("contact_supervisor"), lazy.active().indexOf("subagent") + 1);

		const eager = createRuntime([], [], [], { config: { toolActivation: "eager" } });
		await eager.emit("session_start", { type: "session_start", reason: "startup" });
		assert.ok((await startAgent(eager)).includes("contact_supervisor"));

		for (const [messages, expected] of [[[declared(["read", "subagents_enable"])], false], [[declared(["read", "subagent"])], true]] as const) {
			const recorded = createRuntime([...messages], [], [], { model: COMPATIBLE });
			await recorded.emit("session_start", { type: "session_start", reason: "resume" });
			assert.equal(recorded.active().includes("contact_supervisor"), expected);
		}
	});

	it("has the declaration a child's working tool has, and a call is an error", async () => {
		const runtime = createRuntime([], [], [], { config: { toolActivation: "eager" } });
		let child: Tool | undefined;
		registerNativeSupervisorClient({ registerTool(tool: Tool) { child = tool; }, getAllTools: () => [] } as never, {
			channelDir: fs.mkdtempSync(path.join(os.tmpdir(), "supervisor-channel-")), runId: "run", agent: "worker", childIndex: 0, orchestratorSessionId: "parent",
		} as never);
		const parent = runtime.tools.get("contact_supervisor");

		assert.ok(parent && child);
		assert.deepEqual(toToolDeclaration(parent as never), toToolDeclaration(child as never));
		assert.equal((parent as { exposure?: string }).exposure, (child as { exposure?: string }).exposure);
		const result = await parent.execute?.("call-1", { reason: "need_decision", message: "?" }, new AbortController().signal, undefined, runtime.context);
		assert.equal(result?.isError, true);
		assert.equal(result?.content[0]?.text, TOP_LEVEL_SUPERVISOR_REFUSAL);
	});
});
