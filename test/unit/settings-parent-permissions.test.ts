import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { it } from "node:test";

const permissions = process.platform !== "win32" && process.getuid?.() !== 0;
for (const operation of ["watchdog", "model", "profile", "override"]) it(`${operation} keeps its existing save contract with a read-only settings directory`, { skip: !permissions }, () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "settings-parent-permissions-"));
	const agentDir = path.join(root, "agent");
	const profileDir = path.join(agentDir, "profiles", "pi-subagents");
	fs.mkdirSync(profileDir, { recursive: true });
	const file = path.join(agentDir, "settings.json");
	fs.writeFileSync(file, JSON.stringify({ unrelated: true })); fs.chmodSync(file, 0o640);
	fs.writeFileSync(path.join(profileDir, "sample.json"), JSON.stringify({ subagents: { agentOverrides: { reviewer: { model: "example/profile" } } } }));
	const before = fs.statSync(file);
	const source = `
const watchdog = await import(${JSON.stringify(new URL("../../src/watchdog/settings.ts", import.meta.url).href)});
const profiles = await import(${JSON.stringify(new URL("../../src/profiles/profiles.ts", import.meta.url).href)});
const agents = await import(${JSON.stringify(new URL("../../src/agents/agents.ts", import.meta.url).href)});
try {
	if (${JSON.stringify(operation)} === "watchdog") watchdog.writeUserWatchdogEnabled(true);
	else if (${JSON.stringify(operation)} === "model") watchdog.writeWatchdogModelSettings({ scope: "user", target: { kind: "main" }, model: "example/model" });
	else if (${JSON.stringify(operation)} === "profile") profiles.applySubagentProfile("sample");
	else agents.saveBuiltinAgentOverride(process.cwd(), "reviewer", "user", { disabled: true });
	process.stdout.write(JSON.stringify({ saved: true }));
} catch (error) { process.stdout.write(JSON.stringify({ code: error.code, message: error.message })); }
`;
	fs.chmodSync(agentDir, 0o555);
	try {
		const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", source], {
			env: { ...process.env, PI_CODING_AGENT_DIR: agentDir }, encoding: "utf-8", timeout: 10_000,
		});
		assert.equal(child.status, 0, child.stderr);
		const result = JSON.parse(child.stdout);
		const saved = JSON.parse(fs.readFileSync(file, "utf-8"));
		assert.equal(saved.unrelated, true);
		assert.equal(fs.statSync(file).mode & 0o777, 0o640);
		assert.equal(fs.statSync(file).ino, before.ino);
		if (operation === "override") { assert.equal(result.code, "EACCES"); assert.equal(saved.subagents, undefined); }
		else {
			assert.equal(result.saved, true, result.message);
			if (operation === "watchdog") assert.equal(saved.subagents.watchdog.enabled, true);
			if (operation === "model") assert.equal(saved.subagents.watchdog.main.model, "example/model");
			if (operation === "profile") assert.equal(saved.subagents.agentOverrides.reviewer.model, "example/profile");
		}
	} finally { fs.chmodSync(agentDir, 0o755); fs.rmSync(root, { recursive: true, force: true }); }
});

it("does not fall back to direct writing after a profile atomic save reports an I/O error", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "settings-profile-eio-"));
	const agentDir = path.join(root, "agent");
	const dir = path.join(agentDir, "profiles", "pi-subagents"); fs.mkdirSync(dir, { recursive: true });
	const file = path.join(agentDir, "settings.json"); const before = '{"unrelated":true}\n'; fs.writeFileSync(file, before);
	fs.writeFileSync(path.join(dir, "sample.json"), JSON.stringify({ subagents: { agentOverrides: {} } }));
	const source = `
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const original = fs.renameSync;
fs.renameSync = (source, destination) => {
	if (destination === ${JSON.stringify(file)}) throw Object.assign(new Error("profile save EIO"), { code: "EIO" });
	return original(source, destination);
}; syncBuiltinESMExports();
const { applySubagentProfile } = await import(${JSON.stringify(new URL("../../src/profiles/profiles.ts", import.meta.url).href)});
assert.throws(() => applySubagentProfile("sample"), error => error.code === "EIO");
`;
	try {
		const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", source], {
			env: { ...process.env, PI_CODING_AGENT_DIR: agentDir }, encoding: "utf-8", timeout: 10_000,
		});
		assert.equal(child.status, 0, child.stderr); assert.equal(fs.readFileSync(file, "utf-8"), before);
	} finally { fs.rmSync(root, { recursive: true, force: true }); }
});
