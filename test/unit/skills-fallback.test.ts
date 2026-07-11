import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	buildSkillInjection,
	clearSkillCache,
	discoverAvailableSkills,
	resolveSkills,
	resolveSkillsWithFallback,
} from "../../src/agents/skills.ts";

let tempDir = "";

function writeSkillFile(skillDir: string, body: string, description = "Test description"): void {
	fs.mkdirSync(skillDir, { recursive: true });
	fs.writeFileSync(
		path.join(skillDir, "SKILL.md"),
		`---\ndescription: ${description}\n---\n\n${body}\n`,
		"utf-8",
	);
}

function makeProjectSkill(cwd: string, name: string, body: string, description = "Test description"): void {
	const skillDir = path.join(cwd, ".pi", "skills", name);
	writeSkillFile(skillDir, body, description);
}

function makeProjectPackageSkill(cwd: string, packageName: string, name: string, body: string): void {
	const packageRoot = path.join(cwd, ".pi", "npm", "node_modules", packageName);
	makePackageSkill(packageRoot, name, body, packageName);
}

function makePackageSkill(packageRoot: string, name: string, body: string, packageName = `${name}-pkg`): void {
	const skillDir = path.join(packageRoot, "skills", name);
	fs.mkdirSync(skillDir, { recursive: true });
	fs.writeFileSync(
		path.join(packageRoot, "package.json"),
		JSON.stringify({ name: packageName, version: "1.0.0", pi: { skills: ["./skills"] } }, null, 2),
		"utf-8",
	);
	fs.writeFileSync(path.join(skillDir, "SKILL.md"), `${body}\n`, "utf-8");
}

async function importSkillsFresh() {
	const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
	const modulePath = path.resolve(projectRoot, "src/agents/skills.ts");
	const bust = `${Date.now()}-${Math.random()}`;
	return await import(`${pathToFileURL(modulePath).href}?bust=${bust}`) as typeof import("../../src/agents/skills.ts");
}

describe("skills filesystem fallback", () => {
	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-skills-fallback-"));
		clearSkillCache();
	});

	afterEach(() => {
		clearSkillCache();
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it("discovers project skills from filesystem paths", () => {
		makeProjectSkill(tempDir, "fallback-skill", "Use fallback mode.");

		const skills = discoverAvailableSkills(tempDir);
		const discovered = skills.find((skill) => skill.name === "fallback-skill");
		assert.ok(discovered, "expected fallback-skill to be discovered");
		assert.equal(discovered?.source, "project");
		assert.equal(discovered?.description, "Test description");
	});

	it("discovers project skills nested below grouping directories", () => {
		writeSkillFile(
			path.join(tempDir, ".pi", "skills", "shell", "issue-262-nested-skill"),
			"Use nested project skill.",
			"Nested issue 262 skill",
		);

		const skills = discoverAvailableSkills(tempDir);
		const discovered = skills.find((skill) => skill.name === "issue-262-nested-skill");
		assert.ok(discovered, "expected grouped nested skill to be discovered");
		assert.equal(discovered?.source, "project");
		assert.equal(discovered?.description, "Nested issue 262 skill");

		const { resolved, missing } = resolveSkills(["issue-262-nested-skill"], tempDir);
		assert.deepEqual(missing, []);
		assert.equal(resolved.length, 1);
		assert.match(resolved[0]?.content ?? "", /Use nested project skill\./);
	});

	it("stops recursive project skill discovery at the first SKILL.md anchor", () => {
		const groupedRoot = path.join(tempDir, ".pi", "skills", "group");
		writeSkillFile(path.join(groupedRoot, "issue-262-anchor"), "Use anchor skill.");
		writeSkillFile(path.join(groupedRoot, "issue-262-anchor", "nested", "issue-262-leaked-skill"), "Should not leak.");
		writeSkillFile(path.join(groupedRoot, "issue-262-sibling"), "Use sibling skill.");

		const names = discoverAvailableSkills(tempDir).map((skill) => skill.name);
		assert.equal(names.includes("issue-262-anchor"), true);
		assert.equal(names.includes("issue-262-sibling"), true);
		assert.equal(names.includes("issue-262-leaked-skill"), false);
	});

	it("skips hidden directories and node_modules while recursing for project skills", () => {
		const groupedRoot = path.join(tempDir, ".pi", "skills", "group");
		writeSkillFile(path.join(groupedRoot, ".hidden", "issue-262-hidden-skill"), "Should stay hidden.");
		writeSkillFile(path.join(groupedRoot, "node_modules", "issue-262-node-skill"), "Should stay ignored.");
		writeSkillFile(path.join(groupedRoot, "visible", "issue-262-visible-skill"), "Use visible nested skill.");

		const names = discoverAvailableSkills(tempDir).map((skill) => skill.name);
		assert.equal(names.includes("issue-262-visible-skill"), true);
		assert.equal(names.includes("issue-262-hidden-skill"), false);
		assert.equal(names.includes("issue-262-node-skill"), false);
	});

	it("keeps direct markdown skills from explicit settings roots after parent recursion", () => {
		const groupedRoot = path.join(tempDir, ".pi", "skills", "group");
		fs.mkdirSync(groupedRoot, { recursive: true });
		fs.writeFileSync(path.join(groupedRoot, "issue-262-direct.md"), "Use direct markdown skill.\n", "utf-8");
		fs.writeFileSync(
			path.join(tempDir, ".pi", "settings.json"),
			JSON.stringify({ skills: ["./skills/group"] }, null, 2),
			"utf-8",
		);

		const { resolved, missing } = resolveSkills(["issue-262-direct"], tempDir);
		assert.deepEqual(missing, []);
		assert.equal(resolved.length, 1);
		assert.equal(resolved[0]?.source, "project-settings");
		assert.match(resolved[0]?.content ?? "", /Use direct markdown skill\./);
	});

	it("keeps nested skills from higher-priority explicit settings roots after parent recursion", () => {
		writeSkillFile(
			path.join(tempDir, "skills", "group", "issue-262-settings-nested"),
			"Use settings nested skill.",
		);
		fs.writeFileSync(
			path.join(tempDir, "package.json"),
			JSON.stringify({ name: "fixture", version: "1.0.0", pi: { skills: ["./skills"] } }, null, 2),
			"utf-8",
		);
		fs.mkdirSync(path.join(tempDir, ".pi"), { recursive: true });
		fs.writeFileSync(
			path.join(tempDir, ".pi", "settings.json"),
			JSON.stringify({ skills: ["../skills/group"] }, null, 2),
			"utf-8",
		);

		const { resolved, missing } = resolveSkills(["issue-262-settings-nested"], tempDir);
		assert.deepEqual(missing, []);
		assert.equal(resolved.length, 1);
		assert.equal(resolved[0]?.source, "project-settings");
		assert.match(resolved[0]?.content ?? "", /Use settings nested skill\./);
	});

	it("keeps nested skills from higher-priority explicit settings roots when the root path is duplicated", () => {
		writeSkillFile(
			path.join(tempDir, "skills", "group", "issue-262-settings-same-root"),
			"Use settings same root skill.",
		);
		fs.writeFileSync(
			path.join(tempDir, "package.json"),
			JSON.stringify({ name: "fixture", version: "1.0.0", pi: { skills: ["./skills"] } }, null, 2),
			"utf-8",
		);
		fs.mkdirSync(path.join(tempDir, ".pi"), { recursive: true });
		fs.writeFileSync(
			path.join(tempDir, ".pi", "settings.json"),
			JSON.stringify({ skills: ["../skills"] }, null, 2),
			"utf-8",
		);

		const { resolved, missing } = resolveSkills(["issue-262-settings-same-root"], tempDir);
		assert.deepEqual(missing, []);
		assert.equal(resolved.length, 1);
		assert.equal(resolved[0]?.source, "project-settings");
		assert.match(resolved[0]?.content ?? "", /Use settings same root skill\./);
	});

	it("resolves and reads skill content via filesystem fallback", () => {
		makeProjectSkill(tempDir, "resolve-skill", "Run local fallback checks.");

		const { resolved, missing } = resolveSkills(["resolve-skill"], tempDir);
		assert.deepEqual(missing, []);
		assert.equal(resolved.length, 1);
		assert.equal(resolved[0]?.name, "resolve-skill");
		assert.equal(resolved[0]?.source, "project");
		assert.match(resolved[0]?.content ?? "", /Run local fallback checks\./);
	});

	it("builds lazy skill references instead of inlining full skill bodies", () => {
		makeProjectSkill(tempDir, "lazy-skill", "This body should stay out of the system prompt.");

		const { resolved, missing } = resolveSkills(["lazy-skill"], tempDir);
		assert.deepEqual(missing, []);

		const injection = buildSkillInjection(resolved);
		assert.match(injection, /The following configured skills are available to this subagent/);
		assert.match(injection, /Use the read tool to load a skill's file/);
		assert.match(injection, /<available_skills>/);
		assert.match(injection, /<name>lazy-skill<\/name>/);
		assert.match(injection, /<description>Test description<\/description>/);
		assert.match(injection, /<location>.*lazy-skill.*SKILL\.md<\/location>/);
		assert.doesNotMatch(injection, /This body should stay out/);
		assert.doesNotMatch(injection, /<skill name=/);
	});

	it("escapes XML-sensitive skill metadata in lazy references", () => {
		makeProjectSkill(tempDir, "amp&skill", "Body", "Use A & B <carefully>");

		const { resolved } = resolveSkills(["amp&skill"], tempDir);
		const injection = buildSkillInjection(resolved);
		assert.match(injection, /<name>amp&amp;skill<\/name>/);
		assert.match(injection, /<description>Use A &amp; B &lt;carefully&gt;<\/description>/);
		assert.match(injection, /amp&amp;skill[\\/]SKILL\.md/);
	});

	it("does not expose pi-subagents as a child-injectable skill", () => {
		makeProjectSkill(tempDir, "pi-subagents", "Parent orchestration only.");
		makeProjectSkill(tempDir, "safe-bash", "Use safe bash.");

		const available = discoverAvailableSkills(tempDir).map((skill) => skill.name);
		assert.equal(available.includes("pi-subagents"), false);
		assert.equal(available.includes("safe-bash"), true);

		const { resolved, missing } = resolveSkills(["pi-subagents", "safe-bash"], tempDir);
		assert.deepEqual(missing, ["pi-subagents"]);
		assert.deepEqual(resolved.map((skill) => skill.name), ["safe-bash"]);
	});

	it("classifies package-provided skills as project-package", () => {
		makeProjectPackageSkill(tempDir, "test-skill-package", "pkg-skill", "Use package skill.");

		const skills = discoverAvailableSkills(tempDir);
		const discovered = skills.find((skill) => skill.name === "pkg-skill");
		assert.ok(discovered, "expected pkg-skill to be discovered");
		assert.equal(discovered?.source, "project-package");
	});

	it("prefers project skills over project-package skills with the same name", () => {
		makeProjectPackageSkill(tempDir, "test-skill-package", "shared-skill", "Package version");
		makeProjectSkill(tempDir, "shared-skill", "Project version");

		const { resolved, missing } = resolveSkills(["shared-skill"], tempDir);
		assert.deepEqual(missing, []);
		assert.equal(resolved.length, 1);
		assert.equal(resolved[0]?.source, "project");
		assert.match(resolved[0]?.content ?? "", /Project version/);
	});

	it("discovers skills from project settings packages", () => {
		const packageRoot = path.join(tempDir, ".pi", "packages", "local-skill-pkg");
		makePackageSkill(packageRoot, "settings-package-skill", "Settings package skill.");
		fs.mkdirSync(path.join(tempDir, ".pi"), { recursive: true });
		fs.writeFileSync(
			path.join(tempDir, ".pi", "settings.json"),
			JSON.stringify({ packages: ["./packages/local-skill-pkg"] }, null, 2),
			"utf-8",
		);

		const { resolved, missing } = resolveSkills(["settings-package-skill"], tempDir);
		assert.deepEqual(missing, []);
		assert.equal(resolved.length, 1);
		assert.equal(resolved[0]?.source, "project-package");
	});

	it("discovers skills from project settings npm package sources", () => {
		const packageRoot = path.join(tempDir, ".pi", "npm", "node_modules", "@scope", "skill-package");
		makePackageSkill(
			packageRoot,
			"project-settings-scoped-npm-package-skill",
			"Project settings scoped npm package skill.",
			"@scope/skill-package",
		);
		fs.mkdirSync(path.join(tempDir, ".pi"), { recursive: true });
		fs.writeFileSync(
			path.join(tempDir, ".pi", "settings.json"),
			JSON.stringify({ packages: ["npm:@scope/skill-package@1.2.3"] }, null, 2),
			"utf-8",
		);

		const { resolved, missing } = resolveSkills(["project-settings-scoped-npm-package-skill"], tempDir);
		assert.deepEqual(missing, []);
		assert.equal(resolved.length, 1);
		assert.equal(resolved[0]?.source, "project-package");
	});

	it("discovers skills from the current cwd package", () => {
		makePackageSkill(tempDir, "cwd-package-skill", "Cwd package skill.");

		const { resolved, missing } = resolveSkills(["cwd-package-skill"], tempDir);
		assert.deepEqual(missing, []);
		assert.equal(resolved.length, 1);
		assert.equal(resolved[0]?.source, "project-package");
	});

	it("falls back to the runtime cwd when the execution cwd lacks the skill", () => {
		const nestedDir = path.join(tempDir, "nested");
		fs.mkdirSync(nestedDir, { recursive: true });
		makePackageSkill(tempDir, "runtime-fallback-skill", "Runtime fallback skill.");

		const { resolved, missing } = resolveSkillsWithFallback(["runtime-fallback-skill"], nestedDir, tempDir);
		assert.deepEqual(missing, []);
		assert.equal(resolved.length, 1);
		assert.equal(resolved[0]?.source, "project-package");
	});

	it("discovers skills from user settings packages", async () => {
		const fakeHome = path.join(tempDir, "fake-home");
		const userAgentDir = path.join(fakeHome, ".pi", "agent");
		const userPackageRoot = path.join(userAgentDir, "user-pkg");
		const previousHome = process.env.HOME;
		const previousUserProfile = process.env.USERPROFILE;

		try {
			process.env.HOME = fakeHome;
			process.env.USERPROFILE = fakeHome;
			makePackageSkill(userPackageRoot, "user-settings-package-skill", "User settings package skill.");
			fs.mkdirSync(userAgentDir, { recursive: true });
			fs.writeFileSync(
				path.join(userAgentDir, "settings.json"),
				JSON.stringify({ packages: [{ source: "./user-pkg" }] }, null, 2),
				"utf-8",
			);

			const fresh = await importSkillsFresh();
			fresh.clearSkillCache();
			const discovered = fresh.discoverAvailableSkills(tempDir);
			const skill = discovered.find((entry) => entry.name === "user-settings-package-skill");
			assert.ok(skill);
			assert.equal(skill?.source, "user-package");
		} finally {
			if (previousHome === undefined) delete process.env.HOME;
			else process.env.HOME = previousHome;
			if (previousUserProfile === undefined) delete process.env.USERPROFILE;
			else process.env.USERPROFILE = previousUserProfile;
		}
	});

	it("discovers skills from user settings git package sources", async () => {
		const fakeHome = path.join(tempDir, "fake-home");
		const userAgentDir = path.join(fakeHome, ".pi", "agent");
		const packageRoot = path.join(userAgentDir, "git", "github.com", "user", "repo");
		const previousHome = process.env.HOME;
		const previousUserProfile = process.env.USERPROFILE;

		try {
			process.env.HOME = fakeHome;
			process.env.USERPROFILE = fakeHome;
			makePackageSkill(packageRoot, "user-settings-git-package-skill", "User settings git package skill.");
			fs.mkdirSync(userAgentDir, { recursive: true });
			fs.writeFileSync(
				path.join(userAgentDir, "settings.json"),
				JSON.stringify({ packages: ["git:github.com/user/repo.git@main"] }, null, 2),
				"utf-8",
			);

			const fresh = await importSkillsFresh();
			fresh.clearSkillCache();
			const discovered = fresh.discoverAvailableSkills(tempDir);
			const skill = discovered.find((entry) => entry.name === "user-settings-git-package-skill");
			assert.ok(skill);
			assert.equal(skill?.source, "user-package");
		} finally {
			if (previousHome === undefined) delete process.env.HOME;
			else process.env.HOME = previousHome;
			if (previousUserProfile === undefined) delete process.env.USERPROFILE;
			else process.env.USERPROFILE = previousUserProfile;
		}
	});

	it("discovers skills from user settings scoped npm package sources", async () => {
		const fakeHome = path.join(tempDir, "fake-home");
		const userAgentDir = path.join(fakeHome, ".pi", "agent");
		const packageRoot = path.join(userAgentDir, "npm", "node_modules", "@scope", "skill-package");
		const previousHome = process.env.HOME;
		const previousUserProfile = process.env.USERPROFILE;

		try {
			process.env.HOME = fakeHome;
			process.env.USERPROFILE = fakeHome;
			makePackageSkill(
				packageRoot,
				"user-settings-scoped-npm-package-skill",
				"User settings scoped npm package skill.",
				"@scope/skill-package",
			);
			fs.mkdirSync(userAgentDir, { recursive: true });
			fs.writeFileSync(
				path.join(userAgentDir, "settings.json"),
				JSON.stringify({ packages: [{ source: "npm:@scope/skill-package@latest" }] }, null, 2),
				"utf-8",
			);

			const fresh = await importSkillsFresh();
			fresh.clearSkillCache();
			const discovered = fresh.discoverAvailableSkills(tempDir);
			const skill = discovered.find((entry) => entry.name === "user-settings-scoped-npm-package-skill");
			assert.ok(skill);
			assert.equal(skill?.source, "user-package");
		} finally {
			if (previousHome === undefined) delete process.env.HOME;
			else process.env.HOME = previousHome;
			if (previousUserProfile === undefined) delete process.env.USERPROFILE;
			else process.env.USERPROFILE = previousUserProfile;
		}
	});

	it("resolves agent-local direct files and directories before global skills without leaking provenance", () => {
		makeProjectSkill(tempDir, "shared", "global body");
		const agentDir = path.join(tempDir, "agents", "nested");
		const directFile = path.join(agentDir, "direct.md");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.writeFileSync(directFile, "local direct body\n", "utf-8");
		writeSkillFile(path.join(agentDir, "skills", "shared"), "local shared body");
		writeSkillFile(path.join(agentDir, "skills", "directory"), "local directory body");

		const globalFirst = resolveSkills(["shared"], tempDir);
		assert.equal(globalFirst.resolved[0]?.source, "project");
		const local = resolveSkills(["shared", "direct", "directory", "missing"], tempDir, ["./skills", "./direct.md"], agentDir);
		assert.deepEqual(local.resolved.map((skill) => [skill.name, skill.source, skill.content]), [
			["shared", "agent-local", "local shared body"],
			["direct", "agent-local", "local direct body\n"],
			["directory", "agent-local", "local directory body"],
		]);
		assert.deepEqual(local.missing, ["missing"]);
		const globalAgain = resolveSkills(["shared"], tempDir);
		assert.equal(globalAgain.resolved[0]?.source, "project");
		assert.equal(globalAgain.resolved[0]?.content, "global body");
	});

	it("does not discover global skills when a valid agent-local candidate exists", () => {
		const agentDir = path.join(tempDir, "agents", "nested");
		writeSkillFile(path.join(agentDir, "skills", "local"), "local body");
		fs.mkdirSync(path.join(tempDir, ".pi"), { recursive: true });
		fs.writeFileSync(path.join(tempDir, ".pi", "settings.json"), "{bad-json", "utf-8");

		const result = resolveSkills(["local"], tempDir, ["./skills"], agentDir);
		assert.deepEqual(result.missing, []);
		assert.deepEqual(result.resolved.map((skill) => [skill.source, skill.content]), [["agent-local", "local body"]]);
	});

	it("invalidates lexical cache entries when a local skill symlink is retargeted", () => {
		const agentDir = path.join(tempDir, "agents", "nested");
		const first = path.join(tempDir, "targets", "first.md");
		const second = path.join(tempDir, "targets", "second.md");
		fs.mkdirSync(path.dirname(first), { recursive: true });
		fs.writeFileSync(first, "first body", "utf-8");
		fs.writeFileSync(second, "second body", "utf-8");
		const link = path.join(agentDir, "local.md");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.symlinkSync(first, link);
		assert.equal(resolveSkills(["local"], tempDir, ["./local.md"], agentDir).resolved[0]?.content, "first body");
		fs.unlinkSync(link);
		fs.symlinkSync(second, link);
		assert.equal(resolveSkills(["local"], tempDir, ["./local.md"], agentDir).resolved[0]?.content, "second body");
	});

	it("falls back globally when an agent-local skill file cannot be read", () => {
		makeProjectSkill(tempDir, "shared", "global body");
		const agentDir = path.join(tempDir, "agents", "nested");
		const localFile = path.join(agentDir, "skills", "shared", "SKILL.md");
		writeSkillFile(path.dirname(localFile), "local body");
		fs.chmodSync(localFile, 0);
		try {
			const result = resolveSkills(["shared"], tempDir, ["./skills"], agentDir);
			assert.deepEqual(result.resolved.map((skill) => [skill.source, skill.content]), [["project", "global body"]]);
			assert.deepEqual(result.missing, []);
		} finally {
			fs.chmodSync(localFile, 0o644);
		}
	});

	it("preserves global provenance when a global skill is read before the same agent-local file", () => {
		makeProjectSkill(tempDir, "shared", "shared body");
		const agentDir = path.join(tempDir, "agents", "nested");
		fs.mkdirSync(agentDir, { recursive: true });

		const global = resolveSkills(["shared"], tempDir);
		const local = resolveSkills(["shared"], tempDir, ["../../.pi/skills"], agentDir);

		assert.equal(global.resolved[0]?.source, "project");
		assert.equal(local.resolved[0]?.source, "agent-local");
		assert.equal(local.resolved[0]?.path, global.resolved[0]?.path);
	});

	it("preserves agent-local provenance when the same file is read before its global name", () => {
		makeProjectSkill(tempDir, "shared", "shared body");
		const agentDir = path.join(tempDir, "agents", "nested");
		fs.mkdirSync(agentDir, { recursive: true });

		const local = resolveSkills(["shared"], tempDir, ["../../.pi/skills"], agentDir);
		const global = resolveSkills(["shared"], tempDir);

		assert.equal(local.resolved[0]?.source, "agent-local");
		assert.equal(global.resolved[0]?.source, "project");
		assert.equal(local.resolved[0]?.path, global.resolved[0]?.path);
	});

	it("keeps agent-local paths isolated and falls back to global names", () => {
		makeProjectSkill(tempDir, "global-only", "global fallback");
		const one = path.join(tempDir, "one");
		const two = path.join(tempDir, "two");
		writeSkillFile(path.join(one, "skills", "private"), "one private");
		writeSkillFile(path.join(two, "skills", "private"), "two private");
		assert.equal(resolveSkills(["private", "global-only"], tempDir, ["./skills"], one).resolved[0]?.content, "one private");
		assert.equal(resolveSkills(["private", "global-only"], tempDir, ["./skills"], two).resolved[0]?.content, "two private");
		assert.equal(resolveSkills(["global-only"], tempDir, ["./skills"], one).resolved[0]?.content, "global fallback");
	});

	it("surfaces malformed project settings files instead of silently ignoring them", () => {
		fs.mkdirSync(path.join(tempDir, ".pi"), { recursive: true });
		fs.writeFileSync(path.join(tempDir, ".pi", "settings.json"), "{bad-json", "utf-8");

		assert.throws(
			() => resolveSkills(["missing-skill"], tempDir),
			/Failed to read skills settings file .+\.pi[\\/]settings\.json/,
		);
	});

	it("surfaces malformed explicit settings package manifests instead of silently ignoring them", () => {
		const packageRoot = path.join(tempDir, ".pi", "packages", "broken-package");
		fs.mkdirSync(packageRoot, { recursive: true });
		fs.writeFileSync(path.join(packageRoot, "package.json"), "{bad-json", "utf-8");
		fs.mkdirSync(path.join(tempDir, ".pi"), { recursive: true });
		fs.writeFileSync(
			path.join(tempDir, ".pi", "settings.json"),
			JSON.stringify({ packages: ["./packages/broken-package"] }, null, 2),
			"utf-8",
		);

		assert.throws(
			() => discoverAvailableSkills(tempDir),
			/Failed to read package manifest .+broken-package[\\/]package\.json/,
		);
	});
});
