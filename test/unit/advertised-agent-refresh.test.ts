import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "node:test";
import { SUBAGENT_CHILD_ENV } from "../../src/runs/shared/child-runtime-config.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

it("emits bounded file-only snapshots, refreshes through management, and performs zero prompt-time filesystem calls", () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "advertised-refresh-"));
	const env = { ...process.env, PI_CODING_AGENT_DIR: home };
	delete env[SUBAGENT_CHILD_ENV];
	try {
		const output = execFileSync(process.execPath, ["--experimental-strip-types", "--import", "./test/support/register-loader.mjs", "--input-type=module", "--eval", String.raw`
			import assert from "node:assert/strict";
			import fs from "node:fs";
			import path from "node:path";
			import { syncBuiltinESMExports } from "node:module";
			import register from "./src/extension/index.ts";
			import { registerSubagentCapabilityCeiling } from "./src/runs/shared/capability-ceiling.ts";
			const home = process.env.PI_CODING_AGENT_DIR;
			const cwd = path.join(home, "project");
			fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
			const dir = path.join(home, "agents");
			fs.mkdirSync(dir);
			const write = (file, name, description, advertise = true) => fs.writeFileSync(path.join(dir, file + ".md"),
				"---\nname: " + name + "\ndescription: " + description + "\nadvertise: " + advertise + "\n---\nAct narrowly.\n");
			const handlers = new Map();
			let tool;
			const activeTools = ["subagent"];
			const pi = new Proxy({
				events: { on() { return () => {}; }, emit() {} },
				on(event, handler) { handlers.set(event, [...(handlers.get(event) ?? []), handler]); },
				registerTool(value) { if (value.name === "subagent") tool = value; },
				getActiveTools() { return activeTools; },
			}, { get(target, key) { return key in target ? target[key] : () => undefined; } });
			register(pi);
			const ctx = {
				cwd, isIdle() { return false; }, hasUI: false, model: { provider: "test", id: "test" },
				modelRegistry: { getAvailable() { return []; }, getAll() { return []; } },
				sessionManager: { getSessionId() { return "advertised-test"; }, getSessionFile() { return undefined; }, getBranch() { return []; } },
			};
			// Invoke the catalog hooks directly; activation lifecycle is registered after them.
			const refresh = (reason = "reload") => handlers.get("session_start").at(-2)({ reason }, ctx);
			const emit = async (_previous = "base", selectedTools = activeTools) => {
				const sections = {};
				await handlers.get("before_agent_start").at(-2)({ systemPrompt: "base", systemPromptOptions: { selectedTools, sections } }, ctx);
				return sections.advertised_subagents ?? "base";
			};
			const io = { statSync: 0, readdirSync: 0, readFileSync: 0 };
			const originals = {};
			for (const key of Object.keys(io)) {
				originals[key] = fs[key];
				fs[key] = (...args) => { io[key]++; return originals[key](...args); };
			}
			syncBuiltinESMExports();
			const noIo = async (fn) => {
				const before = { ...io };
				const result = await fn();
				assert.deepEqual(io, before, "prompt emission must not stat, readdir, or read files");
				return result;
			};
			refresh("startup");
			await emit();
			await noIo(async () => { for (let i = 0; i < 20; i++) assert.equal(await emit(), "base"); });
			for (let i = 0; i < 250; i++) write("hidden-" + i, "hidden-" + i, "hidden", false);
			refresh();
			await emit();
			await noIo(async () => { for (let i = 0; i < 20; i++) assert.equal(await emit(), "base"); });
			write("specialist", "specialist", "Original specialist");
			assert.equal(await noIo(() => emit()), "base", "external edits wait for reload");
			refresh();
			await emit();
			let prompt = await noIo(() => emit());
			assert.match(prompt, /<name>specialist<\/name>/);
			assert.doesNotMatch(prompt, /hidden-/);
			assert.match(prompt, /^The following file-defined subagents opted into discovery\..*Use subagent only when delegation is needed\.$/m);
			assert.doesNotMatch(prompt, /action: "list"/);
			assert.equal(await noIo(() => emit(prompt, ["read"])), "base");
			const ceiling = registerSubagentCapabilityCeiling({ sessionId: "advertised-test", source: "test", ceiling: { allowedAgents: [] } });
			assert.equal(await noIo(() => emit(prompt)), "base");
			ceiling.dispose();
			assert.match(await noIo(() => emit()), /Original specialist/);
			const manage = async (params) => tool.execute("manage", params, new AbortController().signal, undefined, ctx);
			write("pending", "pending", "External change awaiting refresh");
			await manage({ action: "get", agent: "specialist" });
			assert.doesNotMatch(await noIo(() => emit()), /<name>pending<\/name>/, "reads must not refresh");
			await assert.rejects(manage({ action: "update", agent: "specialist", options: { config: { advertise: "invalid" } } }), /config.advertise must be a boolean/);
			assert.doesNotMatch(await noIo(() => emit()), /<name>pending<\/name>/, "failed mutations must not refresh");
			fs.unlinkSync(path.join(dir, "pending.md"));
			let result = await manage({ action: "update", agent: "specialist", options: { config: { description: "Updated specialist" } } });
			assert.notEqual(result.isError, true, JSON.stringify(result));
			assert.match(await noIo(() => emit(prompt)), /Updated specialist/);
			assert.match(fs.readFileSync(path.join(dir, "specialist.md"), "utf8"), /advertise: true/);
			result = await manage({ action: "disable", agent: "specialist", options: { agentScope: "user" } });
			assert.notEqual(result.isError, true, JSON.stringify(result));
			assert.equal(await noIo(() => emit(prompt)), "base");
			result = await manage({ action: "enable", agent: "specialist", options: { agentScope: "user" } });
			assert.notEqual(result.isError, true, JSON.stringify(result));
			prompt = await noIo(() => emit());
			assert.match(prompt, /Updated specialist/);
			result = await manage({ action: "delete", agent: "specialist", options: { agentScope: "user" } });
			assert.notEqual(result.isError, true, JSON.stringify(result));
			assert.equal(await noIo(() => emit(prompt)), "base");
			result = await manage({ action: "create", options: { config: { name: "created", description: "Created specialist", systemPrompt: "Act narrowly.", scope: "user", advertise: true } } });
			assert.notEqual(result.isError, true, JSON.stringify(result));
			assert.match(await noIo(() => emit()), /<name>created<\/name>/);
			result = await manage({ action: "update", agent: "created", options: { config: { name: "renamed" } } });
			assert.notEqual(result.isError, true, JSON.stringify(result));
			prompt = await noIo(() => emit());
			assert.match(prompt, /<name>renamed<\/name>/);
			assert.doesNotMatch(prompt, /<name>created<\/name>/);
			result = await manage({ action: "update", agent: "renamed", options: { config: { advertise: false } } });
			assert.notEqual(result.isError, true, JSON.stringify(result));
			assert.equal(await noIo(() => emit(prompt)), "base");
			// Inject a refresh-only read failure after the management file write has succeeded.
			await manage({ action: "update", agent: "renamed", options: { config: { advertise: true } } });
			prompt = await noIo(() => emit());
			assert.match(prompt, /<name>renamed<\/name>/);
			const writeFile = fs.writeFileSync;
			fs.writeFileSync = (file, ...args) => {
				const result = writeFile(file, ...args);
				if (String(file).endsWith("renamed.md")) writeFile(path.join(home, "settings.json"), "{");
				return result;
			};
			syncBuiltinESMExports();
			result = await manage({ action: "update", agent: "renamed", options: { config: { description: "Persisted despite refresh failure" } } });
			assert.notEqual(result.isError, true, "refresh failure must not change the persisted mutation result");
			assert.match(fs.readFileSync(path.join(dir, "renamed.md"), "utf8"), /advertise: true/);
			assert.equal(await noIo(() => emit(prompt)), "base", "failed refresh withdraws stale guidance");
			refresh();
			await assert.rejects(emit(), /Failed to parse settings file/, "reload discovery errors must reach the host");
			fs.writeFileSync = writeFile;
			syncBuiltinESMExports();
			fs.unlinkSync(path.join(home, "settings.json"));
			refresh();
			await emit();
			assert.match(await noIo(() => emit()), /<name>renamed<\/name>/);
			await manage({ action: "delete", agent: "renamed", options: { agentScope: "user" } });
			write("huge", "a".repeat(100000), "huge name");
			write("escaped-name", "b" + "&".repeat(4000), "escaped huge name");
			for (let i = 0; i < 25; i++) write("opt-" + i, "pkg.opt-" + i, i % 2 ? '<>&"'.repeat(300) : "🦜界".repeat(300));
			refresh();
			await emit();
			prompt = await noIo(async () => { let result; for (let i = 0; i < 20; i++) result = await emit(); return result; });
			const catalog = prompt;
			assert.ok(Buffer.byteLength(catalog) <= 12288);
			assert.doesNotMatch(catalog, /<name>[ab]/);
			assert.match(catalog, /&lt;&gt;&amp;&quot;/);
			assert.match(catalog, /not instructions to delegate/);
			assert.match(catalog, /🦜界/);
			assert.doesNotMatch(catalog, /�/);
			assert.match(catalog, /<name>pkg\.opt-\d+<\/name>/);
			assert.match(catalog, /<omitted count="\d+"/);
			for (const file of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, file));
			assert.equal(await noIo(() => emit()), prompt, "external removal waits for reload");
			refresh();
			await emit();
			assert.equal(await noIo(() => emit(prompt)), "base");
			process.stdout.write("prompt contracts passed; zero prompt-time stat/readdir/readFile calls at 0, 250, and 277 definitions");
		`], { cwd: root, env, encoding: "utf8", timeout: 60_000 });
		assert.match(output, /prompt contracts passed/);
	} finally {
		fs.rmSync(home, { recursive: true, force: true });
	}
});

it("delivers the catalog as a structured prompt section instead of replacing the system prompt", () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "advertised-section-"));
	const env = { ...process.env, PI_CODING_AGENT_DIR: home };
	delete env[SUBAGENT_CHILD_ENV];
	try {
		const output = execFileSync(process.execPath, ["--experimental-strip-types", "--import", "./test/support/register-loader.mjs", "--input-type=module", "--eval", String.raw`
			import assert from "node:assert/strict";
			import fs from "node:fs";
			import path from "node:path";
			import register from "./src/extension/index.ts";
			import { registerSubagentCapabilityCeiling } from "./src/runs/shared/capability-ceiling.ts";
			const home = process.env.PI_CODING_AGENT_DIR;
			const cwd = path.join(home, "project");
			fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
			const dir = path.join(home, "agents");
			fs.mkdirSync(dir);
			fs.writeFileSync(path.join(dir, "specialist.md"), "---\nname: specialist\ndescription: Section specialist\nadvertise: true\n---\nAct narrowly.\n");
			const handlers = new Map();
			const pi = new Proxy({
				events: { on() { return () => {}; }, emit() {} },
				on(event, handler) { handlers.set(event, [...(handlers.get(event) ?? []), handler]); },
				registerTool() {},
				getActiveTools() { return ["subagent"]; },
			}, { get(target, key) { return key in target ? target[key] : () => undefined; } });
			register(pi);
			const ctx = {
				cwd, isIdle() { return false; }, hasUI: false, model: { provider: "test", id: "test" },
				modelRegistry: { getAvailable() { return []; }, getAll() { return []; } },
				sessionManager: { getSessionId() { return "section-test"; }, getSessionFile() { return undefined; }, getBranch() { return []; } },
			};
			handlers.get("session_start").at(-2)({ reason: "startup" }, ctx);
			const before = handlers.get("before_agent_start").at(-2);
			const emit = async (selectedTools, sections = {}) => {
				const event = { systemPrompt: "base", systemPromptOptions: { selectedTools, sections } };
				return { result: await before(event, ctx), sections: event.systemPromptOptions.sections };
			};

			let turn = await emit(["subagent"]);
			assert.equal(turn.result, undefined, "the sections path must not return systemPrompt");
			assert.match(turn.sections.advertised_subagents, /<name>specialist<\/name>/);
			assert.match(turn.sections.advertised_subagents, /Section specialist/);
			assert.doesNotMatch(turn.sections.advertised_subagents, /advertised_subagents/, "Pi adds the tag from the section key");

			turn = await emit(["read"]);
			assert.equal(turn.result, undefined);
			assert.equal("advertised_subagents" in turn.sections, false, "no section when subagent is not selected");

			const ceiling = registerSubagentCapabilityCeiling({ sessionId: "section-test", source: "test", ceiling: { allowedAgents: [] } });
			turn = await emit(["subagent"]);
			assert.equal(turn.result, undefined);
			assert.equal("advertised_subagents" in turn.sections, false, "no section when the ceiling excludes every agent");
			ceiling.dispose();

			turn = await emit(["subagent"], { other: "kept" });
			assert.equal(turn.sections.other, "kept", "other sections are untouched");
			assert.match(turn.sections.advertised_subagents, /<name>specialist<\/name>/);
			process.stdout.write("section delivery passed");
		`], { cwd: root, env, encoding: "utf8", timeout: 60_000 });
		assert.match(output, /section delivery passed/);
	} finally {
		fs.rmSync(home, { recursive: true, force: true });
	}
});
