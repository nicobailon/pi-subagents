import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { inspectSessionLease } from "../../src/runs/shared/session-lease.ts";
import { validateSubagentRunConfig } from "../../src/runs/background/subagent-runner-bootstrap.ts";
import { persistRunnerStartupFailure } from "../../src/runs/background/runner-startup-failure.ts";

const harness = fileURLToPath(new URL("../fixtures/runner-bootstrap-harness.ts", import.meta.url));

test("runner config validation reports required fields without echoing values", () => {
	assert.throws(
		() => validateSubagentRunConfig({ id: "run", steps: [], resultPath: "/result", cwd: "/cwd", asyncDir: "/async", placeholder: "pending" }),
		{ message: "Invalid runner configuration: 'steps' must be a non-empty array." },
	);
	assert.throws(
		() => validateSubagentRunConfig({ id: "run", steps: [{}], resultPath: "/result", cwd: "/cwd", asyncDir: "/async", placeholder: "pending" }),
		{ message: "Invalid runner configuration: 'steps[0].agent' must be a non-empty string." },
	);
	assert.throws(
		() => validateSubagentRunConfig({ id: "run", steps: [{ agent: "secret-agent", task: "task" }], resultPath: 42, cwd: "/cwd", asyncDir: "/async", placeholder: "pending" }),
		(error: unknown) => error instanceof Error && error.message === "Invalid runner configuration: 'resultPath' must be a non-empty string." && !error.message.includes("secret-agent"),
	);
});

test("startup failure persistence does not overwrite malformed existing evidence", () => {
	const asyncDir = fs.mkdtempSync(path.join(os.tmpdir(), "runner-startup-failure-"));
	const statusPath = path.join(asyncDir, "status.json");
	fs.writeFileSync(statusPath, "not-json");
	assert.throws(
		() => persistRunnerStartupFailure({
			asyncDir,
			runId: "run",
			runnerProcessInstanceId: "runner",
			message: "setup failed",
		}),
		SyntaxError,
	);
	assert.equal(fs.readFileSync(statusPath, "utf8"), "not-json");
	assert.equal(fs.existsSync(path.join(asyncDir, "process-terminal-candidate.json")), false);
	fs.rmSync(asyncDir, { recursive: true, force: true });
});

type ChildMessage = { type: string; importRequested?: boolean; token?: string };

function nextMessage(child: ChildProcess, type: string): Promise<ChildMessage> {
	return new Promise((resolve, reject) => {
		const onMessage = (message: ChildMessage) => {
			if (message?.type !== type) return;
			cleanup();
			resolve(message);
		};
		const onExit = (code: number | null) => { cleanup(); reject(new Error(`runner exited ${code} before ${type}`)); };
		const cleanup = () => { child.off("message", onMessage); child.off("exit", onExit); };
		child.on("message", onMessage);
		child.on("exit", onExit);
	});
}

function waitForStartupState(startupPath: string, state: string): Promise<Record<string, unknown>> {
	return new Promise((resolve, reject) => {
		const inspect = () => {
			try {
				const payload = JSON.parse(fs.readFileSync(startupPath, "utf8")) as Record<string, unknown>;
				if (payload.state === "error") { cleanup(); reject(new Error(String(payload.error))); }
				if (payload.state === state) { cleanup(); resolve(payload); }
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") { cleanup(); reject(error); }
			}
		};
		fs.watchFile(startupPath, { interval: 20 }, inspect);
		const cleanup = () => fs.unwatchFile(startupPath, inspect);
		inspect();
	});
}

function writeControl(asyncDir: string, name: string, action: string, token: string): void {
	fs.writeFileSync(path.join(asyncDir, name), JSON.stringify({ action, token }));
}

async function runBootstrapCase(mode: "delayed" | "reject"): Promise<{ code: number | null; stderr: string; candidate: Record<string, unknown>; executed?: ChildMessage }> {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "runner-bootstrap-"));
	const asyncDir = path.join(root, "run");
	const sessionFile = path.join(root, "session.jsonl");
	fs.mkdirSync(asyncDir);
	fs.writeFileSync(sessionFile, "");
	const config = {
		id: `bootstrap-${mode}`,
		steps: [{ agent: "worker", task: "test", inheritProjectContext: false, inheritGlobalContext: false, inheritSkills: false }],
		resultPath: path.join(root, "result.json"),
		cwd: root,
		placeholder: "pending",
		asyncDir,
		runnerProcessInstanceId: "runner-instance",
		revivalLease: { sessionFile, runId: `bootstrap-${mode}`, sourceRunId: "source" },
	};
	fs.writeFileSync(path.join(asyncDir, "process-terminal-candidate.json"), JSON.stringify({
		version: 1, runId: config.id, runnerProcessInstanceId: "runner-instance", writers: {},
	}));
	const child = fork(harness, [JSON.stringify(config), mode], {
		execArgv: ["--experimental-strip-types"],
		stdio: ["ignore", "ignore", "pipe", "ipc"],
	});
	const exitPromise = new Promise<number | null>((resolve) => child.once("exit", resolve));
	let stderr = "";
	child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
	const startupPath = path.join(asyncDir, "runner-startup.json");
	const ready = await waitForStartupState(startupPath, "ready");
	const token = String(ready.token);
	assert.equal(inspectSessionLease(sessionFile).state, "owned");
	writeControl(asyncDir, "runner-startup-ack.json", "ack", token);
	await waitForStartupState(startupPath, "acknowledged");
	writeControl(asyncDir, "runner-startup-confirm.json", "confirm", token);
	await waitForStartupState(startupPath, "confirmed");
	const probe = nextMessage(child, "probe-result");
	child.send("probe");
	assert.equal((await probe).importRequested, false, "heavy import must not start before proceed");
	const importRequested = nextMessage(child, "import-requested");
	writeControl(asyncDir, "runner-startup-proceed.json", "proceed", token);
	await importRequested;
	assert.equal(inspectSessionLease(sessionFile).state, "owned", "bootstrap must retain the lease during import");
	const executedPromise = mode === "delayed" ? nextMessage(child, "executed") : undefined;
	child.send("release-import");
	const executed = executedPromise ? await executedPromise : undefined;
	const code = await exitPromise;
	assert.equal(inspectSessionLease(sessionFile).state, "free");
	const candidate = JSON.parse(fs.readFileSync(path.join(asyncDir, "process-terminal-candidate.json"), "utf8")) as Record<string, unknown>;
	assert.equal(candidate.revivalLeaseToken, token);
	assert.equal(candidate.revivalLeaseReleaseAcknowledged, true);
	if (mode === "reject") {
		const status = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf8")) as Record<string, unknown>;
		assert.equal(status.state, "failed");
		assert.match(String(status.error), /injected heavy import rejection/);
		assert.deepEqual(candidate.expectedWriters, { 0: 0 });
	}
	fs.rmSync(root, { recursive: true, force: true });
	return { code, stderr, candidate, ...(executed ? { executed } : {}) };
}

test("revival handshake commits before delayed heavy import and retains one lease", async () => {
	const result = await runBootstrapCase("delayed");
	assert.equal(result.code, 0);
	assert.ok(result.executed?.token, "revival lease token reaches execution");
});

test("rejected post-proceed heavy import fails visibly and releases the lease", async () => {
	const result = await runBootstrapCase("reject");
	assert.equal(result.code, 1);
	assert.match(result.stderr, /injected heavy import rejection/);
});

test("fresh-launch barrier also keeps heavy execution behind proceed", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "runner-bootstrap-fresh-"));
	const asyncDir = path.join(root, "run");
	fs.mkdirSync(asyncDir);
	const token = "fresh-barrier-token";
	const config = {
		id: "bootstrap-fresh", steps: [{ agent: "worker", task: "test", inheritProjectContext: false, inheritGlobalContext: false, inheritSkills: false }], resultPath: path.join(root, "result.json"),
		cwd: root, placeholder: "pending", asyncDir, launchBarrierToken: token,
	};
	const child = fork(harness, [JSON.stringify(config), "delayed"], {
		execArgv: ["--experimental-strip-types"], stdio: ["ignore", "ignore", "pipe", "ipc"],
	});
	const exitPromise = new Promise<number | null>((resolve) => child.once("exit", resolve));
	const probe = nextMessage(child, "probe-result");
	child.send("probe");
	assert.equal((await probe).importRequested, false);
	const importRequested = nextMessage(child, "import-requested");
	writeControl(asyncDir, "runner-startup-proceed.json", "proceed", token);
	await importRequested;
	assert.equal(fs.existsSync(path.join(asyncDir, "runner-startup-proceed.json")), false);
	const executed = nextMessage(child, "executed");
	child.send("release-import");
	await executed;
	assert.equal(await exitPromise, 0);
	fs.rmSync(root, { recursive: true, force: true });
});
