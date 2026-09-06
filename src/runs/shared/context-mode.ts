export type ContextMode = "fresh" | "fork";
export type ContextSummary = ContextMode | "mixed";

/** A fork context that branches from a named seed session file instead of the parent session. */
export type ForkSeedContextValue = `fork:${string}`;

export function isForkContextValue(value: unknown): value is ContextMode | ForkSeedContextValue {
	return value === "fresh" || value === "fork" || (typeof value === "string" && value.startsWith("fork:"));
}

/** True when the value selects fork context, whether parent-seeded ("fork") or seed-file-seeded ("fork:<path>"). */
export function isForkMode(value: unknown): value is ContextMode | ForkSeedContextValue {
	return value === "fork" || (typeof value === "string" && value.startsWith("fork:") && value.length > "fork:".length);
}

export function isContextMode(value: unknown): value is ContextMode {
	return value === "fresh" || value === "fork";
}

export function isContextSummary(value: unknown): value is ContextSummary {
	return isContextMode(value) || value === "mixed";
}

/** Reduce a mode value (including "fork:<seed>" forms) to its plain mode. */
export function contextModeOf(value: ContextMode | ForkSeedContextValue): ContextMode {
	return isForkMode(value) ? "fork" : "fresh";
}

export function summarizeContextModes(modes: Array<ContextMode | ForkSeedContextValue | undefined>): ContextSummary | undefined {
	const resolved = modes.filter((mode) => mode !== undefined).map(contextModeOf);
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
