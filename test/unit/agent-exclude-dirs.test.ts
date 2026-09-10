import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { clearAgentDiscoveryCache, discoverAgents, discoverAgentsAll, discoverAgentSnapshot } from "../../src/agents/agents.ts";

function writeAgent(dir: string, name: string): void {
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, `${name}.md`), `---\nname: ${name}\ndescription: exclusion test\n---\nbody\n`);
}

function recordReads(): string[] {
	const reads: string[] = [];
	const readdir = fs.readdirSync;
	const readFile = fs.readFileSync;
	mock.method(fs, "readdirSync", (...args: Parameters<typeof fs.readdirSync>) => {
		reads.push(String(args[0]));
		return readdir(...args);
	});
	mock.method(fs, "readFileSync", (...args: Parameters<typeof fs.readFileSync>) => {
		reads.push(String(args[0]));
		return readFile(...args);
	});
	return reads;
}

describe("settings subagents.agentExcludeDirs", () => {
	let root: string;
	let user: string;
	let project: string;
	let previousAgentDir: string | undefined;
	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-exclude-"));
		user = path.join(root, "user");
		project = path.join(root, "project");
		fs.mkdirSync(user);
		fs.mkdirSync(path.join(project, ".pi"), { recursive: true });
		previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = user;
		clearAgentDiscoveryCache();
	});
	afterEach(() => {
		mock.restoreAll();
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		fs.rmSync(root, { recursive: true, force: true });
		clearAgentDiscoveryCache();
	});
	function settings(dir: string, subagents: unknown, extra = {}): void {
		fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ subagents, ...extra }));
	}

	it("prunes nested sources, diagnostics and explicit roots in every projection while retaining legacy agents", () => {
		const userPlugins = path.join(user, "agents", "plugins");
		const projectPlugins = path.join(project, ".agents", "plugins");
		const fixedProjectRoot = path.join(project, ".pi", "agents");
		writeAgent(path.join(user, "agents"), "user-legacy");
		writeAgent(path.join(project, ".agents"), "project-legacy");
		fs.mkdirSync(fixedProjectRoot, { recursive: true });
		fs.writeFileSync(path.join(fixedProjectRoot, "fixed-invalid.md"), "---\nname: fixed-invalid\n---\nbody");
		for (const dir of [userPlugins, projectPlugins]) {
			writeAgent(path.join(dir, "nested", "agents"), "plugin-only");
			writeAgent(dir, "user-legacy");
			fs.writeFileSync(path.join(dir, "invalid.md"), "---\nname: invalid\n---\nbody");
		}
		settings(user, { agentExcludeDirs: ["agents/plugins"], agentScanDirs: [userPlugins, projectPlugins] });
		settings(path.join(project, ".pi"), { agentExcludeDirs: ["../.agents/plugins", "agents"] });
		for (const scope of ["user", "project", "both"] as const) {
			for (const result of [discoverAgents(project, scope), discoverAgentSnapshot(project, scope, undefined, { includeChains: false }).effective]) {
				assert.equal(result.agents.some((agent) => agent.name === "plugin-only"), false);
				assert.equal(result.agents.some((agent) => agent.name === (scope === "project" ? "project-legacy" : "user-legacy")), true);
				assert.equal(result.agentDiagnostics?.some((diagnostic) => diagnostic.filePath.includes("plugins")), false);
				assert.equal(result.directories?.some((directory) => directory.path.includes("plugins")), false);
			}
		}
		const all = discoverAgentsAll(project);
		assert.equal([...all.user, ...all.project, ...all.package].some((agent) => agent.name === "plugin-only"), false);
		assert.equal([...all.user, ...all.project, ...all.package].some((agent) => agent.filePath.includes("plugins")), false, "collision inputs must not retain excluded definitions");
		assert.equal(all.agentDiagnostics?.some((diagnostic) => diagnostic.filePath.includes("plugins")), false);
		assert.equal(discoverAgents(project, "project").directories?.some((directory) => directory.path === fixedProjectRoot), false);
		assert.equal(discoverAgentSnapshot(project, "project", undefined, { includeChains: false }).all.agentDiagnostics?.some((diagnostic) => diagnostic.filePath.startsWith(fixedProjectRoot)), false);
	});

	it("invalidates cached exclusions when settings change and discovers later additions after removal", () => {
		const plugins = path.join(user, "agents", "plugins");
		writeAgent(plugins, "plugin-cache");
		assert.equal(discoverAgents(project, "both").agents.some((agent) => agent.name === "plugin-cache"), true);
		settings(user, { agentExcludeDirs: ["agents/plugins"] });
		assert.equal(discoverAgents(project, "both").agents.some((agent) => agent.name === "plugin-cache"), false);
		writeAgent(plugins, "late-plugin");
		settings(user, { agentExcludeDirs: [] });
		assert.equal(discoverAgents(project, "both").agents.some((agent) => agent.name === "late-plugin"), true);
	});

	it("matches real paths and symlink aliases without matching sibling prefixes", () => {
		const plugins = path.join(user, "agents", "plugins");
		writeAgent(plugins, "hidden-alias");
		writeAgent(`${plugins}-kept`, "sibling-kept");
		writeAgent(path.join(plugins, "..kept"), "hidden-descendant");
		fs.symlinkSync(plugins, path.join(user, "agents", "alias"), "dir");
		fs.symlinkSync(path.join(plugins, "hidden-alias.md"), path.join(user, "agents", "alias.md"));
		fs.symlinkSync(plugins, path.join(root, "excluded-alias"), "dir");
		settings(user, { agentExcludeDirs: [path.join(root, "excluded-alias", ".")], agentScanDirs: [plugins] });
		const names = discoverAgents(project, "both").agents.map((agent) => agent.name);
		assert.equal(names.includes("hidden-alias"), false);
		assert.equal(names.includes("hidden-descendant"), false);
		assert.equal(names.includes("sibling-kept"), true);
		fs.unlinkSync(path.join(root, "excluded-alias"));
		fs.symlinkSync(`${plugins}-kept`, path.join(root, "excluded-alias"), "dir");
		const retargeted = discoverAgents(project, "both").agents.map((agent) => agent.name);
		assert.equal(retargeted.includes("hidden-alias"), true);
		assert.equal(retargeted.includes("sibling-kept"), false);
	});

	it("invalidates excluded explicit scan-root aliases when retargeted to allowed storage", () => {
		const hidden = path.join(root, "hidden");
		const allowed = path.join(root, "allowed");
		writeAgent(hidden, "hidden-retarget");
		writeAgent(allowed, "allowed-retarget");
		for (const scope of ["user", "project"] as const) {
			clearAgentDiscoveryCache();
			const alias = path.join(root, `${scope}-scan-alias`);
			fs.symlinkSync(hidden, alias, "dir");
			settings(user, { agentExcludeDirs: [hidden], ...(scope === "user" ? { agentScanDirs: [alias] } : {}) });
			settings(path.join(project, ".pi"), scope === "project" ? { agentScanDirs: [alias] } : {});
			const reads = recordReads();
			for (let attempt = 0; attempt < 2; attempt++) {
				const initial = discoverAgentSnapshot(project, "both", undefined, { includeChains: false });
				assert.equal(initial.effective.agents.some((agent) => agent.name.endsWith("-retarget")), false);
			}
			assert.equal(reads.some((filePath) => [hidden, alias].some((dir) => filePath === dir || filePath.startsWith(`${dir}${path.sep}`))), false);
			mock.restoreAll();
			fs.unlinkSync(alias);
			fs.symlinkSync(allowed, alias, "dir");
			const cached = discoverAgentSnapshot(project, "both", undefined, { includeChains: false });
			assert.equal(cached.effective.agents.some((agent) => agent.name === "allowed-retarget"), true);
			assert.equal(cached.all[scope].some((agent) => agent.name === "allowed-retarget"), true);
			clearAgentDiscoveryCache();
			assert.deepEqual(cached.effective.agents.map((agent) => agent.filePath), discoverAgents(project, "both").agents.map((agent) => agent.filePath));
		}
	});

	for (const source of ["wildcard", "environment", "package", "fixed"] as const) it(`invalidates excluded ${source} root aliases on reverse retarget`, () => {
		const hidden = path.join(root, "hidden");
		const allowed = path.join(root, "allowed");
		const container = path.join(root, "sources", "child");
		fs.mkdirSync(container, { recursive: true });
		const alias = path.join(source === "fixed" ? user : container, "agents");
		writeAgent(hidden, "hidden-source");
		writeAgent(allowed, "allowed-source");
		fs.symlinkSync(hidden, alias, "dir");
		const previousExtraDirs = process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS;
		try {
			if (source === "environment") process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS = alias;
			if (source === "package") fs.writeFileSync(path.join(container, "package.json"), JSON.stringify({ name: "alias-fixture", "pi-subagents": { agents: ["./agents"] } }));
			settings(user, { agentExcludeDirs: [hidden], ...(source === "wildcard" ? { agentScanDirs: [path.join(root, "sources", "*", "agents")] } : {}) }, source === "package" ? { packages: [container] } : {});
			assert.equal(discoverAgents(project, "both").agents.some((agent) => agent.name === "allowed-source"), false);
			fs.unlinkSync(alias);
			fs.symlinkSync(allowed, alias, "dir");
			assert.equal(discoverAgents(project, "both").agents.some((agent) => agent.name === "allowed-source"), true);
		} finally {
			if (previousExtraDirs === undefined) delete process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS;
			else process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS = previousExtraDirs;
		}
	});

	it("resolves home paths and missing descendants through symlinked ancestors", () => {
		const previousHome = process.env.HOME;
		const previousUserProfile = process.env.USERPROFILE;
		try {
			process.env.HOME = root;
			process.env.USERPROFILE = root;
			const plugins = path.join(user, "agents", "plugins");
			fs.mkdirSync(plugins, { recursive: true });
			fs.symlinkSync(plugins, path.join(root, "plugin-alias"), "dir");
			settings(user, { agentExcludeDirs: ["~/plugin-alias/later"], agentScanDirs: [path.join(plugins, "*", "agents")] });
			discoverAgents(project, "both");
			writeAgent(path.join(plugins, "later", "agents"), "missing-hidden");
			writeAgent(path.join(plugins, "later-kept", "agents"), "missing-kept");
			const names = discoverAgents(project, "both").agents.map((agent) => agent.name);
			assert.equal(names.includes("missing-hidden"), false);
			assert.equal(names.includes("missing-kept"), true);
		} finally {
			if (previousHome === undefined) delete process.env.HOME;
			else process.env.HOME = previousHome;
			if (previousUserProfile === undefined) delete process.env.USERPROFILE;
			else process.env.USERPROFILE = previousUserProfile;
		}
	});

	it("does not read or traverse excluded trees on fresh scans or cache fingerprints", () => {
		const plugins = path.join(user, "agents", "plugins");
		writeAgent(plugins, "never-read");
		writeAgent(path.join(user, "agents"), "kept");
		settings(user, { agentExcludeDirs: [plugins] });
		const reads = recordReads();
		for (const scope of ["user", "project", "both"] as const) discoverAgents(project, scope);
		discoverAgentsAll(project);
		assert.equal(reads.some((filePath) => filePath === plugins || filePath.startsWith(`${plugins}${path.sep}`)), false);
		reads.length = 0;
		writeAgent(path.join(plugins, "late"), "still-hidden");
		discoverAgents(project, "both");
		assert.equal(reads.some((filePath) => filePath === plugins || filePath.startsWith(`${plugins}${path.sep}`)), false);
		assert.equal(reads.includes(path.join(user, "agents", "kept.md")), false, "excluded changes must not force a source reload");
	});

	it("does not re-include excluded package roots or change chain discovery", () => {
		const pkg = path.join(root, "pkg");
		writeAgent(path.join(pkg, "agents"), "package-hidden");
		fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "exclude-fixture", "pi-subagents": { agents: ["./agents"], chains: ["./agents"] } }));
		fs.writeFileSync(path.join(pkg, "agents", "kept.chain.json"), JSON.stringify({ name: "kept-chain", description: "Retained chain", chain: [{ agent: "scout", task: "Inspect" }] }));
		settings(user, {}, { packages: [pkg] });
		assert.equal(discoverAgentsAll(project).package.some((agent) => agent.name === "package-hidden"), true);
		settings(user, { agentExcludeDirs: [path.join(pkg, "agents")] }, { packages: [pkg] });
		const all = discoverAgentsAll(project);
		assert.equal(all.package.some((agent) => agent.name === "package-hidden"), false);
		assert.equal(all.chains.some((chain) => chain.name === "kept-chain"), true);
		fs.writeFileSync(path.join(pkg, "agents", "late.chain.json"), JSON.stringify({ name: "late-chain", description: "New chain", chain: [{ agent: "scout", task: "Inspect" }] }));
		assert.equal(discoverAgentsAll(project).chains.some((chain) => chain.name === "late-chain"), true);
	});

	it("invalidates agent-only discovery when an excluded package declares an allowed external root", () => {
		const pkg = path.join(root, "pkg");
		const excludedAgents = path.join(pkg, "agents");
		writeAgent(excludedAgents, "package-hidden");
		writeAgent(path.join(root, "allowed"), "outside");
		const manifest = path.join(pkg, "package.json");
		fs.writeFileSync(manifest, JSON.stringify({ name: "fixture", "pi-subagents": { agents: ["./agents"] } }));
		settings(user, { agentExcludeDirs: [pkg] }, { packages: [pkg] });
		const reads = recordReads();
		assert.equal(discoverAgents(project, "both").agents.some((agent) => agent.name === "outside"), false);
		fs.writeFileSync(manifest, JSON.stringify({ name: "fixture", "pi-subagents": { agents: ["../allowed"] } }));
		const cached = discoverAgents(project, "both");
		assert.equal(cached.agents.some((agent) => agent.name === "outside"), true);
		assert.equal(cached.agents.some((agent) => agent.name === "package-hidden"), false);
		assert.equal(discoverAgentSnapshot(project, "both", undefined, { includeChains: false }).all.package.some((agent) => agent.name === "outside"), true);
		assert.equal(reads.some((filePath) => filePath === excludedAgents || filePath.startsWith(`${excludedAgents}${path.sep}`)), false);
	});

	it("rejects malformed exclusions in participating settings", () => {
		settings(user, { agentExcludeDirs: [42] });
		assert.throws(() => discoverAgents(project, "user"), /invalid 'agentExcludeDirs'/);
		assert.throws(() => discoverAgents(project, "both"), /invalid 'agentExcludeDirs'/);
	});
});
