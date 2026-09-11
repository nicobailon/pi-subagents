import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const launcherSource = path.resolve("remote-native-host.sh");

function runLauncher(launcher: string, env: NodeJS.ProcessEnv, input = ""): Promise<{ code: number | null; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		const child = spawn(launcher, [], { env, stdio: ["pipe", "pipe", "pipe"] }); let stdout = ""; let stderr = "";
		child.stdout.on("data", (chunk) => { stdout += String(chunk); }); child.stderr.on("data", (chunk) => { stderr += String(chunk); });
		child.on("close", (code) => resolve({ code, stdout, stderr })); child.stdin.end(input);
	});
}

describe("remote native POSIX launcher", { skip: process.platform === "win32" ? "POSIX shell launcher" : false }, () => {
	it("resolves an npm-style symlink and execs an absolute Pi with exact argv and streams", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi remote launcher ")); const packageDir = path.join(root, "node_modules", "pi-subagents"); const binDir = path.join(root, "node_modules", ".bin"); const fakePi = path.join(root, "fake pi"); const argvFile = path.join(root, "argv");
		fs.mkdirSync(path.join(packageDir, "src", "runs", "shared"), { recursive: true }); fs.mkdirSync(binDir, { recursive: true });
		fs.copyFileSync(launcherSource, path.join(packageDir, "remote-native-host.sh")); fs.chmodSync(path.join(packageDir, "remote-native-host.sh"), 0o755); fs.writeFileSync(path.join(packageDir, "src", "runs", "shared", "remote-native-bootstrap.ts"), "");
		fs.symlinkSync(path.join("..", "pi-subagents", "remote-native-host.sh"), path.join(binDir, "pi-subagents-remote-host"));
		fs.writeFileSync(fakePi, `#!/bin/sh\nprintf '%s\\n' "$@" >${JSON.stringify(argvFile)}\ncat\nprintf 'fake-pi-stderr\\n' >&2\nexit 23\n`, { mode: 0o755 });
		try {
			const result = await runLauncher(path.join(binDir, "pi-subagents-remote-host"), { ...process.env, PI_SUBAGENT_PI_BINARY: fakePi }, "rpc-input\n");
			assert.equal(result.code, 23); assert.equal(result.stdout, "rpc-input\n"); assert.equal(result.stderr, "fake-pi-stderr\n");
			assert.deepEqual(fs.readFileSync(argvFile, "utf8").trim().split("\n"), ["--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-session", "--mode", "rpc", "--extension", path.join(fs.realpathSync(packageDir), "src", "runs", "shared", "remote-native-bootstrap.ts")]);
		} finally { fs.rmSync(root, { recursive: true, force: true }); }
	});

	it("rejects a relative override and reports a missing PATH Pi", async () => {
		let result = await runLauncher(launcherSource, { ...process.env, PI_SUBAGENT_PI_BINARY: "relative/pi" }); assert.equal(result.code, 126); assert.match(result.stderr, /must be an absolute path/u);
		result = await runLauncher(launcherSource, { ...process.env, PATH: "/usr/bin:/bin", PI_SUBAGENT_PI_BINARY: "" }); assert.equal(result.code, 127); assert.match(result.stderr, /pi.*not found|not found.*pi/ui);
	});

	it("transfers process ownership and termination directly to Pi", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-remote-signal-")); const fakePi = path.join(dir, "pi"); const ready = path.join(dir, "ready"); const terminated = path.join(dir, "terminated");
		fs.writeFileSync(fakePi, `#!/bin/sh\ntrap 'printf done >${JSON.stringify(terminated)}; exit 42' TERM\nprintf ready >${JSON.stringify(ready)}\nwhile :; do sleep 1; done\n`, { mode: 0o755 });
		try {
			const child = spawn(launcherSource, [], { env: { ...process.env, PI_SUBAGENT_PI_BINARY: fakePi }, stdio: "ignore" });
			for (let i = 0; i < 100 && !fs.existsSync(ready); i++) await new Promise((resolve) => setTimeout(resolve, 10));
			assert.equal(fs.existsSync(ready), true); child.kill("SIGTERM");
			const code = await new Promise<number | null>((resolve) => child.on("close", resolve)); assert.equal(code, 42); assert.equal(fs.readFileSync(terminated, "utf8"), "done");
		} finally { fs.rmSync(dir, { recursive: true, force: true }); }
	});
});
