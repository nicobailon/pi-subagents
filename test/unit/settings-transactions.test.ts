import assert from "node:assert/strict";
import { fork } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { it } from "node:test";
import { fileURLToPath } from "node:url";

const fixture = fileURLToPath(new URL("../fixtures/settings-race-writer.mjs", import.meta.url));

function writer(root: string, project: string, target: string, role: string, operation: string, agentDir: string) {
	// Each process gets its own temp root: settings coordination must not depend on sharing one.
	const tempRoot = fs.mkdtempSync(path.join(root, `temp-${role}-`));
	const child = fork(fixture, [project, target, root, role, operation], {
		execArgv: ["--experimental-strip-types"],
		env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_SUBAGENTS_TEMP_ROOT: tempRoot },
		stdio: ["ignore", "ignore", "pipe", "ipc"],
	});
	let stderr = "";
	child.stderr!.on("data", (data) => { stderr += data; });
	const seen = new Set<string>();
	const listeners: Array<() => void> = [];
	child.on("message", (message: { type: string }) => {
		seen.add(message.type);
		for (const listener of listeners) listener();
	});
	const done = new Promise<void>((resolve, reject) => {
		child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(stderr || `${role} writer exited ${code}`)));
	});
	const message = (type: string) => new Promise<void>((resolve) => {
		const check = () => { if (seen.has(type)) resolve(); };
		listeners.push(check);
		check();
	});
	return { child, done, message };
}

/** Pause the first writer mid-save, start the second, and release the first once the second reaches the lease or finishes. */
async function race(options: { first: string; second: string; fileAlias?: boolean }): Promise<any> {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "settings-race-")));
	const project = path.join(root, "project");
	const config = path.join(project, ".pi");
	fs.mkdirSync(path.join(config, "profiles", "pi-subagents"), { recursive: true });
	fs.writeFileSync(path.join(config, "profiles", "pi-subagents", "race.json"), JSON.stringify({ subagents: { agentOverrides: { reviewer: { model: "example/profile" } } } }));
	const target = path.join(config, "settings.json");
	fs.writeFileSync(target, JSON.stringify({ unrelated: true }));
	let secondProject = project;
	if (options.fileAlias) {
		secondProject = path.join(root, "alias");
		fs.mkdirSync(path.join(secondProject, ".pi"), { recursive: true });
		fs.symlinkSync(target, path.join(secondProject, ".pi", "settings.json"));
	}
	const first = writer(root, project, target, "first", options.first, config);
	const second = writer(root, secondProject, target, "second", options.second, config);
	const timeout = setTimeout(() => { first.child.kill("SIGKILL"); second.child.kill("SIGKILL"); }, 20_000);
	try {
		await Promise.all([first.message("ready"), second.message("ready")]);
		fs.writeFileSync(path.join(root, "first.start"), "");
		await first.message("paused");
		fs.writeFileSync(path.join(root, "second.start"), "");
		await Promise.race([second.message("lock-attempt"), second.done]);
		fs.writeFileSync(path.join(root, "release"), "");
		await Promise.all([first.done, second.done]);
		assert.equal(fs.existsSync(`${target}.write-lock`), false);
		return JSON.parse(fs.readFileSync(target, "utf-8"));
	} finally {
		clearTimeout(timeout);
		fs.rmSync(root, { recursive: true, force: true });
	}
}

it("keeps agent overrides saved by two processes at once", async () => {
	const saved = await race({ first: "save", second: "save" });
	assert.equal(saved.unrelated, true);
	assert.equal(saved.subagents.agentOverrides.first.disabled, true);
	assert.equal(saved.subagents.agentOverrides.second.disabled, true);
});

it("keeps a watchdog change made while another process applies a profile", async () => {
	const saved = await race({ first: "watchdog", second: "profile" });
	assert.equal(saved.subagents.watchdog.enabled, true);
	assert.equal(saved.subagents.agentOverrides.reviewer.model, "example/profile");
});

it("coordinates a settings file reached through a symlink", { skip: process.platform === "win32" }, async () => {
	const saved = await race({ first: "save", second: "save", fileAlias: true });
	assert.deepEqual(Object.keys(saved.subagents.agentOverrides).sort(), ["first", "second"]);
});
