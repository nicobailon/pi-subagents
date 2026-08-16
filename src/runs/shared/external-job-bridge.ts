import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { writeAtomicJson } from "../../shared/atomic-json.ts";
import {
	ExternalJobProviderError,
	getExternalJobProvider,
	validateExternalJobHandle,
	validateExternalJobResult,
	type ExternalJobHandle,
	type ExternalJobOperation,
	type ExternalJobResult,
	type ExternalJobStartInput,
} from "../../api/external-job-provider.ts";

export const EXTERNAL_JOB_BRIDGE_REQUEST_DIR = "external-job-requests";
const EXTERNAL_JOB_BRIDGE_RESPONSE_DIR = "external-job-responses";
const DEFAULT_OPERATION_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 50;
const MAX_REQUESTS_PER_SWEEP = 100;

interface ExternalJobBridgeRequest {
	id: string;
	operation: ExternalJobOperation;
	provider: string;
	providerJobId?: string;
	start?: ExternalJobStartInput;
	createdAt: number;
}

type ExternalJobBridgeResponse = {
	id: string;
	ok: true;
	operation: ExternalJobOperation;
	provider: string;
	result: ExternalJobHandle | ExternalJobResult;
	completedAt: number;
} | {
	id: string;
	ok: false;
	operation: ExternalJobOperation;
	provider: string;
	code: string;
	message: string;
	blockingJobId?: string;
	completedAt: number;
};

const inFlight = new Set<string>();

function requestDir(asyncDir: string): string {
	return path.join(asyncDir, EXTERNAL_JOB_BRIDGE_REQUEST_DIR);
}

function responseDir(asyncDir: string): string {
	return path.join(asyncDir, EXTERNAL_JOB_BRIDGE_RESPONSE_DIR);
}

function requestPath(asyncDir: string, id: string): string {
	return path.join(requestDir(asyncDir), `${id}.json`);
}

function responsePath(asyncDir: string, id: string): string {
	return path.join(responseDir(asyncDir), `${id}.json`);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function readJson<T>(filePath: string): T {
	return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
}

function bridgeError(error: unknown): { code: string; message: string; blockingJobId?: string } {
	if (error instanceof ExternalJobProviderError) {
		return { code: error.code, message: error.message, ...(error.blockingJobId ? { blockingJobId: error.blockingJobId } : {}) };
	}
	if (error && typeof error === "object") {
		const record = error as Record<string, unknown>;
		const code = typeof record.code === "string" && record.code.trim() ? record.code : "provider-error";
		const blockingJobId = typeof record.blockingJobId === "string" && record.blockingJobId.trim() ? record.blockingJobId : undefined;
		return {
			code,
			message: error instanceof Error ? error.message : String(error),
			...(blockingJobId ? { blockingJobId } : {}),
		};
	}
	return { code: "provider-error", message: String(error) };
}

function assertRequest(value: unknown, filePath: string): ExternalJobBridgeRequest {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`External-job bridge request '${filePath}' must be an object.`);
	const request = value as ExternalJobBridgeRequest;
	if (typeof request.id !== "string" || !request.id) throw new Error(`External-job bridge request '${filePath}' has invalid id.`);
	if (request.operation !== "start" && request.operation !== "status" && request.operation !== "result" && request.operation !== "reattach") throw new Error(`External-job bridge request '${filePath}' has invalid operation.`);
	if (typeof request.provider !== "string" || !request.provider.trim()) throw new Error(`External-job bridge request '${filePath}' has invalid provider.`);
	if (typeof request.createdAt !== "number") throw new Error(`External-job bridge request '${filePath}' has invalid createdAt.`);
	if (request.operation === "start") {
		if (!request.start || typeof request.start !== "object" || Array.isArray(request.start)) throw new Error(`External-job bridge start request '${filePath}' is missing start input.`);
	} else if (typeof request.providerJobId !== "string" || !request.providerJobId.trim()) {
		throw new Error(`External-job bridge ${request.operation} request '${filePath}' is missing providerJobId.`);
	}
	return request;
}

async function executeBridgeRequest(request: ExternalJobBridgeRequest): Promise<ExternalJobBridgeResponse> {
	const provider = getExternalJobProvider(request.provider);
	if (!provider) {
		return {
			id: request.id,
			ok: false,
			operation: request.operation,
			provider: request.provider,
			code: "provider-unavailable",
			message: `External-job provider '${request.provider}' is not registered. Load the Surf Pi extension and its external-job provider bridge before starting this agent.`,
			completedAt: Date.now(),
		};
	}
	try {
		const raw = request.operation === "start"
			? await provider.start(request.start!)
			: request.operation === "status"
				? await provider.status(request.providerJobId!)
				: request.operation === "reattach"
					? await provider.reattach(request.providerJobId!)
					: await provider.result(request.providerJobId!);
		const result = request.operation === "result"
			? validateExternalJobResult(provider.name, raw, "External-job bridge result")
			: validateExternalJobHandle(provider.name, raw, "External-job bridge handle");
		return { id: request.id, ok: true, operation: request.operation, provider: request.provider, result, completedAt: Date.now() };
	} catch (error) {
		const details = bridgeError(error);
		return {
			id: request.id,
			ok: false,
			operation: request.operation,
			provider: request.provider,
			...details,
			completedAt: Date.now(),
		};
	}
}

export function serviceExternalJobBridgeRequests(asyncDir: string): void {
	let files: string[];
	try {
		files = fs.readdirSync(requestDir(asyncDir)).filter((file) => file.endsWith(".json")).slice(0, MAX_REQUESTS_PER_SWEEP);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	fs.mkdirSync(responseDir(asyncDir), { recursive: true });
	for (const file of files) {
		const filePath = path.join(requestDir(asyncDir), file);
		let request: ExternalJobBridgeRequest;
		try {
			request = assertRequest(readJson(filePath), filePath);
		} catch (error) {
			const id = file.replace(/\.json$/, "");
			writeAtomicJson(responsePath(asyncDir, id), {
				id,
				ok: false,
				operation: "status",
				provider: "unknown",
				code: "malformed-request",
				message: error instanceof Error ? error.message : String(error),
				completedAt: Date.now(),
			} satisfies ExternalJobBridgeResponse);
			fs.rmSync(filePath, { force: true });
			continue;
		}
		if (inFlight.has(request.id) || fs.existsSync(responsePath(asyncDir, request.id))) continue;
		inFlight.add(request.id);
		void executeBridgeRequest(request).then((response) => {
			writeAtomicJson(responsePath(asyncDir, request.id), response);
			fs.rmSync(filePath, { force: true });
		}).catch((error) => {
			writeAtomicJson(responsePath(asyncDir, request.id), {
				id: request.id,
				ok: false,
				operation: request.operation,
				provider: request.provider,
				code: "bridge-error",
				message: error instanceof Error ? error.message : String(error),
				completedAt: Date.now(),
			} satisfies ExternalJobBridgeResponse);
		}).finally(() => {
			inFlight.delete(request.id);
		});
	}
}

export async function requestExternalJobOperation<T extends ExternalJobHandle | ExternalJobResult>(asyncDir: string, request: Omit<ExternalJobBridgeRequest, "id" | "createdAt">, timeoutMs = DEFAULT_OPERATION_TIMEOUT_MS): Promise<T> {
	const id = randomUUID();
	fs.mkdirSync(requestDir(asyncDir), { recursive: true });
	fs.mkdirSync(responseDir(asyncDir), { recursive: true });
	writeAtomicJson(requestPath(asyncDir, id), { ...request, id, createdAt: Date.now() } satisfies ExternalJobBridgeRequest);
	const deadline = Date.now() + timeoutMs;
	const outPath = responsePath(asyncDir, id);
	while (!fs.existsSync(outPath)) {
		if (Date.now() >= deadline) {
			throw new ExternalJobProviderError(
				`External-job provider bridge did not respond to ${request.operation} for provider '${request.provider}' within ${timeoutMs}ms.`,
				{ code: "bridge-timeout" },
			);
		}
		await sleep(POLL_INTERVAL_MS);
	}
	const response = readJson<ExternalJobBridgeResponse>(outPath);
	fs.rmSync(outPath, { force: true });
	if (!response.ok) throw new ExternalJobProviderError(response.message, { code: response.code, ...(response.blockingJobId ? { blockingJobId: response.blockingJobId } : {}) });
	return response.result as T;
}
