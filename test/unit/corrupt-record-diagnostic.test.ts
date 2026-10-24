import assert from "node:assert/strict";
import fsDefault, * as fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { CORRUPT_RECORD_REVALIDATION_INTERVAL_MS, corruptRecordPath, shouldReportCorruptRecord } from "../../src/shared/corrupt-record-diagnostic.ts";
import { readMissionBinding } from "../../src/missions/lifecycle.ts";
import { createMission, missionRecordPath, readMission, resolveMissionStoreLocation } from "../../src/missions/store.ts";
import { readStatus } from "../../src/shared/utils.ts";
import { ACTIVE_RUN_INDEX_DIR, updateActiveRunIndex } from "../../src/runs/background/active-run-index.ts";
import { listAsyncRuns } from "../../src/runs/background/async-status.ts";

describe("corrupt record diagnostics", () => {
	it("fast-paths unchanged retries, detects changed bytes after the bounded revalidation interval, and preserves originals", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-corrupt-record-"));
		const originalReadSync = fsDefault.readSync;
		let reads = 0;
		try {
			fsDefault.readSync = ((...args: Parameters<typeof fs.readSync>) => {
				reads++;
				return originalReadSync(...args);
			}) as typeof fsDefault.readSync;
			syncBuiltinESMExports();
			const file = path.join(root, "record.json");
			const original = Buffer.from([0, 0, 0]);
			fs.writeFileSync(file, original);
			assert.equal(shouldReportCorruptRecord(file, 100), true);
			const firstReadCount = reads;
			assert.equal(shouldReportCorruptRecord(file, 200), false);
			assert.equal(reads, firstReadCount, "rapid retry stats but does not reread/hash the file");
			fs.writeFileSync(file, "{broken");
			assert.equal(shouldReportCorruptRecord(file, 300), true, "changed metadata allows immediate retry");
			fs.writeFileSync(file, "{}\n");
			assert.equal(shouldReportCorruptRecord(file, 300 + CORRUPT_RECORD_REVALIDATION_INTERVAL_MS), true);
			assert.deepEqual(fs.readFileSync(file), Buffer.from("{}\n"));
		} finally {
			fsDefault.readSync = originalReadSync;
			syncBuiltinESMExports();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("rechecks oversized files by streaming bytes and catches same-metadata changes at the declared interval", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-corrupt-oversized-"));
		const file = path.join(root, "large.json");
		const originalStatSync = fsDefault.statSync;
		try {
			const content = Buffer.alloc(16 * 1024 * 1024 + 1, 0x61);
			fs.writeFileSync(file, content);
			const fixedStat = originalStatSync(file);
			fsDefault.statSync = ((...args: Parameters<typeof fs.statSync>) => {
				const actual = originalStatSync(...args);
				return { ...actual, mtimeMs: fixedStat.mtimeMs, ctimeMs: fixedStat.ctimeMs, ino: fixedStat.ino } as fs.Stats;
			}) as typeof fsDefault.statSync;
			syncBuiltinESMExports();
			assert.equal(shouldReportCorruptRecord(file, 1_000), true);
			assert.equal(shouldReportCorruptRecord(file, 1_100), false);
			const fd = fs.openSync(file, "r+");
			try { fs.writeSync(fd, Buffer.from([0x62]), 0, 1, 0); } finally { fs.closeSync(fd); }
			assert.equal(shouldReportCorruptRecord(file, 1_999), false, "same-metadata change waits for bounded content recheck");
			assert.equal(shouldReportCorruptRecord(file, 2_000), true, "same-metadata change is eventually detected");
			assert.equal(fs.readFileSync(file)[0], 0x62, "same-metadata changed bytes remain untouched");
		} finally {
			fsDefault.statSync = originalStatSync;
			syncBuiltinESMExports();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("bounds the diagnostic fingerprint cache", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-corrupt-cache-bound-"));
		const originalReadSync = fsDefault.readSync;
		let reads = 0;
		try {
			fsDefault.readSync = ((...args: Parameters<typeof fs.readSync>) => {
				reads++;
				return originalReadSync(...args);
			}) as typeof fsDefault.readSync;
			syncBuiltinESMExports();
			const files = Array.from({ length: 513 }, (_, index) => path.join(root, `${index}.json`));
			for (const file of files) {
				fs.writeFileSync(file, "bad");
				assert.equal(shouldReportCorruptRecord(file, 5_000), true);
			}
			const beforeEvictedRead = reads;
			assert.equal(shouldReportCorruptRecord(files[0]!, 5_001), true);
			assert.ok(reads > beforeEvictedRead, "evicted fingerprint is safely re-read rather than cached permanently");
		} finally {
			fsDefault.readSync = originalReadSync;
			syncBuiltinESMExports();
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
