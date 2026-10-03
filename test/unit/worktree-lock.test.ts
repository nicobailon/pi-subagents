import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { it } from "node:test";
import { withHandoffWriteLock, withRepositoryWorktreeLock } from "../../src/runs/shared/worktree-lock.ts";

const moduleUrl = new URL("../../src/runs/shared/worktree-lock.ts", import.meta.url).href;
const nodeArgs = ["--experimental-strip-types", "--input-type=module", "--eval"];

function fixture(): string {
	const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pi-worktree-lock-"));
	execFileSync("git", ["init", repo], { stdio: "ignore" });
	return repo;
}

function childSource(source: string, repo: string): void {
	const child = spawnSync(process.execPath, [...nodeArgs, source, repo], { encoding: "utf-8", timeout: 30_000 });
	assert.equal(child.status, 81, child.error?.message || child.stderr);
}

function deadOwner(repo: string, handoff = false): void {
	childSource(`
		import path from 'node:path';
		import { withHandoffWriteLock, withRepositoryWorktreeLock } from ${JSON.stringify(moduleUrl)};
		if (${handoff}) withHandoffWriteLock(path.join(process.argv[1], 'handoff.json'), () => process.exit(81));
		else await withRepositoryWorktreeLock(process.argv[1], () => process.exit(81));
	`, repo);
}

for (const handoff of [false, true]) it(`recovers after the reclaimer exits immediately after retiring a ${handoff ? "handoff" : "repository"} lock`, async () => {
	const repo = fixture();
	try {
		deadOwner(repo, handoff);
		childSource(`
			import fs from 'node:fs';
			import path from 'node:path';
			import { syncBuiltinESMExports } from 'node:module';
			import { withHandoffWriteLock, withRepositoryWorktreeLock } from ${JSON.stringify(moduleUrl)};
			const rename = fs.renameSync;
			fs.renameSync = (from, to) => {
				const result = rename(from, to);
				if (String(to).includes('.retired-')) process.exit(81);
				return result;
			};
			syncBuiltinESMExports();
			if (${handoff}) withHandoffWriteLock(path.join(process.argv[1], 'handoff.json'), () => {});
			else await withRepositoryWorktreeLock(process.argv[1], () => {}, { waitMs: 0 });
		`, repo);
		let entered = false;
		if (handoff) withHandoffWriteLock(path.join(repo, "handoff.json"), () => entered = true);
		else await withRepositoryWorktreeLock(repo, () => entered = true, { waitMs: 0 });
		assert.equal(entered, true);
		const parent = handoff ? repo : path.join(repo, ".git");
		const retired = fs.readdirSync(parent).filter((name) => name.includes(".retired-"));
		assert.equal(retired.length, 1);
		assert.ok(fs.existsSync(path.join(parent, retired[0]!, "owner.json")));
	} finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

it("a delayed reclaimer of an old token cannot move a new live lease", async () => {
	const repo = fixture();
	const ready = path.join(repo, "ready"), release = path.join(repo, "release");
	let child: ReturnType<typeof spawn> | undefined;
	let exited: Promise<number | null> | undefined;
	try {
		deadOwner(repo);
		const source = `
			import fs from 'node:fs';
			import path from 'node:path';
			import { syncBuiltinESMExports } from 'node:module';
			import { withRepositoryWorktreeLock } from ${JSON.stringify(moduleUrl)};
			const rename = fs.renameSync;
			fs.renameSync = (from, to) => {
				if (String(to).includes('.retired-')) {
					fs.writeFileSync(path.join(process.argv[1], 'ready'), 'ready');
					const deadline = Date.now() + 30_000;
					while (!fs.existsSync(path.join(process.argv[1], 'release'))) {
						if (Date.now() > deadline) process.exit(92);
						Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
					}
				}
				return rename(from, to);
			};
			syncBuiltinESMExports();
			try { await withRepositoryWorktreeLock(process.argv[1], () => process.exit(93), { waitMs: 0 }); }
			catch (error) { if (!/busy/.test(error.message)) throw error; process.exit(84); }
		`;
		child = spawn(process.execPath, [...nodeArgs, source, repo], { stdio: ["ignore", "pipe", "pipe"] });
		let errors = "";
		child.stderr!.on("data", (chunk) => errors += chunk);
		exited = new Promise((resolve, reject) => { child!.once("error", reject); child!.once("exit", resolve); });
		const deadline = Date.now() + 30_000;
		while (!fs.existsSync(ready)) {
			assert.equal(child.exitCode, null, errors);
			assert.ok(Date.now() < deadline, "reclaimer did not reach the retirement boundary");
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		await withRepositoryWorktreeLock(repo, async () => {
			const ownerPath = path.join(repo, ".git", "pi-subagents-worktree.lock", "owner.json");
			const before = JSON.parse(fs.readFileSync(ownerPath, "utf-8"));
			fs.writeFileSync(release, "continue");
			assert.equal(await exited, 84, errors);
			const after = JSON.parse(fs.readFileSync(ownerPath, "utf-8"));
			assert.equal(after.token, before.token);
			assert.equal(after.pid, process.pid);
		}, { waitMs: 0 });
	} finally {
		if (child && child.exitCode === null) { child.kill("SIGKILL"); await exited; }
		fs.rmSync(repo, { recursive: true, force: true });
	}
});

it("does not evict an ownerless lock", async () => {
	const repo = fixture();
	try {
		const lockPath = path.join(repo, ".git", "pi-subagents-worktree.lock");
		fs.mkdirSync(lockPath);
		await assert.rejects(withRepositoryWorktreeLock(repo, () => assert.fail("unknown owner was evicted"), { waitMs: 0 }), /busy/);
		assert.ok(fs.existsSync(lockPath));
	} finally { fs.rmSync(repo, { recursive: true, force: true }); }
});
