import { randomBytes, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import * as net from "node:net";
import * as path from "node:path";

export const SUBAGENT_LAUNCH_CAPABILITIES_ENV = "PI_SUBAGENT_LAUNCH_CAPABILITIES_V1";
export const SUBAGENT_LAUNCH_CAPABILITY_VERSION = 1 as const;
const REGISTRY_KEY = Symbol.for("pi-subagents.launch-capability-providers.v1");
const MAX_CAPABILITIES = 16;
const MAX_CAPABILITY_ID_BYTES = 128;
const MAX_MESSAGE_BYTES = 32 * 1024;
const MAX_PROJECTION_BYTES = 8 * 1024;
const MAX_PROJECTION_AGGREGATE_BYTES = 24 * 1024;
const CLIENT_TIMEOUT_MS = 2_000;
const MAX_LEASE_MS = 30 * 60 * 1_000;

export interface SubagentLaunchIdentityV1 {
	version: 1;
	parentSessionId: string;
	rootRunId: string;
	runId: string;
	attemptId: string;
	childIndex: number;
	agent: string;
	mode: "foreground";
	cwdRealpath: string;
	effectiveTools: readonly string[];
	launchResolvedExtensions: readonly string[];
	launchContractDigest?: string;
}

export interface BoundSubagentLaunchIdentityV1 extends SubagentLaunchIdentityV1 {
	childSessionId: string;
}

export interface LaunchCapabilityTransitionRequest {
	phase: "prepare" | "commit" | "rollback";
	operation: string;
}

export interface LaunchCapabilityTransitionResult {
	ok: boolean;
	reason?: string;
}

export interface IssuedSubagentLaunchCapability {
	expiresAt: number;
	projection?: Record<string, unknown>;
	authorize(identity: Readonly<BoundSubagentLaunchIdentityV1>): boolean | Promise<boolean>;
	transition?(
		request: Readonly<LaunchCapabilityTransitionRequest>,
		identity: Readonly<BoundSubagentLaunchIdentityV1>,
	): LaunchCapabilityTransitionResult | Promise<LaunchCapabilityTransitionResult>;
	release?(reason: string): void | Promise<void>;
}

export interface RegisterSubagentLaunchCapabilityProviderOptions {
	sessionId: string;
	capabilityId: string;
	source: string;
	issue(
		identity: Readonly<SubagentLaunchIdentityV1>,
	): IssuedSubagentLaunchCapability | undefined | Promise<IssuedSubagentLaunchCapability | undefined>;
}

export interface SubagentLaunchCapabilityProviderHandle {
	dispose(): void;
}

export interface PreparedSubagentLaunchCapabilities {
	envelope: string;
	dispose(reason?: string): Promise<void>;
}

export interface LaunchCapabilityAuthorization {
	ok: boolean;
	reason?: string;
}

export interface BoundSubagentLaunchCapabilities {
	capabilityIds(): string[];
	projection(capabilityId: string): Record<string, unknown> | undefined;
	authorize(capabilityId: string): Promise<LaunchCapabilityAuthorization>;
	transition(capabilityId: string, request: LaunchCapabilityTransitionRequest): Promise<LaunchCapabilityTransitionResult>;
	release(): Promise<void>;
}

type ProviderRegistration = {
	source: string;
	issue: RegisterSubagentLaunchCapabilityProviderOptions["issue"];
};
type ProviderRegistry = Map<string, Map<string, Map<symbol, ProviderRegistration>>>;

type EnvelopeV1 = {
	version: 1;
	host: "127.0.0.1";
	port: number;
	token: string;
	attemptId: string;
};

type BrokerRequest = {
	version: 1;
	token: string;
	attemptId: string;
	op: "bind" | "authorize" | "transition" | "release";
	childSessionId: string;
	cwdRealpath?: string;
	capabilityId?: string;
	transition?: LaunchCapabilityTransitionRequest;
};

type BrokerResponse = {
	ok: boolean;
	reason?: string;
	projections?: Record<string, Record<string, unknown> | undefined>;
	transition?: LaunchCapabilityTransitionResult;
};

function brokerRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function parseBrokerResponse(value: unknown, op: BrokerRequest["op"]): BrokerResponse {
	const record = brokerRecord(value);
	if (!record || typeof record.ok !== "boolean" || (record.reason !== undefined && typeof record.reason !== "string")) {
		throw new Error("Malformed launch capability broker response.");
	}
	const base = { ok: record.ok, ...(typeof record.reason === "string" ? { reason: record.reason } : {}) };
	if (!record.ok) return base;
	if (op === "bind") {
		const rawProjections = brokerRecord(record.projections);
		if (!rawProjections) throw new Error("Malformed launch capability broker bind response.");
		const projections: Record<string, Record<string, unknown> | undefined> = {};
		for (const [id, projection] of Object.entries(rawProjections)) {
			capabilityId(id);
			if (projection === undefined) projections[id] = undefined;
			else {
				const exact = brokerRecord(projection);
				if (!exact) throw new Error("Malformed launch capability broker projection.");
				projections[id] = exact;
			}
		}
		return { ...base, projections };
	}
	if (op === "transition") {
		const transition = brokerRecord(record.transition);
		if (!transition || transition.ok !== true || (transition.reason !== undefined && typeof transition.reason !== "string")) {
			throw new Error("Malformed launch capability broker transition response.");
		}
		return { ...base, transition: { ok: true, ...(typeof transition.reason === "string" ? { reason: transition.reason } : {}) } };
	}
	return base;
}

function registry(): ProviderRegistry {
	const root = globalThis as typeof globalThis & { [REGISTRY_KEY]?: ProviderRegistry };
	if (!(root[REGISTRY_KEY] instanceof Map)) root[REGISTRY_KEY] = new Map();
	return root[REGISTRY_KEY]!;
}

function exactText(value: unknown, field: string, maxBytes = 256): string {
	if (typeof value !== "string" || !value || value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value) || Buffer.byteLength(value, "utf8") > maxBytes) {
		throw new Error(`Invalid launch capability ${field}.`);
	}
	return value;
}

function capabilityId(value: unknown): string {
	const id = exactText(value, "id", MAX_CAPABILITY_ID_BYTES);
	if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(id)) throw new Error(`Invalid launch capability id '${id}'.`);
	return id;
}

function canonicalPath(value: string): string {
	try {
		return realpathSync(value);
	} catch {
		return path.resolve(value);
	}
}

function normalizedIdentity(value: SubagentLaunchIdentityV1): SubagentLaunchIdentityV1 {
	if (value?.version !== 1 || value.mode !== "foreground") throw new Error("Invalid subagent launch identity version or mode.");
	if (!Number.isInteger(value.childIndex) || value.childIndex < 0) throw new Error("Invalid subagent launch identity childIndex.");
	return {
		version: 1,
		parentSessionId: exactText(value.parentSessionId, "parentSessionId"),
		rootRunId: exactText(value.rootRunId, "rootRunId"),
		runId: exactText(value.runId, "runId"),
		attemptId: exactText(value.attemptId, "attemptId"),
		childIndex: value.childIndex,
		agent: exactText(value.agent, "agent"),
		mode: "foreground",
		cwdRealpath: canonicalPath(exactText(value.cwdRealpath, "cwdRealpath", 4096)),
		effectiveTools: [...new Set((value.effectiveTools ?? []).map((entry) => exactText(entry, "effective tool", 128)))].sort(),
		launchResolvedExtensions: [...new Set((value.launchResolvedExtensions ?? []).map((entry) => exactText(entry, "launch extension", 4096)))].sort(),
		...(value.launchContractDigest ? { launchContractDigest: exactText(value.launchContractDigest, "launchContractDigest", 512) } : {}),
	};
}

export function registerSubagentLaunchCapabilityProvider(
	options: RegisterSubagentLaunchCapabilityProviderOptions,
): SubagentLaunchCapabilityProviderHandle {
	const sessionId = exactText(options.sessionId, "provider sessionId");
	const id = capabilityId(options.capabilityId);
	const source = exactText(options.source, "provider source");
	if (typeof options.issue !== "function") throw new Error("Invalid launch capability provider issue callback.");
	const all = registry();
	let session = all.get(sessionId);
	if (!session) {
		session = new Map();
		all.set(sessionId, session);
	}
	let providers = session.get(id);
	if (!providers) {
		providers = new Map();
		session.set(id, providers);
	}
	const key = Symbol(source);
	providers.set(key, { source, issue: options.issue });
	let disposed = false;
	return {
		dispose() {
			if (disposed) return;
			disposed = true;
			providers!.delete(key);
			if (providers!.size === 0) session!.delete(id);
			if (session!.size === 0) all.delete(sessionId);
		},
	};
}

function encodeEnvelope(value: EnvelopeV1): string {
	return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeEnvelope(value: string): EnvelopeV1 {
	let parsed: unknown;
	try {
		parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
	} catch {
		throw new Error("Malformed inherited launch capability envelope.");
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Malformed inherited launch capability envelope.");
	const record = parsed as Partial<EnvelopeV1>;
	if (record.version !== 1 || record.host !== "127.0.0.1" || !Number.isInteger(record.port) || Number(record.port) <= 0 || Number(record.port) > 65535) {
		throw new Error("Malformed inherited launch capability envelope.");
	}
	return {
		version: 1,
		host: "127.0.0.1",
		port: Number(record.port),
		token: exactText(record.token, "envelope token", 512),
		attemptId: exactText(record.attemptId, "envelope attemptId"),
	};
}

function writeResponse(socket: net.Socket, response: BrokerResponse): void {
	socket.end(`${JSON.stringify(response)}\n`);
}

async function releaseGrants(grants: Map<string, IssuedSubagentLaunchCapability>, reason: string): Promise<void> {
	await Promise.allSettled([...grants.values()].map((grant) =>
		Promise.resolve().then(() => grant.release?.(reason))
	));
}

export async function prepareSubagentLaunchCapabilities(input: {
	sessionId: string;
	requested: readonly string[];
	identity: SubagentLaunchIdentityV1;
}): Promise<PreparedSubagentLaunchCapabilities> {
	const sessionId = exactText(input.sessionId, "request sessionId");
	const requested = input.requested.map(capabilityId);
	if (requested.length === 0 || requested.length > MAX_CAPABILITIES || new Set(requested).size !== requested.length) {
		throw new Error(`Invalid requested launch capabilities; expected 1-${MAX_CAPABILITIES} unique ids.`);
	}
	const identity = normalizedIdentity(input.identity);
	if (identity.parentSessionId !== sessionId) throw new Error("Launch capability parent session mismatch.");
	const sessionProviders = registry().get(sessionId);
	const grants = new Map<string, IssuedSubagentLaunchCapability>();
	let pendingGrant: IssuedSubagentLaunchCapability | undefined;
	let aggregateProjectionBytes = 0;
	try {
		for (const id of requested) {
			const candidates = sessionProviders?.get(id);
			if (!candidates || candidates.size !== 1) throw new Error(`Required launch capability '${id}' is not available from one exact provider.`);
			const provider = [...candidates.values()][0]!;
			const grant = await provider.issue(identity);
			if (!grant) throw new Error(`Required launch capability '${id}' was not granted by ${provider.source}.`);
			pendingGrant = grant;
			const now = Date.now();
			if (!Number.isFinite(grant.expiresAt) || grant.expiresAt <= now || grant.expiresAt > now + MAX_LEASE_MS) {
				throw new Error(`Required launch capability '${id}' returned an invalid expiry.`);
			}
			if (typeof grant.authorize !== "function") throw new Error(`Required launch capability '${id}' returned no authorization callback.`);
			let projection: Record<string, unknown> | undefined;
			if (grant.projection !== undefined) {
				if (!grant.projection || typeof grant.projection !== "object" || Array.isArray(grant.projection)) {
					throw new Error(`Required launch capability '${id}' returned an invalid projection.`);
				}
				let serialized: string;
				try {
					serialized = JSON.stringify(grant.projection);
				} catch {
					throw new Error(`Required launch capability '${id}' returned a non-JSON projection.`);
				}
				if (!serialized || Buffer.byteLength(serialized, "utf8") > MAX_PROJECTION_BYTES) {
					throw new Error(`Required launch capability '${id}' returned an oversized projection.`);
				}
				projection = JSON.parse(serialized) as Record<string, unknown>;
				aggregateProjectionBytes += Buffer.byteLength(id, "utf8") + Buffer.byteLength(serialized, "utf8") + 16;
				if (aggregateProjectionBytes > MAX_PROJECTION_AGGREGATE_BYTES) {
					throw new Error("Required launch capability projections exceed the aggregate transport bound.");
				}
			}
			grants.set(id, { ...grant, ...(projection !== undefined ? { projection } : {}) });
			pendingGrant = undefined;
		}
	} catch (error) {
		if (pendingGrant?.release) {
			try {
				await pendingGrant.release("issuance-validation-failed");
			} catch {
				// Continue releasing every previously validated grant.
			}
		}
		await releaseGrants(grants, "issuance-failed");
		throw error;
	}

	const token = randomBytes(32).toString("base64url");
	let boundSessionId: string | undefined;
	let revoked = false;
	let disposed = false;
	let grantsReleased = false;
	const releaseAll = async (reason: string) => {
		if (grantsReleased) return;
		grantsReleased = true;
		await releaseGrants(grants, reason);
	};
	const server = net.createServer((socket) => {
		let bytes = 0;
		let body = "";
		socket.setTimeout(CLIENT_TIMEOUT_MS, () => socket.destroy());
		socket.setEncoding("utf8");
		socket.on("data", (chunk: string) => {
			bytes += Buffer.byteLength(chunk, "utf8");
			if (bytes > MAX_MESSAGE_BYTES) {
				socket.destroy();
				return;
			}
			body += chunk;
			if (!body.includes("\n")) return;
			void (async () => {
				let request: BrokerRequest;
				try {
					request = JSON.parse(body.slice(0, body.indexOf("\n"))) as BrokerRequest;
				} catch {
					writeResponse(socket, { ok: false, reason: "malformed request" });
					return;
				}
				if (request.version !== 1 || request.token !== token || request.attemptId !== identity.attemptId) {
					writeResponse(socket, { ok: false, reason: "invalid launch capability" });
					return;
				}
				const childSessionId = typeof request.childSessionId === "string" ? request.childSessionId.trim() : "";
				if (!childSessionId || revoked || disposed) {
					writeResponse(socket, { ok: false, reason: "launch capability is unavailable" });
					return;
				}
				if ([...grants.values()].some((grant) => grant.expiresAt <= Date.now())) {
					revoked = true;
					await releaseAll("expired");
					writeResponse(socket, { ok: false, reason: "launch capability expired" });
					return;
				}
				if (request.op === "bind") {
					if (canonicalPath(request.cwdRealpath ?? "") !== identity.cwdRealpath) {
						writeResponse(socket, { ok: false, reason: "launch context mismatch" });
						return;
					}
					if (boundSessionId) {
						writeResponse(socket, { ok: false, reason: "launch capability envelope was already bound and cannot be replayed" });
						return;
					}
					boundSessionId = childSessionId;
					writeResponse(socket, {
						ok: true,
						projections: Object.fromEntries([...grants].map(([id, grant]) => [id, grant.projection ? structuredClone(grant.projection) : undefined])),
					});
					return;
				}
				if (!boundSessionId || boundSessionId !== childSessionId) {
					writeResponse(socket, { ok: false, reason: "child session mismatch" });
					return;
				}
				if (request.op === "release") {
					revoked = true;
					await releaseAll("child-release");
					writeResponse(socket, { ok: true });
					return;
				}
				const id = typeof request.capabilityId === "string" ? request.capabilityId : "";
				const grant = grants.get(id);
				if (!grant) {
					writeResponse(socket, { ok: false, reason: "capability not granted" });
					return;
				}
				const boundIdentity: BoundSubagentLaunchIdentityV1 = { ...identity, childSessionId };
				if (request.op === "authorize") {
					try {
						const ok = await grant.authorize(boundIdentity);
						if (revoked || disposed || boundSessionId !== childSessionId || [...grants.values()].some((candidate) => candidate.expiresAt <= Date.now())) {
							revoked = true;
							await releaseAll("stale-after-authorization");
							writeResponse(socket, { ok: false, reason: "launch capability became unavailable during authorization" });
							return;
						}
						writeResponse(socket, ok === true ? { ok: true } : { ok: false, reason: "provider denied authorization" });
					} catch {
						writeResponse(socket, { ok: false, reason: "provider authorization failed" });
					}
					return;
				}
				if (request.op === "transition") {
					if (!grant.transition || !request.transition || !["prepare", "commit", "rollback"].includes(request.transition.phase) || typeof request.transition.operation !== "string") {
						writeResponse(socket, { ok: false, reason: "transition unsupported" });
						return;
					}
					try {
						const result = await grant.transition(request.transition, boundIdentity);
						const transitionOk = brokerRecord(result)?.ok === true;
						const transitionReason = typeof brokerRecord(result)?.reason === "string" ? brokerRecord(result)!.reason as string : undefined;
						if (revoked || disposed || boundSessionId !== childSessionId || [...grants.values()].some((candidate) => candidate.expiresAt <= Date.now())) {
							revoked = true;
							if (transitionOk && request.transition.phase === "prepare") {
								try {
									await grant.transition({ ...request.transition, phase: "rollback" }, boundIdentity);
								} catch {
									// An unknown prepare outcome remains denied.
								}
							}
							await releaseAll("stale-after-transition");
							writeResponse(socket, { ok: false, reason: "launch capability became unavailable during transition" });
							return;
						}
						writeResponse(socket, transitionOk
							? { ok: true, transition: { ok: true, ...(transitionReason ? { reason: transitionReason } : {}) } }
							: { ok: false, reason: transitionReason ?? "provider denied transition" });
					} catch {
						writeResponse(socket, { ok: false, reason: "provider transition failed" });
					}
					return;
				}
				writeResponse(socket, { ok: false, reason: "unsupported operation" });
			})();
		});
	});
	server.unref();
	try {
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", () => {
				server.off("error", reject);
				resolve();
			});
		});
	} catch (error) {
		revoked = true;
		await releaseAll("broker-listen-failed");
		throw error;
	}
	const address = server.address();
	if (!address || typeof address === "string") {
		server.close();
		await releaseAll("broker-start-failed");
		throw new Error("Failed to start launch capability broker.");
	}
	const envelope = encodeEnvelope({ version: 1, host: "127.0.0.1", port: address.port, token, attemptId: identity.attemptId });
	return {
		envelope,
		async dispose(reason = "launcher-dispose") {
			if (disposed) return;
			disposed = true;
			revoked = true;
			await releaseAll(reason);
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}

async function brokerCall(envelope: EnvelopeV1, request: Omit<BrokerRequest, "version" | "token" | "attemptId">): Promise<BrokerResponse> {
	return await new Promise<BrokerResponse>((resolve, reject) => {
		const socket = net.createConnection({ host: envelope.host, port: envelope.port });
		let body = "";
		let settled = false;
		const finish = (error?: Error, response?: BrokerResponse) => {
			if (settled) return;
			settled = true;
			socket.destroy();
			if (error) reject(error);
			else resolve(response ?? { ok: false, reason: "empty broker response" });
		};
		socket.setTimeout(CLIENT_TIMEOUT_MS, () => finish(new Error("Launch capability broker timed out.")));
		socket.setEncoding("utf8");
		socket.once("error", (error) => finish(error));
		socket.on("connect", () => socket.write(`${JSON.stringify({ version: 1, token: envelope.token, attemptId: envelope.attemptId, ...request })}\n`));
		socket.on("data", (chunk: string) => {
			body += chunk;
			if (Buffer.byteLength(body, "utf8") > MAX_MESSAGE_BYTES) return finish(new Error("Launch capability broker response was too large."));
			if (!body.includes("\n")) return;
			try {
				finish(undefined, parseBrokerResponse(JSON.parse(body.slice(0, body.indexOf("\n"))), request.op));
			} catch (error) {
				finish(error instanceof Error ? error : new Error("Malformed launch capability broker response."));
			}
		});
	});
}

export async function bindInheritedLaunchCapabilities(input: {
	childSessionId: string;
	cwd: string;
	envelope?: string;
}): Promise<BoundSubagentLaunchCapabilities> {
	const childSessionId = exactText(input.childSessionId, "childSessionId");
	const encoded = input.envelope ?? process.env[SUBAGENT_LAUNCH_CAPABILITIES_ENV];
	if (!encoded) throw new Error("No inherited launch capability envelope is available.");
	const envelope = decodeEnvelope(encoded);
	if (input.envelope === undefined) delete process.env[SUBAGENT_LAUNCH_CAPABILITIES_ENV];
	const response = await brokerCall(envelope, { op: "bind", childSessionId, cwdRealpath: canonicalPath(input.cwd) });
	if (response.ok !== true) throw new Error(`Launch capability bind failed: ${response.reason ?? "denied"}.`);
	const projections = response.projections ?? {};
	let released = false;
	const safeCall = async (request: Omit<BrokerRequest, "version" | "token" | "attemptId" | "childSessionId">): Promise<BrokerResponse> => {
		if (released) return { ok: false, reason: "launch capability released" };
		try {
			return await brokerCall(envelope, { ...request, childSessionId });
		} catch {
			return { ok: false, reason: "launch capability broker unavailable" };
		}
	};
	return {
		capabilityIds: () => Object.keys(projections).sort(),
		projection: (id) => projections[id] ? structuredClone(projections[id]) : undefined,
		authorize: async (id) => {
			const result = await safeCall({ op: "authorize", capabilityId: capabilityId(id) });
			return result.ok === true ? { ok: true } : { ok: false, reason: result.reason };
		},
		transition: async (id, transition) => {
			const result = await safeCall({ op: "transition", capabilityId: capabilityId(id), transition });
			const reason = result.reason ?? result.transition?.reason;
			if (result.ok === true && result.transition?.ok === true) {
				return { ok: true, ...(reason ? { reason } : {}) };
			}
			return { ok: false, ...(reason ? { reason } : {}) };
		},
		async release() {
			if (released) return;
			try {
				await brokerCall(envelope, { op: "release", childSessionId });
			} catch {
				// Parent loss already revokes online authority.
			}
			released = true;
		},
	};
}

export function resetSubagentLaunchCapabilityProvidersForTests(): void {
	registry().clear();
}
