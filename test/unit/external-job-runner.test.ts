import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { EXTERNAL_JOB_PROVIDER_REGISTRY_KEY, ExternalJobProviderError, registerExternalJobProvider } from "../../src/api/external-job-provider.ts";
import { serviceExternalJobBridgeRequests } from "../../src/runs/shared/external-job-bridge.ts";
import { externalJobPromptDigest, runExternalJob } from "../../src/runs/shared/external-job-runner.ts";

const tempDirs: string[] = [];

function clearRegistry(): void {
	delete (globalThis as Record<PropertyKey, unknown>)[Symbol.for(EXTERNAL_JOB_PROVIDER_REGISTRY_KEY)];
}

afterEach(() => {
	clearRegistry();
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

async function serviceUntil<T>(asyncDir: string, promise: Promise<T>): Promise<T> {
	let done = false;
	void promise.finally(() => { done = true; });
	while (!done) {
		serviceExternalJobBridgeRequests(asyncDir);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	return promise;
}

describe("external-job runner bridge", () => {
	it("starts a provider job and persists result artifact metadata", async () => {
		const dir = tempDir("pi-external-job-start-");
		let startInput: { promptDigest: string; options: Record<string, unknown> } | undefined;
		registerExternalJobProvider({
			name: "surf-oracle",
			start: (input) => {
				startInput = { promptDigest: input.promptDigest, options: input.options };
				return { providerJobId: "job-1", state: "completed", conversationUrl: "https://surf.example/jobs/job-1" };
			},
			status: () => ({ providerJobId: "job-1", state: "completed" }),
			reattach: () => ({ providerJobId: "job-1", state: "completed" }),
			result: () => ({ providerJobId: "job-1", state: "completed", output: "advisor result" }),
		});

		const result = await serviceUntil(dir, runExternalJob({
			provider: "surf-oracle",
			options: { tier: "pro" },
			cwd: dir,
			prompt: "prompt text",
			asyncDir: dir,
			stepIndex: 0,
			runId: "run-1",
			agent: "gpt-pro",
		}));

		assert.equal(result.exitCode, 0);
		assert.equal(result.output, "advisor result");
		assert.equal(result.externalJob.providerJobId, "job-1");
		assert.equal(result.externalJob.conversationUrl, "https://surf.example/jobs/job-1");
		assert.equal(result.externalJob.resultArtifactPath, path.join(dir, "external-job-0.result.md"));
		assert.equal(fs.readFileSync(result.externalJob.resultArtifactPath!, "utf-8"), "advisor result");
		assert.deepEqual(startInput, { promptDigest: externalJobPromptDigest("prompt text"), options: { tier: "pro" } });
	});

	it("reattaches an existing provider job instead of redispatching the prompt", async () => {
		const dir = tempDir("pi-external-job-reattach-");
		const prompt = "same prompt";
		fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify({
			steps: [{
				externalJob: {
					provider: "surf-oracle",
					providerJobId: "job-existing",
					promptDigest: externalJobPromptDigest(prompt),
					options: {},
					state: "running",
				},
			}],
		}), "utf-8");
		let reattached = false;
		registerExternalJobProvider({
			name: "surf-oracle",
			start: () => { throw new Error("start must not be called"); },
			reattach: (providerJobId) => { reattached = true; return { providerJobId, state: "completed" }; },
			status: (providerJobId) => ({ providerJobId, state: "completed" }),
			result: (providerJobId) => ({ providerJobId, state: "completed", output: "recovered result" }),
		});

		const result = await serviceUntil(dir, runExternalJob({
			provider: "surf-oracle",
			cwd: dir,
			prompt,
			asyncDir: dir,
			stepIndex: 0,
			runId: "run-reattach",
			agent: "gpt-pro",
		}));

		assert.equal(reattached, true);
		assert.equal(result.exitCode, 0);
		assert.equal(result.externalJob.providerJobId, "job-existing");
		assert.equal(result.output, "recovered result");
	});

	it("fails closed with the blocking provider job on capacity conflicts", async () => {
		const dir = tempDir("pi-external-job-capacity-");
		registerExternalJobProvider({
			name: "surf-oracle",
			start: () => { throw new ExternalJobProviderError("Surf capacity is occupied", { code: "capacity", blockingJobId: "job-blocking" }); },
			status: () => ({ providerJobId: "unused", state: "failed" }),
			reattach: () => ({ providerJobId: "unused", state: "failed" }),
			result: () => ({ providerJobId: "unused", state: "failed" }),
		});

		const result = await serviceUntil(dir, runExternalJob({
			provider: "surf-oracle",
			cwd: dir,
			prompt: "prompt",
			asyncDir: dir,
			stepIndex: 0,
			runId: "run-capacity",
			agent: "gpt-pro",
		}));

		assert.equal(result.exitCode, 1);
		assert.equal(result.externalJob.state, "blocked");
		assert.equal(result.externalJob.blockingJobId, "job-blocking");
		assert.match(result.error ?? "", /job-blocking/);
	});
});
