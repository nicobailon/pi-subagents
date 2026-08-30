import { sanitizeDisplayText, truncateDisplayText } from "../shared/display-text.ts";

export const EXTERNAL_RUN_REGISTRY_VERSION = 2;
export const EXTERNAL_RUN_REGISTRY_KEY = "pi-subagents.external-runs.v2";

export const EXTERNAL_RUN_LIMITS = {
	maxCachedRuns: 100,
	maxSnapshotRuns: 20,
	maxIdentityLength: 160,
	/**
	 * A Pi session id is the session file path, which routinely exceeds a short
	 * identity budget in nested worktrees, so it is bounded like the other paths.
	 */
	maxSessionIdLength: 4_096,
	maxTextLength: 160,
	maxPreviewLength: 4_096,
	maxPathLength: 4_096,
	maxSerializedBytes: 32 * 1_024,
} as const;

export type ExternalRunState = "queued" | "running" | "completed" | "failed" | "stopped";

/** A display-only record for work owned by another extension or runtime. */
export interface ExternalRun {
	id: string;
	sessionId: string;
	source: string;
	label: string;
	state: ExternalRunState;
	startedAt: number;
	updatedAt?: number;
	endedAt?: number;
	currentAction?: string;
	preview?: string;
	reportPath?: string;
	transcriptPath?: string;
}

export type ExternalRunUpdate = Partial<Omit<ExternalRun, "id" | "sessionId" | "source">>;

export interface ExternalRunSnapshotOptions {
	onMalformedRecord?: (message: string) => void;
	ignoreMalformed?: boolean;
}

interface ExternalRunRegistry {
	version: typeof EXTERNAL_RUN_REGISTRY_VERSION;
	runs: Map<string, ExternalRun>;
}

interface TrustedExternalRunRecord {
	value: unknown;
	normalized: ExternalRun;
	keys: readonly string[];
	values: readonly unknown[];
}

const trustedRecordsByRegistry = new WeakMap<object, Map<string, TrustedExternalRunRecord>>();

const RUN_FIELD_NAMES = [
	"id",
	"sessionId",
	"source",
	"label",
	"state",
	"startedAt",
	"updatedAt",
	"endedAt",
	"currentAction",
	"preview",
	"reportPath",
	"transcriptPath",
] as const satisfies readonly (keyof ExternalRun)[];
const RUN_FIELDS = new Set<string>(RUN_FIELD_NAMES);
const UPDATE_FIELDS = new Set([...RUN_FIELDS].filter((field) => field !== "id" && field !== "sessionId" && field !== "source"));

function registry(): ExternalRunRegistry {
	const key = Symbol.for(EXTERNAL_RUN_REGISTRY_KEY);
	const target = globalThis as Record<PropertyKey, unknown>;
	const existing = target[key];
	if (existing === undefined) {
		const created: ExternalRunRegistry = { version: EXTERNAL_RUN_REGISTRY_VERSION, runs: new Map() };
		target[key] = created;
		return created;
	}
	if (!existing || typeof existing !== "object" || Array.isArray(existing)) throw new Error(`Malformed external-run registry at Symbol.for("${EXTERNAL_RUN_REGISTRY_KEY}").`);
	const candidate = existing as Partial<ExternalRunRegistry>;
	if (candidate.version !== EXTERNAL_RUN_REGISTRY_VERSION || !(candidate.runs instanceof Map)) throw new Error(`Unsupported external-run registry at Symbol.for("${EXTERNAL_RUN_REGISTRY_KEY}").`);
	return candidate as ExternalRunRegistry;
}

function trustedRecords(current: ExternalRunRegistry): Map<string, TrustedExternalRunRecord> {
	const cached = trustedRecordsByRegistry.get(current);
	if (cached) return cached;
	const records = new Map<string, TrustedExternalRunRecord>();
	trustedRecordsByRegistry.set(current, records);
	return records;
}

function inputObject(value: unknown, field: string, allowed: Set<string>): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be an object.`);
	const input = value as Record<string, unknown>;
	const unknown = Object.keys(input).filter((key) => !allowed.has(key));
	if (unknown.length) throw new Error(`${field} has unknown fields: ${unknown.join(", ")}.`);
	return input;
}

function identity(value: unknown, field: string, maxLength: number = EXTERNAL_RUN_LIMITS.maxIdentityLength): string {
	if (typeof value !== "string" || value.length === 0 || value.trim() !== value || value.includes("\0")) throw new Error(`${field} must be a non-empty trimmed string without NUL characters.`);
	if (value.length > maxLength) throw new Error(`${field} must be at most ${maxLength} characters.`);
	const safe = sanitizeDisplayText(value);
	if (!safe || safe !== value) throw new Error(`${field} must contain only display-safe text.`);
	return value;
}

function displayText(value: unknown, field: string, maxLength: number): string | undefined;
function displayText(value: unknown, field: string, maxLength: number, required: true): string;
function displayText(value: unknown, field: string, maxLength: number, required = false): string | undefined {
	if (value === undefined && !required) return undefined;
	if (typeof value !== "string" || value.length === 0) throw new Error(`${field} must be a non-empty string.`);
	const safe = sanitizeDisplayText(value.slice(0, Math.max(maxLength * 4, maxLength)));
	if (!safe) throw new Error(`${field} must contain displayable text.`);
	return truncateDisplayText(safe, maxLength);
}

function timestamp(value: unknown, field: string): number | undefined;
function timestamp(value: unknown, field: string, required: true): number;
function timestamp(value: unknown, field: string, required = false): number | undefined {
	if (value === undefined && !required) return undefined;
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 8_640_000_000_000_000) throw new Error(`${field} must be a non-negative safe timestamp.`);
	return value;
}

function state(value: unknown, field: string): ExternalRunState {
	if (value === "queued" || value === "running" || value === "completed" || value === "failed" || value === "stopped") return value;
	throw new Error(`${field} is invalid.`);
}

function validateRun(value: unknown): ExternalRun {
	const run = inputObject(value, "External run", RUN_FIELDS);
	const updatedAt = timestamp(run.updatedAt, "External run updatedAt");
	const endedAt = timestamp(run.endedAt, "External run endedAt");
	const currentAction = displayText(run.currentAction, "External run currentAction", EXTERNAL_RUN_LIMITS.maxTextLength);
	const preview = displayText(run.preview, "External run preview", EXTERNAL_RUN_LIMITS.maxPreviewLength);
	const reportPath = displayText(run.reportPath, "External run reportPath", EXTERNAL_RUN_LIMITS.maxPathLength);
	const transcriptPath = displayText(run.transcriptPath, "External run transcriptPath", EXTERNAL_RUN_LIMITS.maxPathLength);
	return {
		id: identity(run.id, "External run id"),
		sessionId: identity(run.sessionId, "External run sessionId", EXTERNAL_RUN_LIMITS.maxSessionIdLength),
		source: displayText(run.source, "External run source", EXTERNAL_RUN_LIMITS.maxTextLength, true),
		label: displayText(run.label, "External run label", EXTERNAL_RUN_LIMITS.maxTextLength, true),
		state: state(run.state, "External run state"),
		startedAt: timestamp(run.startedAt, "External run startedAt", true),
		...(updatedAt !== undefined ? { updatedAt } : {}),
		...(endedAt !== undefined ? { endedAt } : {}),
		...(currentAction ? { currentAction } : {}),
		...(preview ? { preview } : {}),
		...(reportPath ? { reportPath } : {}),
		...(transcriptPath ? { transcriptPath } : {}),
	};
}

function key(sessionId: string, id: string): string {
	return `${sessionId}\0${id}`;
}

function clone(run: ExternalRun): ExternalRun {
	return { ...run };
}

function trustedRecord(value: unknown, normalized: ExternalRun): TrustedExternalRunRecord {
	const candidate = value as ExternalRun;
	return {
		value,
		normalized,
		keys: Object.keys(candidate),
		values: RUN_FIELD_NAMES.map((field) => candidate[field]),
	};
}

function trustedRecordValue(value: unknown, record: TrustedExternalRunRecord | undefined): ExternalRun | undefined {
	if (!record || record.value !== value || !value || typeof value !== "object") return undefined;
	try {
		const candidate = value as ExternalRun;
		const keys = Object.keys(candidate);
		if (keys.length !== record.keys.length || keys.some((key, index) => key !== record.keys[index])) return undefined;
		for (const [index, field] of RUN_FIELD_NAMES.entries()) {
			if (candidate[field] !== record.values[index]) return undefined;
		}
		return record.normalized;
	} catch {
		return undefined;
	}
}

function rememberTrustedRecord(current: ExternalRunRegistry, cacheKey: string, value: unknown, normalized: ExternalRun): void {
	trustedRecords(current).set(cacheKey, trustedRecord(value, normalized));
}

function normalizeCachedRecord(current: ExternalRunRegistry, cacheKey: string, value: unknown): ExternalRun {
	const run = validateRun(value);
	rememberTrustedRecord(current, cacheKey, value, run);
	return run;
}

/** Register one current-session external job. pi-subagents never controls the job. */
export function registerExternalRun(input: ExternalRun): ExternalRun {
	const run = validateRun(input);
	const current = registry();
	const runKey = key(run.sessionId, run.id);
	if (current.runs.has(runKey)) throw new Error(`External run '${run.id}' is already registered for session '${run.sessionId}'.`);
	if (current.runs.size >= EXTERNAL_RUN_LIMITS.maxCachedRuns) throw new Error(`External-run registry supports at most ${EXTERNAL_RUN_LIMITS.maxCachedRuns} cached runs.`);
	current.runs.set(runKey, run);
	rememberTrustedRecord(current, runKey, run, run);
	return clone(run);
}

/** Update display fields for a registered external job without changing its identity or owner. */
export function updateExternalRun(sessionId: string, id: string, update: ExternalRunUpdate): ExternalRun {
	const safeSessionId = identity(sessionId, "External run sessionId", EXTERNAL_RUN_LIMITS.maxSessionIdLength);
	const safeId = identity(id, "External run id");
	const patch = inputObject(update, "External run update", UPDATE_FIELDS);
	const current = registry();
	const runKey = key(safeSessionId, safeId);
	const previous = current.runs.get(runKey);
	if (!previous) throw new Error(`External run '${safeId}' is not registered for session '${safeSessionId}'.`);
	const next = validateRun({ ...previous, ...patch });
	current.runs.set(runKey, next);
	rememberTrustedRecord(current, runKey, next, next);
	return clone(next);
}

/** Remove a cached external job. The caller remains responsible for its process and artifacts. */
export function unregisterExternalRun(sessionId: string, id: string): boolean {
	const current = registry();
	const runKey = key(identity(sessionId, "External run sessionId", EXTERNAL_RUN_LIMITS.maxSessionIdLength), identity(id, "External run id"));
	const deleted = current.runs.delete(runKey);
	if (deleted) trustedRecords(current).delete(runKey);
	return deleted;
}

function snapshotBytes(runs: readonly ExternalRun[]): number {
	return Buffer.byteLength(JSON.stringify(runs), "utf8");
}

function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Read a bounded cached snapshot for one Pi session. This never invokes third-party code. */
export function snapshotExternalRuns(sessionId: string, options: ExternalRunSnapshotOptions = {}): readonly ExternalRun[] {
	const safeSessionId = identity(sessionId, "External-run snapshot sessionId", EXTERNAL_RUN_LIMITS.maxSessionIdLength);
	const current = registry();
	const trusted = trustedRecords(current);
	const sessionPrefix = `${safeSessionId}\0`;
	const runs: ExternalRun[] = [];
	for (const [cacheKey, value] of current.runs.entries()) {
		if (typeof cacheKey !== "string" || !cacheKey.startsWith(sessionPrefix)) continue;
		try {
			const run = trustedRecordValue(value, trusted.get(cacheKey)) ?? normalizeCachedRecord(current, cacheKey, value);
			if (run.sessionId === safeSessionId) runs.push(run);
		} catch (error) {
			const message = `Malformed cached external run '${cacheKey}': ${getErrorMessage(error)}`;
			if (!options.ignoreMalformed) throw new Error(message, { cause: error instanceof Error ? error : undefined });
			current.runs.delete(cacheKey);
			trusted.delete(cacheKey);
			options.onMalformedRecord?.(message);
		}
	}
	runs.sort((left, right) => {
		const leftActive = left.state === "queued" || left.state === "running";
		const rightActive = right.state === "queued" || right.state === "running";
		if (leftActive !== rightActive) return leftActive ? -1 : 1;
		return (right.updatedAt ?? right.endedAt ?? right.startedAt) - (left.updatedAt ?? left.endedAt ?? left.startedAt) || left.id.localeCompare(right.id);
	});
	const snapshot = runs.slice(0, EXTERNAL_RUN_LIMITS.maxSnapshotRuns).map(clone);
	while (snapshot.length > 0 && snapshotBytes(snapshot) > EXTERNAL_RUN_LIMITS.maxSerializedBytes) snapshot.pop();
	return snapshot;
}

/** Alias for callers that prefer list terminology. */
export const listExternalRuns = snapshotExternalRuns;
