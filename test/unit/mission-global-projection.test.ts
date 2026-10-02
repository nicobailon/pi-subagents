import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { createMission, listGlobalMissions, readMission, resolveMissionStoreLocation, updateMission } from "../../src/missions/store.ts";

function fixture() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-mission-projection-"));
	const projectRoot = path.join(root, "project");
	const agentDir = path.join(root, "agent");
	fs.mkdirSync(projectRoot, { recursive: true });
	const location = resolveMissionStoreLocation({
		projectRoot,
		agentDir,
		config: { directory: path.join(root, "missions"), globalIndexDir: path.join(root, "global-index") },
	});
	return { root, location };
}

function indexPathFor(globalIndexDir: string, missionId: string): string {
	const filePath = fs.readdirSync(globalIndexDir)
		.filter((name) => name.endsWith(".json"))
		.map((name) => path.join(globalIndexDir, name))
		.find((candidate) => JSON.parse(fs.readFileSync(candidate, "utf-8")).missionId === missionId);
	assert.ok(filePath, `missing index pointer for ${missionId}`);
	return filePath;
}

describe("mission global projection", () => {
	it("uses the updated record after the index rename fails, without rewriting the pointer", { timeout: 15_000 }, () => {
		const harness = String.raw`
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";

const [storeUrl] = process.argv.slice(1);
const store = await import(storeUrl);
const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mission-global-projection-repro-"));
const projectRoot = path.join(root, "project");
const location = store.resolveMissionStoreLocation({
	projectRoot,
	agentDir: path.join(root, "agent"),
	config: { directory: path.join(root, "missions"), globalIndexDir: path.join(root, "global-index") },
});
const pointerPathFor = (missionId) => fs.readdirSync(location.globalIndexDir)
	.map((name) => path.join(location.globalIndexDir, name))
	.find((file) => JSON.parse(fs.readFileSync(file, "utf-8")).missionId === missionId);
const fields = (entry) => entry ? {
	title: entry.title,
	status: entry.status,
	updatedAt: entry.updatedAt,
	lastRunId: entry.lastRunId ?? entry.runs?.at(-1)?.runId,
	stale: entry.stale,
} : null;

try {
	fs.mkdirSync(projectRoot, { recursive: true });
	const original = store.createMission(location, {
		title: "Before partial commit",
		objective: "Use authoritative record fields",
		status: "planned",
	}, new Date("2026-01-01T00:00:00.000Z"));
	store.updateMission(location, original.id, {
		addRuns: [{ runId: "run-old", mode: "single", status: "running" }],
	}, new Date("2026-01-01T01:00:00.000Z"));
	const control = store.createMission(location, {
		title: "Healthy before",
		objective: "Check normal writes",
		status: "planned",
	}, new Date("2026-01-02T00:00:00.000Z"));
	const recordPath = store.missionRecordPath(location, original.id);
	const indexPath = pointerPathFor(original.id);
	const oldPointer = JSON.parse(fs.readFileSync(indexPath, "utf-8"));
	const originalRenameSync = fs.renameSync;
	let recordRenameCompleted = false;
	let indexRenameAttempted = false;
	let injectedIndexRenameFailure = false;
	fs.renameSync = function (source, destination, ...args) {
		const destinationPath = path.resolve(String(destination));
		if (destinationPath === path.resolve(recordPath)) {
			const result = originalRenameSync.call(this, source, destination, ...args);
			recordRenameCompleted = true;
			return result;
		}
		if (!indexRenameAttempted && path.dirname(destinationPath) === path.resolve(location.globalIndexDir)) {
			indexRenameAttempted = true;
			injectedIndexRenameFailure = true;
			const error = new Error("Injected EIO at global mission index rename boundary");
			Object.assign(error, { code: "EIO" });
			throw error;
		}
		return originalRenameSync.call(this, source, destination, ...args);
	};
	syncBuiltinESMExports();
	let updateError = null;
	try {
		store.updateMission(location, original.id, {
			title: "After partial commit",
			status: "completed",
			addRuns: [{ runId: "run-new", mode: "single", status: "completed" }],
		}, new Date("2026-01-03T00:00:00.000Z"));
	} catch (error) {
		updateError = { code: error?.code ?? null, message: String(error?.message ?? error) };
	} finally {
		fs.renameSync = originalRenameSync;
		syncBuiltinESMExports();
	}
	const recordAfterFailure = store.readMission(location, original.id);
	const firstList = store.listGlobalMissions(location.globalIndexDir);
	const immediateProjection = firstList.entries.find((entry) => entry.missionId === original.id);
	const pointerAfterFailure = JSON.parse(fs.readFileSync(indexPath, "utf-8"));
	const healthyRecord = store.updateMission(location, control.id, {
		title: "Healthy after",
		status: "active",
	}, new Date("2026-01-02T12:00:00.000Z"));
	const healthyProjection = store.listGlobalMissions(location.globalIndexDir).entries.find((entry) => entry.missionId === control.id);
	const laterList = store.listGlobalMissions(location.globalIndexDir);
	process.stdout.write(JSON.stringify({
		updateError,
		renameBoundary: { recordRenameCompleted, indexRenameAttempted, injectedIndexRenameFailure },
		record: fields(recordAfterFailure),
		oldPointer,
		pointerAfterFailure,
		immediateProjection: fields(immediateProjection),
		laterProjection: fields(laterList.entries.find((entry) => entry.missionId === original.id)),
		order: laterList.entries.map((entry) => entry.missionId),
		expectedOrder: [original.id, control.id],
		healthyControlMatchesRecord: Boolean(healthyProjection)
			&& healthyProjection.title === healthyRecord.title
			&& healthyProjection.status === healthyRecord.status
			&& healthyProjection.updatedAt === healthyRecord.updatedAt,
	}));
} finally {
	fs.rmSync(root, { recursive: true, force: true });
}
`;
		const storeUrl = pathToFileURL(path.resolve("src/missions/store.ts")).href;
		const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "--eval", harness, storeUrl], {
			cwd: process.cwd(),
			encoding: "utf-8",
			timeout: 10_000,
		});
		const observed = child.stdout?.trim() ? JSON.parse(child.stdout.trim()) as Record<string, any> : null;
		assert.equal(child.status, 0, child.stderr || child.error?.message || "isolated mission projection harness produced no output");
		assert.ok(observed, child.stderr || "isolated mission projection harness produced no JSON");
		assert.equal(observed.updateError?.code, "EIO");
		assert.deepEqual(observed.renameBoundary, { recordRenameCompleted: true, indexRenameAttempted: true, injectedIndexRenameFailure: true });
		assert.deepEqual(observed.record, { title: "After partial commit", status: "completed", updatedAt: "2026-01-03T00:00:00.000Z", lastRunId: "run-new" });
		assert.equal(observed.oldPointer.title, "Before partial commit");
		assert.equal(observed.oldPointer.lastRunId, "run-old");
		assert.deepEqual(observed.pointerAfterFailure, observed.oldPointer, "the list read must not rewrite the persisted pointer");
		assert.deepEqual(observed.immediateProjection, { title: "After partial commit", status: "completed", updatedAt: "2026-01-03T00:00:00.000Z", lastRunId: "run-new", stale: false });
		assert.deepEqual(observed.laterProjection, observed.immediateProjection);
		assert.deepEqual(observed.order, observed.expectedOrder, "global list sorting uses the authoritative updatedAt");
		assert.equal(observed.healthyControlMatchesRecord, true);
	});

	it("uses record timestamps for sorting and removes an index lastRunId when runs are empty", () => {
		const test = fixture();
		try {
			const first = createMission(test.location, { title: "First pointer", objective: "Current record should sort first" }, new Date("2026-01-01T00:00:00.000Z"));
			updateMission(test.location, first.id, { addRuns: [{ runId: "run-stale", mode: "single", status: "running" }] }, new Date("2026-01-01T01:00:00.000Z"));
			const second = createMission(test.location, { title: "Second pointer", objective: "Current record should sort second" }, new Date("2026-01-02T00:00:00.000Z"));
			const firstRecordPath = path.join(test.location.missionDir, `${first.id}.json`);
			const secondRecordPath = path.join(test.location.missionDir, `${second.id}.json`);
			const indexedFirst = listGlobalMissions(test.location.globalIndexDir).entries.find((entry) => entry.missionId === first.id);
			assert.equal(indexedFirst?.lastRunId, "run-stale");

			const firstRecord = readMission(test.location, first.id);
			firstRecord.title = "First record is newest";
			firstRecord.status = "completed";
			firstRecord.updatedAt = "2026-01-04T00:00:00.000Z";
			firstRecord.runs = [];
			fs.writeFileSync(firstRecordPath, JSON.stringify(firstRecord, null, 2), "utf-8");
			const secondRecord = readMission(test.location, second.id);
			secondRecord.title = "Second record is older";
			secondRecord.updatedAt = "2026-01-03T00:00:00.000Z";
			fs.writeFileSync(secondRecordPath, JSON.stringify(secondRecord, null, 2), "utf-8");

			const global = listGlobalMissions(test.location.globalIndexDir);
			assert.deepEqual(global.entries.map((entry) => entry.missionId), [first.id, second.id]);
			assert.equal(global.entries[0]?.title, "First record is newest");
			assert.equal(global.entries[0]?.updatedAt, "2026-01-04T00:00:00.000Z");
			assert.equal(Object.hasOwn(global.entries[0] ?? {}, "lastRunId"), false, "a stale pointer run id must not survive when the current record has no runs");
		} finally {
			fs.rmSync(test.root, { recursive: true, force: true });
		}
	});

	it("keeps mismatched and unreadable pointers on their existing paths", () => {
		const test = fixture();
		try {
			const mismatch = createMission(test.location, { title: "Mismatched record", objective: "Keep its pointer stale" });
			const mismatchPointerPath = indexPathFor(test.location.globalIndexDir, mismatch.id);
			const mismatchPointer = JSON.parse(fs.readFileSync(mismatchPointerPath, "utf-8")) as Record<string, unknown>;
			mismatchPointer.missionId = "wrong-record-id";
			fs.writeFileSync(mismatchPointerPath, JSON.stringify(mismatchPointer), "utf-8");
			const corruptPointerPath = path.join(test.location.globalIndexDir, "corrupt-pointer.json");
			fs.writeFileSync(corruptPointerPath, "{not json", "utf-8");

			const global = listGlobalMissions(test.location.globalIndexDir);
			assert.deepEqual(global.entries.map((entry) => entry.missionId), ["wrong-record-id"]);
			assert.match(global.entries.find((entry) => entry.missionId === "wrong-record-id")?.staleReason ?? "", /does not match index id/);
			assert.match(global.warnings.join("\n"), /Skipped corrupt global mission index entry/);
			assert.equal(fs.existsSync(corruptPointerPath), true, "an unreadable index pointer remains available for inspection");
			assert.equal(fs.existsSync(mismatchPointerPath), true, "an ID-mismatched pointer remains marked stale rather than being rewritten");
		} finally {
			fs.rmSync(test.root, { recursive: true, force: true });
		}
	});
});
