import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
	digestSubagentLaunchRequest,
	registerSubagentLaunchAuthority,
} from "../../src/api/launch-authority.ts";
import {
	authorizeSubagentLaunch,
	classifySubagentLaunchRequest,
	verifyAuthorizedLaunchManifest,
} from "../../src/runs/shared/launch-authority.ts";

const workflow = (task = "Inspect A") => ({
	workflowScript: `return await runs.all([{key:"a",agent:"reviewer",task:${JSON.stringify(task)}}]);`,
	cwd: "/repo",
	context: "fresh",
	async: true,
});

const lane = {
	key: "a",
	agent: "reviewer",
	modelCandidates: ["openai/gpt-test"],
	launchContractDigest: "a".repeat(64),
};

function permitInput(params = workflow(), revision = "revision-1") {
	return {
		configRevision: revision,
		expiresInMs: 1_000,
		requestDigest: digestSubagentLaunchRequest(params),
		minLanes: 1,
		maxLanes: 2,
		lanes: [lane],
	};
}

test("package exports the public launch-authority API", () => {
	const pkg = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "../../package.json"), "utf8")) as { exports?: Record<string, string> };
	assert.equal(pkg.exports?.["./launch-authority"], "./src/api/launch-authority.ts");
});

test("request digests are deterministic, field-sensitive, and reject secret or non-JSON inputs", () => {
	const left = workflow();
	const reordered = { async: true, context: "fresh", cwd: "/repo", workflowScript: left.workflowScript };
	assert.equal(digestSubagentLaunchRequest(left), digestSubagentLaunchRequest(reordered));
	assert.notEqual(digestSubagentLaunchRequest(left), digestSubagentLaunchRequest(workflow("Inspect B")));
	assert.throws(() => digestSubagentLaunchRequest({ ...left, authorization: { launchPermits: ["secret"] } }), /authorization/i);
	const cyclic: Record<string, unknown> = {};
	cyclic.self = cyclic;
	assert.throws(() => digestSubagentLaunchRequest(cyclic), /cycle/i);
	assert.throws(() => digestSubagentLaunchRequest({ task: "x".repeat(1_048_577) }), /size|bytes/i);
});

test("classifies only explicit read/control actions as management", () => {
	for (const params of [{ action: "list" }, { action: "status" }, { action: "stop" }, { action: "interrupt" }, { action: "steer", steeringRecovery: false }, { action: "children.list" }, { action: "schedule.list" }, { action: "schedule.show" }, { action: "schedule.history" }, { action: "schedule.pause" }, { action: "schedule.delete" }]) {
		assert.equal(classifySubagentLaunchRequest(params), "management", JSON.stringify(params));
	}
	for (const params of [workflow(), { agent: "worker" }, { action: "steer" }, { action: "steer", steeringRecovery: true }, { action: "resume" }, { action: "schedule.create" }, { action: "schedule.resume" }, { action: "schedule.run" }, { action: "unknown" }]) {
		assert.equal(classifySubagentLaunchRequest(params), "new-spawn", JSON.stringify(params));
	}
});

test("validates authority registration and permit manifests", () => {
	assert.throws(() => registerSubagentLaunchAuthority({ sessionId: "", source: "ultra", defaultNewSpawnDecision: "deny" }), /sessionId/i);
	assert.throws(() => registerSubagentLaunchAuthority({ sessionId: "s", source: "", defaultNewSpawnDecision: "deny" }), /source/i);
	const authority = registerSubagentLaunchAuthority({ sessionId: "validation", source: "ultra", defaultNewSpawnDecision: "deny" });
	assert.throws(() => authority.issueOnce({ ...permitInput(), minLanes: 0 }), /minLanes/i);
	assert.throws(() => authority.issueOnce({ ...permitInput(), minLanes: 2, maxLanes: 2 }), /between 2 and 2/i);
	assert.throws(() => authority.issueOnce({ ...permitInput(), lanes: [{ ...lane, modelCandidates: [] }] }), /modelCandidates/i);
	authority.dispose();
});

test("allows launches with no authority and management with an active authority", async () => {
	assert.deepEqual(await authorizeSubagentLaunch({ sessionId: "none", params: workflow() }), { ok: true, authorities: [] });
	const authority = registerSubagentLaunchAuthority({ sessionId: "management", source: "ultra", defaultNewSpawnDecision: "deny" });
	assert.deepEqual(await authorizeSubagentLaunch({ sessionId: "management", params: { action: "status" } }), { ok: true, authorities: [] });
	authority.dispose();
});

test("denies without a permit, accepts one exact request once, and rejects replay", async () => {
	const sessionId = "one-use";
	const authority = registerSubagentLaunchAuthority({ sessionId, source: "ultra", defaultNewSpawnDecision: "deny" });
	const params = workflow();
	const missing = await authorizeSubagentLaunch({ sessionId, params });
	assert.equal(missing.ok, false);
	if (!missing.ok) assert.equal(missing.code, "permit_required");
	const token = authority.issueOnce(permitInput(params));
	const accepted = await authorizeSubagentLaunch({ sessionId, params, permits: [token] });
	assert.equal(accepted.ok, true);
	if (accepted.ok) {
		assert.equal(accepted.authorities.length, 1);
		assert.deepEqual(accepted.authorities[0]?.lanes, [lane]);
	}
	const replay = await authorizeSubagentLaunch({ sessionId, params, permits: [token] });
	assert.equal(replay.ok, false);
	if (!replay.ok) assert.equal(replay.code, "invalid_permit");
	authority.dispose();
});

test("a changed request consumes the mismatched permit", async () => {
	const sessionId = "changed";
	const authority = registerSubagentLaunchAuthority({ sessionId, source: "ultra", defaultNewSpawnDecision: "deny" });
	const original = workflow();
	const token = authority.issueOnce(permitInput(original));
	const changed = await authorizeSubagentLaunch({ sessionId, params: workflow("Changed"), permits: [token] });
	assert.equal(changed.ok, false);
	if (!changed.ok) assert.equal(changed.code, "request_mismatch");
	const retry = await authorizeSubagentLaunch({ sessionId, params: original, permits: [token] });
	assert.equal(retry.ok, false);
	authority.dispose();
});

test("rejects expired, revoked, and stale-revision permits", async () => {
	const expiredId = "expired";
	const expired = registerSubagentLaunchAuthority({ sessionId: expiredId, source: "ultra", defaultNewSpawnDecision: "deny" });
	const expiredToken = expired.issueOnce({ ...permitInput(), expiresInMs: 1 });
	await new Promise((resolve) => setTimeout(resolve, 5));
	const expiredResult = await authorizeSubagentLaunch({ sessionId: expiredId, params: workflow(), permits: [expiredToken] });
	assert.equal(expiredResult.ok, false);
	if (!expiredResult.ok) assert.equal(expiredResult.code, "expired_permit");
	expired.dispose();

	const revokedId = "revoked";
	const revoked = registerSubagentLaunchAuthority({ sessionId: revokedId, source: "ultra", defaultNewSpawnDecision: "deny" });
	const revokedToken = revoked.issueOnce(permitInput());
	revoked.revokeUnused();
	const revokedResult = await authorizeSubagentLaunch({ sessionId: revokedId, params: workflow(), permits: [revokedToken] });
	assert.equal(revokedResult.ok, false);
	revoked.dispose();

	const staleId = "stale";
	const stale = registerSubagentLaunchAuthority({
		sessionId: staleId,
		source: "ultra",
		defaultNewSpawnDecision: "deny",
		validateConfigRevision: (revision) => revision === "current",
	});
	const staleToken = stale.issueOnce(permitInput(workflow(), "old"));
	const staleResult = await authorizeSubagentLaunch({ sessionId: staleId, params: workflow(), permits: [staleToken] });
	assert.equal(staleResult.ok, false);
	if (!staleResult.ok) assert.equal(staleResult.code, "config_revision_mismatch");
	stale.dispose();
});

test("all active authorities must contribute a permit", async () => {
	const sessionId = "intersection";
	const first = registerSubagentLaunchAuthority({ sessionId, source: "first", defaultNewSpawnDecision: "deny" });
	const second = registerSubagentLaunchAuthority({ sessionId, source: "second", defaultNewSpawnDecision: "deny" });
	const params = workflow();
	const firstToken = first.issueOnce(permitInput(params));
	const missingSecond = await authorizeSubagentLaunch({ sessionId, params, permits: [firstToken] });
	assert.equal(missingSecond.ok, false);
	if (!missingSecond.ok) assert.equal(missingSecond.code, "permit_required");
	const nextFirst = first.issueOnce(permitInput(params));
	const secondToken = second.issueOnce(permitInput(params));
	const accepted = await authorizeSubagentLaunch({ sessionId, params, permits: [nextFirst, secondToken] });
	assert.equal(accepted.ok, true);
	if (accepted.ok) assert.deepEqual(accepted.authorities.map(({ source }) => source), ["first", "second"]);
	first.dispose();
	second.dispose();
});

test("reserves a permit before awaiting revision validation", async () => {
	const sessionId = "race";
	let release!: (value: boolean) => void;
	const pending = new Promise<boolean>((resolve) => { release = resolve; });
	const authority = registerSubagentLaunchAuthority({
		sessionId,
		source: "ultra",
		defaultNewSpawnDecision: "deny",
		validateConfigRevision: () => pending,
	});
	const params = workflow();
	const token = authority.issueOnce(permitInput(params));
	const first = authorizeSubagentLaunch({ sessionId, params, permits: [token] });
	await Promise.resolve();
	const concurrent = await authorizeSubagentLaunch({ sessionId, params, permits: [token] });
	assert.equal(concurrent.ok, false);
	if (!concurrent.ok) assert.equal(concurrent.code, "invalid_permit");
	release(true);
	assert.equal((await first).ok, true);
	authority.dispose();
});

test("rejects missing session identity and surplus or unknown tokens while any authority is active", async () => {
	const sessionId = "token-exactness";
	const authority = registerSubagentLaunchAuthority({ sessionId, source: "ultra", defaultNewSpawnDecision: "deny" });
	const params = workflow();
	const missingSession = await authorizeSubagentLaunch({ params });
	assert.equal(missingSession.ok, false);
	const token = authority.issueOnce(permitInput(params));
	const surplus = await authorizeSubagentLaunch({ sessionId, params, permits: [token, "unknown-token"] });
	assert.equal(surplus.ok, false);
	if (!surplus.ok) assert.equal(surplus.code, "invalid_permit");
	assert.equal((await authorizeSubagentLaunch({ sessionId, params, permits: [token] })).ok, false);
	authority.dispose();
});

test("rechecks registry generation, revocation, disposal, expiry, and validator deadline before commit", async () => {
	for (const scenario of ["register", "revoke", "dispose", "expire"] as const) {
		const sessionId = `linear-${scenario}`;
		let release!: (value: boolean) => void;
		const pending = new Promise<boolean>((resolve) => { release = resolve; });
		const authority = registerSubagentLaunchAuthority({
			sessionId,
			source: "ultra",
			defaultNewSpawnDecision: "deny",
			validationTimeoutMs: 100,
			validateConfigRevision: () => pending,
		});
		const params = workflow();
		const token = authority.issueOnce({ ...permitInput(params), ...(scenario === "expire" ? { expiresInMs: 2 } : {}) });
		const admission = authorizeSubagentLaunch({ sessionId, params, permits: [token] });
		await Promise.resolve();
		let second: ReturnType<typeof registerSubagentLaunchAuthority> | undefined;
		if (scenario === "register") second = registerSubagentLaunchAuthority({ sessionId, source: "second", defaultNewSpawnDecision: "deny" });
		if (scenario === "revoke") authority.revokeUnused();
		if (scenario === "dispose") authority.dispose();
		if (scenario === "expire") await new Promise((resolve) => setTimeout(resolve, 5));
		release(true);
		assert.equal((await admission).ok, false, scenario);
		second?.dispose();
		authority.dispose();
	}

	const timeoutId = "validator-timeout";
	const timeoutAuthority = registerSubagentLaunchAuthority({
		sessionId: timeoutId,
		source: "ultra",
		defaultNewSpawnDecision: "deny",
		validationTimeoutMs: 5,
		validateConfigRevision: () => new Promise(() => {}),
	});
	const timeoutToken = timeoutAuthority.issueOnce(permitInput());
	const started = Date.now();
	const timedOut = await authorizeSubagentLaunch({ sessionId: timeoutId, params: workflow(), permits: [timeoutToken] });
	assert.equal(timedOut.ok, false);
	assert.ok(Date.now() - started < 100, "validator timeout must be bounded");
	timeoutAuthority.dispose();
});

test("bounds outstanding permit storage", () => {
	const authority = registerSubagentLaunchAuthority({ sessionId: "capacity", source: "ultra", defaultNewSpawnDecision: "deny" });
	for (let index = 0; index < 64; index += 1) authority.issueOnce(permitInput(workflow(`task-${index}`)));
	assert.throws(() => authority.issueOnce(permitInput(workflow("overflow"))), /outstanding permit/i);
	authority.revokeUnused();
	assert.doesNotThrow(() => authority.issueOnce(permitInput(workflow("after-prune"))));
	authority.dispose();
});

test("requires every authority manifest to match exact resolved lanes", () => {
	const actual = [lane];
	const matching = [{ source: "ultra", configRevision: "r", minLanes: 1, maxLanes: 1, lanes: [lane] }];
	assert.doesNotThrow(() => verifyAuthorizedLaunchManifest(matching, actual));
	for (const changed of [
		[],
		[{ ...lane, key: "b" }],
		[{ ...lane, agent: "worker" }],
		[{ ...lane, modelCandidates: ["openai/other"] }],
		[{ ...lane, launchContractDigest: "b".repeat(64) }],
	]) assert.throws(() => verifyAuthorizedLaunchManifest(matching, changed), /manifest|lane|authority/i);
	assert.throws(() => verifyAuthorizedLaunchManifest([
		...matching,
		{ source: "other", configRevision: "r", minLanes: 1, maxLanes: 1, lanes: [{ ...lane, agent: "worker" }] },
	], actual), /other|manifest/i);
});

test("disposing the final authority restores ordinary launch behavior", async () => {
	const sessionId = "dispose";
	const authority = registerSubagentLaunchAuthority({ sessionId, source: "ultra", defaultNewSpawnDecision: "deny" });
	authority.dispose();
	authority.dispose();
	assert.throws(() => authority.issueOnce(permitInput()), /disposed/i);
	assert.deepEqual(await authorizeSubagentLaunch({ sessionId, params: workflow() }), { ok: true, authorities: [] });
});
