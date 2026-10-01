import * as fs from "node:fs";
import * as path from "node:path";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_REQUIRED_EXTENSIONS = 32;
const MAX_PATH_BYTES = 4096;
const EMPTY_SNAPSHOT: RequiredChildExtensionSnapshot = Object.freeze([]);

export interface RequiredChildExtension {
	/** Safe host-owned identity exposed in launch evidence. */
	id: string;
	/** Existing importable module path. Snapshotted to its canonical absolute path. */
	path: string;
}

export interface RegisterRequiredChildExtensionsInput {
	sessionId: string;
	extensions: readonly RequiredChildExtension[];
	/** Reject launches whose runner or machine placement cannot load these extensions, instead of dropping them. */
	requireForAllRunners?: boolean;
}

export interface RequiredChildExtensionRegistration { dispose(): void }
/** Registration stamps `requireForAllRunners` on each entry so every carrier of the snapshot retains it. */
export type RequiredChildExtensionSnapshot = ReadonlyArray<Readonly<RequiredChildExtension & { requireForAllRunners?: true }>>;

/** Validate and freeze a snapshot; registration canonicalizes once, while retained launches preserve that identity. */
export function snapshotRequiredChildExtensions(value: unknown, label = "Required child extensions", canonicalizeFiles = false): RequiredChildExtensionSnapshot {
	if (!Array.isArray(value) || value.length > MAX_REQUIRED_EXTENSIONS) throw new Error(`${label} must be an array of at most ${MAX_REQUIRED_EXTENSIONS} entries.`);
	const ids = new Set<string>();
	const paths = new Set<string>();
	return Object.freeze(value.map((entry, index) => {
		// The flag comes from registration, so only serialized snapshots (not registration input) may carry it.
		if (!entry || typeof entry !== "object" || Array.isArray(entry) || Object.keys(entry).some((key) => key !== "id" && key !== "path" && (canonicalizeFiles || key !== "requireForAllRunners"))) throw new Error(`${label} entry ${index} requires only id and path.`);
		const id = "id" in entry ? entry.id : undefined;
		const rawPath = "path" in entry ? entry.path : undefined;
		const requireForAllRunners = "requireForAllRunners" in entry ? entry.requireForAllRunners : undefined;
		if (typeof id !== "string" || !ID_PATTERN.test(id)) throw new Error(`${label} entry ${index} requires a safe id of at most 128 characters.`);
		if (ids.has(id)) throw new Error(`${label} id '${id}' is duplicated.`);
		if (requireForAllRunners !== undefined && requireForAllRunners !== true) throw new Error(`${label} '${id}' requireForAllRunners must be true when present.`);
		if (typeof rawPath !== "string" || !rawPath.trim() || rawPath.includes("\0") || Buffer.byteLength(rawPath, "utf8") > MAX_PATH_BYTES || (!canonicalizeFiles && !path.isAbsolute(rawPath))) throw new Error(`${label} '${id}' requires ${canonicalizeFiles ? "a" : "an absolute"} non-empty path of at most ${MAX_PATH_BYTES} bytes without NUL.`);
		let extensionPath = rawPath;
		if (canonicalizeFiles) {
			try {
				extensionPath = fs.realpathSync(path.resolve(rawPath));
				if (!fs.statSync(extensionPath).isFile()) throw new Error("not a file");
			} catch (error) {
				throw new Error(`${label} '${id}' is not an importable file: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		if (paths.has(extensionPath)) throw new Error(`${label} path '${extensionPath}' is duplicated.`);
		ids.add(id);
		paths.add(extensionPath);
		return Object.freeze(requireForAllRunners ? { id, path: extensionPath, requireForAllRunners } : { id, path: extensionPath });
	}));
}

interface Registry { version: 1; bySession: Map<string, RequiredChildExtensionSnapshot> }

function registry(): Registry {
	const key = Symbol.for("pi-subagents.required-child-extensions.v1");
	const root = globalThis as Record<PropertyKey, unknown>;
	const existing = root[key];
	if (existing === undefined) {
		const created: Registry = { version: 1, bySession: new Map() };
		root[key] = created;
		return created;
	}
	if (!existing || typeof existing !== "object" || !("version" in existing) || existing.version !== 1 || !("bySession" in existing) || !(existing.bySession instanceof Map)) throw new Error("Malformed or unsupported required child extension registry.");
	return { version: 1, bySession: existing.bySession };
}

/** Register one immutable host-required extension snapshot for a parent session. */
export function registerRequiredChildExtensions(input: RegisterRequiredChildExtensionsInput): RequiredChildExtensionRegistration {
	if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((key) => key !== "sessionId" && key !== "extensions" && key !== "requireForAllRunners")) throw new Error("Required child extension registration accepts only sessionId, extensions, and requireForAllRunners.");
	if (typeof input.sessionId !== "string" || !input.sessionId || input.sessionId.trim() !== input.sessionId || input.sessionId.length > 256 || input.sessionId.includes("\0")) throw new Error("Required child extension registration requires a non-empty trimmed sessionId of at most 256 characters without NUL.");
	if (input.requireForAllRunners !== undefined && typeof input.requireForAllRunners !== "boolean") throw new Error("Required child extension registration requireForAllRunners must be a boolean.");
	const canonical = snapshotRequiredChildExtensions(input.extensions, "Required child extensions", true);
	const frozen = input.requireForAllRunners ? Object.freeze(canonical.map((entry) => Object.freeze({ ...entry, requireForAllRunners: true as const }))) : canonical;
	const store = registry();
	if (store.bySession.has(input.sessionId)) throw new Error(`Required child extensions are already registered for session '${input.sessionId}'; dispose them first.`);
	store.bySession.set(input.sessionId, frozen);
	return { dispose() { if (store.bySession.get(input.sessionId) === frozen) store.bySession.delete(input.sessionId); } };
}

export function resolveRequiredChildExtensions(sessionId: string | undefined): RequiredChildExtensionSnapshot {
	if (!sessionId) return EMPTY_SNAPSHOT;
	return registry().bySession.get(sessionId) ?? EMPTY_SNAPSHOT;
}

/** Reject a non-native runner or machine placement when any given snapshot has a `requireForAllRunners` entry. */
export function assertRequiredChildExtensionsAdmitted(snapshots: ReadonlyArray<RequiredChildExtensionSnapshot | undefined>, launch: { agent: string; runnerType?: string; machine?: string }): void {
	const ids = [...new Set(snapshots.flatMap((snapshot) => snapshot ?? []).filter((entry) => entry.requireForAllRunners).map((entry) => entry.id))];
	if (ids.length === 0) return;
	const route = launch.machine ? `machine '${launch.machine}'` : launch.runnerType !== undefined && launch.runnerType !== "pi" ? `runner.type='${launch.runnerType}'` : undefined;
	if (route) throw new Error(`Agent '${launch.agent}' cannot run on ${route}: the host requires child extensions (${ids.join(", ")}) for every runner, and only local native Pi children load them.`);
}

export function hasMandatoryRequiredChildExtensions(snapshot: RequiredChildExtensionSnapshot | undefined): snapshot is RequiredChildExtensionSnapshot {
	return snapshot?.some((entry) => entry.requireForAllRunners) === true;
}

const RETAINED_FILE = "required-child-extensions.json";

/** Persist a run's mandatory snapshot so append-step admits against it; writes nothing without a mandatory entry. */
export function writeRetainedRequiredChildExtensions(asyncDir: string, snapshot: RequiredChildExtensionSnapshot): void {
	if (!hasMandatoryRequiredChildExtensions(snapshot)) return;
	fs.writeFileSync(path.join(asyncDir, RETAINED_FILE), `${JSON.stringify(snapshot)}\n`, { mode: 0o600 });
}

export function readRetainedRequiredChildExtensions(asyncDir: string): RequiredChildExtensionSnapshot | undefined {
	const filePath = path.join(asyncDir, RETAINED_FILE);
	if (!fs.existsSync(filePath)) return undefined;
	return snapshotRequiredChildExtensions(JSON.parse(fs.readFileSync(filePath, "utf-8")), "Retained required child extensions");
}
