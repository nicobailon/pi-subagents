import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { PI_CODING_AGENT_PACKAGE_ROOT_ENV } from "../../src/shared/utils.ts";
import { computeWatchdogRepoChangeSignature } from "../../src/watchdog/change-signature.ts";

function git(cwd: string, args: string[]): string {
	const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf-8" });
	if (result.status !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || `git ${args.join(" ")} failed`);
	return result.stdout.trim();
}

function createRepo(): string {
	const repo = fs.mkdtempSync(path.join(os.tmpdir(), "watchdog-change-signature-"));
	git(repo, ["init"]);
	git(repo, ["config", "user.email", "watchdog@example.com"]);
	git(repo, ["config", "user.name", "Watchdog Tests"]);
	fs.mkdirSync(path.join(repo, "src"));
	fs.writeFileSync(path.join(repo, "src", "file.ts"), "export const value = 1;\n", "utf-8");
	git(repo, ["add", "-A"]);
	git(repo, ["commit", "-m", "initial"]);
	return repo;
}

function writeArtifact(repo: string, configDirName: string): void {
	const artifactsDir = path.join(repo, configDirName, "subagents", "artifacts");
	fs.mkdirSync(artifactsDir, { recursive: true });
	fs.writeFileSync(path.join(artifactsDir, "run_output.md"), "artifact\n", "utf-8");
}

function createCustomConfigPackageRoot(configDirName: string): string {
	const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "watchdog-config-root-"));
	fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({
		name: "@earendil-works/pi-coding-agent",
		piConfig: { configDir: configDirName },
	}), "utf-8");
	return packageRoot;
}

describe("watchdog repo change signature ignore rules", () => {
	const tempDirs: string[] = [];
	let previousPackageRootEnv: string | undefined;

	beforeEach(() => {
		previousPackageRootEnv = process.env[PI_CODING_AGENT_PACKAGE_ROOT_ENV];
		delete process.env[PI_CODING_AGENT_PACKAGE_ROOT_ENV];
	});

	afterEach(() => {
		if (previousPackageRootEnv === undefined) delete process.env[PI_CODING_AGENT_PACKAGE_ROOT_ENV];
		else process.env[PI_CODING_AGENT_PACKAGE_ROOT_ENV] = previousPackageRootEnv;
		for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
	});

	function trackedRepo(): string {
		const repo = createRepo();
		tempDirs.push(repo);
		return repo;
	}

	it("ignores default .pi/subagents artifacts and keeps real changes", () => {
		const repo = trackedRepo();
		const baseline = computeWatchdogRepoChangeSignature(repo);
		assert.ok(baseline);

		writeArtifact(repo, ".pi");
		const withArtifact = computeWatchdogRepoChangeSignature(repo);
		assert.ok(withArtifact);
		assert.equal(withArtifact.key, baseline.key);
		assert.deepEqual(withArtifact.changedPaths, []);

		fs.writeFileSync(path.join(repo, "src", "file.ts"), "export const value = 2;\n", "utf-8");
		const withEdit = computeWatchdogRepoChangeSignature(repo);
		assert.ok(withEdit);
		assert.notEqual(withEdit.key, baseline.key);
		assert.deepEqual(withEdit.changedPaths, ["src/file.ts"]);
	});

	it("ignores artifacts under a custom Pi config directory", () => {
		const packageRoot = createCustomConfigPackageRoot(".custom-pi");
		tempDirs.push(packageRoot);
		process.env[PI_CODING_AGENT_PACKAGE_ROOT_ENV] = packageRoot;

		const repo = trackedRepo();
		const baseline = computeWatchdogRepoChangeSignature(repo);
		assert.ok(baseline);

		writeArtifact(repo, ".custom-pi");
		const withArtifact = computeWatchdogRepoChangeSignature(repo);
		assert.ok(withArtifact);
		assert.equal(withArtifact.key, baseline.key);
		assert.deepEqual(withArtifact.changedPaths, []);
	});

	it("still ignores tmp/ and node_modules/ alongside dynamic artifact rules", () => {
		const repo = trackedRepo();
		const baseline = computeWatchdogRepoChangeSignature(repo);
		assert.ok(baseline);

		fs.mkdirSync(path.join(repo, "tmp"), { recursive: true });
		fs.writeFileSync(path.join(repo, "tmp", "scratch.txt"), "scratch\n", "utf-8");
		fs.mkdirSync(path.join(repo, "node_modules", "dep"), { recursive: true });
		fs.writeFileSync(path.join(repo, "node_modules", "dep", "index.js"), "module.exports = 1;\n", "utf-8");

		const withIgnored = computeWatchdogRepoChangeSignature(repo);
		assert.ok(withIgnored);
		assert.equal(withIgnored.key, baseline.key);
		assert.deepEqual(withIgnored.changedPaths, []);
	});
});
