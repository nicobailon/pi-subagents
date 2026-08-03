import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
	attachMissionToLaunchResult,
	prepareMissionLaunch,
	readMissionBinding,
	syncMissionFromAsyncCompletion,
} from "../../src/missions/lifecycle.ts";
import { readMission } from "../../src/missions/store.ts";

function projectFixture() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-mission-lifecycle-"));
	const projectRoot = path.join(root, "project");
	fs.mkdirSync(projectRoot, { recursive: true });
	return { root, projectRoot, missionConfig: { globalIndexDir: path.join(root, "global-index") } };
}

describe("mission launch lifecycle", () => {
	it("creates missions by default for task launches and honors explicit opt-out", () => {
		const test = projectFixture();
		try {
			const binding = prepareMissionLaunch({
				params: { task: "Map the auth flow" },
				projectRoot: test.projectRoot,
				config: test.missionConfig,
				ownerSessionId: "session-1",
			});
			assert.ok(binding);
			const mission = readMission(binding.location, binding.missionId);
			assert.equal(mission.goal, "Map the auth flow");
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
		} finally {
			fs.rmSync(test.root, { recursive: true, force: true });
		}
	});

	it("creates a mission shortcut and records a completed foreground run", () => {
		const test = projectFixture();
		try {
			const binding = prepareMissionLaunch({
				params: { mission: { title: "Implement feature", goal: "Ship it", labels: ["phase-1"] }, task: "Do the work" },
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

	it("binds an async launch and reconciles terminal status and artifacts", () => {
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
					details: { mode: "chain", runId: "async-1", asyncId: "async-1", asyncDir, results: [] },
				},
			});
			assert.equal(readMissionBinding(asyncDir)?.missionId, binding.missionId);
			assert.equal(readMission(binding.location, binding.missionId).status, "active");

			const completed = syncMissionFromAsyncCompletion({
				id: "async-1",
				runId: "async-1",
				asyncDir,
				mode: "chain",
				state: "complete",
				success: true,
				summary: "Background work completed",
				results: [{ artifactPath: path.join(asyncDir, "output-0.log") }],
			});
			assert.equal(completed?.status, "completed");
			assert.equal(completed?.runs[0]?.status, "complete");
			assert.ok(completed?.artifacts.some((artifact) => artifact.kind === "output"));
		} finally {
			fs.rmSync(test.root, { recursive: true, force: true });
		}
	});
});
