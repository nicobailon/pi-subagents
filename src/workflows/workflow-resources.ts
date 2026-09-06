import { randomUUID } from "node:crypto";
import { stableJsonDigest } from "../shared/launch-contract.ts";
import {
	createWorkflowResourcePermit,
	type WorkflowResourceHostAuthority,
	type WorkflowResourcePermit,
} from "../shared/workflow-child-permit.ts";
import type { WorkflowResourceProvenance } from "../shared/types.ts";

const RESOURCE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_ARGS_BYTES = 16 * 1024;
const MAX_STRING_BYTES = 16 * 1024;

export interface ResolvedWorkflowResource {
	script: string;
	permit: WorkflowResourcePermit;
	provenance: WorkflowResourceProvenance;
}

export type WorkflowResourceResolution =
	| { ok: true; resource: ResolvedWorkflowResource }
	| { ok: false; error: string };

export interface WorkflowResourceDefinition {
	name: string;
	version: number;
	/** Trusted synchronous validation/expansion. The extension owns semantic command binding. */
	resolve: (args: Readonly<Record<string, unknown>>) => { script: string; hostCommands?: readonly WorkflowResourceHostAuthority[] } | { error: string };
}

export interface WorkflowResourceRegistration {
	dispose(): void;
}

export interface RegisterWorkflowResourceInput {
	sessionId: string;
	definition: WorkflowResourceDefinition;
}

interface WorkflowResourceRegistry {
	version: 1;
	bySession: Map<string, Map<string, WorkflowResourceDefinition>>;
}

function registry(): WorkflowResourceRegistry {
	const key = Symbol.for("pi-subagents.workflow-resources.v1");
	const globalObject = globalThis as Record<PropertyKey, unknown>;
	const existing = globalObject[key];
	if (existing === undefined) {
		const created: WorkflowResourceRegistry = { version: 1, bySession: new Map() };
		globalObject[key] = created;
		return created;
	}
	if (!isPlainRecord(existing) || existing.version !== 1 || !(existing.bySession instanceof Map)) throw new Error("Malformed or unsupported workflow resource registry.");
	return existing as unknown as WorkflowResourceRegistry;
}

/** Session ID scopes lookup, not authentication. Dispose on session_shutdown; issued permits remain valid. */
export function registerWorkflowResource(input: RegisterWorkflowResourceInput): WorkflowResourceRegistration {
	if (!isPlainRecord(input) || Object.keys(input).some((key) => key !== "sessionId" && key !== "definition")) throw new Error("Workflow registration requires only sessionId and definition.");
	const { sessionId, definition } = input;
	if (typeof sessionId !== "string" || !sessionId || sessionId.trim() !== sessionId || sessionId.length > 256 || sessionId.includes("\0")) throw new Error("Workflow registration requires a non-empty trimmed sessionId of at most 256 characters without NUL.");
	if (!isPlainRecord(definition) || Object.keys(definition).some((key) => !["name", "version", "resolve"].includes(key))) throw new Error("Workflow definition requires only name, version and resolve.");
	const { name, version, resolve } = definition;
	if (typeof name !== "string" || !RESOURCE_NAME_PATTERN.test(name)) throw new Error("Workflow definition requires a safe resource name.");
	if (!Number.isSafeInteger(version) || version < 1) throw new Error("Workflow definition version must be a positive safe integer.");
	if (typeof resolve !== "function") throw new Error("Workflow definition requires a synchronous resolve function.");
	if (findWorkflowResource(name)) throw new Error(`Workflow resource '${name}' is a protected builtin.`);
	const current = registry();
	const bucket = current.bySession.get(sessionId) ?? new Map<string, WorkflowResourceDefinition>();
	if (!(bucket instanceof Map)) throw new Error("Malformed workflow resource session registry.");
	if (bucket.has(name)) throw new Error(`Workflow resource '${name}' is already registered in this session; dispose it first.`);
	const snapshot = Object.freeze({ name, version, resolve });
	bucket.set(name, snapshot);
	current.bySession.set(sessionId, bucket);
	let disposed = false;
	return {
		dispose() {
			if (disposed) return;
			disposed = true;
			if (bucket.get(name) === snapshot) bucket.delete(name);
			if (bucket.size === 0 && current.bySession.get(sessionId) === bucket) current.bySession.delete(sessionId);
		},
	};
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function jsonByteLength(value: unknown): number {
	try {
		const encoded = JSON.stringify(value);
		if (encoded === undefined) throw new Error("must contain JSON data");
		return Buffer.byteLength(encoded, "utf8");
	} catch (error) {
		throw new Error(`must contain plain JSON data: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function validatePlainJson(value: unknown, path: string, depth = 0): void {
	if (depth > 8) throw new Error(`${path} is too deeply nested.`);
	if (value === null || typeof value === "boolean") return;
	if (typeof value === "string") {
		if (!value.trim()) throw new Error(`${path} must not be empty.`);
		if (Buffer.byteLength(value, "utf8") > MAX_STRING_BYTES) throw new Error(`${path} exceeds ${MAX_STRING_BYTES} bytes.`);
		return;
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new Error(`${path} must be finite.`);
		return;
	}
	if (Array.isArray(value)) {
		if (value.length > 64) throw new Error(`${path} contains too many items.`);
		for (const [index, entry] of value.entries()) validatePlainJson(entry, `${path}[${index}]`, depth + 1);
		return;
	}
	if (!isPlainRecord(value)) throw new Error(`${path} must contain plain JSON data.`);
	if (Object.keys(value).length > 16) throw new Error(`${path} contains too many fields.`);
	for (const [key, entry] of Object.entries(value)) {
		if (!key.trim()) throw new Error(`${path} contains an empty field name.`);
		validatePlainJson(entry, `${path}.${key}`, depth + 1);
	}
}

function normalizeArgs(value: unknown): { args: Record<string, unknown> } | { error: string } {
	if (value === undefined) return { args: {} };
	if (!isPlainRecord(value)) return { error: "workflow args must be a plain JSON object." };
	try {
		validatePlainJson(value, "workflow args");
		if (jsonByteLength(value) > MAX_ARGS_BYTES) return { error: `workflow args exceed ${MAX_ARGS_BYTES} bytes.` };
		return { args: JSON.parse(JSON.stringify(value)) };
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

function resolveRunCi(args: Readonly<Record<string, unknown>>): ReturnType<WorkflowResourceDefinition["resolve"]> {
	const allowed = new Set(["command", "timeoutMs"]);
	const unsupported = Object.keys(args).filter((key) => !allowed.has(key));
	if (unsupported.length > 0) return { error: `workflow 'run-ci' args contain unsupported fields: ${unsupported.join(", ")}.` };
	const command = args.command === undefined ? "npm test" : args.command;
	if (command !== "npm test" && command !== "npm run typecheck") return { error: "workflow 'run-ci' args.command must be 'npm test' or 'npm run typecheck'." };
	const timeoutMs = args.timeoutMs === undefined ? 120_000 : args.timeoutMs;
	if (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 86_400_000) return { error: "workflow 'run-ci' args.timeoutMs must be an integer from 1 to 86400000." };
	const params = { kind: "command", command, timeoutMs, role: "ci" };
	return {
		script: `return await runs.host("ci", ${JSON.stringify(params)});`,
		hostCommands: [{ key: "ci", command }],
	};
}

function resolveReview(args: Readonly<Record<string, unknown>>): ReturnType<WorkflowResourceDefinition["resolve"]> {
	const unsupported = Object.keys(args).filter((key) => key !== "task");
	if (unsupported.length > 0) return { error: `workflow 'review' args contain unsupported fields: ${unsupported.join(", ")}.` };
	const task = args.task;
	if (typeof task !== "string" || !task.trim()) return { error: "workflow 'review' requires a non-empty string args.task." };
	return {
		script: `return (await runs.run("review", { agent: "reviewer", task: ${JSON.stringify(task.trim())} })).output;`,
	};
}

const WORKFLOW_RESOURCES: readonly WorkflowResourceDefinition[] = [
	{ name: "review", version: 1, resolve: resolveReview },
	{ name: "run-ci", version: 1, resolve: resolveRunCi },
];

function findWorkflowResource(name: string): WorkflowResourceDefinition | undefined {
	return WORKFLOW_RESOURCES.find((resource) => resource.name === name);
}

function listWorkflowResourceNames(): string[] {
	return WORKFLOW_RESOURCES.map((resource) => resource.name);
}

/** Resolve only extension-owned resources so policy can distinguish them from raw scripts; caller-provided script text is never consulted. */
export function resolveWorkflowResource(nameValue: unknown, argsValue?: unknown, sessionId?: string): WorkflowResourceResolution {
	try {
		const result = resolveResource(nameValue, argsValue, sessionId);
		return result.ok ? result : { ok: false, error: result.error.slice(0, 4096) };
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message.slice(0, 4096) : "Workflow resource resolution failed." };
	}
}

function resolveResource(nameValue: unknown, argsValue?: unknown, sessionId?: string): WorkflowResourceResolution {
	if (typeof nameValue !== "string" || !nameValue.trim()) return { ok: false, error: "workflow must be a non-empty resource name." };
	const name = nameValue.trim();
	if (!RESOURCE_NAME_PATTERN.test(name)) return { ok: false, error: "workflow must use a safe resource name." };
	const resource = findWorkflowResource(name) ?? (sessionId ? registry().bySession.get(sessionId)?.get(name) : undefined);
	if (!resource) return { ok: false, error: `Unknown workflow resource '${name}'. Available resources: ${listWorkflowResourceNames().join(", ")}.` };
	const normalizedArgs = normalizeArgs(argsValue);
	if ("error" in normalizedArgs) return { ok: false, error: normalizedArgs.error };
	const resolved = resource.resolve(normalizedArgs.args);
	if (resolved && typeof (resolved as unknown as { then?: unknown }).then === "function") {
		void Promise.resolve(resolved).catch(() => {});
		throw new Error("Workflow resource resolve must be synchronous.");
	}
	if (!isPlainRecord(resolved)) throw new Error("Workflow resource resolve must return an expansion or error object.");
	if ("error" in resolved) {
		if (Object.keys(resolved).some((key) => key !== "error") || typeof resolved.error !== "string" || !resolved.error.trim()) throw new Error("Workflow resource returned an invalid error.");
		return { ok: false, error: resolved.error };
	}
	const { script, hostCommands } = resolved;
	if (Object.keys(resolved).some((key) => key !== "script" && key !== "hostCommands") || typeof script !== "string" || !script.trim()) throw new Error("Workflow resource returned an invalid expansion.");
	const resourceId = randomUUID();
	const permit = createWorkflowResourcePermit({
		resourceName: resource.name,
		resourceVersion: resource.version,
		resourceId,
		scriptDigest: stableJsonDigest(script),
		authority: { host: hostCommands },
	});
	const provenance: WorkflowResourceProvenance = Object.freeze({
		kind: "workflow",
		name: resource.name,
		version: resource.version,
		invocation: "named",
		expansion: "resolved",
		id: resourceId,
	});
	return { ok: true, resource: { script, permit, provenance } };
}
