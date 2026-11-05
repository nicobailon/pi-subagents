import type { ExtensionContext, SessionShutdownEvent } from "@earendil-works/pi-coding-agent";
import { isActiveAsyncState } from "../runs/background/active-run-index.ts";
import { listAsyncRuns } from "../runs/background/async-status.ts";
import { reconcileNestedAsyncDescendants } from "../runs/background/stale-run-reconciler.ts";
import { ownsRun } from "../runs/shared/run-ownership.ts";
import { collectNestedRuns, projectNestedEvents } from "../runs/shared/nested-events.ts";
import { keepSessionWork, releaseSessionWork } from "../shared/session-succession.ts";
import type { NestedRouteInfo, SubagentState } from "../shared/types.ts";
import { readStatus } from "../shared/utils.ts";

const STAY = "Stay here";
const TAKE = "Switch and take the work";
const LEAVE = "Switch and leave the work here";
const RPC_PROMPT_TIMEOUT_MS = 60_000;

type SwitchReason = "new" | "resume" | "fork";

export type SessionSwitchContext = Pick<ExtensionContext, "mode" | "hasUI"> & {
	ui: Pick<ExtensionContext["ui"], "select" | "notify">;
};

interface SessionSwitchDeps {
	state: SubagentState;
	asyncDirRoot: string;
	resultsDir: string;
	hasPendingResults(): boolean;
	hasPendingSupervisorRequest(): boolean;
}

/**
 * Asks what happens to this session's outstanding background work when a UI session switches away. Without a UI or
 * outstanding work the switch proceeds and the next session inherits the work. The prompt never enters model history.
 */
export function createSessionSwitchGuard(deps: SessionSwitchDeps) {
	let leave: { sessionId: string; reason: SwitchReason } | undefined;
	let checking = false;
	const lifetime = new AbortController();
	const activeRunCount = (sessionId: string) => {
		const runs = new Set(listAsyncRuns(deps.asyncDirRoot, {
			sessionId, states: ["queued", "running"], resultsDir: deps.resultsDir, includeNested: false,
		}).map((run) => run.id));
		// Include launch receipts whose active-index marker has not landed yet.
		for (const job of deps.state.asyncJobs.values()) {
			if (runs.has(job.asyncId) || !ownsRun(sessionId, job.sessionId) || !isActiveAsyncState(job.status)) continue;
			let active = true;
			// An unreadable status could be a live run, so it counts as outstanding instead of refusing every switch.
			try { const status = readStatus(job.asyncDir); active = !status || isActiveAsyncState(status.state); } catch { /* active */ }
			if (active) runs.add(job.asyncId);
		}
		for (const id of deps.state.workflowControllers?.keys() ?? []) runs.add(id);
		return runs.size;
	};
	const hasNestedWork = (sessionId: string) => {
		const routes = new Map<string, NestedRouteInfo>();
		for (const job of deps.state.asyncJobs.values()) {
			if (!ownsRun(sessionId, job.sessionId)) continue;
			if (job.nestedRoute) routes.set(job.nestedRoute.rootRunId, job.nestedRoute);
			else if (collectNestedRuns(job.nestedChildren).some((run) => isActiveAsyncState(run.state))) return true;
		}
		for (const control of deps.state.foregroundControls.values()) {
			if (control.sessionId && !ownsRun(sessionId, control.sessionId)) continue;
			if (control.nestedRoute) routes.set(control.nestedRoute.rootRunId, control.nestedRoute);
		}
		for (const route of deps.state.retainedForegroundNestedRoutes?.values() ?? []) routes.set(route.rootRunId, route);
		if (deps.state.retainedNestedLookupRoutes?.sessionId === sessionId) {
			for (const route of deps.state.retainedNestedLookupRoutes.routes.values()) routes.set(route.rootRunId, route);
		}
		return [...routes.values()].some((route) => {
			reconcileNestedAsyncDescendants(route, { resultsDir: deps.resultsDir });
			return collectNestedRuns(projectNestedEvents(route).children).some((run) => isActiveAsyncState(run.state));
		});
	};

	return {
		async beforeSwitch(reason: SwitchReason, ctx: SessionSwitchContext): Promise<{ cancel: true } | undefined> {
			if (lifetime.signal.aborted || checking) return { cancel: true };
			leave = undefined; // A choice belongs to this switch attempt only.
			if (!ctx.hasUI) return;
			checking = true;
			try {
				const sessionId = deps.state.currentSessionId;
				if (!sessionId) throw new Error("The current session identity is unavailable.");
				const runs = activeRunCount(sessionId);
				const nested = hasNestedWork(sessionId);
				const results = deps.hasPendingResults();
				const questions = deps.hasPendingSupervisorRequest();
				if (runs === 0 && !nested && !results && !questions) return;
				const title = [
					"pi-subagents: switch sessions?",
					"",
					"Background subagent work in this session:",
					...(runs > 0 ? [`  ${runs} run${runs === 1 ? "" : "s"} queued or running`] : []),
					...(nested ? ["  Nested subagents still running"] : []),
					...(results ? ["  Undelivered results"] : []),
					...(questions ? ["  Questions awaiting a reply"] : []),
				].join("\n");
				const choice = await ctx.ui.select(title, [STAY, TAKE, LEAVE], { signal: lifetime.signal, timeout: ctx.mode === "rpc" ? RPC_PROMPT_TIMEOUT_MS : undefined });
				if (lifetime.signal.aborted || deps.state.currentSessionId !== sessionId) return { cancel: true };
				if (choice === TAKE) return;
				if (choice === LEAVE) {
					leave = { sessionId, reason };
					return;
				}
				return { cancel: true };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				// Pi ignores thrown switch hooks; always return cancel, even if the UI is stale.
				try { if (!lifetime.signal.aborted) ctx.ui.notify(`Session switch cancelled: ${message}`, "warning"); }
				catch { /* The context may already be stale. */ }
				return { cancel: true };
			} finally {
				checking = false;
			}
		},
		// Recorded only once the switch commits, so a switch another extension cancels keeps the default handoff.
		sessionShutdown(event: SessionShutdownEvent) {
			const left = leave;
			leave = undefined;
			const sessionId = deps.state.currentSessionId;
			if (!sessionId) return;
			if (left && left.sessionId === sessionId && left.reason === event.reason) keepSessionWork(sessionId);
			else releaseSessionWork(sessionId);
		},
		dispose() {
			leave = undefined;
			lifetime.abort();
		},
	};
}
