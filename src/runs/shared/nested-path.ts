import * as path from "node:path";

const MAX_NESTED_ID_LENGTH = 128;
export const MAX_NESTED_PATH_ENTRIES = 4;

export type NestedPathEntry = { runId: string; stepIndex?: number; agent?: string };

export function isSafeNestedPathId(value: unknown): value is string {
	return typeof value === "string"
		&& value.length > 0
		&& value.length <= MAX_NESTED_ID_LENGTH
		&& !path.isAbsolute(value)
		&& !value.includes("/")
		&& !value.includes("\\")
		&& !value.includes("..");
}

function finiteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nonEmptyString(value: unknown, max: number): string | undefined {
	return typeof value === "string" && value.length > 0 ? value.slice(0, max) : undefined;
}

export function sanitizeNestedPath(value: unknown): NestedPathEntry[] {
	if (!Array.isArray(value)) return [];
	return value.map((part) => {
		if (!part || typeof part !== "object") return undefined;
		const record = part as Record<string, unknown>;
		if (!isSafeNestedPathId(record.runId)) return undefined;
		return {
			runId: record.runId,
			...(finiteNumber(record.stepIndex) !== undefined ? { stepIndex: finiteNumber(record.stepIndex) } : {}),
			...(nonEmptyString(record.agent, 128) ? { agent: nonEmptyString(record.agent, 128) } : {}),
		};
	}).filter((part): part is NestedPathEntry => Boolean(part)).slice(0, MAX_NESTED_PATH_ENTRIES);
}

export function parseNestedPathEnv(value: string | undefined): NestedPathEntry[] {
	if (!value) return [];
	try {
		return sanitizeNestedPath(JSON.parse(value) as unknown);
	} catch {
		return [];
	}
}

export function encodeNestedPathEnv(value: NestedPathEntry[]): string {
	const sanitized = sanitizeNestedPath(value);
	return sanitized.length ? JSON.stringify(sanitized) : "";
}
