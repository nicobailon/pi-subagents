export interface ChildModelResolutionDiagnostic {
	agent?: string;
	model?: string;
	host?: "parent" | "runner";
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
 * Explain a child model that did not resolve because the extension serving its
 * provider never loaded: a foreground child never loads the parent's ambient
 * extensions, and an explicit `extensions` list or a capability ceiling keeps a
 * background child from loading them too. The caller keeps the core error
 * intact and appends this explanation, so a genuinely unknown model id still
 * reads as one.
 */
export function formatChildModelResolutionDiagnostic(diagnostic: ChildModelResolutionDiagnostic): string {
	const subject = diagnostic.agent ? `Agent '${diagnostic.agent}'` : "Subagent";
	const model = diagnostic.model ? `'${diagnostic.model}'` : "this model";
	const unloaded = `If ${model} is served by a provider extension, that extension is not loaded for this child`;
	if (diagnostic.host === "parent") {
		return [
			`${subject} ran as a foreground child, which never loads the parent's ambient extensions.`,
			`${unloaded}: agents that need models from a provider extension must run as background children (\`async: true\`), which load the ambient extensions.`,
			"To keep this child in the foreground, load the provider extension explicitly with `subagentOnlyExtensions` or `extensions` in the agent frontmatter.",
		].join("\n");
	}
	return [
		`${subject} ran as a background child without the ambient extensions, so a provider extension the parent loads is absent from its model registry.`,
		`${unloaded}. List it in \`subagentOnlyExtensions\` or \`extensions\` in the agent frontmatter, or leave \`extensions\` unset so the child loads the ambient extensions.`,
	].join("\n");
}
