import type { WorkflowPreflightLaneV1, WorkflowPreflightV1 } from "../shared/types.ts";

export const WORKFLOW_PREFLIGHT_VERSION = 1 as const;
export const WORKFLOW_PREFLIGHT_MAX_LANES = 64;
export const WORKFLOW_PREFLIGHT_MAX_STRING_LENGTH = 256;
export const WORKFLOW_PREFLIGHT_MAX_CLAIMS = 16;
export const WORKFLOW_PREFLIGHT_MAX_DEPTH = 3;
export const WORKFLOW_PREFLIGHT_MAX_BYTES = 16 * 1024;
export const WORKFLOW_PREFLIGHT_MAX_WARNINGS = 16;

const WORKFLOW_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const PREFLIGHT_FIELDS = new Set(["version", "coverage", "lanes"]);
const LANE_FIELDS = new Set(["key", "mode", "decision", "claims", "expectedOutput", "independence"]);
const PREFLIGHT_MODES = new Set<WorkflowPreflightLaneV1["mode"]>(["mutation", "review", "scout", "gate"]);

type WorkflowTraceLike = {
	operation: string;
	key: string;
	phase?: string;
	generatedLaneKey?: string;
	warning?: string;
};

export interface WorkflowPreflightValidationResult {
	ok: boolean;
	preflight?: WorkflowPreflightV1;
	error?: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function assertPlainObject(value: unknown, path: string): asserts value is Record<string, unknown> {
	if (!isPlainObject(value)) throw new Error(`${path} must be a plain JSON object.`);
	if (Object.getOwnPropertySymbols(value).length > 0) throw new Error(`${path} must not contain symbol keys.`);
	for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
		if (!descriptor.enumerable || !("value" in descriptor)) throw new Error(`${path}.${key} must be an enumerable data property.`);
	}
}

function assertKnownFields(value: Record<string, unknown>, allowed: ReadonlySet<string>, path: string): void {
	for (const key of Object.keys(value)) {
		if (!allowed.has(key)) throw new Error(`${path} contains unsupported field '${key}'.`);
	}
}

function normalizeDisplayString(value: unknown, path: string): string {
	if (typeof value !== "string") throw new Error(`${path} must be a string.`);
	const normalized = value
		.replace(/[\u0000-\u001f\u007f]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	if (!normalized) throw new Error(`${path} must be a non-empty string.`);
	if (normalized.length > WORKFLOW_PREFLIGHT_MAX_STRING_LENGTH) {
		throw new Error(`${path} exceeds the maximum length of ${WORKFLOW_PREFLIGHT_MAX_STRING_LENGTH}.`);
	}
	return normalized;
}

function normalizeLane(value: unknown, index: number): WorkflowPreflightLaneV1 {
	const path = `preflight.lanes[${index}]`;
	assertPlainObject(value, path);
	assertKnownFields(value, LANE_FIELDS, path);
	const key = normalizeDisplayString(value.key, `${path}.key`);
	if (!WORKFLOW_KEY_PATTERN.test(key)) throw new Error(`${path}.key must be 1-128 characters using letters, numbers, '.', '_' or '-', and start with a letter or number.`);
	let mode: WorkflowPreflightLaneV1["mode"];
	if (value.mode !== undefined) {
		if (typeof value.mode !== "string" || !PREFLIGHT_MODES.has(value.mode as WorkflowPreflightLaneV1["mode"])) {
			throw new Error(`${path}.mode must be one of: mutation, review, scout, gate.`);
		}
		mode = value.mode as WorkflowPreflightLaneV1["mode"];
	}
	let claims: string[] | undefined;
	if (value.claims !== undefined) {
		if (!Array.isArray(value.claims)) throw new Error(`${path}.claims must be an array of strings.`);
		if (value.claims.length > WORKFLOW_PREFLIGHT_MAX_CLAIMS) throw new Error(`${path}.claims supports at most ${WORKFLOW_PREFLIGHT_MAX_CLAIMS} entries.`);
		claims = value.claims.map((claim, claimIndex) => normalizeDisplayString(claim, `${path}.claims[${claimIndex}]`));
		for (let claimIndex = 0; claimIndex < value.claims.length; claimIndex += 1) {
			if (!Object.prototype.hasOwnProperty.call(value.claims, claimIndex)) throw new Error(`${path}.claims must not contain sparse arrays.`);
		}
	}
	return {
		key,
		...(mode ? { mode } : {}),
		...(value.decision !== undefined ? { decision: normalizeDisplayString(value.decision, `${path}.decision`) } : {}),
		...(claims ? { claims } : {}),
		...(value.expectedOutput !== undefined ? { expectedOutput: normalizeDisplayString(value.expectedOutput, `${path}.expectedOutput`) } : {}),
		...(value.independence !== undefined ? { independence: normalizeDisplayString(value.independence, `${path}.independence`) } : {}),
	};
}

/**
 * Validate and canonicalize the explicit preflight input. This is intentionally
 * independent of workflowScript parsing: callers may describe dynamic fanout
 * without making the metadata a second execution graph.
 */
export function normalizeWorkflowPreflight(input: unknown): WorkflowPreflightV1 | undefined {
	if (input === undefined) return undefined;
	assertPlainObject(input, "preflight");
	assertKnownFields(input, PREFLIGHT_FIELDS, "preflight");
	if (input.version !== WORKFLOW_PREFLIGHT_VERSION) throw new Error(`preflight.version must be ${WORKFLOW_PREFLIGHT_VERSION}.`);
	const coverage = input.coverage === undefined ? "partial" : input.coverage;
	if (coverage !== "complete" && coverage !== "partial") throw new Error("preflight.coverage must be 'complete' or 'partial'.");
	if (!Array.isArray(input.lanes)) throw new Error("preflight.lanes must be an array.");
	if (input.lanes.length > WORKFLOW_PREFLIGHT_MAX_LANES) throw new Error(`preflight.lanes supports at most ${WORKFLOW_PREFLIGHT_MAX_LANES} lanes.`);
	for (let index = 0; index < input.lanes.length; index += 1) {
		if (!Object.prototype.hasOwnProperty.call(input.lanes, index)) throw new Error("preflight.lanes must not contain sparse arrays.");
	}
	const lanes = input.lanes.map(normalizeLane);
	const seenKeys = new Set<string>();
	for (const lane of lanes) {
		if (seenKeys.has(lane.key)) throw new Error(`preflight.lanes contains duplicate key '${lane.key}'.`);
		seenKeys.add(lane.key);
	}
	const normalized = { version: WORKFLOW_PREFLIGHT_VERSION, coverage, lanes } satisfies WorkflowPreflightV1;
	const depth = 1 + (lanes.length > 0 ? 1 : 0) + (lanes.some((lane) => lane.claims !== undefined) ? 1 : 0);
	if (depth > WORKFLOW_PREFLIGHT_MAX_DEPTH) throw new Error(`preflight exceeds the maximum nesting depth of ${WORKFLOW_PREFLIGHT_MAX_DEPTH}.`);
	const bytes = Buffer.byteLength(JSON.stringify(normalized), "utf8");
	if (bytes > WORKFLOW_PREFLIGHT_MAX_BYTES) throw new Error(`preflight canonical JSON is ${bytes} bytes; maximum is ${WORKFLOW_PREFLIGHT_MAX_BYTES}.`);
	return normalized;
}

export function validateWorkflowPreflight(input: unknown): WorkflowPreflightValidationResult {
	try {
		const preflight = normalizeWorkflowPreflight(input);
		return { ok: true, ...(preflight ? { preflight } : {}) };
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}

function warningLimit(messages: string[]): string[] {
	if (messages.length <= WORKFLOW_PREFLIGHT_MAX_WARNINGS) return messages;
	const omitted = messages.length - WORKFLOW_PREFLIGHT_MAX_WARNINGS + 1;
	return [...messages.slice(0, WORKFLOW_PREFLIGHT_MAX_WARNINGS - 1), `Preflight advisory: ${omitted} additional mismatch warning(s) omitted.`];
}

function declaredKeys(preflight: WorkflowPreflightV1): Set<string> {
	return new Set(preflight.lanes.map((lane) => lane.key));
}

/**
 * Treat declared lane keys as plan roots: `lane` is the lane itself and
 * `lane.stage` is a stage by convention, even without generated provenance.
 */
function declaredLaneCoversWorkflowKey(entry: WorkflowTraceLike, laneKey: string): boolean {
	return entry.key === laneKey || entry.key.startsWith(`${laneKey}.`);
}

function keyCoveredByDeclaredLane(entry: WorkflowTraceLike, declared: ReadonlySet<string>): boolean {
	for (const laneKey of declared) if (declaredLaneCoversWorkflowKey(entry, laneKey)) return true;
	return false;
}

function launchedEntries(trace: readonly WorkflowTraceLike[]): WorkflowTraceLike[] {
	const entries: WorkflowTraceLike[] = [];
	const seen = new Set<string>();
	for (const entry of trace) {
		if (entry.operation !== "run" || entry.phase === "auto-resume" || seen.has(entry.key)) continue;
		seen.add(entry.key);
		entries.push(entry);
	}
	return entries;
}

function undeclaredWarning(key: string): string {
	return `Preflight advisory: workflow key '${key}' launched without a declared lane.`;
}

function unlaunchedWarning(key: string): string {
	return `Preflight advisory: declared lane '${key}' was not launched.`;
}

/** Return bounded advisory mismatch warnings; these never reject a child launch. */
export function workflowPreflightWarnings(
	preflight: WorkflowPreflightV1 | undefined,
	trace: readonly WorkflowTraceLike[],
	options: { settled?: boolean } = {},
): string[] {
	if (!preflight) return [];
	const declared = declaredKeys(preflight);
	const launched = launchedEntries(trace);
	const messages = launched.filter((entry) => !keyCoveredByDeclaredLane(entry, declared)).map((entry) => undeclaredWarning(entry.key));
	if (options.settled === true) {
		for (const lane of preflight.lanes) if (!launched.some((entry) => declaredLaneCoversWorkflowKey(entry, lane.key))) messages.push(unlaunchedWarning(lane.key));
	}
	return warningLimit(messages);
}

/** Attach the first undeclared-key warning to its first trace row for status/debug views. */
export function annotateWorkflowPreflightTrace<T extends WorkflowTraceLike>(trace: readonly T[], preflight: WorkflowPreflightV1 | undefined): T[] {
	if (!preflight) return [...trace];
	const declared = declaredKeys(preflight);
	const warned = new Set<string>();
	return trace.map((entry) => {
		if (entry.operation !== "run" || entry.phase === "auto-resume" || keyCoveredByDeclaredLane(entry, declared) || warned.has(entry.key)) return entry;
		warned.add(entry.key);
		return { ...entry, warning: entry.warning ?? undeclaredWarning(entry.key) };
	});
}

function laneCell(value: string | undefined): string {
	return value ?? "—";
}

const WORKFLOW_PREFLIGHT_PLAN_LABEL_LENGTH = 96;

function planLaneLabel(lane: WorkflowPreflightLaneV1): string {
	const value = lane.decision?.trim() || lane.key;
	if (value.length <= WORKFLOW_PREFLIGHT_PLAN_LABEL_LENGTH) return value;
	return `${value.slice(0, WORKFLOW_PREFLIGHT_PLAN_LABEL_LENGTH - 1).trimEnd()}…`;
}

/** Render the detailed bounded table reserved for tool output and expanded/debug views. */
export function formatWorkflowPreflight(preflight: WorkflowPreflightV1 | undefined, options: { indent?: string } = {}): string {
	if (!preflight) return "";
	const indent = options.indent ?? "";
	const count = preflight.lanes.length;
	const lines = [
		`${indent}Preflight: v${preflight.version} · ${preflight.coverage} · ${count} lane${count === 1 ? "" : "s"}`,
		`${indent}  key | mode | decision | claims | expected output | independence`,
	];
	for (const lane of preflight.lanes) {
		lines.push(`${indent}  ${[
			lane.key,
			laneCell(lane.mode),
			laneCell(lane.decision),
			lane.claims?.join(", ") ?? "—",
			laneCell(lane.expectedOutput),
			laneCell(lane.independence),
		].join(" | ")}`);
	}
	return lines.join("\n");
}

export function formatWorkflowPreflightSummary(preflight: WorkflowPreflightV1 | undefined): string {
	if (!preflight) return "";
	const keys = preflight.lanes.slice(0, 4).map((lane) => lane.key).join(", ");
	const remainder = preflight.lanes.length > 4 ? `, +${preflight.lanes.length - 4}` : "";
	return `preflight · ${preflight.coverage} · ${preflight.lanes.length} lane${preflight.lanes.length === 1 ? "" : "s"}${keys ? `: ${keys}${remainder}` : ""}`;
}

/** Render the operator-facing one-line plan shown in routine status views. */
export function formatWorkflowPreflightPlanSummary(preflight: WorkflowPreflightV1 | undefined, options: { indent?: string } = {}): string {
	if (!preflight) return "";
	const indent = options.indent ?? "";
	const count = preflight.lanes.length;
	const labels = count === 1
		? planLaneLabel(preflight.lanes[0]!)
		: preflight.lanes.slice(0, 4).map((lane) => lane.key).join(", ") + (count > 4 ? `, +${count - 4}` : "");
	return `${indent}Plan: ${count} lane${count === 1 ? "" : "s"}${labels ? ` · ${labels}` : ""}`;
}

/** Render a bounded, non-alarming warning for routine status views. */
export function formatWorkflowPreflightWarningSummary(warnings: readonly string[] | undefined, options: { indent?: string; hint?: string } = {}): string {
	if (!warnings?.length) return "";
	const indent = options.indent ?? "";
	const hint = options.hint ?? "details available for debug";
	const count = warnings.length;
	return `${indent}Plan note: ${count} preflight mismatch${count === 1 ? "" : "es"} · ${hint}.`;
}

export function formatWorkflowPreflightWarnings(warnings: readonly string[] | undefined, options: { indent?: string } = {}): string {
	if (!warnings?.length) return "";
	const indent = options.indent ?? "";
	return [`${indent}Preflight warnings:`, ...warnings.map((warning) => `${indent}  - ${warning.replace(/\s+/g, " ").trim()}`)].join("\n");
}
