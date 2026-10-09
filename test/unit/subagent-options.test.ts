import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { SUBAGENT_OPTION_KEYS } from "../../src/extension/schemas.ts";
import { flattenSubagentToolOptions } from "../../src/extension/subagent-options.ts";
import { resolveDisabledFeatureSurface } from "../../src/shared/disabled-features.ts";
import { WAIT_TOOL_ENABLED_ENV } from "../../src/runs/background/subagent-wait.ts";
import { SUBAGENT_CHILD_ENV } from "../../src/runs/shared/child-runtime-config.ts";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// One valid value per management/control field the model passes inside options.
const OPTION_SAMPLES: Record<string, unknown> = {
	extensionBindings: { "pkg/1": {} }, capabilities: true, name: "nightly", dir: "/tmp/run", handoffPath: "handoff.json",
	repo: "/repo", planId: "plan-1", laneId: "lane-1", merge: {}, supersession: {}, index: 0, childId: "child-1",
	toolCallId: "call-1", view: "transcript", lines: 5, topic: "workflows", mode: "follow_up", steeringRecovery: false,
	additional: 1, scope: "session", target: "children", focus: true, thinking: "low", at: "10m", every: "1h",
	sessionOnly: true, quiet: true, on: ["mon"], timezone: "UTC", overlap: "skip", catchUp: "none", missionId: "mission-1",
	mission: false, missionUpdate: {}, missionStatus: "open", missionScope: "project", runMode: "single", runStatus: "running",
	summary: "done", config: { name: "reviewer" }, globalConcurrencyLimit: 2, maxSubagentSpawnsPerRun: 3,
	preflight: { version: 1, lanes: [] }, chatProgress: "off", baseRef: "main", lane: { version: 1, key: "lane-a" },
	context: "fresh", timeoutMs: 1000, checkpointBeforeDeadlineMs: 100, toolTimeoutMs: 100, toolBudget: { hard: 3 },
	usageBudget: { tokens: { hard: 10 } }, agentScope: "user", machine: "box", artifacts: false, includeProgress: true,
	share: false, sessionDir: "/tmp/sessions", control: { enabled: false }, outputMode: "file-only", skill: "review",
	fast: false, outputSchema: { type: "object" }, agentContract: { version: 1 }, acceptance: "checked", gate: "npm test", maxOutput: { bytes: 1000 },
};

describe("subagent tool options", () => {
	it("lowers every options field to the flat params the executor reads", () => {
		assert.deepEqual(Object.keys(OPTION_SAMPLES).sort(), [...SUBAGENT_OPTION_KEYS].sort());
		assert.deepEqual(flattenSubagentToolOptions({ action: "status", options: OPTION_SAMPLES }), { action: "status", ...OPTION_SAMPLES });
		assert.deepEqual(flattenSubagentToolOptions({ agent: "worker", task: "scan" }), { agent: "worker", task: "scan" });
	});

	it("keeps top-level management fields and aliases, and rejects a field given in both places with different values", () => {
		const flat = { action: "status", runId: "r1", view: "transcript", lines: 5, isolation: "worktree", maxRuntimeMs: 1000 };
		assert.deepEqual(flattenSubagentToolOptions(flat), flat);
		assert.deepEqual(flattenSubagentToolOptions({ action: "status", view: "fleet", options: { view: "fleet", lines: 5 } }), { action: "status", view: "fleet", lines: 5 });
		assert.throws(() => flattenSubagentToolOptions({ action: "status", view: "fleet", lines: 5, options: { view: "transcript", lines: 6 } }), { message: "subagent: 'view', 'lines' given both at the top level and in options with different values; give each once." });
	});

	it("points typos, aliases and top-level fields inside options to the field to use", () => {
		assert.throws(() => flattenSubagentToolOptions({ agent: "worker", task: "scan", options: { acceptence: "checked" } }), { message: /^subagent: unknown options key 'acceptence'\. Did you mean 'acceptance'\? Valid options: acceptance, additional, agentContract, / });
		assert.throws(() => flattenSubagentToolOptions({ agent: "worker", task: "scan", options: { maxRuntimeMs: 1000 } }), { message: /^subagent: unknown options key 'maxRuntimeMs'; use options\.timeoutMs\. Valid options: / });
		assert.throws(() => flattenSubagentToolOptions({ action: "status", options: { id: "r1" } }), { message: /^subagent: 'id' is a top-level field, not an option\. Valid options: / });
		assert.throws(() => flattenSubagentToolOptions({ options: { workflowScript: "return 1" } }), /workflowScript was removed/);
		assert.throws(() => flattenSubagentToolOptions({ action: "status", options: { lines: 0 } }), /options\.lines must be >= 1/);
		assert.throws(() => flattenSubagentToolOptions({ action: "status", options: [] }), /options must be an object/);
	});

	it("rejects a disabled option by its options path and leaves it out of the valid list", () => {
		const disabled = resolveDisabledFeatureSurface({ disabledFeatures: ["gates"] });
		assert.throws(() => flattenSubagentToolOptions({ agent: "worker", task: "scan", options: { gate: "npm test" } }, disabled), { message: `subagent option 'options.gate' is disabled by config disabledFeatures "gates".` });
		assert.throws(() => flattenSubagentToolOptions({ agent: "worker", task: "scan", options: { gat: "npm test" } }, disabled), (error: Error) => {
			assert.doesNotMatch(error.message, /\bgate\b/);
			return true;
		});
	});
});

describe("registered subagent tools with options", () => {
	it("run management, control, schedule, and launch fields from options or the top level end to end", () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-options-"));
		fs.writeFileSync(path.join(cwd, "flow.js"), "return 1;\n");
		const script = String.raw`
			import assert from "node:assert/strict";
			import registerSubagentExtension from "./index.ts";
			import registerFanoutChildSubagentExtension from "./src/extension/fanout-child.ts";
			const tools = {};
			const makePi = (name) => new Proxy({
				events: { on() { return () => {}; }, emit() {} },
				registerTool(tool) { if (tool.name === "subagent") tools[name] = tool; },
				registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {}, sendMessage() {}, getSessionName() {},
			}, { get(target, prop) { return prop in target ? target[prop] : () => undefined; } });
			registerSubagentExtension(makePi("parent"));
			registerFanoutChildSubagentExtension(makePi("fanout"), { fanoutChild: true, depth: 1, waitTool: { enabled: true }, fast: false });
			const ctx = {
				cwd: ${JSON.stringify(cwd)}, isIdle() { return true; }, hasUI: false,
				sessionManager: { getSessionId() { return "session-test"; }, getSessionFile() { return null; }, getBranch() { return []; }, getEntries() { return []; } },
				modelRegistry: { getAvailable() { return []; } },
			};
			const text = (result) => result.content.map((part) => part.text ?? "").join("\n");
			const call = (params, tool = tools.parent) => tool.execute("options-e2e", params, new AbortController().signal, undefined, ctx);

			assert.doesNotMatch(text(await call({ action: "status" })), /No active subagent fleet/);
			assert.match(text(await call({ action: "status", options: { view: "fleet" } })), /No active subagent fleet/);
			assert.match(text(await call({ action: "status", view: "fleet" })), /No active subagent fleet/);
			await assert.rejects(call({ action: "status", runId: "missing-run", view: "transcript" }), /Transcript target: run missing-run/);
			await assert.rejects(call({ action: "status", options: { view: "fleet" } }, tools.fanout), /Child-safe subagent fleet view is unavailable/);
			await assert.rejects(call({ action: "status", id: "missing-run", options: { view: "transcript", lines: 5 } }), /Transcript target: run missing-run/);
			await assert.rejects(call({ action: "steer", id: "missing-run", message: "focus", options: { mode: "plan" } }), /action='steer' mode must be/);
			assert.match(text(await call({ action: "schedule.create", workflow: "./flow.js", options: { every: "1h", name: "nightly" } })), /Trigger: every 1h/);
			await assert.rejects(call({ agent: "worker", task: "scan", options: { acceptance: "checked", timeoutMs: 3000000000 } }), /timeoutMs must be a positive integer no larger/);
			const theme = { fg(_name, value) { return value; }, bold(value) { return value; } };
			assert.match(tools.parent.renderCall({ workflow: true, options: { preflight: { version: 1, lanes: [] } } }, theme).text, /preflight/);
			assert.match(tools.parent.renderCall({ workflow: true, preflight: { version: 1, lanes: [] } }, theme).text, /preflight/);
		`;
		const env = { ...process.env };
		delete env[SUBAGENT_CHILD_ENV];
		delete env[WAIT_TOOL_ENABLED_ENV];
		try {
			execFileSync(process.execPath, ["--experimental-strip-types", "--import", "./test/support/register-loader.mjs", "--input-type=module", "--eval", script], { cwd: projectRoot, env, stdio: "pipe" });
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true, maxRetries: 3 });
		}
	});
});
