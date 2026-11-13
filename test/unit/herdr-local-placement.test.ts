import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { HerdrPlacedRunOwner } from "../../src/runs/shared/herdr-pane-host.ts";
import { editsLocalDisk } from "../../src/runs/shared/rex-machine.ts";
import type { HerdrLocalMachineReference } from "../../src/shared/types.ts";

// A fake `herdr`: records the Herdr selectors it was started with and reports the server at $HERDR_SOCKET_PATH (or $FAKE_HERDR_REPORT).
const FAKE_HERDR = `#!/bin/sh
d="$FAKE_HERDR_DIR"; printf '%s\\n' "$*" >> "$d/herdr-calls"
printf '%s\\n' "\${HERDR_SOCKET_PATH:-unset} \${HERDR_SESSION:-unset} \${HERDR_PANE_ID:-unset} \${HERDR_ENV:-unset} \${HERDR_CLIENT_SOCKET_PATH:-unset}" >> "$d/herdr-env"
printf '{"socket":"%s","session":null,"version":"0.9.5","protocol":22,"running":true,"compatible":true}' "\${FAKE_HERDR_REPORT:-$HERDR_SOCKET_PATH}"
`;

function withEnv(values: Record<string, string>): () => void {
	const previous = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]));
	Object.assign(process.env, values);
	return () => { for (const [name, value] of Object.entries(previous)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } };
}

const RESULTS: Record<string, unknown> = {
	"session.snapshot": { type: "session_snapshot", snapshot: { panes: [], workspaces: [], agents: [] } },
	"workspace.create": { type: "workspace_created", workspace: { workspace_id: "w1" }, tab: { tab_id: "t1" }, root_pane: { pane_id: "p1" } },
	"agent.start": { type: "agent_started", agent: { terminal_id: "term1", pane_id: "p1" } },
	"agent.get": { type: "agent_info", agent: { terminal_id: "term1", pane_id: "p1" } },
	"pane.close": {},
};

describe("Herdr placement on this machine (machine 'local' in Herdr)", { skip: process.platform === "win32" }, () => {
	let dir: string, socket: string, server: net.Server, requests: Array<{ method: string; params: Record<string, unknown> }>, restore: () => void;
	const runtimeDirs = (runId: string) => fs.readdirSync("/tmp").filter((name) => name.startsWith(`pi-subagents-herdr-${createHash("sha256").update(runId).digest("hex").slice(0, 12)}-`));
	beforeEach(async () => {
		dir = fs.realpathSync(fs.mkdtempSync(path.join("/tmp", "hl-"))); socket = path.join(dir, "h.sock"); requests = [];
		fs.mkdirSync(path.join(dir, "bin"));
		fs.writeFileSync(path.join(dir, "herdr"), FAKE_HERDR, { mode: 0o755 });
		fs.writeFileSync(path.join(dir, "bin", "ssh"), `#!/bin/sh\ntouch "$FAKE_HERDR_DIR/ssh-called"\nexit 99\n`, { mode: 0o755 });
		server = net.createServer((connection) => { let buffer = ""; connection.on("data", (chunk) => { buffer += chunk; const newline = buffer.indexOf("\n"); if (newline < 0) return; const request = JSON.parse(buffer.slice(0, newline)) as { id: string; method: string; params: Record<string, unknown> }; requests.push(request); connection.end(`${JSON.stringify({ id: request.id, result: RESULTS[request.method] })}\n`); }); });
		await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socket, resolve); });
		// Decoy selectors from the calling process's own pane must never pick the server.
		restore = withEnv({ HERDR_BIN: path.join(dir, "herdr"), FAKE_HERDR_DIR: dir, PATH: `${path.join(dir, "bin")}:${process.env.PATH ?? ""}`, HERDR_SOCKET_PATH: "/tmp/decoy.sock", HERDR_SESSION: "decoy", HERDR_PANE_ID: "decoy-pane", HERDR_ENV: "1", HERDR_CLIENT_SOCKET_PATH: "/tmp/decoy-client.sock" });
	});
	afterEach(async () => { restore(); await new Promise((resolve) => server.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }); });

	it("opens and closes a pane in the recorded local server over its socket, with a /tmp runtime dir and no SSH", async () => {
		const runId = `${"l".repeat(48)}_0123456789abcdef`, machine: HerdrLocalMachineReference = { provider: "herdr", id: "local", socket, cwd: dir };
		const owner = await HerdrPlacedRunOwner.create(machine, runId), runtimeDir = owner.runtimeDir;
		try {
			assert.match(runtimeDir, /^\/tmp\/pi-subagents-herdr-[0-9a-f]{12}-/u);
			assert.ok(Buffer.byteLength(path.join(runtimeDir, "bridge.sock")) <= 103);
			assert.ok(fs.statSync(runtimeDir).isDirectory());
			const { owned, terminalId } = await owner.launch({ kind: "pi", name: "pi-local", args: [], environment: { PI_SUBAGENTS_HERDR_RUN_ID: runId } }, async () => {});
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

	it("refuses a server whose socket or session is not the recorded one, and leaves no runtime dir", async () => {
		const runId = "run_local_mismatch_0123456789";
		const reportOther = withEnv({ FAKE_HERDR_REPORT: "/tmp/other-herdr.sock" });
		try { await assert.rejects(HerdrPlacedRunOwner.create({ provider: "herdr", id: "local", socket, cwd: dir }, runId), /Local Herdr server identity mismatch: expected socket/u); } finally { reportOther(); }
		await assert.rejects(HerdrPlacedRunOwner.create({ provider: "herdr", id: "local", socket, session: "work", cwd: dir }, runId), /session identity mismatch: expected work, received default/u);
		assert.deepEqual(runtimeDirs(runId), []);
		assert.equal(fs.existsSync(path.join(dir, "ssh-called")), false);
		assert.equal(requests.length, 0);
	});

	it("counts only references without an SSH target as editing this machine's disk", () => {
		assert.equal(editsLocalDisk({ provider: "herdr", id: "local", socket: "/tmp/h.sock", cwd: "/repo" }), true);
		assert.equal(editsLocalDisk({ provider: "rex", id: "local", session: "session:s", cwd: "/repo" }), true);
		assert.equal(editsLocalDisk({ provider: "herdr", id: "m1", target: "host", cwd: "/remote" }), false);
		assert.equal(editsLocalDisk({ provider: "rex", id: "workmac", target: "host", cwd: "/remote" }), false);
		assert.equal(editsLocalDisk(undefined), false);
	});
});
