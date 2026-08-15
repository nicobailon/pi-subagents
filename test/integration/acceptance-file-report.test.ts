/**
 * Acceptance report sourcing through the real execution drivers: the report the
 * child wrote to its configured output file (recovered from its write tool
 * calls) versus the assistant text, ordered by outputMode, including parallel
 * children with the distinct configured paths required after #420. Runs the
 * full spawn → stream-parse → acceptance pipeline against the mock pi CLI.
 */
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import type { MockPi } from "../support/helpers.ts";
import { createEventBus, createMockPi, createTempDir, events, makeAgent, makeAgentConfigs, makeMinimalCtx, removeTempDir, tryImport } from "../support/helpers.ts";

interface AcceptanceSummary {
	status?: string;
	childReport?: { criteriaSatisfied?: Array<{ id?: string; status?: string; evidence?: string }> };
	runtimeChecks?: Array<{ id?: string; status?: string; message?: string }>;
}

interface AcceptanceArtifactPaths {
	outputPath: string;
	metadataPath: string;
	transcriptPath: string;
}

interface ExecutionModule {
	runSync(
		runtimeCwd: string,
		agents: ReturnType<typeof makeAgentConfigs>,
		agentName: string,
		task: string,
		options: Record<string, unknown>,
	): Promise<{
		exitCode: number;
		error?: string;
		finalOutput?: string;
		savedOutputPath?: string;
		acceptance?: AcceptanceSummary;
		artifactPaths?: AcceptanceArtifactPaths;
	}>;
}

interface AsyncExecutionModule {
	isAsyncAvailable(): boolean;
	executeAsyncSingle(id: string, params: Record<string, unknown>): unknown;
}

interface TypesModule {
	ASYNC_DIR: string;
	RESULTS_DIR: string;
}

interface ExecutorModule {
	createSubagentExecutor?: (...args: unknown[]) => {
		execute: (...args: unknown[]) => Promise<{ content: Array<{ text?: string }>; isError?: boolean; details?: { asyncId?: string } }>;
	};
}

interface AsyncResultPayload {
	success: boolean;
	results: Array<{ output?: string; error?: string; acceptance?: AcceptanceSummary; artifactPaths?: AcceptanceArtifactPaths }>;
}

const execution = await tryImport<ExecutionModule>("./src/runs/foreground/execution.ts");
const asyncMod = await tryImport<AsyncExecutionModule>("./src/runs/background/async-execution.ts");
const typesMod = await tryImport<TypesModule>("./src/shared/types.ts");
const executorMod = await tryImport<ExecutorModule>("./src/runs/foreground/subagent-executor.ts");

const runSync = execution?.runSync;
const isAsyncAvailable = asyncMod?.isAsyncAvailable;
const executeAsyncSingle = asyncMod?.executeAsyncSingle;
const ASYNC_DIR = typesMod?.ASYNC_DIR;
const RESULTS_DIR = typesMod?.RESULTS_DIR;
const createSubagentExecutor = executorMod?.createSubagentExecutor;

const DISABLED_ARTIFACTS = {
	enabled: false,
	includeInput: false,
	includeOutput: false,
	includeJsonl: false,
	includeMetadata: false,
	cleanupDays: 7,
};

const ACCEPTANCE_ARTIFACTS = {
	enabled: true,
	includeInput: false,
	includeOutput: true,
	includeJsonl: false,
	includeTranscript: true,
	includeMetadata: true,
	cleanupDays: 7,
};

function acceptanceReport(criterionStatus: "satisfied" | "not-satisfied", evidence: string): string {
	return [
		"```acceptance-report",
		JSON.stringify({
			criteriaSatisfied: [{ id: "criterion-1", status: criterionStatus, evidence }],
			changedFiles: ["src/module.ts"],
			testsAddedOrUpdated: ["test/module.test.ts"],
			commandsRun: [{ command: "npm test", result: "passed", summary: "passed" }],
			validationOutput: ["passed"],
			residualRisks: [],
			noStagedFiles: true,
			notes: evidence,
		}),
		"```",
	].join("\n");
}

async function waitForAsyncResult(id: string, timeoutMs = 15_000): Promise<AsyncResultPayload> {
	const resultPath = path.join(RESULTS_DIR!, `${id}.json`);
	const deadline = Date.now() + timeoutMs;
	while (!fs.existsSync(resultPath)) {
		if (Date.now() > deadline) assert.fail(`Timed out waiting for async result file: ${resultPath}`);
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	return JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
}

describe("acceptance file reports", { skip: !runSync ? "pi packages not available" : undefined }, () => {
	let tempDir: string;
	let mockPi: MockPi;

	before(() => {
		mockPi = createMockPi();
		mockPi.install();
	});

	after(() => {
		mockPi.uninstall();
	});

	beforeEach(() => {
		tempDir = createTempDir();
		mockPi.reset();
	});

	afterEach(() => {
		removeTempDir(tempDir);
	});

	function conflictingReportsCall(outputPath: string, fileStatus: "satisfied" | "not-satisfied", textStatus: "satisfied" | "not-satisfied") {
		const fileReport = `# Findings\n${acceptanceReport(fileStatus, "from child-written file")}`;
		mockPi.onCall({
			jsonl: [
				...events.completedWrite(outputPath, fileReport),
				events.assistantMessage(`Report written to the output file.\n${acceptanceReport(textStatus, "from assistant text")}`),
			],
			writeFiles: [{ path: outputPath, content: fileReport }],
		});
	}

	describe("foreground runSync", () => {
		it("file-only mode accepts from the child-written file when the text report fails", async () => {
			const outputPath = path.join(tempDir, "report.md");
			conflictingReportsCall(outputPath, "satisfied", "not-satisfied");

			const result = await runSync!(tempDir, makeAgentConfigs(["worker"]), "worker", "Write the findings report.", {
				runId: "acceptance-file-only",
				outputPath,
				outputMode: "file-only",
				acceptance: { level: "checked", criteria: ["Report the findings"] },
			});

			assert.equal(result.acceptance?.status, "checked");
			assert.equal(result.exitCode, 0);
			assert.equal(result.savedOutputPath, outputPath);
		});

		it("file-only mode persists acceptance metadata when final assistant text is only a receipt", async () => {
			const outputPath = path.join(tempDir, "saved-review.md");
			const artifactsDir = path.join(tempDir, "artifacts");
			const fileReport = `# Review\n${acceptanceReport("satisfied", "foreground saved verdict")}`;
			mockPi.onCall({
				jsonl: [...events.completedWrite(outputPath, fileReport), events.assistantMessage("Output saved to the configured file.")],
				writeFiles: [{ path: outputPath, content: fileReport }],
			});

			const result = await runSync!(tempDir, makeAgentConfigs(["worker"]), "worker", "Write the findings report.", {
				runId: "acceptance-foreground-saved-receipt",
				outputPath,
				outputMode: "file-only",
				acceptance: { level: "checked", criteria: ["Report the findings"] },
				artifactsDir,
				artifactConfig: ACCEPTANCE_ARTIFACTS,
			});

			assert.equal(result.acceptance?.status, "checked");
			assert.equal(result.acceptance?.childReport?.criteriaSatisfied?.[0]?.evidence, "foreground saved verdict");
			assert.equal(result.exitCode, 0);
			assert.ok(result.artifactPaths);
			const metadata = JSON.parse(fs.readFileSync(result.artifactPaths.metadataPath, "utf-8")) as { exitCode?: number; acceptance?: AcceptanceSummary };
			assert.equal(metadata.exitCode, 0);
			assert.equal(metadata.acceptance?.status, "checked");
			assert.equal(metadata.acceptance?.childReport?.criteriaSatisfied?.[0]?.evidence, "foreground saved verdict");
			assert.doesNotMatch(fs.readFileSync(result.artifactPaths.outputPath, "utf-8"), /```acceptance-report/);
		});

		it("persists a report-only child response in metadata while normal output stays clean", async () => {
			const artifactsDir = path.join(tempDir, "report-only-artifacts");
			mockPi.onCall({ output: acceptanceReport("satisfied", "report-only evidence") });

			const result = await runSync!(tempDir, [makeAgent("worker", { completionGuard: false })], "worker", "Implement and report the fix.", {
				runId: "acceptance-report-only",
				acceptance: { level: "checked", criteria: ["Report the findings"] },
				artifactsDir,
				artifactConfig: ACCEPTANCE_ARTIFACTS,
			});

			assert.equal(result.exitCode, 0);
			assert.equal(result.finalOutput, "");
			assert.ok(result.artifactPaths);
			assert.equal(fs.readFileSync(result.artifactPaths.outputPath, "utf-8"), "");
			const metadata = JSON.parse(fs.readFileSync(result.artifactPaths.metadataPath, "utf-8")) as { acceptance?: AcceptanceSummary };
			assert.equal(metadata.acceptance?.status, "checked");
			assert.equal(metadata.acceptance?.childReport?.criteriaSatisfied?.[0]?.evidence, "report-only evidence");
			assert.match(fs.readFileSync(result.artifactPaths.transcriptPath, "utf-8"), /```acceptance-report/);
		});

		it("inline mode persists final rejection metadata when the text report fails", async () => {
			const outputPath = path.join(tempDir, "report.md");
			const artifactsDir = path.join(tempDir, "rejected-artifacts");
			conflictingReportsCall(outputPath, "satisfied", "not-satisfied");

			const result = await runSync!(tempDir, makeAgentConfigs(["worker"]), "worker", "Write the findings report.", {
				runId: "acceptance-inline-text-first",
				outputPath,
				acceptance: { level: "checked", criteria: ["Report the findings"] },
				artifactsDir,
				artifactConfig: ACCEPTANCE_ARTIFACTS,
			});

			assert.equal(result.acceptance?.status, "rejected");
			assert.equal(result.exitCode, 1);
			assert.match(result.finalOutput ?? "", /Output saved to:/);
			assert.match(result.finalOutput ?? "", new RegExp(outputPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
			assert.match(result.error ?? "", /Acceptance rejected: Required criterion 'criterion-1' was reported as not-satisfied\./);
			assert.ok(result.artifactPaths);
			const metadata = JSON.parse(fs.readFileSync(result.artifactPaths.metadataPath, "utf-8")) as { exitCode?: number; error?: string; acceptance?: AcceptanceSummary };
			assert.equal(metadata.exitCode, 1);
			assert.match(metadata.error ?? "", /Acceptance rejected/);
			assert.equal(metadata.acceptance?.status, "rejected");
			assert.equal(metadata.acceptance?.runtimeChecks?.find((check) => check.id === "criterion:criterion-1")?.status, "failed");
			const outputArtifact = fs.readFileSync(result.artifactPaths.outputPath, "utf-8");
			assert.match(outputArtifact, /Output saved to:/);
			assert.match(outputArtifact, new RegExp(outputPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
		});

		it("inline mode keeps one saved output reference after rejection", { skip: !createSubagentExecutor ? "executor not available" : undefined }, async () => {
			const outputPath = path.join(tempDir, "report.md");
			const artifactsDir = path.join(tempDir, "rejected-inline-artifacts");
			conflictingReportsCall(outputPath, "satisfied", "not-satisfied");
			const executor = createSubagentExecutor!({
				pi: { events: createEventBus(), getSessionName: () => undefined },
				state: { baseCwd: tempDir, currentSessionId: null, asyncJobs: new Map(), foregroundControls: new Map(), lastForegroundControlId: null },
				config: { artifactDir: "temp" },
				asyncByDefault: false,
				tempArtifactsDir: artifactsDir,
				getSubagentSessionRoot: () => tempDir,
				expandTilde: (p: string) => p,
				discoverAgents: () => ({ agents: [makeAgent("worker", { completionGuard: false })] }),
			});

			const result = await executor.execute(
				"acceptance-inline-single-reference-rejection",
				{
					agent: "worker",
					task: "Write the findings report.",
					output: outputPath,
					acceptance: { level: "checked", criteria: ["Report the findings"] },
				},
				new AbortController().signal,
				undefined,
				makeMinimalCtx(tempDir),
			);

			assert.equal(result.isError, true);
			const content = result.content[0]?.text ?? "";
			assert.equal(content.match(/Output saved to:/g)?.length, 1);
			assert.match(content, new RegExp(outputPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
			assert.equal(result.details?.results?.[0]?.acceptance?.status, "rejected");
			assert.match(result.details?.results?.[0]?.finalOutput ?? "", /Output saved to:/);
		});

		it("inline mode keeps the saved output visible after maxOutput truncation on rejection", { skip: !createSubagentExecutor ? "executor not available" : undefined }, async () => {
			const outputPath = path.join(tempDir, "report.md");
			const artifactsDir = path.join(tempDir, "rejected-max-output-artifacts");
			const fileReport = `# Findings\n${"Saved report detail. ".repeat(300)}\n${acceptanceReport("satisfied", "from child-written file")}`;
			mockPi.onCall({
				jsonl: [
					...events.completedWrite(outputPath, fileReport),
					events.assistantMessage(`Report written to the output file.\n${acceptanceReport("not-satisfied", "from assistant text")}`),
				],
				writeFiles: [{ path: outputPath, content: fileReport }],
			});
			const executor = createSubagentExecutor!({
				pi: { events: createEventBus(), getSessionName: () => undefined },
				state: { baseCwd: tempDir, currentSessionId: null, asyncJobs: new Map(), foregroundControls: new Map(), lastForegroundControlId: null },
				config: { artifactDir: "temp" },
				asyncByDefault: false,
				tempArtifactsDir: artifactsDir,
				getSubagentSessionRoot: () => tempDir,
				expandTilde: (p: string) => p,
				discoverAgents: () => ({ agents: [makeAgent("worker", { completionGuard: false })] }),
			});

			const result = await executor.execute(
				"acceptance-inline-max-output-rejection",
				{
					agent: "worker",
					task: "Write the findings report.",
					output: outputPath,
					acceptance: { level: "checked", criteria: ["Report the findings"] },
					maxOutput: { bytes: 40, lines: 1 },
				},
				new AbortController().signal,
				undefined,
				makeMinimalCtx(tempDir),
			);

			assert.equal(result.isError, true);
			const content = result.content[0]?.text ?? "";
			assert.match(content, /\[TRUNCATED:/);
			assert.match(content, /Output saved to:/);
			assert.match(content, new RegExp(outputPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
			assert.doesNotMatch(content, /Saved report detail/);
			assert.equal(result.details?.results?.[0]?.acceptance?.status, "rejected");
			assert.match(result.details?.results?.[0]?.finalOutput ?? "", /Output saved to:/);
		});

		it("inline mode accepts on the text report regardless of a failing file report", async () => {
			const outputPath = path.join(tempDir, "report.md");
			conflictingReportsCall(outputPath, "not-satisfied", "satisfied");

			const result = await runSync!(tempDir, makeAgentConfigs(["worker"]), "worker", "Write the findings report.", {
				runId: "acceptance-inline-file-fallback-only",
				outputPath,
				acceptance: { level: "checked", criteria: ["Report the findings"] },
			});

			assert.equal(result.acceptance?.status, "checked");
			assert.equal(result.exitCode, 0);
		});

		it("does not credit a failed write as the file report", async () => {
			const outputPath = path.join(tempDir, "report.md");
			const fileReport = `# Findings\n${acceptanceReport("satisfied", "from a write that failed")}`;
			mockPi.onCall({
				jsonl: [
					{
						type: "message_end",
						message: {
							role: "assistant",
							content: [{ type: "toolCall", id: "w-failed", name: "write", arguments: { path: outputPath, content: fileReport } }],
							model: "mock/test-model",
							stopReason: "toolUse",
							usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } },
						},
					},
					{
						type: "tool_result_end",
						message: { role: "toolResult", toolCallId: "w-failed", toolName: "write", isError: true, content: [{ type: "text", text: "disk full" }] },
					},
					events.assistantMessage(`The write failed.\n${acceptanceReport("not-satisfied", "from assistant text")}`),
				],
			});

			const result = await runSync!(tempDir, makeAgentConfigs(["worker"]), "worker", "Write the findings report.", {
				runId: "acceptance-failed-write",
				outputPath,
				outputMode: "file-only",
				acceptance: { level: "checked", criteria: ["Report the findings"] },
			});

			assert.equal(result.acceptance?.status, "rejected");
			assert.equal(result.exitCode, 1);
			assert.match(result.error ?? "", /reported as not-satisfied/);
		});

		it("rejects a malformed child-written file report instead of accepting the text report", async () => {
			const outputPath = path.join(tempDir, "report.md");
			const malformedReport = "```acceptance-report\n{ not json";
			mockPi.onCall({
				jsonl: [
					...events.completedWrite(outputPath, malformedReport),
					events.assistantMessage(acceptanceReport("satisfied", "from assistant text")),
				],
				writeFiles: [{ path: outputPath, content: malformedReport }],
			});

			const result = await runSync!(tempDir, makeAgentConfigs(["worker"]), "worker", "Write the findings report.", {
				runId: "acceptance-malformed-file-report",
				outputPath,
				outputMode: "file-only",
				acceptance: { level: "checked", criteria: ["Report the findings"] },
			});

			assert.equal(result.acceptance?.status, "rejected");
			assert.equal(result.exitCode, 1);
			assert.match(result.error ?? "", /Failed to parse acceptance-report: Expected property name.*configured output/);
		});
	});

	describe("background runner", { skip: isAsyncAvailable && !isAsyncAvailable() ? "jiti not available" : undefined }, () => {
		function runAsyncSingle(id: string, outputPath: string, outputMode: "inline" | "file-only", artifactConfig = DISABLED_ARTIFACTS) {
			executeAsyncSingle!(id, {
				agent: "worker",
				task: "Write the findings report.",
				agentConfig: makeAgent("worker", { completionGuard: false }),
				ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-file-report" },
				artifactConfig,
				artifactsDir: path.join(tempDir, ".pi/subagents", "artifacts"),
				shareEnabled: false,
				maxSubagentDepth: 2,
				output: outputPath,
				outputMode,
				acceptance: { level: "checked", criteria: ["Report the findings"] },
			});
		}

		it("file-only mode accepts from the child-written file when the text report fails", async () => {
			const outputPath = path.join(tempDir, "async-report.md");
			conflictingReportsCall(outputPath, "satisfied", "not-satisfied");
			const id = `acceptance-file-report-${Date.now().toString(36)}`;
			runAsyncSingle(id, outputPath, "file-only");

			const payload = await waitForAsyncResult(id);
			assert.equal(payload.success, true);
			assert.equal(payload.results[0]?.acceptance?.status, "checked");
			assert.match(payload.results[0]?.acceptance?.childReport?.criteriaSatisfied?.[0]?.evidence ?? "", /from child-written file/);
			const status = JSON.parse(fs.readFileSync(path.join(ASYNC_DIR!, id, "status.json"), "utf-8")) as { steps?: Array<{ acceptance?: { status?: string } }> };
			assert.equal(status.steps?.[0]?.acceptance?.status, "checked");
		});

		it("file-only mode persists async acceptance metadata when final assistant text is only a receipt", async () => {
			const outputPath = path.join(tempDir, "saved-review.md");
			const fileReport = `# Review\n${acceptanceReport("satisfied", "saved reviewer verdict")}`;
			mockPi.onCall({
				jsonl: [...events.completedWrite(outputPath, fileReport), events.assistantMessage("Output saved to the configured file.")],
				writeFiles: [{ path: outputPath, content: fileReport }],
			});
			const id = `acceptance-saved-receipt-${Date.now().toString(36)}`;
			runAsyncSingle(id, outputPath, "file-only", ACCEPTANCE_ARTIFACTS);

			const payload = await waitForAsyncResult(id);
			assert.equal(payload.success, true);
			assert.equal(payload.results[0]?.acceptance?.status, "checked");
			assert.equal(payload.results[0]?.acceptance?.childReport?.criteriaSatisfied?.[0]?.evidence, "saved reviewer verdict");
			const metadataPath = payload.results[0]?.artifactPaths?.metadataPath;
			assert.ok(metadataPath);
			const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf-8")) as { acceptance?: AcceptanceSummary };
			assert.equal(metadata.acceptance?.status, "checked");
			assert.equal(metadata.acceptance?.childReport?.criteriaSatisfied?.[0]?.evidence, "saved reviewer verdict");
		});

		it("inline mode accepts from the text report and strips fences from the resolved file output", async () => {
			const outputPath = path.join(tempDir, "async-report.md");
			conflictingReportsCall(outputPath, "not-satisfied", "satisfied");
			const id = `acceptance-inline-strip-${Date.now().toString(36)}`;
			runAsyncSingle(id, outputPath, "inline");

			const payload = await waitForAsyncResult(id);
			assert.equal(payload.success, true);
			assert.equal(payload.results[0]?.acceptance?.status, "checked");
			assert.match(payload.results[0]?.output ?? "", /# Findings/);
			assert.doesNotMatch(payload.results[0]?.output ?? "", /```acceptance-report/);
		});
	});
});
