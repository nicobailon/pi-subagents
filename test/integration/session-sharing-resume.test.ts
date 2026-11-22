/**
 * A resume restores the launch's saved `share`, so config `disabledFeatures: ["session-sharing"]`
 * must refuse the resume instead of letting the revived run upload the continued session.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeAgent, makeMinimalCtx } from "../support/helpers.ts";
import { recoveryDescriptorPath } from "../../src/runs/shared/run-launch-folder.ts";
import { getActiveAsyncCapacitySnapshot } from "../../src/runs/background/active-async-capacity.ts";
import {
	installAsyncExecutionHooks, available, isAsyncAvailable, ASYNC_DIR, tempDir, mockPi, readAsyncPayload, makeAsyncExecutor,
} from "../support/async-execution-fixture.ts";

describe("session sharing on resume", { skip: !available ? "pi packages not available" : undefined }, () => {
	installAsyncExecutionHooks();

	// Resume revives a retained session, so the source run is a fork with a pre-created session file.
	const forkCtx = (name: string) => {
		const parentSessionFile = path.join(tempDir, `${name}-parent.jsonl`);
		const sessionFile = path.join(tempDir, `${name}-child.jsonl`);
		const header = JSON.stringify({ type: "session", version: 1, id: name, cwd: fs.realpathSync(tempDir) });
		fs.writeFileSync(parentSessionFile, `${header}\n`);
		fs.writeFileSync(sessionFile, `${header}\n`);
		return { ...makeMinimalCtx(tempDir), sessionManager: { getSessionId: () => `${name}-session`, getSessionFile: () => parentSessionFile, getLeafId: () => "leaf", openSession: () => ({ createBranchedSession: () => sessionFile }) } };
	};

	it("refuses to resume a run whose saved launch enabled share, and resumes it once the setting is gone", { timeout: 30_000, skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		const ctx = forkCtx("share-resume");
		const agent = makeAgent("worker");
		mockPi.onCall({ output: "first run" });
		const launch = await makeAsyncExecutor([agent])
			.execute("share-launch", { agent: "worker", task: "Work", async: true, context: "fork", acceptance: false, share: true }, new AbortController().signal, undefined, ctx);
		assert.equal(launch.isError, undefined, launch.content[0]?.text);
		const sourceId = launch.details.asyncId!;
		assert.equal((await readAsyncPayload(sourceId)).success, true);
		// The request carried no share; only the saved descriptor remembers it.
		const descriptor = JSON.parse(fs.readFileSync(recoveryDescriptorPath(ASYNC_DIR, sourceId), "utf-8")) as { share?: boolean };
		assert.equal(descriptor.share, true);

		const capacityBefore = getActiveAsyncCapacitySnapshot("share-resume-session", 4).used;
		// Dot entries are run indexes the finished runner may still be writing after its result lands.
		const runDirs = () => fs.readdirSync(ASYNC_DIR).filter((entry) => !entry.startsWith(".")).sort();
		const runsBefore = runDirs();
		const callsBefore = mockPi.callCount();
		const resume = (executor: ReturnType<typeof makeAsyncExecutor>, callId: string) => executor
			.execute(callId, { action: "resume", id: sourceId, message: "Continue", acceptance: false }, new AbortController().signal, undefined, ctx);

		const refused = await resume(makeAsyncExecutor([agent], { disabledFeatures: ["session-sharing"] }), "share-resume-refused");
		assert.equal(refused.isError, true);
		assert.match(refused.content[0]?.text ?? "", new RegExp(`^Cannot resume: run '${sourceId}' was launched with share enabled, which config disabledFeatures "session-sharing" now disables\\. Re-enable session sharing to resume it\\.$`));
		assert.equal(mockPi.callCount(), callsBefore, "the refused resume started no child");
		assert.equal(getActiveAsyncCapacitySnapshot("share-resume-session", 4).used, capacityBefore, "the refused resume moved no capacity");
		assert.deepEqual(runDirs(), runsBefore, "the refused resume created no run");

		mockPi.onCall({ output: "resumed run" });
		const allowed = await resume(makeAsyncExecutor([agent]), "share-resume-allowed");
		assert.equal(allowed.isError, undefined, allowed.content[0]?.text);
		assert.equal((await readAsyncPayload(allowed.details.asyncId!)).success, true);
		assert.equal(mockPi.callCount(), callsBefore + 1, "the run stays resumable once the setting is gone");
	});
});
