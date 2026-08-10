import assert from "node:assert/strict";
import * as os from "node:os";
import { describe, it } from "node:test";
import { createSubagentExecutor, unknownSubagentActionMessage } from "../../src/runs/foreground/subagent-executor.ts";
import type { SubagentState } from "../../src/shared/types.ts";

function createState(): SubagentState {
	return {
		baseCwd: "",
		currentSessionId: null,
		asyncJobs: new Map(),
		foregroundRuns: new Map(),
		foregroundControls: new Map(),
		lastForegroundControlId: null,
		pendingForegroundControlNotices: new Map(),
		cleanupTimers: new Map(),
		lastUiContext: null,
		poller: null,
		completionSeen: new Map(),
		watcher: null,
		watcherRestartTimer: null,
		resultFileCoalescer: { schedule: () => false, clear: () => {} },
	};
}

function createExecutor() {
	return createSubagentExecutor({
		pi: { events: { emit() {}, on() { return () => {}; } }, getSessionName() { return "parent"; } } as any,
		state: createState(),
		config: { maxSubagentDepth: 2, control: {}, intercomBridge: {} } as any,
		asyncByDefault: false,
		tempArtifactsDir: os.tmpdir(),
		getSubagentSessionRoot: () => os.tmpdir(),
		expandTilde: (value) => value,
		discoverAgents: () => ({ agents: [] }),
	});
}

function ctx() {
	return {
		cwd: os.tmpdir(),
		hasUI: false,
		sessionManager: { getSessionId() { return "session"; }, getSessionFile() { return null; } },
		modelRegistry: { getAvailable() { return []; } },
	} as any;
}

describe("subagent action recovery", () => {
	it("suggests a benign typo with safe next steps", () => {
		const message = unknownSubagentActionMessage("statsu");

		assert.match(message, /Unknown action: statsu\. Did you mean status\?/);
		assert.match(message, /Use subagent\(\{ action: "status" \}\)/);
		assert.match(message, /Valid: .*status/);
	});

	it("does not suggest a destructive near-miss", () => {
		const message = unknownSubagentActionMessage("del");

		assert.match(message, /Unknown action: del\./);
		assert.doesNotMatch(message, /Did you mean delete\?/);
		assert.match(message, /Valid: .*delete/);
	});

	it("returns a concise recovery error for an invalid action", async () => {
		const result = await createExecutor().execute("invalid-action", { action: "statsu" }, new AbortController().signal, undefined, ctx());
		assert.equal(result.isError, true);
		assert.equal(result.content[0]?.type, "text");
		assert.equal(result.content[0]?.text, unknownSubagentActionMessage("statsu"));
	});

	it("routes invalid schedule actions through common recovery", async () => {
		const result = await createExecutor().execute("invalid-schedule-action", { action: "schedule.lsit" }, new AbortController().signal, undefined, ctx());
		assert.equal(result.isError, true);
		assert.equal(result.content[0]?.type, "text");
		assert.equal(result.content[0]?.text, unknownSubagentActionMessage("schedule.lsit"));
	});

	it("lists and suggests mission decision resolution", () => {
		const message = unknownSubagentActionMessage("mission.resolve-decison");

		assert.match(message, /Did you mean mission\.resolve-decision\?/);
		assert.match(message, /Valid: .*mission\.resolve-decision/);
	});
});
