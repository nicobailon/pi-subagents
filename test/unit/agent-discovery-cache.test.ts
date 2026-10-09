import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { registerAgent } from "../../src/api/agents.ts";
import { clearAgentDiscoveryCache, discoverAgentSnapshot, discoverAgents, discoverAgentsAll } from "../../src/agents/agents.ts";
import { mergeRuntimeAgents, clearRuntimeAgentsForPi } from "../../src/agents/runtime-agent-registry.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

let tempRoot = "";
let home = "";
let project = "";
let pi: ExtensionAPI;
const previousEnv: Record<string, string | undefined> = {};
const managedEnv = ["HOME", "USERPROFILE", "PI_CODING_AGENT_DIR", "PI_SUBAGENT_EXTRA_AGENT_DIRS", "PI_OFFLINE"];

function writeAgent(filePath: string, name: string, description: string): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, `---\nname: ${name}\ndescription: ${description}\n---\n\n${description}.\n`, "utf-8");
}

function writeJson(filePath: string, value: unknown): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf-8");
}

function makePi(): ExtensionAPI {
	return { on() {}, registerTool() {} } as unknown as ExtensionAPI;
}

describe("agent discovery snapshots", () => {
	beforeEach(() => {
		tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-discovery-cache-"));
		home = path.join(tempRoot, "home");
		project = path.join(tempRoot, "project");
		for (const name of managedEnv) previousEnv[name] = process.env[name];
		process.env.HOME = home;
		process.env.USERPROFILE = home;
		process.env.PI_CODING_AGENT_DIR = path.join(home, ".pi", "agent");
		process.env.PI_OFFLINE = "true";
		delete process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS;
		pi = makePi();
		clearAgentDiscoveryCache();
	});

	afterEach(() => {
		clearRuntimeAgentsForPi(pi);
		clearAgentDiscoveryCache();
		for (const name of managedEnv) {
			const value = previousEnv[name];
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		fs.rmSync(tempRoot, { recursive: true, force: true });
	});

	it("keeps effective and all-source projections distinct in one snapshot", () => {
		const userAgentPath = path.join(home, ".pi", "agent", "agents", "shared.md");
		const projectAgentPath = path.join(project, ".pi", "agents", "shared.md");
		writeAgent(userAgentPath, "shared", "User shared");
		writeAgent(projectAgentPath, "shared", "Project shared");
		writeAgent(path.join(home, ".pi", "agent", "agents", "scope-hidden.md"), "scope-hidden", "User hidden");
		writeJson(path.join(project, ".pi", "settings.json"), {
			subagents: { agentOverrides: { "scope-hidden": { disabled: true } } },
		});

		const snapshot = discoverAgentSnapshot(project, "both", undefined, { includeChains: false });
		assert.equal(snapshot.effective.agents.find((agent) => agent.name === "shared")?.source, "project");
		assert.equal(snapshot.effective.agents.some((agent) => agent.name === "scope-hidden"), false);
		assert.equal(snapshot.all.user.some((agent) => agent.name === "shared"), true);
		assert.equal(snapshot.all.project.some((agent) => agent.name === "shared"), true);
		assert.equal(snapshot.all.user.some((agent) => agent.name === "scope-hidden"), true);
		assert.equal(snapshot.all.project.some((agent) => agent.name === "scope-hidden"), false);
		assert.equal(snapshot.effective.directories.some((directory) => directory.source === "project"), true);
	});

	it("retains hidden definitions for runtime collision checks", () => {
		const hiddenPath = path.join(home, ".pi", "agent", "agents", "scope-hidden.md");
		writeAgent(hiddenPath, "scope-hidden", "User hidden");
		const registration = registerAgent({
			pi,
			name: "scope-hidden",
			definition: { description: "Runtime hidden collision", systemPrompt: "Runtime." },
		});
		try {
			const snapshot = discoverAgentSnapshot(project, "project", undefined, { includeChains: false });
			const configured = [...snapshot.all.builtin, ...snapshot.all.package, ...snapshot.all.user, ...snapshot.all.project];
			assert.equal(snapshot.effective.agents.some((agent) => agent.name === "scope-hidden"), false);
			assert.throws(
				() => mergeRuntimeAgents(pi, snapshot.effective, configured),
				/collides with configured agent 'scope-hidden'/,
			);
		} finally {
			registration.dispose();
		}
	});

	it("invalidates agent and chain projections when files change or appear", () => {
		const agentPath = path.join(project, ".pi", "agents", "fresh.md");
		const chainPath = path.join(project, ".pi", "chains", "fresh.chain.md");
		writeAgent(agentPath, "fresh", "Initial agent");
		fs.mkdirSync(path.dirname(chainPath), { recursive: true });
		fs.writeFileSync(chainPath, "---\nname: fresh-chain\ndescription: Initial chain\n---\n\n## fresh\nInspect\n", "utf-8");

		const first = discoverAgentSnapshot(project, "both");
		assert.equal(first.effective.agents.find((agent) => agent.name === "fresh")?.description, "Initial agent");
		assert.equal(first.all.chains.find((chain) => chain.name === "fresh-chain")?.description, "Initial chain");

		writeAgent(agentPath, "fresh", "Updated agent");
		fs.writeFileSync(chainPath, "---\nname: fresh-chain\ndescription: Updated chain\n---\n\n## fresh\nInspect\n", "utf-8");
		const updated = discoverAgentSnapshot(project, "both");
		assert.equal(updated.effective.agents.find((agent) => agent.name === "fresh")?.description, "Updated agent");
		assert.equal(updated.all.chains.find((chain) => chain.name === "fresh-chain")?.description, "Updated chain");

		fs.rmSync(agentPath);
		const addedPath = path.join(project, ".pi", "agents", "added.md");
		writeAgent(addedPath, "added", "Added agent");
		const changedFiles = discoverAgents(project, "both");
		assert.equal(changedFiles.agents.some((agent) => agent.name === "fresh"), false);
		assert.equal(changedFiles.agents.some((agent) => agent.name === "added"), true);
	});

	it("matches scoped discovery settings and precedence for user and project views", () => {
		writeAgent(path.join(home, ".pi", "agent", "agents", "shared.md"), "shared", "User shared");
		writeAgent(path.join(project, ".pi", "agents", "shared.md"), "shared", "Project shared");
		writeAgent(path.join(home, ".pi", "agent", "agents", "user-only.md"), "user-only", "User only");
		writeAgent(path.join(project, ".pi", "agents", "project-only.md"), "project-only", "Project only");
		writeJson(path.join(home, ".pi", "agent", "settings.json"), { subagents: { agentOverrides: { shared: { description: "User override" } } } });
		writeJson(path.join(project, ".pi", "settings.json"), { subagents: { agentOverrides: { shared: { description: "Project override" } } } });

		for (const scope of ["user", "project"] as const) {
			const direct = discoverAgents(project, scope);
			const snapshot = discoverAgentSnapshot(project, scope, undefined, { includeChains: false }).effective;
			assert.deepEqual(snapshot, direct);
		}
	});

	it("invalidates when a new agent appears in a previously inspected nested directory", () => {
		const nestedDir = path.join(project, ".pi", "agents", "nested");
		fs.mkdirSync(nestedDir, { recursive: true });

		const initial = discoverAgents(project, "both");
		assert.equal(initial.agents.some((agent) => agent.name === "nested-agent"), false);

		writeAgent(path.join(nestedDir, "nested-agent.md"), "nested-agent", "Nested agent");
		const updated = discoverAgents(project, "both");
		assert.equal(updated.agents.some((agent) => agent.name === "nested-agent"), true);
	});

	it("does not read out-of-scope user settings for a project snapshot", () => {
		writeAgent(path.join(project, ".pi", "agents", "project-agent.md"), "project-agent", "Project agent");
		const userSettingsPath = path.join(home, ".pi", "agent", "settings.json");
		fs.mkdirSync(path.dirname(userSettingsPath), { recursive: true });
		fs.writeFileSync(userSettingsPath, "{ malformed", "utf-8");

		const snapshot = discoverAgentSnapshot(project, "project", undefined, { includeChains: false });
		assert.equal(snapshot.effective.agents.some((agent) => agent.name === "project-agent"), true);
		assert.equal(snapshot.all.project.some((agent) => agent.name === "project-agent"), true);
	});

	it("keeps shared package agent metadata scoped to the selected settings source", () => {
		const userPackageRoot = path.join(tempRoot, "user-package");
		const projectPackageRoot = path.join(tempRoot, "project-package");
		const sharedAgentDir = path.join(tempRoot, "shared-package-agents");
		writeJson(path.join(home, ".pi", "agent", "settings.json"), { packages: [userPackageRoot] });
		writeJson(path.join(project, ".pi", "settings.json"), { packages: [projectPackageRoot] });
		writeJson(path.join(userPackageRoot, "package.json"), {
			name: "user-package",
			"pi-subagents": { agents: [path.relative(userPackageRoot, sharedAgentDir)] },
		});
		writeJson(path.join(projectPackageRoot, "package.json"), {
			name: "project-package",
			"pi-subagents": { agents: [path.relative(projectPackageRoot, sharedAgentDir)] },
		});
		writeAgent(path.join(sharedAgentDir, "shared.md"), "shared", "Shared package agent");

		const directUser = discoverAgents(project, "user").agents.find((agent) => agent.name === "shared");
		const directProject = discoverAgents(project, "project").agents.find((agent) => agent.name === "shared");
		const snapshotUser = discoverAgentSnapshot(project, "user", undefined, { includeChains: false }).effective.agents.find((agent) => agent.name === "shared");
		const snapshotProject = discoverAgentSnapshot(project, "project", undefined, { includeChains: false }).effective.agents.find((agent) => agent.name === "shared");

		assert.equal(directUser?.packageSourceName, "user-package");
		assert.equal(directProject?.packageSourceName, "project-package");
		assert.equal(snapshotUser?.packageSourceName, directUser?.packageSourceName);
		assert.equal(snapshotProject?.packageSourceName, directProject?.packageSourceName);
	});

	it("surfaces malformed in-scope settings while collecting package roots", () => {
		const settingsPath = path.join(home, ".pi", "agent", "settings.json");
		fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
		fs.writeFileSync(settingsPath, "{ malformed", "utf-8");

		assert.throws(
			() => discoverAgentSnapshot(project, "both", undefined, { includeChains: false }),
			(error: unknown) => error instanceof Error
				&& error.message.includes(settingsPath)
				&& error.message.includes("Failed to parse settings file"),
		);
	});

	it("invalidates when project-root policy changes", () => {
		const outer = path.join(tempRoot, "outer");
		const nested = path.join(outer, "nested");
		fs.mkdirSync(path.join(outer, ".git"), { recursive: true });
		writeAgent(path.join(outer, ".pi", "agents", "outer.md"), "outer", "Outer agent");
		writeAgent(path.join(nested, ".pi", "agents", "nested.md"), "nested", "Nested agent");
		writeJson(path.join(nested, ".pi", "settings.json"), { subagents: { projectRootResolution: "git-root" } });

		const gitRoot = discoverAgents(nested, "both");
		assert.equal(gitRoot.projectAgentsDir, path.join(outer, ".pi", "agents"));
		assert.equal(gitRoot.agents.some((agent) => agent.name === "outer"), true);
		assert.equal(gitRoot.agents.some((agent) => agent.name === "nested"), false);

		writeJson(path.join(nested, ".pi", "settings.json"), { subagents: { projectRootResolution: "nearest" } });
		const nearest = discoverAgents(nested, "both");
		assert.equal(nearest.projectAgentsDir, path.join(nested, ".pi", "agents"));
		assert.equal(nearest.agents.some((agent) => agent.name === "nested"), true);
		assert.equal(nearest.agents.some((agent) => agent.name === "outer"), false);
	});

	it("does not parse chains on the ordinary effective discovery fast path", () => {
		const agentPath = path.join(project, ".pi", "agents", "worker.md");
		const chainPath = path.join(project, ".pi", "chains", "broken.chain.md");
		writeAgent(agentPath, "worker", "Worker");
		fs.mkdirSync(path.dirname(chainPath), { recursive: true });
		fs.writeFileSync(chainPath, "not a valid chain", "utf-8");

		assert.equal(discoverAgents(project, "both").agents.some((agent) => agent.name === "worker"), true);
		assert.equal(discoverAgentsAll(project).chainDiagnostics.some((diagnostic) => diagnostic.filePath === chainPath), true);
	});

	it("ignores project settings, agents and chains when the session declined project trust", () => {
		writeAgent(path.join(home, ".pi", "agent", "agents", "probe.md"), "probe", "User probe");
		writeJson(path.join(home, ".pi", "agent", "settings.json"), {
			subagents: { agentOverrides: { probe: { model: "openai/luna" } }, modelScope: { enforce: true, allow: ["openai/luna"] } },
		});
		writeAgent(path.join(project, ".pi", "agents", "project-only.md"), "project-only", "Project only");
		writeJson(path.join(project, ".pi", "settings.json"), {
			subagents: { agentOverrides: { probe: { model: "openai/astra" } }, modelScope: { enforce: true, allow: ["openai/astra"] } },
		});
		fs.mkdirSync(path.join(project, ".pi", "chains"), { recursive: true });
		fs.writeFileSync(path.join(project, ".pi", "chains", "project.chain.md"), "---\nname: project-chain\ndescription: Project chain\n---\n\n## probe\nInspect\n", "utf-8");
		// The repository's own package.json can declare agents too.
		writeJson(path.join(project, "package.json"), { name: "repo", "pi-subagents": { agents: ["./repo-agents"] } });
		writeAgent(path.join(project, "repo-agents", "repo-agent.md"), "repo-agent", "Repository agent");

		const untrusted = { projectTrusted: false };
		for (const discovered of [discoverAgents(project, "both", undefined, untrusted), discoverAgentSnapshot(project, "both", undefined, untrusted).effective]) {
			assert.equal(discovered.agents.find((agent) => agent.name === "probe")?.model, "openai/luna");
			assert.equal(discovered.agents.some((agent) => agent.name === "project-only"), false);
			assert.equal(discovered.agents.some((agent) => agent.name === "repo-agent"), false);
			assert.deepEqual(discovered.modelScope?.allow, ["openai/luna"]);
			assert.equal(discovered.directories.some((directory) => directory.source === "project" || directory.source === "package"), false);
		}
		const all = discoverAgentsAll(project, undefined, untrusted);
		assert.deepEqual(all.project, []);
		assert.deepEqual(all.package, []);
		assert.equal(all.user.find((agent) => agent.name === "probe")?.model, "openai/luna");
		assert.equal(all.chains.some((chain) => chain.name === "project-chain"), false);
		assert.throws(() => discoverAgents(project, "project", undefined, untrusted), /agentScope: "project" requires project trust/);
		assert.throws(() => discoverAgentSnapshot(project, "project", undefined, untrusted), /agentScope: "project" requires project trust/);
		assert.equal(discoverAgents(project, "user", undefined, untrusted).agents.some((agent) => agent.name === "repo-agent"), false);

		// Trusted lookups share the cached sources and still see the project.
		const trusted = discoverAgentSnapshot(project, "both");
		assert.equal(trusted.effective.agents.find((agent) => agent.name === "probe")?.model, "openai/astra");
		assert.equal(trusted.effective.agents.some((agent) => agent.name === "project-only"), true);
		assert.equal(trusted.effective.agents.some((agent) => agent.name === "repo-agent"), true);
		assert.equal(discoverAgents(project, "user").agents.some((agent) => agent.name === "repo-agent"), true);
		assert.deepEqual(trusted.effective.modelScope?.allow, ["openai/astra"]);
		assert.equal(trusted.all.chains.some((chain) => chain.name === "project-chain"), true);
		assert.equal(discoverAgents(project, "both", undefined, untrusted).agents.find((agent) => agent.name === "probe")?.model, "openai/luna");
	});
});
