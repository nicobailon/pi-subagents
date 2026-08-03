import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { ensureAccessibleDir } from "../../src/shared/accessible-dir.ts";
import { DIRS } from "../../src/shared/types.ts";

class FakeFs {
	created: string[] = [];
	blockedMkdir = new Set<string>();
	blockedAccess = new Set<string>();

	mkdirSync(dirPath: string): void {
		if (this.blockedMkdir.has(dirPath)) {
			const error = new Error("mkdir blocked") as NodeJS.ErrnoException;
			error.code = "EPERM";
			throw error;
		}
		this.created.push(dirPath);
	}

	accessSync(dirPath: string): void {
		if (this.blockedAccess.has(dirPath)) {
			const error = new Error("access blocked") as NodeJS.ErrnoException;
			error.code = "EPERM";
			throw error;
		}
	}
}

function fakeOptions(fakeFs: FakeFs) {
	return {
		fs: fakeFs,
		pid: 12345,
		retryDirectoryErrors: true,
		retryDelaysMs: [] as readonly number[],
		wait: () => {},
	};
}

describe("ensureAccessibleDir", () => {
	it("returns the requested path when it is usable", () => {
		const fakeFs = new FakeFs();
		const dirPath = "/tmp/pi-subagents-ok/results";

		const result = ensureAccessibleDir(dirPath, fakeOptions(fakeFs));

		assert.equal(result, dirPath);
		assert.deepEqual(fakeFs.created, [dirPath]);
	});

	it("falls back to a pid-scoped sibling when mkdir is persistently blocked", () => {
		const fakeFs = new FakeFs();
		const dirPath = "/tmp/pi-subagents-mkdir-eperm/results";
		fakeFs.blockedMkdir.add(dirPath);

		const result = ensureAccessibleDir(dirPath, fakeOptions(fakeFs));

		assert.equal(result, `${dirPath}-12345`);
		assert.deepEqual(fakeFs.created, [`${dirPath}-12345`]);
	});

	it("falls back to a pid-scoped sibling when access is persistently blocked", () => {
		const fakeFs = new FakeFs();
		const dirPath = "/tmp/pi-subagents-access-eperm/results";
		fakeFs.blockedAccess.add(dirPath);

		const result = ensureAccessibleDir(dirPath, fakeOptions(fakeFs));

		assert.equal(result, `${dirPath}-12345`);
		assert.deepEqual(fakeFs.created, [dirPath, `${dirPath}-12345`]);
	});

	it("does not delete existing primary directory contents when falling back", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-accessible-dir-"));
		try {
			const dirPath = path.join(root, "async-subagent-runs");
			const statusPath = path.join(dirPath, "run-1", "status.json");
			fs.mkdirSync(path.dirname(statusPath), { recursive: true });
			fs.writeFileSync(statusPath, "{}", "utf-8");

			const fsImpl = {
				mkdirSync: fs.mkdirSync,
				accessSync(target: string, mode?: number): void {
					if (target === dirPath) {
						const error = new Error("access blocked") as NodeJS.ErrnoException;
						error.code = "EPERM";
						throw error;
					}
					fs.accessSync(target, mode);
				},
			};

			const result = ensureAccessibleDir(dirPath, {
				fs: fsImpl,
				pid: 12345,
				retryDirectoryErrors: true,
				retryDelaysMs: [] as readonly number[],
				wait: () => {},
			});

			assert.equal(result, `${dirPath}-12345`);
			assert.equal(fs.readFileSync(statusPath, "utf-8"), "{}");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("DIRS", () => {
	it("allows runtime reassignment for live async and results paths", () => {
		const originalResults = DIRS.results;
		const originalAsync = DIRS.async;
		try {
			DIRS.results = "/tmp/fallback-results";
			DIRS.async = "/tmp/fallback-async";
			assert.equal(DIRS.results, "/tmp/fallback-results");
			assert.equal(DIRS.async, "/tmp/fallback-async");
		} finally {
			DIRS.results = originalResults;
			DIRS.async = originalAsync;
		}
	});
});
