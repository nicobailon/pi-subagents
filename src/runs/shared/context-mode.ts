export type ContextMode = "fresh" | "fork";
export type ContextSummary = ContextMode | "mixed";

export function isContextMode(value: unknown): value is ContextMode {
	return value === "fresh" || value === "fork";
}

export function isContextSummary(value: unknown): value is ContextSummary {
	return isContextMode(value) || value === "mixed";
}

export function summarizeContextModes(modes: Array<ContextMode | undefined>): ContextSummary | undefined {
	const resolved = modes.filter(isContextMode);
	if (resolved.length === 0) return undefined;
	const first = resolved[0]!;
	return resolved.every((mode) => mode === first) ? first : "mixed";
}

export function contextModeLabel(mode: ContextMode | ContextSummary | undefined): string {
	if (mode === "fork") return "[fork]";
	if (mode === "fresh") return "[fresh]";
	if (mode === "mixed") return "[mixed]";
	return "";
}

export function contextModeBadge(
	theme: { fg(name: string, text: string): string },
	mode: ContextMode | ContextSummary | undefined,
): string {
	const label = contextModeLabel(mode);
	if (!label) return "";
	if (mode === "fork") return theme.fg("warning", ` ${label}`);
	return theme.fg("dim", ` ${label}`);
}

export function contextModePrefix(
	theme: { fg(name: string, text: string): string },
	mode: ContextMode | ContextSummary | undefined,
): string {
	const label = contextModeLabel(mode);
	if (!label) return "";
	if (mode === "fork") return `${theme.fg("warning", label)} `;
	return `${theme.fg("dim", label)} `;
}
