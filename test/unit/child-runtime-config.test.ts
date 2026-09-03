import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createChildHooks } from "../../src/runs/shared/child-hooks.ts";
import { childSupervisorMetadata, evaluateChildToolDiagnostic, type ChildRuntimeConfig } from "../../src/runs/shared/child-runtime-config.ts";

function baseConfig(overrides: Partial<ChildRuntimeConfig> = {}): ChildRuntimeConfig {
	return { fanoutChild: false, depth: 1, waitTool: { enabled: true }, fast: false, ...overrides };
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
		assert.deepEqual(createChildHooks(baseConfig()).map((hook) => hook.name), ["pi-subagents:prompt-runtime"]);
		assert.deepEqual(createChildHooks(baseConfig({ fast: true })).map((hook) => hook.name), ["pi-subagents:prompt-runtime", "pi-subagents:fast-mode"]);
		assert.deepEqual(createChildHooks(baseConfig({ fanoutChild: true })).map((hook) => hook.name), ["pi-subagents:prompt-runtime", "pi-subagents:fanout-child"]);
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
		assert.deepEqual(diagnostics, [{ agent: "config-agent", required: ["read", "fixture_search"], available: ["read", "bg_wait", "structured_output"], missing: ["fixture_search"] }]);

		const structured = pi.tools.find((tool) => tool.name === "structured_output") as { execute: (id: string, params: { value: unknown }) => Promise<unknown> } | undefined;
		assert.ok(structured, "structured_output tool registered from config");
		await structured.execute("call-1", { value: { done: true } });
		assert.deepEqual(captured, [{ done: true }]);

		const rewritten = await pi.handlers.get("before_agent_start")?.[0]?.({ systemPrompt: "base prompt" }) as { systemPrompt: string } | undefined;
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
