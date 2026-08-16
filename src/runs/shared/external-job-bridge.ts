import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
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
	claimedAt?: number;
}

interface ExternalJobClaimOwner {
	version: 1;
	pid: number;
	hostname: string;
	claimedAt: number;
	processStartIdentity?: string;
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

export type ExternalJobBridgeCancel = () => ExternalJobProviderError | undefined;

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

function startClaimDir(asyncDir: string, id: string): string {
	return path.join(requestDir(asyncDir), `${id}.claim`);
}

function startClaimTempDir(asyncDir: string, id: string): string {
	return path.join(requestDir(asyncDir), `${id}.claim.tmp-${randomUUID()}`);
}

function startClaimCompletedPath(claimDir: string): string {
	return path.join(claimDir, "completed.json");
}

function startClaimHandlePath(claimDir: string): string {
	return path.join(claimDir, "handle.json");
}

function completedStartClaimExists(asyncDir: string, id: string): boolean {
	return fs.existsSync(startClaimCompletedPath(startClaimDir(asyncDir, id)));
}

function cancelStartRequest(asyncDir: string, request: ExternalJobBridgeRequest): boolean {
	const claimDir = startClaimDir(asyncDir, request.id);
	const tempClaimDir = startClaimTempDir(asyncDir, request.id);
	try {
		fs.mkdirSync(tempClaimDir);
		writeAtomicJson(startClaimCompletedPath(tempClaimDir), { completedAt: Date.now() });
		fs.renameSync(tempClaimDir, claimDir);
	} catch (error) {
		fs.rmSync(tempClaimDir, { recursive: true, force: true });
		if (isClaimConflictError(error)) return false;
		throw error;
	}
	fs.rmSync(requestPath(asyncDir, request.id), { force: true });
	return true;
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

function processStartIdentity(pid: number): string | undefined {
	if (process.platform === "linux") {
		try {
			const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf-8");
			const commandEnd = stat.lastIndexOf(")");
			if (commandEnd === -1) return undefined;
			const fields = stat.slice(commandEnd + 1).trim().split(/\s+/);
			const startTicks = fields[19];
			return startTicks ? `linux:${startTicks}` : undefined;
		} catch {
			return undefined;
		}
	}
	if (process.platform === "darwin" || process.platform === "freebsd") {
		const result = spawnSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf-8" });
		const started = result.status === 0 ? result.stdout.trim() : "";
		return started ? `${process.platform}:${started}` : undefined;
	}
	return undefined;
}

function processIsAlive(pid: number): boolean | undefined {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ESRCH") return false;
		if (code === "EPERM") return true;
		return undefined;
	}
}

function currentClaimOwner(): ExternalJobClaimOwner {
	const startIdentity = processStartIdentity(process.pid);
	return {
		version: 1,
		pid: process.pid,
		hostname: os.hostname(),
		claimedAt: Date.now(),
		...(startIdentity ? { processStartIdentity: startIdentity } : {}),
	};
}

function isClaimConflictError(error: unknown): boolean {
	if (typeof error !== "object" || error === null || !("code" in error)) return false;
	const code = (error as NodeJS.ErrnoException).code;
	return code === "EEXIST" || code === "ENOTEMPTY" || code === "EPERM";
}

function isNotFoundError(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
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
	if (request.claimedAt !== undefined && typeof request.claimedAt !== "number") throw new Error(`External-job bridge request '${filePath}' has invalid claimedAt.`);
	if (request.operation === "start") {
		if (!request.start || typeof request.start !== "object" || Array.isArray(request.start)) throw new Error(`External-job bridge start request '${filePath}' is missing start input.`);
	} else if (typeof request.providerJobId !== "string" || !request.providerJobId.trim()) {
		throw new Error(`External-job bridge ${request.operation} request '${filePath}' is missing providerJobId.`);
	}
	return request;
}

async function executeBridgeRequest(request: ExternalJobBridgeRequest, claimDir?: string): Promise<ExternalJobBridgeResponse> {
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
		if (request.operation === "start" && claimDir) writeAtomicJson(startClaimHandlePath(claimDir), result);
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

function claimStartRequest(asyncDir: string, filePath: string, request: ExternalJobBridgeRequest): { request: ExternalJobBridgeRequest; filePath: string } | undefined {
	const owner = currentClaimOwner();
	const claimed: ExternalJobBridgeRequest = { ...request, claimedAt: owner.claimedAt };
	const claimDir = startClaimDir(asyncDir, request.id);
	const tempClaimDir = startClaimTempDir(asyncDir, request.id);
	try {
		fs.mkdirSync(tempClaimDir);
		writeAtomicJson(path.join(tempClaimDir, "owner.json"), owner);
		writeAtomicJson(path.join(tempClaimDir, "request.json"), claimed);
		fs.renameSync(tempClaimDir, claimDir);
	} catch (error) {
		fs.rmSync(tempClaimDir, { recursive: true, force: true });
		if (isClaimConflictError(error)) return undefined;
		throw error;
	}
	fs.rmSync(filePath, { force: true });
	return { request: claimed, filePath: claimDir };
}

function parseClaimOwner(value: unknown): ExternalJobClaimOwner | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const owner = value as Partial<ExternalJobClaimOwner>;
	if (owner.version !== 1 || typeof owner.pid !== "number" || !Number.isInteger(owner.pid) || owner.pid <= 0 || typeof owner.hostname !== "string" || typeof owner.claimedAt !== "number") return undefined;
	if (owner.processStartIdentity !== undefined && typeof owner.processStartIdentity !== "string") return undefined;
	return owner as ExternalJobClaimOwner;
}

function claimOwnerIsDead(owner: ExternalJobClaimOwner | undefined): boolean {
	if (!owner || owner.hostname !== os.hostname()) return false;
	const alive = processIsAlive(owner.pid);
	if (alive === false) return true;
	if (alive !== true || !owner.processStartIdentity) return false;
	const currentIdentity = processStartIdentity(owner.pid);
	return currentIdentity !== undefined && currentIdentity !== owner.processStartIdentity;
}

function readClaimOwner(claimDir: string): ExternalJobClaimOwner | undefined {
	try {
		return parseClaimOwner(readJson(path.join(claimDir, "owner.json")));
	} catch {
		return undefined;
	}
}

function readClaimHandle(provider: string, claimDir: string): ExternalJobHandle | undefined {
	try {
		return validateExternalJobHandle(provider, readJson(startClaimHandlePath(claimDir)), "External-job bridge recovered start handle");
	} catch {
		return undefined;
	}
}

export function serviceExternalJobBridgeRequests(asyncDir: string): void {
	let files: string[];
	try {
		files = fs.readdirSync(requestDir(asyncDir), { withFileTypes: true })
			.filter((entry) => (entry.isFile() && entry.name.endsWith(".json") && !completedStartClaimExists(asyncDir, entry.name.replace(/\.json$/, ""))) || (entry.isDirectory() && entry.name.endsWith(".claim") && !fs.existsSync(startClaimCompletedPath(path.join(requestDir(asyncDir), entry.name)))))
			.map((entry) => entry.name)
			.slice(0, MAX_REQUESTS_PER_SWEEP);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	fs.mkdirSync(responseDir(asyncDir), { recursive: true });
	for (const file of files) {
		serviceExternalJobBridgeRequestFile(asyncDir, file);
	}
}

export function serviceExternalJobBridgeRequestFile(asyncDir: string, file: string): void {
	fs.mkdirSync(responseDir(asyncDir), { recursive: true });
	if (file.endsWith(".claim")) {
		serviceExternalJobStartClaim(asyncDir, file);
		return;
	}
	const filePath = path.join(requestDir(asyncDir), file);
	let request: ExternalJobBridgeRequest;
	try {
		request = assertRequest(readJson(filePath), filePath);
	} catch (error) {
		if (isNotFoundError(error)) return;
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
		return;
	}
	if (request.operation === "start" && completedStartClaimExists(asyncDir, request.id)) {
		fs.rmSync(filePath, { force: true });
		return;
	}
	if (inFlight.has(request.id) || fs.existsSync(responsePath(asyncDir, request.id))) return;
	if (request.operation === "start" && request.claimedAt !== undefined) return;
	const claimed = request.operation === "start" ? claimStartRequest(asyncDir, filePath, request) : { request, filePath };
	if (!claimed) return;
	const claimedRequest = claimed.request;
	inFlight.add(claimedRequest.id);
	void executeBridgeRequest(claimedRequest, claimedRequest.operation === "start" ? claimed.filePath : undefined).then((response) => {
		writeAtomicJson(responsePath(asyncDir, claimedRequest.id), response);
		if (claimedRequest.operation === "start") {
			writeAtomicJson(startClaimCompletedPath(claimed.filePath), { completedAt: Date.now() });
		} else {
			fs.rmSync(claimed.filePath, { recursive: true, force: true });
		}
	}).catch((error) => {
		writeAtomicJson(responsePath(asyncDir, claimedRequest.id), {
			id: claimedRequest.id,
			ok: false,
			operation: claimedRequest.operation,
			provider: claimedRequest.provider,
			code: "bridge-error",
			message: error instanceof Error ? error.message : String(error),
			completedAt: Date.now(),
		} satisfies ExternalJobBridgeResponse);
		if (claimedRequest.operation === "start") writeAtomicJson(startClaimCompletedPath(claimed.filePath), { completedAt: Date.now() });
	}).finally(() => {
		inFlight.delete(claimedRequest.id);
	});
}

function serviceExternalJobStartClaim(asyncDir: string, file: string): void {
	const claimDir = path.join(requestDir(asyncDir), file);
	if (fs.existsSync(startClaimCompletedPath(claimDir))) return;
	const owner = readClaimOwner(claimDir);
	if (!owner && fs.existsSync(requestPath(asyncDir, file.replace(/\.claim$/, ""))) && !fs.existsSync(responsePath(asyncDir, file.replace(/\.claim$/, "")))) {
		fs.rmSync(claimDir, { recursive: true, force: true });
		return;
	}
	if (!claimOwnerIsDead(owner)) return;
	let request: ExternalJobBridgeRequest;
	try {
		request = assertRequest(readJson(path.join(claimDir, "request.json")), path.join(claimDir, "request.json"));
	} catch {
		return;
	}
	if (request.operation !== "start" || fs.existsSync(responsePath(asyncDir, request.id))) return;
	const handle = readClaimHandle(request.provider, claimDir);
	if (handle) {
		writeAtomicJson(responsePath(asyncDir, request.id), {
			id: request.id,
			ok: true,
			operation: request.operation,
			provider: request.provider,
			result: handle,
			completedAt: Date.now(),
		} satisfies ExternalJobBridgeResponse);
		writeAtomicJson(startClaimCompletedPath(claimDir), { completedAt: Date.now() });
		fs.rmSync(requestPath(asyncDir, request.id), { force: true });
		return;
	}
	writeAtomicJson(responsePath(asyncDir, request.id), {
		id: request.id,
		ok: false,
		operation: request.operation,
		provider: request.provider,
		code: "start-dispatch-abandoned",
		message: `External-job start for provider '${request.provider}' was claimed by a host process that is no longer alive before a provider job id was committed. Refusing to redispatch the prompt automatically.`,
		completedAt: Date.now(),
	} satisfies ExternalJobBridgeResponse);
	fs.rmSync(claimDir, { recursive: true, force: true });
	fs.rmSync(requestPath(asyncDir, request.id), { force: true });
}

export async function requestExternalJobOperation<T extends ExternalJobHandle | ExternalJobResult>(asyncDir: string, request: Omit<ExternalJobBridgeRequest, "id" | "createdAt">, timeoutMs = DEFAULT_OPERATION_TIMEOUT_MS, cancel?: ExternalJobBridgeCancel): Promise<T> {
	const id = randomUUID();
	fs.mkdirSync(requestDir(asyncDir), { recursive: true });
	fs.mkdirSync(responseDir(asyncDir), { recursive: true });
	const bridgeRequest = { ...request, id, createdAt: Date.now() } satisfies ExternalJobBridgeRequest;
	writeAtomicJson(requestPath(asyncDir, id), bridgeRequest);
	const deadline = request.operation === "start" ? undefined : Date.now() + timeoutMs;
	const outPath = responsePath(asyncDir, id);
	while (!fs.existsSync(outPath)) {
		const canceled = cancel?.();
		if (canceled) {
			if (request.operation === "start" && !cancelStartRequest(asyncDir, bridgeRequest)) {
				await sleep(POLL_INTERVAL_MS);
				continue;
			}
			if (request.operation !== "start") fs.rmSync(requestPath(asyncDir, id), { force: true });
			throw canceled;
		}
		if (deadline !== undefined && Date.now() >= deadline) {
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
