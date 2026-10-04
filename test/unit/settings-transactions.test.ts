import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fork, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { it } from "node:test";
import { settingsFileLockPath } from "../../src/shared/settings-file.ts";
import { saveBuiltinAgentOverride } from "../../src/agents/agents.ts";

const fixture = fileURLToPath(new URL("../fixtures/settings-transaction-writer.mjs", import.meta.url));

function writer(project: string, target: string, root: string, role: string, operation: string, scope: string, agentDir: string, readOnlyParent = false) {
	const child = fork(fixture, [project, target, root, role, operation, scope, String(readOnlyParent)], {
		execArgv: ["--experimental-strip-types"],
		env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
		stdio: ["ignore", "ignore", "pipe", "ipc"],
	});
	let stderr = "";
	child.stderr!.on("data", (data) => { stderr += data; });
	const messages = new Set<string>();
	const waiters = new Map<string, { resolve: () => void; reject: (error: Error) => void }[]>();
	child.on("message", (message: { type?: string }) => {
		if (!message.type) return;
		messages.add(message.type);
		for (const waiter of waiters.get(message.type) ?? []) waiter.resolve();
	});
	const done = new Promise<void>((resolve, reject) => {
		child.on("error", reject);
		child.on("exit", (code) => {
			if (code === 0) resolve();
			else {
				const error = new Error(stderr || `Settings writer exited ${code}`);
				reject(error);
				for (const group of waiters.values()) for (const waiter of group) waiter.reject(error);
			}
		});
	});
	done.catch(() => {});
	return { child, done, wait: (type: string) => messages.has(type) ? Promise.resolve() : new Promise<void>((resolve, reject) => {
		const group = waiters.get(type) ?? []; group.push({ resolve, reject }); waiters.set(type, group);
	}) };
}

async function race(options: { initial?: object; readOnlyParent?: boolean; alias?: boolean; fileAlias?: boolean; scope?: string; first?: string; second?: string }, check: (settings: any) => void) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "settings-transactions-"));
	const project = path.join(root, "project");
	const config = path.join(project, ".pi");
	fs.mkdirSync(config, { recursive: true });
	const target = path.join(config, "settings.json");
	if (options.initial) fs.writeFileSync(target, JSON.stringify(options.initial));
	let secondProject = project;
	if (options.alias || options.fileAlias) {
		secondProject = path.join(root, "alias");
		if (options.fileAlias) {
			fs.mkdirSync(path.join(secondProject, ".pi"), { recursive: true });
			fs.symlinkSync(target, path.join(secondProject, ".pi", "settings.json"));
		} else fs.symlinkSync(project, secondProject, process.platform === "win32" ? "junction" : "dir");
	}
	const profiles = path.join(config, "profiles", "pi-subagents");
	fs.mkdirSync(profiles, { recursive: true });
	fs.writeFileSync(path.join(profiles, "race.json"), JSON.stringify({ subagents: { agentOverrides: { reviewer: { model: "example/profile" } } } }));
		const scope = options.scope ?? "project";
	const a = writer(project, target, root, "first", options.first ?? "save", scope, config, options.readOnlyParent);
	const b = writer(secondProject, target, root, "second", options.second ?? "save", scope, config, options.readOnlyParent);
	const timeout = setTimeout(() => { a.child.kill("SIGKILL"); b.child.kill("SIGKILL"); }, 12_000);
	try {
		await Promise.all([a.wait("ready"), b.wait("ready")]);
		fs.writeFileSync(path.join(root, "first.start"), "");
		await a.wait("paused");
		fs.writeFileSync(path.join(root, "second.start"), "");
		// Old code finishes the stale write; coordinated code reaches the lock
		// before it can read. Either event releases the first writer.
		await Promise.race([b.wait("lock-attempt"), b.wait("result")]);
		fs.writeFileSync(path.join(root, "release"), "");
		await Promise.all([a.done, b.done]);
		check(JSON.parse(fs.readFileSync(target, "utf-8")));
		assert.equal(fs.existsSync(settingsFileLockPath(path.join(fs.realpathSync.native(path.dirname(target)), path.basename(target)))), false);
	} finally {
		clearTimeout(timeout); a.child.kill("SIGKILL"); b.child.kill("SIGKILL");
		fs.rmSync(root, { recursive: true, force: true });
	}
}

for (const initial of [undefined, { unrelated: true }]) it(`preserves concurrent overrides with ${initial ? "existing" : "new"} settings`, async () => {
	await race({ initial }, (saved) => {
		assert.equal(saved.subagents.agentOverrides.first.disabled, true);
		assert.equal(saved.subagents.agentOverrides.second.disabled, true);
		if (initial) assert.equal(saved.unrelated, true);
	});
});
it("coordinates directory aliases", async () => race({ alias: true, initial: {} }, (saved) => {
	assert.deepEqual(Object.keys(saved.subagents.agentOverrides).sort(), ["first", "second"]);
}));
it("coordinates settings-file aliases", { skip: process.platform === "win32" }, async () => race({ fileAlias: true, initial: {} }, (saved) => {
	assert.deepEqual(Object.keys(saved.subagents.agentOverrides).sort(), ["first", "second"]);
}));
it("preserves concurrent changes to different override fields", async () => race({ initial: {}, first: "merge", second: "merge" }, (saved) => {
	assert.deepEqual(saved.subagents.agentOverrides.reviewer, { model: "example/model", thinking: "high" });
}));
it("keeps removals when another override is saved", async () => race({ initial: { subagents: { agentOverrides: { first: { disabled: true } } } }, first: "remove" }, (saved) => {
	assert.equal(saved.subagents.agentOverrides.first, undefined);
	assert.equal(saved.subagents.agentOverrides.second.disabled, true);
}));
it("keeps field removal when another field is merged", async () => race({ initial: { subagents: { agentOverrides: { reviewer: { disabled: true, model: "example/model" } } } }, first: "remove-field", second: "merge" }, (saved) => {
	assert.equal(saved.subagents.agentOverrides.reviewer.disabled, undefined);
	assert.equal(saved.subagents.agentOverrides.reviewer.thinking, "high");
}));
it("coordinates watchdog and agent settings", async () => race({ initial: {}, scope: "user", first: "watchdog" }, (saved) => {
	assert.equal(saved.subagents.watchdog.enabled, true);
	assert.equal(saved.subagents.agentOverrides.second.disabled, true);
}));
it("profile application retains concurrent watchdog changes", async () => race({ initial: {}, scope: "user", first: "watchdog", second: "profile" }, (saved) => {
	assert.equal(saved.subagents.watchdog.enabled, true);
	assert.equal(saved.subagents.agentOverrides.reviewer.model, "example/profile");
}));
it("reports contention without overwriting settings", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "settings-busy-"));
	try {
		fs.mkdirSync(path.join(root, ".pi"));
		const file = path.join(root, ".pi", "settings.json");
		fs.writeFileSync(file, "{}");
		const lock = settingsFileLockPath(fs.realpathSync.native(file));
		fs.mkdirSync(lock, { recursive: true });
		const started = Date.now();
		assert.throws(() => saveBuiltinAgentOverride(root, "reviewer", "project", { disabled: true }), (error: any) => error.code === "ELOCKED");
		assert.ok(Date.now() - started < 1000);
		assert.equal(fs.readFileSync(file, "utf-8"), "{}");
	} finally { fs.rmSync(root, { recursive: true, force: true }); }
});

it("honors the host's zero retry budget without waiting", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "settings-no-wait-"));
	try {
		const file = path.join(root, "settings.json"); fs.mkdirSync(`${file}.lock`);
		const moduleUrl = new URL("../../src/shared/file-write-lock.ts", import.meta.url).href;
		const source = `
import assert from "node:assert/strict";
const { withFileWriteLock } = await import(${JSON.stringify(moduleUrl)});
let waits = 0;
Atomics.wait = () => { waits++; return "timed-out"; };
assert.throws(() => withFileWriteLock(${JSON.stringify(file)}, () => {}), error => error.code === "ELOCKED");
assert.equal(waits, 0);
`;
		const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", source], {
			env: { ...process.env, PI_SUBAGENT_FS_RETRY_MAX_TOTAL_MS: "0" }, encoding: "utf-8", timeout: 5000,
		});
		assert.equal(child.status, 0, child.stderr);
	} finally { fs.rmSync(root, { recursive: true, force: true }); }
});

it("coordinates profile and watchdog writes through a read-only settings directory", async () => race({ readOnlyParent: true, initial: {}, scope: "user", first: "watchdog", second: "profile" }, (saved) => {
	assert.equal(saved.subagents.watchdog.enabled, true);
	assert.equal(saved.subagents.agentOverrides.reviewer.model, "example/profile");
}));
