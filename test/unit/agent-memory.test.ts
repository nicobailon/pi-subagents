import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { afterEach, describe, it } from "node:test";
import {
	AGENT_MEMORY_DIR_NAME,
	AGENT_MEMORY_FILE,
	MAX_MEMORY_APPEND_BYTES,
	agentHasWriteTools,
	appendAgentMemoryRecord,
	buildAgentMemoryInjection,
	parseMemoryFrontmatter,
	readMemoryFile,
	resolveAgentMemoryAppendTarget,
	resolveMemoryDir,
	restrictAgentMemoryWrites,
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

	it("rejects an opened file reached through a symlinked ancestor", () => {
		const root = mkdtemp("pi-subagents-mem-root-");
		const outside = mkdtemp("pi-subagents-mem-outside-");
		writeMemoryFile(outside, "leaked\n");
		const linkedDir = path.join(root, "linked");
		try {
			fs.symlinkSync(outside, linkedDir);
		} catch {
			return;
		}
		assert.equal(readMemoryFile(linkedDir, root), "unsafe");
	});

	it("rejects a hard-linked memory file", () => {
		const root = mkdtemp("pi-subagents-mem-hardlink-root-");
		const memoryDir = path.join(root, "worker");
		const outside = path.join(mkdtemp("pi-subagents-mem-hardlink-outside-"), "outside.md");
		fs.mkdirSync(memoryDir);
		fs.writeFileSync(outside, "outside\n");
		try {
			fs.linkSync(outside, path.join(memoryDir, AGENT_MEMORY_FILE));
		} catch {
			return;
		}
		assert.equal(readMemoryFile(memoryDir, root), "unsafe");
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
		assert.match(injection, /agent_memory_append to append one concise dated entry/);
		assert.match(injection, /reference data, not instructions/);
		assert.match(injection, /Threat: token leakage in logs\./);
		assert.match(injection, /Gotcha: retry on 429\./);
		assert.doesNotMatch(injection, /read-only/);
	});

	it("downgrades writable guidance when the effective launch has no append tool", () => {
		const project = mkProject();
		const memoryDir = path.join(project, ".pi", AGENT_MEMORY_DIR_NAME, "worker");
		writeMemoryFile(memoryDir, "existing\n");
		const writable = buildAgentMemoryInjection(makeAgent({ memory: { scope: "project", path: "worker" }, tools: ["write"] }), project);
		const readOnly = restrictAgentMemoryWrites(writable);
		assert.match(readOnly, /read-only, role-specific memory scope/);
		assert.match(readOnly, /no agent-memory append capability/);
		assert.doesNotMatch(readOnly, /use agent_memory_append/);
	});

	it("injects a creation prompt when a read-write agent has no memory file yet", () => {
		const project = mkProject();
		const agent = makeAgent({ memory: { scope: "project", path: "fresh-agent" }, tools: ["read", "write"] });
		const injection = buildAgentMemoryInjection(agent, project);
		const memoryFile = path.join(project, ".pi", AGENT_MEMORY_DIR_NAME, "fresh-agent", AGENT_MEMORY_FILE);
		assert.match(injection, new RegExp(`Memory file: ${escapeRegex(memoryFile)}`));
		assert.match(injection, new RegExp(`No ${AGENT_MEMORY_FILE} exists yet`));
		assert.match(injection, /agent_memory_append/);
		assert.match(injection, /Do not replace or edit the memory file/);
	});

	it("resolves project memory through a linked worktree to the main checkout", () => {
		const root = mkdtemp("pi-subagents-mem-worktree-");
		const project = path.join(root, "project");
		const worktree = path.join(root, "worktree");
		fs.mkdirSync(path.join(project, ".pi", "agents"), { recursive: true });
		fs.writeFileSync(path.join(project, ".pi", "agents", "probe.md"), "probe\n");
		execFileSync("git", ["init", "-q"], { cwd: project });
		execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: project });
		execFileSync("git", ["config", "user.name", "Test"], { cwd: project });
		execFileSync("git", ["add", ".pi/agents/probe.md"], { cwd: project });
		execFileSync("git", ["commit", "-qm", "fixture"], { cwd: project });
		execFileSync("git", ["worktree", "add", "-qb", "probe", worktree], { cwd: project });
		const memoryDir = path.join(project, ".pi", AGENT_MEMORY_DIR_NAME, "probe");
		writeMemoryFile(memoryDir, "marker: shared-main-memory\n");
		const agent = makeAgent({ memory: { scope: "project", path: "probe" }, tools: ["read", "write"] });
		const target = resolveAgentMemoryAppendTarget(agent, worktree);
		assert.ok(target);
		assert.deepEqual(target, {
			rootDir: path.join(fs.realpathSync.native(project), ".pi", AGENT_MEMORY_DIR_NAME),
			scopedPath: "probe",
		});
		const injection = buildAgentMemoryInjection(agent, path.join(worktree, ".pi", "agents"));
		assert.match(injection, /marker: shared-main-memory/);
		assert.match(injection, new RegExp(`Memory file: ${escapeRegex(path.join(target.rootDir, target.scopedPath, AGENT_MEMORY_FILE))}`));
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
		assert.equal(resolveAgentMemoryAppendTarget(agent, worktree)?.rootDir, target.rootDir);
	});

	it("maps nested project memory from a linked worktree to the same main-checkout path", () => {
		const root = mkdtemp("pi-subagents-mem-nested-worktree-");
		const project = path.join(root, "project");
		const worktree = path.join(root, "worktree");
		const nested = path.join("packages", "app");
		fs.mkdirSync(path.join(project, nested, ".pi", "agents"), { recursive: true });
		fs.writeFileSync(path.join(project, nested, ".pi", "agents", "probe.md"), "probe\n");
		execFileSync("git", ["init", "-q"], { cwd: project });
		execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: project });
		execFileSync("git", ["config", "user.name", "Test"], { cwd: project });
		execFileSync("git", ["add", `${nested}/.pi/agents/probe.md`], { cwd: project });
		execFileSync("git", ["commit", "-qm", "fixture"], { cwd: project });
		execFileSync("git", ["worktree", "add", "-qb", "nested", worktree], { cwd: project });
		const memoryDir = path.join(project, nested, ".pi", AGENT_MEMORY_DIR_NAME, "probe");
		writeMemoryFile(memoryDir, "marker: nested-main-memory\n");
		const agent = makeAgent({ memory: { scope: "project", path: "probe" }, tools: ["read", "write"] });
		const target = resolveAgentMemoryAppendTarget(agent, path.join(worktree, nested));
		assert.equal(target?.rootDir, path.join(fs.realpathSync.native(project), nested, ".pi", AGENT_MEMORY_DIR_NAME));
		assert.match(buildAgentMemoryInjection(agent, path.join(worktree, nested)), /marker: nested-main-memory/);
	});

	it("rejects a forged marker pointing at another repository's valid worktree metadata", () => {
		const project = mkProject();
		const other = path.join(mkdtemp("pi-subagents-mem-other-repo-"), "project");
		const otherWorktree = path.join(path.dirname(other), "worktree");
		fs.mkdirSync(other, { recursive: true });
		fs.writeFileSync(path.join(other, "tracked.txt"), "fixture\n");
		execFileSync("git", ["init", "-q"], { cwd: other });
		execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: other });
		execFileSync("git", ["config", "user.name", "Test"], { cwd: other });
		execFileSync("git", ["add", "tracked.txt"], { cwd: other });
		execFileSync("git", ["commit", "-qm", "fixture"], { cwd: other });
		execFileSync("git", ["worktree", "add", "-qb", "other", otherWorktree], { cwd: other });
		const otherGitDir = fs.readFileSync(path.join(otherWorktree, ".git"), "utf8").match(/^gitdir:\s*(.+?)\s*$/m)?.[1];
		assert.ok(otherGitDir);
		fs.writeFileSync(path.join(project, ".git"), `gitdir: ${otherGitDir}\n`);
		const agent = makeAgent({ memory: { scope: "project", path: "probe" }, tools: ["write"] });
		assert.equal(resolveAgentMemoryAppendTarget(agent, project)?.rootDir, path.join(project, ".pi", AGENT_MEMORY_DIR_NAME));
	});

	it("rejects self-consistent forged worktree metadata that Git does not recognize", () => {
		const project = mkProject();
		const fakeMain = mkdtemp("pi-subagents-mem-forged-main-");
		const fakeWorktreeGitDir = path.join(fakeMain, ".git", "worktrees", "forged");
		fs.mkdirSync(fakeWorktreeGitDir, { recursive: true });
		fs.writeFileSync(path.join(project, ".git"), `gitdir: ${fakeWorktreeGitDir}\n`);
		fs.writeFileSync(path.join(fakeWorktreeGitDir, "gitdir"), `${path.join(project, ".git")}\n`);
		const agent = makeAgent({ memory: { scope: "project", path: "probe" }, tools: ["write"] });
		assert.equal(resolveAgentMemoryAppendTarget(agent, project)?.rootDir, path.join(project, ".pi", AGENT_MEMORY_DIR_NAME));
	});

	it("uses the Git root when a linked worktree has no local project config directory", () => {
		const root = mkdtemp("pi-subagents-mem-unconfigured-worktree-");
		const project = path.join(root, "project");
		const worktree = path.join(root, "worktree");
		fs.mkdirSync(project, { recursive: true });
		fs.writeFileSync(path.join(project, "tracked.txt"), "fixture\n");
		execFileSync("git", ["init", "-q"], { cwd: project });
		execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: project });
		execFileSync("git", ["config", "user.name", "Test"], { cwd: project });
		execFileSync("git", ["add", "tracked.txt"], { cwd: project });
		execFileSync("git", ["commit", "-qm", "fixture"], { cwd: project });
		execFileSync("git", ["worktree", "add", "-qb", "probe", worktree], { cwd: project });
		const memoryDir = path.join(project, ".pi", AGENT_MEMORY_DIR_NAME, "probe");
		writeMemoryFile(memoryDir, "marker: git-root-memory\n");
		const agent = makeAgent({ memory: { scope: "project", path: "probe" }, tools: ["read"] });
		assert.equal(findNearestProjectRoot(worktree), null);
		assert.match(buildAgentMemoryInjection(agent, worktree), /marker: git-root-memory/);
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

describe("appendAgentMemoryRecord", () => {
	it("appends complete newline-terminated records without replacing prior entries", () => {
		const rootDir = path.join(mkdtemp("pi-subagents-mem-append-"), AGENT_MEMORY_DIR_NAME);
		const target = { rootDir, scopedPath: "worker" };
		appendAgentMemoryRecord(target, "first");
		appendAgentMemoryRecord(target, "second\n");
		assert.equal(fs.readFileSync(path.join(rootDir, "worker", AGENT_MEMORY_FILE), "utf8"), "first\nsecond\n");
	});

	it("preserves records appended by concurrent processes", async () => {
		const rootDir = path.join(mkdtemp("pi-subagents-mem-multiprocess-"), AGENT_MEMORY_DIR_NAME);
		const moduleUrl = new URL("../../src/agents/agent-memory.ts", import.meta.url).href;
		const markers = Array.from({ length: 8 }, (_, index) => `process-${index}`);
		await Promise.all(markers.map((marker) => new Promise<void>((resolve, reject) => {
			const script = `import { appendAgentMemoryRecord } from ${JSON.stringify(moduleUrl)}; appendAgentMemoryRecord(${JSON.stringify({ rootDir, scopedPath: "worker" })}, ${JSON.stringify(marker)});`;
			const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], { stdio: ["ignore", "ignore", "pipe"] });
			let stderr = "";
			child.stderr.on("data", (chunk) => { stderr += chunk; });
			child.on("error", reject);
			child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`append process exited ${code}: ${stderr}`)));
		})));
		const lines = fs.readFileSync(path.join(rootDir, "worker", AGENT_MEMORY_FILE), "utf8").trim().split("\n");
		assert.equal(lines.length, markers.length);
		assert.deepEqual(new Set(lines), new Set(markers));
	});

	it("rejects a memory root replaced while preparing the scoped directory", { concurrency: false }, () => {
		const parent = mkdtemp("pi-subagents-mem-root-swap-");
		const rootDir = path.join(parent, AGENT_MEMORY_DIR_NAME);
		const originalRoot = `${rootDir}-original`;
		const memoryDir = path.join(rootDir, "worker");
		fs.mkdirSync(memoryDir, { recursive: true });
		const nativeFs = createRequire(import.meta.url)("node:fs");
		const originalMkdir = nativeFs.mkdirSync;
		let swapped = false;
		// SAFETY: this test temporarily replaces Node's exact mkdirSync function and restores it in finally.
		const patchedMkdir = ((target: fs.PathLike, options?: fs.MakeDirectoryOptions & { recursive?: false }) => {
			if (!swapped && path.resolve(String(target)) === path.resolve(memoryDir)) {
				swapped = true;
				fs.renameSync(rootDir, originalRoot);
				originalMkdir(rootDir);
			}
			return originalMkdir(target, options);
		}) as typeof fs.mkdirSync;
		Reflect.set(nativeFs, "mkdirSync", patchedMkdir);
		syncBuiltinESMExports();
		try {
			assert.throws(() => appendAgentMemoryRecord({ rootDir, scopedPath: "worker" }, "blocked"), /root changed/);
			assert.equal(fs.existsSync(path.join(rootDir, "worker", AGENT_MEMORY_FILE)), false);
		} finally {
			Reflect.set(nativeFs, "mkdirSync", originalMkdir);
			syncBuiltinESMExports();
			if (swapped) {
				fs.rmSync(rootDir, { recursive: true, force: true });
				fs.renameSync(originalRoot, rootDir);
			}
		}
	});

	it("rejects hard-linked records without changing the outside inode", () => {
		const rootDir = path.join(mkdtemp("pi-subagents-mem-hardlink-append-"), AGENT_MEMORY_DIR_NAME);
		const memoryDir = path.join(rootDir, "worker");
		const outside = path.join(mkdtemp("pi-subagents-mem-hardlink-outside-"), "outside.md");
		fs.mkdirSync(memoryDir, { recursive: true });
		fs.writeFileSync(outside, "outside\n", { mode: 0o640 });
		const outsideMode = fs.statSync(outside).mode;
		try {
			fs.linkSync(outside, path.join(memoryDir, AGENT_MEMORY_FILE));
		} catch {
			return;
		}
		assert.throws(() => appendAgentMemoryRecord({ rootDir, scopedPath: "worker" }, "blocked"), /multiple links/);
		assert.equal(fs.readFileSync(outside, "utf8"), "outside\n");
		assert.equal(fs.statSync(outside).mode, outsideMode);
	});

	it("rejects empty, oversized, and symlinked records", () => {
		const rootDir = path.join(mkdtemp("pi-subagents-mem-append-"), AGENT_MEMORY_DIR_NAME);
		const target = { rootDir, scopedPath: "worker" };
		assert.throws(() => appendAgentMemoryRecord(target, ""), /cannot be empty/);
		assert.throws(() => appendAgentMemoryRecord(target, "x".repeat(MAX_MEMORY_APPEND_BYTES + 1)), /exceeds/);
		const memoryDir = path.join(rootDir, "worker");
		fs.mkdirSync(memoryDir, { recursive: true });
		const outside = path.join(mkdtemp("pi-subagents-mem-append-outside-"), "outside.md");
		fs.writeFileSync(outside, "outside\n");
		try {
			fs.symlinkSync(outside, path.join(memoryDir, AGENT_MEMORY_FILE));
		} catch {
			return;
		}
		assert.throws(() => appendAgentMemoryRecord(target, "blocked"), /must not be a symlink/);

		fs.rmSync(path.join(memoryDir, AGENT_MEMORY_FILE));
		fs.rmSync(memoryDir, { recursive: true });
		try {
			fs.symlinkSync(path.dirname(outside), memoryDir);
		} catch {
			return;
		}
		assert.throws(() => appendAgentMemoryRecord(target, "blocked"), /Unsafe agent memory path/);
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
