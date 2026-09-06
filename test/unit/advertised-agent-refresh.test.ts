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
			let activeTools = ["subagent"];
			const pi = new Proxy({
				events: { on() { return () => {}; }, emit() {} },
				on(event, handler) { handlers.set(event, [...(handlers.get(event) ?? []), handler]); },
				registerTool(value) { if (value.name === "subagent") tool = value; },
				getActiveTools() { return activeTools; },
			}, { get(target, key) { return key in target ? target[key] : () => undefined; } });
			register(pi);
			const ctx = {
				cwd, hasUI: false, model: { provider: "test", id: "test" },
				modelRegistry: { getAvailable() { return []; }, getAll() { return []; } },
				sessionManager: { getSessionId() { return "advertised-test"; }, getSessionFile() { return undefined; }, getBranch() { return []; } },
			};
			// Invoke the registered catalog lifecycle hook; unrelated host services are not started by this harness.
			const refresh = (reason = "reload") => handlers.get("session_start").at(-1)({ reason }, ctx);
			const emit = (systemPrompt = "base", selectedTools = activeTools) => {
				const result = handlers.get("before_agent_start").at(-1)({ systemPrompt, systemPromptOptions: { selectedTools: selectedTools ?? undefined } }, ctx);
				return result?.systemPrompt ?? systemPrompt;
			};
			const io = { statSync: 0, readdirSync: 0, readFileSync: 0 };
			const originals = {};
			for (const key of Object.keys(io)) {
				originals[key] = fs[key];
				fs[key] = (...args) => { io[key]++; return originals[key](...args); };
			}
			syncBuiltinESMExports();
			const noIo = (fn) => {
				const before = { ...io };
				const result = fn();
				assert.deepEqual(io, before, "prompt emission must not stat, readdir, or read files");
				return result;
			};
			refresh("startup");
			noIo(() => { for (let i = 0; i < 20; i++) assert.equal(emit(), "base"); });
			for (let i = 0; i < 250; i++) write("hidden-" + i, "hidden-" + i, "hidden", false);
			refresh();
			noIo(() => { for (let i = 0; i < 20; i++) assert.equal(emit(), "base"); });
			write("specialist", "specialist", "Original specialist");
			assert.equal(noIo(() => emit()), "base", "external edits wait for reload");
			refresh();
			let prompt = noIo(() => emit());
			assert.match(prompt, /<name>specialist<\/name>/);
			assert.doesNotMatch(prompt, /hidden-/);
			assert.match(prompt, /Before execution.*action: "list", capabilities: true/);
			assert.equal(noIo(() => emit(prompt, ["read"])), "base");
			activeTools = ["read"];
			assert.equal(noIo(() => emit(prompt, null)), "base");
			activeTools = ["subagent"];
			const ceiling = registerSubagentCapabilityCeiling({ sessionId: "advertised-test", source: "test", ceiling: { allowedAgents: [] } });
			assert.equal(noIo(() => emit(prompt)), "base");
			ceiling.dispose();
			assert.match(noIo(() => emit()), /Original specialist/);
			const manage = async (params) => tool.execute("manage", params, new AbortController().signal, undefined, ctx);
			write("pending", "pending", "External change awaiting refresh");
			await manage({ action: "get", agent: "specialist" });
			assert.doesNotMatch(noIo(() => emit()), /<name>pending<\/name>/, "reads must not refresh");
			await assert.rejects(manage({ action: "update", agent: "specialist", config: { advertise: "invalid" } }), /config.advertise must be a boolean/);
			assert.doesNotMatch(noIo(() => emit()), /<name>pending<\/name>/, "failed mutations must not refresh");
			fs.unlinkSync(path.join(dir, "pending.md"));
			let result = await manage({ action: "update", agent: "specialist", config: { description: "Updated specialist" } });
			assert.notEqual(result.isError, true, JSON.stringify(result));
			assert.match(noIo(() => emit(prompt)), /Updated specialist/);
			assert.match(fs.readFileSync(path.join(dir, "specialist.md"), "utf8"), /advertise: true/);
			result = await manage({ action: "disable", agent: "specialist", agentScope: "user" });
			assert.notEqual(result.isError, true, JSON.stringify(result));
			assert.equal(noIo(() => emit(prompt)), "base");
			result = await manage({ action: "enable", agent: "specialist", agentScope: "user" });
			assert.notEqual(result.isError, true, JSON.stringify(result));
			prompt = noIo(() => emit());
			assert.match(prompt, /Updated specialist/);
			result = await manage({ action: "delete", agent: "specialist", agentScope: "user" });
			assert.notEqual(result.isError, true, JSON.stringify(result));
			assert.equal(noIo(() => emit(prompt)), "base");
			result = await manage({ action: "create", config: { name: "created", description: "Created specialist", systemPrompt: "Act narrowly.", scope: "user", advertise: true } });
			assert.notEqual(result.isError, true, JSON.stringify(result));
			assert.match(noIo(() => emit()), /<name>created<\/name>/);
			result = await manage({ action: "update", agent: "created", config: { name: "renamed" } });
			assert.notEqual(result.isError, true, JSON.stringify(result));
			prompt = noIo(() => emit());
			assert.match(prompt, /<name>renamed<\/name>/);
			assert.doesNotMatch(prompt, /<name>created<\/name>/);
			result = await manage({ action: "update", agent: "renamed", config: { advertise: false } });
			assert.notEqual(result.isError, true, JSON.stringify(result));
			assert.equal(noIo(() => emit(prompt)), "base");
			// Inject a refresh-only read failure after the management file write has succeeded.
			await manage({ action: "update", agent: "renamed", config: { advertise: true } });
			prompt = noIo(() => emit());
			assert.match(prompt, /<name>renamed<\/name>/);
			const writeFile = fs.writeFileSync;
			fs.writeFileSync = (file, ...args) => {
				const result = writeFile(file, ...args);
				if (String(file).endsWith("renamed.md")) writeFile(path.join(home, "settings.json"), "{");
				return result;
			};
			syncBuiltinESMExports();
			result = await manage({ action: "update", agent: "renamed", config: { description: "Persisted despite refresh failure" } });
			assert.notEqual(result.isError, true, "refresh failure must not change the persisted mutation result");
			assert.match(fs.readFileSync(path.join(dir, "renamed.md"), "utf8"), /advertise: true/);
			assert.equal(noIo(() => emit(prompt)), "base", "failed refresh withdraws stale guidance");
			assert.throws(() => refresh(), /Failed to parse settings file/, "reload discovery errors must reach the host");
			fs.writeFileSync = writeFile;
			syncBuiltinESMExports();
			fs.unlinkSync(path.join(home, "settings.json"));
			refresh();
			assert.match(noIo(() => emit()), /<name>renamed<\/name>/);
			await manage({ action: "delete", agent: "renamed", agentScope: "user" });
			write("huge", "a".repeat(100000), "huge name");
			write("escaped-name", "b" + "&".repeat(4000), "escaped huge name");
			for (let i = 0; i < 25; i++) write("opt-" + i, "pkg.opt-" + i, i % 2 ? '<>&"'.repeat(300) : "🦜界".repeat(300));
			refresh();
			prompt = noIo(() => { let result; for (let i = 0; i < 20; i++) result = emit(); return result; });
			const catalog = prompt.slice(prompt.indexOf("<advertised_subagents>"));
			assert.ok(Buffer.byteLength(catalog) <= 12288);
			assert.doesNotMatch(catalog, /<name>[ab]/);
			assert.match(catalog, /&lt;&gt;&amp;&quot;/);
			assert.match(catalog, /not instructions to delegate/);
			assert.match(catalog, /🦜界/);
			assert.doesNotMatch(catalog, /�/);
			assert.match(catalog, /<name>pkg\.opt-\d+<\/name>/);
			assert.match(catalog, /<omitted count="\d+"/);
			for (const file of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, file));
			assert.equal(noIo(() => emit()), prompt, "external removal waits for reload");
			refresh();
			assert.equal(noIo(() => emit(prompt)), "base");
			process.stdout.write("prompt contracts passed; zero prompt-time stat/readdir/readFile calls at 0, 250, and 277 definitions");
		`], { cwd: root, env, encoding: "utf8", timeout: 60_000 });
		assert.match(output, /prompt contracts passed/);
	} finally {
		fs.rmSync(home, { recursive: true, force: true });
	}
});
