import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentConfig } from "../agents/agents.ts";
import type { ExtensionConfig, ScopedRuntimeConfig } from "./types.ts";

const SCOPED_KEYS = [
	"defaultSessionDir",
	"worktreeRoot",
	"worktreeSetupHook",
	"worktreeSetupHookTimeoutMs",
	"keepWorktrees",
] as const;

type ScopedKey = (typeof SCOPED_KEYS)[number];

export interface ProjectRuntimeConfig {
	config: Partial<ExtensionConfig>;
	baseDir?: string;
}

export interface RuntimePathContext {
	cwd: string;
	baseDir?: string;
	agent?: string;
	runId?: string;
	index?: number;
}

function isDirectory(filePath: string): boolean {
	try {
		return fs.statSync(filePath).isDirectory();
	} catch {
		return false;
	}
}

function findNearestProjectRoot(cwd: string): string | undefined {
	let current = path.resolve(cwd);
	while (true) {
		if (isDirectory(path.join(current, ".pi")) || isDirectory(path.join(current, ".agents"))) return current;
		const parent = path.dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

function readJsonObject(filePath: string): Record<string, unknown> | undefined {
	if (!fs.existsSync(filePath)) return undefined;
	const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf-8"));
	return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
}

function readScopedConfig(input: unknown): ScopedRuntimeConfig | undefined {
	if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
	const source = input as Record<string, unknown>;
	const out: ScopedRuntimeConfig = {};
	for (const key of SCOPED_KEYS) {
		const value = source[key];
		if (typeof value === "string" && value.trim()) (out as Record<ScopedKey, unknown>)[key] = value.trim();
		else if (key === "worktreeSetupHookTimeoutMs" && typeof value === "number" && Number.isInteger(value) && value > 0) out.worktreeSetupHookTimeoutMs = value;
		else if (key === "keepWorktrees" && typeof value === "boolean") out.keepWorktrees = value;
	}
	return Object.keys(out).length ? out : undefined;
}

function readAgentDefaults(input: unknown): Record<string, ScopedRuntimeConfig> | undefined {
	if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
	const out: Record<string, ScopedRuntimeConfig> = {};
	for (const [name, value] of Object.entries(input)) {
		const scoped = readScopedConfig(value);
		if (scoped) out[name] = scoped;
	}
	return Object.keys(out).length ? out : undefined;
}

export function readProjectRuntimeConfig(cwd: string): ProjectRuntimeConfig {
	const projectRoot = findNearestProjectRoot(cwd);
	if (!projectRoot) return { config: {} };
	const settingsPath = path.join(projectRoot, ".pi", "settings.json");
	try {
		const settings = readJsonObject(settingsPath);
		const subagents = settings?.subagents;
		if (!subagents || typeof subagents !== "object" || Array.isArray(subagents)) return { config: {}, baseDir: projectRoot };
		const scoped = readScopedConfig(subagents) ?? {};
		const agentDefaults = readAgentDefaults((subagents as Record<string, unknown>).agentDefaults);
		return { config: { ...scoped, ...(agentDefaults ? { agentDefaults } : {}) }, baseDir: projectRoot };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to read project subagent runtime config '${settingsPath}': ${message}`, { cause: error });
	}
}

export function mergeRuntimeConfig(globalConfig: ExtensionConfig, projectConfig: Partial<ExtensionConfig>): ExtensionConfig {
	return {
		...globalConfig,
		...projectConfig,
		agentDefaults: {
			...(globalConfig.agentDefaults ?? {}),
			...(projectConfig.agentDefaults ?? {}),
		},
	};
}

export function resolveAgentRuntimeConfig(config: ExtensionConfig, agent: string | undefined, agentConfig?: AgentConfig): ScopedRuntimeConfig {
	const agentDefaults = agent ? config.agentDefaults?.[agent] : undefined;
	return {
		defaultSessionDir: agentConfig?.defaultSessionDir ?? agentDefaults?.defaultSessionDir ?? config.defaultSessionDir,
		worktreeRoot: agentConfig?.worktreeRoot ?? agentDefaults?.worktreeRoot ?? config.worktreeRoot,
		worktreeSetupHook: agentConfig?.worktreeSetupHook ?? agentDefaults?.worktreeSetupHook ?? config.worktreeSetupHook,
		worktreeSetupHookTimeoutMs: agentConfig?.worktreeSetupHookTimeoutMs ?? agentDefaults?.worktreeSetupHookTimeoutMs ?? config.worktreeSetupHookTimeoutMs,
		keepWorktrees: agentConfig?.keepWorktrees ?? agentDefaults?.keepWorktrees ?? config.keepWorktrees,
	};
}

export function expandRuntimePath(rawPath: string, context: RuntimePathContext): string {
	const expanded = rawPath
		.replaceAll("{cwd}", context.cwd)
		.replaceAll("{projectRoot}", context.baseDir ?? context.cwd)
		.replaceAll("{agent}", context.agent ?? "agent")
		.replaceAll("{runId}", context.runId ?? "run")
		.replaceAll("{index}", String(context.index ?? 0));
	const withHome = expanded.startsWith("~/") ? path.join(os.homedir(), expanded.slice(2)) : expanded;
	return path.isAbsolute(withHome) ? withHome : path.resolve(context.baseDir ?? context.cwd, withHome);
}
