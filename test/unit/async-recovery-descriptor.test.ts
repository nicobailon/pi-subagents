import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { readAsyncRecoveryDescriptor } from "../../src/runs/background/async-resume.ts";

describe("async recovery descriptor", () => {
	it("accepts launchContractDigest written by async execution", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-recovery-digest-"));
		try {
			const digest = "launch-contract-digest";
			fs.writeFileSync(path.join(root, "recovery-descriptor.json"), JSON.stringify({
				version: 1,
				launchContractDigest: digest,
				sourceRunId: "run-digest",
				agent: "worker",
				cwd: root,
				systemPromptMode: "replace",
				inheritProjectContext: false,
				inheritSkills: false,
				outputMode: "inline",
				maxSubagentDepth: 2,
				share: false,
			}), "utf-8");

			const descriptor = readAsyncRecoveryDescriptor(root);

			assert.equal(descriptor?.launchContractDigest, digest);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
