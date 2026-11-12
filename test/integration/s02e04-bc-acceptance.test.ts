import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { available, createRepo, createSubagentExecutor, installAsyncExecutionHooks, mockPi, mockAssistantMessage, tempDir, waitForAsyncResultFile, waitForAsyncState } from "../support/async-execution-fixture.ts";
import { createEventBus, events, makeAgent, makeMinimalCtx } from "../support/helpers.ts";

interface TestExecutorResult {
	content: Array<{ text?: string }>;
	isError?: boolean;
	details?: {
		workflow?: { value?: unknown };
		asyncId?: string;
		results?: Array<{ workflowKey?: string; finalOutput?: string; error?: string }>;
	};
}

function gitResult(cwd: string, args: string[]) {
	return spawnSync("git", ["-C", cwd, ...args], { encoding: "utf-8" });
}

function git(cwd: string, args: string[]): string {
	const result = gitResult(cwd, args);
	if (result.status !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || `git ${args.join(" ")} failed`);
	return result.stdout.trim();
}

function makeExecutor(config: Record<string, unknown> = {}) {
	return createSubagentExecutor!({
		pi: { events: createEventBus(), getSessionName: () => undefined, sendMessage() {} },
		state: { baseCwd: tempDir, currentSessionId: null, asyncJobs: new Map(), foregroundControls: new Map(), lastForegroundControlId: null },
		config,
		asyncByDefault: false,
		tempArtifactsDir: tempDir,
		getSubagentSessionRoot: () => tempDir,
		expandTilde: (value: string) => value,
		discoverAgents: () => ({ agents: [makeAgent("worker-a"), makeAgent("worker-b"), makeAgent("worker-c")] }),
	});
}

function callRecords(): Array<{ args?: string[]; cwd?: string }> {
	return fs.readdirSync(mockPi.dir)
		.filter((name) => name.startsWith("call-") && name.endsWith(".json"))
		.map((name) => JSON.parse(fs.readFileSync(path.join(mockPi.dir, name), "utf-8")) as { args?: string[]; cwd?: string });
}

function writeCommit(repo: string, message: string): void {
	git(repo, ["add", "-A"]);
	git(repo, ["commit", "-m", message]);
}

describe("S02E04 deterministic acceptance through the existing Runner", { skip: !available || !createSubagentExecutor ? "Pi test runtime not available" : undefined }, () => {
	installAsyncExecutionHooks();
	let repo: string;
	let worktreeBaseDir: string;

	before(() => {
		repo = createRepo("pi-s02e04-bc-acceptance-");
		worktreeBaseDir = path.join(path.dirname(repo), `${path.basename(repo)}-worktrees`);
		fs.writeFileSync(path.join(repo, "evidence.md"), "release marker: ALPHA\n", "utf-8");
		fs.writeFileSync(path.join(repo, "verify-evidence.cjs"), [
			"const fs = require('node:fs');",
			"const { spawnSync } = require('node:child_process');",
			"const head = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });",
			"const ok = head.status === 0 && head.stdout.trim() === process.argv[2] && fs.readFileSync('evidence.md', 'utf8').includes('release marker: ALPHA');",
			"process.exit(ok ? 0 : 1);",
		].join("\n"), "utf-8");
		writeCommit(repo, "add deterministic evidence fixture");
	});

	beforeEach(() => mockPi.reset());
	after(() => {
		if (repo) fs.rmSync(repo, { recursive: true, force: true });
		if (worktreeBaseDir) fs.rmSync(worktreeBaseDir, { recursive: true, force: true });
	});

	it("B: relays bounded evidence with source and actual verification status, while retaining stale hypotheses as untrusted", async () => {
		const currentRef = git(repo, ["rev-parse", "HEAD"]);
		const oldRef = "0".repeat(40);
		const findingsSchema = {
			type: "object",
			required: ["findings"],
			properties: {
				findings: {
					type: "array",
					items: {
						type: "object",
						required: ["claim", "classification", "source"],
						properties: {
							claim: { type: "string" },
							classification: { enum: ["verified", "hypothesis"] },
							source: { type: "object", required: ["path", "ref"], properties: { path: { type: "string" }, ref: { type: "string" } } },
						},
					},
				},
			},
		};
		const workerBResultSchema = {
			type: "object",
			required: ["used", "held"],
			properties: {
				used: { type: "array", items: { type: "string" } },
				held: { type: "array", items: { type: "string" } },
			},
		};
		const findingOutput = {
			findings: [
				{ claim: "release marker is ALPHA", classification: "verified", source: { path: "evidence.md", ref: currentRef } },
				{ claim: "legacy marker is BETA", classification: "hypothesis", source: { path: "legacy.md", ref: oldRef } },
			],
		};
		mockPi.onCall({ output: "FULL_TRANSCRIPT_SENTINEL; do not copy this session history", structuredOutput: findingOutput });
		mockPi.onCall({
			output: "Used only the verified current evidence; held the stale hypothesis.",
			structuredOutput: { used: ["release marker is ALPHA"], held: ["legacy marker is BETA"] },
		});

		const workflowScript = `
			const source = await runs.run("source", {
				agent: "worker-a",
				task: "Return a finding and its source reference.",
				outputSchema: ${JSON.stringify(findingsSchema)},
				acceptance: { level: "verified", verify: [{ id: "current-source", command: "node verify-evidence.cjs ${currentRef}" }] }
			});
			const sourceAcceptance = source.results && source.results[0] && source.results[0].acceptance && source.results[0].acceptance.status;
			const findings = source.structuredOutput && Array.isArray(source.structuredOutput.findings) ? source.structuredOutput.findings : [];
			const envelope = {
				source: { worker: source.agent, workflowKey: source.key, runId: source.runId, acceptanceStatus: sourceAcceptance },
				currentRef: args.currentRef,
				verified: sourceAcceptance === "verified" ? findings.filter(item => item.classification === "verified" && item.source && item.source.ref === args.currentRef) : [],
				held: findings.filter(item => item.classification !== "verified" || !item.source || item.source.ref !== args.currentRef).map(item => ({ claim: item.claim, classification: item.classification, source: item.source, reason: item.source && item.source.ref !== args.currentRef ? "stale source reference" : "hypothesis is not a verified fact" }))
			};
			const consumer = await runs.run("consumer", {
				agent: "worker-b",
				task: "Use this compact evidence envelope only; keep held entries untrusted: " + JSON.stringify(envelope),
				outputSchema: ${JSON.stringify(workerBResultSchema)},
				acceptance: false
			});
			return { envelope, consumer: consumer.structuredOutput };
		`;
		const result = await makeExecutor().executePublic("s02e04-b-context", {
			workflowScript,
			args: { currentRef },
			async: false,
			cwd: repo,
			output: false,
		}, new AbortController().signal, undefined, makeMinimalCtx(repo)) as TestExecutorResult;

		assert.equal(result.isError, undefined, result.content.map((part) => part.text ?? "").join("\n"));
		const value = result.details?.workflow?.value as { envelope?: { source?: { worker?: string; workflowKey?: string; acceptanceStatus?: string }; verified?: Array<{ claim?: string; source?: { path?: string; ref?: string } }>; held?: Array<{ claim?: string; reason?: string }> }; consumer?: { used?: string[]; held?: string[] } };
		assert.equal(value.envelope?.source?.worker, "worker-a");
		assert.equal(value.envelope?.source?.workflowKey, "source");
		assert.equal(value.envelope?.source?.acceptanceStatus, "verified");
		assert.deepEqual(value.envelope?.verified?.map((item) => [item.claim, item.source?.path, item.source?.ref]), [["release marker is ALPHA", "evidence.md", currentRef]]);
		assert.deepEqual(value.envelope?.held?.map((item) => [item.claim, item.reason]), [["legacy marker is BETA", "stale source reference"]]);
		assert.deepEqual(value.consumer, { used: ["release marker is ALPHA"], held: ["legacy marker is BETA"] });
		const consumerPrompt = callRecords().find((record) => JSON.stringify(record.args).includes("compact evidence envelope"));
		assert.ok(consumerPrompt, "worker B was launched with the targeted envelope");
		assert.match(JSON.stringify(consumerPrompt.args), /evidence\.md/);
		assert.match(JSON.stringify(consumerPrompt.args), /acceptanceStatus/);
		assert.doesNotMatch(JSON.stringify(consumerPrompt.args), /FULL_TRANSCRIPT_SENTINEL/);
	});

	it("C: captures and applies independent worktree patches; holds only a conflicting patch without losing its artifact or blocking independent work", async () => {
		const executeGroup = async (runId: string, tasks: Array<{ key: string; agent: string; task: string }>): Promise<{ manifestPaths: string[]; patches: Array<{ agent: string; path: string }> }> => {
			const taskJson = JSON.stringify(tasks.map((task) => ({ ...task, cwd: repo })));
			const script = `const results = await runs.all(${taskJson}); return results.map(result => ({ key: result.key, agent: result.agent, ok: result.ok, artifactPaths: result.artifactPaths }));`;
			const result = await makeExecutor({ worktreeProvider: "native", worktree: true, worktreeBaseDir })
				.executePublic(runId, { workflowScript: script, async: false, cwd: repo, worktree: true, output: false }, new AbortController().signal, undefined, makeMinimalCtx(repo)) as TestExecutorResult;
			assert.equal(result.isError, undefined, result.content.map((part) => part.text ?? "").join("\n"));
			const childReports = result.details?.workflow?.value as Array<{ artifactPaths?: string[] }>;
			const artifactPaths = childReports.flatMap((child) => child.artifactPaths ?? []).filter((artifact) => fs.existsSync(artifact));
			const manifestPaths = artifactPaths.filter((artifact) => {
				try { return Array.isArray(JSON.parse(fs.readFileSync(artifact, "utf-8")).groups); } catch { return false; }
			});
			assert.equal(manifestPaths.length, tasks.length, "each isolated workflow child exposes its existing handoff manifest as an artifact");
			const patches: Array<{ agent: string; path: string }> = [];
			for (const manifestPath of manifestPaths) {
				const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as { groups?: Array<{ children?: Array<{ agent: string; patch: { path: string; changed: boolean } }>; cleanup?: { state?: string; tasks?: Array<{ worktreeRemoved?: boolean }> } }> };
				for (const group of manifest.groups ?? []) {
					assert.equal(group.cleanup?.state, "complete");
					assert.ok(group.cleanup?.tasks?.every((task) => task.worktreeRemoved));
					patches.push(...(group.children ?? []).map((child) => ({ agent: child.agent, path: child.patch.path })));
					assert.ok((group.children ?? []).every((child) => child.patch.changed));
				}
			}
			assert.equal(patches.length, tasks.length);
			assert.ok(patches.every((patch) => fs.existsSync(patch.path)));
			return { manifestPaths, patches };
		};
		const applyPatch = (patchPath: string) => {
			const check = gitResult(repo, ["apply", "--check", patchPath]);
			if (check.status !== 0) return check;
			return gitResult(repo, ["apply", patchPath]);
		};

		mockPi.onCall({ output: "changed A", writeFiles: [{ path: "file-a.txt", content: "worker A\n" }] });
		mockPi.onCall({ output: "changed B", writeFiles: [{ path: "file-b.txt", content: "worker B\n" }] });
		const independent = await executeGroup("s02e04-c-independent", [
			{ key: "a", agent: "worker-a", task: "Write only file-a.txt" },
			{ key: "b", agent: "worker-b", task: "Write only file-b.txt" },
		]);
		assert.equal(fs.existsSync(path.join(repo, "file-a.txt")), false);
		assert.equal(fs.existsSync(path.join(repo, "file-b.txt")), false);
		for (const patch of independent.patches) {
			const applied = applyPatch(patch.path);
			assert.equal(applied.status, 0, applied.stderr);
		}
		assert.equal(fs.readFileSync(path.join(repo, "file-a.txt"), "utf-8"), "worker A\n");
		assert.equal(fs.readFileSync(path.join(repo, "file-b.txt"), "utf-8"), "worker B\n");
		writeCommit(repo, "integrate independent worker patches");

		fs.writeFileSync(path.join(repo, "shared.txt"), "base\n", "utf-8");
		writeCommit(repo, "prepare shared-file conflict fixture");
		mockPi.reset();
		mockPi.onCall({ output: "conflict A", writeFiles: [{ path: "shared.txt", content: "worker A version\n" }] });
		mockPi.onCall({ output: "conflict B", writeFiles: [{ path: "shared.txt", content: "worker B version\n" }] });
		mockPi.onCall({ output: "independent C", writeFiles: [{ path: "independent.txt", content: "worker C\n" }] });
		const conflict = await executeGroup("s02e04-c-conflict", [
			{ key: "conflict-a", agent: "worker-a", task: "Change shared.txt" },
			{ key: "conflict-b", agent: "worker-b", task: "Change shared.txt differently" },
			{ key: "independent-c", agent: "worker-c", task: "Write independent.txt" },
		]);
		const patchFor = (agent: string) => conflict.patches.find((patch) => patch.agent === agent)?.path;
		const patchA = patchFor("worker-a");
		const patchB = patchFor("worker-b");
		const patchC = patchFor("worker-c");
		assert.ok(patchA && patchB && patchC);
		assert.equal(applyPatch(patchA).status, 0);
		assert.equal(applyPatch(patchC).status, 0, "independent worker C continues despite A/B conflict");
		const heldB = gitResult(repo, ["apply", "--check", patchB]);
		assert.notEqual(heldB.status, 0, "Git detects that worker B's patch conflicts with the already-applied worker A patch");
		assert.ok(fs.existsSync(patchB), "the conflicting patch is retained for parent resolution");
		assert.match(fs.readFileSync(patchB, "utf-8"), /worker B version/);
		assert.equal(fs.readFileSync(path.join(repo, "shared.txt"), "utf-8"), "worker A version\n");
		assert.equal(fs.readFileSync(path.join(repo, "independent.txt"), "utf-8"), "worker C\n");
		assert.ok(conflict.manifestPaths.every((manifestPath) => fs.existsSync(manifestPath)));
	});

	it("D: flags an isolated stalled worker without stopping a healthy sibling, then recovers the same run", async (t) => {
		const releasePath = path.join(mockPi.dir, "s02e04-d-stalled-worker-release");
		t.after(() => fs.writeFileSync(releasePath, "release"));
		mockPi.onCall({
			matchArgIncludes: "S02E04_D_STALLED_WORKER",
			steps: [
				{ jsonl: [events.toolStart("read", { path: "evidence.md" }), events.toolEnd("read"), events.toolResult("read", "fixture data"), mockAssistantMessage("started", "tool_use")] },
				{ waitForPath: releasePath, jsonl: [events.assistantMessage("recovered after parent observation")] },
			],
		});
		mockPi.onCall({ matchArgIncludes: "S02E04_D_HEALTHY_WORKER", output: "independent worker completed" });
		const result = await makeExecutor({ control: {
			enabled: true,
			needsAttentionAfterMs: 100,
			activeNoticeAfterMs: 999_999,
			activeNoticeAfterTurns: 999_999,
			activeNoticeAfterTokens: 999_999,
			notifyOn: ["needs_attention"],
		} }).executePublic("s02e04-d-stall-recovery", {
			workflowScript: `const results = await Promise.all([
				runs.run("stalled", { agent: "worker-a", task: "S02E04_D_STALLED_WORKER", acceptance: false }),
				runs.run("healthy", { agent: "worker-b", task: "S02E04_D_HEALTHY_WORKER", acceptance: false })
			]); return results.map(result => ({ key: result.key, agent: result.agent, ok: result.ok }));`,
			async: true,
			cwd: repo,
			output: false,
		}, new AbortController().signal, undefined, makeMinimalCtx(repo)) as TestExecutorResult;

		assert.equal(result.isError, undefined, result.content.map((part) => part.text ?? "").join("\n"));
		assert.ok(result.details?.asyncId, "isolated workflow returned its own run id");
		const stalled = await waitForAsyncState(result.details.asyncId, (status) =>
			status.steps?.some((step) => step.agent === "worker-a" && step.status === "running" && step.activityState === "needs_attention") === true
			&& status.steps?.some((step) => step.agent === "worker-b" && step.status === "completed") === true,
		10_000);
		assert.equal(stalled.state, "running", "the stalled child is surfaced for attention, not treated as whole-workflow failure");
		assert.ok(fs.existsSync(releasePath) === false, "the held worker was not released before the parent observed the stalled state");

		fs.writeFileSync(releasePath, "release");
		const resultPath = await waitForAsyncResultFile(result.details.asyncId, 10_000);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as { success?: boolean; results?: Array<{ agent?: string; output?: string }> };
		assert.equal(payload.success, true);
		assert.ok(payload.results?.some((child) => child.agent === "worker-a" && child.output?.includes("recovered after parent observation")));
		assert.ok(payload.results?.some((child) => child.agent === "worker-b" && child.output?.includes("independent worker completed")));
	});

	it("G: continues an independent lane after partial failure and adjusts the plan without replaying completed work", async () => {
		mockPi.onCall({ matchArgIncludes: "S02E04_FAIL_LANE", exitCode: 1, stderr: "controlled lane failure" });
		mockPi.onCall({ matchArgIncludes: "S02E04_HEALTHY_PREPARE", output: "prepared-once" });
		mockPi.onCall({ matchArgIncludes: "S02E04_HEALTHY_REVIEW", output: "reviewed" });
		mockPi.onCall({ matchArgIncludes: "S02E04_PLAN_ADJUSTMENT", output: "adjusted-plan-complete" });
		const workflowScript = `
			const board = await runs.lanes([
				{ key: "failed-lane", stages: [
					{ key: "write", agent: "worker-a", task: "S02E04_FAIL_LANE", acceptance: false },
					{ key: "must-skip", agent: "worker-b", task: "S02E04_FAIL_LANE_FOLLOWUP", acceptance: false }
				] },
				{ key: "independent-lane", stages: [
					{ key: "prepare", agent: "worker-b", task: "S02E04_HEALTHY_PREPARE", acceptance: false },
					{ key: "review", agent: "worker-a", task: "S02E04_HEALTHY_REVIEW", acceptance: false }
				] }
			]);
			const healthy = board.find(lane => lane.key === "independent-lane");
			const adjustment = healthy && healthy.state === "complete"
				? await runs.run("plan-adjusted", { agent: "worker-c", task: "S02E04_PLAN_ADJUSTMENT", acceptance: false })
				: undefined;
			return { board, adjustment: { basedOn: healthy && healthy.state, output: adjustment && adjustment.output } };
		`;
		const result = await makeExecutor().executePublic("s02e04-g-partial-plan-change", {
			workflowScript,
			async: false,
			cwd: repo,
			output: false,
		}, new AbortController().signal, undefined, makeMinimalCtx(repo)) as TestExecutorResult;

		assert.equal(result.isError, undefined, result.content.map((part) => part.text ?? "").join("\n"));
		const value = result.details?.workflow?.value as { board?: Array<{ key?: string; state?: string; failedStage?: string; stages?: Array<{ key?: string; state?: string; output?: string }> }>; adjustment?: { basedOn?: string; output?: string } };
		assert.equal(value.board?.find((lane) => lane.key === "failed-lane")?.state, "blocked");
		assert.equal(value.board?.find((lane) => lane.key === "failed-lane")?.stages?.[1]?.state, "skipped");
		assert.deepEqual(value.board?.find((lane) => lane.key === "independent-lane")?.stages?.map((stage) => [stage.key, stage.state]), [
			["prepare", "completed"],
			["review", "completed"],
		]);
		assert.equal(result.details?.results?.find((child) => child.workflowKey === "independent-lane.prepare")?.finalOutput, "prepared-once");
		assert.equal(result.details?.results?.find((child) => child.workflowKey === "independent-lane.review")?.finalOutput, "reviewed");
		assert.deepEqual(value.adjustment, { basedOn: "complete", output: "adjusted-plan-complete" });
		const calls = callRecords().map((record) => JSON.stringify(record.args));
		assert.equal(calls.length, 4);
		assert.equal(calls.filter((args) => args.includes("S02E04_HEALTHY_PREPARE")).length, 1, "completed independent work is not replayed after the plan change");
		assert.equal(calls.some((args) => args.includes("S02E04_FAIL_LANE_FOLLOWUP")), false, "failure blocks only the dependent stage in its lane");
	});
});
