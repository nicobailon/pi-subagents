import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { it } from "node:test";

it("traces bounded completion reasons through NODE_DEBUG without changing delivery", () => {
	const run = (debug: string) => {
		const child = spawnSync(process.execPath, [
			"--experimental-strip-types",
			"--import", new URL("../support/isolated-temp-root.mjs", import.meta.url).href,
			fileURLToPath(new URL("../support/notify-diagnostics-fixture.ts", import.meta.url)),
		], { env: { ...process.env, NODE_DEBUG: debug, NODE_NO_WARNINGS: "1" }, encoding: "utf8" });
		assert.equal(child.status, 0, child.stderr);
		return child;
	};
	const disabled = run("");
	const enabled = run("pi-subagents-notify");
	assert.equal(disabled.stderr, "");
	assert.equal(enabled.stdout, disabled.stdout);
	assert.equal(JSON.parse(enabled.stdout).length, 7);
	assert.deepEqual(JSON.parse(enabled.stdout).at(-1).options, { triggerTurn: false });
	const records = enabled.stderr.trim().split("\n").map((line) => {
		assert.ok(line.length < 512, line);
		assert.match(line, /^PI-SUBAGENTS-NOTIFY \d+: /);
		return JSON.parse(line.slice(line.indexOf("{")));
	});
	assert.deepEqual([...new Set(records.map((row) => row.reason))].sort(), [
		"missing_session", "foreground_session_mismatch", "not_owned", "intercom_delivered",
		"batch_deferred", "deduped_pending", "send_accepted", "deduped_ttl", "emit_not_owned",
		"send_failed", "dispose_pending", "disposed",
	].sort());
	assert.deepEqual(records.filter((row) => row.id === "first").map((row) => row.reason), [
		"batch_deferred", "deduped_pending", "send_accepted", "deduped_ttl", "batch_deferred", "send_accepted",
	]);
	assert.deepEqual(records.filter((row) => row.id === "unbatched").map((row) => row.reason), ["send_accepted"]);
	for (const row of records) {
		assert.deepEqual(Object.keys(row).sort(), ["id", "reason", "runId", "source"]);
		assert.ok(row.id.length <= 128);
		assert.ok(row.runId.length <= 128);
	}
	assert.doesNotMatch(enabled.stderr, /PRIVATE_|owner-a|session-a|\u001b/);
});
