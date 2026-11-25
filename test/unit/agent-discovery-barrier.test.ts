import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { it } from "node:test";
import { fileURLToPath } from "node:url";
import { SUBAGENT_CHILD_ENV } from "../../src/runs/shared/child-runtime-config.ts";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

it("session startup yields to the event loop and the first guide and launch await the complete global catalog", () => {
	const temp = fs.mkdtempSync(path.join(os.tmpdir(), "discovery-barrier-"));
	try {
		const fixtureRoot = path.join(temp, "quote's & space");
		const bin = path.join(fixtureRoot, "bin");
		const globalRoot = path.join(fixtureRoot, "global", "node_modules");
		const newerRoot = path.join(fixtureRoot, "newer", "node_modules");
		const packageDir = path.join(globalRoot, "example");
		const newerPackage = path.join(newerRoot, "example");
		const localDir = path.join(fixtureRoot, "project", ".pi", "agents");
		fs.mkdirSync(bin, { recursive: true });
		fs.mkdirSync(path.join(packageDir, "agents"), { recursive: true });
		fs.mkdirSync(path.join(newerPackage, "agents"), { recursive: true });
		fs.mkdirSync(localDir, { recursive: true });
		fs.writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({ name: "example", "pi-subagents": { agents: ["agents"] } }));
		fs.writeFileSync(path.join(newerPackage, "package.json"), JSON.stringify({ name: "example", "pi-subagents": { agents: ["agents"] } }));
		const agent = (name: string) => `---\nname: ${name}\ndescription: ${name}\n---\nWork.\n`;
		fs.writeFileSync(path.join(packageDir, "agents", "global-specialist.md"), agent("global-specialist"));
		fs.writeFileSync(path.join(newerPackage, "agents", "new-specialist.md"), agent("new-specialist"));
		fs.writeFileSync(path.join(localDir, "local-specialist.md"), agent("local-specialist"));
		const oldDone = path.join(temp, "old-lookup-finished");
		const oldPid = path.join(temp, "old-lookup-pid");
		const oldRelease = path.join(temp, "old-lookup-release");
		fs.writeFileSync(path.join(bin, "fake-npm.cjs"), `
const fs = require("node:fs");
const phase = process.env.TEST_NPM_PHASE;
if (phase === "failure") { console.error("private npm failure"); process.exit(1); }
const print = () => { if (phase !== "timeout") console.log(phase === "latest" ? ${JSON.stringify(newerRoot)} : ${JSON.stringify(globalRoot)}); };
if (phase === "old") {
	process.on("SIGTERM", () => process.exit(0));
	process.on("exit", () => fs.writeFileSync(${JSON.stringify(oldDone)}, "done"));
	fs.writeFileSync(${JSON.stringify(oldPid)}, String(process.pid));
	const cap = Date.now() + 30000;
	const poll = setInterval(() => { if (fs.existsSync(${JSON.stringify(oldRelease)}) || Date.now() > cap) { clearInterval(poll); print(); } }, 25);
} else setTimeout(print, phase === "timeout" ? 6000 : phase === "seed" || phase === "latest" ? 150 : 300);
`);
		const npm = path.join(bin, process.platform === "win32" ? "npm.cmd" : "npm");
		fs.writeFileSync(npm, process.platform === "win32"
			? `@echo off\r\n"${process.execPath}" "%~dp0fake-npm.cjs" %*\r\n`
			: `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/fake-npm.cjs" "$@"\n`);
		if (process.platform !== "win32") fs.chmodSync(npm, 0o755);
		const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`, HOME: path.join(temp, "home"), USERPROFILE: path.join(temp, "home"), PI_CODING_AGENT_DIR: path.join(temp, "home"), TEST_PROJECT: path.join(fixtureRoot, "project"), TEST_OLD_DONE: oldDone, TEST_OLD_PID: oldPid, TEST_OLD_RELEASE: oldRelease, TEST_NPM_PHASE: "initial", APPDATA: path.join(temp, "missing-appdata") };
		delete env.PI_OFFLINE;
		delete env[SUBAGENT_CHILD_ENV];
		const output = execFileSync(process.execPath, ["--experimental-strip-types", "--import", "./test/support/register-loader.mjs", "--input-type=module", "--eval", String.raw`
			import assert from "node:assert/strict";
			import fs from "node:fs";
			import register from "./src/extension/index.ts";
			const hooks = new Map();
			const tools = new Map();
			const pi = new Proxy({
				events: { on() { return () => {}; }, emit() {} },
				on(name, handler) { hooks.set(name, [...(hooks.get(name) ?? []), handler]); },
				registerTool(tool) { tools.set(tool.name, tool); },
				getAllTools() { return [...tools.values()].map(({ name }) => ({ name })); },
			}, { get(target, key) { return key in target ? target[key] : () => undefined; } });
			register(pi);
			const ctx = {
				cwd: process.env.TEST_PROJECT, isIdle() { return false; }, hasUI: false, model: { provider: "test", id: "test" },
				modelRegistry: { getAvailable() { return []; }, getAll() { return []; } },
				sessionManager: { getSessionId() { return "barrier-test"; }, getSessionFile() { return undefined; }, getBranch() { return []; }, buildContextEntries() { return []; } },
			};
			const start = (reason) => hooks.get("session_start").at(-1)({ reason }, ctx);
			const guide = async () => (await tools.get("subagent").execute("guide", { action: "guide" }, new AbortController().signal, undefined, ctx)).content[0].text;
			const waitForFile = async (file, message, ms = 3000) => {
				const deadline = Date.now() + ms;
				while (!fs.existsSync(file) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
				assert.equal(fs.existsSync(file), true, message);
			};
			void start("startup");
			let tick = false;
			setTimeout(() => { tick = true; }, 10);
			const firstGuide = guide();
			const firstList = tools.get("subagent").execute("list", { action: "list" }, new AbortController().signal, undefined, ctx);
			await new Promise((resolve) => setTimeout(resolve, 50));
			assert.equal(tick, true, "npm did not block event loop");
			let complete = false;
			void firstGuide.then(() => { complete = true; });
			assert.equal(complete, false, "first guide returned before global lookup");
			const [text, listed] = await Promise.all([firstGuide, firstList]);
			assert.match(text, /- global-specialist/);
			assert.match(text, /- local-specialist/);
			assert.match(JSON.stringify(listed), /global-specialist/);
			for (const handler of hooks.get("turn_start")) handler({ turnIndex: 1 }, ctx);
			const firstRun = await tools.get("subagent").execute("immediate", { agent: "global-specialist", task: "Probe", async: false }, new AbortController().signal, undefined, ctx)
				.then((result) => JSON.stringify(result), (error) => error.message);
			assert.match(firstRun, /global-specialist/);
			assert.doesNotMatch(firstRun, /Unknown agent|not found/i);
			process.env.TEST_NPM_PHASE = "old";
			const oldStarted = Date.now();
			void start("reload");
			await waitForFile(process.env.TEST_OLD_PID);
			const waitingOnOld = guide();
			process.env.TEST_NPM_PHASE = "latest";
			void start("reload");
			const latest = await waitingOnOld;
			assert.ok(Date.now() - oldStarted < 5000, "old lookup held the new session's guide");
			if (process.platform !== "win32") await waitForFile(process.env.TEST_OLD_DONE, "superseded owned lookup must exit without release");
			fs.writeFileSync(process.env.TEST_OLD_RELEASE, "release");
			assert.match(latest, /- new-specialist/);
			assert.doesNotMatch(latest, /- global-specialist/);
			await waitForFile(process.env.TEST_OLD_DONE, "old lookup completed", 15_000);
			process.env.TEST_NPM_PHASE = "failure";
			void start("reload");
			const local = await guide();
			assert.match(local, /- local-specialist/);
			assert.doesNotMatch(local, /- (global|new)-specialist/);
			console.log("responsive session_start; complete first guide");
		`], { cwd: repo, env, encoding: "utf8", timeout: 30_000 });
		assert.match(output, /responsive session_start; complete first guide/);
	} finally {
		fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	}
});
