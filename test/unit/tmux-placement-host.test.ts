import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { resolveMachinePlacement } from "../../src/runs/shared/herdr-machine.ts";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { registerPlacementAdapter, registerPlacementEventListener, type PlacementAdapterV1 } from "../../src/api/placement.ts";
import { localMachineAccess } from "../../src/runs/shared/local-machine-access.ts";
import { closeOwnedTmuxPane, connectTmux, TmuxPlacedRunOwner, tmuxPaneHost } from "../../packages/tmux-placement-adapter/src/tmux-pane-host.ts";
import { resolveTmuxMachinePlacement } from "../../packages/tmux-placement-adapter/src/tmux-machine.ts";
import type { ChildSession } from "../../src/runs/shared/child-session.ts";

const child: ChildSession = { subscribe: () => () => {}, prompt: async () => {}, steer: async () => {}, followUp: async () => {}, abort: async () => {}, dispose: async () => {}, messages: [], sessionFile: undefined, sessionId: "native", modelId: "provider/model" };

// A fake `tmux` on disk: it logs its argv and its TMUX/TMUX_PANE selectors, prints <kind>.out when present,
// and exits with the next scripted code for each command kind. Defaults cover the common green paths so
// each test only scripts the branch it exercises.
const FAKE_TMUX = `#!/bin/sh
d="$FAKE_TMUX_DIR"; printf '%s\\n' "$*" >> "$d/calls"
printf '%s\\n' "\${TMUX:-unset} \${TMUX_PANE:-unset}" >> "$d/selectors"
case "$*" in
  has-session\\ *|*" has-session "*) key=has;;
  new-session\\ *|*" new-session "*) key=newsession;;
  new-window\\ *|*" new-window "*) key=window;;
  set-window-option\\ *|*" set-window-option "*) key=setwopt;;
  display\\ -p\\ *|*" display -p "*) key=display;;
  set-option\\ -p\\ *|*" set-option -p "*) key=setopt;;
  list-windows\\ *|*" list-windows "*) key=list;;
  kill-window\\ *|*" kill-window "*) key=killwindow;;
  kill-pane\\ *|*" kill-pane "*) key=killpane;;
  send-keys\\ *|*" send-keys "*) key=sendkeys;;
  *) key=other;;
esac
n=$(($(cat "$d/$key.n" 2>/dev/null || echo 0) + 1)); echo "$n" > "$d/$key.n"
code=$(sed -n "\${n}p" "$d/$key" 2>/dev/null); [ -n "$code" ] || code=$(tail -n 1 "$d/$key" 2>/dev/null); [ -n "$code" ] || code=0
t=$(printf '%s\\n' "$*" | sed -n 's/.* -t \\([^ ]*\\).*/\\1/p')
if [ -f "$d/$key.out" ]; then cat "$d/$key.out"
elif [ "$key" = window ] && [ "$code" = 0 ]; then printf '%%%s\\n' "$n"
elif [ "$key" = display ] && [ "$code" = 0 ]; then printf '%s|%s|%s|\\n' "$t" "\${FAKE_TMUX_PANE_PID:-700}" "\${FAKE_TMUX_SERVER_PID:-400}"
fi
[ "$code" = 0 ] || echo "can't find pane $t" >&2
exit "$code"
`;
const session = "pi-subagents";
const machine = { provider: "tmux", id: "local", target: "local", session, cwd: "/tmp" };
const runId = "run_0123456789abcdef";
const label = `subagent-${runId.slice(-8)}`;
function withEnv(values: Record<string, string>): () => void {
	const previous = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]));
	Object.assign(process.env, values);
	return () => { for (const [name, value] of Object.entries(previous)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } };
}

describe("Tmux pane host", { skip: process.platform === "win32" }, () => {
	let dir: string, bin: string;
	const script = (key: string, codes: number[]) => fs.writeFileSync(path.join(dir, key), `${codes.join("\n")}\n`);
	const calls = () => fs.readFileSync(path.join(dir, "calls"), "utf8").trim().split("\n");
	const connect = () => connectTmux(machine, { bin, access: localMachineAccess({ env: { FAKE_TMUX_DIR: dir } }) });
	beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-tmux-")); bin = path.join(dir, "tmux"); fs.writeFileSync(bin, FAKE_TMUX, { mode: 0o755 }); });
	afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

	it("confirms the recorded session before use and creates the pi-subagents session once", async () => {
		await connect();
		assert.deepEqual(calls(), ["has-session -t pi-subagents"]);
		script("has", [1]);
		await connect();
		assert.deepEqual(calls().slice(1), ["has-session -t pi-subagents", "new-session -d -s pi-subagents -n housekeeping -c $HOME"]);
		script("newsession", [1]);
		await assert.rejects(connect(), /new-session exited with code 1/u);
		assert.equal(calls().at(-1), "new-session -d -s pi-subagents -n housekeeping -c $HOME");
	});

	it("scrubs TMUX and TMUX_PANE so a parent living inside tmux cannot leak its server", async () => {
		await connectTmux(machine, { bin, access: localMachineAccess({ env: { FAKE_TMUX_DIR: dir, TMUX: "%9", TMUX_PANE: "%9" } }) });
		assert.equal(fs.readFileSync(path.join(dir, "selectors"), "utf8").trim(), "unset unset");
	});

	it("opens the run's window, stamps the ownership marker, and reports the owned pane", async () => {
		const connection = await connect(), restore = withEnv({ PI_SUBAGENT_PI_BINARY: "/bin/echo" });
		try {
		fs.writeFileSync(path.join(dir, "display.out"), "%1|700|400|\n");
		const onPane: Array<unknown> = [];
		const result = await tmuxPaneHost.launch(connection, machine, runId, "/tmp/unused", { kind: "pi", name: "pi", args: ["-p", "hi"], environment: { PI_TEST_MODE: "1" } }, async (owned) => { onPane.push(owned); });
		const windowCall = calls().find((call) => call.startsWith("new-window "));
		assert.match(windowCall ?? "", new RegExp(`new-window -d -t ${session}: -n ${label} -c /tmp -P -F #\\{pane_id\\} sh -c exec /usr/bin/env "\\$@" sh PI_TEST_MODE=1 /bin/echo -p hi$`, "u"));
		assert.deepEqual(calls().filter((call) => call.startsWith("set-window-option ")), [`set-window-option -t %1 automatic-rename off`]);
		assert.deepEqual(calls().filter((call) => call.startsWith("set-option -p ")), [`set-option -p -t %1 @pi-subagents-owner ${runId}:400`]);
		assert.deepEqual(onPane, [{ workspaceId: session, tabId: "%1", paneId: "%1" }]);
		assert.deepEqual(result, { owned: { workspaceId: session, tabId: "%1", paneId: "%1" }, terminalId: "%1" });
		} finally { restore(); }
	});

	it("refuses non-Pi kinds, bad environment names, and a relative Pi binary before touching the server", async () => {
		const connection = await connect();
		await assert.rejects(tmuxPaneHost.launch(connection, machine, runId, "/tmp", { kind: "claude", name: "claude", args: [] }, async () => {}), /native Pi children only/u);
		await assert.rejects(tmuxPaneHost.launch(connection, machine, runId, "/tmp", { kind: "pi", name: "pi", args: [], environment: { "BAD-NAME": "1" } }, async () => {}), /shell variable names/u);
		const restore = withEnv({ PI_SUBAGENT_PI_BINARY: "pi" });
		try { await assert.rejects(tmuxPaneHost.launch(connection, machine, runId, "/tmp", { kind: "pi", name: "pi", args: [] }, async () => {}), /absolute Pi executable/u); } finally { restore(); }
		assert.deepEqual(calls(), ["has-session -t pi-subagents"]);
	});

	it("closes the window a failed new-window may have opened, found by the run's window name", async () => {
		const connection = await connect(), restore = withEnv({ PI_SUBAGENT_PI_BINARY: "/bin/echo" });
		const listing = (...windows: Array<{ id: string; name: string }>) => fs.writeFileSync(path.join(dir, "list.out"), windows.map((window) => `${window.id}|${window.name}`).join("\n") + "\n");
		const launch = () => tmuxPaneHost.launch(connection, machine, runId, "/tmp/unused", { kind: "pi", name: "pi", args: [] }, async () => { throw new Error("onPane must not run for an unparsed window"); });
		try {
			script("window", [1]); listing({ id: "%0", name: "housekeeping" }, { id: "%9", name: label });
			await assert.rejects(launch(), /new-window exited with code 1/u);
			assert.deepEqual(calls().filter((call) => call.startsWith("kill-window ")), ["kill-window -t %9"]);

			const killCount = () => calls().filter((call) => call.startsWith("kill-window ")).length;
			fs.rmSync(path.join(dir, "list.out")); script("list", [1]);
			await assert.rejects(launch(), /new-window exited with code 1/u);
			assert.equal(killCount(), 1);

			script("list", [0]);
			listing({ id: "%0", name: label }, { id: "%9", name: label });
			let guessError: AggregateError | undefined;
			await assert.rejects(launch(), (error: Error) => { guessError = error as AggregateError; return /could not be closed/u.test(error.message); });
			assert.ok(guessError);
			assert.match(guessError.errors.map((error: unknown) => String(error)).join("\n"), /refusing to guess/u);
		} finally { restore(); }
	});

	it("closes a present pane and reports closed only once the pane is gone", async () => {
		const connection = { ...await connect(), ownerRunId: runId };
		fs.writeFileSync(path.join(dir, "display.out"), `%1|700|400|${runId}:400\n`);
		script("display", [0, 0, 1]); script("killpane", [0]);
		await closeOwnedTmuxPane(connection, { workspaceId: session, tabId: "%1", paneId: "%1" });
		const paneFormat = `display -p -t %1 -F #{pane_id}|#{pane_pid}|#{server_pid}|#{@pi-subagents-owner}`;
		assert.deepEqual(calls().slice(1), [paneFormat, paneFormat, `kill-pane -t %1`, paneFormat]);
	});

	it("treats an already-gone pane as closed without killing anything", async () => {
		const connection = { ...await connect(), ownerRunId: runId }; script("display", [1]);
		await closeOwnedTmuxPane(connection, { workspaceId: session, tabId: "%1", paneId: "%1" });
		assert.equal(calls().some((call) => call.startsWith("kill-pane ")), false);
	});

	it("refuses to report closed while the pane still exists after kill", async () => {
		const connection = { ...await connect(), ownerRunId: runId };
		fs.writeFileSync(path.join(dir, "display.out"), `%1|700|400|${runId}:400\n`);
		script("killpane", [0]);
		await assert.rejects(closeOwnedTmuxPane(connection, { workspaceId: session, tabId: "%1", paneId: "%1" }), /still exists after kill/u);
	});

	it("refuses cleanup of a pane recorded in another tmux session", async () => {
		const connection = await connect();
		await assert.rejects(closeOwnedTmuxPane(connection, { workspaceId: "other", tabId: "%1", paneId: "%1" }), /different tmux session/u);
		assert.equal(calls().length, 1);
	});

	it("refuses to close when the connection carries no run id or the marker does not match", async () => {
		const noProof = await connect();
		await assert.rejects(closeOwnedTmuxPane(noProof, { workspaceId: session, tabId: "%1", paneId: "%1" }), /carries no run id/u);
		assert.equal(calls().some((call) => call.startsWith("kill-pane ")), false);
		const mismatched = { ...await connect(), ownerRunId: "another-run" };
		fs.writeFileSync(path.join(dir, "display.out"), `%1|700|400|someone-else:400\n`);
		script("display", [0]);
		await assert.rejects(closeOwnedTmuxPane(mismatched, { workspaceId: session, tabId: "%1", paneId: "%1" }), /does not match run another-run/u);
		assert.equal(calls().some((call) => call.startsWith("kill-pane ")), false);
		const staleServer = { ...await connect(), ownerRunId: runId };
		fs.writeFileSync(path.join(dir, "display.out"), `%1|700|401|${runId}:400\n`);
		script("display", [0]);
		await assert.rejects(closeOwnedTmuxPane(staleServer, { workspaceId: session, tabId: "%1", paneId: "%1" }), /another tmux server lifetime/u);
		assert.equal(calls().some((call) => call.startsWith("kill-pane ")), false);
	});

	it("sends prompts as literal text followed by Enter", async () => {
		const connection = await connect();
		await tmuxPaneHost.prompt(connection, { runId, machineId: "local", target: "local", session, workspaceId: session, tabId: "%1", paneId: "%1", terminalId: "%1", agentName: "worker", nativeSessionId: "native-1", cwd: "/tmp", runtimeDir: "/tmp/unused" }, "do the thing");
		assert.deepEqual(calls().slice(1), ["send-keys -t %1 -l -- do the thing", "send-keys -t %1 Enter"]);
		script("sendkeys", [0, 1]);
		await assert.rejects(tmuxPaneHost.prompt(connection, { runId, machineId: "local", target: "local", session, workspaceId: session, tabId: "%1", paneId: "%1", terminalId: "%1", agentName: "worker", nativeSessionId: "native-1", cwd: "/tmp", runtimeDir: "/tmp/unused" }, "again"), /send-keys exited with code 1/u);
	});

	it("keeps the runtime dir within the socket-path limit and cleans it up", async () => {
		fs.mkdirSync(path.join(dir, ".local", "bin"), { recursive: true });
		fs.copyFileSync(bin, path.join(dir, ".local", "bin", "tmux"));
		fs.chmodSync(path.join(dir, ".local", "bin", "tmux"), 0o755);
		const owner = await TmuxPlacedRunOwner.create(machine, runId, { access: localMachineAccess({ env: { FAKE_TMUX_DIR: dir, HOME: dir } }) });
		try {
			assert.match(path.basename(owner.runtimeDir), /^pi-subagents-herdr-[0-9a-f]{12}-/u);
			assert.ok(Buffer.byteLength(path.join(owner.runtimeDir, "bridge.sock")) <= 103, owner.runtimeDir);
		} finally { await owner.cleanup(); }
		assert.equal(fs.existsSync(owner.runtimeDir), false);
	});
});

describe("tmux machine resolution", () => {
	let dir: string;
	beforeEach(() => { dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tmux-resolve-"))); fs.mkdirSync(path.join(dir, "repo")); });
	afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
	it("routes through the core adapter loop: tmux claims its names ahead of the herdr fallback", (t) => {
		const owner = { events: createEventBus() };
		const disposeListener = registerPlacementEventListener(owner);
		t.after(disposeListener);
		const registration = registerPlacementAdapter(owner, { kind: "pi-subagents.placement-adapter", version: 1, provider: "tmux", resolveMachinePlacement: resolveTmuxMachinePlacement, async createPlacedPiSession() { return child; } } satisfies PlacementAdapterV1, { before: "herdr" });
		const tmuxPlacement = resolveMachinePlacement({ machine: "teambox", cwd: dir, settings: { tmux: { ssh: "10.0.0.9" }, cwd: "~/dev" }, herdrBin: path.join(dir, "no-herdr") });
		assert.equal(tmuxPlacement.machine.provider, "tmux");
		const localPlacement = resolveMachinePlacement({ machine: "tmux", cwd: dir, herdrBin: path.join(dir, "no-herdr") });
		assert.deepEqual(localPlacement.machine, { provider: "tmux", id: "local", target: "local", session, socket: undefined, cwd: dir });
		registration.dispose();
		assert.throws(() => resolveMachinePlacement({ machine: "teambox", cwd: dir, settings: { tmux: { ssh: "10.0.0.9" }, cwd: "~/dev" }, herdrBin: path.join(dir, "no-herdr") }), /Herdr CLI .* was not found/u);
	});
	it("claims machine 'tmux' for local placement and a settings tmux.ssh entry for remote placement", () => {
		assert.deepEqual(resolveTmuxMachinePlacement({ machine: "tmux", cwd: dir, stepCwd: "repo", settings: {} }), { machine: { provider: "tmux", id: "local", target: "local", session, socket: undefined, cwd: path.join(dir, "repo") } });
		assert.deepEqual(resolveTmuxMachinePlacement({ machine: "teambox", cwd: dir, stepCwd: "packages/api", settings: { tmux: { ssh: "10.0.0.9", socket: "/tmp/tmux-0" }, cwd: "~/dev" } }), { machine: { provider: "tmux", id: "teambox", target: "10.0.0.9", session, socket: "/tmp/tmux-0", cwd: "~/dev/packages/api" } });
		assert.equal(resolveTmuxMachinePlacement({ machine: "teambox", cwd: dir, settings: {} }), undefined);
		assert.throws(() => resolveTmuxMachinePlacement({ machine: "tmux", cwd: dir, settings: { tmux: { ssh: "10.0.0.9" } } }), /reserved for local tmux placement/u);
	});
});
