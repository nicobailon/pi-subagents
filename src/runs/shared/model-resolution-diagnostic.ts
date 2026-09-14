export interface ChildModelResolutionDiagnostic {
	agent?: string;
	model?: string;
	host?: "parent" | "runner";
	/** The launch's resolved capability ceiling, when one is active. */
	capabilityCeiling?: { denyExtensions: boolean; sources?: readonly string[] };
}

/**
 * Pi core's model-resolution failure text. `resolveCliModel` reports an
 * unknown provider or model and cannot know which extension would have
 * registered it, so these two shapes are the ones that mean "the child's
 * model registry was missing a provider", not "the provider is unhealthy".
 */
const MODEL_RESOLUTION_FAILURE_PATTERNS = [
	/^Model .+ not found\b/i,
	/^Unknown provider "/i,
];

/** True for a core model-resolution failure, which a missing extension can explain. */
export function isChildModelResolutionFailure(error: string | undefined): boolean {
	const text = typeof error === "string" ? error.trim() : "";
	return MODEL_RESOLUTION_FAILURE_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * A `capabilityCeiling.denyExtensions` launch loads no extension at all:
 * ambient, listed, and MCP provider extensions are all suppressed, so neither
 * `async: true` nor a frontmatter list can register the provider. Saying only
 * the ambient-extension rule would direct the operator at remedies the ceiling
 * discards.
 */
function capabilityCeilingDeniesExtensions(diagnostic: ChildModelResolutionDiagnostic): boolean {
	return diagnostic.capabilityCeiling?.denyExtensions === true;
}

function denyExtensionsClause(diagnostic: ChildModelResolutionDiagnostic): string {
	const sources = diagnostic.capabilityCeiling?.sources ?? [];
	return `Capability ceiling from ${sources.length > 0 ? sources.join(", ") : "an unnamed source"} denies extensions`;
}

/**
 * Explain a child model that did not resolve because the extension serving its
 * provider never loaded: a foreground child never loads the parent's ambient
 * extensions, an explicit `extensions` list keeps a background child from
 * loading them, and a capability ceiling denies extensions to both. The caller
 * keeps the core error intact and appends this explanation, so a genuinely
 * unknown model id still reads as one.
 */
export function formatChildModelResolutionDiagnostic(diagnostic: ChildModelResolutionDiagnostic): string {
	const subject = diagnostic.agent ? `Agent '${diagnostic.agent}'` : "Subagent";
	const model = diagnostic.model ? `'${diagnostic.model}'` : "this model";
	if (capabilityCeilingDeniesExtensions(diagnostic)) {
		return (diagnostic.host === "parent"
			? [
				`${subject} ran as a foreground child, which never loads the parent's ambient extensions.`,
				`${denyExtensionsClause(diagnostic)}, so if ${model} is served by a provider extension, that extension cannot load for this child: \`async: true\` does not help either, and listed \`subagentOnlyExtensions\` or \`extensions\` entries are suppressed.`,
				"Relax the capability ceiling to allow extensions, or use a model that the parent's model registry already resolves.",
			]
			: [
				`${subject} ran as a background child without the ambient extensions.`,
				`${denyExtensionsClause(diagnostic)}, so if ${model} is served by a provider extension, that extension cannot load for this child: listed \`subagentOnlyExtensions\` or \`extensions\` entries are suppressed, and leaving \`extensions\` unset does not enable ambient loading.`,
				"Relax the capability ceiling to allow extensions, or use a model that the child's model registry already resolves.",
			]).join("\n");
	}
	if (diagnostic.host === "parent") {
		return [
			`${subject} ran as a foreground child, which never loads the parent's ambient extensions.`,
			`If ${model} is served by a provider extension, that extension is not loaded for this child: agents that need models from a provider extension must run as background children (\`async: true\`) with \`extensions\` unset, which load the ambient extensions; a background child with an \`extensions\` list loads only what it lists.`,
			"To keep this child in the foreground, load the provider extension explicitly with `subagentOnlyExtensions` or `extensions` in the agent frontmatter.",
		].join("\n");
	}
	return [
		`${subject} ran as a background child without the ambient extensions.`,
		`If ${model} is served by a provider extension, that extension is not loaded for this child: list it in \`subagentOnlyExtensions\` or \`extensions\` in the agent frontmatter, or leave \`extensions\` unset so the child loads the ambient extensions.`,
	].join("\n");
}
