export const EXTERNAL_RUN_REGISTRY_VERSION = 1;
export const EXTERNAL_RUN_REGISTRY_KEY = "pi-subagents.external-runs.v1";

const MAX_PROVIDERS = 100;
const MAX_RUNS_PER_PROVIDER = 10_000;
const MAX_TEXT_LENGTH = 4_096;

export type ExternalRunState = "running" | "completed" | "failed" | "stopped";
export type ExternalRunCompletionReason = "exit" | "timeout" | "user-kill" | "auto-close-quiet" | "crash" | "unknown";

/** An observational record for work owned by another runtime. */
export interface ExternalRun {
	id: string;
	sessionId: string;
	source: string;
	state: ExternalRunState;
	command?: string;
	cwd?: string;
	isolationPath?: string;
	owner?: string;
	completionReason?: ExternalRunCompletionReason;
	reportPath?: string;
	startedAt?: number;
	completedAt?: number;
	exitCode?: number | null;
	residualRisks?: string[];
}

export interface ExternalRunProvider {
	name: string;
	listExternalRuns(): readonly ExternalRun[];
}

export interface RegisteredExternalRun extends ExternalRun {
	provider: string;
}

interface ExternalRunRegistry {
	version: typeof EXTERNAL_RUN_REGISTRY_VERSION;
	providers: Map<string, ExternalRunProvider>;
}

function registry(): ExternalRunRegistry {
	const key = Symbol.for(EXTERNAL_RUN_REGISTRY_KEY);
	const target = globalThis as Record<PropertyKey, unknown>;
	const existing = target[key];
	if (existing === undefined) {
		const created: ExternalRunRegistry = { version: EXTERNAL_RUN_REGISTRY_VERSION, providers: new Map() };
		target[key] = created;
		return created;
	}
	if (!existing || typeof existing !== "object" || Array.isArray(existing)) throw new Error(`Malformed external-run registry at Symbol.for("${EXTERNAL_RUN_REGISTRY_KEY}").`);
	const candidate = existing as Partial<ExternalRunRegistry>;
	if (candidate.version !== EXTERNAL_RUN_REGISTRY_VERSION || !(candidate.providers instanceof Map)) throw new Error(`Unsupported external-run registry at Symbol.for("${EXTERNAL_RUN_REGISTRY_KEY}").`);
	return candidate as ExternalRunRegistry;
}

function text(value: unknown, field: string, required = false): string | undefined {
	if (value === undefined && !required) return undefined;
	if (typeof value !== "string" || value.length === 0 || value.trim() !== value || value.includes("\0")) throw new Error(`${field} must be a non-empty trimmed string without NUL characters.`);
	if (value.length > MAX_TEXT_LENGTH) throw new Error(`${field} must be at most ${MAX_TEXT_LENGTH} characters.`);
	return value;
}

function timestamp(value: unknown, field: string): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`${field} must be a non-negative finite number.`);
	return value;
}

function validateRun(value: unknown, provider: string, index: number): ExternalRun {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`External-run provider '${provider}' item ${index} must be an object.`);
	const run = value as Record<string, unknown>;
	const fields = new Set(["id", "sessionId", "source", "state", "command", "cwd", "isolationPath", "owner", "completionReason", "reportPath", "startedAt", "completedAt", "exitCode", "residualRisks"]);
	const unknown = Object.keys(run).filter((key) => !fields.has(key));
	if (unknown.length) throw new Error(`External-run provider '${provider}' item ${index} has unknown fields: ${unknown.join(", ")}.`);
	if (!["running", "completed", "failed", "stopped"].includes(run.state as string)) throw new Error(`External-run provider '${provider}' item ${index} state is invalid.`);
	if (run.completionReason !== undefined && !["exit", "timeout", "user-kill", "auto-close-quiet", "crash", "unknown"].includes(run.completionReason as string)) throw new Error(`External-run provider '${provider}' item ${index} completionReason is invalid.`);
	if (run.exitCode !== undefined && run.exitCode !== null && (!Number.isInteger(run.exitCode) || !Number.isFinite(run.exitCode))) throw new Error(`External-run provider '${provider}' item ${index} exitCode must be an integer or null.`);
	if (run.residualRisks !== undefined && (!Array.isArray(run.residualRisks) || run.residualRisks.some((risk, riskIndex) => text(risk, `External-run provider '${provider}' item ${index} residualRisks[${riskIndex}]`, true) === undefined))) throw new Error(`External-run provider '${provider}' item ${index} residualRisks must be an array of strings.`);
	return {
		id: text(run.id, `External-run provider '${provider}' item ${index} id`, true)!,
		sessionId: text(run.sessionId, `External-run provider '${provider}' item ${index} sessionId`, true)!,
		source: text(run.source, `External-run provider '${provider}' item ${index} source`, true)!,
		state: run.state as ExternalRunState,
		...(text(run.command, `External-run provider '${provider}' item ${index} command`) !== undefined ? { command: text(run.command, `External-run provider '${provider}' item ${index} command`) } : {}),
		...(text(run.cwd, `External-run provider '${provider}' item ${index} cwd`) !== undefined ? { cwd: text(run.cwd, `External-run provider '${provider}' item ${index} cwd`) } : {}),
		...(text(run.isolationPath, `External-run provider '${provider}' item ${index} isolationPath`) !== undefined ? { isolationPath: text(run.isolationPath, `External-run provider '${provider}' item ${index} isolationPath`) } : {}),
		...(text(run.owner, `External-run provider '${provider}' item ${index} owner`) !== undefined ? { owner: text(run.owner, `External-run provider '${provider}' item ${index} owner`) } : {}),
		...(run.completionReason !== undefined ? { completionReason: run.completionReason as ExternalRunCompletionReason } : {}),
		...(text(run.reportPath, `External-run provider '${provider}' item ${index} reportPath`) !== undefined ? { reportPath: text(run.reportPath, `External-run provider '${provider}' item ${index} reportPath`) } : {}),
		...(timestamp(run.startedAt, `External-run provider '${provider}' item ${index} startedAt`) !== undefined ? { startedAt: timestamp(run.startedAt, `External-run provider '${provider}' item ${index} startedAt`) } : {}),
		...(timestamp(run.completedAt, `External-run provider '${provider}' item ${index} completedAt`) !== undefined ? { completedAt: timestamp(run.completedAt, `External-run provider '${provider}' item ${index} completedAt`) } : {}),
		...(run.exitCode !== undefined ? { exitCode: run.exitCode as number | null } : {}),
		...(run.residualRisks !== undefined ? { residualRisks: [...run.residualRisks] as string[] } : {}),
	};
}

/** Register an observational provider. pi-subagents never starts, stops, or steers these processes. */
export function registerExternalRunProvider(provider: ExternalRunProvider): () => void {
	if (!provider || typeof provider !== "object" || Array.isArray(provider) || Object.keys(provider).some((key) => key !== "name" && key !== "listExternalRuns")) throw new Error("External-run provider must contain only name and listExternalRuns.");
	const name = text(provider.name, "External-run provider name", true)!;
	if (typeof provider.listExternalRuns !== "function") throw new Error(`External-run provider '${name}' must expose listExternalRuns().`);
	const current = registry();
	if (!current.providers.has(name) && current.providers.size >= MAX_PROVIDERS) throw new Error(`External-run registry supports at most ${MAX_PROVIDERS} providers.`);
	current.providers.set(name, provider);
	return () => { if (current.providers.get(name) === provider) current.providers.delete(name); };
}

/** Snapshot records for one Pi session. Records are read-only observations of foreign process ownership. */
export function snapshotExternalRuns(sessionId: string): readonly RegisteredExternalRun[] {
	text(sessionId, "External-run snapshot sessionId", true);
	const records: RegisteredExternalRun[] = [];
	const identities = new Set<string>();
	for (const [name, provider] of registry().providers) {
		if (provider.name !== name) throw new Error(`External-run registry key '${name}' does not match provider name '${provider.name}'.`);
		const runs = provider.listExternalRuns();
		if (!Array.isArray(runs)) throw new Error(`External-run provider '${name}' listExternalRuns() must return an array.`);
		if (runs.length > MAX_RUNS_PER_PROVIDER) throw new Error(`External-run provider '${name}' returned more than ${MAX_RUNS_PER_PROVIDER} runs.`);
		runs.forEach((value, index) => {
			const run = validateRun(value, name, index);
			const identity = `${name}\0${run.sessionId}\0${run.id}`;
			if (identities.has(identity)) throw new Error(`External-run provider '${name}' returned duplicate run '${run.id}' for session '${run.sessionId}'.`);
			identities.add(identity);
			if (run.sessionId === sessionId) records.push({ provider: name, ...run });
		});
	}
	return records;
}
