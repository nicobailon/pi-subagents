/**
 * Optional rate-limit insights for model selection.
 *
 * This module is intentionally read-only and safe to skip when the bundled
 * snapshot is missing, invalid, or incompatible with the current runtime.
 */

import { readFileSync } from "node:fs";

export interface ProviderRateLimit {
	provider: string;
	scope: string;
	target: string;
	rateType: string;
	endpoint: string;
	scopeMode: string;
	limitMode: string;
	usageProfile: string;
	tierRule: string;
	effectiveStart: string;
	effectiveEnd: string;
	rpmMax: string;
	tpmMax: string;
	rphMax: string;
	rpdMax: string;
	tphMax: string;
	tpdMax: string;
	conMax: string;
	retryAfterHint: string;
}

let cachedSnapshot: ProviderRateLimit[] | null = null;
let cachedPath: string | null = null;

export function resetProviderRateLimitCache() {
	cachedSnapshot = null;
	cachedPath = null;
}

export function loadProviderRateLimits(csvPath?: string): ProviderRateLimit[] | null {
	const resolved = resolveCsvPath(csvPath);
	if (cachedSnapshot !== null && cachedPath === resolved) return cachedSnapshot;
	try {
		cachedSnapshot = readSnapshot(resolved) ?? null;
		cachedPath = resolved;
		return cachedSnapshot;
	} catch {
		cachedSnapshot = null;
		cachedPath = resolved;
		return null;
	}
}

function resolveCsvPath(csvPath?: string) {
	const defaultPath = new URL('../../../assets/provider-rate-limits.csv', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1/');
	if (csvPath) return csvPath;
	return defaultPath;
}

function readSnapshot(csvPath: string): ProviderRateLimit[] | null {
	try {
		const content = readFileSync(csvPath, 'utf-8');
		const lines = content.split(/\r?\n/).filter((line) => line.trim().length > 0);
		if (lines.length === 0) return [];
		const headers = parseCsvLine(lines[0]);
		const headerSet = new Set(headers.map((h) => h.trim().toLowerCase()));
		const required = ['provider', 'scope', 'target', 'rate_type', 'endpoint', 'limit_mode', 'usage_profile', 'tier_rule', 'effective_start', 'effective_end', 'rpm_max', 'tpm_max', 'con_max'];
		if (!required.every((header) => headerSet.has(header))) return null;
		const alias: Record<string, string> = {
			rate_type: 'rateType',
			scope_mode: 'scopeMode',
			limit_mode: 'limitMode',
			usage_profile: 'usageProfile',
			tier_rule: 'tierRule',
			effective_start: 'effectiveStart',
			effective_end: 'effectiveEnd',
			retry_after_hint: 'retryAfterHint',
			rpm_max: 'rpmMax',
			tpm_max: 'tpmMax',
			rph_max: 'rphMax',
			rpd_max: 'rpdMax',
			tph_max: 'tphMax',
			tpd_max: 'tpdMax',
			con_max: 'conMax',
		};
		const rowMap = new Map<string, number>();
		const rows: ProviderRateLimit[] = [];
		for (let i = 1; i < lines.length; i++) {
			const values = parseCsvLine(lines[i]);
			const source: Record<string, string> = {};
			for (let h = 0; h < headers.length && h < values.length; h++) source[headers[h].trim().toLowerCase()] = values[h].trim();
			if (!source.provider || !source.scope || !source.target) continue;
			const target: ProviderRateLimit = {
				provider: source.provider,
				scope: source.scope,
				target: source.target,
				rateType: source.rate_type ?? '',
				endpoint: source.endpoint ?? '',
				scopeMode: source.scope_mode ?? '',
				limitMode: source.limit_mode ?? '',
				usageProfile: source.usage_profile ?? '',
				tierRule: source.tier_rule ?? '',
				effectiveStart: source.effective_start ?? '',
				effectiveEnd: source.effective_end ?? '',
				rpmMax: source.rpm_max ?? '',
				tpmMax: source.tpm_max ?? '',
				rphMax: source.rph_max ?? '',
				rpdMax: source.rpd_max ?? '',
				tphMax: source.tph_max ?? '',
				tpdMax: source.tpd_max ?? '',
				conMax: source.con_max ?? '',
				retryAfterHint: source.retry_after_hint ?? '',
			};
			const naturalKey = naturalKeyFromRateLimit(target);
			const existingIndex = rowMap.get(naturalKey);
			if (existingIndex === undefined) {
				rowMap.set(naturalKey, rows.length);
				rows.push(target);
			}
		}
		return rows;
	} catch {
		return null;
	}
}

function naturalKeyFromRateLimit(row: ProviderRateLimit) {
	return [row.provider.toLowerCase(), row.scope.toLowerCase(), row.target.toLowerCase(), row.rateType.toLowerCase(), row.endpoint.toLowerCase(), row.scopeMode.toLowerCase(), row.usageProfile.toLowerCase(), row.effectiveStart, row.effectiveEnd, row.tierRule.toLowerCase()].join('|');
}

function parseCsvLine(line: string) {
	const values: string[] = [];
	let current = '';
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
		} else if (ch === ',') {
			values.push(current);
			current = '';
		} else current += ch;
	}
	values.push(current);
	return values;
}
