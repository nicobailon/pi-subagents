import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ChildSessionLaunch } from "../../src/runs/shared/child-session.ts";
import { resolveMachinePlacement } from "../../src/runs/shared/herdr-machine.ts";
import { createPlacementAwareChildSessionFactory, HerdrPiSession } from "../../src/runs/shared/herdr-placed-run.ts";

// Live check against a private Herdr server and a real Pi: PI_SUBAGENTS_HERDR_SMOKE=1 (run this file alone).
// It never talks to the operator's Herdr server: the private server keeps its config, state and sockets under a /tmp scratch
// directory (XDG_CONFIG_HOME/XDG_STATE_HOME), every call names that server, and the run stops unless the server reports the private socket.
const enabled = process.env.PI_SUBAGENTS_HERDR_SMOKE === "1";
const realHome = os.userInfo().homedir;
function which(name: string): string | undefined { const found = spawnSync("/bin/sh", ["-c", `command -v ${name}`], { encoding: "utf8" }); return found.status === 0 && found.stdout.trim() ? found.stdout.trim() : undefined; }
const herdrBin = enabled ? which("herdr") : undefined, piBin = enabled ? which("pi") : undefined;
const skip = !enabled ? "set PI_SUBAGENTS_HERDR_SMOKE=1" : process.platform === "win32" ? "Herdr placement is POSIX-only" : !herdrBin ? "herdr is not on PATH" : !piBin ? "pi is not on PATH" : false;
const worktree = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SESSION = "smoke";
const log = (line: string) => process.stdout.write(`[herdr-smoke] ${line}\n`);

describe("Herdr local placement against a private Herdr server and a real Pi", { skip }, () => {
	it("resolves machine 'local' from a pane of a named private session, completes one bridge prompt, and proves the pane gone on dispose", { timeout: 240_000 }, async () => {
		const scratch = fs.mkdtempSync("/tmp/hls."), sessionDir = path.join(scratch, "cfg", "herdr", "sessions", SESSION), socket = path.join(sessionDir, "herdr.sock");
		const bin = path.join(scratch, "bin"); fs.mkdirSync(bin);
		// The pane shell finds this pi first: it loads only this worktree's pi-subagents, so the bridge version matches.
		fs.writeFileSync(path.join(bin, "pi"), `#!/bin/sh\nexec ${JSON.stringify(piBin)} -ne -e ${JSON.stringify(path.join(worktree, "index.ts"))} --session-dir ${JSON.stringify(path.join(scratch, "sessions"))} "$@"\n`, { mode: 0o755 });
		fs.writeFileSync(path.join(bin, "ssh"), `#!/bin/sh\ntouch ${JSON.stringify(path.join(scratch, "ssh-called"))}\nexit 99\n`, { mode: 0o755 });
		const privateEnv: NodeJS.ProcessEnv = { PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`, HOME: realHome, USER: os.userInfo().username, TMPDIR: "/tmp", SHELL: "/bin/sh", TERM: "xterm-256color", XDG_CONFIG_HOME: path.join(scratch, "cfg"), XDG_STATE_HOME: path.join(scratch, "state"), HERDR_SESSION: SESSION };
		const herdr = (args: string[]) => spawnSync(herdrBin!, args, { encoding: "utf8", env: privateEnv, timeout: 15_000 });
		const serverProcess = spawn(herdrBin!, ["--session", SESSION, "server"], { env: privateEnv, stdio: "ignore", detached: true });
		const processKeys = ["PATH", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "HERDR_SESSION", "HERDR_SOCKET_PATH", "HERDR_PANE_ID", "HERDR_ENV", "HERDR_CLIENT_SOCKET_PATH", "HERDR_BIN"] as const;
		const previous = processKeys.map((name) => process.env[name]);
		let serverStopped = false;
		const stopServer = async () => {
			if (serverStopped) return; serverStopped = true;
			herdr(["server", "stop"]);
			if (serverProcess.exitCode === null) await new Promise<void>((resolve) => { const timer = setTimeout(() => { serverProcess.kill("SIGKILL"); resolve(); }, 5_000); serverProcess.once("exit", () => { clearTimeout(timer); resolve(); }); });
		};
		try {
			let status: { running?: boolean; socket?: string; session?: string | null } = {};
			for (let attempt = 0; attempt < 100 && status.running !== true; attempt++) { await new Promise((resolve) => setTimeout(resolve, 100)); try { status = JSON.parse(herdr(["status", "server", "--json"]).stdout); } catch {} }
			// Isolation gate: nothing below runs unless the private server answers on the private socket.
			assert.equal(status.socket, socket, `private Herdr server is not isolated: ${JSON.stringify(status)}`);
			assert.equal(status.running, true, "private Herdr server did not start");
			assert.equal(status.session, SESSION);
			log(`private server ${socket}, session ${status.session}`);

			const project = fs.realpathSync(fs.mkdtempSync(path.join(scratch, "project-")));
			fs.mkdirSync(path.join(project, ".pi", "agents"), { recursive: true });
			fs.writeFileSync(path.join(project, ".pi", "agents", "herdr-smoke.md"), "---\nname: herdr-smoke\ndescription: Herdr placement smoke agent\ntools: read\n---\nYou answer in one short line.\n");
			const created = herdr(["workspace", "create", "--cwd", project]);
			assert.equal(created.status, 0, created.stderr);
			const parentPane: string = JSON.parse(created.stdout).result.root_pane.pane_id;

			// The parent's view: this Pi runs in parentPane of the private named session, and Herdr wins over a decoy Rex session.
			const paneEnv = { ...privateEnv, HERDR_ENV: "1", HERDR_PANE_ID: parentPane, HERDR_SOCKET_PATH: socket, REX_SESSION: "session:decoy" };
			Object.assign(process.env, { PATH: privateEnv.PATH, XDG_CONFIG_HOME: privateEnv.XDG_CONFIG_HOME, XDG_STATE_HOME: privateEnv.XDG_STATE_HOME, HERDR_BIN: herdrBin, HERDR_SESSION: "decoy", HERDR_SOCKET_PATH: "/tmp/decoy.sock", HERDR_PANE_ID: "decoy", HERDR_ENV: "1" });
			const machine = resolveMachinePlacement({ machine: "local", cwd: project, env: paneEnv, settings: {} }).machine;
			assert.deepEqual(machine, { provider: "herdr", id: "local", socket, session: SESSION, cwd: project });
			const model = process.env.PI_SUBAGENTS_HERDR_SMOKE_MODEL ?? "opencode-go/glm-5.3-flash";
			const launch: ChildSessionLaunch = { cwd: project, machine, remoteResources: { agent: "herdr-smoke" }, storage: { kind: "memory" }, extensionPaths: [], ambientExtensions: true, hooks: [], noSkills: true, noContextFiles: true, tools: ["read"], model, runtime: { runId: "herdrsmoke", agent: "herdr-smoke", childIndex: 0, fanoutChild: false, depth: 1, maxDepth: 1, inheritProjectContext: true, inheritGlobalContext: true, inheritSkills: false, fast: false, waitTool: { enabled: true } } };
			const factory = createPlacementAwareChildSessionFactory({ create: async () => { throw new Error("local factory must not run for machine 'local'"); }, dispose: async () => {} });
			const started = Date.now();
			const child = await factory.create(launch);
			assert.ok(child instanceof HerdrPiSession);
			const identity = child.identity;
			log(`bridge ready+configured in ${Date.now() - started}ms: workspace ${identity.workspaceId}, tab ${identity.tabId}, pane ${identity.paneId}, target ${identity.target}, session ${identity.session}, model ${child.model}`);
			assert.equal(identity.target, "local");
			assert.equal(identity.session, SESSION);
			assert.equal(identity.cwd, project);

			const promptStarted = Date.now();
			await child.prompt("Reply with exactly the word herdr-ok and nothing else.");
			const assistant = child.messages.findLast((message): message is AssistantMessage => message.role === "assistant");
			const text = assistant?.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("") ?? "";
			log(`prompt round trip in ${Date.now() - promptStarted}ms; assistant said ${JSON.stringify(text)} (stop ${assistant?.stopReason}${assistant?.errorMessage ? `, error ${assistant.errorMessage}` : ""})`);
			assert.match(text, /herdr-ok/u);

			await child.abort();
			await child.dispose();
			const gone = herdr(["pane", "get", identity.paneId]);
			log(`after abort + dispose: pane get exit ${gone.status}; runtime dir exists ${fs.existsSync(identity.runtimeDir)}`);
			assert.notEqual(gone.status, 0);
			assert.equal(fs.existsSync(identity.runtimeDir), false);
			assert.equal(fs.existsSync(path.join(scratch, "ssh-called")), false, "no ssh was started");
			await factory.dispose();
		} finally {
			processKeys.forEach((name, index) => { const value = previous[index]; if (value === undefined) delete process.env[name]; else process.env[name] = value; });
			await stopServer();
			log(`private server stopped: exit ${serverProcess.exitCode ?? serverProcess.signalCode}`);
			fs.rmSync(scratch, { recursive: true, force: true });
		}
	});
});
