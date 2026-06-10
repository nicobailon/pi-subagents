import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	clearSkillCache,
	discoverAvailableSkills,
	resolveSkills,
	resolveSkillsWithFallback,
} from "../../src/agents/skills.ts";

let tempDir = "";

function makeProjectSkill(cwd: string, name: string, body: string): void {
	const skillDir = path.join(cwd, ".pi", "skills", name);
	fs.mkdirSync(skillDir, { recursive: true });
	fs.writeFileSync(
		path.join(skillDir, "SKILL.md"),
		`---\ndescription: Test description\n---\n\n${body}\n`,
		"utf-8",
	);
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

	it("resolves and reads skill content via filesystem fallback", () => {
		makeProjectSkill(tempDir, "resolve-skill", "Run local fallback checks.");

		const { resolved, missing } = resolveSkills(["resolve-skill"], tempDir);
		assert.deepEqual(missing, []);
		assert.equal(resolved.length, 1);
		assert.equal(resolved[0]?.name, "resolve-skill");
		assert.equal(resolved[0]?.source, "project");
		assert.match(resolved[0]?.content ?? "", /Run local fallback checks\./);
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

	it("prefers project-package skills over legacy project .agents skills with the same name", () => {
		makeProjectPackageSkill(tempDir, "test-skill-package", "legacy-shadowed-skill", "Package version");
		const legacySkillDir = path.join(tempDir, ".agents", "skills", "legacy-shadowed-skill");
		fs.mkdirSync(legacySkillDir, { recursive: true });
		fs.writeFileSync(path.join(legacySkillDir, "SKILL.md"), "Legacy version\n", "utf-8");

		const { resolved, missing } = resolveSkills(["legacy-shadowed-skill"], tempDir);
		assert.deepEqual(missing, []);
		assert.equal(resolved.length, 1);
		assert.equal(resolved[0]?.source, "project-package");
		assert.match(resolved[0]?.content ?? "", /Package version/);
	});

	it("prefers user-package skills over legacy user ~/.agents skills with the same name", async () => {
		const fakeHome = path.join(tempDir, "fake-home");
		const userAgentDir = path.join(fakeHome, ".pi", "agent");
		const userPackageRoot = path.join(userAgentDir, "npm", "node_modules", "legacy-shadow-package");
		const legacySkillDir = path.join(fakeHome, ".agents", "skills", "legacy-user-shadowed-skill");
		const previousHome = process.env.HOME;
		const previousUserProfile = process.env.USERPROFILE;

		try {
			process.env.HOME = fakeHome;
			process.env.USERPROFILE = fakeHome;
			makePackageSkill(userPackageRoot, "legacy-user-shadowed-skill", "User package version.", "legacy-shadow-package");
			fs.mkdirSync(legacySkillDir, { recursive: true });
			fs.writeFileSync(path.join(legacySkillDir, "SKILL.md"), "Legacy user version.\n", "utf-8");

			const fresh = await importSkillsFresh();
			fresh.clearSkillCache();
			const { resolved, missing } = fresh.resolveSkills(["legacy-user-shadowed-skill"], tempDir);
			assert.deepEqual(missing, []);
			assert.equal(resolved.length, 1);
			assert.equal(resolved[0]?.source, "user-package");
			assert.match(resolved[0]?.content ?? "", /User package version/);
		} finally {
			if (previousHome === undefined) delete process.env.HOME;
			else process.env.HOME = previousHome;
			if (previousUserProfile === undefined) delete process.env.USERPROFILE;
			else process.env.USERPROFILE = previousUserProfile;
		}
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
