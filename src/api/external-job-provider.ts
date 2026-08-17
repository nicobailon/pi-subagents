export const EXTERNAL_JOB_PROVIDER_PROTOCOL_VERSION = 1;
export const EXTERNAL_JOB_PROVIDER_REGISTRY_KEY = "pi-subagents.external-job-providers.v1";

const MAX_PROVIDER_NAME_LENGTH = 128;
const MAX_PROVIDERS = 100;
const MAX_JOB_ID_LENGTH = 256;
const MAX_FAILURE_CODE_LENGTH = 128;
const MAX_FAILURE_MESSAGE_LENGTH = 4_096;
const MAX_URL_LENGTH = 4_096;

export type ExternalJobState = "queued" | "running" | "completed" | "failed" | "stopped" | "blocked";
export type ExternalJobOperation = "start" | "status" | "result" | "reattach";

export type ExternalJobOptions = Record<string, unknown>;

export interface ExternalJobStartInput {
	prompt: string;
	promptDigest: string;
	cwd: string;
	runId: string;
	stepIndex: number;
	agent: string;
	options: ExternalJobOptions;
	sessionId?: string;
}

export interface ExternalJobHandle {
	providerJobId: string;
	state: ExternalJobState;
	handleUrl?: string;
	conversationUrl?: string;
	failureCode?: string;
	failureMessage?: string;
	blockingJobId?: string;
}

export interface ExternalJobResult extends ExternalJobHandle {
	output?: string;
	artifactPath?: string;
}

export interface ExternalJobProvider {
	name: string;
	start(input: ExternalJobStartInput): Promise<ExternalJobHandle> | ExternalJobHandle;
	status(providerJobId: string): Promise<ExternalJobHandle> | ExternalJobHandle;
	result(providerJobId: string): Promise<ExternalJobResult> | ExternalJobResult;
	reattach(providerJobId: string): Promise<ExternalJobHandle> | ExternalJobHandle;
}

export class ExternalJobProviderError extends Error {
	readonly code: string;
	readonly blockingJobId?: string;

	constructor(message: string, options: { code: string; blockingJobId?: string; cause?: unknown }) {
		super(message, options.cause === undefined ? undefined : { cause: options.cause });
		this.name = "ExternalJobProviderError";
		this.code = options.code;
		this.blockingJobId = options.blockingJobId;
	}
}

interface ExternalJobProviderRegistry {
	version: typeof EXTERNAL_JOB_PROVIDER_PROTOCOL_VERSION;
	providers: Map<string, ExternalJobProvider>;
}

function registry(): ExternalJobProviderRegistry {
	const key = Symbol.for(EXTERNAL_JOB_PROVIDER_REGISTRY_KEY);
	const globalObject = globalThis as Record<PropertyKey, unknown>;
	const existing = globalObject[key];
	if (existing === undefined) {
		const created: ExternalJobProviderRegistry = {
			version: EXTERNAL_JOB_PROVIDER_PROTOCOL_VERSION,
			providers: new Map(),
		};
		globalObject[key] = created;
		return created;
	}
	if (!existing || typeof existing !== "object" || Array.isArray(existing)) {
		throw new Error(`Malformed external-job provider registry at Symbol.for("${EXTERNAL_JOB_PROVIDER_REGISTRY_KEY}").`);
	}
	const candidate = existing as Partial<ExternalJobProviderRegistry>;
	if (candidate.version !== EXTERNAL_JOB_PROVIDER_PROTOCOL_VERSION || !(candidate.providers instanceof Map)) {
		throw new Error(`Unsupported external-job provider registry at Symbol.for("${EXTERNAL_JOB_PROVIDER_REGISTRY_KEY}").`);
	}
	return candidate as ExternalJobProviderRegistry;
}

function validateString(value: unknown, field: string, maxLength: number): string {
	if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
		throw new Error(`${field} must be a non-empty string without leading or trailing whitespace.`);
	}
	if (value.length > maxLength) throw new Error(`${field} must be at most ${maxLength} characters.`);
	if (value.includes("\0")) throw new Error(`${field} must not contain NUL characters.`);
	return value;
}

function validateOptionalString(value: unknown, field: string, maxLength: number): string | undefined {
	if (value === undefined) return undefined;
	return validateString(value, field, maxLength);
}

function validateState(value: unknown, field: string): ExternalJobState {
	if (value === "queued" || value === "running" || value === "completed" || value === "failed" || value === "stopped" || value === "blocked") return value;
	throw new Error(`${field} must be queued, running, completed, failed, stopped, or blocked.`);
}

function validateHandle(provider: string, value: unknown, field: string, extraFields: readonly string[] = []): ExternalJobHandle {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} from external-job provider '${provider}' must be an object.`);
	const handle = value as Record<string, unknown>;
	const supported = new Set(["providerJobId", "state", "handleUrl", "conversationUrl", "failureCode", "failureMessage", "blockingJobId", ...extraFields]);
	const unknown = Object.keys(handle).filter((key) => !supported.has(key));
	if (unknown.length > 0) throw new Error(`${field} from external-job provider '${provider}' has unknown fields: ${unknown.join(", ")}.`);
	const handleUrl = validateOptionalString(handle.handleUrl, `${field}.handleUrl`, MAX_URL_LENGTH);
	const conversationUrl = validateOptionalString(handle.conversationUrl, `${field}.conversationUrl`, MAX_URL_LENGTH);
	const failureCode = validateOptionalString(handle.failureCode, `${field}.failureCode`, MAX_FAILURE_CODE_LENGTH);
	const failureMessage = validateOptionalString(handle.failureMessage, `${field}.failureMessage`, MAX_FAILURE_MESSAGE_LENGTH);
	const blockingJobId = validateOptionalString(handle.blockingJobId, `${field}.blockingJobId`, MAX_JOB_ID_LENGTH);
	return {
		providerJobId: validateString(handle.providerJobId, `${field}.providerJobId`, MAX_JOB_ID_LENGTH),
		state: validateState(handle.state, `${field}.state`),
		...(handleUrl ? { handleUrl } : {}),
		...(conversationUrl ? { conversationUrl } : {}),
		...(failureCode ? { failureCode } : {}),
		...(failureMessage ? { failureMessage } : {}),
		...(blockingJobId ? { blockingJobId } : {}),
	};
}

export function validateExternalJobHandle(provider: string, value: unknown, field = "External-job handle"): ExternalJobHandle {
	return validateHandle(provider, value, field);
}

export function validateExternalJobResult(provider: string, value: unknown, field = "External-job result"): ExternalJobResult {
	const result = validateHandle(provider, value, field, ["output", "artifactPath"]) as ExternalJobResult;
	const record = value as Record<string, unknown>;
	const output = validateOptionalString(record.output, `${field}.output`, 1024 * 1024);
	const artifactPath = validateOptionalString(record.artifactPath, `${field}.artifactPath`, MAX_URL_LENGTH);
	return {
		...result,
		...(output !== undefined ? { output } : {}),
		...(artifactPath !== undefined ? { artifactPath } : {}),
	};
}

function validateProvider(value: unknown): ExternalJobProvider {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("External-job provider must be an object.");
	const provider = value as Record<string, unknown>;
	const unknownFields = Object.keys(provider).filter((key) => !["name", "start", "status", "result", "reattach"].includes(key));
	if (unknownFields.length > 0) throw new Error(`External-job provider has unknown fields: ${unknownFields.join(", ")}.`);
	const name = validateString(provider.name, "External-job provider name", MAX_PROVIDER_NAME_LENGTH);
	for (const op of ["start", "status", "result", "reattach"] as const) {
		if (typeof provider[op] !== "function") throw new Error(`External-job provider '${name}' must expose ${op}().`);
	}
	return value as ExternalJobProvider;
}

export function registerExternalJobProvider(provider: ExternalJobProvider): () => void {
	const validated = validateProvider(provider);
	const current = registry();
	if (!current.providers.has(validated.name) && current.providers.size >= MAX_PROVIDERS) {
		throw new Error(`External-job provider registry supports at most ${MAX_PROVIDERS} providers.`);
	}
	current.providers.set(validated.name, validated);
	return () => {
		if (current.providers.get(validated.name) === validated) current.providers.delete(validated.name);
	};
}

export function listExternalJobProviders(): readonly ExternalJobProvider[] {
	const current = registry();
	if (current.providers.size > MAX_PROVIDERS) throw new Error(`External-job provider registry contains more than ${MAX_PROVIDERS} providers.`);
	const providers: ExternalJobProvider[] = [];
	for (const [key, value] of current.providers) {
		const provider = validateProvider(value);
		if (key !== provider.name) throw new Error(`External-job provider registry key '${key}' does not match provider name '${provider.name}'.`);
		providers.push(provider);
	}
	return providers;
}

export function getExternalJobProvider(name: string): ExternalJobProvider | undefined {
	const safeName = validateString(name, "External-job provider name", MAX_PROVIDER_NAME_LENGTH);
	return listExternalJobProviders().find((provider) => provider.name === safeName);
}
