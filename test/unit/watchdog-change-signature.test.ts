import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { computeWatchdogRepoChangeSignature } from "../../src/watchdog/change-signature.ts";

// The module under test hashes file content via `fs.readFileSync`, whose ESM
// binding cannot be reassigned (module namespaces are frozen) and mock.module is
// gated behind an experimental flag not passed by the runner. However, the ESM
// `readFileSync` dispatches through the CJS module's `openSync`, so patching
// `require("node:fs").openSync` deterministically forces the inner read error
// paths without touching lstat/readdir (which do not go through openSync).
const require = createRequire(import.meta.url);
const cjsFs = require("node:fs") as { openSync: typeof fs.openSync; lstatSync: typeof fs.lstatSync };

function withOpenSyncError<T>(code: string, run: () => T): T {
	const previous = cjsFs.openSync;
	cjsFs.openSync = () => {
		throw Object.assign(new Error("forced read failure"), { code });
	};
	try {
		return run();
	} finally {
		cjsFs.openSync = previous;
	}
}

function withLstatSyncError<T>(code: string, run: () => T): T {
	const previous = cjsFs.lstatSync;
	cjsFs.lstatSync = () => {
		throw Object.assign(new Error("forced stat failure"), { code });
	};
	syncBuiltinESMExports();
	try {
		return run();
	} finally {
		cjsFs.lstatSync = previous;
		syncBuiltinESMExports();
	}
}

function git(cwd: string, args: string[]): string {
	const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf-8" });
	if (result.status !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || `git ${args.join(" ")} failed`);
	return result.stdout.trim();
}

function createRepo(prefix: string): string {
	const repo = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	git(repo, ["init"]);
	git(repo, ["config", "user.email", "watchdog@example.com"]);
	git(repo, ["config", "user.name", "Watchdog Tests"]);
	return repo;
}

describe("watchdog change signature", () => {
	it("summarizes modified submodules as opaque Git worktrees", (t) => {
		const childSource = createRepo("watchdog-child-");
		const parent = createRepo("watchdog-parent-");
		const checkout = path.join(parent, "vendor", "child");
		const ignoredFile = path.join(checkout, "node_modules", "ignored.bin");
		t.after(() => {
			fs.rmSync(parent, { recursive: true, force: true });
			fs.rmSync(childSource, { recursive: true, force: true });
		});

		fs.writeFileSync(path.join(childSource, ".gitignore"), "node_modules/\n", "utf-8");
		fs.writeFileSync(path.join(childSource, "tracked.txt"), "one\n", "utf-8");
		git(childSource, ["add", "-A"]);
		git(childSource, ["commit", "-m", "initial"]);

		git(parent, ["-c", "protocol.file.allow=always", "submodule", "add", childSource, "vendor/child"]);
		git(parent, ["commit", "-am", "add submodule"]);
		git(checkout, ["config", "user.email", "watchdog@example.com"]);
		git(checkout, ["config", "user.name", "Watchdog Tests"]);

		fs.mkdirSync(path.dirname(ignoredFile), { recursive: true });
		fs.writeFileSync(ignoredFile, "ignored one\n", "utf-8");
		fs.writeFileSync(path.join(checkout, "tracked.txt"), "two\n", "utf-8");

		const first = computeWatchdogRepoChangeSignature(parent);
		assert.deepEqual(first?.changedPaths, ["vendor/child"]);

		fs.writeFileSync(ignoredFile, "ignored two\n", "utf-8");
		const ignoredOnly = computeWatchdogRepoChangeSignature(parent);
		assert.equal(ignoredOnly?.key, first?.key);

		fs.writeFileSync(path.join(checkout, "tracked.txt"), "three\n", "utf-8");
		const stillDirty = computeWatchdogRepoChangeSignature(parent);
		assert.equal(stillDirty?.key, first?.key, "dirty submodule content is intentionally opaque");

		git(checkout, ["add", "tracked.txt"]);
		git(checkout, ["commit", "-m", "update tracked"]);
		const headChange = computeWatchdogRepoChangeSignature(parent);
		assert.notEqual(headChange?.key, first?.key, "submodule HEAD changes remain visible");
	});

	function setThreshold(bytes: number, t: { after: (fn: () => void) => void }): void {
		const previous = process.env.PI_SUBAGENTS_MAX_HASH_FILE_BYTES;
		process.env.PI_SUBAGENTS_MAX_HASH_FILE_BYTES = String(bytes);
		t.after(() => {
			if (previous === undefined) delete process.env.PI_SUBAGENTS_MAX_HASH_FILE_BYTES;
			else process.env.PI_SUBAGENTS_MAX_HASH_FILE_BYTES = previous;
		});
	}

	function setTotalThreshold(bytes: number, t: { after: (fn: () => void) => void }): void {
		const previous = process.env.PI_SUBAGENTS_MAX_HASH_TOTAL_BYTES;
		process.env.PI_SUBAGENTS_MAX_HASH_TOTAL_BYTES = String(bytes);
		t.after(() => {
			if (previous === undefined) delete process.env.PI_SUBAGENTS_MAX_HASH_TOTAL_BYTES;
			else process.env.PI_SUBAGENTS_MAX_HASH_TOTAL_BYTES = previous;
		});
	}

	function setEntryThreshold(entries: number, t: { after: (fn: () => void) => void }): void {
		const previous = process.env.PI_SUBAGENTS_MAX_HASH_ENTRIES;
		process.env.PI_SUBAGENTS_MAX_HASH_ENTRIES = String(entries);
		t.after(() => {
			if (previous === undefined) delete process.env.PI_SUBAGENTS_MAX_HASH_ENTRIES;
			else process.env.PI_SUBAGENTS_MAX_HASH_ENTRIES = previous;
		});
	}

	it("uses a metadata marker for files above the (lowered) threshold instead of hashing content", (t) => {
		const repo = createRepo("watchdog-large-");
		t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
		setThreshold(1024, t);

		const filePath = path.join(repo, "big.txt");
		fs.writeFileSync(filePath, Buffer.alloc(4096, 0x61)); // 4 KiB > 1 KiB threshold
		const mtime = new Date(1_600_000_000_000);
		fs.utimesSync(filePath, mtime, mtime);

		const sig = computeWatchdogRepoChangeSignature(repo);
		assert.ok(sig, "expected a signature");
		assert.equal(typeof sig?.key, "string");
		assert.ok(sig?.changedPaths.includes("big.txt"));

		// The per-file hash is not exposed on the public signature, so prove the
		// metadata marker (largeFileHash = "large:size:mtime") behaviorally: content
		// is unchanged but the mtime changes, so a metadata-keyed hash yields a new
		// key while a content SHA-256 (unfixed main) would produce the same key.
		const laterMtime = new Date(1_600_000_100_000);
		fs.utimesSync(filePath, laterMtime, laterMtime);
		const afterMtime = computeWatchdogRepoChangeSignature(repo);
		assert.notEqual(afterMtime?.key, sig?.key, "mtime-only change must alter the key for large files");
	});

	it("uses metadata markers after the total content hash budget", (t) => {
		const repo = createRepo("watchdog-total-budget-");
		t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
		setTotalThreshold(10, t);

		const aPath = path.join(repo, "a.txt");
		const bPath = path.join(repo, "b.txt");
		const mtime = new Date(1_600_000_000_000);
		fs.writeFileSync(aPath, "aaaaaaaa");
		fs.writeFileSync(bPath, "bbbbbbbb");
		fs.utimesSync(aPath, mtime, mtime);
		fs.utimesSync(bPath, mtime, mtime);

		const first = computeWatchdogRepoChangeSignature(repo);
		assert.ok(first, "expected a signature");

		fs.writeFileSync(bPath, "cccccccc");
		fs.utimesSync(bPath, mtime, mtime);
		assert.equal(computeWatchdogRepoChangeSignature(repo)?.key, first?.key, "over-budget files use size+mtime metadata instead of content");

		fs.writeFileSync(aPath, "dddddddd");
		fs.utimesSync(aPath, mtime, mtime);
		assert.notEqual(computeWatchdogRepoChangeSignature(repo)?.key, first?.key, "within-budget files are still content hashed");
	});

	it("uses skipped markers after the entry budget", (t) => {
		const repo = createRepo("watchdog-entry-budget-");
		t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
		setEntryThreshold(3, t);

		const dir = path.join(repo, "files");
		fs.mkdirSync(dir);
		for (const name of ["a.txt", "b.txt", "c.txt", "d.txt"]) {
			fs.writeFileSync(path.join(dir, name), `${name}\n`, "utf-8");
		}

		const first = computeWatchdogRepoChangeSignature(repo);
		assert.ok(first, "expected a signature");

		fs.writeFileSync(path.join(dir, "d.txt"), "changed d\n", "utf-8");
		assert.equal(computeWatchdogRepoChangeSignature(repo)?.key, first?.key, "over-budget entries are summarized instead of hashed individually");

		fs.writeFileSync(path.join(dir, "a.txt"), "changed a\n", "utf-8");
		assert.notEqual(computeWatchdogRepoChangeSignature(repo)?.key, first?.key, "within-budget entries are still content hashed");
	});

	it("produces deterministic keys keyed on size and mtime for large files", (t) => {
		const repo = createRepo("watchdog-large-det-");
		t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
		setThreshold(1024, t);

		const filePath = path.join(repo, "big.txt");
		fs.writeFileSync(filePath, Buffer.alloc(4096, 0x61));
		const mtime = new Date(1_600_000_000_000);
		fs.utimesSync(filePath, mtime, mtime);

		const first = computeWatchdogRepoChangeSignature(repo);
		const again = computeWatchdogRepoChangeSignature(repo);
		assert.equal(again?.key, first?.key, "same size+mtime → same key");

		const laterMtime = new Date(1_600_000_100_000);
		fs.utimesSync(filePath, laterMtime, laterMtime);
		const afterMtime = computeWatchdogRepoChangeSignature(repo);
		assert.notEqual(afterMtime?.key, first?.key, "changed mtime → different key");

		fs.writeFileSync(filePath, Buffer.alloc(8192, 0x61));
		fs.utimesSync(filePath, laterMtime, laterMtime);
		const afterSize = computeWatchdogRepoChangeSignature(repo);
		assert.notEqual(afterSize?.key, afterMtime?.key, "changed size → different key");
	});

	it("handles a >2 GiB sparse file without throwing (default threshold)", { skip: process.platform === "win32" }, (t) => {
		const repo = createRepo("watchdog-sparse-");
		const filePath = path.join(repo, "huge.bin");
		t.after(() => fs.rmSync(repo, { recursive: true, force: true }));

		const fd = fs.openSync(filePath, "w");
		try {
			fs.ftruncateSync(fd, 2 * 1024 ** 3 + 1);
		} finally {
			fs.closeSync(fd);
		}

		const sig = computeWatchdogRepoChangeSignature(repo);
		assert.ok(sig, "expected a signature");
		assert.ok(sig?.changedPaths.includes("huge.bin"));
	});

	it("ignores node_modules below changed directories", (t) => {
		const repo = createRepo("watchdog-nested-ignored-");
		t.after(() => fs.rmSync(repo, { recursive: true, force: true }));

		const subdir = path.join(repo, "nested");
		fs.mkdirSync(path.join(subdir, "node_modules"), { recursive: true });
		fs.writeFileSync(path.join(subdir, "keep.txt"), "one\n", "utf-8");
		fs.writeFileSync(path.join(subdir, "node_modules", "cache.bin"), "ignored one\n", "utf-8");

		const first = computeWatchdogRepoChangeSignature(repo);
		assert.ok(first?.changedPaths.includes("nested/keep.txt"));
		assert.ok(!first?.changedPaths.some((relPath) => relPath.includes("node_modules")));

		fs.writeFileSync(path.join(subdir, "node_modules", "cache.bin"), "ignored two\n", "utf-8");
		assert.equal(computeWatchdogRepoChangeSignature(repo)?.key, first?.key);

		fs.writeFileSync(path.join(subdir, "keep.txt"), "two\n", "utf-8");
		assert.notEqual(computeWatchdogRepoChangeSignature(repo)?.key, first?.key);
	});

	it("applies the threshold guard recursively into untracked subdirectories", (t) => {
		const repo = createRepo("watchdog-recurse-");
		t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
		setThreshold(1024, t);

		const subdir = path.join(repo, "nested");
		fs.mkdirSync(subdir, { recursive: true });
		const filePath = path.join(subdir, "big.txt");
		fs.writeFileSync(filePath, Buffer.alloc(4096, 0x62));
		const mtime = new Date(1_600_000_000_000);
		fs.utimesSync(filePath, mtime, mtime);

		const sig = computeWatchdogRepoChangeSignature(repo);
		assert.ok(sig, "expected a signature");
		assert.ok(sig?.changedPaths.includes("nested/big.txt"));

		// Same behavioral proof as above, for a file nested in a subdirectory.
		const laterMtime = new Date(1_600_000_100_000);
		fs.utimesSync(filePath, laterMtime, laterMtime);
		const afterMtime = computeWatchdogRepoChangeSignature(repo);
		assert.notEqual(afterMtime?.key, sig?.key, "mtime-only change must alter the key for large files in subdirs");
	});

	it("degrades to the metadata marker when a per-file read raises ERR_FS_FILE_TOO_LARGE", (t) => {
		const repo = createRepo("watchdog-inner-toolarge-");
		t.after(() => fs.rmSync(repo, { recursive: true, force: true }));

		// Small file (default threshold) so it enters the content-hash try branch.
		fs.writeFileSync(path.join(repo, "small.txt"), "hello\n", "utf-8");

		const warnings: string[] = [];
		const previousWarn = console.warn;
		console.warn = (...args: unknown[]) => void warnings.push(args.join(" "));
		let sig: ReturnType<typeof computeWatchdogRepoChangeSignature>;
		try {
			sig = withOpenSyncError("ERR_FS_FILE_TOO_LARGE", () => computeWatchdogRepoChangeSignature(repo));
		} finally {
			console.warn = previousWarn;
		}

		assert.ok(sig, "a single unreadable file must not discard the whole signature");
		assert.equal(typeof sig?.key, "string");
		assert.ok(sig?.changedPaths.includes("small.txt"));
		assert.deepEqual(warnings, [], "the too-large case is expected and must stay quiet");
	});

	it("keeps a valid signature when a per-file read races into ENOENT", (t) => {
		const repo = createRepo("watchdog-inner-enoent-");
		t.after(() => fs.rmSync(repo, { recursive: true, force: true }));

		fs.writeFileSync(path.join(repo, "small.txt"), "hello\n", "utf-8");

		const sig = withOpenSyncError("ENOENT", () => computeWatchdogRepoChangeSignature(repo));
		assert.ok(sig, "an ENOENT during read must degrade to the deleted marker, not undefined");
		assert.equal(typeof sig?.key, "string");
		assert.ok(sig?.changedPaths.includes("small.txt"));
	});

	it("warns and falls back to metadata for other per-file read errors", (t) => {
		const repo = createRepo("watchdog-inner-eacces-");
		t.after(() => fs.rmSync(repo, { recursive: true, force: true }));

		fs.writeFileSync(path.join(repo, "small.txt"), "hello\n", "utf-8");

		const warnings: string[] = [];
		const previousWarn = console.warn;
		console.warn = (...args: unknown[]) => void warnings.push(args.join(" "));
		let sig: ReturnType<typeof computeWatchdogRepoChangeSignature>;
		try {
			sig = withOpenSyncError("EACCES", () => computeWatchdogRepoChangeSignature(repo));
		} finally {
			console.warn = previousWarn;
		}

		assert.ok(sig, "a single unreadable file must not discard the whole signature");
		assert.equal(typeof sig?.key, "string");
		assert.ok(warnings.some((line) => line.includes("hashFile fell back to metadata") && line.includes("small.txt")));
	});

	it("returns undefined instead of throwing when hashing a changed path raises", (t) => {
		const repo = createRepo("watchdog-outer-");
		t.after(() => fs.rmSync(repo, { recursive: true, force: true }));

		// Use a deterministic stat failure to exercise the outer fail-safe on every
		// platform without depending on POSIX permissions or ENOTDIR/ENOENT differences
		// between Unix and Windows.
		fs.writeFileSync(path.join(repo, "x.txt"), "changed\n", "utf-8");

		const warnings: string[] = [];
		const previousWarn = console.warn;
		console.warn = (...args: unknown[]) => void warnings.push(args.join(" "));
		let result: ReturnType<typeof computeWatchdogRepoChangeSignature>;
		try {
			assert.doesNotThrow(() => {
				result = withLstatSyncError("EIO", () => computeWatchdogRepoChangeSignature(repo));
			});
		} finally {
			console.warn = previousWarn;
		}

		assert.equal(result, undefined, "a throw in the hashing region must fail safe to undefined");
	});

	it("still hashes small files by content when under the threshold", (t) => {
		const repo = createRepo("watchdog-small-");
		t.after(() => fs.rmSync(repo, { recursive: true, force: true }));

		const filePath = path.join(repo, "small.txt");
		fs.writeFileSync(filePath, "hello\n", "utf-8");
		const mtime = new Date(1_600_000_000_000);
		fs.utimesSync(filePath, mtime, mtime);

		const sig = computeWatchdogRepoChangeSignature(repo);
		assert.ok(sig, "expected a signature");
		assert.ok(sig?.changedPaths.includes("small.txt"));

		// Content-hashed files ignore mtime: an mtime-only change must NOT alter the
		// key (would fail if the metadata marker leaked into the normal path). A
		// content change must alter it.
		const laterMtime = new Date(1_600_000_100_000);
		fs.utimesSync(filePath, laterMtime, laterMtime);
		assert.equal(computeWatchdogRepoChangeSignature(repo)?.key, sig?.key, "mtime-only change must not alter key for small files");

		fs.writeFileSync(filePath, "changed\n", "utf-8");
		assert.notEqual(computeWatchdogRepoChangeSignature(repo)?.key, sig?.key, "content change must alter key");
	});
});
