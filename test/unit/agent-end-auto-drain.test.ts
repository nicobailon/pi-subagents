import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";

const script = String.raw`
	const handlers = new Map();
	const errors = [];
	const sent = [];
	const fs = await import("node:fs");
	const os = await import("node:os");
	const path = await import("node:path");
	const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-end-goal-"));
	const hasOwner = process.env.PI_SUBAGENTS_TEST_NO_OWNER !== "1";
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
	if (hasOwner) for (const handler of handlers.get("session_start") ?? []) await handler({ reason: "startup" }, ctx);
	const mission = hasOwner ? createMission(resolveMissionStoreLocation({ projectRoot }), {
		title: "Continue after drain", objective: "Deliver the goal reminder", goal: true,
		budget: { tokens: 100 }, status: "active", ownerSessionId: "agent-end-drain-session",
	}) : null;
	const providerError = new Error("synthetic drain failure");
	const dispose = registerBackgroundWorkProvider({
		name: "agent-end-drain-test",
		listActiveWork() {
			if (process.env.PI_SUBAGENTS_TEST_DRAIN_FAILURE === "1") throw providerError;
			return [];
		},
	});
	if (process.env.PI_SUBAGENTS_TEST_FINISHED_RUN === "1") {
		const { RESULTS_DIR } = await import("./src/shared/types.ts");
		const { resultFilePath, writeAsyncResultFile } = await import("./src/runs/background/result-files.ts");
		const { currentCompletionOwnerId } = await import("./src/shared/completion-owner.ts");
		writeAsyncResultFile(resultFilePath(RESULTS_DIR, "finished-run"), {
			id: "finished-run", runId: "finished-run", agent: "worker", mode: "single", state: "complete",
			success: true, exitCode: 0, summary: "CHILD_DONE", timestamp: Date.now(),
			sessionId: "agent-end-drain-session", completionOwnerId: currentCompletionOwnerId(),
		});
	}
	let rejected = null;
	let preservedCause = false;
	try {
		for (const handler of handlers.get("agent_end") ?? []) {
			await handler({ type: "agent_end", messages: [], willRetry: false }, ctx);
		}
	} catch (error) {
		rejected = error instanceof Error ? error.message : String(error);
		preservedCause = error instanceof Error && error.cause === providerError;
	}
	const sentByAgentEnd = sent.length;
	dispose();
	for (const handler of handlers.get("session_shutdown") ?? []) await handler({ reason: "quit" }, ctx);
	fs.rmSync(projectRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	process.stdout.write(JSON.stringify({ rejected, preservedCause, errors, sent, sentByAgentEnd, missionId: mission?.id }));
`;

function runScript(root: string, env: Record<string, string | undefined>) {
	const result = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "--eval", script], {
		cwd: process.cwd(),
		encoding: "utf-8",
		env: {
			...process.env,
			HOME: path.join(root, "home"), USERPROFILE: path.join(root, "home"),
			PI_CODING_AGENT_DIR: path.join(root, "agent"),
			TMPDIR: root, TMP: root, TEMP: root,
			PI_SUBAGENT_CHILD: undefined,
			...env,
		},
		timeout: 10_000,
	});
	assert.equal(result.status, 0, result.stderr);
	return JSON.parse(result.stdout) as {
		rejected: string | null;
		preservedCause: boolean;
		errors: string[];
		missionId: string;
		sentByAgentEnd: number;
		sent: Array<{ message: { customType: string; content: string; details: { source?: string } }; options: { triggerTurn: boolean } }>;
	};
}

describe("headless agent_end auto-drain", () => {
	for (const scenario of [
		{ name: "delivers goal notices while preserving a failed drain", failedDrain: true, hasOwner: true },
		{ name: "delivers goal notices after a successful drain", failedDrain: false, hasOwner: true },
		{ name: "preserves the drain rejection when no session owns goal notices", failedDrain: false, hasOwner: false },
	]) {
		it(scenario.name, () => {
			const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-end-fixture-"));
			try {
				const payload = runScript(root, {
					PI_SUBAGENTS_TEST_DRAIN_FAILURE: scenario.failedDrain ? "1" : "0",
					PI_SUBAGENTS_TEST_NO_OWNER: scenario.hasOwner ? "0" : "1",
				});
				assert.equal(payload.rejected, !scenario.hasOwner
					? "Cannot auto-drain background work without an active session identity."
					: scenario.failedDrain ? "Background-work provider 'agent-end-drain-test' listActiveWork failed: synthetic drain failure" : null);
				assert.equal(payload.preservedCause, scenario.failedDrain);
				assert.deepEqual(payload.errors, []);
				const notices = payload.sent.filter(({ message }) => message.details?.source === "goal");
				assert.equal(notices.length, scenario.hasOwner ? 1 : 0);
				if (!scenario.hasOwner) return;
				assert.match(notices[0]!.message.content, /Next ready action: Continue objective: Deliver the goal reminder/);
				assert.ok(notices[0]!.message.content.includes(payload.missionId));
				assert.deepEqual(notices[0]!.options, { triggerTurn: false });
			} finally {
				fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
			}
		});
	}

	it("sends a finished run's completion before the turn settles, so disposal right after cannot lose it", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-end-fixture-"));
		try {
			const payload = runScript(root, { PI_SUBAGENTS_TEST_FINISHED_RUN: "1" });
			assert.equal(payload.rejected, null);
			assert.deepEqual(payload.errors, []);
			const completions = payload.sent.slice(0, payload.sentByAgentEnd).filter(({ message }) => message.customType === "subagent-notify");
			assert.equal(completions.length, 1);
			assert.match(completions[0]!.message.content, /CHILD_DONE/);
			assert.deepEqual(completions[0]!.options, { triggerTurn: true });
		} finally {
			fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
		}
	});
});
