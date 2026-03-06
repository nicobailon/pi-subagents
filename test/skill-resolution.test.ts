/**
 * Focused tests for skill discovery sources.
 *
 * - settings.packages entries (project) are expanded and read via package.json
 * - task-level cwd resolves local package skills from cwd/package.json
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import type { MockPi } from "./helpers.ts";
import {
	createMockPi,
	createTempDir,
	makeAgent,
	removeTempDir,
	tryImport,
} from "./helpers.ts";

const skillsMod = await tryImport<any>("./skills.ts");
const executionMod = await tryImport<any>("./execution.ts");
const available = !!(skillsMod && executionMod);

const { resolveSkills, clearSkillCache } = skillsMod ?? {};
const runSync = executionMod?.runSync;

function makePkgWithSkill(packageRoot: string, skillName: string) {
	const packageJsonPath = path.join(packageRoot, "package.json");
	const skillDir = path.join(packageRoot, "skills", skillName);
	const skillPath = path.join(skillDir, "SKILL.md");

	fs.mkdirSync(skillDir, { recursive: true });
	fs.writeFileSync(
		packageJsonPath,
		JSON.stringify({ name: `${skillName}-pkg`, pi: { skills: ["skills"] }, version: "1.0.0" }),
		"utf-8",
	);
	fs.writeFileSync(
		skillPath,
		`---\nname: ${skillName}\ndescription: Test skill ${skillName}\n---\nContent\n`,
		"utf-8",
	);
}

if (available) {
	describe("resolveSkills with settings.packages", () => {
		it("discovers skills from project settings packages", () => {
			const cwd = createTempDir("subagent-skill-settings-");
			const pkgRoot = path.join(cwd, ".pi", "packages", "local-skill-pkg");
			makePkgWithSkill(pkgRoot, "settings-package-skill");

			const settingsDir = path.join(cwd, ".pi");
			fs.mkdirSync(settingsDir, { recursive: true });
			fs.writeFileSync(
				path.join(settingsDir, "settings.json"),
				JSON.stringify({
					packages: [
						{
							source: "./packages/local-skill-pkg",
						},
					],
				}, null, 2),
				"utf-8",
			);

			clearSkillCache?.();
			try {
				const result = resolveSkills(["settings-package-skill"], cwd);

				assert.equal(result.missing.length, 0, "should not miss settings package skill");
				assert.equal(result.resolved.length, 1, "should resolve one skill");
				assert.equal(result.resolved[0]!.name, "settings-package-skill");
				assert.ok(result.resolved[0]!.path.includes("skills"));
			} finally {
				removeTempDir(cwd);
			}
		});
	});

	describe("resolveSkills with execution cwd override", () => {
		it("uses effective step cwd for skill lookup in runSync", async () => {
			const mockPi: MockPi = createMockPi();
			mockPi.install();
			mockPi.onCall({ output: "ok" });
			let runtimeCwd: string | undefined;
			try {
				runtimeCwd = createTempDir("subagent-runtime-");
				const taskCwd = path.join(runtimeCwd, "step");
				fs.mkdirSync(taskCwd, { recursive: true });
				makePkgWithSkill(taskCwd, "runtime-package-skill");

				const agents = [makeAgent("worker", { skills: ["runtime-package-skill"] })];
				const result = await runSync(runtimeCwd, agents, "worker", "Run", {
					cwd: taskCwd,
				});

				assert.equal(result.exitCode, 0);
				assert.ok(result.skills?.includes("runtime-package-skill"));
			} finally {
				mockPi.uninstall();
				clearSkillCache?.();
				if (runtimeCwd) removeTempDir(runtimeCwd);
			}
		});
	});
}
