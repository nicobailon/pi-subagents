import { createHash, randomBytes } from "node:crypto";

export const SUBAGENT_LAUNCH_AUTHORITY_VERSION = 1 as const;
const REGISTRY_SYMBOL = Symbol.for("pi-subagents.launch-authority.v1");

const MAX_REQUEST_BYTES = 1_048_576;
const MAX_DEPTH = 32;
const MAX_PROPERTIES = 4_096;
const MAX_AUTHORITIES = 16;
const MAX_LANES = 256;
const MAX_MODELS = 16;
const MAX_TEXT_BYTES = 256;
const MAX_EXPIRY_MS = 60_000;
const MAX_OUTSTANDING_PERMITS = 64;
const MAX_TOMBSTONES = 256;
const DEFAULT_VALIDATION_TIMEOUT_MS = 1_500;
const MAX_VALIDATION_TIMEOUT_MS = 5_000;
const DIGEST = /^[a-f0-9]{64}$/u;
const KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const NAME = /^[A-Za-z0-9_.:/-]{1,128}$/u;

const SAFE_MANAGEMENT_ACTIONS = new Set([
	"list", "get", "models", "guide", "doctor", "debug.run",
	"status", "stop", "interrupt", "children.list",
	"mission.list", "mission.show", "refine.show",
	"inspector.status", "project.status",
	"watchdog.status", "watchdog.check", "watchdog.recommend-model",
	"schedule.list", "schedule.show", "schedule.history", "schedule.pause", "schedule.delete",
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
	validationTimeoutMs?: number;
	validateConfigRevision?(revision: string, signal: AbortSignal): boolean | Promise<boolean>;
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
	| {
		ok: true;
		authorities: AuthorizedLaunchAuthority[];
		commit(actualLanes: readonly LaunchAuthorityLane[]): Promise<SubagentLaunchAdmission>;
		cancel(): void;
	}
	| {
		ok: false;
		code: "permit_required" | "invalid_permit" | "expired_permit" | "request_mismatch" | "config_revision_mismatch";
		message: string;
	};

interface PermitRecord extends LaunchAuthorityPermitInput {
	token: string;
	expiresAt: number;
	state: "issued" | "validating";
}

interface Registration {
	id: symbol;
	source: string;
	validateConfigRevision?: RegisterSubagentLaunchAuthorityOptions["validateConfigRevision"];
	validationTimeoutMs: number;
	permits: Map<string, PermitRecord>;
	tombstones: Set<string>;
	tombstoneOrder: string[];
	disposed: boolean;
}

interface SessionRegistry {
	generation: number;
	registrations: Map<symbol, Registration>;
}

interface Registry {
	sessions: Map<string, SessionRegistry>;
}

interface BoundAuthorization {
	permits: string[];
	domain: string;
}

const boundAuthorizations = new WeakMap<object, BoundAuthorization>();

/** Bind opaque transport metadata to normalized params without making it schema/model-visible. */
export function bindSubagentLaunchPermits(params: object, permits: readonly string[], domain = "public"): void {
	boundAuthorizations.set(params, { permits: [...permits], domain: validateDomain(domain) });
}

/** Consume transport metadata exactly once at an execution admission boundary. */
export function takeBoundSubagentLaunchAuthorization(params: object, fallbackDomain = "public"): BoundAuthorization {
	const authorization = boundAuthorizations.get(params) ?? { permits: [], domain: validateDomain(fallbackDomain) };
	boundAuthorizations.delete(params);
	return { permits: [...authorization.permits], domain: authorization.domain };
}

/** Compatibility helper for transport tests that need only the opaque token list. */
export function takeBoundSubagentLaunchPermits(params: object): string[] {
	return takeBoundSubagentLaunchAuthorization(params).permits;
}

function registry(): Registry {
	const root = globalThis as unknown as Record<symbol, unknown>;
	const existing = root[REGISTRY_SYMBOL];
	if (existing && typeof existing === "object" && (existing as Registry).sessions instanceof Map) return existing as Registry;
	const created: Registry = { sessions: new Map() };
	root[REGISTRY_SYMBOL] = created;
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

function validateDomain(value: unknown): string {
	const domain = text(value, "launch request domain", 64);
	if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u.test(domain)) throw new Error("launch request domain is invalid.");
	return domain;
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
	if (value === undefined) throw new Error(`${path} must not be undefined.`);
	if (typeof value !== "object") throw new Error(`${path} must be JSON-compatible.`);
	if (state.depth >= MAX_DEPTH) throw new Error(`${path} exceeds maximum depth ${MAX_DEPTH}.`);
	if (state.seen.has(value)) throw new Error(`${path} contains a cycle.`);
	state.seen.add(value);
	state.depth += 1;
	let result: string;
	if (Array.isArray(value)) {
		result = `[${value.map((entry, index) => stableJson(entry, state, `${path}[${index}]`)).join(",")}]`;
	} else {
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) throw new Error(`${path} must contain only plain objects.`);
		const descriptors = Object.getOwnPropertyDescriptors(value);
		for (const [key, descriptor] of Object.entries(descriptors)) {
			if (descriptor.get || descriptor.set) throw new Error(`${path}.${key} must not be an accessor.`);
		}
		const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
		state.properties += entries.length;
		if (state.properties > MAX_PROPERTIES) throw new Error(`${path} exceeds ${MAX_PROPERTIES} properties.`);
		result = `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry, state, `${path}.${key}`)}`).join(",")}}`;
	}
	state.depth -= 1;
	state.seen.delete(value);
	return result;
}

export function digestSubagentLaunchRequest(params: Record<string, unknown>, domain = "public"): string {
	if (!params || typeof params !== "object" || Array.isArray(params)) throw new Error("launch params must be a plain object.");
	for (const forbidden of ["authorization", "launchPermit", "launchPermits"]) {
		if (Object.hasOwn(params, forbidden)) throw new Error(`launch params must not contain authorization field '${forbidden}'.`);
	}
	const canonical = stableJson({ version: SUBAGENT_LAUNCH_AUTHORITY_VERSION, domain: validateDomain(domain), params }, { depth: 0, properties: 0, seen: new Set() }, "launch request");
	if (Buffer.byteLength(canonical, "utf8") > MAX_REQUEST_BYTES) throw new Error(`launch params exceed the ${MAX_REQUEST_BYTES}-byte size limit.`);
	return createHash("sha256").update(canonical).digest("hex");
}

export function classifySubagentLaunchRequest(params: Record<string, unknown>): SubagentLaunchRequestKind {
	const action = typeof params.action === "string" ? params.action.trim() : undefined;
	if (action === "steer") return params.steeringRecovery === false ? "management" : "new-spawn";
	return action && SAFE_MANAGEMENT_ACTIONS.has(action) ? "management" : "new-spawn";
}

function rememberTombstone(registration: Registration, token: string): void {
	registration.tombstones.add(token);
	registration.tombstoneOrder.push(token);
	while (registration.tombstoneOrder.length > MAX_TOMBSTONES) {
		const oldest = registration.tombstoneOrder.shift();
		if (oldest) registration.tombstones.delete(oldest);
	}
}

function consume(registration: Registration, permit: PermitRecord): void {
	registration.permits.delete(permit.token);
	rememberTombstone(registration, permit.token);
}

function pruneExpired(registration: Registration, now = Date.now()): void {
	for (const permit of [...registration.permits.values()]) {
		if (permit.expiresAt <= now && permit.state === "issued") consume(registration, permit);
	}
}

export function hasActiveSubagentLaunchAuthority(sessionId?: string | null): boolean {
	const store = registry();
	if (sessionId?.trim()) return Boolean(store.sessions.get(sessionId.trim())?.registrations.size);
	return [...store.sessions.values()].some((session) => session.registrations.size > 0);
}

export function registerSubagentLaunchAuthority(options: RegisterSubagentLaunchAuthorityOptions): SubagentLaunchAuthorityHandle {
	const sessionId = text(options.sessionId, "launch authority sessionId");
	const source = text(options.source, "launch authority source");
	if (options.defaultNewSpawnDecision !== "deny") throw new Error("launch authority defaultNewSpawnDecision must be 'deny'.");
	if (options.validateConfigRevision !== undefined && typeof options.validateConfigRevision !== "function") throw new Error("validateConfigRevision must be a function.");
	const validationTimeoutMs = options.validationTimeoutMs === undefined
		? DEFAULT_VALIDATION_TIMEOUT_MS
		: safeInteger(options.validationTimeoutMs, "validationTimeoutMs", 1, MAX_VALIDATION_TIMEOUT_MS);
	const store = registry();
	let session = store.sessions.get(sessionId);
	if (!session) {
		session = { generation: 0, registrations: new Map() };
		store.sessions.set(sessionId, session);
	}
	if (session.registrations.size >= MAX_AUTHORITIES) throw new Error(`A session supports at most ${MAX_AUTHORITIES} launch authorities.`);
	const id = Symbol(source);
	const registration: Registration = {
		id,
		source,
		...(options.validateConfigRevision ? { validateConfigRevision: options.validateConfigRevision } : {}),
		validationTimeoutMs,
		permits: new Map(),
		tombstones: new Set(),
		tombstoneOrder: [],
		disposed: false,
	};
	session.registrations.set(id, registration);
	session.generation += 1;
	return {
		issueOnce(input) {
			if (registration.disposed) throw new Error("Cannot issue from a disposed launch authority.");
			pruneExpired(registration);
			if (registration.permits.size >= MAX_OUTSTANDING_PERMITS) throw new Error(`Launch authority has reached its ${MAX_OUTSTANDING_PERMITS} outstanding permit limit.`);
			const normalized = normalizePermit(input);
			let token: string;
			do token = randomBytes(32).toString("base64url"); while (registration.permits.has(token) || registration.tombstones.has(token));
			registration.permits.set(token, { ...normalized, token, expiresAt: Date.now() + normalized.expiresInMs, state: "issued" });
			return token;
		},
		revokeUnused() {
			if (registration.disposed) return;
			for (const permit of [...registration.permits.values()]) consume(registration, permit);
			session!.generation += 1;
		},
		dispose() {
			if (registration.disposed) return;
			registration.disposed = true;
			for (const permit of [...registration.permits.values()]) consume(registration, permit);
			session!.registrations.delete(id);
			session!.generation += 1;
			if (session!.registrations.size === 0) store.sessions.delete(sessionId);
		},
	};
}

export function verifyAuthorizedLaunchManifest(
	authorities: readonly AuthorizedLaunchAuthority[],
	actualLanes: readonly LaunchAuthorityLane[],
): void {
	for (const authority of authorities) {
		if (actualLanes.length < authority.minLanes || actualLanes.length > authority.maxLanes || actualLanes.length !== authority.lanes.length) {
			throw new Error(`Launch manifest does not satisfy authority '${authority.source}' lane bounds or cardinality.`);
		}
		for (let index = 0; index < actualLanes.length; index += 1) {
			const expected = authority.lanes[index]!;
			const actual = actualLanes[index]!;
			if (actual.key !== expected.key
				|| actual.agent !== expected.agent
				|| actual.launchContractDigest !== expected.launchContractDigest
				|| actual.modelCandidates.length !== expected.modelCandidates.length
				|| actual.modelCandidates.some((model, modelIndex) => model !== expected.modelCandidates[modelIndex])) {
				throw new Error(`Launch manifest lane ${index} does not match authority '${authority.source}'.`);
			}
		}
	}
}

function denied(code: Exclude<SubagentLaunchAdmission, { ok: true }>["code"], message: string): SubagentLaunchAdmission {
	return { ok: false, code, message };
}

function accepted(authorities: AuthorizedLaunchAuthority[] = []): SubagentLaunchAdmission {
	let result: SubagentLaunchAdmission;
	result = {
		ok: true,
		authorities,
		commit: async () => result,
		cancel() {},
	};
	return result;
}

async function validateRevision(registration: Registration, revision: string): Promise<boolean> {
	if (!registration.validateConfigRevision) return true;
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			Promise.resolve(registration.validateConfigRevision(revision, controller.signal)).then((value) => value === true),
			new Promise<boolean>((resolve) => {
				timer = setTimeout(() => {
					controller.abort(new Error("Launch authority revision validation timed out."));
					resolve(false);
				}, registration.validationTimeoutMs);
			}),
		]);
	} catch {
		return false;
	} finally {
		if (timer) clearTimeout(timer);
	}
}

export async function authorizeSubagentLaunch(input: {
	sessionId?: string | null;
	params: Record<string, unknown>;
	permits?: readonly string[];
	domain?: string;
}): Promise<SubagentLaunchAdmission> {
	const store = registry();
	const sessionId = input.sessionId?.trim();
	if (!sessionId) {
		return hasActiveSubagentLaunchAuthority()
			? denied("permit_required", "Launch authority cannot admit a new spawn without an authoritative session id.")
			: accepted();
	}
	const session = store.sessions.get(sessionId);
	if (!session?.registrations.size) return accepted();
	if (classifySubagentLaunchRequest(input.params) === "management") return accepted();
	const requestDigest = digestSubagentLaunchRequest(input.params, input.domain ?? "public");
	const supplied = input.permits ?? [];
	if (!Array.isArray(supplied) || supplied.length > MAX_AUTHORITIES || supplied.some((token) => typeof token !== "string" || token.length > 128) || new Set(supplied).size !== supplied.length) {
		return denied("invalid_permit", "Launch authorization contains invalid permit tokens.");
	}
	const generation = session.generation;
	const registrations = [...session.registrations.values()].sort((left, right) => left.source.localeCompare(right.source));
	const selected: Array<{ registration: Registration; permit: PermitRecord }> = [];
	const consumeSelected = () => { for (const { registration, permit } of selected) consume(registration, permit); };
	const consumeSuppliedIssued = () => {
		for (const registration of registrations) {
			for (const token of supplied) {
				const permit = registration.permits.get(token);
				if (permit?.state === "issued") consume(registration, permit);
			}
		}
	};
	for (const token of supplied) {
		const owners = registrations.filter((registration) => registration.permits.has(token) || registration.tombstones.has(token));
		if (owners.length !== 1) {
			consumeSuppliedIssued();
			return denied("invalid_permit", "Launch authorization contains an unknown or ambiguous permit.");
		}
	}
	if (supplied.length !== registrations.length) {
		for (const registration of registrations) {
			for (const token of supplied) {
				const permit = registration.permits.get(token);
				if (permit && !selected.some((entry) => entry.permit === permit)) selected.push({ registration, permit });
			}
		}
		consumeSelected();
		return denied(supplied.length < registrations.length ? "permit_required" : "invalid_permit", "Every active launch authority requires exactly one permit.");
	}
	for (const registration of registrations) {
		const ownedTokens = supplied.filter((token) => registration.permits.has(token) || registration.tombstones.has(token));
		if (ownedTokens.length !== 1) {
			consumeSelected();
			return denied("invalid_permit", `Launch authority '${registration.source}' requires exactly one owned permit.`);
		}
		const token = ownedTokens[0]!;
		if (registration.tombstones.has(token)) {
			consumeSelected();
			return denied("invalid_permit", `Launch permit for '${registration.source}' is not reusable.`);
		}
		const permit = registration.permits.get(token)!;
		if (permit.state !== "issued") {
			consumeSelected();
			return denied("invalid_permit", `Launch permit for '${registration.source}' is already being validated.`);
		}
		selected.push({ registration, permit });
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
	const revisions = await Promise.all(selected.map(({ registration, permit }) => validateRevision(registration, permit.configRevision)));
	const registryStable = store.sessions.get(sessionId) === session
		&& session.generation === generation
		&& selected.every(({ registration, permit }) =>
			!registration.disposed
			&& session.registrations.get(registration.id) === registration
			&& registration.permits.get(permit.token) === permit
			&& permit.state === "validating"
			&& permit.expiresAt > Date.now());
	if (!registryStable || revisions.some((valid) => !valid)) {
		consumeSelected();
		return denied("config_revision_mismatch", "Launch authority state or config revision changed before admission committed.");
	}
	const authorities = selected.map(({ registration, permit }) => ({
		source: registration.source,
		configRevision: permit.configRevision,
		minLanes: permit.minLanes,
		maxLanes: permit.maxLanes,
		lanes: permit.lanes.map((lane) => ({ ...lane, modelCandidates: [...lane.modelCandidates] })),
	}));
	let settled = false;
	const expiryTimer = setTimeout(() => {
		if (settled) return;
		settled = true;
		consumeSelected();
	}, Math.max(1, Math.min(...selected.map(({ permit }) => permit.expiresAt - Date.now()))));
	expiryTimer.unref?.();
	const cancel = () => {
		if (settled) return;
		settled = true;
		clearTimeout(expiryTimer);
		consumeSelected();
	};
	const reservation: SubagentLaunchAdmission = {
		ok: true,
		authorities,
		async commit(actualLanes) {
			if (settled) return denied("invalid_permit", "Launch admission reservation is no longer active.");
			try {
				verifyAuthorizedLaunchManifest(authorities, actualLanes);
			} catch (error) {
				cancel();
				return denied("request_mismatch", error instanceof Error ? error.message : String(error));
			}
			const finalRevisions = await Promise.all(selected.map(({ registration, permit }) => validateRevision(registration, permit.configRevision)));
			const finalStable = !settled
				&& store.sessions.get(sessionId) === session
				&& session.generation === generation
				&& selected.every(({ registration, permit }) =>
					!registration.disposed
					&& session.registrations.get(registration.id) === registration
					&& registration.permits.get(permit.token) === permit
					&& permit.state === "validating"
					&& permit.expiresAt > Date.now()
					&& permit.requestDigest === requestDigest);
			if (!finalStable || finalRevisions.some((valid) => !valid)) {
				cancel();
				return denied("config_revision_mismatch", "Launch authority state or config revision changed during runtime manifest preflight.");
			}
			settled = true;
			clearTimeout(expiryTimer);
			consumeSelected();
			return accepted(authorities);
		},
		cancel,
	};
	return reservation;
}
