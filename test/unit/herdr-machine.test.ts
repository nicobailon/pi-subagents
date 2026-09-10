import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	formatHerdrMachineHint,
	formatHerdrMachineRunnerUnsupported,
	HERDR_SSH_ENV_ALLOWLIST,
	prepareHerdrMachineExternalCliRun,
	resolveHerdrMachinePlacement,
	shellQuote,
} from "../../src/runs/shared/herdr-machine.ts";
import type { ExternalCliPreflightResult } from "../../src/runs/shared/external-cli-preflight.ts";
import type { ExternalProcessStatus, HerdrMachineReference } from "../../src/shared/types.ts";

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

/** The remote command is the last ssh argument: `sh -c '<script>'`. Returns the script with the outer quoting removed. */
function remoteScript(args: readonly string[] | undefined): string {
	const remote = args?.at(-1) ?? "";
	assert.match(remote, /^sh -c '/u);
	return remote.slice("sh -c '".length, -1).replaceAll("'\\''", "'");
}

describe("Herdr machine placement", () => {
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
		it("resolves by profile id first, then by unique label, and carries the saved session", () => {
			const byLabel = resolveHerdrMachinePlacement({ machine: "workmac", cwd: tempProject, catalogJson: catalog, settings: { cwd: "/home/nico/proj" } });
			assert.deepEqual(byLabel, { machine });
			const byId = resolveHerdrMachinePlacement({ machine: machine.id, cwd: tempProject, catalogJson: catalog, settings: { cwd: "/home/nico/proj" } });
			assert.deepEqual(byId.machine, machine);
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

		it("reads machine roots from project settings over user settings, keyed by label or id, with opt-in env", () => {
			writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), { subagents: { machines: { workmac: { cwd: "/user/root", env: { FOO: "user" } } } } });
			writeJson(path.join(tempProject, ".pi", "settings.json"), { subagents: { machines: { [machine.id]: { cwd: "/project/root" } } } });
			const nested = path.join(tempProject, "nested", "dir");
			fs.mkdirSync(nested, { recursive: true });
			const placement = resolveHerdrMachinePlacement({ machine: "workmac", cwd: nested, catalogJson: catalog });
			assert.equal(placement.machine.cwd, "/project/root");
			assert.deepEqual(placement.env, { FOO: "user" });
		});

		it("rejects malformed machine settings instead of ignoring them", () => {
			writeJson(path.join(tempProject, ".pi", "settings.json"), { subagents: { machines: { workmac: { cwd: "relative/path" } } } });
			assert.throws(() => resolveHerdrMachinePlacement({ machine: "workmac", cwd: tempProject, catalogJson: catalog }), /cwd must be an absolute POSIX path/u);
			writeJson(path.join(tempProject, ".pi", "settings.json"), { subagents: { machines: { workmac: { cwd: "/ok", env: { "bad name": "x" } } } } });
			assert.throws(() => resolveHerdrMachinePlacement({ machine: "workmac", cwd: tempProject, catalogJson: catalog }), /invalid 'machines\.workmac\.env'/u);
		});
	});

	describe("launch gating", () => {
		it("rejects native agents, generic adapters, and worktrees with a pointer", () => {
			assert.match(formatHerdrMachineRunnerUnsupported({ machine: "workmac", agentName: "reviewer", runnerType: "pi" }) ?? "", /only external-cli agents can run on a Herdr saved machine/u);
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

	describe("ssh wrapping", { skip: process.platform === "win32" ? "POSIX control sockets" : false }, () => {
		it("wraps a Claude launch as one quoted sh -c script with Herdr's ssh options and a shared control socket", () => {
			const validated: ExternalCliPreflightResult[] = [];
			const prepared = prepareHerdrMachineExternalCliRun({
				command: "claude",
				args: ["-p", "--output-format", "stream-json", "--tools", "", "--mcp-config", '{"mcpServers":{}}'],
				cwd: "/local/parent",
				prompt: "hello",
				asyncDir: tempProject,
				stepIndex: 0,
				environment: { allowlist: ["PATH", "ANTHROPIC_API_KEY"] },
				preflight: { id: "claude-code", versionArgs: ["--version"], helpArgs: ["--help"], probeTimeoutMs: 2_000, validate: (result) => { validated.push(result); } },
				parser: { parseLine: () => undefined, finish: () => ({ kind: "success", text: "done" }) },
			}, { machine, env: { CLAUDE_CONFIG_DIR: "/home/nico/.claude-work" } }, { localCwd: "/local/parent" });

			assert.equal(prepared.input.command, "ssh");
			assert.equal(prepared.input.cwd, "/local/parent");
			assert.deepEqual(prepared.input.environment, { allowlist: HERDR_SSH_ENV_ALLOWLIST });
			assert.ok(HERDR_SSH_ENV_ALLOWLIST.includes("SSH_AUTH_SOCK"));
			const args = prepared.input.args ?? [];
			const target = args.at(-2);
			assert.equal(target, "100.82.67.118");
			const options = args.slice(0, -2).join(" ");
			for (const expected of ["-T", "BatchMode=yes", "StrictHostKeyChecking=yes", "ConnectTimeout=10", "ServerAliveInterval=15", "ServerAliveCountMax=4", "ControlMaster=auto", "ControlPersist=60"]) {
				assert.ok(options.includes(expected), `missing ${expected}`);
			}
			const controlPath = args[args.indexOf("ControlPath=" + args.find((arg) => arg.startsWith("ControlPath="))!.slice("ControlPath=".length))]!;
			assert.equal(controlPath, `ControlPath=${path.join(tempHome, ".pi", "agent", "ssh-control", "%C")}`);
			assert.ok(fs.statSync(path.join(tempHome, ".pi", "agent", "ssh-control")).isDirectory());

			const script = remoteScript(args);
			assert.match(script, /^export PATH="\$HOME\/\.local\/bin:\/opt\/homebrew\/bin:\/usr\/local\/bin:\$PATH"; export CLAUDE_CONFIG_DIR='\/home\/nico\/\.claude-work'; cd '\/home\/nico\/proj' \|\| exit 125; printf '%s\\n' '__pi_subagents_ready_[0-9a-f]{16}__'; 'claude' '-p' /u);
			assert.ok(script.includes(`'claude' '-p' '--output-format' 'stream-json' '--tools' '' '--mcp-config' '{"mcpServers":{}}'; pi_status=$?;`));
			assert.ok(script.endsWith("exit $pi_status"));
			assert.ok(script.includes("git rev-parse --is-inside-work-tree"));
			assert.ok(!script.includes("ANTHROPIC_API_KEY"));

			const preflight = prepared.input.preflight!;
			assert.equal(preflight.remote, true);
			assert.equal(preflight.probeTimeoutMs, undefined);
			assert.equal(preflight.id, `claude-code@${machine.id}`);
			assert.equal(preflight.versionArgs.at(-2), "100.82.67.118");
			const probe = remoteScript(preflight.versionArgs);
			assert.match(probe, /cd '\/home\/nico\/proj' \|\| exit 125; printf '%s\\n' '__pi_subagents_ready_[0-9a-f]{16}__'; exec 'claude' '--version'$/u);
			const marker = /__pi_subagents_ready_[0-9a-f]{16}__/u.exec(probe)![0];

			preflight.validate!({ binaryPath: "/usr/bin/ssh", binaryMtimeMs: 1, version: `motd noise\n${marker}\n1.2.3 (Claude Code)`, help: `${marker}\nUsage: claude`, cacheHit: false });
			assert.equal(validated[0]?.version, "1.2.3 (Claude Code)");
			assert.equal(validated[0]?.help, "Usage: claude");
			assert.throws(() => preflight.validate!({ binaryPath: "/usr/bin/ssh", binaryMtimeMs: 1, version: "'sh' is not recognized as an internal or external command", help: "", cacheHit: false }), /not a POSIX host/u);
		});

		it("quotes a tilde cwd through $HOME and single quotes inside arguments", () => {
			const prepared = prepareHerdrMachineExternalCliRun({
				command: "claude",
				args: ["-p", "it's"],
				cwd: "/local",
				prompt: "x",
				asyncDir: tempProject,
				stepIndex: 0,
				preflight: { id: "claude-code", versionArgs: ["--version"], helpArgs: ["--help"] },
			}, { machine: { ...machine, cwd: "~/proj" } }, { localCwd: "/local" });
			const remote = prepared.input.args?.at(-1) ?? "";
			assert.ok(remote.includes(`cd "$HOME"'\\''/proj'\\'' || exit 125`), remote);
			assert.ok(remote.includes(`'\\''it'\\''\\'\\'''\\''s'\\''`), remote);
			assert.equal(shellQuote("it's"), `'it'\\''s'`);
		});

		it("discards stream lines until the ready marker and fails closed when it never arrives", () => {
			const seen: string[] = [];
			const prepared = prepareHerdrMachineExternalCliRun({
				command: "claude",
				args: [],
				cwd: "/local",
				prompt: "x",
				asyncDir: tempProject,
				stepIndex: 0,
				preflight: { id: "claude-code", versionArgs: ["--version"], helpArgs: ["--help"] },
				parser: { parseLine: (line) => { seen.push(line); return undefined; }, finish: () => ({ kind: "success", text: "ok" }) },
			}, { machine }, { localCwd: "/local" });
			const marker = /__pi_subagents_ready_[0-9a-f]{16}__/u.exec(prepared.input.args?.at(-1) ?? "")![0];
			const parser = prepared.input.parser!;
			parser.parseLine("Welcome to workmac");
			assert.throws(() => parser.finish(), /never reached the project directory/u);
			parser.parseLine(marker);
			parser.parseLine('{"type":"result"}');
			assert.deepEqual(seen, ['{"type":"result"}']);
			assert.deepEqual(parser.finish(), { kind: "success", text: "ok" });
		});

		it("carries the Codex final message back through the stream into the local artifact", () => {
			const finalOutputPath = path.join(tempProject, "external-0.final-message.txt");
			let finished = false;
			const prepared = prepareHerdrMachineExternalCliRun({
				command: "codex",
				args: ["exec", "--json", "--output-last-message", finalOutputPath, "-"],
				cwd: "/local",
				prompt: "x",
				asyncDir: tempProject,
				stepIndex: 0,
				finalOutputPath,
				preflight: { id: "codex-exec", versionArgs: ["--version"], helpArgs: ["exec", "--help"] },
				parser: { parseLine: () => undefined, finish: () => { finished = true; return { kind: "success", text: fs.readFileSync(finalOutputPath, "utf-8") }; } },
			}, { machine }, { localCwd: "/local" });
			assert.equal(prepared.input.finalOutputPath, finalOutputPath);
			const script = remoteScript(prepared.input.args);
			assert.ok(script.includes('pi_final=$(mktemp "${TMPDIR:-/tmp}/pi-subagents-final.XXXXXX") || exit 126; '), script);
			assert.ok(script.includes(`'codex' 'exec' '--json' '--output-last-message' ''"$pi_final"'' '-'; pi_status=$?; printf '%s\\n' '__pi_subagents_final_begin_`), script);
			assert.ok(script.includes(`cat "$pi_final"; printf '\\n%s\\n' '__pi_subagents_final_end_`), script);
			assert.ok(script.includes('rm -f "$pi_final"'), script);
			assert.ok(!script.includes(finalOutputPath));
			const markers = [...script.matchAll(/__pi_subagents_(?:ready|final_begin|final_end|git)_[0-9a-f]{16}__/gu)].map((match) => match[0]);
			const [ready, begin, end, git] = markers;
			const parser = prepared.input.parser!;
			parser.parseLine(ready!);
			parser.parseLine('{"type":"turn.completed"}');
			parser.parseLine(begin!);
			parser.parseLine("final answer");
			parser.parseLine("second line");
			parser.parseLine(end!);
			parser.parseLine(`${git}{"head":"abc123","branch":"main","dirty":true}`);
			assert.deepEqual(parser.finish(), { kind: "success", text: "final answer\nsecond line" });
			assert.equal(finished, true);
			const status = prepared.decorateProcess({ startedAt: 1, stdoutPath: "out", stderrPath: "err" } satisfies ExternalProcessStatus);
			assert.deepEqual(status.machine, { ...machine, remoteGit: { head: "abc123", branch: "main", dirty: true } });
		});

		it("delivers the Cursor handoff over stdin into a remote temp directory and never names the local prompt file", () => {
			const promptDirectory = path.join(tempProject, "external-0.cursor-prompt");
			const promptFilePath = path.join(promptDirectory, "handoff.txt");
			const prepared = prepareHerdrMachineExternalCliRun({
				command: "cursor-agent",
				args: ["-p", "--sandbox", "enabled", "--workspace", "/home/nico/proj", "--add-dir", promptDirectory, `Read the complete handoff from the private file at ${promptFilePath}. Follow it and return only the final answer.`],
				cwd: "/local",
				prompt: "x",
				asyncDir: tempProject,
				stepIndex: 0,
				promptFilePath,
				temporaryDirectories: [promptDirectory],
				preflight: { id: "cursor-agent", versionArgs: ["--version"], helpArgs: ["--help"] },
			}, { machine }, { localCwd: "/local" });
			assert.equal(prepared.input.promptFilePath, undefined);
			assert.equal(prepared.input.temporaryDirectories, undefined);
			const script = remoteScript(prepared.input.args);
			assert.ok(!script.includes(tempProject));
			assert.ok(script.includes('pi_prompt_dir=$(mktemp -d "${TMPDIR:-/tmp}/pi-subagents-prompt.XXXXXX") || exit 126; pi_prompt="$pi_prompt_dir/handoff.txt"; cat >"$pi_prompt"; '), script);
			assert.ok(script.includes(`'cursor-agent' '-p' '--sandbox' 'enabled' '--workspace' '/home/nico/proj' '--add-dir' "$pi_prompt_dir" 'Read the complete handoff from the private file at '"$pi_prompt"'. Follow it and return only the final answer.'; pi_status=$?; rm -rf "$pi_prompt_dir"`), script);
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
