import assert from "node:assert/strict";
import * as path from "node:path";
import { describe, it } from "node:test";
import { createAtomicJsonWriter } from "../../src/shared/atomic-json.ts";

class FakeFs {
	files = new Map<string, string>();
	madeDirs: string[] = [];
	renameCalls = 0;
	failRenameCodes: string[] = [];

	mkdirSync(dirPath: string): void {
		this.madeDirs.push(dirPath);
	}

	writeFileSync(filePath: string, contents: string): void {
		this.files.set(filePath, contents);
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
