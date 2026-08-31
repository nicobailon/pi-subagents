import assert from "node:assert/strict";
import * as path from "node:path";
import { describe, it } from "node:test";
import { createAtomicJsonWriter } from "../../src/shared/atomic-json.ts";

class FakeFs {
	files = new Map<string, string>();
	madeDirs: string[] = [];
	renameCalls = 0;
	failMkdirCodes: string[] = [];
	failRenameCodes: string[] = [];
	writeOptions = new Map<string, unknown>();
	failCleanup = false;

	mkdirSync(dirPath: string): void {
		this.madeDirs.push(dirPath);
		const failureCode = this.failMkdirCodes.shift();
		if (failureCode) {
			const error = new Error(`mkdir failed with ${failureCode}`) as NodeJS.ErrnoException;
			error.code = failureCode;
			throw error;
		}
	}

	writeFileSync(filePath: string, contents: string, options?: unknown): void {
		this.files.set(filePath, contents);
		this.writeOptions.set(filePath, options);
	}

	renameSync(sourcePath: string, targetPath: string): void {
		this.renameCalls++;
		const failureCode = this.failRenameCodes.shift();
		if (failureCode) {
			const error = new Error(`rename failed with ${failureCode}`) as NodeJS.ErrnoException;
			error.code = failureCode;
			throw error;
		}
		const contents = this.files.get(sourcePath);
		if (contents === undefined) throw new Error(`missing source file: ${sourcePath}`);
		this.files.delete(sourcePath);
		this.files.set(targetPath, contents);
	}

	rmSync(filePath: string): void {
		if (this.failCleanup) throw new Error("cleanup failed");
		this.files.delete(filePath);
	}
}

function createWriter(fakeFs: FakeFs, waits: number[]) {
	return createAtomicJsonWriter({
		fs: fakeFs as any,
		now: () => 12345,
		pid: 678,
		random: () => 0.5,
		retryRenameErrors: true,
		retryDelaysMs: [1, 2, 3],
		wait: (delayMs) => waits.push(delayMs),
	});
}

describe("writeAtomicJson", () => {
	it("retries transient rename failures before replacing the target", () => {
		const fakeFs = new FakeFs();
		fakeFs.failRenameCodes = ["EPERM", "EBUSY"];
		const waits: number[] = [];
		const writeAtomicJson = createWriter(fakeFs, waits);
		const targetPath = path.join("/tmp", "status.json");

		writeAtomicJson(targetPath, { state: "running" });

		assert.equal(fakeFs.renameCalls, 3);
		assert.deepEqual(waits, [1, 2]);
		assert.deepEqual(fakeFs.madeDirs, [path.dirname(targetPath)]);
		assert.equal(fakeFs.files.get(targetPath), JSON.stringify({ state: "running" }, null, 2));
		assert.equal(fakeFs.files.size, 1);
	});

	it("retries transient directory creation failures before writing", () => {
		const fakeFs = new FakeFs();
		fakeFs.failMkdirCodes = ["EPERM", "EACCES"];
		const waits: number[] = [];
		const writeAtomicJson = createWriter(fakeFs, waits);
		const targetPath = path.join("/tmp", "status.json");

		writeAtomicJson(targetPath, { state: "running" });

		assert.equal(fakeFs.renameCalls, 1);
		assert.deepEqual(waits, [1, 2]);
		assert.deepEqual(fakeFs.madeDirs, [path.dirname(targetPath), path.dirname(targetPath), path.dirname(targetPath)]);
		assert.equal(fakeFs.files.get(targetPath), JSON.stringify({ state: "running" }, null, 2));
	});

	it("writes the temporary descriptor with the requested private mode", () => {
		const fakeFs = new FakeFs();
		const writeAtomicJson = createAtomicJsonWriter({
			fs: fakeFs as any,
			now: () => 12345,
			pid: 678,
			random: () => 0.5,
			mode: 0o600,
		});
		const targetPath = path.join("/tmp", "recovery-descriptor.json");

		writeAtomicJson(targetPath, { sourceRunId: "run" });

		assert.deepEqual([...fakeFs.writeOptions.values()], [{ encoding: "utf-8", mode: 0o600 }]);
	});

	it("keeps temporary names below the component limit for long target names", () => {
		const fakeFs = new FakeFs();
		const waits: number[] = [];
		const writeAtomicJson = createWriter(fakeFs, waits);
		const targetPath = path.join("/tmp", `${"x".repeat(250)}.json`);

		writeAtomicJson(targetPath, { state: "running" });

		const [tempPath] = fakeFs.writeOptions.keys();
		assert.ok(tempPath);
		assert.ok(Buffer.byteLength(path.basename(tempPath), "utf-8") <= 255);
		assert.equal(fakeFs.files.get(targetPath), JSON.stringify({ state: "running" }, null, 2));
	});

	it("uses longer default retries for transient Windows rename locks", () => {
		const fakeFs = new FakeFs();
		fakeFs.failRenameCodes = ["EPERM", "EPERM", "EPERM", "EPERM", "EPERM", "EPERM"];
		const waits: number[] = [];
		const writeAtomicJson = createAtomicJsonWriter({
			fs: fakeFs as any,
			now: () => 12345,
			pid: 678,
			random: () => 0.5,
			retryRenameErrors: true,
			wait: (delayMs) => waits.push(delayMs),
		});

		writeAtomicJson(path.join("/tmp", "status.json"), { state: "running" });

		assert.equal(fakeFs.renameCalls, 7);
		assert.deepEqual(waits, [10, 25, 50, 100, 200, 500]);
	});

	it("throws non-retryable rename failures without retrying", () => {
		const fakeFs = new FakeFs();
		fakeFs.failRenameCodes = ["ENOENT"];
		const waits: number[] = [];
		const writeAtomicJson = createWriter(fakeFs, waits);

		assert.throws(() => writeAtomicJson(path.join("/tmp", "status.json"), { state: "running" }), /ENOENT/);
		assert.equal(fakeFs.renameCalls, 1);
		assert.deepEqual(waits, []);
		assert.equal(fakeFs.files.size, 0);
	});

	it("does not let cleanup failures mask a write failure", () => {
		const fakeFs = new FakeFs();
		fakeFs.failRenameCodes = ["ENOSPC"];
		fakeFs.failCleanup = true;
		const writeAtomicJson = createWriter(fakeFs, []);
		assert.throws(() => writeAtomicJson(path.join("/tmp", "status.json"), { state: "running" }), /ENOSPC/);
	});

	it("can ignore cleanup failures after the target is atomically published", () => {
		const fakeFs = new FakeFs();
		fakeFs.failCleanup = true;
		const writeAtomicJson = createAtomicJsonWriter({
			fs: fakeFs as any,
			now: () => 12345,
			pid: 678,
			random: () => 0.5,
			ignoreCleanupErrorAfterSuccess: true,
		});
		const targetPath = path.join("/tmp", "runner-startup-proceed.json");

		assert.doesNotThrow(() => writeAtomicJson(targetPath, { action: "proceed", token: "runner" }));
		assert.equal(fakeFs.files.get(targetPath), JSON.stringify({ action: "proceed", token: "runner" }, null, 2));
	});

	it("cleans up the temp file after retryable failures are exhausted", () => {
		const fakeFs = new FakeFs();
		fakeFs.failRenameCodes = ["EPERM", "EPERM", "EPERM", "EPERM"];
		const waits: number[] = [];
		const writeAtomicJson = createWriter(fakeFs, waits);
		const targetPath = path.join("/tmp", "status.json");

		assert.throws(() => writeAtomicJson(targetPath, { state: "running" }), /EPERM/);
		assert.equal(fakeFs.renameCalls, 4);
		assert.deepEqual(waits, [1, 2, 3]);
		assert.equal(fakeFs.files.has(targetPath), false);
		assert.equal(fakeFs.files.size, 0);
	});
});
