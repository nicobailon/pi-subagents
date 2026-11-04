import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext, ExtensionUIDialogOptions, SessionShutdownEvent } from "@earendil-works/pi-coding-agent";
import { isActiveAsyncState } from "../runs/background/active-run-index.ts";
import { listAsyncRuns } from "../runs/background/async-status.ts";
import { deliverStopRequest, StopInboxClosedError } from "../runs/background/control-channel.ts";
import { reconcileNestedAsyncDescendants } from "../runs/background/stale-run-reconciler.ts";
import { readProcessTerminal } from "../runs/background/process-terminal.ts";
import { isTerminalAsyncState, readWorkflowChildProcessEvidence } from "../runs/background/workflow-terminal-proof.ts";
import { stopAsyncRun } from "../runs/foreground/async-stop-action.ts";
import { ownsRun } from "../runs/shared/run-ownership.ts";
import { collectNestedRuns, projectNestedEvents, resolveNestedAsyncDir } from "../runs/shared/nested-events.ts";
import { approveSessionHandoff } from "../shared/session-succession.ts";
import { expandHomePath } from "../shared/settings.ts";
import type { NestedRouteInfo, NestedRunSummary, SubagentState } from "../shared/types.ts";
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
	const nestedWork = (knownRoutes: ReadonlyMap<string, NestedRouteInfo> = new Map()) => {
		const routes = new Map(knownRoutes);
		const roots = new Set<string>();
		const runs = new Map<string, string>();
		const collect = (rootId: string, children: NestedRunSummary[] | undefined) => {
			for (const run of collectNestedRuns(children)) {
				if (!isActiveAsyncState(run.state)) continue;
				roots.add(rootId);
				const dir = resolveNestedAsyncDir(rootId, run);
				if (dir) runs.set(dir, run.id);
			}
		};
		for (const job of deps.state.asyncJobs.values()) {
			if (!ownsRun(deps.state.currentSessionId, job.sessionId)) continue;
			if (job.nestedRoute) routes.set(job.nestedRoute.rootRunId, job.nestedRoute);
			else collect(job.asyncId, job.nestedChildren);
		}
		for (const control of deps.state.foregroundControls.values()) {
			if (control.sessionId && !ownsRun(deps.state.currentSessionId, control.sessionId)) continue;
			if (control.nestedRoute) routes.set(control.nestedRoute.rootRunId, control.nestedRoute);
		}
		for (const route of deps.state.retainedForegroundNestedRoutes?.values() ?? []) routes.set(route.rootRunId, route);
		if (deps.state.retainedNestedLookupRoutes?.sessionId === deps.state.currentSessionId) {
			for (const route of deps.state.retainedNestedLookupRoutes.routes.values()) routes.set(route.rootRunId, route);
		}
		for (const route of routes.values()) {
			reconcileNestedAsyncDescendants(route, { resultsDir: deps.resultsDir });
			collect(route.rootRunId, projectNestedEvents(route).children);
		}
		return { routes, roots, runs };
	};

	const stopRunningWork = async (ctx: SessionSwitchContext, initialRuns: ReadonlyMap<string, string>, initialNested: ReturnType<typeof nestedWork>) => {
		// Keep exit checks even when runs finish during the prompt or abort.
		const tracked = new Map([...initialRuns, ...activeRuns()]);
		let nested = nestedWork(initialNested.routes);
		const trackedNested = new Map([...initialNested.runs, ...nested.runs]);
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
			nested = nestedWork(nested.routes);
			for (const [dir, id] of nested.runs) trackedNested.set(dir, id);
			if (runs.size === 0 && nested.roots.size === 0 && [...tracked].every(([id, dir]) => stopObserved(dir, id))
				&& [...trackedNested].every(([dir, id]) => stopObserved(dir, id))) return;
			for (const [id, asyncDir] of runs) {
				if (requested.has(asyncDir)) continue;
				const result = stopAsyncRun(deps.state, id, undefined, { asyncDir, resolvedId: id });
				if (!result || result.isError) {
					// A run may finish before its stop request.
					if (!activeRuns().has(id)) continue;
					throw new Error(extractTextFromContent(result?.content) || `Could not stop ${id}.`);
				}
				requested.add(asyncDir);
			}
			for (const asyncDir of nested.runs.keys()) {
				if (requested.has(asyncDir)) continue;
				try { deliverStopRequest({ asyncDir, source: "session-switch" }); }
				catch (error) { if (!(error instanceof StopInboxClosedError)) throw error; }
				requested.add(asyncDir);
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
				const nested = nestedWork();
				const results = deps.hasPendingResults();
				const questions = deps.hasPendingSupervisorRequest();
				if (runs.size === 0 && nested.roots.size === 0 && !results && !questions) return;
				if (!ctx.hasUI) throw new Error("Background work is outstanding. Finish or stop it in its original session before switching without an interactive UI.");
				const title = [
					"pi-subagents: switch sessions?",
					"",
					"Background subagent work in this session:",
					...(runs.size > 0 ? [`  ${runs.size} run${runs.size === 1 ? "" : "s"} queued or running`] : []),
					...(nested.roots.size > 0 ? ["  Nested subagents still running"] : []),
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
					const running = activeRuns();
					if ([...nestedWork(nested.routes).roots].some((rootId) => !running.has(rootId))) {
						throw new Error("Nested work without an active background parent cannot be transferred. Stop it or stay in this session.");
					}
					approval = { sessionId: sessionId!, reason, targetSessionFile: targetSessionFile ? resolveSessionTarget(targetSessionFile) : undefined };
					return;
				}
				if (choice === STOP) {
					await stopRunningWork(ctx, runs, nested);
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
