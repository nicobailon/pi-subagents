import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "node:test";
import { SUBAGENT_CHILD_ENV } from "../../src/runs/shared/child-runtime-config.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// Registers the extension, then reads the active_subagents section around one run of this session and one of another.
const script = String.raw`
	import os from "node:os";
	import path from "node:path";
	import register from "./src/extension/index.ts";
	const handlers = new Map();
	const events = { listeners: new Map(), on(name, handler) { this.listeners.set(name, handler); return () => this.listeners.delete(name); }, emit(name, payload) { this.listeners.get(name)?.(payload); } };
	const pi = new Proxy({
		events,
		on(name, handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
		getActiveTools() { return ["subagent"]; },
	}, { get(target, key) { return key in target ? target[key] : () => undefined; } });
	register(pi);
	const ctx = {
		cwd: process.cwd(), isIdle() { return false; }, hasUI: false, model: { provider: "test", id: "test" },
		modelRegistry: { getAvailable() { return []; }, getAll() { return []; } },
		sessionManager: { getSessionId() { return "active-runs"; }, getSessionFile() { return undefined; }, getBranch() { return []; }, getEntries() { return []; }, buildContextEntries() { return []; } },
	};
	for (const handler of handlers.get("session_start")) await handler({ reason: "startup" }, ctx);
	const prompt = async (selectedTools = ["subagent"]) => {
		const sections = {};
		await handlers.get("before_agent_start").at(-1)({ systemPrompt: "base", systemPromptOptions: { selectedTools, sections } }, ctx);
		return sections.active_subagents ?? null;
	};
	const start = (id, sessionId) => events.emit("subagent:async-started", { id, pid: process.pid, sessionId, mode: "single", agent: "researcher", task: "[prompt redacted]", asyncDir: path.join(os.tmpdir(), "active-runs-" + id) });
	const seen = { idle: await prompt() };
	start("foreign-run", "other-session");
	seen.foreign = await prompt();
	start("run-a", "active-runs");
	seen.first = await prompt();
	seen.second = await prompt();
	events.emit("subagent:async-complete", { id: "run-a", sessionId: "active-runs", agent: "researcher", success: true, summary: "done" });
	seen.done = await prompt();
	for (const handler of handlers.get("session_shutdown") ?? []) await handler({ reason: "quit" }, ctx);
	console.log("RESULT " + JSON.stringify(seen));
	process.exit(0);
`;

function promptSections(config: Record<string, unknown>): Record<string, string | null> {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "active-runs-prompt-"));
	try {
		fs.mkdirSync(path.join(home, "extensions", "subagent"), { recursive: true });
		fs.writeFileSync(path.join(home, "extensions", "subagent", "config.json"), JSON.stringify(config));
		const env = { ...process.env, PI_CODING_AGENT_DIR: home };
		delete env[SUBAGENT_CHILD_ENV];
		const output = execFileSync(process.execPath, ["--experimental-strip-types", "--import", "./test/support/register-loader.mjs", "--input-type=module", "--eval", script], { cwd: root, env, encoding: "utf-8" });
		const line = output.split("\n").find((entry) => entry.startsWith("RESULT "));
		assert.ok(line, output);
		return JSON.parse(line.slice("RESULT ".length));
	} finally {
		fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 });
	}
}

it("lists this session's active background runs only when activeRunsPrompt is on", () => {
	const off = promptSections({});
	assert.deepEqual(off, { idle: null, foreign: null, first: null, second: null, done: null });

	const on = promptSections({ activeRunsPrompt: true });
	assert.equal(on.idle, null);
	assert.equal(on.foreign, null, "another session's run is not listed");
	assert.match(on.first ?? "", /active in this session \(1\)/);
	assert.match(on.first ?? "", /^- run-a researcher \(single\)$/m);
	assert.ok(!on.first?.includes("[prompt redacted]"));
	assert.equal(on.second, on.first, "an unchanged run keeps the same section text");
	assert.equal(on.done, null, "a finished run drops the section");
});
