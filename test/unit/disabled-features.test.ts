import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { SUBAGENT_FEATURES, resolveDisabledFeatureSurface, validateDisabledFeatures, type SubagentFeature } from "../../src/extension/features.ts";
import { SubagentParams, createSubagentParamsSchema } from "../../src/extension/schemas.ts";
import { createSubagentExecutor } from "../../src/runs/foreground/subagent-executor.ts";
import { SUBAGENT_ACTIONS, type ExtensionConfig, type SubagentState } from "../../src/shared/types.ts";

const ALL_FEATURES = Object.keys(SUBAGENT_FEATURES) as SubagentFeature[];

function schemaProperties(schema: unknown): Record<string, unknown> {
	return (schema as { properties: Record<string, unknown> }).properties;
}

function createState(): SubagentState {
	return {
		baseCwd: "",
		currentSessionId: null,
		asyncJobs: new Map(),
		foregroundRuns: new Map(),
		foregroundControls: new Map(),
		lastForegroundControlId: null,
		pendingForegroundControlNotices: new Map(),
		cleanupTimers: new Map(),
		lastUiContext: null,
		poller: null,
		completionSeen: new Map(),
		watcher: null,
		watcherRestartTimer: null,
		resultFileCoalescer: { schedule: () => false, clear: () => {} },
	};
}

function createExecutor(config: ExtensionConfig) {
	return createSubagentExecutor({
		pi: { events: { emit() {}, on() { return () => {}; } }, getSessionName() { return "parent"; } } as never,
		state: createState(),
		config: { maxSubagentDepth: 2, control: {}, intercomBridge: {}, ...config } as never,
		asyncByDefault: false,
		tempArtifactsDir: os.tmpdir(),
		getSubagentSessionRoot: () => os.tmpdir(),
		expandTilde: (value) => value,
		discoverAgents: () => ({ agents: [] as never[] }),
	});
}

function ctx(cwd: string) {
	return {
		cwd,
		hasUI: false,
		ui: {},
		sessionManager: { getSessionId() { return "session-disabled-features"; }, getSessionFile() { return null; } },
		modelRegistry: { getAvailable() { return []; } },
		model: { provider: "test", id: "test-model" },
	} as never;
}

function resultText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map((part) => part.text ?? "").join("\n");
}

describe("disabled feature registry", () => {
	it("names only public parameters and actions, and gives each one a single owner", () => {
		const properties = schemaProperties(SubagentParams);
		const owners = new Map<string, string>();
		for (const [feature, surface] of Object.entries(SUBAGENT_FEATURES)) {
			for (const param of surface.params) {
				assert.ok(Object.hasOwn(properties, param), `${feature} names unknown parameter ${param}`);
				assert.equal(owners.get(`param:${param}`), undefined, `${param} has two owners`);
				owners.set(`param:${param}`, feature);
			}
			for (const action of surface.actions) {
				assert.ok((SUBAGENT_ACTIONS as readonly string[]).includes(action), `${feature} names unknown action ${action}`);
				assert.equal(owners.get(`action:${action}`), undefined, `${action} has two owners`);
				owners.set(`action:${action}`, feature);
			}
		}
		const schedules = resolveDisabledFeatureSurface({ scheduledRuns: { enabled: false } });
		for (const param of schedules.params.keys()) assert.ok(Object.hasOwn(properties, param), `schedules names unknown parameter ${param}`);
		for (const action of schedules.actions.keys()) assert.ok((SUBAGENT_ACTIONS as readonly string[]).includes(action), `schedules names unknown action ${action}`);
	});

	it("rejects unknown, duplicate, and schedule entries in config", () => {
		assert.doesNotThrow(() => validateDisabledFeatures(ALL_FEATURES));
		assert.throws(() => validateDisabledFeatures("watchdog"), /must be an array/);
		assert.throws(() => validateDisabledFeatures(["watchdogs"]), /"watchdogs" is not one of/);
		assert.throws(() => validateDisabledFeatures(["gates", "gates"]), /more than once/);
		assert.throws(() => validateDisabledFeatures(["schedules"]), /scheduledRuns\.enabled to false/);
	});
});

describe("disabled feature schema", () => {
	it("keeps the registered schema unchanged when nothing is disabled", () => {
		assert.equal(createSubagentParamsSchema(), SubagentParams);
		assert.equal(createSubagentParamsSchema(resolveDisabledFeatureSurface({})), SubagentParams);
		assert.equal(createSubagentParamsSchema(resolveDisabledFeatureSurface({ scheduledRuns: { enabled: true } })), SubagentParams);
	});

	it("removes exactly the disabled parameters and leaves every other parameter identical", () => {
		const surface = resolveDisabledFeatureSurface({ disabledFeatures: ALL_FEATURES, scheduledRuns: { enabled: false } });
		const full = schemaProperties(SubagentParams);
		const reduced = schemaProperties(createSubagentParamsSchema(surface));
		assert.deepEqual(Object.keys(reduced), Object.keys(full).filter((name) => !surface.params.has(name)));
		for (const [name, schema] of Object.entries(reduced)) assert.deepEqual(schema, full[name], `${name} changed`);
	});

	it("hides one feature without hiding another", () => {
		const reduced = schemaProperties(createSubagentParamsSchema(resolveDisabledFeatureSurface({ disabledFeatures: ["gates"] })));
		assert.equal(Object.hasOwn(reduced, "gate"), false);
		assert.equal(Object.hasOwn(reduced, "toolBudget"), true);
		assert.equal(Object.hasOwn(reduced, "at"), true);
	});
});

describe("disabled feature execution boundary", () => {
	it("rejects a disabled action before management dispatch", async () => {
		const result = await createExecutor({ disabledFeatures: ["watchdog"] }).executePublic("disabled-action", { action: "watchdog.status" }, new AbortController().signal, undefined, ctx(os.tmpdir()));
		assert.equal(result.isError, true);
		assert.equal(resultText(result), `subagent action 'watchdog.status' is disabled by config disabledFeatures "watchdog".`);
	});

	it("rejects schedule actions through the existing scheduledRuns switch", async () => {
		const result = await createExecutor({ scheduledRuns: { enabled: false } }).executePublic("disabled-schedule", { action: "schedule.list" }, new AbortController().signal, undefined, ctx(os.tmpdir()));
		assert.equal(result.isError, true);
		assert.equal(resultText(result), "subagent action 'schedule.list' is disabled by config scheduledRuns.enabled=false.");
	});

	it("rejects a disabled option on a public single-child launch", async () => {
		const result = await createExecutor({ disabledFeatures: ["tool-budgets"] }).executePublic("disabled-option", { agent: "worker", task: "scan", toolBudget: { hard: 3 } }, new AbortController().signal, undefined, ctx(os.tmpdir()));
		assert.equal(result.isError, true);
		assert.equal(resultText(result), `subagent option 'toolBudget' is disabled by config disabledFeatures "tool-budgets".`);
	});

	it("rejects a disabled option on delegated execution", async () => {
		const result = await createExecutor({ disabledFeatures: ["gates"] }).executeDelegated("disabled-delegated", { agent: "worker", task: "scan", gate: "npm test" }, new AbortController().signal, undefined, ctx(os.tmpdir()));
		assert.equal(result.isError, true);
		assert.equal(resultText(result), `subagent option 'gate' is disabled by config disabledFeatures "gates".`);
	});

	it("rejects a disabled option on a workflow child before it launches", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-disabled-features-workflow-"));
		try {
			const result = await createExecutor({ disabledFeatures: ["tool-budgets"] }).executePublic(
				"disabled-workflow-child",
				{
					// A non-literal agent reaches runtime admission instead of static script validation.
					workflowScript: `const agent = "worker"; return await runs.run("scan", { agent, task: "scan", toolBudget: { hard: 3 } });`,
					async: false,
					chatProgress: "off",
				},
				new AbortController().signal,
				undefined,
				ctx(root),
			);
			assert.equal(result.isError, true);
			assert.match(resultText(result), /runs\.run\('scan'\) option 'toolBudget' is disabled by config disabledFeatures "tool-budgets"\./);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
