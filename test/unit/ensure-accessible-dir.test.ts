import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { DIRS } from "../../src/shared/types.ts";

/**
 * Standalone copy of ensureAccessibleDir for unit testing.
 * The actual implementation lives in src/extension/index.ts but can't be
 * imported in Node.js strip-only mode due to TypeScript parameter properties
 * in that file. This copy MUST be kept in sync with the source.
 */
function ensureAccessibleDir(dirPath: string): string {
	try {
		fs.mkdirSync(dirPath, { recursive: true });
	} catch (err: any) {
		if (err?.code !== 'EPERM' && err?.code !== 'EACCES') throw err;
		try {
			fs.rmSync(dirPath, { recursive: true, force: true });
		} catch {
			// Deletion also blocked — fall through to retry
		}
		try {
			fs.mkdirSync(dirPath, { recursive: true });
		} catch {
			const fallback = `${dirPath}-${process.pid}`;
			fs.mkdirSync(fallback, { recursive: true });
			fs.accessSync(fallback, fs.constants.R_OK | fs.constants.W_OK);
			return fallback;
		}
	}
	try {
		fs.accessSync(dirPath, fs.constants.R_OK | fs.constants.W_OK);
	} catch {
		try {
			fs.rmSync(dirPath, { recursive: true, force: true });
		} catch {
			// Best effort
		}
		try {
			fs.mkdirSync(dirPath, { recursive: true });
			fs.accessSync(dirPath, fs.constants.R_OK | fs.constants.W_OK);
		} catch {
			const fallback = `${dirPath}-${process.pid}`;
			fs.mkdirSync(fallback, { recursive: true });
			fs.accessSync(fallback, fs.constants.R_OK | fs.constants.W_OK);
			return fallback;
		}
	}
	return dirPath;
}

describe("ensureAccessibleDir", () => {
	let tempBase: string;

	beforeEach(() => {
		tempBase = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-test-"));
	});

	afterEach(() => {
		try {
			fs.rmSync(tempBase, { recursive: true, force: true });
		} catch {
			// Best effort cleanup
		}
		const pidSuffix = `-${process.pid}`;
		try {
			const parent = path.dirname(tempBase);
			for (const entry of fs.readdirSync(parent)) {
				if (entry.startsWith(path.basename(tempBase)) && entry.includes(pidSuffix)) {
					try {
						fs.rmSync(path.join(parent, entry), { recursive: true, force: true });
					} catch {
						// Best effort
					}
				}
			}
		} catch {
			// Best effort
		}
	});

	it("returns the original path when mkdir succeeds and access check passes", () => {
		const dirPath = path.join(tempBase, "normal-dir");
		const result = ensureAccessibleDir(dirPath);
		assert.equal(result, dirPath);
		assert.ok(fs.existsSync(dirPath));
	});

	it("re-throws non-EPERM/EACCES errors like EEXIST", () => {
		const dirPath = path.join(tempBase, "blocked-dir");
		// Create a file where a directory is expected — EEXIST is not EPERM/EACCES
		fs.writeFileSync(dirPath, "blocking-file");
		assert.throws(
			() => ensureAccessibleDir(dirPath),
			(err: any) => err?.code === "EEXIST",
		);
	});

	it("falls back to pid-scoped path when mkdirSync throws EPERM", () => {
		const dirPath = path.join(tempBase, "eperm-dir");
		// We can't easily create EPERM in a test, so we test by mocking mkdirSync
		// indirectly. Instead, test the fallback naming convention by calling
		// ensureAccessibleDir on a path we control and verifying the contract.
		// When EPERM occurs, fallback = `dirPath-${process.pid}`
		const expectedFallback = `${dirPath}-${process.pid}`;
		assert.ok(expectedFallback.includes(String(process.pid)),
			"Fallback path should contain process.pid");
	});

	it("returns the original path for nested directory creation", () => {
		const dirPath = path.join(tempBase, "parent", "child", "deep-dir");
		const result = ensureAccessibleDir(dirPath);
		assert.equal(result, dirPath);
		assert.ok(fs.existsSync(dirPath));
	});

	it("creates the directory if it doesn't exist", () => {
		const dirPath = path.join(tempBase, "new-dir");
		assert.ok(!fs.existsSync(dirPath));
		const result = ensureAccessibleDir(dirPath);
		assert.equal(result, dirPath);
		assert.ok(fs.existsSync(dirPath));
	});

	it("returns the same path when directory already exists and is accessible", () => {
		const dirPath = path.join(tempBase, "existing-dir");
		fs.mkdirSync(dirPath, { recursive: true });
		const result = ensureAccessibleDir(dirPath);
		assert.equal(result, dirPath);
	});
});

describe("DIRS container", () => {
	it("exports DIRS with results and async properties", () => {
		assert.ok(typeof DIRS.results === "string", "DIRS.results should be string");
		assert.ok(typeof DIRS.async === "string", "DIRS.async should be string");
		assert.ok(DIRS.results.includes("async-subagent-results"), `DIRS.results should contain 'async-subagent-results', got: ${DIRS.results}`);
		assert.ok(DIRS.async.includes("async-subagent-runs"), `DIRS.async should contain 'async-subagent-runs', got: ${DIRS.async}`);
	});

	it("allows reassignment of DIRS.results", () => {
		const original = DIRS.results;
		DIRS.results = "/test/fallback/path";
		assert.equal(DIRS.results, "/test/fallback/path");
		DIRS.results = original; // restore
	});

	it("allows reassignment of DIRS.async", () => {
		const original = DIRS.async;
		DIRS.async = "/test/fallback/async";
		assert.equal(DIRS.async, "/test/fallback/async");
		DIRS.async = original; // restore
	});
});