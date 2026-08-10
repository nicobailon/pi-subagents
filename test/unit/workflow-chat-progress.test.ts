import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { isSameGitRepository, resolveWorkflowChatProgress } from "../../src/workflows/chat-progress.ts";
import { renderSubagentResult } from "../../src/tui/render.ts";
import { bindMissionWorkflowChildAsyncLaunch, createSubagentExecutor, foregroundResultIntercomStatus, missionWorkflowChildStatus, runMissionWorkflowChild, shouldSuppressRoutineResultIntercom } from "../../src/runs/foreground/subagent-executor.ts";
import { readMissionBinding } from "../../src/missions/lifecycle.ts";
import { createMission, readMission } from "../../src/missions/store.ts";
import { DIRS, type Details, type SingleResult, type SubagentState } from "../../src/shared/types.ts";

const theme = {
	fg(_name: string, text: string): string { return text; },
	bold(text: string): string { return text; },
};

function git(cwd: string, args: string[]): string {
	const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf-8" });
	if (result.status !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || `git ${args.join(" ")} failed`);
	return result.stdout.trim();
}

function createRepo(prefix: string): string {
	const repo = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	git(repo, ["init"]);
	git(repo, ["config", "user.email", "tests@example.com"]);
	git(repo, ["config", "user.name", "Workflow Progress Tests"]);
	fs.writeFileSync(path.join(repo, "tracked.txt"), "initial\n", "utf-8");
	git(repo, ["add", "-A"]);
	git(repo, ["commit", "-m", "initial"]);
	return repo;
}

function componentText(component: unknown): string {
	if (typeof component !== "object" || component === null) return "";
	if ("text" in component && typeof component.text === "string") return component.text;
	if ("children" in component && Array.isArray(component.children)) return component.children.map(componentText).filter(Boolean).join("\n");
	return "";
}

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
		discoverAgents: () => ({ agents: [] as any[] }),
	});
}

function ctx(root: string) {
	return {
		cwd: root,
		hasUI: false,
		sessionManager: { getSessionId() { return "session"; }, getSessionFile() { return null; } },
		modelRegistry: { getAvailable() { return []; } },
		model: { provider: "test", id: "test-model" },
	} as any;
}

describe("workflow chat progress policy", () => {
	it("treats managed worktrees as same repo and sibling repos as other repo", () => {
		const repo = createRepo("pi-workflow-progress-repo-");
		const other = createRepo("pi-workflow-progress-other-");
		const worktree = path.join(os.tmpdir(), `pi-workflow-progress-wt-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		try {
			fs.mkdirSync(path.join(repo, "packages"));
			git(repo, ["worktree", "add", "-b", "chat-progress-test", worktree, "HEAD"]);
			assert.equal(isSameGitRepository(repo, path.join(repo, "packages")), true);
			assert.equal(isSameGitRepository(repo, worktree), true);
			assert.equal(isSameGitRepository(repo, other), false);

			assert.equal(resolveWorkflowChatProgress({ requested: "auto", parentCwd: repo, workflowCwd: worktree, background: false }).projection?.mode, "live-card");
			assert.equal(resolveWorkflowChatProgress({ requested: "auto", parentCwd: repo, workflowCwd: worktree, background: true }).projection?.mode, "off");
			assert.equal(resolveWorkflowChatProgress({ requested: "auto", parentCwd: repo, workflowCwd: other, background: false }).projection?.mode, "off");
			assert.match(resolveWorkflowChatProgress({ requested: "live-card", parentCwd: repo, workflowCwd: other, background: false }).error ?? "", /same Git repository/i);
			assert.match(resolveWorkflowChatProgress({ requested: "terminal", parentCwd: repo, workflowCwd: repo, background: false }).error ?? "", /one of: auto, off, live-card/i);
		} finally {
			try { git(repo, ["worktree", "remove", "--force", worktree]); } catch {}
			fs.rmSync(repo, { recursive: true, force: true });
			fs.rmSync(other, { recursive: true, force: true });
			fs.rmSync(worktree, { recursive: true, force: true });
		}
	});
});

describe("workflow chat progress rendering", () => {
	it("emits live-card updates for same-repo watched workflowScript runs", async () => {
		const repo = createRepo("pi-workflow-progress-executor-");
		try {
			const updates: Array<{ details?: Details }> = [];
			const result = await createExecutor().execute(
				"wf-live",
				{ workflowScript: `return await runs.run("scout", { agent: "missing-agent", task: "scan", phase: "Validation", label: "Find renderer seam" });`, async: false },
				new AbortController().signal,
				(update) => updates.push(update),
				ctx(repo),
			);
			assert.equal(result.isError, true);
			const liveUpdate = updates.find((update) => update.details?.chatProgress?.mode === "live-card");
			assert.ok(liveUpdate, "expected a live-card update");
			assert.equal(liveUpdate.details?.workflow?.trace[0]?.key, "scout");
			assert.equal(liveUpdate.details?.workflow?.trace[0]?.phase, "Validation");
			assert.equal(liveUpdate.details?.workflow?.trace[0]?.label, "Find renderer seam");
			const ledgerChild = result.details.mission?.workflowChildren[0];
			assert.equal(ledgerChild?.key, "scout");
			assert.equal(ledgerChild?.workflowRunId, "wf-live");
			assert.equal(ledgerChild?.agent, "missing-agent");
			assert.equal(ledgerChild?.phase, "Validation");
			assert.equal(ledgerChild?.status, "failed");
			assert.equal(ledgerChild?.heartbeat?.status, "failed");
		} finally {
			fs.rmSync(repo, { recursive: true, force: true });
		}
	});

	it("keeps async workflow launch receipts running in the mission ledger", () => {
		assert.equal(missionWorkflowChildStatus({
			content: [{ type: "text", text: "Async: worker [run-1]" }],
			details: { mode: "single", runId: "run-1", asyncId: "run-1", asyncDir: "/tmp/run-1", results: [] },
		} as any), "running");
	});

	it("writes mission binding before async workflow child launch", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-workflow-child-binding-"));
		const asyncId = `workflow-child-${process.pid}-${Date.now()}`;
		const asyncDir = path.join(DIRS.async, asyncId);
		try {
			const location = {
				projectRoot: root,
				missionDir: path.join(root, ".pi-subagents", "missions"),
				globalIndexDir: path.join(root, ".pi-subagents", "mission-index"),
				writeGlobalIndex: false,
			};
			const mission = createMission(location, { title: "Workflow", objective: "Track child" });
			const params = bindMissionWorkflowChildAsyncLaunch(
				{ agent: "worker", task: "run", async: true },
				{ missionId: mission.id, location, autoCreated: false },
				false,
				asyncId,
			);

			assert.equal(params.workflowChildAsyncId, asyncId);
			assert.equal(readMissionBinding(asyncDir)?.missionId, mission.id);
		} finally {
			fs.rmSync(asyncDir, { recursive: true, force: true });
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("marks workflow launch preparation failures as failed mission children", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-workflow-prep-failure-"));
		try {
			const location = {
				projectRoot: root,
				missionDir: path.join(root, ".pi-subagents", "missions"),
				globalIndexDir: path.join(root, ".pi-subagents", "mission-index"),
				writeGlobalIndex: false,
			};
			const mission = createMission(location, { title: "Workflow", objective: "Track child" });

			await assert.rejects(
				() => runMissionWorkflowChild({ missionId: mission.id, location, autoCreated: false }, "wf-prep-failure", "resume", "Prep", async () => {
					throw new Error("gate is not supported with retained resume");
				}),
				/gate is not supported with retained resume/,
			);
			const ledgerChild = readMission(location, mission.id).workflowChildren[0];

			assert.equal(ledgerChild?.key, "resume");
			assert.equal(ledgerChild?.status, "failed");
			assert.equal(ledgerChild?.heartbeat?.status, "failed");
			assert.equal(ledgerChild?.heartbeat?.phase, "Prep");
			assert.match(ledgerChild?.heartbeat?.message ?? "", /gate is not supported with retained resume/);
			assert.ok(ledgerChild?.completedAt);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("renders stable rows keyed by workflow trace entries", () => {
		const text = componentText(renderSubagentResult({
			content: [{ type: "text", text: "Workflow running." }],
			details: {
				mode: "workflow",
				runId: "wf_8f3a123456",
				results: [],
				chatProgress: { mode: "live-card", repoRelation: "same", repoLabel: "pi-subagents" },
				workflow: {
					trace: [
						{ operation: "run", key: "scout", state: "completed", runId: "run-scout", phase: "Validation", label: "Found renderer seam", durationMs: 12 },
						{ operation: "run", key: "tests", state: "started", phase: "Validation", label: "focused integration suite" },
						{ operation: "run", key: "review", state: "failed", phase: "Validation", label: "fresh-context UX review", error: "needs fixes" },
					],
					emits: [],
					console: [],
				},
			},
		}, { expanded: false }, theme as any));

		assert.match(text, /workflow wf_8f3a12345 .* same repo .* failed/);
		assert.match(text, /Repo   pi-subagents/);
		assert.match(text, /Phase  Validation/);
		assert.match(text, /complete\s+scout Found renderer seam/);
		assert.match(text, /running\s+tests focused integration suite/);
		assert.match(text, /failed\s+review fresh-context UX review .* needs fixes/);
	});

	it("bounds workflow live-card rows and keeps old failed children visible", () => {
		const trace = Array.from({ length: 10 }, (_, index) => ({
			operation: "run" as const,
			key: `step-${index}`,
			state: index === 0 ? "failed" as const : "started" as const,
			label: `review ${index}`,
			...(index === 0 ? { error: "Failed\n\nOutput:\nI will read the required plan first.\nI will inspect the exact head.\nI will read agent default application path." } : {}),
		}));
		const text = componentText(renderSubagentResult({
			content: [{ type: "text", text: "Workflow running." }],
			details: {
				mode: "workflow",
				runId: "wf_noisy",
				results: [],
				chatProgress: { mode: "live-card", repoRelation: "same", repoLabel: "pi-subagents" },
				workflow: { trace, emits: [], console: [] },
			},
		}, { expanded: false }, theme as any));

		assert.match(text, /2 older workflow rows hidden/);
		assert.match(text, /failed\s+step-0 review 0 .* Failed · latest: read agent default application path/);
		assert.match(text, /running\s+step-9 review 9/);
		assert.doesNotMatch(text, /step-1/);
		assert.doesNotMatch(text, /Output:/);
	});

	it("keeps mixed workflow child error output visible", () => {
		const text = componentText(renderSubagentResult({
			content: [{ type: "text", text: "Workflow running." }],
			details: {
				mode: "workflow",
				runId: "wf_mixed_error",
				results: [],
				chatProgress: { mode: "live-card", repoRelation: "same", repoLabel: "pi-subagents" },
				workflow: {
					trace: [{
						operation: "run",
						key: "gate-monitor",
						state: "failed",
						label: "bot gate",
						error: "Failed\n\nOutput:\nerror: failed to fetch review threads\nI will inspect the retry path.",
					}],
					emits: [],
					console: [],
				},
			},
		}, { expanded: false }, theme as any));

		assert.match(text, /Failed · error: failed to fetch review threads I will inspect the retry path/);
		assert.doesNotMatch(text, /latest: inspect the retry path/);
		assert.doesNotMatch(text, /Output:/);
	});

	it("suppresses only successful routine child result intercom for live-card workflows", () => {
		const completed = { agent: "delegate", exitCode: 0, outputState: "present" } as SingleResult;
		const failed = { agent: "delegate", exitCode: 1, outputState: "present" } as SingleResult;
		const rejected = { agent: "delegate", exitCode: 0, acceptance: { status: "rejected" }, outputState: "present" } as SingleResult;

		assert.equal(shouldSuppressRoutineResultIntercom({ suppressRoutineResultIntercom: true, results: [completed] }), true);
		assert.equal(shouldSuppressRoutineResultIntercom({ suppressRoutineResultIntercom: true, results: [failed] }), false);
		assert.equal(shouldSuppressRoutineResultIntercom({ suppressRoutineResultIntercom: true, results: [rejected] }), false);
		assert.equal(shouldSuppressRoutineResultIntercom({ suppressRoutineResultIntercom: false, results: [completed] }), false);
	});

	it("marks acceptance-rejected foreground intercom results as failed", () => {
		const rejected = { agent: "delegate", exitCode: 0, acceptance: { status: "rejected" }, outputState: "present" } as SingleResult;

		assert.equal(foregroundResultIntercomStatus(rejected), "failed");
	});

	it("shows final workflow output after live-card progress completes", () => {
		const text = componentText(renderSubagentResult({
			content: [{ type: "text", text: "Workflow completed.\n\nReturn:\nfinal answer" }],
			details: {
				mode: "workflow",
				runId: "wf_done",
				results: [],
				chatProgress: { mode: "live-card", repoRelation: "same", repoLabel: "pi-subagents" },
				workflow: {
					value: "final answer",
					trace: [{ operation: "run", key: "scout", state: "completed", runId: "run-scout" }],
					emits: [],
					console: [],
				},
			},
		}, { expanded: true }, theme as any));

		assert.match(text, /Workflow completed/);
		assert.match(text, /final answer/);
		assert.doesNotMatch(text, /workflow wf_done/);
	});
});
