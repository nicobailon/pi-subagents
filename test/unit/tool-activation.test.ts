import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import registerSubagentExtension from "../../src/extension/index.ts";

type Handler = (event: any, context: any) => any;
type Tool = { name: string; description?: string; promptSnippet?: string; parameters?: unknown; execute?: (...args: any[]) => any };

const runtimes: Array<{ handlers: Map<string, Handler[]>; context: any }> = [];

function createRuntime(messages: any[] = [], excluded: string[] = []) {
	const handlers = new Map<string, Handler[]>();
	const tools = new Map<string, Tool>();
	let activeNames = ["read"];
	const excludedNames = new Set(excluded);
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
	}, { get(target, property) { return property in target ? target[property as keyof typeof target] : () => undefined; } });
	const context = {
		cwd: process.cwd(), hasUI: false, model: undefined,
		ui: { setWidget() {}, theme: { fg(_name: string, text: string) { return text; }, bg(_name: string, text: string) { return text; }, bold(text: string) { return text; } } },
		sessionManager: {
			getSessionId() { return "activation-session"; }, getSessionFile() { return null; }, getEntries() { return []; },
			buildSessionContext() { return { messages }; },
		},
		modelRegistry: { getAvailable() { return []; } },
	};
	const childEnv = process.env.PI_SUBAGENT_CHILD;
	delete process.env.PI_SUBAGENT_CHILD;
	try {
		registerSubagentExtension(pi as any);
	} finally {
		if (childEnv === undefined) delete process.env.PI_SUBAGENT_CHILD;
		else process.env.PI_SUBAGENT_CHILD = childEnv;
	}
	runtimes.push({ handlers, context });
	return {
		handlers, tools, context,
		active: () => [...activeNames],
		async emit(name: string, event: any) {
			const results = [];
			for (const handler of handlers.get(name) ?? []) results.push(await handler(event, context));
			return results;
		},
	};
}

afterEach(async () => {
	for (const runtime of runtimes.splice(0)) {
		for (const handler of runtime.handlers.get("session_shutdown") ?? []) await handler({ type: "session_shutdown", reason: "quit" }, runtime.context);
	}
});

describe("subagent tool activation", () => {
	it("starts fresh parents with a compact self-service loader and keeps support tools active", async () => {
		const runtime = createRuntime();
		await runtime.emit("session_start", { type: "session_start", reason: "startup" });

		assert.equal(runtime.active().includes("subagent"), false);
		assert.ok(runtime.active().includes("subagents_enable"));
		assert.ok(runtime.active().includes("bg_wait"));
		assert.ok(runtime.active().includes("subagent_supervisor"));
		const loader = runtime.tools.get("subagents_enable");
		assert.ok(loader);
		assert.match(loader.description ?? "", /current request|applicable .*instructions/i);
		assert.match(loader.promptSnippet ?? "", /pi-subagents is installed/i);
		assert.match(loader.promptSnippet ?? "", /complexity alone.*not authorization/i);
		assert.deepEqual(loader.parameters, { type: "object", properties: {}, additionalProperties: false });

		const before = runtime.active();
		const result = await loader.execute?.("enable", {}, new AbortController().signal, undefined, runtime.context);
		assert.notEqual(result?.isError, true);
		assert.ok(runtime.active().includes("subagent"));
		assert.ok(runtime.active().includes("read"));
		const enabled = runtime.active();
		await loader.execute?.("enable-again", {}, new AbortController().signal, undefined, runtime.context);
		assert.deepEqual(runtime.active(), enabled);
		assert.notDeepEqual(before, enabled);
	});

	it("restores native cold and warm transcript selections across start, reload, and tree navigation", async () => {
		const tool = { name: "subagent", description: "historical", parameters: { type: "object" } };
		const cold = createRuntime([{ role: "system", content: "", toolsAdded: [], timestamp: 1 }]);
		await cold.emit("session_start", { type: "session_start", reason: "reload" });
		assert.equal(cold.active().includes("subagent"), false);
		await cold.emit("session_tree", { type: "session_tree", newLeafId: null, oldLeafId: null });
		assert.equal(cold.active().includes("subagent"), false);

		const warm = createRuntime([{ role: "system", content: "", toolsAdded: [tool], timestamp: 1 }]);
		await warm.emit("session_start", { type: "session_start", reason: "resume" });
		assert.ok(warm.active().includes("subagent"));
		assert.ok(warm.active().includes("subagents_enable"));
	});

	it("keeps eager compatibility for legacy history and when the loader is restricted", async () => {
		const legacy = createRuntime([{ role: "user", content: "continue", timestamp: 1 }]);
		await legacy.emit("session_start", { type: "session_start", reason: "startup" });
		assert.ok(legacy.active().includes("subagent"));
		assert.ok(legacy.active().includes("subagents_enable"));

		const restricted = createRuntime([], ["subagents_enable"]);
		await restricted.emit("session_start", { type: "session_start", reason: "startup" });
		assert.ok(restricted.active().includes("subagent"));
		assert.equal(restricted.active().includes("subagents_enable"), false);
	});

	it("does not activate delegation from prompt keywords and reports an unavailable target", async () => {
		const runtime = createRuntime();
		await runtime.emit("session_start", { type: "session_start", reason: "startup" });
		const events = await runtime.emit("before_agent_start", {
			type: "before_agent_start", prompt: "delegate this complex task", systemPrompt: "base",
			systemPromptOptions: { selectedTools: runtime.active(), sections: new Map(), promptGuidelines: [] },
		});
		assert.equal(runtime.active().includes("subagent"), false);
		assert.ok(events.length > 0);

		(runtime.tools as Map<string, Tool>).delete("subagent");
		const loader = runtime.tools.get("subagents_enable");
		const result = await loader?.execute?.("missing", {}, new AbortController().signal, undefined, runtime.context);
		assert.equal(result?.isError, true);
		assert.match(result?.content?.[0]?.text ?? "", /unavailable.*subagent/i);
	});
});
