/**
 * Tests for skill discovery from settings-defined sources.
 */

import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { createTempDir, removeTempDir, tryImport } from "./helpers.ts";

const skillsModule = await tryImport<any>("./skills.ts");
const available = !!skillsModule;

const resolveSkills = skillsModule?.resolveSkills;
const clearSkillCache = skillsModule?.clearSkillCache;

const tempDirs: string[] = [];

afterEach(() => {
	clearSkillCache?.();
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) removeTempDir(dir);
	}
});

function writeJson(filePath: string, value: unknown): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function writeSkill(rootDir: string, name: string, description = `Skill ${name}`): string {
	const skillPath = path.join(rootDir, name, "SKILL.md");
	fs.mkdirSync(path.dirname(skillPath), { recursive: true });
	fs.writeFileSync(
		skillPath,
		`---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nUse ${name}.\n`,
	);
	return skillPath;
}

describe("skill discovery from settings", { skip: !available ? "pi packages not available" : undefined }, () => {
	it("resolves skills from local path packages declared in project settings", () => {
		const cwd = createTempDir("pi-subagents-skills-");
		tempDirs.push(cwd);
		const packageRoot = path.join(cwd, "vendor", "local-reviewers");
		writeJson(path.join(packageRoot, "package.json"), {
			name: "local-reviewers",
			pi: {
				skills: ["./skills"],
			},
		});
		writeSkill(path.join(packageRoot, "skills"), "local-reviewer-from-package");
		writeJson(path.join(cwd, ".pi", "settings.json"), {
			packages: [
				{
					source: "../vendor/local-reviewers",
				},
			],
		});

		const result = resolveSkills(["local-reviewer-from-package"], cwd);
		assert.equal(result.missing.length, 0);
		assert.equal(result.resolved.length, 1);
		assert.equal(result.resolved[0].name, "local-reviewer-from-package");
		assert.equal(result.resolved[0].source, "project-package");
		assert.ok(result.resolved[0].path.endsWith(path.join("local-reviewer-from-package", "SKILL.md")));
	});

	it("falls back to conventional package skills directory for local packages", () => {
		const cwd = createTempDir("pi-subagents-skills-");
		tempDirs.push(cwd);
		const packageRoot = path.join(cwd, "vendor", "convention-reviewers");
		writeJson(path.join(packageRoot, "package.json"), {
			name: "convention-reviewers",
		});
		writeSkill(path.join(packageRoot, "skills"), "convention-reviewer");
		writeJson(path.join(cwd, ".pi", "settings.json"), {
			packages: ["../vendor/convention-reviewers"],
		});

		const result = resolveSkills(["convention-reviewer"], cwd);
		assert.equal(result.missing.length, 0);
		assert.equal(result.resolved.length, 1);
		assert.equal(result.resolved[0].source, "project-package");
	});

	it("honors excluded skill paths from settings skill entries", () => {
		const cwd = createTempDir("pi-subagents-skills-");
		tempDirs.push(cwd);
		const externalSkillsRoot = path.join(cwd, "external-skills");
		writeSkill(externalSkillsRoot, "allowed-reviewer");
		writeSkill(externalSkillsRoot, "blocked-reviewer");
		writeJson(path.join(cwd, ".pi", "settings.json"), {
			skills: [
				"../external-skills",
				"-../external-skills/blocked-reviewer",
			],
		});

		const result = resolveSkills(["allowed-reviewer", "blocked-reviewer"], cwd);
		assert.deepEqual(result.resolved.map((skill: { name: string }) => skill.name), ["allowed-reviewer"]);
		assert.deepEqual(result.missing, ["blocked-reviewer"]);
	});
});
