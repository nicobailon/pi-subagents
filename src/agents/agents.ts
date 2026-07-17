/**
 * Agent discovery and configuration
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import { parse as parseYaml } from "yaml";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { AcceptanceInput, AcceptanceRole, OutputMode, ToolBudgetConfig, TurnBudgetConfig } from "../shared/types.ts";
import { getAgentDir, getProjectConfigDir } from "../shared/utils.ts";
import { KNOWN_FIELDS } from "./agent-serializer.ts";
import { parseChain, parseJsonChain } from "./chain-serializer.ts";
import { mergeAgentsForScope } from "./agent-selection.ts";
import { parseFrontmatter, parseFrontmatterList } from "./frontmatter.ts";
import { buildRuntimeName, parsePackageName } from "./identity.ts";
import { parseModelScopeConfig, type ModelScopeConfig } from "../runs/shared/model-scope.ts";
export { buildRuntimeName, frontmatterNameForConfig, parsePackageName } from "./identity.ts";
import { parseMemoryFrontmatter } from "./agent-memory.ts";
import { resolveTurnBudgetConfig } from "../runs/shared/turn-budget.ts";
import { validateAcceptanceInput } from "../runs/shared/acceptance.ts";

export type AgentScope = "user" | "project" | "both";

export type AgentSource = "builtin" | "package" | "user" | "project";
type SystemPromptMode = "append" | "replace";
export type AgentDefaultContext = "fresh" | "fork";

export type AgentMemoryScope = "project" | "user";

export interface AgentMemoryConfig {
	scope: AgentMemoryScope;
	path: string;
}

export const BUILTIN_AGENT_NAMES = [
	"context-builder",
	"delegate",
	"oracle",
	"planner",
	"researcher",
	"reviewer",
	"scout",
	"worker",
] as const;

export function defaultSystemPromptMode(name: string): SystemPromptMode {
	return name === "delegate" ? "append" : "replace";
}

export function defaultInheritProjectContext(name: string): boolean {
	return name === "delegate";
}

export function defaultInheritSkills(): boolean {
	return false;
}

export interface BuiltinAgentOverrideBase {
	model?: string;
	fallbackModels?: string[];
	thinking?: string | false;
	systemPromptMode: SystemPromptMode;
	inheritProjectContext: boolean;
	inheritSkills: boolean;
	defaultContext?: AgentDefaultContext;
	acceptanceRole?: AcceptanceRole;
	disabled?: boolean;
	systemPrompt: string;
	skills?: string[];
	skillPath?: string[];
	tools?: string[];
	mcpDirectTools?: string[];
	subagentOnlyExtensions?: string[];
	completionGuard?: boolean;
	toolBudget?: ToolBudgetConfig;
}

interface BuiltinAgentOverrideConfig {
	model?: string | false;
	fallbackModels?: string[] | false;
	thinking?: string | false;
	systemPromptMode?: SystemPromptMode;
	inheritProjectContext?: boolean;
	inheritSkills?: boolean;
	defaultContext?: AgentDefaultContext | false;
	acceptanceRole?: AcceptanceRole | false;
	disabled?: boolean;
	systemPrompt?: string;
	skills?: string[] | false;
	tools?: string[] | false;
	subagentOnlyExtensions?: string[] | false;
	completionGuard?: boolean;
	toolBudget?: ToolBudgetConfig | false;
}

interface BuiltinAgentOverrideInfo {
	scope: "user" | "project";
	path: string;
	base: BuiltinAgentOverrideBase;
}

export interface AgentModelSourceInfo {
	type: "subagents.defaultModel";
	scope: "user" | "project";
	path: string;
	model: string;
}

export interface AgentConfig {
	name: string;
	localName?: string;
	packageName?: string;
	description: string;
	tools?: string[];
	mcpDirectTools?: string[];
	model?: string;
	fallbackModels?: string[];
	thinking?: string | false;
	systemPromptMode: SystemPromptMode;
	inheritProjectContext: boolean;
	inheritSkills: boolean;
	defaultContext?: AgentDefaultContext;
	defaultAsync?: boolean;
	defaultTimeoutMs?: number;
	defaultTurnBudget?: TurnBudgetConfig;
	defaultAcceptance?: AcceptanceInput;
	acceptanceRole?: AcceptanceRole;
	systemPrompt: string;
	source: AgentSource;
	filePath: string;
	skills?: string[];
	skillPath?: string[];
	extensions?: string[];
	subagentOnlyExtensions?: string[];
	output?: string;
	defaultReads?: string[];
	defaultProgress?: boolean;
	interactive?: boolean;
	maxSubagentDepth?: number;
	completionGuard?: boolean;
	toolBudget?: ToolBudgetConfig;
	memory?: AgentMemoryConfig;
	disabled?: boolean;
	extraFields?: Record<string, string>;
	override?: BuiltinAgentOverrideInfo;
	modelSource?: AgentModelSourceInfo;
}

interface SubagentSettings {
	overrides: Record<string, BuiltinAgentOverrideConfig>;
	defaultModel?: string;
	disableBuiltins?: boolean;
	disableThinking?: boolean;
	modelScope?: ModelScopeConfig;
}

const EMPTY_SUBAGENT_SETTINGS: SubagentSettings = { overrides: {} };
const agentFrontmatterFields = new WeakMap<AgentConfig, Set<string>>();

export interface ChainStepConfig {
	agent?: string;
	task?: string;
	phase?: string;
	label?: string;
	as?: string;
	outputSchema?: string | Record<string, unknown>;
	output?: string | false;
	outputMode?: OutputMode;
	reads?: string[] | false;
	model?: string;
	skills?: string[] | false;
	progress?: boolean;
	parallel?: unknown;
	expand?: unknown;
	collect?: unknown;
	concurrency?: number;
	failFast?: boolean;
	worktree?: boolean;
	acceptance?: AcceptanceInput;
	toolBudget?: ToolBudgetConfig;
}

export interface ChainConfig {
	name: string;
	localName?: string;
	packageName?: string;
	description: string;
	source: AgentSource;
	filePath: string;
	steps: ChainStepConfig[];
	extraFields?: Record<string, string>;
}

export interface ChainDiscoveryDiagnostic {
	source: AgentSource;
	filePath: string;
	error: string;
}

interface AgentDiscoveryResult {
	agents: AgentConfig[];
	projectAgentsDir: string | null;
	modelScope?: ModelScopeConfig;
}

function getUserChainDir(): string {
	return path.join(getAgentDir(), "chains");
}

interface PackageSubagentPaths {
	agents: string[];
	chains: string[];
}

let cachedGlobalNpmRoot: string | null = null;

function readJsonFileBestEffort(filePath: string): unknown {
	try {
		return JSON.parse(fs.readFileSync(filePath, "utf-8"));
	} catch {
		// Installed package scans are opportunistic; bad third-party manifests
		// should not break local agent discovery.
		return null;
	}
}

function readOptionalJsonFile(filePath: string): unknown {
	try {
		return JSON.parse(fs.readFileSync(filePath, "utf-8"));
	} catch (error) {
		const code = typeof error === "object" && error !== null && "code" in error
			? (error as { code?: unknown }).code
			: undefined;
		if (code === "ENOENT") return null;
		throw error;
	}
}

function isSafePackagePath(value: string): boolean {
	return value.length > 0
		&& !path.isAbsolute(value)
		&& value.split(/[\\/]/).every((part) => part.length > 0 && part !== "." && part !== "..");
}

function parseNpmPackageName(source: string): string | undefined {
	const spec = source.slice(4).trim();
	if (!spec) return undefined;
	const match = spec.match(/^(@?[^@]+(?:\/[^@]+)?)(?:@(.+))?$/);
	const packageName = match?.[1] ?? spec;
	return isSafePackagePath(packageName) ? packageName : undefined;
}

function stripGitRef(repoPath: string): string {
	const atIndex = repoPath.indexOf("@");
	const hashIndex = repoPath.indexOf("#");
	const refIndex = [atIndex, hashIndex].filter((index) => index >= 0).sort((a, b) => a - b)[0];
	return refIndex === undefined ? repoPath : repoPath.slice(0, refIndex);
}

function parseGitPackagePath(source: string): { host: string; repoPath: string } | undefined {
	const spec = source.slice(4).trim();
	if (!spec) return undefined;

	let host = "";
	let repoPath = "";
	const scpLike = spec.match(/^git@([^:]+):(.+)$/);
	if (scpLike) {
		host = scpLike[1] ?? "";
		repoPath = scpLike[2] ?? "";
	} else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(spec)) {
		try {
			const url = new URL(spec);
			host = url.hostname;
			repoPath = url.pathname.replace(/^\/+/, "");
		} catch {
			return undefined;
		}
	} else {
		const slashIndex = spec.indexOf("/");
		if (slashIndex < 0) return undefined;
		host = spec.slice(0, slashIndex);
		repoPath = spec.slice(slashIndex + 1);
	}

	const normalizedPath = stripGitRef(repoPath).replace(/\.git$/, "").replace(/^\/+/, "");
	if (!host || !isSafePackagePath(host) || !isSafePackagePath(normalizedPath) || normalizedPath.split(/[\\/]/).length < 2) {
		return undefined;
	}
	return { host, repoPath: normalizedPath };
}

function resolveSettingsPackageRoot(source: string, baseDir: string): string | undefined {
	const trimmed = source.trim();
	if (!trimmed) return undefined;
	if (trimmed.startsWith("git:")) {
		const parsed = parseGitPackagePath(trimmed);
		return parsed ? path.join(baseDir, "git", parsed.host, parsed.repoPath) : undefined;
	}
	if (trimmed.startsWith("npm:")) {
		const packageName = parseNpmPackageName(trimmed);
		return packageName ? path.join(baseDir, "npm", "node_modules", packageName) : undefined;
	}
	const normalized = trimmed.startsWith("file:") ? trimmed.slice(5) : trimmed;
	if (normalized === "~") return os.homedir();
	if (normalized.startsWith("~/")) return path.join(os.homedir(), normalized.slice(2));
	if (path.isAbsolute(normalized)) return normalized;
	if (normalized === "." || normalized === ".." || normalized.startsWith("./") || normalized.startsWith("../")) {
		return path.resolve(baseDir, normalized);
	}
	return undefined;
}

function getGlobalNpmRoot(): string | null {
	const offline = process.env.PI_OFFLINE?.toLowerCase();
	if (offline === "1" || offline === "true" || offline === "yes") return null;
	if (cachedGlobalNpmRoot !== null) return cachedGlobalNpmRoot;
	try {
		cachedGlobalNpmRoot = fs.realpathSync(execSync("npm root -g", { encoding: "utf-8", timeout: 5000 }).trim());
		return cachedGlobalNpmRoot;
	} catch {
		cachedGlobalNpmRoot = "";
		return null;
	}
}

function stringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
}

function extractSubagentPathsFromPackageRoot(packageRoot: string): PackageSubagentPaths {
	const packageJsonPath = path.join(packageRoot, "package.json");
	const pkg = readJsonFileBestEffort(packageJsonPath);
	if (!pkg || typeof pkg !== "object" || Array.isArray(pkg)) return { agents: [], chains: [] };

	const roots: Record<string, unknown>[] = [];
	const piSubagents = (pkg as { "pi-subagents"?: unknown })["pi-subagents"];
	if (piSubagents && typeof piSubagents === "object" && !Array.isArray(piSubagents)) {
		roots.push(piSubagents as Record<string, unknown>);
	}

	const pi = (pkg as { pi?: unknown }).pi;
	if (pi && typeof pi === "object" && !Array.isArray(pi)) {
		const subagents = (pi as { subagents?: unknown }).subagents;
		if (subagents && typeof subagents === "object" && !Array.isArray(subagents)) {
			roots.push(subagents as Record<string, unknown>);
		}
	}

	const agents: string[] = [];
	const chains: string[] = [];
	for (const root of roots) {
		for (const entry of stringArray(root.agents)) agents.push(path.resolve(packageRoot, entry));
		for (const entry of stringArray(root.chains)) chains.push(path.resolve(packageRoot, entry));
	}
	return { agents, chains };
}

function collectPackageRootsFromNodeModules(nodeModulesDir: string): string[] {
	const roots: string[] = [];
	if (!fs.existsSync(nodeModulesDir)) return roots;

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(nodeModulesDir, { withFileTypes: true });
	} catch {
		return roots;
	}

	for (const entry of entries) {
		if (entry.name.startsWith(".")) continue;
		if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;

		if (entry.name.startsWith("@")) {
			const scopeDir = path.join(nodeModulesDir, entry.name);
			let scopeEntries: fs.Dirent[];
			try {
				scopeEntries = fs.readdirSync(scopeDir, { withFileTypes: true });
			} catch {
				continue;
			}
			for (const scopeEntry of scopeEntries) {
				if (scopeEntry.name.startsWith(".")) continue;
				if (!scopeEntry.isDirectory() && !scopeEntry.isSymbolicLink()) continue;
				roots.push(path.join(scopeDir, scopeEntry.name));
			}
			continue;
		}

		roots.push(path.join(nodeModulesDir, entry.name));
	}
	return roots;
}

function collectSettingsPackageRoots(settingsFile: string, baseDir: string): string[] {
	const settings = readOptionalJsonFile(settingsFile);
	if (!settings || typeof settings !== "object" || Array.isArray(settings)) return [];
	const packages = (settings as { packages?: unknown }).packages;
	if (!Array.isArray(packages)) return [];

	const roots: string[] = [];
	for (const entry of packages) {
		const packageSource = typeof entry === "string"
			? entry
			: typeof entry === "object" && entry !== null && typeof (entry as { source?: unknown }).source === "string"
				? (entry as { source: string }).source
				: undefined;
		if (!packageSource) continue;
		const packageRoot = resolveSettingsPackageRoot(packageSource, baseDir);
		if (packageRoot) roots.push(packageRoot);
	}
	return roots;
}

function collectPackageSubagentPaths(cwd: string, options: { includeUser: boolean; includeProject: boolean } = { includeUser: true, includeProject: true }): PackageSubagentPaths {
	const agentDir = getAgentDir();
	const projectRoot = findNearestProjectRoot(cwd) ?? cwd;
	const packageRoots = [
		projectRoot,
	];

	if (options.includeProject) {
		const projectConfigDir = getProjectConfigDir(projectRoot);
		packageRoots.push(
			...collectPackageRootsFromNodeModules(path.join(projectConfigDir, "npm", "node_modules")),
			...collectSettingsPackageRoots(path.join(projectConfigDir, "settings.json"), projectConfigDir),
		);
	}

	if (options.includeUser) {
		packageRoots.push(
			...collectPackageRootsFromNodeModules(path.join(agentDir, "npm", "node_modules")),
			...collectSettingsPackageRoots(path.join(agentDir, "settings.json"), agentDir),
		);
	}

	if (options.includeUser) {
		const globalRoot = getGlobalNpmRoot();
		if (globalRoot) packageRoots.push(...collectPackageRootsFromNodeModules(globalRoot));
	}

	const seenRoots = new Set<string>();
	const seenAgents = new Set<string>();
	const seenChains = new Set<string>();
	const agents: string[] = [];
	const chains: string[] = [];
	for (const packageRoot of packageRoots) {
		const resolvedRoot = path.resolve(packageRoot);
		if (seenRoots.has(resolvedRoot)) continue;
		seenRoots.add(resolvedRoot);
		const paths = extractSubagentPathsFromPackageRoot(resolvedRoot);
		for (const agentDir of paths.agents) {
			if (seenAgents.has(agentDir)) continue;
			seenAgents.add(agentDir);
			agents.push(agentDir);
		}
		for (const chainDir of paths.chains) {
			if (seenChains.has(chainDir)) continue;
			seenChains.add(chainDir);
			chains.push(chainDir);
		}
	}
	return { agents, chains };
}

function splitToolList(rawTools: string[] | undefined): { tools?: string[]; mcpDirectTools?: string[] } {
	const mcpDirectTools: string[] = [];
	const tools: string[] = [];
	for (const tool of rawTools ?? []) {
		if (tool.startsWith("mcp:")) {
			mcpDirectTools.push(tool.slice(4));
		} else {
			tools.push(tool);
		}
	}
	return {
		...(tools.length > 0 ? { tools } : {}),
		...(mcpDirectTools.length > 0 ? { mcpDirectTools } : {}),
	};
}

function joinToolList(config: Pick<AgentConfig, "tools" | "mcpDirectTools">): string[] | undefined {
	const joined = [
		...(config.tools ?? []),
		...(config.mcpDirectTools ?? []).map((tool) => `mcp:${tool}`),
	];
	return joined.length > 0 ? joined : undefined;
}

function arraysEqual(a: string[] | undefined, b: string[] | undefined): boolean {
	if (!a && !b) return true;
	if (!a || !b) return false;
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) return false;
	}
	return true;
}

function cloneOverrideBase(agent: AgentConfig): BuiltinAgentOverrideBase {
	return {
		model: agent.model,
		fallbackModels: agent.fallbackModels ? [...agent.fallbackModels] : undefined,
		thinking: agent.thinking,
		systemPromptMode: agent.systemPromptMode,
		inheritProjectContext: agent.inheritProjectContext,
		inheritSkills: agent.inheritSkills,
		defaultContext: agent.defaultContext,
		acceptanceRole: agent.acceptanceRole,
		disabled: agent.disabled,
		systemPrompt: agent.systemPrompt,
		skills: agent.skills ? [...agent.skills] : undefined,
		skillPath: agent.skillPath ? [...agent.skillPath] : undefined,
		tools: agent.tools ? [...agent.tools] : undefined,
		mcpDirectTools: agent.mcpDirectTools ? [...agent.mcpDirectTools] : undefined,
		subagentOnlyExtensions: agent.subagentOnlyExtensions ? [...agent.subagentOnlyExtensions] : undefined,
		completionGuard: agent.completionGuard,
		toolBudget: agent.toolBudget,
	};
}

function cloneOverrideValue(override: BuiltinAgentOverrideConfig): BuiltinAgentOverrideConfig {
	return {
		...(override.model !== undefined ? { model: override.model } : {}),
		...(override.fallbackModels !== undefined
			? { fallbackModels: override.fallbackModels === false ? false : [...override.fallbackModels] }
			: {}),
		...(override.thinking !== undefined ? { thinking: override.thinking } : {}),
		...(override.systemPromptMode !== undefined ? { systemPromptMode: override.systemPromptMode } : {}),
		...(override.inheritProjectContext !== undefined ? { inheritProjectContext: override.inheritProjectContext } : {}),
		...(override.inheritSkills !== undefined ? { inheritSkills: override.inheritSkills } : {}),
		...(override.defaultContext !== undefined ? { defaultContext: override.defaultContext } : {}),
		...(override.acceptanceRole !== undefined ? { acceptanceRole: override.acceptanceRole } : {}),
		...(override.disabled !== undefined ? { disabled: override.disabled } : {}),
		...(override.systemPrompt !== undefined ? { systemPrompt: override.systemPrompt } : {}),
		...(override.skills !== undefined ? { skills: override.skills === false ? false : [...override.skills] } : {}),
		...(override.tools !== undefined ? { tools: override.tools === false ? false : [...override.tools] } : {}),
		...(override.subagentOnlyExtensions !== undefined ? { subagentOnlyExtensions: override.subagentOnlyExtensions === false ? false : [...override.subagentOnlyExtensions] } : {}),
		...(override.completionGuard !== undefined ? { completionGuard: override.completionGuard } : {}),
		...(override.toolBudget !== undefined ? { toolBudget: override.toolBudget === false ? false : { ...override.toolBudget, ...(Array.isArray(override.toolBudget.block) ? { block: [...override.toolBudget.block] } : {}) } } : {}),
	};
}

export function findNearestProjectRoot(cwd: string): string | null {
	let currentDir = cwd;
	while (true) {
		if (isDirectory(getProjectConfigDir(currentDir)) || isDirectory(path.join(currentDir, ".agents"))) {
			return currentDir;
		}

		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

function getUserAgentSettingsPath(): string {
	return path.join(getAgentDir(), "settings.json");
}

function getProjectAgentSettingsPath(cwd: string): string | null {
	const projectRoot = findNearestProjectRoot(cwd);
	return projectRoot ? path.join(getProjectConfigDir(projectRoot), "settings.json") : null;
}

function readSettingsFileStrict(filePath: string): Record<string, unknown> {
	if (!fs.existsSync(filePath)) return {};
	let raw: string;
	try {
		raw = fs.readFileSync(filePath, "utf-8");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to read settings file '${filePath}': ${message}`, { cause: error });
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to parse settings file '${filePath}': ${message}`, { cause: error });
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`Settings file '${filePath}' must contain a JSON object.`);
	}
	return parsed as Record<string, unknown>;
}

function writeSettingsFile(filePath: string, settings: Record<string, unknown>): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
}

function parseOverrideStringArrayOrFalse(
	value: unknown,
	meta: { filePath: string; name: string; field: string },
): string[] | false | undefined {
	if (value === undefined) return undefined;
	if (value === false) return false;
	if (!Array.isArray(value)) {
		throw new Error(`Builtin override '${meta.name}' in '${meta.filePath}' has invalid '${meta.field}'; expected an array of strings or false.`);
	}

	const items: string[] = [];
	for (const item of value) {
		if (typeof item !== "string") {
			throw new Error(`Builtin override '${meta.name}' in '${meta.filePath}' has invalid '${meta.field}'; expected an array of strings or false.`);
		}
		const trimmed = item.trim();
		if (trimmed) items.push(trimmed);
	}
	return items;
}

function parseBuiltinOverrideEntry(
	name: string,
	value: unknown,
	filePath: string,
): BuiltinAgentOverrideConfig | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`Builtin override '${name}' in '${filePath}' must be an object.`);
	}

	const input = value as Record<string, unknown>;
	const override: BuiltinAgentOverrideConfig = {};

	if ("model" in input) {
		if (typeof input.model === "string" || input.model === false) override.model = input.model;
		else throw new Error(`Builtin override '${name}' in '${filePath}' has invalid 'model'; expected a string or false.`);
	}

	if ("thinking" in input) {
		if (typeof input.thinking === "string" || input.thinking === false) override.thinking = input.thinking;
		else throw new Error(`Builtin override '${name}' in '${filePath}' has invalid 'thinking'; expected a string or false.`);
	}

	if ("systemPromptMode" in input) {
		if (input.systemPromptMode === "append" || input.systemPromptMode === "replace") {
			override.systemPromptMode = input.systemPromptMode;
		} else {
			throw new Error(`Builtin override '${name}' in '${filePath}' has invalid 'systemPromptMode'; expected 'append' or 'replace'.`);
		}
	}

	if ("inheritProjectContext" in input) {
		if (typeof input.inheritProjectContext === "boolean") {
			override.inheritProjectContext = input.inheritProjectContext;
		} else {
			throw new Error(`Builtin override '${name}' in '${filePath}' has invalid 'inheritProjectContext'; expected a boolean.`);
		}
	}

	if ("inheritSkills" in input) {
		if (typeof input.inheritSkills === "boolean") {
			override.inheritSkills = input.inheritSkills;
		} else {
			throw new Error(`Builtin override '${name}' in '${filePath}' has invalid 'inheritSkills'; expected a boolean.`);
		}
	}

	if ("defaultContext" in input) {
		if (input.defaultContext === "fresh" || input.defaultContext === "fork" || input.defaultContext === false) {
			override.defaultContext = input.defaultContext;
		} else {
			throw new Error(`Builtin override '${name}' in '${filePath}' has invalid 'defaultContext'; expected 'fresh', 'fork', or false.`);
		}
	}

	if ("acceptanceRole" in input) {
		if (input.acceptanceRole === "read-only" || input.acceptanceRole === "writer" || input.acceptanceRole === false) {
			override.acceptanceRole = input.acceptanceRole;
		} else {
			throw new Error(`Builtin override '${name}' in '${filePath}' has invalid 'acceptanceRole'; expected 'read-only', 'writer', or false.`);
		}
	}

	if ("disabled" in input) {
		if (typeof input.disabled === "boolean") {
			override.disabled = input.disabled;
		} else {
			throw new Error(`Builtin override '${name}' in '${filePath}' has invalid 'disabled'; expected a boolean.`);
		}
	}

	if ("completionGuard" in input) {
		if (typeof input.completionGuard === "boolean") {
			override.completionGuard = input.completionGuard;
		} else {
			throw new Error(`Builtin override '${name}' in '${filePath}' has invalid 'completionGuard'; expected a boolean.`);
		}
	}

	if ("toolBudget" in input) {
		if (input.toolBudget === false) {
			override.toolBudget = false;
		} else if (input.toolBudget && typeof input.toolBudget === "object" && !Array.isArray(input.toolBudget)) {
			override.toolBudget = input.toolBudget as ToolBudgetConfig;
		} else {
			throw new Error(`Builtin override '${name}' in '${filePath}' has invalid 'toolBudget'; expected an object or false.`);
		}
	}

	if ("systemPrompt" in input) {
		if (typeof input.systemPrompt === "string") override.systemPrompt = input.systemPrompt;
		else throw new Error(`Builtin override '${name}' in '${filePath}' has invalid 'systemPrompt'; expected a string.`);
	}

	const fallbackModels = parseOverrideStringArrayOrFalse(input.fallbackModels, { filePath, name, field: "fallbackModels" });
	if (fallbackModels !== undefined) override.fallbackModels = fallbackModels;

	const skills = parseOverrideStringArrayOrFalse(input.skills, { filePath, name, field: "skills" });
	if (skills !== undefined) override.skills = skills;

	const tools = parseOverrideStringArrayOrFalse(input.tools, { filePath, name, field: "tools" });
	if (tools !== undefined) override.tools = tools;

	const subagentOnlyExtensions = parseOverrideStringArrayOrFalse(input.subagentOnlyExtensions, { filePath, name, field: "subagentOnlyExtensions" });
	if (subagentOnlyExtensions !== undefined) override.subagentOnlyExtensions = subagentOnlyExtensions;

	return Object.keys(override).length > 0 ? override : undefined;
}

function readSubagentSettings(filePath: string | null): SubagentSettings {
	if (!filePath) return EMPTY_SUBAGENT_SETTINGS;
	const settings = readSettingsFileStrict(filePath);
	const subagents = settings.subagents;
	if (!subagents || typeof subagents !== "object" || Array.isArray(subagents)) return EMPTY_SUBAGENT_SETTINGS;

	const subagentsObject = subagents as Record<string, unknown>;
	let disableBuiltins: boolean | undefined;
	if ("disableBuiltins" in subagentsObject) {
		if (typeof subagentsObject.disableBuiltins === "boolean") {
			disableBuiltins = subagentsObject.disableBuiltins;
		} else {
			throw new Error(`Subagent settings in '${filePath}' have invalid 'disableBuiltins'; expected a boolean.`);
		}
	}
	let disableThinking: boolean | undefined;
	if ("disableThinking" in subagentsObject) {
		if (typeof subagentsObject.disableThinking === "boolean") {
			disableThinking = subagentsObject.disableThinking;
		} else {
			throw new Error(`Subagent settings in '${filePath}' have invalid 'disableThinking'; expected a boolean.`);
		}
	}
	let defaultModel: string | undefined;
	if ("defaultModel" in subagentsObject) {
		if (typeof subagentsObject.defaultModel === "string" && subagentsObject.defaultModel.trim()) {
			defaultModel = subagentsObject.defaultModel.trim();
		} else {
			throw new Error(`Subagent settings in '${filePath}' have invalid 'defaultModel'; expected a non-empty string.`);
		}
	}
	const modelScope = parseModelScopeConfig(subagentsObject.modelScope, { filePath });

	const parsed: Record<string, BuiltinAgentOverrideConfig> = {};
	const agentOverrides = subagentsObject.agentOverrides;
	if (!agentOverrides || typeof agentOverrides !== "object" || Array.isArray(agentOverrides)) {
		return { overrides: parsed, defaultModel, disableBuiltins, disableThinking, modelScope };
	}
	for (const [name, value] of Object.entries(agentOverrides)) {
		const override = parseBuiltinOverrideEntry(name, value, filePath);
		if (override) parsed[name] = override;
	}
	return { overrides: parsed, defaultModel, disableBuiltins, disableThinking, modelScope };
}

function resolveSubagentDefaultModel(
	userSettings: SubagentSettings,
	projectSettings: SubagentSettings,
	userSettingsPath: string,
	projectSettingsPath: string | null,
): AgentModelSourceInfo | undefined {
	if (projectSettingsPath && projectSettings.defaultModel !== undefined) {
		return { type: "subagents.defaultModel", scope: "project", path: projectSettingsPath, model: projectSettings.defaultModel };
	}
	return userSettings.defaultModel !== undefined
		? { type: "subagents.defaultModel", scope: "user", path: userSettingsPath, model: userSettings.defaultModel }
		: undefined;
}

function applySubagentDefaultModel(agents: AgentConfig[], defaultModel: AgentModelSourceInfo | undefined): AgentConfig[] {
	if (!defaultModel) return agents;
	return agents.map((agent) => {
		if (agent.model !== undefined) return agent;
		const next = { ...agent, model: defaultModel.model, modelSource: defaultModel };
		const frontmatterFields = agentFrontmatterFields.get(agent);
		if (frontmatterFields) agentFrontmatterFields.set(next, frontmatterFields);
		return next;
	});
}

function applyBuiltinOverride(
	agent: AgentConfig,
	override: BuiltinAgentOverrideConfig,
	meta: { scope: "user" | "project"; path: string },
): AgentConfig {
	const next: AgentConfig = {
		...agent,
		override: { ...meta, base: cloneOverrideBase(agent) },
	};

	if (override.model !== undefined) next.model = override.model === false ? undefined : override.model;
	if (override.fallbackModels !== undefined) {
		next.fallbackModels = override.fallbackModels === false ? undefined : [...override.fallbackModels];
	}
	if (override.thinking !== undefined) next.thinking = override.thinking === false ? undefined : override.thinking;
	if (override.systemPromptMode !== undefined) next.systemPromptMode = override.systemPromptMode;
	if (override.inheritProjectContext !== undefined) next.inheritProjectContext = override.inheritProjectContext;
	if (override.inheritSkills !== undefined) next.inheritSkills = override.inheritSkills;
	if (override.defaultContext !== undefined) next.defaultContext = override.defaultContext === false ? undefined : override.defaultContext;
	if (override.acceptanceRole !== undefined) next.acceptanceRole = override.acceptanceRole === false ? undefined : override.acceptanceRole;
	if (override.disabled !== undefined) next.disabled = override.disabled;
	if (override.systemPrompt !== undefined) next.systemPrompt = override.systemPrompt;
	if (override.skills !== undefined) next.skills = override.skills === false ? undefined : [...override.skills];
	if (override.tools !== undefined) {
		const { tools, mcpDirectTools } = splitToolList(override.tools === false ? [] : override.tools);
		next.tools = tools;
		next.mcpDirectTools = mcpDirectTools;
	}
	if (override.subagentOnlyExtensions !== undefined) {
		next.subagentOnlyExtensions = override.subagentOnlyExtensions === false ? undefined : [...override.subagentOnlyExtensions];
	}
	if (override.completionGuard !== undefined) next.completionGuard = override.completionGuard;
	if (override.toolBudget !== undefined) next.toolBudget = override.toolBudget === false ? undefined : override.toolBudget;

	return next;
}

function clearBuiltinThinking(agent: AgentConfig, meta: { scope: "user" | "project"; path: string }): AgentConfig {
	if (agent.thinking === undefined) return agent;
	return {
		...agent,
		thinking: undefined,
		override: agent.override ?? { ...meta, base: cloneOverrideBase(agent) },
	};
}

function applyBuiltinOverrides(
	builtinAgents: AgentConfig[],
	userSettings: SubagentSettings,
	projectSettings: SubagentSettings,
	userSettingsPath: string,
	projectSettingsPath: string | null,
): AgentConfig[] {
	const projectBulkDisabled = projectSettings.disableBuiltins === true && projectSettingsPath !== null;
	const userBulkDisabled = projectSettings.disableBuiltins === undefined && userSettings.disableBuiltins === true;
	const projectThinkingConfigured = projectSettings.disableThinking !== undefined && projectSettingsPath !== null;
	const disableThinking = projectThinkingConfigured ? projectSettings.disableThinking === true : userSettings.disableThinking === true;
	const disableThinkingMeta = projectThinkingConfigured
		? { scope: "project" as const, path: projectSettingsPath! }
		: { scope: "user" as const, path: userSettingsPath };

	const applyGlobalThinking = (agent: AgentConfig, hasExplicitThinkingOverride: boolean): AgentConfig => {
		if (!disableThinking || hasExplicitThinkingOverride) return agent;
		return clearBuiltinThinking(agent, disableThinkingMeta);
	};

	return builtinAgents.map((agent) => {
		const projectOverride = projectSettings.overrides[agent.name];
		if (projectOverride && projectSettingsPath) {
			return applyGlobalThinking(
				applyBuiltinOverride(agent, projectOverride, { scope: "project", path: projectSettingsPath }),
				projectOverride.thinking !== undefined,
			);
		}

		if (projectBulkDisabled && projectSettingsPath) {
			return applyGlobalThinking(
				applyBuiltinOverride(agent, { disabled: true }, { scope: "project", path: projectSettingsPath }),
				false,
			);
		}

		const userOverride = userSettings.overrides[agent.name];
		if (userOverride) {
			return applyGlobalThinking(
				applyBuiltinOverride(agent, userOverride, { scope: "user", path: userSettingsPath }),
				!projectThinkingConfigured && userOverride.thinking !== undefined,
			);
		}

		if (userBulkDisabled) {
			return applyGlobalThinking(
				applyBuiltinOverride(agent, { disabled: true }, { scope: "user", path: userSettingsPath }),
				false,
			);
		}

		return applyGlobalThinking(agent, false);
	});
}

export function agentHasFrontmatterField(agent: AgentConfig, ...fields: string[]): boolean {
	const frontmatterFields = agentFrontmatterFields.get(agent);
	return frontmatterFields ? fields.some((field) => frontmatterFields.has(field)) : false;
}

function applyCustomAgentOverride(
	agent: AgentConfig,
	override: BuiltinAgentOverrideConfig,
	meta: { scope: "user" | "project"; path: string },
): AgentConfig {
	let next: AgentConfig | undefined;
	let anyFilled = false;

	const mutable = (): AgentConfig => {
		next ??= { ...agent };
		return next;
	};

	const fill = <K extends keyof AgentConfig>(
		field: K,
		frontmatterFields: string[],
		value: AgentConfig[K],
	): void => {
		if (agentHasFrontmatterField(agent, ...frontmatterFields)) return;
		mutable()[field] = value;
		anyFilled = true;
	};

	if (override.model !== undefined) {
		fill("model", ["model"], override.model === false ? undefined : override.model);
	}
	if (override.fallbackModels !== undefined) {
		fill(
			"fallbackModels",
			["fallbackModels"],
			override.fallbackModels === false ? undefined : [...override.fallbackModels],
		);
	}
	if (override.thinking !== undefined) {
		fill("thinking", ["thinking"], override.thinking === false ? undefined : override.thinking);
	}
	if (override.systemPromptMode !== undefined) {
		fill("systemPromptMode", ["systemPromptMode"], override.systemPromptMode);
	}
	if (override.inheritProjectContext !== undefined) {
		fill("inheritProjectContext", ["inheritProjectContext"], override.inheritProjectContext);
	}
	if (override.inheritSkills !== undefined) {
		fill("inheritSkills", ["inheritSkills"], override.inheritSkills);
	}
	if (override.defaultContext !== undefined) {
		fill("defaultContext", ["defaultContext"], override.defaultContext === false ? undefined : override.defaultContext);
	}
	if (override.acceptanceRole !== undefined) {
		fill("acceptanceRole", ["acceptanceRole"], override.acceptanceRole === false ? undefined : override.acceptanceRole);
	}
	if (override.disabled !== undefined && agent.disabled === undefined) {
		mutable().disabled = override.disabled;
		anyFilled = true;
	}
	if (override.skills !== undefined) {
		fill("skills", ["skill", "skills"], override.skills === false ? undefined : [...override.skills]);
	}
	if (override.tools !== undefined && !agentHasFrontmatterField(agent, "tools")) {
		const { tools, mcpDirectTools } = splitToolList(override.tools === false ? [] : override.tools);
		const target = mutable();
		target.tools = tools;
		target.mcpDirectTools = mcpDirectTools;
		anyFilled = true;
	}
	if (override.subagentOnlyExtensions !== undefined) {
		fill(
			"subagentOnlyExtensions",
			["subagentOnlyExtensions"],
			override.subagentOnlyExtensions === false ? undefined : [...override.subagentOnlyExtensions],
		);
	}
	if (override.completionGuard !== undefined) {
		fill("completionGuard", ["completionGuard"], override.completionGuard);
	}
	if (override.toolBudget !== undefined) {
		fill("toolBudget", ["toolBudget"], override.toolBudget === false ? undefined : override.toolBudget);
	}

	if (!anyFilled || !next) return agent;
	next.override = { ...meta, base: cloneOverrideBase(agent) };
	const frontmatterFields = agentFrontmatterFields.get(agent);
	if (frontmatterFields) agentFrontmatterFields.set(next, frontmatterFields);
	return next;
}

function applyCustomAgentOverrides(
	agents: AgentConfig[],
	userSettings: SubagentSettings,
	projectSettings: SubagentSettings,
	userSettingsPath: string,
	projectSettingsPath: string | null,
): AgentConfig[] {
	return agents.map((agent) => {
		const projectOverride = projectSettings.overrides[agent.name];
		if (projectOverride && projectSettingsPath) {
			return applyCustomAgentOverride(agent, projectOverride, { scope: "project", path: projectSettingsPath });
		}

		const userOverride = userSettings.overrides[agent.name];
		if (userOverride) {
			return applyCustomAgentOverride(agent, userOverride, { scope: "user", path: userSettingsPath });
		}

		return agent;
	});
}

export function buildBuiltinOverrideConfig(
	base: BuiltinAgentOverrideBase,
	draft: Pick<AgentConfig, "model" | "fallbackModels" | "thinking" | "systemPromptMode" | "inheritProjectContext" | "inheritSkills" | "defaultContext" | "acceptanceRole" | "disabled" | "systemPrompt" | "skills" | "tools" | "mcpDirectTools" | "subagentOnlyExtensions" | "completionGuard" | "toolBudget">,
): BuiltinAgentOverrideConfig | undefined {
	const override: BuiltinAgentOverrideConfig = {};

	if (draft.model !== base.model) override.model = draft.model ?? false;
	if (!arraysEqual(draft.fallbackModels, base.fallbackModels)) override.fallbackModels = draft.fallbackModels ? [...draft.fallbackModels] : false;
	if (draft.thinking !== base.thinking) override.thinking = draft.thinking ?? false;
	if (draft.systemPromptMode !== base.systemPromptMode) override.systemPromptMode = draft.systemPromptMode;
	if (draft.inheritProjectContext !== base.inheritProjectContext) override.inheritProjectContext = draft.inheritProjectContext;
	if (draft.inheritSkills !== base.inheritSkills) override.inheritSkills = draft.inheritSkills;
	if (draft.defaultContext !== base.defaultContext) override.defaultContext = draft.defaultContext ?? false;
	if (draft.acceptanceRole !== base.acceptanceRole) override.acceptanceRole = draft.acceptanceRole ?? false;
	if (draft.disabled !== base.disabled) override.disabled = draft.disabled ?? false;
	if (draft.systemPrompt !== base.systemPrompt) override.systemPrompt = draft.systemPrompt;
	if (!arraysEqual(draft.skills, base.skills)) override.skills = draft.skills ? [...draft.skills] : false;

	const baseTools = joinToolList(base);
	const draftTools = joinToolList(draft);
	if (!arraysEqual(draftTools, baseTools)) override.tools = draftTools ? [...draftTools] : false;
	if (!arraysEqual(draft.subagentOnlyExtensions, base.subagentOnlyExtensions)) {
		override.subagentOnlyExtensions = draft.subagentOnlyExtensions ? [...draft.subagentOnlyExtensions] : false;
	}
	if ((draft.completionGuard !== false) !== (base.completionGuard !== false)) {
		override.completionGuard = draft.completionGuard !== false;
	}
	if (JSON.stringify(draft.toolBudget) !== JSON.stringify(base.toolBudget)) override.toolBudget = draft.toolBudget ?? false;

	return Object.keys(override).length > 0 ? override : undefined;
}

export function saveBuiltinAgentOverride(
	cwd: string,
	name: string,
	scope: "user" | "project",
	override: BuiltinAgentOverrideConfig,
): string {
	const filePath = scope === "project" ? getProjectAgentSettingsPath(cwd) : getUserAgentSettingsPath();
	if (!filePath) throw new Error("Project override is not available here. No project config root was found.");

	const settings = readSettingsFileStrict(filePath);
	const subagents = settings.subagents && typeof settings.subagents === "object" && !Array.isArray(settings.subagents)
		? { ...(settings.subagents as Record<string, unknown>) }
		: {};
	const agentOverrides = subagents.agentOverrides && typeof subagents.agentOverrides === "object" && !Array.isArray(subagents.agentOverrides)
		? { ...(subagents.agentOverrides as Record<string, unknown>) }
		: {};

	agentOverrides[name] = cloneOverrideValue(override);
	subagents.agentOverrides = agentOverrides;
	settings.subagents = subagents;
	writeSettingsFile(filePath, settings);
	return filePath;
}

export function removeBuiltinAgentOverride(cwd: string, name: string, scope: "user" | "project"): { path: string; removed: boolean } {
	const filePath = scope === "project" ? getProjectAgentSettingsPath(cwd) : getUserAgentSettingsPath();
	if (!filePath) throw new Error("Project override is not available here. No project config root was found.");
	if (!fs.existsSync(filePath)) return { path: filePath, removed: false };

	const settings = readSettingsFileStrict(filePath);
	const subagents = settings.subagents;
	if (!subagents || typeof subagents !== "object" || Array.isArray(subagents)) return { path: filePath, removed: false };
	const nextSubagents = { ...(subagents as Record<string, unknown>) };
	const agentOverrides = nextSubagents.agentOverrides;
	if (!agentOverrides || typeof agentOverrides !== "object" || Array.isArray(agentOverrides)) return { path: filePath, removed: false };

	const nextOverrides = { ...(agentOverrides as Record<string, unknown>) };
	if (!Object.prototype.hasOwnProperty.call(nextOverrides, name)) return { path: filePath, removed: false };
	delete nextOverrides[name];
	if (Object.keys(nextOverrides).length > 0) nextSubagents.agentOverrides = nextOverrides;
	else delete nextSubagents.agentOverrides;

	if (Object.keys(nextSubagents).length > 0) settings.subagents = nextSubagents;
	else delete settings.subagents;

	writeSettingsFile(filePath, settings);
	return { path: filePath, removed: true };
}

export function mergeBuiltinAgentOverride(
	cwd: string,
	name: string,
	scope: "user" | "project",
	fields: BuiltinAgentOverrideConfig,
): string {
	const filePath = scope === "project" ? getProjectAgentSettingsPath(cwd) : getUserAgentSettingsPath();
	if (!filePath) throw new Error("Project override is not available here. No project config root was found.");

	const settings = readSettingsFileStrict(filePath);
	const subagents = settings.subagents && typeof settings.subagents === "object" && !Array.isArray(settings.subagents)
		? { ...(settings.subagents as Record<string, unknown>) }
		: {};
	const agentOverrides = subagents.agentOverrides && typeof subagents.agentOverrides === "object" && !Array.isArray(subagents.agentOverrides)
		? { ...(subagents.agentOverrides as Record<string, unknown>) }
		: {};

	const existing = agentOverrides[name];
	const base = existing && typeof existing === "object" && !Array.isArray(existing)
		? existing as Record<string, unknown>
		: {};
	agentOverrides[name] = { ...base, ...cloneOverrideValue(fields) };
	subagents.agentOverrides = agentOverrides;
	settings.subagents = subagents;
	writeSettingsFile(filePath, settings);
	return filePath;
}

export function removeBuiltinAgentOverrideFields(
	cwd: string,
	name: string,
	scope: "user" | "project",
	fields: string[],
): { path: string; removed: boolean } {
	const filePath = scope === "project" ? getProjectAgentSettingsPath(cwd) : getUserAgentSettingsPath();
	if (!filePath) throw new Error("Project override is not available here. No project config root was found.");
	if (!fs.existsSync(filePath)) return { path: filePath, removed: false };

	const settings = readSettingsFileStrict(filePath);
	const subagents = settings.subagents;
	if (!subagents || typeof subagents !== "object" || Array.isArray(subagents)) return { path: filePath, removed: false };
	const agentOverrides = (subagents as Record<string, unknown>).agentOverrides;
	if (!agentOverrides || typeof agentOverrides !== "object" || Array.isArray(agentOverrides)) return { path: filePath, removed: false };

	const entry = (agentOverrides as Record<string, unknown>)[name];
	if (!entry || typeof entry !== "object" || Array.isArray(entry)) return { path: filePath, removed: false };

	const nextEntry: Record<string, unknown> = { ...(entry as Record<string, unknown>) };
	let removed = false;
	for (const field of fields) {
		if (Object.prototype.hasOwnProperty.call(nextEntry, field)) {
			delete nextEntry[field];
			removed = true;
		}
	}
	if (!removed) return { path: filePath, removed: false };

	const nextSubagents = { ...(subagents as Record<string, unknown>) };
	if (Object.keys(nextEntry).length > 0) {
		(nextSubagents.agentOverrides as Record<string, unknown>)[name] = nextEntry;
	} else {
		const nextOverrides = { ...(agentOverrides as Record<string, unknown>) };
		delete nextOverrides[name];
		if (Object.keys(nextOverrides).length > 0) nextSubagents.agentOverrides = nextOverrides;
		else delete nextSubagents.agentOverrides;
	}
	if (Object.keys(nextSubagents).length > 0) settings.subagents = nextSubagents;
	else delete settings.subagents;
	writeSettingsFile(filePath, settings);
	return { path: filePath, removed: true };
}

function listFilesRecursive(dir: string, predicate: (fileName: string) => boolean): string[] {
	const files: string[] = [];
	if (!fs.existsSync(dir)) return files;

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
	} catch {
		return files;
	}

	for (const entry of entries) {
		const filePath = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			files.push(...listFilesRecursive(filePath, predicate));
			continue;
		}
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;
		if (!predicate(entry.name)) continue;
		files.push(filePath);
	}
	return files;
}

function isLegacyAgentSkillPath(rootDir: string, filePath: string): boolean {
	const relative = path.relative(rootDir, filePath);
	const parts = relative.split(path.sep).map((part) => part.toLowerCase());
	if (path.basename(rootDir).toLowerCase() === ".agents") {
		parts.unshift(".agents");
	}
	return parts.some((part, index) => part === ".agents" && parts[index + 1] === "skills");
}

function parseAgentAcceptanceFrontmatter(raw: string | undefined, agentName: string): AcceptanceInput | undefined {
	if (raw === undefined || !raw.trim()) return undefined;
	let parsed: unknown;
	try {
		parsed = parseYaml(raw);
	} catch (error) {
		throw new Error(`Agent '${agentName}' has invalid acceptance frontmatter: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
	}
	const errors = validateAcceptanceInput(parsed, `Agent '${agentName}' acceptance frontmatter`);
	if (errors.length > 0) throw new Error(errors.join(" "));
	return parsed as AcceptanceInput;
}

function loadAgentsFromDir(dir: string, source: AgentSource): AgentConfig[] {
	const agents: AgentConfig[] = [];

	for (const filePath of listFilesRecursive(dir, (fileName) => fileName.endsWith(".md") && !fileName.endsWith(".chain.md"))) {
		if (isLegacyAgentSkillPath(dir, filePath)) {
			continue;
		}

		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		const { frontmatter, body } = parseFrontmatter(content);

		if (!frontmatter.name || !frontmatter.description) {
			continue;
		}

		const localName = frontmatter.name;
		const parsedPackage = parsePackageName(frontmatter.package, `Agent '${localName}' package`);
		if (parsedPackage.error) continue;
		const packageName = parsedPackage.packageName;
		const runtimeName = buildRuntimeName(localName, packageName);

		const rawTools = parseFrontmatterList(frontmatter.tools);
		const { tools = [], mcpDirectTools = [] } = splitToolList(rawTools);
		const defaultReads = parseFrontmatterList(frontmatter.defaultReads);
		const skillStr = frontmatter.skill || frontmatter.skills;
		const skills = parseFrontmatterList(skillStr);
		const skillPath = parseFrontmatterList(frontmatter.skillPath);
		const fallbackModels = parseFrontmatterList(frontmatter.fallbackModels);
		const systemPromptMode = frontmatter.systemPromptMode === "replace"
			? "replace"
			: frontmatter.systemPromptMode === "append"
				? "append"
				: defaultSystemPromptMode(localName);
		const inheritProjectContext = frontmatter.inheritProjectContext === "true"
			? true
			: frontmatter.inheritProjectContext === "false"
				? false
				: defaultInheritProjectContext(localName);
		const inheritSkills = frontmatter.inheritSkills === "true"
			? true
			: frontmatter.inheritSkills === "false"
				? false
				: defaultInheritSkills();
		const defaultContext = frontmatter.defaultContext === "fork"
			? "fork" as const
			: frontmatter.defaultContext === "fresh"
				? "fresh" as const
				: undefined;
		let defaultAsync: boolean | undefined;
		if (frontmatter.async !== undefined) {
			if (frontmatter.async === "true") defaultAsync = true;
			else if (frontmatter.async === "false") defaultAsync = false;
			else throw new Error(`Agent '${localName}' has invalid async frontmatter; expected true or false.`);
		}
		let defaultTimeoutMs: number | undefined;
		if (frontmatter.timeoutMs !== undefined) {
			const parsed = Number(frontmatter.timeoutMs);
			if (!Number.isInteger(parsed) || parsed <= 0) {
				throw new Error(`Agent '${localName}' has invalid timeoutMs frontmatter; expected a positive integer.`);
			}
			defaultTimeoutMs = parsed;
		}
		let defaultTurnBudget: TurnBudgetConfig | undefined;
		if (frontmatter.turnBudget !== undefined && frontmatter.turnBudget.trim()) {
			const parsed = JSON.parse(frontmatter.turnBudget) as unknown;
			const resolved = resolveTurnBudgetConfig(parsed, `Agent '${localName}' turnBudget frontmatter`);
			if (resolved.error) throw new Error(resolved.error);
			defaultTurnBudget = resolved.turnBudget;
		}
		const defaultAcceptance = parseAgentAcceptanceFrontmatter(frontmatter.acceptance, localName);
		let acceptanceRole: AcceptanceRole | undefined;
		if (frontmatter.acceptanceRole !== undefined && frontmatter.acceptanceRole.trim()) {
			if (frontmatter.acceptanceRole === "read-only" || frontmatter.acceptanceRole === "writer") acceptanceRole = frontmatter.acceptanceRole;
			else throw new Error(`Agent '${localName}' has invalid acceptanceRole frontmatter; expected 'read-only' or 'writer'.`);
		}

		const extensions = parseFrontmatterList(frontmatter.extensions);
		const subagentOnlyExtensions = parseFrontmatterList(frontmatter.subagentOnlyExtensions);

		const extraFields: Record<string, string> = {};
		for (const [key, value] of Object.entries(frontmatter)) {
			if (!KNOWN_FIELDS.has(key)) extraFields[key] = value;
		}

		const parsedMaxSubagentDepth = Number(frontmatter.maxSubagentDepth);
		let toolBudget: ToolBudgetConfig | undefined;
		if (frontmatter.toolBudget !== undefined && frontmatter.toolBudget.trim()) {
			const parsed = JSON.parse(frontmatter.toolBudget) as unknown;
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
				throw new Error(`Agent '${localName}' has invalid toolBudget frontmatter; expected a JSON object.`);
			}
			toolBudget = parsed as ToolBudgetConfig;
		}
		const completionGuard = frontmatter.completionGuard === "false"
			? false
			: frontmatter.completionGuard === "true"
				? true
				: undefined;

		const agent: AgentConfig = {
			name: runtimeName,
			localName,
			packageName,
			description: frontmatter.description,
			tools: tools.length > 0 ? tools : undefined,
			mcpDirectTools: mcpDirectTools.length > 0 ? mcpDirectTools : undefined,
			model: frontmatter.model,
			fallbackModels: fallbackModels && fallbackModels.length > 0 ? fallbackModels : undefined,
			thinking: frontmatter.thinking === "false" ? false : frontmatter.thinking,
			systemPromptMode,
			inheritProjectContext,
			inheritSkills,
			defaultContext,
			defaultAsync,
			defaultTimeoutMs,
			defaultTurnBudget,
			defaultAcceptance,
			acceptanceRole,
			systemPrompt: body,
			source,
			filePath,
			skills: skills && skills.length > 0 ? skills : undefined,
			skillPath: skillPath && skillPath.length > 0 ? skillPath : undefined,
			extensions,
			subagentOnlyExtensions,
			output: frontmatter.output,
			defaultReads: defaultReads && defaultReads.length > 0 ? defaultReads : undefined,
			defaultProgress: frontmatter.defaultProgress === "true",
			interactive: frontmatter.interactive === "true",
			maxSubagentDepth:
				Number.isInteger(parsedMaxSubagentDepth) && parsedMaxSubagentDepth >= 0
					? parsedMaxSubagentDepth
					: undefined,
			completionGuard,
			toolBudget,
			memory: parseMemoryFrontmatter(frontmatter.memory),
			extraFields: Object.keys(extraFields).length > 0 ? extraFields : undefined,
		};
		agentFrontmatterFields.set(agent, new Set(Object.keys(frontmatter)));
		agents.push(agent);
	}

	return agents;
}

function loadChainsFromDir(dir: string, source: AgentSource): { chains: ChainConfig[]; diagnostics: ChainDiscoveryDiagnostic[] } {
	const chains = new Map<string, ChainConfig>();
	const diagnostics: ChainDiscoveryDiagnostic[] = [];

	for (const filePath of listFilesRecursive(dir, (fileName) => fileName.endsWith(".chain.md") || fileName.endsWith(".chain.json"))) {
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		try {
			const chain = filePath.endsWith(".chain.json") ? parseJsonChain(content, source, filePath) : parseChain(content, source, filePath);
			const existing = chains.get(chain.name);
			if (existing && existing.filePath.endsWith(".chain.json") && filePath.endsWith(".chain.md")) continue;
			chains.set(chain.name, chain);
		} catch (error) {
			diagnostics.push({ source, filePath, error: error instanceof Error ? error.message : String(error) });
			continue;
		}
	}

	return { chains: Array.from(chains.values()), diagnostics };
}

function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

function resolveNearestProjectAgentDirs(cwd: string): { readDirs: string[]; preferredDir: string | null } {
	const projectRoot = findNearestProjectRoot(cwd);
	if (!projectRoot) return { readDirs: [], preferredDir: null };

	const legacyDir = path.join(projectRoot, ".agents");
	const preferredDir = path.join(getProjectConfigDir(projectRoot), "agents");
	const readDirs: string[] = [];
	if (isDirectory(legacyDir)) readDirs.push(legacyDir);
	if (isDirectory(preferredDir)) readDirs.push(preferredDir);

	return {
		readDirs,
		preferredDir,
	};
}

function resolveNearestProjectChainDirs(cwd: string): { readDirs: string[]; preferredDir: string | null } {
	const projectRoot = findNearestProjectRoot(cwd);
	if (!projectRoot) return { readDirs: [], preferredDir: null };

	const preferredDir = path.join(getProjectConfigDir(projectRoot), "chains");
	return {
		readDirs: isDirectory(preferredDir) ? [preferredDir] : [],
		preferredDir,
	};
}
const BUILTIN_AGENTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "agents");

export const EXTRA_AGENT_DIRS_ENV = "PI_SUBAGENT_EXTRA_AGENT_DIRS";

// Additional read-only directories to scan for agent definitions, supplied by the
// launcher via PI_SUBAGENT_EXTRA_AGENT_DIRS (PATH-style, split on os/path delimiter).
// Lets a hermetic wrapper (e.g. a Nix-store install) expose bundled agents without
// copying or symlinking them into the writable agent dir. Loaded as "user" source,
// at lower precedence than agents the user placed in their own agent dir.
function extraUserAgentDirs(): string[] {
	const raw = process.env[EXTRA_AGENT_DIRS_ENV];
	if (!raw) return [];
	return raw
		.split(path.delimiter)
		.map((dir) => dir.trim())
		.filter((dir) => dir.length > 0);
}

export function discoverAgents(cwd: string, scope: AgentScope): AgentDiscoveryResult {
	const userDirOld = path.join(getAgentDir(), "agents");
	const userDirNew = path.join(os.homedir(), ".agents");
	const { readDirs: projectAgentDirs, preferredDir: projectAgentsDir } = resolveNearestProjectAgentDirs(cwd);
	const userSettingsPath = getUserAgentSettingsPath();
	const projectSettingsPath = getProjectAgentSettingsPath(cwd);
	const userSettings = scope === "project" ? EMPTY_SUBAGENT_SETTINGS : readSubagentSettings(userSettingsPath);
	const projectSettings = scope === "user" ? EMPTY_SUBAGENT_SETTINGS : readSubagentSettings(projectSettingsPath);
	const defaultModel = resolveSubagentDefaultModel(userSettings, projectSettings, userSettingsPath, projectSettingsPath);
	const modelScope = projectSettings.modelScope ?? userSettings.modelScope;
	const packageSubagentPaths = collectPackageSubagentPaths(cwd, {
		includeUser: scope !== "project",
		includeProject: scope !== "user",
	});

	const builtinAgents = applyBuiltinOverrides(
		applySubagentDefaultModel(loadAgentsFromDir(BUILTIN_AGENTS_DIR, "builtin"), defaultModel),
		userSettings,
		projectSettings,
		userSettingsPath,
		projectSettingsPath,
	);

	const userAgentsExtra = scope === "project" ? [] : extraUserAgentDirs().flatMap((dir) => loadAgentsFromDir(dir, "user"));
	const userAgentsOld = scope === "project" ? [] : loadAgentsFromDir(userDirOld, "user");
	const userAgentsNew = scope === "project" ? [] : loadAgentsFromDir(userDirNew, "user");
	const userAgents = applyCustomAgentOverrides(
		applySubagentDefaultModel([...userAgentsExtra, ...userAgentsOld, ...userAgentsNew], defaultModel),
		userSettings,
		projectSettings,
		userSettingsPath,
		projectSettingsPath,
	);

	const projectAgents = applyCustomAgentOverrides(
		applySubagentDefaultModel(scope === "user" ? [] : projectAgentDirs.flatMap((dir) => loadAgentsFromDir(dir, "project")), defaultModel),
		userSettings,
		projectSettings,
		userSettingsPath,
		projectSettingsPath,
	);
	const packageAgents = applyCustomAgentOverrides(
		applySubagentDefaultModel(packageSubagentPaths.agents.flatMap((dir) => loadAgentsFromDir(dir, "package")), defaultModel),
		userSettings,
		projectSettings,
		userSettingsPath,
		projectSettingsPath,
	);
	const agents = mergeAgentsForScope(scope, userAgents, projectAgents, builtinAgents, packageAgents)
		.filter((agent) => agent.disabled !== true);

	return { agents, projectAgentsDir, modelScope };
}

export function discoverAgentsAll(cwd: string): {
	builtin: AgentConfig[];
	package: AgentConfig[];
	user: AgentConfig[];
	project: AgentConfig[];
	chains: ChainConfig[];
	chainDiagnostics: ChainDiscoveryDiagnostic[];
	userDir: string;
	projectDir: string | null;
	userChainDir: string;
	projectChainDir: string | null;
	userSettingsPath: string;
	projectSettingsPath: string | null;
} {
	const userDirOld = path.join(getAgentDir(), "agents");
	const userDirNew = path.join(os.homedir(), ".agents");
	const userChainDir = getUserChainDir();
	const { readDirs: projectDirs, preferredDir: projectDir } = resolveNearestProjectAgentDirs(cwd);
	const { readDirs: projectChainDirs, preferredDir: projectChainDir } = resolveNearestProjectChainDirs(cwd);
	const userSettingsPath = getUserAgentSettingsPath();
	const projectSettingsPath = getProjectAgentSettingsPath(cwd);
	const userSettings = readSubagentSettings(userSettingsPath);
	const projectSettings = readSubagentSettings(projectSettingsPath);
	const defaultModel = resolveSubagentDefaultModel(userSettings, projectSettings, userSettingsPath, projectSettingsPath);
	const packageSubagentPaths = collectPackageSubagentPaths(cwd);

	const builtin = applyBuiltinOverrides(
		applySubagentDefaultModel(loadAgentsFromDir(BUILTIN_AGENTS_DIR, "builtin"), defaultModel),
		userSettings,
		projectSettings,
		userSettingsPath,
		projectSettingsPath,
	);
	const user = applyCustomAgentOverrides(
		applySubagentDefaultModel([
			...extraUserAgentDirs().flatMap((dir) => loadAgentsFromDir(dir, "user")),
			...loadAgentsFromDir(userDirOld, "user"),
			...loadAgentsFromDir(userDirNew, "user"),
		], defaultModel),
		userSettings,
		projectSettings,
		userSettingsPath,
		projectSettingsPath,
	);
	const packageMap = new Map<string, AgentConfig>();
	for (const dir of packageSubagentPaths.agents) {
		for (const agent of loadAgentsFromDir(dir, "package")) {
			if (!packageMap.has(agent.name)) packageMap.set(agent.name, agent);
		}
	}
	const packageAgents = applyCustomAgentOverrides(
		applySubagentDefaultModel(Array.from(packageMap.values()), defaultModel),
		userSettings,
		projectSettings,
		userSettingsPath,
		projectSettingsPath,
	);
	const projectMap = new Map<string, AgentConfig>();
	for (const dir of projectDirs) {
		for (const agent of loadAgentsFromDir(dir, "project")) {
			projectMap.set(agent.name, agent);
		}
	}
	const project = applyCustomAgentOverrides(
		applySubagentDefaultModel(Array.from(projectMap.values()), defaultModel),
		userSettings,
		projectSettings,
		userSettingsPath,
		projectSettingsPath,
	);

	const chainMap = new Map<string, ChainConfig>();
	const packageChainDiagnostics: ChainDiscoveryDiagnostic[] = [];
	const packageChainMap = new Map<string, ChainConfig>();
	for (const dir of packageSubagentPaths.chains) {
		const loaded = loadChainsFromDir(dir, "package");
		packageChainDiagnostics.push(...loaded.diagnostics);
		for (const chain of loaded.chains) {
			if (!packageChainMap.has(chain.name)) packageChainMap.set(chain.name, chain);
		}
	}
	const projectChainDiagnostics: ChainDiscoveryDiagnostic[] = [];
	for (const dir of projectChainDirs) {
		const loaded = loadChainsFromDir(dir, "project");
		projectChainDiagnostics.push(...loaded.diagnostics);
		for (const chain of loaded.chains) {
			chainMap.set(chain.name, chain);
		}
	}
	const userChains = loadChainsFromDir(userChainDir, "user");
	const chains = [
		...Array.from(packageChainMap.values()),
		...userChains.chains,
		...Array.from(chainMap.values()),
	];
	const chainDiagnostics = [
		...packageChainDiagnostics,
		...userChains.diagnostics,
		...projectChainDiagnostics,
	];

	const userDir = process.env.PI_CODING_AGENT_DIR ? userDirOld : fs.existsSync(userDirNew) ? userDirNew : userDirOld;

	return { builtin, package: packageAgents, user, project, chains, chainDiagnostics, userDir, projectDir, userChainDir, projectChainDir, userSettingsPath, projectSettingsPath };
}
