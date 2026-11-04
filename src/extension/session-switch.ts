import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext, ExtensionUIDialogOptions, SessionShutdownEvent } from "@earendil-works/pi-coding-agent";
import { isActiveAsyncState } from "../runs/background/active-run-index.ts";
import { listAsyncRuns } from "../runs/background/async-status.ts";
import { readProcessTerminal } from "../runs/background/process-terminal.ts";
import { isTerminalAsyncState, readWorkflowChildProcessEvidence } from "../runs/background/workflow-terminal-proof.ts";
import { stopAsyncRun } from "../runs/foreground/async-stop-action.ts";
import { ownsRun } from "../runs/shared/run-ownership.ts";
import { hasLiveNestedDescendants } from "../runs/shared/nested-events.ts";
import { approveSessionHandoff } from "../shared/session-succession.ts";
import { expandHomePath } from "../shared/settings.ts";
import type { SubagentState } from "../shared/types.ts";
import { extractTextFromContent, readStatus } from "../shared/utils.ts";

const CANCEL = "Stay here — keep work running";
const TRANSFER = "Switch and transfer — take work, results, and run history";
const STOP = "Stop and switch — stop work first";
const STOP_TIMEOUT_MS = 5_000;
const STOP_POLL_INTERVAL_MS = 100;
const RPC_PROMPT_TIMEOUT_MS = 60_000;

type SwitchReason = "new" | "resume" | "fork";

function resolveSessionTarget(file: string): string {
	if (path.sep === "\\" && file.startsWith("~\\")) file = `~/${file.slice(2)}`;
	return path.resolve(file.startsWith("file://") ? fileURLToPath(file) : expandHomePath(file));
}

export type SessionSwitchContext = Pick<ExtensionContext, "mode" | "hasUI" | "abort"> & {
	sessionManager: Pick<ExtensionContext["sessionManager"], "getSessionFile">;
	ui: Pick<ExtensionContext["ui"], "select" | "notify">;
};

interface SessionSwitchDeps {
	state: SubagentState;
	asyncDirRoot: string;
	resultsDir: string;
	hasPendingResults(): boolean;
	hasPendingCompletionWake(): boolean;
	hasPendingSupervisorRequest(): boolean;
	now?: () => number;
	sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/** Prompts the operator without writing model history. */
export function createSessionSwitchGuard(pi: Pick<ExtensionAPI, "events">, deps: SessionSwitchDeps) {
	let approval: { sessionId: string; reason: SwitchReason; targetSessionFile?: string } | undefined;
	let checking = false;
	let blocked = false;
	const lifetime = new AbortController();
	const now = deps.now ?? Date.now;
	const wait = deps.sleep ?? ((ms: number, signal: AbortSignal) => sleep(ms, undefined, { signal }));
	const setBlocked = (active: boolean) => {
		if (blocked === active) return;
		blocked = active;
		pi.events.emit("herdr:blocked", active ? { active, label: "Decide what to do with background work" } : { active });
	};
	const activeRuns = () => {
		const sessionId = deps.state.currentSessionId;
		if (!sessionId) throw new Error("The current session identity is unavailable.");
		const runs = new Map(listAsyncRuns(deps.asyncDirRoot, {
			sessionId, states: ["queued", "running"], resultsDir: deps.resultsDir, includeNested: false,
		}).map((run) => [run.id, run.asyncDir]));
		// Include launch receipts whose active-index marker has not landed yet.
		for (const job of deps.state.asyncJobs.values()) {
			if (runs.has(job.asyncId) || !ownsRun(sessionId, job.sessionId) || !isActiveAsyncState(job.status)) continue;
			const status = readStatus(job.asyncDir);
			if (!status || isActiveAsyncState(status.state)) runs.set(job.asyncId, job.asyncDir);
		}
		for (const id of deps.state.workflowControllers?.keys() ?? []) {
			if (!runs.has(id)) runs.set(id, path.join(deps.asyncDirRoot, id));
		}
		return runs;
	};
	const hasNestedWork = () => [...deps.state.asyncJobs.values()].some((job) =>
		ownsRun(deps.state.currentSessionId, job.sessionId) && hasLiveNestedDescendants(job.nestedChildren));

	const stopRunningWork = async (ctx: SessionSwitchContext, initialRuns: ReadonlyMap<string, string>) => {
		// Keep exit checks even when runs finish during the prompt or abort.
		const tracked = new Map([...initialRuns, ...activeRuns()]);
		await ctx.abort();
		const deadline = now() + STOP_TIMEOUT_MS;
		const requested = new Set<string>();
		const stopObserved = (asyncDir: string, id: string) => {
			const status = readStatus(asyncDir);
			if (!status || !isTerminalAsyncState(status.state)) return false;
			if (status.mode === "workflow") return !deps.state.workflowControllers?.has(id)
				&& readWorkflowChildProcessEvidence(asyncDir, status.steps).state === "observed";
			if (status.processTerminal?.state === "not-started") return status.processTerminal.runId === id && Boolean(status.error);
			return readProcessTerminal(asyncDir, { runId: id, runnerProcessInstanceId: status.processTerminal?.runnerProcessInstanceId })?.state === "observed";
		};
		while (!lifetime.signal.aborted) {
			const runs = activeRuns();
			for (const [id, dir] of runs) tracked.set(id, dir);
			if (runs.size === 0 && !hasNestedWork() && [...tracked].every(([id, dir]) => stopObserved(dir, id))) return;
			for (const [id, asyncDir] of runs) {
				if (requested.has(id)) continue;
				const result = stopAsyncRun(deps.state, id, undefined, { asyncDir, resolvedId: id });
				if (!result || result.isError) {
					// A run may finish before its stop request.
					if (!activeRuns().has(id)) continue;
					throw new Error(extractTextFromContent(result?.content) || `Could not stop ${id}.`);
				}
				requested.add(id);
			}
			if (now() >= deadline) throw new Error("Could not verify that all background work stopped within five seconds. The switch was cancelled; inspect the runs and retry.");
			await wait(STOP_POLL_INTERVAL_MS, lifetime.signal);
		}
		throw new Error("The session closed while stopping background work.");
	};

	return {
		async beforeSwitch(reason: SwitchReason, ctx: SessionSwitchContext, targetSessionFile?: string): Promise<{ cancel: true } | undefined> {
			if (lifetime.signal.aborted || checking) return { cancel: true };
			approval = undefined; // Consent belongs to this switch attempt.
			checking = true;
			try {
				const sessionId = deps.state.currentSessionId;
				const runs = activeRuns();
				const nested = hasNestedWork();
				const results = deps.hasPendingResults();
				const questions = deps.hasPendingSupervisorRequest();
				if (runs.size === 0 && !nested && !results && !questions) return;
				if (!ctx.hasUI) throw new Error("Background work is outstanding. Finish or stop it in its original session before switching without an interactive UI.");
				const title = [
					"pi-subagents: switch sessions?",
					"",
					"Background subagent work in this session:",
					...(runs.size > 0 ? [`  ${runs.size} run${runs.size === 1 ? "" : "s"} queued or running`] : []),
					...(nested ? ["  Nested subagents still running"] : []),
					...(results ? ["  Undelivered results"] : []),
					...(questions ? ["  Questions awaiting a reply"] : []),
				].join("\n");
				if (ctx.mode === "tui") setBlocked(true);
				const dialogOptions: ExtensionUIDialogOptions = { signal: lifetime.signal };
				if (ctx.mode === "rpc") dialogOptions.timeout = RPC_PROMPT_TIMEOUT_MS;
				const choice = await ctx.ui.select(title, [CANCEL, TRANSFER, STOP], dialogOptions);
				setBlocked(false);
				if (lifetime.signal.aborted || deps.state.currentSessionId !== sessionId) return { cancel: true };
				if (choice === TRANSFER) {
					if (!ctx.sessionManager.getSessionFile()) throw new Error("An in-memory session cannot hand off its runs. Stop the work or stay in this session.");
					// Accepted wakes belong to the old conversation, not a second delivery route.
					if (deps.hasPendingCompletionWake()) throw new Error("A completion wake is still queued in this session. Let it start, then retry the handoff.");
					approval = { sessionId: sessionId!, reason, targetSessionFile: targetSessionFile ? resolveSessionTarget(targetSessionFile) : undefined };
					return;
				}
				if (choice === STOP) {
					await stopRunningWork(ctx, runs);
					return;
				}
				return { cancel: true };
			} catch (error) {
				approval = undefined;
				const message = error instanceof Error ? error.message : String(error);
				console.error(`Subagent session switch cancelled: ${message}`);
				// Pi ignores thrown switch hooks; always return cancel, even if the UI is stale.
				try { if (!lifetime.signal.aborted && ctx.hasUI) ctx.ui.notify(message, "warning"); }
				catch { /* The context may already be stale. */ }
				return { cancel: true };
			} finally {
				checking = false;
				setBlocked(false);
			}
		},
		sessionShutdown(event: SessionShutdownEvent) {
			const accepted = approval;
			approval = undefined;
			if (accepted && accepted.sessionId === deps.state.currentSessionId && accepted.reason === event.reason
				&& event.targetSessionFile && (!accepted.targetSessionFile || accepted.targetSessionFile === event.targetSessionFile)) {
				// Offer after the switch commits; claim on destination startup.
				approveSessionHandoff(event.targetSessionFile, accepted.sessionId);
			}
		},
		dispose() {
			approval = undefined;
			lifetime.abort();
			setBlocked(false);
		},
	};
}
