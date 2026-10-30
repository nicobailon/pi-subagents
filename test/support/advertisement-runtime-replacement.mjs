import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "advertisement-replacement-"));
const home = path.join(temp, "home");
const project = path.join(temp, "project");
const bin = path.join(temp, "bin");
const root = path.join(temp, "global");
const packageDir = path.join(root, "example");
for (const dir of [home, project, bin, path.join(packageDir, "agents")]) fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({ name: "example", "pi-subagents": { agents: ["agents"] } }));
fs.writeFileSync(path.join(packageDir, "agents", "late.md"), "---\nname: late\ndescription: late\nadvertise: true\n---\nWork.\n");
const pidFile = path.join(temp, "pid");
const exitedFile = path.join(temp, "exited");
const release = path.join(temp, "release");
fs.writeFileSync(path.join(bin, "fake.cjs"), `
const fs = require("node:fs");
process.on("SIGTERM", () => process.exit(0));
process.on("exit", () => fs.writeFileSync(${JSON.stringify(exitedFile)}, "done"));
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
const cap = Date.now() + 8000;
const timer = setInterval(() => {
	if (fs.existsSync(${JSON.stringify(release)}) || Date.now() > cap) {
		clearInterval(timer);
		console.log(${JSON.stringify(root)});
	}
}, 10);
`);
fs.writeFileSync(path.join(bin, "npm"), `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/fake.cjs"\n`, { mode: 0o755 });
Object.assign(process.env, { HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: home, PATH: bin + path.delimiter + process.env.PATH });
delete process.env.PI_OFFLINE;
delete process.env.PI_SUBAGENT_CHILD;
const runtimes = [];
let pid;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

try {
	const { default: register } = await import("../../src/extension/index.ts");
	const { createEventBus } = await import("@earendil-works/pi-coding-agent");
	function runtime() {
		const hooks = new Map();
		const tools = new Map();
		let active = ["subagents_enable"];
		const pi = new Proxy({
			events: createEventBus(),
			on(name, handler) { hooks.set(name, [...(hooks.get(name) ?? []), handler]); },
			registerTool(tool) { tools.set(tool.name, tool); },
			getAllTools() { return [...tools.values()].map(({ name }) => ({ name })); },
			getActiveTools() { return active; },
			setActiveTools(next) { active = next; },
		}, { get: (target, key) => key in target ? target[key] : () => undefined });
		register(pi);
		runtimes.push(hooks);
		return hooks;
	}
	const ctx = {
		cwd: project, isIdle() { return false; }, hasUI: false, model: undefined,
		ui: { setWidget() {}, theme: { fg: (_, text) => text, bg: (_, text) => text, bold: (text) => text } },
		sessionManager: {
			getSessionId: () => "replacement-test", getSessionFile: () => null,
			getEntries: () => [], getBranch: () => [], buildSessionContext: () => ({ messages: [] }),
		},
		modelRegistry: { getAvailable: () => [], getAll: () => [] },
	};
	const old = runtime();
	for (const handler of old.get("session_start")) await handler({ reason: "startup" }, ctx);
	const readyDeadline = Date.now() + 3000;
	while (!fs.existsSync(pidFile) && Date.now() < readyDeadline) await delay(10);
	pid = Number(fs.readFileSync(pidFile, "utf8"));
	const registry = globalThis.__piSubagentRuntimeRegistry;
	const oldEntry = registry.bySessionManager.get(ctx.sessionManager);
	assert.ok(oldEntry);
	const event = { systemPrompt: "base", systemPromptOptions: { selectedTools: ["subagent"], sections: {} } };
	const waiting = old.get("before_agent_start").at(-2)(event, ctx);
	// No shutdown hook: installRuntime itself must retire the old registration.
	process.env.PI_OFFLINE = "1";
	const next = runtime();
	for (const handler of next.get("session_start")) await handler({ reason: "reload" }, ctx);
	assert.notEqual(registry.bySessionManager.get(ctx.sessionManager), oldEntry);
	assert.equal(registry.activeEntries.has(oldEntry), false);
	let watchdog;
	try {
		await Promise.race([waiting, new Promise((_, reject) => {
			watchdog = setTimeout(() => reject(new Error("retired advertisement did not settle before lookup release")), 1000);
		})]);
	} finally { clearTimeout(watchdog); }
	const exitDeadline = Date.now() + 3000;
	while (!fs.existsSync(exitedFile) && Date.now() < exitDeadline) await delay(10);
	assert.equal(fs.existsSync(exitedFile), true, "retired runtime retained owned npm process");
	fs.writeFileSync(release, "release");
	await delay(50);
	assert.equal(event.systemPromptOptions.sections.advertised_subagents, undefined);
	const later = { systemPrompt: "base", systemPromptOptions: { selectedTools: ["subagent"], sections: {} } };
	await old.get("before_agent_start").at(-2)(later, ctx);
	assert.equal(later.systemPromptOptions.sections.advertised_subagents, undefined, "retired runtime republished a catalog");
	console.log("runtime replacement cleaned discovery");
} finally {
	for (const hooks of runtimes) {
		for (const handler of hooks.get("session_shutdown") ?? []) {
			try { await handler({ reason: "exit" }); } catch {}
		}
	}
	if (pid && !fs.existsSync(exitedFile)) {
		try { process.kill(pid); } catch {}
		const deadline = Date.now() + 1000;
		while (!fs.existsSync(exitedFile) && Date.now() < deadline) await delay(10);
	}
	// Preserve the fixture if a child might still write its exit receipt.
	if (!pid || fs.existsSync(exitedFile)) fs.rmSync(temp, { recursive: true, force: true });
}
