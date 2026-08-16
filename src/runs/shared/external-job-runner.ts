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

function readExistingExternalJob(asyncDir: string, stepIndex: number): ExternalJobStatus | undefined {
	try {
		const status = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8")) as { steps?: Array<{ externalJob?: ExternalJobStatus }> };
		return status.steps?.[stepIndex]?.externalJob;
	} catch {
		return undefined;
	}
}

function statusFromHandle(input: {
	provider: string;
	promptDigest: string;
	options: Record<string, unknown>;
	startedAt?: number;
	previous?: ExternalJobStatus;
	handle: ExternalJobHandle;
	resultArtifactPath?: string;
}): ExternalJobStatus {
	return {
		provider: input.provider,
		providerJobId: input.handle.providerJobId,
		promptDigest: input.promptDigest,
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
	previous?: ExternalJobStatus;
	code: string;
	message: string;
	blockingJobId?: string;
}): ExternalJobStatus {
	return {
		provider: input.provider,
		providerJobId: input.previous?.providerJobId,
		promptDigest: input.promptDigest,
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
}): Promise<ExternalJobRunResult> {
	const provider = input.provider;
	const options = input.options ?? {};
	const promptDigest = externalJobPromptDigest(input.prompt);
	const startedAt = Date.now();
	let timedOut = false;
	let stopped = false;
	let current = readExistingExternalJob(input.asyncDir, input.stepIndex);
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
		let handle: ExternalJobHandle;
		if (current?.providerJobId) {
			if (current.provider !== provider || current.promptDigest !== promptDigest) {
				const message = `Existing external job '${current.providerJobId}' does not match provider or prompt digest. Refusing to redispatch prompt.`;
				const status = failureStatus({ provider, promptDigest, options, previous: current, code: "recovery-mismatch", message });
				publish(status);
				return { output: message, exitCode: 1, error: message, externalJob: status };
			}
			handle = await requestExternalJobOperation<ExternalJobHandle>(input.asyncDir, { operation: "reattach", provider, providerJobId: current.providerJobId });
		} else {
			if (current && blocksStartRedispatch(current, provider, promptDigest)) {
				const message = `External-job start for provider '${provider}' previously ended without a durable provider job id. Refusing to redispatch the prompt automatically.`;
				const status = failureStatus({ provider, promptDigest, options, previous: current, code: "start-redispatch-blocked", message });
				publish(status);
				return { output: message, exitCode: 1, error: message, externalJob: status };
			}
			publish({ provider, promptDigest, options, state: "queued", startedAt, updatedAt: Date.now() });
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
		publish(statusFromHandle({ provider, promptDigest, options, startedAt, previous: current, handle }));
		while (!terminal(handle.state)) {
			if (timedOut || stopped) {
				const message = stopped
					? input.stopMessage ?? `Subagent stopped locally; external provider job '${handle.providerJobId}' may still be running.`
					: input.timeoutMessage ?? `Subagent timed out locally; external provider job '${handle.providerJobId}' may still be running.`;
				return { output: message, exitCode: 1, error: message, ...(timedOut ? { timedOut: true } : {}), ...(stopped ? { stopped: true } : {}), externalJob: current! };
			}
			await sleep(STATUS_POLL_INTERVAL_MS);
			handle = await requestExternalJobOperation<ExternalJobHandle>(input.asyncDir, { operation: "status", provider, providerJobId: handle.providerJobId });
			publish(statusFromHandle({ provider, promptDigest, options, previous: current, handle }));
		}
		const result = await requestExternalJobOperation<ExternalJobResult>(input.asyncDir, { operation: "result", provider, providerJobId: handle.providerJobId });
		let artifactPath = result.artifactPath;
		if (!artifactPath && result.output !== undefined) {
			artifactPath = path.join(input.asyncDir, `external-job-${input.stepIndex}.result.md`);
			fs.writeFileSync(artifactPath, result.output, "utf-8");
		}
		const finalStatus = statusFromHandle({ provider, promptDigest, options, previous: current, handle: result, resultArtifactPath: artifactPath });
		publish(finalStatus);
		const output = resultOutput(result, artifactPath);
		const error = result.state === "completed" ? undefined : result.failureMessage ?? `External job ${result.state}.`;
		return { output, exitCode: result.state === "completed" ? 0 : 1, ...(error ? { error } : {}), externalJob: finalStatus };
	} catch (error) {
		const providerError = error instanceof ExternalJobProviderError
			? error
			: new ExternalJobProviderError(error instanceof Error ? error.message : String(error), { code: "provider-error", cause: error });
		const message = formatError(providerError, provider);
		const status = failureStatus({ provider, promptDigest, options, previous: current, code: providerError.code, message, ...(providerError.blockingJobId ? { blockingJobId: providerError.blockingJobId } : {}) });
		publish(status);
		return { output: message, exitCode: 1, error: message, ...(timedOut ? { timedOut: true } : {}), ...(stopped ? { stopped: true } : {}), externalJob: status };
	} finally {
		input.registerTimeout?.(undefined);
		input.registerStop?.(undefined);
	}
}
