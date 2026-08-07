import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { handleMissionAction } from "../../src/missions/actions.ts";
import { collectGoalContinuationNotices } from "../../src/missions/goal-driver.ts";
import { createMission, readMission, resolveMissionStoreLocation, updateMission } from "../../src/missions/store.ts";
import { missionStatePath } from "../../src/missions/workflow-state.ts";

function fixture() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-goal-mission-"));
	const projectRoot = path.join(root, "project");
	fs.mkdirSync(projectRoot, { recursive: true });
	const location = resolveMissionStoreLocation({ projectRoot, agentDir: path.join(root, "agent") });
	return { root, projectRoot, location };
}

describe("goal mission continuation", () => {
	it("nudges from persisted state only while linked runs are idle and accounts their tokens", () => {
		const test = fixture();
		try {
			const mission = createMission(test.location, {
				title: "Ship auth refresh",
				objective: "Implement and validate token refresh",
				goal: true,
				budget: { tokens: 100 },
				status: "active",
				ownerSessionId: "session-1",
			});
			fs.mkdirSync(path.dirname(missionStatePath(test.location, mission.id)), { recursive: true });
			fs.writeFileSync(missionStatePath(test.location, mission.id), JSON.stringify({ lanes: { review: { status: "ready", action: "Review the token refresh diff" } } }));

			const first = collectGoalContinuationNotices({ location: test.location, ownerSessionId: "session-1", retainedChildren: [], turnId: 1 });
			assert.equal(first.length, 1);
			assert.match(first[0]!.message, /Remaining budget: 100 tokens/);
			assert.match(first[0]!.message, /Next ready action: Review the token refresh diff/);

			const asyncDir = path.join(test.root, "run-1");
			fs.mkdirSync(asyncDir);
			fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({ state: "running", totalTokens: { input: 10, output: 5, total: 15 } }));
			updateMission(test.location, mission.id, { addRuns: [{ runId: "workflow-1", mode: "workflow", asyncDir, status: "running" }] });
			assert.deepEqual(collectGoalContinuationNotices({ location: test.location, ownerSessionId: "session-1", retainedChildren: [], turnId: 2 }), []);

			fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({ state: "complete", totalTokens: { input: 25, output: 15, total: 40 } }));
			const resumed = collectGoalContinuationNotices({
				location: test.location,
				ownerSessionId: "session-1",
				retainedChildren: [{ runId: "child-review", parentRunId: "workflow-1", agent: "reviewer", taskSummary: "Review", completedAt: 1, sessionPath: "/tmp/child.jsonl" }],
				turnId: 3,
			});
			assert.equal(resumed.length, 1);
			assert.match(resumed[0]!.message, /Remaining budget: 60 tokens/);
			assert.match(resumed[0]!.message, /Resume retained child child-review \(reviewer\)/);
			assert.equal(readMission(test.location, mission.id).usage?.tokens, 40);

			fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({ state: "complete", totalTokens: { input: 60, output: 40, total: 100 } }));
			assert.deepEqual(collectGoalContinuationNotices({ location: test.location, ownerSessionId: "session-1", retainedChildren: [], turnId: 4 }), []);
			assert.equal(readMission(test.location, mission.id).goal?.status, "budget-exhausted");
			assert.equal(readMission(test.location, mission.id).status, "active");
		} finally {
			fs.rmSync(test.root, { recursive: true, force: true });
		}
	});

	it("resumes retained children from the latest linked run", () => {
		const test = fixture();
		try {
			const mission = createMission(test.location, {
				title: "Ship auth refresh",
				objective: "Implement and validate token refresh",
				goal: true,
				budget: { tokens: 100 },
				status: "active",
				ownerSessionId: "session-1",
			});
			updateMission(test.location, mission.id, {
				addRuns: [
					{ runId: "workflow-old", mode: "workflow", status: "complete" },
					{ runId: "workflow-new", mode: "workflow", status: "complete" },
				],
			});

			const notices = collectGoalContinuationNotices({
				location: test.location,
				ownerSessionId: "session-1",
				retainedChildren: [
					{ runId: "child-old", parentRunId: "workflow-old", agent: "reviewer", taskSummary: "Old", completedAt: 2, sessionPath: "/tmp/old.jsonl" },
					{ runId: "child-new", parentRunId: "workflow-new", agent: "reviewer", taskSummary: "New", completedAt: 1, sessionPath: "/tmp/new.jsonl" },
				],
				turnId: 1,
			});

			assert.equal(notices.length, 1);
			assert.match(notices[0]!.message, /Resume retained child child-new \(reviewer\)/);
			assert.doesNotMatch(notices[0]!.message, /child-old/);
		} finally {
			fs.rmSync(test.root, { recursive: true, force: true });
		}
	});

	it("supports pause, resume, and opt-out through mission.update", () => {
		const test = fixture();
		try {
			const ctx = { cwd: test.projectRoot, agentDir: path.join(test.root, "agent"), currentSessionId: "session-1" };
			const created = handleMissionAction("mission.create", { mission: { title: "Goal controls", objective: "Exercise controls", goal: true, budget: { tokens: 50 } } }, ctx);
			const missionId = created.details!.missionId!;
			assert.equal(handleMissionAction("mission.update", { missionId, missionUpdate: { goal: { paused: true } } }, ctx).details?.mission?.goal?.status, "paused");
			assert.deepEqual(collectGoalContinuationNotices({ location: test.location, ownerSessionId: "session-1", retainedChildren: [], turnId: 1 }), []);
			assert.equal(handleMissionAction("mission.update", { missionId, missionUpdate: { goal: { paused: false } } }, ctx).details?.mission?.goal?.status, "active");
			assert.equal(handleMissionAction("mission.update", { missionId, missionUpdate: { goal: false } }, ctx).details?.mission?.goal, undefined);
		} finally {
			fs.rmSync(test.root, { recursive: true, force: true });
		}
	});
});
