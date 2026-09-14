import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { createSubagentExecutor } from "../../src/runs/foreground/subagent-executor.ts";
import type { AuthorityPolicyConfig, SubagentState } from "../../src/shared/types.ts";

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

function createExecutor(authorityPolicy?: AuthorityPolicyConfig, childSafe = false) {
	return createSubagentExecutor({
		pi: { events: { emit() {}, on() { return () => {}; } }, getSessionName() { return "parent"; } } as any,
		state: createState(),
		config: { maxSubagentDepth: 2, control: {}, intercomBridge: {}, ...(authorityPolicy ? { authorityPolicy } : {}) } as any,
		...(childSafe ? { allowMutatingManagementActions: false } : {}),
		asyncByDefault: false,
		tempArtifactsDir: os.tmpdir(),
		getSubagentSessionRoot: () => os.tmpdir(),
		expandTilde: (value) => value,
		discoverAgents: () => ({ agents: [] }),
	});
}

function ctx(ui?: { confirm: () => Promise<boolean> }) {
	return {
		cwd: os.tmpdir(),
		hasUI: Boolean(ui),
		...(ui ? { ui } : {}),
		sessionManager: { getSessionId() { return "session"; }, getSessionFile() { return null; } },
		modelRegistry: { getAvailable() { return []; } },
	} as any;
}

async function run(action: string, policy?: AuthorityPolicyConfig, ui?: { confirm: () => Promise<boolean> }, childSafe = false): Promise<{ text: string; isError?: boolean }> {
	const result = await createExecutor(policy, childSafe).execute(action, { action }, new AbortController().signal, undefined, ctx(ui));
	return { text: result.content.find((entry) => entry.type === "text")?.text ?? "", ...(result.isError === undefined ? {} : { isError: result.isError }) };
}

// `project.open` spawns the Herdr CLI, so point the client at a path that cannot
// exist whenever the policy is expected to let the action through.
async function withoutHerdr<T>(body: () => Promise<T>): Promise<T> {
	const previous = process.env.HERDR_BIN;
	process.env.HERDR_BIN = path.join(os.tmpdir(), "pi-subagents-absent-herdr-binary");
	try {
		return await body();
	} finally {
		if (previous === undefined) delete process.env.HERDR_BIN;
		else process.env.HERDR_BIN = previous;
	}
}

describe("inspector and project pane authority policy", () => {
	it("requires confirmation for project.open and fails closed without an interactive UI", async () => {
		const { text, isError } = await run("project.open");

		assert.equal(isError, true);
		assert.match(text, /requires user confirmation for action 'project\.open'/);
	});

	it("cancels project.open when the operator declines the confirmation", async () => {
		let asked = 0;
		const { text } = await run("project.open", undefined, { confirm: async () => { asked += 1; return false; } });

		assert.equal(asked, 1);
		assert.match(text, /Action 'project\.open' canceled; authority was not granted\./);
	});

	it("forbids project.open outright when the policy says so", async () => {
		const { text, isError } = await run("project.open", { projectOpen: "forbid" });

		assert.equal(isError, true);
		assert.match(text, /Authority policy forbids action 'project\.open'\./);
	});

	it("runs project.open unprompted when the policy opts back in to auto", async () => {
		const { text } = await withoutHerdr(() => run("project.open", { projectOpen: "auto" }));

		assert.doesNotMatch(text, /Authority policy/);
		assert.match(text, /Herdr/);
	});

	it("leaves inspector.open automatic by default so the plugin gate still decides", async () => {
		const { text } = await run("inspector.open");

		assert.doesNotMatch(text, /Authority policy/);
		assert.match(text, /Inspector actions require id or dir/);
	});

	it("forbids inspector.open when the policy says so", async () => {
		const { text, isError } = await run("inspector.open", { inspectorOpen: "forbid" });

		assert.equal(isError, true);
		assert.match(text, /Authority policy forbids action 'inspector\.open'\./);
	});

	it("requires confirmation for inspector.open when the operator opts in", async () => {
		const { text, isError } = await run("inspector.open", { inspectorOpen: "confirm" });

		assert.equal(isError, true);
		assert.match(text, /requires user confirmation for action 'inspector\.open'/);
	});

	it("refuses project.open in child-safe fanout mode without prompting for authority", async () => {
		let asked = 0;
		const { text, isError } = await run("project.open", undefined, { confirm: async () => { asked += 1; return true; } }, true);

		assert.equal(asked, 0);
		assert.equal(isError, true);
		assert.match(text, /Action 'project\.open' is not available from child-safe subagent fanout mode\./);
	});

	it("reports the child-safe restriction for inspector.open rather than the policy that also forbids it", async () => {
		const { text, isError } = await run("inspector.open", { inspectorOpen: "forbid" }, undefined, true);

		assert.equal(isError, true);
		assert.match(text, /Action 'inspector\.open' is not available from child-safe subagent fanout mode\./);
	});

	it("refuses schedule.create in child-safe fanout mode without prompting for authority", async () => {
		let asked = 0;
		const { text, isError } = await run("schedule.create", { scheduleCreate: "confirm" }, { confirm: async () => { asked += 1; return true; } }, true);

		assert.equal(asked, 0);
		assert.equal(isError, true);
		assert.match(text, /Action 'schedule\.create' is not available from child-safe subagent fanout mode\./);
	});
});
