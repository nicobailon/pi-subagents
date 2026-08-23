import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { ExternalJobProviderError, type ExternalJobHandle, type ExternalJobResult, type ExternalJobState } from "../../api/external-job-provider.ts";
import type { ExternalJobStatus } from "../../shared/types.ts";
import { requestExternalJobOperation } from "./external-job-bridge.ts";

const STATUS_POLL_INTERVAL_MS = 1_000;

export interface ExternalJobRunResult {
	output: string;
	exitCode: number;
	error?: string;
	timedOut?: boolean;
	stopped?: boolean;
	externalJob: ExternalJobStatus;
}

export function externalJobPromptDigest(prompt: string): string {
	return createHash("sha256").update(prompt).digest("hex");
}

export function externalJobStableJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(externalJobStableJson).join(",")}]`;
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${externalJobStableJson(record[key])}`).join(",")}}`;
}

export function externalJobFollowUpRequestDigest(input: { provider: string; parentProviderJobId: string; promptDigest: string; options: Record<string, unknown> }): string {
	return createHash("sha256")
		.update(externalJobStableJson({ provider: input.provider, parentProviderJobId: input.parentProviderJobId, promptDigest: input.promptDigest, options: input.options }))
		.digest("hex");
}

export function externalJobFollowUpRequestId(requestDigest: string): string {
	return `follow-up-${requestDigest.slice(0, 48)}`;
}

export function externalJobFollowUpRunId(requestDigest: string): string {
	const hex = requestDigest.padEnd(32, "0").slice(0, 32).split("");
	hex[12] = "4";
	hex[16] = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
	const value = hex.join("");
	return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20, 32)}`;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function terminal(state: ExternalJobState): boolean {
	return state === "completed" || state === "failed" || state === "stopped" || state === "blocked";
}

function formatError(error: ExternalJobProviderError, provider: string): string {
	const blocking = error.blockingJobId ? ` Blocking provider job: ${error.blockingJobId}.` : "";
	return `External-job provider '${provider}' failed closed (${error.code}): ${error.message}.${blocking}`;
}

function isNotFound(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function malformedStatus(statusPath: string): ExternalJobProviderError {
	return new ExternalJobProviderError(`Malformed external-job status '${statusPath}'. Refusing to redispatch the prompt.`, { code: "status-unreadable" });
}

function parseExternalJobStatus(value: unknown, statusPath: string): ExternalJobStatus {
	if (!isRecord(value)) throw malformedStatus(statusPath);
	const provider = value.provider;
	const promptDigest = value.promptDigest;
	const state = value.state;
	if (typeof provider !== "string" || provider.length === 0) throw malformedStatus(statusPath);
	if (typeof promptDigest !== "string" || promptDigest.length === 0) throw malformedStatus(statusPath);
	if (state !== "queued" && state !== "running" && state !== "completed" && state !== "failed" && state !== "stopped" && state !== "blocked") throw malformedStatus(statusPath);
	if (value.options !== undefined && !isRecord(value.options)) throw malformedStatus(statusPath);
	const providerJobId = value.providerJobId;
	const handleUrl = value.handleUrl;
	const conversationUrl = value.conversationUrl;
	const resultArtifactPath = value.resultArtifactPath;
	const failureCode = value.failureCode;
	const failureMessage = value.failureMessage;
	const blockingJobId = value.blockingJobId;
	const startedAt = value.startedAt;
	const updatedAt = value.updatedAt;
	if (providerJobId !== undefined && (typeof providerJobId !== "string" || providerJobId.length === 0)) throw malformedStatus(statusPath);
	if (handleUrl !== undefined && typeof handleUrl !== "string") throw malformedStatus(statusPath);
	if (conversationUrl !== undefined && typeof conversationUrl !== "string") throw malformedStatus(statusPath);
	if (resultArtifactPath !== undefined && typeof resultArtifactPath !== "string") throw malformedStatus(statusPath);
	if (failureCode !== undefined && typeof failureCode !== "string") throw malformedStatus(statusPath);
	if (failureMessage !== undefined && typeof failureMessage !== "string") throw malformedStatus(statusPath);
	if (blockingJobId !== undefined && typeof blockingJobId !== "string") throw malformedStatus(statusPath);
	const operation = value.operation;
	const sourceRunId = value.sourceRunId;
	const sourceStepIndex = value.sourceStepIndex;
	const parentProviderJobId = value.parentProviderJobId;
	const requestId = value.requestId;
	const requestDigest = value.requestDigest;
	if (operation !== undefined && operation !== "start" && operation !== "follow-up") throw malformedStatus(statusPath);
	if (sourceRunId !== undefined && (typeof sourceRunId !== "string" || sourceRunId.length === 0)) throw malformedStatus(statusPath);
	if (sourceStepIndex !== undefined && (typeof sourceStepIndex !== "number" || !Number.isInteger(sourceStepIndex) || sourceStepIndex < 0)) throw malformedStatus(statusPath);
	if (parentProviderJobId !== undefined && (typeof parentProviderJobId !== "string" || parentProviderJobId.length === 0)) throw malformedStatus(statusPath);
	if (requestId !== undefined && (typeof requestId !== "string" || requestId.length === 0)) throw malformedStatus(statusPath);
	if (requestDigest !== undefined && (typeof requestDigest !== "string" || requestDigest.length === 0)) throw malformedStatus(statusPath);
	if (startedAt !== undefined && typeof startedAt !== "number") throw malformedStatus(statusPath);
	if (updatedAt !== undefined && typeof updatedAt !== "number") throw malformedStatus(statusPath);
	return {
		provider,
		promptDigest,
		...(operation ? { operation } : {}),
		...(sourceRunId ? { sourceRunId } : {}),
		...(sourceStepIndex !== undefined ? { sourceStepIndex } : {}),
		...(parentProviderJobId ? { parentProviderJobId } : {}),
		...(requestId ? { requestId } : {}),
		...(requestDigest ? { requestDigest } : {}),
		options: value.options ?? {},
		state,
		...(providerJobId ? { providerJobId } : {}),
		...(handleUrl ? { handleUrl } : {}),
		...(conversationUrl ? { conversationUrl } : {}),
		...(resultArtifactPath ? { resultArtifactPath } : {}),
		...(failureCode ? { failureCode } : {}),
		...(failureMessage ? { failureMessage } : {}),
		...(blockingJobId ? { blockingJobId } : {}),
		...(startedAt !== undefined ? { startedAt } : {}),
		...(updatedAt !== undefined ? { updatedAt } : {}),
	};
}

function readExistingExternalJob(asyncDir: string, stepIndex: number): ExternalJobStatus | undefined {
	const statusPath = path.join(asyncDir, "status.json");
	let raw: string;
	try {
		raw = fs.readFileSync(statusPath, "utf-8");
	} catch (error) {
		if (isNotFound(error)) return undefined;
		throw new ExternalJobProviderError(`Unreadable external-job status '${statusPath}'. Refusing to redispatch the prompt.`, { code: "status-unreadable", cause: error });
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new ExternalJobProviderError(`Malformed external-job status '${statusPath}'. Refusing to redispatch the prompt.`, { code: "status-unreadable", cause: error });
	}
	if (!isRecord(parsed) || !Array.isArray(parsed.steps)) throw malformedStatus(statusPath);
	const step = parsed.steps[stepIndex];
	if (step === undefined || !isRecord(step)) throw malformedStatus(statusPath);
	if (step.externalJob === undefined) return undefined;
	return parseExternalJobStatus(step.externalJob, statusPath);
}

function externalJobLineage(followUp: ExternalJobFollowUpDescriptor | undefined, previous: ExternalJobStatus | undefined) {
	return {
		operation: followUp ? "follow-up" as const : previous?.operation,
		...(followUp ? {
			sourceRunId: followUp.sourceRunId,
			sourceStepIndex: followUp.sourceStepIndex,
			parentProviderJobId: followUp.parentProviderJobId,
			requestId: followUp.requestId,
			requestDigest: followUp.requestDigest,
		} : {
			...(previous?.sourceRunId ? { sourceRunId: previous.sourceRunId } : {}),
			...(previous?.sourceStepIndex !== undefined ? { sourceStepIndex: previous.sourceStepIndex } : {}),
			...(previous?.parentProviderJobId ? { parentProviderJobId: previous.parentProviderJobId } : {}),
			...(previous?.requestId ? { requestId: previous.requestId } : {}),
			...(previous?.requestDigest ? { requestDigest: previous.requestDigest } : {}),
		}),
	};
}

function statusFromHandle(input: {
	provider: string;
	promptDigest: string;
	options: Record<string, unknown>;
	followUp?: ExternalJobFollowUpDescriptor;
	startedAt?: number;
	previous?: ExternalJobStatus;
	handle: ExternalJobHandle;
	resultArtifactPath?: string;
}): ExternalJobStatus {
	return {
		provider: input.provider,
		providerJobId: input.handle.providerJobId,
		promptDigest: input.promptDigest,
		...externalJobLineage(input.followUp, input.previous),
		options: input.options,
		handleUrl: input.handle.handleUrl ?? input.previous?.handleUrl,
		conversationUrl: input.handle.conversationUrl ?? input.previous?.conversationUrl,
		resultArtifactPath: input.resultArtifactPath ?? input.previous?.resultArtifactPath,
		state: input.handle.state,
		failureCode: input.handle.failureCode,
		failureMessage: input.handle.failureMessage,
		blockingJobId: input.handle.blockingJobId,
		startedAt: input.previous?.startedAt ?? input.startedAt,
		updatedAt: Date.now(),
	};
}

function failureStatus(input: {
	provider: string;
	promptDigest: string;
	options: Record<string, unknown>;
	followUp?: ExternalJobFollowUpDescriptor;
	previous?: ExternalJobStatus;
	code: string;
	message: string;
	blockingJobId?: string;
}): ExternalJobStatus {
	return {
		provider: input.provider,
		providerJobId: input.previous?.providerJobId,
		promptDigest: input.promptDigest,
		...externalJobLineage(input.followUp, input.previous),
		options: input.options,
		handleUrl: input.previous?.handleUrl,
		conversationUrl: input.previous?.conversationUrl,
		resultArtifactPath: input.previous?.resultArtifactPath,
		state: input.blockingJobId ? "blocked" : "failed",
		failureCode: input.code,
		failureMessage: input.message,
		blockingJobId: input.blockingJobId,
		startedAt: input.previous?.startedAt,
		updatedAt: Date.now(),
	};
}

function resultOutput(result: ExternalJobResult, artifactPath: string | undefined): string {
	if (result.output?.trim()) return result.output.trim();
	if (artifactPath) return `External job finished. Result artifact: ${artifactPath}`;
	return "External job finished without text output.";
}

function blocksStartRedispatch(status: ExternalJobStatus, provider: string, promptDigest: string): boolean {
	return status.provider === provider
		&& status.promptDigest === promptDigest
		&& !status.providerJobId
		&& status.failureCode !== "provider-unavailable";
}

interface ExternalJobFollowUpDescriptor {
	sourceRunId: string;
	sourceStepIndex: number;
	parentProviderJobId: string;
	requestId: string;
	requestDigest: string;
}

function sameFollowUpLineage(status: ExternalJobStatus, followUp: ExternalJobFollowUpDescriptor | undefined): boolean {
	if (!followUp) return status.operation !== "follow-up";
	return status.operation === "follow-up"
		&& status.sourceRunId === followUp.sourceRunId
		&& status.sourceStepIndex === followUp.sourceStepIndex
		&& status.parentProviderJobId === followUp.parentProviderJobId
		&& status.requestId === followUp.requestId
		&& status.requestDigest === followUp.requestDigest;
}

export async function runExternalJob(input: {
	provider: string;
	options?: Record<string, unknown>;
	cwd: string;
	prompt: string;
	asyncDir: string;
	stepIndex: number;
	runId: string;
	agent: string;
	sessionId?: string;
	registerTimeout?: (stop: (() => void) | undefined) => void;
	registerStop?: (stop: (() => void) | undefined) => void;
	timeoutMessage?: string;
	stopMessage?: string;
	onExternalJob?: (status: ExternalJobStatus) => void;
	followUp?: ExternalJobFollowUpDescriptor;
}): Promise<ExternalJobRunResult> {
	const provider = input.provider;
	const options = input.options ?? {};
	const promptDigest = externalJobPromptDigest(input.prompt);
	const startedAt = Date.now();
	let timedOut = false;
	let stopped = false;
	let current: ExternalJobStatus | undefined;
	const timeout = () => { timedOut = true; };
	const stop = () => { stopped = true; };
	input.registerTimeout?.(timeout);
	input.registerStop?.(stop);
	const publish = (status: ExternalJobStatus) => {
		current = status;
		input.onExternalJob?.(status);
	};
	const localCancellation = () => {
		if (!timedOut && !stopped) return undefined;
		const message = stopped
			? input.stopMessage ?? `Subagent stopped locally before external provider '${provider}' returned a job id. The provider start may still be running.`
			: input.timeoutMessage ?? `Subagent timed out locally before external provider '${provider}' returned a job id. The provider start may still be running.`;
		return new ExternalJobProviderError(message, { code: stopped ? "local-stop" : "local-timeout" });
	};
	try {
		current = readExistingExternalJob(input.asyncDir, input.stepIndex);
		let handle: ExternalJobHandle;
		if (current?.providerJobId) {
			if (current.provider !== provider || current.promptDigest !== promptDigest || !sameFollowUpLineage(current, input.followUp)) {
				const message = `Existing external job '${current.providerJobId}' does not match provider, prompt digest, or follow-up lineage. Refusing to redispatch prompt.`;
				const status = failureStatus({ provider, promptDigest, options, followUp: input.followUp, previous: current, code: "recovery-mismatch", message });
				publish(status);
				return { output: message, exitCode: 1, error: message, externalJob: status };
			}
			handle = await requestExternalJobOperation<ExternalJobHandle>(input.asyncDir, { operation: "reattach", provider, providerJobId: current.providerJobId });
		} else {
			if (current && blocksStartRedispatch(current, provider, promptDigest)) {
				const message = `External-job ${input.followUp ? "follow-up" : "start"} for provider '${provider}' previously ended without a durable provider job id. Refusing to redispatch the prompt automatically.`;
				const status = failureStatus({ provider, promptDigest, options, followUp: input.followUp, previous: current, code: input.followUp ? "dispatch-redispatch-blocked" : "start-redispatch-blocked", message });
				publish(status);
				return { output: message, exitCode: 1, error: message, externalJob: status };
			}
			publish({ provider, promptDigest, ...(input.followUp ? { operation: "follow-up" as const, ...input.followUp } : {}), options, state: "queued", startedAt, updatedAt: Date.now() });
			if (input.followUp) {
				handle = await requestExternalJobOperation<ExternalJobHandle>(input.asyncDir, {
					operation: "follow-up",
					provider,
					followUp: {
						prompt: input.prompt,
						promptDigest,
						cwd: input.cwd,
						runId: input.runId,
						stepIndex: input.stepIndex,
						agent: input.agent,
						options,
						...(input.sessionId ? { sessionId: input.sessionId } : {}),
						...input.followUp,
					},
				}, undefined, localCancellation);
			} else {
				handle = await requestExternalJobOperation<ExternalJobHandle>(input.asyncDir, {
					operation: "start",
					provider,
					start: {
						prompt: input.prompt,
						promptDigest,
						cwd: input.cwd,
						runId: input.runId,
						stepIndex: input.stepIndex,
						agent: input.agent,
						options,
						...(input.sessionId ? { sessionId: input.sessionId } : {}),
					},
				}, undefined, localCancellation);
			}
		}
		publish(statusFromHandle({ provider, promptDigest, options, followUp: input.followUp, startedAt, previous: current, handle }));
		while (!terminal(handle.state)) {
			if (timedOut || stopped) {
				const message = stopped
					? input.stopMessage ?? `Subagent stopped locally; external provider job '${handle.providerJobId}' may still be running.`
					: input.timeoutMessage ?? `Subagent timed out locally; external provider job '${handle.providerJobId}' may still be running.`;
				return { output: message, exitCode: 1, error: message, ...(timedOut ? { timedOut: true } : {}), ...(stopped ? { stopped: true } : {}), externalJob: current! };
			}
			await sleep(STATUS_POLL_INTERVAL_MS);
			handle = await requestExternalJobOperation<ExternalJobHandle>(input.asyncDir, { operation: "status", provider, providerJobId: handle.providerJobId });
			publish(statusFromHandle({ provider, promptDigest, options, followUp: input.followUp, previous: current, handle }));
		}
		const result = await requestExternalJobOperation<ExternalJobResult>(input.asyncDir, { operation: "result", provider, providerJobId: handle.providerJobId });
		let artifactPath = result.artifactPath;
		if (!artifactPath && result.output !== undefined) {
			artifactPath = path.join(input.asyncDir, `external-job-${input.stepIndex}.result.md`);
			fs.writeFileSync(artifactPath, result.output, "utf-8");
		}
		const finalStatus = statusFromHandle({ provider, promptDigest, options, followUp: input.followUp, previous: current, handle: result, resultArtifactPath: artifactPath });
		publish(finalStatus);
		const output = resultOutput(result, artifactPath);
		const error = result.state === "completed" ? undefined : result.failureMessage ?? `External job ${result.state}.`;
		return { output, exitCode: result.state === "completed" ? 0 : 1, ...(error ? { error } : {}), externalJob: finalStatus };
	} catch (error) {
		const providerError = error instanceof ExternalJobProviderError
			? error
			: new ExternalJobProviderError(error instanceof Error ? error.message : String(error), { code: "provider-error", cause: error });
		const message = formatError(providerError, provider);
		const status = failureStatus({ provider, promptDigest, options, followUp: input.followUp, previous: current, code: providerError.code, message, ...(providerError.blockingJobId ? { blockingJobId: providerError.blockingJobId } : {}) });
		publish(status);
		return { output: message, exitCode: 1, error: message, ...(timedOut ? { timedOut: true } : {}), ...(stopped ? { stopped: true } : {}), externalJob: status };
	} finally {
		input.registerTimeout?.(undefined);
		input.registerStop?.(undefined);
	}
}
