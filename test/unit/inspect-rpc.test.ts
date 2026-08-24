import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
	encodeInspectReply,
	handleInspectRpcArgs,
	INSPECT_REPLY_KIND,
	INSPECT_REPLY_VERSION,
	INSPECT_WIDGET_PREFIX,
	MAX_SERIALIZED_BYTES,
	buildInspectReply,
	parseInspectRequest,
	type InspectDeps,
} from "../../src/runs/background/inspect-rpc.ts";
import { writeAsyncResultFile } from "../../src/runs/background/result-files.ts";
import { recordWaitCompletion } from "../../src/runs/background/wait-completions.ts";
import { completionArchivePath, completionReplayPath } from "../../src/runs/background/completion-replay.ts";
import { formatOutputArtifactContent } from "../../src/shared/artifacts.ts";
import type { SubagentState } from "../../src/shared/types.ts";

const SESSION_ID = "session-current";

function makeState(root: string, sessionId: string | null = SESSION_ID): SubagentState {
	return {
		currentSessionId: sessionId,
		foregroundControls: new Map(),
		foregroundRuns: new Map(),
		asyncJobs: new Map(),
		trustedSessionRoots: [root],
	} as unknown as SubagentState;
}

interface FixtureOptions {
	runId: string;
	sessionId?: string;
	state?: string;
	mode?: string;
	context?: string;
	steps?: Array<Record<string, unknown>>;
	sessionMessages?: Array<Record<string, unknown>>;
	resultPayload?: Record<string, unknown>;
	error?: string;
}

function makeRun(root: string, options: FixtureOptions): { asyncDir: string; resultsDir: string; sessionFile: string } {
	const asyncRoot = path.join(root, "runs");
	const resultsDir = path.join(root, "results");
	const asyncDir = path.join(asyncRoot, options.runId);
	fs.mkdirSync(asyncDir, { recursive: true });
	fs.mkdirSync(resultsDir, { recursive: true });
	const sessionFile = path.join(root, `${options.runId}-session.jsonl`);
	const records = (options.sessionMessages ?? []).map((message) => JSON.stringify({ message }));
	fs.writeFileSync(sessionFile, records.length > 0 ? `${records.join("\n")}\n` : "", "utf-8");
	const steps = (options.steps ?? [{ agent: "worker", status: options.state ?? "complete", startedAt: 100, endedAt: 150, sessionFile }])
		.map((step) => ({ ...step }));
	fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
		runId: options.runId,
		sessionId: options.sessionId ?? SESSION_ID,
		mode: options.mode ?? "single",
		state: options.state ?? "complete",
		...(options.context ? { context: options.context } : {}),
		startedAt: 100,
		endedAt: 200,
		lastUpdate: 200,
		...(options.error ? { error: options.error } : {}),
		sessionFile,
		steps,
	}, null, 2), "utf-8");
	if (options.resultPayload) {
		writeAsyncResultFile(path.join(resultsDir, `${options.runId}.json`), {
			runId: options.runId,
			sessionId: options.sessionId ?? SESSION_ID,
			...options.resultPayload,
		});
	}
	return { asyncDir, resultsDir, sessionFile };
}

function makeDeps(root: string, resultsDir: string, state?: SubagentState): InspectDeps {
	return {
		state: state ?? makeState(root),
		asyncDirRoot: path.join(root, "runs"),
		resultsDir,
		kill: () => true,
		now: () => 1_000,
	};
}

const userMessage = (text: string) => ({ role: "user", content: text });
const assistantMessage = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] });
const toolCallMessage = (name: string, args: unknown) => ({ role: "assistant", content: [{ type: "toolCall", name, args }] });

describe("inspect-rpc request parsing", () => {
	it("parses positional args and --lines", () => {
		const parsed = parseInspectRequest("req-1 run-1 child-2 --lines 25");
		assert.deepEqual(parsed.request, { requestId: "req-1", asyncId: "run-1", childId: "child-2", lines: 25 });
	});
	it("rejects bad requestId charset, unknown flags, extra positionals", () => {
		assert.match(parseInspectRequest("bad!id run-1").error ?? "", /requestId/);
		assert.match(parseInspectRequest("req-1 run-1 --bogus").error ?? "", /Unknown flag/);
		assert.match(parseInspectRequest("req-1 run-1 a b").error ?? "", /Too many positional/);
		assert.match(parseInspectRequest("req-1 run-1 --lines nope").error ?? "", /--lines/);
		assert.match(parseInspectRequest("req-1").error ?? "", /Usage/);
	});
});

describe("inspect-rpc resolution and ownership", () => {
	it("does not expose async artifact paths when status is malformed", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-inspect-malformed-"));
		const { asyncDir, resultsDir } = makeRun(root, { runId: "run-malformed" });
		fs.writeFileSync(path.join(asyncDir, "status.json"), "{ not json", "utf-8");
		const reply = buildInspectReply({ requestId: "r-malformed", asyncId: "run-malformed" }, makeDeps(root, resultsDir));
		assert.equal(reply.error?.code, "internal");
		assert.equal(JSON.stringify(reply).includes(root), false);
	});
	it("returns not_found for an unknown run", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-inspect-missing-"));
		const reply = buildInspectReply({ requestId: "r1", asyncId: "nope" }, makeDeps(root, path.join(root, "results")));
		assert.equal(reply.error?.code, "not_found");
		assert.equal(reply.requestId, "r1");
	});
	it("returns foreign_session and no data for runs owned by another session", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-inspect-foreign-"));
		const { resultsDir } = makeRun(root, { runId: "run-foreign", sessionId: "session-other" });
		const reply = buildInspectReply({ requestId: "r2", asyncId: "run-foreign" }, makeDeps(root, resultsDir));
		assert.equal(reply.error?.code, "foreign_session");
		assert.equal(reply.messages, undefined);
		assert.equal(reply.task, undefined);
		assert.equal(reply.finalOutput, undefined);
	});
	it("returns no_active_session when the request cannot be attributed", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-inspect-nosession-"));
		const { resultsDir } = makeRun(root, { runId: "run-x" });
		const reply = buildInspectReply({ requestId: "r3", asyncId: "run-x" }, makeDeps(root, resultsDir, makeState(root, null)));
		assert.equal(reply.error?.code, "no_active_session");
	});
	it("returns stale when artifacts are gone", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-inspect-stale-"));
		const asyncRoot = path.join(root, "runs");
		fs.mkdirSync(path.join(asyncRoot, "run-stale"), { recursive: true });
		const reply = buildInspectReply({ requestId: "r4", asyncId: "run-stale" }, makeDeps(root, path.join(root, "results")));
		assert.equal(reply.error?.code, "stale");
	});
});

describe("inspect-rpc reply content", () => {
	it("reads an exact runtime-recorded session under the Pi sessions base", () => {
		const sessionsBase = fs.mkdtempSync(path.join(os.tmpdir(), "pi-inspect-recorded-session-"));
		const root = path.join(sessionsBase, "project");
		try {
			fs.mkdirSync(root);
			const { resultsDir } = makeRun(root, {
				runId: "run-recorded",
				sessionMessages: [userMessage("recorded task"), assistantMessage("recorded answer")],
				resultPayload: { summary: "done", results: [{ agent: "worker", output: "recorded answer", success: true }] },
			});
			const state = makeState(path.join(sessionsBase, "unrelated"));
			state.trustedSessionFileRoot = sessionsBase;
			const reply = buildInspectReply({ requestId: "r-recorded", asyncId: "run-recorded" }, makeDeps(root, resultsDir, state));
			assert.equal(reply.error, undefined);
			assert.equal(reply.task, "recorded task");
			assert.equal(reply.messages?.at(-1)?.text, "recorded answer");
		} finally {
			fs.rmSync(sessionsBase, { recursive: true, force: true });
		}
	});

	it("returns task, messages, and final output without leaking paths", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-inspect-full-"));
		const sessionFile = path.join(root, "run-1-session.jsonl");
		const { resultsDir } = makeRun(root, {
			runId: "run-1",
			sessionMessages: [
				userMessage("Summarize the repo"),
				toolCallMessage("bash", { command: "ls" }),
				assistantMessage("Done."),
			],
			resultPayload: { summary: "Run summary", results: [{ agent: "worker", output: "final answer", success: true }] },
		});
		const reply = buildInspectReply({ requestId: "r5", asyncId: "run-1" }, makeDeps(root, resultsDir));
		assert.equal(reply.error, undefined);
		assert.equal(reply.kind, INSPECT_REPLY_KIND);
		assert.equal(reply.version, INSPECT_REPLY_VERSION);
		assert.equal(reply.status, "complete");
		assert.equal(reply.task, "Summarize the repo");
		assert.equal(reply.finalOutput, "Run summary");
		assert.equal(reply.messages?.length, 3);
		assert.equal(reply.messages?.[1]?.kind, "toolCall");
		assert.equal(reply.messages?.[1]?.name, "bash");
		const serialized = JSON.stringify(reply);
		assert.equal(serialized.includes(sessionFile), false);
		assert.equal(serialized.includes(root), false);
	});
	it("resolves a direct step child by snapshot node id", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-inspect-child-"));
		const childSession = path.join(root, "child.jsonl");
		fs.writeFileSync(childSession, `${JSON.stringify({ message: userMessage("child task") })}\n`, "utf-8");
		const { resultsDir } = makeRun(root, {
			runId: "run-parent",
			mode: "workflow",
			steps: [
				{ agent: "planner", label: "plan", status: "complete", workflowKey: "step-a", startedAt: 100, endedAt: 150, sessionFile: childSession },
			],
			resultPayload: { summary: "parent", results: [{ agent: "planner", output: "child output", success: true }] },
		});
		const reply = buildInspectReply({ requestId: "r6", asyncId: "run-parent", childId: "step-a" }, makeDeps(root, resultsDir));
		assert.equal(reply.error, undefined);
		assert.equal(reply.childId, "step-a");
		assert.equal(reply.label, "plan");
		assert.equal(reply.task, "child task");
		assert.equal(reply.finalOutput, "child output");
	});
	it("returns not_found for an unknown childId", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-inspect-nochild-"));
		const { resultsDir } = makeRun(root, { runId: "run-p2" });
		const reply = buildInspectReply({ requestId: "r7", asyncId: "run-p2", childId: "step:9" }, makeDeps(root, resultsDir));
		assert.equal(reply.error?.code, "not_found");
	});
	it("omits task for fork-context children", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-inspect-fork-"));
		const { resultsDir } = makeRun(root, {
			runId: "run-fork",
			context: "fork",
			sessionMessages: [userMessage("inherited parent text"), assistantMessage("answer")],
		});
		const reply = buildInspectReply({ requestId: "r8", asyncId: "run-fork" }, makeDeps(root, resultsDir));
		assert.equal(reply.error, undefined);
		assert.equal(reply.task, undefined);
		assert.equal(reply.messages?.length, 2);
	});
	it("reports running state with messages so far and no final output", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-inspect-running-"));
		const { resultsDir } = makeRun(root, {
			runId: "run-live",
			state: "running",
			sessionMessages: [userMessage("do work"), assistantMessage("working on it")],
		});
		const reply = buildInspectReply({ requestId: "r9", asyncId: "run-live" }, makeDeps(root, resultsDir));
		assert.equal(reply.error, undefined);
		assert.equal(reply.status, "running");
		assert.equal(reply.messages?.length, 2);
		assert.equal(reply.finalOutput, undefined);
	});
	it("returns completed output from durable replay after the result payload is consumed", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-inspect-replay-"));
		const { resultsDir } = makeRun(root, { runId: "run-replay" });
		recordWaitCompletion(makeState(root), "run-replay", {
			runId: "run-replay",
			sessionId: SESSION_ID,
			results: [{ agent: "worker", output: "finished output" }],
		}, Date.now(), 60_000, { resultsDir, sessionId: SESSION_ID });
		const reply = buildInspectReply({ requestId: "r-replay", asyncId: "run-replay" }, makeDeps(root, resultsDir));
		assert.equal(reply.error, undefined);
		assert.equal(reply.finalOutput, "finished output");
		assert.equal(JSON.stringify(reply).includes(root), false);
	});
	it("returns legacy single-child replay output at run level when resultIndex is absent", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-inspect-replay-legacy-single-"));
		const { resultsDir } = makeRun(root, { runId: "run-replay-legacy-single" });
		recordWaitCompletion(makeState(root), "run-replay-legacy-single", {
			runId: "run-replay-legacy-single",
			sessionId: SESSION_ID,
			results: [{ agent: "worker", output: "finished output" }],
		}, Date.now(), 60_000, { resultsDir, sessionId: SESSION_ID });
		const archivePath = completionArchivePath(resultsDir, "run-replay-legacy-single");
		const archive = JSON.parse(fs.readFileSync(archivePath, "utf-8"));
		for (const entry of archive.entries) delete entry.resultIndex;
		fs.writeFileSync(archivePath, JSON.stringify(archive), "utf-8");
		const reply = buildInspectReply({ requestId: "r-replay-legacy-single", asyncId: "run-replay-legacy-single" }, makeDeps(root, resultsDir));
		assert.equal(reply.error, undefined);
		assert.equal(reply.finalOutput, "finished output");
	});
	it("returns output from a durable replay artifact without exposing its path", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-inspect-replay-artifact-"));
		const outputPath = path.join(root, "output.txt");
		fs.writeFileSync(outputPath, "artifact output", "utf-8");
		const { resultsDir } = makeRun(root, { runId: "run-replay-artifact" });
		recordWaitCompletion(makeState(root), "run-replay-artifact", {
			runId: "run-replay-artifact",
			sessionId: SESSION_ID,
			results: [{ artifactPaths: { outputPath }, output: "ignored fallback" }],
		}, Date.now(), 60_000, { resultsDir, sessionId: SESSION_ID });
		const reply = buildInspectReply({ requestId: "r-replay-artifact", asyncId: "run-replay-artifact" }, makeDeps(root, resultsDir));
		assert.equal(reply.error, undefined);
		assert.equal(reply.finalOutput, "artifact output");
		assert.equal(JSON.stringify(reply).includes(outputPath), false);
	});
	it("returns a failed replay artifact error without private metadata", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-inspect-replay-failed-artifact-"));
		const outputPath = path.join(root, "output.txt");
		const transcriptPath = path.join(root, "transcript.jsonl");
		const metadataPath = path.join(root, "metadata.json");
		const childError = `${"x".repeat(12_000)} child failure tail ${"x".repeat(28_000)}`;
		fs.writeFileSync(outputPath, formatOutputArtifactContent({ output: "", error: childError, transcriptPath, metadataPath }), "utf-8");
		const { resultsDir } = makeRun(root, {
			runId: "run-replay-failed-artifact",
			mode: "workflow",
			steps: [{ agent: "worker", status: "failed", workflowKey: "worker", startedAt: 100, endedAt: 150 }],
		});
		recordWaitCompletion(makeState(root), "run-replay-failed-artifact", {
			runId: "run-replay-failed-artifact",
			sessionId: SESSION_ID,
			results: [{ artifactPaths: { outputPath } }],
		}, Date.now(), 60_000, { resultsDir, sessionId: SESSION_ID });
		const reply = buildInspectReply({ requestId: "r-replay-failed-artifact", asyncId: "run-replay-failed-artifact", childId: "worker" }, makeDeps(root, resultsDir));
		const serialized = JSON.stringify(reply);
		assert.equal(reply.error, undefined);
		assert.ok(reply.finalOutput?.includes("child failure tail"));
		for (const privateText of [root, outputPath, transcriptPath, metadataPath, "Transcript:", "Metadata:"]) assert.equal(serialized.includes(privateText), false);
	});
	it("returns the selected child output from a multi-step replay artifact archive", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-inspect-replay-children-"));
		const firstOutputPath = path.join(root, "first-output.txt");
		const secondOutputPath = path.join(root, "second-output.txt");
		fs.writeFileSync(firstOutputPath, "first output", "utf-8");
		fs.writeFileSync(secondOutputPath, "second output", "utf-8");
		const { resultsDir } = makeRun(root, {
			runId: "run-replay-children",
			mode: "workflow",
			steps: [
				{ agent: "first", status: "complete", workflowKey: "first", startedAt: 100, endedAt: 150 },
				{ agent: "second", status: "complete", workflowKey: "second", startedAt: 100, endedAt: 150 },
			],
		});
		recordWaitCompletion(makeState(root), "run-replay-children", {
			runId: "run-replay-children",
			sessionId: SESSION_ID,
			results: [
				{ artifactPaths: { outputPath: firstOutputPath } },
				{ artifactPaths: { outputPath: secondOutputPath } },
			],
		}, Date.now(), 60_000, { resultsDir, sessionId: SESSION_ID });
		const reply = buildInspectReply({ requestId: "r-replay-children", asyncId: "run-replay-children", childId: "second" }, makeDeps(root, resultsDir));
		assert.equal(reply.error, undefined);
		assert.equal(reply.finalOutput, "second output");
		assert.equal(JSON.stringify(reply).includes(root), false);
	});
	it("uses the child result index when a replay mixes inline and artifact output", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-inspect-replay-mixed-"));
		const secondOutputPath = path.join(root, "second-output.txt");
		fs.writeFileSync(secondOutputPath, "second artifact output", "utf-8");
		const { resultsDir } = makeRun(root, {
			runId: "run-replay-mixed",
			mode: "workflow",
			steps: [
				{ agent: "first", status: "complete", workflowKey: "first", startedAt: 100, endedAt: 150 },
				{ agent: "second", status: "complete", workflowKey: "second", startedAt: 100, endedAt: 150 },
			],
		});
		recordWaitCompletion(makeState(root), "run-replay-mixed", {
			runId: "run-replay-mixed",
			sessionId: SESSION_ID,
			results: [
				{ agent: "first", output: "first inline output" },
				{ agent: "second", artifactPaths: { outputPath: secondOutputPath } },
			],
		}, Date.now(), 60_000, { resultsDir, sessionId: SESSION_ID });
		const first = buildInspectReply({ requestId: "r-replay-mixed-first", asyncId: "run-replay-mixed", childId: "first" }, makeDeps(root, resultsDir));
		assert.equal(first.error, undefined);
		assert.equal(first.finalOutput, "first inline output");
		const second = buildInspectReply({ requestId: "r-replay-mixed", asyncId: "run-replay-mixed", childId: "second" }, makeDeps(root, resultsDir));
		assert.equal(second.error, undefined);
		assert.equal(second.finalOutput, "second artifact output");
		const topLevel = buildInspectReply({ requestId: "r-replay-mixed-top", asyncId: "run-replay-mixed" }, makeDeps(root, resultsDir));
		assert.equal(topLevel.error, undefined);
		assert.equal(topLevel.finalOutput, undefined);
		assert.equal(JSON.stringify(first).includes(root), false);
	});
	it("returns session-backed replay output from the child's archived session transcript", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-inspect-replay-session-"));
		const childSession = path.join(root, "child-session.jsonl");
		fs.writeFileSync(childSession, [
			JSON.stringify({ message: userMessage("child task") }),
			JSON.stringify({ message: assistantMessage("session-backed answer") }),
		].join("\n") + "\n", "utf-8");
		const { resultsDir } = makeRun(root, {
			runId: "run-replay-session",
			mode: "workflow",
			steps: [{ agent: "worker", status: "complete", workflowKey: "worker", startedAt: 100, endedAt: 150, sessionFile: childSession }],
		});
		recordWaitCompletion(makeState(root), "run-replay-session", {
			runId: "run-replay-session",
			sessionId: SESSION_ID,
			results: [{ sessionFile: childSession }],
		}, Date.now(), 60_000, { resultsDir, sessionId: SESSION_ID });
		const reply = buildInspectReply({ requestId: "r-replay-session", asyncId: "run-replay-session", childId: "worker" }, makeDeps(root, resultsDir));
		assert.equal(reply.error, undefined);
		assert.equal(reply.finalOutput, "session-backed answer");
		assert.equal(JSON.stringify(reply).includes(childSession), false);
	});
	it("omits finalOutput for run-level inspection of a multi-child replay instead of attributing a child output", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-inspect-replay-toplevel-"));
		const firstOutputPath = path.join(root, "first-output.txt");
		const secondOutputPath = path.join(root, "second-output.txt");
		fs.writeFileSync(firstOutputPath, "first output", "utf-8");
		fs.writeFileSync(secondOutputPath, "second output", "utf-8");
		const { resultsDir } = makeRun(root, {
			runId: "run-replay-toplevel",
			mode: "workflow",
			steps: [
				{ agent: "first", status: "complete", workflowKey: "first", startedAt: 100, endedAt: 150 },
				{ agent: "second", status: "complete", workflowKey: "second", startedAt: 100, endedAt: 150 },
			],
		});
		recordWaitCompletion(makeState(root), "run-replay-toplevel", {
			runId: "run-replay-toplevel",
			sessionId: SESSION_ID,
			results: [
				{ artifactPaths: { outputPath: firstOutputPath } },
				{ artifactPaths: { outputPath: secondOutputPath } },
			],
		}, Date.now(), 60_000, { resultsDir, sessionId: SESSION_ID });
		const reply = buildInspectReply({ requestId: "r-replay-toplevel", asyncId: "run-replay-toplevel" }, makeDeps(root, resultsDir));
		assert.equal(reply.error, undefined);
		assert.equal(reply.finalOutput, undefined);
	});
	it("routes legacy replay archives (no resultIndex) by agent and keeps child output out of run-level replies", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-inspect-replay-legacy-"));
		const firstOutputPath = path.join(root, "first-output.txt");
		const secondOutputPath = path.join(root, "second-output.txt");
		fs.writeFileSync(firstOutputPath, "first output", "utf-8");
		fs.writeFileSync(secondOutputPath, "second output", "utf-8");
		const { resultsDir } = makeRun(root, {
			runId: "run-replay-legacy",
			mode: "workflow",
			steps: [
				{ agent: "first", status: "complete", workflowKey: "first", startedAt: 100, endedAt: 150 },
				{ agent: "second", status: "complete", workflowKey: "second", startedAt: 100, endedAt: 150 },
			],
		});
		recordWaitCompletion(makeState(root), "run-replay-legacy", {
			runId: "run-replay-legacy",
			sessionId: SESSION_ID,
			results: [
				{ agent: "first", artifactPaths: { outputPath: firstOutputPath } },
				{ agent: "second", artifactPaths: { outputPath: secondOutputPath } },
			],
		}, Date.now(), 60_000, { resultsDir, sessionId: SESSION_ID });
		// Downgrade the archive to the pre-resultIndex legacy shape.
		const archivePath = completionArchivePath(resultsDir, "run-replay-legacy");
		const archive = JSON.parse(fs.readFileSync(archivePath, "utf-8"));
		for (const entry of archive.entries) delete entry.resultIndex;
		fs.writeFileSync(archivePath, JSON.stringify(archive), "utf-8");

		const child = buildInspectReply({ requestId: "r-legacy-child", asyncId: "run-replay-legacy", childId: "second" }, makeDeps(root, resultsDir));
		assert.equal(child.error, undefined);
		assert.equal(child.finalOutput, "second output");

		const topLevel = buildInspectReply({ requestId: "r-legacy-top", asyncId: "run-replay-legacy" }, makeDeps(root, resultsDir));
		assert.equal(topLevel.error, undefined);
		assert.equal(topLevel.finalOutput, undefined);
	});
	it("does not attribute a legacy same-agent sibling's output to a later child", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-inspect-replay-legacy-dup-"));
		const firstOutputPath = path.join(root, "first-output.txt");
		const secondOutputPath = path.join(root, "second-output.txt");
		fs.writeFileSync(firstOutputPath, "first output", "utf-8");
		fs.writeFileSync(secondOutputPath, "second output", "utf-8");
		const { resultsDir } = makeRun(root, {
			runId: "run-replay-legacy-dup",
			mode: "workflow",
			steps: [
				{ agent: "worker", status: "complete", workflowKey: "first", startedAt: 100, endedAt: 150 },
				{ agent: "worker", status: "complete", workflowKey: "second", startedAt: 100, endedAt: 150 },
			],
		});
		recordWaitCompletion(makeState(root), "run-replay-legacy-dup", {
			runId: "run-replay-legacy-dup",
			sessionId: SESSION_ID,
			results: [
				{ agent: "worker", artifactPaths: { outputPath: firstOutputPath } },
				{ agent: "worker", artifactPaths: { outputPath: secondOutputPath } },
			],
		}, Date.now(), 60_000, { resultsDir, sessionId: SESSION_ID });
		const archivePath = completionArchivePath(resultsDir, "run-replay-legacy-dup");
		const archive = JSON.parse(fs.readFileSync(archivePath, "utf-8"));
		for (const entry of archive.entries) delete entry.resultIndex;
		fs.writeFileSync(archivePath, JSON.stringify(archive), "utf-8");

		const second = buildInspectReply({ requestId: "r-legacy-dup", asyncId: "run-replay-legacy-dup", childId: "second" }, makeDeps(root, resultsDir));
		assert.equal(second.error, undefined);
		assert.equal(second.finalOutput, undefined);
	});
	it("joins all text parts of the terminal assistant message for session-backed output", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-inspect-multipart-"));
		const childSession = path.join(root, "multipart-session.jsonl");
		fs.writeFileSync(childSession, [
			JSON.stringify({ message: userMessage("child task") }),
			JSON.stringify({ message: { role: "assistant", content: [{ type: "text", text: "part one" }, { type: "text", text: "part two" }] } }),
		].join("\n") + "\n", "utf-8");
		const { resultsDir } = makeRun(root, {
			runId: "run-replay-multipart",
			mode: "workflow",
			steps: [{ agent: "worker", status: "complete", workflowKey: "worker", startedAt: 100, endedAt: 150, sessionFile: childSession }],
		});
		recordWaitCompletion(makeState(root), "run-replay-multipart", {
			runId: "run-replay-multipart",
			sessionId: SESSION_ID,
			results: [{ sessionFile: childSession }],
		}, Date.now(), 60_000, { resultsDir, sessionId: SESSION_ID });
		const reply = buildInspectReply({ requestId: "r-multipart", asyncId: "run-replay-multipart", childId: "worker" }, makeDeps(root, resultsDir));
		assert.equal(reply.error, undefined);
		assert.equal(reply.finalOutput, "part one\npart two");
	});
	it("reports an internal error when a current-version replay record fails validation", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-inspect-replay-invalid-"));
		const runId = "run-replay-invalid";
		const { resultsDir } = makeRun(root, { runId });
		recordWaitCompletion(makeState(root), runId, {
			runId,
			sessionId: SESSION_ID,
			results: [{ output: "finished output" }],
		}, Date.now(), 60_000, { resultsDir, sessionId: SESSION_ID });
		// Corrupt the record's archivePath so validation rejects it while the
		// record still parses and names this run and session.
		const replayFile = completionReplayPath(resultsDir, runId);
		const record = JSON.parse(fs.readFileSync(replayFile, "utf-8"));
		record.archivePath = path.join(root, "elsewhere.json");
		fs.writeFileSync(replayFile, JSON.stringify(record), "utf-8");
		const reply = buildInspectReply({ requestId: "r-replay-invalid", asyncId: runId }, makeDeps(root, resultsDir));
		assert.equal(reply.error?.code, "internal");
		assert.equal(reply.finalOutput, undefined);
	});
	it("reports an internal error when a durable replay archive is malformed", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-inspect-replay-malformed-"));
		const runId = "run-replay-malformed";
		const { resultsDir } = makeRun(root, { runId });
		recordWaitCompletion(makeState(root), runId, {
			runId,
			sessionId: SESSION_ID,
			results: [{ output: "finished output" }],
		}, Date.now(), 60_000, { resultsDir, sessionId: SESSION_ID });
		fs.writeFileSync(completionArchivePath(resultsDir, runId), JSON.stringify({ version: 1, runId, createdAt: 1, entries: "not-an-array" }), "utf-8");
		const reply = buildInspectReply({ requestId: "r-replay-malformed", asyncId: runId }, makeDeps(root, resultsDir));
		assert.equal(reply.error?.code, "internal");
		assert.equal(reply.finalOutput, undefined);
		assert.equal(JSON.stringify(reply).includes(root), false);
	});
	it("reports an internal error when an indexed result payload is malformed", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-inspect-result-malformed-"));
		const { resultsDir } = makeRun(root, { runId: "run-result-malformed", resultPayload: { summary: "valid" } });
		fs.writeFileSync(path.join(resultsDir, "run-result-malformed.json"), "{ invalid", "utf-8");
		const reply = buildInspectReply({ requestId: "r-result-malformed", asyncId: "run-result-malformed" }, makeDeps(root, resultsDir));
		assert.equal(reply.error?.code, "internal");
		assert.equal(reply.finalOutput, undefined);
		assert.equal(JSON.stringify(reply).includes(root), false);
	});
	it("fails closed instead of returning a private status error", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-inspect-status-error-"));
		const { resultsDir } = makeRun(root, { runId: "run-status-error", state: "failed", error: `Failed to write ${path.join(root, "result.json")}` });
		const reply = buildInspectReply({ requestId: "r-status-error", asyncId: "run-status-error" }, makeDeps(root, resultsDir));
		assert.equal(reply.error?.code, "internal");
		assert.equal(reply.finalOutput, undefined);
		assert.equal(JSON.stringify(reply).includes(root), false);
	});
});

describe("inspect-rpc bounds", () => {
	it("keeps the serialized reply under the global byte budget", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-inspect-budget-"));
		const big = "x".repeat(1_000);
		const { resultsDir } = makeRun(root, {
			runId: "run-big",
			sessionMessages: Array.from({ length: 300 }, (_, index) => assistantMessage(`${index}:${big}`)),
			resultPayload: { summary: big.repeat(9), results: [] },
		});
		const reply = buildInspectReply({ requestId: "r10", asyncId: "run-big", lines: 200 }, makeDeps(root, resultsDir));
		assert.equal(reply.error, undefined);
		const bytes = Buffer.byteLength(JSON.stringify(reply), "utf-8");
		assert.ok(bytes <= MAX_SERIALIZED_BYTES, `reply ${bytes} exceeds ${MAX_SERIALIZED_BYTES}`);
		assert.ok((reply.truncated?.messages ?? 0) > 0);
	});
	it("caps per-field lengths", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-inspect-caps-"));
		const { resultsDir } = makeRun(root, {
			runId: "run-caps",
			sessionMessages: [userMessage(`task ${"t".repeat(10_000)}`)],
			resultPayload: { summary: `out ${"o".repeat(20_000)}`, results: [] },
		});
		const reply = buildInspectReply({ requestId: "r11", asyncId: "run-caps" }, makeDeps(root, resultsDir));
		assert.ok(reply.task && reply.task.length <= 2_000 && reply.truncated?.task);
		assert.ok(reply.finalOutput && reply.finalOutput.length <= 8_000 && reply.truncated?.finalOutput);
	});
	it("preserves newlines in long-form content", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-inspect-lines-"));
		const { resultsDir } = makeRun(root, {
			runId: "run-lines",
			sessionMessages: [userMessage("line one\nline two")],
			resultPayload: { summary: "first\nsecond", results: [] },
		});
		const reply = buildInspectReply({ requestId: "r12", asyncId: "run-lines" }, makeDeps(root, resultsDir));
		assert.equal(reply.task, "line one\nline two");
		assert.equal(reply.finalOutput, "first\nsecond");
		// The wire line itself must stay single-line for prefix parsing.
		assert.equal(encodeInspectReply(reply)[0]?.includes("\n"), false);
	});
});

describe("inspect-rpc command surface", () => {
	it("answers unparseable args with an invalid_request reply", () => {
		const reply = handleInspectRpcArgs("not valid at all", { state: makeState(fs.mkdtempSync(path.join(os.tmpdir(), "pi-inspect-args-"))) });
		assert.equal(reply.error?.code, "invalid_request");
		assert.equal(reply.requestId, "not");
	});
	it("encodes replies with the widget prefix", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-inspect-encode-"));
		const { resultsDir } = makeRun(root, { runId: "run-e" });
		const lines = encodeInspectReply(buildInspectReply({ requestId: "r13", asyncId: "run-e" }, makeDeps(root, resultsDir)));
		assert.equal(lines.length, 1);
		assert.ok(lines[0]!.startsWith(INSPECT_WIDGET_PREFIX));
		const parsed = JSON.parse(lines[0]!.slice(INSPECT_WIDGET_PREFIX.length));
		assert.equal(parsed.kind, INSPECT_REPLY_KIND);
		assert.equal(parsed.requestId, "r13");
	});
});
