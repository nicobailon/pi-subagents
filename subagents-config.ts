/**
 * subagents.json overlay loader.
 *
 * Locates up to two `subagents.json` files (project + user), parses them
 * safely, validates entries against an allowlist of overridable fields, and
 * merges them into a single overlay with project-precedence-per-field for
 * overrides and union semantics for `disabled`. All problems are collected
 * as human-readable warnings — this module never throws.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const CONFIG_DIR = ".pi";
const AGENT_DIR = path.join(os.homedir(), ".pi", "agent");
// Referenced to keep intent explicit; production user path resolution below
// honors PI_SUBAGENTS_HOME and falls back to os.homedir().
void AGENT_DIR;

export interface AgentOverride {
	description?: string;
	model?: string;
	thinking?: string;
	tools?: string[];
	skills?: string[];
	extensions?: string[];
	output?: string;
	defaultReads?: string[];
	defaultProgress?: boolean;
	interactive?: boolean;
	maxSubagentDepth?: number;
}

export interface SubagentsOverlay {
	agents: Map<string, AgentOverride>;
	disabled: Set<string>;
	warnings: string[];
}

const OVERRIDABLE_FIELDS = new Set<keyof AgentOverride>([
	"description",
	"model",
	"thinking",
	"tools",
	"skills",
	"extensions",
	"output",
	"defaultReads",
	"defaultProgress",
	"interactive",
	"maxSubagentDepth",
]);

const STRING_FIELDS = new Set<keyof AgentOverride>([
	"description",
	"model",
	"thinking",
	"output",
]);

const STRING_ARRAY_FIELDS = new Set<keyof AgentOverride>([
	"tools",
	"skills",
	"extensions",
	"defaultReads",
]);

const BOOLEAN_FIELDS = new Set<keyof AgentOverride>([
	"defaultProgress",
	"interactive",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function userSubagentsPath(): string {
	const override = process.env.PI_SUBAGENTS_HOME;
	const home = override && override.length > 0 ? override : os.homedir();
	return path.join(home, ".pi", "agent", "subagents.json");
}

interface PartialOverlay {
	agents: Map<string, AgentOverride>;
	disabled: Set<string>;
	warnings: string[];
}

function parseOverlayFile(filePath: string): PartialOverlay {
	const empty: PartialOverlay = {
		agents: new Map(),
		disabled: new Set(),
		warnings: [],
	};

	let raw: string;
	try {
		raw = fs.readFileSync(filePath, "utf-8");
	} catch (_err) {
		// Missing file (or unreadable) → treat as empty, no warning.
		return empty;
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return {
			agents: new Map(),
			disabled: new Set(),
			warnings: [`${filePath}: invalid JSON: ${message}`],
		};
	}

	const warnings: string[] = [];
	const agents = new Map<string, AgentOverride>();
	const disabled = new Set<string>();

	if (!isPlainObject(parsed)) {
		warnings.push(`${filePath}: root must be an object`);
		return { agents, disabled, warnings };
	}

	// agents
	if (parsed.agents !== undefined) {
		if (!isPlainObject(parsed.agents)) {
			warnings.push(`${filePath}: 'agents' must be an object`);
		} else {
			for (const [name, entryRaw] of Object.entries(parsed.agents)) {
				if (!isPlainObject(entryRaw)) {
					warnings.push(`${filePath}: agents.${name}: entry must be an object`);
					continue;
				}
				const override: AgentOverride = {};
				for (const [field, value] of Object.entries(entryRaw)) {
					if (!OVERRIDABLE_FIELDS.has(field as keyof AgentOverride)) {
						warnings.push(`${filePath}: agents.${name}: unknown field '${field}'`);
						continue;
					}
					const key = field as keyof AgentOverride;
					if (STRING_FIELDS.has(key)) {
						if (typeof value !== "string") {
							warnings.push(
								`${filePath}: agents.${name}.${field}: expected string, dropping`,
							);
							continue;
						}
						(override as Record<string, unknown>)[field] = value;
					} else if (STRING_ARRAY_FIELDS.has(key)) {
						if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
							warnings.push(
								`${filePath}: agents.${name}.${field}: expected string[], dropping`,
							);
							continue;
						}
						(override as Record<string, unknown>)[field] = [...value];
					} else if (BOOLEAN_FIELDS.has(key)) {
						if (typeof value !== "boolean") {
							warnings.push(
								`${filePath}: agents.${name}.${field}: expected boolean, dropping`,
							);
							continue;
						}
						(override as Record<string, unknown>)[field] = value;
					} else if (key === "maxSubagentDepth") {
						if (!Number.isInteger(value) || (value as number) < 0) {
							warnings.push(
								`${filePath}: agents.${name}.${field}: expected non-negative integer, dropping`,
							);
							continue;
						}
						(override as Record<string, unknown>)[field] = value;
					}
				}
				agents.set(name, override);
			}
		}
	}

	// disabled
	if (parsed.disabled !== undefined) {
		if (!Array.isArray(parsed.disabled)) {
			warnings.push(`${filePath}: 'disabled' must be an array, treating as empty`);
		} else {
			for (const entry of parsed.disabled) {
				if (typeof entry !== "string") {
					warnings.push(`${filePath}: disabled: non-string entry dropped`);
					continue;
				}
				disabled.add(entry);
			}
		}
	}

	return { agents, disabled, warnings };
}

export function loadSubagentsOverlay(
	cwd: string,
	opts?: { userFilePath?: string; projectFilePath?: string },
): SubagentsOverlay {
	const userPath = opts?.userFilePath ?? userSubagentsPath();
	const projectPath = opts?.projectFilePath ?? path.join(cwd, CONFIG_DIR, "subagents.json");

	const userOverlay = parseOverlayFile(userPath);
	const projectOverlay = parseOverlayFile(projectPath);

	// Merge agents: start with user, then shallow-merge project per field (project wins).
	const merged = new Map<string, AgentOverride>();
	for (const [name, override] of userOverlay.agents) {
		merged.set(name, { ...override });
	}
	for (const [name, projectOverride] of projectOverlay.agents) {
		const existing = merged.get(name) ?? {};
		merged.set(name, { ...existing, ...projectOverride });
	}

	// Union disabled sets.
	const disabled = new Set<string>();
	for (const name of userOverlay.disabled) disabled.add(name);
	for (const name of projectOverlay.disabled) disabled.add(name);

	return {
		agents: merged,
		disabled,
		warnings: [...userOverlay.warnings, ...projectOverlay.warnings],
	};
}

/**
 * Given a list of known agent names (after loading and merging from disk),
 * return warnings for any names referenced in the overlay (in `agents` or
 * `disabled`) that do not exist. Mutates nothing.
 */
export function detectUnknownAgentNames(
	overlay: SubagentsOverlay,
	knownNames: Iterable<string>,
): string[] {
	const known = new Set(knownNames);
	const warnings: string[] = [];
	for (const name of overlay.agents.keys()) {
		if (!known.has(name)) {
			warnings.push(
				`subagents.json: agents.${name} references unknown agent '${name}'`,
			);
		}
	}
	for (const name of overlay.disabled) {
		if (!known.has(name)) {
			warnings.push(
				`subagents.json: disabled[] references unknown agent '${name}'`,
			);
		}
	}
	return warnings;
}
