import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";

const script = String.raw`
	const handlers = new Map();
	const active = new Set();
	const originalSetTimeout = globalThis.setTimeout;
	const originalSetInterval = globalThis.setInterval;
	const originalClearTimeout = globalThis.clearTimeout;
	const originalClearInterval = globalThis.clearInterval;
	const isMaintenanceTimer = (kind, delay) => {
		const stack = (new Error().stack ?? "").replaceAll("\\", "/");
		return (kind === "timeout" && (delay === 30_000 || delay === 60_000) && stack.includes("/src/extension/index.ts"))
			|| (kind === "interval" && delay === 1_000 && stack.includes("/src/runs/background/wait-subscriptions.ts"));
	};
	globalThis.setTimeout = ((handler, delay, ...args) => { const timer = originalSetTimeout(handler, delay, ...args); if (isMaintenanceTimer("timeout", delay)) active.add(timer); return timer; });
	globalThis.setInterval = ((handler, delay, ...args) => { const timer = originalSetInterval(handler, delay, ...args); if (isMaintenanceTimer("interval", delay)) active.add(timer); return timer; });
	globalThis.clearTimeout = ((timer) => { active.delete(timer); return originalClearTimeout(timer); });
	globalThis.clearInterval = ((timer) => { active.delete(timer); return originalClearInterval(timer); });
	const { default: registerSubagentExtension } = await import("./src/extension/index.ts");
	const events = { on() { return () => {}; }, emit() {} };
	const pi = new Proxy({
		events,
		on(name, handler) { const list = handlers.get(name) ?? []; list.push(handler); handlers.set(name, list); },
		registerTool() {}, registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {}, sendMessage() {}, getSessionName() {},
	}, { get(target, property) { return property in target ? target[property] : () => undefined; } });
	const ctx = {
		cwd: process.cwd(), hasUI: false, model: undefined,
		ui: { setWidget() {}, theme: { fg(_name, text) { return text; }, bg(_name, text) { return text; }, bold(text) { return text; } } },
		sessionManager: { getSessionId() { return "lifecycle-session"; }, getSessionFile() { return null; }, getEntries() { return []; } },
		modelRegistry: { getAvailable() { return []; } },
	};
	registerSubagentExtension(pi);
	const atFactory = active.size;
	for (const handler of handlers.get("session_start") ?? []) await handler({ reason: "startup" }, ctx);
	const atStart = active.size;
	for (const handler of handlers.get("session_start") ?? []) await handler({ reason: "reload" }, ctx);
	const atRepeatedStart = active.size;
	for (const handler of handlers.get("session_shutdown") ?? []) await handler({ reason: "quit" }, ctx);
	const atShutdown = active.size;
	process.stdout.write(JSON.stringify({ atFactory, atStart, atRepeatedStart, atShutdown }));
`;

describe("extension maintenance lifecycle", () => {
	it("starts session-owned maintenance at session_start and cleans it at shutdown", () => {
		const result = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "--eval", script], {
			cwd: process.cwd(), encoding: "utf-8", env: { ...process.env, PI_SUBAGENT_CHILD: undefined },
		});
		assert.equal(result.status, 0, result.stderr);
		assert.deepEqual(JSON.parse(result.stdout), { atFactory: 0, atStart: 3, atRepeatedStart: 3, atShutdown: 0 });
	});
});
