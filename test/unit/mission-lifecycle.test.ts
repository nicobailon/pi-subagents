import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { validateMissionLaunch } from "../../src/missions/actions.ts";
import {
	attachMissionToLaunchResult,
	prepareMissionLaunch,
	readMissionBinding,
	syncMissionFromAsyncCompletion,
} from "../../src/missions/lifecycle.ts";
import { readMission } from "../../src/missions/store.ts";
import { PROMPT_REDACTED } from "../../src/shared/utils.ts";

function projectFixture() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-mission-lifecycle-"));
	const projectRoot = path.join(root, "project");
	fs.mkdirSync(projectRoot, { recursive: true });
	return { root, projectRoot, missionConfig: { directory: ".pi/subagents/missions", globalIndexDir: path.join(root, "global-index") } };
}

describe("mission launch lifecycle", () => {
	it("validates the public mission launch shape", () => {
		assert.deepEqual(validateMissionLaunch({
			summary: "Review the active backlog",
			objective: "Find ready work",
			goal: true,
			budget: { tokens: 400000 },
			labels: ["review"],
		}), {
			title: "Review the active backlog",
			objective: "Find ready work",
			goal: true,
			budget: { tokens: 400000 },
			labels: ["review"],
		});
		assert.throws(() => validateMissionLaunch({}), /title or mission\.summary/);
		assert.throws(() => validateMissionLaunch(true), /mission must be an object/);
		assert.throws(() => validateMissionLaunch(false), /mission must be an object/);
		assert.throws(() => validateMissionLaunch({ title: "Title", summary: "Summary" }), /cannot both be set/);
		assert.throws(() => validateMissionLaunch({ title: " " }), /non-empty string/);
		assert.throws(() => validateMissionLaunch({ title: "Title", goal: false }), /must be true/);
		assert.throws(() => validateMissionLaunch({ title: "Title", goal: true }), /budget is required/);
	});

	it("creates missions by default for task launches and honors explicit opt-out", () => {
		const test = projectFixture();
		try {
			assert.throws(() => prepareMissionLaunch({
				params: { mission: true, task: "Invalid mission" },
				projectRoot: test.projectRoot,
				config: test.missionConfig,
			}), /mission must be an object/);
			assert.deepEqual(fs.readdirSync(test.projectRoot), [], "invalid mission must not create records");
			assert.equal(fs.existsSync(test.missionConfig.globalIndexDir), false);
			const binding = prepareMissionLaunch({
				params: { task: "Map the auth flow" },
				projectRoot: test.projectRoot,
				config: test.missionConfig,
				ownerSessionId: "session-1",
			});
			assert.ok(binding);
			const mission = readMission(binding.location, binding.missionId);
			assert.equal(mission.objective, PROMPT_REDACTED);
			assert.equal(mission.title, PROMPT_REDACTED);
			assert.equal(mission.status, "active");
			const result = attachMissionToLaunchResult({
				binding,
				result: {
					content: [{ type: "text", text: JSON.stringify({ ok: true }) }],
					details: {
						mode: "single",
						runId: "default-mission-run",
						results: [{ index: 0, agent: "worker", task: "Map the auth flow", exitCode: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 } }],
					},
				},
			});
			assert.equal(result.content[0]?.type === "text" ? result.content[0].text : "", JSON.stringify({ ok: true }));

			const disabled = prepareMissionLaunch({
				params: { task: "Tiny one-off" },
				projectRoot: test.projectRoot,
				config: { ...test.missionConfig, enabled: false },
			});
			assert.equal(disabled, undefined);

			const parallelOnly = prepareMissionLaunch({
				params: { chain: [{ parallel: [{ task: "" }, { task: "Review parallel work" }] }] },
				projectRoot: test.projectRoot,
				config: test.missionConfig,
			});
			assert.ok(parallelOnly);
			assert.equal(readMission(parallelOnly.location, parallelOnly.missionId).objective, PROMPT_REDACTED);

			assert.throws(() => prepareMissionLaunch({
				params: { missionId: "" },
				projectRoot: test.projectRoot,
				config: test.missionConfig,
			}), /missionId/);

			const perLaunchDisabled = prepareMissionLaunch({
				params: { mission: false, task: "Ephemeral check" },
				projectRoot: test.projectRoot,
				config: test.missionConfig,
			});
			assert.equal(perLaunchDisabled, undefined);

			assert.throws(() => prepareMissionLaunch({
				params: { missionId: binding.missionId, mission: false, task: "Contradictory mission request" },
				projectRoot: test.projectRoot,
				config: test.missionConfig,
			}), /Use missionId or mission/);

			const explicit = prepareMissionLaunch({
				params: { mission: { title: "Explicit mission" }, task: "Tiny one-off" },
				projectRoot: test.projectRoot,
				config: { ...test.missionConfig, enabled: false },
			});
			assert.ok(explicit);
			assert.equal(readMission(explicit.location, explicit.missionId).objective, "Explicit mission");

			const summaryAlias = prepareMissionLaunch({
				params: { mission: { summary: "Review active backlog", labels: ["review"] }, task: "Review the current diff" },
				projectRoot: test.projectRoot,
				config: test.missionConfig,
			});
			assert.ok(summaryAlias);
			assert.deepEqual(readMission(summaryAlias.location, summaryAlias.missionId).labels, ["review"]);
			assert.equal(readMission(summaryAlias.location, summaryAlias.missionId).title, "Review active backlog");
			assert.equal(readMission(summaryAlias.location, summaryAlias.missionId).objective, "Review active backlog");
		} finally {
			fs.rmSync(test.root, { recursive: true, force: true });
		}
	});

	it("explains when an explicit mission belongs to another worktree", () => {
		const test = projectFixture();
		const worktreeRoot = path.join(test.root, "worktree");
		fs.mkdirSync(worktreeRoot, { recursive: true });
		try {
			const binding = prepareMissionLaunch({
				params: { mission: { title: "Root mission" }, task: "Prepare root work" },
				projectRoot: test.projectRoot,
				config: test.missionConfig,
			});
			assert.ok(binding);
			const missionDir = path.join(worktreeRoot, ".pi", "subagents", "missions");
			assert.throws(() => prepareMissionLaunch({
				params: { missionId: binding.missionId, task: "Prepare worktree work" },
				projectRoot: worktreeRoot,
				config: test.missionConfig,
			}), {
				message: `Mission '${binding.missionId}' was not found in mission directory '${missionDir}' for project root '${worktreeRoot}'. If it was created in another worktree, run the request from that worktree.`,
			});
		} finally {
			fs.rmSync(test.root, { recursive: true, force: true });
		}
	});

	it("creates a mission shortcut and records a completed foreground run", () => {
		const test = projectFixture();
		try {
			const binding = prepareMissionLaunch({
				params: { mission: { title: "Implement feature", objective: "Ship it", labels: ["phase-1"] }, task: "Do the work" },
				projectRoot: test.projectRoot,
				config: test.missionConfig,
				ownerSessionId: "session-1",
			});
			assert.ok(binding);
			const result = attachMissionToLaunchResult({
				binding,
				result: {
					content: [{ type: "text", text: "Implemented and tested." }],
					details: {
						mode: "single",
						runId: "foreground-1",
						results: [{ index: 0, agent: "worker", task: "Do the work", exitCode: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 } }],
					},
				},
			});
			assert.equal(result.details?.missionId, binding.missionId);
			assert.match(result.content[0]?.type === "text" ? result.content[0].text : "", new RegExp(`Implemented and tested\\.\\nMission: ${binding.missionId} \\(completed\\)$`));
			const mission = readMission(binding.location, binding.missionId);
			assert.equal(mission.status, "completed");
			assert.equal(mission.runs[0]?.runId, "foreground-1");
			assert.equal(mission.runs[0]?.status, "completed");
		} finally {
			fs.rmSync(test.root, { recursive: true, force: true });
		}
	});

	it("marks a prepared mission failed when launch reservation returns an error before a run id exists", () => {
		const test = projectFixture();
		try {
			const binding = prepareMissionLaunch({
				params: { mission: { title: "Budget race" }, task: "Run after preflight" },
				projectRoot: test.projectRoot,
				config: test.missionConfig,
			});
			assert.ok(binding);
			const result = attachMissionToLaunchResult({
				binding,
				result: {
					content: [{ type: "text", text: "Spawn budget exhausted after preflight." }],
					isError: true,
					details: { mode: "single", results: [] },
				},
			});
			assert.equal(result.details?.missionId, binding.missionId);
			assert.equal(readMission(binding.location, binding.missionId).status, "failed");
		} finally {
			fs.rmSync(test.root, { recursive: true, force: true });
		}
	});

	it("records a bounded warning when an async mission record disappeared before completion", () => {
		const test = projectFixture();
		try {
			const asyncDir = path.join(test.root, "async-run-missing-mission");
			fs.mkdirSync(asyncDir, { recursive: true });
			const binding = prepareMissionLaunch({
				params: { mission: { title: "Disposable mission record" }, task: "Run later" },
				projectRoot: test.projectRoot,
				config: test.missionConfig,
			});
			assert.ok(binding);
			attachMissionToLaunchResult({
				binding,
				result: {
					content: [{ type: "text", text: "Async started" }],
					details: { mode: "single", runId: "async-missing-mission", asyncId: "async-missing-mission", asyncDir, results: [] },
				},
			});
			fs.rmSync(binding.location.missionDir, { recursive: true, force: true });

			const completed = syncMissionFromAsyncCompletion({
				runId: "async-missing-mission",
				asyncDir,
				mode: "single",
				state: "complete",
				success: true,
			});
			const repeated = syncMissionFromAsyncCompletion({
				runId: "async-missing-mission",
				asyncDir,
				mode: "single",
				state: "complete",
				success: true,
			});

			assert.equal(completed, undefined);
			assert.equal(repeated, undefined);
			const events = fs.readFileSync(path.join(asyncDir, "events.jsonl"), "utf-8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
			assert.deepEqual(events, [{
				type: "subagent.mission.sync.skipped",
				ts: events[0]?.ts,
				runId: "async-missing-mission",
				missionId: binding.missionId,
				reason: "mission-record-missing",
				missionPath: path.join(binding.location.missionDir, `${binding.missionId}.json`),
			}]);
			assert.equal(typeof events[0]?.ts, "number");
			assert.equal(fs.readdirSync(asyncDir).filter((name) => name.startsWith(".mission-sync-skipped-")).length, 1);
		} finally {
			fs.rmSync(test.root, { recursive: true, force: true });
		}
	});

	it("binds an async workflow launch and preserves its mode through completion", () => {
		const test = projectFixture();
		try {
			const asyncDir = path.join(test.root, "async-run");
			fs.mkdirSync(asyncDir, { recursive: true });
			const binding = prepareMissionLaunch({
				params: { mission: { title: "Background mission" }, task: "Run later" },
				projectRoot: test.projectRoot,
				config: test.missionConfig,
			});
			assert.ok(binding);
			attachMissionToLaunchResult({
				binding,
				result: {
					content: [{ type: "text", text: "Async started" }],
					details: { mode: "workflow", runId: "async-1", asyncId: "async-1", asyncDir, results: [] },
				},
			});
			assert.equal(readMissionBinding(asyncDir)?.missionId, binding.missionId);
			assert.equal(readMission(binding.location, binding.missionId).status, "active");

			const completed = syncMissionFromAsyncCompletion({
				id: "async-1",
				runId: "async-1",
				asyncDir,
				mode: "workflow",
				state: "complete",
				success: true,
				summary: "Background work completed",
				results: [{ artifactPath: path.join(asyncDir, "output-0.log") }],
			});
			assert.equal(completed?.status, "completed");
			assert.equal(completed?.runs[0]?.status, "complete");
			assert.equal(completed?.runs[0]?.mode, "workflow");
			assert.ok(completed?.artifacts.some((artifact) => artifact.kind === "output"));
		} finally {
			fs.rmSync(test.root, { recursive: true, force: true });
		}
	});
});
