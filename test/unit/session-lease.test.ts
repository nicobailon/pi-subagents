import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { acquireSessionLease, canonicalSessionFilePath, SessionLeaseConflictError, sessionLeaseDir } from "../../src/runs/shared/session-lease.ts";

function fixture(prefix: string): { root: string; leases: string; sessionFile: string } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	const sessionFile = path.join(root, "session.jsonl");
	fs.writeFileSync(sessionFile, "", "utf-8");
	return { root, leases: path.join(root, "leases"), sessionFile };
}

function request(sessionFile: string, runId: string) {
	return { sessionFile, runId, sourceRunId: "source-run", parentSessionId: "parent-session" };
}

function waitForLine(child: ChildProcess, timeoutMs = 10_000): Promise<string> {
	return new Promise((resolve, reject) => {
		let stdout = "";
		const timer = setTimeout(() => reject(new Error(`Timed out waiting for child output. stderr: ${String(child.stderr?.read() ?? "")}`)), timeoutMs);
		child.stdout?.setEncoding("utf-8");
		child.stdout?.on("data", (chunk: string) => {
			stdout += chunk;
			const newline = stdout.indexOf("\n");
			if (newline === -1) return;
			clearTimeout(timer);
			resolve(stdout.slice(0, newline));
		});
		child.once("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.once("exit", (code) => {
			if (stdout.includes("\n")) return;
			clearTimeout(timer);
			reject(new Error(`Lease child exited with ${code} before reporting acquisition.`));
		});
	});
}

function waitForExit(child: ChildProcess, timeoutMs = 10_000): Promise<void> {
	return new Promise((resolve, reject) => {
		if (child.exitCode !== null) {
			resolve();
			return;
		}
		const timer = setTimeout(() => reject(new Error("Timed out waiting for lease child exit.")), timeoutMs);
		child.once("exit", () => {
			clearTimeout(timer);
			resolve();
		});
		child.once("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
	});
}

function pidIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

async function waitForPidExit(pid: number, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (pidIsAlive(pid)) {
		if (Date.now() > deadline) throw new Error(`Timed out waiting for pid ${pid} to exit.`);
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

describe("session revival leases", () => {
	it("allows one owner and reports its run metadata on contention", () => {
		const { root, leases, sessionFile } = fixture("pi-session-lease-owner-");
		try {
			const first = acquireSessionLease(request(sessionFile, "revive-a"), {
				rootDir: leases,
				pid: 101,
				hostname: "host-a",
				processStartIdentity: "start-a",
				isProcessAlive: () => true,
				getProcessStartIdentity: () => "start-a",
				token: () => "token-a",
				now: () => 1000,
			});
			assert.throws(
				() => acquireSessionLease(request(sessionFile, "revive-b"), {
					rootDir: leases,
					pid: 202,
					hostname: "host-a",
					processStartIdentity: "start-b",
					isProcessAlive: () => true,
					getProcessStartIdentity: () => "start-a",
					token: () => "token-b",
				}),
				(error: unknown) => error instanceof SessionLeaseConflictError
					&& error.owner?.runId === "revive-a"
					&& /already owned by run 'revive-a'/.test(error.message),
			);
			first.release();
			const second = acquireSessionLease(request(sessionFile, "revive-b"), { rootDir: leases, token: () => "token-b" });
			second.release();
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("keys aliases by the canonical session path", { skip: process.platform === "win32" ? "symlink creation is not portable on Windows CI" : undefined }, () => {
		const { root, leases, sessionFile } = fixture("pi-session-lease-canonical-");
		try {
			const alias = path.join(root, "alias.jsonl");
			fs.symlinkSync(sessionFile, alias);
			assert.equal(canonicalSessionFilePath(alias), canonicalSessionFilePath(sessionFile));
			assert.equal(sessionLeaseDir(alias, leases), sessionLeaseDir(sessionFile, leases));
			const lease = acquireSessionLease(request(alias, "alias-owner"), { rootDir: leases });
			assert.throws(() => acquireSessionLease(request(sessionFile, "direct-owner"), { rootDir: leases }), /already owned by run 'alias-owner'/);
			lease.release();
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("allows different canonical session files concurrently", () => {
		const { root, leases, sessionFile } = fixture("pi-session-lease-distinct-");
		try {
			const otherSession = path.join(root, "other.jsonl");
			fs.writeFileSync(otherSession, "", "utf-8");
			const first = acquireSessionLease(request(sessionFile, "revive-a"), { rootDir: leases });
			const second = acquireSessionLease(request(otherSession, "revive-b"), { rootDir: leases });
			first.release();
			second.release();
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("reclaims only demonstrably dead or PID-reused owners", () => {
		const { root, leases, sessionFile } = fixture("pi-session-lease-stale-");
		try {
			const dead = acquireSessionLease(request(sessionFile, "dead-owner"), {
				rootDir: leases,
				pid: 101,
				hostname: "host-a",
				processStartIdentity: "start-dead",
				token: () => "dead-token",
			});
			const recovered = acquireSessionLease(request(sessionFile, "recovered"), {
				rootDir: leases,
				pid: 202,
				hostname: "host-a",
				processStartIdentity: "start-recovered",
				isProcessAlive: (pid) => pid === 101 ? false : true,
				token: () => "recovered-token",
			});
			assert.equal(recovered.owner.runId, "recovered");
			assert.ok(fs.existsSync(`${dead.leaseDir}.stale-dead-token`));
			recovered.release();

			const reused = acquireSessionLease(request(sessionFile, "reused-owner"), {
				rootDir: leases,
				pid: 303,
				hostname: "host-a",
				processStartIdentity: "old-start",
				token: () => "reused-token",
			});
			const afterReuse = acquireSessionLease(request(sessionFile, "after-reuse"), {
				rootDir: leases,
				pid: 404,
				hostname: "host-a",
				processStartIdentity: "new-owner-start",
				isProcessAlive: () => true,
				getProcessStartIdentity: (pid) => pid === 303 ? "new-start" : "new-owner-start",
				token: () => "after-reuse-token",
			});
			assert.equal(afterReuse.owner.runId, "after-reuse");
			assert.ok(fs.existsSync(`${reused.leaseDir}.stale-reused-token`));
			afterReuse.release();
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("does not reclaim a dead runner while its writer is live or still spawning", () => {
		const { root, leases, sessionFile } = fixture("pi-session-lease-writer-state-");
		try {
			const lease = acquireSessionLease(request(sessionFile, "runner-owner"), {
				rootDir: leases,
				pid: 101,
				hostname: "host-a",
				processStartIdentity: "runner-start",
				getProcessStartIdentity: (pid) => pid === 202 ? "writer-start" : undefined,
			});
			lease.updateWriter({ state: "spawning" });
			assert.throws(
				() => acquireSessionLease(request(sessionFile, "spawning-contender"), {
					rootDir: leases,
					pid: 303,
					hostname: "host-a",
					processStartIdentity: "contender-start",
					isProcessAlive: () => false,
				}),
				/already owned by run 'runner-owner'/,
			);

			lease.updateWriter({ state: "running", pid: 202 });
			assert.throws(
				() => acquireSessionLease(request(sessionFile, "writer-contender"), {
					rootDir: leases,
					pid: 303,
					hostname: "host-a",
					processStartIdentity: "contender-start",
					isProcessAlive: (pid) => pid === 202,
					getProcessStartIdentity: (pid) => pid === 202 ? "writer-start" : undefined,
				}),
				/already owned by run 'runner-owner'/,
			);
			lease.release();
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("does not reclaim unverifiable owners on another host", () => {
		const { root, leases, sessionFile } = fixture("pi-session-lease-host-");
		try {
			const lease = acquireSessionLease(request(sessionFile, "remote-owner"), {
				rootDir: leases,
				pid: 101,
				hostname: "host-a",
				processStartIdentity: "start-a",
			});
			assert.throws(
				() => acquireSessionLease(request(sessionFile, "local-owner"), {
					rootDir: leases,
					pid: 202,
					hostname: "host-b",
					processStartIdentity: "start-b",
					isProcessAlive: () => false,
				}),
				/already owned by run 'remote-owner'/,
			);
			lease.release();
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("keeps an orphaned writer exclusive after its runner exits", async () => {
		const { root, leases, sessionFile } = fixture("pi-session-lease-orphan-writer-");
		const helper = fileURLToPath(new URL("../support/session-lease-child.mjs", import.meta.url));
		const releaseSignal = path.join(root, "unused-release");
		let writerPid: number | undefined;
		try {
			const owner = spawn(process.execPath, ["--experimental-strip-types", helper, sessionFile, leases, releaseSignal, "abandon-with-writer"], {
				stdio: ["ignore", "pipe", "pipe"],
			});
			const started = JSON.parse(await waitForLine(owner)) as { acquired?: boolean; writerPid?: number };
			assert.equal(started.acquired, true);
			assert.equal(typeof started.writerPid, "number");
			writerPid = started.writerPid;
			await waitForExit(owner);
			assert.ok(writerPid && pidIsAlive(writerPid));
			assert.throws(() => acquireSessionLease(request(sessionFile, "blocked-by-writer"), { rootDir: leases }), /already owned by run 'child-/);

			process.kill(writerPid, "SIGTERM");
			await waitForPidExit(writerPid);
			const recovered = acquireSessionLease(request(sessionFile, "after-writer-exit"), { rootDir: leases });
			assert.equal(recovered.owner.runId, "after-writer-exit");
			recovered.release();
		} finally {
			if (writerPid && pidIsAlive(writerPid)) process.kill(writerPid, "SIGKILL");
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("enforces ownership across independent Node processes and elects one stale successor", async () => {
		const { root, leases, sessionFile } = fixture("pi-session-lease-process-");
		const helper = fileURLToPath(new URL("../support/session-lease-child.mjs", import.meta.url));
		const releaseSignal = path.join(root, "release");
		let child: ChildProcess | undefined;
		try {
			child = spawn(process.execPath, ["--experimental-strip-types", helper, sessionFile, leases, releaseSignal, "hold"], {
				stdio: ["ignore", "pipe", "pipe"],
			});
			const line = await waitForLine(child);
			const started = JSON.parse(line) as { owner?: { pid?: number; runId?: string } };
			assert.equal(started.owner?.pid, child.pid);
			assert.throws(() => acquireSessionLease(request(sessionFile, "parent-contender"), { rootDir: leases }), /already owned by run 'child-/);
			fs.writeFileSync(releaseSignal, "release", "utf-8");
			await waitForExit(child);
			const afterRelease = acquireSessionLease(request(sessionFile, "parent-after-release"), { rootDir: leases });
			afterRelease.release();

			fs.rmSync(releaseSignal, { force: true });
			const abandoned = spawn(process.execPath, ["--experimental-strip-types", helper, sessionFile, leases, releaseSignal, "abandon"], {
				stdio: ["ignore", "pipe", "pipe"],
			});
			await waitForLine(abandoned);
			await waitForExit(abandoned);

			const releaseA = path.join(root, "release-a");
			const releaseB = path.join(root, "release-b");
			const contenderA = spawn(process.execPath, ["--experimental-strip-types", helper, sessionFile, leases, releaseA, "hold"], { stdio: ["ignore", "pipe", "pipe"] });
			const contenderB = spawn(process.execPath, ["--experimental-strip-types", helper, sessionFile, leases, releaseB, "hold"], { stdio: ["ignore", "pipe", "pipe"] });
			const [lineA, lineB] = await Promise.all([waitForLine(contenderA), waitForLine(contenderB)]);
			const stateA = JSON.parse(lineA) as { acquired?: boolean };
			const stateB = JSON.parse(lineB) as { acquired?: boolean };
			assert.equal(Number(stateA.acquired === true) + Number(stateB.acquired === true), 1);
			fs.writeFileSync(stateA.acquired ? releaseA : releaseB, "release", "utf-8");
			await Promise.all([waitForExit(contenderA), waitForExit(contenderB)]);
			const recovered = acquireSessionLease(request(sessionFile, "parent-after-contenders"), { rootDir: leases });
			recovered.release();
		} finally {
			if (child && child.exitCode === null) child.kill();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
