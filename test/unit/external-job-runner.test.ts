import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { EXTERNAL_JOB_PROVIDER_REGISTRY_KEY, ExternalJobProviderError, registerExternalJobProvider } from "../../src/api/external-job-provider.ts";
import { EXTERNAL_JOB_BRIDGE_REQUEST_DIR, serviceExternalJobBridgeRequestFile, serviceExternalJobBridgeRequests } from "../../src/runs/shared/external-job-bridge.ts";
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

async function waitForFile(filePath: string): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (!fs.existsSync(filePath)) {
		if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${filePath}`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
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

	it("does not redispatch a partial claimed start request after host restart", () => {
		const dir = tempDir("pi-external-job-claimed-start-");
		let starts = 0;
		registerExternalJobProvider({
			name: "surf-oracle",
			start: () => { starts += 1; return { providerJobId: "job-duplicate", state: "completed" }; },
			status: () => ({ providerJobId: "unused", state: "completed" }),
			reattach: () => ({ providerJobId: "unused", state: "completed" }),
			result: () => ({ providerJobId: "unused", state: "completed" }),
		});
		const requestDir = path.join(dir, EXTERNAL_JOB_BRIDGE_REQUEST_DIR);
		fs.mkdirSync(requestDir, { recursive: true });
		fs.mkdirSync(path.join(requestDir, "start-timeout.claim"));
		fs.writeFileSync(path.join(requestDir, "start-timeout.json"), JSON.stringify({
			id: "start-timeout",
			operation: "start",
			provider: "surf-oracle",
			createdAt: 1,
			start: {
				prompt: "prompt",
				promptDigest: externalJobPromptDigest("prompt"),
				cwd: dir,
				runId: "run-timeout",
				stepIndex: 0,
				agent: "gpt-pro",
				options: {},
			},
		}), "utf-8");

		serviceExternalJobBridgeRequests(dir);

		assert.equal(starts, 0);
		assert.equal(fs.existsSync(path.join(dir, "external-job-responses", "start-timeout.json")), false);
		assert.equal(fs.existsSync(path.join(requestDir, "start-timeout.json")), true);
	});

	it("does not dispatch a start request twice while the first claim is active", async () => {
		const dir = tempDir("pi-external-job-active-claim-");
		let starts = 0;
		let resolveStart: ((value: { providerJobId: string; state: "completed" }) => void) | undefined;
		registerExternalJobProvider({
			name: "surf-oracle",
			start: () => {
				starts += 1;
				return new Promise((resolve) => { resolveStart = resolve; });
			},
			status: () => ({ providerJobId: "unused", state: "completed" }),
			reattach: () => ({ providerJobId: "unused", state: "completed" }),
			result: () => ({ providerJobId: "unused", state: "completed" }),
		});
		const requestDir = path.join(dir, EXTERNAL_JOB_BRIDGE_REQUEST_DIR);
		fs.mkdirSync(requestDir, { recursive: true });
		fs.writeFileSync(path.join(requestDir, "start-race.json"), JSON.stringify({
			id: "start-race",
			operation: "start",
			provider: "surf-oracle",
			createdAt: Date.now(),
			start: {
				prompt: "prompt",
				promptDigest: externalJobPromptDigest("prompt"),
				cwd: dir,
				runId: "run-race",
				stepIndex: 0,
				agent: "gpt-pro",
				options: {},
			},
		}), "utf-8");

		serviceExternalJobBridgeRequests(dir);
		serviceExternalJobBridgeRequests(dir);

		assert.equal(starts, 1);
		assert.equal(fs.existsSync(path.join(dir, "external-job-responses", "start-race.json")), false);
		resolveStart!({ providerJobId: "job-race", state: "completed" });
		await waitForFile(path.join(dir, "external-job-responses", "start-race.json"));
		const response = JSON.parse(fs.readFileSync(path.join(dir, "external-job-responses", "start-race.json"), "utf-8"));
		assert.equal(response.ok, true);
		assert.equal(response.result.providerJobId, "job-race");
		assert.equal(starts, 1);
	});

	it("does not fail an old active start claim while provider start may still be running", () => {
		const dir = tempDir("pi-external-job-long-active-claim-");
		let starts = 0;
		registerExternalJobProvider({
			name: "surf-oracle",
			start: () => { starts += 1; return { providerJobId: "job-duplicate", state: "completed" }; },
			status: () => ({ providerJobId: "unused", state: "completed" }),
			reattach: () => ({ providerJobId: "unused", state: "completed" }),
			result: () => ({ providerJobId: "unused", state: "completed" }),
		});
		const requestDir = path.join(dir, EXTERNAL_JOB_BRIDGE_REQUEST_DIR);
		fs.mkdirSync(requestDir, { recursive: true });
		fs.writeFileSync(path.join(requestDir, "start-long.json"), JSON.stringify({
			id: "start-long",
			operation: "start",
			provider: "surf-oracle",
			createdAt: 1,
			claimedAt: 2,
			start: {
				prompt: "prompt",
				promptDigest: externalJobPromptDigest("prompt"),
				cwd: dir,
				runId: "run-long",
				stepIndex: 0,
				agent: "gpt-pro",
				options: {},
			},
		}), "utf-8");

		serviceExternalJobBridgeRequestFile(dir, "start-long.json");

		assert.equal(starts, 0);
		assert.equal(fs.existsSync(path.join(dir, "external-job-responses", "start-long.json")), false);
		assert.equal(fs.existsSync(path.join(requestDir, "start-long.json")), true);
	});

	it("ignores a stale start request snapshot after another host claimed it", async () => {
		const dir = tempDir("pi-external-job-stale-snapshot-");
		let starts = 0;
		let resolveStart: ((value: { providerJobId: string; state: "completed" }) => void) | undefined;
		registerExternalJobProvider({
			name: "surf-oracle",
			start: () => {
				starts += 1;
				return new Promise((resolve) => { resolveStart = resolve; });
			},
			status: () => ({ providerJobId: "unused", state: "completed" }),
			reattach: () => ({ providerJobId: "unused", state: "completed" }),
			result: () => ({ providerJobId: "unused", state: "completed" }),
		});
		const requestDir = path.join(dir, EXTERNAL_JOB_BRIDGE_REQUEST_DIR);
		fs.mkdirSync(requestDir, { recursive: true });
		fs.writeFileSync(path.join(requestDir, "start-stale.json"), JSON.stringify({
			id: "start-stale",
			operation: "start",
			provider: "surf-oracle",
			createdAt: Date.now(),
			start: {
				prompt: "prompt",
				promptDigest: externalJobPromptDigest("prompt"),
				cwd: dir,
				runId: "run-stale",
				stepIndex: 0,
				agent: "gpt-pro",
				options: {},
			},
		}), "utf-8");

		serviceExternalJobBridgeRequests(dir);
		serviceExternalJobBridgeRequestFile(dir, "start-stale.json");

		assert.equal(starts, 1);
		assert.equal(fs.existsSync(path.join(dir, "external-job-responses", "start-stale.json")), false);
		resolveStart!({ providerJobId: "job-stale", state: "completed" });
		await waitForFile(path.join(dir, "external-job-responses", "start-stale.json"));
		const response = JSON.parse(fs.readFileSync(path.join(dir, "external-job-responses", "start-stale.json"), "utf-8"));
		assert.equal(response.ok, true);
		assert.equal(response.result.providerJobId, "job-stale");
		assert.equal(starts, 1);
	});

	it("does not start again after a bridge timeout without provider job id", async () => {
		const dir = tempDir("pi-external-job-timeout-retry-");
		const prompt = "prompt";
		fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify({
			steps: [{
				externalJob: {
					provider: "surf-oracle",
					promptDigest: externalJobPromptDigest(prompt),
					options: {},
					state: "failed",
					failureCode: "bridge-timeout",
					failureMessage: "Bridge timed out before a provider job id was committed.",
				},
			}],
		}), "utf-8");
		let starts = 0;
		registerExternalJobProvider({
			name: "surf-oracle",
			start: () => { starts += 1; return { providerJobId: "job-2", state: "completed" }; },
			status: () => ({ providerJobId: "unused", state: "completed" }),
			reattach: () => ({ providerJobId: "unused", state: "completed" }),
			result: () => ({ providerJobId: "unused", state: "completed" }),
		});

		const result = await runExternalJob({
			provider: "surf-oracle",
			cwd: dir,
			prompt,
			asyncDir: dir,
			stepIndex: 0,
			runId: "run-timeout-retry",
			agent: "gpt-pro",
		});

		assert.equal(starts, 0);
		assert.equal(result.exitCode, 1);
		assert.equal(result.externalJob.failureCode, "start-redispatch-blocked");
		assert.match(result.error ?? "", /Refusing to redispatch/);
		assert.equal(fs.existsSync(path.join(dir, EXTERNAL_JOB_BRIDGE_REQUEST_DIR)), false);
	});
});
