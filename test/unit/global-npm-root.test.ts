import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getEventListeners } from "node:events";
import { afterEach, describe, it } from "node:test";
import { resolveGlobalNpmRoot } from "../../src/agents/global-npm-root.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function fixture(script: string) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "global-npm-root-"));
	dirs.push(dir);
	const bin = path.join(dir, "bin");
	fs.mkdirSync(bin);
	const npm = path.join(bin, process.platform === "win32" ? "npm.cmd" : "npm");
	fs.writeFileSync(npm, process.platform === "win32" ? `@echo off\r\n${script}\r\n` : `#!/bin/sh\n${script}\n`, { mode: 0o755 });
	return { dir, env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` } };
}

function printRoot(root: string): string {
	return process.platform === "win32" ? `echo ${root}` : `printf '%s\\n' '${root}'`;
}

function markAndPrint(marker: string, root: string): string {
	return process.platform === "win32"
		? `echo called > "${marker}"\r\n${printRoot(root)}`
		: `echo called > '${marker}'\n${printRoot(root)}`;
}

describe("resolveGlobalNpmRoot", () => {
	it("skips npm in offline mode", async () => {
		const { dir, env } = fixture("exit 1");
		const marker = path.join(dir, "called");
		const command = path.join(dir, "bin", process.platform === "win32" ? "npm.cmd" : "npm");
		fs.writeFileSync(command, process.platform === "win32" ? `@echo off\r\necho called > "${marker}"\r\n` : `#!/bin/sh\necho called > '${marker}'\n`, { mode: 0o755 });
		assert.equal(await resolveGlobalNpmRoot({ env: { ...env, PI_OFFLINE: "YeS" } }), null);
		assert.equal(fs.existsSync(marker), false);
	});

	it("uses a valid Windows APPDATA root without invoking npm", async () => {
		const { dir, env } = fixture("exit 1");
		const marker = path.join(dir, "called");
		const command = path.join(dir, "bin", process.platform === "win32" ? "npm.cmd" : "npm");
		fs.writeFileSync(command, process.platform === "win32" ? `@echo off\r\necho called > "${marker}"\r\n` : `#!/bin/sh\necho called > '${marker}'\n`, { mode: 0o755 });
		const root = path.join(dir, "appdata", "npm", "node_modules");
		fs.mkdirSync(root, { recursive: true });
		assert.equal(await resolveGlobalNpmRoot({ platform: "win32", env: { ...env, APPDATA: path.join(dir, "appdata") } }), await fs.promises.realpath(root));
		assert.equal(fs.existsSync(marker), false);
	});

	it("falls back to npm for invalid Windows APPDATA and canonicalizes its output", async () => {
		const { dir, env } = fixture("exit 1");
		const root = path.join(dir, "real-root");
		const alias = path.join(dir, "linked-root");
		const marker = path.join(dir, "called");
		fs.mkdirSync(root);
		fs.symlinkSync(root, alias, process.platform === "win32" ? "junction" : "dir");
		const binCommand = path.join(dir, "bin", process.platform === "win32" ? "npm.cmd" : "npm");
		fs.writeFileSync(binCommand, process.platform === "win32" ? `@echo off\r\n${markAndPrint(marker, alias)}\r\n` : `#!/bin/sh\n${markAndPrint(marker, alias)}\n`, { mode: 0o755 });
		const invalidAppData = path.join(dir, "not-a-directory");
		fs.writeFileSync(invalidAppData, "file");
		assert.equal(await resolveGlobalNpmRoot({ platform: "win32", env: { ...env, APPDATA: invalidAppData } }), await fs.promises.realpath(root));
		assert.equal(fs.existsSync(marker), true);
	});

	it("returns null silently when npm fails or produces a nonexistent root", async () => {
		const { env } = fixture(process.platform === "win32" ? "echo optional failure 1>&2\r\nexit /b 1" : "echo optional failure >&2\nexit 1");
		assert.equal(await resolveGlobalNpmRoot({ env }), null);
		const second = fixture(printRoot(path.join(os.tmpdir(), "missing-global-root-2474")));
		assert.equal(await resolveGlobalNpmRoot({ env: second.env }), null);
	});

	it("times out a slow npm command without waiting for its output", async () => {
		const { env } = fixture(process.platform === "win32" ? "ping -n 4 127.0.0.1 > nul" : "sleep 1");
		const started = Date.now();
		assert.equal(await resolveGlobalNpmRoot({ env, timeoutMs: 80 }), null);
		assert.ok(Date.now() - started < 700, "timeout must not wait for a descendant holding stdout open");
	});

	it("terminates the owned npm process on timeout", async () => {
		if (process.platform === "win32") return; // Windows npm.cmd needs a shell.
		const { dir, env } = fixture("exit 1");
		const pidFile = path.join(dir, "npm.pid");
		const executable = path.join(dir, "bin", "npm");
		// sh records its pid at once, where a Node fixture could still be booting when the timeout kills it;
		// exec keeps that pid, so the check below still targets the owned process, not a wrapper.
		fs.writeFileSync(executable, `#!/bin/sh\necho $$ > '${pidFile}'\nexec sleep 30\n`, { mode: 0o755 });
		assert.equal(await resolveGlobalNpmRoot({ env, timeoutMs: 500 }), null);
		const pid = Number(fs.readFileSync(pidFile, "utf8"));
		for (let waited = 0; waited < 5_000; waited += 20) {
			try { process.kill(pid, 0); } catch { break; }
			await new Promise<void>((resolve) => setTimeout(resolve, 20));
		}
		assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }, "timed-out npm must exit");
	});

	it("returns immediately to the event loop while a slow npm command runs", async () => {
		const { dir, env } = fixture(process.platform === "win32" ? "ping -n 2 127.0.0.1 > nul\r\necho %PI_TEST_ROOT%" : "sleep 0.3\nprintf '%s\\n' \"$PI_TEST_ROOT\"");
		const root = path.join(dir, "global-root");
		fs.mkdirSync(root);
		let completed = false;
		const lookup = resolveGlobalNpmRoot({ env: { ...env, PI_TEST_ROOT: root } }).then((result) => {
			completed = true;
			return result;
		});
		await new Promise<void>((resolve) => setTimeout(resolve, 20));
		assert.equal(completed, false, "the lookup should still be in flight");
		assert.equal(await lookup, await fs.promises.realpath(root));
	});
	it("does not launch npm when already cancelled", async () => {
		const { dir, env } = fixture("exit 1");
		const marker = path.join(dir, "called");
		const executable = path.join(dir, "bin", process.platform === "win32" ? "npm.cmd" : "npm");
		fs.writeFileSync(executable, process.platform === "win32" ? `@echo off\r\necho called > "${marker}"\r\n` : `#!/bin/sh\necho called > '${marker}'\n`, { mode: 0o755 });
		const controller = new AbortController();controller.abort();
		assert.equal(await resolveGlobalNpmRoot({ env, signal: controller.signal }), null);
		assert.equal(fs.existsSync(marker), false);
	});

	it("cancels a pending lookup and terminates its owned POSIX process", async () => {
		if (process.platform === "win32") return; // npm.cmd descendants are outside this ownership assertion.
		const { dir, env } = fixture("exit 1");
		const pidFile = path.join(dir, "npm.pid");
		// Shell redirection exposes an empty receipt before echo writes the PID.
		fs.writeFileSync(path.join(dir, "bin", "npm"), `#!/bin/sh\n: > '${pidFile}'\nsleep 0.05\necho $$ > '${pidFile}'\nexec sleep 30\n`, { mode: 0o755 });
		const controller = new AbortController();
		const lookup = resolveGlobalNpmRoot({ env, timeoutMs: 5000, signal: controller.signal });
		try {
			const deadline = Date.now() + 3000;
			let pid: number | undefined;
			while (Date.now() < deadline) {
				try {
					const receipt = fs.readFileSync(pidFile, "utf8");
					const candidate = Number(receipt);
					if (/^[1-9]\d*\n$/.test(receipt) && Number.isSafeInteger(candidate) && candidate > 1) {
						pid = candidate;
						break;
					}
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				}
				await new Promise(resolve => setTimeout(resolve, 10));
			}
			assert.ok(pid !== undefined, "owned npm must publish a complete positive PID");
			controller.abort();
			assert.equal(await lookup, null);
			for (let waited = 0; waited < 3000; waited += 20) {
				try { process.kill(pid, 0); } catch { break; }
				await new Promise(resolve => setTimeout(resolve, 20));
			}
			assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }, `cancelled owned npm ${pid} must exit`);
			assert.equal(getEventListeners(controller.signal, "abort").length, 0);
		} finally { controller.abort(); await lookup; }
	});

	it("removes cancellation listeners after success and timeout", async () => {
		const { dir, env } = fixture("exit 1");
		const root = path.join(dir, "root");fs.mkdirSync(root);
		const executable = path.join(dir, "bin", process.platform === "win32" ? "npm.cmd" : "npm");
		fs.writeFileSync(executable, process.platform === "win32" ? `@echo off\r\n${printRoot(root)}\r\n` : `#!/bin/sh\n${printRoot(root)}\n`, {mode: 0o755});
		const success = new AbortController();
		assert.equal(await resolveGlobalNpmRoot({env, signal: success.signal}), await fs.promises.realpath(root));
		assert.equal(getEventListeners(success.signal, "abort").length, 0);
		success.abort();
		const slow = fixture(process.platform === "win32" ? "ping -n 4 127.0.0.1 > nul" : "exec sleep 2");
		const timeout = new AbortController();
		assert.equal(await resolveGlobalNpmRoot({env: slow.env, timeoutMs: 80, signal: timeout.signal}), null);
		assert.equal(getEventListeners(timeout.signal, "abort").length, 0);
		timeout.abort();
	});

});
