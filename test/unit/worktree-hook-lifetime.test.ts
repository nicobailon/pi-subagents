import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createServer } from "node:net";
import { setImmediate } from "node:timers/promises";
import { it } from "node:test";
import { Type } from "typebox";
import { Compile } from "typebox/compile";
import { createWorktrees } from "../../src/runs/shared/worktree.ts";

const addressValidator = Compile(Type.Object({ port: Type.Number() }));

it("keeps an explicitly unbounded real setup hook alive beyond the default thirty seconds", { skip: process.platform === "win32", timeout: 30_000 }, async (t) => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hook-lifetime-"));
	const repo = path.join(directory, "repo");
	fs.mkdirSync(repo);
	const git = (...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args], { cwd: repo, env: process.env, stdio: "ignore" });
	git("init", "--quiet");
	git("commit", "--quiet", "--allow-empty", "-m", "base");
	const server = createServer();
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	assert.ok(addressValidator.Check(address));
	const hook = path.join(directory, "hook.mjs");
	fs.writeFileSync(hook, `#!${process.execPath}\nimport fs from 'node:fs';import net from 'node:net';fs.readFileSync(0,'utf8');const socket=net.createConnection({host:'127.0.0.1',port:${address.port}});socket.on('data',()=>{process.stdout.write(JSON.stringify({syntheticPaths:[]}));socket.end()});`, { mode: 0o755 });
	const controller = new AbortController();
	const connection = once(server, "connection", { signal: controller.signal });
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
	let settled = false;
	const pending = createWorktrees(repo, "unbounded-hook", 1, { provider: "native", baseDir: path.join(directory, "trees"), setupHook: { hookPath: hook, timeoutMs: false }, signal: controller.signal }).finally(() => { settled = true; });
	try {
		const [socket] = await Promise.race([connection, pending.then(() => { throw new Error("Hook completed before release"); })]);
		t.mock.timers.tick(31_000);
		await setImmediate();
		assert.equal(settled, false);
		socket.write("finish");
		const setup = await pending;
		assert.equal(setup.worktrees.length, 1);
	} finally {
		t.mock.timers.reset();
		controller.abort();
		await pending.catch(() => undefined);
		await new Promise<void>((resolve) => server.close(() => resolve()));
		fs.rmSync(directory, { recursive: true, force: true });
	}
});
