import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { buildWorkflowChatProgressRows, isSameGitRepository, resolveWorkflowChatProgress } from "../../src/workflows/chat-progress.ts";
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
			assert.match(resolveWorkflowChatProgress({ requested: "live-card", parentCwd: repo, workflowCwd: repo, background: true }).error ?? "", /omit chatProgress or use auto\/off.*async:false only when the parent must block/i);
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
				missionDir: path.join(root, ".pi/subagents", "missions"),
				globalIndexDir: path.join(root, ".pi/subagents", "mission-index"),
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
				missionDir: path.join(root, ".pi/subagents", "missions"),
				globalIndexDir: path.join(root, ".pi/subagents", "mission-index"),
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

	it("warns once when a workflow child outlives its mission record", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-workflow-missing-mission-"));
		const originalWarn = console.warn;
		const warnings: string[] = [];
		try {
			const location = {
				projectRoot: root,
				missionDir: path.join(root, ".pi/subagents", "missions"),
				globalIndexDir: path.join(root, ".pi/subagents", "mission-index"),
				writeGlobalIndex: false,
			};
			const mission = createMission(location, { title: "Workflow", objective: "Track child" });
			fs.rmSync(path.join(location.missionDir, `${mission.id}.json`));
			console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(" "));

			for (const key of ["first", "second"]) {
				await assert.rejects(
					() => runMissionWorkflowChild({ missionId: mission.id, location, autoCreated: false }, "wf-missing-mission", key, "Prep", async () => {
						throw new Error("child failed");
					}),
					/child failed/,
				);
			}

			assert.equal(warnings.length, 1);
			assert.match(warnings[0] ?? "", new RegExp(`Mission '${mission.id}' is no longer in the mission store`));
		} finally {
			console.warn = originalWarn;
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
						{ operation: "run", key: "stale", state: "stopped", phase: "Validation", label: "superseded exact-head review", error: "Workflow stopped by user." },
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
		assert.match(text, /stopped\s+stale superseded exact-head review .* Workflow stopped by user/);
	});

	it("renders detached workflow trace rows as paused attention", () => {
		const trace: NonNullable<Details["workflow"]>["trace"] = [{
			operation: "run",
			key: "detaches",
			state: "detached",
			phase: "Decision",
			label: "supervisor handoff",
			runId: "child-detached-123456",
			error: "Detached for intercom coordination. Reply to the supervisor request first.",
		}];
		const rows = buildWorkflowChatProgressRows(trace);
		assert.equal(rows[0]?.state, "detached");

		const text = componentText(renderSubagentResult({
			content: [{ type: "text", text: "Workflow failed: Run 'detaches' detached for intercom coordination." }],
			isError: true,
			details: {
				mode: "workflow",
				runId: "wf_detached_123456",
				results: [],
				chatProgress: { mode: "live-card", repoRelation: "same", repoLabel: "pi-subagents" },
				workflow: { trace, emits: [], console: [] },
			},
		}, { expanded: false }, theme as any));

		assert.match(text, /workflow wf_detached_ .* same repo .* paused/);
		assert.match(text, /Phase  Decision/);
		assert.match(text, /detached\s+detaches supervisor handoff \[child-de\] .* Detached for intercom coordination/);
		assert.doesNotMatch(text, /running\s+detaches/);
		assert.doesNotMatch(text, /failed\s+detaches/);
	});

	it("seeds declared preflight lanes as planned before workflow trace entries", () => {
		const preflight = {
			version: 1 as const,
			coverage: "partial" as const,
			lanes: [
				{ key: "writer", mode: "mutation" as const, claims: ["src/workflows"] },
				{ key: "review", mode: "review" as const, expectedOutput: "review.md" },
			],
		};
		assert.deepEqual(buildWorkflowChatProgressRows([], preflight).map((row) => ({ key: row.key, state: row.state })), [
			{ key: "writer", state: "planned" },
			{ key: "review", state: "planned" },
		]);
		const text = componentText(renderSubagentResult({
			content: [{ type: "text", text: "Workflow running." }],
			details: {
				mode: "workflow",
				runId: "wf_planned",
				results: [],
				preflight,
				chatProgress: { mode: "live-card", repoRelation: "same", repoLabel: "pi-subagents" },
				workflow: { trace: [], emits: [], console: [] },
			},
		}, { expanded: false }, theme as any));
		assert.match(text, /planned\s+writer/);
		assert.match(text, /planned\s+review/);
		assert.doesNotMatch(text, /mode:mutation/);
		assert.doesNotMatch(text, /expected:review\.md/);
		assert.doesNotMatch(text, /waiting for workflow child launches/);

		const expanded = componentText(renderSubagentResult({
			content: [{ type: "text", text: "Workflow running." }],
			details: {
				mode: "workflow",
				runId: "wf_planned",
				results: [],
				preflight,
				chatProgress: { mode: "live-card", repoRelation: "same", repoLabel: "pi-subagents" },
				workflow: { trace: [], emits: [], console: [] },
			},
		}, { expanded: true }, theme as any));
		assert.match(expanded, /mode:mutation/);
		assert.match(expanded, /expected:review\.md/);
	});

	it("uses the compact plan preview for collapsed workflow launch output", () => {
		const preflight = {
			version: 1 as const,
			coverage: "complete" as const,
			lanes: [{ key: "writer", mode: "mutation" as const, decision: "Implement the change" }],
		};
		const output = "Preflight: v1 · complete · 1 lane\n  key | mode | decision | claims | expected output | independence\n  writer | mutation | Implement the change | — | — | —\n\nAsync workflow [wf_launch] started.";
		const result = {
			content: [{ type: "text" as const, text: output }],
			details: { mode: "workflow" as const, runId: "wf_launch", results: [], preflight },
		};
		const compact = componentText(renderSubagentResult(result, { expanded: false }, theme as any));
		assert.match(compact, /Plan: 1 lane · Implement the change/);
		assert.doesNotMatch(compact, /Preflight: v1/);
		assert.doesNotMatch(compact, /key \| mode \| decision/);

		const expanded = componentText(renderSubagentResult(result, { expanded: true }, theme as any));
		assert.match(expanded, /Preflight: v1 · complete · 1 lane/);
		assert.match(expanded, /key \| mode \| decision/);
	});

	it("keeps each expanded preflight warning visible as a bounded row", () => {
		const result = {
			content: [{ type: "text" as const, text: "Workflow running." }],
			details: {
				mode: "workflow" as const,
				runId: "wf_warning_rows",
				results: [],
				preflight: { version: 1 as const, coverage: "complete" as const, lanes: [{ key: "writer", mode: "mutation" as const }] },
				chatProgress: { mode: "live-card" as const, repoRelation: "same" as const, repoLabel: "pi-subagents" },
				workflow: {
					trace: [{ operation: "run" as const, key: "writer", state: "started" as const }],
					emits: [],
					console: [],
					preflightWarnings: [
						`Preflight advisory: first warning ${"x".repeat(120)}`,
						`Preflight advisory: second warning ${"y".repeat(120)}`,
					],
				},
			},
		};
		const originalColumns = Object.getOwnPropertyDescriptor(process.stdout, "columns");
		Object.defineProperty(process.stdout, "columns", { configurable: true, value: 56 });
		try {
			const expanded = renderSubagentResult(result, { expanded: true }, theme as any).render(56);
			assert.ok(expanded.some((line) => line.includes("Preflight warnings:")));
			const warningRows = expanded.filter((line) => line.includes("- Preflight advisory"));
			assert.equal(warningRows.length, 2);
			assert.match(warningRows[0]!, /first warning/);
			assert.match(warningRows[1]!, /second warning/);
			assert.ok(warningRows.every((line) => line.trimEnd().length <= 52));

			const compact = renderSubagentResult(result, { expanded: false }, theme as any).render(56);
			assert.equal(compact.filter((line) => line.includes("Plan note:")).length, 1);
			assert.doesNotMatch(compact.join("\n"), /first warning|second warning/);
		} finally {
			if (originalColumns) Object.defineProperty(process.stdout, "columns", originalColumns);
			else delete (process.stdout as { columns?: number }).columns;
		}
	});

	it("keeps mixed detached and failed workflow traces failed", () => {
		const text = componentText(renderSubagentResult({
			content: [{ type: "text", text: "Workflow failed: child failed after a detached sibling." }],
			isError: true,
			details: {
				mode: "workflow",
				runId: "wf_mixed_failure",
				results: [],
				chatProgress: { mode: "live-card", repoRelation: "same", repoLabel: "pi-subagents" },
				workflow: {
					trace: [
						{ operation: "run", key: "handoff", state: "detached", runId: "child-detached", error: "Detached for supervisor handoff." },
						{ operation: "run", key: "tests", state: "failed", runId: "child-failed", error: "unit test failed" },
					],
					emits: [],
					console: [],
				},
			},
		}, { expanded: false }, theme as any));

		assert.match(text, /workflow wf_mixed_fai .* same repo .* failed/);
		assert.match(text, /detached\s+handoff .* Detached for supervisor handoff/);
		assert.match(text, /failed\s+tests .* unit test failed/);
	});

	it("applies main-window density settings to collapsed workflow live cards", () => {
		const trace = Array.from({ length: 10 }, (_, index) => ({
			operation: "run" as const,
			key: `step-${index}`,
			state: "started" as const,
			label: `review ${index}`,
			phase: `phase-${index}`,
		}));
		const result = {
			content: [{ type: "text" as const, text: "Workflow running." }],
			details: {
				mode: "workflow" as const,
				runId: "wf_density",
				results: [],
				chatProgress: { mode: "live-card" as const, repoRelation: "same" as const, repoLabel: "pi-subagents" },
				workflow: { trace, emits: [], console: [] },
			},
		};

		const compact = renderSubagentResult(result, { expanded: false }, theme as any, undefined, { horizontalSpacing: 0, compactResultMaxLines: 3 }).render(120);
		assert.equal(compact.length, 3);
		assert.match(compact[1]!, /^Repo   pi-subagents\s*$/);
		assert.match(compact[2]!, /rows hidden/);

		const expanded = renderSubagentResult(result, { expanded: true }, theme as any, undefined, { horizontalSpacing: 0, compactResultMaxLines: 3 }).render(120);
		assert.ok(expanded.length > 3);
		assert.match(expanded[1]!, /^  Repo   pi-subagents\s*$/);
		assert.match(expanded.join("\n"), /phase-9 1 active/);
		assert.doesNotMatch(expanded.join("\n"), /rows hidden · .* expands/);
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
