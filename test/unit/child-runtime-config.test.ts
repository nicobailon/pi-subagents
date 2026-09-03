import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { createChildHooks } from "../../src/runs/shared/child-hooks.ts";
import { readChildRuntimeConfigFromEnv, type ChildRuntimeConfig } from "../../src/runs/shared/child-runtime-config.ts";
import { PERMISSION_POLICY_ENV } from "../../src/runs/shared/permissions.ts";
import { STRUCTURED_OUTPUT_CAPTURE_ENV, STRUCTURED_OUTPUT_SCHEMA_ENV } from "../../src/runs/shared/structured-output.ts";
import { CHILD_TOOL_DIAGNOSTIC_PATH_ENV, REQUIRED_CHILD_TOOLS_ENV } from "../../src/runs/shared/tool-availability.ts";
import { TOOL_BUDGET_ENV } from "../../src/runs/shared/tool-budget.ts";
import { WAIT_TOOL_ENABLED_ENV } from "../../src/runs/background/wait-config.ts";
import {
	SUBAGENT_CHILD_AGENT_ENV,
	SUBAGENT_CHILD_INDEX_ENV,
	SUBAGENT_FANOUT_CHILD_ENV,
	SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV,
	SUBAGENT_PARENT_CHILD_INDEX_ENV,
	SUBAGENT_PARENT_CONTROL_INBOX_ENV,
	SUBAGENT_PARENT_DEPTH_ENV,
	SUBAGENT_PARENT_EVENT_SINK_ENV,
	SUBAGENT_PARENT_ROOT_RUN_ID_ENV,
	SUBAGENT_PARENT_RUN_ID_ENV,
	SUBAGENT_RUN_ID_ENV,
	SUBAGENT_STEER_ACK_DIR_ENV,
	SUBAGENT_STEER_INBOX_ENV,
} from "../../src/runs/shared/pi-args.ts";

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
	it("builds the config from a spawned child's environment once", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "child-runtime-config-"));
		try {
			const schemaPath = path.join(dir, "schema.json");
			fs.writeFileSync(schemaPath, JSON.stringify({ type: "object" }), "utf-8");
			const env: NodeJS.ProcessEnv = {
				[SUBAGENT_RUN_ID_ENV]: "run-1",
				[SUBAGENT_CHILD_AGENT_ENV]: "worker",
				[SUBAGENT_CHILD_INDEX_ENV]: "2",
				[SUBAGENT_FANOUT_CHILD_ENV]: "1",
				[SUBAGENT_PARENT_ROOT_RUN_ID_ENV]: "root",
				[SUBAGENT_PARENT_EVENT_SINK_ENV]: "/tmp/route/events",
				[SUBAGENT_PARENT_CONTROL_INBOX_ENV]: "/tmp/route/controls",
				[SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV]: "token",
				[SUBAGENT_PARENT_RUN_ID_ENV]: "run-1",
				[SUBAGENT_PARENT_CHILD_INDEX_ENV]: "2",
				[SUBAGENT_PARENT_DEPTH_ENV]: "2",
				[SUBAGENT_STEER_INBOX_ENV]: path.join(dir, "inbox"),
				[SUBAGENT_STEER_ACK_DIR_ENV]: path.join(dir, "acks"),
				[PERMISSION_POLICY_ENV]: JSON.stringify({ write: "deny" }),
				[TOOL_BUDGET_ENV]: JSON.stringify({ hard: 5, block: "*" }),
				[WAIT_TOOL_ENABLED_ENV]: "false",
				[STRUCTURED_OUTPUT_SCHEMA_ENV]: schemaPath,
				[STRUCTURED_OUTPUT_CAPTURE_ENV]: path.join(dir, "output.json"),
				[REQUIRED_CHILD_TOOLS_ENV]: JSON.stringify(["read", "write"]),
				[CHILD_TOOL_DIAGNOSTIC_PATH_ENV]: path.join(dir, "diagnostic.json"),
				PI_SUBAGENT_DEPTH: "2",
				PI_SUBAGENT_MAX_DEPTH: "3",
				PI_SUBAGENT_INHERIT_PROJECT_CONTEXT: "0",
			};
			const config = readChildRuntimeConfigFromEnv(env);
			assert.equal(config.runId, "run-1");
			assert.equal(config.agent, "worker");
			assert.equal(config.childIndex, 2);
			assert.equal(config.fanoutChild, true);
			assert.deepEqual(config.nestedRoute, { rootRunId: "root", eventSink: "/tmp/route/events", controlInbox: "/tmp/route/controls", capabilityToken: "token" });
			assert.deepEqual(config.nestedParent, { parentRunId: "run-1", parentChildIndex: 2, depth: 2, path: [] });
			assert.deepEqual(config.steerInbox, { inboxDir: path.join(dir, "inbox"), ackDir: path.join(dir, "acks") });
			assert.deepEqual(config.permissions, { rules: { write: "deny" } });
			assert.equal(config.toolBudget?.hard, 5);
			assert.deepEqual(config.waitTool, { enabled: false });
			assert.equal(config.depth, 2);
			assert.equal(config.maxDepth, 3);
			assert.equal(config.inheritProjectContext, false);
			assert.equal(config.inheritSkills, undefined);
			assert.deepEqual(config.requiredTools, ["read", "write"]);
			assert.deepEqual(config.structuredOutput?.schema, { type: "object" });

			config.structuredOutput!.capture({ ok: true }, undefined);
			assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "output.json"), "utf-8")), { ok: true });
			config.toolDiagnostic!({ required: ["read", "write"], available: ["read"], missing: ["write"] });
			assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "diagnostic.json"), "utf-8")).missing[0], "write");
			config.toolDiagnostic!(undefined);
			assert.equal(fs.existsSync(path.join(dir, "diagnostic.json")), false);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("creates the prompt runtime hook always and the fast and fanout hooks on demand", () => {
		assert.deepEqual(createChildHooks(baseConfig()).map((hook) => hook.name), ["pi-subagents:prompt-runtime"]);
		assert.deepEqual(createChildHooks(baseConfig({ fast: true })).map((hook) => hook.name), ["pi-subagents:prompt-runtime", "pi-subagents:fast-mode"]);
		assert.deepEqual(createChildHooks(baseConfig({ fanoutChild: true })).map((hook) => hook.name), ["pi-subagents:prompt-runtime", "pi-subagents:fanout-child"]);
	});

	it("hooks read the config object, not the process environment", async () => {
		const previousAgent = process.env[SUBAGENT_CHILD_AGENT_ENV];
		const previousRequired = process.env[REQUIRED_CHILD_TOOLS_ENV];
		process.env[SUBAGENT_CHILD_AGENT_ENV] = "env-agent";
		process.env[REQUIRED_CHILD_TOOLS_ENV] = JSON.stringify(["env-only-tool"]);
		try {
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
		} finally {
			if (previousAgent === undefined) delete process.env[SUBAGENT_CHILD_AGENT_ENV];
			else process.env[SUBAGENT_CHILD_AGENT_ENV] = previousAgent;
			if (previousRequired === undefined) delete process.env[REQUIRED_CHILD_TOOLS_ENV];
			else process.env[REQUIRED_CHILD_TOOLS_ENV] = previousRequired;
		}
	});
});
