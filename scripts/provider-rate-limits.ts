#!/usr/bin/env node
/**
 * Agent-friendly editor for bundled provider-rate-limits.csv.
 *
 * This is the canonical in-repo replacement for the legacy Python editor.
 * The Python script remains in provider-models-builder for reference only.
 */

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";

// ---------------------------------------------------------------------------
// Constants / schema
// ---------------------------------------------------------------------------

const SCRIPT_DIR = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1/"));
const DEFAULT_CSV = path.join(SCRIPT_DIR, "..", "assets", "provider-rate-limits.csv");

const NUMERIC_COLUMNS = [
	"con_max",
	"rps_max",
	"tps_max",
	"rpm_max",
	"tpm_max",
	"rph_max",
	"tph_max",
	"rpd_max",
	"tpd_max",
	"asm_max",
	"ash_max",
	"asd_max",
	"ppm_max",
	"npd_max",
] as const;

const ISO_DATE_COLUMNS = [
	"effective_start",
	"effective_end",
	"last_verified",
] as const;

const CANONICAL_HEADERS = [
	"provider",
	"rate_type",
	"tier_rule",
	"scope",
	"scope_mode",
	"endpoint",
	"limit_mode",
	"target",
	"usage_profile",
	"credit_type",
	"credit_value",
	"credit_period_days",
	"credit_renew",
	"effective_start",
	"effective_end",
	"last_verified",
	"con_max",
	"rps_max",
	"tps_max",
	"rpm_max",
	"tpm_max",
	"rph_max",
	"tph_max",
	"rpd_max",
	"tpd_max",
	"asm_max",
	"ash_max",
	"asd_max",
	"ppm_max",
	"npd_max",
	"source_url",
	"retry_after_hint",
	"notes",
] as const;

const ALLOWED_SCOPES = new Set(["provider", "family", "model"]);
const ALLOWED_RATE_TYPES = new Set(["", "free", "paid", "anon"]);
const ALLOWED_CREDIT_TYPES = new Set(["", "usd", "token", "second", "request"]);
const ALLOWED_SCOPE_MODES = new Set(["", "per_key", "per_org", "per_user", "per_project"]);
const ALLOWED_LIMIT_MODES = new Set(["", "hard", "soft", "adaptive", "unknown"]);
const ALLOWED_TIER_RULES = new Set(["", "tier_0", "tier_1", "tier_2", "tier_3", "tier_4", "tier_5"]);
const ALLOWED_USAGE_PROFILES = new Set([
	"",
	"default",
	"chat",
	"tool_use",
	"map_grounding",
	"agents",
	"text_out",
	"embedding",
	"rerank",
	"image",
	"audio",
	"code",
	"vision",
	"custom",
]);
const REQUIRED_FIELDS = ["provider", "scope", "target"] as const;

const UNIQUE_KEY_FIELDS = [
	"provider",
	"scope",
	"target",
	"rate_type",
	"endpoint",
	"scope_mode",
	"usage_profile",
	"effective_start",
	"effective_end",
	"tier_rule",
] as const;

const TIER_RULE_CANONICAL: Record<string, string> = {
	tier_0: "tier_0",
	tier0: "tier_0",
	"tier 0": "tier_0",
	tier_1: "tier_1",
	tier1: "tier_1",
	"tier 1": "tier_1",
	tier_2: "tier_2",
	tier2: "tier_2",
	"tier 2": "tier_2",
	"tier 3": "tier_3",
	"tier 4": "tier_4",
	"tier 5": "tier_5",
	default: "",
};

const CREDIT_RENEW_ALLOWED = new Set(["", "true", "false"]);
const CREDIT_RENEW_CANONICAL: Record<string, string> = {
	true: "true",
	false: "false",
	TRUE: "true",
	FALSE: "false",
	1: "true",
	0: "false",
};
const SCOPE_MODE_CANONICAL: Record<string, string> = {
	per_key: "per_key",
	per_org: "per_org",
	per_user: "per_user",
	per_project: "per_project",
	PER_KEY: "per_key",
	PER_ORG: "per_org",
	PER_USER: "per_user",
	PER_PROJECT: "per_project",
};
const LIMIT_MODE_CANONICAL: Record<string, string> = {
	hard: "hard",
	soft: "soft",
	adaptive: "adaptive",
	unknown: "unknown",
	HARD: "hard",
	SOFT: "soft",
	ADAPTIVE: "adaptive",
	UNKNOWN: "unknown",
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Row = Record<(typeof CANONICAL_HEADERS)[number], string>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toPath(file: string) {
	return path.isAbsolute(file) ? file : path.resolve(process.cwd(), file);
}

function nowIso() {
	const d = new Date();
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function parseIsoDate(value: string, fieldName = "date") {
	const trimmed = (value ?? "").trim();
	if (!trimmed) return "";
	const m = trimmed.match(/^(\d{4}-\d{2}-\d{2})/);
	if (!m) throw new Error(`${fieldName.replace(/_/g, " ")} must be ISO format YYYY-MM-DD; invalid value=${JSON.stringify(trimmed)}`);
	return m[1];
}

function canonical(value: string, mapping: Record<string, string>) {
	const trimmed = (value ?? "").trim();
	if (!trimmed) return "";
	return mapping[trimmed] ?? trimmed;
}

function numeric(value: string, fieldName: string) {
	const trimmed = (value ?? "").trim();
	if (!trimmed) return "";
	const normalized = trimmed.replace(/,/g, "");
	if (normalized.toLowerCase() === "unlimited") return "-1";
	if (normalized === "-1" || /^-?\d+(?:\.\d+)?$/.test(normalized)) return normalized;
	throw new Error(`${fieldName.replace(/_/g, " ")} must be a number or '-1', got: ${JSON.stringify(trimmed)}`);
}

function keyFromRow(row: Row) {
	return UNIQUE_KEY_FIELDS.map((field) => (row[field] ?? "").trim()) as unknown as tuple;
}

type tuple = [string, string, string, string, string, string, string, string, string, string];

function rowMatchKey(row: Row, strict = false) {
	const key: Record<string, string> = {};
	for (const field of UNIQUE_KEY_FIELDS) {
		const value = (row[field] ?? "").trim();
		if (strict || value) key[field] = value;
	}
	return key;
}

function cleanRow(row: Row) {
	const cleaned: Row = { ...row };
	for (const col of NUMERIC_COLUMNS) cleaned[col] = numeric(cleaned[col], col);
	for (const col of ISO_DATE_COLUMNS) cleaned[col] = parseIsoDate(cleaned[col], col);
	cleaned.credit_renew = canonical(cleaned.credit_renew, CREDIT_RENEW_CANONICAL);
	cleaned.scope_mode = canonical(cleaned.scope_mode, SCOPE_MODE_CANONICAL);
	cleaned.limit_mode = canonical(cleaned.limit_mode, LIMIT_MODE_CANONICAL);
	cleaned.tier_rule = canonical(cleaned.tier_rule, TIER_RULE_CANONICAL);
	return cleaned;
}

function validateRow(row: Row) {
	const errors: string[] = [];
	for (const field of REQUIRED_FIELDS) if (!(row[field] ?? "").trim()) errors.push(`${field.replace(/_/g, " ")} is required`);
	if (!ALLOWED_SCOPES.has((row.scope ?? "").trim()))
		errors.push(`scope must be one of ${[...ALLOWED_SCOPES].filter(Boolean).sort()}, got: ${JSON.stringify(row.scope)}`);
	if ((row.scope ?? "").trim() === "provider" && (row.target ?? "").trim() !== "*")
		errors.push("provider-scope rows should use target='*'");
	if (row.credit_type && !ALLOWED_CREDIT_TYPES.has((row.credit_type ?? "").trim()))
		errors.push(`credit type must be one of ${[...ALLOWED_CREDIT_TYPES].filter(Boolean).sort()}, got: ${JSON.stringify(row.credit_type)}`);
	if (row.credit_renew && !CREDIT_RENEW_ALLOWED.has((row.credit_renew ?? "").trim()))
		errors.push(`credit renew must be true/false, got: ${JSON.stringify(row.credit_renew)}`);
	if (row.rate_type && !ALLOWED_RATE_TYPES.has((row.rate_type ?? "").trim()))
		errors.push(`rate type must be one of ${[...ALLOWED_RATE_TYPES].filter(Boolean).sort()}, or blank, got: ${JSON.stringify(row.rate_type)}`);
	if (row.scope_mode && !ALLOWED_SCOPE_MODES.has((row.scope_mode ?? "").trim()))
		errors.push(`scope mode must be one of ${[...ALLOWED_SCOPE_MODES].filter(Boolean).sort()}, got: ${JSON.stringify(row.scope_mode)}`);
	if (row.limit_mode && !ALLOWED_LIMIT_MODES.has((row.limit_mode ?? "").trim()))
		errors.push(`limit mode must be one of ${[...ALLOWED_LIMIT_MODES].filter(Boolean).sort()}, got: ${JSON.stringify(row.limit_mode)}`);
	if (row.tier_rule && !ALLOWED_TIER_RULES.has((row.tier_rule ?? "").trim()))
		errors.push(`tier rule must be blank or one of ${[...ALLOWED_TIER_RULES].filter(Boolean).sort()}, got: ${JSON.stringify(row.tier_rule)}`);
	if (row.usage_profile && !ALLOWED_USAGE_PROFILES.has((row.usage_profile ?? "").trim()))
		errors.push(`usage profile must be one of ${[...ALLOWED_USAGE_PROFILES].filter(Boolean).sort()}, got: ${JSON.stringify(row.usage_profile)}`);
	for (const col of NUMERIC_COLUMNS) {
		try {
			numeric(row[col], col);
		} catch (error) {
			errors.push((error as Error).message);
			break;
		}
	}
	return errors;
}

function hierarchyRank(scope: string) {
	return [...ALLOWED_SCOPES].filter(Boolean).indexOf((scope ?? "").trim());
}

// ---------------------------------------------------------------------------
// CSV I/O
// ---------------------------------------------------------------------------

function parseCsvLine(line: string) {
	const values: string[] = [];
	let current = "";
	let inQuotes = false;
	for (let i = 0; i < line.length; i++) {
		const ch = line[i];
		if (inQuotes) {
			if (ch === '"') {
				if (line[i + 1] === '"') { current += '"'; i++; }
				else inQuotes = false;
			} else current += ch;
		} else if (ch === '"') {
			inQuotes = true;
		} else if (ch === ",") {
			values.push(current);
			current = "";
		} else current += ch;
	}
	values.push(current);
	return values;
}

function loadCsv(csvPath: string) {
	if (!fs.existsSync(csvPath)) return { rows: [] as Row[], headers: [...CANONICAL_HEADERS] };
	const content = fs.readFileSync(csvPath, "utf8");
	const lines = content.split(/\r?\n/).filter((line) => line.trim().length > 0);
	if (lines.length === 0) return { rows: [] as Row[], headers: [...CANONICAL_HEADERS] };
	const rawHeaders = parseCsvLine(lines[0]).map((h) => h.trim());
	if (!CANONICAL_HEADERS.every((header) => rawHeaders.includes(header))) {
		const missing = CANONICAL_HEADERS.filter((header) => !rawHeaders.includes(header));
		throw new Error(`CSV is missing required headers: ${missing.join(", ")}. Expected: ${CANONICAL_HEADERS.join(", ")}`);
	}
	const rows: Row[] = [];
	for (let i = 1; i < lines.length; i++) {
		const values = parseCsvLine(lines[i]);
		const row: Row = {} as Row;
		for (let h = 0; h < rawHeaders.length && h < values.length; h++) row[rawHeaders[h] as (typeof CANONICAL_HEADERS)[number]] = values[h].trim();
		for (let h = values.length; h < rawHeaders.length; h++) row[rawHeaders[h] as (typeof CANONICAL_HEADERS)[number]] = "";
		rows.push(row);
	}
	return { rows, headers: rawHeaders as (typeof CANONICAL_HEADERS)[] };
}

function writeCsv(csvPath: string, rows: Row[]) {
	const tmpPath = `${csvPath}.tmp-${Date.now()}`;
	const content = [CANONICAL_HEADERS.join(","), ...rows.map((row) => CANONICAL_HEADERS.map((header) => JSON.stringify(row[header] ?? "")).join(","))].join("\n") + "\n";
	fs.writeFileSync(tmpPath, content, "utf8");
	fs.renameSync(tmpPath, csvPath);
}

function writeAuditRow(auditDir: string | undefined, event: string, payload: Record<string, unknown>) {
	if (!auditDir) return;
	fs.mkdirSync(auditDir, { recursive: true });
	const sidecar = path.join(auditDir, `provider-rate-limits.audit.csv`);
	const header = ["event", "timestamp", ...Object.keys(payload)];
	const writeHeader = !fs.existsSync(sidecar);
	const line = [event, nowIso(), ...Object.values(payload).map((value) => JSON.stringify(value ?? ""))].join(",") + "\n";
	if (writeHeader) fs.writeFileSync(sidecar, header.join(",") + "\n", "utf8");
	fs.appendFileSync(sidecar, line, "utf8");
}

function writeAuditJson(auditDir: string | undefined, event: string, payload: Record<string, unknown>) {
	if (!auditDir) return;
	fs.mkdirSync(auditDir, { recursive: true });
	const sidecar = path.join(auditDir, `provider-rate-limits.audit.jsonl`);
	const record = { event, timestamp: nowIso(), ...payload };
	fs.appendFileSync(sidecar, JSON.stringify(record) + "\n", "utf8");
}

function auditEvent(auditDir: string | undefined, event: string, payload: Record<string, unknown>, auditFormat?: string) {
	const fmt = (auditFormat ?? "csv").toLowerCase();
	if (fmt === "json") return writeAuditJson(auditDir, event, payload);
	return writeAuditRow(auditDir, event, payload);
}

// ---------------------------------------------------------------------------
// Public read API intended for selection code
// ---------------------------------------------------------------------------

export type RateLimitRow = {
	readonly provider: string;
	readonly scope: string;
	readonly target: string;
	readonly rateType: string;
	readonly endpoint: string;
	readonly scopeMode: string;
	readonly limitMode: string;
	readonly usageProfile: string;
	readonly tierRule: string;
	readonly effectiveStart: string;
	readonly effectiveEnd: string;
	readonly rpmMax: string;
	readonly tpmMax: string;
	readonly conMax: string;
	readonly retryAfterHint: string;
};

export type RateLimitSnapshot = ReadonlyArray<RateLimitRow>;

export function loadSnapshot(csvPath = DEFAULT_CSV): RateLimitSnapshot {
	if (!fs.existsSync(path.resolve(csvPath))) return [];
	const { rows } = loadCsv(path.resolve(csvPath));
	return rows.map((row) => ({
		provider: row.provider ?? "",
		scope: row.scope ?? "",
		target: row.target ?? "",
		rateType: row.rate_type ?? "",
		endpoint: row.endpoint ?? "",
		scopeMode: row.scope_mode ?? "",
		limitMode: row.limit_mode ?? "",
		usageProfile: row.usage_profile ?? "",
		tierRule: row.tier_rule ?? "",
		effectiveStart: row.effective_start ?? "",
		effectiveEnd: row.effective_end ?? "",
		rpmMax: row.rpm_max ?? "",
		tpmMax: row.tpm_max ?? "",
		conMax: row.con_max ?? "",
		retryAfterHint: row.retry_after_hint ?? "",
	}));
}

export function findApplicableRows(snapshot: RateLimitSnapshot, filters: {
	provider: string;
	scope?: string;
	target?: string;
	rateType?: string;
	endpoint?: string;
	scopeMode?: string;
	usageProfile?: string;
	tierRule?: string;
	now?: string;
}) {
	const lowerProvider = (filters.provider ?? "").trim().toLowerCase();
	const now = filters.now ?? nowIso();
	return snapshot.filter((row) => {
		if (!row.provider || row.provider.toLowerCase() !== lowerProvider) return false;
		if (filters.scope && row.scope !== filters.scope) return false;
		if (filters.target && row.target !== filters.target) return false;
		if (filters.rateType && row.rateType !== filters.rateType) return false;
		if (filters.endpoint && row.endpoint !== filters.endpoint) return false;
		if (filters.scopeMode && row.scopeMode !== filters.scopeMode) return false;
		if (filters.usageProfile && row.usageProfile !== filters.usageProfile) return false;
		if (filters.tierRule && row.tierRule !== filters.tierRule) return false;
		if (row.effectiveStart && now < row.effectiveStart) return false;
		if (row.effectiveEnd && now > row.effectiveEnd) return false;
		return true;
	});
}

export function hasQuotaHint(snapshot: RateLimitSnapshot, provider: string) {
	return findApplicableRows(snapshot, { provider }).length > 0;
}

// ---------------------------------------------------------------------------
// Validation / dedupe / search
// ---------------------------------------------------------------------------

export function validateCsv(csvPath = DEFAULT_CSV) {
	const resolved = path.resolve(csvPath);
	if (!fs.existsSync(resolved)) {
		return { valid: true, rowCount: 0, issues: [] };
	}
	const { rows } = loadCsv(resolved);
	const issues: Array<{ row: number; provider: string; scope: string; target: string; errors: string[] }> = [];
	for (let i = 0; i < rows.length; i++) {
		const cleaned = cleanRow(rows[i]);
		const errors = validateRow(cleaned);
		if (errors.length) {
			issues.push({ row: i + 2, provider: cleaned.provider, scope: cleaned.scope, target: cleaned.target, errors });
		}
	}
	const duplicateGroups = findDuplicateKeys(resolved);
	if (duplicateGroups.length) {
		issues.push({ row: 0, provider: "", scope: "", target: "", errors: [`Duplicate key(s): ${duplicateGroups.length} group(s)`] });
	}
	return { valid: issues.length === 0, rowCount: rows.length, issues };
}

export function findDuplicateKeys(csvPath = DEFAULT_CSV) {
	const resolved = path.resolve(csvPath);
	if (!fs.existsSync(resolved)) return [];
	const { rows } = loadCsv(resolved);
	const counts = new Map<string, number>();
	for (const row of rows) {
		const key = keyFromRow(row).join("|");
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	return [...counts.entries()].filter(([, count]) => count > 1).map(([key, count]) => [key, count] as [string, number]);
}

export function searchRows(query = "", filters: Record<string, string> = {}, strict = false, csvPath = DEFAULT_CSV) {
	const { rows } = loadCsv(path.resolve(csvPath));
	const q = (query ?? "").trim().toLowerCase();
	const fields = ["provider", "scope", "target", "notes", "source_url", "tier_rule"];
	const matches: Row[] = [];
	for (const row of rows) {
		let ok = true;
		for (const [key, value] of Object.entries(filters)) {
			const cell = (row[key as keyof Row] ?? "").trim();
			if (strict ? cell !== value : cell.toLowerCase() !== value.toLowerCase()) {
				ok = false;
				break;
			}
		}
		if (!ok) continue;
		if (q && !fields.some((field) => ((row[field as keyof Row] ?? "") as string).toLowerCase().includes(q))) continue;
		matches.push(row);
	}
	return matches;
}

export function listProviders(csvPath = DEFAULT_CSV) {
	const { rows } = loadCsv(path.resolve(csvPath));
	return [...new Set(rows.map((row) => row.provider).filter((provider): provider is string => Boolean(provider)))].sort();
}

function matchIndex(rows: Row[], key: Record<string, string>) {
	const matches: number[] = [];
	for (let i = 0; i < rows.length; i++) {
		if (Object.entries(key).every(([k, v]) => (rows[i][k as keyof Row] ?? "").trim() === v)) {
			matches.push(i);
		}
	}
	return matches;
}

function partialKey(row: Row, strict = false) {
	const key: Record<string, string> = {};
	for (const field of UNIQUE_KEY_FIELDS) {
		const value = (row[field] ?? "").trim();
		if (strict || value) key[field] = value;
	}
	return key;
}

function keyEquals(a: Record<string, string>, b: Record<string, string>) {
	const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
	return [...keys].every((key) => (a[key] ?? "") === (b[key] ?? ""));
}

function checkNaturalKeyDuplicates(rows: Row[], exactFilters: Record<string, string>, strict: boolean) {
	const filtered = rows.map((row) => {
		const base: Record<string, string> = {};
		for (const [key, value] of Object.entries(exactFilters)) {
			const field = key.replace("-", "_");
			base[field] = (value ?? "").trim();
		}
		return { row, key: partialKey({ ...base, ...row }, strict) };
	});
	const groups = new Map<string, Array<{ row: Row; key: Record<string, string> }>>();
	for (const item of filtered) {
		const serialized = JSON.stringify(item.key);
		const group = groups.get(serialized) ?? [];
		group.push(item);
		groups.set(serialized, group);
	}
	const conflicts: Array<{ rows: Row[]; message: string }> = [];
	for (const group of groups.values()) {
		if (group.length <= 1) continue;
		const seen = new Set<string>();
		const unique: Row[] = [];
		for (const item of group) {
			const serialized = JSON.stringify(item.key);
			if (!seen.has(serialized)) {
				seen.add(serialized);
				unique.push(item.row);
			}
		}
		if (unique.length <= 1) continue;
		const label = `${unique[0].provider}/${unique[0].scope}/${unique[0].target}`;
		const differences = findNaturalKeyDifferences(unique);
		conflicts.push({ rows: unique, message: `${label} same partial natural key with different ${differences.join(", ")}` });
	}
	return conflicts;
}

function findNaturalKeyDifferences(rows: Row[]) {
	const fields = [...UNIQUE_KEY_FIELDS];
	const differing: string[] = [];
	for (const field of fields) {
		const values = [...new Set(rows.map((row) => (row[field] ?? "").trim()))];
		if (values.length > 1) differing.push(field);
	}
	return differing;
}

export function deduplicate(csvPath = DEFAULT_CSV, dryRun = false, auditDir?: string) {
	const resolved = path.resolve(csvPath);
	const { rows } = loadCsv(resolved);
	const uniqueRows: Row[] = [];
	const seen = new Set<string>();
	let removed = 0;
	for (const row of rows) {
		const key = keyFromRow(row).join("|");
		if (seen.has(key)) { removed++; continue; }
		seen.add(key);
		uniqueRows.push(row);
	}
	if (!dryRun) writeCsv(resolved, uniqueRows);
	auditEvent(auditDir, "deduplicate", { csv: resolved, removed, kept: uniqueRows.length });
	return { removed, kept: uniqueRows.length, dryRun };
}

// ---------------------------------------------------------------------------
// Mutation helpers
// ---------------------------------------------------------------------------

function resolveCsvPath(inputPath?: string) {
	return path.resolve(inputPath ?? DEFAULT_CSV);
}

export function addRows(items: Row[], csvPath?: string, auditDir?: string, continueOnError = false) {
	const resolved = resolveCsvPath(csvPath);
	const { rows } = loadCsv(resolved);
	const added: Row[] = [];
	const errors: string[] = [];
	for (const raw of items) {
		try {
			const cleaned = cleanRow(raw as Row);
			const rowErrors = validateRow(cleaned);
			if (rowErrors.length) throw new Error(rowErrors.join("; "));
			const existingKey = keyFromRow(cleaned).join("|");
			if (rows.some((existing) => keyFromRow(existing).join("|") === existingKey)) {
				throw new Error("duplicate");
			}
			rows.push(cleaned);
			added.push(cleaned);
		} catch (error) {
			const message = (error as Error).message;
			errors.push(message);
			if (!continueOnError) throw error;
		}
	}
	if (added.length) writeCsv(resolved, rows);
	auditEvent(auditDir, "add", { csv: resolved, added: added.length, errors: errors.length });
	return { added, errors };
}

export function updateRows(updates: Array<{ match: Record<string, string>; changes: Partial<Row> }>, csvPath?: string, auditDir?: string, continueOnError = false) {
	const resolved = resolveCsvPath(csvPath);
	const { rows } = loadCsv(resolved);
	const updated: Row[] = [];
	const errors: string[] = [];
	for (const update of updates) {
		try {
			const matches = matchIndex(rows, update.match as Record<string, string>);
			if (matches.length !== 1) throw new Error(`expected 1 match, got ${matches.length} for ${JSON.stringify(update.match)}`);
			const index = matches[0];
			const next = cleanRow({ ...rows[index], ...(update.changes as Row) });
			const rowErrors = validateRow(next);
			if (rowErrors.length) throw new Error(rowErrors.join("; "));
			rows[index] = next;
			updated.push(next);
		} catch (error) {
			const message = (error as Error).message;
			errors.push(message);
			if (!continueOnError) throw error;
		}
	}
	if (updated.length) writeCsv(resolved, rows);
	auditEvent(auditDir, "update", { csv: resolved, updated: updated.length, errors: errors.length });
	return { updated, errors };
}

export function removeRows(matches: Record<string, string>[], csvPath?: string, auditDir?: string, continueOnError = false) {
	const resolved = resolveCsvPath(csvPath);
	let { rows } = loadCsv(resolved);
	const removed: Row[] = [];
	const errors: string[] = [];
	for (const match of matches) {
		try {
			const indices = matchIndex(rows, match as Record<string, string>);
			if (indices.length !== 1) throw new Error(`expected 1 match, got ${indices.length} for ${JSON.stringify(match)}`);
			const [index] = indices;
			removed.push(rows[index]);
			rows = rows.filter((_, idx) => idx !== index);
		} catch (error) {
			const message = (error as Error).message;
			errors.push(message);
			if (!continueOnError) throw error;
		}
	}
	if (removed.length) writeCsv(resolved, rows);
	auditEvent(auditDir, "remove", { csv: resolved, removed: removed.length, errors: errors.length });
	return { removed, errors };
}

export function upsertRow(row: Row, strict = false, singleMatch = false, csvPath?: string, auditDir?: string) {
	const resolved = resolveCsvPath(csvPath);
	const { rows } = loadCsv(resolved);
	const cleaned = cleanRow(row);
	const rowErrors = validateRow(cleaned);
	if (rowErrors.length) throw new Error(rowErrors.join("; "));
	const matchKey = rowMatchKey(cleaned, strict);
	const matches = matchIndex(rows, matchKey);
	if (singleMatch && matches.length !== 1) throw new Error(`expected exactly 1 match, got ${matches.length}`);
	if (matches.length) {
		const updated: Row[] = [];
		for (const index of matches) {
			const next = cleanRow({ ...rows[index], ...Object.fromEntries(Object.entries(cleaned).filter(([, value]) => value !== "")) });
			const nextErrors = validateRow(next);
			if (nextErrors.length) throw new Error(nextErrors.join("; "));
			updated.push(next);
		}
		for (let i = 0; i < matches.length; i++) rows[matches[i]] = updated[i];
		writeCsv(resolved, rows);
		auditEvent(auditDir, "upsert", { csv: resolved, action: "updated", count: matches.length });
		return { action: "updated", count: matches.length, rows: updated };
	}
	const next = [...rows, cleaned];
	writeCsv(resolved, next);
	auditEvent(auditDir, "upsert", { csv: resolved, action: "added", count: 1 });
	return { action: "added", count: 1, rows: [cleaned] };
}

// ---------------------------------------------------------------------------
// CLI surface
// ---------------------------------------------------------------------------

type CliContext = {
	command: string;
	csv: string;
	json?: boolean;
	auditDir?: string;
};

function printJson(value: unknown) {
	console.log(JSON.stringify(value, null, 2));
}

function requireCsvExists(context: CliContext) {
	const resolved = path.resolve(context.csv);
	if (!fs.existsSync(resolved)) throw new Error(`CSV not found: ${resolved}`);
	return resolved;
}

function contextFromParsed(parsed: Record<string, string | boolean>): CliContext {
	return {
		command: "",
		csv: (parsed.csv as string) ?? DEFAULT_CSV,
		json: parsed.json as boolean | undefined,
		auditDir: (parsed["audit-dir"] as string | undefined) || undefined,
		auditFormat: (parsed["audit-format"] as string | undefined) || undefined,
	};
}

// Keep this as a simple hand-rolled parser to avoid adding dependencies.
function parseArgs(argv: string[]) {
	const parsed: Record<string, string | boolean> = { command: "", query: "", csv: DEFAULT_CSV, json: false, "audit-dir": "", "audit-format": "csv", strict: false, "continue-on-error": false, fields: [] as string[] };
	let positionals: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--csv") { parsed.csv = argv[++i] ?? parsed.csv as string; continue; }
		if (arg === "--json") { parsed.json = true; continue; }
		if (arg === "--audit-dir") { parsed["audit-dir"] = argv[++i] ?? ""; continue; }
		if (arg === "--audit-format") { parsed["audit-format"] = argv[++i] ?? "csv"; continue; }
		if (arg === "--strict-match") { parsed.strict = true; continue; }
		if (arg === "--continue-on-error") { parsed["continue-on-error"] = true; continue; }
		if (arg === "--dry-run") { parsed["dry-run"] = true; continue; }
		if (arg === "--limit") { parsed.limit = Number(argv[++i] ?? 50); continue; }
		if (arg === "--json-input") { parsed["json-input"] = argv[++i] ?? ""; continue; }
		if (arg === "--provider") { parsed.provider = argv[++i] ?? ""; continue; }
		if (arg === "--scope") { parsed.scope = argv[++i] ?? ""; continue; }
		if (arg === "--endpoint") { parsed.endpoint = argv[++i] ?? ""; continue; }
		if (arg === "--usage-profile") { parsed["usage-profile"] = argv[++i] ?? ""; continue; }
		if (arg === "--rate-type") { parsed["rate-type"] = argv[++i] ?? ""; continue; }
		if (arg === "--fields") { parsed.fields = String(argv[++i] ?? "").split(",").map((s) => s.trim()).filter(Boolean); continue; }
		if (arg === "--query") { parsed.query = argv[++i] ?? ""; continue; }
		if (arg === "--help") { parsed.command = "help"; break; }
		positionals.push(arg);
	}
	if (!parsed.command) parsed.command = positionals[0] ?? "";
	if (parsed.command !== "help" && positionals[1]) parsed.query = positionals[1];
	return parsed;
}

function cmdValidate(parsed: Record<string, string | boolean>) {
	const context = contextFromParsed(parsed);
	const result = validateCsv(context.csv);
	if (parsed.json) return printJson(result);
	console.log(result.valid ? `Validation passed for ${result.rowCount} rows.` : `Validation failed for ${result.issues.length} issue(s).`);
	if (!result.valid) {
		for (const issue of result.issues) {
			const rowPrefix = issue.row ? `row ${issue.row}` : "duplicate check";
			console.log(`  ${rowPrefix}: ${issue.provider} / ${issue.scope} / ${issue.target} -> ${issue.errors.join("; ")}`);
		}
	}
	return result.valid ? 0 : 2;
}

function cmdCheckDuplicates(parsed: Record<string, string | boolean>) {
	const context = contextFromParsed(parsed);
	const duplicateGroups = findDuplicateKeys(context.csv);
	const payload = { ok: duplicateGroups.length === 0, duplicateGroups };
	if (parsed.json) return printJson(payload);
	if (!duplicateGroups.length) return console.log("No duplicate global unique keys.");
	for (const [key, count] of duplicateGroups) {
		const [provider, scope, target, ...rest] = key.split("|");
		console.log(`  ${provider} / ${scope} / ${target} -> ${count}`);
		const details = rest.filter(Boolean).join(" | ");
		if (details) console.log(`      ${details}`);
	}
	return duplicateGroups.length ? 2 : 0;
}

function cmdSearch(parsed: Record<string, string | boolean>) {
	const context = contextFromParsed(parsed);
	const query = (parsed.query as string) ?? "";
	const fields = (parsed.fields as string[]) ?? ["provider", "scope", "target", "notes", "source_url", "tier_rule"];
	const limit = Number((parsed.limit as number | string | undefined) ?? 50);
	const filters: Record<string, string> = {};
	const filterKeys = [
		["provider", "provider"],
		["scope", "scope"],
		["endpoint", "endpoint"],
		["usage-profile", "usage_profile"],
		["rate-type", "rate_type"],
	] as const;
	for (const [flag, field] of filterKeys) {
		const value = (parsed[flag] as string | undefined) ?? "";
		if (value.trim()) filters[field] = value.trim();
	}
	const matches = searchRows(query, filters, parsed.strict, context.csv).slice(0, limit);
	if (parsed.json) return printJson({ ok: matches.length > 0, query, matches });
	if (!matches.length) return console.log("No matches.");
	console.log(`Found ${matches.length} match(es):`);
	for (const match of matches) {
		const label = `${match.provider} / ${match.scope}/${match.target} / ${match.rate_type} / endpoint=${match.endpoint} / limit=${match.limit_mode} / tier=${match.tier_rule}`;
		const caps = ["rpm_max", "tpm_max", "con_max"].map((cap) => `${cap}=${match[cap]}`).filter(Boolean).join(", ");
		console.log(`  ${label} || ${caps} || src=${match.source_url} || verified=${match.last_verified}`);
	}
	return 0;
}

function cmdProviders(parsed: Record<string, string | boolean>) {
	const context = contextFromParsed(parsed);
	const providers = listProviders(context.csv);
	if (parsed.json) return printJson({ providers });
	console.log(`Providers (${providers.length}):\n${providers.join("\n")}`);
	return 0;
}

function cmdDeduplicate(parsed: Record<string, string | boolean>) {
	const context = contextFromParsed(parsed);
	const result = deduplicate(context.csv, parsed["dry-run"], context.auditDir);
	if (parsed.json) return printJson(result);
	console.log(`Dry-run would remove ${result.removed} duplicate row(s), keeping ${result.kept}.`);
	return 0;
}

function cmdAdd(parsed: Record<string, string | boolean>) {
	const context = contextFromParsed(parsed);
	const input = parsed["json-input"] as string | undefined;
	if (!input) throw new Error("add requires --json-input");
	const items = JSON.parse(fs.readFileSync(input, "utf8"));
	const result = addRows(items as Row[], context.csv, context.auditDir, parsed["continue-on-error"]);
	if (parsed.json) return printJson(result);
	console.log(`Added ${result.added.length} row(s).`);
	for (const error of result.errors) console.log(`  error: ${error}`);
	return result.errors.length ? 2 : 0;
}

function cmdUpdate(parsed: Record<string, string | boolean>) {
	const context = contextFromParsed(parsed);
	const input = parsed["json-input"] as string | undefined;
	if (!input) throw new Error("update requires --json-input");
	const updates = JSON.parse(fs.readFileSync(input, "utf8"));
	const result = updateRows(updates, context.csv, context.auditDir, parsed["continue-on-error"]);
	if (parsed.json) return printJson(result);
	console.log(`Updated ${result.updated.length} row(s).`);
	for (const error of result.errors) console.log(`  error: ${error}`);
	return result.errors.length ? 2 : 0;
}

function cmdRemove(parsed: Record<string, string | boolean>) {
	const context = contextFromParsed(parsed);
	const input = parsed["json-input"] as string | undefined;
	if (!input) throw new Error("remove requires --json-input");
	const matches = JSON.parse(fs.readFileSync(input, "utf8"));
	const result = removeRows(matches, context.csv, context.auditDir, parsed["continue-on-error"]);
	if (parsed.json) return printJson(result);
	console.log(`Removed ${result.removed.length} row(s).`);
	for (const error of result.errors) console.log(`  error: ${error}`);
	return result.errors.length ? 2 : 0;
}

function cmdUpsert(parsed: Record<string, string | boolean>) {
	const context = contextFromParsed(parsed);
	const input = parsed["json-input"] as string | undefined;
	if (!input) throw new Error("upsert requires --json-input");
	const items = JSON.parse(fs.readFileSync(input, "utf8"));
	const results: Record<string, unknown>[] = [];
	let code = 0;
	for (const raw of items) {
		try {
			results.push(upsertRow(raw as Row, parsed.strict, parsed["strict-match"], context.csv, context.auditDir));
		} catch (error) {
			results.push({ error: (error as Error).message });
			code = 2;
			if (!parsed["continue-on-error"]) throw error;
		}
	}
	if (parsed.json) return printJson({ results });
	for (const result of results) console.log(JSON.stringify(result));
	return code;
}

function cmdResetProvider(parsed: Record<string, string | boolean>) {
	const context = contextFromParsed(parsed);
	const provider = (parsed.provider as string | undefined)?.trim();
	if (!provider) throw new Error("provider is required");
	const { rows } = loadCsv(context.csv);
	const removed = rows.filter((row) => (row.provider ?? "").toLowerCase() === provider.toLowerCase()).length;
	if (parsed["dry-run"]) {
		console.log(`Dry-run would remove ${removed} row(s) for provider=${provider}.`);
		auditEvent(context.auditDir, "reset-provider-dry-run", { csv: path.resolve(context.csv), provider, removed }, context.auditFormat);
		return 0;
	}
	const kept = rows.filter((row) => (row.provider ?? "").toLowerCase() !== provider.toLowerCase());
	writeCsv(path.resolve(context.csv), kept);
	auditEvent(context.auditDir, "reset-provider", { csv: path.resolve(context.csv), provider, removed }, context.auditFormat);
	console.log(`Removed ${removed} row(s) for provider=${provider}; total now ${kept.length}.`);
	return 0;
}

function cmdImport(parsed: Record<string, string | boolean>) {
	const context = contextFromParsed(parsed);
	const input = parsed["json-input"] as string | undefined;
	if (!input) throw new Error("import requires --json-input");
	const items = JSON.parse(fs.readFileSync(input, "utf8"));
	const result = importRows(items as Row[], context.csv, context.auditDir, parsed["skip-duplicates"], parsed["continue-on-error"]);
	if (parsed.json) return printJson(result);
	console.log(`Import completed: added=${result.added}, updated=${result.updated}, errors=${result.errors.length}.`);
	for (const error of result.errors) console.log(`  error: ${error}`);
	return result.errors.length ? 2 : 0;
}

function cmdCheckNaturalKeyDuplicates(parsed: Record<string, string | boolean>) {
	const context = contextFromParsed(parsed);
	const { rows } = loadCsv(context.csv);
	const exactFilters: Record<string, string> = {};
	for (const key of ["provider", "endpoint", "usage-profile"] as const) {
		const value = (parsed[key] as string | undefined) ?? "";
		if (value.trim()) exactFilters[key.replace("-", "_")] = value.trim();
	}
	const conflicts = checkNaturalKeyDuplicates(rows, exactFilters, parsed.strict);
	const payload = { ok: conflicts.length === 0, conflicts };
	if (parsed.json) return printJson(payload);
	if (!conflicts.length) return console.log("No natural key conflicts.");
	console.log(`Found ${conflicts.length} natural key conflict(s):`);
	for (const conflict of conflicts) console.log(`  ${conflict.message}`);
	return 2;
}

function printHelp() {
	console.log(`Usage: provider-rate-limits <command> [options]

Commands:
  validate                            Validate schema, required fields, enums, dates, and duplicates.
  check-duplicates                    Show duplicate global unique keys.
  check-natural-key-duplicates        Show natural key conflicts.
  search <query>                      Search rows by text with optional exact filters.
  providers                           List unique providers.
  import --json-input <file>          Lenient batch import from JSON.
  deduplicate                         Remove duplicate global unique keys.
  add --json-input <file>             Add rows from JSON/NDJSON file.
  update --json-input <file>          Update rows using match+change records.
  remove --json-input <file>          Remove rows by exact-match payload.
  upsert --json-input <file>          Add-or-update rows.
  reset-provider --provider <name>    Remove all rows for a provider.

Options:
  --csv <path>                        CSV path, defaults to bundled assets/provider-rate-limits.csv.
  --json                              Print structured JSON instead of human text.
  --audit-dir <path>                  Write audit sidecar into this directory.
  --audit-format <format>             Audit sidecar format: csv or json.
  --strict-match                      Use exact case-sensitive exact filters.
  --continue-on-error                 Continue batch operations after the first error.
`);
}

function runCli(argv: string[]) {
	const parsed = parseArgs(argv);
	if (parsed.command === "help" || parsed.command === "--help") return printHelp();
	if (!parsed.command) return printHelp();
	switch (parsed.command) {
		case "validate":
			return cmdValidate(parsed);
		case "check-duplicates":
			return cmdCheckDuplicates(parsed);
		case "check-natural-key-duplicates":
			return cmdCheckNaturalKeyDuplicates(parsed);
		case "search":
			return cmdSearch(parsed);
		case "providers":
			return cmdProviders(parsed);
		case "import":
			return cmdImport(parsed);
		case "deduplicate":
			return cmdDeduplicate(parsed);
		case "add":
			return cmdAdd(parsed);
		case "update":
			return cmdUpdate(parsed);
		case "remove":
			return cmdRemove(parsed);
		case "upsert":
			return cmdUpsert(parsed);
		case "reset-provider":
			return cmdResetProvider(parsed);
		default:
			console.error(`Unknown command: ${parsed.command}`);
			return printHelp();
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const code = runCli(process.argv.slice(2));
	process.exit(code ?? 0);
}
