import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { it } from "node:test";
import { FileLeaseBusyError, tryLease, withFileLease } from "../../src/shared/file-lease.ts";

it("withFileLease waits a bounded time for a live owner, then updates once it is released", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-file-lease-"));
	const file = path.join(fs.realpathSync(dir), "history.json");
	const release = tryLease(`${file}.write-lock`);
	assert.ok(release);
	assert.throws(() => withFileLease(file, () => "never", 30), /Timed out waiting for another process to finish updating/);
	release();
	assert.equal(withFileLease(file, () => "updated", 30), "updated");
	assert.equal(fs.existsSync(`${file}.write-lock`), false);
});

it("withFileLease with no wait makes one attempt and reports a busy lease as FileLeaseBusyError", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-file-lease-"));
	const file = path.join(fs.realpathSync(dir), "history.json");
	const release = tryLease(`${file}.write-lock`);
	assert.ok(release);
	assert.throws(() => withFileLease(file, () => "never", 0), (error) => error instanceof FileLeaseBusyError && /Timed out waiting/.test(error.message));
	release();
	assert.equal(withFileLease(file, () => "updated", 0), "updated");
});
