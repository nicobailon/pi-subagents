import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { resolveHostPeerAliases } from "../../src/runs/background/runner-aliases.ts";
import { runnerStartupPaths } from "../../src/runs/background/runner-startup.ts";
import { sessionLeaseDir } from "../../src/runs/shared/session-lease.ts";
import { resolveInstalledPiPackageRoot } from "../../src/runs/shared/pi-spawn.ts";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const HEAVY_IMPORT_DELAY_MS = 4_000;
const STARTUP_WAIT_MS = 30_000;

interface BootstrapFixture {
	root: string;
	asyncDir: string;
	runId: string;
	runnerProcessInstanceId: string;
	sessionFile: string;
	statusPath: string;
	markerPath: string;
	child: ChildProcessWithoutNullStreams;
	exited: Promise<number | null>;
	readOutput: () => string;
}

/**
 * Spawn the detached runner entry the way the parent does and hand the test the
 * fixtures it needs to act as that parent: a committed status file, the config,
 * and the child process.
 */
function startBootstrap(suffix: string, env: Record<string, string>): BootstrapFixture {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), `pi-subagents-runner-${suffix}-`));
	const asyncDir = path.join(root, "async-subagent-runs", suffix);
	fs.mkdirSync(asyncDir, { recursive: true });
	const sessionFile = path.join(root, "session.jsonl");
	fs.writeFileSync(sessionFile, `${JSON.stringify({ type: "session", version: 1, id: suffix })}\n`);
	const runId = suffix;
	const runnerProcessInstanceId = "11111111-2222-3333-4444-555555555555";
	const statusPath = path.join(asyncDir, "status.json");
	fs.writeFileSync(statusPath, JSON.stringify({
		version: 1,
		runId,
		state: "running",
		startedAt: Date.now(),
		lastUpdate: Date.now(),
		processTerminal: { version: 1, state: "pending", runId, runnerProcessInstanceId },
	}));
	const configPath = path.join(root, `async-cfg-${suffix}.json`);
	fs.writeFileSync(configPath, JSON.stringify({
		id: runId,
		asyncDir,
		runnerProcessInstanceId,
		revivalLease: { sessionFile, runId, sourceRunId: `${suffix}-source` },
	}));

	const packageRoot = resolveInstalledPiPackageRoot();
	assert.ok(packageRoot, "expected the pi package (or its test shim) to be resolvable");
	const markerPath = path.join(root, "heavy-graph-imported.marker");
	const child = spawn(process.execPath, [
		"--import", new URL("../../runner-peer-preload.mjs", import.meta.url).href,
		"--import", pathToFileURL(path.join(projectRoot, "test", "support", "slow-heavy-import-hook.mjs")).href,
		"--experimental-strip-types",
		path.join(projectRoot, "src", "runs", "background", "runner-bootstrap.ts"),
		configPath,
	], {
		cwd: root,
		env: {
			...process.env,
			JITI_ALIAS: JSON.stringify(resolveHostPeerAliases(packageRoot).aliases),
			PI_ASYNC_NATIVE_RUNNER: "1",
			PI_SUBAGENTS_TEST_HEAVY_IMPORT_MARKER: markerPath,
			PI_SUBAGENTS_TEST_HEAVY_IMPORT_DELAY_MS: String(HEAVY_IMPORT_DELAY_MS),
			...env,
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	let output = "";
	child.stdout.setEncoding("utf-8");
	child.stderr.setEncoding("utf-8");
	child.stdout.on("data", (chunk: string) => { output += chunk; });
	child.stderr.on("data", (chunk: string) => { output += chunk; });
	return {
		root,
		asyncDir,
		runId,
		runnerProcessInstanceId,
		sessionFile,
		statusPath,
		markerPath,
		child,
		exited: new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code))),
		readOutput: () => output,
	};
}

function readStartupPayload(startupPath: string): { state?: unknown; token?: unknown; error?: unknown } | undefined {
	try {
		return JSON.parse(fs.readFileSync(startupPath, "utf-8")) as { state?: unknown; token?: unknown; error?: unknown };
	} catch {
		return undefined;
	}
}

async function waitForStartupState(startupPath: string, state: string): Promise<string> {
	const deadline = Date.now() + STARTUP_WAIT_MS;
	while (Date.now() < deadline) {
		const payload = readStartupPayload(startupPath);
		if (payload?.state === "error") throw new Error(`runner reported startup error: ${String(payload.error ?? "")}`);
		if (payload?.state === state && typeof payload.token === "string") return payload.token;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error(`timed out waiting for startup state '${state}' in ${startupPath}`);
}

function writeStartupControl(filePath: string, action: "ack" | "confirm" | "proceed", token: string): void {
	fs.writeFileSync(filePath, JSON.stringify({ action, token }));
}

function stopBootstrap(fixture: BootstrapFixture): Promise<void> {
	return stopBootstrapChild(fixture).then(() => {
		fs.rmSync(fixture.root, { recursive: true, force: true });
	});
}

/** The runner uses its tree as its working directory, so the exit must be observed before the tree is removed. */
async function stopBootstrapChild(fixture: BootstrapFixture): Promise<void> {
	if (fixture.child.exitCode !== null || fixture.child.signalCode !== null) return;
	const exited = fixture.exited;
	fixture.child.kill();
	let deadline: NodeJS.Timeout | undefined;
	try {
		await Promise.race([exited, new Promise((resolve) => {
			deadline = setTimeout(resolve, STARTUP_WAIT_MS);
			deadline.unref();
		})]);
	} finally {
		// A referenced losing timer would keep the test process alive after cleanup.
		clearTimeout(deadline);
	}
}

/** The parent's ready deadline is 10s; the entry must not spend it loading the execution graph (issue #2403). */
test("publishes the startup handshake before the execution graph is imported", async () => {
	const fixture = startBootstrap("startup-ordering", {});
	try {
		const { startupPath, ackPath, confirmPath, proceedPath } = runnerStartupPaths(fixture.asyncDir);
		const token = await waitForStartupState(startupPath, "ready");
		assert.equal(fs.existsSync(fixture.markerPath), false, `execution graph loaded before 'ready' was published (${fixture.readOutput()})`);
		writeStartupControl(ackPath, "ack", token);
		await waitForStartupState(startupPath, "acknowledged");
		writeStartupControl(confirmPath, "confirm", token);
		await waitForStartupState(startupPath, "confirmed");
		assert.equal(fs.existsSync(fixture.markerPath), false, "execution graph loaded before the handshake completed");
		writeStartupControl(proceedPath, "proceed", token);
		assert.equal(await fixture.exited, 0, `runner exited with output: ${fixture.readOutput()}`);
		assert.equal(fs.existsSync(fixture.markerPath), true, "the execution graph must load after the handshake is committed");
	} finally {
		await stopBootstrap(fixture);
	}
});

test("fails the committed run when the execution graph cannot be loaded", async () => {
	const fixture = startBootstrap("startup-import-failure", { PI_SUBAGENTS_TEST_HEAVY_IMPORT_FAIL: "1" });
	try {
		const { startupPath, ackPath, confirmPath, proceedPath } = runnerStartupPaths(fixture.asyncDir);
		const token = await waitForStartupState(startupPath, "ready");
		writeStartupControl(ackPath, "ack", token);
		await waitForStartupState(startupPath, "acknowledged");
		writeStartupControl(confirmPath, "confirm", token);
		await waitForStartupState(startupPath, "confirmed");
		writeStartupControl(proceedPath, "proceed", token);
		assert.equal(await fixture.exited, 1, `runner exited with output: ${fixture.readOutput()}`);

		// A committed run whose graph never loaded must not stay non-terminal: the
		// `not-started` proof plus the error is what lets capacity release the slot
		// immediately instead of waiting for the abandoned-slot timeout, and the
		// empty writer candidate lets the runner-close observation confirm it.
		const status = JSON.parse(fs.readFileSync(fixture.statusPath, "utf-8")) as {
			state?: string;
			error?: string;
			processTerminal?: unknown;
		};
		assert.equal(status.state, "failed");
		assert.match(String(status.error), /^Failed to load the async runner execution graph: /);
		assert.match(String(status.error), /simulated execution-graph import failure/);
		assert.deepEqual(status.processTerminal, {
			version: 1,
			state: "not-started",
			runId: fixture.runId,
			runnerProcessInstanceId: fixture.runnerProcessInstanceId,
		});
		assert.deepEqual(JSON.parse(fs.readFileSync(path.join(fixture.asyncDir, "process-terminal-candidate.json"), "utf-8")), {
			version: 1,
			runId: fixture.runId,
			runnerProcessInstanceId: fixture.runnerProcessInstanceId,
			writers: {},
			expectedWriters: { 0: 0 },
		});
		assert.equal(fs.existsSync(sessionLeaseDir(fixture.sessionFile)), false, "the revival lease must be released on a failed handoff");
	} finally {
		await stopBootstrap(fixture);
	}
});
