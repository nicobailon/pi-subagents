import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { isRetryableAtomicRenameError, writeAtomicJson } from "../../src/shared/atomic-json.ts";

function tempDir(prefix: string): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe("writeAtomicJson", () => {
	it("retries transient rename failures before writing the final JSON", () => {
		const root = tempDir("pi-atomic-json-retry-");
		try {
			const filePath = path.join(root, "status.json");
			let attempts = 0;
			writeAtomicJson(filePath, { ok: true }, {
				delayMsForAttempt: () => 0,
				renameSync: (src, dest) => {
					attempts++;
					if (attempts < 3) {
						const error = Object.assign(new Error("transient rename failure"), { code: attempts === 1 ? "EPERM" : "EBUSY" });
						throw error;
					}
					fs.renameSync(src, dest);
				},
			});

			assert.equal(attempts, 3);
			assert.deepEqual(JSON.parse(fs.readFileSync(filePath, "utf-8")), { ok: true });
			assert.deepEqual(fs.readdirSync(root).filter((entry) => entry.includes(".tmp")), []);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("does not retry non-transient rename failures and removes the temp file", () => {
		const root = tempDir("pi-atomic-json-nonretry-");
		try {
			const filePath = path.join(root, "status.json");
			let attempts = 0;
			assert.throws(
				() => writeAtomicJson(filePath, { ok: false }, {
					delayMsForAttempt: () => 0,
					renameSync: () => {
						attempts++;
						throw Object.assign(new Error("disk failed"), { code: "EIO" });
					},
				}),
				/disk failed/,
			);

			assert.equal(attempts, 1);
			assert.equal(fs.existsSync(filePath), false);
			assert.deepEqual(fs.readdirSync(root).filter((entry) => entry.includes(".tmp")), []);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("classifies only Windows-style transient rename errors as retryable", () => {
		for (const code of ["EPERM", "EBUSY", "EACCES"]) {
			assert.equal(isRetryableAtomicRenameError({ code }), true);
		}
		for (const code of ["EIO", "ENOENT", undefined]) {
			assert.equal(isRetryableAtomicRenameError({ code }), false);
		}
	});
});
