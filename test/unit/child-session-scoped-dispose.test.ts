import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	createDefaultChildSessionFactory,
	type ChildSessionLaunch,
	type PiCodingAgentModule,
} from "../../src/runs/shared/child-session.ts";

function stubPiModule(logs: string[][]): () => PiCodingAgentModule {
	return () => {
		const events: string[] = [];
		logs.push(events);
		return {
			ModelRuntime: { create: async () => ({ refresh: async () => {} }) },
			SettingsManager: { create: () => ({}) },
			DefaultResourceLoader: class { async reload() {} getExtensions() { return { extensions: [], errors: [], runtime: { pendingProviderRegistrations: [], pendingNativeProviderRegistrations: [] } }; } },
			SessionManager: { inMemory: () => ({}) },
			resolveCliModel: () => ({}),
			createAgentSession: async () => ({
				session: {
					bindExtensions: async () => {},
					dispose() { events.push("dispose"); },
					extensionRunner: { hasHandlers: () => false },
					subscribe: () => () => {},
					prompt: async () => {},
					abort: async () => { events.push("abort"); },
					steer: async () => {},
					followUp: async () => {},
					messages: [],
					sessionId: `child-${logs.length}`,
				},
			}),
		} as unknown as PiCodingAgentModule;
	};
}

function launchFor(parentSessionFile: string | undefined): ChildSessionLaunch {
	return {
		cwd: process.cwd(),
		storage: { kind: "memory" },
		parentSessionFile,
		extensionPaths: [],
		ambientExtensions: false,
		hooks: [],
		noSkills: true,
		noContextFiles: true,
		runtime: { fanoutChild: false, depth: 1, waitTool: { enabled: false }, fast: false },
	};
}

describe("disposeForParent scopes child disposal to one session", () => {
	it("disposes only the given parent's children, file-less parents included, and dispose() takes the rest", async () => {
		const logs: string[][] = [];
		const factory = createDefaultChildSessionFactory({ loadPiCodingAgent: stubPiModule(logs) });
		const parentA = "/tmp/sessions/parent-a.jsonl";
		await factory.create(launchFor(parentA));
		await factory.create(launchFor("/tmp/sessions/parent-b.jsonl"));
		await factory.create(launchFor(undefined));

		await factory.disposeForParent(parentA);
		assert.deepEqual(logs, [["abort", "dispose"], [], []]);

		await factory.disposeForParent(undefined);
		assert.deepEqual(logs, [["abort", "dispose"], [], ["abort", "dispose"]]);

		await factory.dispose();
		assert.deepEqual(logs, [["abort", "dispose"], ["abort", "dispose"], ["abort", "dispose"]]);
	});

	it("a launch waiting for its MCP tools fails only when its own parent is disposed", async () => {
		let entered!: () => void;
		let release!: () => void;
		let released!: Promise<void>;
		const tool = { name: "mcp__selected__t", label: "selected/t" };
		const pi = {
			...stubPiModule([])(),
			createMcpExtension: () => (api: { registerTool(tool: object): void; on(event: string, handler: (event: unknown, ctx: { signal: AbortSignal }) => Promise<void>): void }) => {
				api.registerTool(tool);
				api.on("tool_call", async (_event, ctx) => {
					entered();
					await Promise.race([released, new Promise((resolve) => ctx.signal.addEventListener("abort", resolve))]);
				});
			},
			DefaultResourceLoader: class {
				handlers = new Map<string, Array<(event: unknown, ctx: object) => unknown>>();
				tools: object[] = [];
				options: { extensionFactories: Array<{ factory(api: object): unknown }> };
				constructor(options: { extensionFactories: Array<{ factory(api: object): unknown }> }) { this.options = options; }
				async reload() {
					const api = { on: (event: string, handler: (event: unknown, ctx: object) => unknown) => this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]), registerTool: (tool: object) => this.tools.push(tool), getAllTools: () => this.tools };
					for (const { factory } of this.options.extensionFactories) await factory(api);
				}
				getExtensions() { return { extensions: [], errors: [], runtime: { pendingProviderRegistrations: [] } }; }
			},
			createAgentSession: async ({ resourceLoader }: { resourceLoader: { handlers: Map<string, Array<(event: unknown, ctx: object) => unknown>>; tools: object[] } }) => {
				for (const handler of resourceLoader.handlers.get("session_start") ?? []) await handler({}, {});
				return { session: { bindExtensions: async () => {}, dispose() {}, extensionRunner: { hasHandlers: () => false }, abort: async () => {}, sessionId: "mcp-child", getAllTools: () => resourceLoader.tools, getActiveToolNames: () => [tool.name] } };
			},
		} as unknown as PiCodingAgentModule;
		const factory = createDefaultChildSessionFactory({ loadPiCodingAgent: () => pi });
		const launch = (parent: string) => {
			const waiting = new Promise<void>((resolve) => { entered = resolve; });
			released = new Promise<void>((resolve) => { release = resolve; });
			return { waiting, child: factory.create({ ...launchFor(parent), builtinMcpTools: [{ name: tool.name, selector: "selected/t" }] }) };
		};

		const a = launch("/tmp/sessions/parent-a.jsonl");
		await a.waiting;
		await factory.disposeForParent("/tmp/sessions/parent-b.jsonl");
		release();
		await assert.doesNotReject(a.child, "another parent's disposal does not fail this launch");

		const a2 = launch("/tmp/sessions/parent-a.jsonl");
		await a2.waiting;
		await factory.disposeForParent("/tmp/sessions/parent-a.jsonl");
		await assert.rejects(a2.child, /disposed while the child waited for its MCP tools/);
	});
});
