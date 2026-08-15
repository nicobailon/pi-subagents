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
import { createProjectPaneManager, handleHerdrProjectPaneAction, readHerdrProjectPaneBinding } from "../../src/inspectors/herdr/project-panes.ts";
import { consumeSteerRequests, consumeStopRequest } from "../../src/runs/background/control-channel.ts";
import { PI_SUBAGENT_PI_BINARY_ENV } from "../../src/runs/shared/pi-spawn.ts";
import type { AsyncStatus, SubagentState } from "../../src/shared/types.ts";

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
			const sessionRoot = path.join(root, "sessions");
			const missionDir = path.join(root, "other-project", ".pi/subagents", "missions");
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
				sessionRoots: [sessionRoot],
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
			if (process.platform !== "win32") {
				assert.ok(!/^[']/.test(runCall[3] ?? ""), `pane run command must not open with a quoted executable; Nushell parses it as a string expression: ${runCall[3]}`);
			}
			assert.match(runCall[3] ?? "", /--allow-steer.*true.*--allow-stop.*true/);
			assert.match(runCall[3] ?? "", /--session-roots.*sessions/);

			const closed = await handleHerdrInspectorAction("inspector.close", { dir: asyncDir }, { cwd: root, asyncDirRoot: root, client });
			assert.equal(closed.isError, undefined, text(closed));
			assert.match(text(closed), /subagent run was not stopped/);
			assert.equal(readHerdrInspectorBinding(asyncDir), undefined);
			assert.ok(calls.some((args) => args.join(" ") === "pane close w1:p9"));
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("passes live parent-owned custom session roots to standalone inspectors", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-herdr-custom-session-"));
		try {
			const { asyncDir, status } = writeRun(root);
			const sessionRoot = path.join(root, "custom-sessions");
			status.steps![0] = { ...status.steps![0], sessionFile: path.join(sessionRoot, "run-0", "session.jsonl") };
			fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify(status), "utf-8");
			const calls: string[][] = [];
			const client: HerdrClient = {
				run: async <T>(args: string[]) => {
					calls.push(args);
					if (args[0] === "--version") return { ok: true, data: "herdr 0.7.5" as T };
					if (args[0] === "pane" && args[1] === "split") return { ok: true, data: { pane: { pane_id: "w1:p11" } } as T };
					return { ok: true, data: {} as T };
				},
			};
			const state = {
				asyncJobs: new Map([["run-123", { asyncId: "run-123", asyncDir, status: "running", sessionRoot }]]),
				foregroundControls: new Map(),
				lastForegroundControlId: null,
				baseCwd: root,
				currentSessionId: "session-1",
			} as unknown as SubagentState;

			const opened = await handleHerdrInspectorAction("inspector.open", { id: "run-123" }, {
				cwd: root,
				asyncDirRoot: root,
				client,
				state,
				runnerPath: path.join(root, "runner.ts"),
			});
			assert.equal(opened.isError, undefined, text(opened));
			const runCall = calls.find((args) => args[0] === "pane" && args[1] === "run" && args[2] === "w1:p11");
			assert.match(runCall?.[3] ?? "", /--session-roots/);
			assert.match(runCall?.[3] ?? "", /custom-sessions/);

			state.asyncJobs.clear();
			fs.rmSync(path.join(asyncDir, "inspectors"), { recursive: true, force: true });
			calls.length = 0;
			const reopened = await handleHerdrInspectorAction("inspector.open", { id: "run-123" }, {
				cwd: root,
				asyncDirRoot: root,
				client,
				state,
				runnerPath: path.join(root, "runner.ts"),
			});
			assert.equal(reopened.isError, undefined, text(reopened));
			const untrustedRunCall = calls.find((args) => args[0] === "pane" && args[1] === "run" && args[2] === "w1:p11");
			assert.doesNotMatch(untrustedRunCall?.[3] ?? "", /custom-sessions/);
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
					goal: { status: "active" },
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

	it("renders trusted child session fallback and refuses untrusted roots", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-herdr-session-"));
		try {
			const { asyncDir, status } = writeRun(root);
			const sessionRoot = path.join(root, "sessions");
			const sessionFile = path.join(sessionRoot, "child.jsonl");
			fs.mkdirSync(sessionRoot, { recursive: true });
			fs.writeFileSync(sessionFile, `${JSON.stringify({ role: "assistant", content: "session fallback text" })}\n`, "utf-8");
			status.steps![0] = { ...status.steps![0], recentOutput: [], sessionFile };

			const trusted = formatInspectorDashboard({ status, asyncDir, sessionRoots: [sessionRoot] });
			assert.match(trusted, /assistant: session fallback text/);
			assert.doesNotMatch(trusted, /without a trusted root/);

			const untrusted = formatInspectorDashboard({ status, asyncDir });
			assert.match(untrusted, /without a trusted root/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("opens, reports, and closes a project-owned Herdr pane", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi=herdr project pane-"));
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
					if (args[0] === "pane" && args[1] === "get") return { ok: true, data: { pane: {
						pane_id: "w1:p10", agent: "pi", agent_status: "idle", cwd: projectRoot,
						foreground_cwd: projectRoot, focused: false, terminal_title_stripped: "Pi · project",
					} } as T };
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
			assert.equal(runCall?.[3]?.startsWith("& "), process.platform === "win32");
			if (process.platform !== "win32") assert.match(runCall?.[3] ?? "", /^sh -c 'exec \"\$0\" \"\$@\"' '/);
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

	it("fails closed when an idle-only project pane close sees active work", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-herdr-project-pane-busy-"));
		try {
			const projectRoot = fs.realpathSync(root);
			const calls: string[][] = [];
			let opened = false;
			const client: HerdrClient = {
				run: async <T>(args: string[]) => {
					calls.push(args);
					if (args[0] === "--version") return { ok: true, data: "herdr 0.8.0" as T };
					if (args[0] === "pane" && args[1] === "split") return { ok: true, data: { pane: { pane_id: "w1:p11" } } as T };
					if (args[0] === "pane" && args[1] === "run") { opened = true; return { ok: true, data: {} as T }; }
					if (args[0] === "pane" && args[1] === "get" && opened) return { ok: true, data: { pane: {
						pane_id: "w1:p11", agent: "pi", agent_status: "working", cwd: projectRoot,
					} } as T };
					return { ok: true, data: {} as T };
				},
			};
			const manager = createProjectPaneManager({ client });
			const open = await manager.open({ cwd: root, focus: false });
			assert.equal(open.ok, true);
			const closed = await manager.close({ cwd: root, requireIdle: true });
			assert.equal(closed.ok, false);
			if (!closed.ok) assert.equal(closed.error.code, "PANE_NOT_IDLE");
			assert.equal(calls.some((args) => args.join(" ") === "pane close w1:p11"), false);
			assert.equal(readHerdrProjectPaneBinding(root)?.paneId, "w1:p11");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("preserves legacy model-facing recovery for transient and opaque pane inspection results", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-herdr-project-pane-legacy-"));
		try {
			let splitCount = 0;
			let getMode: "valid" | "timeout" | "opaque" = "valid";
			const client: HerdrClient = {
				run: async <T>(args: string[]) => {
					if (args[0] === "--version") return { ok: true, data: "herdr 0.8.0" as T };
					if (args[0] === "pane" && args[1] === "split") {
						splitCount++;
						return { ok: true, data: { pane: { pane_id: `w1:p3${splitCount}` } } as T };
					}
					if (args[0] === "pane" && args[1] === "get") {
						if (getMode === "timeout") return { ok: false, error: { code: "TIMEOUT", message: "temporary" } };
						if (getMode === "opaque") return { ok: true, data: {} as T };
						return { ok: true, data: { pane: { pane_id: `w1:p3${splitCount}`, agent_status: "idle", cwd: root } } as T };
					}
					return { ok: true, data: {} as T };
				},
			};
			const first = await handleHerdrProjectPaneAction("project.open", { cwd: root }, { cwd: root, client });
			assert.equal(first.isError, undefined, text(first));
			getMode = "timeout";
			const recovered = await handleHerdrProjectPaneAction("project.open", { cwd: root }, { cwd: root, client });
			assert.equal(recovered.isError, undefined, text(recovered));
			assert.equal(splitCount, 2);
			assert.equal(readHerdrProjectPaneBinding(root)?.paneId, "w1:p32");
			getMode = "opaque";
			const status = await handleHerdrProjectPaneAction("project.status", { cwd: root }, { cwd: root, client });
			assert.equal(status.isError, undefined, text(status));
			assert.match(text(status), /w1:p32 is open/);
			const legacyBinding = readHerdrProjectPaneBinding(root)!;
			fs.writeFileSync(path.join(root, ".pi/subagents", "project-panes", "herdr.json"), JSON.stringify({ ...legacyBinding, startupMessage: 42 }));
			const closed = await handleHerdrProjectPaneAction("project.close", { cwd: root }, { cwd: root, client });
			assert.equal(closed.isError, undefined, text(closed));
			assert.equal(readHerdrProjectPaneBinding(root), undefined);
		} finally {
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
