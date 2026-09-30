import assert from "node:assert/strict";
import * as os from "node:os";
import { describe, it } from "node:test";
import { Compile } from "typebox/compile";
import { disabledFeatureUseError, resolveDisabledFeatureSurface } from "../../src/shared/disabled-features.ts";
import { normalizePublicSubagentExecution } from "../../src/extension/public-execution.ts";
import { createSubagentParamsSchema } from "../../src/extension/schemas.ts";
import { SUBAGENT_RPC_PROTOCOL_VERSION, SUBAGENT_RPC_REQUEST_EVENT, registerSubagentRpcBridge, subagentRpcReplyEvent } from "../../src/extension/rpc.ts";
import { buildSubagentToolDescription, buildSubagentToolPromptMetadata } from "../../src/extension/tool-description.ts";
import { createSubagentExecutor, type SubagentParamsLike } from "../../src/runs/foreground/subagent-executor.ts";
import { createChildSafeState } from "../../src/extension/fanout-child.ts";
import { registerSlashCommands } from "../../src/slash/slash-commands.ts";
import type { ExtensionConfig } from "../../src/shared/types.ts";
import { createEventBus, makeMinimalCtx } from "../support/helpers.ts";

const SETTING = `disabledFeatures "workflow-scripts"`;
const DISABLED: ExtensionConfig = { disabledFeatures: ["workflow-scripts"] };
const surface = resolveDisabledFeatureSurface(DISABLED);
const LEGACY_ERROR = "Legacy top-level chain and parallel inputs were removed; use a workflow script (workflow: true or a workflow script path).";
const SCRIPTS_DISABLED = `subagent workflow scripts are disabled by config ${SETTING}.`;

function createExecutor(config: ExtensionConfig) {
	return createSubagentExecutor({
		pi: { events: { emit() {}, on() { return () => {}; } }, getSessionName() { return "parent"; } } as never,
		state: createChildSafeState(),
		config: { maxSubagentDepth: 2, control: {}, intercomBridge: {}, ...config } as never,
		asyncByDefault: false,
		tempArtifactsDir: os.tmpdir(),
		getSubagentSessionRoot: () => os.tmpdir(),
		expandTilde: (value) => value,
		discoverAgents: () => ({ agents: [] as never[] }),
	});
}

function ctx() {
	return makeMinimalCtx(os.tmpdir()) as never;
}

function resultText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map((part) => part.text ?? "").join("\n");
}

function declarationLength(config: ExtensionConfig, toolDescriptionMode?: "full"): number {
	const disabledFeatures = resolveDisabledFeatureSurface(config);
	return JSON.stringify({
		name: "subagent",
		description: buildSubagentToolDescription({ toolDescriptionMode }, { disabledFeatures }),
		parameters: createSubagentParamsSchema(disabledFeatures),
	}).length;
}

describe("workflow-scripts tool surface", () => {
	it("is smaller than the default declaration", () => {
		for (const mode of [undefined, "full"] as const) {
			const enabled = declarationLength({}, mode);
			const disabled = declarationLength(DISABLED, mode);
			assert.ok(disabled < enabled, `${mode ?? "default"} mode: disabled ${disabled} is not smaller than enabled ${enabled}`);
		}
	});

	it("accepts chain and tasks shapes with a small schema", () => {
		const schema = createSubagentParamsSchema(surface);
		const validator = Compile(schema);
		assert.equal(validator.Check({ task: "ship it", tasks: [{ agent: "scout", task: "a" }, { agent: "reviewer", task: "b" }] }), true);
		assert.equal(validator.Check({ task: "ship it", chain: [{ agent: "scout", task: "{task}", as: "scan" }, { parallel: [{ agent: "reviewer", task: "{outputs.scan}" }] }, { agent: "writer" }] }), true);
		assert.equal(validator.Check({ tasks: [{ agent: "scout" }] }), false, "tasks items require task");
		assert.equal(validator.Check({ chain: [{ agent: "scout", model: "x" }] }), false, "chain steps reject other fields");
		assert.equal(validator.Check({ chain: [] }), false, "chain needs a step");
		const serialized = JSON.stringify({ tasks: schema.properties.tasks, chain: schema.properties.chain });
		assert.ok(serialized.length <= 750, `chain/tasks schema is ${serialized.length} chars`);
	});

	it("replaces script guidance with chain/tasks guidance", () => {
		for (const toolDescriptionMode of [undefined, "compact", "full"] as const) {
			const description = buildSubagentToolDescription({ toolDescriptionMode }, { disabledFeatures: surface });
			for (const script of ["```js workflow", "workflow:true", "runs.run", "runs.all", "runs.lanes", "runs.host", "Named resources", "validate", "args", "state.get", "Schedules take script inputs"]) {
				assert.ok(!description.includes(script), `${toolDescriptionMode ?? "default"} description still mentions ${script}`);
			}
			for (const text of ["tasks:[{agent,task},...]", "chain:[{agent,task?,as?}", "{task}", "{previous}", "{outputs.name}", "SAFETY-CRITICAL SUBAGENT GUIDANCE", "exactly one top-level subagent chain or tasks call"]) {
				assert.ok(description.includes(text), `${toolDescriptionMode ?? "default"} description lacks ${text}`);
			}
		}
		assert.equal(buildSubagentToolPromptMetadata({}, surface).promptSnippet, "For operator-requested delegation, use subagents; compose multi-child work in one chain or tasks call.");
	});
});

describe("workflow-scripts admission", () => {
	it("attributes preflight to workflow-scripts in either config order", () => {
		for (const disabledFeatures of [["preflight", "workflow-scripts"], ["workflow-scripts", "preflight"]] as const) {
			const both = resolveDisabledFeatureSurface({ disabledFeatures: [...disabledFeatures] });
			assert.equal(disabledFeatureUseError({ preflight: {} }, both), `subagent option 'preflight' is disabled by config ${SETTING}.`);
		}
	});

	it("rejects every workflow form and raw scripts from public, delegated, and scheduled launches", async () => {
		const executor = createExecutor(DISABLED);
		for (const workflow of [true, "./flow.js", "review"]) {
			const result = await executor.executePublic("workflow", { workflow } as SubagentParamsLike, new AbortController().signal, undefined, ctx());
			assert.equal(resultText(result), `subagent option 'workflow' is disabled by config ${SETTING}.`);
		}
		const script = { workflowScript: "return 1;", async: true };
		assert.equal(resultText(await executor.executePublic("public", script, new AbortController().signal, undefined, ctx())), SCRIPTS_DISABLED);
		assert.equal(resultText(await executor.executeDelegated("delegated", script, new AbortController().signal, undefined, ctx())), SCRIPTS_DISABLED);
		assert.equal(resultText(await executor.executeScheduled("scheduled", script, new AbortController().signal, ctx())), SCRIPTS_DISABLED);
	});

	it("rejects RPC spawn scripts before normalization", async () => {
		const handlers: Array<(data: unknown) => void> = [];
		const replies = new Map<string, unknown>();
		registerSubagentRpcBridge({
			events: {
				on(event: string, handler: (data: unknown) => void) {
					if (event === SUBAGENT_RPC_REQUEST_EVENT) handlers.push(handler);
					return () => {};
				},
				emit(event: string, data: unknown) { replies.set(event, data); },
			} as never,
			getContext: () => ctx(),
			execute: async () => assert.fail("disabled RPC spawn must not execute"),
			disabledFeatures: surface,
		});
		const spawn = async (requestId: string, params: unknown) => {
			for (const handler of handlers) await handler({ version: SUBAGENT_RPC_PROTOCOL_VERSION, requestId, method: "spawn", params });
			return (replies.get(subagentRpcReplyEvent(requestId)) as { error?: { code: string; message: string } }).error;
		};
		assert.deepEqual(await spawn("script", { script: "return 1;" }), { code: "invalid_params", message: `RPC spawn workflow scripts are disabled by config ${SETTING}.` });
		// Normalization would otherwise report "args requires workflow." and hide the setting.
		assert.deepEqual(await spawn("args", { agent: "scout", task: "x", args: {} }), { code: "invalid_params", message: `RPC spawn option 'args' is disabled by config ${SETTING}.` });
		assert.equal((await spawn("chain", { chain: [{ agent: "scout", task: "x" }] }))?.message, LEGACY_ERROR);
	});

	it("launches /run as a direct child", async () => {
		const commands = new Map<string, { handler(args: string, ctx: unknown): Promise<void> }>();
		const requested: unknown[] = [];
		const events = createEventBus();
		events.on("subagent:slash:request", (data) => {
			const { requestId, params } = data as { requestId: string; params: unknown };
			requested.push(params);
			events.emit("subagent:slash:started", { requestId });
			events.emit("subagent:slash:response", { requestId, result: { content: [{ type: "text", text: "done" }], details: { mode: "single", results: [] } }, isError: false });
		});
		const pi = { events, on() { return () => {}; }, registerTool() {}, registerCommand: (name: string, spec: { handler(args: string, ctx: unknown): Promise<void> }) => commands.set(name, spec), registerShortcut() {}, sendMessage() {} };
		const disposer = registerSlashCommands(pi as never, { ...createChildSafeState(), baseCwd: process.cwd() }, { workflowScriptsDisabled: true });
		try {
			await commands.get("run")!.handler("scout Inspect this --bg", { ...makeMinimalCtx(process.cwd()), ui: { notify() {}, setStatus() {}, setToolsExpanded() {} } });
			await new Promise<void>((resolve) => setImmediate(resolve));
		} finally {
			disposer.dispose();
		}
		assert.deepEqual(requested, [{ agent: "scout", task: "Inspect this", agentScope: "both", async: true }]);
	});
});

describe("workflow-scripts chain/tasks normalization", () => {
	it("keeps chain and tasks as legacy errors while workflow scripts are enabled", async () => {
		for (const input of [{ chain: [{ agent: "scout", task: "x" }] }, { tasks: [{ agent: "scout", task: "x" }] }]) {
			const result = await createExecutor({}).executePublic("enabled", input, new AbortController().signal, undefined, ctx());
			assert.equal(resultText(result), LEGACY_ERROR);
		}
	});

	it("accepts chain or tasks with the original request and rejects conflicts", () => {
		const chain = [{ agent: "scout", task: "{task}" }];
		const normalize = (input: Record<string, unknown>) => normalizePublicSubagentExecution(input, { structuredWorkflows: true });
		assert.deepEqual(normalize({ task: "ship", chain, async: true }), { ok: true, params: { task: "ship", chain, async: true } });
		const error = (input: Record<string, unknown>) => {
			const normalized = normalize(input);
			return normalized.ok ? undefined : normalized.error;
		};
		assert.equal(error({ chain, tasks: chain }), "Pass either tasks or chain, not both.");
		assert.equal(error({ chain, agent: "scout" }), "chain cannot be combined with agent.");
		assert.equal(error({ tasks: chain, action: "status" }), "tasks cannot be combined with action.");
		assert.equal(error({ tasks: chain, step: {} }), "tasks cannot be combined with step.");
		for (const legacy of [{ action: "chain", chain }, { action: "tasks", tasks: chain }, { chain, concurrency: 2 }, { chain, chainDir: "/tmp" }]) assert.equal(error(legacy), LEGACY_ERROR);
	});
});
