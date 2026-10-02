import assert from "node:assert/strict";
import childProcess from "node:child_process";
import * as fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { readAsyncRecoveryDescriptor } from "../../src/runs/background/async-resume.ts";
import { executeAsyncSingle } from "../../src/runs/background/async-execution.ts";
import { createRunFanoutBudget } from "../../src/runs/shared/run-fanout-budget.ts";
import { DIRS } from "../../src/shared/types.ts";
import { makeAgent } from "../support/helpers.ts";
import { registerRequiredChildExtensions } from "../../src/api/required-child-extensions.ts";

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
	it("rejects a mandatory-policy launch on an external runner before spawning the runner", (t) => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-required-all-"));
		const runId = `required-all-${Date.now().toString(36)}`;
		const asyncDir = path.join(DIRS.async, runId);
		const spawn = t.mock.method(childProcess, "spawn", () => { throw new Error("captured detached spawn"); });
		syncBuiltinESMExports();
		const registration = registerRequiredChildExtensions({ sessionId: "required-all-runners", extensions: [{ id: "host-policy", path: import.meta.filename }], requireForAllRunners: true });
		try {
			const result = executeAsyncSingle(runId, {
				agent: "external", task: "Review", agentConfig: makeAgent("external", { runner: { type: "external-cli", command: process.execPath, args: ["fake.mjs"] } }),
				ctx: { pi: { events: { emit() {} } }, cwd: root, currentSessionId: "required-all-runners" },
				artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
				shareEnabled: false, sessionRoot: path.join(root, "sessions"), maxSubagentDepth: 1,
			});
			assert.equal(result.isError, true);
			assert.match(result.content[0]?.text ?? "", /requires child extensions \(host-policy\) for every runner/u);
			assert.equal(spawn.mock.callCount(), 0);
			assert.equal(fs.existsSync(asyncDir), false);
		} finally {
			registration.dispose();
			t.mock.restoreAll();
			syncBuiltinESMExports();
			fs.rmSync(root, { recursive: true, force: true });
			fs.rmSync(asyncDir, { recursive: true, force: true });
		}
	});

	it("snapshots an explicit empty descendant allowlist before detached spawn", (t) => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-recovery-allowed-agents-"));
		const runId = `recovery-allowed-agents-${Date.now().toString(36)}`;
		const asyncDir = path.join(DIRS.async, runId);
		const spawn = t.mock.method(childProcess, "spawn", () => { throw new Error("captured detached spawn"); });
		syncBuiltinESMExports();
		try {
			const result = executeAsyncSingle(runId, {
				agent: "worker", task: "Coordinate", agentConfig: makeAgent("worker", { allowedAgents: [] }),
				ctx: { pi: { events: { emit() {} } }, cwd: root, currentSessionId: "recovery-allowed-agents" },
				artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
				shareEnabled: false, sessionRoot: path.join(root, "sessions"), maxSubagentDepth: 1, acceptance: false,
			});
			assert.equal(result.isError, true);
			assert.equal(spawn.mock.callCount(), 1);
			assert.deepEqual(readAsyncRecoveryDescriptor(asyncDir)?.allowedAgents, []);
		} finally {
			t.mock.restoreAll();
			syncBuiltinESMExports();
			fs.rmSync(root, { recursive: true, force: true });
			fs.rmSync(asyncDir, { recursive: true, force: true });
		}
	});

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

	it("accepts a safe baseRef in persisted recovery descriptors", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-recovery-base-ref-"));
		try {
			fs.writeFileSync(path.join(root, "recovery-descriptor.json"), JSON.stringify({
				version: 1,
				baseRef: "@/foo",
				runFanoutBudget: runFanoutBudget("run-base-ref"),
				sourceRunId: "run-base-ref",
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
			assert.equal(readAsyncRecoveryDescriptor(root)?.baseRef, "@/foo");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects unsafe baseRef values in persisted recovery descriptors", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-recovery-bad-base-ref-"));
		try {
			for (const baseRef of ["refs/heads/unsafe..ref", "a".repeat(40), "a".repeat(64)] as const) {
				fs.writeFileSync(path.join(root, "recovery-descriptor.json"), JSON.stringify({
					version: 1,
					baseRef,
					runFanoutBudget: runFanoutBudget("run-bad-base-ref"),
					sourceRunId: "run-bad-base-ref",
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
				assert.throws(() => readAsyncRecoveryDescriptor(root), /baseRef must be a valid Git ref/);
			}
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

	it("accepts persisted boolean fast settings and leaves omitted fast unset", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-recovery-fast-"));
		try {
			const base = {
				version: 1,
				runFanoutBudget: runFanoutBudget("run-fast"),
				sourceRunId: "run-fast",
				agent: "worker",
				cwd: root,
				systemPromptMode: "replace",
				inheritGlobalContext: false,
				inheritProjectContext: false,
				inheritSkills: false,
				outputMode: "inline",
				maxSubagentDepth: 2,
				share: false,
			} as const;

			fs.writeFileSync(path.join(root, "recovery-descriptor.json"), JSON.stringify({ ...base, fast: true }), "utf-8");
			assert.equal(readAsyncRecoveryDescriptor(root)?.fast, true);

			fs.writeFileSync(path.join(root, "recovery-descriptor.json"), JSON.stringify({ ...base, fast: false }), "utf-8");
			assert.equal(readAsyncRecoveryDescriptor(root)?.fast, false);

			fs.writeFileSync(path.join(root, "recovery-descriptor.json"), JSON.stringify(base), "utf-8");
			assert.equal(readAsyncRecoveryDescriptor(root)?.fast, undefined);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects non-boolean fast values in persisted recovery descriptors", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-recovery-bad-fast-"));
		try {
			fs.writeFileSync(path.join(root, "recovery-descriptor.json"), JSON.stringify({
				version: 1,
				fast: "true",
				runFanoutBudget: runFanoutBudget("run-bad-fast"),
				sourceRunId: "run-bad-fast",
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
			assert.throws(() => readAsyncRecoveryDescriptor(root), /fast must be a boolean/);
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
