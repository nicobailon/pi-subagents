import type { RuntimeAcknowledgedChildExtensions } from "../../shared/types.ts";

export const RUNTIME_EXTENSION_ACK_EVENT = "subagent:acknowledge-extension";
export const MAX_RUNTIME_ACKNOWLEDGED_EXTENSION_IDS = 32;
export const MAX_RUNTIME_ACKNOWLEDGED_EXTENSION_ID_LENGTH = 128;

export function isRuntimeAcknowledgedExtensionId(value: unknown): value is string {
	return typeof value === "string"
		&& value.length > 0
		&& value.length <= MAX_RUNTIME_ACKNOWLEDGED_EXTENSION_ID_LENGTH
		&& /^[A-Za-z0-9._:@+-]+$/.test(value)
		&& !value.includes("..")
		&& !value.includes("/")
		&& !value.includes("\\");
}

export function projectRuntimeAcknowledgedExtensions(ids: Iterable<unknown>): RuntimeAcknowledgedChildExtensions | undefined {
	const unique: string[] = [];
	const seen = new Set<string>();
	for (const id of ids) {
		if (!isRuntimeAcknowledgedExtensionId(id) || seen.has(id)) continue;
		seen.add(id);
		unique.push(id);
	}
	if (unique.length === 0) return undefined;
	return {
		version: 1,
		source: "child-runtime",
		ids: unique.slice(0, MAX_RUNTIME_ACKNOWLEDGED_EXTENSION_IDS),
		omitted: Math.max(0, unique.length - MAX_RUNTIME_ACKNOWLEDGED_EXTENSION_IDS),
	};
}

export function sanitizeRuntimeAcknowledgedExtensions(value: unknown): RuntimeAcknowledgedChildExtensions | undefined {
	if (!value || typeof value !== "object") return undefined;
	const raw = value as Record<string, unknown>;
	if (raw.version !== 1 || raw.source !== "child-runtime" || !Array.isArray(raw.ids)) return undefined;
	const projected = projectRuntimeAcknowledgedExtensions(raw.ids);
	if (!projected) return undefined;
	const omitted = typeof raw.omitted === "number" && Number.isFinite(raw.omitted)
		? Math.max(0, Math.floor(raw.omitted))
		: 0;
	return { ...projected, omitted: projected.omitted + omitted };
}
