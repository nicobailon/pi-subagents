import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	buildSkillInjection,
	clearSkillCache,
	discoverAvailableSkills,
	resolveSkills,
} from "../../src/agents/skills.ts";
let tempDir = "";

function writeSkill(
	skillDir: string,
	body: string,
	options: { description?: string; disableModelInvocation?: boolean } = {},
): void {
	fs.mkdirSync(skillDir, { recursive: true });
	const lines = ["---"];
	lines.push(`description: ${options.description ?? "Test description"}`);
	if (options.disableModelInvocation) lines.push("disable-model-invocation: true");
	lines.push("---", "", body, "");
	fs.writeFileSync(path.join(skillDir, "SKILL.md"), lines.join("\n"), "utf-8");
}

function makeProjectSkill(
	cwd: string,
	name: string,
	body: string,
	options: { description?: string; disableModelInvocation?: boolean } = {},
): void {
	writeSkill(path.join(cwd, ".pi", "skills", name), body, options);
}

function makeProjectPackageSkill(cwd: string, packageName: string, name: string, body: string): void {
	const packageRoot = path.join(cwd, ".pi", "npm", "node_modules", packageName);
	const skillDir = path.join(packageRoot, "skills", name);
	fs.mkdirSync(skillDir, { recursive: true });
	fs.writeFileSync(
		path.join(packageRoot, "package.json"),
		JSON.stringify({ name: packageName, version: "1.0.0", pi: { skills: ["./skills"] } }, null, 2),
		"utf-8",
	);
	fs.writeFileSync(path.join(skillDir, "SKILL.md"), `${body}\n`, "utf-8");
}

describe("disable-model-invocation filtering", () => {
	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-skills-disable-invocation-"));
		clearSkillCache();
	});

	afterEach(() => {
		clearSkillCache();
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it("exposes disableModelInvocation metadata when a skill opts out of model invocation", () => {
		makeProjectSkill(tempDir, "hidden-skill", "User-only skill body.", { disableModelInvocation: true });
		makeProjectSkill(tempDir, "visible-skill", "Model-invocable body.");

		const skills = discoverAvailableSkills(tempDir);
		const hidden = skills.find((skill) => skill.name === "hidden-skill");
		const visible = skills.find((skill) => skill.name === "visible-skill");

		assert.ok(hidden, "expected hidden-skill to be discovered for user tooling");
		assert.equal(hidden?.disableModelInvocation, true);
		assert.equal(visible?.disableModelInvocation, undefined);
	});

	it("still resolves hidden skills when they are named explicitly", () => {
		makeProjectSkill(tempDir, "hidden-skill", "User-only skill body.", { disableModelInvocation: true });

		const { resolved, missing } = resolveSkills(["hidden-skill"], tempDir);
		assert.deepEqual(missing, []);
		assert.equal(resolved.length, 1);
		assert.equal(resolved[0]?.name, "hidden-skill");
		assert.match(resolved[0]?.content ?? "", /User-only skill body\./);
		assert.equal(resolved[0]?.disableModelInvocation, true);
	});

	it("buildSkillInjection filters hidden skills even when the caller resolves them by name", () => {
		// Simulate the default-injection path: the caller resolves every discovered
		// skill name (including hidden ones) and hands the full list to
		// buildSkillInjection. Production filtering must drop the hidden entry.
		makeProjectSkill(tempDir, "hidden-skill", "User-only skill body.", { disableModelInvocation: true });
		makeProjectSkill(tempDir, "visible-skill", "Model-invocable body.");

		const allNames = discoverAvailableSkills(tempDir).map((skill) => skill.name);
		assert.ok(allNames.includes("hidden-skill"), "expected hidden-skill to be resolvable");
		const { resolved } = resolveSkills(allNames, tempDir);
		assert.equal(resolved.some((skill) => skill.name === "hidden-skill"), true);

		const injection = buildSkillInjection(resolved);
		assert.match(injection, /<name>visible-skill<\/name>/);
		assert.doesNotMatch(injection, /<name>hidden-skill<\/name>/);
		assert.doesNotMatch(injection, /User-only skill body/);
	});

	it("buildSkillInjection returns empty when every resolved skill is hidden", () => {
		makeProjectSkill(tempDir, "only-hidden", "User-only skill body.", { disableModelInvocation: true });
		const { resolved } = resolveSkills(["only-hidden"], tempDir);
		assert.equal(buildSkillInjection(resolved), "");
	});

	it("re-reads disableModelInvocation when the same file is re-registered at a higher-priority source", () => {
		// pushEntry's same-file priority-upgrade branch strips old metadata and
		// re-reads it; the flag must survive even when only one source sees it.
		makeProjectSkill(tempDir, "upgrade-skill", "Upgrade body.", { disableModelInvocation: true });
		const discovered = discoverAvailableSkills(tempDir).find((skill) => skill.name === "upgrade-skill");
		assert.equal(discovered?.disableModelInvocation, true);
		// Re-registering via a second, lower-priority source must not clear the flag.
		makeProjectPackageSkill(tempDir, "upgrade-skill-pkg", "upgrade-skill", "Package version.");
		clearSkillCache();
		const after = discoverAvailableSkills(tempDir).find((skill) => skill.name === "upgrade-skill");
		assert.equal(after?.source, "project");
		assert.equal(after?.disableModelInvocation, true);
	});

	it("treats non-'true' disable-model-invocation values as model-invocable", () => {
		fs.mkdirSync(path.join(tempDir, ".pi", "skills", "loose-skill"), { recursive: true });
		fs.writeFileSync(
			path.join(tempDir, ".pi", "skills", "loose-skill", "SKILL.md"),
			"---\ndescription: Loose flag\ndisable-model-invocation: yes\n---\n\nBody\n",
			"utf-8",
		);

		const skill = discoverAvailableSkills(tempDir).find((entry) => entry.name === "loose-skill");
		assert.equal(skill?.disableModelInvocation, undefined);
	});
});
