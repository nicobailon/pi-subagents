import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { findConfiguredProjectRoot } from "../../agents/agents.ts";
import { getAgentDir, getProjectConfigDir } from "../../shared/utils.ts";
import { loadAgentPluginMcpServers, loadPackageMcpServers, type McpServerDefinition } from "./mcp-config-sources.ts";

const CACHE_VERSION = 1;
const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const BUILTIN_TOOL_NAMES = new Set(["read", "bash", "edit", "write", "grep", "find", "ls", "mcp"]);
const GENERIC_GLOBAL_CONFIG_PATH = path.join(os.homedir(), ".config", "mcp", "mcp.json");
const IMPORT_PATHS = {
	cursor: [path.join(os.homedir(), ".cursor", "mcp.json")],
	"claude-code": [
		path.join(os.homedir(), ".claude", "mcp.json"),
		path.join(os.homedir(), ".claude.json"),
		path.join(os.homedir(), ".claude", "claude_desktop_config.json"),
	],
	"claude-desktop": [path.join(os.homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json")],
	codex: [path.join(os.homedir(), ".codex", "config.json")],
	windsurf: [path.join(os.homedir(), ".windsurf", "mcp.json")],
	vscode: [".vscode/mcp.json"],
} as const;

type ToolPrefix = "server" | "none" | "short";
type ImportKind = keyof typeof IMPORT_PATHS;

type ServerEntry = McpServerDefinition;

export interface McpConfig {
	mcpServers: Record<string, ServerEntry>;
	imports?: ImportKind[];
	settings?: {
		toolPrefix?: ToolPrefix;
		directTools?: boolean;
		agentPluginPaths?: unknown;
	};
}

export const MCP_RUNTIME_SNAPSHOT_EVENT = "pi-mcp-adapter:runtime-snapshot:v1" as const;
export const MCP_RUNTIME_SNAPSHOT_VERSION = 1 as const;

export interface McpRuntimeServerSnapshot {
	readonly name: string;
	readonly definition: ServerEntry;
	readonly runtime: true;
	readonly persisted: false;
}

interface McpRuntimeSnapshotRequest {
	version: typeof MCP_RUNTIME_SNAPSHOT_VERSION;
	name: string;
	result?:
		| { ok: true; snapshot: McpRuntimeServerSnapshot }
		| { ok: false; error: Error };
}

export interface McpRuntimeSnapshotHost {
	events: {
		emit(event: string, request: McpRuntimeSnapshotRequest): void;
	};
}

interface CachedTool {
	name?: string;
}

interface CachedResource {
	uri?: string;
	name?: string;
}

interface ServerCacheEntry {
	configHash?: string;
	tools?: CachedTool[];
	resources?: CachedResource[];
	cachedAt?: number;
}

interface MetadataCache {
	version: number;
	servers: Record<string, ServerCacheEntry>;
}

export interface ResolvedMcpDirectToolSelection { name: string; selector: string }

export interface McpDirectToolResolution {
	selections: ResolvedMcpDirectToolSelection[];
	unresolvedSelectors: string[];
	/** Normal loaded config plus the selected runtime server definitions. */
	mcpConfig?: McpConfig;
	runtimeServerNames?: string[];
}

function normalizeSelectors(selectors: string[] | undefined): string[] {
	return [...new Set((selectors ?? []).map((selector) => selector.replace(/\/+$/, "")).filter(Boolean))];
}

export function resolveMcpDirectToolResolution(
	mcpDirectTools: string[] | undefined,
	cwd = process.cwd(),
	runtimeSnapshotHost?: McpRuntimeSnapshotHost,
	configOverride?: McpConfig,
): McpDirectToolResolution {
	const selectors = normalizeSelectors(mcpDirectTools);
	if (selectors.length === 0) return { selections: [], unresolvedSelectors: [] };

	const config = configOverride ?? loadMcpConfig(cwd);
	const { servers: selectedServers, tools: selectedTools } = parseSelections(selectors);
	const runtimeSelectionServers = new Set([...selectedServers, ...selectedTools.keys()]);
	const runtimeServers = resolveRuntimeMcpServers(config, runtimeSelectionServers, runtimeSnapshotHost);
	const resolvedConfig = Object.keys(runtimeServers).length > 0
		? mergeConfigs(config, { mcpServers: runtimeServers })
		: config;
	validateSelectedServerDefinitions(resolvedConfig, selectors);
	const cache = loadMetadataCache();
	if (!cache) return { selections: [], unresolvedSelectors: selectors };
	const selections = resolveDirectToolSelections(resolvedConfig, cache, getToolPrefix(resolvedConfig.settings?.toolPrefix), selectors);
	const unresolvedSelectors = selectors.filter((selector) =>
		selector.includes("/")
			? !selections.some((selection) => selection.selector === selector)
			: !selections.some((selection) => selection.selector.startsWith(`${selector}/`)),
	);
	return {
		selections,
		unresolvedSelectors,
		...(Object.keys(runtimeServers).length > 0
			? { mcpConfig: resolvedConfig, runtimeServerNames: Object.keys(runtimeServers) }
			: {}),
	};
}

export function resolveMcpDirectToolSelections(
	mcpDirectTools: string[] | undefined,
	cwd = process.cwd(),
	runtimeSnapshotHost?: McpRuntimeSnapshotHost,
): ResolvedMcpDirectToolSelection[] {
	return resolveMcpDirectToolResolution(mcpDirectTools, cwd, runtimeSnapshotHost).selections;
}

export function formatUnresolvedMcpDirectToolSelectors(selectors: readonly string[]): string {
	return `Unresolved MCP direct-tool selectors: ${selectors.join(", ")}. Direct MCP tools require a matching configured server and fresh metadata cache; runtime-registered servers require a host/pi-mcp-adapter handoff before child launch.`;
}

function loadMetadataCache(): MetadataCache | null {
	const cachePath = path.join(getAgentDir(), "mcp-cache.json");
	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(cachePath, "utf-8"));
	} catch {
		return null;
	}

	if (!parsed || typeof parsed !== "object") return null;
	const raw = parsed as Record<string, unknown>;
	if (raw.version !== CACHE_VERSION || !raw.servers || typeof raw.servers !== "object" || Array.isArray(raw.servers)) {
		return null;
	}
	return raw as unknown as MetadataCache;
}

function resolveRuntimeMcpServers(
	config: McpConfig,
	selectedServers: ReadonlySet<string>,
	runtimeSnapshotHost: McpRuntimeSnapshotHost | undefined,
): Record<string, ServerEntry> {
	if (!runtimeSnapshotHost) return {};
	const runtimeServers: Record<string, ServerEntry> = {};
	for (const serverName of selectedServers) {
		if (Object.hasOwn(config.mcpServers, serverName)) continue;
		try {
			const snapshot = getRuntimeMcpServerSnapshot(runtimeSnapshotHost, serverName);
			runtimeServers[serverName] = snapshot.definition;
		} catch {
			// Missing, disposed, or shadowed runtime servers remain unresolved below.
		}
	}
	return runtimeServers;
}

function getRuntimeMcpServerSnapshot(
	host: McpRuntimeSnapshotHost,
	name: string,
): McpRuntimeServerSnapshot {
	const request: McpRuntimeSnapshotRequest = {
		version: MCP_RUNTIME_SNAPSHOT_VERSION,
		name,
	};
	host.events.emit(MCP_RUNTIME_SNAPSHOT_EVENT, request);
	if (!request.result) throw new Error("pi-mcp-adapter is not installed for this Pi instance");
	if (!request.result.ok) throw request.result.error;
	const snapshot = request.result.snapshot;
	if (
		!snapshot ||
		snapshot.name !== name ||
		snapshot.runtime !== true ||
		snapshot.persisted !== false ||
		!snapshot.definition ||
		typeof snapshot.definition !== "object" ||
		Array.isArray(snapshot.definition)
	) {
		throw new Error(`Invalid MCP runtime snapshot for server "${name}"`);
	}
	return snapshot;
}

function loadMcpConfig(cwd: string): McpConfig {
	const resolvedCwd = path.resolve(cwd);
	const projectRoot = findConfiguredProjectRoot(resolvedCwd) ?? resolvedCwd;
	let config: McpConfig = { mcpServers: {} };
	for (const sourcePath of getConfigPaths(projectRoot)) {
		const loaded = readConfig(sourcePath);
		if (!loaded) continue;
		config = mergeConfigs(config, expandImports(loaded, projectRoot));
	}

	const packageServers = loadPackageMcpServers(projectRoot);
	const pluginServers = loadAgentPluginMcpServers(config.settings?.agentPluginPaths, projectRoot);
	const packageOnlyServers = Object.fromEntries(
		Object.entries(packageServers).filter(([name]) => !Object.hasOwn(pluginServers, name)),
	);
	return mergeConfigs(
		{ mcpServers: packageOnlyServers },
		mergeConfigs({ mcpServers: pluginServers }, config),
	);
}

function getConfigPaths(projectRoot: string): string[] {
	const piGlobalPath = path.join(getAgentDir(), "mcp.json");
	const projectPath = path.resolve(projectRoot, ".mcp.json");
	const projectPiPath = path.resolve(getProjectConfigDir(projectRoot), "mcp.json");
	const sources: string[] = [];
	if (GENERIC_GLOBAL_CONFIG_PATH !== piGlobalPath) sources.push(GENERIC_GLOBAL_CONFIG_PATH);
	sources.push(piGlobalPath);
	if (projectPath !== piGlobalPath) sources.push(projectPath);
	if (projectPiPath !== piGlobalPath && projectPiPath !== projectPath) sources.push(projectPiPath);
	return sources;
}

function readConfig(configPath: string): McpConfig | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(configPath, "utf-8"));
	} catch {
		return null;
	}
	return validateConfig(parsed);
}

function validateConfig(raw: unknown): McpConfig {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { mcpServers: {} };
	const obj = raw as Record<string, unknown>;
	const servers = obj.mcpServers ?? obj["mcp-servers"] ?? {};
	return {
		mcpServers: servers && typeof servers === "object" && !Array.isArray(servers) ? servers as Record<string, ServerEntry> : {},
		imports: Array.isArray(obj.imports) ? obj.imports.filter((value): value is ImportKind => isImportKind(value)) : undefined,
		settings: obj.settings && typeof obj.settings === "object" && !Array.isArray(obj.settings)
			? obj.settings as McpConfig["settings"]
			: undefined,
	};
}

function mergeConfigs(base: McpConfig, next: McpConfig): McpConfig {
	const imports = [...(base.imports ?? []), ...(next.imports ?? [])];
	return {
		mcpServers: { ...base.mcpServers, ...next.mcpServers },
		imports: imports.length ? [...new Set(imports)] : undefined,
		settings: next.settings ? { ...base.settings, ...next.settings } : base.settings,
	};
}

function expandImports(config: McpConfig, cwd: string): McpConfig {
	if (!config.imports?.length) return config;

	const importedServers: Record<string, ServerEntry> = {};
	for (const importKind of config.imports) {
		const importPath = resolveImportPath(importKind, cwd);
		if (!importPath) continue;
		let imported: unknown;
		try {
			imported = JSON.parse(fs.readFileSync(importPath, "utf-8"));
		} catch {
			continue;
		}
		for (const [name, definition] of Object.entries(extractServers(imported, importKind))) {
			if (!importedServers[name]) importedServers[name] = definition;
		}
	}

	return {
		imports: config.imports,
		settings: config.settings,
		mcpServers: { ...importedServers, ...config.mcpServers },
	};
}

function resolveImportPath(importKind: ImportKind, cwd: string): string | null {
	for (const candidate of IMPORT_PATHS[importKind]) {
		const fullPath = candidate.startsWith(".") ? path.resolve(cwd, candidate) : candidate;
		if (fs.existsSync(fullPath)) return fullPath;
	}
	return null;
}

function extractServers(config: unknown, kind: ImportKind): Record<string, ServerEntry> {
	if (!config || typeof config !== "object" || Array.isArray(config)) return {};
	const obj = config as Record<string, unknown>;
	const servers = kind === "cursor" || kind === "windsurf" || kind === "vscode"
		? obj.mcpServers ?? obj["mcp-servers"]
		: obj.mcpServers;
	return servers && typeof servers === "object" && !Array.isArray(servers) ? servers as Record<string, ServerEntry> : {};
}

function resolveDirectToolSelections(config: McpConfig, cache: MetadataCache, prefix: ToolPrefix, envOverride: string[]): ResolvedMcpDirectToolSelection[] {
	const names: ResolvedMcpDirectToolSelection[] = [];
	const seenNames = new Set<string>();
	const { servers: selectedServers, tools: selectedTools } = parseSelections(envOverride);

	for (const [serverName, definition] of Object.entries(config.mcpServers)) {
		const serverCache = cache.servers[serverName];
		if (!isServerCacheValid(serverCache, definition)) continue;

		const toolFilter = selectedServers.has(serverName)
			? true
			: selectedTools.get(serverName);
		if (!toolFilter) continue;

		for (const tool of Array.isArray(serverCache.tools) ? serverCache.tools : []) {
			if (typeof tool?.name !== "string" || !tool.name) continue;
			if (toolFilter !== true && !toolFilter.has(tool.name)) continue;
			if (isToolExcluded(tool.name, serverName, prefix, definition.excludeTools)) continue;
			const prefixedName = formatToolName(tool.name, serverName, prefix);
			if (BUILTIN_TOOL_NAMES.has(prefixedName) || seenNames.has(prefixedName)) continue;
			seenNames.add(prefixedName);
			names.push({ name: prefixedName, selector: `${serverName}/${tool.name}` });
		}

		if (definition.exposeResources === false) continue;
		for (const resource of Array.isArray(serverCache.resources) ? serverCache.resources : []) {
			if (typeof resource?.name !== "string" || !resource.name || typeof resource.uri !== "string" || !resource.uri) continue;
			const baseName = `get_${resourceNameToToolName(resource.name)}`;
			if (toolFilter !== true && !toolFilter.has(baseName)) continue;
			if (isToolExcluded(baseName, serverName, prefix, definition.excludeTools)) continue;
			const prefixedName = formatToolName(baseName, serverName, prefix);
			if (BUILTIN_TOOL_NAMES.has(prefixedName) || seenNames.has(prefixedName)) continue;
			seenNames.add(prefixedName);
			names.push({ name: prefixedName, selector: `${serverName}/${baseName}` });
		}
	}

	return names;
}

export function resolveMcpDirectToolNames(mcpDirectTools: string[] | undefined, cwd = process.cwd()): string[] {
	return resolveMcpDirectToolSelections(mcpDirectTools, cwd).map((selection) => selection.name);
}

function parseSelections(selections: string[]): { servers: Set<string>; tools: Map<string, Set<string>> } {
	const servers = new Set<string>();
	const tools = new Map<string, Set<string>>();
	for (const item of selections) {
		if (item.includes("/")) {
			const [server, tool] = item.split("/", 2);
			if (server && tool) {
				if (!tools.has(server)) tools.set(server, new Set());
				tools.get(server)!.add(tool);
			} else if (server) {
				servers.add(server);
			}
		} else if (item) {
			servers.add(item);
		}
	}
	return { servers, tools };
}

function validateSelectedServerDefinitions(config: McpConfig, selectors: string[]): void {
	const { servers, tools } = parseSelections(selectors);
	for (const serverName of new Set([...servers, ...tools.keys()])) {
		const definition = config.mcpServers[serverName];
		if (definition) computeMcpServerHash(definition);
	}
}

function isServerCacheValid(entry: ServerCacheEntry | undefined, definition: ServerEntry): entry is ServerCacheEntry {
	if (!entry || entry.configHash !== computeMcpServerHash(definition)) return false;
	if (!entry.cachedAt || typeof entry.cachedAt !== "number") return false;
	return Date.now() - entry.cachedAt <= CACHE_MAX_AGE_MS;
}

export function computeMcpServerHash(definition: ServerEntry): string {
	const identity: Record<string, unknown> = {
		command: definition.command,
		args: definition.args,
		socket: resolveConfigPath(definition.socket),
		env: interpolateEnvRecord(definition.env),
		cwd: resolveConfigPath(definition.cwd),
		url: resolveServerUrl(definition),
		headers: interpolateEnvRecord(definition.headers),
		requestHeadersCommand: definition.requestHeadersCommand
			? {
				command: interpolateEnvVars(definition.requestHeadersCommand.command),
				args: definition.requestHeadersCommand.args?.map(interpolateEnvVars),
				env: interpolateEnvRecord(definition.requestHeadersCommand.env),
				timeoutMs: definition.requestHeadersCommand.timeoutMs,
			}
			: undefined,
		auth: definition.auth,
		bearerToken: resolveBearerToken(definition),
		bearerTokenEnv: definition.bearerTokenEnv,
		exposeResources: definition.exposeResources,
		includeTools: definition.includeTools,
		excludeTools: definition.excludeTools,
		protocolVersion: definition.protocolVersion,
	};
	return createHash("sha256").update(stableStringify(identity)).digest("hex");
}

function getToolPrefix(value: unknown): ToolPrefix {
	return value === "none" || value === "short" || value === "server" ? value : "server";
}

function isImportKind(value: unknown): value is ImportKind {
	return typeof value === "string" && Object.hasOwn(IMPORT_PATHS, value);
}

function getServerPrefix(serverName: string, mode: ToolPrefix): string {
	if (mode === "none") return "";
	if (mode === "short") {
		const short = serverName.replace(/-?mcp$/i, "").replace(/-/g, "_");
		return short || "mcp";
	}
	return serverName.replace(/-/g, "_");
}

function formatToolName(toolName: string, serverName: string, prefix: ToolPrefix): string {
	const serverPrefix = getServerPrefix(serverName, prefix);
	return serverPrefix ? `${serverPrefix}_${toolName}` : toolName;
}

function isToolExcluded(toolName: string, serverName: string, prefix: ToolPrefix, excludeTools: unknown): boolean {
	if (!Array.isArray(excludeTools) || excludeTools.length === 0) return false;
	const candidates = new Set([
		normalizeToolName(toolName),
		normalizeToolName(formatToolName(toolName, serverName, prefix)),
		normalizeToolName(formatToolName(toolName, serverName, "server")),
		normalizeToolName(formatToolName(toolName, serverName, "short")),
	]);
	return excludeTools.some((excluded) => typeof excluded === "string" && candidates.has(normalizeToolName(excluded)));
}

function normalizeToolName(value: string): string {
	return value.replace(/-/g, "_");
}

function resourceNameToToolName(name: string): string {
	let result = name
		.replace(/[^a-zA-Z0-9]/g, "_")
		.replace(/_+/g, "_")
		.replace(/^_+/, "")
		.replace(/_+$/, "")
		.toLowerCase();
	if (!result || /^\d/.test(result)) result = `resource${result ? `_${result}` : ""}`;
	return result;
}

function interpolateEnvRecord(values: Record<string, string> | undefined): Record<string, string> | undefined {
	if (!values) return undefined;
	return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, interpolateSecretExpression(value)]));
}

function interpolateEnvVars(value: string): string {
	return value
		.replace(/\$\{(\w+)\}/g, (_, name: string) => process.env[name] ?? "")
		.replace(/\$env:(\w+)/g, (_, name: string) => process.env[name] ?? "")
		.replace(/\{env:(\w+)\}/g, (_, name: string) => process.env[name] ?? "");
}

function interpolateSecretExpression(value: string): string {
	if (value.startsWith("!!")) return interpolateEnvVars(value.slice(1));
	return value.startsWith("!") ? value : interpolateEnvVars(value);
}

function getMissingEnvVars(value: string): string[] {
	const missing = new Set<string>();
	for (const match of value.matchAll(/\$\{(\w+)\}|\$env:(\w+)|\{env:(\w+)\}/g)) {
		const name = match[1] ?? match[2] ?? match[3];
		if (name && process.env[name] === undefined) missing.add(name);
	}
	return [...missing];
}

function resolveServerUrl(definition: Pick<ServerEntry, "url">): string | undefined {
	if (definition.url == null) return undefined;
	if (typeof definition.url !== "string") throw new Error("MCP server URL must be a string");

	const missing = getMissingEnvVars(definition.url);
	if (missing.length > 0) {
		throw new Error(`Missing environment variable${missing.length === 1 ? "" : "s"} in MCP server URL: ${missing.join(", ")}`);
	}

	const resolved = interpolateEnvVars(definition.url);
	try {
		new URL(resolved);
	} catch (error) {
		throw new Error(`Invalid MCP server URL after environment interpolation: ${resolved}`, { cause: error });
	}
	return resolved;
}

function resolveConfigPath(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	const resolved = interpolateEnvVars(value);
	if (resolved === "~") return os.homedir();
	if (resolved.startsWith("~/") || resolved.startsWith("~\\")) return path.join(os.homedir(), resolved.slice(2));
	return resolved;
}

function resolveBearerToken(definition: Pick<ServerEntry, "bearerToken" | "bearerTokenEnv">): string | undefined {
	if (definition.bearerToken !== undefined) return interpolateSecretExpression(definition.bearerToken);
	return definition.bearerTokenEnv ? process.env[definition.bearerTokenEnv] : undefined;
}

function stableStringify(value: unknown): string {
	if (value === null || value === undefined || typeof value !== "object") {
		const serialized = JSON.stringify(value);
		return serialized === undefined ? "undefined" : serialized;
	}
	if (Array.isArray(value)) return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
	const obj = value as Record<string, unknown>;
	return `{${Object.keys(obj).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`).join(",")}}`;
}
