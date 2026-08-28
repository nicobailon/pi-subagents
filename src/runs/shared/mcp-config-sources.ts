import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { findConfiguredProjectRoot } from "../../agents/agents.ts";
import { getAgentDir, getConfigDirName, getProjectConfigDir } from "../../shared/utils.ts";

const PACKAGE_CONFIG_ROOT = "npm";
const PACKAGE_GIT_ROOT = "git";
const PLUGIN_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
const PLUGIN_MCP_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";
const PLUGIN_NAME_PATTERN = /^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;
const PLUGIN_STDIO_FIELDS = new Set(["type", "command", "args", "env", "cwd"]);
const PLUGIN_HTTP_FIELDS = new Set(["type", "url", "headers"]);

export interface McpServerDefinition {
	command?: string;
	args?: string[];
	socket?: string;
	env?: Record<string, string>;
	cwd?: string;
	url?: string;
	headers?: Record<string, string>;
	requestHeadersCommand?: {
		command: string;
		args?: string[];
		env?: Record<string, string>;
		timeoutMs?: number;
	};
	auth?: "oauth" | "bearer" | false;
	bearerToken?: string;
	bearerTokenEnv?: string;
	exposeResources?: boolean;
	includeTools?: string[];
	excludeTools?: string[];
	protocolVersion?: string;
	directTools?: boolean | string[];
	httpTransport?: string;
	pluginDataDir?: string;
	literalEnv?: boolean;
}

export function isMcpServerDefinition(value: unknown): value is McpServerDefinition {
	if (!isRecord(value)) return false;
	for (const field of ["command", "socket", "cwd", "url", "bearerToken", "bearerTokenEnv", "protocolVersion", "httpTransport", "pluginDataDir"] as const) {
		if (value[field] !== undefined && typeof value[field] !== "string") return false;
	}
	for (const field of ["args", "includeTools", "excludeTools"] as const) {
		if (value[field] !== undefined && !isStringArray(value[field])) return false;
	}
	for (const field of ["env", "headers"] as const) {
		if (value[field] !== undefined && !isStringRecord(value[field])) return false;
	}
	for (const field of ["exposeResources", "literalEnv"] as const) {
		if (value[field] !== undefined && typeof value[field] !== "boolean") return false;
	}
	if (value.requestHeadersCommand !== undefined && !isRequestHeadersCommand(value.requestHeadersCommand)) return false;
	if (value.auth !== undefined && value.auth !== "oauth" && value.auth !== "bearer" && value.auth !== false) return false;
	return value.directTools === undefined || typeof value.directTools === "boolean" || isStringArray(value.directTools);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isStringRecord(value: unknown): value is Record<string, string> {
	return isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");
}

function isRequestHeadersCommand(value: unknown): value is NonNullable<McpServerDefinition["requestHeadersCommand"]> {
	if (!isRecord(value) || typeof value.command !== "string") return false;
	if (value.args !== undefined && !isStringArray(value.args)) return false;
	if (value.env !== undefined && !isStringRecord(value.env)) return false;
	return value.timeoutMs === undefined || (typeof value.timeoutMs === "number" && Number.isFinite(value.timeoutMs));
}

export function loadPackageMcpServers(cwd: string): Record<string, McpServerDefinition> {
	const servers: Record<string, McpServerDefinition> = {};
	const seen = new Set<string>();

	for (const packageRoot of getConfiguredPackageRoots(cwd)) {
		const manifest = readJson(path.join(packageRoot, "package.json"));
		if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) continue;
		const packageName = (manifest as { name?: unknown }).name;
		if (typeof packageName !== "string" || !packageName) continue;
		const mcpValue = (manifest as { pi?: { mcp?: unknown } }).pi?.mcp;
		const configPaths = typeof mcpValue === "string"
			? [mcpValue]
			: Array.isArray(mcpValue) && mcpValue.every((value): value is string => typeof value === "string")
				? mcpValue
				: [];
		const packagePrefix = formatName(packageName, "package");

		for (const configPath of configPaths) {
			const resolvedPath = resolvePackageConfigPath(packageRoot, configPath);
			if (!resolvedPath) continue;
			const config = readJson(resolvedPath);
			if (!config || typeof config !== "object" || Array.isArray(config)) continue;
			const rawServers = (config as { mcpServers?: unknown }).mcpServers;
			if (!rawServers || typeof rawServers !== "object" || Array.isArray(rawServers)) continue;
			for (const [serverName, definition] of Object.entries(rawServers)) {
				if (!isMcpServerDefinition(definition)) continue;
				const normalizedName = `${packagePrefix}__${formatName(serverName, "server")}`;
				if (seen.has(normalizedName)) continue;
				seen.add(normalizedName);
				servers[normalizedName] = definition;
			}
		}
	}

	return servers;
}

export function loadAgentPluginMcpServers(paths: unknown, cwd: string): Record<string, McpServerDefinition> {
	const servers: Record<string, McpServerDefinition> = {};
	if (!Array.isArray(paths)) return servers;

	for (const configuredPath of paths) {
		if (typeof configuredPath !== "string") continue;
		const pluginRoot = resolvePluginPath(configuredPath, cwd);
		const manifest = readJson(path.join(pluginRoot, "plugin.json"));
		if (!isValidPluginManifest(manifest)) continue;
		const config = readJson(path.join(pluginRoot, "mcp.json"));
		if (!isValidPluginConfig(config)) continue;
		const rawServers = (config as { mcpServers: Record<string, unknown> }).mcpServers;

		for (const [serverName, rawDefinition] of Object.entries(rawServers)) {
			const definition = translatePluginServer(manifest.name, pluginRoot, rawDefinition);
			if (!definition) continue;
			const normalizedName = `${formatName(manifest.name, "plugin")}__${formatName(serverName, "server")}`;
			if (Object.hasOwn(servers, normalizedName)) continue;
			servers[normalizedName] = definition;
		}
	}

	return servers;
}

function getConfiguredPackageRoots(cwd: string): string[] {
	const roots: string[] = [];
	const projectConfigDir = findProjectConfigDir(cwd);
	const sources = [
		{ path: path.join(projectConfigDir, "settings.json"), baseDir: projectConfigDir },
		{ path: path.join(getAgentDir(), "settings.json"), baseDir: getAgentDir() },
	];
	for (const source of sources) {
		const settings = readJson(source.path);
		if (!settings || typeof settings !== "object" || Array.isArray(settings)) continue;
		const packages = (settings as { packages?: unknown }).packages;
		if (!Array.isArray(packages)) continue;
		for (const entry of packages) {
			const packageSource = typeof entry === "string"
				? entry
				: entry && typeof entry === "object" && !Array.isArray(entry) && typeof (entry as { source?: unknown }).source === "string"
					? (entry as { source: string }).source
					: undefined;
			if (!packageSource) continue;
			const root = resolvePackageRoot(packageSource, source.baseDir);
			if (root && !roots.includes(root)) roots.push(root);
		}
	}
	return roots;
}

function findProjectConfigDir(cwd: string): string {
	const projectRoot = findConfiguredProjectRoot(path.resolve(cwd));
	return projectRoot ? getProjectConfigDir(projectRoot) : path.join(path.resolve(cwd), getConfigDirName());
}

function resolvePackageRoot(source: string, baseDir: string): string | undefined {
	const trimmed = source.trim();
	if (!trimmed) return undefined;
	if (trimmed.startsWith("npm:")) {
		const packageName = parseNpmPackageName(trimmed);
		return packageName ? resolveContainedPath(path.join(baseDir, PACKAGE_CONFIG_ROOT, "node_modules"), packageName) ?? undefined : undefined;
	}

	if (trimmed.startsWith("git:") || /^(?:https?:\/\/|ssh:\/\/|git@[^:]+:)/.test(trimmed)) {
		const parsed = parseGitPackagePath(trimmed.startsWith("git:") ? trimmed : `git:${trimmed}`);
		return parsed ? path.join(baseDir, PACKAGE_GIT_ROOT, parsed.host, parsed.repoPath) : undefined;
	}

	const localPath = trimmed.startsWith("file:") ? trimmed.slice(5) : trimmed;
	if (localPath === "~") return os.homedir();
	if (localPath.startsWith("~/")) return path.join(os.homedir(), localPath.slice(2));
	return path.isAbsolute(localPath) ? path.resolve(localPath) : path.resolve(baseDir, localPath);
}

function parseNpmPackageName(source: string): string | undefined {
	const spec = source.slice(4).trim();
	if (!spec) return undefined;
	const match = spec.match(/^(@?[^@]+(?:\/[^@]+)?)(?:@(.+))?$/);
	const packageName = match?.[1] ?? spec;
	return resolveContainedPath("/", packageName) ? packageName : undefined;
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

function stripGitRef(repoPath: string): string {
	const atIndex = repoPath.indexOf("@");
	const hashIndex = repoPath.indexOf("#");
	const refIndex = [atIndex, hashIndex].filter((index) => index >= 0).sort((a, b) => a - b)[0];
	return refIndex === undefined ? repoPath : repoPath.slice(0, refIndex);
}

function isSafePackagePath(value: string): boolean {
	return value.length > 0
		&& !path.isAbsolute(value)
		&& value.split(/[\\/]/).every((part) => part.length > 0 && part !== "." && part !== "..");
}

function resolvePackageConfigPath(packageRoot: string, configuredPath: string): string | undefined {
	const lexicalPath = resolveContainedPath(packageRoot, configuredPath);
	if (!lexicalPath || !fs.existsSync(lexicalPath)) return undefined;
	try {
		if (!fs.statSync(lexicalPath).isFile()) return undefined;
		const packageRealPath = fs.realpathSync(packageRoot);
		const configRealPath = fs.realpathSync(lexicalPath);
		return resolveContainedPath(packageRealPath, configRealPath) ?? undefined;
	} catch {
		return undefined;
	}
}

function resolveContainedPath(root: string, value: string): string | undefined {
	const resolved = path.resolve(root, value);
	const relative = path.relative(root, resolved);
	return relative === "" || (!relative.startsWith("..") && !relative.startsWith(path.sep) && !path.isAbsolute(relative))
		? resolved
		: undefined;
}

function resolvePluginPath(configuredPath: string, cwd: string): string {
	if (configuredPath === "~") return path.resolve(process.env.HOME ?? "", ".");
	if (configuredPath.startsWith("~/")) return path.resolve(process.env.HOME ?? "", configuredPath.slice(2));
	return path.isAbsolute(configuredPath) ? path.resolve(configuredPath) : path.resolve(cwd, configuredPath);
}

function isValidPluginManifest(value: unknown): value is { name: string } {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const manifest = value as { $schema?: unknown; name?: unknown };
	return manifest.$schema === PLUGIN_SCHEMA
		&& typeof manifest.name === "string"
		&& manifest.name.length >= 1
		&& manifest.name.length <= 64
		&& PLUGIN_NAME_PATTERN.test(manifest.name);
}

function isValidPluginConfig(value: unknown): value is { mcpServers: Record<string, unknown> } {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const config = value as Record<string, unknown>;
	return config.$schema === PLUGIN_MCP_SCHEMA
		&& Object.keys(config).every((key) => key === "$schema" || key === "mcpServers")
		&& !!config.mcpServers
		&& typeof config.mcpServers === "object"
		&& !Array.isArray(config.mcpServers);
}

function translatePluginServer(
	pluginName: string,
	pluginRoot: string,
	value: unknown,
): McpServerDefinition | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const raw = value as Record<string, unknown>;
	if (raw.type === "stdio") return translatePluginStdioServer(pluginName, pluginRoot, raw);
	if (raw.type === "streamable-http" || raw.type === "sse") return translatePluginHttpServer(raw);
	return undefined;
}

function translatePluginStdioServer(
	pluginName: string,
	pluginRoot: string,
	raw: Record<string, unknown>,
): McpServerDefinition | undefined {
	if ([...Object.keys(raw)].some((key) => !PLUGIN_STDIO_FIELDS.has(key))) return undefined;
	if (typeof raw.command !== "string" || !raw.command) return undefined;
	if (!isBareCommand(raw.command) && !raw.command.startsWith("./")) return undefined;
	const args = stringArray(raw.args);
	if (raw.args !== undefined && !args) return undefined;
	const env = stringRecord(raw.env);
	if (raw.env !== undefined && !env) return undefined;
	if (env && (Object.hasOwn(env, "PLUGIN_ROOT") || Object.hasOwn(env, "PLUGIN_DATA"))) return undefined;

	const pluginDataDir = path.join(getAgentDir(), "agent-plugin-data", pluginName);
	const command = raw.command.startsWith("./") ? resolveContainedPath(pluginRoot, raw.command) : raw.command;
	if (!command) return undefined;
	const cwd = resolvePluginCwd(raw.cwd, pluginRoot, pluginDataDir);
	if (!cwd) return undefined;

	return {
		command,
		args: (args ?? []).map((value) => expandPluginPlaceholders(value, pluginRoot, pluginDataDir)),
		env: {
			...Object.fromEntries(Object.entries(env ?? {}).map(([key, value]) => [key, expandPluginPlaceholders(value, pluginRoot, pluginDataDir)])),
			PLUGIN_ROOT: pluginRoot,
			PLUGIN_DATA: pluginDataDir,
		},
		cwd,
		pluginDataDir,
		literalEnv: true,
	};
}

function translatePluginHttpServer(raw: Record<string, unknown>): McpServerDefinition | undefined {
	if ([...Object.keys(raw)].some((key) => !PLUGIN_HTTP_FIELDS.has(key))) return undefined;
	if (typeof raw.url !== "string" || !isValidPluginUrl(raw.url)) return undefined;
	const headers = stringRecord(raw.headers);
	if (raw.headers !== undefined && !headers) return undefined;
	if (headers) {
		const normalized = new Set<string>();
		for (const key of Object.keys(headers)) {
			const lower = key.toLowerCase();
			if (normalized.has(lower)) return undefined;
			normalized.add(lower);
		}
		try {
			new Headers(headers);
		} catch {
			return undefined;
		}
	}
	return { url: raw.url, ...(headers ? { headers } : {}), httpTransport: raw.type as string };
}

function resolvePluginCwd(value: unknown, pluginRoot: string, pluginDataDir: string): string | undefined {
	if (value === undefined) return pluginRoot;
	if (typeof value !== "string") return undefined;
	if (value.startsWith("./")) return resolveContainedPath(pluginRoot, value);
	if (value === "${PLUGIN_ROOT}" || value.startsWith("${PLUGIN_ROOT}/")) return resolveContainedPath(pluginRoot, value.replace("${PLUGIN_ROOT}", "."));
	if (value === "${PLUGIN_DATA}" || value.startsWith("${PLUGIN_DATA}/")) return resolveContainedPath(pluginDataDir, value.replace("${PLUGIN_DATA}", "."));
	return undefined;
}

function expandPluginPlaceholders(value: string, pluginRoot: string, pluginDataDir: string): string {
	return value.replaceAll("${PLUGIN_ROOT}", pluginRoot).replaceAll("${PLUGIN_DATA}", pluginDataDir);
}

function isBareCommand(command: string): boolean {
	return !command.includes("/")
		&& !command.includes("\\")
		&& !command.includes("${PLUGIN_ROOT}")
		&& !command.includes("${PLUGIN_DATA}");
}

function isValidPluginUrl(value: string): boolean {
	if (value.includes("${") || value.includes("$env:") || value.includes("{env:")) return false;
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return false;
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return false;
	if (url.username || url.password || url.hash) return false;
	if (url.protocol === "https:") return true;
	const host = url.hostname.toLowerCase();
	return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(host);
}

function stringArray(value: unknown): string[] | undefined {
	return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value : undefined;
}

function stringRecord(value: unknown): Record<string, string> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const entries = Object.entries(value);
	if (entries.some(([, entry]) => typeof entry !== "string")) return undefined;
	return Object.fromEntries(entries) as Record<string, string>;
}

function formatName(value: string, fallback: string): string {
	return value.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^[_-]+|[_-]+$/g, "") || fallback;
}

function readJson(filePath: string): unknown | undefined {
	let content: string;
	try {
		content = fs.readFileSync(filePath, "utf-8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw new Error(`Failed to read JSON file '${filePath}': ${error instanceof Error ? error.message : String(error)}`, { cause: error });
	}
	try {
		return JSON.parse(content);
	} catch (error) {
		throw new Error(`Invalid JSON in '${filePath}': ${error instanceof Error ? error.message : String(error)}`, { cause: error });
	}
}
