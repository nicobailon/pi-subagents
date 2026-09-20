/**
 * Acceptance report sourcing through the real execution drivers: the report the
 * child wrote to its configured output file (recovered from its write tool
 * calls) versus the assistant text, ordered by outputMode, including parallel
 * children with the distinct configured paths required after #420. Runs the
 * full launch, event, and acceptance pipeline against the scripted child session.
 */
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { ChildProcess, execFileSync } from "node:child_process";
import { channel } from "node:diagnostics_channel";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { readProcessTerminal } from "../../src/runs/background/process-terminal.ts";
import { childSessionFactoryModule, setChildSessionFactoryModule } from "../../src/runs/shared/child-session.ts";
import type { MockPi } from "../support/helpers.ts";
import { createEventBus, createMockPi, createTempDir, events, makeAgent, makeAgentConfigs, makeMinimalCtx, tryImport } from "../support/helpers.ts";

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
		outputReference?: { path: string; message: string };
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
	const marks = ownedRunners.get(id)?.marks;
	if (marks) marks.resultWaitStartedAt = Date.now();
	const resultPath = path.join(RESULTS_DIR!, `${id}.json`);
	const deadline = Date.now() + timeoutMs;
	while (!fs.existsSync(resultPath)) {
		if (Date.now() > deadline) assert.fail(`Timed out waiting for async result file: ${resultPath}`);
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
	if (marks) marks.resultReadAt = Date.now();
	return payload;
}

// Diagnostic only: retaining ChildProcess objects may perturb observer lifetime.
// Neither callbacks nor these projections authorize cleanup.
const ownedRunners = new Map<string, ReturnType<typeof observeRunner>>();
function observeRunner(id: string, bodyStartedAt: number, disableCompileCache: boolean) {
	const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
	const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : undefined;
	const known = (value: unknown, values: string[]) => typeof value === "string" && values.includes(value) ? value : undefined;
	const errorCode = (error: unknown) => known(record(error).code, ["ENOENT", "EACCES", "EPERM", "EBUSY", "EIO", "EMFILE", "ENFILE", "ENOSPC"]) ?? "other";
	const project = (value: unknown) => {
		const raw = record(value);
		return {
			runMatches: (raw.runId ?? raw.id) === id,
			runnerProcessInstanceId: typeof raw.runnerProcessInstanceId === "string" && /^[a-zA-Z0-9:-]{1,128}$/.test(raw.runnerProcessInstanceId) ? raw.runnerProcessInstanceId : undefined,
			state: known(raw.state, ["pending", "running", "complete", "failed", "stopped", "paused", "observed", "unknown", "not-started"]),
			reason: known(raw.reason, ["runner-candidate-missing", "runner-instance-mismatch", "writer-close-unverified", "process-tree-unverified", "canonical-session-unavailable", "canonical-session-lease-active", "canonical-session-release-unverified", "proof-write-failed"]),
			pid: number(raw.pid), startedAt: number(raw.startedAt), endedAt: number(raw.endedAt), observedAt: number(raw.observedAt),
			success: typeof raw.success === "boolean" ? raw.success : undefined,
			writerCount: Array.isArray(record(raw.writers)["0"]) ? record(raw.writers)["0"].length : undefined,
			expectedWriters: number(record(raw.expectedWriters)["0"]),
		};
	};
	const marks: Record<string, number> = { bodyStartedAt, launchStartedAt: Date.now() };
	let pid: number | undefined;
	let identity: Record<string, unknown> | undefined;
	const notifications: unknown[] = [];
	const processes: Array<{ proc: ChildProcess; events: unknown[]; dispose: () => void }> = [];
	const diagnosticChannel = channel("child_process");
	const onProcess = (message: unknown) => {
		const proc = record(message).process;
		if (!(proc instanceof ChildProcess) || processes.length >= 8) return;
		const events: unknown[] = [];
		const add = (type: string, code?: number | null, signal?: string | null) => events.push({ type, at: Date.now(), code, signal: signal === null ? null : known(signal, ["SIGTERM", "SIGKILL", "SIGINT", "SIGABRT", "SIGSEGV"]) });
		const spawn = () => add("spawn");
		const error = (err: Error) => events.push({ type: "error", at: Date.now(), code: errorCode(err) });
		const exit = (code: number | null, signal: string | null) => add("exit", code, signal);
		const close = (code: number | null, signal: string | null) => add("close", code, signal);
		proc.once("spawn", spawn).once("error", error).once("exit", exit).once("close", close);
		processes.push({ proc, events, dispose: () => { proc.off("spawn", spawn).off("error", error).off("exit", exit).off("close", close); } });
	};
	function queryIdentity(proc: ChildProcess | undefined): Record<string, unknown> {
		const at = Date.now();
		const config = proc?.spawnargs.at(-1);
		if (process.platform !== "win32") return { at, state: "unavailable", reason: "platform" };
		if (!proc || !path.isAbsolute(proc.spawnfile) || !config || !path.isAbsolute(config) || path.basename(config) !== `async-cfg-${id}.json`) {
			return { at, state: "unavailable", reason: "correlation" };
		}
		try {
			// CommandLineToArgvW avoids substring/quoting guesses. Only fixed projections leave PowerShell.
			const script = `
$ErrorActionPreference = 'Stop'
try {
  $p = Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}' -Property CreationDate,ExecutablePath,CommandLine
  if ($null -eq $p) { '{"state":"missing"}'; return }
  if (!$p.CreationDate -or !$p.ExecutablePath -or !$p.CommandLine) { '{"state":"unavailable"}'; return }
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class AcceptanceIdentity {
  [DllImport("shell32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern IntPtr CommandLineToArgvW(string line, out int count);
  [DllImport("kernel32.dll")]
  static extern IntPtr LocalFree(IntPtr memory);
  public static bool Matches(string line, string config, int expectedCount) {
    int count;
    IntPtr args = CommandLineToArgvW(line, out count);
    if (args == IntPtr.Zero) throw new InvalidOperationException();
    try {
      if (count != expectedCount) return false;
      int matches = 0;
      for (int i = 1; i < count; i++) {
        string arg = Marshal.PtrToStringUni(Marshal.ReadIntPtr(args, i * IntPtr.Size));
        if (String.Equals(arg, config, StringComparison.Ordinal)) matches++;
        if (i == count - 1 && !String.Equals(arg, config, StringComparison.Ordinal)) return false;
      }
      return matches == 1;
    } finally { LocalFree(args); }
  }
}
'@
  $exe = [string]::Equals($p.ExecutablePath, $env:ACCEPTANCE_EXPECTED_EXE, [StringComparison]::OrdinalIgnoreCase)
  $config = [AcceptanceIdentity]::Matches($p.CommandLine, $env:ACCEPTANCE_EXPECTED_CONFIG, ${proc.spawnargs.length})
  $state = if ($exe -and $config) { 'matched' } else { 'mismatch' }
  @{ state=$state; creationTime=$p.CreationDate.ToUniversalTime().ToString('o'); executableMatches=$exe; configArgumentMatches=$config } | ConvertTo-Json -Compress
} catch {
  if ($_.Exception -is [UnauthorizedAccessException] -or $_.Exception.NativeErrorCode -eq 2) { '{"state":"permission-denied"}' }
  else { '{"state":"unavailable"}' }
}
`;
			const raw = record(JSON.parse(execFileSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
				encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 2000, maxBuffer: 4096, windowsHide: true,
				env: { ...process.env, ACCEPTANCE_EXPECTED_EXE: proc.spawnfile, ACCEPTANCE_EXPECTED_CONFIG: config },
			})));
			const state = known(raw.state, ["matched", "mismatch", "missing", "permission-denied", "unavailable"]) ?? "unavailable";
			if (state !== "matched" && state !== "mismatch") return { at, completedAt: Date.now(), state };
			if (typeof raw.creationTime !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{7}Z$/.test(raw.creationTime)
				|| typeof raw.executableMatches !== "boolean" || typeof raw.configArgumentMatches !== "boolean"
				|| (state === "matched") !== (raw.executableMatches && raw.configArgumentMatches)) {
				return { at, completedAt: Date.now(), state: "unavailable", reason: "invalid-response" };
			}
			return { at, completedAt: Date.now(), state, creationTime: raw.creationTime, executableMatches: raw.executableMatches, configArgumentMatches: raw.configArgumentMatches };
		} catch (error) {
			const code = record(error).code;
			return { at, completedAt: Date.now(), state: code === "ETIMEDOUT" ? "timeout" : code === "EACCES" || code === "EPERM" ? "permission-denied" : "unavailable" };
		}
	}
	return {
		marks,
		emit(type: string, value: unknown) {
			const raw = record(value);
			if (type === "subagent:async-started" && raw.id === id) pid = number(raw.pid);
			else if (type !== "subagent:process-terminal" || raw.runId !== id) return;
			if (notifications.length < 8) notifications.push({ type, at: Date.now(), ...project(raw) });
		},
		launch(run: () => unknown) {
			const nodeOptions = process.env.NODE_OPTIONS;
			const previousDisableCompileCache = process.env.NODE_DISABLE_COMPILE_CACHE;
			diagnosticChannel.subscribe(onProcess);
			try {
				process.env.NODE_OPTIONS = `${nodeOptions ?? ""} --trace-exit`;
				if (disableCompileCache) process.env.NODE_DISABLE_COMPILE_CACHE = "1";
				return run();
			}
			finally {
				if (disableCompileCache) {
					if (previousDisableCompileCache === undefined) delete process.env.NODE_DISABLE_COMPILE_CACHE;
					else process.env.NODE_DISABLE_COMPILE_CACHE = previousDisableCompileCache;
				}
				if (nodeOptions === undefined) delete process.env.NODE_OPTIONS;
				else process.env.NODE_OPTIONS = nodeOptions;
				marks.launchFinishedAt = Date.now();
				diagnosticChannel.unsubscribe(onProcess);
				for (const entry of processes) if (pid === undefined || entry.proc.pid !== pid) entry.dispose();
			}
		},
		readEvidence(file: string, kind: "json" | "phases" | "journal" = "json") {
			const matched = processes.filter(({ proc }) => pid !== undefined && Number.isSafeInteger(pid) && pid > 0 && proc.pid === pid);
			const readAt = Date.now();
			try {
				const fd = fs.openSync(file, "r");
				try {
					const size = fs.fstatSync(fd).size;
					const limit = kind === "phases" ? 8192 : 65536;
					if (kind === "json" && size > limit) return { readAt, size, io: "oversized", truncated: true };
					const offset = kind === "json" ? 0 : Math.max(0, size - limit);
					const buffer = Buffer.alloc(Math.min(size, limit));
					const bytes = fs.readSync(fd, buffer, 0, buffer.length, offset);
					const text = buffer.toString("utf-8", 0, bytes);
					const base = { readAt, size, bytes, io: "readable", truncated: offset > 0 };
					if (kind === "json") return { ...base, ...project(JSON.parse(text)) };
					const lines = text.split("\n").slice(offset > 0 ? 1 : 0);
					const entries: unknown[] = [];
					let parseErrors = 0;
					for (const line of lines.filter(Boolean)) {
						if (kind === "phases") {
							if (matched.length !== 1) continue;
							// Native Environment::Exit follows AtExit, precedes shutdown, and has no timestamp.
							const trace = /^\(node:(\d{1,16})\) WARNING: Exited the environment with code (-?\d{1,10})\r?$/.exec(line);
							if (trace && Number(trace[1]) === pid) {
								entries.push({ phase: "native-trace-exit", pid, code: Number(trace[2]) });
								continue;
							}
							const runtime = /^#1916 runtime node=(v\d{1,3}\.\d{1,3}\.\d{1,3}) uv=(\d{1,3}\.\d{1,3}\.\d{1,3}) cacheEnabled=(true|false|unavailable) pid=(\d{1,16})$/.exec(line);
							if (runtime && Number(runtime[4]) === pid) {
								entries.push({ phase: "runtime", node: runtime[1], uv: runtime[2], cacheEnabled: runtime[3] === "unavailable" ? "unavailable" : runtime[3] === "true", pid });
								continue;
							}
							const match = /^#1918 phase=(dispose-entry|dispose-return|dispose-rejection|exit|exit-request|exit-dispatch-return|exit-dispatch-throw) invocation=(\d{1,16}) ts=(\d{1,16}) pid=(\d{1,16})$/.exec(line);
							if (!match) continue;
							const [invocation, ts, markerPid] = match.slice(2).map(Number);
							if (![invocation, ts, markerPid].every(Number.isSafeInteger) || markerPid !== pid || ts <= 0) continue;
							if (match[1]!.startsWith("exit") ? invocation !== 0 : invocation < 1 || invocation > 8) continue;
							entries.push({ phase: match[1], invocation, ts, pid: markerPid });
						} else {
							try {
								const event = record(JSON.parse(line));
								const type = known(event.type, ["subagent.run.started", "subagent.run.completed", "subagent.run.process_terminal"]);
								if (type && event.runId === id) entries.push({ type, ts: number(event.ts), ...project(event), proof: project(event.processTerminal) });
							} catch { parseErrors++; }
						}
					}
					return { ...base, parseErrors, entries: entries.slice(-16), entriesTruncated: entries.length > 16 };
				} finally { fs.closeSync(fd); }
			} catch (error) { return { readAt, io: error instanceof SyntaxError ? "invalid-json" : errorCode(error) }; }
		},
		snapshot(proof: unknown) {
			const snapshotAt = Date.now();
			const matched = processes.filter(({ proc }) => pid !== undefined && Number.isSafeInteger(pid) && pid > 0 && proc.pid === pid);
			const read = this.readEvidence;
			const asyncDir = path.join(ASYNC_DIR!, id);
			const snapshot = {
				id, pid, marks, notifications, lastProof: project(proof), snapshotAt,
				capturedProcesses: processes.length,
				processes: processes.filter(({ proc }) => pid !== undefined && proc.pid === pid).map(({ proc, events }) => ({ pid: proc.pid, exitCode: proc.exitCode, signalCode: known(proc.signalCode, ["SIGTERM", "SIGKILL", "SIGINT", "SIGABRT", "SIGSEGV"]), events })),
				status: read(path.join(asyncDir, "status.json")), result: read(path.join(RESULTS_DIR!, `${id}.json`)),
				candidate: read(path.join(asyncDir, "process-terminal-candidate.json")), proof: read(path.join(asyncDir, "process-terminal.json")),
				phases: read(path.join(asyncDir, "runner.stderr.log"), "phases"), journal: read(path.join(asyncDir, "events.jsonl"), "journal"),
			};
			// One failure-only query, after the original evidence snapshot. Never cleanup authority.
			identity ??= queryIdentity(matched.length === 1 ? matched[0]!.proc : undefined);
			return { ...snapshot, identity };
		},
		measureControl(proof: unknown) {
			if (!disableCompileCache) return;
			try {
				console.log("#1947 cache-disable-control " + JSON.stringify({
					id, pid, measuredAt: Date.now(), proof: project(proof),
					processes: processes.filter(({ proc }) => pid !== undefined && proc.pid === pid).map(({ proc, events }) => ({ pid: proc.pid, exitCode: proc.exitCode, events })),
					phases: this.readEvidence(path.join(ASYNC_DIR!, id, "runner.stderr.log"), "phases"),
				}));
			}
			catch { console.log('#1947 cache-disable-control {"measurement":"unavailable"}'); }
		},
		dispose() { for (const entry of processes) entry.dispose(); },
	};
}

describe("acceptance file reports", { skip: !runSync ? "pi packages not available" : undefined }, () => {
	let tempDir: string;
	let mockPi: MockPi;
	let bodyStartedAt: number;
	let terminalBarrier: Promise<void> | undefined;

	async function waitForOwnedRunner(id: string): Promise<void> {
		const diagnostic = ownedRunners.get(id)!;
		diagnostic.marks.teardownStartedAt = Date.now();
		const asyncDir = path.join(ASYNC_DIR!, id);
		const deadline = Date.now() + 10_000;
		let proof;
		do {
			// The reader validates identity/shape and treats absent or partial I/O as unproven.
			proof = readProcessTerminal(asyncDir, { runId: id });
			if (proof?.state === "observed") {
				diagnostic.measureControl(proof);
				diagnostic.dispose();
				return;
			}
			await new Promise((resolve) => setTimeout(resolve, 50));
		} while (Date.now() <= deadline);
		let evidence: unknown;
		try { evidence = diagnostic.snapshot(proof); }
		catch { evidence = { snapshot: "unavailable" }; }
		finally { diagnostic.dispose(); }
		assert.fail(`No terminal proof for owned runner ${id}; retaining ${tempDir} and mock queue ${mockPi.dir}. Diagnostics: ${JSON.stringify(evidence)}`);
	}

	before(() => {
		mockPi = createMockPi();
		mockPi.install();
	});

	after(() => {
		assert.equal(ownedRunners.size, 0, "Unproven owned runners: retain the mock queue");
		mockPi.uninstall();
	});

	beforeEach(() => {
		assert.equal(ownedRunners.size, 0, "Unproven owned runners: do not reset the mock queue");
		terminalBarrier = undefined;
		tempDir = createTempDir();
		mockPi.reset();
		bodyStartedAt = Date.now();
	});

	afterEach(async () => {
		// Result publication precedes runner close. Also drain on assertion/result-wait failure.
		// Cache a failed barrier so later hooks cannot retry cleanup or reset shared state.
		terminalBarrier ??= Promise.all([...ownedRunners.keys()].map(waitForOwnedRunner)).then(() => { ownedRunners.clear(); });
		await terminalBarrier;
		fs.rmSync(tempDir, { recursive: true, force: true });
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

		it("retains the file-only report in the diagnostic artifact when acceptance rejects it", async () => {
			const outputPath = path.join(tempDir, "rejected-report.md");
			const artifactsDir = path.join(tempDir, "rejected-artifacts");
			const fileReport = `# Findings\n${acceptanceReport("not-satisfied", "from child-written file")}`;
			mockPi.onCall({
				jsonl: [
					...events.completedWrite(outputPath, fileReport),
					events.assistantMessage(`Report written to the output file.\n${acceptanceReport("satisfied", "from assistant text")}`),
				],
				writeFiles: [{ path: outputPath, content: fileReport }],
			});

			const result = await runSync!(tempDir, makeAgentConfigs(["worker"]), "worker", "Write the findings report.", {
				runId: "acceptance-file-only-rejected-artifact",
				outputPath,
				outputMode: "file-only",
				acceptance: { level: "checked", criteria: ["Report the findings"] },
				artifactsDir,
				artifactConfig: ACCEPTANCE_ARTIFACTS,
			});

			assert.equal(result.acceptance?.status, "rejected");
			assert.equal(result.exitCode, 1);
			assert.equal(result.savedOutputPath, outputPath);
			assert.equal(result.outputReference?.path, outputPath);
			assert.equal(fs.readFileSync(outputPath, "utf-8"), fileReport);
			assert.ok(result.artifactPaths);
			const outputArtifact = fs.readFileSync(result.artifactPaths.outputPath, "utf-8");
			assert.match(outputArtifact, /# Findings/);
			assert.doesNotMatch(outputArtifact, /^Output saved to:/);
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

			const result = await runSync!(tempDir, [makeAgent("worker")], "worker", "Implement and report the fix.", {
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

		it("inline mode preserves resolved report content in the diagnostic artifact on rejection", async () => {
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
			assert.match(outputArtifact, /# Findings/);
			assert.doesNotMatch(outputArtifact, /^Output saved to:/);
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
				discoverAgents: () => ({ agents: [makeAgent("worker")] }),
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
				discoverAgents: () => ({ agents: [makeAgent("worker")] }),
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
		function runAsyncSingle(id: string, outputPath: string, outputMode: "inline" | "file-only", artifactConfig = DISABLED_ARTIFACTS, disableCompileCache = false) {
			const originalFactoryModule = childSessionFactoryModule();
			assert.ok(originalFactoryModule, "expected the installed scripted runner factory");
			const factoryPath = path.join(tempDir, "acceptance-exit-phases.mjs");
			fs.writeFileSync(factoryPath, `
import { writeSync } from "node:fs";
import nodeModule from "node:module";
import createFactory from ${JSON.stringify(pathToFileURL(originalFactoryModule).href)};
export default function() {
  const factory = createFactory();
  let invocation = 0;
  const mark = (phase, call) => {
    if (call > 8) return;
    try { writeSync(process.stderr.fd, "#1918 phase=" + phase + " invocation=" + call + " ts=" + Date.now() + " pid=" + process.pid + "\\n"); } catch {}
  };
  process.once("exit", () => mark("exit", 0));
  const originalExit = process.exit;
  const originalEmit = process.emit;
  process.exit = function(...args) {
    mark("exit-request", 0);
    return Reflect.apply(originalExit, this, args);
  };
  process.emit = function(...args) {
    if (args[0] !== "exit") return Reflect.apply(originalEmit, this, args);
    try {
      const result = Reflect.apply(originalEmit, this, args);
      mark("exit-dispatch-return", 0);
      return result;
    } catch (error) { mark("exit-dispatch-throw", 0); throw error; }
  };
  try {
    const cacheEnabled = typeof nodeModule.getCompileCacheDir === "function" ? Boolean(nodeModule.getCompileCacheDir()) : "unavailable";
    writeSync(process.stderr.fd, "#1916 runtime node=" + process.version + " uv=" + process.versions.uv + " cacheEnabled=" + cacheEnabled + " pid=" + process.pid + "\\n");
  } catch {}
  return {
    create(...args) { return factory.create(...args); },
    async dispose() {
      const call = ++invocation;
      mark("dispose-entry", call);
      try {
        const result = await factory.dispose();
        mark("dispose-return", call);
        return result;
      } catch (error) { mark("dispose-rejection", call); throw error; }
    },
  };
}
`);
			const diagnostic = observeRunner(id, bodyStartedAt, disableCompileCache);
			// Register before launch so even a throwing launch cannot escape teardown ownership.
			ownedRunners.set(id, diagnostic);
			try {
				setChildSessionFactoryModule(factoryPath);
				diagnostic.launch(() => executeAsyncSingle!(id, {
					agent: "worker",
					task: "Write the findings report.",
					agentConfig: makeAgent("worker"),
					ctx: { pi: { events: { emit: diagnostic.emit } }, cwd: tempDir, currentSessionId: "session-file-report" },
					artifactConfig,
					artifactsDir: path.join(tempDir, ".pi/subagents", "artifacts"),
					shareEnabled: false,
					maxSubagentDepth: 2,
					output: outputPath,
					outputMode,
					acceptance: { level: "checked", criteria: ["Report the findings"] },
				}));
			} finally {
				// Launch captures the module path synchronously; restoring it does not release owned fixtures.
				setChildSessionFactoryModule(originalFactoryModule);
			}
		}

		it("file-only mode accepts from the child-written file when the text report fails", async () => {
			const outputPath = path.join(tempDir, "async-report.md");
			conflictingReportsCall(outputPath, "satisfied", "not-satisfied");
			const id = `acceptance-file-report-${Date.now().toString(36)}`;
			// One-variable control: only this launch disables Node's compile cache, not Jiti's transform cache.
			runAsyncSingle(id, outputPath, "file-only", DISABLED_ARTIFACTS, true);

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
