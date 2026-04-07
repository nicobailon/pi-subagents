/**
 * subagents.json overlay loader.
 *
 * Locates up to four sources of agent overrides — `subagents.json` (project +
 * user) and the `subagents` key inside `settings.json` (project + user) —
 * parses them safely, validates entries against an allowlist of overridable
 * fields, and merges them into a single overlay.
 *
 * Per-field precedence (highest wins):
 *   1. project `.pi/subagents.json`
 *   2. user `~/.pi/agent/subagents.json`
 *   3. project `.pi/settings.json` (`subagents` key)
 *   4. user `~/.pi/agent/settings.json` (`subagents` key)
 *
 * `disabled` is unioned across all four sources. All problems are collected
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
	disableBuiltins: boolean;
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

function userAgentDir(): string {
	const override = process.env.PI_SUBAGENTS_HOME;
	const home = override && override.length > 0 ? override : os.homedir();
	return path.join(home, ".pi", "agent");
}

function userSubagentsPath(): string {
	return path.join(userAgentDir(), "subagents.json");
}

function userSettingsPath(): string {
	return path.join(userAgentDir(), "settings.json");
}

interface PartialOverlay {
	agents: Map<string, AgentOverride>;
	disabled: Set<string>;
	disableBuiltins?: boolean;
	warnings: string[];
}

/**
 * Parse an overlay-shaped value (an object with optional `agents` and
 * `disabled` keys). `label` is used as the prefix for warning strings.
 */
function parseOverlayShape(value: unknown, label: string): PartialOverlay {
	const warnings: string[] = [];
	const agents = new Map<string, AgentOverride>();
	const disabled = new Set<string>();

	if (!isPlainObject(value)) {
		warnings.push(`${label}: must be an object`);
		return { agents, disabled, warnings };
	}

	// agents
	if (value.agents !== undefined) {
		if (!isPlainObject(value.agents)) {
			warnings.push(`${label}: 'agents' must be an object`);
		} else {
			for (const [name, entryRaw] of Object.entries(value.agents)) {
				if (!isPlainObject(entryRaw)) {
					warnings.push(`${label}: agents.${name}: entry must be an object`);
					continue;
				}
				const override: AgentOverride = {};
				for (const [field, fieldValue] of Object.entries(entryRaw)) {
					if (!OVERRIDABLE_FIELDS.has(field as keyof AgentOverride)) {
						warnings.push(`${label}: agents.${name}: unknown field '${field}'`);
						continue;
					}
					const key = field as keyof AgentOverride;
					if (STRING_FIELDS.has(key)) {
						if (typeof fieldValue !== "string") {
							warnings.push(
								`${label}: agents.${name}.${field}: expected string, dropping`,
							);
							continue;
						}
						(override as Record<string, unknown>)[field] = fieldValue;
					} else if (STRING_ARRAY_FIELDS.has(key)) {
						if (
							!Array.isArray(fieldValue) ||
							!fieldValue.every((v) => typeof v === "string")
						) {
							warnings.push(
								`${label}: agents.${name}.${field}: expected string[], dropping`,
							);
							continue;
						}
						(override as Record<string, unknown>)[field] = [...fieldValue];
					} else if (BOOLEAN_FIELDS.has(key)) {
						if (typeof fieldValue !== "boolean") {
							warnings.push(
								`${label}: agents.${name}.${field}: expected boolean, dropping`,
							);
							continue;
						}
						(override as Record<string, unknown>)[field] = fieldValue;
					} else if (key === "maxSubagentDepth") {
						if (!Number.isInteger(fieldValue) || (fieldValue as number) < 0) {
							warnings.push(
								`${label}: agents.${name}.${field}: expected non-negative integer, dropping`,
							);
							continue;
						}
						(override as Record<string, unknown>)[field] = fieldValue;
					}
				}
				agents.set(name, override);
			}
		}
	}

	// disableBuiltins
	let disableBuiltins: boolean | undefined;
	if (value.disableBuiltins !== undefined) {
		if (typeof value.disableBuiltins !== "boolean") {
			warnings.push(`${label}: 'disableBuiltins' must be a boolean, ignoring`);
		} else {
			disableBuiltins = value.disableBuiltins;
		}
	}

	// disabled
	if (value.disabled !== undefined) {
		if (!Array.isArray(value.disabled)) {
			warnings.push(`${label}: 'disabled' must be an array, treating as empty`);
		} else {
			for (const entry of value.disabled) {
				if (typeof entry !== "string") {
					warnings.push(`${label}: disabled: non-string entry dropped`);
					continue;
				}
				disabled.add(entry);
			}
		}
	}

	return { agents, disabled, disableBuiltins, warnings };
}

function emptyOverlay(): PartialOverlay {
	return { agents: new Map(), disabled: new Set(), warnings: [] };
}

function readJsonFile(filePath: string): { parsed?: unknown; warnings: string[] } {
	let raw: string;
	try {
		raw = fs.readFileSync(filePath, "utf-8");
	} catch (_err) {
		return { warnings: [] };
	}
	try {
		return { parsed: JSON.parse(raw), warnings: [] };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { warnings: [`${filePath}: invalid JSON: ${message}`] };
	}
}

function parseOverlayFile(filePath: string): PartialOverlay {
	const { parsed, warnings: readWarnings } = readJsonFile(filePath);
	if (parsed === undefined) {
		return { agents: new Map(), disabled: new Set(), warnings: readWarnings };
	}
	const result = parseOverlayShape(parsed, filePath);
	return {
		agents: result.agents,
		disabled: result.disabled,
		disableBuiltins: result.disableBuiltins,
		warnings: [...readWarnings, ...result.warnings],
	};
}

/**
 * Read settings.json and extract its `subagents` key as a partial overlay.
 * Missing file → empty. Invalid JSON → warning. Missing `subagents` key →
 * empty (no warning — settings.json is shared with other features).
 */
function parseSettingsFile(filePath: string): PartialOverlay {
	const { parsed, warnings: readWarnings } = readJsonFile(filePath);
	if (parsed === undefined) {
		return { agents: new Map(), disabled: new Set(), warnings: readWarnings };
	}
	if (!isPlainObject(parsed)) {
		// settings.json root not an object — leave it to other consumers to flag.
		return emptyOverlay();
	}
	if (parsed.subagents === undefined) {
		return emptyOverlay();
	}
	const label = `${filePath}: subagents`;
	const result = parseOverlayShape(parsed.subagents, label);
	return {
		agents: result.agents,
		disabled: result.disabled,
		disableBuiltins: result.disableBuiltins,
		warnings: [...readWarnings, ...result.warnings],
	};
}

export function loadSubagentsOverlay(
	cwd: string,
	opts?: {
		userFilePath?: string;
		projectFilePath?: string;
		userSettingsPath?: string;
		projectSettingsPath?: string;
	},
): SubagentsOverlay {
	const userOverlayPath = opts?.userFilePath ?? userSubagentsPath();
	const projectOverlayPath =
		opts?.projectFilePath ?? path.join(cwd, CONFIG_DIR, "subagents.json");
	const userSettings = opts?.userSettingsPath ?? userSettingsPath();
	const projectSettings =
		opts?.projectSettingsPath ?? path.join(cwd, CONFIG_DIR, "settings.json");

	// Load all four sources. Layered precedence (lowest → highest):
	//   user settings.json < project settings.json < user subagents.json < project subagents.json
	const layers: PartialOverlay[] = [
		parseSettingsFile(userSettings),
		parseSettingsFile(projectSettings),
		parseOverlayFile(userOverlayPath),
		parseOverlayFile(projectOverlayPath),
	];

	// Merge agents per-field, layer by layer (later wins).
	const merged = new Map<string, AgentOverride>();
	for (const layer of layers) {
		for (const [name, override] of layer.agents) {
			const existing = merged.get(name) ?? {};
			merged.set(name, { ...existing, ...override });
		}
	}

	// Union disabled sets across all layers.
	const disabled = new Set<string>();
	for (const layer of layers) {
		for (const name of layer.disabled) disabled.add(name);
	}

	// disableBuiltins: any layer setting it true wins (union).
	let disableBuiltins = false;
	for (const layer of layers) {
		if (layer.disableBuiltins === true) disableBuiltins = true;
	}

	const warnings: string[] = [];
	for (const layer of layers) warnings.push(...layer.warnings);

	return { agents: merged, disabled, disableBuiltins, warnings };
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
