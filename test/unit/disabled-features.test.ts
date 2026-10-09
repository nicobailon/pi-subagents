import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { SUBAGENT_FEATURES, resolveDisabledFeatureSurface, validateDisabledFeatures, type SubagentFeature } from "../../src/shared/disabled-features.ts";
import { SUBAGENT_OPTION_KEYS, SubagentParams, createSubagentParamsSchema } from "../../src/extension/schemas.ts";
import { SUBAGENT_RPC_PROTOCOL_VERSION, SUBAGENT_RPC_REQUEST_EVENT, registerSubagentRpcBridge, subagentRpcReplyEvent } from "../../src/extension/rpc.ts";
import { readSubagentGuide } from "../../src/extension/subagent-guide.ts";
import { buildSubagentToolDescription, SUBAGENT_SAFETY_GUIDANCE } from "../../src/extension/tool-description.ts";
import { createSubagentExecutor } from "../../src/runs/foreground/subagent-executor.ts";
import { createChildSafeState } from "../../src/extension/fanout-child.ts";
import type { ExtensionConfig } from "../../src/shared/types.ts";
import { makeMinimalCtx } from "../support/helpers.ts";

const ALL_FEATURES = Object.keys(SUBAGENT_FEATURES) as SubagentFeature[];
const ALL_DISABLED: ExtensionConfig = { disabledFeatures: ALL_FEATURES, scheduledRuns: { enabled: false } };

const GROUPS: Array<{ name: string; config: ExtensionConfig; setting: string; params: string[]; actions: string[] }> = [
	...([
		["agent-management", ["config"], ["create", "update", "delete", "eject", "disable", "enable", "reset", "refine", "refine.show", "refine.rollback"]],
		["watchdog", ["scope", "target", "thinking"], ["watchdog.status", "watchdog.check", "watchdog.configure", "watchdog.recommend-model"]],
		["panes", ["focus"], ["inspector.open", "inspector.command", "inspector.status", "inspector.close", "project.open", "project.status", "project.close"]],
		["missions", ["mission", "missionUpdate", "missionStatus", "missionScope", "missionId", "runMode", "runStatus", "summary"], ["mission.create", "mission.list", "mission.show", "mission.update", "mission.resolve-decision", "mission.attach-run", "mission.close"]],
		["lane-management", ["handoffPath", "laneId", "merge", "supersession", "repo", "planId"], ["lane.status", "lane.recordMerge", "lane.recordSupersession", "worktree.discard", "worktree.cleanup"]],
		["spawn-budget-grants", ["additional"], ["grant-spawn-budget"]],
		["preflight", ["preflight"], []],
		["lane-metadata", ["lane"], []],
		["gates", ["gate"], []],
		["usage-budgets", ["usageBudget"], []],
		["tool-budgets", ["toolBudget"], []],
		["control-overrides", ["control"], []],
		["extension-bindings", ["extensionBindings"], []],
		["external-machines", ["machine"], []],
		["workflow-scripts", ["workflow", "args", "preflight", "globalConcurrencyLimit", "maxSubagentSpawnsPerRun"], ["validate"]],
	] as const).map(([name, params, actions]) => ({ name, config: { disabledFeatures: [name] }, setting: `disabledFeatures "${name}"`, params: [...params], actions: [...actions] })),
	{
		name: "schedules",
		config: { scheduledRuns: { enabled: false } },
		setting: "scheduledRuns.enabled=false",
		params: ["name", "at", "every", "sessionOnly", "quiet", "on", "timezone", "overlap", "catchUp"],
		actions: ["schedule.create", "schedule.list", "schedule.show", "schedule.history", "schedule.pause", "schedule.resume", "schedule.run", "schedule.run-due", "schedule.delete"],
	},
];

function schemaKeys(config: ExtensionConfig): string[] {
	return Object.keys(createSubagentParamsSchema(resolveDisabledFeatureSurface(config)).properties);
}

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

function ctx(cwd = os.tmpdir()) {
	return makeMinimalCtx(cwd) as never;
}

function resultText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map((part) => part.text ?? "").join("\n");
}

describe("disabledFeatures config", () => {
	it("covers every registered feature in this test table", () => {
		assert.deepEqual(GROUPS.map((group) => group.name).filter((name) => name !== "schedules").sort(), [...ALL_FEATURES].sort());
	});

	it("rejects unknown, duplicate, and schedule entries", () => {
		assert.doesNotThrow(() => validateDisabledFeatures(ALL_FEATURES));
		assert.throws(() => validateDisabledFeatures("watchdog"), /must be an array/);
		assert.throws(() => validateDisabledFeatures(["watchdogs"]), /"watchdogs" is not one of/);
		assert.throws(() => validateDisabledFeatures(["gates", "gates"]), /more than once/);
		assert.throws(() => validateDisabledFeatures(["schedules"]), /scheduledRuns\.enabled to false/);
	});
});

describe("disabled feature groups", () => {
	const fullKeys = schemaKeys({});

	it("keeps the registered schema object when nothing is disabled", () => {
		assert.equal(createSubagentParamsSchema(resolveDisabledFeatureSurface({})), SubagentParams);
		assert.equal(createSubagentParamsSchema(resolveDisabledFeatureSurface({ scheduledRuns: { enabled: true } })), SubagentParams);
	});

	for (const group of GROUPS) {
		it(`${group.name}: removes exactly its top-level parameters from the schema`, () => {
			// Options fields are opaque in the provider schema; the executor rejects disabled ones.
			for (const param of group.params) assert.ok(fullKeys.includes(param) || SUBAGENT_OPTION_KEYS.includes(param), `${param} is not a subagent parameter`);
			// workflow-scripts replaces the removed script parameters with chain/tasks after task.
			const added = group.name === "workflow-scripts" ? ["tasks", "chain"] : [];
			assert.deepEqual(schemaKeys(group.config), fullKeys.filter((key) => !group.params.includes(key)).flatMap((key) => key === "task" ? [key, ...added] : [key]));
		});

		it(`${group.name}: rejects its actions and parameters with the setting name`, async () => {
			const executor = createExecutor(group.config);
			for (const action of group.actions) {
				const result = await executor.executePublic("disabled-action", { action }, new AbortController().signal, undefined, ctx());
				assert.equal(result.isError, true);
				assert.equal(resultText(result), `subagent action '${action}' is disabled by config ${group.setting}.`);
				assert.equal(result.details.mode, "management");
			}
			const param = group.params[0]!;
			const result = await executor.executePublic("disabled-option", { agent: "worker", task: "scan", [param]: "x" }, new AbortController().signal, undefined, ctx());
			assert.equal(result.isError, true);
			assert.equal(resultText(result), `subagent option '${param}' is disabled by config ${group.setting}.`);
			assert.equal(result.details.mode, param === "workflow" ? "workflow" : "single");
		});
	}
});

describe("disabled feature execution boundaries", () => {
	it("rejects a disabled option on delegated execution", async () => {
		const result = await createExecutor({ disabledFeatures: ["gates"] }).executeDelegated("disabled-delegated", { agent: "worker", task: "scan", gate: "npm test" }, new AbortController().signal, undefined, ctx());
		assert.equal(result.isError, true);
		assert.equal(resultText(result), `subagent option 'gate' is disabled by config disabledFeatures "gates".`);
	});

	it("rejects a disabled option on a runs.all workflow child before it launches", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-disabled-features-workflow-"));
		try {
			const result = await createExecutor({ disabledFeatures: ["external-machines"] }).executePublic(
				"disabled-workflow-child",
				{
					// A non-literal agent skips static agent validation and reaches launch admission.
					workflowScript: `const agent = "worker"; return await runs.all([{ key: "local", agent, task: "scan" }, { key: "remote", agent, task: "scan", machine: "box" }]);`,
					async: false,
					chatProgress: "off",
				},
				new AbortController().signal,
				undefined,
				ctx(root),
			);
			// runs.all admits the batch together, so neither child launches.
			const error = `workflow child 'remote' option 'machine' is disabled by config disabledFeatures "external-machines".`;
			assert.deepEqual((result.details.workflow?.value as Array<{ key: string; ok: boolean; error?: string }>).map(({ key, ok, error }) => ({ key, ok, error })), [
				{ key: "local", ok: false, error },
				{ key: "remote", ok: false, error },
			]);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("disabled feature discovery", () => {
	const featureText = [
		"not watchdog-only thinking",
		"tool budget, fast",
		"usageBudget is shared",
		"unless options.mission:false",
		"create/update/delete",
		"mission.*",
		"schedule.*",
		"watchdog.*",
		"inspector.*",
		"lane.status",
		"worktree.discard",
		"grant-spawn-budget",
		"Schedules take script inputs",
	];

	it("removes disabled-feature text from the built-in descriptions and keeps the safety guidance", () => {
		const enabled = buildSubagentToolDescription({ toolDescriptionMode: "full" });
		for (const text of featureText) assert.ok(enabled.includes(text), `enabled description lacks ${text}`);
		assert.match(enabled, /Management discovery: list\/get\/models\/guide; create\/update\/delete\/eject\/disable\/enable\/reset\/refine; mission\.\*, schedule\.\*, watchdog\.\*, inspector\.\*, project\.\*, lane\.status\/recordMerge\/recordSupersession; worktree\.discard and reviewed worktree\.cleanup; doctor and grant-spawn-budget\. /);

		const disabledFeatures = resolveDisabledFeatureSurface(ALL_DISABLED);
		for (const toolDescriptionMode of [undefined, "full"] as const) {
			const description = buildSubagentToolDescription({ toolDescriptionMode }, { disabledFeatures });
			for (const text of featureText) assert.ok(!description.includes(text), `${toolDescriptionMode ?? "default"} description still has ${text}`);
			// Every safety line stays; with workflow-scripts disabled only the script-writing wording changes.
			for (const line of SUBAGENT_SAFETY_GUIDANCE.split("\n").filter((text) => !/runs\.|workflow call/.test(text))) assert.ok(description.includes(line), `${toolDescriptionMode ?? "default"} description lacks safety line ${line}`);
			assert.match(description, /Thinking uses model suffix\./);
		}
		assert.match(buildSubagentToolDescription({ toolDescriptionMode: "full" }, { disabledFeatures }), /Management discovery: list\/get\/models\/guide; doctor\. Use guide topics agents, observability, tool-reference, configuration, models or extension-api for/);
	});

	it("lists only enabled actions for an unknown action", async () => {
		const result = await createExecutor({ disabledFeatures: ["watchdog"], scheduledRuns: { enabled: false } }).executePublic("unknown-action", { action: "statsu" }, new AbortController().signal, undefined, ctx());
		assert.equal(result.isError, true);
		assert.match(resultText(result), /Did you mean status\?.*Valid: .*doctor/);
		assert.doesNotMatch(resultText(result), /watchdog\.|schedule\./);
	});

	it("prepends a disabled-feature notice to the tool reference guide", async () => {
		const guide = readSubagentGuide("tool-reference");
		const request = { action: "guide", topic: "tool-reference" };
		const enabled = await createExecutor({}).executePublic("guide", request, new AbortController().signal, undefined, ctx());
		assert.equal(resultText(enabled), guide);
		const disabled = resultText(await createExecutor({ disabledFeatures: ["watchdog"] }).executePublic("guide", request, new AbortController().signal, undefined, ctx()));
		assert.ok(disabled.endsWith(guide));
		assert.match(disabled.slice(0, -guide.length), /^Disabled by config[^\n]*\n- disabledFeatures "watchdog": options scope, target, thinking; actions watchdog\.status, watchdog\.check, watchdog\.configure, watchdog\.recommend-model\n\n$/);
	});

	it("keeps every tool-reference section within the 8,000-char guide cap when every feature is disabled", async () => {
		const executor = createExecutor({ disabledFeatures: Object.keys(SUBAGENT_FEATURES) as SubagentFeature[], scheduledRuns: { enabled: false } });
		const read = async (topic: string) => resultText(await executor.executePublic("guide", { action: "guide", topic }, new AbortController().signal, undefined, ctx()));
		const toc = await read("tool-reference");
		assert.match(toc, /^Disabled by config/);
		const sections = [...toc.matchAll(/^\s*(tool-reference\/\S+) — /gm)].map((match) => match[1]!);
		assert.ok(sections.length > 10);
		for (const section of sections) {
			const text = await read(section);
			assert.match(text, /^Some options and actions documented here are disabled by config/, section);
			assert.ok(text.length <= 8_000, `${section}: ${text.length}`);
		}
	});

	it("advertises only enabled RPC management actions", async () => {
		const handlers: Array<(data: unknown) => void> = [];
		const replies = new Map<string, unknown>();
		const events = {
			on(event: string, handler: (data: unknown) => void) {
				if (event === SUBAGENT_RPC_REQUEST_EVENT) handlers.push(handler);
				return () => {};
			},
			emit(event: string, data: unknown) {
				replies.set(event, data);
			},
		};
		registerSubagentRpcBridge({
			events: events as never,
			getContext: () => ctx(),
			execute: async () => assert.fail("disabled RPC actions must not execute"),
			disabledFeatures: resolveDisabledFeatureSurface({ scheduledRuns: { enabled: false } }),
		});
		const request = async (requestId: string, method: string, params?: unknown) => {
			for (const handler of handlers) await handler({ version: SUBAGENT_RPC_PROTOCOL_VERSION, requestId, method, params });
			return replies.get(subagentRpcReplyEvent(requestId)) as { success: boolean; data?: { capabilities: { managementActions: string[] } }; error?: { message: string } };
		};
		assert.deepEqual((await request("ping", "ping")).data?.capabilities.managementActions, []);
		assert.equal((await request("manage", "manage", { action: "schedule.bogus" })).error?.message, "RPC manage actions are all disabled by config.");
	});
});
