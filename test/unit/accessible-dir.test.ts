import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ensureAccessibleDir } from "../../src/shared/accessible-dir.ts";

class FakeFs {
	mkdirCalls = 0;
	accessCalls = 0;
	failMkdirCodes: string[] = [];
	failAccessCodes: string[] = [];

	mkdirSync(): void {
		this.mkdirCalls++;
		const failureCode = this.failMkdirCodes.shift();
		if (failureCode) {
			const error = new Error(`mkdir failed with ${failureCode}`) as NodeJS.ErrnoException;
			error.code = failureCode;
			throw error;
		}
	}

	accessSync(): void {
		this.accessCalls++;
		const failureCode = this.failAccessCodes.shift();
		if (failureCode) {
			const error = new Error(`access failed with ${failureCode}`) as NodeJS.ErrnoException;
			error.code = failureCode;
			throw error;
		}
	}
}

describe("ensureAccessibleDir", () => {
	it("retries transient shared-directory mkdir failures before validating access", () => {
		const fakeFs = new FakeFs();
		fakeFs.failMkdirCodes = ["EPERM", "EBUSY"];
		const waits: number[] = [];

		ensureAccessibleDir("/tmp/pi-subagents-user/async-subagent-results", {
			fs: fakeFs as any,
			retryDirectoryErrors: true,
			retryDelaysMs: [1, 2, 3],
			wait: (delayMs) => waits.push(delayMs),
		});

		assert.equal(fakeFs.mkdirCalls, 3);
		assert.equal(fakeFs.accessCalls, 1);
		assert.deepEqual(waits, [1, 2]);
	});

	it("retries transient shared-directory access failures without recreating the directory", () => {
		const fakeFs = new FakeFs();
		fakeFs.failAccessCodes = ["EPERM", "EACCES"];
		const waits: number[] = [];

		ensureAccessibleDir("/tmp/pi-subagents-user/async-subagent-results", {
			fs: fakeFs as any,
			retryDirectoryErrors: true,
			retryDelaysMs: [1, 2, 3],
			wait: (delayMs) => waits.push(delayMs),
		});

		assert.equal(fakeFs.mkdirCalls, 1);
		assert.equal(fakeFs.accessCalls, 3);
		assert.deepEqual(waits, [1, 2]);
	});

	it("throws non-retryable access failures without retrying", () => {
		const fakeFs = new FakeFs();
		fakeFs.failAccessCodes = ["ENOENT"];
		const waits: number[] = [];

		assert.throws(() => ensureAccessibleDir("/tmp/pi-subagents-user/async-subagent-results", {
			fs: fakeFs as any,
			retryDirectoryErrors: true,
			retryDelaysMs: [1, 2, 3],
			wait: (delayMs) => waits.push(delayMs),
		}), /ENOENT/);
		assert.equal(fakeFs.mkdirCalls, 1);
		assert.equal(fakeFs.accessCalls, 1);
		assert.deepEqual(waits, []);
	});
});
