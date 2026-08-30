import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { readAsyncRecoveryDescriptor } from "../../src/runs/background/async-resume.ts";
import { createRunFanoutBudget } from "../../src/runs/shared/run-fanout-budget.ts";

const budgetDirectories: string[] = [];

function runFanoutBudget(runId: string) {
	const descriptor = createRunFanoutBudget(runId, 64);
	budgetDirectories.push(descriptor.directory);
	return descriptor;
}

afterEach(() => {
	for (const directory of budgetDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("async recovery descriptor", () => {
	it("accepts launchContractDigest written by async execution", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-recovery-digest-"));
		try {
			const digest = "launch-contract-digest";
			fs.writeFileSync(path.join(root, "recovery-descriptor.json"), JSON.stringify({
				version: 1,
				launchContractDigest: digest,
				runFanoutBudget: runFanoutBudget("run-digest"),
				sourceRunId: "run-digest",
				agent: "worker",
				cwd: root,
				systemPromptMode: "replace",
				inheritGlobalContext: false,
				inheritProjectContext: false,
				inheritSkills: false,
				outputMode: "inline",
				context: "fork",
				maxSubagentDepth: 2,
				share: false,
			}), "utf-8");

			const descriptor = readAsyncRecoveryDescriptor(root);

			assert.equal(descriptor?.launchContractDigest, digest);
			assert.equal(descriptor?.context, "fork");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("defaults inheritGlobalContext from inheritProjectContext for descriptors from older versions", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-recovery-legacy-global-context-"));
		try {
			fs.writeFileSync(path.join(root, "recovery-descriptor.json"), JSON.stringify({
				version: 1,
				runFanoutBudget: runFanoutBudget("run-legacy-global-context"),
				sourceRunId: "run-legacy-global-context",
				agent: "worker",
				cwd: root,
				systemPromptMode: "replace",
				inheritProjectContext: true,
				inheritSkills: false,
				outputMode: "inline",
				maxSubagentDepth: 2,
				share: false,
			}), "utf-8");

			const descriptor = readAsyncRecoveryDescriptor(root);

			assert.equal(descriptor?.inheritGlobalContext, true);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("defaults legacy non-parent models to configured origin", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-recovery-legacy-model-origin-"));
		try {
			fs.writeFileSync(path.join(root, "recovery-descriptor.json"), JSON.stringify({
				version: 1,
				runFanoutBudget: runFanoutBudget("run-legacy-model-origin"),
				sourceRunId: "run-legacy-model-origin",
				agent: "worker",
				cwd: root,
				model: "test/missing-primary",
				fallbackModels: ["test/fallback"],
				systemPromptMode: "replace",
				inheritGlobalContext: false,
				inheritProjectContext: false,
				inheritSkills: false,
				outputMode: "inline",
				maxSubagentDepth: 2,
				share: false,
			}), "utf-8");

			const descriptor = readAsyncRecoveryDescriptor(root);

			assert.equal(descriptor?.modelOrigin, "configured");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("defaults legacy parent models to inherited origin", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-recovery-legacy-parent-origin-"));
		try {
			fs.writeFileSync(path.join(root, "recovery-descriptor.json"), JSON.stringify({
				version: 1,
				runFanoutBudget: runFanoutBudget("run-legacy-parent-origin"),
				sourceRunId: "run-legacy-parent-origin",
				agent: "worker",
				cwd: root,
				model: "gateway/parent-model",
				modelOverrideFromParent: true,
				systemPromptMode: "replace",
				inheritGlobalContext: false,
				inheritProjectContext: false,
				inheritSkills: false,
				outputMode: "inline",
				maxSubagentDepth: 2,
				share: false,
			}), "utf-8");

			const descriptor = readAsyncRecoveryDescriptor(root);

			assert.equal(descriptor?.modelOrigin, "inherited");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects unresolved profile context values", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-recovery-bad-context-"));
		try {
			fs.writeFileSync(path.join(root, "recovery-descriptor.json"), JSON.stringify({
				version: 1,
				runFanoutBudget: runFanoutBudget("run-bad-context"),
				sourceRunId: "run-bad-context",
				agent: "worker",
				cwd: root,
				systemPromptMode: "replace",
				inheritGlobalContext: false,
				inheritProjectContext: false,
				inheritSkills: false,
				outputMode: "inline",
				context: "profile",
				maxSubagentDepth: 2,
				share: false,
			}), "utf-8");

			assert.throws(
				() => readAsyncRecoveryDescriptor(root),
				/context is invalid/,
			);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects malformed launchContractDigest values", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-recovery-bad-digest-"));
		try {
			fs.writeFileSync(path.join(root, "recovery-descriptor.json"), JSON.stringify({
				version: 1,
				launchContractDigest: {},
				runFanoutBudget: runFanoutBudget("run-bad-digest"),
				sourceRunId: "run-digest",
				agent: "worker",
				cwd: root,
				systemPromptMode: "replace",
				inheritGlobalContext: false,
				inheritProjectContext: false,
				inheritSkills: false,
				outputMode: "inline",
				maxSubagentDepth: 2,
				share: false,
			}), "utf-8");

			assert.throws(
				() => readAsyncRecoveryDescriptor(root),
				/launchContractDigest must be a non-empty string/,
			);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
