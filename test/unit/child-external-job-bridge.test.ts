import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { EXTERNAL_JOB_PROVIDER_REGISTRY_KEY, registerExternalJobProvider } from "../../src/api/external-job-provider.ts";
import { createChildExternalJobBridgeSweeper, EXTERNAL_JOB_BRIDGE_REQUEST_DIR } from "../../src/runs/shared/external-job-bridge.ts";
import { runExternalJob } from "../../src/runs/shared/external-job-runner.ts";

const tempDirs: string[] = [];

afterEach(() => {
	delete (globalThis as Record<PropertyKey, unknown>)[Symbol.for(EXTERNAL_JOB_PROVIDER_REGISTRY_KEY)];
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

function writeStatus(asyncDir: string, state: string, runnerType: string): void {
	fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({ state, steps: [{ runner: { type: runnerType } }] }));
}

async function sweepUntil<T>(sweeper: ReturnType<typeof createChildExternalJobBridgeSweeper>, promise: Promise<T>): Promise<T> {
	let done = false;
	promise.then(() => { done = true; }, () => { done = true; });
	while (!done) {
		sweeper.sweep();
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	return promise;
}

function runJob(asyncDir: string) {
	return runExternalJob({ provider: "surf-oracle", options: {}, cwd: asyncDir, prompt: "prompt text", asyncDir, stepIndex: 0, runId: "run-1", agent: "gpt-pro" });
}

function registerProvider(onStart: () => void): void {
	registerExternalJobProvider({
		name: "surf-oracle",
		start: () => {
			onStart();
			return { providerJobId: "job-1", state: "completed" };
		},
		status: () => ({ providerJobId: "job-1", state: "completed" }),
		reattach: () => ({ providerJobId: "job-1", state: "completed" }),
		result: () => ({ providerJobId: "job-1", state: "completed", output: "advisor result" }),
	});
}

describe("child external-job bridge sweeper", () => {
	it("services a tracked run before its status exists, starts the provider job once, and releases the run when final", async () => {
		const dir = tempDir("pi-child-bridge-");
		let starts = 0;
		registerProvider(() => { starts += 1; });
		const sweeper = createChildExternalJobBridgeSweeper();
		try {
			sweeper.track("run-1", dir);
			assert.equal(sweeper.sweep(), 1);
			const result = await sweepUntil(sweeper, runJob(dir));
			assert.equal(result.output, "advisor result");
			assert.equal(starts, 1);
			writeStatus(dir, "complete", "external-job");
			assert.equal(sweeper.sweep(), 0);
		} finally {
			sweeper.dispose();
		}
	});

	it("keeps a run tracked while its launch status has no runner metadata, then services the bridge", async () => {
		const dir = tempDir("pi-child-bridge-startup-");
		fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify({ state: "running", steps: [{ agent: "gpt-pro", status: "pending" }] }));
		let starts = 0;
		registerProvider(() => { starts += 1; });
		const sweeper = createChildExternalJobBridgeSweeper();
		try {
			sweeper.track("run-1", dir);
			assert.equal(sweeper.sweep(), 1);
			writeStatus(dir, "running", "external-job");
			const result = await sweepUntil(sweeper, runJob(dir));
			assert.equal(result.output, "advisor result");
			assert.equal(starts, 1);
		} finally {
			sweeper.dispose();
		}
	});

	it("fails the run closed when the child has no provider registered", async () => {
		const dir = tempDir("pi-child-bridge-missing-");
		writeStatus(dir, "running", "external-job");
		const sweeper = createChildExternalJobBridgeSweeper();
		try {
			sweeper.track("run-1", dir);
			const result = await sweepUntil(sweeper, runJob(dir));
			assert.notEqual(result.exitCode, 0);
			assert.match(result.error ?? "", /not registered/);
		} finally {
			sweeper.dispose();
		}
	});

	it("never services a run without external-job steps and releases it when final", () => {
		const dir = tempDir("pi-child-bridge-native-");
		writeStatus(dir, "running", "pi");
		fs.mkdirSync(path.join(dir, EXTERNAL_JOB_BRIDGE_REQUEST_DIR));
		const sweeper = createChildExternalJobBridgeSweeper();
		sweeper.track("run-2", dir);
		assert.equal(sweeper.sweep(), 1);
		assert.equal(fs.existsSync(path.join(dir, "external-job-responses")), false);
		writeStatus(dir, "complete", "pi");
		assert.equal(sweeper.sweep(), 0);
		sweeper.dispose();
	});

	it("stops tracking every run on dispose", () => {
		const dir = tempDir("pi-child-bridge-dispose-");
		writeStatus(dir, "running", "external-job");
		const sweeper = createChildExternalJobBridgeSweeper();
		sweeper.track("run-3", dir);
		sweeper.dispose();
		assert.equal(sweeper.sweep(), 0);
	});
});
