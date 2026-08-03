import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ensureAccessibleDir } from "../../src/shared/accessible-dir.ts";
import { DIRS } from "../../src/shared/types.ts";

/**
 * Injectable fake fs for ensureAccessibleDir. `epermPaths` cause mkdirSync to
 * throw a persistent EPERM (simulating Windows NTFS ACL corruption after
 * wake-from-sleep), so the retry loop is exhausted and the pid-scoped fallback
 * path must be created instead.
 */
class FakeFs {
	created: string[] = [];
	epermPaths = new Set<string>();
	epermAccessPaths = new Set<string>();

	mkdirSync(dirPath: string): void {
		if (this.epermPaths.has(dirPath)) {
			const error = new Error(`mkdir failed with EPERM`) as NodeJS.ErrnoException;
			error.code = "EPERM";
			throw error;
		}
		this.created.push(dirPath);
	}

	accessSync(dirPath: string): void {
		if (this.epermAccessPaths.has(dirPath)) {
			const error = new Error(`access failed with EPERM`) as NodeJS.ErrnoException;
			error.code = "EPERM";
			throw error;
		}
	}

	rmSync(): void {
		// Best-effort deletion; the fake does not actually remove anything.
	}
}

function options(fakeFs: FakeFs) {
	return {
		fs: fakeFs as any,
		pid: 12345,
		retryDirectoryErrors: true,
		retryDelaysMs: [1, 1] as readonly number[],
		wait: () => {},
	};
}

describe("ensureAccessibleDir", () => {
	it("returns the requested path when mkdir and access succeed", () => {
		const fakeFs = new FakeFs();
		const dirPath = "/tmp/pi-subagents-ok/results";
		const result = ensureAccessibleDir(dirPath, options(fakeFs));
		assert.equal(result, dirPath);
		assert.ok(fakeFs.created.includes(dirPath));
	});

	it("falls back to a pid-scoped path on persistent EPERM during mkdir", () => {
		const fakeFs = new FakeFs();
		const dirPath = "/tmp/pi-subagents-eperm/results";
		fakeFs.epermPaths.add(dirPath);
		const result = ensureAccessibleDir(dirPath, options(fakeFs));
		const expectedFallback = `${dirPath}-12345`;
		assert.equal(result, expectedFallback);
		assert.ok(fakeFs.created.includes(expectedFallback), "pid-scoped fallback dir should be created");
		assert.ok(!fakeFs.created.includes(dirPath), "blocked primary path should not be recorded as created");
	});

	it("falls back to a pid-scoped path on persistent EPERM during access", () => {
		const fakeFs = new FakeFs();
		const dirPath = "/tmp/pi-subagents-access-eperm/results";
		fakeFs.epermAccessPaths.add(dirPath);
		const result = ensureAccessibleDir(dirPath, options(fakeFs));
		assert.equal(result, `${dirPath}-12345`);
	});
});

describe("DIRS container", () => {
	it("exports mutable results and async properties with the expected defaults", () => {
		assert.equal(typeof DIRS.results, "string");
		assert.equal(typeof DIRS.async, "string");
		assert.ok(DIRS.results.includes("async-subagent-results"), `DIRS.results=${DIRS.results}`);
		assert.ok(DIRS.async.includes("async-subagent-runs"), `DIRS.async=${DIRS.async}`);
	});

	it("allows runtime reassignment of results and async", () => {
		const originalResults = DIRS.results;
		const originalAsync = DIRS.async;
		DIRS.results = "/tmp/fallback-results";
		DIRS.async = "/tmp/fallback-async";
		assert.equal(DIRS.results, "/tmp/fallback-results");
		assert.equal(DIRS.async, "/tmp/fallback-async");
		DIRS.results = originalResults;
		DIRS.async = originalAsync;
		assert.equal(DIRS.results, originalResults);
		assert.equal(DIRS.async, originalAsync);
	});
});
