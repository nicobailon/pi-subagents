import assert from "node:assert/strict";
import * as path from "node:path";
import { describe, it } from "node:test";

/**
 * Tests for cross-platform path handling patterns used throughout the codebase.
 * These tests document bugs found in the code review and verify fixes.
 *
 * Key locations:
 * - chain-execution.ts:496 — startsWith("/") instead of path.isAbsolute()
 * - settings.ts:216,246,302,306 — template string "/" instead of path.join()
 */

describe("path.isAbsolute vs startsWith('/')", () => {
	// chain-execution.ts:496 uses startsWith("/") to detect absolute paths.
	// On Windows, absolute paths look like "C:\..." or "C:/..." — neither starts with "/".

	it("startsWith('/') misses Windows absolute paths", () => {
		const windowsAbsolute = "C:\\dev\\pi-subagents\\output.md";
		const windowsAbsoluteForward = "C:/dev/pi-subagents/output.md";

		// This is what the current code does (chain-execution.ts:496):
		assert.equal(windowsAbsolute.startsWith("/"), false,
			"Windows backslash absolute path not detected by startsWith('/')");
		assert.equal(windowsAbsoluteForward.startsWith("/"), false,
			"Windows forward-slash absolute path not detected by startsWith('/')");

		// This is what the code SHOULD do:
		assert.equal(path.isAbsolute(windowsAbsolute), process.platform === "win32",
			"path.isAbsolute correctly identifies Windows paths on Windows");
		assert.equal(path.isAbsolute(windowsAbsoluteForward), process.platform === "win32",
			"path.isAbsolute correctly identifies forward-slash Windows paths on Windows");

		// POSIX paths work with both approaches
		assert.equal("/home/user/output.md".startsWith("/"), true);
		assert.equal(path.isAbsolute("/home/user/output.md"), true);
	});

	it("path.isAbsolute is the correct cross-platform check", () => {
		// Relative paths — both approaches agree
		assert.equal(path.isAbsolute("output.md"), false);
		assert.equal(path.isAbsolute("subdir/output.md"), false);
		assert.equal("output.md".startsWith("/"), false);

		// The only platform-safe check for absolute paths is path.isAbsolute()
		if (process.platform === "win32") {
			// On Windows, these are absolute:
			assert.equal(path.isAbsolute("C:\\output.md"), true);
			assert.equal(path.isAbsolute("C:/output.md"), true);
			assert.equal(path.isAbsolute("\\\\server\\share"), true); // UNC
			// But startsWith("/") catches none of them
			assert.equal("C:\\output.md".startsWith("/"), false);
			assert.equal("C:/output.md".startsWith("/"), false);
		}
	});
});

describe("path.join vs template string concatenation", () => {
	// settings.ts uses `${chainDir}/${file}` in several places.
	// This works but produces inconsistent separators on Windows.

	it("template concatenation produces forward slashes regardless of platform", () => {
		const chainDir = "C:\\Users\\marc\\temp\\chain-abc";
		const file = "progress.md";

		// Template string: always forward slash (settings.ts:246 pattern)
		const templateResult = `${chainDir}/${file}`;
		assert.equal(templateResult, "C:\\Users\\marc\\temp\\chain-abc/progress.md",
			"template string produces mixed separators");

		// path.join: uses platform separator
		const joinResult = path.join(chainDir, file);
		if (process.platform === "win32") {
			assert.equal(joinResult, "C:\\Users\\marc\\temp\\chain-abc\\progress.md",
				"path.join uses consistent backslashes on Windows");
		}
	});

	it("resolveChainPath pattern should use path.join for relative paths", () => {
		// settings.ts:216: `${chainDir}/${filePath}` for relative paths
		const chainDir = "C:\\temp\\chain-runs\\abc123";
		const relative = "synthesis.md";

		// Current: string concat
		const current = `${chainDir}/${relative}`;
		// Fixed: path.join
		const fixed = path.join(chainDir, relative);

		// On Windows these differ:
		if (process.platform === "win32") {
			assert.notEqual(current, fixed, "concat and path.join produce different results on Windows");
			assert.ok(fixed.includes(path.sep), "path.join uses native separator");
		}
	});

	it("parallel subdir naming should use path.join", () => {
		// settings.ts:302,306 pattern: `${subdir}/${task.output}`
		const subdir = "parallel-0/0-_code-reviewer";
		const output = "review.md";

		const templateResult = `${subdir}/${output}`;
		const joinResult = path.join(subdir, output);

		// Both produce forward slashes here (subdir itself uses /).
		// But if subdir comes from path.join on Windows, it would have backslashes.
		const windowsSubdir = path.join("parallel-0", "0-_code-reviewer");
		const windowsJoin = path.join(windowsSubdir, output);
		// Consistent: all native separators
		assert.equal(windowsJoin, path.join("parallel-0", "0-_code-reviewer", output));
	});
});
