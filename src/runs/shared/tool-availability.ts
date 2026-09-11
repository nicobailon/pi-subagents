export interface ChildToolDiagnostic {
	agent?: string;
	required: string[];
	available: string[];
	missing: string[];
	missingMcpDirectTools?: string[];
}

/** Explain missing child tools after the child registry has been initialized. */
export function formatChildToolDiagnostic(diagnostic: ChildToolDiagnostic, options: { host?: "parent" | "runner" } = {}): string {
	const subject = diagnostic.agent ? `Agent '${diagnostic.agent}'` : "Subagent";
	if (options.host === "parent") {
		return [
			`${subject} requested unavailable tools in its foreground child runtime: ${diagnostic.missing.join(", ")}.`,
			"The `tools` field is a strict allowlist; it does not load extension code.",
			...(diagnostic.missingMcpDirectTools?.length
				? [`MCP direct tools missing from the child registry: ${diagnostic.missingMcpDirectTools.join(", ")}.`]
				: []),
			"Verify that the ambient extension is configured for Pi, or add the provider path to `subagentOnlyExtensions` (child-only), `extensions`, or as a path-like entry in `tools`, while keeping each registered tool name in `tools`.",
		].join("\n");
	}
	return [
		`${subject} requested unavailable child tools: ${diagnostic.missing.join(", ")}.`,
		"The `tools` field is a strict allowlist; it does not load extension code.",
		...(diagnostic.missingMcpDirectTools?.length
			? [`Resolved MCP direct tools missing from the child registry: ${diagnostic.missingMcpDirectTools.join(", ")}. This indicates a host/pi-mcp-adapter registration problem, not a tool-call failure.`]
			: []),
		"For extension tools, add the provider path to `subagentOnlyExtensions` (child-only), `extensions`, or as a path-like entry in `tools`, while keeping each registered tool name in `tools`.",
		"For MCP tools, verify the MCP adapter configuration and selected tool names. For builtin tools, verify the name against the installed Pi version.",
	].join("\n");
}
