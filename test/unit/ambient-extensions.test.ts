import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	applyRuntimeAgentSettings,
	discoverAgents,
	discoverAgentsAll,
	type AgentConfig,
} from "../../src/agents/agents.ts";
import { handleUpdate } from "../../src/agents/agent-management.ts";
import { serializeAgent } from "../../src/agents/agent-serializer.ts";
import { resolvePiLaunchToolPlan } from "../../src/api/child-tool-plan.ts";
import { buildInProcessChildLaunch } from "../../src/runs/shared/child-launch.ts";
import { createHash } from "node:crypto";

function extensionId(value: string): string {
	return `sha256:${createHash("sha256").update(path.normalize(value.trim())).digest("hex").slice(0, 16)}`;
}

let tempHome = "";
let tempProject = "";
let guardFile = "";
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const originalPiCodingAgentDir = process.env.PI_CODING_AGENT_DIR;

function writeJson(filePath: string, value: unknown): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf-8");
}

function writeUserSettings(subagents: Record<string, unknown>): void {
	writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), { subagents });
}

function writeProjectSettings(subagents: Record<string, unknown>): void {
	writeJson(path.join(tempProject, ".pi", "settings.json"), { subagents });
}

function writeProjectGuard(name = "project-guard.ts"): string {
	const projectGuard = path.join(tempProject, name);
	fs.writeFileSync(projectGuard, "export default true;\n", "utf-8");
	return projectGuard;
}

function scout(): AgentConfig | undefined {
	return discoverAgentsAll(tempProject).builtin.find((agent) => agent.name === "scout");
}

beforeEach(() => {
	tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-home-"));
	tempProject = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-project-"));
	process.env.HOME = tempHome;
	process.env.USERPROFILE = tempHome;
	process.env.PI_CODING_AGENT_DIR = path.join(tempHome, ".pi", "agent");
	guardFile = path.join(tempHome, "guard.ts");
	fs.writeFileSync(guardFile, "export default true;\n", "utf-8");
});

afterEach(() => {
	if (originalHome === undefined) delete process.env.HOME;
	else process.env.HOME = originalHome;
	if (originalUserProfile === undefined) delete process.env.USERPROFILE;
	else process.env.USERPROFILE = originalUserProfile;
	if (originalPiCodingAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalPiCodingAgentDir;
	fs.rmSync(tempHome, { recursive: true, force: true });
	fs.rmSync(tempProject, { recursive: true, force: true });
});

describe("subagents.ambientExtensions settings parsing", () => {
	it("rejects relative paths, bare package names, and npm: specs", () => {
		for (const entry of ["./guard.ts", "cc-safety-net", "npm:cc-safety-net"]) {
			writeUserSettings({ ambientExtensions: [entry] });
			assert.throws(() => discoverAgentsAll(tempProject), /invalid 'ambientExtensions'.*absolute path or start with '~'/, `expected rejection for ${entry}`);
		}
	});

	it("rejects directories and missing files, pointing at the pi.extensions entry file", () => {
		writeUserSettings({ ambientExtensions: [tempHome] });
		assert.throws(() => discoverAgentsAll(tempProject), /not a directory.*pi\.extensions/);

		writeUserSettings({ ambientExtensions: [path.join(tempHome, "absent.ts")] });
		assert.throws(() => discoverAgentsAll(tempProject), /must be an existing extension file \(ENOENT\)/);
	});

	it("expands ~ to the agent home and loads the file for every agent", () => {
		writeUserSettings({ ambientExtensions: ["~/guard.ts"] });
		const agent = scout();
		assert.deepEqual(agent?.ambientExtensionPaths, [guardFile]);
	});

	it("rejects non-array and blank values", () => {
		writeUserSettings({ ambientExtensions: "guard.ts" });
		assert.throws(() => discoverAgentsAll(tempProject), /expected an array of non-empty strings/);

		writeUserSettings({ ambientExtensions: ["  "] });
		assert.throws(() => discoverAgentsAll(tempProject), /expected an array of non-empty strings/);
	});
});

describe("subagents.ambientExtensions discovery union", () => {
	it("applies to agents that declare their own extension lists, without touching them", () => {
		writeUserSettings({ ambientExtensions: [guardFile] });
		fs.mkdirSync(path.join(tempProject, ".pi", "agents"), { recursive: true });
		fs.writeFileSync(path.join(tempProject, ".pi", "agents", "own.md"), `---
name: own
description: Own lists
extensions:
subagentOnlyExtensions:
  - /tmp/child-only.ts
---

Own lists.
`, "utf-8");
		const agent = discoverAgentsAll(tempProject).project.find((entry) => entry.name === "own");
		assert.ok(agent);
		assert.deepEqual(agent.ambientExtensionPaths, [guardFile]);
		assert.deepEqual(agent.extensions, []);
		assert.deepEqual(agent.subagentOnlyExtensions, ["/tmp/child-only.ts"]);
	});

	it("merges user and project entries for both discovery scopes", () => {
		const projectGuard = writeProjectGuard();
		writeUserSettings({ ambientExtensions: [guardFile] });
		writeProjectSettings({ ambientExtensions: [projectGuard] });
		for (const scope of ["user", "project"] as const) {
			const agents = discoverAgents(tempProject, scope, undefined, { projectTrusted: true }).agents;
			const agent = agents.find((entry) => entry.name === "scout");
			assert.ok(agent, `scout missing for scope ${scope}`);
			assert.deepEqual(agent.ambientExtensionPaths, [guardFile, projectGuard], `scope ${scope}`);
		}
	});

	it("ignores an untrusted project's entries", () => {
		const projectGuard = writeProjectGuard();
		writeUserSettings({ ambientExtensions: [guardFile] });
		writeProjectSettings({ ambientExtensions: [projectGuard] });
		const agents = discoverAgents(tempProject, "user", undefined, { projectTrusted: false }).agents;
		const agent = agents.find((entry) => entry.name === "scout");
		assert.ok(agent);
		assert.deepEqual(agent.ambientExtensionPaths, [guardFile]);
	});

	it("tolerates a malformed out-of-scope user file and keeps the project entries", () => {
		const projectGuard = writeProjectGuard();
		writeProjectSettings({ ambientExtensions: [projectGuard] });
		fs.mkdirSync(path.join(tempHome, ".pi", "agent"), { recursive: true });
		fs.writeFileSync(path.join(tempHome, ".pi", "agent", "settings.json"), "{ not json", "utf-8");
		const agents = discoverAgents(tempProject, "project", undefined, { projectTrusted: true }).agents;
		const agent = agents.find((entry) => entry.name === "scout");
		assert.ok(agent);
		assert.deepEqual(agent.ambientExtensionPaths, [projectGuard]);
	});

	it("tolerates an invalid non-ambient field in the out-of-scope file but fails loudly on an invalid ambient value", () => {
		writeProjectSettings({ defaultModel: "" });
		writeUserSettings({ ambientExtensions: [guardFile] });
		const agent = discoverAgents(tempProject, "user", undefined, { projectTrusted: true }).agents.find((entry) => entry.name === "scout");
		assert.ok(agent);
		assert.deepEqual(agent.ambientExtensionPaths, [guardFile]);

		writeProjectSettings({ ambientExtensions: ["relative-guard.ts"] });
		assert.throws(() => discoverAgents(tempProject, "user", undefined, { projectTrusted: true }), /invalid 'ambientExtensions'/);
	});

	it("applies to runtime-registered agents", () => {
		writeUserSettings({ ambientExtensions: [guardFile] });
		const agent = {
			name: "runtime-agent",
			description: "Runtime",
			systemPrompt: "Runtime prompt.",
			systemPromptMode: "replace",
			inheritProjectContext: true,
			inheritGlobalContext: true,
			inheritSkills: false,
			source: "runtime",
			filePath: "",
		} as AgentConfig;
		const [withDefaults] = applyRuntimeAgentSettings([agent], { cwd: tempProject, scope: "user", projectTrusted: true });
		assert.deepEqual(withDefaults.ambientExtensionPaths, [guardFile]);
	});

	it("keeps settings-derived entries out of agent management writes", () => {
		writeUserSettings({ ambientExtensions: [guardFile] });
		fs.mkdirSync(path.join(tempProject, ".pi", "agents"), { recursive: true });
		fs.writeFileSync(path.join(tempProject, ".pi", "agents", "managed.md"), `---\nname: managed\ndescription: Managed\n---\n\nManaged.\n`, "utf-8");
		const ctx = {
			cwd: tempProject,
			modelRegistry: { getAvailable: () => [] },
		} as unknown as Parameters<typeof handleUpdate>[1];
		const updated = handleUpdate({ agent: "managed", config: { description: "Updated managed" } }, ctx) as { isError?: boolean };
		assert.equal(updated.isError, false);
		const content = fs.readFileSync(path.join(tempProject, ".pi", "agents", "managed.md"), "utf-8");
		assert.ok(!content.includes("ambientExtensionPaths"), content);
	});

	it("never serializes ambientExtensionPaths into agent files", () => {
		writeUserSettings({ ambientExtensions: [guardFile] });
		const agent = scout();
		assert.ok(agent?.ambientExtensionPaths?.length);
		const serialized = serializeAgent({ ...agent, source: "user" });
		assert.ok(!serialized.includes("ambientExtensionPaths"), serialized);
	});
});

describe("ambient entries in the launch tool plan", () => {
	const baseInput = {
		agentName: "scout",
		cwd: "/tmp",
	};

	it("unions entries into the extension args in both ambient branches, deduplicated", () => {
		const withAgentExtensions = resolvePiLaunchToolPlan({
			...baseInput,
			extensions: [guardFile],
			ambientExtensionPaths: [guardFile],
		});
		assert.equal(withAgentExtensions.disableAmbientExtensions, true);
		assert.equal(withAgentExtensions.extensionArgs.filter((entry) => entry === guardFile).length, 1);
		assert.ok(withAgentExtensions.configuredExtensions.includes(guardFile));
		assert.deepEqual(withAgentExtensions.enforcedExtensionPaths, [guardFile]);

		const withSubagentOnly = resolvePiLaunchToolPlan({
			...baseInput,
			subagentOnlyExtensions: [guardFile],
			ambientExtensionPaths: [guardFile],
		});
		assert.equal(withSubagentOnly.disableAmbientExtensions, false);
		assert.equal(withSubagentOnly.extensionArgs.filter((entry) => entry === guardFile).length, 1);

		const plain = resolvePiLaunchToolPlan({ ...baseInput, ambientExtensionPaths: [guardFile] });
		assert.equal(plain.disableAmbientExtensions, false);
		assert.ok(plain.extensionArgs.includes(guardFile));
		assert.deepEqual(plain.enforcedExtensionPaths, [guardFile]);

		const absent = resolvePiLaunchToolPlan({ ...baseInput });
		assert.equal(absent.enforcedExtensionPaths, undefined);
	});

	it("rejects a denyExtensions ceiling instead of silently dropping the guard", () => {
		assert.throws(
			() => resolvePiLaunchToolPlan({
				...baseInput,
				ambientExtensionPaths: [guardFile],
				capabilityCeiling: { version: 1, denyExtensions: true, sources: ["test-ceiling"] },
			}),
			/denies extensions but 'subagents\.ambientExtensions' requires/,
		);
	});
});

describe("ambient entries in the in-process launch", () => {
	it("loads enforced entries in a foreground child even with extensions: []", () => {
		const launch = buildInProcessChildLaunch({
			sessionEnabled: false,
			inheritProjectContext: true,
			inheritGlobalContext: true,
			inheritSkills: false,
			childAgentName: "scout",
			childIndex: 1,
			cwd: tempProject,
			host: "parent",
			extensions: [],
			ambientExtensionPaths: [guardFile],
		});
		assert.equal(launch.session.ambientExtensions, false);
		assert.ok(launch.session.extensionPaths.includes(guardFile));
		assert.deepEqual(launch.session.enforcedExtensionPaths, [guardFile]);
		assert.equal(launch.launchResolvedExtensions.disableAmbientExtensions, true);
		assert.ok(launch.launchResolvedExtensions.configured.includes(extensionId(guardFile)));
		assert.ok(launch.launchResolvedExtensions.effective.includes(extensionId(guardFile)));
	});

	it("carries the entries to background children alongside ambient discovery", () => {
		const launch = buildInProcessChildLaunch({
			sessionEnabled: false,
			inheritProjectContext: true,
			inheritGlobalContext: true,
			inheritSkills: false,
			childAgentName: "scout",
			childIndex: 1,
			cwd: tempProject,
			host: "runner",
			ambientExtensionPaths: [guardFile],
		});
		assert.equal(launch.session.ambientExtensions, true);
		assert.ok(launch.session.extensionPaths.includes(guardFile));
		assert.equal(launch.launchResolvedExtensions.disableAmbientExtensions, false);
		assert.ok(launch.launchResolvedExtensions.effective.includes(extensionId(guardFile)));
	});

	it("skips the entries for machine-placed children", () => {
		const launch = buildInProcessChildLaunch({
			sessionEnabled: false,
			inheritProjectContext: true,
			inheritGlobalContext: true,
			inheritSkills: false,
			childAgentName: "scout",
			childIndex: 1,
			cwd: tempProject,
			host: "parent",
			ambientExtensionPaths: [guardFile],
			machine: { name: "box", workingDirectory: "/tmp/box" } as never,
		});
		assert.ok(!launch.session.extensionPaths.includes(guardFile));
		assert.equal(launch.session.enforcedExtensionPaths, undefined);
	});
});

describe("agentOverrides.extensions reaches children (issue #3395 request 1)", () => {
	it("applies a settings override to a builtin and forwards it to the launch plan", () => {
		writeUserSettings({ agentOverrides: { scout: { extensions: [guardFile] } } });
		const agent = scout();
		assert.deepEqual(agent?.extensions, [guardFile]);
		const plan = resolvePiLaunchToolPlan({
			agentName: "scout",
			cwd: tempProject,
			extensions: agent?.extensions,
		});
		assert.equal(plan.disableAmbientExtensions, true);
		assert.ok(plan.extensionArgs.includes(guardFile));
	});
});
