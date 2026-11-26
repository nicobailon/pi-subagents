import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as net from "node:net";
import { describe, it } from "node:test";
import { HerdrCorePlacedRunOwner, herdrCoreHost, reconcileHerdrCoreRun, type HerdrCoreConnection } from "../../src/runs/shared/herdr-core-host.ts";
import { SocketRpcClient } from "../../src/runs/shared/herdr-connection.ts";
import { resolveMachinePlacement } from "../../src/runs/shared/herdr-machine.ts";
import type { HerdrRunIdentity } from "../../src/runs/shared/herdr-placed-run.ts";
import type { HerdrCoreLocalMachineReference } from "../../src/shared/types.ts";

const machine: HerdrCoreLocalMachineReference = { provider: "herdr-core", id: "local", socket: "/tmp/hc.sock", parentTerminal: "t1", cwd: "/repo" };

function connection(calls: Array<{ method: string; params: Record<string, unknown> }>, terminal: Record<string, unknown> = { address: "t2", parent: "t1", state: "live", labels: { "pi-subagents.run": "run", "pi-subagents.agent": "pi-run" } }): HerdrCoreConnection {
	return {
		parentTerminal: machine.parentTerminal,
		client: {
			async call(method, params = {}) { calls.push({ method, params }); if (method === "terminal.run" || method === "terminal.get" || method === "terminal.kill") return terminal as never; return {} as never; },
			async subscribe() { return () => {}; },
			async subscribeParams(_params, _listener, _lost, accepts) { assert.equal(accepts?.({ terminals: [terminal] }), true); return () => {}; },
		},
		async forwardRemoteSocket(socketPath) { return { socketPath, async close() {} }; },
		async close() {},
	};
}

const identity: HerdrRunIdentity = { runId: "run", machineId: "local", target: "t1", session: null, workspaceId: "t2", tabId: "t2", paneId: "t2", terminalId: "t2", agentName: "pi-run", nativeSessionId: "native", cwd: "/repo", runtimeDir: "/tmp/run" };

describe("Herdr Core local placement", { skip: process.platform === "win32" }, () => {
	it("prefers a confirmed live HC parent over an inherited Rex session", () => {
		const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hc-placement-")));
		const hc = path.join(dir, "hc");
		fs.writeFileSync(hc, `#!/bin/sh\nprintf '%s\\n' "$*" > "$FAKE_HC_CALL"\nprintf '{"address":"t1","state":"live"}'\n`, { mode: 0o755 });
		try {
			const call = path.join(dir, "call");
			const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HC_TERMINAL_ID: "t1", HC_TERMINAL_SOCKET: path.join(dir, "core.sock"), REX_SESSION: "session:inherited", REX_BIN_DIR: path.join(dir, "no-rex"), FAKE_HC_CALL: call };
			assert.deepEqual(resolveMachinePlacement({ machine: "local", cwd: dir, stepCwd: ".", env, settings: {}, hcBin: hc }), { machine: { provider: "herdr-core", id: "local", socket: path.join(dir, "core.sock"), parentTerminal: "t1", cwd: dir } });
			assert.equal(fs.readFileSync(call, "utf8").trim(), "--json get t1");
		} finally { fs.rmSync(dir, { recursive: true, force: true }); }
	});

	it("accepts the current hc events.subscribe snapshot before delivering notifications", async () => {
		const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hc-events-"))), socket = path.join(dir, "core.sock");
		const server = net.createServer((connection) => { connection.once("data", (chunk) => { const request = JSON.parse(String(chunk).trim()) as { id: string }; connection.write(`${JSON.stringify({ id: request.id, result: { seq: 1, terminals: [] } })}\n`); connection.write(`${JSON.stringify({ jsonrpc: "2.0", method: "event", params: { type: "status", terminal: "t2", data: { status: { state: "working" } } } })}\n`); }); });
		await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socket, resolve); });
		try {
			let observed: unknown;
			const unsubscribe = await new SocketRpcClient(socket).subscribeParams({ terminal: "t2" }, (event) => { observed = event; }, undefined, (result) => Boolean(result && typeof result === "object" && Array.isArray((result as { terminals?: unknown }).terminals)));
			for (let i = 0; i < 20 && observed === undefined; i++) await new Promise((resolve) => setTimeout(resolve, 5));
			assert.equal((observed as { params?: { terminal?: string } })?.params?.terminal, "t2");
			unsubscribe();
		} finally { await new Promise((resolve) => server.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }); }
	});

	it("fails closed when hc cannot confirm a live parent terminal, without falling back to an inherited Rex session", () => {
		const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hc-placement-")));
		try {
			const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HC_TERMINAL_ID: "t1", HC_TERMINAL_SOCKET: path.join(dir, "core.sock"), REX_SESSION: "session:inherited", REX_BIN_DIR: path.join(dir, "no-rex") };
			const failing = path.join(dir, "hc-fail");
			fs.writeFileSync(failing, "#!/bin/sh\necho 'terminal not found' >&2\nexit 1\n", { mode: 0o755 });
			assert.throws(() => resolveMachinePlacement({ machine: "local", cwd: dir, env, settings: {}, hcBin: failing }), /could not confirm this Pi's Herdr Core terminal t1: terminal not found/u);
			const finished = path.join(dir, "hc-finished");
			fs.writeFileSync(finished, `#!/bin/sh\nprintf '{"address":"t1","state":"finished"}'\n`, { mode: 0o755 });
			assert.throws(() => resolveMachinePlacement({ machine: "local", cwd: dir, env, settings: {}, hcBin: finished }), /did not confirm live parent terminal t1/u);
		} finally { fs.rmSync(dir, { recursive: true, force: true }); }
	});

	it("launches a headless native Pi terminal parented to the current HC terminal", async (t) => {
		const previousPiBinary = process.env.PI_SUBAGENT_PI_BINARY;
		process.env.PI_SUBAGENT_PI_BINARY = "/opt/pi/bin/pi";
		t.after(() => { if (previousPiBinary === undefined) delete process.env.PI_SUBAGENT_PI_BINARY; else process.env.PI_SUBAGENT_PI_BINARY = previousPiBinary; });
		const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
		const core = connection(calls);
		let owned: unknown;
		const launched = await herdrCoreHost.launch(core, machine, "run", "/tmp/run", { kind: "pi", name: "pi-run", args: ["--no-skills"], environment: { PI_SUBAGENTS_HERDR_MODE: "1" } }, async (value) => { owned = value; });
		assert.deepEqual(launched, { owned: { workspaceId: "t2", tabId: "t2", paneId: "t2" }, terminalId: "t2" });
		assert.deepEqual(owned, launched.owned);
		assert.deepEqual(calls[0], { method: "terminal.run", params: { argv: ["/opt/pi/bin/pi", "--no-skills"], cwd: "/repo", env: { PI_SUBAGENTS_HERDR_MODE: "1" }, name: "pi-run", parent: "t1", caller: "t1", no_notify: true, labels: { "pi-subagents.run": "run", "pi-subagents.agent": "pi-run" } } });
		await herdrCoreHost.prompt(core, identity, "/pi-subagents-bridge request");
		assert.deepEqual(calls[1], { method: "terminal.send", params: { terminal: "t2", text: "/pi-subagents-bridge request", force: true } });
	});

	it("hashes long run IDs so the Core bridge socket stays within the macOS path limit", async () => {
		const owner = await HerdrCorePlacedRunOwner.create(machine, `run_${"x".repeat(61)}`);
		try {
			assert.match(path.basename(owner.runtimeDir), /^pi-subagents-herdr-[0-9a-f]{12}-/u);
			assert.ok(Buffer.byteLength(path.join(owner.runtimeDir, "bridge.sock")) <= 103);
		} finally { await owner.cleanup(false); }
	});

	it("kills a headless Pi when event subscription fails, even on a cleanup that keeps settled tabs", async () => {
		const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
		const core = connection(calls); core.client.subscribeParams = async () => { throw new Error("subscribe failed"); };
		const Owner = HerdrCorePlacedRunOwner as unknown as new (machine: HerdrCoreLocalMachineReference, runId: string, runtimeDir: string, connection: HerdrCoreConnection, access: unknown) => HerdrCorePlacedRunOwner;
		const owner = new Owner(machine, "run", "/tmp/pi-subagents-herdr-test-owned", core, { shellCommand() { return "remove"; }, run() { return { status: 0, stdout: "", stderr: "" }; } });
		await assert.rejects(owner.launch({ kind: "pi", name: "pi-run", args: [] }, () => owner.subscribe(() => {}, () => {})), /subscribe failed/u);
		await owner.cleanup(false);
		assert.deepEqual(calls.map((call) => call.method), ["terminal.run", "terminal.get", "terminal.kill"]);
	});

	it("reconnects only to the same parented, labeled terminal and kills the owned Pi on settled disposal", async () => {
		const candidate = { terminals: [{ address: "t2", parent: "t1", state: "live", status: { state: "working" }, labels: { "pi-subagents.run": "run", "pi-subagents.agent": "pi-run" } }] };
		assert.deepEqual(reconcileHerdrCoreRun(identity, candidate, () => ({ ok: true, cursor: 4 })), { ok: true, state: "working", paneId: "t2", cursor: 4 });
		assert.match(reconcileHerdrCoreRun(identity, { terminals: [{ ...candidate.terminals[0], parent: "other" }] }, () => ({ ok: true, cursor: 4 })).reason, /ownership changed/u);
		assert.match(reconcileHerdrCoreRun(identity, { terminals: [{ ...candidate.terminals[0], labels: { ...candidate.terminals[0].labels, "pi-subagents.agent": "other" } }] }, () => ({ ok: true, cursor: 4 })).reason, /ownership changed/u);
		const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
		const ownership = { runId: "run", terminalId: "t2", agentName: "pi-run" };
		await herdrCoreHost.closeOwnedPane(connection(calls), { workspaceId: "t2", tabId: "t2", paneId: "t2" }, ownership);
		assert.deepEqual(calls.map((call) => call.method), ["terminal.get", "terminal.kill"]);
		const refused: Array<{ method: string; params: Record<string, unknown> }> = [];
		await assert.rejects(herdrCoreHost.closeOwnedPane(connection(refused, { address: "t2", parent: "other", state: "live", labels: { "pi-subagents.run": "other-run", "pi-subagents.agent": "pi-run" } }), { workspaceId: "t2", tabId: "t2", paneId: "t2" }, ownership), /ownership changed/u);
		assert.deepEqual(refused.map((call) => call.method), ["terminal.get"], "an ownership mismatch never reaches terminal.kill");
	});
});
