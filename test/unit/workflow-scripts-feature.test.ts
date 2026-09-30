import assert from "node:assert/strict";
import * as os from "node:os";
import { describe, it } from "node:test";
import { Compile } from "typebox/compile";
import { disabledFeatureUseError, resolveDisabledFeatureSurface } from "../../src/shared/disabled-features.ts";
import { normalizePublicSubagentExecution } from "../../src/extension/public-execution.ts";
import { SubagentParams, createSubagentParamsSchema } from "../../src/extension/schemas.ts";
import { SUBAGENT_RPC_PROTOCOL_VERSION, SUBAGENT_RPC_REQUEST_EVENT, registerSubagentRpcBridge, subagentRpcReplyEvent } from "../../src/extension/rpc.ts";
import {
	buildSubagentToolDescription,
	buildSubagentToolPromptMetadata,
	DEFAULT_SUBAGENT_TOOL_DESCRIPTION,
	FULL_SUBAGENT_TOOL_DESCRIPTION,
	SUBAGENT_TOOL_PROMPT_GUIDELINES,
	SUBAGENT_TOOL_PROMPT_SNIPPET,
} from "../../src/extension/tool-description.ts";
import { createSubagentExecutor } from "../../src/runs/foreground/subagent-executor.ts";
import { createChildSafeState } from "../../src/extension/fanout-child.ts";
import { registerPromptWorkflowCommands } from "../../src/slash/prompt-workflows.ts";
import { registerSlashCommands } from "../../src/slash/slash-commands.ts";
import type { ExtensionConfig, SubagentParamsLike } from "../../src/shared/types.ts";
import { makeMinimalCtx } from "../support/helpers.ts";

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

describe("workflow-scripts disabled feature: tool surface", () => {
	it("leaves the default schema, descriptions, and prompt metadata unchanged", () => {
		const unrelated = resolveDisabledFeatureSurface({ disabledFeatures: ["watchdog"] });
		assert.equal(createSubagentParamsSchema(resolveDisabledFeatureSurface({})), SubagentParams);
		assert.equal(Object.hasOwn(SubagentParams.properties, "chain"), false);
		assert.equal(Object.hasOwn(SubagentParams.properties, "tasks"), false);
		assert.equal(Object.hasOwn(createSubagentParamsSchema(unrelated).properties, "chain"), false);
		assert.equal(buildSubagentToolDescription({}, { disabledFeatures: resolveDisabledFeatureSurface({}) }), DEFAULT_SUBAGENT_TOOL_DESCRIPTION);
		assert.equal(buildSubagentToolDescription({ toolDescriptionMode: "full" }), FULL_SUBAGENT_TOOL_DESCRIPTION);
		assert.deepEqual(buildSubagentToolPromptMetadata({}), { promptSnippet: SUBAGENT_TOOL_PROMPT_SNIPPET, promptGuidelines: SUBAGENT_TOOL_PROMPT_GUIDELINES });
		assert.deepEqual(buildSubagentToolPromptMetadata({}, unrelated), { promptSnippet: SUBAGENT_TOOL_PROMPT_SNIPPET, promptGuidelines: SUBAGENT_TOOL_PROMPT_GUIDELINES });
	});

	it("declares a smaller tool than the default with the same constructors", () => {
		for (const mode of [undefined, "full"] as const) {
			const enabled = declarationLength({}, mode);
			const disabled = declarationLength(DISABLED, mode);
			assert.ok(disabled < enabled, `${mode ?? "default"} mode: disabled ${disabled} is not smaller than enabled ${enabled}`);
		}
	});

	it("replaces the five script parameters with a small chain/tasks schema", () => {
		const schema = createSubagentParamsSchema(surface);
		for (const param of ["workflow", "args", "preflight", "globalConcurrencyLimit", "maxSubagentSpawnsPerRun"]) assert.equal(Object.hasOwn(schema.properties, param), false, param);
		const validator = Compile(schema);
		assert.equal(validator.Check({ task: "ship it", tasks: [{ agent: "scout", task: "a" }, { agent: "reviewer", task: "b" }] }), true);
		assert.equal(validator.Check({ task: "ship it", chain: [{ agent: "scout", task: "{task}", as: "scan" }, { parallel: [{ agent: "reviewer", task: "{outputs.scan}" }] }, { agent: "writer" }] }), true);
		assert.equal(validator.Check({ tasks: [{ agent: "scout" }] }), false, "tasks items require task");
		assert.equal(validator.Check({ chain: [{ agent: "scout", model: "x" }] }), false, "chain steps reject other fields");
		assert.equal(validator.Check({ chain: [] }), false, "chain needs a step");
		const serialized = JSON.stringify({ tasks: schema.properties.tasks, chain: schema.properties.chain });
		assert.ok(serialized.length <= 750, `chain/tasks schema is ${serialized.length} chars`);
	});

	it("drops script guidance from the description and prompt snippet and explains chain/tasks", () => {
		for (const toolDescriptionMode of [undefined, "compact", "full"] as const) {
			const description = buildSubagentToolDescription({ toolDescriptionMode }, { disabledFeatures: surface });
			for (const script of ["```js workflow", "workflow:true", "runs.run", "runs.all", "runs.lanes", "runs.host", "Named resources", "validate", "args", "state.get", "Schedules take script inputs"]) {
				assert.ok(!description.includes(script), `${toolDescriptionMode ?? "default"} description still mentions ${script}`);
			}
			for (const text of ["tasks:[{agent,task},...]", "chain:[{agent,task?,as?}", "{task}", "{previous}", "{outputs.name}", "SAFETY-CRITICAL SUBAGENT GUIDANCE", "exactly one top-level subagent chain or tasks call"]) {
				assert.ok(description.includes(text), `${toolDescriptionMode ?? "default"} description lacks ${text}`);
			}
		}
		const metadata = buildSubagentToolPromptMetadata({}, surface);
		assert.equal(metadata.promptSnippet, "For operator-requested delegation, use subagents; compose multi-child work in one chain or tasks call.");
		assert.deepEqual(metadata.promptGuidelines, SUBAGENT_TOOL_PROMPT_GUIDELINES);
	});
});

describe("workflow-scripts disabled feature: admission", () => {
	it("attributes preflight to workflow-scripts whatever order the config lists it", () => {
		for (const disabledFeatures of [["preflight", "workflow-scripts"], ["workflow-scripts", "preflight"]] as const) {
			const both = resolveDisabledFeatureSurface({ disabledFeatures: [...disabledFeatures] });
			assert.equal(disabledFeatureUseError({ preflight: {} }, both), `subagent option 'preflight' is disabled by config ${SETTING}.`);
		}
	});

	it("rejects each removed parameter, validate, and a raw script with the setting name", async () => {
		const executor = createExecutor(DISABLED);
		for (const [param, value] of [["workflow", true], ["workflow", "./flow.js"], ["workflow", "review"], ["args", {}], ["preflight", {}], ["globalConcurrencyLimit", 2], ["maxSubagentSpawnsPerRun", 2]] as const) {
			const result = await executor.executePublic("disabled", { [param]: value } as SubagentParamsLike, new AbortController().signal, undefined, ctx());
			assert.equal(result.isError, true);
			assert.equal(resultText(result), `subagent option '${param}' is disabled by config ${SETTING}.`);
		}
		const validate = await executor.executePublic("disabled", { action: "validate" }, new AbortController().signal, undefined, ctx());
		assert.equal(resultText(validate), `subagent action 'validate' is disabled by config ${SETTING}.`);
		const raw = await executor.executePublic("disabled", { workflowScript: "return 1;" }, new AbortController().signal, undefined, ctx());
		assert.equal(resultText(raw), SCRIPTS_DISABLED);
	});

	it("rejects raw scripts from delegated and scheduled launches", async () => {
		const executor = createExecutor(DISABLED);
		const delegated = await executor.executeDelegated("delegated", { workflowScript: "return 1;" }, new AbortController().signal, undefined, ctx());
		assert.equal(delegated.isError, true);
		assert.equal(resultText(delegated), SCRIPTS_DISABLED);
		const scheduled = await executor.executeScheduled("scheduled", { workflowScript: "return 1;", args: {}, async: true }, new AbortController().signal, ctx());
		assert.equal(scheduled.isError, true);
		assert.equal(resultText(scheduled), `subagent option 'args' is disabled by config ${SETTING}.`);
		const scheduledScript = await executor.executeScheduled("scheduled", { workflowScript: "return 1;", async: true }, new AbortController().signal, ctx());
		assert.equal(resultText(scheduledScript), SCRIPTS_DISABLED);
	});

	it("rejects /prompt-workflow template scripts", async () => {
		const commands = new Map<string, { handler(args: string, ctx: unknown): Promise<void> }>();
		const launched: SubagentParamsLike[] = [];
		registerPromptWorkflowCommands({
			pi: { registerCommand: (name: string, spec: { handler(args: string, ctx: unknown): Promise<void> }) => commands.set(name, spec), sendMessage() {} } as never,
			run: async (params) => { launched.push(params); },
		});
		const notices: string[] = [];
		await commands.get("prompt-workflow")!.handler("parallel-review src", { ...makeMinimalCtx(process.cwd()), ui: { notify: (message: string) => notices.push(message) } });
		assert.deepEqual(notices, []);
		assert.equal(launched.length, 1);
		assert.equal(typeof launched[0]!.workflowScript, "string");
		const result = await createExecutor(DISABLED).executePublic("template", launched[0]!, new AbortController().signal, undefined, ctx());
		assert.equal(resultText(result), SCRIPTS_DISABLED);
	});

	it("rejects RPC spawn scripts and script parameters before normalization", async () => {
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
			return replies.get(subagentRpcReplyEvent(requestId)) as { success: boolean; error?: { code: string; message: string } };
		};
		assert.deepEqual((await spawn("script", { script: "return 1;" })).error, { code: "invalid_params", message: `RPC spawn workflow scripts are disabled by config ${SETTING}.` });
		// Without the early check, "args requires workflow." would hide the setting.
		assert.deepEqual((await spawn("args", { agent: "scout", task: "x", args: {} })).error, { code: "invalid_params", message: `RPC spawn option 'args' is disabled by config ${SETTING}.` });
		assert.deepEqual((await spawn("path", { workflow: "./flow.js" })).error, { code: "invalid_params", message: `RPC spawn option 'workflow' is disabled by config ${SETTING}.` });
		assert.equal((await spawn("chain", { chain: [{ agent: "scout", task: "x" }] })).error?.message, LEGACY_ERROR);
	});

	it("launches /run as a direct single child instead of a script", async () => {
		const commands = new Map<string, { handler(args: string, ctx: unknown): Promise<void> }>();
		const requested: unknown[] = [];
		const handlers = new Map<string, Array<(data: unknown) => void>>();
		const events = {
			on(event: string, handler: (data: unknown) => void) {
				handlers.set(event, [...(handlers.get(event) ?? []), handler]);
				return () => {};
			},
			emit(event: string, data: unknown) {
				for (const handler of handlers.get(event) ?? []) handler(data);
			},
		};
		events.on("subagent:slash:request", (data) => {
			const { requestId, params } = data as { requestId: string; params: unknown };
			requested.push(params);
			events.emit("subagent:slash:started", { requestId });
			events.emit("subagent:slash:response", { requestId, result: { content: [{ type: "text", text: "done" }], details: { mode: "single", results: [] } }, isError: false });
		});
		const pi = { events, on() { return () => {}; }, registerTool() {}, registerCommand: (name: string, spec: { handler(args: string, ctx: unknown): Promise<void> }) => commands.set(name, spec), registerShortcut() {}, sendMessage() {} };
		const state = { baseCwd: process.cwd(), currentSessionId: null, asyncJobs: new Map(), foregroundRuns: new Map(), foregroundControls: new Map(), lastForegroundControlId: null, cleanupTimers: new Map(), lastUiContext: null, poller: null, completionSeen: new Map(), watcher: null, watcherRestartTimer: null, resultFileCoalescer: { schedule: () => false, clear: () => {} } };
		const disposer = registerSlashCommands(pi as never, state as never, { workflowScriptsDisabled: true });
		try {
			await commands.get("run")!.handler("scout Inspect this --bg", { ...makeMinimalCtx(process.cwd()), ui: { notify() {}, setStatus() {}, setToolsExpanded() {} } });
			await new Promise<void>((resolve) => setImmediate(resolve));
		} finally {
			disposer.dispose();
		}
		assert.deepEqual(requested, [{ agent: "scout", task: "Inspect this", agentScope: "both", async: true }]);
		const normalized = normalizePublicSubagentExecution(requested[0] as SubagentParamsLike, { structuredWorkflows: true });
		assert.equal(normalized.ok, true);
		assert.equal(disabledFeatureUseError(requested[0] as object, surface), undefined);
	});
});

describe("workflow-scripts: chain/tasks public normalization", () => {
	const structured = { structuredWorkflows: true };

	it("keeps chain and tasks legacy errors while workflow scripts are enabled", async () => {
		for (const input of [{ chain: [{ agent: "scout", task: "x" }] }, { tasks: [{ agent: "scout", task: "x" }] }]) {
			const normalized = normalizePublicSubagentExecution(input);
			assert.deepEqual(normalized, { ok: false, error: LEGACY_ERROR, mode: "workflow" });
			const result = await createExecutor({}).executePublic("enabled", input, new AbortController().signal, undefined, ctx());
			assert.equal(resultText(result), LEGACY_ERROR);
		}
	});

	it("accepts chain or tasks with the original request and rejects conflicting inputs", () => {
		const chain = [{ agent: "scout", task: "{task}" }];
		assert.deepEqual(normalizePublicSubagentExecution({ task: "ship", chain, async: true }, structured), { ok: true, params: { task: "ship", chain, async: true } });
		assert.deepEqual(normalizePublicSubagentExecution({ tasks: chain }, structured), { ok: true, params: { tasks: chain } });
		const error = (input: Record<string, unknown>) => {
			const normalized = normalizePublicSubagentExecution(input, structured);
			return normalized.ok ? undefined : normalized.error;
		};
		assert.equal(error({ chain, tasks: chain }), "Pass either tasks or chain, not both.");
		assert.equal(error({ chain, agent: "scout" }), "chain cannot be combined with agent.");
		assert.equal(error({ tasks: chain, action: "status" }), "tasks cannot be combined with action.");
		assert.equal(error({ tasks: chain, workflowScript: "return 1;" }), "tasks cannot be combined with workflowScript.");
		assert.equal(error({ chain, task: 1 }), "task must be a string when provided; with chain it is the original request for {task}.");
		for (const action of ["chain", "tasks", "parallel"]) {
			assert.equal(error({ action }), LEGACY_ERROR);
			assert.equal(error({ action, chain }), LEGACY_ERROR);
		}
		for (const legacy of [{ parallel: chain }, { chain, concurrency: 2 }, { chain, chainDir: "/tmp" }]) assert.equal(error(legacy), LEGACY_ERROR);
	});
});
