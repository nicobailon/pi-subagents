import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { EXTERNAL_JOB_PROVIDER_REGISTRY_KEY, ExternalJobProviderError, registerExternalJobProvider } from "../../src/api/external-job-provider.ts";
import { EXTERNAL_JOB_BRIDGE_REQUEST_DIR, requestExternalJobOperation, serviceExternalJobBridgeRequestFile, serviceExternalJobBridgeRequests } from "../../src/runs/shared/external-job-bridge.ts";
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

	it("recovers an incomplete start claim and dispatches the original request once", async () => {
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
		serviceExternalJobBridgeRequests(dir);
		await waitForFile(path.join(dir, "external-job-responses", "start-timeout.json"));
		const response = JSON.parse(fs.readFileSync(path.join(dir, "external-job-responses", "start-timeout.json"), "utf-8"));

		assert.equal(starts, 1);
		assert.equal(response.ok, true);
		assert.equal(response.result.providerJobId, "job-duplicate");
		assert.equal(fs.existsSync(path.join(requestDir, "start-timeout.claim")), true);
		assert.equal(fs.existsSync(path.join(requestDir, "start-timeout.json")), false);
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
		const claimDir = path.join(requestDir, "start-long.claim");
		fs.mkdirSync(requestDir, { recursive: true });
		fs.mkdirSync(claimDir);
		fs.writeFileSync(path.join(claimDir, "owner.json"), JSON.stringify({ version: 1, pid: process.pid, hostname: os.hostname(), claimedAt: 1 }), "utf-8");
		fs.writeFileSync(path.join(claimDir, "request.json"), JSON.stringify({
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

		serviceExternalJobBridgeRequestFile(dir, "start-long.claim");

		assert.equal(starts, 0);
		assert.equal(fs.existsSync(path.join(dir, "external-job-responses", "start-long.json")), false);
		assert.equal(fs.existsSync(claimDir), true);
	});

	it("settles an abandoned start claim without redispatching", () => {
		const dir = tempDir("pi-external-job-abandoned-claim-");
		let starts = 0;
		registerExternalJobProvider({
			name: "surf-oracle",
			start: () => { starts += 1; return { providerJobId: "job-duplicate", state: "completed" }; },
			status: () => ({ providerJobId: "unused", state: "completed" }),
			reattach: () => ({ providerJobId: "unused", state: "completed" }),
			result: () => ({ providerJobId: "unused", state: "completed" }),
		});
		const requestDir = path.join(dir, EXTERNAL_JOB_BRIDGE_REQUEST_DIR);
		const claimDir = path.join(requestDir, "start-abandoned.claim");
		fs.mkdirSync(claimDir, { recursive: true });
		fs.writeFileSync(path.join(claimDir, "owner.json"), JSON.stringify({ version: 1, pid: 9_999_999, hostname: os.hostname(), claimedAt: 1 }), "utf-8");
		fs.writeFileSync(path.join(claimDir, "request.json"), JSON.stringify({
			id: "start-abandoned",
			operation: "start",
			provider: "surf-oracle",
			createdAt: 1,
			claimedAt: 2,
			start: {
				prompt: "prompt",
				promptDigest: externalJobPromptDigest("prompt"),
				cwd: dir,
				runId: "run-abandoned",
				stepIndex: 0,
				agent: "gpt-pro",
				options: {},
			},
		}), "utf-8");

		serviceExternalJobBridgeRequests(dir);

		assert.equal(starts, 0);
		const response = JSON.parse(fs.readFileSync(path.join(dir, "external-job-responses", "start-abandoned.json"), "utf-8"));
		assert.equal(response.ok, false);
		assert.equal(response.code, "start-dispatch-abandoned");
		assert.match(response.message, /Refusing to redispatch/);
		assert.equal(fs.existsSync(claimDir), false);
	});

	it("recovers a persisted start handle from a dead owner claim", () => {
		const dir = tempDir("pi-external-job-dead-owner-handle-");
		let starts = 0;
		registerExternalJobProvider({
			name: "surf-oracle",
			start: () => { starts += 1; return { providerJobId: "job-duplicate", state: "completed" }; },
			status: () => ({ providerJobId: "unused", state: "completed" }),
			reattach: () => ({ providerJobId: "unused", state: "completed" }),
			result: () => ({ providerJobId: "unused", state: "completed" }),
		});
		const requestDir = path.join(dir, EXTERNAL_JOB_BRIDGE_REQUEST_DIR);
		const claimDir = path.join(requestDir, "start-recovered.claim");
		fs.mkdirSync(claimDir, { recursive: true });
		fs.writeFileSync(path.join(claimDir, "owner.json"), JSON.stringify({ version: 1, pid: 9_999_999, hostname: os.hostname(), claimedAt: 1 }), "utf-8");
		fs.writeFileSync(path.join(claimDir, "request.json"), JSON.stringify({
			id: "start-recovered",
			operation: "start",
			provider: "surf-oracle",
			createdAt: 1,
			claimedAt: 2,
			start: {
				prompt: "prompt",
				promptDigest: externalJobPromptDigest("prompt"),
				cwd: dir,
				runId: "run-recovered",
				stepIndex: 0,
				agent: "gpt-pro",
				options: {},
			},
		}), "utf-8");
		fs.writeFileSync(path.join(claimDir, "handle.json"), JSON.stringify({ providerJobId: "job-recovered", state: "running" }), "utf-8");

		serviceExternalJobBridgeRequests(dir);

		assert.equal(starts, 0);
		const response = JSON.parse(fs.readFileSync(path.join(dir, "external-job-responses", "start-recovered.json"), "utf-8"));
		assert.equal(response.ok, true);
		assert.equal(response.result.providerJobId, "job-recovered");
		assert.equal(fs.existsSync(path.join(claimDir, "completed.json")), true);
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

	it("does not redispatch after a completed start claim", async () => {
		const dir = tempDir("pi-external-job-completed-claim-");
		let starts = 0;
		registerExternalJobProvider({
			name: "surf-oracle",
			start: () => { starts += 1; return { providerJobId: "job-completed", state: "completed" }; },
			status: () => ({ providerJobId: "unused", state: "completed" }),
			reattach: () => ({ providerJobId: "unused", state: "completed" }),
			result: () => ({ providerJobId: "unused", state: "completed" }),
		});
		const requestDir = path.join(dir, EXTERNAL_JOB_BRIDGE_REQUEST_DIR);
		fs.mkdirSync(requestDir, { recursive: true });
		const request = {
			id: "start-completed",
			operation: "start",
			provider: "surf-oracle",
			createdAt: Date.now(),
			start: {
				prompt: "prompt",
				promptDigest: externalJobPromptDigest("prompt"),
				cwd: dir,
				runId: "run-completed",
				stepIndex: 0,
				agent: "gpt-pro",
				options: {},
			},
		};
		fs.writeFileSync(path.join(requestDir, "start-completed.json"), JSON.stringify(request), "utf-8");

		serviceExternalJobBridgeRequests(dir);
		await waitForFile(path.join(dir, "external-job-responses", "start-completed.json"));
		fs.rmSync(path.join(dir, "external-job-responses", "start-completed.json"), { force: true });
		fs.writeFileSync(path.join(requestDir, "start-completed.json"), JSON.stringify(request), "utf-8");
		serviceExternalJobBridgeRequests(dir);

		assert.equal(starts, 1);
		assert.equal(fs.existsSync(path.join(requestDir, "start-completed.claim")), true);
	});

	it("does not let completed start claims starve later requests", async () => {
		const dir = tempDir("pi-external-job-completed-claim-starvation-");
		let starts = 0;
		registerExternalJobProvider({
			name: "surf-oracle",
			start: () => { starts += 1; return { providerJobId: "job-after-tombstones", state: "completed" }; },
			status: () => ({ providerJobId: "unused", state: "completed" }),
			reattach: () => ({ providerJobId: "unused", state: "completed" }),
			result: () => ({ providerJobId: "unused", state: "completed" }),
		});
		const requestDir = path.join(dir, EXTERNAL_JOB_BRIDGE_REQUEST_DIR);
		fs.mkdirSync(requestDir, { recursive: true });
		for (let index = 0; index < 100; index += 1) {
			const id = `000-${String(index).padStart(3, "0")}`;
			const claimDir = path.join(requestDir, `${id}.claim`);
			fs.mkdirSync(claimDir);
			fs.writeFileSync(path.join(claimDir, "completed.json"), JSON.stringify({ completedAt: 1 }), "utf-8");
			fs.writeFileSync(path.join(requestDir, `${id}.json`), JSON.stringify({
				id,
				operation: "start",
				provider: "surf-oracle",
				createdAt: Date.now(),
				start: {
					prompt: "stale prompt",
					promptDigest: externalJobPromptDigest("stale prompt"),
					cwd: dir,
					runId: "run-stale-completed",
					stepIndex: 0,
					agent: "gpt-pro",
					options: {},
				},
			}), "utf-8");
		}
		fs.writeFileSync(path.join(requestDir, "zzz.json"), JSON.stringify({
			id: "zzz",
			operation: "start",
			provider: "surf-oracle",
			createdAt: Date.now(),
			start: {
				prompt: "prompt",
				promptDigest: externalJobPromptDigest("prompt"),
				cwd: dir,
				runId: "run-after-tombstones",
				stepIndex: 0,
				agent: "gpt-pro",
				options: {},
			},
		}), "utf-8");

		serviceExternalJobBridgeRequests(dir);
		await waitForFile(path.join(dir, "external-job-responses", "zzz.json"));

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

	it("fails closed when existing status.json is malformed", async () => {
		const dir = tempDir("pi-external-job-corrupt-status-");
		fs.writeFileSync(path.join(dir, "status.json"), "{ not json", "utf-8");
		let starts = 0;
		registerExternalJobProvider({
			name: "surf-oracle",
			start: () => { starts += 1; return { providerJobId: "job-new", state: "completed" }; },
			status: () => ({ providerJobId: "unused", state: "completed" }),
			reattach: () => ({ providerJobId: "unused", state: "completed" }),
			result: () => ({ providerJobId: "unused", state: "completed" }),
		});

		const result = await runExternalJob({
			provider: "surf-oracle",
			cwd: dir,
			prompt: "prompt",
			asyncDir: dir,
			stepIndex: 0,
			runId: "run-corrupt-status",
			agent: "gpt-pro",
		});

		assert.equal(starts, 0);
		assert.equal(result.exitCode, 1);
		assert.equal(result.externalJob.failureCode, "status-unreadable");
		assert.match(result.error ?? "", /Malformed external-job status/);
		assert.equal(fs.existsSync(path.join(dir, EXTERNAL_JOB_BRIDGE_REQUEST_DIR)), false);
	});

	it("fails closed when existing status.json has an invalid steps shape", async () => {
		const dir = tempDir("pi-external-job-invalid-steps-");
		fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify({ steps: "nope" }), "utf-8");
		let starts = 0;
		registerExternalJobProvider({
			name: "surf-oracle",
			start: () => { starts += 1; return { providerJobId: "job-new", state: "completed" }; },
			status: () => ({ providerJobId: "unused", state: "completed" }),
			reattach: () => ({ providerJobId: "unused", state: "completed" }),
			result: () => ({ providerJobId: "unused", state: "completed" }),
		});

		const result = await runExternalJob({
			provider: "surf-oracle",
			cwd: dir,
			prompt: "prompt",
			asyncDir: dir,
			stepIndex: 0,
			runId: "run-invalid-steps",
			agent: "gpt-pro",
		});

		assert.equal(starts, 0);
		assert.equal(result.exitCode, 1);
		assert.equal(result.externalJob.failureCode, "status-unreadable");
		assert.match(result.error ?? "", /Malformed external-job status/);
		assert.equal(fs.existsSync(path.join(dir, EXTERNAL_JOB_BRIDGE_REQUEST_DIR)), false);
	});

	it("starts when existing status.json has a pending step without an external job", async () => {
		const dir = tempDir("pi-external-job-pending-step-");
		fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify({
			steps: [{ agent: "gpt-pro", status: "pending" }],
		}), "utf-8");
		let starts = 0;
		registerExternalJobProvider({
			name: "surf-oracle",
			start: () => { starts += 1; return { providerJobId: "job-1", state: "completed" }; },
			status: () => ({ providerJobId: "job-1", state: "completed" }),
			reattach: () => ({ providerJobId: "job-1", state: "completed" }),
			result: () => ({ providerJobId: "job-1", state: "completed", output: "first start" }),
		});

		const result = await serviceUntil(dir, runExternalJob({
			provider: "surf-oracle",
			cwd: dir,
			prompt: "prompt",
			asyncDir: dir,
			stepIndex: 0,
			runId: "run-pending-step",
			agent: "gpt-pro",
		}));

		assert.equal(starts, 1);
		assert.equal(result.exitCode, 0);
		assert.equal(result.externalJob.providerJobId, "job-1");
	});

	it("stops waiting for start when local timeout fires before a provider job id", async () => {
		const dir = tempDir("pi-external-job-start-local-timeout-");
		let starts = 0;
		let timeout: (() => void) | undefined;
		registerExternalJobProvider({
			name: "surf-oracle",
			start: () => {
				starts += 1;
				return new Promise(() => {});
			},
			status: () => ({ providerJobId: "unused", state: "completed" }),
			reattach: () => ({ providerJobId: "unused", state: "completed" }),
			result: () => ({ providerJobId: "unused", state: "completed" }),
		});

		const operation = runExternalJob({
			provider: "surf-oracle",
			cwd: dir,
			prompt: "prompt",
			asyncDir: dir,
			stepIndex: 0,
			runId: "run-local-timeout",
			agent: "gpt-pro",
			registerTimeout: (registered) => { timeout = registered; },
		});
		timeout!();
		const result = await operation;

		assert.equal(starts, 0);
		assert.equal(result.exitCode, 1);
		assert.equal(result.timedOut, true);
		assert.equal(result.externalJob.failureCode, "local-timeout");
		assert.match(result.error ?? "", /timed out locally/);
		const requestDir = path.join(dir, EXTERNAL_JOB_BRIDGE_REQUEST_DIR);
		const tombstone = fs.readdirSync(requestDir).find((entry) => entry.endsWith(".claim"));
		assert.ok(tombstone);
		const staleId = tombstone.replace(/\.claim$/, "");
		fs.writeFileSync(path.join(requestDir, `${staleId}.json`), JSON.stringify({
			id: staleId,
			operation: "start",
			provider: "surf-oracle",
			createdAt: Date.now(),
			start: {
				prompt: "prompt",
				promptDigest: externalJobPromptDigest("prompt"),
				cwd: dir,
				runId: "run-local-timeout",
				stepIndex: 0,
				agent: "gpt-pro",
				options: {},
			},
		}), "utf-8");
		serviceExternalJobBridgeRequests(dir);
		assert.equal(starts, 0);
	});

	it("waits for a slow start response instead of timing out without provider job id", async () => {
		const dir = tempDir("pi-external-job-slow-start-");
		let starts = 0;
		let settled = false;
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
		const operation = requestExternalJobOperation(dir, {
			operation: "start",
			provider: "surf-oracle",
			start: {
				prompt: "prompt",
				promptDigest: externalJobPromptDigest("prompt"),
				cwd: dir,
				runId: "run-slow",
				stepIndex: 0,
				agent: "gpt-pro",
				options: {},
			},
		}, 1).finally(() => { settled = true; });

		serviceExternalJobBridgeRequests(dir);
		await new Promise((resolve) => setTimeout(resolve, 30));
		assert.equal(starts, 1);
		assert.equal(settled, false);

		resolveStart!({ providerJobId: "job-slow", state: "completed" });
		const result = await serviceUntil(dir, operation);

		assert.equal(result.providerJobId, "job-slow");
		assert.equal(starts, 1);
	});
});
