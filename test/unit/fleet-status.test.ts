import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Editor, visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SubagentState } from "../../src/shared/types.ts";
import { collectFleetSnapshot } from "../../src/tui/fleet.ts";
import {
	FLEET_STATUS_WIDGET_KEY,
	SubagentFleetStatus,
	collectFleetStatusEntries,
	formatFleetElapsed,
	formatFleetTokens,
} from "../../src/tui/fleet-status.ts";

function stateForTest(): SubagentState {
	return {
		baseCwd: process.cwd(),
		currentSessionId: "session-current",
		asyncJobs: new Map(),
		fleetJobs: new Map(),
		foregroundRuns: new Map(),
		foregroundControls: new Map(),
		lastForegroundControlId: null,
		cleanupTimers: new Map(),
		lastUiContext: null,
		poller: null,
		completionSeen: new Map(),
		watcher: null,
		watcherRestartTimer: null,
		resultFileCoalescer: { schedule: () => false, clear: () => {} },
	};
}

const theme = {
	fg: (_name: string, text: string) => text,
	bg: (_name: string, text: string) => text,
	bold: (text: string) => text,
};

describe("below-editor subagent FleetView", () => {
	it("formats elapsed time and token counts like the Claude Code fleet", () => {
		assert.equal(formatFleetElapsed(10_600), "11s");
		assert.equal(formatFleetTokens(999), "↓ 999 tokens");
		assert.equal(formatFleetTokens(13_100), "↓ 13.1k tokens");
		assert.equal(formatFleetTokens(1_250_000), "↓ 1.3M tokens");
	});

	it("renders main plus active children below the editor and bounds every line", () => {
		const state = stateForTest();
		const now = Date.now();
		for (let index = 0; index < 7; index++) {
			state.foregroundControls.set(`run-${index}`, {
				runId: `run-${index}`,
				mode: "single",
				startedAt: now - 11_000 + index,
				updatedAt: now,
				currentAgent: `worker-${index}`,
				description: index === 0 ? "Inspect\nmodule 0" : `Inspect module ${index}`,
				tokens: index === 0 ? 13_100 : index,
			});
		}

		let widgetFactory: ((tui: unknown, theme: typeof theme) => { render(width: number): string[] }) | undefined;
		const ctx = {
			hasUI: true,
			ui: {
				setWidget(key: string, content: typeof widgetFactory | undefined, options?: { placement?: string }) {
					assert.equal(key, FLEET_STATUS_WIDGET_KEY);
					if (content) {
						assert.equal(options?.placement, "belowEditor");
						widgetFactory = content;
					}
				},
				onTerminalInput() { return () => {}; },
				getEditorText() { return ""; },
				requestRender() {},
				notify() {},
				theme,
			},
		} as unknown as ExtensionContext;
		const fleet = new SubagentFleetStatus(state, () => {}, { refreshMs: 60_000 });
		try {
			fleet.setContext(ctx);
			assert.ok(widgetFactory);
			const component = widgetFactory!({ requestRender() {} }, theme);
			const lines = component.render(80);
			assert.ok(lines.some((line) => line.includes("⏺ main")));
			assert.ok(lines.some((line) => line.includes("worker-0") && line.includes("Inspect module 0")));
			assert.ok(lines.some((line) => line.includes("11s · ↓ 13.1k tokens")));
			assert.ok(lines.some((line) => line.includes("↓ 2 more")));
			for (const line of lines) assert.ok(visibleWidth(line) <= 80, `line exceeded width: ${line}`);
		} finally {
			fleet.dispose();
		}
	});

	it("keeps widget ownership through invalidation so an empty refresh removes it", () => {
		const state = stateForTest();
		state.foregroundControls.set("run-worker", {
			runId: "run-worker",
			mode: "single",
			startedAt: 10,
			updatedAt: 20,
			currentAgent: "worker",
		});
		let widgetFactory: ((tui: unknown, theme: typeof theme) => { render(width: number): string[]; invalidate(): void }) | undefined;
		let removals = 0;
		const ctx = {
			hasUI: true,
			ui: {
				setWidget(_key: string, content: typeof widgetFactory | undefined) {
					if (content) widgetFactory = content;
					else removals++;
				},
				onTerminalInput() { return () => {}; },
				getEditorText() { return ""; },
				requestRender() {},
				notify() {},
				theme,
			},
		} as unknown as ExtensionContext;
		const fleet = new SubagentFleetStatus(state, () => {}, { refreshMs: 60_000 });
		try {
			fleet.setContext(ctx);
			const component = widgetFactory!({ requestRender() {} }, theme);
			component.invalidate();
			state.foregroundControls.clear();
			fleet.refresh();
			assert.equal(removals, 1);
		} finally {
			fleet.dispose();
		}
	});

	it("shows only the current sequential chain step while retaining active parallel siblings", () => {
		const state = stateForTest();
		state.asyncJobs.set("sequential", {
			asyncId: "sequential",
			asyncDir: "/tmp/sequential",
			status: "running",
			mode: "chain",
			currentStep: 1,
			startedAt: 50,
			updatedAt: 200,
			steps: [
				{ agent: "scout", index: 0, status: "complete" },
				{ agent: "worker", index: 1, status: "running" },
				{ agent: "reviewer", index: 2, status: "pending" },
			],
		});
		state.asyncJobs.set("parallel-group", {
			asyncId: "parallel-group",
			asyncDir: "/tmp/parallel-group",
			status: "running",
			mode: "chain",
			currentStep: 3,
			activeParallelGroup: true,
			startedAt: 100,
			updatedAt: 200,
			steps: [
				{ agent: "reviewer", index: 3, status: "running" },
				{ agent: "tester", index: 4, status: "pending" },
			],
		});
		assert.deepEqual(collectFleetStatusEntries(state).map((entry) => entry.key), [
			"async:sequential:1",
			"async:parallel-group:3",
			"async:parallel-group:4",
		]);
	});

	it("shows every active foreground parallel child", () => {
		const state = stateForTest();
		state.foregroundControls.set("parallel", {
			runId: "parallel",
			mode: "parallel",
			startedAt: 10,
			updatedAt: 30,
			activeChildren: new Map([
				[0, { index: 0, agent: "reviewer", description: "Review correctness", startedAt: 11, updatedAt: 21, tokens: 100 }],
				[1, { index: 1, agent: "reviewer", description: "Review quality", startedAt: 12, updatedAt: 22, tokens: 200 }],
				[2, { index: 2, agent: "reviewer", description: "Review tests", startedAt: 13, updatedAt: 23, tokens: 300 }],
			]),
		});

		const entries = collectFleetStatusEntries(state);
		assert.deepEqual(entries.map((entry) => entry.key), [
			"foreground-active:parallel:0",
			"foreground-active:parallel:1",
			"foreground-active:parallel:2",
		]);
		assert.deepEqual(entries.map((entry) => entry.description), ["Review correctness", "Review quality", "Review tests"]);
		assert.deepEqual(collectFleetSnapshot(state).items.map((item) => item.key), entries.map((entry) => entry.key));
	});

	it("uses the same item keys as the full inspector", () => {
		const state = stateForTest();
		state.foregroundControls.set("foreground", {
			runId: "foreground",
			mode: "single",
			startedAt: 10,
			updatedAt: 20,
			currentAgent: "worker",
			currentIndex: 2,
		});
		const asyncJob = {
			asyncId: "background",
			asyncDir: "/tmp/background",
			sessionId: "session-current",
			status: "running" as const,
			mode: "single" as const,
			startedAt: 10,
			updatedAt: 20,
			steps: [{ agent: "reviewer", index: 0, status: "running" as const }],
		};
		state.asyncJobs.set(asyncJob.asyncId, asyncJob);
		state.fleetJobs!.set(asyncJob.asyncId, asyncJob);

		const statusKeys = collectFleetStatusEntries(state).map((entry) => entry.key).sort();
		const inspectorKeys = collectFleetSnapshot(state).items.map((item) => item.key).sort();
		assert.deepEqual(statusKeys, inspectorKeys);
	});

	it("uses tracked async task descriptions and per-child token totals", () => {
		const state = stateForTest();
		state.asyncJobs.set("async-run", {
			asyncId: "async-run",
			asyncDir: "/tmp/async-run",
			status: "running",
			mode: "parallel",
			description: "Review the authentication changes",
			startedAt: 100,
			updatedAt: 200,
			steps: [
				{ agent: "reviewer", index: 0, status: "running", startedAt: 120, tokens: { input: 4_000, output: 200, total: 4_200 } },
				{ agent: "worker", index: 1, status: "complete", tokens: { input: 100, output: 20, total: 120 } },
			],
		});
		const fleet = new SubagentFleetStatus(state, () => {}, { refreshMs: 60_000 });
		let widgetFactory: ((tui: unknown, theme: typeof theme) => { render(width: number): string[] }) | undefined;
		const ctx = {
			hasUI: true,
			ui: {
				setWidget(_key: string, content: typeof widgetFactory | undefined) { if (content) widgetFactory = content; },
				onTerminalInput() { return () => {}; },
				getEditorText() { return ""; },
				requestRender() {},
				notify() {},
				theme,
			},
		} as unknown as ExtensionContext;
		try {
			fleet.setContext(ctx);
			const lines = widgetFactory!({ requestRender() {} }, theme).render(100);
			assert.ok(lines.some((line) => line.includes("reviewer") && line.includes("Review the authentication changes")));
			assert.ok(lines.some((line) => line.includes("↓ 4.2k tokens")));
			assert.ok(!lines.some((line) => line.includes("worker")), "completed async children should leave the status fleet");
		} finally {
			fleet.dispose();
		}
	});

	it("only captures navigation at an empty editor and opens the selected child", async () => {
		const state = stateForTest();
		state.foregroundControls.set("run-worker", {
			runId: "run-worker",
			mode: "single",
			startedAt: Date.now() - 1_000,
			updatedAt: Date.now(),
			currentAgent: "worker",
			description: "Implement FleetView",
		});
		let editorText = "draft";
		let inputHandler: ((data: string) => { consume?: boolean } | undefined) | undefined;
		let widgetFactory: ((tui: unknown, theme: typeof theme) => { render(width: number): string[] }) | undefined;
		const opened: string[] = [];
		const ctx = {
			hasUI: true,
			ui: {
				setWidget(_key: string, content: typeof widgetFactory | undefined) { if (content) widgetFactory = content; },
				onTerminalInput(handler: typeof inputHandler) { inputHandler = handler; return () => { inputHandler = undefined; }; },
				getEditorText() { return editorText; },
				requestRender() {},
				notify() {},
				theme,
			},
		} as unknown as ExtensionContext;
		const fleet = new SubagentFleetStatus(state, async (key) => { opened.push(key); }, { refreshMs: 60_000 });
		try {
			fleet.setContext(ctx);
			assert.ok(inputHandler);
			assert.ok(widgetFactory);
			const tui = { requestRender() {}, focusedComponent: Object.create(Editor.prototype) as Editor };
			const component = widgetFactory!(tui, theme);

			assert.equal(inputHandler!("\x1b[B"), undefined, "non-empty editor should retain Down");
			editorText = "";
			tui.focusedComponent = {} as Editor;
			assert.equal(inputHandler!("\x1b[B"), undefined, "non-editor focus should retain Down");
			tui.focusedComponent = Object.create(Editor.prototype) as Editor;
			assert.deepEqual(inputHandler!("\x1b[B"), { consume: true });
			assert.deepEqual(inputHandler!("\x1b[B"), { consume: true });
			assert.ok(component.render(100).some((line) => line.includes("⏺ worker")));
			assert.deepEqual(inputHandler!("\r"), { consume: true });
			await Promise.resolve();
			assert.deepEqual(opened, ["foreground-active:run-worker:0"]);
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.deepEqual(inputHandler!("\x1b"), { consume: true });
			assert.ok(component.render(100).some((line) => line.includes("⏺ main")));
		} finally {
			fleet.dispose();
		}
	});
});
