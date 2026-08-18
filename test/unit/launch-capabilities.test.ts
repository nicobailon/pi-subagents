import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer, Server } from "node:net";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { launchBindingDigest } from "../../src/shared/launch-contract.ts";
import {
	bindInheritedLaunchCapabilities,
	prepareSubagentLaunchCapabilities,
	registerSubagentLaunchCapabilityProvider,
	resetSubagentLaunchCapabilityProvidersForTests,
	type SubagentLaunchIdentityV1,
} from "../../src/runs/shared/launch-capabilities.ts";

const CAPABILITY = "devspec.claim-authority.v1";

function identity(overrides: Partial<SubagentLaunchIdentityV1> = {}): SubagentLaunchIdentityV1 {
	return {
		version: 1,
		parentSessionId: "parent-session",
		rootRunId: "run-1",
		runId: "run-1",
		attemptId: "attempt-1",
		childIndex: 0,
		agent: "worker",
		mode: "foreground",
		cwdRealpath: process.cwd(),
		effectiveTools: ["edit", "read"],
		launchResolvedExtensions: ["devspec-mutation-gate"],
		launchContractDigest: "sha256:test",
		...overrides,
	};
}

test.beforeEach(() => resetSubagentLaunchCapabilityProvidersForTests());
test.afterEach(() => resetSubagentLaunchCapabilityProvidersForTests());

test("launch capability namespaces are part of the canonical launch digest", () => {
	const base = {
		definitionDigest: "definition",
		inheritProjectContext: false,
		inheritSkills: false,
	};
	assert.notEqual(
		launchBindingDigest(base),
		launchBindingDigest({ ...base, launchCapabilities: [CAPABILITY] }),
	);
	assert.equal(
		launchBindingDigest({ ...base, launchCapabilities: ["z.v1", CAPABILITY] }),
		launchBindingDigest({ ...base, launchCapabilities: [CAPABILITY, "z.v1"] }),
	);
});

test("requested launch capabilities fail closed when no exact provider grants them", async () => {
	await assert.rejects(
		prepareSubagentLaunchCapabilities({
			sessionId: "parent-session",
			requested: [CAPABILITY],
			identity: identity(),
		}),
		/required launch capability.*not available/i,
	);
});

test("provider projections are bounded before any child broker starts", async () => {
	let releases = 0;
	const registration = registerSubagentLaunchCapabilityProvider({
		sessionId: "parent-session",
		capabilityId: CAPABILITY,
		source: "oversized-provider",
		issue: () => ({
			expiresAt: Date.now() + 60_000,
			projection: { value: "x".repeat(9 * 1024) },
			authorize: () => true,
			release: () => { releases++; },
		}),
	});
	try {
		await assert.rejects(
			prepareSubagentLaunchCapabilities({ sessionId: "parent-session", requested: [CAPABILITY], identity: identity() }),
			/oversized projection/i,
		);
		assert.equal(releases, 1, "the grant that fails validation must also be released");
	} finally {
		registration.dispose();
	}
});

test("aggregate provider projections cannot exceed the broker response bound", async () => {
	const ids = ["test.a.v1", "test.b.v1", "test.c.v1", "test.d.v1"];
	let releases = 0;
	const registrations = ids.map((capabilityId) => registerSubagentLaunchCapabilityProvider({
		sessionId: "parent-session",
		capabilityId,
		source: capabilityId,
		issue: () => ({ expiresAt: Date.now() + 60_000, projection: { value: "x".repeat(7 * 1024) }, authorize: () => true, release: () => { releases++; } }),
	}));
	try {
		await assert.rejects(
			prepareSubagentLaunchCapabilities({ sessionId: "parent-session", requested: ids, identity: identity() }),
			/aggregate transport bound/i,
		);
		assert.equal(releases, ids.length, "validated and currently rejecting grants must all be released");
	} finally {
		for (const registration of registrations) registration.dispose();
	}
});

test("a synchronous release failure cannot skip later grant cleanup", async () => {
	let laterReleased = false;
	const registrations = [
		registerSubagentLaunchCapabilityProvider({
			sessionId: "parent-session",
			capabilityId: "test.first.v1",
			source: "first",
			issue: () => ({ expiresAt: Date.now() + 60_000, authorize: () => true, release: () => { throw new Error("sync release failure"); } }),
		}),
		registerSubagentLaunchCapabilityProvider({
			sessionId: "parent-session",
			capabilityId: "test.second.v1",
			source: "second",
			issue: () => ({ expiresAt: Date.now() + 60_000, authorize: () => true, release: () => { laterReleased = true; } }),
		}),
	];
	try {
		await assert.rejects(
			prepareSubagentLaunchCapabilities({
				sessionId: "parent-session",
				requested: ["test.first.v1", "test.second.v1", "test.missing.v1"],
				identity: identity(),
			}),
			/not available/i,
		);
		assert.equal(laterReleased, true);
	} finally {
		for (const registration of registrations) registration.dispose();
	}
});

test("broker listen failure releases every issued grant", async () => {
	let releases = 0;
	const registration = registerSubagentLaunchCapabilityProvider({
		sessionId: "parent-session",
		capabilityId: CAPABILITY,
		source: "listen-failure",
		issue: () => ({ expiresAt: Date.now() + 60_000, authorize: () => true, release: () => { releases++; } }),
	});
	const originalListen = Server.prototype.listen;
	Server.prototype.listen = function (..._args: any[]) {
		queueMicrotask(() => this.emit("error", new Error("synthetic listen failure")));
		return this;
	} as typeof Server.prototype.listen;
	try {
		await assert.rejects(
			prepareSubagentLaunchCapabilities({ sessionId: "parent-session", requested: [CAPABILITY], identity: identity() }),
			/synthetic listen failure/i,
		);
		assert.equal(releases, 1);
	} finally {
		Server.prototype.listen = originalListen;
		registration.dispose();
	}
});

test("a private launch capability binds once and authorizes online until release", async () => {
	let active = true;
	let authorizeCalls = 0;
	let releases = 0;
	const transitions: string[] = [];
	const registration = registerSubagentLaunchCapabilityProvider({
		sessionId: "parent-session",
		capabilityId: CAPABILITY,
		source: "test-provider",
		issue(request) {
			assert.deepEqual(request, identity());
			return {
				expiresAt: Date.now() + 60_000,
				projection: { actionItemId: "item-1", observationId: "observation-1" },
				authorize(bound) {
					authorizeCalls++;
					assert.equal(bound.childSessionId, "child-session");
					return active;
				},
				transition(request) {
					transitions.push(request.phase);
					return { ok: true };
				},
				release() {
					releases++;
				},
			};
		},
	});

	const prepared = await prepareSubagentLaunchCapabilities({
		sessionId: "parent-session",
		requested: [CAPABILITY],
		identity: identity(),
	});
	try {
		const bound = await bindInheritedLaunchCapabilities({
			envelope: prepared.envelope,
			childSessionId: "child-session",
			cwd: process.cwd(),
		});
		assert.deepEqual(bound.projection(CAPABILITY), {
			actionItemId: "item-1",
			observationId: "observation-1",
		});
		assert.equal((await bound.authorize(CAPABILITY)).ok, true);
		assert.equal((await bound.authorize(CAPABILITY)).ok, true);
		assert.equal(authorizeCalls, 2, "positive authorization must not be cached");

		for (const replaySession of ["child-session", "sibling-session"]) {
			await assert.rejects(
				bindInheritedLaunchCapabilities({
					envelope: prepared.envelope,
					childSessionId: replaySession,
					cwd: process.cwd(),
				}),
				/already bound|replayed|session mismatch/i,
			);
		}

		assert.deepEqual(await bound.transition(CAPABILITY, { phase: "prepare", operation: "record_implementation" }), { ok: true });
		assert.deepEqual(await bound.transition(CAPABILITY, { phase: "rollback", operation: "record_implementation" }), { ok: true });
		assert.deepEqual(transitions, ["prepare", "rollback"]);
		active = false;
		assert.equal((await bound.authorize(CAPABILITY)).ok, false);
		await bound.release();
		assert.equal(releases, 1);
		assert.equal((await bound.authorize(CAPABILITY)).ok, false);
	} finally {
		await prepared.dispose("test-complete");
		registration.dispose();
	}
});

test("malformed positive broker responses fail closed at the child boundary", async () => {
	const responses = [
		{ ok: true, projections: { [CAPABILITY]: {} } },
		{ ok: "truthy-but-invalid" },
		{ ok: true },
		{ ok: true },
	];
	const server = createServer((socket) => {
		let body = "";
		socket.setEncoding("utf8");
		socket.on("data", (chunk: string) => {
			body += chunk;
			if (!body.includes("\n")) return;
			socket.end(`${JSON.stringify(responses.shift() ?? { ok: false })}\n`);
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolve());
	});
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	const envelope = Buffer.from(JSON.stringify({
		version: 1,
		host: "127.0.0.1",
		port: address.port,
		token: "fake-token",
		attemptId: "attempt-1",
	}), "utf8").toString("base64url");
	const bound = await bindInheritedLaunchCapabilities({ envelope, childSessionId: "child-session", cwd: process.cwd() });
	try {
		assert.equal((await bound.authorize(CAPABILITY)).ok, false);
		assert.equal((await bound.transition(CAPABILITY, { phase: "prepare", operation: "record_implementation" })).ok, false);
	} finally {
		await bound.release();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});

test("an authorization pending across launcher disposal fails closed", async () => {
	let authorizeStarted!: () => void;
	let resolveAuthorize!: (value: boolean) => void;
	const started = new Promise<void>((resolve) => { authorizeStarted = resolve; });
	const pending = new Promise<boolean>((resolve) => { resolveAuthorize = resolve; });
	const registration = registerSubagentLaunchCapabilityProvider({
		sessionId: "parent-session",
		capabilityId: CAPABILITY,
		source: "pending-provider",
		issue: () => ({ expiresAt: Date.now() + 60_000, authorize: () => { authorizeStarted(); return pending; } }),
	});
	const prepared = await prepareSubagentLaunchCapabilities({ sessionId: "parent-session", requested: [CAPABILITY], identity: identity() });
	const bound = await bindInheritedLaunchCapabilities({ envelope: prepared.envelope, childSessionId: "child-session", cwd: process.cwd() });
	const authorization = bound.authorize(CAPABILITY);
	await started;
	const disposing = prepared.dispose("parent-session-shutdown");
	resolveAuthorize(true);
	assert.equal((await authorization).ok, false);
	await disposing;
	registration.dispose();
});

test("a real separate child process binds the private envelope and revalidates every authorization", async () => {
	let authorizeCalls = 0;
	const registration = registerSubagentLaunchCapabilityProvider({
		sessionId: "parent-session",
		capabilityId: CAPABILITY,
		source: "process-provider",
		issue: () => ({
			expiresAt: Date.now() + 60_000,
			projection: { actionItemId: "item-process", observationId: "observation-process" },
			authorize: () => { authorizeCalls++; return true; },
		}),
	});
	const prepared = await prepareSubagentLaunchCapabilities({
		sessionId: "parent-session",
		requested: [CAPABILITY],
		identity: identity({ attemptId: "attempt-process" }),
	});
	const temp = mkdtempSync(path.join(tmpdir(), "pi-subagent-delegated-writer-"));
	const writePath = path.join(temp, "mutation.txt");
	try {
		const fixture = fileURLToPath(new URL("../support/launch-capability-child.mjs", import.meta.url));
		const output = await new Promise<string>((resolve, reject) => {
			const child = spawn(process.execPath, ["--experimental-strip-types", fixture], {
				cwd: process.cwd(),
				env: {
					...process.env,
					PI_SUBAGENT_LAUNCH_CAPABILITIES_V1: prepared.envelope,
					TEST_CHILD_SESSION_ID: "child-process-session",
					TEST_WRITE_PATH: writePath,
				},
				stdio: ["ignore", "pipe", "pipe"],
			});
			let stdout = "";
			let stderr = "";
			child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
			child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
			child.once("error", reject);
			child.once("close", (code) => code === 0 ? resolve(stdout) : reject(new Error(`child exited ${code}: ${stderr}`)));
		});
		const parsed = JSON.parse(output.trim());
		assert.deepEqual(parsed, {
			first: { ok: true },
			second: { ok: true },
			envelopeCleared: true,
			projection: { actionItemId: "item-process", observationId: "observation-process" },
		});
		assert.equal(authorizeCalls, 2);
		assert.equal(readFileSync(writePath, "utf8"), "delegated writer mutation\n");
		assert.equal(output.includes(prepared.envelope), false, "bearer material must not enter child output");
	} finally {
		await prepared.dispose("test-complete");
		registration.dispose();
		rmSync(temp, { recursive: true, force: true });
	}
});

test("binding rejects a launch-context replay", async () => {
	const registration = registerSubagentLaunchCapabilityProvider({
		sessionId: "parent-session",
		capabilityId: CAPABILITY,
		source: "test-provider",
		issue: () => ({ expiresAt: Date.now() + 60_000, authorize: () => true }),
	});
	const prepared = await prepareSubagentLaunchCapabilities({
		sessionId: "parent-session",
		requested: [CAPABILITY],
		identity: identity(),
	});
	try {
		await assert.rejects(
			bindInheritedLaunchCapabilities({
				envelope: prepared.envelope,
				childSessionId: "child-session",
				cwd: process.cwd() + "-other",
			}),
			/launch context mismatch/i,
		);
	} finally {
		await prepared.dispose("test-complete");
		registration.dispose();
	}
});
