import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { localMachineAccess } from "../../src/runs/shared/local-machine-access.ts";
import { formatHerdrMachineRunnerUnsupported, resolveMachinePlacement } from "../../src/runs/shared/herdr-machine.ts";
import { closeOwnedRexPane, connectRex, rexPaneHost, RexPlacedRunOwner } from "../../src/runs/shared/rex-pane-host.ts";
import type { RexMachineReference } from "../../src/shared/types.ts";

// A fake `rex` on disk: it logs its argv, prints <kind>.out when present, and exits with the next scripted code for each command kind.
const FAKE_REX = `#!/bin/sh
d="$FAKE_REX_DIR"; printf '%s\\n' "$*" >> "$d/calls"
printf '%s\\n' "\${REX_SESSION:-unset} \${REX_BLOCK:-unset} \${REX_SERVER:-unset}" >> "$d/selectors"
case "$*" in
  *" session inspect "*) key=session;;
  *" block inspect "*) key=inspect;;
  *" block close "*) key=close;;
  *" window new "*) key=window;;
  *) key=other;;
esac
n=$(($(cat "$d/$key.n" 2>/dev/null || echo 0) + 1)); echo "$n" > "$d/$key.n"
code=$(sed -n "\${n}p" "$d/$key" 2>/dev/null); [ -n "$code" ] || code=$(tail -n 1 "$d/$key" 2>/dev/null); [ -n "$code" ] || code=0
if [ -f "$d/$key.out" ]; then cat "$d/$key.out"; elif [ "$key" = session ] && [ "$code" = 0 ]; then printf '{"session_id":"%s"}' "$FAKE_REX_SESSION"; fi
[ "$code" = 0 ] || echo "fake rex exit $code" >&2
exit "$code"
`;
const session = "session:fake-1", machine: RexMachineReference = { provider: "rex", id: "local", session, server: "unix:///tmp/fake-rex.sock", cwd: "/tmp" };
const owned = { workspaceId: session, tabId: "window:w1", paneId: "block:b1" };
function withEnv(values: Record<string, string>): () => void {
	const previous = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]));
	Object.assign(process.env, values);
	return () => { for (const [name, value] of Object.entries(previous)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } };
}

describe("Rex pane host exit codes and cleanup", { skip: process.platform === "win32" }, () => {
	let dir: string, bin: string;
	const script = (key: string, codes: number[]) => fs.writeFileSync(path.join(dir, key), `${codes.join("\n")}\n`);
	const calls = () => fs.readFileSync(path.join(dir, "calls"), "utf8").trim().split("\n");
	const connect = () => connectRex(machine, { bin, access: localMachineAccess({ env: { PATH: "/usr/bin:/bin", FAKE_REX_DIR: dir, FAKE_REX_SESSION: session } }) });
	beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-rex-")); bin = path.join(dir, "rex"); fs.writeFileSync(bin, FAKE_REX, { mode: 0o755 }); });
	afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

	it("connects only when the server confirms the recorded session, with autostart off and an explicit server", async () => {
		await connect();
		assert.deepEqual(calls(), [`--autostart=false -S ${machine.server} session inspect ${session} --json`]);
		fs.rmSync(path.join(dir, "session.n"));
		script("session", [3]); await assert.rejects(connect(), /session session:fake-1 no longer exists/u);
		fs.rmSync(path.join(dir, "session.n"));
		script("session", [4]); await assert.rejects(connect(), /unreachable/u);
	});

	it("closes a present block and reports closed only once block inspect exits 3", async () => {
		const connection = await connect(); script("inspect", [0, 3]); script("close", [0]);
		await closeOwnedRexPane(connection, owned);
		assert.deepEqual(calls().slice(1), [
			`--autostart=false -S ${machine.server} block inspect -s ${session} block:b1`,
			`--autostart=false -S ${machine.server} block close -s ${session} block:b1`,
			`--autostart=false -S ${machine.server} block inspect -s ${session} block:b1`,
		]);
	});

	it("treats an already-gone block as closed without closing anything", async () => {
		const connection = await connect(); script("inspect", [3]);
		await closeOwnedRexPane(connection, owned);
		assert.equal(calls().some((call) => call.includes("block close")), false);
	});

	it("refuses to report closed while the block still exists after close", async () => {
		const connection = await connect(); script("inspect", [0]); script("close", [0]);
		await assert.rejects(closeOwnedRexPane(connection, owned), /still exists after close/u);
	});

	it("never treats an unreachable server (exit 4) as a gone block", async () => {
		const connection = await connect(); script("inspect", [4]);
		await assert.rejects(closeOwnedRexPane(connection, owned), /unreachable/u);
		script("inspect", [0, 4]); fs.rmSync(path.join(dir, "inspect.n")); script("close", [0]);
		await assert.rejects(closeOwnedRexPane(connection, owned), /unreachable/u);
	});

	it("refuses cleanup of a pane recorded in another Rex session", async () => {
		const connection = await connect();
		await assert.rejects(closeOwnedRexPane(connection, { ...owned, workspaceId: "session:other" }), /different Rex session/u);
		assert.equal(calls().length, 1);
	});

	it("closes the window a failed or unreadable window new may have opened, found by the run's tab label", async () => {
		const connection = await connect(), restore = withEnv({ PI_SUBAGENT_PI_BINARY: "/bin/echo" }), label = "subagent-89abcdef";
		const listing = (...windows: Array<{ id: string; label: string; block: string }>) => fs.writeFileSync(path.join(dir, "session.out"), JSON.stringify({ session_id: session, windows: windows.map((window) => ({ window_id: window.id, label: window.label, layers: [{ blocks: [{ block_id: window.block }] }] })) }));
		const launch = () => rexPaneHost.launch(connection, machine, "run_0123456789abcdef", "/tmp/unused", { kind: "pi", name: "pi", args: [] }, async () => { throw new Error("onPane must not run for an unparsed window"); });
		try {
			fs.writeFileSync(path.join(dir, "window.out"), "not json"); listing({ id: "window:parent", label: "Window 1", block: "block:parent" }, { id: "window:w9", label, block: "block:b9" });
			script("inspect", [0, 3]); script("close", [0]);
			await assert.rejects(launch(), /window new returned malformed JSON/u);
			const windowNew = calls().find((call) => call.includes(" window new "));
			assert.match(windowNew ?? "", new RegExp(`window new -s ${session} ${label} -c /tmp --focus=false --json -- /usr/bin/env /bin/echo$`, "u"));
			assert.deepEqual(calls().filter((call) => call.includes(" block ")), [`--autostart=false -S ${machine.server} block inspect -s ${session} block:b9`, `--autostart=false -S ${machine.server} block close -s ${session} block:b9`, `--autostart=false -S ${machine.server} block inspect -s ${session} block:b9`]);

			fs.rmSync(path.join(dir, "window.out")); script("window", [1]); listing({ id: "window:parent", label: "Window 1", block: "block:parent" });
			await assert.rejects(launch(), /window new exited with code 1/u);
			assert.equal(calls().filter((call) => call.includes(" block close ")).length, 1);
		} finally { restore(); }
	});

	it("keeps the bridge socket path within the macOS 103-byte limit for a 65-character run id", async () => {
		const runId = `${"w".repeat(48)}_0123456789abcdef`, restore = withEnv({ REX_BIN_DIR: dir, FAKE_REX_DIR: dir, FAKE_REX_SESSION: session });
		assert.equal(runId.length, 65);
		let runtimeDir = "";
		try {
			const owner = await RexPlacedRunOwner.create(machine, runId); runtimeDir = owner.runtimeDir;
			try {
				const socketPath = path.join(runtimeDir, "bridge.sock");
				assert.ok(Buffer.byteLength(socketPath) <= 103, socketPath);
				assert.match(path.basename(runtimeDir), /^pi-subagents-herdr-[0-9a-f]{12}-/u);
				const server = net.createServer();
				await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
				await new Promise((resolve) => server.close(resolve));
			} finally { await owner.cleanup(); }
		} finally { restore(); }
		assert.equal(fs.existsSync(runtimeDir), false);
	});
});

describe("machine 'local' resolution", { skip: process.platform === "win32" }, () => {
	let dir: string;
	const script = (codes: number[]) => fs.writeFileSync(path.join(dir, "session"), `${codes.join("\n")}\n`);
	const parentEnv = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({ PATH: "/usr/bin:/bin", REX_BIN_DIR: dir, FAKE_REX_DIR: dir, FAKE_REX_SESSION: session, ...extra });
	let insideRex: NodeJS.ProcessEnv;
	beforeEach(() => { dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fake-rex-"))); fs.writeFileSync(path.join(dir, "rex"), FAKE_REX, { mode: 0o755 }); fs.mkdirSync(path.join(dir, "repo")); insideRex = parentEnv({ REX_SESSION: session, REX_BLOCK: "block:parent", REX_SERVER: "unix:///tmp/fake-rex.sock" }); });
	afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

	it("records the parent's confirmed Rex session, server and real launch directory without reading the Herdr catalog", () => {
		const placement = resolveMachinePlacement({ machine: "local", cwd: dir, stepCwd: "repo", env: insideRex, herdrBin: path.join(dir, "no-herdr") });
		assert.deepEqual(placement, { machine: { provider: "rex", id: "local", session, server: "unix:///tmp/fake-rex.sock", cwd: path.join(dir, "repo") } });
		assert.deepEqual(fs.readFileSync(path.join(dir, "calls"), "utf8").trim().split("\n"), [`--autostart=false -S unix:///tmp/fake-rex.sock session inspect ${session} --json`]);
		assert.equal(fs.readFileSync(path.join(dir, "selectors"), "utf8").trim(), "unset unset unset");
	});

	it("fails closed outside Rex, for a session the server does not know, and when the server is unreachable", () => {
		assert.throws(() => resolveMachinePlacement({ machine: "local", cwd: dir, env: parentEnv() }), /not running inside Rex/u);
		assert.equal(fs.existsSync(path.join(dir, "calls")), false);
		script([3]); assert.throws(() => resolveMachinePlacement({ machine: "local", cwd: dir, env: insideRex }), /does not know session/u);
		fs.rmSync(path.join(dir, "session.n")); script([4]); assert.throws(() => resolveMachinePlacement({ machine: "local", cwd: dir, env: insideRex }), /unreachable/u);
		fs.rmSync(path.join(dir, "session.n")); script([0]); assert.throws(() => resolveMachinePlacement({ machine: "local", cwd: dir, env: { ...insideRex, FAKE_REX_SESSION: "session:other" } }), /did not confirm/u);
		assert.throws(() => resolveMachinePlacement({ machine: "local", cwd: dir, stepCwd: "missing", env: insideRex }), /cwd does not exist/u);
	});

	it("rejects external runners and managed worktrees on machine 'local' before launch", () => {
		assert.equal(formatHerdrMachineRunnerUnsupported({ machine: "local", agentName: "worker" }), undefined);
		assert.match(formatHerdrMachineRunnerUnsupported({ machine: "local", agentName: "claude", runnerType: "external-cli", adapter: "claude-code" }) ?? "", /native Pi children only/u);
		assert.match(formatHerdrMachineRunnerUnsupported({ machine: "local", agentName: "worker", worktree: true }) ?? "", /managed worktrees/u);
	});
});
