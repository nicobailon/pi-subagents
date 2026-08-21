/**
 * Permission-system compatibility tests:
 * - <active_agent> tag injection into child system prompts
 * - Permission-system extension auto-detection
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
	buildPiArgs,
	resolvePermissionSystemExtension,
	resolvePiLaunchToolPlan,
} from "../../src/runs/shared/pi-args.ts";

const originalEnv = {
	HOME: process.env.HOME,
	USERPROFILE: process.env.USERPROFILE,
	PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
};
const tempRoots: string[] = [];

function createFixture() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-args-perm-"));
	tempRoots.push(root);
	const home = path.join(root, "home");
	const agentDir = path.join(home, ".pi", "agent");
	const projectDir = path.join(root, "project");
	fs.mkdirSync(agentDir, { recursive: true });
	fs.mkdirSync(projectDir, { recursive: true });
	process.env.HOME = home;
	process.env.USERPROFILE = home;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.chdir(projectDir);
	return { root, agentDir, projectDir };
}

afterEach(() => {
	for (const key of Object.keys(originalEnv)) {
		const value = originalEnv[key as keyof typeof originalEnv];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	for (const root of tempRoots) {
		try {
			fs.rmSync(root, { recursive: true, force: true });
		} catch {
			// best effort
		}
	}
	tempRoots.length = 0;
});

function readPromptFile(result: { tempDir?: string }): string {
	assert.ok(result.tempDir, "expected a temp dir from buildPiArgs");
	const files = fs.readdirSync(result.tempDir);
	const promptFile = files.find((f: string) => f.endsWith(".md"));
	assert.ok(promptFile, "expected a prompt.md file");
	return fs.readFileSync(path.join(result.tempDir, promptFile), "utf-8");
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

describe("resolvePermissionSystemExtension", () => {
	it("returns undefined when extension is not installed", () => {
		const { agentDir } = createFixture();
		process.env.PI_CODING_AGENT_DIR = agentDir;
		const result = resolvePermissionSystemExtension();
		assert.equal(result, undefined);
	});

	it("throws when an installed extension dir has no package.json", () => {
		const { agentDir } = createFixture();
		const extDir = path.join(agentDir, "extensions", "pi-permission-system");
		const pkgPath = path.join(extDir, "package.json");
		fs.mkdirSync(extDir, { recursive: true });
		assert.throws(
			() => resolvePermissionSystemExtension(),
			new RegExp(`Permission-system package manifest is missing at ${escapeRegExp(pkgPath)}`),
		);
	});

	it("throws when package.json has no valid pi.extensions entry", () => {
		const { agentDir } = createFixture();
		process.env.PI_CODING_AGENT_DIR = agentDir;
		const extDir = path.join(agentDir, "extensions", "pi-permission-system");
		const pkgPath = path.join(extDir, "package.json");
		fs.mkdirSync(extDir, { recursive: true });

		for (const value of [
			{ name: "test" },
			{ name: "test", pi: { extensions: "./src/index.ts" } },
			{ name: "test", pi: { extensions: [123] } },
		]) {
			fs.writeFileSync(pkgPath, JSON.stringify(value));
			assert.throws(
				() => resolvePermissionSystemExtension(),
				new RegExp(`Permission-system package manifest at ${escapeRegExp(pkgPath)}`),
			);
		}
	});

	it("throws when package.json is malformed", () => {
		const { agentDir } = createFixture();
		process.env.PI_CODING_AGENT_DIR = agentDir;
		const extDir = path.join(agentDir, "extensions", "pi-permission-system");
		const pkgPath = path.join(extDir, "package.json");
		fs.mkdirSync(extDir, { recursive: true });
		fs.writeFileSync(pkgPath, "{ malformed");

		assert.throws(
			() => resolvePermissionSystemExtension(),
			new RegExp(`Cannot read permission-system package manifest at ${escapeRegExp(pkgPath)}`),
		);
	});

	it("throws when package.json cannot be read", () => {
		const { agentDir } = createFixture();
		process.env.PI_CODING_AGENT_DIR = agentDir;
		const extDir = path.join(agentDir, "extensions", "pi-permission-system");
		const pkgPath = path.join(extDir, "package.json");
		fs.mkdirSync(pkgPath, { recursive: true });

		assert.throws(
			() => resolvePermissionSystemExtension(),
			new RegExp(`Cannot read permission-system package manifest at ${escapeRegExp(pkgPath)}`),
		);
	});

	it("throws with manifest context when package.json is not an object", () => {
		const { agentDir } = createFixture();
		process.env.PI_CODING_AGENT_DIR = agentDir;
		const extDir = path.join(agentDir, "extensions", "pi-permission-system");
		const pkgPath = path.join(extDir, "package.json");
		fs.mkdirSync(extDir, { recursive: true });
		fs.writeFileSync(pkgPath, "null");

		assert.throws(
			() => resolvePermissionSystemExtension(),
			new RegExp(`Cannot read permission-system package manifest at ${escapeRegExp(pkgPath)}`),
		);
	});

	it("uses a valid fallback installation when the first candidate is malformed or missing a manifest", () => {
		for (const primarySetup of [
			(dir: string) => fs.writeFileSync(path.join(dir, "package.json"), "{ malformed"),
			() => undefined,
		]) {
			const { agentDir } = createFixture();
			const primaryDir = path.join(
				agentDir,
				"npm",
				"node_modules",
				"@gotgenes",
				"pi-permission-system",
			);
			const fallbackDir = path.join(agentDir, "extensions", "pi-permission-system");
			fs.mkdirSync(primaryDir, { recursive: true });
			primarySetup(primaryDir);
			fs.mkdirSync(path.join(fallbackDir, "src"), { recursive: true });
			fs.writeFileSync(
				path.join(fallbackDir, "package.json"),
				JSON.stringify({ name: "test", pi: { extensions: ["./src/index.ts"] } }),
			);
			fs.writeFileSync(
				path.join(fallbackDir, "src", "index.ts"),
				"export default () => {};",
			);

			const result = resolvePermissionSystemExtension();

			assert.equal(result, path.join(fallbackDir, "src", "index.ts"));
		}
	});

	it("returns extension path when fully installed", () => {
		const { agentDir } = createFixture();
		process.env.PI_CODING_AGENT_DIR = agentDir;
		const extDir = path.join(agentDir, "extensions", "pi-permission-system");
		fs.mkdirSync(extDir, { recursive: true });
		fs.writeFileSync(
			path.join(extDir, "package.json"),
			JSON.stringify({ name: "test", pi: { extensions: ["./src/index.ts"] } }),
		);
		fs.mkdirSync(path.join(extDir, "src"), { recursive: true });
		fs.writeFileSync(
			path.join(extDir, "src", "index.ts"),
			"export default () => {};",
		);
		const result = resolvePermissionSystemExtension();
		assert.ok(result, "expected extension path");
		if (!result) return; // narrow for TS
		assert.ok(
			result.endsWith(path.join("pi-permission-system", "src", "index.ts")),
		);
	});

	it("throws when the configured entry file does not exist", () => {
		const { agentDir } = createFixture();
		process.env.PI_CODING_AGENT_DIR = agentDir;
		const extDir = path.join(agentDir, "extensions", "pi-permission-system");
		const pkgPath = path.join(extDir, "package.json");
		fs.mkdirSync(extDir, { recursive: true });
		fs.writeFileSync(
			pkgPath,
			JSON.stringify({
				name: "test",
				pi: { extensions: ["./src/missing.ts"] },
			}),
		);

		assert.throws(
			() => resolvePermissionSystemExtension(),
			new RegExp(`Permission-system extension entry .* in ${escapeRegExp(pkgPath)} does not exist`),
		);
	});
});

describe("resolvePiLaunchToolPlan with permission system", () => {
	it("does not inject the permission system when no native permission rules are set", () => {
		const { agentDir } = createFixture();
		process.env.PI_CODING_AGENT_DIR = agentDir;
		const extDir = path.join(agentDir, "extensions", "pi-permission-system");
		fs.mkdirSync(path.join(extDir, "src"), { recursive: true });
		fs.writeFileSync(
			path.join(extDir, "src", "index.ts"),
			"export default () => {};",
		);
		fs.writeFileSync(
			path.join(extDir, "package.json"),
			JSON.stringify({ name: "test", pi: { extensions: ["./src/index.ts"] } }),
		);

		const { args } = buildPiArgs({
			baseArgs: ["-p"],
			task: "test task",
			sessionEnabled: false,
			inheritProjectContext: false,
			inheritSkills: false,
		});
		const extensionArgs = args.filter(
			(arg, index) => args[index - 1] === "--extension",
		);
		assert.equal(
			extensionArgs.includes(path.join(extDir, "src", "index.ts")),
			false,
			"permission system extension should not be emitted without native rules",
		);
	});

	it("injects the permission system when explicit native permission rules are set", () => {
		const { agentDir } = createFixture();
		process.env.PI_CODING_AGENT_DIR = agentDir;
		const extDir = path.join(agentDir, "extensions", "pi-permission-system");
		fs.mkdirSync(path.join(extDir, "src"), { recursive: true });
		fs.writeFileSync(
			path.join(extDir, "src", "index.ts"),
			"export default () => {};",
		);
		fs.writeFileSync(
			path.join(extDir, "package.json"),
			JSON.stringify({ name: "test", pi: { extensions: ["./src/index.ts"] } }),
		);

		const { args } = buildPiArgs({
			baseArgs: ["-p"],
			task: "test task",
			sessionEnabled: false,
			inheritProjectContext: false,
			inheritSkills: false,
			permissionRules: { write: "ask" },
		});
		const extensionArgs = args.filter(
			(arg, index) => args[index - 1] === "--extension",
		);
		assert.ok(
			extensionArgs.includes(path.join(extDir, "src", "index.ts")),
			"permission system extension should be emitted when native rules are active",
		);
	});

	it("does NOT include permission system when not installed", () => {
		const { agentDir } = createFixture();
		process.env.PI_CODING_AGENT_DIR = agentDir;

		const plan = resolvePiLaunchToolPlan({});
		const permExt = plan.runtimeExtensions.find((e) =>
			e.includes("pi-permission-system"),
		);
		assert.equal(permExt, undefined);
	});

	it("does NOT include permission system when denyExtensions is set", () => {
		const { agentDir } = createFixture();
		process.env.PI_CODING_AGENT_DIR = agentDir;
		const extDir = path.join(
			agentDir,
			"npm",
			"node_modules",
			"@gotgenes",
			"pi-permission-system",
		);
		fs.mkdirSync(path.join(extDir, "src"), { recursive: true });
		fs.writeFileSync(
			path.join(extDir, "src", "index.ts"),
			"export default () => {};",
		);
		fs.writeFileSync(
			path.join(extDir, "package.json"),
			JSON.stringify({ name: "test", pi: { extensions: ["./src/index.ts"] } }),
		);

		const plan = resolvePiLaunchToolPlan({
			capabilityCeiling: {
				version: 1 as const,
				allowedTools: ["read"],
				denyExtensions: true,
				sources: ["test"],
			},
		});
		const permExt = plan.runtimeExtensions.find((e) =>
			e.includes("pi-permission-system"),
		);
		assert.equal(permExt, undefined);
	});
});

describe("buildPiArgs <active_agent> tag injection", () => {
	it("prepends <active_agent> tag when childAgentName is set", () => {
		const { agentDir } = createFixture();
		process.env.PI_CODING_AGENT_DIR = agentDir;

		const result = buildPiArgs({
			baseArgs: ["-p"],
			task: "test task",
			sessionEnabled: false,
			systemPrompt: "You are a helpful assistant.",
			inheritProjectContext: false,
			inheritSkills: false,
			childAgentName: "reviewer",
			promptFileStem: "reviewer",
		});

		const promptContent = readPromptFile(result);
		assert.ok(
			promptContent.startsWith('<active_agent name="reviewer"/>'),
			`expected prompt to start with <active_agent> tag, got: ${promptContent.slice(0, 100)}`,
		);
		assert.ok(
			promptContent.includes("You are a helpful assistant."),
			"original prompt should be preserved after the tag",
		);
	});

	it("does NOT inject tag when childAgentName is not set", () => {
		const { agentDir } = createFixture();
		process.env.PI_CODING_AGENT_DIR = agentDir;

		const result = buildPiArgs({
			baseArgs: ["-p"],
			task: "test task",
			sessionEnabled: false,
			systemPrompt: "You are a helper.",
			inheritProjectContext: false,
			inheritSkills: false,
			promptFileStem: "test",
		});

		const promptContent = readPromptFile(result);
		assert.equal(
			promptContent.includes("<active_agent"),
			false,
			"should not inject tag when no childAgentName",
		);
		assert.equal(promptContent, "You are a helper.");
	});

	it("does NOT inject tag when systemPrompt is empty", () => {
		const { agentDir } = createFixture();
		process.env.PI_CODING_AGENT_DIR = agentDir;

		const result = buildPiArgs({
			baseArgs: ["-p"],
			task: "test task",
			sessionEnabled: false,
			systemPrompt: "",
			inheritProjectContext: false,
			inheritSkills: false,
			childAgentName: "worker",
			promptFileStem: "worker",
		});

		const promptContent = readPromptFile(result);
		assert.ok(promptContent.startsWith('<active_agent name="worker"/>'));
	});

	it("escapes XML metacharacters in agent name", () => {
		const { agentDir } = createFixture();
		process.env.PI_CODING_AGENT_DIR = agentDir;

		const result = buildPiArgs({
			baseArgs: ["-p"],
			task: "test task",
			sessionEnabled: false,
			systemPrompt: "System prompt here",
			inheritProjectContext: false,
			inheritSkills: false,
			childAgentName: 'my "special" agent',
			promptFileStem: "test",
		});

		const promptContent = readPromptFile(result);
		assert.ok(
			promptContent.startsWith('<active_agent name="my &quot;special&quot; agent"/>'),
			`expected escaped tag, got: ${promptContent.slice(0, 120)}`,
		);
	});

	it("runtimeExtensions include prompt runtime path (pre-existing behavior)", () => {
		const { agentDir } = createFixture();
		process.env.PI_CODING_AGENT_DIR = agentDir;

		const plan = resolvePiLaunchToolPlan({});
		assert.ok(plan.runtimeExtensions.length >= 1);
		const hasPromptRuntime = plan.runtimeExtensions.some((e) =>
			e.endsWith("subagent-prompt-runtime.ts"),
		);
		assert.ok(
			hasPromptRuntime,
			"prompt runtime extension should always be included",
		);
	});
});
