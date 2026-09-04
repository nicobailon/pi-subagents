import * as fs from "node:fs";
import type { SubagentState } from "../../shared/types.ts";
import { shouldUseNativeFsWatch } from "../../shared/watch-strategy.ts";
import { hasLiveNestedDescendants, projectNestedEvents } from "../shared/nested-events.ts";

interface RetainedNestedRouteTrackerOptions {
	pollIntervalMs?: number;
	platform?: NodeJS.Platform;
	watch?: typeof fs.watch;
}

const DEFAULT_POLL_INTERVAL_MS = 5000;
const REFRESH_DEBOUNCE_MS = 25;

export function createRetainedNestedRouteTracker(
	state: Pick<SubagentState, "retainedForegroundNestedRoutes">,
	options: RetainedNestedRouteTrackerOptions = {},
): { track: (rootRunId: string) => void; clear: () => void } {
	const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
	const watch = options.watch ?? fs.watch;
	const watchers = new Map<string, fs.FSWatcher>();
	const refreshTimers = new Map<string, ReturnType<typeof setTimeout>>();
	let poller: ReturnType<typeof setInterval> | undefined;

	const close = (rootRunId: string): void => {
		watchers.get(rootRunId)?.close();
		watchers.delete(rootRunId);
		const timer = refreshTimers.get(rootRunId);
		if (timer) clearTimeout(timer);
		refreshTimers.delete(rootRunId);
	};

	const refresh = (rootRunId: string): void => {
		const retained = state.retainedForegroundNestedRoutes?.get(rootRunId);
		if (!retained) {
			close(rootRunId);
			return;
		}
		try {
			if (hasLiveNestedDescendants(projectNestedEvents(retained).children)) return;
			state.retainedForegroundNestedRoutes?.delete(rootRunId);
			close(rootRunId);
		} catch (error) {
			console.error(`Failed to refresh retained nested descendants for foreground run '${rootRunId}':`, error);
		}
	};

	const scheduleRefresh = (rootRunId: string): void => {
		if (refreshTimers.has(rootRunId)) return;
		const timer = setTimeout(() => {
			refreshTimers.delete(rootRunId);
			refresh(rootRunId);
		}, REFRESH_DEBOUNCE_MS);
		timer.unref?.();
		refreshTimers.set(rootRunId, timer);
	};

	const ensurePoller = (): void => {
		if (poller || (state.retainedForegroundNestedRoutes?.size ?? 0) === 0) return;
		poller = setInterval(() => {
			for (const rootRunId of state.retainedForegroundNestedRoutes?.keys() ?? []) refresh(rootRunId);
			if ((state.retainedForegroundNestedRoutes?.size ?? 0) > 0) return;
			if (poller) clearInterval(poller);
			poller = undefined;
		}, pollIntervalMs);
		poller.unref?.();
	};

	const track = (rootRunId: string): void => {
		const retained = state.retainedForegroundNestedRoutes?.get(rootRunId);
		if (!retained) return;
		if (shouldUseNativeFsWatch("retained-nested-route-tracker", options.platform) && !watchers.has(rootRunId)) {
			try {
				const watcher = watch(retained.eventSink, () => scheduleRefresh(rootRunId));
				watcher.on("error", () => close(rootRunId));
				watcher.unref?.();
				watchers.set(rootRunId, watcher);
			} catch {
				// The bounded safety poll below covers unsupported or failed watchers.
			}
		}
		scheduleRefresh(rootRunId);
		ensurePoller();
	};

	const clear = (): void => {
		if (poller) clearInterval(poller);
		poller = undefined;
		for (const rootRunId of watchers.keys()) close(rootRunId);
		for (const timer of refreshTimers.values()) clearTimeout(timer);
		refreshTimers.clear();
		state.retainedForegroundNestedRoutes?.clear();
	};

	return { track, clear };
}
