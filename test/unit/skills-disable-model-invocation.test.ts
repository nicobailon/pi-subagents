import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { AgentConfig } from "../../src/agents/agents.ts";
import { recommendProactiveSkillSubagents } from "../../src/agents/proactive-skills.ts";
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
	options: { description?: string; disableModelInvocation?: boolean | string } = {},
): void {
	fs.mkdirSync(skillDir, { recursive: true });
	const lines = ["---"];
	lines.push(`description: ${options.description ?? "Test description"}`);
	if (options.disableModelInvocation !== undefined) lines.push(`disable-model-invocation: ${options.disableModelInvocation}`);
	lines.push("---", "", body, "");
	fs.writeFileSync(path.join(skillDir, "SKILL.md"), lines.join("\n"), "utf-8");
}

function makeProjectSkill(
	cwd: string,
	name: string,
	body: string,
	options: { description?: string; disableModelInvocation?: boolean | string } = {},
): void {
	writeSkill(path.join(cwd, ".pi", "skills", name), body, options);
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

	it("carries disableModelInvocation through name-level source precedence", () => {
		// Two DIFFERENT files that share the skill name: a cwd-level settings
		// skill (project-settings) and a .pi/skills project skill. Name-level
		// dedup (chooseHigherPrioritySkill in getCachedSkills) keeps the higher-
		// priority project entry; that entry must carry the flag read from its own
		// file. This is the real path by which a flagged project skill wins over an
		// unflagged same-named settings skill.
		const settingsSkillDir = path.join(tempDir, "skills", "upgrade-skill");
		writeSkill(settingsSkillDir, "Settings body.");
		const settingsFile = path.join(tempDir, ".pi", "settings.json");
		fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
		fs.writeFileSync(settingsFile, JSON.stringify({ skills: ["../skills"] }, null, 2), "utf-8");

		makeProjectSkill(tempDir, "upgrade-skill", "Project body.", { disableModelInvocation: true });

		clearSkillCache();
		const winner = discoverAvailableSkills(tempDir).find((skill) => skill.name === "upgrade-skill");
		assert.equal(winner?.source, "project");
		assert.equal(winner?.disableModelInvocation, true);
	});

	it("matches host YAML boolean semantics in injection and proactive recommendations", () => {
		const cases = [
			{ name: "plain-true", value: "true", hidden: true },
			{ name: "quoted-true", value: '"true"', hidden: false },
			{ name: "title-true", value: "True", hidden: true },
			{ name: "upper-true", value: "TRUE", hidden: true },
			{ name: "plain-false", value: "false", hidden: false },
			{ name: "plain-yes", value: "yes", hidden: false },
		] as const;
		for (const testCase of cases) {
			makeProjectSkill(tempDir, testCase.name, `${testCase.name} body.`, {
				disableModelInvocation: testCase.value,
			});
		}

		const availableSkills = discoverAvailableSkills(tempDir);
		for (const testCase of cases) {
			const skill = availableSkills.find((entry) => entry.name === testCase.name);
			assert.equal(skill?.disableModelInvocation, testCase.hidden ? true : undefined, testCase.name);
		}

		const names = cases.map((testCase) => testCase.name);
		const { resolved } = resolveSkills(names, tempDir);
		const injection = buildSkillInjection(resolved);
		for (const testCase of cases) {
			const matcher = new RegExp(`<name>${testCase.name}</name>`);
			testCase.hidden ? assert.doesNotMatch(injection, matcher) : assert.match(injection, matcher);
		}

		const agents: AgentConfig[] = ["one", "two"].map((name) => ({
			name,
			description: `${name} agent`,
			systemPrompt: "",
			systemPromptMode: "replace",
			inheritProjectContext: false,
			inheritSkills: false,
			source: "project",
			filePath: `/tmp/${name}.md`,
			skills: names,
		}));
		const recommendations = recommendProactiveSkillSubagents({ agents, availableSkills });
		assert.deepEqual(
			recommendations.map((entry) => entry.skill),
			["plain-false", "plain-yes", "quoted-true"],
		);
	});
});
