import { Buffer } from "node:buffer";

export const SUBAGENT_LAUNCH_AUTHORIZATION_VERSION = 1 as const;
export const SUBAGENT_LAUNCH_AUTHORIZATION_REGISTRY_KEY = "pi-subagents.launch-authorization.v1";
export const SUBAGENT_LAUNCH_AUTHORIZATION_ENV = "PI_SUBAGENT_LAUNCH_AUTHORIZATION_V1";

const MAX_PROVIDERS = 100;
const MAX_AGENTS_PER_PROVIDER = 256;
const MAX_DETACHED_APPROVALS = 256;
const MAX_ENV_BYTES = 64 * 1024;
const MAX_ID_BYTES = 512;
const MAX_PATH_BYTES = 16 * 1024;
const MAX_REASON_BYTES = 4 * 1024;
const AGENT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
const PROVIDER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;

export type SubagentLaunchAuthorizationOrigin = "tool" | "rpc" | "delegation" | "schedule" | "workflow" | "internal";
export type SubagentLaunchAuthorizationRunner = "native" | "external-cli" | "external-job";
export type SubagentLaunchAuthorizationAgentSource = "builtin" | "package" | "user" | "project" | "runtime";

export interface SubagentLaunchAuthorizationInvocation {
	id: string;
	origin: SubagentLaunchAuthorizationOrigin;
	parentId?: string;
	workflowRunId?: string;
	workflowKey?: string;
}

export interface SubagentLaunchAuthorizationRequest {
	version: typeof SUBAGENT_LAUNCH_AUTHORIZATION_VERSION;
	sessionId?: string;
	invocation: SubagentLaunchAuthorizationInvocation;
	run: {
		id: string;
		childIndex: number;
		modelAttempt: number;
		startupAttempt: number;
		async: boolean;
	};
	agent: {
		name: string;
		source: SubagentLaunchAuthorizationAgentSource;
		filePath: string;
		definitionDigest: string;
		runner: SubagentLaunchAuthorizationRunner;
	};
	contract: {
		launchContractDigest: string;
		context?: "fresh" | "fork";
		model?: string;
		modelCandidates: readonly string[];
	};
}

export type SubagentLaunchAuthorizationDecision =
	| { decision: "allow" }
	| { decision: "deny"; reason: string };

export interface SubagentLaunchAuthorizationProvider {
	name: string;
	sessionId: string;
	agents: readonly string[];
	authorize(request: Readonly<SubagentLaunchAuthorizationRequest>): SubagentLaunchAuthorizationDecision;
}

export interface SubagentLaunchAuthorizationReservation {
	provider: string;
	agents: readonly string[];
}

export interface ResolvedSubagentLaunchAuthorizationReservations {
	version: typeof SUBAGENT_LAUNCH_AUTHORIZATION_VERSION;
	providers: readonly SubagentLaunchAuthorizationReservation[];
}

/** Package-owned proof that every matching provider allowed one exact detached attempt. */
export interface ResolvedSubagentLaunchAuthorizationApproval {
	version: typeof SUBAGENT_LAUNCH_AUTHORIZATION_VERSION;
	request: Readonly<SubagentLaunchAuthorizationRequest>;
	providers: readonly string[];
}

/** Prompt-free authorization state serialized only to the package-owned detached runner config. */
export interface DetachedSubagentLaunchAuthorizationContext {
	version: typeof SUBAGENT_LAUNCH_AUTHORIZATION_VERSION;
	sessionId?: string;
	invocation: SubagentLaunchAuthorizationInvocation;
	agent: {
		source: SubagentLaunchAuthorizationAgentSource;
		filePath: string;
	};
	approvals: readonly ResolvedSubagentLaunchAuthorizationApproval[];
}

export interface DetachedSubagentLaunchAuthorizationAttempt {
	run: {
		id: string;
		childIndex: number;
		modelAttempt: number;
		startupAttempt: number;
	};
	agent: {
		name: string;
		definitionDigest: string;
		runner: SubagentLaunchAuthorizationRunner;
	};
	contract: {
		launchContractDigest: string;
		context?: "fresh" | "fork";
		model?: string;
		modelCandidates: readonly string[];
	};
}

interface RegisteredProvider {
	name: string;
	sessionId: string;
	agents: readonly string[];
	authorize: SubagentLaunchAuthorizationProvider["authorize"];
}

interface LaunchAuthorizationRegistry {
	version: typeof SUBAGENT_LAUNCH_AUTHORIZATION_VERSION;
	bySession: Map<string, Map<string, RegisteredProvider>>;
}

function existingRegistry(): LaunchAuthorizationRegistry | undefined {
	const key = Symbol.for(SUBAGENT_LAUNCH_AUTHORIZATION_REGISTRY_KEY);
	const existing = (globalThis as Record<PropertyKey, unknown>)[key];
	if (existing === undefined) return undefined;
	if (!existing || typeof existing !== "object" || Array.isArray(existing)) {
		throw new Error(`Malformed launch-authorization registry at Symbol.for("${SUBAGENT_LAUNCH_AUTHORIZATION_REGISTRY_KEY}").`);
	}
	const candidate = existing as Partial<LaunchAuthorizationRegistry>;
	if (candidate.version !== SUBAGENT_LAUNCH_AUTHORIZATION_VERSION || !(candidate.bySession instanceof Map)) {
		throw new Error(`Unsupported launch-authorization registry at Symbol.for("${SUBAGENT_LAUNCH_AUTHORIZATION_REGISTRY_KEY}").`);
	}
	return candidate as LaunchAuthorizationRegistry;
}

function registry(): LaunchAuthorizationRegistry {
	const existing = existingRegistry();
	if (existing) return existing;
	const created: LaunchAuthorizationRegistry = {
		version: SUBAGENT_LAUNCH_AUTHORIZATION_VERSION,
		bySession: new Map(),
	};
	(globalThis as Record<PropertyKey, unknown>)[Symbol.for(SUBAGENT_LAUNCH_AUTHORIZATION_REGISTRY_KEY)] = created;
	return created;
}

function validateText(value: unknown, field: string, maxBytes = MAX_ID_BYTES): string {
	if (typeof value !== "string" || !value.trim() || value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) {
		throw new Error(`${field} must be a non-empty string without surrounding whitespace or control characters.`);
	}
	if (Buffer.byteLength(value, "utf8") > maxBytes) throw new Error(`${field} exceeds ${maxBytes} UTF-8 bytes.`);
	return value;
}

function validateProviderName(value: unknown, field: string): string {
	const name = validateText(value, field, 128);
	if (!PROVIDER_NAME_PATTERN.test(name)) throw new Error(`${field} has an invalid provider name.`);
	return name;
}

function validateAgentName(value: unknown, field: string): string {
	const name = validateText(value, field, 128);
	if (!AGENT_NAME_PATTERN.test(name)) throw new Error(`${field} has an invalid agent name.`);
	return name;
}

function validateDigest(value: unknown, field: string): string {
	if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) throw new Error(`${field} must be a lowercase SHA-256 digest.`);
	return value;
}

function normalizeAgents(value: unknown, field: string): readonly string[] {
	if (!Array.isArray(value) || value.length === 0 || value.length > MAX_AGENTS_PER_PROVIDER) {
		throw new Error(`${field} must contain between 1 and ${MAX_AGENTS_PER_PROVIDER} agent names.`);
	}
	return Object.freeze([...new Set(value.map((entry, index) => validateAgentName(entry, `${field}[${index}]`)))].sort());
}

function validateProvider(value: unknown): RegisteredProvider {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Launch-authorization provider must be an object.");
	const input = value as Record<string, unknown>;
	const unknown = Object.keys(input).filter((key) => !["name", "sessionId", "agents", "authorize"].includes(key));
	if (unknown.length > 0) throw new Error(`Launch-authorization provider has unknown fields: ${unknown.join(", ")}.`);
	const name = validateProviderName(input.name, "Launch-authorization provider name");
	const sessionId = validateText(input.sessionId, `Launch-authorization provider '${name}' sessionId`);
	const agents = normalizeAgents(input.agents, `Launch-authorization provider '${name}' agents`);
	if (typeof input.authorize !== "function") throw new Error(`Launch-authorization provider '${name}' must expose authorize().`);
	return Object.freeze({
		name,
		sessionId,
		agents,
		authorize: input.authorize as SubagentLaunchAuthorizationProvider["authorize"],
	});
}

function normalizeReservation(value: unknown, index: number): SubagentLaunchAuthorizationReservation {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Launch-authorization reservation ${index} must be an object.`);
	const input = value as Record<string, unknown>;
	const unknown = Object.keys(input).filter((key) => key !== "provider" && key !== "agents");
	if (unknown.length > 0) throw new Error(`Launch-authorization reservation ${index} has unknown fields: ${unknown.join(", ")}.`);
	return Object.freeze({
		provider: validateProviderName(input.provider, `Launch-authorization reservation ${index} provider`),
		agents: normalizeAgents(input.agents, `Launch-authorization reservation ${index} agents`),
	});
}

function normalizeReservations(value: unknown, field: string): ResolvedSubagentLaunchAuthorizationReservations {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid ${field}; expected an object.`);
	const input = value as Record<string, unknown>;
	const unknown = Object.keys(input).filter((key) => key !== "version" && key !== "providers");
	if (unknown.length > 0) throw new Error(`Invalid ${field}; unknown fields: ${unknown.join(", ")}.`);
	if (input.version !== SUBAGENT_LAUNCH_AUTHORIZATION_VERSION) throw new Error(`Invalid ${field} version.`);
	if (!Array.isArray(input.providers) || input.providers.length > MAX_PROVIDERS) {
		throw new Error(`Invalid ${field} providers; expected at most ${MAX_PROVIDERS} entries.`);
	}
	const byProvider = new Map<string, Set<string>>();
	input.providers.forEach((entry, index) => {
		const reservation = normalizeReservation(entry, index);
		const agents = byProvider.get(reservation.provider) ?? new Set<string>();
		for (const agent of reservation.agents) agents.add(agent);
		if (agents.size > MAX_AGENTS_PER_PROVIDER) throw new Error(`Invalid ${field}; provider '${reservation.provider}' exceeds ${MAX_AGENTS_PER_PROVIDER} agents.`);
		byProvider.set(reservation.provider, agents);
	});
	return Object.freeze({
		version: SUBAGENT_LAUNCH_AUTHORIZATION_VERSION,
		providers: Object.freeze([...byProvider]
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([provider, agents]) => Object.freeze({ provider, agents: Object.freeze([...agents].sort()) }))),
	});
}

function normalizeInvocation(value: SubagentLaunchAuthorizationInvocation): SubagentLaunchAuthorizationInvocation {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Launch authorization invocation must be an object.");
	const origins = new Set<SubagentLaunchAuthorizationOrigin>(["tool", "rpc", "delegation", "schedule", "workflow", "internal"]);
	if (!origins.has(value.origin)) throw new Error("Launch authorization invocation origin is invalid.");
	return Object.freeze({
		id: validateText(value.id, "Launch authorization invocation id"),
		origin: value.origin,
		...(value.parentId !== undefined ? { parentId: validateText(value.parentId, "Launch authorization parent invocation id") } : {}),
		...(value.workflowRunId !== undefined ? { workflowRunId: validateText(value.workflowRunId, "Launch authorization workflow run id") } : {}),
		...(value.workflowKey !== undefined ? { workflowKey: validateText(value.workflowKey, "Launch authorization workflow key") } : {}),
	});
}

function normalizeRequest(value: SubagentLaunchAuthorizationRequest): Readonly<SubagentLaunchAuthorizationRequest> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Launch authorization request must be an object.");
	if (value.version !== SUBAGENT_LAUNCH_AUTHORIZATION_VERSION) throw new Error("Launch authorization request version is invalid.");
	const sources = new Set<SubagentLaunchAuthorizationAgentSource>(["builtin", "package", "user", "project", "runtime"]);
	const runners = new Set<SubagentLaunchAuthorizationRunner>(["native", "external-cli", "external-job"]);
	if (!sources.has(value.agent.source)) throw new Error("Launch authorization agent source is invalid.");
	if (!runners.has(value.agent.runner)) throw new Error("Launch authorization agent runner is invalid.");
	for (const [field, entry] of [["childIndex", value.run.childIndex], ["modelAttempt", value.run.modelAttempt], ["startupAttempt", value.run.startupAttempt]] as const) {
		if (!Number.isInteger(entry) || entry < 0) throw new Error(`Launch authorization run ${field} must be a non-negative integer.`);
	}
	if (typeof value.run.async !== "boolean") throw new Error("Launch authorization run async must be a boolean.");
	if (!Array.isArray(value.contract.modelCandidates) || value.contract.modelCandidates.length > 64) {
		throw new Error("Launch authorization modelCandidates must contain at most 64 entries.");
	}
	const modelCandidates = Object.freeze(value.contract.modelCandidates.map((entry, index) => validateText(entry, `Launch authorization modelCandidates[${index}]`)));
	const context = value.contract.context;
	if (context !== undefined && context !== "fresh" && context !== "fork") throw new Error("Launch authorization context is invalid.");
	return Object.freeze({
		version: SUBAGENT_LAUNCH_AUTHORIZATION_VERSION,
		...(value.sessionId !== undefined ? { sessionId: validateText(value.sessionId, "Launch authorization sessionId") } : {}),
		invocation: normalizeInvocation(value.invocation),
		run: Object.freeze({
			id: validateText(value.run.id, "Launch authorization run id"),
			childIndex: value.run.childIndex,
			modelAttempt: value.run.modelAttempt,
			startupAttempt: value.run.startupAttempt,
			async: value.run.async,
		}),
		agent: Object.freeze({
			name: validateAgentName(value.agent.name, "Launch authorization agent name"),
			source: value.agent.source,
			filePath: validateText(value.agent.filePath, "Launch authorization agent filePath", MAX_PATH_BYTES),
			definitionDigest: validateDigest(value.agent.definitionDigest, "Launch authorization definitionDigest"),
			runner: value.agent.runner,
		}),
		contract: Object.freeze({
			launchContractDigest: validateDigest(value.contract.launchContractDigest, "Launch authorization launchContractDigest"),
			...(context ? { context } : {}),
			...(value.contract.model !== undefined ? { model: validateText(value.contract.model, "Launch authorization model") } : {}),
			modelCandidates,
		}),
	});
}

function validateDecision(value: unknown, provider: string): SubagentLaunchAuthorizationDecision {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Launch-authorization provider '${provider}' returned an invalid decision.`);
	const decision = value as Record<string, unknown>;
	if (decision.decision === "allow" && Object.keys(decision).length === 1) return { decision: "allow" };
	if (decision.decision === "deny" && Object.keys(decision).every((key) => key === "decision" || key === "reason")) {
		return { decision: "deny", reason: validateText(decision.reason, `Launch-authorization provider '${provider}' denial reason`, MAX_REASON_BYTES) };
	}
	throw new Error(`Launch-authorization provider '${provider}' returned an invalid decision.`);
}

function matchingProviderNames(
	reservations: ResolvedSubagentLaunchAuthorizationReservations | undefined,
	agent: string,
): readonly string[] {
	return Object.freeze((reservations?.providers ?? [])
		.filter((reservation) => reservation.agents.includes(agent))
		.map((reservation) => reservation.provider));
}

function launchAuthorizationRequestKey(request: Readonly<SubagentLaunchAuthorizationRequest>): string {
	return JSON.stringify(request);
}

function launchAuthorizationRequestCommonKey(request: Readonly<SubagentLaunchAuthorizationRequest>): string {
	return JSON.stringify({
		version: request.version,
		sessionId: request.sessionId,
		invocation: request.invocation,
		run: {
			id: request.run.id,
			childIndex: request.run.childIndex,
			async: request.run.async,
		},
		agent: request.agent,
		contract: {
			context: request.contract.context,
			modelCandidates: request.contract.modelCandidates,
		},
	});
}

function normalizeApproval(value: unknown, index: number): ResolvedSubagentLaunchAuthorizationApproval {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Detached launch authorization approval ${index} must be an object.`);
	const input = value as Record<string, unknown>;
	const unknown = Object.keys(input).filter((key) => !["version", "request", "providers"].includes(key));
	if (unknown.length > 0) throw new Error(`Detached launch authorization approval ${index} has unknown fields: ${unknown.join(", ")}.`);
	if (input.version !== SUBAGENT_LAUNCH_AUTHORIZATION_VERSION) throw new Error(`Detached launch authorization approval ${index} has an invalid version.`);
	if (!Array.isArray(input.providers) || input.providers.length === 0 || input.providers.length > MAX_PROVIDERS) {
		throw new Error(`Detached launch authorization approval ${index} must contain between 1 and ${MAX_PROVIDERS} providers.`);
	}
	const providers = input.providers.map((provider, providerIndex) => validateProviderName(provider, `Detached launch authorization approval ${index} providers[${providerIndex}]`));
	if (new Set(providers).size !== providers.length) throw new Error(`Detached launch authorization approval ${index} contains duplicate providers.`);
	return Object.freeze({
		version: SUBAGENT_LAUNCH_AUTHORIZATION_VERSION,
		request: normalizeRequest(input.request as SubagentLaunchAuthorizationRequest),
		providers: Object.freeze([...providers].sort()),
	});
}

function normalizeDetachedContext(value: unknown): DetachedSubagentLaunchAuthorizationContext {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Reserved agent has no exact detached launch authorization approval context.");
	const input = value as Record<string, unknown>;
	const unknown = Object.keys(input).filter((key) => !["version", "sessionId", "invocation", "agent", "approvals"].includes(key));
	if (unknown.length > 0) throw new Error(`Detached launch authorization context has unknown fields: ${unknown.join(", ")}.`);
	if (input.version !== SUBAGENT_LAUNCH_AUTHORIZATION_VERSION) throw new Error("Detached launch authorization context has an invalid version.");
	if (!input.agent || typeof input.agent !== "object" || Array.isArray(input.agent)) throw new Error("Detached launch authorization context agent must be an object.");
	const rawAgent = input.agent as Record<string, unknown>;
	const unknownAgent = Object.keys(rawAgent).filter((key) => key !== "source" && key !== "filePath");
	if (unknownAgent.length > 0) throw new Error(`Detached launch authorization context agent has unknown fields: ${unknownAgent.join(", ")}.`);
	const sources = new Set<SubagentLaunchAuthorizationAgentSource>(["builtin", "package", "user", "project", "runtime"]);
	if (!sources.has(rawAgent.source as SubagentLaunchAuthorizationAgentSource)) throw new Error("Detached launch authorization context agent source is invalid.");
	if (!Array.isArray(input.approvals) || input.approvals.length === 0 || input.approvals.length > MAX_DETACHED_APPROVALS) {
		throw new Error(`Detached launch authorization context must contain between 1 and ${MAX_DETACHED_APPROVALS} approvals.`);
	}
	const context = Object.freeze({
		version: SUBAGENT_LAUNCH_AUTHORIZATION_VERSION,
		...(input.sessionId !== undefined ? { sessionId: validateText(input.sessionId, "Detached launch authorization context sessionId") } : {}),
		invocation: normalizeInvocation(input.invocation as SubagentLaunchAuthorizationInvocation),
		agent: Object.freeze({
			source: rawAgent.source as SubagentLaunchAuthorizationAgentSource,
			filePath: validateText(rawAgent.filePath, "Detached launch authorization context agent filePath", MAX_PATH_BYTES),
		}),
		approvals: Object.freeze(input.approvals.map((approval, index) => normalizeApproval(approval, index))),
	});
	const first = context.approvals[0]!;
	const commonKey = launchAuthorizationRequestCommonKey(first.request);
	const contextIdentity = JSON.stringify({
		sessionId: context.sessionId,
		invocation: context.invocation,
		agent: context.agent,
	});
	const requestKeys = new Set<string>();
	for (const approval of context.approvals) {
		if (!approval.request.run.async) throw new Error("Detached launch authorization approvals must bind async child attempts.");
		if (launchAuthorizationRequestCommonKey(approval.request) !== commonKey) throw new Error("Detached launch authorization approvals must bind one exact logical child.");
		if (JSON.stringify({
			sessionId: approval.request.sessionId,
			invocation: approval.request.invocation,
			agent: { source: approval.request.agent.source, filePath: approval.request.agent.filePath },
		}) !== contextIdentity) throw new Error("Detached launch authorization approval identity does not match its context.");
		const requestKey = launchAuthorizationRequestKey(approval.request);
		if (requestKeys.has(requestKey)) throw new Error("Detached launch authorization context contains a duplicate exact attempt approval.");
		requestKeys.add(requestKey);
	}
	return context;
}

/**
 * Register or replace one exact-session launch-authorization provider. The old
 * disposer cannot remove a newer replacement registered under the same name.
 */
export function registerSubagentLaunchAuthorizationProvider(provider: SubagentLaunchAuthorizationProvider): () => void {
	const validated = validateProvider(provider);
	const current = registry();
	let session = current.bySession.get(validated.sessionId);
	if (!session) {
		session = new Map();
		current.bySession.set(validated.sessionId, session);
	}
	if (!session.has(validated.name) && session.size >= MAX_PROVIDERS) {
		throw new Error(`Launch-authorization registry supports at most ${MAX_PROVIDERS} providers per session.`);
	}
	session.set(validated.name, validated);
	return () => {
		if (session!.get(validated.name) === validated) session!.delete(validated.name);
		if (session!.size === 0 && current.bySession.get(validated.sessionId) === session) {
			current.bySession.delete(validated.sessionId);
		}
	};
}

export function decodeSubagentLaunchAuthorizationReservations(value: string | undefined): ResolvedSubagentLaunchAuthorizationReservations | undefined {
	if (value === undefined || value === "") return undefined;
	if (Buffer.byteLength(value, "utf8") > MAX_ENV_BYTES * 2) throw new Error("Invalid inherited launch authorization: encoded payload is too large.");
	let parsed: unknown;
	try {
		const decoded = Buffer.from(value, "base64url");
		if (decoded.byteLength > MAX_ENV_BYTES) throw new Error("decoded payload is too large");
		parsed = JSON.parse(decoded.toString("utf8"));
	} catch (error) {
		throw new Error(`Invalid inherited launch authorization: ${error instanceof Error ? error.message : String(error)}`);
	}
	return normalizeReservations(parsed, "inherited launch authorization");
}

export function encodeSubagentLaunchAuthorizationReservations(value: ResolvedSubagentLaunchAuthorizationReservations | undefined): string | undefined {
	if (!value) return undefined;
	const normalized = normalizeReservations(value, "launch authorization");
	const json = JSON.stringify(normalized);
	if (Buffer.byteLength(json, "utf8") > MAX_ENV_BYTES) throw new Error(`Launch authorization exceeds ${MAX_ENV_BYTES} UTF-8 bytes.`);
	return Buffer.from(json, "utf8").toString("base64url");
}

export function resolveSubagentLaunchAuthorizationReservations(
	sessionId: string | undefined,
	inherited = decodeSubagentLaunchAuthorizationReservations(process.env[SUBAGENT_LAUNCH_AUTHORIZATION_ENV]),
): ResolvedSubagentLaunchAuthorizationReservations | undefined {
	const normalizedInherited = inherited ? normalizeReservations(inherited, "inherited launch authorization") : undefined;
	const providers = new Map<string, Set<string>>();
	for (const reservation of normalizedInherited?.providers ?? []) {
		providers.set(reservation.provider, new Set(reservation.agents));
	}
	if (sessionId) {
		const local = registry().bySession.get(sessionId);
		for (const provider of local?.values() ?? []) {
			const agents = providers.get(provider.name) ?? new Set<string>();
			for (const agent of provider.agents) agents.add(agent);
			providers.set(provider.name, agents);
		}
	}
	if (providers.size === 0) return undefined;
	return normalizeReservations({
		version: SUBAGENT_LAUNCH_AUTHORIZATION_VERSION,
		providers: [...providers].map(([provider, agents]) => ({ provider, agents: [...agents] })),
	}, "launch authorization");
}

function authorizeSubagentLaunchAgainstReservations(
	input: SubagentLaunchAuthorizationRequest,
	reservations: ResolvedSubagentLaunchAuthorizationReservations | undefined,
): { request: Readonly<SubagentLaunchAuthorizationRequest>; providers: readonly string[] } {
	const request = normalizeRequest(input);
	const matching = matchingProviderNames(reservations, request.agent.name);
	const current = existingRegistry();
	const sessionProviders = request.sessionId ? current?.bySession.get(request.sessionId) : undefined;
	const authorized: string[] = [];
	for (const providerName of matching) {
		const provider = sessionProviders?.get(providerName);
		if (!provider || !provider.agents.includes(request.agent.name)) {
			throw new Error(`Launch-authorization provider '${providerName}' is unavailable for reserved agent '${request.agent.name}'.`);
		}
		let rawDecision: unknown;
		try {
			rawDecision = provider.authorize(request);
		} catch (error) {
			throw new Error(`Launch-authorization provider '${provider.name}' failed closed.`, { cause: error });
		}
		const decision = validateDecision(rawDecision, provider.name);
		if (decision.decision === "deny") {
			throw new Error(`Launch-authorization provider '${provider.name}' denied agent '${request.agent.name}': ${decision.reason}`);
		}
		authorized.push(provider.name);
	}
	return { request, providers: Object.freeze(authorized) };
}

/** Authorize one fully resolved child contract immediately before launch. */
export function authorizeSubagentLaunch(input: SubagentLaunchAuthorizationRequest): { providers: readonly string[] } {
	const inherited = process.env[SUBAGENT_LAUNCH_AUTHORIZATION_ENV];
	const current = existingRegistry();
	const local = typeof input?.sessionId === "string" ? current?.bySession.get(input.sessionId) : undefined;
	if (!inherited && !local?.size) return { providers: [] };
	const reservations = resolveSubagentLaunchAuthorizationReservations(input.sessionId);
	const rawAgentName = input?.agent?.name;
	if (typeof rawAgentName !== "string" || matchingProviderNames(reservations, rawAgentName).length === 0) return { providers: [] };
	const authorized = authorizeSubagentLaunchAgainstReservations(input, reservations);
	return { providers: authorized.providers };
}

/** Internal detached-runner handoff: authorize one exact request against one fixed reservation snapshot. */
export function createSubagentLaunchAuthorizationApproval(
	input: SubagentLaunchAuthorizationRequest,
	reservations: ResolvedSubagentLaunchAuthorizationReservations | undefined,
): ResolvedSubagentLaunchAuthorizationApproval | undefined {
	const normalizedReservations = reservations ? normalizeReservations(reservations, "detached launch authorization reservations") : undefined;
	const rawAgentName = input?.agent?.name;
	if (typeof rawAgentName !== "string" || matchingProviderNames(normalizedReservations, rawAgentName).length === 0) return undefined;
	const authorized = authorizeSubagentLaunchAgainstReservations(input, normalizedReservations);
	return Object.freeze({
		version: SUBAGENT_LAUNCH_AUTHORIZATION_VERSION,
		request: authorized.request,
		providers: authorized.providers,
	});
}

/** Build the bounded, prompt-free approval manifest written to one detached runner config. */
export function createDetachedSubagentLaunchAuthorizationContext(
	approvals: readonly ResolvedSubagentLaunchAuthorizationApproval[],
): DetachedSubagentLaunchAuthorizationContext {
	if (!Array.isArray(approvals) || approvals.length === 0) throw new Error("Detached launch authorization requires at least one exact attempt approval.");
	const first = normalizeApproval(approvals[0], 0);
	return normalizeDetachedContext({
		version: SUBAGENT_LAUNCH_AUTHORIZATION_VERSION,
		...(first.request.sessionId ? { sessionId: first.request.sessionId } : {}),
		invocation: first.request.invocation,
		agent: {
			source: first.request.agent.source,
			filePath: first.request.agent.filePath,
		},
		approvals,
	});
}

/**
 * Validate and consume package-owned approvals in a detached runner. Provider
 * callbacks and provider-owned receipts never cross the process boundary.
 */
export function createDetachedSubagentLaunchAuthorizationGate(input: {
	agentName: string;
	context?: DetachedSubagentLaunchAuthorizationContext;
	reservations?: ResolvedSubagentLaunchAuthorizationReservations;
}): {
	reserved: boolean;
	authorizeAttempt(attempt: DetachedSubagentLaunchAuthorizationAttempt): void;
} {
	const agentName = validateAgentName(input.agentName, "Detached launch authorization agent name");
	const reservations = input.reservations
		? normalizeReservations(input.reservations, "detached launch authorization reservations")
		: decodeSubagentLaunchAuthorizationReservations(process.env[SUBAGENT_LAUNCH_AUTHORIZATION_ENV]);
	const expectedProviders = matchingProviderNames(reservations, agentName);
	if (expectedProviders.length === 0) {
		return Object.freeze({ reserved: false, authorizeAttempt() {} });
	}
	const context = normalizeDetachedContext(input.context);
	const approvals = new Map<string, ResolvedSubagentLaunchAuthorizationApproval>();
	for (const approval of context.approvals) {
		if (approval.request.agent.name !== agentName) {
			throw new Error(`Detached launch authorization approval targets '${approval.request.agent.name}' instead of reserved agent '${agentName}'.`);
		}
		if (JSON.stringify(approval.providers) !== JSON.stringify(expectedProviders)) {
			throw new Error(`Detached launch authorization approval providers do not match the reservations for agent '${agentName}'.`);
		}
		approvals.set(launchAuthorizationRequestKey(approval.request), approval);
	}
	return Object.freeze({
		reserved: true,
		authorizeAttempt(attempt: DetachedSubagentLaunchAuthorizationAttempt): void {
			const request = normalizeRequest({
				version: SUBAGENT_LAUNCH_AUTHORIZATION_VERSION,
				...(context.sessionId ? { sessionId: context.sessionId } : {}),
				invocation: context.invocation,
				run: {
					id: attempt.run.id,
					childIndex: attempt.run.childIndex,
					modelAttempt: attempt.run.modelAttempt,
					startupAttempt: attempt.run.startupAttempt,
					async: true,
				},
				agent: {
					name: attempt.agent.name,
					source: context.agent.source,
					filePath: context.agent.filePath,
					definitionDigest: attempt.agent.definitionDigest,
					runner: attempt.agent.runner,
				},
				contract: {
					launchContractDigest: attempt.contract.launchContractDigest,
					...(attempt.contract.context ? { context: attempt.contract.context } : {}),
					...(attempt.contract.model ? { model: attempt.contract.model } : {}),
					modelCandidates: attempt.contract.modelCandidates,
				},
			});
			const key = launchAuthorizationRequestKey(request);
			if (!approvals.delete(key)) {
				throw new Error(`Reserved agent '${agentName}' has no exact detached launch authorization approval for model attempt ${request.run.modelAttempt}, startup attempt ${request.run.startupAttempt}.`);
			}
		},
	});
}
