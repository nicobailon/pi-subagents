import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import registerHerdrPiBridge from "../../src/extension/herdr-pi-bridge.ts";
import type { ChildSessionLaunch } from "../../src/runs/shared/child-session.ts";
import { resolveMachinePlacement } from "../../src/runs/shared/herdr-machine.ts";
import { HerdrPlacedRunOwner } from "../../src/runs/shared/herdr-pane-host.ts";
import { HERDR_PI_MODE_ENV, HERDR_PI_RUN_ENV, HERDR_PI_RUNTIME_DIR_ENV } from "../../src/runs/shared/herdr-pi-protocol.ts";
import { createHerdrPiSession, HerdrPiSession } from "../../src/runs/shared/herdr-placed-run.ts";
import { withHerdrPaneAllocationLock } from "../../src/runs/shared/placement-host.ts";
import type { HerdrLocalMachineReference } from "../../src/shared/types.ts";

// A fake `herdr`: records its argv and Herdr selectors, reports the server at $HERDR_SOCKET_PATH (or $FAKE_HERDR_REPORT) with
// the session HERDR_SESSION names (as herdr 0.9.5 does), and knows one pane, w1:p1.
const FAKE_HERDR = `#!/bin/sh
d="$FAKE_HERDR_DIR"; printf '%s\\n' "$*" >> "$d/herdr-calls"
printf '%s\\n' "\${HERDR_SOCKET_PATH:-unset} \${HERDR_SESSION:-unset} \${HERDR_PANE_ID:-unset} \${HERDR_ENV:-unset} \${HERDR_CLIENT_SOCKET_PATH:-unset}" >> "$d/herdr-env"
case "$1 $2" in
  "status server")
    s="\${FAKE_HERDR_REPORT_SESSION:-\${HERDR_SESSION:-}}"; if [ -n "$s" ]; then s="\\"$s\\""; else s=null; fi
    printf '{"socket":"%s","session":%s,"version":"0.9.5","protocol":22,"running":true,"compatible":true}' "\${FAKE_HERDR_REPORT:-$HERDR_SOCKET_PATH}" "$s";;
  "pane get")
    if [ "$3" = w1:p1 ]; then printf '{"id":"cli:pane:get","result":{"type":"pane_info","pane":{"pane_id":"%s"}}}' "$3"; else echo "pane not found" >&2; exit 1; fi;;
  *) echo "unexpected herdr $*" >&2; exit 9;;
esac
`;

function withEnv(values: Record<string, string>): () => void {
	const previous = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]));
	Object.assign(process.env, values);
	return () => { for (const [name, value] of Object.entries(previous)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } };
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const RESULTS: Record<string, unknown> = {
	"session.snapshot": { type: "session_snapshot", snapshot: { panes: [], workspaces: [], agents: [] } },
	"workspace.create": { type: "workspace_created", workspace: { workspace_id: "w1" }, tab: { tab_id: "t1" }, root_pane: { pane_id: "p1" } },
	"agent.start": { type: "agent_started", agent: { terminal_id: "term1", pane_id: "p1" } },
	"agent.get": { type: "agent_info", agent: { terminal_id: "term1", pane_id: "p1" } },
	"pane.close": {},
};
const runtime = { runId: "run", agent: "worker", childIndex: 0, fanoutChild: false, depth: 1, maxDepth: 1, inheritProjectContext: true, inheritGlobalContext: true, inheritSkills: false, fast: false, waitTool: { enabled: true } };

describe("Herdr placement on this machine (machine 'local' in Herdr)", { skip: process.platform === "win32" }, () => {
	let dir: string, socket: string, server: net.Server, requests: Array<{ method: string; params: Record<string, unknown> }>, restore: () => void, onAgentStart: ((created: Record<string, unknown>) => void) | undefined;
	const subscriptions: net.Socket[] = [];
	const runtimeDirs = (runId: string) => fs.readdirSync("/tmp").filter((name) => name.startsWith(`pi-subagents-herdr-${createHash("sha256").update(runId).digest("hex").slice(0, 12)}-`));
	beforeEach(async () => {
		dir = fs.realpathSync(fs.mkdtempSync(path.join("/tmp", "hl-"))); socket = path.join(dir, "h.sock"); requests = []; onAgentStart = undefined;
		fs.mkdirSync(path.join(dir, "bin")); fs.mkdirSync(path.join(dir, "repo"));
		fs.writeFileSync(path.join(dir, "herdr"), FAKE_HERDR, { mode: 0o755 });
		fs.writeFileSync(path.join(dir, "bin", "ssh"), `#!/bin/sh\ntouch "$FAKE_HERDR_DIR/ssh-called"\nexit 99\n`, { mode: 0o755 });
		server = net.createServer((connection) => { let buffer = ""; connection.on("data", (chunk) => {
			buffer += chunk; const newline = buffer.indexOf("\n"); if (newline < 0) return;
			const request = JSON.parse(buffer.slice(0, newline)) as { id: string; method: string; params: Record<string, unknown> }; requests.push(request);
			if (request.method === "events.subscribe") { subscriptions.push(connection); connection.write(`${JSON.stringify({ id: request.id, result: { type: "subscription_started" } })}\n`); return; }
			if (request.method === "agent.start") onAgentStart?.(requests.find((item) => item.method === "workspace.create")!.params);
			connection.end(`${JSON.stringify({ id: request.id, result: RESULTS[request.method] })}\n`);
		}); });
		await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socket, resolve); });
		// Decoy selectors from the calling process's own pane must never pick the server.
		restore = withEnv({ HERDR_BIN: path.join(dir, "herdr"), FAKE_HERDR_DIR: dir, PATH: `${path.join(dir, "bin")}:${process.env.PATH ?? ""}`, HERDR_SOCKET_PATH: "/tmp/decoy.sock", HERDR_SESSION: "decoy", HERDR_PANE_ID: "decoy-pane", HERDR_ENV: "1", HERDR_CLIENT_SOCKET_PATH: "/tmp/decoy-client.sock" });
	});
	afterEach(async () => { restore(); for (const connection of subscriptions.splice(0)) connection.destroy(); await new Promise((resolve) => server.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }); });

	it("opens and closes a pane in the recorded local server over its socket, with a /tmp runtime dir, its own allocation lock and no SSH", async () => {
		const runId = `${"l".repeat(48)}_0123456789abcdef`, machine: HerdrLocalMachineReference = { provider: "herdr", id: "local", socket, cwd: dir };
		const owner = await HerdrPlacedRunOwner.create(machine, runId), runtimeDir = owner.runtimeDir;
		try {
			assert.match(runtimeDir, /^\/tmp\/pi-subagents-herdr-[0-9a-f]{12}-/u);
			assert.ok(Buffer.byteLength(path.join(runtimeDir, "bridge.sock")) <= 103);
			assert.ok(fs.statSync(runtimeDir).isDirectory());
			// Pane allocation on this server and directory waits for whoever holds ["local", socket, session, cwd].
			let release!: () => void, entered!: () => void; const held = new Promise<void>((resolve) => { release = resolve; }), inLock = new Promise<void>((resolve) => { entered = resolve; });
			const holder = withHerdrPaneAllocationLock(JSON.stringify(["local", socket, null, dir]), async () => { entered(); await held; });
			await inLock;
			const launching = owner.launch({ kind: "pi", name: "pi-local", args: [], environment: { PI_SUBAGENTS_HERDR_RUN_ID: runId } }, async () => {});
			await sleep(200);
			assert.equal(requests.length, 0, "allocation waits for the holder of this server's lock");
			release(); await holder;
			const { owned, terminalId } = await launching;
			assert.deepEqual({ owned, terminalId }, { owned: { workspaceId: "w1", tabId: "t1", paneId: "p1" }, terminalId: "term1" });
			const created = requests.find((request) => request.method === "workspace.create");
			assert.equal(created?.params.cwd, dir);
			assert.equal(created?.params.focus, false);
		} finally { await owner.cleanup(); }
		assert.deepEqual(requests.filter((request) => request.method === "pane.close").map((request) => request.params.pane_id), ["p1"]);
		assert.equal(fs.existsSync(runtimeDir), false);
		assert.equal(fs.existsSync(path.join(dir, "ssh-called")), false);
		assert.deepEqual(fs.readFileSync(path.join(dir, "herdr-calls"), "utf8").trim().split("\n"), ["status server --json"]);
		assert.equal(fs.readFileSync(path.join(dir, "herdr-env"), "utf8").trim(), `${socket} unset unset unset unset`);
	});

	it("names a recorded session to herdr, and refuses a server whose socket or session is not the recorded one", async () => {
		const runId = "run_local_mismatch_0123456789";
		const named = await HerdrPlacedRunOwner.create({ provider: "herdr", id: "local", socket, session: "work", cwd: dir }, runId);
		await named.cleanup();
		assert.equal(fs.readFileSync(path.join(dir, "herdr-env"), "utf8").trim(), `${socket} work unset unset unset`);
		const reportOther = withEnv({ FAKE_HERDR_REPORT: "/tmp/other-herdr.sock" });
		try { await assert.rejects(HerdrPlacedRunOwner.create({ provider: "herdr", id: "local", socket, cwd: dir }, runId), /Local Herdr server identity mismatch: expected socket/u); } finally { reportOther(); }
		const reportOtherSession = withEnv({ FAKE_HERDR_REPORT_SESSION: "other" });
		try { await assert.rejects(HerdrPlacedRunOwner.create({ provider: "herdr", id: "local", socket, session: "work", cwd: dir }, runId), /session identity mismatch: expected work, received other/u); } finally { reportOtherSession(); }
		assert.deepEqual(runtimeDirs(runId), []);
		assert.equal(requests.length, 0);
	});

	it("places a native Pi child through the local server and its bridge, recorded as machine 'local'", async () => {
		// The bridge runs in this process, so the pane's directory is this process's directory.
		const cwd = process.cwd(), machine: HerdrLocalMachineReference = { provider: "herdr", id: "local", socket, cwd };
		const handlers = new Map<string, Function>(), pi = { registerTool() {}, registerCommand() {}, on(name: string, handler: Function) { handlers.set(name, handler); }, getActiveTools: () => ["read"], setActiveTools() {} };
		let restorePane = () => {};
		onAgentStart = (created) => {
			const env = created.env as Record<string, string>;
			restorePane = withEnv({ [HERDR_PI_MODE_ENV]: env[HERDR_PI_MODE_ENV]!, [HERDR_PI_RUN_ENV]: env[HERDR_PI_RUN_ENV]!, [HERDR_PI_RUNTIME_DIR_ENV]: env[HERDR_PI_RUNTIME_DIR_ENV]! });
			registerHerdrPiBridge(pi as never);
			handlers.get("session_start")?.({}, { sessionManager: { getSessionId: () => "native", getSessionFile: () => "/local/session" }, model: { provider: "p", id: "m" }, isIdle: () => true, hasPendingMessages: () => false });
		};
		const launch: ChildSessionLaunch = { cwd, machine, remoteResources: { agent: "worker", toolCeiling: ["read"] }, storage: { kind: "memory" }, extensionPaths: [], ambientExtensions: true, hooks: [], noSkills: true, noContextFiles: true, tools: ["read"], runtime: { ...runtime, runId: "run_herdrlocal01" } };
		let child: Awaited<ReturnType<typeof createHerdrPiSession>> | undefined;
		try {
			child = await createHerdrPiSession(launch);
			assert.ok(child instanceof HerdrPiSession);
			const { runtimeDir: _runtimeDir, runId: _runId, agentName: _agentName, ...identity } = child.identity;
			assert.deepEqual(identity, { machineId: "local", target: "local", session: null, workspaceId: "w1", tabId: "t1", paneId: "p1", terminalId: "term1", nativeSessionId: "native", cwd });
		} finally { await child?.dispose(); handlers.get("session_shutdown")?.(); restorePane(); }
	});

	it("resolves 'local' to this pane's Herdr server, Herdr over Rex, and refuses outside both before anything starts", () => {
		const herdrPane = { PATH: "/usr/bin:/bin", HERDR_BIN: path.join(dir, "herdr"), FAKE_HERDR_DIR: dir, HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", HERDR_SOCKET_PATH: socket };
		assert.deepEqual(resolveMachinePlacement({ machine: "local", cwd: dir, stepCwd: "repo", env: herdrPane, settings: {} }), { machine: { provider: "herdr", id: "local", socket, cwd: path.join(dir, "repo") } });
		assert.deepEqual(fs.readFileSync(path.join(dir, "herdr-calls"), "utf8").trim().split("\n"), ["status server --json", "pane get w1:p1"], "no saved-machine catalog lookup");
		assert.deepEqual(fs.readFileSync(path.join(dir, "herdr-env"), "utf8").trim().split("\n"), [`${socket} unset w1:p1 1 unset`, `${socket} unset unset unset unset`]);
		// Herdr inside a Rex tab: its panes inherit REX_SESSION, and Herdr is where this Pi is drawn.
		assert.deepEqual(resolveMachinePlacement({ machine: "local", cwd: dir, env: { ...herdrPane, HERDR_SESSION: "work", REX_SESSION: "session:outer", REX_BIN_DIR: path.join(dir, "no-rex") }, settings: {} }).machine, { provider: "herdr", id: "local", socket, session: "work", cwd: dir });
		assert.throws(() => resolveMachinePlacement({ machine: "local", cwd: dir, env: { ...herdrPane, HERDR_PANE_ID: "w9:p9" }, settings: {} }), /did not return it: herdr pane get w9:p9 exited with code 1: pane not found/u);
		for (const env of [{ PATH: "/usr/bin:/bin" }, { ...herdrPane, HERDR_PANE_ID: " " }, { ...herdrPane, HERDR_ENV: "0" }]) assert.throws(() => resolveMachinePlacement({ machine: "local", cwd: dir, env, settings: {} }), /running in neither Herdr \(HERDR_ENV=1 with HERDR_PANE_ID\) nor Rex \(REX_SESSION is not set\)/u);
		assert.throws(() => resolveMachinePlacement({ machine: "local", cwd: dir, env: herdrPane, settings: { rex: { ssh: "host" } } }), /Machine 'local' is reserved/u);
	});
});
