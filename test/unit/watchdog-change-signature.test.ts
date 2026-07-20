import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { computeWatchdogRepoChangeSignature } from "../../src/watchdog/change-signature.ts";

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
	it("hashes modified submodules through Git without traversing ignored dependencies", (t) => {
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

		fs.mkdirSync(path.dirname(ignoredFile), { recursive: true });
		fs.writeFileSync(ignoredFile, "ignored one\n", "utf-8");
		fs.writeFileSync(path.join(checkout, "tracked.txt"), "two\n", "utf-8");

		const first = computeWatchdogRepoChangeSignature(parent);
		assert.deepEqual(first?.changedPaths, ["vendor/child"]);

		fs.writeFileSync(ignoredFile, "ignored two\n", "utf-8");
		const ignoredOnly = computeWatchdogRepoChangeSignature(parent);
		assert.equal(ignoredOnly?.key, first?.key);

		fs.writeFileSync(path.join(checkout, "tracked.txt"), "three\n", "utf-8");
		const trackedChange = computeWatchdogRepoChangeSignature(parent);
		assert.notEqual(trackedChange?.key, first?.key);
	});

	function setThreshold(bytes: number, t: { after: (fn: () => void) => void }): void {
		const previous = process.env.PI_SUBAGENTS_MAX_HASH_FILE_BYTES;
		process.env.PI_SUBAGENTS_MAX_HASH_FILE_BYTES = String(bytes);
		t.after(() => {
			if (previous === undefined) delete process.env.PI_SUBAGENTS_MAX_HASH_FILE_BYTES;
			else process.env.PI_SUBAGENTS_MAX_HASH_FILE_BYTES = previous;
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
