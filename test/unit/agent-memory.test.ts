import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
	AGENT_MEMORY_DIR_NAME,
	AGENT_MEMORY_FILE,
	agentHasWriteTools,
	buildAgentMemoryInjection,
	parseMemoryFrontmatter,
	readMemoryFile,
	resolveMemoryDir,
} from "../../src/agents/agent-memory.ts";
import { serializeAgent } from "../../src/agents/agent-serializer.ts";
import { discoverAgents, findNearestProjectRoot, type AgentConfig, type AgentMemoryConfig } from "../../src/agents/agents.ts";
import { handleManagementAction } from "../../src/agents/agent-management.ts";

const tempDirs: string[] = [];

function makeAgent(overrides: Partial<AgentConfig> & { memory?: AgentMemoryConfig }): AgentConfig {
	return {
		name: "test-agent",
		description: "test agent",
		systemPrompt: "do the thing",
		systemPromptMode: "replace",
		inheritProjectContext: false,
		inheritSkills: false,
		source: "project",
		filePath: "/tmp/test-agent.md",
		...overrides,
	};
}

function mkdtemp(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

function withTempHome<T>(fn: (home: string) => T): T {
	const home = mkdtemp("pi-subagents-mem-home-");
	const oldHome = process.env.HOME;
	const oldUserProfile = process.env.USERPROFILE;
	const oldPiCodingAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.HOME = home;
	process.env.USERPROFILE = home;
	delete process.env.PI_CODING_AGENT_DIR;
	try {
		return fn(home);
	} finally {
		if (oldHome === undefined) delete process.env.HOME;
		else process.env.HOME = oldHome;
		if (oldUserProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = oldUserProfile;
		if (oldPiCodingAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = oldPiCodingAgentDir;
	}
}

// Create a temp project root that findNearestProjectRoot will recognise (.pi dir present).
function mkProject(): string {
	const dir = mkdtemp("pi-subagents-mem-project-");
	fs.mkdirSync(path.join(dir, ".pi", "agents"), { recursive: true });
	return dir;
}

function writeMemoryFile(memoryDir: string, contents: string): void {
	fs.mkdirSync(memoryDir, { recursive: true });
	fs.writeFileSync(path.join(memoryDir, AGENT_MEMORY_FILE), contents, "utf-8");
}

function commitFixture(project: string, trackedFile: string): void {
	execFileSync("git", ["init", "-q"], { cwd: project });
	execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: project });
	execFileSync("git", ["config", "user.name", "Test"], { cwd: project });
	execFileSync("git", ["add", trackedFile], { cwd: project });
	execFileSync("git", ["commit", "-qm", "fixture"], { cwd: project });
}

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (!dir) continue;
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe("parseMemoryFrontmatter", () => {
	it("parses a project scope block", () => {
		assert.deepEqual(parseMemoryFrontmatter("scope: project\npath: security-reviewer"), {
			scope: "project",
			path: "security-reviewer",
		});
	});

	it("parses a user scope with nested path and strips quotes", () => {
		assert.deepEqual(parseMemoryFrontmatter('scope: user\npath: "team/release-agent"'), {
			scope: "user",
			path: "team/release-agent",
		});
	});

	it("parses an inline object memory block", () => {
		assert.deepEqual(parseMemoryFrontmatter('{ scope: "project", path: "security-reviewer" }'), {
			scope: "project",
			path: "security-reviewer",
		});
	});

	it("rejects unknown scopes", () => {
		assert.equal(parseMemoryFrontmatter("scope: global\npath: x"), undefined);
	});

	it("rejects a missing path", () => {
		assert.equal(parseMemoryFrontmatter("scope: project"), undefined);
	});

	it("rejects a missing scope", () => {
		assert.equal(parseMemoryFrontmatter("path: x"), undefined);
	});

	it("treats empty or absent input as no memory config", () => {
		assert.equal(parseMemoryFrontmatter(undefined), undefined);
		assert.equal(parseMemoryFrontmatter(""), undefined);
	});
});

describe("agentHasWriteTools", () => {
	it("inherits write capability when tools are unset", () => {
		assert.equal(agentHasWriteTools({}), true);
	});

	it("detects edit, write, and bash as write tools", () => {
		assert.equal(agentHasWriteTools({ tools: ["read", "edit"] }), true);
		assert.equal(agentHasWriteTools({ tools: ["write"] }), true);
		assert.equal(agentHasWriteTools({ tools: ["bash"] }), true);
	});

	it("treats read-only and mcp-only tool sets as non-write", () => {
		assert.equal(agentHasWriteTools({ tools: ["read", "grep", "find", "ls"] }), false);
		assert.equal(agentHasWriteTools({ tools: ["mcp:filesystem"] }), false);
	});
});

describe("resolveMemoryDir", () => {
	it("resolves a simple and nested path under the root", () => {
		const root = mkdtemp("pi-subagents-mem-root-");
		assert.deepEqual(resolveMemoryDir(root, "reviewer"), { dir: path.join(root, "reviewer") });
		assert.deepEqual(resolveMemoryDir(root, "team/reviewer"), { dir: path.join(root, "team", "reviewer") });
	});

	it("rejects empty paths", () => {
		const root = mkdtemp("pi-subagents-mem-root-");
		assert.ok("error" in resolveMemoryDir(root, ""));
		assert.ok("error" in resolveMemoryDir(root, "   "));
	});

	it("rejects dot and parent segments", () => {
		const root = mkdtemp("pi-subagents-mem-root-");
		assert.ok("error" in resolveMemoryDir(root, "."));
		assert.ok("error" in resolveMemoryDir(root, ".."));
		assert.ok("error" in resolveMemoryDir(root, "a/../b"));
	});

	it("rejects absolute and Windows drive-like paths", () => {
		const root = mkdtemp("pi-subagents-mem-root-");
		assert.ok("error" in resolveMemoryDir(root, "/tmp/reviewer"));
		assert.ok("error" in resolveMemoryDir(root, "C:\\Users\\reviewer"));
		assert.ok("error" in resolveMemoryDir(root, "C:reviewer"));
		assert.ok("error" in resolveMemoryDir(root, "team:C"));
	});

	it("rejects a symlinked ancestor before prompting a first write", () => {
		const root = mkdtemp("pi-subagents-mem-root-");
		const outside = mkdtemp("pi-subagents-mem-outside-");
		const linkPath = path.join(root, "leak");
		try {
			fs.symlinkSync(outside, linkPath);
		} catch {
			return;
		}
		const resolved = resolveMemoryDir(root, "leak/new-agent");
		assert.ok("error" in resolved, "expected symlink ancestor escape to be rejected");
	});

	it("rejects a memory dir that is a symlink escaping the root", () => {
		const root = mkdtemp("pi-subagents-mem-root-");
		const outside = mkdtemp("pi-subagents-mem-outside-");
		const linkPath = path.join(root, "leak");
		try {
			fs.symlinkSync(outside, linkPath);
		} catch {
			// Symlinks may be unavailable (e.g. Windows without dev mode); skip portably.
			return;
		}
		const resolved = resolveMemoryDir(root, "leak");
		assert.ok("error" in resolved, "expected symlink escape to be rejected");
	});
});

describe("readMemoryFile", () => {
	it("returns null when no memory file exists", () => {
		const dir = mkdtemp("pi-subagents-mem-dir-");
		assert.equal(readMemoryFile(dir), null);
	});

	it("reads contents and reports byte capping", () => {
		const dir = mkdtemp("pi-subagents-mem-dir-");
		writeMemoryFile(dir, "line one\nline two\n");
		const result = readMemoryFile(dir);
		assert.ok(result && typeof result === "object" && !("error" in result) && result !== "unsafe");
		assert.equal((result as { contents: string }).contents, "line one\nline two\n");
		assert.equal((result as { byteCapped: boolean }).byteCapped, false);
	});

	it("flags byte-capped contents", () => {
		const dir = mkdtemp("pi-subagents-mem-dir-");
		const bigLine = "x".repeat(500);
		writeMemoryFile(dir, Array.from({ length: 50 }, () => bigLine).join("\n"));
		const result = readMemoryFile(dir);
		assert.ok(result && result !== "unsafe");
		assert.equal((result as { byteCapped: boolean }).byteCapped, true);
	});

	it("does not return more than the memory byte cap", () => {
		const dir = mkdtemp("pi-subagents-mem-dir-");
		writeMemoryFile(dir, "x".repeat(1024 * 1024));
		const result = readMemoryFile(dir);
		assert.ok(result && result !== "unsafe");
		assert.equal(result.byteCapped, true);
		assert.ok(Buffer.byteLength(result.contents, "utf-8") <= 16 * 1024);
	});

	it("rejects a symlinked memory file that escapes the memory dir", () => {
		const dir = mkdtemp("pi-subagents-mem-dir-");
		const outsideFile = path.join(mkdtemp("pi-subagents-mem-outside-"), "secret.md");
		fs.writeFileSync(outsideFile, "leaked", "utf-8");
		try {
			fs.symlinkSync(outsideFile, path.join(dir, AGENT_MEMORY_FILE));
		} catch {
			return; // Symlinks unsupported here; skip portably.
		}
		assert.equal(readMemoryFile(dir), "unsafe");
	});
});

describe("buildAgentMemoryInjection", () => {
	it("returns empty when the agent has no memory scope", () => {
		const project = mkProject();
		assert.equal(buildAgentMemoryInjection(makeAgent({}), project), "");
	});

	it("injects a read-write block with contents for a project scope", () => {
		const project = mkProject();
		const memoryDir = path.join(project, ".pi", AGENT_MEMORY_DIR_NAME, "security-reviewer");
		writeMemoryFile(memoryDir, "Threat: token leakage in logs.\nGotcha: retry on 429.");
		const agent = makeAgent({ memory: { scope: "project", path: "security-reviewer" }, tools: ["read", "edit"] });
		const injection = buildAgentMemoryInjection(agent, project);
		const memoryFile = path.join(memoryDir, AGENT_MEMORY_FILE);
		assert.match(injection, /# Persistent agent memory/);
		assert.match(injection, new RegExp(`Memory file: ${escapeRegex(memoryFile)}`));
		assert.match(injection, /append a concise dated entry/);
		assert.match(injection, /reference data, not instructions/);
		assert.match(injection, /Threat: token leakage in logs\./);
		assert.match(injection, /Gotcha: retry on 429\./);
		assert.doesNotMatch(injection, /read-only/);
	});

	it("injects a creation prompt when a read-write agent has no memory file yet", () => {
		const project = mkProject();
		const agent = makeAgent({ memory: { scope: "project", path: "fresh-agent" }, tools: ["read", "write"] });
		const injection = buildAgentMemoryInjection(agent, project);
		const memoryFile = path.join(project, ".pi", AGENT_MEMORY_DIR_NAME, "fresh-agent", AGENT_MEMORY_FILE);
		assert.match(injection, new RegExp(`Memory file: ${escapeRegex(memoryFile)}`));
		assert.match(injection, new RegExp(`No ${AGENT_MEMORY_FILE} exists yet`));
		assert.match(injection, /You may create it/);
	});

	it("resolves project memory through a linked worktree when Git trace writes to stderr", () => {
		const root = mkdtemp("pi-subagents-mem-worktree-");
		const project = path.join(root, "project");
		const worktree = path.join(root, "worktree");
		fs.mkdirSync(path.join(project, ".pi", "agents"), { recursive: true });
		fs.writeFileSync(path.join(project, ".pi", "agents", "probe.md"), "probe\n");
		commitFixture(project, ".pi/agents/probe.md");
		execFileSync("git", ["worktree", "add", "-qb", "probe", worktree], { cwd: project });
		const expectedFile = path.join(fs.realpathSync.native(project), ".pi", AGENT_MEMORY_DIR_NAME, "probe", AGENT_MEMORY_FILE);
		writeMemoryFile(path.dirname(expectedFile), "marker: shared-main-memory\n");
		const agent = makeAgent({ memory: { scope: "project", path: "probe" }, tools: ["read", "write"] });
		const previousGitTrace = process.env.GIT_TRACE;
		process.env.GIT_TRACE = "1";
		let injection: string;
		try {
			injection = buildAgentMemoryInjection(agent, path.join(worktree, ".pi", "agents"));
		} finally {
			if (previousGitTrace === undefined) delete process.env.GIT_TRACE;
			else process.env.GIT_TRACE = previousGitTrace;
		}
		assert.match(injection, /marker: shared-main-memory/);
		assert.match(injection, new RegExp(`Memory file: ${escapeRegex(expectedFile)}`));
		assert.doesNotMatch(injection, new RegExp(escapeRegex(path.join(worktree, ".pi", AGENT_MEMORY_DIR_NAME))));

		const marker = path.join(worktree, ".git");
		const absoluteGitDir = fs.readFileSync(marker, "utf8").match(/^gitdir:\s*(.+?)\s*$/m)?.[1];
		assert.ok(absoluteGitDir);
		const markerFd = fs.openSync(marker, "r+");
		try {
			fs.ftruncateSync(markerFd, 0);
			fs.writeFileSync(markerFd, `gitdir: ${path.relative(fs.realpathSync(worktree), path.resolve(worktree, absoluteGitDir))}\n`);
		} finally {
			fs.closeSync(markerFd);
		}
		injection = buildAgentMemoryInjection(agent, worktree);
		assert.match(injection, /marker: shared-main-memory/);
		assert.match(injection, new RegExp(`Memory file: ${escapeRegex(expectedFile)}`));
	});

	it("maps nested project memory from a linked worktree to the same main-checkout path", () => {
		const root = mkdtemp("pi-subagents-mem-nested-worktree-");
		const project = path.join(root, "project");
		const worktree = path.join(root, "worktree");
		const nested = path.join("packages", "app");
		fs.mkdirSync(path.join(project, nested, ".pi", "agents"), { recursive: true });
		fs.writeFileSync(path.join(project, nested, ".pi", "agents", "probe.md"), "probe\n");
		commitFixture(project, `${nested}/.pi/agents/probe.md`);
		execFileSync("git", ["worktree", "add", "-qb", "nested", worktree], { cwd: project });
		const expectedFile = path.join(fs.realpathSync.native(project), nested, ".pi", AGENT_MEMORY_DIR_NAME, "probe", AGENT_MEMORY_FILE);
		writeMemoryFile(path.dirname(expectedFile), "marker: nested-main-memory\n");
		const agent = makeAgent({ memory: { scope: "project", path: "probe" }, tools: ["read", "write"] });
		const injection = buildAgentMemoryInjection(agent, path.join(worktree, nested));
		assert.match(injection, /marker: nested-main-memory/);
		assert.match(injection, new RegExp(`Memory file: ${escapeRegex(expectedFile)}`));
	});

	it("rejects a forged marker pointing at another repository's valid worktree metadata", () => {
		const project = mkProject();
		const other = path.join(mkdtemp("pi-subagents-mem-other-repo-"), "project");
		const otherWorktree = path.join(path.dirname(other), "worktree");
		fs.mkdirSync(other, { recursive: true });
		fs.writeFileSync(path.join(other, "tracked.txt"), "fixture\n");
		commitFixture(other, "tracked.txt");
		execFileSync("git", ["worktree", "add", "-qb", "other", otherWorktree], { cwd: other });
		const otherGitDir = fs.readFileSync(path.join(otherWorktree, ".git"), "utf8").match(/^gitdir:\s*(.+?)\s*$/m)?.[1];
		assert.ok(otherGitDir);
		fs.writeFileSync(path.join(project, ".git"), `gitdir: ${otherGitDir}\n`);
		writeMemoryFile(path.join(project, ".pi", AGENT_MEMORY_DIR_NAME, "probe"), "marker: checkout-local\n");
		writeMemoryFile(path.join(other, ".pi", AGENT_MEMORY_DIR_NAME, "probe"), "marker: other-repository\n");
		const injection = buildAgentMemoryInjection(makeAgent({ memory: { scope: "project", path: "probe" }, tools: ["read"] }), project);
		assert.match(injection, /marker: checkout-local/);
		assert.doesNotMatch(injection, /marker: other-repository/);
	});

	it("rejects self-consistent forged worktree metadata that Git does not recognize", () => {
		const project = mkProject();
		const fakeMain = mkdtemp("pi-subagents-mem-forged-main-");
		const fakeWorktreeGitDir = path.join(fakeMain, ".git", "worktrees", "forged");
		fs.mkdirSync(fakeWorktreeGitDir, { recursive: true });
		fs.writeFileSync(path.join(project, ".git"), `gitdir: ${fakeWorktreeGitDir}\n`);
		fs.writeFileSync(path.join(fakeWorktreeGitDir, "gitdir"), `${path.join(project, ".git")}\n`);
		writeMemoryFile(path.join(project, ".pi", AGENT_MEMORY_DIR_NAME, "probe"), "marker: checkout-local\n");
		writeMemoryFile(path.join(fakeMain, ".pi", AGENT_MEMORY_DIR_NAME, "probe"), "marker: forged-main\n");
		const injection = buildAgentMemoryInjection(makeAgent({ memory: { scope: "project", path: "probe" }, tools: ["read"] }), project);
		assert.match(injection, /marker: checkout-local/);
		assert.doesNotMatch(injection, /marker: forged-main/);
	});

	it("uses the Git root when a linked worktree has no local project config directory", () => {
		const root = mkdtemp("pi-subagents-mem-unconfigured-worktree-");
		const project = path.join(root, "project");
		const worktree = path.join(root, "worktree");
		fs.mkdirSync(project, { recursive: true });
		fs.writeFileSync(path.join(project, "tracked.txt"), "fixture\n");
		commitFixture(project, "tracked.txt");
		execFileSync("git", ["worktree", "add", "-qb", "probe", worktree], { cwd: project });
		writeMemoryFile(path.join(project, ".pi", AGENT_MEMORY_DIR_NAME, "probe"), "marker: git-root-memory\n");
		const agent = makeAgent({ memory: { scope: "project", path: "probe" }, tools: ["read"] });
		assert.equal(findNearestProjectRoot(worktree), null);
		assert.match(buildAgentMemoryInjection(agent, worktree), /marker: git-root-memory/);
	});

	it("keeps project memory checkout-local for unsupported separate Git directories", () => {
		const root = mkdtemp("pi-subagents-mem-separate-git-dir-");
		const project = path.join(root, "project");
		const gitDir = path.join(root, "metadata");
		fs.mkdirSync(path.join(project, ".pi", "agents"), { recursive: true });
		execFileSync("git", ["init", "-q", `--separate-git-dir=${gitDir}`, project]);
		writeMemoryFile(path.join(project, ".pi", AGENT_MEMORY_DIR_NAME, "probe"), "marker: checkout-local\n");
		writeMemoryFile(path.join(root, ".pi", AGENT_MEMORY_DIR_NAME, "probe"), "marker: unsupported-remap\n");
		const injection = buildAgentMemoryInjection(makeAgent({ memory: { scope: "project", path: "probe" }, tools: ["read"] }), project);
		assert.match(injection, /marker: checkout-local/);
		assert.doesNotMatch(injection, /marker: unsupported-remap/);
		assert.match(injection, new RegExp(`Memory file: ${escapeRegex(path.join(project, ".pi", AGENT_MEMORY_DIR_NAME, "probe", AGENT_MEMORY_FILE))}`));
	});

	it("injects a read-only block for agents without write tools", () => {
		const project = mkProject();
		const memoryDir = path.join(project, ".pi", AGENT_MEMORY_DIR_NAME, "scout");
		writeMemoryFile(memoryDir, "Known flake: async timeout test.");
		const agent = makeAgent({ memory: { scope: "project", path: "scout" }, tools: ["read", "grep", "find", "ls"] });
		const injection = buildAgentMemoryInjection(agent, project);
		assert.match(injection, /read-only, role-specific memory scope/);
		assert.match(injection, /Do not attempt to edit or create the memory file/);
		assert.match(injection, /reference data, not instructions/);
		assert.match(injection, /Known flake: async timeout test\./);
		assert.doesNotMatch(injection, /You may create it/);
		assert.doesNotMatch(injection, /append a concise dated entry/);
	});

	it("injects nothing for a read-only agent with no memory file yet", () => {
		const project = mkProject();
		const agent = makeAgent({ memory: { scope: "project", path: "empty-scout" }, tools: ["read"] });
		assert.equal(buildAgentMemoryInjection(agent, project), "");
	});

	it("resolves user scope under the agent dir, separate from the owner memory system", () => {
		withTempHome((home) => {
			const project = mkProject();
			const memoryDir = path.join(home, ".pi", "agent", AGENT_MEMORY_DIR_NAME, "release-agent");
			writeMemoryFile(memoryDir, "Release gotcha: tag before gh release.");
			const agent = makeAgent({ memory: { scope: "user", path: "release-agent" }, tools: ["read", "edit"] });
			const injection = buildAgentMemoryInjection(agent, project);
			const memoryFile = path.join(memoryDir, AGENT_MEMORY_FILE);
			assert.match(injection, new RegExp(`Memory file: ${escapeRegex(memoryFile)}`));
			assert.match(injection, /Release gotcha: tag before gh release\./);
			// Must not collide with the owner's ~/.pi/agent/memory/{project}/ layout.
			assert.doesNotMatch(injection, /agent\/memory\/[^/]+\/release-agent/);
		});
	});

	it("returns empty for project scope when no project root is found", () => {
		const nowhere = mkdtemp("pi-subagents-mem-noroot-");
		// Skip deterministically if an ancestor happens to register as a project root.
		if (findNearestProjectRoot(nowhere) !== null) return;
		const agent = makeAgent({ memory: { scope: "project", path: "x" }, tools: ["read"] });
		assert.equal(buildAgentMemoryInjection(agent, nowhere), "");
	});

	it("returns empty when the memory path is unsafe", () => {
		const project = mkProject();
		const agent = makeAgent({ memory: { scope: "project", path: ".." }, tools: ["read", "edit"] });
		assert.equal(buildAgentMemoryInjection(agent, project), "");
	});

	it("returns empty when the memory file is an escaping symlink", () => {
		const project = mkProject();
		const memoryDir = path.join(project, ".pi", AGENT_MEMORY_DIR_NAME, "leak");
		fs.mkdirSync(memoryDir, { recursive: true });
		const outsideFile = path.join(mkdtemp("pi-subagents-mem-outside-"), "secret.md");
		fs.writeFileSync(outsideFile, "leaked", "utf-8");
		try {
			fs.symlinkSync(outsideFile, path.join(memoryDir, AGENT_MEMORY_FILE));
		} catch {
			return; // Symlinks unsupported here; skip portably.
		}
		const agent = makeAgent({ memory: { scope: "project", path: "leak" }, tools: ["read", "edit"] });
		assert.equal(buildAgentMemoryInjection(agent, project), "");
	});

	it("caps memory contents to the first N lines without claiming a byte cap", () => {
		const project = mkProject();
		const memoryDir = path.join(project, ".pi", AGENT_MEMORY_DIR_NAME, "capped");
		writeMemoryFile(memoryDir, Array.from({ length: 210 }, (_, i) => `l-${i + 1}`).join("\n"));
		const agent = makeAgent({ memory: { scope: "project", path: "capped" }, tools: ["read", "edit"] });
		const injection = buildAgentMemoryInjection(agent, project);
		assert.match(injection, /l-200\b/);
		assert.doesNotMatch(injection, /l-201\b/);
		assert.match(injection, /first 200 lines\)/);
		assert.doesNotMatch(injection, /byte-capped/);
	});
});

describe("agent memory frontmatter round-trip", () => {
	it("parses memory frontmatter during discovery and keeps it out of extraFields", () => {
		const project = mkProject();
		fs.writeFileSync(path.join(project, ".pi", "agents", "security-reviewer.md"), `---
name: security-reviewer
description: Recurring security reviewer
tools: read, grep, bash, edit
memory: { scope: project, path: security-reviewer }
---

Review for threats.
`, "utf-8");

		const agent = discoverAgents(project, "project").agents.find((a) => a.name === "security-reviewer");
		assert.ok(agent, "agent should be discovered");
		assert.deepEqual(agent?.memory, { scope: "project", path: "security-reviewer" });
		assert.equal(agent?.extraFields?.memory, undefined, "memory must not leak into extraFields");
	});

	it("serializes memory back into frontmatter", () => {
		const agent = makeAgent({ memory: { scope: "user", path: "release-agent" } });
		const serialized = serializeAgent(agent);
		assert.match(serialized, /^memory:$/m);
		assert.match(serialized, /^  scope: user$/m);
		assert.match(serialized, /^  path: release-agent$/m);
	});

	it("ignores a malformed memory block without dropping the agent", () => {
		const project = mkProject();
		fs.writeFileSync(path.join(project, ".pi", "agents", "bad-memory.md"), `---
name: bad-memory
description: Bad memory config
memory:
  scope: galaxy
  path: whatever
---

Still loads.
`, "utf-8");

		const agent = discoverAgents(project, "project").agents.find((a) => a.name === "bad-memory");
		assert.ok(agent, "agent should still be discovered");
		assert.equal(agent?.memory, undefined);
	});
});

describe("agent memory in management detail", () => {
	it("surfaces the memory scope in the get action", () => {
		const project = mkProject();
		fs.writeFileSync(path.join(project, ".pi", "agents", "security-reviewer.md"), `---
name: security-reviewer
description: Recurring security reviewer
memory:
  scope: project
  path: security-reviewer
---

Review for threats.
`, "utf-8");

		const res = handleManagementAction("get", { agent: "security-reviewer" }, {
			cwd: project,
			modelRegistry: { getAvailable: () => [] },
		});
		assert.equal(res.isError, false);
		assert.match(res.content[0]?.text ?? "", /Memory: project scope, path: security-reviewer/);
	});
});

function escapeRegex(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
