import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { getConfigDirName, PI_CODING_AGENT_PACKAGE_ROOT_ENV, resolveConfigDirName } from "../../src/shared/utils.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
let previousPackageRootEnv: string | undefined;

describe("config directory resolution", () => {
	beforeEach(() => {
		previousPackageRootEnv = process.env[PI_CODING_AGENT_PACKAGE_ROOT_ENV];
		delete process.env[PI_CODING_AGENT_PACKAGE_ROOT_ENV];
	});

	afterEach(() => {
		if (previousPackageRootEnv === undefined) delete process.env[PI_CODING_AGENT_PACKAGE_ROOT_ENV];
		else process.env[PI_CODING_AGENT_PACKAGE_ROOT_ENV] = previousPackageRootEnv;
	});

	it("falls back without importing the Pi peer package at runtime", () => {
		assert.equal(resolveConfigDirName(), ".pi");
		assert.equal(getConfigDirName(), ".pi");
	});

	it("honors an explicitly provided Pi module shape", () => {
		assert.equal(resolveConfigDirName({ CONFIG_DIR_NAME: ".custom-pi" }), ".custom-pi");
		assert.equal(resolveConfigDirName({ CONFIG_DIR_NAME: "" }), ".pi");
	});

	it("honors Pi package metadata without importing the peer package", () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-config-dir-"));
		try {
			const packageRoot = path.join(tempDir, "coding-agent");
			const distDir = path.join(packageRoot, "dist");
			fs.mkdirSync(distDir, { recursive: true });
			const cliPath = path.join(distDir, "cli.js");
			fs.writeFileSync(cliPath, "", "utf-8");
			fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({
				name: "@earendil-works/pi-coding-agent",
				piConfig: { configDir: ".custom-pi" },
			}), "utf-8");

			assert.equal(resolveConfigDirName(undefined, cliPath), ".custom-pi");
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("uses an explicit Pi package root before the process entrypoint walk", () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-config-root-"));
		try {
			const packageRoot = path.join(tempDir, "coding-agent-root");
			fs.mkdirSync(packageRoot, { recursive: true });
			fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({
				name: "@earendil-works/pi-coding-agent",
				piConfig: { configDir: ".root-pi" },
			}), "utf-8");

			assert.equal(resolveConfigDirName(undefined, undefined, packageRoot), ".root-pi");
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("does not runtime-import the coding agent peer from shared utils", () => {
		const source = fs.readFileSync(path.join(repoRoot, "src/shared/utils.ts"), "utf-8");
		assert.doesNotMatch(source, /import\s+[^;]*from\s+["']@earendil-works\/pi-coding-agent["']/);
	});
});
