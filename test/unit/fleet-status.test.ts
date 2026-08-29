import assert from "node:assert/strict";
import * as path from "node:path";
import { describe, it } from "node:test";
import { Editor, type EditorComponent, visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SubagentState } from "../../src/shared/types.ts";
import { EXTERNAL_RUN_REGISTRY_KEY, EXTERNAL_RUN_REGISTRY_VERSION, registerExternalRun } from "../../src/api/external-runs.ts";
import { collectFleetSnapshot } from "../../src/tui/fleet.ts";
import {
	FLEET_STATUS_WIDGET_KEY,
	SubagentFleetStatus,
	collectFleetStatusEntries,
	formatFleetElapsed,
	formatFleetTokens,
	resolveFleetViewPlacement,
} from "../../src/tui/fleet-status.ts";

function clearExternalRuns(): void {
	delete (globalThis as Record<PropertyKey, unknown>)[Symbol.for(EXTERNAL_RUN_REGISTRY_KEY)];
}

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
		assert.equal(formatFleetTokens(484_000, 129_000), "↓ 129.0k window · 484.0k spent");
	});

	it("renders cached external jobs with an external marker and elapsed time", () => {
		clearExternalRuns();
		registerExternalRun({
			id: "external-review",
			sessionId: "session-current",
			source: "interactive-shell",
			label: "Dependency review",
			state: "running",
			startedAt: Date.now() - 11_000,
			currentAction: "Inspecting package metadata",
		});
		const state = stateForTest();
		state.activeAsyncCapacity = { used: 0, limit: 0 };
		assert.deepEqual(collectFleetStatusEntries(state).map((entry) => ({ key: entry.key, agent: entry.agent, description: entry.description })), [{
			key: "external:external-review",
			agent: "external · Dependency review",
			description: "Inspecting package metadata",
		}]);
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
		const fleet = new SubagentFleetStatus(state, () => {}, { refreshMs: 60_000 });
		try {
			fleet.setContext(ctx);
			const tui = { requestRender() {}, focusedComponent: Object.create(Editor.prototype) as Editor };
			const component = widgetFactory!(tui, theme);
			const compact = component.render(80)[0]!;
			assert.match(compact, /1 active job/);
			assert.doesNotMatch(compact, /Async runs|tokens/);
			fleet.handleKey("\x1b[B");
			const expanded = component.render(80).join("\n");
			assert.match(expanded, /external · Dependency review · running/);
			assert.match(expanded, /11s/);
			assert.doesNotMatch(expanded.split("\n").find((line) => line.includes("Dependency review"))!, /tokens/);
		} finally {
			fleet.dispose();
			clearExternalRuns();
		}
	});

	it("warns when compact FleetView cannot inspect external jobs", () => {
		clearExternalRuns();
		const warnings: string[] = [];
		const originalWarn = console.warn;
		console.warn = (message?: unknown) => warnings.push(String(message));
		(globalThis as Record<PropertyKey, unknown>)[Symbol.for(EXTERNAL_RUN_REGISTRY_KEY)] = {
			version: EXTERNAL_RUN_REGISTRY_VERSION + 1,
			runs: new Map(),
		};
		try {
			assert.deepEqual(collectFleetStatusEntries(stateForTest()), []);
			assert.match(warnings[0]!, /Failed to inspect external jobs/);
		} finally {
			console.warn = originalWarn;
			clearExternalRuns();
		}
	});

	it("resolves configured FleetView placement with a below-editor fallback", () => {
		assert.equal(resolveFleetViewPlacement(undefined), "belowEditor");
		assert.equal(resolveFleetViewPlacement("belowEditor"), "belowEditor");
		assert.equal(resolveFleetViewPlacement("aboveEditor"), "aboveEditor");
		assert.equal(resolveFleetViewPlacement("side"), "belowEditor");
	});

	it("renders main plus active children below the editor and bounds every line", () => {
		const state = stateForTest();
		state.activeAsyncCapacity = { used: 2, limit: 4 };
		const now = Date.now();
		for (let index = 0; index < 7; index++) {
			state.foregroundControls.set(`run-${index}`, {
				runId: `run-${index}`,
				mode: "single",
				startedAt: now - 11_000 + index,
				updatedAt: now,
				currentAgent: `worker-${index}`,
				description: index === 0 ? "Inspect\nmodule 0" : `Inspect module ${index}`,
				...(index === 0 ? { model: "anthropic/fable-5", thinking: "low" } : {}),
				tokens: index === 0 ? 13_100 : 100,
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
			const tui = {
				requestRender() {},
				focusedComponent: Object.create(Editor.prototype) as Editor,
			};
			const component = widgetFactory!(tui, theme);
			const compactLines = component.render(80);
			assert.equal(compactLines.length, 1);
			assert.ok(compactLines[0]!.includes("7 active agents · Async runs 2/4"));
			assert.ok(compactLines[0]!.includes("↓ 13.7k tokens"));
			assert.ok(compactLines[0]!.includes("↓/← to inspect"));
			assert.ok(visibleWidth(compactLines[0]!) <= 80);

			assert.deepEqual(fleet.handleKey("\x1b[B"), { consume: true });
			const expandedLines = component.render(80);
			assert.ok(expandedLines.some((line) => line.includes("> main")));
			assert.ok(expandedLines.some((line) => line.includes("  worker-0")), "unselected agents use blank focus space");
			assert.ok(expandedLines.every((line) => !/[⏺◯]/u.test(line)), "selection avoids terminal-ambiguous circle glyphs");
			assert.ok(expandedLines.some((line) => line.includes("worker-0 (fable-5 · thinking low)")));
			assert.ok(expandedLines.some((line) => line.includes("11s · ↓ 13.1k tokens")));
			assert.ok(expandedLines.some((line) => line.includes("↓ 1 more")));
			for (const line of expandedLines) assert.ok(visibleWidth(line) <= 80, `line exceeded width: ${line}`);

			assert.deepEqual(fleet.handleKey("\x1b"), { consume: true });
			assert.equal(component.render(80).length, 1);
			assert.deepEqual(fleet.handleKey("\x1b[D"), { consume: true });
			assert.ok(component.render(80).length > 1, "Left should also expand the roster");
		} finally {
			fleet.dispose();
		}
	});

	it("keeps occupied capacity visible without active child rows", () => {
		const state = stateForTest();
		state.activeAsyncCapacity = { used: 1, limit: 2 };
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
		const fleet = new SubagentFleetStatus(state, () => {}, { refreshMs: 60_000 });
		try {
			fleet.setContext(ctx);
			assert.ok(widgetFactory);
			assert.deepEqual(widgetFactory!({ requestRender() {} }, theme).render(80), ["  Async runs 1/2 · ↓ 0 tokens · ↓/← to inspect"]);
		} finally {
			fleet.dispose();
		}
	});

	it("keeps one queued agent visible in the compact summary", () => {
		const state = stateForTest();
		state.asyncJobs.set("run-worker", {
			asyncId: "run-worker",
			asyncDir: "/tmp/run-worker",
			status: "queued",
			mode: "single",
			startedAt: 10,
			updatedAt: 20,
			totalTokens: { input: 40, output: 2, total: 42, window: 30, windowPeak: 35 },
		});
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
		const fleet = new SubagentFleetStatus(state, () => {}, { refreshMs: 60_000 });
		try {
			fleet.setContext(ctx);
			const lines = widgetFactory!({ requestRender() {} }, theme).render(50);
			assert.equal(lines.length, 1);
			assert.ok(lines[0]!.includes("1 active agent"));
			assert.ok(lines[0]!.includes("↓ 30 window · 42 spent"));
			assert.ok(visibleWidth(lines[0]!) <= 50);
		} finally {
			fleet.dispose();
		}
	});

	it("repaints unchanged running entries but keeps queued-only ticks quiet", () => {
		const refreshCount = (status: "running" | "queued"): number => {
			const state = stateForTest();
			state.asyncJobs.set(`run-${status}`, {
				asyncId: `run-${status}`,
				asyncDir: `/tmp/run-${status}`,
				status,
				mode: "single",
				startedAt: 10,
				updatedAt: 20,
			});
			let widgetFactory: ((tui: unknown, theme: typeof theme) => { render(width: number): string[] }) | undefined;
			let renderRequests = 0;
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
			const fleet = new SubagentFleetStatus(state, () => {}, { refreshMs: 60_000 });
			try {
				fleet.setContext(ctx);
				assert.ok(widgetFactory);
				widgetFactory!({ requestRender() { renderRequests++; } }, theme);
				fleet.refresh();
				return renderRequests;
			} finally {
				fleet.dispose();
			}
		};

		assert.equal(refreshCount("running"), 1);
		assert.equal(refreshCount("queued"), 0);
	});

	it("counts project panes in compact status", () => {
		const state = stateForTest();
		const projectRoot = path.join("fixtures", "peer-project");
		const asyncDir = path.join("fixtures", "async-run");
		state.asyncJobs.set("run-view", {
			asyncId: "run-view",
			asyncDir,
			status: "running",
			mode: "single",
			agents: ["worker"],
			startedAt: Date.now() - 12_000,
			updatedAt: Date.now() - 1_000,
		});
		state.herdrProjectPanes = new Map([[projectRoot, {
			projectRoot,
			bindingPath: path.join(projectRoot, ".pi/subagents/project-panes/herdr.json"),
			paneId: "w1:p50",
			openedAt: "2026-01-01T00:00:00.000Z",
			state: "open",
			agentStatus: "needs_attention",
			ownership: "verified",
			safeToClose: false,
			refreshedAt: Date.now() - 2_000,
			summary: "worker needs attention",
		}]]);

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
		const fleet = new SubagentFleetStatus(state, () => {}, { refreshMs: 60_000 });
		try {
			fleet.setContext(ctx);
			const component = widgetFactory!({ requestRender() {}, focusedComponent: Object.create(Editor.prototype) as Editor }, theme);
			const compact = component.render(100)[0]!;
			assert.match(compact, /1 active agent/);
			assert.match(compact, /1 pane \(1 ⚠\)/);
			assert.deepEqual(fleet.handleKey("\x1b[B"), { consume: true });
			const expanded = component.render(100).join("\n");
			assert.match(expanded, /project panes/);
			assert.match(expanded, /peer-project · w1:p50/);
			assert.match(expanded, /worker needs attention/);
			assert.doesNotMatch(expanded, /views/);
		} finally {
			fleet.dispose();
		}
	});

	it("registers above the editor when configured", () => {
		const state = stateForTest();
		state.foregroundControls.set("run-worker", {
			runId: "run-worker",
			mode: "single",
			startedAt: 10,
			updatedAt: 20,
			currentAgent: "worker",
		});
		let placement: string | undefined;
		const ctx = {
			hasUI: true,
			ui: {
				setWidget(_key: string, content: unknown, options?: { placement?: string }) {
					if (content) placement = options?.placement;
				},
				onTerminalInput() { return () => {}; },
				getEditorText() { return ""; },
				notify() {},
				theme,
			},
		} as unknown as ExtensionContext;
		const fleet = new SubagentFleetStatus(state, () => {}, { refreshMs: 60_000, placement: "aboveEditor" });
		try {
			fleet.setContext(ctx);
			assert.equal(placement, "aboveEditor");
		} finally {
			fleet.dispose();
		}
	});

	it("stops refreshing when the captured extension context becomes stale", () => {
		const state = stateForTest();
		state.foregroundControls.set("run-worker", {
			runId: "run-worker",
			mode: "single",
			startedAt: 10,
			updatedAt: 20,
			currentAgent: "worker",
		});
		let stale = false;
		let contextReads = 0;
		let inputUnsubscribes = 0;
		let widgetRemovals = 0;
		const ctx = {
			get hasUI() {
				contextReads++;
				if (stale) {
					throw new Error("This extension ctx is stale after session replacement or reload.");
				}
				return true;
			},
			ui: {
				setWidget(_key: string, content: unknown) {
					if (content === undefined) widgetRemovals++;
				},
				onTerminalInput() { return () => { inputUnsubscribes++; }; },
				getEditorText() { return ""; },
				notify() {},
				theme,
			},
		} as unknown as ExtensionContext;
		const fleet = new SubagentFleetStatus(state, () => {}, { refreshMs: 60_000 });
		try {
			fleet.setContext(ctx);
			stale = true;
			assert.doesNotThrow(() => fleet.refresh());
			assert.equal(inputUnsubscribes, 1);
			assert.equal(widgetRemovals, 1);
			assert.equal((fleet as unknown as { timer?: unknown }).timer, undefined);
			const readsAfterStaleRefresh = contextReads;
			fleet.refresh();
			assert.equal(contextReads, readsAfterStaleRefresh, "later refreshes must not reuse the stale context");
		} finally {
			fleet.dispose();
		}
	});

	it("does not swallow unrelated widget cleanup errors", () => {
		const state = stateForTest();
		state.foregroundControls.set("run-worker", {
			runId: "run-worker",
			mode: "single",
			startedAt: 10,
			updatedAt: 20,
			currentAgent: "worker",
		});
		const ctx = {
			hasUI: true,
			ui: {
				setWidget(_key: string, content: unknown) {
					if (content === undefined) throw new Error("widget cleanup failed");
				},
				onTerminalInput() { return () => {}; },
				getEditorText() { return ""; },
				notify() {},
				theme,
			},
		} as unknown as ExtensionContext;
		const fleet = new SubagentFleetStatus(state, () => {}, { refreshMs: 60_000 });
		fleet.setContext(ctx);
		assert.throws(() => fleet.dispose(), /widget cleanup failed/);
	});

	it("preserves multiple unrelated UI cleanup errors", () => {
		const state = stateForTest();
		state.foregroundControls.set("run-worker", {
			runId: "run-worker",
			mode: "single",
			startedAt: 10,
			updatedAt: 20,
			currentAgent: "worker",
		});
		const ctx = {
			hasUI: true,
			ui: {
				setWidget(_key: string, content: unknown) {
					if (content === undefined) throw new Error("widget cleanup failed");
				},
				onTerminalInput() {
					return () => { throw new Error("input cleanup failed"); };
				},
				getEditorText() { return ""; },
				notify() {},
				theme,
			},
		} as unknown as ExtensionContext;
		const fleet = new SubagentFleetStatus(state, () => {}, { refreshMs: 60_000 });
		fleet.setContext(ctx);
		assert.throws(
			() => fleet.dispose(),
			(error: unknown) => error instanceof AggregateError
				&& error.errors.map(String).join("\n").includes("input cleanup failed")
				&& error.errors.map(String).join("\n").includes("widget cleanup failed"),
		);
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

	it("removes the dynamic widget while the fleet inspector owns the viewport", () => {
		const state = stateForTest();
		state.foregroundControls.set("run-worker", {
			runId: "run-worker",
			mode: "single",
			startedAt: 10,
			updatedAt: 20,
			currentAgent: "worker",
		});
		const registrations: string[] = [];
		const ctx = {
			hasUI: true,
			ui: {
				setWidget(_key: string, content: unknown) {
					registrations.push(content ? "shown" : "hidden");
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
			state.fleetInspectorOpen = true;
			fleet.refresh();
			state.fleetInspectorOpen = false;
			fleet.refresh();
			assert.deepEqual(registrations, ["shown", "hidden", "shown"]);
		} finally {
			fleet.dispose();
		}
	});

	it("renders retained nested terminal siblings under an active owner with bounded leaves", () => {
		const state = stateForTest();
		state.asyncJobs.set("supervisor", {
			asyncId: "supervisor",
			asyncDir: "/tmp/supervisor",
			status: "running",
			mode: "single",
			startedAt: 10,
			updatedAt: 20,
			steps: [{ agent: "supervisor", index: 0, status: "running" }],
			nestedChildren: [0, 1, 2, 3, 4].map((index) => ({
				id: `nested-${index}`,
				parentRunId: "supervisor",
				parentStepIndex: 0,
				depth: 1,
				path: [{ runId: "supervisor", stepIndex: 0 }],
				state: index === 0 ? "complete" as const : "running" as const,
				agent: `leaf-${index}`,
				model: index === 0 ? "provider/gpt-5.6-luna:medium" : "provider/gpt-5.6-luna",
				thinking: "medium",
				startedAt: 10,
				lastUpdate: 20,
				...(index === 4 ? {
					children: [{
						id: "nested-hidden-child",
						parentRunId: "nested-4",
						depth: 2,
						path: [{ runId: "supervisor", stepIndex: 0 }, { runId: "nested-4" }],
						state: "running" as const,
						agent: "hidden-child",
					}],
				} : {}),
			})),
		});
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
		const fleet = new SubagentFleetStatus(state, () => {}, { refreshMs: 60_000 });
		try {
			fleet.setContext(ctx);
			const tui = { requestRender() {}, focusedComponent: Object.create(Editor.prototype) as Editor };
			const component = widgetFactory!(tui, theme);
			assert.equal(component.render(120).length, 1, "nested activity should stay compact until navigation activates the roster");
			assert.deepEqual(fleet.handleKey("\x1b[B"), { consume: true });
			const lines = component.render(120).join("\n");
			assert.match(lines, /supervisor/);
			for (const [index, state] of ["complete", "running", "running", "running"].entries()) {
				const line = lines.split("\n").find((candidate) => candidate.includes(`leaf-${index}`));
				assert.ok(line);
				assert.match(line!, /gpt-5.6-luna/);
				assert.match(line!, /thinking medium/);
				assert.match(line!, new RegExp(state));
			}
			assert.doesNotMatch(lines, /leaf-4.*running/);
			assert.doesNotMatch(lines, /hidden-child/);
			assert.match(lines, /\+2 nested leaves/);
		} finally {
			fleet.dispose();
		}
	});

	it("counts hidden nested leaves across multiple parallel children", () => {
		const state = stateForTest();
		state.asyncJobs.set("supervisor", {
			asyncId: "supervisor",
			asyncDir: "/tmp/supervisor",
			status: "running",
			mode: "single",
			startedAt: 10,
			updatedAt: 20,
			steps: [{ agent: "supervisor", index: 0, status: "running" }],
			nestedChildren: [
				{
					id: "nested-a",
					parentRunId: "supervisor",
					parentStepIndex: 0,
					depth: 1,
					path: [{ runId: "supervisor", stepIndex: 0 }],
					state: "running",
					mode: "parallel",
					steps: [0, 1, 2, 3].map((index) => ({ agent: `child-a-${index}`, index, status: "running" as const })),
				},
				{
					id: "nested-b",
					parentRunId: "supervisor",
					parentStepIndex: 0,
					depth: 1,
					path: [{ runId: "supervisor", stepIndex: 0 }],
					state: "running",
					mode: "parallel",
					steps: [0, 1].map((index) => ({ agent: `child-b-${index}`, index, status: "running" as const })),
				},
			],
		});
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
		const fleet = new SubagentFleetStatus(state, () => {}, { refreshMs: 60_000 });
		try {
			fleet.setContext(ctx);
			const tui = { requestRender() {}, focusedComponent: Object.create(Editor.prototype) as Editor };
			const component = widgetFactory!(tui, theme);
			assert.equal(component.render(120).length, 1, "parallel nested activity should stay compact until activated");
			assert.deepEqual(fleet.handleKey("\x1b[B"), { consume: true });
			const lines = component.render(120).join("\n");
			for (const index of [0, 1, 2, 3]) assert.match(lines, new RegExp(`child-a-${index}`));
			assert.doesNotMatch(lines, /child-b-[01]/);
			assert.match(lines, /\+2 nested leaves/);
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
			nestedChildren: [0, 1, 2].map((index) => ({
				id: `nested-${index}`,
				parentRunId: "parallel",
				parentStepIndex: index,
				depth: 1,
				path: [{ runId: "parallel", stepIndex: index }],
				state: "running" as const,
				agent: `nested-${index}`,
			})),
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
		assert.deepEqual(entries.map((entry) => entry.nestedChildren?.map((child) => child.id)), [["nested-0"], ["nested-1"], ["nested-2"]]);
		assert.deepEqual(collectFleetSnapshot(state).items.map((item) => item.key), entries.map((entry) => entry.key));
	});

	it("labels workflow-owned foreground children", () => {
		const state = stateForTest();
		state.foregroundControls.set("child-1", {
			runId: "child-1",
			parentWorkflowRunId: "workflow-1",
			workflowKey: "review",
			mode: "single",
			startedAt: 10,
			updatedAt: 20,
			activeChildren: new Map([[0, { index: 0, agent: "reviewer", description: "Review the change", startedAt: 10, updatedAt: 20 }]]),
		});

		assert.deepEqual(collectFleetStatusEntries(state).map((entry) => ({ agent: entry.agent, description: entry.description })), [{
			agent: "reviewer",
			description: "workflow child: workflow-1 (review) · Review the change",
		}]);
	});

	it("renders a workflow-owned foreground child under its workflow parent", () => {
		const state = stateForTest();
		state.asyncJobs.set("workflow-1", {
			asyncId: "workflow-1",
			asyncDir: "/tmp/workflow-1",
			status: "running",
			mode: "workflow",
			startedAt: 10,
			updatedAt: 20,
			nestedChildren: [{
				id: "owner-nested",
				parentRunId: "workflow-1",
				depth: 1,
				path: [{ runId: "workflow-1" }],
				state: "running",
				agent: "owner-nested",
			}],
		});
		state.foregroundControls.set("child-1", {
			runId: "child-1",
			parentWorkflowRunId: "workflow-1",
			workflowKey: "review",
			mode: "single",
			startedAt: 11,
			updatedAt: 20,
			activeChildren: new Map([[0, { index: 0, agent: "reviewer", startedAt: 11, updatedAt: 20 }]]),
			nestedChildren: [{
				id: "nested-review",
				parentRunId: "child-1",
				parentStepIndex: 0,
				depth: 1,
				path: [{ runId: "child-1", stepIndex: 0 }],
				state: "running",
				agent: "nested-reviewer",
			}],
		});
		state.foregroundControls.set("child-2", {
			runId: "child-2",
			parentWorkflowRunId: "workflow-1",
			workflowKey: "test",
			mode: "single",
			startedAt: 12,
			updatedAt: 20,
			activeChildren: new Map([[0, { index: 0, agent: "tester", startedAt: 12, updatedAt: 20 }]]),
			nestedChildren: [{
				id: "nested-test",
				parentRunId: "child-2",
				parentStepIndex: 0,
				depth: 1,
				path: [{ runId: "child-2", stepIndex: 0 }],
				state: "running",
				agent: "nested-tester",
			}],
		});
		const entries = collectFleetStatusEntries(state);
		assert.deepEqual(entries.map((entry) => [entry.key, entry.parentKey]), [
			["async:workflow-1", undefined],
			["foreground-active:child-1:0", "async:workflow-1"],
			["foreground-active:child-2:0", "async:workflow-1"],
		]);

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
		const fleet = new SubagentFleetStatus(state, () => {}, { refreshMs: 60_000 });
		try {
			fleet.setContext(ctx);
			const component = widgetFactory!({ requestRender() {}, focusedComponent: Object.create(Editor.prototype) as Editor }, theme);
			const compact = component.render(120);
			assert.match(compact[0]!, /2 active agents/, "workflow wrappers must not be counted as leaf agents");
			assert.doesNotMatch(compact[0]!, /3 active agents/);
			assert.deepEqual(fleet.handleKey("\x1b[B"), { consume: true });
			const lines = component.render(120);
			const workflowIndex = lines.findIndex((line) => line.includes("workflow · running"));
			const childIndex = lines.findIndex((line) => line.includes("reviewer · running"));
			const nestedIndex = lines.findIndex((line) => line.includes("nested-reviewer"));
			const secondChildIndex = lines.findIndex((line) => line.includes("tester · running"));
			const secondNestedIndex = lines.findIndex((line) => line.includes("nested-tester"));
			const ownerNestedIndex = lines.findIndex((line) => line.includes("owner-nested"));
			assert.ok(workflowIndex >= 0 && childIndex > workflowIndex && nestedIndex > childIndex);
			assert.ok(secondChildIndex > nestedIndex && secondNestedIndex > secondChildIndex && ownerNestedIndex > secondNestedIndex);
			assert.match(lines[childIndex]!, /├─.*reviewer/);
			assert.match(lines[nestedIndex]!, /├─.*nested-reviewer/);
			assert.match(lines[secondNestedIndex]!, /├─.*nested-tester/);
			assert.match(lines[ownerNestedIndex]!, /└─.*owner-nested/);
		} finally {
			fleet.dispose();
		}
	});

	it("attaches active async workflow children and removes matching shell rows", () => {
		const state = stateForTest();
		state.asyncJobs.set("workflow-1", {
			asyncId: "workflow-1",
			asyncDir: "/tmp/workflow-1",
			status: "running",
			mode: "workflow",
			startedAt: 10,
			updatedAt: 20,
			steps: [
				{ agent: "reviewer", workflowKey: "review", runId: "child-review", status: "running" },
				{ agent: "worker", workflowKey: "worker", runId: "child-worker", status: "running" },
			],
		});
		state.asyncJobs.set("child-review", {
			asyncId: "child-review",
			asyncDir: "/tmp/child-review",
			status: "running",
			mode: "single",
			parentWorkflowRunId: "workflow-1",
			workflowKey: "review",
			startedAt: 11,
			updatedAt: 20,
			steps: [{ agent: "reviewer", status: "running" }],
		});

		const entries = collectFleetStatusEntries(state);
		const workflow = entries.find((entry) => entry.key === "async:workflow-1");
		const child = entries.find((entry) => entry.key === "async:child-review:0");
		assert.equal(child?.parentKey, "async:workflow-1");
		assert.deepEqual(workflow?.workflowRows?.map((row) => row.name), ["worker (worker)"]);
	});

	it("preserves sibling shell rows when a materialized child has nested step identities", () => {
		const state = stateForTest();
		state.asyncJobs.set("workflow-1", {
			asyncId: "workflow-1",
			asyncDir: "/tmp/workflow-1",
			status: "running",
			mode: "workflow",
			startedAt: 10,
			updatedAt: 20,
			steps: [
				{ agent: "reviewer", workflowKey: "a", status: "running" },
				{ agent: "worker", workflowKey: "b", status: "running" },
			],
		});
		state.asyncJobs.set("child-a", {
			asyncId: "child-a",
			asyncDir: "/tmp/child-a",
			status: "running",
			mode: "single",
			parentWorkflowRunId: "workflow-1",
			workflowKey: "a",
			startedAt: 11,
			updatedAt: 20,
			steps: [{ agent: "nested", workflowKey: "b", status: "running" }],
		});

		const entries = collectFleetStatusEntries(state);
		const workflow = entries.find((entry) => entry.key === "async:workflow-1");
		const child = entries.find((entry) => entry.key === "async:child-a:0");
		assert.equal(child?.parentKey, "async:workflow-1");
		assert.deepEqual(workflow?.workflowRows?.map((row) => row.name), ["b (worker)"]);
	});

	it("keeps async workflow children top-level when the parent is missing or terminal", () => {
		const state = stateForTest();
		state.asyncJobs.set("missing-child", {
			asyncId: "missing-child",
			asyncDir: "/tmp/missing-child",
			status: "running",
			mode: "single",
			parentWorkflowRunId: "missing-parent",
			workflowKey: "missing",
			startedAt: 10,
			updatedAt: 20,
			steps: [{ agent: "reviewer", status: "running" }],
		});
		state.asyncJobs.set("terminal-child", {
			asyncId: "terminal-child",
			asyncDir: "/tmp/terminal-child",
			status: "running",
			mode: "single",
			parentWorkflowRunId: "terminal-parent",
			workflowKey: "terminal",
			startedAt: 11,
			updatedAt: 20,
			steps: [{ agent: "worker", status: "running" }],
		});
		state.asyncJobs.set("terminal-parent", {
			asyncId: "terminal-parent",
			asyncDir: "/tmp/terminal-parent",
			status: "complete",
			mode: "workflow",
			startedAt: 12,
			updatedAt: 20,
		});

		const entries = collectFleetStatusEntries(state);
		assert.deepEqual(entries.map((entry) => [entry.key, entry.parentKey]), [
			["async:missing-child:0", undefined],
			["async:terminal-child:0", undefined],
		]);
	});

	it("keeps workflow shell rows when no materialized child is present", () => {
		const state = stateForTest();
		state.asyncJobs.set("workflow-1", {
			asyncId: "workflow-1",
			asyncDir: "/tmp/workflow-1",
			status: "running",
			mode: "workflow",
			startedAt: 10,
			updatedAt: 20,
			steps: [{ agent: "reviewer", workflowKey: "review", runId: "child-review", status: "running" }],
		});

		const workflow = collectFleetStatusEntries(state).find((entry) => entry.key === "async:workflow-1");
		assert.deepEqual(workflow?.workflowRows?.map((row) => row.name), ["review (reviewer)"]);
	});

	it("renders bounded workflow progress rows under the workflow parent", () => {
		const state = stateForTest();
		const workflowJob = {
			asyncId: "workflow-1",
			asyncDir: "/tmp/workflow-1",
			sessionId: "session-current",
			status: "running" as const,
			mode: "workflow" as const,
			startedAt: 10,
			updatedAt: 20,
			steps: [
				{ agent: "scout", workflowKey: "scan", phase: "Plan", label: "Find seams", status: "complete" as const, index: 0, context: "fresh" as const, model: "openai-codex/gpt-5.6-luna", thinking: "max", tokens: { input: 10, output: 5, total: 15 } },
				{ agent: "reviewer", workflowKey: "review", phase: "Review", status: "running" as const, index: 1, context: "fork" as const, currentTool: "grep", tokens: { input: 20, output: 5, total: 25 } },
				{ agent: "tester", workflowKey: "test", phase: "Verify", status: "pending" as const, index: 2 },
			],
		};
		state.asyncJobs.set("workflow-1", workflowJob);
		state.fleetJobs!.set("workflow-1", workflowJob);

		assert.deepEqual(collectFleetStatusEntries(state).map((entry) => entry.key), ["async:workflow-1"]);
		assert.deepEqual(collectFleetSnapshot(state).items.map((item) => item.key), ["async:workflow-1"]);

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
		const fleet = new SubagentFleetStatus(state, () => {}, { refreshMs: 60_000, maxAgentRows: 8 });
		try {
			fleet.setContext(ctx);
			const component = widgetFactory!({ requestRender() {}, focusedComponent: Object.create(Editor.prototype) as Editor }, theme);
			assert.deepEqual(fleet.handleKey("\x1b[B"), { consume: true });
			const lines = component.render(140).join("\n");
			assert.match(lines, /workflow · running/);
			assert.match(lines, /Plan: scan · Find seams \(scout\) \[fresh\] \(gpt-5\.6-luna · thinking max\) · complete/);
			assert.match(lines, /Review: review \(reviewer\) \[fork\] · running · tool grep/);
			assert.match(lines, /Verify: test \(tester\) · pending/);
		} finally {
			fleet.dispose();
		}
	});

	it("renders host CI and gate rows as typed workflow monitors", () => {
		const state = stateForTest();
		const workflowJob = {
			asyncId: "workflow-host",
			asyncDir: "/tmp/workflow-host",
			sessionId: "session-current",
			status: "running" as const,
			mode: "workflow" as const,
			startedAt: 10,
			updatedAt: 20,
			hostSteps: [
				{
					version: 1 as const,
					kind: "host-step" as const,
					monitorKind: "ci" as const,
					id: "ci-check",
					label: "CI checks",
					provider: "github-ci",
					state: "running" as const,
					target: "PR #1614",
					updatedAt: 20,
				},
				{
					version: 1 as const,
					kind: "host-step" as const,
					monitorKind: "gate" as const,
					id: "gate-check",
					label: "Review gate",
					provider: "greptile",
					state: "done" as const,
					verdict: "inconclusive" as const,
					reasonCode: "stale-head",
					freshness: { expectedRef: "old", observedRef: "new", stale: true },
					reportPath: "/tmp/reports/gate.json",
					updatedAt: 20,
				},
			],
		};
		state.asyncJobs.set(workflowJob.asyncId, workflowJob);
		state.fleetJobs!.set(workflowJob.asyncId, workflowJob);

		const workflow = collectFleetStatusEntries(state).find((entry) => entry.key === "async:workflow-host");
		assert.deepEqual(workflow?.workflowRows?.map((row) => ({ kind: row.kind, state: row.state })), [
			{ kind: "ci", state: "running" },
			{ kind: "gate", state: "done" },
		]);

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
		const fleet = new SubagentFleetStatus(state, () => {}, { refreshMs: 60_000, maxAgentRows: 8 });
		try {
			fleet.setContext(ctx);
			const component = widgetFactory!({ requestRender() {}, focusedComponent: Object.create(Editor.prototype) as Editor }, theme);
			assert.deepEqual(fleet.handleKey("\x1b[B"), { consume: true });
			const lines = component.render(160).join("\n");
			assert.match(lines, /ci: CI checks · running · .*provider:github-ci.*PR #1614/);
			assert.match(lines, /gate: Review gate · inconclusive · .*provider:greptile.*stale.*out:gate.json/);
			assert.doesNotMatch(lines, /agent: CI checks/);
		} finally {
			fleet.dispose();
		}
	});

	it("renders recursive nested runs and steps within the existing row budget", () => {
		const state = stateForTest();
		state.asyncJobs.set("supervisor", {
			asyncId: "supervisor",
			asyncDir: "/tmp/supervisor",
			status: "running",
			mode: "single",
			startedAt: 10,
			updatedAt: 20,
			steps: [{ agent: "supervisor", index: 0, status: "running" }],
			nestedChildren: [{
				id: "level-one",
				parentRunId: "supervisor",
				parentStepIndex: 0,
				depth: 1,
				path: [{ runId: "supervisor", stepIndex: 0 }],
				state: "running",
				agent: "level-one",
				children: [{
					id: "level-two",
					parentRunId: "level-one",
					depth: 2,
					path: [{ runId: "supervisor", stepIndex: 0 }, { runId: "level-one" }],
					state: "running",
					mode: "parallel",
					steps: [{
						agent: "level-two",
						status: "running",
						children: [0, 1, 2, 3].map((index) => ({
							id: `leaf-${index}`,
							parentRunId: "level-two",
							depth: 3,
							path: [{ runId: "level-two" }],
							state: "running" as const,
							agent: `leaf-${index}`,
						})),
					}],
				}],
			}],
		});
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
		const fleet = new SubagentFleetStatus(state, () => {}, { refreshMs: 60_000 });
		try {
			fleet.setContext(ctx);
			const component = widgetFactory!({ requestRender() {}, focusedComponent: Object.create(Editor.prototype) as Editor }, theme);
			assert.deepEqual(fleet.handleKey("\x1b[B"), { consume: true });
			const lines = component.render(140).join("\n");
			assert.match(lines, /level-one/);
			assert.match(lines, /level-two/);
			assert.match(lines, /leaf-0/);
			assert.match(lines, /leaf-1/);
			assert.doesNotMatch(lines, /leaf-[23]/);
			assert.match(lines, /\+2 nested leaves/);
		} finally {
			fleet.dispose();
		}
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

	it("hides tracked async task descriptions and shows per-child token totals", () => {
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
				{ agent: "reviewer", index: 0, status: "running", description: "Review only authentication", startedAt: 120, model: "openai/gpt-5", thinking: "medium", tokens: { input: 4_000, output: 200, total: 4_200 } },
				{ agent: "worker", index: 1, status: "running", description: "Implement only billing", startedAt: 121, tokens: { input: 100, output: 20, total: 120 } },
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
			const tui = { requestRender() {}, focusedComponent: Object.create(Editor.prototype) as Editor };
			const component = widgetFactory!(tui, theme);
			assert.deepEqual(fleet.handleKey("\x1b[B"), { consume: true });
			const lines = component.render(180);
			assert.ok(lines.some((line) => line.includes("reviewer (gpt-5 · thinking medium)")));
			assert.ok(lines.some((line) => line.includes("worker")));
			assert.ok(lines.every((line) => !line.includes("Review only authentication") && !line.includes("Implement only billing") && !line.includes("Review the authentication changes")));
			assert.ok(lines.some((line) => line.includes("↓ 4.2k tokens")));
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
		let closeInspector: (() => void) | undefined;
		const ctx = {
			hasUI: true,
			ui: {
				setWidget(_key: string, content: typeof widgetFactory | undefined) { widgetFactory = content; },
				onTerminalInput(handler: typeof inputHandler) { inputHandler = handler; return () => { inputHandler = undefined; }; },
				getEditorText() { return editorText; },
				requestRender() {},
				notify() {},
				theme,
			},
		} as unknown as ExtensionContext;
		const fleet = new SubagentFleetStatus(state, (key) => {
			opened.push(key);
			return new Promise<void>((resolve) => { closeInspector = resolve; });
		}, { refreshMs: 60_000 });
		try {
			fleet.setContext(ctx);
			assert.ok(inputHandler);
			assert.ok(widgetFactory);
			const tui = { requestRender() {}, focusedComponent: Object.create(Editor.prototype) as Editor };
			const component = widgetFactory!(tui, theme);

			assert.equal(inputHandler!("\x1b[B"), undefined, "non-empty editor should retain Down");
			editorText = "";
			tui.focusedComponent = {
				render() { return []; },
				invalidate() {},
				handleInput() {},
			} as unknown as Editor;
			assert.equal(inputHandler!("\x1b[B"), undefined, "non-editor focus should retain Down");

			const crossModuleCustomEditor = {
				render() { return []; },
				invalidate() {},
				handleInput() {},
				getText() { return ""; },
				setText() {},
			} satisfies EditorComponent;
			assert.equal(crossModuleCustomEditor instanceof Editor, false, "regression setup must cross the instanceof boundary");
			tui.focusedComponent = crossModuleCustomEditor as unknown as Editor;
			assert.equal(inputHandler!("j"), undefined, "inactive FleetView should retain printable navigation keys");
			assert.equal(inputHandler!("k"), undefined, "inactive FleetView should retain printable navigation keys");
			assert.equal(component.render(100).length, 1, "inactive FleetView should stay compact");
			assert.deepEqual(inputHandler!("\x1b[B"), { consume: true }, "custom editors should activate FleetView across jiti boundaries");
			assert.ok(component.render(100).length > 1, "keyboard activation should expand the roster");
			assert.deepEqual(inputHandler!("j"), { consume: true }, "active FleetView should navigate down with j");
			assert.ok(component.render(100).some((line) => line.includes("> worker")));
			assert.deepEqual(inputHandler!("k"), { consume: true }, "active FleetView should navigate up with k");
			assert.ok(component.render(100).some((line) => line.includes("> main")));

			tui.focusedComponent = Object.create(Editor.prototype) as Editor;
			assert.deepEqual(inputHandler!("\x1b[B"), { consume: true });
			assert.ok(component.render(100).some((line) => line.includes("> worker")));
			assert.deepEqual(inputHandler!("\r"), { consume: true });
			await Promise.resolve();
			assert.deepEqual(opened, ["foreground-active:run-worker:0"]);
			assert.equal(widgetFactory, undefined, "the widget should unregister while the inspector owns the viewport");

			closeInspector!();
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.ok(widgetFactory, "closing should restore the FleetView widget");
			assert.notEqual(widgetFactory, component, "restoration should install a new component factory");
			const restoredComponent = widgetFactory!(tui, theme);
			assert.ok(restoredComponent.render(100).some((line) => line.includes("> worker")), "closing should restore the prior selected roster row");
			assert.deepEqual(inputHandler!("\x1b"), { consume: true });
			assert.equal(restoredComponent.render(100).length, 1, "Escape should return to the compact summary");
		} finally {
			fleet.dispose();
		}
	});
});
