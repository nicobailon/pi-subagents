const BUILTIN_TOOL_NAMES = new Set(["read", "bash", "edit", "write", "grep", "find", "ls", "mcp"]);

export type McpToolPrefix = "server" | "none" | "short" | "mcp";

export interface McpGrantServerFacts {
	readonly exposeResources?: boolean;
	readonly includeTools?: readonly unknown[];
	readonly excludeTools?: readonly unknown[];
	/** Per-server prefix override, matching the adapter's `ServerEntry.toolPrefix`. */
	readonly toolPrefix?: unknown;
}

export interface McpGrantToolMetadata {
	readonly name?: string;
}

export interface McpGrantResourceMetadata {
	readonly name?: string;
	readonly uri?: string;
}

export interface McpGrantServerMetadata {
	readonly tools?: readonly McpGrantToolMetadata[];
	readonly resources?: readonly McpGrantResourceMetadata[];
}

export interface McpDirectToolGrantInput {
	readonly selectors?: readonly string[];
	readonly servers: Readonly<Record<string, McpGrantServerFacts>>;
	/** Cache entries already validated by the source-loading adapter. */
	readonly metadata: Readonly<Record<string, McpGrantServerMetadata>>;
	readonly toolPrefix?: unknown;
}

export interface ResolvedMcpDirectToolSelection {
	name: string;
	selector: string;
}

export interface McpDirectToolGrant {
	selections: ResolvedMcpDirectToolSelection[];
	unresolvedSelectors: string[];
}

export function normalizeMcpDirectToolSelectors(selectors: readonly string[] | undefined): string[] {
	return [...new Set((selectors ?? []).map((selector) => selector.replace(/\/+$/, "")).filter(Boolean))];
}

export function parseMcpDirectToolSelectors(selectors: readonly string[]): {
	servers: Set<string>;
	tools: Map<string, Set<string>>;
} {
	const servers = new Set<string>();
	const tools = new Map<string, Set<string>>();
	for (const item of selectors) {
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

export function planMcpDirectToolGrant(input: McpDirectToolGrantInput): McpDirectToolGrant {
	const selectors = normalizeMcpDirectToolSelectors(input.selectors);
	if (selectors.length === 0) return { selections: [], unresolvedSelectors: [] };

	const { servers: selectedServers, tools: selectedTools } = parseMcpDirectToolSelectors(selectors);
	const selections: ResolvedMcpDirectToolSelection[] = [];
	const seenNames = new Set<string>();

	for (const [serverName, server] of Object.entries(input.servers)) {
		const metadata = input.metadata[serverName];
		if (!metadata) continue;

		const toolFilter: true | ReadonlySet<string> | undefined = selectedServers.has(serverName)
			? true
			: selectedTools.get(serverName);
		if (!toolFilter) continue;
		const prefix = normalizeMcpToolPrefix(server.toolPrefix ?? input.toolPrefix);

		for (const tool of Array.isArray(metadata.tools) ? metadata.tools : []) {
			if (typeof tool?.name !== "string" || !tool.name) continue;
			if (toolFilter !== true && !toolFilter.has(tool.name)) continue;
			if (!isToolAllowed(tool.name, serverName, prefix, server.includeTools, server.excludeTools)) continue;
			const name = formatToolName(tool.name, serverName, prefix);
			if (BUILTIN_TOOL_NAMES.has(name) || seenNames.has(name)) continue;
			seenNames.add(name);
			selections.push({ name, selector: `${serverName}/${tool.name}` });
		}

		if (server.exposeResources === false) continue;
		for (const resource of Array.isArray(metadata.resources) ? metadata.resources : []) {
			if (typeof resource?.name !== "string" || !resource.name || typeof resource.uri !== "string" || !resource.uri) continue;
			const baseName = `get_${resourceNameToToolName(resource.name)}`;
			if (toolFilter !== true && !toolFilter.has(baseName)) continue;
			if (!isToolAllowed(baseName, serverName, prefix, server.includeTools, server.excludeTools)) continue;
			const name = formatToolName(baseName, serverName, prefix);
			if (BUILTIN_TOOL_NAMES.has(name) || seenNames.has(name)) continue;
			seenNames.add(name);
			selections.push({ name, selector: `${serverName}/${baseName}` });
		}
	}

	const unresolvedSelectors = selectors.filter((selector) =>
		selector.includes("/")
			? !selections.some((selection) => selection.selector === selector)
			: !selections.some((selection) => selection.selector.startsWith(`${selector}/`)),
	);
	return { selections, unresolvedSelectors };
}

export function normalizeMcpToolPrefix(value: unknown): McpToolPrefix {
	return value === "none" || value === "short" || value === "mcp" || value === "server" ? value : "server";
}

export function formatUnresolvedMcpDirectToolSelectors(selectors: readonly string[]): string {
	return `Unresolved MCP direct-tool selectors: ${selectors.join(", ")}. Direct MCP tools require a matching configured server and fresh metadata cache; runtime-registered servers require a host/pi-mcp-adapter handoff before child launch.`;
}

function getServerPrefix(serverName: string, mode: McpToolPrefix): string {
	if (mode === "none") return "";
	if (mode === "short") return sanitizeServerPrefix(serverName.replace(/-?mcp$/i, "")) || "mcp";
	if (mode === "mcp") return `mcp__${sanitizeServerPrefix(serverName)}`;
	return sanitizeServerPrefix(serverName);
}

/** Adapter parity: characters outside [A-Za-z0-9_-] become `_<code point in hex>_`. */
function sanitizeServerPrefix(serverName: string): string {
	return Array.from(serverName, (char) => /^[A-Za-z0-9_-]$/.test(char) ? char : `_${char.codePointAt(0)!.toString(16)}_`).join("");
}

function formatToolName(toolName: string, serverName: string, prefix: McpToolPrefix): string {
	const serverPrefix = getServerPrefix(serverName, prefix);
	const sanitized = toolName.replace(/\./g, "_");
	// Some servers prefix their tool names with the server name (codegraph ->
	// codegraph_explore). pi-mcp-adapter registers such a name unchanged, so
	// keep the two sides in agreement instead of demanding codegraph_codegraph_explore.
	if (serverPrefix && sanitized.startsWith(`${serverPrefix}_`) && sanitized.length > serverPrefix.length + 1) {
		return sanitized;
	}
	return serverPrefix ? `${serverPrefix}_${sanitized}` : sanitized;
}

function isToolAllowed(
	toolName: string,
	serverName: string,
	prefix: McpToolPrefix,
	includeTools: readonly unknown[] | undefined,
	excludeTools: readonly unknown[] | undefined,
): boolean {
	const candidates = toolNameCandidates(toolName, serverName, prefix);
	return (!Array.isArray(includeTools) || includeTools.length === 0 || matchesToolPatterns(candidates, includeTools))
		&& !matchesToolPatterns(candidates, excludeTools);
}

function toolNameCandidates(toolName: string, serverName: string, prefix: McpToolPrefix): Set<string> {
	return new Set([
		toolName,
		`mcp_${toolName}`,
		formatToolName(toolName, serverName, prefix),
		formatToolName(toolName, serverName, "server"),
		formatToolName(toolName, serverName, "short"),
		formatToolName(toolName, serverName, "mcp"),
		formatToolName(toolName, serverName, "none"),
	]);
}

function matchesToolPatterns(candidates: ReadonlySet<string>, patterns: readonly unknown[] | undefined): boolean {
	if (!Array.isArray(patterns) || patterns.length === 0) return false;
	for (const pattern of patterns) {
		if (typeof pattern !== "string") continue;
		const normalizedPattern = normalizeToolName(pattern);
		const matcher = normalizedPattern.includes("*") || normalizedPattern.includes("?")
			? globToRegExp(normalizedPattern)
			: undefined;
		for (const candidate of candidates) {
			const normalizedCandidate = normalizeToolName(candidate);
			if (matcher ? matcher.test(normalizedCandidate) : normalizedCandidate === normalizedPattern) return true;
		}
	}
	return false;
}

function globToRegExp(pattern: string): RegExp {
	const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
	return new RegExp(`^${escaped}$`);
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
