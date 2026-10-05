import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { acquireActiveAsyncCapacity } from "../../src/runs/background/active-async-capacity.ts";
import { createEventBus, createTempDir, makeMinimalCtx, removeTempDir, tryImport } from "../support/helpers.ts";

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const importHome = createTempDir("pi-doctor-executor-import-home-");
process.env.HOME = importHome;
process.env.USERPROFILE = importHome;
let executorMod: any;
try {
	executorMod = await tryImport<any>("./src/runs/foreground/subagent-executor.ts");
} finally {
	if (originalHome === undefined) delete process.env.HOME;
	else process.env.HOME = originalHome;
	if (originalUserProfile === undefined) delete process.env.USERPROFILE;
	else process.env.USERPROFILE = originalUserProfile;
	removeTempDir(importHome);
}
const createSubagentExecutor = executorMod?.createSubagentExecutor;

function makeState(cwd: string) {
	return {
		baseCwd: cwd,
		currentSessionId: null,
		asyncJobs: new Map(),
		foregroundControls: new Map(),
		lastForegroundControlId: null,
		cleanupTimers: new Map(),
		lastUiContext: null,
		poller: null,
		completionSeen: new Map(),
		watcher: null,
		watcherRestartTimer: null,
		resultFileCoalescer: { schedule: () => false, clear: () => {} },
	};
}

describe("doctor action executor routing", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, () => {
	let tempDir = "";
	let tempHome = "";

	beforeEach(() => {
		tempDir = createTempDir("pi-doctor-executor-project-");
		tempHome = createTempDir("pi-doctor-executor-home-");
		process.env.HOME = tempHome;
		process.env.USERPROFILE = tempHome;
	});

	afterEach(() => {
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;
		if (originalUserProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = originalUserProfile;
		removeTempDir(tempDir);
		removeTempDir(tempHome);
	});

	it("returns a doctor report for the tool action", async () => {
		const sessionFile = path.join(tempDir, "sessions", "parent.jsonl");
		fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
		fs.writeFileSync(sessionFile, "");
		const executor = createSubagentExecutor({
			pi: { events: createEventBus(), getSessionName: () => undefined },
			state: makeState(tempDir),
			config: { defaultSessionDir: path.join(tempDir, "configured-sessions") },
			asyncByDefault: false,
			tempArtifactsDir: tempDir,
			getSubagentSessionRoot: () => tempDir,
			expandTilde: (value: string) => value,
			discoverAgents: () => ({ agents: [] }),
		});
		const ctx = makeMinimalCtx(tempDir);
		ctx.sessionManager.getSessionFile = () => sessionFile;
		ctx.sessionManager.getSessionId = () => "session-doctor";

		const result = await executor.execute(
			"doctor-id",
			{ action: "doctor" },
			new AbortController().signal,
			undefined,
			ctx,
		);

		assert.equal(result.isError, undefined);
		const text = result.content[0]?.text ?? "";
		assert.match(text, /^Subagents doctor report/);
		assert.match(text, /- configured session dir: .*configured-sessions/);
		assert.match(text, /- supervisor channel: available \(native:pi-subagents-supervisor-channel\)/);
	});

	it("counts async capacity in the pool launch admission uses", async () => {
		const sessionFile = path.join(tempDir, "sessions", "resumed.jsonl");
		const capacity = acquireActiveAsyncCapacity({ sessionId: sessionFile, limit: 3, runId: "doctor-held-run", kind: "runner", asyncDir: path.join(tempDir, "doctor-held-run") });
		try {
			const executor = createSubagentExecutor({
				pi: { events: createEventBus(), getSessionName: () => undefined },
				state: makeState(tempDir),
				config: { maxActiveAsyncRunsPerSession: 3 },
				asyncByDefault: false,
				tempArtifactsDir: tempDir,
				getSubagentSessionRoot: () => tempDir,
				expandTilde: (value: string) => value,
				discoverAgents: () => ({ agents: [] }),
			});
			const ctx = makeMinimalCtx(tempDir);
			ctx.sessionManager.getSessionFile = () => sessionFile;
			ctx.sessionManager.getSessionId = () => "short-session-id";

			const result = await executor.execute("doctor-id", { action: "doctor" }, new AbortController().signal, undefined, ctx);

			assert.match(result.content[0]?.text ?? "", /Active async capacity\n- usage: 1\/3 used/);
			assert.deepEqual(result.details.activeAsyncCapacity, { used: 1, limit: 3 });
		} finally {
			capacity?.rollback();
		}
	});

	it("reports session manager failures without failing the doctor action", async () => {
		const executor = createSubagentExecutor({
			pi: { events: createEventBus(), getSessionName: () => undefined },
			state: makeState(tempDir),
			config: {},
			asyncByDefault: false,
			tempArtifactsDir: tempDir,
			getSubagentSessionRoot: () => tempDir,
			expandTilde: (value: string) => value,
			discoverAgents: () => ({ agents: [] }),
		});
		const ctx = makeMinimalCtx(tempDir);
		ctx.sessionManager.getSessionFile = () => {
			throw new Error("session unavailable");
		};
		ctx.sessionManager.getSessionId = () => {
			throw new Error("session unavailable");
		};

		const result = await executor.execute(
			"doctor-id",
			{ action: "doctor" },
			new AbortController().signal,
			undefined,
			ctx,
		);

		assert.equal(result.isError, undefined);
		const text = result.content[0]?.text ?? "";
		assert.match(text, /^Subagents doctor report/);
		assert.match(text, /- session manager: failed — Error: session unavailable/);
		assert.match(text, /- current session file: not available/);
	});
});
