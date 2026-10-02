import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { registerRequiredChildExtensions } from "../../src/api/required-child-extensions.ts";
import { assertRequiredChildExtensionsAdmitted, resolveRequiredChildExtensions, snapshotRequiredChildExtensions } from "../../src/shared/required-child-extensions.ts";
import { buildInProcessChildLaunch } from "../../src/runs/shared/child-launch.ts";
import { resolvePiLaunchToolPlan } from "../../src/runs/shared/child-tool-plan.ts";
import { buildRunnerChildLaunch } from "../../src/runs/background/runner-child-launch.ts";

function fixture() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-required-ext-"));
	const file = path.join(dir, "required.mjs");
	fs.writeFileSync(file, "export default () => {};\n");
	return { dir, file };
}

function baseInput(sessionId: string) {
	return { parentSessionId: sessionId, sessionEnabled: false, inheritProjectContext: false, inheritGlobalContext: false, inheritSkills: false, cwd: process.cwd(), childAgentName: "worker", childIndex: 0, host: "parent" as const };
}

describe("required child extension host policy", () => {
	it("registers a canonical immutable snapshot with conflict-safe idempotent disposal", () => {
		const { dir, file } = fixture();
		const sessionId = `required-${Date.now()}-registry`;
		try {
			const handle = registerRequiredChildExtensions({ sessionId, extensions: [{ id: "provider.safe", path: file }] });
			const snapshot = resolveRequiredChildExtensions(sessionId);
			assert.equal(snapshot[0]?.path, fs.realpathSync(file));
			assert.ok(Object.isFrozen(snapshot));
			assert.throws(() => registerRequiredChildExtensions({ sessionId, extensions: [] }), /already registered/);
			handle.dispose(); handle.dispose();
			assert.deepEqual(resolveRequiredChildExtensions(sessionId), []);
			const replacement = registerRequiredChildExtensions({ sessionId, extensions: [{ id: "replacement", path: file }] });
			handle.dispose();
			assert.equal(resolveRequiredChildExtensions(sessionId)[0]?.id, "replacement");
			replacement.dispose();
		} finally { fs.rmSync(dir, { recursive: true, force: true }); }
	});

	it("appends required paths after ordinary resolution and exposes only safe IDs", () => {
		const { dir, file } = fixture();
		const sessionId = `required-${Date.now()}-launch`;
		const handle = registerRequiredChildExtensions({ sessionId, extensions: [{ id: "host-provider", path: file }] });
		try {
			for (const extensions of [undefined, [], ["./optional.ts"]]) {
				const launch = buildInProcessChildLaunch({ ...baseInput(sessionId), extensions });
				assert.equal(launch.session.extensionPaths.at(-1), fs.realpathSync(file));
				assert.deepEqual(launch.launchResolvedExtensions.required, ["host-provider"]);
				assert.equal(JSON.stringify(launch.launchResolvedExtensions).includes(file), false);
			}
		} finally { handle.dispose(); fs.rmSync(dir, { recursive: true, force: true }); }
	});

	it("fails closed when the capability ceiling denies a nonempty required set", () => {
		assert.throws(() => resolvePiLaunchToolPlan({ requiredExtensions: [{ id: "required", path: "/tmp/required.mjs" }], capabilityCeiling: { version: 1, denyExtensions: true, sources: ["host-test"] } }), /denies extensions.*requires: required/);
	});

	it("rejects malformed serialized snapshots at the shared launch boundary", () => {
		assert.throws(() => buildInProcessChildLaunch({ ...baseInput("serialized"), requiredExtensions: [{ id: "unsafe id", path: "/tmp/provider.mjs" }] }), /safe id/);
		assert.throws(() => buildInProcessChildLaunch({ ...baseInput("serialized"), requiredExtensions: [{ id: "provider", path: "relative.mjs" }] }), /absolute/);
	});

	it("uses a serialized snapshot in a detached runner after registration disposal", () => {
		const { dir, file } = fixture();
		const sessionId = `required-${Date.now()}-runner`;
		const handle = registerRequiredChildExtensions({ sessionId, extensions: [{ id: "runner-provider", path: file }] });
		const snapshot = resolveRequiredChildExtensions(sessionId);
		handle.dispose();
		try {
			const launch = buildRunnerChildLaunch({ agent: "worker", task: "test", inheritProjectContext: false, inheritGlobalContext: false, inheritSkills: false, requiredExtensions: snapshot }, { cwd: process.cwd(), id: "run", flatIndex: 0 }, { sessionEnabled: false, watchdogStatus() {} });
			assert.equal(launch.session.extensionPaths.at(-1), fs.realpathSync(file));
			assert.deepEqual(launch.launchResolvedExtensions.required, ["runner-provider"]);
		} finally { fs.rmSync(dir, { recursive: true, force: true }); }
	});

	it("propagates the root snapshot through nested child runtime inheritance", () => {
		const { dir, file } = fixture();
		try {
			const requiredExtensions = Object.freeze([Object.freeze({ id: "nested-provider", path: fs.realpathSync(file) })]);
			const parent = buildInProcessChildLaunch({ ...baseInput("unregistered-root"), requiredExtensions, allowNestedSubagents: true });
			const nested = buildInProcessChildLaunch({ ...baseInput("nested-child"), inherited: { depth: 1, requiredExtensions: parent.config.requiredExtensions } });
			assert.equal(nested.session.extensionPaths.at(-1), fs.realpathSync(file));
			assert.deepEqual(nested.launchResolvedExtensions.required, ["nested-provider"]);
		} finally { fs.rmSync(dir, { recursive: true, force: true }); }
	});
});

describe("require-for-all-runners admission", () => {
	it("stamps requireForAllRunners on every entry and round-trips it through snapshot validation", () => {
		const { dir, file } = fixture();
		const sessionId = `required-${Date.now()}-all-runners`;
		const handle = registerRequiredChildExtensions({ sessionId, extensions: [{ id: "host-policy", path: file }], requireForAllRunners: true });
		try {
			const snapshot = resolveRequiredChildExtensions(sessionId);
			assert.equal(snapshot[0]?.requireForAllRunners, true);
			assert.equal(snapshotRequiredChildExtensions(snapshot, "requiredExtensions")[0]?.requireForAllRunners, true);
			assert.throws(() => snapshotRequiredChildExtensions([{ id: "host-policy", path: fs.realpathSync(file), requireForAllRunners: false }], "requiredExtensions"), /must be true when present/);
		} finally { handle.dispose(); fs.rmSync(dir, { recursive: true, force: true }); }
	});

	it("admits every runner for a legacy registration but rejects non-native routes for an opt-in one", () => {
		const legacy = snapshotRequiredChildExtensions([{ id: "legacy", path: "/tmp/legacy.mjs" }], "requiredExtensions");
		assertRequiredChildExtensionsAdmitted([legacy], { agent: "worker", runnerType: "external-cli" });
		assertRequiredChildExtensionsAdmitted([legacy], { agent: "worker", runnerType: "pi", machine: "workmac" });
		const optIn = snapshotRequiredChildExtensions([{ id: "policy", path: "/tmp/policy.mjs", requireForAllRunners: true }], "requiredExtensions");
		assertRequiredChildExtensionsAdmitted([optIn], { agent: "worker", runnerType: "pi" });
		assertRequiredChildExtensionsAdmitted([undefined, []], { agent: "worker", runnerType: "external-job" });
		assert.throws(() => assertRequiredChildExtensionsAdmitted([optIn], { agent: "worker", runnerType: "external-cli" }), /requires child extensions \(policy\) for every runner/);
		assert.throws(() => assertRequiredChildExtensionsAdmitted([optIn], { agent: "worker", runnerType: "external-job" }), /cannot run on runner.type='external-job'/);
		assert.throws(() => assertRequiredChildExtensionsAdmitted([optIn], { agent: "worker", runnerType: "pi", machine: "workmac" }), /cannot run on machine 'workmac'/);
	});
});
