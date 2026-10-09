import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { bindingPath, readTmuxInspectorBinding, readTmuxInspectorBindingForTarget } from "../../src/inspectors/tmux/actions.ts";
import { createTmuxClient } from "../../src/inspectors/tmux/client.ts";
import { createTmuxInspectorPlugin } from "../../src/inspectors/tmux/plugin.ts";
import type { TmuxClient } from "../../src/inspectors/tmux/client.ts";
import type { InspectorContext, InspectorLaunch } from "../../src/inspectors/types.ts";

function tempRoot(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "tmux-inspector-test-"));
}

/** A temp async dir already holding a tmux binding for run-1 and pane %6. */
function boundRoot(extra: Record<string, unknown> = {}, index?: number): string {
	const root = tempRoot();
	fs.mkdirSync(path.join(root, "inspectors"), { recursive: true });
	fs.writeFileSync(bindingPath(root, index), JSON.stringify({
		schemaVersion: 1,
		kind: "tmux-inspector",
		runId: "run-1",
		asyncDir: root,
		paneId: "%6",
		openedAt: new Date().toISOString(),
		command: "node x",
		...extra,
	}));
	return root;
}

function ctx(asyncDir: string, env: NodeJS.ProcessEnv = {}, index?: number): InspectorContext {
	return {
		cwd: "/tmp",
		env,
		target: {
			runId: "run-1",
			asyncDir,
			...(index === undefined ? {} : { index }),
			status: { cwd: "/tmp", state: "running", steps: [] },
		},
	};
}

function launch(mission?: { id: string; path: string }): InspectorLaunch {
	return { executable: "node", argv: ["x"], displayCommand: "node x", allowSteer: true, allowStop: true, sessionRoots: [], ...(mission ? { mission } : {}) };
}

/** Scripted tmux client: maps first argument word to a queued response. "!CODE|message" entries resolve to error results. */
function fakeClient(responses: Record<string, string[]>, commands: string[] = []): TmuxClient {
	const queue = Object.fromEntries(Object.entries(responses).map(([key, value]) => [key, [...value]]));
	return {
		run: async (args) => {
			commands.push(args.join(" "));
			const key = args[0];
			const next = queue[key]?.shift();
			if (next === undefined) throw new Error(`unexpected tmux command: ${args.join(" ")}`);
			if (next.startsWith("!")) {
				const [code, ...rest] = next.slice(1).split("|");
				return { ok: false, error: { code: code as never, message: rest.join("|") || code } };
			}
			return { ok: true, data: next };
		},
	};
}

describe("tmux inspector availability", () => {
	it("does not take over on win32", async () => {
		const plugin = createTmuxInspectorPlugin({ platform: "win32" });
		assert.equal(await plugin.available(ctx(tempRoot(), { TMUX: "/tmp/tmux-0/default,%0,0" })), false);
	});

	it("does not take over without TMUX env", async () => {
		const plugin = createTmuxInspectorPlugin({ platform: "darwin" });
		assert.equal(await plugin.available(ctx(tempRoot(), {})), false);
	});

	it("takes over when running inside tmux", async () => {
		const plugin = createTmuxInspectorPlugin({ platform: "darwin" });
		assert.equal(await plugin.available(ctx(tempRoot(), { TMUX: "/tmp/tmux-0/default,%0,0" })), true);
	});
});

describe("tmux inspector open", () => {
	it("splits the window, writes a binding, and refocuses the original pane when focus is not requested", async () => {
		const root = tempRoot();
		const commands: string[] = [];
		const client = fakeClient({
			"-V": ["tmux 3.7c"],
			"display-message": ["%5", "69556"],
			"split-window": ["%6"],
			"select-pane": [""],
			"set-option": [""],
		}, commands);
		const plugin = createTmuxInspectorPlugin({ platform: "darwin", client });
		const response = await plugin.open(ctx(root, { TMUX: "1" }), launch({ id: "m-1", path: "/tmp/m-1.json" }), {});
		assert.ok(!response.isError, String(response.content[0].text));
		assert.match(String(response.content[0].text), /%6/);
		assert.ok(commands.some((command) => command.includes("split-window -h -P -F #{pane_id} -c /tmp node x")));
		assert.ok(commands.some((command) => command.includes("select-pane -t %5")));
		const binding = readTmuxInspectorBinding(root);
		assert.equal(binding?.paneId, "%6");
		assert.equal(binding?.runId, "run-1");
		assert.equal(binding?.command, "node x");
		assert.equal(binding?.tmuxVersion, "tmux 3.7c");
		assert.equal(binding?.serverPid, "69556");
		assert.equal(binding?.missionId, "m-1");
		assert.equal(binding?.missionPath, "/tmp/m-1.json");
		assert.ok(commands.some((command) => command.includes("set-option -p -t %6 @pi-subagents-inspector pi-subagents:run-1:-")));
	});

	it("skips select-pane when focus is requested", async () => {
		const root = tempRoot();
		const commands: string[] = [];
		const client = fakeClient({
			"-V": ["tmux 3.7c"],
			"split-window": ["%6"],
			"set-option": [""],
			"display-message": ["69556"],
		}, commands);
		const plugin = createTmuxInspectorPlugin({ platform: "darwin", client });
		await plugin.open(ctx(root, { TMUX: "1" }), launch(), { focus: true });
		assert.ok(!commands.some((command) => command.startsWith("display-message -p #{pane_id}")));
		assert.ok(!commands.some((command) => command.startsWith("select-pane")));
	});

	it("reuses an existing live pane instead of splitting again", async () => {
		const root = boundRoot();
		const commands: string[] = [];
		const client = fakeClient({
			"-V": ["tmux 3.7c"],
			"list-panes": ["%6|pi-subagents:run-1:-|69556"],
		}, commands);
		const plugin = createTmuxInspectorPlugin({ platform: "darwin", client });
		const response = await plugin.open(ctx(root, { TMUX: "1" }), launch(), {});
		assert.match(String(response.content[0].text), /already open/);
		assert.ok(!commands.some((command) => command.startsWith("split-window")));
		assert.ok(!commands.some((command) => command.startsWith("select-pane")));
	});

	it("refocuses an existing live pane when focus is requested", async () => {
		const root = boundRoot();
		const commands: string[] = [];
		const client = fakeClient({
			"-V": ["tmux 3.7c"],
			"list-panes": ["%6|pi-subagents:run-1:-|69556"],
			"select-pane": [""],
		}, commands);
		const plugin = createTmuxInspectorPlugin({ platform: "darwin", client });
		const response = await plugin.open(ctx(root, { TMUX: "1" }), launch(), { focus: true });
		assert.match(String(response.content[0].text), /already open/);
		assert.ok(commands.some((command) => command.startsWith("select-pane -t %6")));
	});

	it("splits a fresh pane when the saved pane no longer carries the marker", async () => {
		const root = boundRoot();
		const commands: string[] = [];
		const client = fakeClient({
			"-V": ["tmux 3.7c"],
			"list-panes": ["%6||69556"],
			"display-message": ["%5", "69556"],
			"split-window": ["%7"],
			"select-pane": [""],
			"set-option": [""],
		}, commands);
		const plugin = createTmuxInspectorPlugin({ platform: "darwin", client });
		const response = await plugin.open(ctx(root, { TMUX: "1" }), launch(), {});
		assert.ok(!response.isError, String(response.content[0].text));
		assert.match(String(response.content[0].text), /%7/);
		assert.equal(readTmuxInspectorBinding(root)?.paneId, "%7");
	});

	it("fails open instead of duplicating the inspector when the liveness probe errors", async () => {
		const root = boundRoot();
		const commands: string[] = [];
		const client = fakeClient({
			"-V": ["tmux 3.7c"],
			"list-panes": ["!TIMEOUT|probe timed out"],
		}, commands);
		const plugin = createTmuxInspectorPlugin({ platform: "darwin", client });
		const response = await plugin.open(ctx(root, { TMUX: "1" }), launch(), {});
		assert.ok(response.isError);
		assert.match(String(response.content[0].text), /TIMEOUT/);
		assert.ok(!commands.some((command) => command.startsWith("split-window")));
	});

	it("kills the created pane when stamping the marker fails", async () => {
		const root = tempRoot();
		const commands: string[] = [];
		const client = fakeClient({
			"-V": ["tmux 3.7c"],
			"display-message": ["%5"],
			"split-window": ["%6"],
			"select-pane": [""],
			"set-option": ["!TMUX_ERROR|cannot set option"],
			"kill-pane": [""],
		}, commands);
		const plugin = createTmuxInspectorPlugin({ platform: "darwin", client });
		const response = await plugin.open(ctx(root, { TMUX: "1" }), launch(), {});
		assert.ok(response.isError);
		assert.match(String(response.content[0].text), /TMUX_ERROR/);
		assert.ok(commands.some((command) => command.startsWith("kill-pane -t %6")));
		assert.equal(readTmuxInspectorBinding(root), undefined);
	});

	it("kills the created pane when saving the binding fails", async () => {
		const root = tempRoot();
		// A file where the bindings directory belongs makes the binding write fail after the split.
		fs.writeFileSync(path.join(root, "inspectors"), "");
		const commands: string[] = [];
		const client = fakeClient({
			"-V": ["tmux 3.7c"],
			"display-message": ["%5", "4242"],
			"split-window": ["%6"],
			"select-pane": [""],
			"set-option": [""],
			"kill-pane": [""],
		}, commands);
		const plugin = createTmuxInspectorPlugin({ platform: "darwin", client });
		await assert.rejects(Promise.resolve().then(() => plugin.open(ctx(root, { TMUX: "1" }), launch(), {})));
		assert.ok(commands.some((command) => command.startsWith("kill-pane -t %6")));
	});

	it("stamps the child index into the marker and the binding", async () => {
		const root = tempRoot();
		const commands: string[] = [];
		const client = fakeClient({
			"-V": ["tmux 3.7c"],
			"split-window": ["%6"],
			"set-option": [""],
			"display-message": ["69556"],
		}, commands);
		const plugin = createTmuxInspectorPlugin({ platform: "darwin", client });
		const response = await plugin.open(ctx(root, { TMUX: "1" }, 0), launch(), { focus: true });
		assert.ok(!response.isError, String(response.content[0].text));
		assert.ok(commands.some((command) => command.includes("set-option -p -t %6 @pi-subagents-inspector pi-subagents:run-1:0")));
		assert.equal(readTmuxInspectorBinding(root, 0)?.childIndex, 0);
	});

	it("reports a clean error when tmux is missing", async () => {
		const root = tempRoot();
		const plugin = createTmuxInspectorPlugin({
			platform: "darwin",
			client: createTmuxClient({ exec: (_file, _args, _options, callback) => {
				const failure = Object.assign(new Error("spawn tmux ENOENT"), { code: "ENOENT" });
				callback(failure, "");
			} }),
		});
		const response = await plugin.open(ctx(root, { TMUX: "1" }), launch(), {});
		assert.ok(response.isError);
		assert.match(String(response.content[0].text), /TMUX_UNAVAILABLE/);
	});
});

describe("tmux inspector status and close", () => {
	it("reports a missing binding on status", async () => {
		const root = tempRoot();
		const plugin = createTmuxInspectorPlugin({ platform: "darwin", client: fakeClient({}) });
		const response = await plugin.status?.(ctx(root, { TMUX: "1" }));
		assert.match(String(response?.content[0].text), /No tmux inspector binding exists/);
	});

	it("reports the live pane and the binding path on status", async () => {
		const root = boundRoot();
		const plugin = createTmuxInspectorPlugin({ platform: "darwin", client: fakeClient({ "list-panes": ["%6|pi-subagents:run-1:-|69556"] }) });
		const response = await plugin.status?.(ctx(root, { TMUX: "1" }));
		const text = String(response?.content[0].text);
		assert.match(text, /%6 is open/);
		assert.match(text, /Run state: running/);
	});

	it("reports a gone pane on status", async () => {
		const root = boundRoot();
		const plugin = createTmuxInspectorPlugin({ platform: "darwin", client: fakeClient({ "list-panes": ["!PANE_GONE|can't find pane: %6"] }) });
		const response = await plugin.status?.(ctx(root, { TMUX: "1" }));
		assert.match(String(response?.content[0].text), /no longer exists/);
	});

	it("reports a pane that lost its marker without claiming it is gone", async () => {
		const root = boundRoot();
		const plugin = createTmuxInspectorPlugin({ platform: "darwin", client: fakeClient({ "list-panes": ["%6||69556"] }) });
		const response = await plugin.status?.(ctx(root, { TMUX: "1" }));
		const text = String(response?.content[0].text);
		assert.match(text, /marker/);
		assert.ok(!text.includes("no longer exists"));
	});

	it("surfaces a probe error on status instead of reporting the pane gone", async () => {
		const root = boundRoot();
		const plugin = createTmuxInspectorPlugin({ platform: "darwin", client: fakeClient({ "list-panes": ["!TIMEOUT|probe timed out"] }) });
		const response = await plugin.status?.(ctx(root, { TMUX: "1" }));
		assert.ok(response?.isError);
		assert.match(String(response.content[0].text), /TIMEOUT/);
	});

	it("picks the target pane's line when list-panes reports the whole window", async () => {
		const root = boundRoot();
		const plugin = createTmuxInspectorPlugin({ platform: "darwin", client: fakeClient({ "list-panes": ["%5||69556\n%6|pi-subagents:run-1:-|69556"] }) });
		const response = await plugin.status?.(ctx(root, { TMUX: "1" }));
		assert.match(String(response?.content[0].text), /%6 is open/);
	});

	it("reports stale when the server pid changed", async () => {
		const root = boundRoot({ serverPid: "111" });
		const plugin = createTmuxInspectorPlugin({ platform: "darwin", client: fakeClient({ "list-panes": ["%6|pi-subagents:run-1:-|69556"] }) });
		const response = await plugin.status?.(ctx(root, { TMUX: "1" }));
		assert.match(String(response?.content[0].text), /marker/);
	});

	it("kills a verified pane and removes the binding", async () => {
		const root = boundRoot();
		const commands: string[] = [];
		const plugin = createTmuxInspectorPlugin({ platform: "darwin", client: fakeClient({
			"list-panes": ["%6|pi-subagents:run-1:-|69556"],
			"kill-pane": [""],
		}, commands) });
		const response = await plugin.close?.(ctx(root, { TMUX: "1" }));
		assert.match(String(response?.content[0].text), /Closed tmux inspector pane %6/);
		assert.ok(commands.some((command) => command.startsWith("kill-pane -t %6")));
		assert.equal(readTmuxInspectorBinding(root), undefined);
	});

	it("treats an already-gone pane as a successful close", async () => {
		const root = boundRoot();
		const commands: string[] = [];
		const plugin = createTmuxInspectorPlugin({ platform: "darwin", client: fakeClient({
			"list-panes": ["!PANE_GONE|can't find pane: %6"],
		}, commands) });
		const response = await plugin.close?.(ctx(root, { TMUX: "1" }));
		assert.match(String(response?.content[0].text), /Closed tmux inspector pane %6/);
		assert.ok(!commands.some((command) => command.startsWith("kill-pane")));
		assert.equal(readTmuxInspectorBinding(root), undefined);
	});

	it("keeps the binding when killing fails", async () => {
		const root = boundRoot();
		const plugin = createTmuxInspectorPlugin({ platform: "darwin", client: fakeClient({
			"list-panes": ["%6|pi-subagents:run-1:-|69556"],
			"kill-pane": ["!TMUX_ERROR|kill failed"],
		}) });
		const response = await plugin.close?.(ctx(root, { TMUX: "1" }));
		assert.ok(response?.isError);
		assert.match(String(response.content[0].text), /kill failed/);
		assert.ok(readTmuxInspectorBinding(root));
	});

	it("removes the binding without killing a pane that lost its marker", async () => {
		const root = boundRoot();
		const commands: string[] = [];
		const plugin = createTmuxInspectorPlugin({ platform: "darwin", client: fakeClient({
			"list-panes": ["%6|other-owner:run-9:-|69556"],
		}, commands) });
		const response = await plugin.close?.(ctx(root, { TMUX: "1" }));
		assert.match(String(response?.content[0].text), /without killing/);
		assert.ok(!commands.some((command) => command.startsWith("kill-pane")));
		assert.equal(readTmuxInspectorBinding(root), undefined);
	});

	it("keeps the binding when the probe errors", async () => {
		const root = boundRoot();
		const plugin = createTmuxInspectorPlugin({ platform: "darwin", client: fakeClient({ "list-panes": ["!TIMEOUT|probe timed out"] }) });
		const response = await plugin.close?.(ctx(root, { TMUX: "1" }));
		assert.ok(response?.isError);
		assert.match(String(response.content[0].text), /TIMEOUT/);
		assert.ok(readTmuxInspectorBinding(root));
	});
});

describe("tmux client failure classification", () => {
	it("classifies tmux stderr as PANE_GONE instead of the 'Command failed' prefix", async () => {
		const client = createTmuxClient({ exec: (_file, _args, _options, callback) => {
			callback(new Error("Command failed: tmux kill-pane -t %6"), "", "can't find pane: %6\n");
		} });
		const outcome = await client.run(["kill-pane", "-t", "%6"]);
		assert.equal(outcome.ok ? "" : outcome.error.code, "PANE_GONE");
		assert.equal(outcome.ok ? "" : outcome.error.message, "can't find pane: %6");
	});

	it("falls back to the first non-'Command failed' message line when stderr is empty", async () => {
		const client = createTmuxClient({ exec: (_file, _args, _options, callback) => {
			callback(new Error("Command failed: tmux list-panes -t %3\ncan't find window @3\n"), "", "");
		} });
		const outcome = await client.run(["list-panes", "-t", "%3"]);
		assert.equal(outcome.ok ? "" : outcome.error.code, "PANE_GONE");
	});

	it("settles a cancelled call once with TIMEOUT and passes the abort signal to the exec", async () => {
		let captured: { timeout: number; signal?: AbortSignal } | undefined;
		const client = createTmuxClient({ exec: (_file, _args, options, _callback) => {
			captured = options;
		} });
		const controller = new AbortController();
		const pending = client.run(["list-panes", "-t", "%6"], { signal: controller.signal });
		controller.abort();
		const outcome = await pending;
		assert.equal(outcome.ok ? "" : outcome.error.code, "TIMEOUT");
		assert.equal(captured?.signal, controller.signal);
	});

	it("settles immediately when the signal is already aborted", async () => {
		let called = false;
		const client = createTmuxClient({ exec: () => {
			called = true;
		} });
		const controller = new AbortController();
		controller.abort();
		const outcome = await client.run(["list-panes"], { signal: controller.signal });
		assert.equal(outcome.ok ? "" : outcome.error.code, "TIMEOUT");
		assert.equal(called, false);
	});

	it("classifies a node-killed child as TIMEOUT", async () => {
		const client = createTmuxClient({ exec: (_file, _args, _options, callback) => {
			callback(Object.assign(new Error("Command failed: tmux list-panes"), { killed: true, signal: "SIGTERM", code: null }), "", "");
		} });
		const outcome = await client.run(["list-panes"]);
		assert.equal(outcome.ok ? "" : outcome.error.code, "TIMEOUT");
	});
});

describe("tmux inspector binding ownership", () => {
	it("rejects bindings for other runs or children", () => {
		const root = boundRoot({ childIndex: 0 }, 0);
		const target = { runId: "run-1", asyncDir: root, index: 0, status: { state: "running" } };
		assert.ok(readTmuxInspectorBindingForTarget(target));
		assert.equal(readTmuxInspectorBindingForTarget({ ...target, runId: "run-2" }), undefined);
		assert.equal(readTmuxInspectorBindingForTarget({ ...target, index: 1 }), undefined);
		assert.equal(readTmuxInspectorBindingForTarget({ ...target, index: undefined }), undefined);
	});
});
