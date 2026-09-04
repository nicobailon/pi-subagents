import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { retainLiveForegroundNestedRoute } from "../../src/integrations/pi-web-session-liveness.ts";
import { createRetainedNestedRouteTracker } from "../../src/runs/background/retained-nested-route-tracker.ts";
import { createNestedRoute, writeNestedEvent } from "../../src/runs/shared/nested-events.ts";
import type { SubagentState } from "../../src/shared/types.ts";

const routeRoots: string[] = [];

function route(rootRunId: string) {
	const value = createNestedRoute(rootRunId);
	routeRoots.push(path.dirname(value.eventSink));
	return value;
}

function writeState(value: ReturnType<typeof route>, state: "running" | "complete", ts: number): void {
	writeNestedEvent(value, {
		type: state === "running" ? "subagent.nested.updated" : "subagent.nested.completed",
		ts,
		parentRunId: value.rootRunId,
		child: {
			id: "nested-child",
			parentRunId: value.rootRunId,
			depth: 1,
			path: [{ runId: value.rootRunId }],
			state,
			agent: "worker",
			lastUpdate: ts,
		},
	});
}

async function waitFor(check: () => boolean, timeoutMs = 1000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
	assert.equal(check(), true, "condition did not become true before timeout");
}

afterEach(() => {
	for (const root of routeRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("retained foreground nested route tracker", () => {
	it("releases retained liveness after the nested descendant completes", async () => {
		const state: Pick<SubagentState, "retainedForegroundNestedRoutes"> = {};
		const nestedRoute = route("retained-root");
		writeState(nestedRoute, "running", 100);
		assert.equal(retainLiveForegroundNestedRoute(state, nestedRoute), true);

		const tracker = createRetainedNestedRouteTracker(state, { platform: "win32", pollIntervalMs: 10 });
		try {
			tracker.track(nestedRoute.rootRunId);
			writeState(nestedRoute, "complete", 200);
			await waitFor(() => !state.retainedForegroundNestedRoutes?.has(nestedRoute.rootRunId));
		} finally {
			tracker.clear();
		}
	});

	it("keeps the route through the handoff race until the first tracker refresh", async () => {
		const state: Pick<SubagentState, "retainedForegroundNestedRoutes"> = {};
		const nestedRoute = route("handoff-root");
		writeState(nestedRoute, "running", 100);
		assert.equal(retainLiveForegroundNestedRoute(state, nestedRoute), true);
		writeState(nestedRoute, "complete", 200);

		const retained = state.retainedForegroundNestedRoutes?.get(nestedRoute.rootRunId);
		assert.equal(retained?.awaitingFirstRefresh, true);

		const tracker = createRetainedNestedRouteTracker(state, { platform: "win32", pollIntervalMs: 60_000 });
		try {
			tracker.track(nestedRoute.rootRunId);
			assert.equal(state.retainedForegroundNestedRoutes?.has(nestedRoute.rootRunId), true);
			await waitFor(() => !state.retainedForegroundNestedRoutes?.has(nestedRoute.rootRunId));
		} finally {
			tracker.clear();
		}
	});

	it("keeps polling after a native watcher error", async () => {
		const state: Pick<SubagentState, "retainedForegroundNestedRoutes"> = {};
		const nestedRoute = route("watch-error-root");
		writeState(nestedRoute, "running", 100);
		assert.equal(retainLiveForegroundNestedRoute(state, nestedRoute), true);

		let watcherError: (() => void) | undefined;
		const tracker = createRetainedNestedRouteTracker(state, {
			platform: "linux",
			pollIntervalMs: 10,
			watch: (() => ({
				close: () => undefined,
				on: (event: string, listener: () => void) => {
					if (event === "error") watcherError = listener;
					return undefined;
				},
				unref: () => undefined,
			} as unknown as fs.FSWatcher)) as typeof fs.watch,
		});
		try {
			tracker.track(nestedRoute.rootRunId);
			watcherError?.();
			writeState(nestedRoute, "complete", 200);
			await waitFor(() => !state.retainedForegroundNestedRoutes?.has(nestedRoute.rootRunId));
		} finally {
			tracker.clear();
		}
	});

	it("refreshes every retained route instead of stopping at the first live one", async () => {
		const state: Pick<SubagentState, "retainedForegroundNestedRoutes"> = {};
		const liveRoute = route("multi-live-root");
		const terminalRoute = route("multi-terminal-root");
		writeState(liveRoute, "running", 100);
		writeState(terminalRoute, "running", 100);
		assert.equal(retainLiveForegroundNestedRoute(state, liveRoute), true);
		assert.equal(retainLiveForegroundNestedRoute(state, terminalRoute), true);

		const tracker = createRetainedNestedRouteTracker(state, { platform: "win32", pollIntervalMs: 10 });
		try {
			tracker.track(liveRoute.rootRunId);
			tracker.track(terminalRoute.rootRunId);
			writeState(terminalRoute, "complete", 200);
			await waitFor(() => !state.retainedForegroundNestedRoutes?.has(terminalRoute.rootRunId));
			assert.equal(state.retainedForegroundNestedRoutes?.has(liveRoute.rootRunId), true);
		} finally {
			tracker.clear();
		}
	});

	it("refreshes promptly from native watch events", async () => {
		const state: Pick<SubagentState, "retainedForegroundNestedRoutes"> = {};
		const nestedRoute = route("watched-root");
		writeState(nestedRoute, "running", 100);
		assert.equal(retainLiveForegroundNestedRoute(state, nestedRoute), true);

		let notify: (() => void) | undefined;
		let closed = 0;
		const tracker = createRetainedNestedRouteTracker(state, {
			platform: "linux",
			pollIntervalMs: 60_000,
			watch: ((_path: fs.PathLike, listener: fs.WatchListener<string>) => {
				notify = () => listener("rename", "event.json");
				return {
					close: () => { closed += 1; },
					on: () => undefined,
					unref: () => undefined,
				} as unknown as fs.FSWatcher;
			}) as typeof fs.watch,
		});
		try {
			tracker.track(nestedRoute.rootRunId);
			writeState(nestedRoute, "complete", 200);
			notify?.();
			await waitFor(() => !state.retainedForegroundNestedRoutes?.has(nestedRoute.rootRunId));
			assert.equal(closed, 1);
		} finally {
			tracker.clear();
		}
	});

	it("clears every retained route during session teardown", () => {
		const state: Pick<SubagentState, "retainedForegroundNestedRoutes"> = {};
		const nestedRoute = route("cleared-root");
		writeState(nestedRoute, "running", 100);
		assert.equal(retainLiveForegroundNestedRoute(state, nestedRoute), true);

		const tracker = createRetainedNestedRouteTracker(state, { platform: "win32", pollIntervalMs: 60_000 });
		tracker.track(nestedRoute.rootRunId);
		tracker.clear();

		assert.equal(state.retainedForegroundNestedRoutes?.size, 0);
	});
});
