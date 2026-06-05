export type WatchScrollAction = "pageUp" | "pageDown" | "lineUp" | "lineDown";

export interface WatchScrollState {
	scrollOffset: number;
}

export function createWatchScrollState(): WatchScrollState {
	return { scrollOffset: 0 };
}

function maxOffset(totalLines: number, visibleLines: number): number {
	return Math.max(0, totalLines - visibleLines);
}

export function clampWatchScroll(state: WatchScrollState, totalLines: number, visibleLines: number): void {
	state.scrollOffset = Math.max(0, Math.min(state.scrollOffset, maxOffset(totalLines, visibleLines)));
}

export function scrollWatchState(state: WatchScrollState, action: WatchScrollAction, totalLines: number, visibleLines: number): void {
	const page = Math.max(1, visibleLines);
	if (action === "pageUp") state.scrollOffset += page;
	if (action === "pageDown") state.scrollOffset -= page;
	if (action === "lineUp") state.scrollOffset += 1;
	if (action === "lineDown") state.scrollOffset -= 1;
	clampWatchScroll(state, totalLines, visibleLines);
}

export function getVisibleRange(state: WatchScrollState, totalLines: number, visibleLines: number): { start: number; end: number } {
	clampWatchScroll(state, totalLines, visibleLines);
	const start = Math.max(0, totalLines - visibleLines - state.scrollOffset);
	const end = Math.max(0, totalLines - state.scrollOffset);
	return { start, end };
}
