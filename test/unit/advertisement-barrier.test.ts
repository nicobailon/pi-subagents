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
		fs.writeFileSync(path.join(bin, "npm"), `#!/bin/sh\ncount=$(cat '${temp}/count' 2>/dev/null || echo 0)\ncount=$((count+1))\necho "$count" > '${temp}/count'\nif [ "$count" = 4 ]; then echo 'private npm failure' >&2; exit 1; fi\nif [ "$count" = 5 ]; then sleep 6; exit 0; fi\nif [ "$count" = 2 ]; then sleep 0.4; else sleep 0.3; fi\nif [ "$count" = 3 ]; then printf '%s\\n' '${newerRoot}'; else printf '%s\\n' '${globalRoot}'; fi\n`);
		fs.chmodSync(path.join(bin, "npm"), 0o755);
		const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`, PI_CODING_AGENT_DIR: path.join(temp, "home"), TEST_PROJECT: path.join(temp, "project") };
		delete env.PI_OFFLINE;
		delete env[SUBAGENT_CHILD_ENV];
		const hostRoot = resolveInstalledPiPackageRoot();
		if (hostRoot) env[PI_CODING_AGENT_PACKAGE_ROOT_ENV] = hostRoot;
		const output = execFileSync(process.execPath, ["--experimental-strip-types", "--import", "./test/support/register-loader.mjs", "--input-type=module", "--eval", String.raw`
			import assert from "node:assert/strict";
			import register from "./src/extension/index.ts";
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
			start({ reason: "reload" }, ctx);
			await new Promise((resolve) => setTimeout(resolve, 50));
			start({ reason: "reload" }, ctx);
			const latest = await before({ systemPrompt: "base", systemPromptOptions: { selectedTools: ["subagent"] } }, ctx);
			assert.match(latest.systemPrompt, /<name>new-specialist<\/name>/);
			assert.doesNotMatch(latest.systemPrompt, /<name>global-specialist<\/name>/);
			await new Promise((resolve) => setTimeout(resolve, 150));
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
