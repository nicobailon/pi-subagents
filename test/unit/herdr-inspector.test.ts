import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";
import { handleHerdrInspectorAction, readHerdrInspectorBinding } from "../../src/inspectors/herdr/actions.ts";
import { createHerdrClient, detectHerdr, parseHerdrVersion, supportsRawPanes, type HerdrClient } from "../../src/inspectors/herdr/client.ts";
import { formatInspectorDashboard, submitInspectorControl } from "../../src/inspectors/herdr/inspector-runner.ts";
import { handleHerdrProjectPaneAction, readHerdrProjectPaneBinding } from "../../src/inspectors/herdr/project-panes.ts";
import { consumeSteerRequests, consumeStopRequest } from "../../src/runs/background/control-channel.ts";
import { PI_SUBAGENT_PI_BINARY_ENV } from "../../src/runs/shared/pi-spawn.ts";
import type { AsyncStatus } from "../../src/shared/types.ts";

function fakeChild(): EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill(): boolean } {
	const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill(): boolean };
	child.stdout = new PassThrough();
	child.stderr = new PassThrough();
	child.kill = () => true;
	return child;
}

function writeRun(root: string, id = "run-123"): { asyncDir: string; status: AsyncStatus } {
	const asyncDir = path.join(root, id);
	fs.mkdirSync(asyncDir, { recursive: true });
	const status: AsyncStatus = {
		runId: id,
		mode: "single",
		state: "running",
		startedAt: Date.now() - 1_000,
		cwd: root,
		steps: [{ agent: "worker", status: "running", recentOutput: ["working"] }],
	};
	fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify(status), "utf-8");
	return { asyncDir, status };
}

function text(result: Awaited<ReturnType<typeof handleHerdrInspectorAction>>): string {
	return result.content.find((entry) => entry.type === "text")?.text ?? "";
}

describe("Herdr inspector", () => {
	it("normalizes missing binaries, timeouts, and supported versions", async () => {
		const missing = createHerdrClient({ spawn: (() => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); }) as never });
		const missingResult = await missing.run(["--version"]);
		assert.equal(missingResult.ok, false);
		if (!missingResult.ok) assert.equal(missingResult.error.code, "HERDR_UNAVAILABLE");

		const timeout = createHerdrClient({ spawn: (() => fakeChild()) as never });
		const timeoutResult = await timeout.run(["pane", "get", "w1:p2"], { timeoutMs: 5 });
		assert.equal(timeoutResult.ok, false);
		if (!timeoutResult.ok) assert.equal(timeoutResult.error.code, "TIMEOUT");

		const gone = createHerdrClient({ spawn: (() => {
			const child = fakeChild();
			queueMicrotask(() => {
				child.stderr.end(JSON.stringify({ error: { code: "no_such_pane", message: "gone" } }));
				child.emit("close", 1);
			});
			return child;
		}) as never });
		const goneResult = await gone.run(["pane", "get", "w1:p2"]);
		assert.equal(goneResult.ok, false);
		if (!goneResult.ok) assert.equal(goneResult.error.code, "NOT_FOUND");

		assert.deepEqual(parseHerdrVersion("herdr 0.7.5"), { major: 0, minor: 7, patch: 5 });
		assert.equal(supportsRawPanes({ major: 0, minor: 7, patch: 4 }), false);
		const old: HerdrClient = { run: async () => ({ ok: true, data: "herdr 0.7.4" }) };
		const oldResult = await detectHerdr(old);
		assert.equal(oldResult.ok, false);
		if (!oldResult.ok) assert.equal(oldResult.error.code, "HERDR_UNSUPPORTED_VERSION");
	});

	it("opens one raw inspector pane, persists its binding, and closes only that pane", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-herdr-inspector-"));
		try {
			const { asyncDir } = writeRun(root);
			const missionDir = path.join(root, "other-project", ".pi-subagents", "missions");
			fs.writeFileSync(path.join(asyncDir, "mission.json"), JSON.stringify({
				schemaVersion: 1,
				missionId: "mission-cross-project",
				projectRoot: path.join(root, "other-project"),
				missionDir,
				globalIndexDir: path.join(root, "mission-index"),
				writeGlobalIndex: false,
			}), "utf-8");
			const calls: string[][] = [];
			const client: HerdrClient = {
				run: async <T>(args: string[]) => {
					calls.push(args);
					if (args[0] === "--version") return { ok: true, data: "herdr 0.7.5" as T };
					if (args[0] === "pane" && args[1] === "split") return { ok: true, data: { pane: { pane_id: "w1:p9" } } as T };
					return { ok: true, data: {} as T };
				},
			};
			const opened = await handleHerdrInspectorAction("inspector.open", { id: "run-123" }, {
				cwd: root,
				asyncDirRoot: root,
				resultsDir: path.join(root, "results"),
				client,
				runnerPath: path.join(root, "runner.ts"),
				now: () => new Date("2026-01-01T00:00:00.000Z"),
			});
			assert.equal(opened.isError, undefined, text(opened));
			assert.match(text(opened), /read-only Herdr inspector pane w1:p9/);
			const binding = readHerdrInspectorBinding(asyncDir);
			assert.equal(binding?.paneId, "w1:p9");
			assert.equal(binding?.openedAt, "2026-01-01T00:00:00.000Z");
			assert.equal(binding?.missionId, "mission-cross-project");
			assert.equal(binding?.missionPath, path.join(missionDir, "mission-cross-project.json"));
			const runCall = calls.find((args) => args[0] === "pane" && args[1] === "run" && args[2] === "w1:p9");
			assert.ok(runCall);
			assert.match(runCall[3] ?? "", /--allow-steer.*true.*--allow-stop.*true/);

			const closed = await handleHerdrInspectorAction("inspector.close", { dir: asyncDir }, { cwd: root, asyncDirRoot: root, client });
			assert.equal(closed.isError, undefined, text(closed));
			assert.match(text(closed), /subagent run was not stopped/);
			assert.equal(readHerdrInspectorBinding(asyncDir), undefined);
			assert.ok(calls.some((args) => args.join(" ") === "pane close w1:p9"));
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("refuses direct run directories outside trusted roots", async () => {
		const trustedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-herdr-trusted-"));
		const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-herdr-outside-"));
		try {
			const { asyncDir } = writeRun(outsideRoot);
			const inspected = await handleHerdrInspectorAction("inspector.status", { dir: asyncDir }, {
				cwd: trustedRoot,
				asyncDirRoot: trustedRoot,
				client: { run: async () => ({ ok: true, data: {} }) },
			});
			assert.equal(inspected.isError, true);
			assert.match(text(inspected), /outside trusted run roots/);
		} finally {
			fs.rmSync(trustedRoot, { recursive: true, force: true });
			fs.rmSync(outsideRoot, { recursive: true, force: true });
		}
	});

	it("renders mission context and reuses existing steer/stop control records", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-herdr-controls-"));
		try {
			const { asyncDir, status } = writeRun(root);
			const dashboard = formatInspectorDashboard({
				status,
				asyncDir,
				mission: {
					schemaVersion: 1,
					id: "mission-1",
					title: "Ship inspector",
					goal: "Inspect safely",
					status: "active",
					createdAt: "2026-01-01T00:00:00.000Z",
					updatedAt: "2026-01-01T00:00:00.000Z",
					runs: [],
					decisions: [{ id: "decision-1", status: "open", title: "Choose UX", createdAt: "2026-01-01T00:00:00.000Z" }],
					artifacts: [],
				},
			});
			assert.match(dashboard, /Mission: Ship inspector \(active\)/);
			assert.match(dashboard, /decision-1: Choose UX/);
			assert.match(dashboard, /closing it does not stop the run/i);

			assert.match(submitInspectorControl({ asyncDir, runId: "run-123", refreshMs: 1_500 }, "steer keep going"), /queued/);
			assert.deepEqual(consumeSteerRequests(asyncDir).map((request) => ({ message: request.message, targetIndex: request.targetIndex, source: request.source })), [
				{ message: "keep going", targetIndex: 0, source: "herdr-inspector" },
			]);
			assert.match(submitInspectorControl({ asyncDir, runId: "run-123", refreshMs: 1_500 }, "stop"), /Stop requested/);
			assert.equal(consumeStopRequest(asyncDir), true);
			assert.throws(() => submitInspectorControl({ asyncDir, runId: "run-123", refreshMs: 1_500 }, "reply decision-1 yes"), /parent Pi session/);
			assert.throws(() => submitInspectorControl({ asyncDir, runId: "run-123", refreshMs: 1_500, allowSteer: false }, "steer bypass"), /Authority policy/);
			assert.throws(() => submitInspectorControl({ asyncDir, runId: "run-123", refreshMs: 1_500, allowStop: false }, "stop"), /Authority policy/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("opens, reports, and closes a project-owned Herdr pane", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-herdr-project-pane-"));
		const previousPiBinary = process.env[PI_SUBAGENT_PI_BINARY_ENV];
		process.env[PI_SUBAGENT_PI_BINARY_ENV] = path.join(root, "pi-bin");
		try {
			const projectRoot = fs.realpathSync(root);
			const calls: string[][] = [];
			const client: HerdrClient = {
				run: async <T>(args: string[]) => {
					calls.push(args);
					if (args[0] === "--version") return { ok: true, data: "herdr 0.7.5" as T };
					if (args[0] === "pane" && args[1] === "split") return { ok: true, data: { pane: { pane_id: "w1:p10" } } as T };
					return { ok: true, data: {} as T };
				},
			};

			const opened = await handleHerdrProjectPaneAction("project.open", { cwd: root, message: "Own this project mission." }, {
				cwd: process.cwd(),
				client,
				now: () => new Date("2026-01-01T00:00:00.000Z"),
			});
			assert.equal(opened.isError, undefined, text(opened));
			assert.match(text(opened), /Opened Herdr project pane w1:p10/);
			const binding = readHerdrProjectPaneBinding(root);
			assert.equal(binding?.paneId, "w1:p10");
			assert.equal(binding?.projectRoot, projectRoot);
			assert.equal(binding?.startupMessage, "Own this project mission.");
			const splitCall = calls.find((args) => args[0] === "pane" && args[1] === "split");
			assert.deepEqual(splitCall?.slice(0, 7), ["pane", "split", "--current", "--direction", "right", "--cwd", projectRoot]);
			const runCall = calls.find((args) => args[0] === "pane" && args[1] === "run" && args[2] === "w1:p10");
			assert.match(runCall?.[3] ?? "", /pi-bin/);
			assert.match(runCall?.[3] ?? "", /Own this project mission\./);

			const status = await handleHerdrProjectPaneAction("project.status", { cwd: root }, { cwd: process.cwd(), client });
			assert.equal(status.isError, undefined, text(status));
			assert.match(text(status), /project pane w1:p10 is open/);

			const closed = await handleHerdrProjectPaneAction("project.close", { cwd: root }, { cwd: process.cwd(), client });
			assert.equal(closed.isError, undefined, text(closed));
			assert.match(text(closed), /Closed Herdr project pane w1:p10/);
			assert.equal(readHerdrProjectPaneBinding(root), undefined);
			assert.ok(calls.some((args) => args.join(" ") === "pane close w1:p10"));
		} finally {
			if (previousPiBinary === undefined) delete process.env[PI_SUBAGENT_PI_BINARY_ENV];
			else process.env[PI_SUBAGENT_PI_BINARY_ENV] = previousPiBinary;
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects project pane targets that are not directories", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-herdr-project-pane-missing-"));
		try {
			const missing = path.join(root, "missing");
			const opened = await handleHerdrProjectPaneAction("project.open", { cwd: missing }, {
				cwd: root,
				client: { run: async () => ({ ok: true, data: {} }) },
			});
			assert.equal(opened.isError, true);
			assert.match(text(opened), /unavailable/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
