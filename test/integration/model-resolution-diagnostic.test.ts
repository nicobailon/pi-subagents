/**
 * A child whose model comes from an extension-registered provider fails to
 * start when that extension is not loaded into it, and Pi core reports only
 * that the model is unknown. These tests drive the real failure paths for both
 * hosts: a foreground child must be told the ambient-extension rule and its two
 * remedies, and a child that did load the ambient extensions must keep the
 * plain core error.
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createDefaultChildSessionFactory, type PiCodingAgentModule } from "../../src/runs/shared/child-session.ts";
import { clearExclusions } from "../../src/runs/shared/model-exclusions.ts";
import { runSync } from "../../src/runs/foreground/execution.ts";
import { buildRunnerChildLaunch } from "../../src/runs/background/runner-child-launch.ts";
import { runChildSession } from "../../src/runs/background/run-child-session.ts";
import { createTempDir, makeAgent, removeTempDir } from "../support/helpers.ts";

const MODEL = "pengepul/commandcode/deepseek/deepseek-v4.1-flash";
const MODEL_NOT_FOUND = `Model "${MODEL}" not found. Use --list-models to see available models.`;

/** A pi module stub whose model resolver rejects the provider-extension model. */
function unresolvedModelPi(): PiCodingAgentModule {
	return {
		ModelRuntime: { create: async () => ({}) },
		SettingsManager: { create: () => ({}) },
		DefaultResourceLoader: class { async reload() {} },
		SessionManager: { inMemory: () => ({}), create: () => ({}) },
		resolveCliModel: (({ cliModel }: { cliModel: string }) => ({
			error: `Model "${cliModel}" not found. Use --list-models to see available models.`,
		})) as unknown as PiCodingAgentModule["resolveCliModel"],
		createAgentSession: (async () => { throw new Error("The child must not reach session creation."); }) as unknown as PiCodingAgentModule["createAgentSession"],
	} as unknown as PiCodingAgentModule;
}

describe("child model resolution diagnostic", () => {
	let tempDir: string;

	beforeEach(() => {
		// A failed foreground attempt records a short-lived model exclusion, which
		// would otherwise filter the next attempt at the same model.
		clearExclusions();
		tempDir = createTempDir();
	});
	afterEach(() => removeTempDir(tempDir));

	it("explains a foreground model that only an unloaded provider extension serves", async () => {
		const factory = createDefaultChildSessionFactory({ loadPiCodingAgent: async () => unresolvedModelPi() });
		const result = await runSync(tempDir, [makeAgent("provider-model-worker", { model: MODEL })], "provider-model-worker", "Task", {
			runId: "foreground-model-resolution",
			waitToolEnabled: false,
			childSessionFactory: factory,
		});

		assert.equal(result.exitCode, 1);
		assert.equal(result.usage.turns, 0);
		assert.deepEqual(result.messages, []);
		assert.ok(result.error?.startsWith(MODEL_NOT_FOUND), `core error must stay first, got: ${result.error}`);
		assert.match(result.error ?? "", /Agent 'provider-model-worker' ran as a foreground child, which never loads the parent's ambient extensions/);
		assert.match(result.error ?? "", /If 'pengepul\/commandcode\/deepseek\/deepseek-v4\.1-flash' is served by a provider extension, that extension is not loaded for this child/);
		assert.match(result.error ?? "", /must run as background children \(`async: true`\)/);
		assert.match(result.error ?? "", /load the provider extension explicitly with `subagentOnlyExtensions` or `extensions` in the agent frontmatter/);
	});

	it("tells a foreground child that the capability ceiling denied the extension, not the frontmatter", async () => {
		const factory = createDefaultChildSessionFactory({ loadPiCodingAgent: async () => unresolvedModelPi() });
		const result = await runSync(tempDir, [makeAgent("provider-model-worker", { model: MODEL })], "provider-model-worker", "Task", {
			runId: "foreground-model-policy",
			waitToolEnabled: false,
			childSessionFactory: factory,
			capabilityCeiling: { version: 1, denyExtensions: true, sources: ["policy-fixture"] },
		});

		assert.equal(result.exitCode, 1);
		assert.ok(result.error?.startsWith(MODEL_NOT_FOUND), `core error must stay first, got: ${result.error}`);
		assert.match(result.error ?? "", /Capability ceiling from policy-fixture denies extensions/);
		assert.match(result.error ?? "", /`async: true` does not help either/);
		assert.match(result.error ?? "", /Relax the capability ceiling to allow extensions/);
		assert.doesNotMatch(result.error ?? "", /must run as background children/);
	});

	it("keeps the plain model-not-found error for a background child that loaded the ambient extensions", async () => {
		const launch = buildRunnerChildLaunch(
			{ agent: "provider-model-worker", task: "Task" },
			{ cwd: tempDir, id: "runner-model-resolution", flatIndex: 0 },
			{ model: MODEL, sessionEnabled: false, watchdogStatus: () => {} },
		);
		assert.equal(launch.session.ambientExtensions, true, "the guard must exercise the ambient-extensions branch");
		const factory = createDefaultChildSessionFactory({ loadPiCodingAgent: async () => unresolvedModelPi() });
		const run = await runChildSession({ factory, launch, prompt: "Task: Task", appendChildEvent: () => {}, writeOutputLine: () => {} });

		assert.equal(run.exitCode, 1);
		assert.equal(run.error, MODEL_NOT_FOUND);
		assert.equal(run.messages.length, 0);
	});

	it("tells a background child that the capability ceiling denied the extension", async () => {
		const launch = buildRunnerChildLaunch(
			{ agent: "provider-model-worker", task: "Task" },
			{ cwd: tempDir, id: "runner-model-policy", flatIndex: 0, capabilityCeiling: { version: 1, denyExtensions: true, sources: ["policy-fixture"] } },
			{ model: MODEL, sessionEnabled: false, watchdogStatus: () => {} },
		);
		assert.equal(launch.session.ambientExtensions, false, "the ceiling must disable ambient extensions for this launch");
		const factory = createDefaultChildSessionFactory({ loadPiCodingAgent: async () => unresolvedModelPi() });
		const run = await runChildSession({ factory, launch, prompt: "Task: Task", appendChildEvent: () => {}, writeOutputLine: () => {} });

		assert.equal(run.exitCode, 1);
		assert.match(run.error ?? "", /Capability ceiling from policy-fixture denies extensions/);
		assert.match(run.error ?? "", /does not enable ambient loading/);
		assert.match(run.error ?? "", /Relax the capability ceiling to allow extensions/);
	});
});
