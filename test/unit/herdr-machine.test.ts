import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	formatHerdrMachineHint,
	formatHerdrMachineRunnerUnsupported,
	prepareHerdrMachineExternalCliRun,
	resolveHerdrMachinePlacement,
	shellQuote,
} from "../../src/runs/shared/herdr-machine.ts";
import type { HerdrMachineReference } from "../../src/shared/types.ts";
import { herdrPaneAllocationKey } from "../../src/runs/shared/herdr-placed-run.ts";
import { connectHerdrMachine, decodeHerdrJsonLine, discoverHerdrEndpoint, hardenedSshEnv, herdrSshArgs, HERDR_REMOTE_PATH, HERDR_SSH_BASE } from "../../src/runs/shared/herdr-connection.ts";
import { createRemoteRuntimeDir, discoverBridgeManifest, removeRemoteRuntimeDir } from "../../src/runs/shared/herdr-placed-run.ts";

const catalog = JSON.stringify([
	{ id: "7b9b56b47aab5ff46f338f1cd3ed1d15", label: "workmac", target: "100.82.67.118", session: "default", enabled: true, selected: false },
	{ id: "1111111111111111111111111111111a", label: "dup", target: "dup-a", session: "default", enabled: true },
	{ id: "1111111111111111111111111111111b", label: "dup", target: "dup-b", session: "default", enabled: true },
	{ id: "2222222222222222222222222222222c", label: "off", target: "off.example", session: "default", enabled: false },
	{ id: "3333333333333333333333333333333d", label: "bad", target: "-oProxyCommand=evil", session: "default", enabled: true },
]);
const machine: HerdrMachineReference = { provider: "herdr", id: "7b9b56b47aab5ff46f338f1cd3ed1d15", label: "workmac", target: "100.82.67.118", session: "default", cwd: "/home/nico/proj" };

let tempHome = "";
let tempProject = "";
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

function writeJson(filePath: string, value: unknown): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf-8");
}

describe("Herdr machine placement", () => {
	it("hardens native SSH against configured SendEnv and SetEnv without removing forwarding or agent auth", { skip: process.platform === "win32" }, () => { const source = { HOME: "/home/me", PATH: "/private/bin", SSH_AUTH_SOCK: "/tmp/auth", LOCAL_SECRET: "nope" }; const env = hardenedSshEnv(source); assert.equal(env.LOCAL_SECRET, undefined); assert.equal(env.SSH_AUTH_SOCK, undefined); assert.equal(env.HOME, undefined); assert.equal(env.PATH, "/usr/bin:/bin:/usr/sbin:/sbin"); assert.deepEqual(herdrSshArgs(source).slice(-2), ["-o", "IdentityAgent=/tmp/auth"]); assert.ok(HERDR_SSH_BASE.includes("SendEnv=-*")); assert.ok(HERDR_SSH_BASE.includes("SetEnv=PI_SUBAGENTS_SSH_GUARD=")); assert.equal(HERDR_SSH_BASE.includes("-L" as never), false); });
	it("rejects invalid UTF-8 in a complete Herdr JSON frame", () => assert.throws(() => decodeHerdrJsonLine(Buffer.concat([Buffer.from('{"x":"'), Buffer.from([0xc3, 0x28]), Buffer.from('"}')])) , /UTF-8/u));
	it("terminates a forwarding child that never creates its socket", { skip: process.platform === "win32" }, async () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-fake-ssh-")); const bin = path.join(dir, "ssh"); const pidFile = path.join(dir, "pid"); fs.writeFileSync(bin, `#!/bin/sh\ncase "$*" in *"command -v herdr"*) echo '{"socket":"/tmp/herdr.sock","session":"default","version":"0.9.0","protocol":1,"compatible":true,"running":true}'; exit 0;; esac\necho $$ > ${JSON.stringify(pidFile)}\ntrap 'exit 0' TERM INT\nwhile :; do sleep 1; done\n`); fs.chmodSync(bin, 0o700); try { await assert.rejects(connectHerdrMachine(machine, { sshBin: bin }), /did not create/u); const pid = Number(fs.readFileSync(pidFile, "utf8")); assert.throws(() => process.kill(pid, 0)); } finally { fs.rmSync(dir, { recursive: true, force: true }); } });
	it("uses one deterministic remote PATH and invokes only the exactly resolved Herdr", { skip: process.platform === "win32" }, () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-ssh-shape-")), ssh = path.join(dir, "ssh"), remoteHome = path.join(dir, "home"), remoteBin = path.join(remoteHome, ".local", "bin"), commandFile = path.join(dir, "command"); fs.mkdirSync(remoteBin, { recursive: true }); const herdr = path.join(remoteBin, "herdr"); fs.writeFileSync(path.join(remoteHome, ".profile"), "export RC_SOURCED=yes\n"); fs.writeFileSync(herdr, `#!/bin/sh\n[ "$0" = ${shellQuote(herdr)} ] || exit 91\n[ "$PATH" = "$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" ] || exit 92\n[ -z "$LOCAL_SECRET" ] && [ -z "$RC_SOURCED" ] || exit 93\nprintf '%s\\n' '{"socket":"/tmp/herdr.sock","session":"default","version":"0.9.0","protocol":22,"compatible":true,"running":true}'\n`); fs.chmodSync(herdr, 0o700); fs.writeFileSync(ssh, `#!/bin/sh\nwhile [ "$#" -gt 0 ]; do [ "$1" = ${shellQuote(machine.target)} ] && { shift; break; }; shift; done\n[ "$#" -eq 1 ] || exit 94\nprintf '%s' "$1" > ${shellQuote(commandFile)}\nHOME=${shellQuote(remoteHome)} exec sh -c "$1"\n`); fs.chmodSync(ssh, 0o700); const options = { sshBin: ssh, env: { PATH: "/caller/bin", LOCAL_SECRET: "nope" } }; try { assert.equal(discoverHerdrEndpoint(machine, options).protocol, 22); const command = fs.readFileSync(commandFile, "utf8"); assert.ok(command.includes(`PATH=\"${HERDR_REMOTE_PATH}\"; export PATH;`)); assert.ok(command.includes("herdr_path=$(command -v herdr)")); assert.ok(command.includes('exec "$herdr_path" status server --json')); assert.equal(/(?:source|\.profile|\.zprofile|LOCAL_SECRET)/u.test(command), false); const runtime = createRemoteRuntimeDir(machine, "run_quote'1", options); assert.match(path.basename(runtime), /^pi-subagents-herdr-run_quote'1-/u); fs.writeFileSync(path.join(runtime, "manifest.json"), JSON.stringify({ protocol: 1, packageVersion: "0.67.0", runId: "run_quote'1", socketPath: path.join(runtime, "bridge.sock"), nativeSessionId: "native" })); assert.equal(discoverBridgeManifest(machine, "run_quote'1", runtime, options).nativeSessionId, "native"); removeRemoteRuntimeDir(machine, runtime, options); assert.equal(fs.existsSync(runtime), false); } finally { fs.rmSync(dir, { recursive: true, force: true }); } });
	beforeEach(() => {
		tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-herdr-home-"));
		tempProject = fs.mkdtempSync(path.join(os.tmpdir(), "pi-herdr-project-"));
		process.env.HOME = tempHome;
		process.env.USERPROFILE = tempHome;
		process.env.PI_CODING_AGENT_DIR = path.join(tempHome, ".pi", "agent");
	});

	afterEach(() => {
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;
		if (originalUserProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = originalUserProfile;
		if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
		fs.rmSync(tempHome, { recursive: true, force: true });
		fs.rmSync(tempProject, { recursive: true, force: true });
	});

	describe("resolution", () => {
		it("resolves by profile id first, then by unique label, and normalizes the saved default session", () => {
			const byLabel = resolveHerdrMachinePlacement({ machine: "workmac", cwd: tempProject, catalogJson: catalog, settings: { cwd: "/home/nico/proj" } });
			assert.deepEqual(byLabel, { machine: { provider: "herdr", id: machine.id, label: "workmac", target: machine.target, cwd: machine.cwd } });
			const byId = resolveHerdrMachinePlacement({ machine: machine.id, cwd: tempProject, catalogJson: catalog, settings: { cwd: "/home/nico/proj" } });
			assert.deepEqual(byId.machine, byLabel.machine);
			assert.equal(herdrPaneAllocationKey(byLabel.machine.target, byLabel.machine.session, byLabel.machine.cwd), herdrPaneAllocationKey(byId.machine.target, byId.machine.session, byId.machine.cwd));
		});

		for (const [selector, pattern] of [
			["nope", /Herdr machine 'nope' was not found\. Saved machines: workmac, dup, dup, bad\./u],
			["dup", /Machine label 'dup' is ambiguous; use its profile ID\./u],
			["off", /Machine 'off' is disabled\. Run herdr machine enable 2222222222222222222222222222222c\./u],
			["bad", /ssh target that cannot be passed safely/u],
			["", /is required/u],
			["with\u0007bell", /control characters/u],
		] as const) {
			it(`fails closed for selector ${JSON.stringify(selector)}`, () => {
				assert.throws(() => resolveHerdrMachinePlacement({ machine: selector, cwd: tempProject, catalogJson: catalog, settings: { cwd: "/x" } }), pattern);
			});
		}

		it("orders cwd as absolute launch cwd, then relative cwd joined to the machine root, then the root", () => {
			const settings = { cwd: "/home/nico/proj" };
			const absolute = resolveHerdrMachinePlacement({ machine: "workmac", cwd: tempProject, stepCwd: "/srv/other", catalogJson: catalog, settings });
			assert.equal(absolute.machine.cwd, "/srv/other");
			const tilde = resolveHerdrMachinePlacement({ machine: "workmac", cwd: tempProject, stepCwd: "~/elsewhere/", catalogJson: catalog, settings });
			assert.equal(tilde.machine.cwd, "~/elsewhere");
			const relative = resolveHerdrMachinePlacement({ machine: "workmac", cwd: tempProject, stepCwd: "packages/api", catalogJson: catalog, settings });
			assert.equal(relative.machine.cwd, "/home/nico/proj/packages/api");
			const root = resolveHerdrMachinePlacement({ machine: "workmac", cwd: tempProject, catalogJson: catalog, settings });
			assert.equal(root.machine.cwd, "/home/nico/proj");
		});

		it("fails closed naming the missing machine root when no absolute cwd is given", () => {
			assert.throws(
				() => resolveHerdrMachinePlacement({ machine: "workmac", cwd: tempProject, stepCwd: "packages/api", catalogJson: catalog }),
				/No root for workmac in this repo\. Set subagents\.machines\.workmac\.cwd in \.pi\/settings\.json or pass an absolute cwd on that machine\./u,
			);
		});

		it("reads project machine roots by label or id and rejects locally supplied remote env", () => {
			writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), { subagents: { machines: { workmac: { cwd: "/user/root", env: { FOO: "user" } } } } });
			writeJson(path.join(tempProject, ".pi", "settings.json"), { subagents: { machines: { [machine.id]: { cwd: "/project/root" } } } });
			const nested = path.join(tempProject, "nested", "dir");
			fs.mkdirSync(nested, { recursive: true });
			assert.throws(() => resolveHerdrMachinePlacement({ machine: "workmac", cwd: nested, catalogJson: catalog }), /configure credentials and environment.*remov/iu);
			writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), { subagents: { machines: { workmac: { cwd: "/user/root" } } } });
			assert.equal(resolveHerdrMachinePlacement({ machine: "workmac", cwd: nested, catalogJson: catalog }).machine.cwd, "/project/root");
		});

		it("rejects malformed machine settings instead of ignoring them", () => {
			writeJson(path.join(tempProject, ".pi", "settings.json"), { subagents: { machines: { workmac: { cwd: "relative/path" } } } });
			assert.throws(() => resolveHerdrMachinePlacement({ machine: "workmac", cwd: tempProject, catalogJson: catalog }), /cwd must be an absolute POSIX path/u);
			writeJson(path.join(tempProject, ".pi", "settings.json"), { subagents: { machines: { workmac: { cwd: "/ok", env: { "bad name": "x" } } } } });
			assert.throws(() => resolveHerdrMachinePlacement({ machine: "workmac", cwd: tempProject, catalogJson: catalog }), /invalid 'machines\.workmac\.env'/u);
		});
	});

	describe("launch gating", () => {
		it("allows native Pi but rejects generic adapters and worktrees with a pointer", () => {
			if (process.platform !== "win32") assert.equal(formatHerdrMachineRunnerUnsupported({ machine: "workmac", agentName: "reviewer", runnerType: "pi" }), undefined);
			assert.match(formatHerdrMachineRunnerUnsupported({ machine: "workmac", agentName: "generic", runnerType: "external-cli" }) ?? "", /generic external-cli commands cannot be remote-wrapped/u);
			assert.match(formatHerdrMachineRunnerUnsupported({ machine: "workmac", agentName: "worker", runnerType: "external-cli", adapter: "claude-code", worktree: true }) ?? "", /managed worktrees are local git operations/u);
			assert.equal(formatHerdrMachineRunnerUnsupported({ agentName: "reviewer", runnerType: "pi" }), undefined);
			if (process.platform === "win32") {
				assert.match(formatHerdrMachineRunnerUnsupported({ machine: "workmac", agentName: "worker", runnerType: "external-cli", adapter: "claude-code" }) ?? "", /Windows host/u);
			} else {
				assert.equal(formatHerdrMachineRunnerUnsupported({ machine: "workmac", agentName: "worker", runnerType: "external-cli", adapter: "claude-code-writer" }), undefined);
			}
		});
	});

	describe("pane-native cut-over", () => {
		it("rejects the removed local-child SSH wrapper for saved-machine runs", () => {
			assert.throws(() => prepareHerdrMachineExternalCliRun({ command: "claude", cwd: "/local", prompt: "x", asyncDir: tempProject, stepIndex: 0 }, { machine }, { localCwd: "/local" }), /must run in a Herdr-owned pane/u);
		});
	});
	describe("hints", () => {
		for (const [text, pattern] of [
			["ssh: connect to host 100.82.67.118 port 22: Connection timed out", /Connect once interactively with ssh 100\.82\.67\.118/u],
			["nico@100.82.67.118: Permission denied (publickey).", /accept the host key or fix the identity/u],
			["sh: line 0: cd: /home/nico/proj: No such file or directory", /Nothing at \/home\/nico\/proj on workmac\. Clone the repo there first/u],
			["\nexit code 125", /Clone the repo there first/u],
			["sh: 1: claude: not found\nexit code 127", /set the agent's command to the absolute path on that machine/u],
			["'sh' is not recognized as an internal or external command", /not a POSIX host/u],
			["Error: Not logged in. Please run /login", /Log in to the agent CLI on workmac once/u],
			["all good", undefined],
		] as const) {
			it(`maps ${JSON.stringify(text.slice(0, 40))}`, () => {
				const hint = formatHerdrMachineHint(machine, text);
				if (pattern === undefined) assert.equal(hint, undefined);
				else assert.match(hint ?? "", pattern);
			});
		}
	});
});
