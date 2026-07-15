import * as fs from "node:fs";
import * as path from "node:path";

export const REQUIRED_CHILD_TOOLS_ENV = "PI_SUBAGENT_REQUIRED_TOOLS";
export const CHILD_TOOL_DIAGNOSTIC_PATH_ENV = "PI_SUBAGENT_TOOL_DIAGNOSTIC_PATH";

export interface ChildToolDiagnostic {
	agent?: string;
	required: string[];
	available: string[];
	missing: string[];
}

export function writeChildToolDiagnostic(
	filePath: string,
	required: string[],
	available: string[],
	agent?: string,
): ChildToolDiagnostic | undefined {
	const availableNames = new Set(available);
	const missing = required.filter((name) => !availableNames.has(name));
	if (missing.length === 0) {
		fs.rmSync(filePath, { force: true });
		return undefined;
	}

	const diagnostic: ChildToolDiagnostic = { agent, required, available, missing };
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, JSON.stringify(diagnostic), { mode: 0o600 });
	return diagnostic;
}

export function readChildToolDiagnostic(filePath: string | undefined): ChildToolDiagnostic | undefined {
	if (!filePath || !fs.existsSync(filePath)) return undefined;
	const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8")) as Partial<ChildToolDiagnostic>;
	const stringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every((entry) => typeof entry === "string" && entry.length > 0);
	if (!stringArray(parsed.required) || !stringArray(parsed.available) || !stringArray(parsed.missing) || (parsed.agent !== undefined && typeof parsed.agent !== "string")) {
		throw new Error(`Malformed child tool diagnostic at '${filePath}'.`);
	}
	return {
		...(parsed.agent ? { agent: parsed.agent } : {}),
		required: parsed.required,
		available: parsed.available,
		missing: parsed.missing,
	};
}

export function formatChildToolDiagnostic(diagnostic: ChildToolDiagnostic): string {
	const subject = diagnostic.agent ? `Agent '${diagnostic.agent}'` : "Subagent";
	return [
		`${subject} requested unavailable child tools: ${diagnostic.missing.join(", ")}.`,
		"The `tools` field is a strict allowlist; it does not load extension code.",
		"For extension tools, add the provider path to `subagentOnlyExtensions` (child-only), `extensions`, or as a path-like entry in `tools`, while keeping each registered tool name in `tools`.",
		"For MCP tools, verify the MCP adapter configuration and selected tool names. For builtin tools, verify the name against the installed Pi version.",
	].join("\n");
}

export function readChildToolDiagnosticError(filePath: string | undefined): string | undefined {
	try {
		const diagnostic = readChildToolDiagnostic(filePath);
		return diagnostic ? formatChildToolDiagnostic(diagnostic) : undefined;
	} catch (error) {
		return `Failed to read child tool availability diagnostic: ${error instanceof Error ? error.message : String(error)}`;
	}
}
