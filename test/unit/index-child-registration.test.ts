import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { WAIT_TOOL_ENABLED_ENV } from "../../src/runs/background/subagent-wait.ts";
import { SUBAGENT_CHILD_ENV, SUBAGENT_FANOUT_CHILD_ENV } from "../../src/runs/shared/pi-args.ts";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function parentToolEnv(agentDir?: string): NodeJS.ProcessEnv {
	const env = { ...process.env };
	delete env[SUBAGENT_CHILD_ENV];
	delete env[SUBAGENT_FANOUT_CHILD_ENV];
	delete env[WAIT_TOOL_ENABLED_ENV];
	if (agentDir) env.PI_CODING_AGENT_DIR = agentDir;
	return env;
}

describe("subagent extension child mode", () => {
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
			const result = await registeredTool.execute("blank-action", { action: "", agent: "reviewer" }, new AbortController().signal, undefined, { cwd: process.cwd(), hasUI: false });
			if (!result.isError) throw new Error("blank action should be rejected");
			const text = result.content?.[0]?.text ?? "";
			if (!text.includes("action must be a non-empty")) throw new Error("unexpected blank action error: " + text);
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
				if (!lines[3].includes(" ✓ Agent 1/3: scout")) throw new Error("zero spacing was not applied: " + JSON.stringify(lines));
			`;
			const env = parentToolEnv();
			env.PI_CODING_AGENT_DIR = agentDir;
			execFileSync(process.execPath, ["--experimental-strip-types", "--import", "./test/support/register-loader.mjs", "--input-type=module", "--eval", script], { cwd: projectRoot, env, stdio: "pipe" });
		} finally {
			fs.rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("registers only subagent_wait and honors waitTool disabled config", () => {
		const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-wait-tool-config-"));
		try {
			const configDir = path.join(agentDir, "extensions", "subagent");
			fs.mkdirSync(configDir, { recursive: true });
			fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({ waitTool: { enabled: false } }), "utf-8");

			const script = String.raw`
				import registerSubagentExtension from "./index.ts";
				const events = { on() { return () => {}; }, emit() {} };
				let subagentWaitTool;
				let legacyWaitRegistered = false;
				const fakePi = new Proxy({
					events,
					registerTool(tool) {
						if (tool.name === "subagent_wait") subagentWaitTool = tool;
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
				if (!subagentWaitTool) throw new Error("subagent_wait tool not registered");
				if (legacyWaitRegistered) throw new Error("legacy wait tool must not be registered");
				const result = await subagentWaitTool.execute("subagent-wait-disabled", {}, new AbortController().signal, undefined, {});
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
					on(channel, handler) { handlers.set(channel, handler); },
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
				handlers.get("session_start")({}, ctx);
				widgets.length = 0;
				eventHandlers.get("subagent:async-started")({ id: "widget-run", pid: 1, sessionId: "session-widget", mode: "single", agent: "worker", asyncDir: "/tmp/widget-run" });
				handlers.get("tool_result")({ toolName: "subagent" }, ctx);
				const asyncWidgets = widgets.filter((entry) => entry.key === "subagent-async");
				if (asyncWidgets.length < 2 || asyncWidgets.some((entry) => entry.value !== undefined)) throw new Error("async widget rendered despite disabled config: " + JSON.stringify(asyncWidgets));
				handlers.get("session_shutdown")();
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
					on(channel, handler) { handlers.set(channel, handler); },
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
				handlers.get("session_start")({}, ctx);
				widgets.length = 0;
				eventHandlers.get("subagent:async-started")({ id: "widget-run", pid: 1, sessionId: "session-widget", mode: "workflow", agent: "worker", asyncDir: "/tmp/widget-run" });
				handlers.get("tool_result")({ toolName: "subagent" }, ctx);
				const asyncWidgets = widgets.filter((entry) => entry.key === "subagent-async");
				if (!asyncWidgets.some((entry) => entry.value !== undefined)) throw new Error("async widget was not rendered with FleetView enabled: " + JSON.stringify(asyncWidgets));
				handlers.get("session_shutdown")();
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
			const fakePi = new Proxy({
				events,
				on(channel, handler) { handlers.set(channel, handler); },
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
			handlers.get("session_start")({}, ctx);
			widgets.length = 0;
			fs.mkdirSync(asyncDir, { recursive: true });
			fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
				runId, sessionId, mode: "workflow", state: "running",
				startedAt: Date.now(), lastUpdate: Date.now(), cwd: process.cwd(), pid: process.pid,
			}), "utf-8");
			updateActiveRunIndex(asyncDir, "running");
			handlers.get("tool_result")({ toolName: "subagent" }, ctx);
			const fleetWidgets = widgets.filter((entry) => entry.key === "subagent-fleet-status");
			if (!fleetWidgets.some((entry) => typeof entry.value === "function")) throw new Error("management result did not restore active fleet status: " + JSON.stringify(fleetWidgets));
			handlers.get("session_shutdown")();
			fs.rmSync(asyncDir, { recursive: true, force: true });
		`;
		execFileSync(process.execPath, ["--experimental-strip-types", "--import", "./test/support/register-loader.mjs", "--input-type=module", "--eval", script], { cwd: projectRoot, env: parentToolEnv(), stdio: "pipe" });
	});

	it("disposes pending completion notifications on session shutdown", () => {
		const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-notify-shutdown-"));
		const configDir = path.join(agentDir, "extensions", "subagent");
		fs.mkdirSync(configDir, { recursive: true });
		fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({ completionBatch: { enabled: true, debounceMs: 150 } }), "utf-8");
		const script = String.raw`
			import registerSubagentExtension from "./index.ts";
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
				on(channel, handler) { handlers.set(channel, handler); },
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
			handlers.get("session_start")({}, ctx);
			sent.length = 0;
			events.emit("subagent:async-complete", {
				id: "shutdown-held-completion", agent: "worker", success: true, summary: "Done",
				exitCode: 0, timestamp: Date.now(), sessionId: "notify-shutdown-session",
			});
			if (sent.length !== 0) throw new Error("completion was not queued before shutdown");
			const heldTimers = [...pendingTimers.values()];
			if (heldTimers.length === 0) throw new Error("completion did not schedule a timer");
			handlers.get("session_shutdown")();
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
			const pendingTimers = new Map();
			const realSetTimeout = globalThis.setTimeout;
			const realClearTimeout = globalThis.clearTimeout;
			globalThis.setTimeout = (handler) => {
				const token = {};
				pendingTimers.set(token, handler);
				return token;
			};
			globalThis.clearTimeout = (token) => pendingTimers.delete(token);
			function createRuntime(sessionId) {
				const eventListeners = new Map();
				const handlers = new Map();
				const sent = [];
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
				const pi = new Proxy({
					events,
					on(channel, handler) { handlers.set(channel, handler); },
					registerTool() {}, registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {},
					sendMessage(message) { sent.push(message); }, getSessionName() { return undefined; },
				}, { get(target, prop) { return prop in target ? target[prop] : () => undefined; } });
				const ctx = {
					cwd: process.cwd(), hasUI: false,
					ui: { setWidget() {}, requestRender() {}, theme: { fg(_name, text) { return text; }, bg(_name, text) { return text; }, bold(text) { return text; } } },
					sessionManager: { getSessionId() { return sessionId; }, getSessionFile() { return null; }, getEntries() { return []; } },
					modelRegistry: { getAvailable() { return []; } },
				};
				return { pi, events, handlers, sent, ctx };
			}
			const oldRuntime = createRuntime("notify-reload-old");
			registerSubagentExtension(oldRuntime.pi);
			oldRuntime.handlers.get("session_start")({}, oldRuntime.ctx);
			oldRuntime.sent.length = 0;
			const timersBeforeOldCompletion = new Set(pendingTimers.keys());
			oldRuntime.events.emit("subagent:async-complete", {
				id: "reload-held-completion", agent: "worker", success: true, summary: "Old",
				exitCode: 0, timestamp: Date.now(), sessionId: "notify-reload-old",
			});
			if (oldRuntime.sent.length !== 0) throw new Error("old completion was not queued before reload");
			const oldCompletionTimers = [...pendingTimers.entries()].filter(([token]) => !timersBeforeOldCompletion.has(token));
			if (oldCompletionTimers.length === 0) throw new Error("old completion did not schedule a timer");

			const newRuntime = createRuntime("notify-reload-new");
			registerSubagentExtension(newRuntime.pi);
			newRuntime.handlers.get("session_start")({}, newRuntime.ctx);
			for (const [, handler] of oldCompletionTimers) handler();
			if (oldRuntime.sent.length !== 0) throw new Error("stale completion sent after runtime cleanup");

			const timersBeforeNewCompletion = new Set(pendingTimers.keys());
			newRuntime.events.emit("subagent:async-complete", {
				id: "reload-new-completion", agent: "reviewer", success: true, summary: "New",
				exitCode: 0, timestamp: Date.now(), sessionId: "notify-reload-new",
			});
			const newCompletionTimers = [...pendingTimers.entries()].filter(([token]) => !timersBeforeNewCompletion.has(token));
			if (newCompletionTimers.length === 0) throw new Error("new completion did not schedule a timer");
			for (const [token, handler] of newCompletionTimers) {
				pendingTimers.delete(token);
				handler();
			}
			if (newRuntime.sent.length !== 1) throw new Error("new notifier was not active after reload cleanup");
			newRuntime.handlers.get("session_shutdown")();
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

	it("registers the main watchdog command and renderer in parent mode", () => {
		const script = String.raw`
			import registerSubagentExtension from "./index.ts";
			const events = { on() { return () => {}; }, emit() {} };
			const commands = [];
			const renderers = [];
			const fakePi = new Proxy({
				events,
				registerTool() {},
				registerCommand(name) { commands.push(name); },
				registerShortcut() {},
				registerMessageRenderer(type) { renderers.push(type); },
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

	it("returns before registering anything for non-fanout children", () => {
		const script = String.raw`
			import registerSubagentExtension from "./index.ts";
			import { SUBAGENT_CHILD_ENV, SUBAGENT_FANOUT_CHILD_ENV } from "./src/runs/shared/pi-args.ts";
			process.env[SUBAGENT_CHILD_ENV] = "1";
			process.env[SUBAGENT_FANOUT_CHILD_ENV] = "0";
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
			{ cwd: projectRoot, stdio: "pipe" },
		);
	});

	it("returns before registering anything for fanout children", () => {
		const script = String.raw`
			import registerSubagentExtension from "./index.ts";
			import { SUBAGENT_CHILD_ENV, SUBAGENT_FANOUT_CHILD_ENV } from "./src/runs/shared/pi-args.ts";
			process.env[SUBAGENT_CHILD_ENV] = "1";
			process.env[SUBAGENT_FANOUT_CHILD_ENV] = "1";
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
			import { SUBAGENT_CHILD_ENV, SUBAGENT_FANOUT_CHILD_ENV } from "./src/runs/shared/pi-args.ts";
			process.env[SUBAGENT_CHILD_ENV] = "1";
			process.env[SUBAGENT_FANOUT_CHILD_ENV] = "1";

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
			registerFanoutChildSubagentExtension(makePi("fanout-child.ts"));
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

	it("omits legacy chain controls from the child-safe fanout tool", () => {
		const readRegisteredTool = (): { description: string; properties: string[]; id: string; runId: string } => {
			const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-fanout-schema-"));
			fs.mkdirSync(path.join(agentDir, "extensions", "subagent"), { recursive: true });
			const script = String.raw`
				import registerFanoutChildSubagentExtension from "./src/extension/fanout-child.ts";
				import { SUBAGENT_CHILD_ENV, SUBAGENT_FANOUT_CHILD_ENV } from "./src/runs/shared/pi-args.ts";
				process.env[SUBAGENT_CHILD_ENV] = "1";
				process.env[SUBAGENT_FANOUT_CHILD_ENV] = "1";
				let tool;
				registerFanoutChildSubagentExtension({ events: { on() { return () => {}; }, emit() {} }, registerTool(value) { tool = value; }, getSessionName() { return undefined; } });
				process.stdout.write(JSON.stringify({ description: tool.description, properties: Object.keys(tool.parameters.properties), id: tool.parameters.properties.id.description, runId: tool.parameters.properties.runId.description }));
			`;
			const output = execFileSync(process.execPath, ["--experimental-strip-types", "--import", "./test/support/register-loader.mjs", "--input-type=module", "--eval", script], {
				cwd: projectRoot,
				env: parentToolEnv(agentDir),
				encoding: "utf-8",
			});
			return JSON.parse(output) as { description: string; properties: string[]; id: string; runId: string };
		};

		const tool = readRegisteredTool();
		assert.equal(tool.properties.includes("step"), false);
		assert.doesNotMatch(`${tool.description}\n${tool.id}\n${tool.runId}`, /append-step|approve-checkpoint|reject-checkpoint/);
	});

	it("lets fanout children call read-only list but blocks mutating management actions", () => {
		const script = String.raw`
			import registerFanoutChildSubagentExtension from "./src/extension/fanout-child.ts";
			import { SUBAGENT_CHILD_ENV, SUBAGENT_FANOUT_CHILD_ENV } from "./src/runs/shared/pi-args.ts";
			process.env[SUBAGENT_CHILD_ENV] = "1";
			process.env[SUBAGENT_FANOUT_CHILD_ENV] = "1";
			let registeredTool;
			const fakePi = {
				events: { on() { return () => {}; }, emit() {} },
				registerTool(tool) { registeredTool = tool; },
				getSessionName() { return undefined; },
			};
			registerFanoutChildSubagentExtension(fakePi);
			if (!registeredTool) throw new Error("tool not registered");
			const ctx = {
				cwd: process.cwd(),
				hasUI: false,
				sessionManager: { getSessionId() { return "session-test"; }, getSessionFile() { return null; } },
				modelRegistry: { getAvailable() { return []; } },
			};
			const list = await registeredTool.execute("list-check", { action: "list" }, new AbortController().signal, undefined, ctx);
			if (list.isError) throw new Error("list should be allowed: " + JSON.stringify(list.content));
			const create = await registeredTool.execute("create-check", { action: "create", config: { name: "x" } }, new AbortController().signal, undefined, ctx);
			if (!create.isError) throw new Error("create should be blocked");
			const text = create.content?.[0]?.text ?? "";
			if (!text.includes("not available from child-safe subagent fanout mode")) throw new Error("unexpected create error: " + text);
			const refine = await registeredTool.execute("refine-check", { action: "refine", agent: "worker" }, new AbortController().signal, undefined, ctx);
			if (!refine.isError) throw new Error("refine should be blocked");
			const refineText = refine.content?.[0]?.text ?? "";
			if (!refineText.includes("not available from child-safe subagent fanout mode")) throw new Error("unexpected refine error: " + refineText);
			const grant = await registeredTool.execute("grant-check", { action: "grant-spawn-budget", additional: 1 }, new AbortController().signal, undefined, { ...ctx, hasUI: true });
			if (!grant.isError) throw new Error("grant-spawn-budget should be blocked");
			const grantText = grant.content?.[0]?.text ?? "";
			if (!grantText.includes("root interactive parent session")) throw new Error("unexpected grant error: " + grantText);
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
