import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
	authorizeSubagentLaunch,
	classifySubagentLaunchRequest,
	digestSubagentLaunchRequest,
	registerSubagentLaunchAuthority,
} from "../../src/api/launch-authority.ts";

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
	for (const action of ["list", "status", "stop", "interrupt", "steer", "children.list", "schedule.list", "schedule.show", "schedule.history", "schedule.pause", "schedule.delete"]) {
		assert.equal(classifySubagentLaunchRequest({ action }), "management", action);
	}
	for (const params of [workflow(), { agent: "worker" }, { action: "resume" }, { action: "schedule.create" }, { action: "schedule.resume" }, { action: "schedule.run" }, { action: "unknown" }]) {
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

test("disposing the final authority restores ordinary launch behavior", async () => {
	const sessionId = "dispose";
	const authority = registerSubagentLaunchAuthority({ sessionId, source: "ultra", defaultNewSpawnDecision: "deny" });
	authority.dispose();
	authority.dispose();
	assert.throws(() => authority.issueOnce(permitInput()), /disposed/i);
	assert.deepEqual(await authorizeSubagentLaunch({ sessionId, params: workflow() }), { ok: true, authorities: [] });
});
