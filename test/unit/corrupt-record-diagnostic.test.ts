import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { corruptRecordPath, shouldReportCorruptRecord } from "../../src/shared/corrupt-record-diagnostic.ts";
import { readMissionBinding } from "../../src/missions/lifecycle.ts";
import { createMission, missionRecordPath, readMission, resolveMissionStoreLocation } from "../../src/missions/store.ts";
import { readStatus } from "../../src/shared/utils.ts";
import { ACTIVE_RUN_INDEX_DIR, updateActiveRunIndex } from "../../src/runs/background/active-run-index.ts";
import { listAsyncRuns } from "../../src/runs/background/async-status.ts";

describe("corrupt record diagnostics", () => {
	it("bounds repeated diagnostics by unchanged bytes and retries after repair or change", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-corrupt-record-"));
		try {
			const file = path.join(root, "record.json");
			fs.writeFileSync(file, Buffer.from([0, 0, 0]));
			assert.equal(shouldReportCorruptRecord(file), true);
			assert.equal(shouldReportCorruptRecord(file), false);
			fs.writeFileSync(file, "{broken");
			assert.equal(shouldReportCorruptRecord(file), true);
			assert.equal(shouldReportCorruptRecord(file), false);
			fs.writeFileSync(file, "{}\n");
			assert.equal(shouldReportCorruptRecord(file), true);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("retains a corrupt active-run marker when liveness is unknown", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-corrupt-active-status-"));
		const runId = "active-corrupt";
		const asyncDir = path.join(root, runId);
		fs.mkdirSync(asyncDir, { recursive: true });
		const statusPath = path.join(asyncDir, "status.json");
		const bytes = Buffer.from([0, 0, 0]);
		fs.writeFileSync(statusPath, bytes);
		updateActiveRunIndex(asyncDir, "running");
		const markerPath = path.join(root, ACTIVE_RUN_INDEX_DIR, runId);
		const originalError = console.error;
		const errors: unknown[][] = [];
		try {
			console.error = (...args: unknown[]) => { errors.push(args); };
			assert.deepEqual(listAsyncRuns(root), []);
			assert.deepEqual(listAsyncRuns(root), []);
			assert.equal(fs.existsSync(markerPath), true, "parse failure alone cannot release liveness marker");
			assert.deepEqual(fs.readFileSync(statusPath), bytes);
			assert.equal(errors.filter((args) => String(args[0]).includes("Skipping corrupt active async run")).length, 1);
		} finally {
			console.error = originalError;
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("does not classify unrelated errors as corrupt record diagnostics", () => {
		assert.equal(corruptRecordPath(new Error("permission denied")), undefined);
	});

	it("keeps targeted status, mission binding, and mission reads throwing without changing corrupt bytes", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-corrupt-targeted-"));
		try {
			const asyncDir = path.join(root, "async");
			fs.mkdirSync(asyncDir);
			const statusPath = path.join(asyncDir, "status.json");
			const corruptStatus = Buffer.from([0, 0, 0]);
			fs.writeFileSync(statusPath, corruptStatus);
			assert.throws(() => readStatus(asyncDir), /Failed to parse async status file/);
			assert.deepEqual(fs.readFileSync(statusPath), corruptStatus);

			const bindingPath = path.join(asyncDir, "mission.json");
			const corruptBinding = Buffer.from([0, 0]);
			fs.writeFileSync(bindingPath, corruptBinding);
			assert.throws(() => readMissionBinding(asyncDir), /Invalid mission binding file/);
			assert.match(corruptRecordPath(new Error(`Invalid mission binding file '${bindingPath}': invalid`)) ?? "", /mission\.json$/);
			assert.deepEqual(fs.readFileSync(bindingPath), corruptBinding);

			const location = resolveMissionStoreLocation({ projectRoot: root, config: { directory: ".pi/missions", globalIndexDir: path.join(root, "global") } });
			const mission = createMission(location, { title: "Corrupt", objective: "Evidence" });
			const missionPath = missionRecordPath(location, mission.id);
			const corruptMission = Buffer.from([0, 0, 0]);
			fs.writeFileSync(missionPath, corruptMission);
			assert.throws(() => readMission(location, mission.id), /Invalid mission file/);
			assert.deepEqual(fs.readFileSync(missionPath), corruptMission);
			assert.equal(shouldReportCorruptRecord(missionPath), true);
			assert.equal(shouldReportCorruptRecord(missionPath), false);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
