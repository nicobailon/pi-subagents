import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { SUBAGENT_CHILD_ENV, SUBAGENT_FANOUT_CHILD_ENV } from "../../src/runs/shared/pi-args.ts";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
function parentToolEnv(): NodeJS.ProcessEnv {
	const env = { ...process.env };
	delete env[SUBAGENT_CHILD_ENV];
	delete env[SUBAGENT_FANOUT_CHILD_ENV];
	return env;
}

function runProbe(script: string, options: { env?: NodeJS.ProcessEnv } = {}): void {
	execFileSync(
		process.execPath,
		[
			"--input-type=module",
			"--eval",
			String.raw`import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
${script}`,
		],
		{ cwd: projectRoot, stdio: "pipe", ...options },
	);
}

describe("subagent extension child mode", () => {
	it("collapses tool detail before direct subagent tool execution", () => {
		const script = String.raw`
			const { default: registerSubagentExtension } = await jiti.import("./src/extension/index.ts");
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
			if (!registeredTool.promptSnippet?.includes("Delegate bounded work")) throw new Error("missing parent promptSnippet");
			const parentGuidelines = registeredTool.promptGuidelines ?? [];
			if (!parentGuidelines.some((line) => line.includes("action: \"list\""))) throw new Error("missing list-before-execute guideline");
			if (!parentGuidelines.some((line) => line.includes("parent session responsible"))) throw new Error("missing parent-owns-final-decision guideline");
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

		runProbe(script, { env: parentToolEnv() });
	});

	it("does not show async badge for explicit foreground clarify chain calls", () => {
		const script = String.raw`
			const { default: registerSubagentExtension } = await jiti.import("./src/extension/index.ts");
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

		runProbe(script, { env: parentToolEnv() });
	});

	it("returns before registering anything for non-fanout children", () => {
		const script = String.raw`
			const { default: registerSubagentExtension } = await jiti.import("./src/extension/index.ts");
			const { SUBAGENT_CHILD_ENV, SUBAGENT_FANOUT_CHILD_ENV } = await jiti.import("./src/runs/shared/pi-args.ts");
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

		runProbe(script);
	});

	it("registers only the child-safe subagent tool for fanout children", () => {
		const script = String.raw`
			const { default: registerSubagentExtension } = await jiti.import("./src/extension/index.ts");
			const { SUBAGENT_CHILD_ENV, SUBAGENT_FANOUT_CHILD_ENV } = await jiti.import("./src/runs/shared/pi-args.ts");
			process.env[SUBAGENT_CHILD_ENV] = "1";
			process.env[SUBAGENT_FANOUT_CHILD_ENV] = "1";
			const calls = [];
			let registeredTool;
			const fakePi = new Proxy({
				events: { on() { calls.push("events.on"); return () => {}; }, emit() { calls.push("events.emit"); } },
				registerTool(tool) { calls.push("registerTool"); registeredTool = tool; },
				getSessionName() { return undefined; },
			}, {
				get(target, prop) {
					if (prop in target) return target[prop];
					return (..._args) => {
						calls.push(String(prop));
						return undefined;
					};
				},
			});
			registerSubagentExtension(fakePi);
			if (!registeredTool || registeredTool.name !== "subagent") throw new Error("child-safe subagent tool not registered");
			if (!registeredTool.promptSnippet?.includes("child-safe")) throw new Error("missing child-safe promptSnippet");
			const childGuidelines = registeredTool.promptGuidelines ?? [];
			if (!childGuidelines.some((line) => line.includes("child-safe fanout mode"))) throw new Error("missing child-safe fanout guideline");
			if (!childGuidelines.some((line) => line.includes("create, update, and delete are blocked"))) throw new Error("missing child-safe mutation-block guideline");
			const unexpected = calls.filter((call) => call !== "registerTool");
			if (unexpected.length > 0) throw new Error("Unexpected parent-surface registrations: " + unexpected.join(", "));
		`;

		runProbe(script);
	});

	it("lets fanout children call read-only list but blocks mutating management actions", () => {
		const script = String.raw`
			const { default: registerFanoutChildSubagentExtension } = await jiti.import("./src/extension/fanout-child.ts");
			const { SUBAGENT_CHILD_ENV, SUBAGENT_FANOUT_CHILD_ENV } = await jiti.import("./src/runs/shared/pi-args.ts");
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
		`;

		runProbe(script);
	});
});
