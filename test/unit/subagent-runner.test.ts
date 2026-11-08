import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { it } from "node:test";
import { requestAsyncStop, stopInboxClosedPath } from "../../src/runs/background/control-channel.ts";
import { runSubagent } from "../../src/runs/background/subagent-runner.ts";
import { createFakeChildSessions } from "../support/fake-child-session.ts";
import { events } from "../support/helpers.ts";

it("keeps an accepted final-inbox stop authoritative over supervisor expiry", { timeout: 20000 }, async (t) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-final-stop-"));
	const asyncDir = path.join(root, "run");
	const queue = path.join(root, "queue");
	fs.mkdirSync(queue, { recursive: true });
	const terminationReason = "timed-out-waiting-on-supervisor";
	fs.writeFileSync(path.join(queue, "default-response.json"), JSON.stringify({ steps: [
		{ jsonl: [{ ...events.toolStart("contact_supervisor", { reason: "need_decision" }), toolCallId: "expired" }] },
		{ jsonl: [{ ...events.toolEnd("contact_supervisor"), toolCallId: "expired", result: { content: [{ type: "text", text: "Expired" }], details: { terminationReason } } }] },
		{ delay: 10000 },
	] }));
	const sessionFile = path.join(root, "retained.jsonl");
	const resultPath = path.join(root, "result.json");
	const rename = fs.renameSync;
	let accepted = false;
	t.mock.method(fs, "renameSync", (from, to) => {
		if (String(to) === stopInboxClosedPath(asyncDir)) {
			requestAsyncStop(asyncDir, { source: "test", reason: "final-drain" });
			accepted = true;
		}
		return rename(from, to);
	});
	syncBuiltinESMExports();
	try {
		await runSubagent({ id: "run", steps: [{ agent: "worker", task: "Ask", sessionFile }], resultPath, asyncDir, cwd: root, sessionId: "session-final-stop", placeholder: "{previous}", artifactConfig: { enabled: false }, share: false }, createFakeChildSessions(() => queue).factory);
		assert.equal(accepted, true);
		const result = JSON.parse(fs.readFileSync(resultPath, "utf8"));
		const status = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf8"));
		for (const projection of [result, status]) {
			assert.equal(projection.state, "stopped");
			assert.equal(projection.terminationReason, undefined);
			assert.equal(projection.activityState, undefined);
			assert.equal(projection.error, "Subagent stopped.");
		}
		assert.equal(result.summary, "Subagent stopped.");
		assert.equal(result.results[0].terminationReason, terminationReason);
		assert.equal(result.results[0].sessionFile, sessionFile);
		assert.equal(fs.existsSync(sessionFile), true);
	} finally {
		t.mock.restoreAll();
		syncBuiltinESMExports();
		fs.rmSync(root, { recursive: true, force: true });
	}
});
