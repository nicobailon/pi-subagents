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
});
