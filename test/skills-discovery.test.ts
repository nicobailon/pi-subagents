/**
 * Tests for skill discovery inputs from settings and package paths.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	createTempDir,
	removeTempDir,
	tryImport,
} from "./helpers.ts";

const skills = await tryImport<any>("./skills.ts");
const available = !!skills;

async function importSkillsFresh(): Promise<any> {
	const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
	const modulePath = path.resolve(projectRoot, "skills.ts");
	const bust = `${Date.now()}-${Math.random()}`;
	return await import(`${pathToFileURL(modulePath).href}?bust=${bust}`);
}

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
		it("loads local package skills from project and user settings", async () => {
			const tempDir = createTempDir("skill-discovery-project-");
			const projectRoot = path.join(tempDir, "project");
			const projectPackageRoot = path.join(projectRoot, ".pi", "project-pkg");
			const projectSettingsPath = path.join(projectRoot, ".pi", "settings.json");

			const fakeHome = path.join(tempDir, "fake-home");
			const userAgentDir = path.join(fakeHome, ".pi", "agent");
			const userPackageRoot = path.join(userAgentDir, "user-pkg");
			const userSettingsPath = path.join(userAgentDir, "settings.json");

			const projectSkill = "proj-settings-skill";
			const userSkill = "user-settings-skill";
			const previousHome = process.env.HOME;
			const previousUserProfile = process.env.USERPROFILE;

			try {
				process.env.HOME = fakeHome;
				process.env.USERPROFILE = fakeHome;

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

				const fresh = await importSkillsFresh();
				fresh.clearSkillCache?.();
				const discovered = fresh.discoverAvailableSkills(projectRoot).map((s: any) => s.name);
				assert.ok(
					discovered.includes(projectSkill),
					"should include project package skill",
				);
				assert.ok(
					discovered.includes(userSkill),
					"should include user package skill",
				);
			} finally {
				if (previousHome === undefined) delete process.env.HOME;
				else process.env.HOME = previousHome;
				if (previousUserProfile === undefined) delete process.env.USERPROFILE;
				else process.env.USERPROFILE = previousUserProfile;
				removeTempDir(tempDir);
			}
		});

		it("keeps user scope when cwd includes the user agent dir", async () => {
			const tempDir = createTempDir("skill-discovery-home-overlap-");
			const fakeHome = path.join(tempDir, "fake-home");
			const userAgentDir = path.join(fakeHome, ".pi", "agent");
			const userSettingsPath = path.join(userAgentDir, "settings.json");
			const userSkill = "user-home-overlap-skill";
			const customSkillDir = path.join(userAgentDir, "custom", userSkill);
			const previousHome = process.env.HOME;
			const previousUserProfile = process.env.USERPROFILE;

			try {
				process.env.HOME = fakeHome;
				process.env.USERPROFILE = fakeHome;

				fs.mkdirSync(customSkillDir, { recursive: true });
				fs.writeFileSync(
					path.join(customSkillDir, "SKILL.md"),
					`---\nname: ${userSkill}\ndescription: overlap test skill\n---\nbody\n`,
					"utf-8",
				);
				fs.mkdirSync(path.dirname(userSettingsPath), { recursive: true });
				fs.writeFileSync(
					userSettingsPath,
					JSON.stringify({ skills: ["./custom"] }, null, 2),
					"utf-8",
				);

				const fresh = await importSkillsFresh();
				fresh.clearSkillCache?.();
				const discovered = fresh.discoverAvailableSkills(fakeHome);
				const overlapSkill = discovered.find((s: any) => s.name === userSkill);
				assert.ok(overlapSkill, "should include overlap user skill");
				assert.equal(overlapSkill.source, "user");
			} finally {
				if (previousHome === undefined) delete process.env.HOME;
				else process.env.HOME = previousHome;
				if (previousUserProfile === undefined) delete process.env.USERPROFILE;
				else process.env.USERPROFILE = previousUserProfile;
				removeTempDir(tempDir);
			}
		});
	},
);
