import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";

const script = String.raw`
	const handlers = new Map();
	const calls = [];
	const fs = await import("node:fs");
	const os = await import("node:os");
	const path = await import("node:path");
	const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-shutdown-scope-"));
	console.error = () => {};
	const { default: registerSubagentExtension } = await import("./src/extension/index.ts");
	const { setChildSessionFactory } = await import("./src/runs/shared/child-session.ts");
	const { createEventBus } = await import("@earendil-works/pi-coding-agent");
	const events = createEventBus();
	const parentSessionFile = path.join(projectRoot, "parent-session.jsonl");
	const scripted = {
		async create() { throw new Error("scripted factory: create must not run in this test"); },
		async dispose() { calls.push(["dispose"]); },
		async disposeForParent(parent) { calls.push(["disposeForParent", parent]); },
	};
	setChildSessionFactory(scripted);
	const pi = new Proxy({
		events,
		on(name, handler) { const list = handlers.get(name) ?? []; list.push(handler); handlers.set(name, list); },
		registerTool() {}, registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {}, getSessionName() {},
		sendMessage() {},
	}, { get(target, property) { return property in target ? target[property] : () => undefined; } });
	const ctx = {
		cwd: projectRoot, hasUI: false, model: undefined, isIdle() { return false; },
		ui: { setWidget() {}, requestRender() {}, theme: { fg(_name, text) { return text; }, bg(_name, text) { return text; }, bold(text) { return text; } } },
		sessionManager: {
			getSessionId() { return "shutdown-scope-session"; },
			getSessionFile() { return parentSessionFile; },
			getEntries() { return []; },
		},
		modelRegistry: { getAvailable() { return []; } },
	};
	registerSubagentExtension(pi);
	for (const handler of handlers.get("session_start") ?? []) await handler({ reason: "startup" }, ctx);
	for (const handler of handlers.get("session_shutdown") ?? []) await handler({ reason: "quit" }, ctx);
	console.log(JSON.stringify(calls));
`;

describe("session_shutdown disposal scope", () => {
	it("calls disposeForParent with this session's file, not the whole-process dispose", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-shutdown-scope-fixture-"));
		try {
			const result = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "--eval", script], {
				cwd: process.cwd(),
				encoding: "utf-8",
				env: {
					...process.env,
					HOME: path.join(root, "home"), USERPROFILE: path.join(root, "home"),
					PI_CODING_AGENT_DIR: path.join(root, "agent"),
					TMPDIR: root, TMP: root, TEMP: root,
					PI_SUBAGENT_CHILD: undefined,
					PI_SUBAGENTS_TEST_NO_OWNER: "1",
				},
				timeout: 10_000,
			});
			assert.equal(result.status, 0, result.stderr);
			const calls: Array<[string, unknown?]> = JSON.parse(result.stdout.trim().split("\n").pop() ?? "[]");
			// The file must be read before runtimeEntry.cleanup() clears it in the same handler.
			assert.deepEqual(calls.map(([name]) => name), ["disposeForParent"]);
			assert.match(String(calls[0]?.[1]), /parent-session\.jsonl$/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
