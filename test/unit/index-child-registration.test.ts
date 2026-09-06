import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { WAIT_TOOL_ENABLED_ENV } from "../../src/runs/background/subagent-wait.ts";
import { SUBAGENT_CHILD_ENV } from "../../src/runs/shared/child-runtime-config.ts";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function parentToolEnv(agentDir?: string): NodeJS.ProcessEnv {
	const env = { ...process.env };
	delete env[SUBAGENT_CHILD_ENV];
	delete env[WAIT_TOOL_ENABLED_ENV];
	if (agentDir) env.PI_CODING_AGENT_DIR = agentDir;
	return env;
}

describe("subagent extension child mode", () => {
	it("defers persistence when startup config expires a cached exclusion", () => {
		const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-model-exclusion-startup-"));
		const exclusionPath = path.join(agentDir, "model-exclusions.json");
		try {
			const configDir = path.join(agentDir, "extensions", "subagent");
			fs.mkdirSync(configDir, { recursive: true });
			fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({ modelExclusions: { defaultTtlMs: 300_000 } }), "utf-8");
			const recordedAt = Date.now() - 600_000;
			const originalExpiry = Date.now() + 3_600_000;
			fs.writeFileSync(exclusionPath, JSON.stringify({
				version: 1,
				exclusions: [{ provider: "openai", modelId: "old-model", reason: "503", recordedAt, expiresAt: originalExpiry }],
			}), "utf-8");
			const script = String.raw`
				import registerSubagentExtension from "./index.ts";
				import { isExcluded } from "./src/runs/shared/model-exclusions.ts";
				const events = { on() { return () => {}; }, emit() {} };
				const fakePi = new Proxy({
					events,
					registerTool() {}, registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {}, sendMessage() {}, getSessionName() {},
				}, { get(target, prop) { return prop in target ? target[prop] : () => undefined; } });
				registerSubagentExtension(fakePi);
				if (isExcluded("old-model", "openai")) throw new Error("startup TTL clamp did not expire the cached exclusion in memory");
			`;
			const env = parentToolEnv(agentDir);
			env.PI_MODEL_EXCLUSIONS_PATH = exclusionPath;
			execFileSync(process.execPath, ["--experimental-strip-types", "--import", "./test/support/register-loader.mjs", "--input-type=module", "--eval", script], { cwd: projectRoot, env, stdio: "pipe" });
			const persisted = JSON.parse(fs.readFileSync(exclusionPath, "utf-8")).exclusions[0] as { expiresAt: number };
			assert.equal(persisted.expiresAt, originalExpiry);
		} finally {
			fs.rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("applies model exclusion TTL from extension config at registration", () => {
		const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-model-exclusion-config-"));
		const exclusionPath = path.join(agentDir, "model-exclusions.json");
		try {
			const configDir = path.join(agentDir, "extensions", "subagent");
			fs.mkdirSync(configDir, { recursive: true });
			fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({ modelExclusions: { defaultTtlMs: 300_000 } }), "utf-8");
			const recordedAt = Date.now();
			fs.writeFileSync(exclusionPath, JSON.stringify({
				version: 1,
				exclusions: [{ provider: "openai", modelId: "old-model", reason: "503", recordedAt, expiresAt: recordedAt + 3_600_000 }],
			}), "utf-8");
			const script = String.raw`
				import * as fs from "node:fs";
				import registerSubagentExtension from "./index.ts";
				import { recordModelFailure } from "./src/runs/shared/model-exclusions.ts";
				const events = { on() { return () => {}; }, emit() {} };
				const fakePi = new Proxy({
					events,
					registerTool() {}, registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {}, sendMessage() {}, getSessionName() {},
				}, { get(target, prop) { return prop in target ? target[prop] : () => undefined; } });
				registerSubagentExtension(fakePi);
				recordModelFailure({ modelId: "gpt-5", provider: "openai", reason: "test" });
				const entries = JSON.parse(fs.readFileSync(process.env.PI_MODEL_EXCLUSIONS_PATH, "utf-8")).exclusions;
				for (const entry of entries) {
					if (entry.expiresAt - entry.recordedAt !== 300_000) throw new Error("configured model exclusion TTL was not applied: " + JSON.stringify(entry));
				}
			`;
			const env = parentToolEnv(agentDir);
			env.PI_MODEL_EXCLUSIONS_PATH = exclusionPath;
			execFileSync(process.execPath, ["--experimental-strip-types", "--import", "./test/support/register-loader.mjs", "--input-type=module", "--eval", script], { cwd: projectRoot, env, stdio: "pipe" });
		} finally {
			fs.rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("collapses tool detail before direct subagent tool execution", () => {
		const script = String.raw`
			import registerSubagentExtension from "./index.ts";
			const events = { on() { return () => {}; }, emit() {} };
			let registeredTool;
			const fakePi = new Proxy({
				events,
				registerTool(tool) { if (tool.name === "subagent") registeredTool = tool; },
				registerCommand() {},
				registerShortcut() {},
				registerMessageRenderer() {},
				sendMessage() {},
				getSessionName() { return undefined; },
			}, {
				get(target, prop) {
					if (prop in target) return target[prop];
					return () => undefined;
				},
			});
			registerSubagentExtension(fakePi);
			if (!registeredTool) throw new Error("tool not registered");
			const calls = [];
			const ctx = {
				cwd: process.cwd(),
				hasUI: true,
				ui: {
					setToolsExpanded(value) { calls.push(value); },
					setWidget() {},
					requestRender() {},
					theme: { fg(_name, text) { return text; }, bg(_name, text) { return text; }, bold(text) { return text; } },
				},
				sessionManager: { getSessionId() { return "session-test"; }, getSessionFile() { return null; } },
				modelRegistry: { getAvailable() { return []; } },
			};
			await registeredTool.execute("collapse-check", { action: "list" }, new AbortController().signal, undefined, ctx);
			if (calls[0] !== false) throw new Error("expected setToolsExpanded(false), got " + JSON.stringify(calls));
		`;

		execFileSync(
			process.execPath,
			[
				"--experimental-strip-types",
				"--import",
				"./test/support/register-loader.mjs",
				"--input-type=module",
				"--eval",
				script,
			],
			{ cwd: projectRoot, env: parentToolEnv(), stdio: "pipe" },
		);
	});

	it("renders only the public workflow execution mode", () => {
		const script = String.raw`
			import registerSubagentExtension from "./index.ts";
			const events = { on() { return () => {}; }, emit() {} };
			let registeredTool;
			const fakePi = new Proxy({
				events,
				registerTool(tool) { if (tool.name === "subagent") registeredTool = tool; },
				registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {}, sendMessage() {}, getSessionName() {},
			}, { get(target, prop) { return prop in target ? target[prop] : () => undefined; } });
			registerSubagentExtension(fakePi);
			if (!registeredTool) throw new Error("tool not registered");
			const theme = { fg(_name, text) { return text; }, bold(text) { return text; } };
			const workflow = registeredTool.renderCall({
				workflowScript: "const scan = await runs.run('scan', {agent:'worker'}); return runs.all([{key:'correctness',agent:'reviewer'},{key:'tests',agent:'reviewer'}]);",
			}, theme).text;
			const foregroundWorkflow = registeredTool.renderCall({ workflowScript: "return runs.run('publish', {agent:'worker'});", async: false }, theme).text;
			const templateWorkflow = registeredTool.renderCall({ workflowScript: "return runs.run(\`template\`, {agent:'worker'});", async: false }, theme).text;
			const commentedWorkflow = registeredTool.renderCall({ workflowScript: "// runs.run('ignored', {agent:'worker'})\nconst note = \"key: 'also-ignored'\"; return runs.run('real', {agent:'worker'});" }, theme).text;
			const dynamicKeyWorkflow = registeredTool.renderCall({ workflowScript: "return runs.all([{key: 'review-' + item, agent: 'reviewer'}]);" }, theme).text;
			const ordinaryKeyWorkflow = registeredTool.renderCall({ workflowScript: "const config = {key: 'secret'}; return runs.all([{agent: 'reviewer', config: {key: 'nested'}, key: 'review'}]);" }, theme).text;
			if (!workflow.includes("background · 3 lanes: scan, correctness, tests")) throw new Error("expected workflow manifest, got " + workflow);
			if (!foregroundWorkflow.includes("foreground · 1 lane: publish")) throw new Error("expected foreground workflow manifest, got " + foregroundWorkflow);
			if (!templateWorkflow.includes("foreground · 1 lane: template")) throw new Error("expected static template lane, got " + templateWorkflow);
			if (!commentedWorkflow.includes("background · 1 lane: real")) throw new Error("expected lexical lane filtering, got " + commentedWorkflow);
			if (!dynamicKeyWorkflow.includes("workflow script · background")) throw new Error("expected dynamic key fallback, got " + dynamicKeyWorkflow);
			if (!ordinaryKeyWorkflow.includes("background · 1 lane: review") || ordinaryKeyWorkflow.includes("secret") || ordinaryKeyWorkflow.includes("nested")) throw new Error("expected only runs.all child key, got " + ordinaryKeyWorkflow);
		`;
		execFileSync(process.execPath, ["--experimental-strip-types", "--import", "./test/support/register-loader.mjs", "--input-type=module", "--eval", script], { cwd: projectRoot, env: parentToolEnv(), stdio: "pipe" });
	});

	it("shows omitted workflow async as background even when asyncByDefault is false", () => {
		const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-workflow-manifest-config-"));
		try {
			const configDir = path.join(agentDir, "extensions", "subagent");
			fs.mkdirSync(configDir, { recursive: true });
			fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({ asyncByDefault: false, forceTopLevelAsync: true }), "utf-8");
			const script = String.raw`
				import registerSubagentExtension from "./index.ts";
				const events = { on() { return () => {}; }, emit() {} };
				let registeredTool;
				const fakePi = new Proxy({
					events, registerTool(tool) { if (tool.name === "subagent") registeredTool = tool; },
					registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {}, sendMessage() {}, getSessionName() {},
				}, { get(target, prop) { return prop in target ? target[prop] : () => undefined; } });
				registerSubagentExtension(fakePi);
				const theme = { fg(_name, text) { return text; }, bold(text) { return text; } };
				const result = registeredTool.renderCall({
					workflowScript: "return runs.run('scan' /* stable lane */, {agent:'worker'});",
				}, theme).text;
				const explicitForeground = registeredTool.renderCall({
					workflowScript: "return runs.run('publish', {agent:'worker'});",
					async: false,
				}, theme).text;
				if (!result.includes("background · 1 lane: scan")) throw new Error("expected workflow executor background manifest, got " + result);
				if (!explicitForeground.includes("foreground · 1 lane: publish")) throw new Error("expected workflow executor foreground manifest, got " + explicitForeground);
			`;
			const env = parentToolEnv();
			env.PI_CODING_AGENT_DIR = agentDir;
			execFileSync(process.execPath, ["--experimental-strip-types", "--import", "./test/support/register-loader.mjs", "--input-type=module", "--eval", script], { cwd: projectRoot, env, stdio: "pipe" });
		} finally {
			fs.rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("keeps registered tool errors actionable while successful results stay collapsed", () => {
		const script = String.raw`
			import registerSubagentExtension from "./index.ts";
			const events = { on() { return () => {}; }, emit() {} };
			let registeredTool;
			const fakePi = new Proxy({
				events,
				registerTool(tool) { if (tool.name === "subagent") registeredTool = tool; },
				registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {},
				sendMessage() {}, getSessionName() { return undefined; },
			}, { get(target, prop) { return prop in target ? target[prop] : () => undefined; } });
			registerSubagentExtension(fakePi);
			if (!registeredTool) throw new Error("tool not registered");

			const theme = { fg(_name, text) { return text; }, bold(text) { return text; } };
			const render = (text, isError) => registeredTool.renderResult({
				content: [{ type: "text", text }],
				details: { mode: "management", results: [] },
			}, { expanded: false }, theme, { isError, state: {} }).render(120).join("\n");

			const error = render("Agent configuration is invalid.\nSet tools to an array.\nRetry the subagent call.", true);
			if (!error.includes("Set tools to an array.")) throw new Error("error remediation was hidden: " + error);
			if (!error.includes("Retry the subagent call.")) throw new Error("error retry guidance was hidden: " + error);
			if (error.includes("3 lines")) throw new Error("error was collapsed: " + error);

			const success = render("Managed agents:\n- reviewer\n- writer", false);
			if (!success.includes("Managed agents: · 3 lines")) throw new Error("success summary was not collapsed: " + success);
			if (success.includes("- reviewer") || success.includes("- writer")) throw new Error("success details were not collapsed: " + success);
		`;

		execFileSync(
			process.execPath,
			[
				"--experimental-strip-types",
				"--import",
				"./test/support/register-loader.mjs",
				"--input-type=module",
				"--eval",
				script,
			],
			{ cwd: projectRoot, env: parentToolEnv(), stdio: "pipe" },
		);
	});

	it("rejects blank action at the public executor boundary", () => {
		const script = String.raw`
			import assert from "node:assert/strict";
			import registerSubagentExtension from "./index.ts";
			const events = { on() { return () => {}; }, emit() {} };
			let registeredTool;
			const fakePi = new Proxy({
				events,
				registerTool(tool) { if (tool.name === "subagent") registeredTool = tool; },
				registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {}, sendMessage() {}, getSessionName() {},
			}, { get(target, prop) { return prop in target ? target[prop] : () => undefined; } });
			registerSubagentExtension(fakePi);
			if (!registeredTool) throw new Error("tool not registered");
			await assert.rejects(
				registeredTool.execute("blank-action", { action: "", agent: "reviewer" }, new AbortController().signal, undefined, { cwd: process.cwd(), hasUI: false }),
				/action must be a non-empty/,
			);
		`;

		execFileSync(
			process.execPath,
			[
				"--experimental-strip-types",
				"--import",
				"./test/support/register-loader.mjs",
				"--input-type=module",
				"--eval",
				script,
			],
			{ cwd: projectRoot, env: parentToolEnv(), stdio: "pipe" },
		);
	});

	it("does not animate foreground results on a timer", () => {
		const script = String.raw`
			import registerSubagentExtension from "./index.ts";
			const events = { on() { return () => {}; }, emit() {} };
			let registeredTool;
			const fakePi = new Proxy({
				events,
				registerTool(tool) { if (tool.name === "subagent") registeredTool = tool; },
				registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {},
				sendMessage() {}, getSessionName() { return undefined; },
			}, { get(target, prop) { return prop in target ? target[prop] : () => undefined; } });
			registerSubagentExtension(fakePi);
			if (!registeredTool) throw new Error("tool not registered");
			let invalidations = 0;
			let legacyTicks = 0;
			const context = {
				state: { subagentResultAnimationTimer: setInterval(() => { legacyTicks += 1; }, 10) },
				invalidate() { invalidations += 1; },
			};
			registeredTool.renderResult({
				content: [{ type: "text", text: "running" }],
				details: {
					mode: "single",
					results: [{
						agent: "worker", task: "quiet", exitCode: 0, messages: [],
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
						progress: { status: "running", index: 0, agent: "worker", toolCount: 0, tokens: 0, durationMs: 0 },
					}],
				},
			}, { expanded: false }, { fg(_name, text) { return text; }, bold(text) { return text; } }, context);
			await new Promise((resolve) => setTimeout(resolve, 120));
			if (context.state.subagentResultAnimationTimer) clearInterval(context.state.subagentResultAnimationTimer);
			if (context.state.subagentResultAnimationTimer !== undefined) throw new Error("legacy timer was not cleared");
			if (legacyTicks !== 0) throw new Error("legacy timer ticked " + legacyTicks + " times");
			if (invalidations !== 0) throw new Error("foreground result invalidated " + invalidations + " times");
		`;

		execFileSync(
			process.execPath,
			[
				"--experimental-strip-types",
				"--import",
				"./test/support/register-loader.mjs",
				"--input-type=module",
				"--eval",
				script,
			],
			{ cwd: projectRoot, env: parentToolEnv(), stdio: "pipe" },
		);
	});

	it("keeps summary inline tool display to one stable row for every supported state", () => {
		const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-inline-display-config-"));
		try {
			const configDir = path.join(agentDir, "extensions", "subagent");
			fs.mkdirSync(configDir, { recursive: true });
			fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({ inlineToolDisplay: "summary" }), "utf-8");

			const script = String.raw`
				import registerSubagentExtension from "./index.ts";
				const events = { on() { return () => {}; }, emit() {} };
				let registeredTool;
				const fakePi = new Proxy({
					events,
					registerTool(tool) { if (tool.name === "subagent") registeredTool = tool; },
					registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {}, sendMessage() {}, getSessionName() {},
				}, { get(target, prop) { return prop in target ? target[prop] : () => undefined; } });
				registerSubagentExtension(fakePi);
				if (!registeredTool) throw new Error("tool not registered");
				const theme = { fg(_name, text) { return text; }, bold(text) { return text; } };
				const base = {
					agent: "delegate", task: "quiet", messages: [],
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
				};
				const running = registeredTool.renderResult({
					content: [{ type: "text", text: "partial output that must not appear" }],
					details: { mode: "single", results: [{ ...base, exitCode: 0, progress: { status: "running", index: 0, agent: "delegate", toolCount: 2, tokens: 300, durationMs: 20_000 } }] },
				}, { expanded: false, isPartial: true }, theme, { state: {} }).render(120);
				const asyncSingle = registeredTool.renderResult({
					content: [{ type: "text", text: "Async: delegate [single-run]" }],
					details: { mode: "single", runId: "single-run", asyncId: "single-run", asyncDir: "/tmp/single-run", results: [] },
				}, { expanded: false }, theme, { state: {} }).render(120);
				const asyncChain = registeredTool.renderResult({
					content: [{ type: "text", text: "Async chain [chain-run]" }],
					details: { mode: "chain", runId: "chain-run", asyncId: "chain-run", asyncDir: "/tmp/chain-run", results: [] },
				}, { expanded: false }, theme, { state: {} }).render(120);
				const completed = registeredTool.renderResult({
					content: [{ type: "text", text: "completed output that must not appear" }],
					details: { mode: "single", results: [{ ...base, exitCode: 0 }] },
				}, { expanded: true, isPartial: false }, theme, { state: {} }).render(120);
				const stopped = registeredTool.renderResult({
					content: [{ type: "text", text: "cancelled output that must not appear" }],
					details: { mode: "single", results: [{ ...base, exitCode: 1, stopped: true, error: "Cancelled by user" }] },
				}, { expanded: true, isPartial: false }, theme, { state: {} }).render(120);
				const paused = registeredTool.renderResult({
					content: [{ type: "text", text: "paused output that must not appear" }],
					details: { mode: "single", results: [{ ...base, exitCode: 1, interrupted: true }] },
				}, { expanded: true, isPartial: false }, theme, { state: {} }).render(120);
				const failed = registeredTool.renderResult({
					content: [{ type: "text", text: "failed output that must not appear" }],
					details: { mode: "single", results: [{ ...base, exitCode: 1, stopped: false }] },
				}, { expanded: true, isPartial: false }, theme, { state: {} }).render(120);
				const failedWithPaused = registeredTool.renderResult({
					content: [{ type: "text", text: "aggregate output that must not appear" }],
					details: { mode: "parallel", results: [{ ...base, agent: "paused", exitCode: 1, interrupted: true }, { ...base, agent: "failed", exitCode: 1, stopped: false }] },
				}, { expanded: true, isPartial: false }, theme, { state: {} }).render(120);
				const failedWithStopped = registeredTool.renderResult({
					content: [{ type: "text", text: "aggregate output that must not appear" }],
					details: { mode: "parallel", results: [{ ...base, agent: "stopped", exitCode: 1, stopped: true }, { ...base, agent: "failed", exitCode: 1, stopped: false }] },
				}, { expanded: true, isPartial: false }, theme, { state: {} }).render(120);
				const contextError = registeredTool.renderResult({
					content: [{ type: "text", text: "Agent configuration is invalid." }],
					details: { mode: "management", results: [] },
				}, { expanded: false, isPartial: false }, theme, { isError: true, state: {} }).render(120);
				if (running.length !== 1 || running[0] !== "● delegate · running") throw new Error("unexpected running summary: " + JSON.stringify(running));
				if (asyncSingle.length !== 1 || asyncSingle[0] !== "● single · running") throw new Error("unexpected async single summary: " + JSON.stringify(asyncSingle));
				if (asyncChain.length !== 1 || asyncChain[0] !== "● chain · running") throw new Error("unexpected async chain summary: " + JSON.stringify(asyncChain));
				if (completed.length !== 1 || completed[0] !== "✓ delegate · completed") throw new Error("unexpected completed summary: " + JSON.stringify(completed));
				if (stopped.length !== 1 || stopped[0] !== "■ delegate · stopped") throw new Error("unexpected stopped summary: " + JSON.stringify(stopped));
				if (paused.length !== 1 || paused[0] !== "■ delegate · paused") throw new Error("unexpected paused summary: " + JSON.stringify(paused));
				if (failed.length !== 1 || failed[0] !== "✗ delegate · failed") throw new Error("unexpected failed summary: " + JSON.stringify(failed));
				if (failedWithPaused.length !== 1 || failedWithPaused[0] !== "✗ parallel · failed") throw new Error("unexpected paused aggregate summary: " + JSON.stringify(failedWithPaused));
				if (failedWithStopped.length !== 1 || failedWithStopped[0] !== "✗ parallel · failed") throw new Error("unexpected stopped aggregate summary: " + JSON.stringify(failedWithStopped));
				if (contextError.length !== 1 || contextError[0] !== "✗ management · failed") throw new Error("unexpected context error summary: " + JSON.stringify(contextError));
			`;
			const env = parentToolEnv();
			env.PI_CODING_AGENT_DIR = agentDir;
			execFileSync(process.execPath, ["--experimental-strip-types", "--import", "./test/support/register-loader.mjs", "--input-type=module", "--eval", script], { cwd: projectRoot, env, stdio: "pipe" });
		} finally {
			fs.rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("uses configured main-window renderer spacing for call rows", () => {
		const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-renderer-density-config-"));
		try {
			const configDir = path.join(agentDir, "extensions", "subagent");
			fs.mkdirSync(configDir, { recursive: true });
			fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({ mainWindowRenderer: { horizontalSpacing: 0 } }), "utf-8");

			const script = String.raw`
				import registerSubagentExtension from "./index.ts";
				const events = { on() { return () => {}; }, emit() {} };
				let registeredTool;
				const fakePi = new Proxy({
					events,
					registerTool(tool) { if (tool.name === "subagent") registeredTool = tool; },
					registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {}, sendMessage() {}, getSessionName() {},
				}, { get(target, prop) { return prop in target ? target[prop] : () => undefined; } });
				registerSubagentExtension(fakePi);
				if (!registeredTool) throw new Error("tool not registered");
				const theme = { fg(_name, text) { return text; }, bold(text) { return text; } };
				const call = registeredTool.renderCall({ agent: "worker", async: true }, theme).render(120).map((line) => line.trimEnd());
				if (call.length !== 1 || call[0] !== "subagentworker[async]") throw new Error("unexpected call row: " + JSON.stringify(call));
			`;
			const env = parentToolEnv();
			env.PI_CODING_AGENT_DIR = agentDir;
			execFileSync(process.execPath, ["--experimental-strip-types", "--import", "./test/support/register-loader.mjs", "--input-type=module", "--eval", script], { cwd: projectRoot, env, stdio: "pipe" });
		} finally {
			fs.rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("uses configured main-window renderer density for slash results", () => {
		const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-slash-renderer-density-config-"));
		try {
			const configDir = path.join(agentDir, "extensions", "subagent");
			fs.mkdirSync(configDir, { recursive: true });
			fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({ mainWindowRenderer: { horizontalSpacing: 0, compactResultMaxLines: 3 } }), "utf-8");

			const script = String.raw`
				import registerSubagentExtension from "./index.ts";
				const events = { on() { return () => {}; }, emit() {} };
				let slashRenderer;
				const fakePi = new Proxy({
					events,
					registerTool() {}, registerCommand() {}, registerShortcut() {}, sendMessage() {}, getSessionName() {},
					registerMessageRenderer(type, renderer) { if (type === "subagent-slash-result") slashRenderer = renderer; },
				}, { get(target, prop) { return prop in target ? target[prop] : () => undefined; } });
				registerSubagentExtension(fakePi);
				if (!slashRenderer) throw new Error("slash renderer not registered");
				const result = slashRenderer({ details: {
					requestId: "slash-density",
					result: { content: [{ type: "text", text: "done" }], details: { mode: "parallel", results: [
						{ agent: "scout", task: "a", exitCode: 0, messages: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 } },
						{ agent: "reviewer", task: "b", exitCode: 0, messages: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 } },
						{ agent: "writer", task: "c", exitCode: 0, messages: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 } },
					] } },
				} }, { expanded: false }, { fg(_name, text) { return text; }, bg(_name, text) { return text; }, bold(text) { return text; } });
				const lines = result.render(120);
				if (lines.length !== 6) throw new Error("expected outer spacer, box rows, and three capped result rows: " + JSON.stringify(lines));
				if (!lines[4].includes("rows hidden")) throw new Error("compact cap was not applied: " + JSON.stringify(lines));
			`;
			const env = parentToolEnv();
			env.PI_CODING_AGENT_DIR = agentDir;
			execFileSync(process.execPath, ["--experimental-strip-types", "--import", "./test/support/register-loader.mjs", "--input-type=module", "--eval", script], { cwd: projectRoot, env, stdio: "pipe" });
		} finally {
			fs.rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("registers bg_wait and honors waitTool disabled config", () => {
		const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-wait-tool-config-"));
		try {
			const configDir = path.join(agentDir, "extensions", "subagent");
			fs.mkdirSync(configDir, { recursive: true });
			fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({ waitTool: { enabled: false } }), "utf-8");

			const script = String.raw`
				import registerSubagentExtension from "./index.ts";
				const events = { on() { return () => {}; }, emit() {} };
				let bgWaitTool;
				let legacyWaitRegistered = false;
				const fakePi = new Proxy({
					events,
					registerTool(tool) {
						if (tool.name === "bg_wait") bgWaitTool = tool;
						if (tool.name === "wait") legacyWaitRegistered = true;
					},
					registerCommand() {},
					registerShortcut() {},
					registerMessageRenderer() {},
					sendMessage() {},
					getSessionName() { return undefined; },
				}, {
					get(target, prop) {
						if (prop in target) return target[prop];
						return () => undefined;
					},
				});
				registerSubagentExtension(fakePi);
				if (!bgWaitTool) throw new Error("bg_wait tool not registered");
				if (legacyWaitRegistered) throw new Error("legacy wait tool must not be registered");
				const result = await bgWaitTool.execute("bg-wait-disabled", {}, new AbortController().signal, undefined, {});
				process.stdout.write(JSON.stringify(result.content[0].text));
			`;

			const env = parentToolEnv();
			env.PI_CODING_AGENT_DIR = agentDir;
			const output = execFileSync(
				process.execPath,
				[
					"--experimental-strip-types",
					"--import",
					"./test/support/register-loader.mjs",
					"--input-type=module",
					"--eval",
					script,
				],
				{ cwd: projectRoot, env, encoding: "utf-8" },
			);
			assert.match(JSON.parse(output) as string, /disabled/i);
		} finally {
			fs.rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("does not restore the async widget from tool results when asyncWidget is disabled", () => {
		const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-async-widget-config-"));
		try {
			const configDir = path.join(agentDir, "extensions", "subagent");
			fs.mkdirSync(configDir, { recursive: true });
			fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({ asyncWidget: false }), "utf-8");
			const script = String.raw`
				import registerSubagentExtension from "./index.ts";
				const eventHandlers = new Map();
				const handlers = new Map();
				const events = { on(channel, handler) { eventHandlers.set(channel, handler); return () => {}; }, emit() {} };
				const fakePi = new Proxy({
					events,
					on(channel, handler) { handlers.set(channel, [...(handlers.get(channel) ?? []), handler]); },
					registerTool() {}, registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {},
					sendMessage() {}, getSessionName() { return undefined; },
				}, { get(target, prop) { return prop in target ? target[prop] : () => undefined; } });
				const widgets = [];
				const ctx = {
					cwd: process.cwd(), hasUI: true,
					ui: { setWidget(key, value) { widgets.push({ key, value }); }, requestRender() {}, theme: { fg(_name, text) { return text; }, bg(_name, text) { return text; }, bold(text) { return text; } } },
					sessionManager: { getSessionId() { return "session-widget"; }, getSessionFile() { return null; }, getEntries() { return []; } },
					modelRegistry: { getAvailable() { return []; } },
				};
				registerSubagentExtension(fakePi);
				for (const handler of handlers.get("session_start")) await handler({}, ctx);
				widgets.length = 0;
				eventHandlers.get("subagent:async-started")({ id: "widget-run", pid: 1, sessionId: "session-widget", mode: "single", agent: "worker", asyncDir: "/tmp/widget-run" });
				for (const handler of handlers.get("tool_result")) await handler({ toolName: "subagent" }, ctx);
				const asyncWidgets = widgets.filter((entry) => entry.key === "subagent-async");
				if (asyncWidgets.length < 2 || asyncWidgets.some((entry) => entry.value !== undefined)) throw new Error("async widget rendered despite disabled config: " + JSON.stringify(asyncWidgets));
				for (const handler of handlers.get("session_shutdown")) await handler();
			`;
			const env = parentToolEnv();
			env.PI_CODING_AGENT_DIR = agentDir;
			execFileSync(process.execPath, ["--experimental-strip-types", "--import", "./test/support/register-loader.mjs", "--input-type=module", "--eval", script], { cwd: projectRoot, env, stdio: "pipe" });
		} finally {
			fs.rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("shows active async work in the under-editor widget when FleetView is enabled", () => {
		const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-async-widget-fleet-"));
		try {
			const configDir = path.join(agentDir, "extensions", "subagent");
			fs.mkdirSync(configDir, { recursive: true });
			fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({ fleetView: true }), "utf-8");
			const script = String.raw`
				import registerSubagentExtension from "./index.ts";
				const eventHandlers = new Map();
				const handlers = new Map();
				const events = { on(channel, handler) { eventHandlers.set(channel, handler); return () => {}; }, emit() {} };
				const fakePi = new Proxy({
					events,
					on(channel, handler) { handlers.set(channel, [...(handlers.get(channel) ?? []), handler]); },
					registerTool() {}, registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {},
					sendMessage() {}, getSessionName() { return undefined; },
				}, { get(target, prop) { return prop in target ? target[prop] : () => undefined; } });
				const widgets = [];
				const ctx = {
					cwd: process.cwd(), hasUI: true,
					ui: { setWidget(key, value) { widgets.push({ key, value }); }, requestRender() {}, theme: { fg(_name, text) { return text; }, bg(_name, text) { return text; }, bold(text) { return text; } } },
					sessionManager: { getSessionId() { return "session-widget"; }, getSessionFile() { return null; }, getEntries() { return []; } },
					modelRegistry: { getAvailable() { return []; } },
				};
				registerSubagentExtension(fakePi);
				for (const handler of handlers.get("session_start")) await handler({}, ctx);
				widgets.length = 0;
				eventHandlers.get("subagent:async-started")({ id: "widget-run", pid: 1, sessionId: "session-widget", mode: "workflow", agent: "worker", asyncDir: "/tmp/widget-run" });
				for (const handler of handlers.get("tool_result")) await handler({ toolName: "subagent" }, ctx);
				const asyncWidgets = widgets.filter((entry) => entry.key === "subagent-async");
				if (!asyncWidgets.some((entry) => entry.value !== undefined)) throw new Error("async widget was not rendered with FleetView enabled: " + JSON.stringify(asyncWidgets));
				for (const handler of handlers.get("session_shutdown")) await handler();
			`;
			const env = parentToolEnv();
			env.PI_CODING_AGENT_DIR = agentDir;
			execFileSync(process.execPath, ["--experimental-strip-types", "--import", "./test/support/register-loader.mjs", "--input-type=module", "--eval", script], { cwd: projectRoot, env, stdio: "pipe" });
		} finally {
			fs.rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("restores indexed active status after a management tool result", () => {
		const script = String.raw`
			import * as fs from "node:fs";
			import * as path from "node:path";
			import registerSubagentExtension from "./index.ts";
			import { updateActiveRunIndex } from "./src/runs/background/active-run-index.ts";
			import { DIRS } from "./src/shared/types.ts";
			const eventHandlers = new Map();
			const handlers = new Map();
			const events = { on(channel, handler) { eventHandlers.set(channel, handler); return () => {}; }, emit() {} };
			const widgets = [];
			const herdrCommands = [];
			process.env.HERDR_ENV = "1";
			process.env.HERDR_PANE_ID = "w1:p1";
			const fakePi = new Proxy({
				events,
				on(channel, handler) { handlers.set(channel, [...(handlers.get(channel) ?? []), handler]); },
				exec(command, args) { herdrCommands.push({ command, args }); return Promise.resolve({ code: 0, stdout: "", stderr: "", killed: false }); },
				registerTool() {}, registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {},
				sendMessage() {}, getSessionName() { return undefined; },
			}, { get(target, prop) { return prop in target ? target[prop] : () => undefined; } });
			const runId = "management-refresh-" + crypto.randomUUID();
			const sessionId = "session-" + runId;
			const ctx = {
				cwd: process.cwd(), hasUI: true,
				ui: { setWidget(key, value) { widgets.push({ key, value }); }, requestRender() {}, theme: { fg(_name, text) { return text; }, bg(_name, text) { return text; }, bold(text) { return text; } } },
				sessionManager: { getSessionId() { return sessionId; }, getSessionFile() { return null; }, getEntries() { return []; } },
				modelRegistry: { getAvailable() { return []; } },
			};
			const asyncDir = path.join(DIRS.async, runId);
			fs.rmSync(asyncDir, { recursive: true, force: true });
			registerSubagentExtension(fakePi);
			for (const handler of handlers.get("session_start")) await handler({}, ctx);
			widgets.length = 0;
			fs.mkdirSync(asyncDir, { recursive: true });
			fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
				runId, sessionId, mode: "workflow", state: "running",
				startedAt: Date.now(), lastUpdate: Date.now(), cwd: process.cwd(), pid: process.pid,
			}), "utf-8");
			updateActiveRunIndex(asyncDir, "running");
			for (const handler of handlers.get("tool_result")) await handler({ toolName: "subagent" }, ctx);
			const fleetWidgets = widgets.filter((entry) => entry.key === "subagent-fleet-status");
			if (!fleetWidgets.some((entry) => typeof entry.value === "function")) throw new Error("management result did not restore active fleet status: " + JSON.stringify(fleetWidgets));
			if (!herdrCommands.some(({ args }) => args.includes("summary=⏳ 1 subagent"))) throw new Error("management result did not restore Herdr status: " + JSON.stringify(herdrCommands));
			const herdrCommandCount = herdrCommands.length;
			for (const handler of handlers.get("tool_result")) await handler({ toolName: "subagent" }, ctx);
			if (herdrCommands.length !== herdrCommandCount) throw new Error("unchanged active jobs redundantly refreshed Herdr status: " + JSON.stringify(herdrCommands));
			for (const handler of handlers.get("session_shutdown")) await handler();
			fs.rmSync(asyncDir, { recursive: true, force: true });
		`;
		execFileSync(process.execPath, ["--experimental-strip-types", "--import", "./test/support/register-loader.mjs", "--input-type=module", "--eval", script], { cwd: projectRoot, env: parentToolEnv(), stdio: "pipe" });
	});

	it("registers pi-web liveness for the current session and releases it on shutdown", () => {
		const script = String.raw`
			import registerSubagentExtension from "./index.ts";
			import { currentCompletionOwnerId } from "./src/shared/completion-owner.ts";
			const handlers = new Map();
			const listeners = new Map();
			const events = {
				on(channel, handler) {
					let set = listeners.get(channel);
					if (!set) listeners.set(channel, set = new Set());
					set.add(handler);
					return () => set.delete(handler);
				},
				emit(channel, payload) {
					for (const handler of [...(listeners.get(channel) ?? [])]) handler(payload);
				},
			};
			const pi = new Proxy({
				events,
				on(channel, handler) { handlers.set(channel, [...(handlers.get(channel) ?? []), handler]); },
				registerTool() {}, registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {},
				sendMessage() {}, getSessionName() { return undefined; },
			}, { get(target, prop) { return prop in target ? target[prop] : () => undefined; } });
			const sessionId = "liveness-" + crypto.randomUUID();
			const sessionFile = "/tmp/" + sessionId + ".jsonl";
			let provider;
			let released = 0;
			const registryKey = Symbol.for("@agegr/pi-web/session-liveness/v1");
			globalThis[registryKey] = {
				version: 1,
				register(value) {
					provider = value;
					return () => { released += 1; };
				},
			};
			const ctx = {
				cwd: process.cwd(), hasUI: false,
				ui: { setWidget() {}, requestRender() {}, theme: { fg(_name, text) { return text; }, bg(_name, text) { return text; }, bold(text) { return text; } } },
				sessionManager: { getSessionId() { return sessionId; }, getSessionFile() { return sessionFile; }, getEntries() { return []; } },
				modelRegistry: { getAvailable() { return []; } },
			};
			registerSubagentExtension(pi);
			for (const handler of handlers.get("session_start")) await handler({ reason: "startup" }, ctx);
			if (provider?.name !== "pi-subagents" || provider?.sessionId !== sessionId || provider?.sessionFile !== sessionFile) {
				throw new Error("liveness provider did not preserve exact session identity: " + JSON.stringify(provider));
			}
			if (provider.isActive()) throw new Error("idle runtime reported live work");
			const completionOwnerId = currentCompletionOwnerId();
			events.emit("subagent:async-started", { id: "run-1", sessionId: sessionFile, completionOwnerId, mode: "single", agent: "worker", asyncDir: "/tmp/" + sessionId + "-run" });
			if (!provider.isActive()) throw new Error("queued async work was not reported live");
			events.emit("subagent:async-complete", { id: "run-1", sessionId: sessionFile, completionOwnerId, success: true, summary: "done" });
			if (!provider.isActive()) throw new Error("pending completion delivery was not reported live");
			const deliveryDeadline = Date.now() + 2000;
			while (provider.isActive() && Date.now() < deliveryDeadline) await new Promise((resolve) => setTimeout(resolve, 10));
			if (provider.isActive()) throw new Error("retained terminal work was reported live after delivery");
			for (const handler of handlers.get("session_shutdown")) await handler({ reason: "quit" });
			if (released !== 1) throw new Error("liveness registration was not released exactly once: " + released);
			delete globalThis[registryKey];
		`;
		execFileSync(process.execPath, ["--experimental-strip-types", "--import", "./test/support/register-loader.mjs", "--input-type=module", "--eval", script], { cwd: projectRoot, env: parentToolEnv(), stdio: "pipe" });
	});

	it("keeps independent extension runtimes active in one process", () => {
		const script = String.raw`
			import registerSubagentExtension from "./index.ts";
			import { currentCompletionOwnerId } from "./src/shared/completion-owner.ts";
			const completionOwnerId = currentCompletionOwnerId();
			function createRuntime(sessionId) {
				const eventListeners = new Map();
				const eventDeliveries = new Map();
				const handlers = new Map();
				const events = {
					on(channel, handler) {
						let listeners = eventListeners.get(channel);
						if (!listeners) eventListeners.set(channel, listeners = new Set());
						listeners.add(handler);
						return () => listeners.delete(handler);
					},
					emit(channel, payload) {
						for (const handler of [...(eventListeners.get(channel) ?? [])]) {
							eventDeliveries.set(channel, (eventDeliveries.get(channel) ?? 0) + 1);
							handler(payload);
						}
					},
				};
				const pi = new Proxy({
					events,
					on(channel, handler) { handlers.set(channel, [...(handlers.get(channel) ?? []), handler]); },
					registerTool() {}, registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {},
					sendMessage() {}, getSessionName() { return undefined; },
				}, { get(target, prop) { return prop in target ? target[prop] : () => undefined; } });
				const sessionManager = {
					getSessionId() { return sessionId; },
					getSessionFile() { return "/tmp/" + sessionId + ".jsonl"; },
					getEntries() { return []; },
				};
				const ctx = {
					cwd: process.cwd(), hasUI: false,
					ui: { setWidget() {}, requestRender() {}, theme: { fg(_name, text) { return text; }, bg(_name, text) { return text; }, bold(text) { return text; } } },
					sessionManager,
					modelRegistry: { getAvailable() { return []; } },
				};
				return { pi, events, eventDeliveries, handlers, ctx };
			}

			const first = createRuntime("independent-first");
			registerSubagentExtension(first.pi);
			for (const handler of first.handlers.get("session_start")) await handler({ reason: "startup" }, first.ctx);
			first.events.emit("subagent:async-complete", {
				id: "independent-baseline", agent: "worker", success: true, summary: "Baseline",
				exitCode: 0, timestamp: Date.now(), sessionId: "independent-first", completionOwnerId,
			});
			const baselineDeliveries = first.eventDeliveries.get("subagent:async-complete") ?? 0;
			if (baselineDeliveries === 0) throw new Error("first runtime did not register async-complete listeners");
			const second = createRuntime("independent-second");
			registerSubagentExtension(second.pi);
			for (const handler of second.handlers.get("session_start")) await handler({ reason: "startup" }, second.ctx);

			for (const handler of first.handlers.get("agent_end")) await handler({}, first.ctx);
			first.events.emit("subagent:async-complete", {
				id: "independent-completion", agent: "worker", success: true, summary: "Done",
				exitCode: 0, timestamp: Date.now(), sessionId: "independent-first", completionOwnerId,
			});
			if (first.eventDeliveries.get("subagent:async-complete") !== baselineDeliveries * 2) {
				throw new Error("first runtime no longer received async-complete after second registration");
			}

			for (const handler of first.handlers.get("session_shutdown")) await handler();
			if (process.env.PI_SUBAGENT_PARENT_SESSION !== "independent-second") {
				throw new Error("independent shutdown cleared another runtime's parent session identity");
			}
			for (const handler of second.handlers.get("agent_end")) await handler({}, second.ctx);
			second.events.emit("subagent:async-complete", {
				id: "independent-second-completion", agent: "reviewer", success: true, summary: "Done",
				exitCode: 0, timestamp: Date.now(), sessionId: "independent-second", completionOwnerId,
			});
			if ((second.eventDeliveries.get("subagent:async-complete") ?? 0) === 0) {
				throw new Error("first runtime shutdown removed the second runtime's event subscription");
			}
			for (const handler of second.handlers.get("session_shutdown")) await handler();
			if (process.env.PI_SUBAGENT_PARENT_SESSION !== undefined) {
				throw new Error("owning shutdown left its parent session identity active");
			}
		`;

		execFileSync(
			process.execPath,
			["--experimental-strip-types", "--import", "./test/support/register-loader.mjs", "--input-type=module", "--eval", script],
			{ cwd: projectRoot, env: parentToolEnv(), stdio: "pipe" },
		);
	});

	it("keeps slash snapshots until the last independent runtime shuts down", () => {
		const script = String.raw`
			import registerSubagentExtension from "./index.ts";
			import { buildSlashInitialResult, getSlashRenderableSnapshot } from "./src/slash/slash-live-state.ts";
			function createRuntime(sessionId) {
				const handlers = new Map();
				const events = { on() { return () => {}; }, emit() {} };
				const pi = new Proxy({
					events,
					on(channel, handler) { handlers.set(channel, [...(handlers.get(channel) ?? []), handler]); },
					registerTool() {}, registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {},
					sendMessage() {}, getSessionName() { return undefined; },
				}, { get(target, prop) { return prop in target ? target[prop] : () => undefined; } });
				const ctx = {
					cwd: process.cwd(), hasUI: false,
					ui: { setWidget() {}, requestRender() {}, theme: { fg(_name, text) { return text; }, bg(_name, text) { return text; }, bold(text) { return text; } } },
					sessionManager: { getSessionId() { return sessionId; }, getSessionFile() { return null; }, getEntries() { return []; } },
					modelRegistry: { getAvailable() { return []; } },
				};
				return { pi, handlers, ctx };
			}

			const first = createRuntime("slash-first");
			const second = createRuntime("slash-second");
			registerSubagentExtension(first.pi);
			for (const handler of first.handlers.get("session_start")) await handler({ reason: "startup" }, first.ctx);
			registerSubagentExtension(second.pi);
			for (const handler of second.handlers.get("session_start")) await handler({ reason: "startup" }, second.ctx);
			const details = buildSlashInitialResult("slash-isolation", { agent: "worker", task: "Keep this snapshot" });
			const liveVersion = getSlashRenderableSnapshot(details).version;
			if (liveVersion <= 0) throw new Error("slash snapshot was not populated");

			for (const handler of first.handlers.get("session_shutdown")) await handler({ reason: "shutdown" });
			if (getSlashRenderableSnapshot(details).version !== liveVersion) {
				throw new Error("one runtime shutdown cleared another active runtime's slash snapshot");
			}
			for (const handler of second.handlers.get("session_shutdown")) await handler({ reason: "shutdown" });
			if (getSlashRenderableSnapshot(details).version !== 0) {
				throw new Error("last runtime shutdown did not clear slash snapshots");
			}
		`;

		execFileSync(
			process.execPath,
			["--experimental-strip-types", "--import", "./test/support/register-loader.mjs", "--input-type=module", "--eval", script],
			{ cwd: projectRoot, env: parentToolEnv(), stdio: "pipe" },
		);
	});

	it("disposes pending completion notifications on session shutdown", () => {
		const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-notify-shutdown-"));
		const configDir = path.join(agentDir, "extensions", "subagent");
		fs.mkdirSync(configDir, { recursive: true });
		fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({ completionBatch: { enabled: true, debounceMs: 150 } }), "utf-8");
		const script = String.raw`
			import registerSubagentExtension from "./index.ts";
			import { currentCompletionOwnerId } from "./src/shared/completion-owner.ts";
			const completionOwnerId = currentCompletionOwnerId();
			const pendingTimers = new Map();
			const realSetTimeout = globalThis.setTimeout;
			const realClearTimeout = globalThis.clearTimeout;
			globalThis.setTimeout = (handler) => {
				const token = {};
				pendingTimers.set(token, handler);
				return token;
			};
			globalThis.clearTimeout = (token) => pendingTimers.delete(token);
			const eventListeners = new Map();
			const events = {
				on(channel, handler) {
					let listeners = eventListeners.get(channel);
					if (!listeners) eventListeners.set(channel, listeners = new Set());
					listeners.add(handler);
					return () => listeners.delete(handler);
				},
				emit(channel, payload) {
					for (const handler of [...(eventListeners.get(channel) ?? [])]) handler(payload);
				},
			};
			const handlers = new Map();
			const sent = [];
			const fakePi = new Proxy({
				events,
				on(channel, handler) { handlers.set(channel, [...(handlers.get(channel) ?? []), handler]); },
				registerTool() {}, registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {},
				sendMessage(message) { sent.push(message); }, getSessionName() { return undefined; },
			}, { get(target, prop) { return prop in target ? target[prop] : () => undefined; } });
			const ctx = {
				cwd: process.cwd(), hasUI: false,
				ui: { setWidget() {}, requestRender() {}, theme: { fg(_name, text) { return text; }, bg(_name, text) { return text; }, bold(text) { return text; } } },
				sessionManager: { getSessionId() { return "notify-shutdown-session"; }, getSessionFile() { return null; }, getEntries() { return []; } },
				modelRegistry: { getAvailable() { return []; } },
			};
			registerSubagentExtension(fakePi);
			for (const handler of handlers.get("session_start")) await handler({}, ctx);
			sent.length = 0;
			events.emit("subagent:async-complete", {
				id: "shutdown-held-completion", agent: "worker", success: true, summary: "Done",
				exitCode: 0, timestamp: Date.now(), sessionId: "notify-shutdown-session", completionOwnerId,
			});
			if (sent.length !== 0) throw new Error("completion was not queued before shutdown");
			const heldTimers = [...pendingTimers.values()];
			if (heldTimers.length === 0) throw new Error("completion did not schedule a timer");
			for (const handler of handlers.get("session_shutdown")) await handler();
			if (pendingTimers.size !== 0) throw new Error("shutdown left completion timers pending");
			for (const handler of heldTimers) handler();
			if (sent.length !== 0) throw new Error("stale completion sent after shutdown");
			globalThis.setTimeout = realSetTimeout;
			globalThis.clearTimeout = realClearTimeout;
		`;

		try {
			const env = parentToolEnv();
			env.PI_CODING_AGENT_DIR = agentDir;
			execFileSync(
				process.execPath,
				["--experimental-strip-types", "--import", "./test/support/register-loader.mjs", "--input-type=module", "--eval", script],
				{ cwd: projectRoot, env, stdio: "pipe" },
			);
		} finally {
			fs.rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("disposes pending completion notifications during runtime reload cleanup", () => {
		const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-notify-reload-"));
		const configDir = path.join(agentDir, "extensions", "subagent");
		fs.mkdirSync(configDir, { recursive: true });
		fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({ completionBatch: { enabled: true, debounceMs: 150 } }), "utf-8");
		const script = String.raw`
			import registerSubagentExtension from "./index.ts";
			import { currentCompletionOwnerId } from "./src/shared/completion-owner.ts";
			const completionOwnerId = currentCompletionOwnerId();
			const pendingTimers = new Map();
			const realSetTimeout = globalThis.setTimeout;
			const realClearTimeout = globalThis.clearTimeout;
			globalThis.setTimeout = (handler) => {
				const token = {};
				pendingTimers.set(token, handler);
				return token;
			};
			globalThis.clearTimeout = (token) => pendingTimers.delete(token);
			const eventListeners = new Map();
			const events = {
				on(channel, handler) {
					let listeners = eventListeners.get(channel);
					if (!listeners) eventListeners.set(channel, listeners = new Set());
					listeners.add(handler);
					return () => listeners.delete(handler);
				},
				emit(channel, payload) {
					for (const handler of [...(eventListeners.get(channel) ?? [])]) handler(payload);
				},
			};
			const sessionManager = {
				getSessionId() { return "notify-reload-session"; },
				getSessionFile() { return null; },
				getEntries() { return []; },
			};
			function createRuntime() {
				const handlers = new Map();
				const sent = [];
				const pi = new Proxy({
					events,
					on(channel, handler) { handlers.set(channel, [...(handlers.get(channel) ?? []), handler]); },
					registerTool() {}, registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {},
					sendMessage(message) { sent.push(message); }, getSessionName() { return undefined; },
				}, { get(target, prop) { return prop in target ? target[prop] : () => undefined; } });
				const ctx = {
					cwd: process.cwd(), hasUI: false,
					ui: { setWidget() {}, requestRender() {}, theme: { fg(_name, text) { return text; }, bg(_name, text) { return text; }, bold(text) { return text; } } },
					sessionManager,
					modelRegistry: { getAvailable() { return []; } },
				};
				return { pi, events, handlers, sent, ctx };
			}

			const oldRuntime = createRuntime();
			registerSubagentExtension(oldRuntime.pi);
			for (const handler of oldRuntime.handlers.get("session_start")) await handler({ reason: "startup" }, oldRuntime.ctx);
			const oldListenerCount = eventListeners.get("subagent:async-complete")?.size ?? 0;
			if (oldListenerCount === 0) throw new Error("old runtime did not register async-complete listeners");
			oldRuntime.sent.length = 0;
			const timersBeforeOldCompletion = new Set(pendingTimers.keys());
			oldRuntime.events.emit("subagent:async-complete", {
				id: "reload-held-completion", agent: "worker", success: true, summary: "Old",
				exitCode: 0, timestamp: Date.now(), sessionId: "notify-reload-session", completionOwnerId,
			});
			if (oldRuntime.sent.length !== 0) throw new Error("old completion was not queued before reload");
			const oldCompletionTimers = [...pendingTimers.entries()].filter(([token]) => !timersBeforeOldCompletion.has(token));
			if (oldCompletionTimers.length === 0) throw new Error("old completion did not schedule a timer");

			const newRuntime = createRuntime();
			registerSubagentExtension(newRuntime.pi);
			for (const handler of newRuntime.handlers.get("session_start")) await handler({ reason: "reload" }, newRuntime.ctx);
			if (eventListeners.get("subagent:async-complete")?.size !== oldListenerCount) {
				throw new Error("replacement runtime did not restore its event subscriptions");
			}
			for (const [, handler] of oldCompletionTimers) handler();
			if (oldRuntime.sent.length !== 0) throw new Error("stale completion sent after runtime cleanup");
			for (const handler of oldRuntime.handlers.get("session_shutdown")) await handler({ reason: "reload" });
			if (eventListeners.get("subagent:async-complete")?.size !== oldListenerCount
				|| process.env.PI_SUBAGENT_PARENT_SESSION !== "notify-reload-session") {
				throw new Error("stale shutdown changed the replacement runtime");
			}

			const timersBeforeNewCompletion = new Set(pendingTimers.keys());
			newRuntime.events.emit("subagent:async-complete", {
				id: "reload-new-completion", agent: "reviewer", success: true, summary: "New",
				exitCode: 0, timestamp: Date.now(), sessionId: "notify-reload-session", completionOwnerId,
			});
			const newCompletionTimers = [...pendingTimers.entries()].filter(([token]) => !timersBeforeNewCompletion.has(token));
			if (newCompletionTimers.length === 0) throw new Error("new completion did not schedule a timer");
			for (const [token, handler] of newCompletionTimers) {
				pendingTimers.delete(token);
				handler();
			}
			if (newRuntime.sent.length !== 1) throw new Error("new notifier was not active after reload cleanup");
			for (const handler of newRuntime.handlers.get("session_shutdown")) await handler({ reason: "shutdown" });
			globalThis.setTimeout = realSetTimeout;
			globalThis.clearTimeout = realClearTimeout;
		`;

		try {
			const env = parentToolEnv();
			env.PI_CODING_AGENT_DIR = agentDir;
			execFileSync(
				process.execPath,
				["--experimental-strip-types", "--import", "./test/support/register-loader.mjs", "--input-type=module", "--eval", script],
				{ cwd: projectRoot, env, stdio: "pipe" },
			);
		} finally {
			fs.rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("ignores the current stale UI context during runtime reload cleanup", () => {
		const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-stale-ui-reload-"));
		const configDir = path.join(agentDir, "extensions", "subagent");
		fs.mkdirSync(configDir, { recursive: true });
		fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({ asyncWidget: false, fleetView: false }), "utf-8");
		const script = String.raw`
			import registerSubagentExtension from "./index.ts";
			const handlers = new Map();
			const events = { on() { return () => {}; }, emit() {} };
			const fakePi = new Proxy({
				events,
				on(channel, handler) { handlers.set(channel, [...(handlers.get(channel) ?? []), handler]); },
				registerTool() {}, registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {},
				sendMessage() {}, getSessionName() { return undefined; },
			}, { get(target, prop) { return prop in target ? target[prop] : () => undefined; } });
			let stale = false;
			const ctx = {
				cwd: process.cwd(),
				get hasUI() {
					if (stale) throw new Error("This extension ctx is stale after session replacement or reload.");
					return true;
				},
				ui: {
					setWidget() {}, requestRender() {}, setToolsExpanded() {}, getToolsExpanded() { return false; },
					theme: { fg(_name, text) { return text; }, bg(_name, text) { return text; }, bold(text) { return text; } },
				},
				sessionManager: { getSessionId() { return "stale-ui-session"; }, getSessionFile() { return null; }, getEntries() { return []; } },
				modelRegistry: { getAvailable() { return []; } },
			};
			registerSubagentExtension(fakePi);
			for (const handler of handlers.get("session_start")) await handler({ reason: "startup" }, ctx);
			stale = true;
			for (const handler of handlers.get("session_shutdown")) await handler({ reason: "reload" });
		`;

		try {
			const env = parentToolEnv(agentDir);
			env.PI_CODING_AGENT_DIR = agentDir;
			execFileSync(
				process.execPath,
				["--experimental-strip-types", "--import", "./test/support/register-loader.mjs", "--input-type=module", "--eval", script],
				{ cwd: projectRoot, env, stdio: "pipe" },
			);
		} finally {
			fs.rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("claims the explicit predecessor session during session replacement", () => {
		const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-session-transition-"));
		const configDir = path.join(agentDir, "extensions", "subagent");
		fs.mkdirSync(configDir, { recursive: true });
		fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({ completionBatch: { enabled: false } }), "utf-8");
		const script = String.raw`
			import fs from "node:fs";
			import path from "node:path";
			import registerSubagentExtension from "./index.ts";
			import { currentCompletionOwnerId } from "./src/shared/completion-owner.ts";
			const handlers = new Map();
			const listeners = new Map();
			const events = {
				on(channel, handler) { let set = listeners.get(channel); if (!set) listeners.set(channel, set = new Set()); set.add(handler); return () => set.delete(handler); },
				emit(channel, payload) { for (const handler of [...(listeners.get(channel) ?? [])]) handler(payload); },
			};
			const sent = [];
			const pi = new Proxy({
				events,
				on(channel, handler) { handlers.set(channel, [...(handlers.get(channel) ?? []), handler]); },
				registerTool() {}, registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {},
				sendMessage(message) { sent.push(message); }, getSessionName() { return undefined; },
			}, { get(target, prop) { return prop in target ? target[prop] : () => undefined; } });
			const sessions = path.join(process.env.PI_CODING_AGENT_DIR, "sessions");
			fs.mkdirSync(sessions, { recursive: true });
			const oldSession = path.join(sessions, "old.jsonl");
			const newSession = path.join(sessions, "new.jsonl");
			fs.writeFileSync(oldSession, "");
			fs.writeFileSync(newSession, "");
			let currentSession = oldSession;
			const sessionManager = { getSessionId() { return path.basename(currentSession); }, getSessionFile() { return currentSession; }, getEntries() { return []; } };
			const ctx = { cwd: process.cwd(), hasUI: false, ui: { setWidget() {}, requestRender() {}, theme: { fg(_name, text) { return text; }, bg(_name, text) { return text; }, bold(text) { return text; } } }, sessionManager, modelRegistry: { getAvailable() { return []; } } };
			registerSubagentExtension(pi);
			for (const handler of handlers.get("session_start")) await handler({ reason: "startup" }, ctx);
			currentSession = newSession;
			for (const handler of handlers.get("session_start")) await handler({ reason: "new", previousSessionFile: oldSession }, ctx);
			const owner = currentCompletionOwnerId();
			events.emit("subagent:async-complete", { id: "old-owned", agent: "worker", success: true, summary: "old", timestamp: 1, sessionId: oldSession, completionOwnerId: owner });
			events.emit("subagent:async-complete", { id: "foreign", agent: "worker", success: true, summary: "foreign", timestamp: 2, sessionId: path.join(sessions, "foreign.jsonl"), completionOwnerId: owner });
			if (sent.length !== 1) throw new Error("expected only the claimed predecessor completion, got " + sent.length);
			for (const handler of handlers.get("session_shutdown")) await handler({ reason: "quit" });
		`;

		try {
			const env = parentToolEnv();
			env.PI_CODING_AGENT_DIR = agentDir;
			execFileSync(process.execPath, ["--experimental-strip-types", "--import", "./test/support/register-loader.mjs", "--input-type=module", "--eval", script], { cwd: projectRoot, env, stdio: "pipe" });
		} finally {
			fs.rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("registers the main watchdog command and renderer in parent mode", () => {
		const script = String.raw`
			import registerSubagentExtension from "./index.ts";
			const events = { on() { return () => {}; }, emit() {} };
			const commands = [];
			const renderers = [];
			const entryRenderers = [];
			const fakePi = new Proxy({
				events,
				registerTool() {},
				registerCommand(name) { commands.push(name); },
				registerShortcut() {},
				registerMessageRenderer(type) { renderers.push(type); },
				registerEntryRenderer(type) { entryRenderers.push(type); },
				sendMessage() {},
				getSessionName() { return undefined; },
			}, {
				get(target, prop) {
					if (prop in target) return target[prop];
					return () => undefined;
				},
			});
			registerSubagentExtension(fakePi);
			if (!commands.includes("subagents-watchdog")) throw new Error("watchdog command not registered: " + commands.join(", "));
			if (!renderers.includes("subagent_watchdog_warning")) throw new Error("watchdog renderer not registered: " + renderers.join(", "));
			if (!renderers.includes("subagent_supervisor_request")) throw new Error("supervisor request renderer not registered: " + renderers.join(", "));
			if (!entryRenderers.includes("subagent_supervisor_reply")) throw new Error("supervisor reply entry renderer not registered: " + entryRenderers.join(", "));
		`;

		execFileSync(
			process.execPath,
			[
				"--experimental-strip-types",
				"--import",
				"./test/support/register-loader.mjs",
				"--input-type=module",
				"--eval",
				script,
			],
			{ cwd: projectRoot, env: parentToolEnv(), stdio: "pipe" },
		);
	});

	it("returns before registering anything in a child-hosting process", () => {
		const script = String.raw`
			import registerSubagentExtension from "./index.ts";
			const calls = [];
			const fakePi = new Proxy({}, {
				get(_target, prop) {
					return (..._args) => {
						calls.push(String(prop));
						return undefined;
					};
				},
			});
			registerSubagentExtension(fakePi);
			if (calls.length > 0) {
				throw new Error("Unexpected child-mode registrations: " + calls.join(", "));
			}
		`;

		execFileSync(
			process.execPath,
			[
				"--experimental-strip-types",
				"--import",
				"./test/support/register-loader.mjs",
				"--input-type=module",
				"--eval",
				script,
			],
			{ cwd: projectRoot, env: { ...parentToolEnv(), [SUBAGENT_CHILD_ENV]: "1" }, stdio: "pipe" },
		);
	});

	it("returns before registering anything when the child host flag is set after import", () => {
		const script = String.raw`
			import registerSubagentExtension from "./index.ts";
			import { SUBAGENT_CHILD_ENV } from "./src/runs/shared/child-runtime-config.ts";
			process.env[SUBAGENT_CHILD_ENV] = "1";
			const calls = [];
			const fakePi = new Proxy({}, {
				get(target, prop) {
					if (prop in target) return target[prop];
					return (..._args) => {
						calls.push(String(prop));
						return undefined;
					};
				},
			});
			registerSubagentExtension(fakePi);
			if (calls.length > 0) {
				throw new Error("Unexpected child-mode registrations: " + calls.join(", "));
			}
		`;

		execFileSync(
			process.execPath,
			[
				"--experimental-strip-types",
				"--import",
				"./test/support/register-loader.mjs",
				"--input-type=module",
				"--eval",
				script,
			],
			{ cwd: projectRoot, stdio: "pipe" },
		);
	});

	it("does not double-register the child-safe subagent tool when index and fanout-child both load", () => {
		const script = String.raw`
			import registerSubagentExtension from "./index.ts";
			import registerFanoutChildSubagentExtension from "./src/extension/fanout-child.ts";
			import { SUBAGENT_CHILD_ENV } from "./src/runs/shared/child-runtime-config.ts";
			process.env[SUBAGENT_CHILD_ENV] = "1";
			const childRuntime = { fanoutChild: true, depth: 1, waitTool: { enabled: true }, fast: false };

			const registeredNames = new Set();
			const registrations = [];
			function makePi(source) {
				return {
					events: { on() { return () => {}; }, emit() {} },
					registerTool(tool) {
						if (registeredNames.has(tool.name)) {
							throw new Error("Tool " + tool.name + " conflicts with " + source);
						}
						registeredNames.add(tool.name);
						registrations.push({ source, name: tool.name });
					},
					getSessionName() { return undefined; },
				};
			}

			registerSubagentExtension(makePi("index.ts"));
			registerFanoutChildSubagentExtension(makePi("fanout-child.ts"), childRuntime);
			if (registrations.length !== 1 || registrations[0].name !== "subagent" || registrations[0].source !== "fanout-child.ts") {
				throw new Error("expected only fanout-child.ts to register subagent, got " + JSON.stringify(registrations));
			}
		`;

		execFileSync(
			process.execPath,
			[
				"--experimental-strip-types",
				"--import",
				"./test/support/register-loader.mjs",
				"--input-type=module",
				"--eval",
				script,
			],
			{ cwd: projectRoot, stdio: "pipe" },
		);
	});

	it("lets fanout children call read-only list but blocks mutating management actions", () => {
		const script = String.raw`
			import assert from "node:assert/strict";
			import registerFanoutChildSubagentExtension from "./src/extension/fanout-child.ts";
			let registeredTool;
			const fakePi = {
				events: { on() { return () => {}; }, emit() {} },
				registerTool(tool) { registeredTool = tool; },
				getSessionName() { return undefined; },
			};
			registerFanoutChildSubagentExtension(fakePi, { fanoutChild: true, depth: 1, waitTool: { enabled: true }, fast: false });
			if (!registeredTool) throw new Error("tool not registered");
			const ctx = {
				cwd: process.cwd(),
				hasUI: false,
				sessionManager: { getSessionId() { return "session-test"; }, getSessionFile() { return null; } },
				modelRegistry: { getAvailable() { return []; } },
			};
			const list = await registeredTool.execute("list-check", { action: "list" }, new AbortController().signal, undefined, ctx);
			if (list.isError) throw new Error("list should be allowed: " + JSON.stringify(list.content));
			await assert.rejects(
				registeredTool.execute("create-check", { action: "create", config: { name: "x" } }, new AbortController().signal, undefined, ctx),
				/not available from child-safe subagent fanout mode/,
			);
			await assert.rejects(
				registeredTool.execute("refine-check", { action: "refine", agent: "worker" }, new AbortController().signal, undefined, ctx),
				/not available from child-safe subagent fanout mode/,
			);
			await assert.rejects(
				registeredTool.execute("grant-check", { action: "grant-spawn-budget", additional: 1 }, new AbortController().signal, undefined, { ...ctx, hasUI: true }),
				/root interactive parent session/,
			);
		`;

		execFileSync(
			process.execPath,
			[
				"--experimental-strip-types",
				"--import",
				"./test/support/register-loader.mjs",
				"--input-type=module",
				"--eval",
				script,
			],
			{ cwd: projectRoot, stdio: "pipe" },
		);
	});
});
