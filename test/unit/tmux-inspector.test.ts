import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { handleInspectorAction } from "../../src/inspectors/actions.ts";
import { bindingPath, readTmuxInspectorBinding, readTmuxInspectorBindingForTarget } from "../../src/inspectors/tmux/actions.ts";
import { createTmuxClient } from "../../src/inspectors/tmux/client.ts";
import { createTmuxInspectorPlugin } from "../../src/inspectors/tmux/plugin.ts";
import type { TmuxClient } from "../../src/inspectors/tmux/client.ts";
import type { InspectorContext, InspectorLaunch, InspectorParams, InspectorPlugin } from "../../src/inspectors/types.ts";

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

/** A key matches a command when it equals the command or leads its words; the longest match wins. */
function queueKey(queue: Record<string, string[]>, args: string[]): string {
	const command = args.join(" ");
	const matches = Object.keys(queue).filter((key) => command === key || command.startsWith(`${key} `));
	return matches.sort((a, b) => b.length - a.length)[0] ?? args[0] ?? "";
}

/** Scripted tmux client: maps a command to a queued response. "!CODE|message" entries resolve to error results. */
function fakeClient(responses: Record<string, string[]>, commands: string[] = []): TmuxClient {
	const queue = Object.fromEntries(Object.entries(responses).map(([key, value]) => [key, [...value]]));
	return {
		run: async (args) => {
			commands.push(args.join(" "));
			const key = queueKey(queue, args);
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

/** A host plugin without float support; each open call is recorded in opens. */
function splitOnlyPlugin(opens: string[]): InspectorPlugin {
	return {
		name: "split-only",
		available: () => true,
		owns: () => false,
		open: async () => {
			opens.push("split-only");
			return { content: [{ type: "text", text: "split-only opened" }], details: { mode: "management", results: [] } };
		},
	};
}

/** Dispatches inspector.open for the run in asyncDir through the given plugins. */
function openRun(root: string, asyncDir: string, env: NodeJS.ProcessEnv, plugins: readonly InspectorPlugin[], params: InspectorParams = {}) {
	return handleInspectorAction("inspector.open", { dir: asyncDir, ...params }, { cwd: root, asyncDirRoot: root, env, plugins });
}

describe("tmux inspector float dispatch", () => {
	it("skips an available plugin without supportsFloat and opens the tmux plugin for float", async () => {
		const { root, asyncDir } = runRoot();
		const opens: string[] = [];
		const commands: string[] = [];
		const tmux = createTmuxInspectorPlugin({ platform: "darwin", client: fakeClient(floatResponses("100 30"), commands) });
		const response = await openRun(root, asyncDir, FLOAT_ENV, [splitOnlyPlugin(opens), tmux], { layout: "float" });
		assert.ok(!response.isError, String(response.content[0].text));
		assert.deepEqual(opens, []);
		assert.ok(commands.some((command) => command.startsWith("new-pane")));
		assert.equal(readTmuxInspectorBinding(asyncDir)?.paneId, "%6");
	});

	it("returns the float error and calls no plugin open when no plugin supports float", async () => {
		const { root, asyncDir } = runRoot();
		const opens: string[] = [];
		const response = await openRun(root, asyncDir, FLOAT_ENV, [splitOnlyPlugin(opens)], { layout: "float" });
		assert.ok(response.isError);
		assert.match(String(response.content[0].text), /No inspector plugin is available for layout float/);
		assert.deepEqual(opens, []);
	});

	it("keeps split opening the first available plugin when layout is omitted", async () => {
		const { root, asyncDir } = runRoot();
		const opens: string[] = [];
		const commands: string[] = [];
		const tmux = createTmuxInspectorPlugin({ platform: "darwin", client: fakeClient({}, commands) });
		const response = await openRun(root, asyncDir, FLOAT_ENV, [splitOnlyPlugin(opens), tmux]);
		assert.ok(!response.isError, String(response.content[0].text));
		assert.deepEqual(opens, ["split-only"]);
		assert.deepEqual(commands, []);
	});

	it("float without TMUX_PANE returns an error and opens no pane", async () => {
		const { root, asyncDir } = runRoot();
		const commands: string[] = [];
		const tmux = createTmuxInspectorPlugin({ platform: "darwin", client: fakeClient({ "-V": ["tmux 3.7c"] }, commands) });
		const response = await openRun(root, asyncDir, { TMUX: "1" }, [tmux], { layout: "float" });
		assert.ok(response.isError);
		assert.match(String(response.content[0].text), /TMUX_PANE/);
		assert.deepEqual(commands, ["-V"]);
		assert.equal(readTmuxInspectorBinding(asyncDir), undefined);
	});

	it("reports supportsFloat on the tmux plugin", () => {
		assert.equal(createTmuxInspectorPlugin({ platform: "darwin" }).supportsFloat, true);
	});
});

/** A host plugin that owns the run and does not support float; its open calls are recorded in opens. */
function owningPlugin(opens: string[]): InspectorPlugin {
	return { ...splitOnlyPlugin(opens), owns: () => true };
}

/** The layout the binding file records. */
function bindingLayout(asyncDir: string): unknown {
	return (JSON.parse(fs.readFileSync(bindingPath(asyncDir), "utf8")) as { layout?: unknown }).layout;
}

/** Commands that create, select, stamp or kill a pane. A refusal must issue none of them. */
function paneChanges(commands: string[]): string[] {
	return commands.filter((command) => /^(split-window|new-pane|select-pane|set-option|kill-pane)/.test(command));
}

describe("tmux inspector layout review regressions", () => {
	it("records the confirmed layout in the binding", async () => {
		const splitRoot = tempRoot();
		const split = await createTmuxInspectorPlugin({ platform: "darwin", client: fakeClient({
			"-V": ["tmux 3.7c"],
			"display-message": ["%5", "69556"],
			"split-window": ["%6"],
			"select-pane": [""],
			"set-option": [""],
		}) }).open(ctx(splitRoot, { TMUX: "1" }), launch(), {});
		assert.ok(!split.isError, String(split.content[0].text));
		assert.equal(bindingLayout(splitRoot), "split");

		const floatRoot = tempRoot();
		const float = await createTmuxInspectorPlugin({ platform: "darwin", client: fakeClient(floatResponses("100 30")) }).open(ctx(floatRoot, FLOAT_ENV), launch(), { layout: "float" });
		assert.ok(!float.isError, String(float.content[0].text));
		assert.equal(bindingLayout(floatRoot), "float");
	});

	it("reuses a live float binding for a float request", async () => {
		const root = boundRoot({ layout: "float" });
		const commands: string[] = [];
		const plugin = createTmuxInspectorPlugin({ platform: "darwin", client: fakeClient(floatResponses("100 30", { "list-panes": ["%6|pi-subagents:run-1:-|69556"] }), commands) });
		const response = await plugin.open(ctx(root, FLOAT_ENV), launch(), { layout: "float" });
		assert.match(String(response.content[0].text), /already open/);
		assert.deepEqual(paneChanges(commands), []);
	});

	it("reuses a live legacy binding without a layout field for a split request", async () => {
		const root = boundRoot();
		const commands: string[] = [];
		const plugin = createTmuxInspectorPlugin({ platform: "darwin", client: fakeClient({ "-V": ["tmux 3.7c"], "list-panes": ["%6|pi-subagents:run-1:-|69556"] }, commands) });
		const response = await plugin.open(ctx(root, { TMUX: "1" }), launch(), { layout: "split" });
		assert.match(String(response.content[0].text), /already open/);
		assert.deepEqual(paneChanges(commands), []);
	});

	it("refuses a live float binding for a default split request and changes no pane", async () => {
		const root = boundRoot({ layout: "float" });
		const commands: string[] = [];
		const plugin = createTmuxInspectorPlugin({ platform: "darwin", client: fakeClient({ "-V": ["tmux 3.7c"], "list-panes": ["%6|pi-subagents:run-1:-|69556"] }, commands) });
		const response = await plugin.open(ctx(root, { TMUX: "1" }), launch(), {});
		assert.ok(response.isError);
		assert.match(String(response.content[0].text), /close/);
		assert.deepEqual(paneChanges(commands), []);
		assert.equal(readTmuxInspectorBinding(root)?.paneId, "%6");
	});

	it("refuses a live legacy split binding for a float request and changes no pane", async () => {
		const root = boundRoot();
		const commands: string[] = [];
		const plugin = createTmuxInspectorPlugin({ platform: "darwin", client: fakeClient(floatResponses("100 30", { "list-panes": ["%6|pi-subagents:run-1:-|69556"] }), commands) });
		const response = await plugin.open(ctx(root, FLOAT_ENV), launch(), { layout: "float" });
		assert.ok(response.isError);
		assert.match(String(response.content[0].text), /close/);
		assert.deepEqual(paneChanges(commands), []);
		assert.equal(readTmuxInspectorBinding(root)?.paneId, "%6");
	});

	it("float refuses when another plugin owns the target and opens no pane", async () => {
		const { root, asyncDir } = runRoot();
		const opens: string[] = [];
		const commands: string[] = [];
		const tmux = createTmuxInspectorPlugin({ platform: "darwin", client: fakeClient(floatResponses("100 30"), commands) });
		const response = await openRun(root, asyncDir, FLOAT_ENV, [owningPlugin(opens), tmux], { layout: "float" });
		assert.ok(response.isError);
		assert.match(String(response.content[0].text), /close/);
		assert.deepEqual(opens, []);
		assert.deepEqual(paneChanges(commands), []);
	});

	it("split still opens the first available plugin when another plugin owns the target", async () => {
		const { root, asyncDir } = runRoot();
		const opens: string[] = [];
		const tmux = createTmuxInspectorPlugin({ platform: "darwin", client: fakeClient({}) });
		const response = await openRun(root, asyncDir, FLOAT_ENV, [owningPlugin(opens), tmux]);
		assert.ok(!response.isError, String(response.content[0].text));
		assert.deepEqual(opens, ["split-only"]);
	});

	it("float restores focus to the active pane of the target window, not the client pane", async () => {
		const root = tempRoot();
		const commands: string[] = [];
		const plugin = createTmuxInspectorPlugin({ platform: "darwin", client: fakeClient(floatResponses("100 30", {
			"list-panes -t %5 -F #{pane_active} #{pane_id}": ["0 %5\n1 %7"],
			"display-message -p #{pane_id}": ["%9"],
		}), commands) });
		const response = await plugin.open(ctx(root, FLOAT_ENV), launch(), { layout: "float" });
		assert.ok(!response.isError, String(response.content[0].text));
		assert.ok(commands.includes("list-panes -t %5 -F #{pane_active} #{pane_id}"));
		assert.ok(commands.includes("select-pane -t %7"));
		assert.ok(!commands.includes("select-pane -t %9"));
		assert.ok(!commands.includes("display-message -p #{pane_id}"));
	});

	it("float aborted during new-pane keeps the pane id, kills that pane, and writes no binding", async () => {
		const root = tempRoot();
		const commands: string[] = [];
		const controller = new AbortController();
		const newPaneCalls: Array<{ signal?: AbortSignal; timeoutMs?: number }> = [];
		const inner = fakeClient(floatResponses("100 30", { "kill-pane": [""] }), commands);
		// Models the real client: a call with an aborted signal settles as TIMEOUT, even when tmux creates the pane.
		const client: TmuxClient = {
			run: async (args, options) => {
				if (args[0] !== "new-pane") return inner.run(args, options);
				commands.push(args.join(" "));
				newPaneCalls.push({ signal: options?.signal, timeoutMs: options?.timeoutMs });
				controller.abort();
				if (options?.signal) return { ok: false, error: { code: "TIMEOUT", message: "tmux command 'new-pane' was aborted." } };
				return { ok: true, data: "%6" };
			},
		};
		const plugin = createTmuxInspectorPlugin({ platform: "darwin", client });
		const response = await plugin.open({ ...ctx(root, FLOAT_ENV), signal: controller.signal }, launch(), { layout: "float" });
		assert.ok(response.isError);
		assert.match(String(response.content[0].text), /aborted/);
		assert.equal(newPaneCalls.length, 1);
		assert.equal(newPaneCalls[0]?.signal, undefined, "new-pane must not take the abort signal");
		assert.equal(newPaneCalls[0]?.timeoutMs, 15_000);
		assert.ok(commands.includes("kill-pane -t %6"));
		assert.ok(!commands.some((command) => command.startsWith("set-option")));
		assert.equal(readTmuxInspectorBinding(root), undefined);
	});

	it("float aborted before new-pane starts creates no pane", async () => {
		const root = tempRoot();
		const commands: string[] = [];
		const controller = new AbortController();
		const inner = fakeClient(floatResponses("100 30"), commands);
		// The abort lands during the window size probe, before any pane creation is attempted.
		const client: TmuxClient = {
			run: (args, options) => {
				if (args.join(" ").includes("#{window_width}")) controller.abort();
				return inner.run(args, options);
			},
		};
		const plugin = createTmuxInspectorPlugin({ platform: "darwin", client });
		const response = await plugin.open({ ...ctx(root, FLOAT_ENV), signal: controller.signal }, launch(), { layout: "float" });
		assert.ok(response.isError);
		assert.ok(!commands.some((command) => command.startsWith("new-pane")));
		assert.equal(readTmuxInspectorBinding(root), undefined);
	});

	it("float names the geometry requirement when tmux cannot list new-pane usage", async () => {
		const root = tempRoot();
		const commands: string[] = [];
		const plugin = createTmuxInspectorPlugin({ platform: "darwin", client: fakeClient(floatResponses("100 30", { "list-commands": ["!TMUX_ERROR|unknown command: new-pane"] }), commands) });
		const response = await plugin.open(ctx(root, FLOAT_ENV), launch(), { layout: "float" });
		assert.ok(response.isError);
		const text = String(response.content[0].text);
		assert.match(text, /layout float/);
		assert.match(text, /geometry/);
		assert.match(text, /unknown command: new-pane/);
		assert.deepEqual(paneChanges(commands), []);
		assert.equal(readTmuxInspectorBinding(root), undefined);
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

// Captured from tmux 3.7c: `tmux list-commands new-pane` lists the native geometry flags.
const NEW_PANE_WITH_GEOMETRY = "new-pane (newp) [-bdefhIklPvZ] [-c start-directory] [-e environment] [-F format] [-l size] [-m message] [-p percentage] [-s style] [-S active-border-style] [-R inactive-border-style] [-x width] [-y height] [-X x-position] [-Y y-position] [-t target-pane] [shell-command [argument ...]]";
/** The same usage line without the four geometry flags. */
const NEW_PANE_WITHOUT_GEOMETRY = "new-pane (newp) [-bdefhIklPvZ] [-c start-directory] [-e environment] [-F format] [-l size] [-m message] [-p percentage] [-s style] [-S active-border-style] [-R inactive-border-style] [-t target-pane] [shell-command [argument ...]]";
const FLOAT_ENV = { TMUX: "1", TMUX_PANE: "%5" };

/** The value after a flag in a command line: flagValue("new-pane -x 80", "-x") is "80". */
function flagValue(command: string, flag: string): string | undefined {
	const words = command.split(" ");
	const index = words.indexOf(flag);
	return index === -1 ? undefined : words[index + 1];
}

/** Responses for a float open. The window size arrives as "width height". */
function floatResponses(windowSize: string, overrides: Record<string, string[]> = {}): Record<string, string[]> {
	return {
		"-V": ["tmux 3.7c"],
		"list-commands": [NEW_PANE_WITH_GEOMETRY],
		"display-message -p -t %5": [windowSize],
		"list-panes -t %5 -F #{pane_active} #{pane_id}": ["1 %5"],
		"display-message -p #{pane_id}": ["%5"],
		"new-pane": ["%6"],
		"select-pane": [""],
		"set-option": [""],
		"display-message -p #{pid}": ["69556"],
		...overrides,
	};
}

/** A temp root holding one running async run, run-1, so inspector actions resolve it by directory. */
function runRoot(): { root: string; asyncDir: string } {
	const root = tempRoot();
	const asyncDir = path.join(root, "run-1");
	fs.mkdirSync(asyncDir);
	fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
		runId: "run-1", mode: "single", state: "running", cwd: root, steps: [{ agent: "worker", status: "running" }],
	}));
	return { root, asyncDir };
}

describe("tmux inspector layout", () => {
	it("keeps split-window when layout is omitted", async () => {
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
		const response = await plugin.open(ctx(root, { TMUX: "1" }), launch(), {});
		assert.ok(!response.isError, String(response.content[0].text));
		assert.ok(commands.some((command) => command.startsWith("split-window -h")));
		assert.ok(!commands.some((command) => command.startsWith("list-commands") || command.startsWith("new-pane")));
		assert.equal(readTmuxInspectorBinding(root)?.paneId, "%6");
	});

	it("keeps split-window when layout is split", async () => {
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
		const response = await plugin.open(ctx(root, { TMUX: "1" }), launch(), { layout: "split" });
		assert.ok(!response.isError, String(response.content[0].text));
		assert.ok(commands.some((command) => command.startsWith("split-window -h")));
		assert.ok(!commands.some((command) => command.startsWith("list-commands") || command.startsWith("new-pane")));
		assert.equal(readTmuxInspectorBinding(root)?.paneId, "%6");
	});

	it("float reports TMUX_UNAVAILABLE when the tmux binary is missing", async () => {
		const root = tempRoot();
		const commands: string[] = [];
		const client = fakeClient({ "-V": ["!TMUX_UNAVAILABLE|tmux is not installed or is not on PATH."] }, commands);
		const plugin = createTmuxInspectorPlugin({ platform: "darwin", client });
		const response = await plugin.open(ctx(root, FLOAT_ENV), launch(), { layout: "float" });
		assert.ok(response.isError);
		assert.match(String(response.content[0].text), /TMUX_UNAVAILABLE/);
		assert.ok(!commands.some((command) => command.startsWith("new-pane") || command.startsWith("split-window")));
	});

	it("float splits a centered eighty percent pane that targets TMUX_PANE", async () => {
		const root = tempRoot();
		const commands: string[] = [];
		const plugin = createTmuxInspectorPlugin({ platform: "darwin", client: fakeClient(floatResponses("100 30"), commands) });
		const response = await plugin.open(ctx(root, FLOAT_ENV), launch(), { layout: "float" });
		assert.ok(!response.isError, String(response.content[0].text));
		const newPane = commands.find((command) => command.startsWith("new-pane")) ?? "";
		assert.ok(newPane, "float must create its pane with new-pane");
		assert.ok(!commands.some((command) => command.startsWith("split-window")));
		assert.equal(flagValue(newPane, "-t"), "%5");
		// A 100x30 window: 80% is 80x24, centered at column 10 and row 3.
		assert.equal(flagValue(newPane, "-x"), "80");
		assert.equal(flagValue(newPane, "-y"), "24");
		assert.equal(flagValue(newPane, "-X"), "10");
		assert.equal(flagValue(newPane, "-Y"), "3");
		assert.equal(readTmuxInspectorBinding(root)?.paneId, "%6");
	});

	it("float caps the pane at 120 columns and 40 rows", async () => {
		const root = tempRoot();
		const commands: string[] = [];
		const plugin = createTmuxInspectorPlugin({ platform: "darwin", client: fakeClient(floatResponses("200 60"), commands) });
		const response = await plugin.open(ctx(root, FLOAT_ENV), launch(), { layout: "float" });
		assert.ok(!response.isError, String(response.content[0].text));
		const newPane = commands.find((command) => command.startsWith("new-pane")) ?? "";
		// A 200x60 window: 80% would be 160x48, so the caps give 120x40 at column 40 and row 10.
		assert.equal(flagValue(newPane, "-x"), "120");
		assert.equal(flagValue(newPane, "-y"), "40");
		assert.equal(flagValue(newPane, "-X"), "40");
		assert.equal(flagValue(newPane, "-Y"), "10");
	});

	it("float refocuses the original pane when focus is not requested", async () => {
		const root = tempRoot();
		const commands: string[] = [];
		const plugin = createTmuxInspectorPlugin({ platform: "darwin", client: fakeClient(floatResponses("100 30"), commands) });
		const response = await plugin.open(ctx(root, FLOAT_ENV), launch(), { layout: "float" });
		assert.ok(!response.isError, String(response.content[0].text));
		assert.ok(commands.includes("select-pane -t %5"));
	});

	it("float leaves the new pane focused when focus is requested", async () => {
		const root = tempRoot();
		const commands: string[] = [];
		const plugin = createTmuxInspectorPlugin({ platform: "darwin", client: fakeClient(floatResponses("100 30"), commands) });
		const response = await plugin.open(ctx(root, FLOAT_ENV), launch(), { layout: "float", focus: true });
		assert.ok(!response.isError, String(response.content[0].text));
		assert.ok(!commands.some((command) => command.startsWith("select-pane")));
		assert.ok(!commands.some((command) => command.startsWith("display-message -p #{pane_id}")));
	});

	it("float fails closed without a pane when tmux lacks new-pane geometry flags", async () => {
		const root = tempRoot();
		const commands: string[] = [];
		const client = fakeClient(floatResponses("100 30", { "list-commands": [NEW_PANE_WITHOUT_GEOMETRY] }), commands);
		const plugin = createTmuxInspectorPlugin({ platform: "darwin", client });
		const response = await plugin.open(ctx(root, FLOAT_ENV), launch(), { layout: "float" });
		assert.ok(response.isError);
		assert.match(String(response.content[0].text), /float/);
		assert.match(String(response.content[0].text), /geometry/);
		assert.ok(!commands.some((command) => command.startsWith("new-pane") || command.startsWith("split-window")));
		assert.equal(readTmuxInspectorBinding(root), undefined);
	});

	it("float cancelled after the new pane exists kills that pane and writes no binding", async () => {
		const root = tempRoot();
		const commands: string[] = [];
		const controller = new AbortController();
		const inner = fakeClient(floatResponses("100 30", { "kill-pane": [""] }), commands);
		const client: TmuxClient = {
			run: (args, options) => {
				// The abort lands while tmux creates the pane, the window where an orphan pane can appear.
				if (args[0] === "new-pane") controller.abort();
				return inner.run(args, options);
			},
		};
		const plugin = createTmuxInspectorPlugin({ platform: "darwin", client });
		const response = await plugin.open({ ...ctx(root, FLOAT_ENV), signal: controller.signal }, launch(), { layout: "float" });
		assert.ok(response.isError);
		assert.match(String(response.content[0].text), /aborted/);
		assert.ok(commands.includes("kill-pane -t %6"));
		assert.ok(!commands.some((command) => command.startsWith("set-option")));
		assert.ok(commands.filter((command) => command.startsWith("kill-")).every((command) => command === "kill-pane -t %6"));
		assert.equal(readTmuxInspectorBinding(root), undefined);
	});

	it("inspector.open with layout float reaches the tmux plugin and writes its binding", async () => {
		const { root, asyncDir } = runRoot();
		const commands: string[] = [];
		const response = await handleInspectorAction("inspector.open", { dir: asyncDir, layout: "float" }, {
			cwd: root,
			asyncDirRoot: root,
			env: FLOAT_ENV,
			plugins: [createTmuxInspectorPlugin({ platform: "darwin", client: fakeClient(floatResponses("100 30"), commands) })],
		});
		assert.ok(!response.isError, String(response.content[0].text));
		assert.ok(commands.some((command) => command.startsWith("new-pane")));
		assert.ok(!commands.some((command) => command.startsWith("split-window")));
		assert.equal(readTmuxInspectorBinding(asyncDir)?.paneId, "%6");
	});

	it("inspector.open with layout float outside tmux opens no pane", async () => {
		const { root, asyncDir } = runRoot();
		const commands: string[] = [];
		const response = await handleInspectorAction("inspector.open", { dir: asyncDir, layout: "float" }, {
			cwd: root,
			asyncDirRoot: root,
			env: {},
			plugins: [createTmuxInspectorPlugin({ platform: "darwin", client: fakeClient({}, commands) })],
		});
		assert.ok(response.isError);
		assert.match(String(response.content[0].text), /No inspector plugin is available/);
		assert.deepEqual(commands, []);
	});
});
