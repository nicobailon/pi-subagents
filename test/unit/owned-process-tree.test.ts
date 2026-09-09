import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { createOwnedProcessTreeController } from "../../src/runs/background/owned-process-tree.ts";

function processIsActive(pid: number): boolean {
	const result = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf-8" });
	return result.status === 0 && Boolean(result.stdout.trim()) && !result.stdout.trim().startsWith("Z");
}

test("owned process tree fails closed when process-group ownership is unsupported", { skip: process.platform !== "win32" }, async () => {
	const proof = await createOwnedProcessTreeController(999_999).terminate();
	assert.deepEqual(proof, { state: "unknown", reason: "unsupported-platform" });
});

test("owned process tree kills descendants and verifies a TERM-resistant POSIX group", { skip: process.platform === "win32" }, async () => {
	const writer = spawn(process.execPath, ["-e", `
		const { spawn } = require("node:child_process");
		const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" });
		process.on("SIGTERM", () => {});
		process.stdout.write(String(child.pid) + "\\n");
		setInterval(() => {}, 1000);
	`], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
	assert.ok(writer.pid);
	const grandchildPid = await new Promise<number>((resolve, reject) => {
		writer.once("error", reject);
		writer.stdout!.once("data", (chunk) => resolve(Number(String(chunk).trim())));
	});
	const proof = await createOwnedProcessTreeController(writer.pid, { termGraceMs: 50, killVerifyMs: 1000 }).terminate();
	assert.equal(proof.state, "observed", JSON.stringify(proof));
	assert.equal(processIsActive(writer.pid), false);
	assert.equal(processIsActive(grandchildPid), false);

	const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-process-tree-ps-"));
	const realPs = spawnSync("sh", ["-c", "command -v ps"], { encoding: "utf-8" }).stdout.trim();
	const marker = path.join(fixtureDir, "failed-once");
	const originalPath = process.env.PATH;
	try {
		fs.writeFileSync(path.join(fixtureDir, "ps"), `#!/bin/sh\nif [ ! -e "$PI_TEST_PS_MARKER" ]; then\n  : > "$PI_TEST_PS_MARKER"\n  exit 1\nfi\nexec "$PI_TEST_REAL_PS" "$@"\n`);
		fs.chmodSync(path.join(fixtureDir, "ps"), 0o755);
		process.env.PATH = `${fixtureDir}${path.delimiter}${originalPath ?? ""}`;
		process.env.PI_TEST_PS_MARKER = marker;
		process.env.PI_TEST_REAL_PS = realPs;
		const enumerationFailureWriter = spawn(process.execPath, ["-e", `
			process.on("SIGTERM", () => {});
			process.stdout.write("ready\\n");
			setInterval(() => {}, 1000);
		`], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
		assert.ok(enumerationFailureWriter.pid);
		await new Promise<void>((resolve, reject) => {
			enumerationFailureWriter.once("error", reject);
			enumerationFailureWriter.stdout!.once("data", () => resolve());
		});
		const termGraceMs = 50;
		const startedAt = Date.now();
		const failedProof = await createOwnedProcessTreeController(enumerationFailureWriter.pid, { termGraceMs, killVerifyMs: 1000 }).terminate();
		assert.ok(Date.now() - startedAt >= termGraceMs, "enumeration failure still waits through the TERM grace before SIGKILL");
		assert.equal(failedProof.state, "observed", JSON.stringify(failedProof));
		assert.equal(processIsActive(enumerationFailureWriter.pid), false);
	} finally {
		process.env.PATH = originalPath;
		delete process.env.PI_TEST_PS_MARKER;
		delete process.env.PI_TEST_REAL_PS;
		fs.rmSync(fixtureDir, { recursive: true, force: true });
	}
});

test("owned process tree does not claim observed while a detached descendant remains", { skip: process.platform === "win32" }, async () => {
	const writer = spawn(process.execPath, ["-e", `
		const { spawn } = require("node:child_process");
		const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
		process.stdout.write(String(child.pid) + "\\n");
		setInterval(() => {}, 1000);
	`], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
	assert.ok(writer.pid);
	const grandchildPid = await new Promise<number>((resolve, reject) => {
		writer.once("error", reject);
		writer.stdout!.once("data", (chunk) => resolve(Number(String(chunk).trim())));
	});
	try {
		const proof = await createOwnedProcessTreeController(writer.pid, { termGraceMs: 50, killVerifyMs: 1000 }).terminate();
		assert.equal(proof.state, "unknown", JSON.stringify(proof));
		assert.equal(processIsActive(writer.pid), false);
		assert.equal(processIsActive(grandchildPid), true);
	} finally {
		for (const pid of [grandchildPid, writer.pid]) {
			try { process.kill(-pid, "SIGKILL"); } catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
			}
		}
	}
});
