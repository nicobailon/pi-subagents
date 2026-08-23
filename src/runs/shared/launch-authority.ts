import { createHash, randomBytes } from "node:crypto";

export const SUBAGENT_LAUNCH_AUTHORITY_VERSION = 1 as const;
export const SUBAGENT_LAUNCH_AUTHORITY_REGISTRY_KEY = "pi-subagents.launch-authority.v1";

const MAX_REQUEST_BYTES = 1_048_576;
const MAX_DEPTH = 32;
const MAX_PROPERTIES = 4_096;
const MAX_AUTHORITIES = 16;
const MAX_LANES = 256;
const MAX_MODELS = 16;
const MAX_TEXT_BYTES = 256;
const MAX_EXPIRY_MS = 60_000;
const DIGEST = /^[a-f0-9]{64}$/u;
const KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const NAME = /^[A-Za-z0-9_.:/-]{1,128}$/u;

const SAFE_MANAGEMENT_ACTIONS = new Set([
	"list",
	"status",
	"stop",
	"interrupt",
	"steer",
	"children.list",
	"schedule.list",
	"schedule.show",
	"schedule.history",
	"schedule.pause",
	"schedule.delete",
]);

export type SubagentLaunchRequestKind = "management" | "new-spawn";

export interface LaunchAuthorityLane {
	key: string;
	agent: string;
	modelCandidates: string[];
	launchContractDigest: string;
}

export interface LaunchAuthorityPermitInput {
	configRevision: string;
	expiresInMs: number;
	requestDigest: string;
	minLanes: number;
	maxLanes: number;
	lanes: LaunchAuthorityLane[];
}

export interface RegisterSubagentLaunchAuthorityOptions {
	sessionId: string;
	source: string;
	defaultNewSpawnDecision: "deny";
	validateConfigRevision?(revision: string): boolean | Promise<boolean>;
}

export interface SubagentLaunchAuthorityHandle {
	issueOnce(input: LaunchAuthorityPermitInput): string;
	revokeUnused(): void;
	dispose(): void;
}

export interface AuthorizedLaunchAuthority {
	source: string;
	configRevision: string;
	minLanes: number;
	maxLanes: number;
	lanes: LaunchAuthorityLane[];
}

export type SubagentLaunchAdmission =
	| { ok: true; authorities: AuthorizedLaunchAuthority[] }
	| {
		ok: false;
		code: "permit_required" | "invalid_permit" | "expired_permit" | "request_mismatch" | "config_revision_mismatch";
		message: string;
	};

interface PermitRecord extends LaunchAuthorityPermitInput {
	token: string;
	expiresAt: number;
	state: "issued" | "validating" | "consumed";
}

interface Registration {
	source: string;
	validateConfigRevision?: RegisterSubagentLaunchAuthorityOptions["validateConfigRevision"];
	permits: Map<string, PermitRecord>;
	disposed: boolean;
}

type Registry = Map<string, Map<symbol, Registration>>;

function registry(): Registry {
	const key = Symbol.for(SUBAGENT_LAUNCH_AUTHORITY_REGISTRY_KEY);
	const root = globalThis as unknown as Record<symbol, unknown>;
	const existing = root[key];
	if (existing instanceof Map) return existing as Registry;
	const created: Registry = new Map();
	root[key] = created;
	return created;
}

function text(value: unknown, field: string, maxBytes = MAX_TEXT_BYTES): string {
	if (typeof value !== "string" || !value.trim() || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
		throw new Error(`${field} must be a non-empty string without control characters.`);
	}
	const normalized = value.trim();
	if (Buffer.byteLength(normalized, "utf8") > maxBytes) throw new Error(`${field} exceeds ${maxBytes} UTF-8 bytes.`);
	return normalized;
}

function safeInteger(value: unknown, field: string, min: number, max: number): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
		throw new Error(`${field} must be a safe integer between ${min} and ${max}.`);
	}
	return value;
}

function cloneLane(value: unknown, index: number): LaunchAuthorityLane {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`lanes[${index}] must be an object.`);
	const lane = value as Record<string, unknown>;
	const allowed = new Set(["key", "agent", "modelCandidates", "launchContractDigest"]);
	for (const field of Object.keys(lane)) if (!allowed.has(field)) throw new Error(`lanes[${index}] contains unsupported field '${field}'.`);
	const key = text(lane.key, `lanes[${index}].key`, 128);
	if (!KEY.test(key)) throw new Error(`lanes[${index}].key is invalid.`);
	const agent = text(lane.agent, `lanes[${index}].agent`, 128);
	if (!NAME.test(agent)) throw new Error(`lanes[${index}].agent is invalid.`);
	if (!Array.isArray(lane.modelCandidates) || lane.modelCandidates.length < 1 || lane.modelCandidates.length > MAX_MODELS) {
		throw new Error(`lanes[${index}].modelCandidates must contain 1..${MAX_MODELS} models.`);
	}
	const modelCandidates = lane.modelCandidates.map((model, modelIndex) => {
		const candidate = text(model, `lanes[${index}].modelCandidates[${modelIndex}]`, 256);
		if (!NAME.test(candidate) || !candidate.includes("/")) throw new Error(`lanes[${index}].modelCandidates[${modelIndex}] is not canonical.`);
		return candidate;
	});
	if (new Set(modelCandidates).size !== modelCandidates.length) throw new Error(`lanes[${index}].modelCandidates must be unique.`);
	const launchContractDigest = text(lane.launchContractDigest, `lanes[${index}].launchContractDigest`, 64);
	if (!DIGEST.test(launchContractDigest)) throw new Error(`lanes[${index}].launchContractDigest must be a lowercase SHA-256 digest.`);
	return { key, agent, modelCandidates, launchContractDigest };
}

function normalizePermit(input: LaunchAuthorityPermitInput): Omit<PermitRecord, "token" | "expiresAt" | "state"> {
	if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("permit input must be an object.");
	const configRevision = text(input.configRevision, "configRevision");
	const requestDigest = text(input.requestDigest, "requestDigest", 64);
	if (!DIGEST.test(requestDigest)) throw new Error("requestDigest must be a lowercase SHA-256 digest.");
	const expiresInMs = safeInteger(input.expiresInMs, "expiresInMs", 1, MAX_EXPIRY_MS);
	const minLanes = safeInteger(input.minLanes, "minLanes", 1, MAX_LANES);
	const maxLanes = safeInteger(input.maxLanes, "maxLanes", minLanes, MAX_LANES);
	if (!Array.isArray(input.lanes) || input.lanes.length < minLanes || input.lanes.length > maxLanes) {
		throw new Error(`lanes must contain between ${minLanes} and ${maxLanes} entries.`);
	}
	const lanes = input.lanes.map(cloneLane);
	if (new Set(lanes.map((lane) => lane.key)).size !== lanes.length) throw new Error("lane keys must be unique.");
	return { configRevision, expiresInMs, requestDigest, minLanes, maxLanes, lanes };
}

function stableJson(value: unknown, state: { depth: number; properties: number; seen: Set<object> }, path: string): string {
	if (value === null) return "null";
	if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new Error(`${path} must contain only finite JSON numbers.`);
		return JSON.stringify(value);
	}
	if (value === undefined) return "undefined";
	if (typeof value !== "object") throw new Error(`${path} must be JSON-compatible.`);
	if (state.depth >= MAX_DEPTH) throw new Error(`${path} exceeds maximum depth ${MAX_DEPTH}.`);
	if (state.seen.has(value)) throw new Error(`${path} contains a cycle.`);
	state.seen.add(value);
	state.depth += 1;
	let result: string;
	if (Array.isArray(value)) {
		result = `[${value.map((entry, index) => {
			if (entry === undefined) throw new Error(`${path}[${index}] must not be undefined.`);
			return stableJson(entry, state, `${path}[${index}]`);
		}).join(",")}]`;
	} else {
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) throw new Error(`${path} must contain only plain objects.`);
		const entries = Object.entries(value as Record<string, unknown>)
			.filter(([, entry]) => entry !== undefined)
			.sort(([left], [right]) => left.localeCompare(right));
		state.properties += entries.length;
		if (state.properties > MAX_PROPERTIES) throw new Error(`${path} exceeds ${MAX_PROPERTIES} properties.`);
		result = `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry, state, `${path}.${key}`)}`).join(",")}}`;
	}
	state.depth -= 1;
	state.seen.delete(value);
	return result;
}

export function digestSubagentLaunchRequest(params: Record<string, unknown>): string {
	if (!params || typeof params !== "object" || Array.isArray(params)) throw new Error("launch params must be a plain object.");
	for (const forbidden of ["authorization", "launchPermit", "launchPermits"]) {
		if (Object.hasOwn(params, forbidden)) throw new Error(`launch params must not contain authorization field '${forbidden}'.`);
	}
	const canonical = stableJson(params, { depth: 0, properties: 0, seen: new Set() }, "launch params");
	if (Buffer.byteLength(canonical, "utf8") > MAX_REQUEST_BYTES) throw new Error(`launch params exceed the ${MAX_REQUEST_BYTES}-byte size limit.`);
	return createHash("sha256").update(canonical).digest("hex");
}

export function classifySubagentLaunchRequest(params: Record<string, unknown>): SubagentLaunchRequestKind {
	const action = typeof params.action === "string" ? params.action.trim() : undefined;
	return action && SAFE_MANAGEMENT_ACTIONS.has(action) ? "management" : "new-spawn";
}

export function registerSubagentLaunchAuthority(options: RegisterSubagentLaunchAuthorityOptions): SubagentLaunchAuthorityHandle {
	const sessionId = text(options.sessionId, "launch authority sessionId");
	const source = text(options.source, "launch authority source");
	if (options.defaultNewSpawnDecision !== "deny") throw new Error("launch authority defaultNewSpawnDecision must be 'deny'.");
	if (options.validateConfigRevision !== undefined && typeof options.validateConfigRevision !== "function") throw new Error("validateConfigRevision must be a function.");
	const store = registry();
	let session = store.get(sessionId);
	if (!session) {
		session = new Map();
		store.set(sessionId, session);
	}
	if (session.size >= MAX_AUTHORITIES) throw new Error(`A session supports at most ${MAX_AUTHORITIES} launch authorities.`);
	const id = Symbol(source);
	const registration: Registration = {
		source,
		...(options.validateConfigRevision ? { validateConfigRevision: options.validateConfigRevision } : {}),
		permits: new Map(),
		disposed: false,
	};
	session.set(id, registration);
	return {
		issueOnce(input) {
			if (registration.disposed) throw new Error("Cannot issue from a disposed launch authority.");
			const normalized = normalizePermit(input);
			let token: string;
			do token = randomBytes(32).toString("base64url"); while (registration.permits.has(token));
			registration.permits.set(token, {
				...normalized,
				token,
				expiresAt: Date.now() + normalized.expiresInMs,
				state: "issued",
			});
			return token;
		},
		revokeUnused() {
			if (registration.disposed) return;
			for (const permit of registration.permits.values()) if (permit.state === "issued") permit.state = "consumed";
		},
		dispose() {
			if (registration.disposed) return;
			registration.disposed = true;
			registration.permits.clear();
			session!.delete(id);
			if (session!.size === 0) store.delete(sessionId);
		},
	};
}

function denied(code: Exclude<SubagentLaunchAdmission, { ok: true }>["code"], message: string): SubagentLaunchAdmission {
	return { ok: false, code, message };
}

export async function authorizeSubagentLaunch(input: {
	sessionId?: string | null;
	params: Record<string, unknown>;
	permits?: readonly string[];
}): Promise<SubagentLaunchAdmission> {
	const sessionId = input.sessionId?.trim();
	const registrations = sessionId ? registry().get(sessionId) : undefined;
	if (!registrations?.size) return { ok: true, authorities: [] };
	if (classifySubagentLaunchRequest(input.params) === "management") return { ok: true, authorities: [] };
	const requestDigest = digestSubagentLaunchRequest(input.params);
	const supplied = input.permits ?? [];
	if (!Array.isArray(supplied) || supplied.length > MAX_AUTHORITIES || supplied.some((token) => typeof token !== "string" || token.length > 128)) {
		return denied("invalid_permit", "Launch authorization contains invalid permit tokens.");
	}
	const selected: Array<{ registration: Registration; permit: PermitRecord }> = [];
	const consumeSelected = () => { for (const entry of selected) entry.permit.state = "consumed"; };
	for (const registration of [...registrations.values()].sort((left, right) => left.source.localeCompare(right.source))) {
		const permit = supplied.map((token) => registration.permits.get(token)).find((candidate) => candidate !== undefined);
		if (!permit) {
			consumeSelected();
			return denied("permit_required", `Launch authority '${registration.source}' requires a permit.`);
		}
		selected.push({ registration, permit });
		if (permit.state !== "issued") {
			consumeSelected();
			return denied("invalid_permit", `Launch permit for '${registration.source}' is not reusable.`);
		}
		if (permit.expiresAt <= Date.now()) {
			consumeSelected();
			return denied("expired_permit", `Launch permit for '${registration.source}' expired.`);
		}
		if (permit.requestDigest !== requestDigest) {
			consumeSelected();
			return denied("request_mismatch", `Launch request does not match the permit from '${registration.source}'.`);
		}
	}
	for (const entry of selected) entry.permit.state = "validating";
	let revisions: boolean[];
	try {
		revisions = await Promise.all(selected.map(async ({ registration, permit }) =>
			registration.validateConfigRevision ? await registration.validateConfigRevision(permit.configRevision) : true));
	} catch {
		revisions = selected.map(() => false);
	}
	consumeSelected();
	const invalidIndex = revisions.findIndex((valid) => valid !== true);
	if (invalidIndex !== -1) {
		return denied("config_revision_mismatch", `Launch permit config revision is no longer valid for '${selected[invalidIndex]!.registration.source}'.`);
	}
	return {
		ok: true,
		authorities: selected.map(({ registration, permit }) => ({
			source: registration.source,
			configRevision: permit.configRevision,
			minLanes: permit.minLanes,
			maxLanes: permit.maxLanes,
			lanes: permit.lanes.map((lane) => ({ ...lane, modelCandidates: [...lane.modelCandidates] })),
		})),
	};
}
