import type { ExtensionBootstrapDiagnostic } from "../../shared/types.ts";

export const EXTENSION_BOOTSTRAP_SUSPECTED = "extension-bootstrap-suspected" as const;

const PI_EXTENSION_LOAD_FAILURE = /^[ \t]*(?:Error:[ \t]*)?(Failed to load extension[ \t]+(?:"[^"\r\n]+"|'[^'\r\n]+'|(?:[A-Za-z]:[\\/]|\\\\|\/|\.\.?[\\/]|~[\\/])\S+):[ \t]*\S[^\r\n]*)/m;

/**
 * Classify only Pi's explicit extension-loader diagnostic. Module resolution,
 * imports, tool failures, and other generic startup-looking errors are not
 * sufficient evidence.
 */
export function classifyExtensionBootstrapDiagnostic(stderr: string | undefined): ExtensionBootstrapDiagnostic | undefined {
	if (!stderr) return undefined;
	const match = PI_EXTENSION_LOAD_FAILURE.exec(stderr);
	if (!match?.[1]) return undefined;
	return {
		classification: EXTENSION_BOOTSTRAP_SUSPECTED,
		retryable: false,
		summary: `${EXTENSION_BOOTSTRAP_SUSPECTED}: Pi reported a child extension load failure; automatic retry is disabled.`,
		diagnosticLine: match[1].trim(),
		evidence: stderr,
	};
}
