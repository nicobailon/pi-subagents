import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";

const script = String.raw`
	const handlers = new Map();
	const errors = [];
	const sent = [];
	const fs = await import("node:fs");
	const os = await import("node:os");
	const path = await import("node:path");
	const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-end-goal-"));
	console.error = (...args) => errors.push(args.map((value) => value instanceof Error ? value.message : String(value)).join(" "));
	const { default: registerSubagentExtension } = await import("./src/extension/index.ts");
	const { createEventBus } = await import("@earendil-works/pi-coding-agent");
	const { registerBackgroundWorkProvider } = await import("./src/api/background-work.ts");
	const { createMission, resolveMissionStoreLocation } = await import("./src/missions/store.ts");
	const events = createEventBus();
	const pi = new Proxy({
		events,
		on(name, handler) { const list = handlers.get(name) ?? []; list.push(handler); handlers.set(name, list); },
		registerTool() {}, registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {}, getSessionName() {},
		sendMessage(message, options) { sent.push({ message, options }); },
	}, { get(target, property) { return property in target ? target[property] : () => undefined; } });
	const ctx = {
		cwd: projectRoot, hasUI: false, model: undefined,
		ui: { setWidget() {}, requestRender() {}, theme: { fg(_name, text) { return text; }, bg(_name, text) { return text; }, bold(text) { return text; } } },
		sessionManager: {
			getSessionId() { return "agent-end-drain-session"; },
			getSessionFile() { return null; },
			getEntries() { return []; },
		},
		modelRegistry: { getAvailable() { return []; } },
	};
	registerSubagentExtension(pi);
	for (const handler of handlers.get("session_start") ?? []) await handler({ reason: "startup" }, ctx);
	const mission = createMission(resolveMissionStoreLocation({ projectRoot }), {
		title: "Continue after drain", objective: "Deliver the goal reminder", goal: true,
		budget: { tokens: 100 }, status: "active", ownerSessionId: "agent-end-drain-session",
	});
	const dispose = registerBackgroundWorkProvider({
		name: "agent-end-drain-test",
		listActiveWork() {
			if (process.env.PI_SUBAGENTS_TEST_DRAIN_FAILURE === "1") throw new Error("synthetic drain failure");
			return [];
		},
	});
	let rejected = null;
	try {
		for (const handler of handlers.get("agent_end") ?? []) {
			await handler({ type: "agent_end", messages: [], willRetry: false }, ctx);
		}
	} catch (error) {
		rejected = error instanceof Error ? error.message : String(error);
	}
	dispose();
	for (const handler of handlers.get("session_shutdown") ?? []) await handler({ reason: "quit" }, ctx);
	fs.rmSync(projectRoot, { recursive: true, force: true });
	process.stdout.write(JSON.stringify({ rejected, errors, sent, missionId: mission.id }));
`;

describe("headless agent_end auto-drain", () => {
	for (const failedDrain of [true, false]) {
		it(`delivers goal notices after ${failedDrain ? "a failed" : "a successful"} drain`, () => {
			const result = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "--eval", script], {
				cwd: process.cwd(),
				encoding: "utf-8",
				env: { ...process.env, PI_SUBAGENT_CHILD: undefined, PI_SUBAGENTS_TEST_DRAIN_FAILURE: failedDrain ? "1" : "0" },
				timeout: 10_000,
			});
			assert.equal(result.status, 0, result.stderr);
			const payload = JSON.parse(result.stdout) as {
				rejected: string | null;
				errors: string[];
				missionId: string;
				sent: Array<{ message: { content: string; details: { source?: string } }; options: { triggerTurn: boolean } }>;
			};
			assert.equal(payload.rejected, null);
			assert.equal(
				payload.errors.filter((message) => /Failed to auto-drain outstanding subagent work:.*synthetic drain failure/.test(message)).length,
				failedDrain ? 1 : 0,
			);
			assert.deepEqual(payload.errors.filter((message) => /Failed to evaluate goal missions/.test(message)), []);
			const notices = payload.sent.filter(({ message }) => message.details?.source === "goal");
			assert.equal(notices.length, 1);
			assert.match(notices[0]!.message.content, /Next ready action: Continue objective: Deliver the goal reminder/);
			assert.ok(notices[0]!.message.content.includes(payload.missionId));
			assert.deepEqual(notices[0]!.options, { triggerTurn: false });
		});
	}
});
