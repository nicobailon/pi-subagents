export interface ChildToolDiagnostic {
	agent?: string;
	required: string[];
	available: string[];
	missing: string[];
	missingMcpDirectTools?: string[];
	/** Registered allowlisted tools an extension left out of the tools sent to the model. */
	undeclared?: string[];
	/** Tools sent to the model that this child cannot call. */
	uncallable?: string[];
}

/**
 * Explain missing child tools. Foreground children run inside the parent
 * process and never load the parent's ambient extensions, so tools an ambient
 * extension registers (MCP tools, provider tools) only exist for background
 * children; the diagnostic says so instead of reporting a generic gap.
 */
export function formatChildToolDiagnostic(diagnostic: ChildToolDiagnostic, options: { host?: "parent" | "runner" } = {}): string {
	const subject = diagnostic.agent ? `Agent '${diagnostic.agent}'` : "Subagent";
	if (diagnostic.undeclared?.length) {
		const uncallable = diagnostic.uncallable?.length ? ` and added ${diagnostic.uncallable.join(", ")}, which this child cannot call` : "";
		return [
			`${subject} declares tools: ${diagnostic.required.join(", ")}, but an extension loaded in this child replaced the tools sent to the model: it left out ${diagnostic.undeclared.join(", ")}${uncallable}.`,
			"The `tools` field is a strict allowlist. Set `extensions: []` or list only the extensions this child needs, or omit `tools` to use that extension's tool surface.",
		].join("\n");
	}
	if (options.host === "parent") {
		return [
			`${subject} ran as a foreground child, which never loads the parent's ambient extensions, and these child tools were unavailable: ${diagnostic.missing.join(", ")}.`,
			"The `tools` field is a strict allowlist; it does not load extension code.",
			...(diagnostic.missingMcpDirectTools?.length
				? [`MCP direct tools missing from the child registry: ${diagnostic.missingMcpDirectTools.join(", ")}.`]
				: []),
			"MCP tools require background children (`async: true`) because only they load ambient extensions.",
			"For extension tools a foreground child can load, add the provider path to `subagentOnlyExtensions` (child-only), `extensions`, or as a path-like entry in `tools`, while keeping each registered tool name in `tools`.",
		].join("\n");
	}
	return [
		`${subject} requested unavailable child tools: ${diagnostic.missing.join(", ")}.`,
		"The `tools` field is a strict allowlist; it does not load extension code.",
		...(diagnostic.missingMcpDirectTools?.length
			? [`Resolved MCP direct tools missing from the child registry: ${diagnostic.missingMcpDirectTools.join(", ")}. Resolved names must match what the host or pi-mcp-adapter registers; check the MCP direct-tool registration before treating this as a tool-call failure.`]
			: []),
		"For extension tools, add the provider path to `subagentOnlyExtensions` (child-only), `extensions`, or as a path-like entry in `tools`, while keeping each registered tool name in `tools`.",
		"For MCP tools, verify the MCP adapter configuration and selected tool names. For builtin tools, verify the name against the installed Pi version.",
	].join("\n");
}
