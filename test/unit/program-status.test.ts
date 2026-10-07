import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";

import { registerProgramStatusReporter } from "../../src/integrations/program-status.ts";
import type { AsyncJobState } from "../../src/shared/types.ts";

type Job = Pick<AsyncJobState, "asyncId" | "status"> & Partial<AsyncJobState>;

function job(asyncId: string, status: AsyncJobState["status"], extra: Partial<AsyncJobState> = {}): AsyncJobState {
	return { asyncId, asyncDir: `/runs/${asyncId}`, status, agents: ["worker"], ...extra } as AsyncJobState;
}

function decode(report: string): Record<string, string> {
	const match = /^\x1b\]7501;(.*)\x1b\\$/.exec(report);
	assert.ok(match, `not an OSC 7501 report: ${JSON.stringify(report)}`);
	const fields = Object.fromEntries(match[1]!.split(":").map((pair) => {
		const at = pair.indexOf("=");
		return [pair.slice(0, at), pair.slice(at + 1)];
	}));
	if (fields.msg !== undefined) fields.msg = Buffer.from(fields.msg, "base64").toString("utf-8");
	return fields;
}

function reporter(input: { jobs?: Job[]; pending?: Array<{ id: string; runId: string }>; enabled?: boolean; isTTY?: boolean; env?: Record<string, string>; hasUI?: boolean; mode?: string } = {}) {
	const writes: string[] = [];
	const jobs = new Map<string, AsyncJobState>((input.jobs ?? []).map((entry) => [entry.asyncId, entry as AsyncJobState]));
	const pending = input.pending ?? [];
	const instance = registerProgramStatusReporter({
		enabled: input.enabled ?? true,
		getJobs: () => jobs.values(),
		getPendingRequests: () => pending,
		write: (data) => writes.push(data),
		isTTY: input.isTTY ?? true,
		env: input.env ?? { TERM: "xterm-ghostty" },
	});
	instance.sessionStarted({ hasUI: input.hasUI ?? true, mode: input.mode ?? "tui" });
	return { instance, writes, jobs, pending, records: () => writes.map(decode) };
}

describe("OSC 7501 program status", () => {
	it("reports one record per run under subagents/, and only when a record changes", () => {
		const runId = "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0";
		const { instance, writes, jobs, records } = reporter({ jobs: [job(runId, "running", { currentTool: "bash" })] });
		assert.equal(writes[0], `\x1b]7501;state=working:id=subagents/0f1e2d3c4b5a:app=pi-subagents:msg=${Buffer.from("worker running bash").toString("base64")}\x1b\\`);
		instance.sync();
		instance.sync();
		assert.equal(writes.length, 1);

		jobs.set("child", job("child", "running", { parentWorkflowRunId: "abcdef12-3456-7890-abcd-ef1234567890", workflowKey: "review pass/2", agents: ["reviewer"] }));
		instance.sync();
		assert.deepEqual(records()[1], { state: "working", id: `subagents/abcdef123456.review-pass--${createHash("sha1").update("review pass/2").digest("hex").slice(0, 6)}`, app: "pi-subagents", msg: "review pass/2 running" });

		const states: Array<[AsyncJobState["status"], string, string]> = [
			["complete", "done", "worker finished"],
			["failed", "error", "worker failed"],
			["partial", "error", "worker finished with failures"],
			["rejected", "error", "worker was rejected"],
			["stopped", "idle", "worker stopped"],
			["paused", "idle", "worker paused"],
			["queued", "working", "worker running"],
		];
		for (const [status, state, msg] of states) {
			jobs.set(runId, job(runId, status));
			instance.sync();
			assert.deepEqual(records().at(-1), { state, id: "subagents/0f1e2d3c4b5a", app: "pi-subagents", msg });
		}
	});

	it("reports blocked only while the parent is idle after settling without answering the request", () => {
		const { instance, records, pending } = reporter({ jobs: [job("run-a", "running")] });
		pending.push({ id: "req-1", runId: "run-a" });
		instance.sync();
		assert.equal(records().length, 1, "a new request is the parent's to handle first");
		instance.agentStarted();
		instance.agentSettled();
		assert.deepEqual(records().at(-1), { state: "blocked", id: "subagents/runa", app: "pi-subagents", kind: "question", msg: "worker is waiting for a reply" });
		instance.agentStarted();
		assert.equal(records().at(-1)?.state, "working", "the parent is working on it again");
		pending.length = 0;
		instance.agentSettled();
		assert.equal(records().at(-1)?.state, "working");
		assert.equal(records().length, 3);
	});

	it("keeps msg free of control characters and within 2048 bytes", () => {
		const longTool = `bash\x1b[31m\u0085${"界".repeat(1000)}`;
		const { records } = reporter({ jobs: [job("run-b", "running", { currentTool: longTool })] });
		const record = records()[0]!;
		const bytes = Buffer.byteLength(record.msg!, "utf-8");
		assert.ok(bytes <= 2048, `msg is ${bytes} bytes`);
		assert.ok(bytes > 2040, "truncated close to the limit, on a code point boundary");
		assert.doesNotMatch(record.msg!, /[\u0000-\u001f\u007f-\u009f�]/);
	});

	it("shows at most 64 records, active runs first", () => {
		const running = reporter({ jobs: Array.from({ length: 65 }, (_, index) => job(`run-${index}`, "running", { updatedAt: index + 1 })) });
		assert.equal(running.writes.length, 64);
		assert.ok(!running.records().some((record) => record.id === "subagents/run0"), "the least recently updated run is not shown");
		running.jobs.set("done-new", job("done-new", "complete", { updatedAt: 1000 }));
		running.instance.sync();
		running.instance.sync();
		assert.equal(running.writes.length, 64, "a finished run never displaces an active one, and unchanged jobs write nothing");
	});

	it("writes nothing on a sync with unchanged jobs, also past the 64-record limit", () => {
		const finished = reporter({ jobs: Array.from({ length: 65 }, (_, index) => job(`done-${index}`, "complete", { updatedAt: index + 1 })) });
		assert.equal(finished.writes.length, 64);
		finished.instance.sync();
		finished.instance.sync();
		assert.equal(finished.writes.length, 64);
	});

	it("clears the least recently updated finished record when an active run needs the room", () => {
		const { instance, jobs, records } = reporter({ jobs: Array.from({ length: 64 }, (_, index) => job(`done-${index}`, "complete", { updatedAt: index + 1 })) });
		jobs.set("new-run", job("new-run", "running", { updatedAt: 100 }));
		instance.sync();
		assert.deepEqual(records().slice(64).map(({ state, id }) => `${state} ${id}`), ["clear subagents/done0", "working subagents/newrun"]);
	});

	it("gives a workflow child one flat id segment next to its run, so clearing the run never touches the child", () => {
		const workflowRunId = "abcdef12-3456-7890-abcd-ef1234567890";
		const { instance, jobs, records } = reporter({ jobs: [
			job(workflowRunId, "complete", { mode: "workflow", updatedAt: 1 }),
			job("child-run", "running", { parentWorkflowRunId: workflowRunId, workflowKey: "worker", updatedAt: 2 }),
		] });
		assert.deepEqual(records().map(({ state, id }) => `${state} ${id}`), ["working subagents/abcdef123456.worker", "done subagents/abcdef123456"]);
		jobs.delete(workflowRunId);
		instance.sync();
		instance.sync();
		assert.deepEqual(records().slice(2), [{ state: "clear", id: "subagents/abcdef123456" }]);
	});

	it("keeps workflow child ids within one 32-character segment without collisions", () => {
		const parentWorkflowRunId = "abcdef12-3456-7890-abcd-ef1234567890";
		const longA = `review-${"a".repeat(30)}-one`;
		const longB = `review-${"a".repeat(30)}-two`;
		const { records } = reporter({ jobs: [
			job("child-dots", "running", { parentWorkflowRunId, workflowKey: "lint.fix/s1 x", updatedAt: 3 }),
			job("child-a", "running", { parentWorkflowRunId, workflowKey: longA, updatedAt: 2 }),
			job("child-b", "running", { parentWorkflowRunId, workflowKey: longB, updatedAt: 1 }),
		] });
		const ids = records().map((record) => record.id!);
		const sha = (key: string) => createHash("sha1").update(key).digest("hex").slice(0, 6);
		assert.deepEqual(ids, [
			`subagents/abcdef123456.lint-fix-s1--${sha("lint.fix/s1 x")}`,
			`subagents/abcdef123456.review-aaaaa-${sha(longA)}`,
			`subagents/abcdef123456.review-aaaaa-${sha(longB)}`,
		]);
		for (const id of ids) {
			const [root, segment, ...rest] = id.split("/");
			assert.equal(root, "subagents");
			assert.deepEqual(rest, []);
			assert.match(segment!, /^[A-Za-z0-9_+-]{12}\.[A-Za-z0-9_+-]{1,19}$/);
		}
	});

	it("keeps keys apart that differ only in characters the id cannot carry", () => {
		const parentWorkflowRunId = "abcdef12-3456-7890-abcd-ef1234567890";
		const { records } = reporter({ jobs: [
			job("child-dot", "running", { parentWorkflowRunId, workflowKey: "a.b", updatedAt: 2 }),
			job("child-dash", "running", { parentWorkflowRunId, workflowKey: "a-b", updatedAt: 1 }),
		] });
		assert.deepEqual(records().map((record) => record.id), [
			`subagents/abcdef123456.a-b-${createHash("sha1").update("a.b").digest("hex").slice(0, 6)}`,
			"subagents/abcdef123456.a-b",
		]);
	});

	it("clears every record it sent when its runtime is replaced, but leaves them when Pi quits", () => {
		const jobs = [job("run-f", "complete"), job("run-g", "running")];
		const reloaded = reporter({ jobs });
		reloaded.instance.dispose("reload");
		reloaded.instance.sync();
		assert.deepEqual(reloaded.records().slice(2).map(({ state, id }) => `${state} ${id}`).sort(), ["clear subagents/runf", "clear subagents/rung"]);

		const replaced = reporter({ jobs });
		replaced.instance.dispose();
		assert.equal(replaced.records().slice(2).length, 2, "a replacement without a shutdown event clears too");

		const quit = reporter({ jobs });
		quit.instance.dispose("quit");
		quit.instance.sync();
		assert.equal(quit.writes.length, 2, "done and error records stay after Pi exits");

		const inactive = reporter({ jobs, isTTY: false });
		inactive.instance.dispose("reload");
		assert.deepEqual(inactive.writes, []);
	});

	it("writes nothing when turned off or not on an interactive terminal", () => {
		const cases = [
			{ enabled: false },
			{ isTTY: false },
			{ env: { TERM: "dumb" } },
			{ hasUI: false },
			{ mode: "rpc" },
		];
		for (const input of cases) {
			const { instance, writes } = reporter({ ...input, jobs: [job("run-e", "running")] });
			instance.agentSettled();
			instance.sync();
			assert.deepEqual(writes, [], JSON.stringify(input));
		}
	});
});
