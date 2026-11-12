import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { formatHerdrMachineRunnerUnsupported, resolveMachinePlacement } from "../../src/runs/shared/herdr-machine.ts";
import { localMachineAccess } from "../../src/runs/shared/local-machine-access.ts";
import { openRexPlacedRun, rexPaneHost } from "../../src/runs/shared/rex-pane-host.ts";
import type { RexSshMachineReference } from "../../src/shared/types.ts";

// A fake remote `rex`: it logs its argv, lists sessions.json, makes `new` publish after-new.json, and confirms any session unless `gone` exists.
const FAKE_REX = `#!/bin/sh
d="$FAKE_REX_DIR"; printf '%s\\n' "$*" >> "$d/calls"
case "$*" in
  *" ls --json") cat "$d/sessions.json";;
  *" new subagents --json") cp "$d/after-new.json" "$d/sessions.json"; printf '{"session_id":"session:new","initial_windows":[]}';;
  *" session inspect "*) if [ -f "$d/gone" ]; then echo "session not found" >&2; exit 3; fi; printf '{"session_id":"%s"}' "$4";;
esac
`;

function writeJson(filePath: string, value: unknown): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, JSON.stringify(value), "utf-8");
}

describe("Rex SSH machine resolution", () => {
	let home: string, project: string, userSettings: string, projectSettings: string, noHerdr: string;
	const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR };
	beforeEach(() => {
		home = fs.mkdtempSync(path.join(os.tmpdir(), "rex-ssh-home-"));
		project = fs.mkdtempSync(path.join(os.tmpdir(), "rex-ssh-project-"));
		process.env.HOME = home;
		process.env.USERPROFILE = home;
		process.env.PI_CODING_AGENT_DIR = path.join(home, ".pi", "agent");
		userSettings = path.join(home, ".pi", "agent", "settings.json");
		projectSettings = path.join(project, ".pi", "settings.json");
		noHerdr = path.join(home, "no-herdr");
	});
	afterEach(() => {
		for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
		fs.rmSync(home, { recursive: true, force: true });
		fs.rmSync(project, { recursive: true, force: true });
	});

	it("resolves a user-settings rex entry to a Rex SSH machine without reading the Herdr catalog", () => {
		writeJson(userSettings, { subagents: { machines: { workmac: { rex: { ssh: "100.82.67.118" } } } } });
		writeJson(projectSettings, { subagents: { machines: { workmac: { cwd: "~/dev/app" } } } });
		assert.deepEqual(resolveMachinePlacement({ machine: "workmac", cwd: project, stepCwd: "packages/api", herdrBin: noHerdr }), { machine: { provider: "rex", id: "workmac", target: "100.82.67.118", cwd: "~/dev/app/packages/api" } });
		assert.throws(() => resolveMachinePlacement({ machine: "macmini", cwd: project, herdrBin: noHerdr }), /Herdr CLI .* was not found/u);
	});

	it("refuses a rex entry in project settings, under the reserved name local, or with unknown fields", () => {
		writeJson(projectSettings, { subagents: { machines: { workmac: { cwd: "/srv/app", rex: { ssh: "evil.example" } } } } });
		assert.throws(() => resolveMachinePlacement({ machine: "workmac", cwd: project, herdrBin: noHerdr }), /Move the rex entry to your user settings/u);
		fs.rmSync(projectSettings);
		writeJson(userSettings, { subagents: { machines: { local: { rex: { ssh: "100.82.67.118" } }, workmac: { cwd: "/srv/app", rex: { ssh: "100.82.67.118", session: "mine" } } } } });
		assert.throws(() => resolveMachinePlacement({ machine: "local", cwd: project, herdrBin: noHerdr }), /'local' is reserved/u);
		assert.throws(() => resolveMachinePlacement({ machine: "workmac", cwd: project, herdrBin: noHerdr }), /invalid 'machines\.workmac\.rex'/u);
	});

	it("rejects non-Pi runners on a Rex SSH name before launch, where Herdr would accept them", { skip: process.platform === "win32" ? "machine placement is rejected outright on Windows" : false }, () => {
		const claude = { machine: "workmac", agentName: "claude", runnerType: "external-cli", adapter: "claude-code" };
		assert.equal(formatHerdrMachineRunnerUnsupported(claude), undefined);
		writeJson(userSettings, { subagents: { machines: { workmac: { rex: { ssh: "100.82.67.118" } } } } });
		assert.match(formatHerdrMachineRunnerUnsupported(claude) ?? "", /machine 'workmac', but Rex supports native Pi children only/u);
		assert.equal(formatHerdrMachineRunnerUnsupported({ machine: "workmac", agentName: "worker" }), undefined);
	});
});

describe("Rex SSH session", { skip: process.platform === "win32" }, () => {
	let dir: string, machine: RexSshMachineReference;
	const sessions = (file: string, ...entries: Array<[string, string]>) => fs.writeFileSync(path.join(dir, file), JSON.stringify({ sessions: entries.map(([id, label]) => ({ session_id: id, label })) }));
	const calls = () => fs.readFileSync(path.join(dir, "calls"), "utf8").trim().split("\n");
	// The remote machine is this one: the access runs the same scripts SSH would send, and finds the fake rex through REX_BIN_DIR.
	const create = () => openRexPlacedRun(machine, "run_session_test", { sshAccess: localMachineAccess({ env: { PATH: "/usr/bin:/bin", HOME: dir, REX_BIN_DIR: dir, FAKE_REX_DIR: dir } }) });
	beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "rex-ssh-session-")); fs.writeFileSync(path.join(dir, "rex"), FAKE_REX, { mode: 0o755 }); machine = { provider: "rex", id: "workmac", target: "workmac.example", cwd: dir }; });
	afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

	it("creates the subagents session once when there is none, and opens in it with the real remote cwd", async () => {
		sessions("sessions.json", ["session:mine", "brave-strait"]); sessions("after-new.json", ["session:mine", "brave-strait"], ["session:new", "subagents"]);
		const context = await create();
		try {
			assert.equal(context.connection.session, "session:new");
			assert.equal(context.machine.cwd, fs.realpathSync(dir));
			assert.equal(calls().filter((call) => call.endsWith(" new subagents --json")).length, 1);
		} finally { await context.connection.close(); context.removeRuntime(); }
	});

	it("reuses one subagents session and refuses when the label is not unique, also right after creating it", async () => {
		sessions("sessions.json", ["session:s1", "subagents"]);
		const context = await create();
		await context.connection.close(); context.removeRuntime();
		assert.equal(context.connection.session, "session:s1");
		assert.ok(!calls().some((call) => call.includes(" new ")));
		sessions("sessions.json", ["session:s1", "subagents"], ["session:s2", "subagents"]);
		await assert.rejects(create(), /has 2 sessions labeled subagents/u);
		sessions("sessions.json"); sessions("after-new.json", ["session:new", "subagents"], ["session:other-laptop", "subagents"]);
		await assert.rejects(create(), /has 2 sessions labeled subagents/u);
	});

	it("reconnects only to the recorded session and fails closed, never creating one, once it is gone", async () => {
		sessions("sessions.json", ["session:s1", "subagents"]);
		const context = await create();
		try {
			await assert.rejects(rexPaneHost.connect(machine), /no recorded session/u);
			fs.writeFileSync(path.join(dir, "gone"), "");
			const before = calls().length;
			await assert.rejects(context.host.connect(machine), /session session:s1 no longer exists/u);
			assert.deepEqual(calls().slice(before).filter((call) => !call.includes(" session inspect session:s1 ")), []);
		} finally { await context.connection.close(); context.removeRuntime(); }
	});
});
