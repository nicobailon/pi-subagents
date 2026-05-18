import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { SUBAGENT_CHILD_ENV } from "../../src/runs/shared/pi-args.ts";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function parentToolEnv(): NodeJS.ProcessEnv {
	const env = { ...process.env };
	delete env[SUBAGENT_CHILD_ENV];
	return env;
}

describe("subagent extension child mode", () => {
	it("collapses tool detail before direct subagent tool execution", () => {
		const script = String.raw`
			import registerSubagentExtension from "./src/extension/index.ts";
			const events = { on() { return () => {}; }, emit() {} };
			let registeredTool;
			const fakePi = new Proxy({
				events,
				registerTool(tool) { registeredTool = tool; },
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
				"--experimental-transform-types",
				"--import",
				"./test/support/register-loader.mjs",
				"--input-type=module",
				"--eval",
				script,
			],
			{ cwd: projectRoot, env: parentToolEnv(), stdio: "pipe" },
		);
	});

	it("does not show async badge for explicit foreground clarify chain calls", () => {
		const script = String.raw`
			import registerSubagentExtension from "./src/extension/index.ts";
			const events = { on() { return () => {}; }, emit() {} };
			let registeredTool;
			const fakePi = new Proxy({
				events,
				registerTool(tool) { registeredTool = tool; },
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
			const theme = { fg(_name, text) { return text; }, bold(text) { return text; } };
			const asyncChain = registeredTool.renderCall({ chain: [{ agent: "worker" }, { agent: "reviewer" }], async: true }, theme).text;
			const clarifyChain = registeredTool.renderCall({ chain: [{ agent: "worker" }, { agent: "reviewer" }], async: true, clarify: true }, theme).text;
			if (!asyncChain.includes("[async]")) throw new Error("expected async chain badge, got " + asyncChain);
			if (clarifyChain.includes("[async]")) throw new Error("unexpected clarify async badge: " + clarifyChain);
		`;

		execFileSync(
			process.execPath,
			[
				"--experimental-transform-types",
				"--import",
				"./test/support/register-loader.mjs",
				"--input-type=module",
				"--eval",
				script,
			],
			{ cwd: projectRoot, env: parentToolEnv(), stdio: "pipe" },
		);
	});

	it("returns before registering parent tools, slash commands, renderers, or event handlers", () => {
		const script = String.raw`
			import registerSubagentExtension from "./src/extension/index.ts";
			import { SUBAGENT_CHILD_ENV } from "./src/runs/shared/pi-args.ts";
			process.env[SUBAGENT_CHILD_ENV] = "1";
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
				"--experimental-transform-types",
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
