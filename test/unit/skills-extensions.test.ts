import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	buildLightSkillInjection,
	buildSkillInjection,
	clearSkillCache,
	discoverAvailableSkills,
	resolveSkills,
} from "../../src/agents/skills.ts";

let tempDir = "";

function writeSkill(skillRoot: string, body: string, description = "Test description"): void {
	fs.mkdirSync(skillRoot, { recursive: true });
	fs.writeFileSync(
		path.join(skillRoot, "SKILL.md"),
		`---\ndescription: ${description}\n---\n\n${body}\n`,
		"utf-8",
	);
}

describe("skills nested-directory discovery", () => {
	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-skills-nested-"));
		clearSkillCache();
	});

	afterEach(() => {
		clearSkillCache();
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it("discovers a skill placed two levels under a project skill root", () => {
		// Layout: <cwd>/.pi/skills/<group>/<skill-name>/SKILL.md
		// pi-coding-agent already supports this; pi-subagents must too so
		// frontmatter `skills:` in the matching agent can resolve them.
		writeSkill(path.join(tempDir, ".pi", "skills", "consultant", "market-sizing"), "Estimate TAM/SAM/SOM.");

		const skills = discoverAvailableSkills(tempDir);
		const found = skills.find((s) => s.name === "market-sizing");
		assert.ok(found, "expected market-sizing under consultant/ to be discovered");
		assert.equal(found?.source, "project");
	});

	it("does not recurse past the first SKILL.md it finds (skill-root anchor)", () => {
		// If <root>/SKILL.md exists, deeper SKILL.md files inside the same root
		// should be ignored — that whole subtree belongs to the parent skill.
		const skillRoot = path.join(tempDir, ".pi", "skills", "outer");
		writeSkill(skillRoot, "Outer body");
		writeSkill(path.join(skillRoot, "nested-helper"), "Nested body");

		const skills = discoverAvailableSkills(tempDir);
		const outer = skills.find((s) => s.name === "outer");
		const nested = skills.find((s) => s.name === "nested-helper");
		assert.ok(outer, "expected outer to be discovered");
		assert.equal(nested, undefined, "nested-helper inside outer/ should be hidden by outer's SKILL.md");
	});

	it("skips node_modules and hidden directories during recursion", () => {
		writeSkill(path.join(tempDir, ".pi", "skills", "node_modules", "should-not-find"), "Hidden by node_modules");
		writeSkill(path.join(tempDir, ".pi", "skills", ".hidden", "should-not-find-either"), "Hidden by dotfile");
		writeSkill(path.join(tempDir, ".pi", "skills", "real", "real-skill"), "Real");

		const skills = discoverAvailableSkills(tempDir);
		assert.equal(skills.find((s) => s.name === "should-not-find"), undefined);
		assert.equal(skills.find((s) => s.name === "should-not-find-either"), undefined);
		assert.ok(skills.find((s) => s.name === "real-skill"), "real-skill should be discovered");
	});

	it("resolves a deeply-nested skill via resolveSkills", () => {
		writeSkill(path.join(tempDir, ".pi", "skills", "marketing", "copywriting"), "Write CTAs.");

		const { resolved, missing } = resolveSkills(["copywriting"], tempDir);
		assert.deepEqual(missing, []);
		assert.equal(resolved.length, 1);
		assert.equal(resolved[0]?.name, "copywriting");
		assert.match(resolved[0]?.content ?? "", /Write CTAs\./);
	});
});

describe("buildLightSkillInjection", () => {
	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-skills-light-"));
		clearSkillCache();
	});

	afterEach(() => {
		clearSkillCache();
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it("emits name + description + location, never the full SKILL.md body", () => {
		writeSkill(
			path.join(tempDir, ".pi", "skills", "long-skill"),
			"This body is very long and should NOT appear in light injection.\n".repeat(10),
			"Short description for light mode",
		);

		const { resolved } = resolveSkills(["long-skill"], tempDir);
		assert.equal(resolved.length, 1);

		const light = buildLightSkillInjection(resolved);
		assert.match(light, /<name>long-skill<\/name>/);
		assert.match(light, /<description>Short description for light mode<\/description>/);
		assert.match(light, /<location>/);
		assert.doesNotMatch(light, /This body is very long/, "full SKILL.md body must not leak in light mode");
	});

	it("falls back gracefully when description is missing", () => {
		const skillRoot = path.join(tempDir, ".pi", "skills", "no-desc");
		fs.mkdirSync(skillRoot, { recursive: true });
		fs.writeFileSync(path.join(skillRoot, "SKILL.md"), "no frontmatter at all\n", "utf-8");

		const { resolved } = resolveSkills(["no-desc"], tempDir);
		assert.equal(resolved.length, 1);

		const light = buildLightSkillInjection(resolved);
		assert.match(light, /<name>no-desc<\/name>/);
		assert.doesNotMatch(light, /<description>/, "no description tag when frontmatter has none");
	});

	it("returns empty string when no skills resolved", () => {
		assert.equal(buildLightSkillInjection([]), "");
	});

	it("escapes XML special characters in name, description, and location", () => {
		writeSkill(
			path.join(tempDir, ".pi", "skills", "skill-with-quotes"),
			"body",
			'Has "quotes" & <angle> brackets',
		);

		const { resolved } = resolveSkills(["skill-with-quotes"], tempDir);
		const light = buildLightSkillInjection(resolved);
		assert.match(light, /&quot;quotes&quot;/);
		assert.match(light, /&amp; &lt;angle&gt;/);
	});

	it("full injection (default) still emits full SKILL.md body", () => {
		writeSkill(path.join(tempDir, ".pi", "skills", "full-mode"), "Full body content here");

		const { resolved } = resolveSkills(["full-mode"], tempDir);
		const full = buildSkillInjection(resolved);
		assert.match(full, /Full body content here/);
		assert.match(full, /<skill name="full-mode">/);
	});
});
