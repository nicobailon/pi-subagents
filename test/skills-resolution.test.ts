/**
 * Tests for skill discovery from local package declarations.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { createTempDir, removeTempDir, tryImport } from "./helpers.ts";

const skillsModule = await tryImport<any>("./skills.ts");
const available = !!skillsModule;
const resolveSkills = skillsModule?.resolveSkills;
const clearSkillCache = skillsModule?.clearSkillCache;

function writeSkillPackage(pkgDir: string, skillName: string): void {
	const skillDir = path.join(pkgDir, "skills", skillName);
	fs.mkdirSync(skillDir, { recursive: true });
	fs.writeFileSync(
		path.join(pkgDir, "package.json"),
		JSON.stringify(
			{
				name: `pkg-${skillName}`,
				version: "1.0.0",
				pi: { skills: [`./skills/${skillName}`] },
			},
			null,
			2,
		),
		"utf-8",
	);
	fs.writeFileSync(
		path.join(skillDir, "SKILL.md"),
		`---
name: ${skillName}
description: Package skill for ${skillName}
---
Loaded from package\n`,
		"utf-8",
	);
}

function writeProjectSettings(dir: string, value: string): void {
	const piDir = path.join(dir, ".pi");
	fs.mkdirSync(piDir, { recursive: true });
	fs.writeFileSync(path.join(piDir, "settings.json"), value, "utf-8");
}

describe("settings.packages local package discovery", { skip: !available ? "pi packages not available" : undefined }, () => {
	it("discovers skills from settings.packages string form", () => {
		const tempDir = createTempDir("pi-subagent-pkg-");
		try {
			const localPackage = path.join(tempDir, ".pi", "local-package");
			writeSkillPackage(localPackage, "pkg-settings-string");
			writeProjectSettings(
				tempDir,
				JSON.stringify({ packages: ["./local-package"] }),
			);
			clearSkillCache?.();

			const result = resolveSkills(["pkg-settings-string"], tempDir);
			assert.equal(result.missing.length, 0);
			assert.equal(result.resolved.length, 1);
			assert.equal(result.resolved[0]!.name, "pkg-settings-string");
		} finally {
			removeTempDir(tempDir);
		}
	});

	it("discovers skills from settings.packages object form", () => {
		const tempDir = createTempDir("pi-subagent-pkg-");
		try {
			const localPackage = path.join(tempDir, ".pi", "local-package-obj");
			writeSkillPackage(localPackage, "pkg-settings-object");
			writeProjectSettings(
				tempDir,
				JSON.stringify({ packages: [{ source: "./local-package-obj" }] }),
			);
			clearSkillCache?.();

			const result = resolveSkills(["pkg-settings-object"], tempDir);
			assert.equal(result.missing.length, 0);
			assert.equal(result.resolved.length, 1);
			assert.equal(result.resolved[0]!.name, "pkg-settings-object");
		} finally {
			removeTempDir(tempDir);
		}
	});

	it("discovers skills from settings.packages file URI form", () => {
		const tempDir = createTempDir("pi-subagent-pkg-");
		try {
			const localPackage = path.join(tempDir, ".pi", "local-package-file-uri");
			writeSkillPackage(localPackage, "pkg-settings-file-uri");
			writeProjectSettings(
				tempDir,
				JSON.stringify({ packages: ["file:./local-package-file-uri"] }),
			);
			clearSkillCache?.();

			const result = resolveSkills(["pkg-settings-file-uri"], tempDir);
			assert.equal(result.missing.length, 0);
			assert.equal(result.resolved.length, 1);
			assert.equal(result.resolved[0]!.name, "pkg-settings-file-uri");
		} finally {
			removeTempDir(tempDir);
		}
	});

	it("discovers skills from cwd package.json pi.skills", () => {
		const tempDir = createTempDir("pi-subagent-cwd-pkg-");
		try {
			writeSkillPackage(tempDir, "cwd-package-skill");
			clearSkillCache?.();

			const result = resolveSkills(["cwd-package-skill"], tempDir);
			assert.equal(result.missing.length, 0);
			assert.equal(result.resolved.length, 1);
			assert.equal(result.resolved[0]!.name, "cwd-package-skill");
		} finally {
			removeTempDir(tempDir);
		}
	});

	it("marks cwd package skills with project-package source", () => {
		const tempDir = createTempDir("pi-subagent-cwd-pkg-src-");
		const sourceSkill = `cwd-package-source-${Date.now()}`;
		try {
			writeSkillPackage(tempDir, sourceSkill);
			clearSkillCache?.();

			const result = resolveSkills([sourceSkill], tempDir);
			assert.equal(result.missing.length, 0);
			assert.equal(result.resolved.length, 1);
			assert.equal(result.resolved[0]!.name, sourceSkill);
			assert.equal(result.resolved[0]!.source, "project-package");
		} finally {
			removeTempDir(tempDir);
		}
	});
});
