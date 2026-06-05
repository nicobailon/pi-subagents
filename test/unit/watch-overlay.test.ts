import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { collectWatchFiles, createWatchOverlayState, handleWatchOverlayKey, WatchOverlay } from "../../src/watch/watch-overlay.ts";

describe("watch overlay state", () => {
	it("cycles tabs with tab and shift-tab", () => {
		const state = createWatchOverlayState();
		assert.equal(state.tab, "transcript");
		handleWatchOverlayKey(state, "\t", { totalLines: 0, visibleLines: 10 });
		assert.equal(state.tab, "status");
		handleWatchOverlayKey(state, "\t", { totalLines: 0, visibleLines: 10 });
		assert.equal(state.tab, "log");
		handleWatchOverlayKey(state, "\x1b[Z", { totalLines: 0, visibleLines: 10 });
		assert.equal(state.tab, "status");
	});

	it("returns navigation actions for back and close", () => {
		const state = createWatchOverlayState();
		assert.equal(handleWatchOverlayKey(state, "b", { totalLines: 0, visibleLines: 10 }), "back");
		assert.equal(handleWatchOverlayKey(state, "q", { totalLines: 0, visibleLines: 10 }), "close");
	});

	it("collects transcript, log, root log, events, and status files for refresh", () => {
		const files = collectWatchFiles({
			sessionFile: "/tmp/session.jsonl",
			outputLog: "/tmp/output-0.log",
			rootLog: "/tmp/root.md",
			eventsFile: "/tmp/events.jsonl",
			statusFile: "/tmp/status.json",
		} as any);
		assert.deepEqual(files, ["/tmp/session.jsonl", "/tmp/output-0.log", "/tmp/root.md", "/tmp/events.jsonl", "/tmp/status.json"]);
	});

	it("refreshes target metadata during render", () => {
		const theme = { fg: (_name: string, text: string) => text, bold: (text: string) => text };
		const tui = { terminal: { rows: 12 }, requestRender() {} };
		const overlay = new WatchOverlay({
			tui: tui as any,
			theme: theme as any,
			target: { id: "run/1", rootRunId: "run", rootAsyncDir: "/tmp/run", rootStatus: "running", agent: "worker", displayName: "worker", status: "running", ancestry: ["run", "worker"], depth: 1 } as any,
			resolveTarget: () => ({ id: "run/1", rootRunId: "run", rootAsyncDir: "/tmp/run", rootStatus: "complete", agent: "worker", displayName: "worker", status: "complete", ancestry: ["run", "worker"], depth: 1 } as any),
			onBack() {},
			onClose() {},
		});
		try {
			assert.match(overlay.render(80).join("\n"), /run › worker · complete/);
		} finally {
			overlay.dispose();
		}
	});
});
