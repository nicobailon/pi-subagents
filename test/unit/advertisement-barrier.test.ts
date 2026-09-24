import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { it } from "node:test";
import { fileURLToPath } from "node:url";
import { resolveInstalledPiPackageRoot } from "../../src/runs/shared/pi-spawn.ts";
import { SUBAGENT_CHILD_ENV } from "../../src/runs/shared/child-runtime-config.ts";
import { PI_CODING_AGENT_PACKAGE_ROOT_ENV } from "../../src/shared/utils.ts";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

it("session startup yields to the event loop and both first advertisements await the complete global catalog", () => {
	const temp = fs.mkdtempSync(path.join(os.tmpdir(), "advertisement-barrier-"));
	try {
		const bin = path.join(temp, "bin");
		const globalRoot = path.join(temp, "global", "node_modules");
		const newerRoot = path.join(temp, "newer", "node_modules");
		const packageDir = path.join(globalRoot, "example");
		const newerPackage = path.join(newerRoot, "example");
		const localDir = path.join(temp, "project", ".pi", "agents");
		fs.mkdirSync(bin, { recursive: true });
		fs.mkdirSync(path.join(packageDir, "agents"), { recursive: true });
		fs.mkdirSync(path.join(newerPackage, "agents"), { recursive: true });
		fs.mkdirSync(localDir, { recursive: true });
		fs.writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({ name: "example", "pi-subagents": { agents: ["agents"] } }));
		fs.writeFileSync(path.join(newerPackage, "package.json"), JSON.stringify({ name: "example", "pi-subagents": { agents: ["agents"] } }));
		const agent = (name: string) => `---\nname: ${name}\ndescription: ${name}\nadvertise: true\n---\nWork.\n`;
		fs.writeFileSync(path.join(packageDir, "agents", "global-specialist.md"), agent("global-specialist"));
		fs.writeFileSync(path.join(newerPackage, "agents", "new-specialist.md"), agent("new-specialist"));
		fs.writeFileSync(path.join(localDir, "local-specialist.md"), agent("local-specialist"));
		const oldDone = path.join(temp, "old-lookup-finished");
		fs.writeFileSync(path.join(bin, "fake-npm.cjs"), `
const fs = require("node:fs");
const counter = ${JSON.stringify(path.join(temp, "count"))};
const count = (fs.existsSync(counter) ? Number(fs.readFileSync(counter, "utf8")) : 0) + 1;
fs.writeFileSync(counter, String(count));
if (count === 5) { console.error("private npm failure"); process.exit(1); }
setTimeout(() => { if (count === 3) fs.writeFileSync(${JSON.stringify(oldDone)}, "done"); if (count !== 6) console.log(count === 4 ? ${JSON.stringify(newerRoot)} : ${JSON.stringify(globalRoot)}); }, count === 6 ? 6000 : count === 3 ? 2500 : count === 2 || count === 4 ? 150 : 300);
`);
		const npm = path.join(bin, process.platform === "win32" ? "npm.cmd" : "npm");
		fs.writeFileSync(npm, process.platform === "win32"
			? `@echo off\r\n"${process.execPath}" "%~dp0fake-npm.cjs" %*\r\n`
			: `#!/bin/sh\nexec "${process.execPath}" '${path.join(bin, "fake-npm.cjs")}' "$@"\n`);
		if (process.platform !== "win32") fs.chmodSync(npm, 0o755);
		const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`, PI_CODING_AGENT_DIR: path.join(temp, "home"), TEST_PROJECT: path.join(temp, "project"), TEST_OLD_DONE: oldDone, APPDATA: path.join(temp, "missing-appdata") };
		delete env.PI_OFFLINE;
		delete env[SUBAGENT_CHILD_ENV];
		const hostRoot = resolveInstalledPiPackageRoot();
		if (hostRoot) env[PI_CODING_AGENT_PACKAGE_ROOT_ENV] = hostRoot;
		const output = execFileSync(process.execPath, ["--experimental-strip-types", "--import", "./test/support/register-loader.mjs", "--input-type=module", "--eval", String.raw`
			import assert from "node:assert/strict";
			import fs from "node:fs";
			import register from "./src/extension/index.ts";
			import { discoverAgents } from "./src/agents/agents.ts";
			import { registerRuntimeAgent } from "./src/agents/runtime-agent-registry.ts";
			const hooks = new Map();
			const tools = new Map();
			let active = ["subagents_enable"];
			const pi = new Proxy({
				events: { on() { return () => {}; }, emit() {} },
				on(name, handler) { hooks.set(name, [...(hooks.get(name) ?? []), handler]); },
				registerTool(tool) { tools.set(tool.name, tool); },
				getAllTools() { return [...tools.values()].map(({ name }) => ({ name })); },
				getActiveTools() { return active; },
				setActiveTools(next) { active = next; },
			}, { get(target, key) { return key in target ? target[key] : () => undefined; } });
			register(pi);
			const ctx = {
				cwd: process.env.TEST_PROJECT, hasUI: false, model: { provider: "test", id: "test" },
				modelRegistry: { getAvailable() { return []; }, getAll() { return []; } },
				sessionManager: { getSessionId() { return "barrier-test"; }, getSessionFile() { return undefined; }, getBranch() { return []; }, buildSessionContext() { return { messages: [] }; } },
			};
			const start = hooks.get("session_start").at(-2);
			const before = hooks.get("before_agent_start").at(-2);
			start({ reason: "startup" }, ctx);
			let tick = false;
			setTimeout(() => { tick = true; }, 10);
			const firstPrompt = before({ systemPrompt: "base", systemPromptOptions: { selectedTools: ["subagent"] } }, ctx);
			const enabled = tools.get("subagents_enable").execute("id", {}, new AbortController().signal, undefined, ctx);
			await new Promise((resolve) => setTimeout(resolve, 50));
			assert.equal(tick, true, "npm did not block event loop");
			let complete = false;
			void firstPrompt.then(() => { complete = true; });
			assert.equal(complete, false, "first prompt returned before global lookup");
			const [prompt, loader] = await Promise.all([firstPrompt, enabled]);
			for (const text of [prompt.systemPrompt, loader.content[0].text]) {
				assert.match(text, /<name>global-specialist<\/name>/);
				assert.match(text, /<name>local-specialist<\/name>/);
			}
			assert.ok(discoverAgents(ctx.cwd, "both").agents.some((agent) => agent.name === "global-specialist"));
			start({ reason: "reload" }, ctx);
			await new Promise((resolve) => setTimeout(resolve, 50));
			const waitingOnOld = before({ systemPrompt: "base", systemPromptOptions: { selectedTools: ["subagent"] } }, ctx);
			const waitingLoader = tools.get("subagents_enable").execute("reload", {}, new AbortController().signal, undefined, ctx);
			start({ reason: "reload" }, ctx);
			const [latest, reloadedLoader] = await Promise.all([waitingOnOld, waitingLoader]);
			assert.equal(fs.existsSync(process.env.TEST_OLD_DONE), false, "old lookup held the new session's prompt");
			assert.match(latest.systemPrompt, /<name>new-specialist<\/name>/);
			assert.match(reloadedLoader.content[0].text, /<name>new-specialist<\/name>/);
			assert.doesNotMatch(latest.systemPrompt, /<name>global-specialist<\/name>/);
			const runtime = await tools.get("subagent").execute("runtime", { agent: "new-specialist", task: "Probe", async: false }, new AbortController().signal, undefined, ctx)
				.then((result) => JSON.stringify(result), (error) => error.message);
			assert.match(runtime, /new-specialist/, "execution must resolve the advertised agent");
			assert.doesNotMatch(runtime, /Unknown agent|not found/i);
			const registration = registerRuntimeAgent({ pi, name: "runtime-test", definition: { description: "Test", systemPrompt: "Test" } });
			const mergedRuntime = await tools.get("subagent").execute("merged-runtime", { agent: "new-specialist", task: "Probe", async: false }, new AbortController().signal, undefined, ctx)
				.then((result) => JSON.stringify(result), (error) => error.message);
			assert.match(mergedRuntime, /new-specialist/, "runtime registry must retain the advertised package agent");
			assert.doesNotMatch(mergedRuntime, /Unknown agent|not found/i);
			registration.dispose();
			await new Promise((resolve) => setTimeout(resolve, 2600));
			assert.equal(fs.existsSync(process.env.TEST_OLD_DONE), true, "old lookup completed");
			const afterStale = await before({ systemPrompt: "base", systemPromptOptions: { selectedTools: ["subagent"] } }, ctx);
			assert.match(afterStale.systemPrompt, /<name>new-specialist<\/name>/);
			assert.doesNotMatch(afterStale.systemPrompt, /<name>global-specialist<\/name>/);
			for (const reason of ["failure", "timeout", "offline"]) {
				if (reason === "offline") process.env.PI_OFFLINE = "1";
				start({ reason: "reload" }, ctx);
				const local = await before({ systemPrompt: "base", systemPromptOptions: { selectedTools: ["subagent"] } }, ctx);
				assert.match(local.systemPrompt, /<name>local-specialist<\/name>/, reason);
				assert.doesNotMatch(local.systemPrompt, /<name>(global|new)-specialist<\/name>/, reason);
			}
			console.log("responsive session_start; complete first prompt and loader");
		`], { cwd: repo, env, encoding: "utf8", timeout: 30_000 });
		assert.match(output, /responsive session_start; complete first prompt and loader/);
	} finally {
		fs.rmSync(temp, { recursive: true, force: true });
	}
});
