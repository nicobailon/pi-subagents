import { Buffer } from "node:buffer";

export const SUBAGENT_CAPABILITY_CEILING_VERSION = 1 as const;
export const SUBAGENT_CAPABILITY_CEILING_REGISTRY_KEY = "pi-subagents.capability-ceiling.v1";
export const SUBAGENT_CAPABILITY_CEILING_ENV = "PI_SUBAGENT_CAPABILITY_CEILING_V1";

export type SubagentCapabilityCeiling =
	| { allowedTools: readonly string[]; allowedAgents?: readonly string[]; denyExtensions?: boolean }
	| { allowedTools?: readonly string[]; allowedAgents?: readonly string[]; denyExtensions: boolean }
	| { allowedTools?: readonly string[]; allowedAgents: readonly string[]; denyExtensions?: boolean };

export interface ResolvedSubagentCapabilityCeiling {
	version: typeof SUBAGENT_CAPABILITY_CEILING_VERSION;
	allowedTools?: string[];
	allowedAgents?: string[];
	denyExtensions: boolean;
	sources: string[];
}

export interface SubagentCapabilityAudit {
	ceiling: ResolvedSubagentCapabilityCeiling;
	requestedTools?: string[];
	effectiveTools: string[];
	removedTools: string[];
	excludeTools?: string[];
	internalTools: string[];
	extensionsDenied: boolean;
	removedExtensionCount: number;
	requestedMcpToolCount: number;
	effectiveMcpTools: string[];
	agentAllowed: boolean;
	agentRestrictionSources?: string[];
}

export interface RegisterSubagentCapabilityCeilingOptions {
	sessionId: string;
	source: string;
	ceiling: SubagentCapabilityCeiling;
}

export interface SubagentCapabilityCeilingHandle {
	update(ceiling: SubagentCapabilityCeiling): void;
	dispose(): void;
}

type Registration = { source: string; ceiling: ResolvedSubagentCapabilityCeiling };
type Registry = Map<string, Map<symbol, Registration>>;

function registry(): Registry {
	const key = Symbol.for(SUBAGENT_CAPABILITY_CEILING_REGISTRY_KEY);
	const store = globalThis as typeof globalThis & { [key: symbol]: unknown };
	const existing = store[key];
	if (existing instanceof Map) return existing as Registry;
	const created: Registry = new Map();
	store[key] = created;
	return created;
}

function validateText(value: unknown, field: string): string {
	if (typeof value !== "string" || !value.trim() || /[\u0000-\u001f\u007f]/u.test(value) || Buffer.byteLength(value.trim(), "utf8") > 256) {
		throw new Error(`Invalid capability ceiling ${field}; expected a non-empty string without control characters (max 256 UTF-8 bytes).`);
	}
	return value.trim();
}

function normalizeCeiling(ceiling: SubagentCapabilityCeiling): ResolvedSubagentCapabilityCeiling {
	if (!ceiling || typeof ceiling !== "object" || Array.isArray(ceiling)) throw new Error("Invalid capability ceiling; expected an object.");
	const hasAllowedTools = Object.hasOwn(ceiling, "allowedTools");
	const hasAllowedAgents = Object.hasOwn(ceiling, "allowedAgents");
	const hasDenyExtensions = Object.hasOwn(ceiling, "denyExtensions");
	if (!hasAllowedTools && !hasAllowedAgents && !hasDenyExtensions) throw new Error("Invalid capability ceiling; expected allowedTools, allowedAgents, or denyExtensions.");
	if (hasDenyExtensions && typeof ceiling.denyExtensions !== "boolean") throw new Error("Invalid capability ceiling denyExtensions; expected a boolean.");
	const normalizeList = (field: "allowedTools" | "allowedAgents", pattern: RegExp): string[] | undefined => {
		if (!Object.hasOwn(ceiling, field)) return undefined;
		const values = ceiling[field];
		if (!Array.isArray(values)) throw new Error(`Invalid capability ceiling ${field}; expected an array.`);
		if (values.length > 256) throw new Error(`Invalid capability ceiling ${field}; expected at most 256 names.`);
		return [...new Set(values.map((entry) => {
			const name = validateText(entry, `${field} entry`);
			if (!pattern.test(name)) throw new Error(`Invalid capability ceiling ${field} entry '${name}'.`);
			if (Buffer.byteLength(name, "utf8") > 128) throw new Error(`Invalid capability ceiling ${field} entry '${name}'; max 128 UTF-8 bytes.`);
			return name;
		}))].sort();
	};
	const allowedTools = normalizeList("allowedTools", /^[A-Za-z0-9_.:-]+$/u);
	const allowedAgents = normalizeList("allowedAgents", /^[A-Za-z0-9_.:-]+$/u);
	return {
		version: SUBAGENT_CAPABILITY_CEILING_VERSION,
		...(allowedTools !== undefined ? { allowedTools } : {}),
		...(allowedAgents !== undefined ? { allowedAgents } : {}),
		denyExtensions: ceiling.denyExtensions === true,
		sources: [],
	};
}

export function parseSubagentCapabilityCeiling(value: unknown, field = "capability ceiling"): ResolvedSubagentCapabilityCeiling {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid ${field}; expected an object.`);
	const record = value as Record<string, unknown>;
	if (record.version !== SUBAGENT_CAPABILITY_CEILING_VERSION) throw new Error(`Invalid ${field} version.`);
	const normalized = normalizeCeiling(record as SubagentCapabilityCeiling);
	const sources = record.sources;
	if (!Array.isArray(sources) || sources.some((source) => typeof source !== "string")) throw new Error(`Invalid ${field} sources; expected an array of strings.`);
	normalized.sources = [...new Set(sources.map((source) => validateText(source, `${field} source`)))].sort();
	return normalized;
}

export function registerSubagentCapabilityCeiling(options: RegisterSubagentCapabilityCeilingOptions): SubagentCapabilityCeilingHandle {
	const sessionId = validateText(options.sessionId, "sessionId");
	const source = validateText(options.source, "source");
	let normalized = normalizeCeiling(options.ceiling);
	const token = Symbol(source);
	const store = registry();
	let session = store.get(sessionId);
	if (!session) {
		session = new Map();
		store.set(sessionId, session);
	}
	const setRegistration = () => {
		normalized = normalizeCeiling(normalized);
		normalized.sources = [source];
		session!.set(token, { source, ceiling: normalized });
	};
	setRegistration();
	let disposed = false;
	return {
		update(ceiling) {
			if (disposed) throw new Error("Cannot update a disposed capability ceiling handle.");
			normalized = normalizeCeiling(ceiling);
			normalized.sources = [source];
			session!.set(token, { source, ceiling: normalized });
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			session!.delete(token);
			if (session!.size === 0) store.delete(sessionId);
		},
	};
}

export function intersectSubagentCapabilityCeilings(...ceilings: Array<ResolvedSubagentCapabilityCeiling | undefined>): ResolvedSubagentCapabilityCeiling | undefined {
	const active = ceilings.filter((ceiling): ceiling is ResolvedSubagentCapabilityCeiling => ceiling !== undefined);
	if (active.length === 0) return undefined;
	const intersectLists = (field: "allowedTools" | "allowedAgents"): string[] | undefined => {
		const definedLists = active.filter((ceiling) => ceiling[field] !== undefined).map((ceiling) => new Set(ceiling[field]));
		if (definedLists.length === 0) return undefined;
		return [...definedLists[0]!].filter((entry) => definedLists.every((list) => list.has(entry))).sort();
	};
	const allowedTools = intersectLists("allowedTools");
	const allowedAgents = intersectLists("allowedAgents");
	return {
		version: SUBAGENT_CAPABILITY_CEILING_VERSION,
		...(allowedTools !== undefined ? { allowedTools } : {}),
		...(allowedAgents !== undefined ? { allowedAgents } : {}),
		denyExtensions: active.some((ceiling) => ceiling.denyExtensions),
		sources: [...new Set(active.flatMap((ceiling) => ceiling.sources))].sort(),
	};
}

export function resolveSubagentCapabilityCeiling(sessionId: string | undefined, inherited?: ResolvedSubagentCapabilityCeiling): ResolvedSubagentCapabilityCeiling | undefined {
	const active: ResolvedSubagentCapabilityCeiling[] = [];
	if (sessionId) {
		const registrations = registry().get(sessionId);
		if (registrations) active.push(...Array.from(registrations.values(), ({ ceiling }) => ceiling));
	}
	return intersectSubagentCapabilityCeilings(inherited, ...active);
}

export function resolveCurrentSubagentCapabilityCeiling(sessionId: string | undefined): ResolvedSubagentCapabilityCeiling | undefined {
	return resolveSubagentCapabilityCeiling(sessionId, decodeSubagentCapabilityCeiling(process.env[SUBAGENT_CAPABILITY_CEILING_ENV]));
}

export function isAgentAllowedByCapabilityCeiling(agentName: string, ceiling: ResolvedSubagentCapabilityCeiling | undefined): boolean {
	return ceiling?.allowedAgents === undefined || ceiling.allowedAgents.includes(agentName);
}

export function capabilityCeilingAgentRestrictionMessage(agentName: string, ceiling: ResolvedSubagentCapabilityCeiling | undefined): string | undefined {
	if (isAgentAllowedByCapabilityCeiling(agentName, ceiling)) return undefined;
	const sources = ceiling?.sources.length ? ceiling.sources.join(", ") : "unknown source";
	const allowed = ceiling?.allowedAgents?.length ? ceiling.allowedAgents.join(", ") : "(none)";
	return `Capability ceiling from ${sources} does not allow agent '${agentName}'. Allowed agents: ${allowed}.`;
}

export function assertAgentAllowedByCapabilityCeiling(agentName: string, ceiling: ResolvedSubagentCapabilityCeiling | undefined): void {
	const message = capabilityCeilingAgentRestrictionMessage(agentName, ceiling);
	if (message) throw new Error(message);
}

export function capabilityCeilingAgentRestrictionSources(ceiling: ResolvedSubagentCapabilityCeiling | undefined): string[] | undefined {
	return ceiling?.allowedAgents === undefined ? undefined : [...ceiling.sources];
}

export function encodeSubagentCapabilityCeiling(ceiling: ResolvedSubagentCapabilityCeiling | undefined): string | undefined {
	if (!ceiling) return undefined;
	return Buffer.from(JSON.stringify(ceiling), "utf8").toString("base64url");
}

export function decodeSubagentCapabilityCeiling(value: string | undefined): ResolvedSubagentCapabilityCeiling | undefined {
	if (value === undefined || value === "") return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
	} catch (error) {
		throw new Error(`Invalid inherited capability ceiling: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || (parsed as { version?: unknown }).version !== SUBAGENT_CAPABILITY_CEILING_VERSION) {
		throw new Error("Invalid inherited capability ceiling version.");
	}
	return parseSubagentCapabilityCeiling(parsed, "inherited capability ceiling");
}
