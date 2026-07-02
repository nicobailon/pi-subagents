/**
 * Per-agent persistent memory scopes with read-only fallback.
 *
 * An agent definition may opt into a durable, role-specific memory scope via the
 * `memory` frontmatter field (e.g. `memory: { scope: "project", path:
 * "security-reviewer" }`). The first lines of a `MEMORY.md` file in the resolved
 * memory directory are injected into the child system prompt so recurring custom
 * agents can recall accumulated role notes. Agents without write tools receive a
 * read-only memory block instead.
 *
 * Memory directories live under a dedicated `agent-memory/` namespace so they
 * never collide with the owner's `~/.pi/agent/memory/{project}/` system.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, getProjectConfigDir } from "../shared/utils.ts";
import { findNearestProjectRoot, type AgentConfig, type AgentMemoryConfig } from "./agents.ts";

export const AGENT_MEMORY_DIR_NAME = "agent-memory";
export const AGENT_MEMORY_FILE = "MEMORY.md";
export const MAX_MEMORY_LINES = 200;
const MAX_MEMORY_BYTES = 16 * 1024;

const WRITE_TOOLS = new Set(["edit", "write", "bash"]);

/** Parse a `memory` frontmatter block string into a typed config, or undefined if invalid. */
export function parseMemoryFrontmatter(raw: string | undefined): AgentMemoryConfig | undefined {
	if (!raw) return undefined;
	const entries = new Map<string, string>();
	for (const line of raw.split("\n")) {
		const match = line.match(/^\s*([\w-]+):\s*(.*)$/);
		if (!match) continue;
		const key = match[1]!;
		let value = match[2]!.trim();
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
			value = value.slice(1, -1);
		}
		entries.set(key, value);
	}
	const scope = entries.get("scope");
	const scopedPath = entries.get("path");
	if (scope !== "project" && scope !== "user") return undefined;
	if (!scopedPath) return undefined;
	return { scope, path: scopedPath };
}

/** Whether an agent can write files this run (inherits default builtins when `tools` is unset). */
export function agentHasWriteTools(agent: Pick<AgentConfig, "tools">): boolean {
	const tools = agent.tools;
	if (!tools) return true;
	return tools.some((tool) => WRITE_TOOLS.has(tool));
}

function isWithin(child: string, parent: string): boolean {
	const rel = path.relative(parent, child);
	return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * Resolve a memory directory under `rootDir` for the given scoped path.
 *
 * Rejects empty paths, `.`/`..` segments, paths that escape the root, and
 * existing directories whose real path (via symlink) lands outside the root.
 */
export function resolveMemoryDir(
	rootDir: string,
	scopedPath: string,
): { dir: string } | { error: string } {
	const segments = scopedPath.split(/[/\\]/).map((segment) => segment.trim()).filter((segment) => segment.length > 0);
	if (segments.length === 0) return { error: "memory path is empty" };
	for (const segment of segments) {
		if (segment === "." || segment === "..") {
			return { error: `memory path segment '${segment}' is not allowed` };
		}
	}

	const memoryDir = path.resolve(rootDir, ...segments);
	if (!isWithin(memoryDir, rootDir)) {
		return { error: "memory path escapes the memory root" };
	}

	try {
		if (fs.existsSync(memoryDir)) {
			const rootReal = fs.existsSync(rootDir) ? fs.realpathSync(rootDir) : path.resolve(rootDir);
			const dirReal = fs.realpathSync(memoryDir);
			if (!isWithin(dirReal, rootReal)) {
				return { error: "memory path resolves outside the memory root" };
			}
		}
	} catch {
		// Treat unreadable paths as not-yet-created; the agent's write tools or
		// a later read will surface concrete filesystem errors.
	}

	return { dir: memoryDir };
}

type MemoryFileResult = { contents: string; byteCapped: boolean } | "unsafe" | null;

function truncateMemory(raw: string): { text: string; byteCapped: boolean } {
	const lines = raw.split("\n");
	let text = lines.slice(0, MAX_MEMORY_LINES).join("\n");
	let byteCapped = false;
	if (Buffer.byteLength(text, "utf-8") > MAX_MEMORY_BYTES) {
		text = Buffer.from(text, "utf-8").subarray(0, MAX_MEMORY_BYTES).toString("utf-8");
		byteCapped = true;
	}
	return { text, byteCapped };
}

/** Read `MEMORY.md` under `memoryDir`. Returns null when absent, `"unsafe"` for a symlink that escapes. */
export function readMemoryFile(memoryDir: string): MemoryFileResult {
	const file = path.join(memoryDir, AGENT_MEMORY_FILE);
	let stat: fs.Stats;
	try {
		stat = fs.statSync(file);
	} catch {
		return null;
	}
	if (!stat.isFile()) return null;

	try {
		const lstat = fs.lstatSync(file);
		if (lstat.isSymbolicLink()) {
			const dirReal = fs.realpathSync(memoryDir);
			const fileReal = fs.realpathSync(file);
			if (!isWithin(fileReal, dirReal)) return "unsafe";
		}
	} catch {
		return null;
	}

	let raw: string;
	try {
		raw = fs.readFileSync(file, "utf-8");
	} catch {
		return null;
	}
	const truncated = truncateMemory(raw);
	return { contents: truncated.text, byteCapped: truncated.byteCapped };
}

/**
 * Build the memory block to append to a child system prompt.
 *
 * Returns an empty string when the agent has no memory scope, the scope cannot
 * be resolved safely, or a read-only agent has no memory file yet (nothing to
 * recall). Read-write agents always receive the scope block so they can create
 * the memory file on the first run.
 */
export function buildAgentMemoryInjection(agent: AgentConfig, cwd: string): string {
	const memory = agent.memory;
	if (!memory) return "";

	let rootDir: string;
	if (memory.scope === "user") {
		rootDir = path.join(getAgentDir(), AGENT_MEMORY_DIR_NAME);
	} else {
		const projectRoot = findNearestProjectRoot(cwd);
		if (!projectRoot) return "";
		rootDir = path.join(getProjectConfigDir(projectRoot), AGENT_MEMORY_DIR_NAME);
	}

	const resolved = resolveMemoryDir(rootDir, memory.path);
	if ("error" in resolved) return "";
	const memoryDir = resolved.dir;

	const fileResult = readMemoryFile(memoryDir);
	if (fileResult === "unsafe") return "";
	const hasWrite = agentHasWriteTools(agent);
	const hasContents = fileResult !== null;
	if (!hasWrite && !hasContents) return "";

	const memoryFile = path.join(memoryDir, AGENT_MEMORY_FILE);
	const truncateNote = (byteCapped: boolean) =>
		`Current memory contents (first ${MAX_MEMORY_LINES} lines${byteCapped ? ", byte-capped" : ""}):`;

	if (hasWrite) {
		const lines = [
			"# Persistent agent memory",
			"",
			"You have a durable, role-specific memory scope shared across recurring runs of this agent.",
			`Memory file: ${memoryFile}`,
			"",
			"Read this file at the start of a task to recall accumulated role notes (threat models, gotchas, verified commands, decisions). When you produce durable, reusable role knowledge worth keeping for future runs, append a concise dated entry to the file with your editing tools. Only persist generally reusable role knowledge, not one-off task details, full transcripts, or secrets. Keep entries short and high-signal.",
		];
		if (hasContents) {
			const result = fileResult as { contents: string; byteCapped: boolean };
			lines.push("", truncateNote(result.byteCapped), "---", result.contents, "---");
		} else {
			lines.push("", `No ${AGENT_MEMORY_FILE} exists yet at the path above. You may create it to begin accumulating notes for this role.`);
		}
		return lines.join("\n");
	}

	const result = fileResult as { contents: string; byteCapped: boolean };
	return [
		"# Persistent agent memory",
		"",
		"You have a read-only, role-specific memory scope for recurring runs of this agent.",
		`Memory file: ${memoryFile}`,
		"",
		"Use the contents below as accumulated role context. Do not attempt to edit or create the memory file; you do not have write tools this run.",
		"",
		truncateNote(result.byteCapped),
		"---",
		result.contents,
		"---",
	].join("\n");
}
