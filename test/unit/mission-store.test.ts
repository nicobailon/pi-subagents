import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { handleMissionAction } from "../../src/missions/actions.ts";
import {
	createMission,
	listGlobalMissions,
	listMissions,
	readMission,
	resolveMissionStoreLocation,
	updateMission,
} from "../../src/missions/store.ts";

function fixture() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-missions-"));
	const projectRoot = path.join(root, "project");
	const agentDir = path.join(root, "agent");
	fs.mkdirSync(projectRoot, { recursive: true });
	const location = resolveMissionStoreLocation({ projectRoot, agentDir });
	return { root, projectRoot, agentDir, location };
}

describe("mission store", () => {
	it("creates, reads, updates, lists, and globally indexes project missions", () => {
		const test = fixture();
		try {
			const created = createMission(test.location, {
				title: "Ship durable missions",
				goal: "Make delegated work resumable",
				labels: ["phase-1"],
			});
			const updated = updateMission(test.location, created.id, {
				status: "active",
				summary: "Implementation started",
				addRuns: [
					{ runId: "run-1", mode: "single", status: "running" },
					{ runId: "workflow-1", mode: "workflow", status: "completed" },
				],
				addArtifacts: [{ kind: "status", path: path.join(test.root, "status.json") }],
				addReceipts: [{ kind: "pull_request", status: "ready", title: "PR 733", url: "https://github.com/example/repo/pull/733" }],
				addDecisions: [{ title: "Choose release window", options: ["now", "later"] }],
			});

			assert.equal(readMission(test.location, created.id).status, "active");
			assert.equal(updated.runs[0]?.runId, "run-1");
			assert.equal(readMission(test.location, created.id).runs[1]?.mode, "workflow");
			assert.equal(updated.decisions[0]?.status, "open");
			assert.equal(updated.receipts[0]?.url, "https://github.com/example/repo/pull/733");
			const receiptUpdated = updateMission(test.location, created.id, {
				addReceipts: [{ kind: "pull_request", status: "succeeded", title: "PR 733", url: "https://github.com/example/repo/pull/733" }],
			});
			assert.equal(receiptUpdated.receipts[0]?.status, "succeeded");
			assert.equal(receiptUpdated.receipts[0]?.createdAt, updated.receipts[0]?.createdAt);
			assert.deepEqual(listMissions(test.location).records.map((record) => record.id), [created.id]);
			const global = listGlobalMissions(test.location.globalIndexDir);
			assert.equal(global.entries[0]?.missionId, created.id);
			assert.equal(global.entries[0]?.stale, false);
		} finally {
			fs.rmSync(test.root, { recursive: true, force: true });
		}
	});

	it("loads older records that do not have receipts", () => {
		const test = fixture();
		try {
			const created = createMission(test.location, { title: "Older record", goal: "Stay readable" });
			const recordPath = path.join(test.location.missionDir, `${created.id}.json`);
			const raw = JSON.parse(fs.readFileSync(recordPath, "utf-8")) as Record<string, unknown>;
			delete raw.receipts;
			fs.writeFileSync(recordPath, JSON.stringify(raw), "utf-8");
			assert.deepEqual(readMission(test.location, created.id).receipts, []);
		} finally {
			fs.rmSync(test.root, { recursive: true, force: true });
		}
	});

	it("skips corrupt records, removes missing pointers, and preserves parse-error pointers", () => {
		const test = fixture();
		try {
			const missing = createMission(test.location, { title: "Missing record", goal: "Heal its pointer" });
			const corrupt = createMission(test.location, { title: "Corrupt record", goal: "Keep evidence" });
			fs.writeFileSync(path.join(test.location.missionDir, "broken.json"), "{not json", "utf-8");
			assert.equal(listMissions(test.location).warnings.length, 1);

			fs.rmSync(path.join(test.location.missionDir, `${missing.id}.json`));
			fs.writeFileSync(path.join(test.location.missionDir, `${corrupt.id}.json`), "{not json", "utf-8");
			const global = listGlobalMissions(test.location.globalIndexDir);
			assert.equal(global.entries.length, 1);
			assert.equal(global.entries[0]?.missionId, corrupt.id);
			assert.equal(global.entries[0]?.stale, true);
			assert.match(global.warnings.join("\n"), /Removed stale global mission pointer/);
		} finally {
			fs.rmSync(test.root, { recursive: true, force: true });
		}
	});

	it("prunes only the oldest terminal missions at the configured bound", () => {
		const test = fixture();
		const location = { ...test.location, retainTerminal: 1 };
		try {
			const oldest = createMission(location, { title: "Old terminal", goal: "Prune me" }, new Date("2026-01-01T00:00:00Z"));
			const newest = createMission(location, { title: "New terminal", goal: "Keep me" }, new Date("2026-01-02T00:00:00Z"));
			const active = createMission(location, { title: "Active", goal: "Never prune", status: "active" }, new Date("2026-01-03T00:00:00Z"));
			const planned = createMission(location, { title: "Planned", goal: "Never prune", status: "planned" }, new Date("2026-01-04T00:00:00Z"));
			updateMission(location, oldest.id, { status: "completed" }, new Date("2026-01-05T00:00:00Z"));
			updateMission(location, newest.id, { status: "failed" }, new Date("2026-01-06T00:00:00Z"));

			assert.throws(() => readMission(location, oldest.id), /was not found/);
			assert.equal(readMission(location, newest.id).status, "failed");
			assert.equal(readMission(location, active.id).status, "active");
			assert.equal(readMission(location, planned.id).status, "planned");
			assert.equal(listGlobalMissions(location.globalIndexDir).entries.some((entry) => entry.missionId === oldest.id), false);
		} finally {
			fs.rmSync(test.root, { recursive: true, force: true });
		}
	});

	it("shows missions with warnings when linked run status is unreadable", () => {
		const test = fixture();
		try {
			const ctx = { cwd: test.projectRoot, agentDir: test.agentDir, currentSessionId: "session-1" };
			const created = handleMissionAction("mission.create", { mission: { title: "Unreadable status", goal: "Keep mission readable" } }, ctx);
			const missionId = created.details?.missionId;
			assert.ok(missionId);
			const asyncDir = path.join(test.root, "async-run");
			fs.mkdirSync(asyncDir, { recursive: true });
			handleMissionAction("mission.attach-run", { missionId, runId: "run-3", runMode: "single", runStatus: "running", dir: asyncDir }, ctx);
			fs.writeFileSync(path.join(asyncDir, "status.json"), "{not json", "utf-8");

			const shown = handleMissionAction("mission.show", { missionId }, ctx);

			assert.equal(shown.details?.mission?.runs[0]?.status, "running");
			assert.match(shown.content[0]?.type === "text" ? shown.content[0].text : "", /Warning: Failed to read linked run status/);
			assert.equal(shown.details?.missions?.warnings?.length, 1);
		} finally {
			fs.rmSync(test.root, { recursive: true, force: true });
		}
	});

	it("supports the mission management actions with structured details", () => {
		const test = fixture();
		try {
			const ctx = { cwd: test.projectRoot, agentDir: test.agentDir, currentSessionId: "session-1" };
			const created = handleMissionAction("mission.create", { mission: { title: "Action mission", goal: "Exercise actions" } }, ctx);
			const missionId = created.details?.missionId;
			assert.ok(missionId);
			const asyncDir = path.join(test.root, "async-run");
			fs.mkdirSync(asyncDir, { recursive: true });
			const attached = handleMissionAction("mission.attach-run", { missionId, runId: "run-2", runMode: "parallel", runStatus: "running", dir: asyncDir }, ctx);
			assert.equal(attached.details?.mission?.runs[0]?.runId, "run-2");
			fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({ state: "complete" }), "utf-8");
			const shown = handleMissionAction("mission.show", { missionId }, ctx);
			assert.equal(shown.details?.mission?.status, "completed");
			assert.equal(shown.details?.mission?.runs[0]?.status, "complete");
			const receipt = handleMissionAction("mission.update", {
				missionId,
				missionUpdate: {
					receipts: [{ kind: "ci", status: "succeeded", title: "Unit tests", url: "https://github.com/example/repo/actions/runs/1", description: "All checks passed" }],
				},
			}, ctx);
			assert.equal(receipt.details?.mission?.receipts[0]?.status, "succeeded");
			assert.match(receipt.content[0]?.type === "text" ? receipt.content[0].text : "", /Delivery receipts:\n  ci \(succeeded\): Unit tests/);
			const updatedReceipt = handleMissionAction("mission.update", {
				missionId,
				missionUpdate: { receipts: [{ kind: "ci", status: "ready", title: "Unit tests", url: "https://github.com/example/repo/actions/runs/1" }] },
			}, ctx);
			assert.equal(updatedReceipt.details?.mission?.receipts.length, 1);
			assert.equal(updatedReceipt.details?.mission?.receipts[0]?.status, "ready");
			const closed = handleMissionAction("mission.close", { missionId, missionStatus: "completed", summary: "Done" }, ctx);
			assert.equal(closed.details?.mission?.status, "completed");
			const global = handleMissionAction("mission.list", { missionScope: "global" }, ctx);
			assert.equal(global.details?.missions?.globalEntries?.length, 1);
			assert.throws(() => handleMissionAction("mission.list", { missionScope: "everywhere" as "global" }, ctx), /missionScope/);
			assert.throws(() => handleMissionAction("mission.update", { missionId, missionUpdate: { unsupported: true } as never }, ctx), /unknown/);
			assert.throws(() => handleMissionAction("mission.update", { missionId, missionUpdate: { receipts: [{ kind: "ci", status: "ready", title: "Bad URL", url: "relative" }] } as never }, ctx), /absolute URL/);
		} finally {
			fs.rmSync(test.root, { recursive: true, force: true });
		}
	});
});
