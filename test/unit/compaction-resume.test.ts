import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, it } from "node:test";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("async compaction resume", () => {
	it("continues an interactive parent after compaction while async work is active", () => {
		const script = String.raw`
			import os from "node:os";
			import path from "node:path";
			import registerSubagentExtension from "./index.ts";
			const handlers = new Map();
			const events = { listeners: new Map(), on(name, handler) { this.listeners.set(name, handler); return () => this.listeners.delete(name); }, emit(name, payload) { this.listeners.get(name)?.(payload); } };
			const sent = [];
			const widgets = [];
			let renders = 0;
			const pi = new Proxy({
				events,
				on(name, handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
				registerTool() {}, registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {},
				sendMessage(message, options) { sent.push({ message, options }); }, getSessionName() { return undefined; },
			}, { get(target, prop) { return prop in target ? target[prop] : () => undefined; } });
			const ctx = { cwd: process.cwd(), hasUI: true, ui: { setWidget(key, value) { widgets.push([key, value]); }, requestRender() { renders++; }, onTerminalInput() { return () => {}; }, getEditorText() { return ""; }, notify() {}, theme: { fg(_name, text) { return text; }, bg(_name, text) { return text; }, bold(text) { return text; } } }, sessionManager: { getSessionId() { return "compact-session"; }, getSessionFile() { return null; }, getEntries() { return []; } }, modelRegistry: { getAvailable() { return []; } } };
			registerSubagentExtension(pi);
			for (const handler of handlers.get("session_start")) await handler({}, ctx);
			sent.length = 0;
			events.emit("subagent:async-started", { id: "running", pid: 1, sessionId: "compact-session", mode: "single", agent: "worker", asyncDir: path.join(os.tmpdir(), "pi-compaction-test-running") });
			widgets.length = 0;
			renders = 0;
			for (const handler of handlers.get("session_before_compact")) await handler({ reason: "threshold", signal: new AbortController().signal });
			const cleared = widgets.filter(([key, value]) => value === undefined).map(([key]) => key).sort();
			if (JSON.stringify(cleared) !== JSON.stringify(["subagent-async", "subagent-fleet-status"])) throw new Error(JSON.stringify(widgets));
			widgets.length = 0;
			events.emit("subagent:async-complete", { id: "running", sessionId: "compact-session", agent: "worker", success: true, summary: "done" });
			events.emit("subagent:async-started", { id: "running-2", pid: 2, sessionId: "compact-session", mode: "single", agent: "worker", asyncDir: path.join(os.tmpdir(), "pi-compaction-test-running-2") });
			if (widgets.length !== 0 || renders !== 0) throw new Error("widgets repainted during compaction");
			for (const handler of handlers.get("session_compact")) await handler({ reason: "threshold" });
			if (widgets.length !== 0) throw new Error("widgets restored inside compaction hook");
			for (const handler of handlers.get("agent_start")) await handler();
			const restored = widgets.filter(([_, value]) => value !== undefined).map(([key]) => key).sort();
			if (JSON.stringify(restored) !== JSON.stringify(["subagent-async", "subagent-fleet-status"])) throw new Error(JSON.stringify(widgets));
			if (sent.length !== 1 || sent[0].options?.triggerTurn !== true || sent[0].message?.customType !== "subagent-compaction-resume") throw new Error(JSON.stringify(sent));

			sent.length = 0;
			events.emit("subagent:async-complete", { id: "running-2", sessionId: "compact-session", agent: "worker", success: true, summary: "done" });
			for (const handler of handlers.get("session_before_compact")) await handler({ reason: "threshold", signal: new AbortController().signal });
			for (const handler of handlers.get("session_compact")) await handler({ reason: "threshold" });
			for (const handler of handlers.get("agent_settled")) await handler();
			if (sent.some((entry) => entry.message?.customType === "subagent-compaction-resume")) throw new Error("resumed without active work");

			events.emit("subagent:async-started", { id: "running-3", pid: 3, sessionId: "compact-session", mode: "single", agent: "worker", asyncDir: path.join(os.tmpdir(), "pi-compaction-test-running-3") });
			widgets.length = 0;
			for (const handler of handlers.get("session_before_compact")) await handler({ reason: "overflow", signal: new AbortController().signal });
			widgets.length = 0;
			for (const handler of handlers.get("agent_settled")) await handler();
			if (!widgets.some(([_, value]) => value !== undefined)) throw new Error("widgets did not recover after compaction failure");

			widgets.length = 0;
			for (const handler of handlers.get("session_before_compact")) await handler({ reason: "manual", signal: new AbortController().signal });
			if (widgets.length !== 0) throw new Error("manual compaction changed widget state");
			for (const handler of handlers.get("session_shutdown")) await handler();
		`;
		const env = { ...process.env };
		delete env.PI_SUBAGENT_CHILD;
		execFileSync(process.execPath, ["--experimental-strip-types", "--import", "./test/support/register-loader.mjs", "--input-type=module", "--eval", script], { cwd: projectRoot, env, stdio: "pipe" });
		assert.ok(true);
	});

	it("ignores stale cached UI context during compaction lifecycle callbacks", () => {
		const script = String.raw`
			import registerSubagentExtension from "./index.ts";
			const handlers = new Map();
			const events = { listeners: new Map(), on(name, handler) { this.listeners.set(name, handler); return () => this.listeners.delete(name); }, emit(name, payload) { this.listeners.get(name)?.(payload); } };
			const pi = new Proxy({
				events,
				on(name, handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
				registerTool() {}, registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {},
				sendMessage() {}, getSessionName() { return undefined; },
			}, { get(target, prop) { return prop in target ? target[prop] : () => undefined; } });
			let stale = false;
			const ctx = { cwd: process.cwd(), get hasUI() { if (stale) throw new Error("This extension ctx is stale after session replacement or reload."); return true; }, ui: { setWidget() {}, requestRender() {}, onTerminalInput() { return () => {}; }, getEditorText() { return ""; }, notify() {}, theme: { fg(_name, text) { return text; }, bg(_name, text) { return text; }, bold(text) { return text; } } }, sessionManager: { getSessionId() { return "stale-context-session"; }, getSessionFile() { return null; }, getEntries() { return []; } }, modelRegistry: { getAvailable() { return []; } } };
			registerSubagentExtension(pi);
			for (const handler of handlers.get("session_start")) await handler({}, ctx);
			events.emit("subagent:async-started", { id: "running", sessionId: "stale-context-session", mode: "single", agent: "worker", asyncDir: "/tmp/pi-stale-context-running" });
			stale = true;
			for (const handler of handlers.get("session_compact")) await handler({ reason: "threshold" });
			for (const handler of handlers.get("session_before_compact")) await handler({ reason: "threshold", signal: new AbortController().signal });
			for (const handler of handlers.get("session_shutdown")) await handler();
		`;
		const env = { ...process.env };
		delete env.PI_SUBAGENT_CHILD;
		execFileSync(process.execPath, ["--experimental-strip-types", "--import", "./test/support/register-loader.mjs", "--input-type=module", "--eval", script], { cwd: projectRoot, env, stdio: "pipe" });
		assert.ok(true);
	});
});
