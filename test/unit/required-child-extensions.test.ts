import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { registerRequiredChildExtensions } from "../../src/api/required-child-extensions.ts";
import { assertRequiredChildExtensionsAdmitted, resolveRequiredChildExtensions, snapshotRequiredChildExtensions } from "../../src/shared/required-child-extensions.ts";
import { buildInProcessChildLaunch } from "../../src/runs/shared/child-launch.ts";
import { resolvePiLaunchToolPlan } from "../../src/runs/shared/child-tool-plan.ts";
import { buildRunnerChildLaunch } from "../../src/runs/background/runner-child-launch.ts";
import { createDefaultChildSessionFactory, type ChildSessionLaunch, type PiCodingAgentModule } from "../../src/runs/shared/child-session.ts";

function fixture() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-required-ext-"));
	const file = path.join(dir, "required.mjs");
	fs.writeFileSync(file, "export default () => {};\n");
	return { dir, file };
}

function baseInput(sessionId: string) {
	return { parentSessionId: sessionId, sessionEnabled: false, inheritProjectContext: false, inheritGlobalContext: false, inheritSkills: false, cwd: process.cwd(), childAgentName: "worker", childIndex: 0, host: "parent" as const };
}

/** Expects the child session to be refused with `pi` and PI_CODING_AGENT_DIR=`agentDir`; then restores the variable and removes `dir`. */
async function rejectsChildCreate(dir: string, agentDir: string, pi: PiCodingAgentModule, session: ChildSessionLaunch, expected: RegExp): Promise<void> {
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const factory = createDefaultChildSessionFactory({ loadPiCodingAgent: async () => pi });
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		await assert.rejects(() => factory.create(session), expected);
	} finally {
		await factory.dispose();
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		fs.rmSync(dir, { recursive: true, force: true });
	}
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

describe("ordinary extension failures next to required child extensions", () => {
	for (const [host, failure] of [["runner", "broken ambient"], ["parent", "missing agent extension"], ["runner", "missing agent extension"]] as const) {
		it(`starts the child despite a ${failure} in the ${host} loader`, async () => {
			const { dir, file } = fixture();
			const cwd = path.join(dir, "project");
			const agentDir = path.join(dir, "agent");
			fs.mkdirSync(agentDir);
			fs.mkdirSync(path.join(cwd, ".pi", "extensions"), { recursive: true });
			const broken = path.join(cwd, ".pi", "extensions", "broken.ts");
			if (failure === "broken ambient") fs.writeFileSync(broken, "throw new Error('ambient broken');\n");
			const missing = path.join(dir, "does-not-exist.mjs");
			const input = { cwd, subagentOnlyExtensions: failure === "missing agent extension" ? [missing] : [], requiredExtensions: [{ id: "policy", path: fs.realpathSync(file) }], projectTrusted: true, inheritProjectContext: false, inheritGlobalContext: false, inheritSkills: false };
			const launch = host === "parent"
				? buildInProcessChildLaunch({ ...baseInput("ordinary-failure"), ...input })
				: buildRunnerChildLaunch({ agent: "worker", task: "test", ...input }, { cwd, id: "run", flatIndex: 0, projectTrusted: true }, { sessionEnabled: false, watchdogStatus() {} });
			let errors: string[] = [];
			// SAFETY: real Pi resource loading stops at createAgentSession; no other SDK members are used.
			const pi = {
				ModelRuntime: { create: async () => ({}) }, SettingsManager, DefaultResourceLoader,
				SessionManager: { inMemory: () => ({}) },
				createAgentSession: async ({ resourceLoader }: { resourceLoader: DefaultResourceLoader }) => {
					errors = resourceLoader.getExtensions().errors.map(({ path }) => path);
					throw new Error("reached session creation");
				},
			} as PiCodingAgentModule;
			await rejectsChildCreate(dir, agentDir, pi, launch.session, /reached session creation/);
			assert.deepEqual(errors, [failure === "broken ambient" ? broken : missing]);
		});
	}
});

describe("aliased required child extension failures", () => {
	for (const host of ["parent", "runner"] as const) {
		for (const [failure, source, expected] of [
			["load", "throw new Error('load failed');", /Required child extension failed to load:.*load failed/],
			["provider", "pi.registerProvider('bad', {});", /Required child extension provider registration failed.*bad provider/],
			["native provider", "pi.registerProvider({ id: 'bad' });", /Required child extension provider registration failed.*bad provider/],
			["virtual model", "pi.registerVirtualModel({ provider: 'bad', id: 'bad', route() {} });", /Required child extension virtual model registration failed.*bad provider/],
			["startup", "pi.on('session_start', () => { throw new Error('startup failed'); });", /Required child extension failed during startup:.*startup failed/],
		] as const) {
			it(`rejects an aliased ${failure} failure in the ${host} loader`, async () => {
				const { dir, file } = fixture();
				const agentDir = path.join(dir, "agent");
				const aliasDir = path.join(dir, "alias");
				fs.mkdirSync(agentDir);
				fs.symlinkSync(dir, aliasDir, "junction");
				fs.writeFileSync(file, `export default (pi) => { ${source} };\n`);
				const alias = path.join(aliasDir, "required.mjs");
				const input = { cwd: dir, subagentOnlyExtensions: [alias], requiredExtensions: [{ id: "policy", path: fs.realpathSync(file) }], inheritProjectContext: false, inheritGlobalContext: false, inheritSkills: false };
				const launch = host === "parent"
					? buildInProcessChildLaunch({ ...baseInput("failure"), ...input })
					: buildRunnerChildLaunch({ agent: "worker", task: "test", ...input }, { cwd: dir, id: "run", flatIndex: 0 }, { sessionEnabled: false, watchdogStatus() {} });
				let disposed = false;
				// SAFETY: real Pi loading supplies errors/queues; only model registration and session binding are scripted.
				const pi = {
					ModelRuntime: { create: async () => ({ registerProvider() { throw new Error("bad provider"); }, registerNativeProvider() { throw new Error("bad provider"); }, registerVirtualModel() { throw new Error("bad provider"); }, refresh: async () => {} }) },
					SettingsManager, DefaultResourceLoader, SessionManager: { inMemory: () => ({}) },
					createAgentSession: async ({ resourceLoader }: { resourceLoader: DefaultResourceLoader }) => ({ session: {
						bindExtensions: async ({ onError }: { onError: (error: { extensionPath: string; event: string; error: string }) => void }) => {
							for (const extension of resourceLoader.getExtensions().extensions) {
								for (const handler of extension.handlers.get("session_start") ?? []) {
									try { await handler(); } catch (error) { onError({ extensionPath: extension.path, event: "session_start", error: String(error) }); }
								}
							}
						},
						dispose() { disposed = true; }, abort: async () => {},
						extensionRunner: { hasHandlers: () => false },
					} }),
				} as PiCodingAgentModule;
				await rejectsChildCreate(dir, agentDir, pi, launch.session, expected);
				assert.equal(disposed, failure === "startup");
			});
		}
	}
});

describe("required child extension loaded identities", () => {
	for (const host of ["parent", "runner"] as const) {
		for (const scenario of ["removed alias", "Unicode collision", "load failure", "provider failure", "startup failure", "Unicode alias loaded", "repeated entries"]) {
			it(`checks ${scenario} using Pi's loaded identity in the ${host} loader`, async () => {
				const dir = fs.realpathSync(fixture().dir);
				const agentDir = path.join(dir, "agent");
				const realDir = path.join(dir, "real");
				const asciiDir = path.join(dir, "policy dir");
				const nbspDir = path.join(dir, "policy\u00a0dir");
				for (const directory of [agentDir, realDir]) fs.mkdirSync(directory);
				let requiredFile = path.join(realDir, "policy.mjs");
				let alias = path.join(nbspDir, "policy.mjs");
				if (scenario === "removed alias" || scenario === "Unicode collision") {
					const aliasDir = scenario === "removed alias" ? path.join(dir, "alias") : nbspDir;
					fs.symlinkSync(realDir, aliasDir, "junction");
					alias = path.join(aliasDir, "policy.mjs");
					fs.mkdirSync(asciiDir);
					fs.writeFileSync(path.join(asciiDir, "policy.mjs"), "export default () => {};\n");
				} else {
					fs.mkdirSync(nbspDir);
					fs.writeFileSync(alias, "export default () => {};\n");
					if (scenario === "repeated entries") {
						fs.mkdirSync(asciiDir);
						requiredFile = path.join(asciiDir, "policy.mjs");
					} else fs.symlinkSync(realDir, asciiDir, "junction");
				}
				const marker = path.join(dir, "invoked");
				const action = scenario === "removed alias" ? `fs.rmSync(${JSON.stringify(path.dirname(alias))}); throw new Error('alias removed');`
					: scenario === "load failure" ? "throw new Error('load failed');"
					: scenario === "provider failure" ? "pi.registerProvider('bad', {});"
					: scenario === "startup failure" ? "pi.on('session_start', () => { throw new Error('startup failed'); });" : "";
				fs.writeFileSync(requiredFile, `import fs from 'node:fs'; export default (pi) => { if (!fs.existsSync(${JSON.stringify(marker)})) { fs.writeFileSync(${JSON.stringify(marker)}, 'x'); ${action} } };\n`);
				const ordinary = path.join(dir, "ordinary.mjs");
				fs.writeFileSync(ordinary, "export default () => {};\n");
				const requiredPath = fs.realpathSync(requiredFile);
				const requiredExtensions = [{ id: "policy", path: requiredPath }];
				if (scenario === "Unicode collision") {
					const otherRequired = path.join(realDir, "other.mjs");
					fs.writeFileSync(otherRequired, "export default () => {};\n");
					requiredExtensions.push({ id: "other", path: otherRequired });
				}
				const input = { cwd: dir, subagentOnlyExtensions: [alias, ordinary], requiredExtensions, inheritProjectContext: false, inheritGlobalContext: false, inheritSkills: false };
				const launch = host === "parent" ? buildInProcessChildLaunch({ ...baseInput("loaded"), ...input })
					: buildRunnerChildLaunch({ agent: "worker", task: "test", ...input }, { cwd: dir, id: "run", flatIndex: 0 }, { sessionEnabled: false, watchdogStatus() {} });
				let disposed = false;
				// SAFETY: Pi supplies real loaded paths and queues; session binding only invokes its loaded startup handlers.
				const pi = {
					ModelRuntime: { create: async () => ({ registerProvider() { throw new Error("bad provider"); }, refresh: async () => {} }) },
					SettingsManager, DefaultResourceLoader, SessionManager: { inMemory: () => ({}) },
					createAgentSession: async ({ resourceLoader }: { resourceLoader: DefaultResourceLoader }) => {
						const entries = resourceLoader.getExtensions().extensions;
						if (scenario === "Unicode alias loaded" || scenario === "repeated entries") throw new Error("reached session creation");
						return { session: {
							bindExtensions: async ({ onError }: { onError: (error: { extensionPath: string; event: string; error: string }) => void }) => {
								for (const entry of entries) for (const handler of entry.handlers.get("session_start") ?? []) {
									try { await handler(); } catch (error) { onError({ extensionPath: entry.path, event: "session_start", error: String(error) }); }
								}
							},
							dispose() { disposed = true; }, abort: async () => {}, extensionRunner: { hasHandlers: () => false },
						} };
					},
				} as PiCodingAgentModule;
				const expected = scenario === "Unicode alias loaded" || scenario === "repeated entries" ? /reached session creation/
					: scenario === "startup failure" ? /Required child extension failed during startup/
					: scenario === "provider failure" ? /Required child extension provider registration failed/ : /Required child extension failed to load/;
				await rejectsChildCreate(dir, agentDir, pi, launch.session, expected);
				assert.equal(disposed, scenario === "startup failure");
			});
		}
	}
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
