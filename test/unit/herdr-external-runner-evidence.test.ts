import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { runSingleStepInner } from "../../src/runs/background/subagent-runner.ts";
import { runSync } from "../../src/runs/foreground/execution.ts";
import type { ChildSessionEvent } from "../../src/runs/shared/child-session.ts";
import type { AgentConfig } from "../../src/agents/agents.ts";
import type { RemoteWorktreeEvidence } from "../../src/shared/types.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function fixture(pending = false) {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-external-runner-evidence-")); roots.push(cwd); const artifactsDir = path.join(cwd, "artifacts");
	const evidence: RemoteWorktreeEvidence & { recordPath: string; unexpectedSecret: string } = { id: "12345678-1234-4234-9234-123456789abc", machineId: "machine-id", repositoryKey: "https://example.com/team/project", sourceRemote: "https://example.com/team/project", baseCommit: "a".repeat(40), branch: "pi-subagents/test", path: "/remote/tree", cwd: "/remote/tree", state: "active", recordPath: "/private/record", unexpectedSecret: "do not serialize" };
	let stop: (() => void) | undefined, disposal = 0, signalStop!: () => void; const stopReady = new Promise<void>(resolve => { signalStop = resolve; });
	const settle = async () => { evidence.state = "retained"; if (disposal === 0) disposal++; }, session = { owner: { managedWorktree: { remoteWorktree: evidence }, identity: { machineId: evidence.machineId, workspaceId: "w", tabId: "t", paneId: "p", terminalId: "term" } }, launch: { nativeSessionId: "12345678-1234-4234-9234-123456789abc" }, async promptAndSettle() { if (pending) return new Promise<never>(() => {}); return { adapter: "codex-exec", outcome: "partial", output: "done", settlement: { state: "settled" } }; }, retain: settle, dispose: settle, abort: settle };
	const step = { agent: "worker", task: "task", context: "fresh", runner: { type: "external-cli", adapter: "codex-exec", command: "codex" }, machine: { provider: "herdr", id: evidence.machineId, target: "host", cwd: evidence.cwd } };
	const context = { cwd, id: "run", flatIndex: 0, flatStepCount: 1, previousOutput: "", placeholder: "{previous}", outputFile: path.join(cwd, "output.log"), sessionEnabled: false, childSessions: {}, artifactsDir, artifactConfig: { enabled: true, includeMetadata: true }, registerStop(value?: () => void) { stop = value; if (value) signalStop(); } };
	// SAFETY: the fake implements the exact session methods consumed by this placed-external runner branch.
	const dependencies = { preparePlacedExternal: async () => session as never };
	return { context, dependencies, evidence, getStop: () => stop, getDisposal: () => disposal, step, stopReady };
}

function metadata(result: { artifactPaths?: { metadataPath?: string } }): { remoteWorktree?: RemoteWorktreeEvidence } {
	assert.ok(result.artifactPaths?.metadataPath);
	// SAFETY: this is the runner's just-written metadata artifact; the assertion below compares its bounded worktree projection exactly.
	return JSON.parse(fs.readFileSync(result.artifactPaths.metadataPath, "utf8")) as { remoteWorktree?: RemoteWorktreeEvidence };
}

describe("managed external runner ownership evidence", () => {
	it("persists ordinary success only after retained evidence settles", async () => {
		const f = fixture();
		// SAFETY: fixture objects provide every field read by the placed external branch under test.
		const result = await runSingleStepInner(f.step as never, f.context as never, f.dependencies);
		assert.equal(result.remoteWorktree?.state, "retained"); assert.equal(f.getDisposal(), 1);
		assert.deepEqual(metadata(result).remoteWorktree, result.remoteWorktree);
		assert.equal("recordPath" in result.remoteWorktree!, false); assert.equal("unexpectedSecret" in result.remoteWorktree!, false);
	});

	it("persists and returns retained evidence for explicit stop", async () => {
		const f = fixture(true);
		// SAFETY: fixture objects provide every field read by the placed external branch under test.
		const running = runSingleStepInner(f.step as never, f.context as never, f.dependencies); await f.stopReady; assert.ok(f.getStop()); f.getStop()!(); const result = await running;
		assert.equal(result.stopped, true); assert.equal(result.remoteWorktree?.state, "retained"); assert.deepEqual(metadata(result).remoteWorktree, result.remoteWorktree);
	});
});

it("refreshes foreground native result and metadata after retained disposal", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-foreground-native-evidence-")); roots.push(cwd); let listener: ((event: ChildSessionEvent) => void) | undefined, disposed = false; const evidence: RemoteWorktreeEvidence = { id: "12345678-1234-4234-9234-123456789abc", machineId: "machine-id", repositoryKey: "https://example.com/team/project", sourceRemote: "https://example.com/team/project", baseCommit: "a".repeat(40), branch: "pi-subagents/test", path: "/remote/tree", cwd: "/remote/tree", state: "active" }, agent: AgentConfig = { name: "worker", description: "Work", systemPrompt: "Work", source: "project", filePath: "worker.md", model: "mock/model" };
	const result = await runSync(cwd, [agent], "worker", "task", { runId: "foreground-native-evidence", artifactsDir: path.join(cwd, "artifacts"), artifactConfig: { enabled: true, includeMetadata: true }, machine: { provider: "herdr", id: evidence.machineId, target: "host", cwd: evidence.cwd }, childSessionFactory: { async create() { return { subscribe(callback: (event: ChildSessionEvent) => void) { listener = callback; return () => {}; }, async prompt() { listener?.({ type: "message_end", message: { role: "assistant", provider: "mock", model: "model", stopReason: "stop", content: [{ type: "text", text: "done" }] } }); }, async steer() {}, async followUp() {}, async abort() {}, async dispose() { disposed = true; }, get machineEvidence() { const remoteWorktree: RemoteWorktreeEvidence = { ...evidence, state: disposed ? "retained" : "active" }; if (disposed) remoteWorktree.evidenceUnavailable = "Retained observation unavailable."; return { machineId: evidence.machineId, remoteWorktree }; }, messages: [], sessionFile: undefined, sessionId: "fake", modelId: "mock/model" }; }, async dispose() {} } });
	assert.equal(result.remoteWorktree?.state, "retained"); assert.equal(result.remoteWorktree?.evidenceUnavailable, "Retained observation unavailable."); assert.ok(result.artifactPaths?.metadataPath); const persisted = JSON.parse(fs.readFileSync(result.artifactPaths.metadataPath, "utf8")); assert.deepEqual(persisted.remoteWorktree, result.remoteWorktree);
});
