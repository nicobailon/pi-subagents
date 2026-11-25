import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createChildHooks } from "../../src/runs/shared/child-hooks.ts";
import { buildInProcessChildLaunch } from "../../src/runs/shared/child-launch.ts";
import { childSupervisorMetadata, evaluateChildToolDiagnostic, type ChildRuntimeConfig } from "../../src/runs/shared/child-runtime-config.ts";
import { SUBAGENT_TOOL_DESCRIPTION, SUBAGENT_TOOL_PARAMETERS } from "../../src/extension/guided-tool.ts";

function baseConfig(overrides: Partial<ChildRuntimeConfig> = {}): ChildRuntimeConfig {
	return { fanoutChild: false, depth: 1, fast: false, ...overrides };
}

interface FakePi {
	handlers: Map<string, Array<(event?: unknown, ctx?: unknown) => unknown>>;
	tools: Array<{ name: string }>;
	api: unknown;
}

function fakePi(available: string[]): FakePi {
	const handlers = new Map<string, Array<(event?: unknown, ctx?: unknown) => unknown>>();
	const tools: Array<{ name: string }> = [];
	const api = {
		on(event: string, handler: (event?: unknown, ctx?: unknown) => unknown) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerTool(tool: { name: string }) { tools.push(tool); },
		getAllTools: () => [...available, ...tools.map((tool) => tool.name)].map((name) => ({ name })),
		events: { on() {}, emit() {} },
		sendMessage() {},
		getThinkingLevel: () => "off",
	};
	return { handlers, tools, api };
}

describe("child runtime config", () => {
	it("creates the prompt runtime hook always and the fast and fanout hooks on demand", () => {
		assert.deepEqual(createChildHooks(baseConfig()).map((hook) => hook.name), ["pi-subagents:prompt-runtime", "pi-subagents:prompt-boundary"]);
		assert.deepEqual(createChildHooks(baseConfig({ fast: true })).map((hook) => hook.name), ["pi-subagents:prompt-runtime", "pi-subagents:fast-mode", "pi-subagents:prompt-boundary"]);
		assert.deepEqual(createChildHooks(baseConfig({ fanoutChild: true })).map((hook) => hook.name), ["pi-subagents:prompt-runtime", "pi-subagents:fanout-child", "pi-subagents:prompt-boundary"]);
	});

	it("gives every child the same subagent declaration, which launches only with fanout authorization", async () => {
		for (const tools of [["subagent", "contact_supervisor"], ["contact_supervisor"]]) {
			const launch = buildInProcessChildLaunch({
				host: "parent", cwd: process.cwd(), childAgentName: "coordinator", childIndex: 0,
				sessionEnabled: false, tools, runId: "registration", parentSessionId: "root-A",
				inheritProjectContext: false, inheritGlobalContext: false, inheritSkills: false,
			});
			const pi = fakePi([]);
			for (const hook of launch.session.hooks) hook.factory(pi.api as never);
			const ctx = { cwd: process.cwd(), sessionManager: { getSessionId: () => "coordinator-B", getSessionFile: () => "/sessions/B.jsonl", buildContextEntries: () => [] } };
			try {
				for (const handler of pi.handlers.get("session_start") ?? []) await handler({}, ctx);
				const declared = pi.tools.filter((tool) => tool.name === "subagent") as unknown as Array<{ description: string; parameters: unknown; execute: (id: string, params: object, signal: undefined, onUpdate: undefined, ctx: object) => Promise<{ content: Array<{ text: string }> }> }>;
				assert.equal(declared.length, 1);
				assert.equal(declared[0]!.description, SUBAGENT_TOOL_DESCRIPTION);
				assert.deepEqual(declared[0]!.parameters, JSON.parse(JSON.stringify(SUBAGENT_TOOL_PARAMETERS)));
				const guide = (await declared[0]!.execute("guide", {}, undefined, undefined, ctx)).content[0]!.text;
				assert.equal(/cannot launch runs/.test(guide), !tools.includes("subagent"));
				assert.deepEqual(launch.session.tools, tools, "registration must not expand explicit tools");
			} finally {
				for (const handler of pi.handlers.get("session_shutdown") ?? []) await handler({}, ctx);
			}
		}
	});

	it("hooks read the config object", async () => {
		const diagnostics: unknown[] = [];
		const captured: unknown[] = [];
		const config = baseConfig({
			agent: "config-agent",
			requiredTools: ["read", "fixture_search"],
			toolDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
			structuredOutput: { schema: { type: "object" }, capture: (value) => captured.push(value) },
			inheritProjectContext: true,
			inheritGlobalContext: true,
			inheritSkills: true,
		});
		const pi = fakePi(["read"]);
		for (const hook of createChildHooks(config)) hook.factory(pi.api as never);

		assert.throws(() => pi.handlers.get("agent_start")?.[0]?.({}), /Agent 'config-agent' requested unavailable child tools: fixture_search/);
		assert.deepEqual(diagnostics, [{ agent: "config-agent", required: ["read", "fixture_search"], available: ["read", "subagent", "structured_output"], missing: ["fixture_search"] }]);

		const structured = pi.tools.find((tool) => tool.name === "structured_output") as { execute: (id: string, params: { value: unknown }) => Promise<unknown> } | undefined;
		assert.ok(structured, "structured_output tool registered from config");
		await structured.execute("call-1", { value: { done: true } });
		assert.deepEqual(captured, [{ done: true }]);

		const rewritten = await pi.handlers.get("before_agent_start")?.at(-1)?.({ systemPrompt: "base prompt" }) as { systemPrompt: string } | undefined;
		assert.match(rewritten?.systemPrompt ?? "", /strict structured output contract/);
	});

	it("evaluates the tool diagnostic against the available tools", () => {
		assert.equal(evaluateChildToolDiagnostic(baseConfig(), ["read"]), undefined);
		assert.equal(evaluateChildToolDiagnostic(baseConfig({ requiredTools: ["read"] }), ["read", "write"]), undefined);
		assert.deepEqual(
			evaluateChildToolDiagnostic(baseConfig({ agent: "worker", requiredTools: ["read", "mcp_search"], mcpDirectTools: ["mcp_search"] }), ["read"]),
			{ agent: "worker", required: ["read", "mcp_search"], available: ["read"], missing: ["mcp_search"], missingMcpDirectTools: ["mcp_search"] },
		);
	});

	it("derives supervisor metadata only when the channel, run, agent, index, and orchestrator session are all set", () => {
		assert.equal(childSupervisorMetadata(baseConfig({ supervisorChannelDir: "/tmp/channel", runId: "run-1", agent: "worker" })), undefined);
		assert.deepEqual(
			childSupervisorMetadata(baseConfig({
				supervisorChannelDir: "/tmp/channel",
				runId: "run-1",
				agent: "worker",
				childIndex: 2,
				orchestratorSessionId: "session-1",
				orchestratorTarget: "orchestrator",
				intercomSessionName: "child-target",
			})),
			{ channelDir: "/tmp/channel", runId: "run-1", agent: "worker", childIndex: 2, orchestratorTarget: "orchestrator", orchestratorSessionId: "session-1", childTarget: "child-target" },
		);
	});
});
