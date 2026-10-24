import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { ChildSessionLaunch } from "../../src/runs/shared/child-session.ts";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { createPlacementAwareChildSessionFactory, HerdrPiSession } from "../../src/runs/shared/herdr-placed-run.ts";
import { resolveMachinePlacement } from "../../src/runs/shared/herdr-machine.ts";
import { REX_BUNDLE_BIN, resolveRexBinary, rexCommandEnv } from "../../src/runs/shared/rex-machine.ts";
import { closeOwnedRexPane, connectRex } from "../../src/runs/shared/rex-pane-host.ts";
import type { RexMachineReference } from "../../src/shared/types.ts";

// Live check against a private Rex server and a real Pi: PI_SUBAGENTS_REX_SMOKE=1 npm run test:unit -- (or run this file alone).
// It never talks to the operator's Rex server: REX_SESSION/REX_BLOCK/REX_SERVER are dropped and every call names the private socket.
const enabled = process.env.PI_SUBAGENTS_REX_SMOKE === "1";
const realHome = os.userInfo().homedir;
// The test loader isolates HOME, so the Rex server bundle is looked up under the real home directory here.
const bundleRex = path.join(realHome, REX_BUNDLE_BIN);
function findRex(): string | undefined { try { return resolveRexBinary(); } catch { return fs.existsSync(bundleRex) ? bundleRex : undefined; } }
function findPi(): string | undefined { const found = spawnSync("/bin/sh", ["-c", "command -v pi"], { encoding: "utf8" }); return found.status === 0 && found.stdout.trim() ? found.stdout.trim() : undefined; }
const rexBin = enabled ? findRex() : undefined, piBin = enabled ? findPi() : undefined;
const skip = !enabled ? "set PI_SUBAGENTS_REX_SMOKE=1" : process.platform === "win32" ? "Rex placement is POSIX-only" : !rexBin ? "Rex is not installed" : !piBin ? "pi is not on PATH" : false;
const worktree = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const log = (line: string) => process.stdout.write(`[rex-smoke] ${line}\n`);

describe("Rex local placement against a private Rex server and a real Pi", { skip }, () => {
	it("launches a background Pi tab, completes one bridge prompt round trip, and proves the block gone on dispose", { timeout: 180_000 }, async () => {
		const scratch = fs.mkdtempSync("/tmp/rxs."), socket = path.join(scratch, "s.sock"), server = `unix://${socket}`, serverEnv = { ...rexCommandEnv(), HOME: realHome };
		for (const name of Object.keys(serverEnv)) if (name.startsWith("PI_")) delete serverEnv[name];
		fs.writeFileSync(path.join(scratch, "c.lua"), "");
		const rex = (args: string[]) => spawnSync(rexBin!, ["--autostart=false", "-S", server, ...args], { encoding: "utf8", env: serverEnv, timeout: 15_000 });
		const serverProcess = spawn(rexBin!, ["--autostart=false", "server", "run", "--listen", server, "--state-dir", path.join(scratch, "st"), "--config", path.join(scratch, "c.lua")], { env: serverEnv, stdio: "ignore", detached: true });
		const previousPiBinary = process.env.PI_SUBAGENT_PI_BINARY;
		let serverStopped = false;
		const stopServer = async () => { if (serverStopped) return; serverStopped = true; if (serverProcess.exitCode === null) { serverProcess.kill("SIGTERM"); await new Promise<void>((resolve) => { const timer = setTimeout(() => { serverProcess.kill("SIGKILL"); resolve(); }, 5_000); serverProcess.once("exit", () => { clearTimeout(timer); resolve(); }); }); } };
		try {
			for (let attempt = 0; attempt < 100 && !fs.existsSync(socket); attempt++) await new Promise((resolve) => setTimeout(resolve, 50));
			assert.ok(fs.existsSync(socket), "private Rex server did not start");
			const created = rex(["new", "smoke-parent", "--json", "--shell=none", "--", "/bin/sleep", "600"]);
			assert.equal(created.status, 0, created.stderr);
			const createdSession: { session_id: string } = JSON.parse(created.stdout);
			const session = createdSession.session_id;
			log(`private server ${server}, parent session ${session}`);

			const project = fs.realpathSync(fs.mkdtempSync(path.join(scratch, "project-")));
			fs.mkdirSync(path.join(project, ".pi", "agents"), { recursive: true });
			fs.writeFileSync(path.join(project, ".pi", "agents", "rex-smoke.md"), "---\nname: rex-smoke\ndescription: Rex placement smoke agent\ntools: read\n---\nYou answer in one short line.\n");
			const wrapper = path.join(scratch, "pi"), sessions = path.join(scratch, "sessions");
			fs.writeFileSync(wrapper, `#!/bin/sh\nexec ${JSON.stringify(piBin)} -ne -e ${JSON.stringify(path.join(worktree, "index.ts"))} --session-dir ${JSON.stringify(sessions)} "$@"\n`, { mode: 0o755 });
			process.env.PI_SUBAGENT_PI_BINARY = wrapper;

			// The parent's view: REX_SESSION/REX_SERVER name the private session, and resolution asks that server to confirm it.
			const resolved = resolveMachinePlacement({ machine: "local", cwd: project, env: { ...serverEnv, REX_BIN_DIR: path.dirname(rexBin!), REX_SESSION: session, REX_SERVER: server } }).machine;
			const machine: RexMachineReference = { provider: "rex", id: "local", session, server, cwd: project };
			assert.deepEqual(resolved, machine);
			// Any model the operator's Pi is logged in to; override with PI_SUBAGENTS_REX_SMOKE_MODEL.
			const model = process.env.PI_SUBAGENTS_REX_SMOKE_MODEL ?? "opencode-go/glm-5.3-flash";
			const launch: ChildSessionLaunch = { cwd: project, machine, remoteResources: { agent: "rex-smoke" }, storage: { kind: "memory" }, extensionPaths: [], ambientExtensions: true, hooks: [], noSkills: true, noContextFiles: true, tools: ["read"], model, runtime: { runId: "rexsmoke", agent: "rex-smoke", childIndex: 0, fanoutChild: false, depth: 1, maxDepth: 1, inheritProjectContext: true, inheritGlobalContext: true, inheritSkills: false, fast: false, waitTool: { enabled: true } } };
			const factory = createPlacementAwareChildSessionFactory({ create: async () => { throw new Error("local factory must not run for machine 'local'"); }, dispose: async () => {} });
			const started = Date.now();
			const child = await factory.create(launch);
			assert.ok(child instanceof HerdrPiSession);
			const identity = child.identity;
			log(`bridge ready+configured in ${Date.now() - started}ms: window ${identity.tabId}, block ${identity.paneId}, native session ${identity.nativeSessionId}, tools ${JSON.stringify(child.requestedTools)}, model ${child.model}`);
			assert.equal(identity.session, session);
			assert.equal(identity.workspaceId, session);
			assert.equal(identity.terminalId, identity.paneId);
			const listed: { active_window_id: string; windows: Array<{ window_id: string; label: string }> } = JSON.parse(rex(["session", "inspect", session, "--json"]).stdout);
			const tab = listed.windows.find((window) => window.window_id === identity.tabId);
			log(`tab label ${tab?.label}; active window is still the parent: ${listed.active_window_id !== identity.tabId}`);
			assert.equal(tab?.label, `subagent-${identity.runId.slice(-8)}`);
			assert.notEqual(listed.active_window_id, identity.tabId);

			const promptStarted = Date.now();
			await child.prompt("Reply with exactly the word rex-ok and nothing else.");
			const assistant = child.messages.findLast((message): message is AssistantMessage => message.role === "assistant");
			const text = assistant?.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("") ?? "";
			const screen = rex(["capture", "-s", session, "-b", identity.paneId, "--trim"]).stdout.trim().split("\n").filter((line) => line.trim()).slice(-6).join(" | ");
			log(`prompt round trip in ${Date.now() - promptStarted}ms; assistant said ${JSON.stringify(text)} (stop ${assistant?.stopReason}${assistant?.errorMessage ? `, error ${assistant.errorMessage}` : ""})`);
			log(`visible pane tail: ${screen}`);
			assert.match(text, /rex-ok/u);

			await child.abort();
			await child.dispose();
			const aborted = rex(["block", "inspect", "-s", session, identity.paneId]);
			log(`after abort + dispose: block inspect exit ${aborted.status}; runtime dir exists ${fs.existsSync(identity.runtimeDir)}`);
			assert.equal(aborted.status, 3);
			assert.equal(fs.existsSync(identity.runtimeDir), false);

			// A finished (not aborted) child keeps its tab, like a Herdr pane; only the bridge runtime directory goes.
			const finished = await factory.create({ ...launch, runtime: { ...launch.runtime, runId: "rexsmoke2" } });
			assert.ok(finished instanceof HerdrPiSession);
			const kept = finished.identity;
			await finished.dispose();
			const keptInspect = rex(["block", "inspect", "-s", session, kept.paneId]);
			log(`finished child after dispose: block inspect exit ${keptInspect.status}; runtime dir exists ${fs.existsSync(kept.runtimeDir)}`);
			assert.equal(keptInspect.status, 0);
			assert.equal(fs.existsSync(kept.runtimeDir), false);
			const connection = await connectRex(machine, { bin: rexBin });
			await closeOwnedRexPane(connection, { workspaceId: session, tabId: kept.tabId, paneId: kept.paneId });
			assert.equal(rex(["block", "inspect", "-s", session, kept.paneId]).status, 3);
			await factory.dispose();

			await stopServer();
			await assert.rejects(closeOwnedRexPane(connection, { workspaceId: session, tabId: identity.tabId, paneId: identity.paneId }), /unreachable/u);
			log("after server stop: cleanup reports the server unreachable instead of gone");
		} finally {
			if (previousPiBinary === undefined) delete process.env.PI_SUBAGENT_PI_BINARY; else process.env.PI_SUBAGENT_PI_BINARY = previousPiBinary;
			await stopServer();
			fs.rmSync(scratch, { recursive: true, force: true });
		}
	});
});
