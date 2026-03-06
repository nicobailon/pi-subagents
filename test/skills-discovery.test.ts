/**
 * Tests for skill discovery inputs from settings and package paths.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	createTempDir,
	removeTempDir,
	tryImport,
} from "./helpers.ts";

const skills = await tryImport<any>("./skills.ts");
const available = !!skills;

const discoverAvailableSkills = skills?.discoverAvailableSkills;
const clearSkillCache = skills?.clearSkillCache;

function writeSkillPackage(packageRoot: string, skillName: string): void {
	const skillDir = path.join(packageRoot, "skills", skillName);
	fs.mkdirSync(skillDir, { recursive: true });
	fs.writeFileSync(
		path.join(packageRoot, "package.json"),
		JSON.stringify(
			{
				name: `${skillName}-pkg`,
				version: "1.0.0",
				pi: {
					skills: ["skills"],
				},
			},
			null,
			2,
		),
		"utf-8",
	);
	fs.writeFileSync(path.join(skillDir, "SKILL.md"), `---\nname: ${skillName}\ndescription: test skill\n---\n`, "utf-8");
}

describe(
	"discoverAvailableSkills",
	{ skip: !available ? "pi packages not available" : undefined },
	() => {
		it("loads local package skills from project and user settings", () => {
			const tempDir = createTempDir("skill-discovery-project-");
			const projectRoot = path.join(tempDir, "project");
			const projectPackageRoot = path.join(projectRoot, ".pi", "project-pkg");
			const projectSettingsPath = path.join(projectRoot, ".pi", "settings.json");

			const userAgentDir = path.join(os.homedir(), ".pi", "agent");
			const userPackageRoot = path.join(userAgentDir, "user-pkg");
			const userSettingsPath = path.join(userAgentDir, "settings.json");

			const projectSkill = "proj-settings-skill";
			const userSkill = "user-settings-skill";
			const originalUserSettings = fs.existsSync(userSettingsPath)
				? fs.readFileSync(userSettingsPath, "utf-8")
				: undefined;

			try {
				writeSkillPackage(projectPackageRoot, projectSkill);
				fs.mkdirSync(path.dirname(projectSettingsPath), { recursive: true });
				fs.writeFileSync(
					projectSettingsPath,
					JSON.stringify(
						{
							packages: ["./project-pkg"],
						},
						null,
						2,
					),
					"utf-8",
				);

				writeSkillPackage(userPackageRoot, userSkill);
				fs.mkdirSync(path.dirname(userSettingsPath), { recursive: true });
				fs.writeFileSync(
					userSettingsPath,
					JSON.stringify({ packages: [{ source: "./user-pkg" }] }, null, 2),
					"utf-8",
				);

				clearSkillCache?.();
				const discovered = discoverAvailableSkills(projectRoot).map((s: any) => s.name);
				assert.ok(
					discovered.includes(projectSkill),
					"should include project package skill",
				);
				assert.ok(
					discovered.includes(userSkill),
					"should include user package skill",
				);
			} finally {
				if (originalUserSettings === undefined) {
					fs.rmSync(userSettingsPath, { force: true });
				} else {
					fs.writeFileSync(userSettingsPath, originalUserSettings, "utf-8");
				}
				fs.rmSync(userPackageRoot, { recursive: true, force: true });
				removeTempDir(tempDir);
				clearSkillCache?.();
			}
		});
	},
);
