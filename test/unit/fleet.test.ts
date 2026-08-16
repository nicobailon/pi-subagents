import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { visibleWidth, type MarkdownTheme } from "@earendil-works/pi-tui";
import { EXTERNAL_RUN_REGISTRY_KEY, EXTERNAL_RUN_REGISTRY_VERSION, registerExternalRun } from "../../src/api/external-runs.ts";
import { collectFleetSnapshot, openSubagentFleet, SubagentFleetComponent } from "../../src/tui/fleet.ts";
import { persistForegroundRunHistory, restoreForegroundRunHistory } from "../../src/runs/foreground/foreground-history.ts";
import { FLEET_STATUS_WIDGET_KEY } from "../../src/tui/fleet-status.ts";
import { registerLivePromptAudit, rewritePromptWithGuidance } from "../../src/runs/foreground/prompt-audit.ts";
import { getArtifactPaths, getArtifactsDir, getProjectArtifactsDir } from "../../src/shared/artifacts.ts";
import type { SubagentState } from "../../src/shared/types.ts";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

function clearExternalRuns(): void {
	delete (globalThis as Record<PropertyKey, unknown>)[Symbol.for(EXTERNAL_RUN_REGISTRY_KEY)];
}

function stateForTest(): SubagentState {
	return {
		baseCwd: process.cwd(),
		currentSessionId: "session-current",
		asyncJobs: new Map(),
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

function writeAsyncRun(root: string, input: {
	id: string;
	sessionId?: string;
	state?: "running" | "complete" | "failed";
	mode?: "single" | "parallel" | "workflow";
	lastUpdate?: number;
	agents?: string[];
	contexts?: Array<"fresh" | "fork">;
	models?: string[];
	thinking?: string[];
	output?: string;
	transcript?: Array<Record<string, unknown>>;
}): string {
	const asyncDir = path.join(root, input.id);
	fs.mkdirSync(asyncDir, { recursive: true });
	const agents = input.agents ?? ["worker"];
	if (input.output !== undefined) fs.writeFileSync(path.join(asyncDir, "output-0.log"), input.output, "utf-8");
	const transcriptPath = input.transcript ? path.join(asyncDir, "transcript-0.jsonl") : undefined;
	if (transcriptPath && input.transcript) fs.writeFileSync(transcriptPath, `${input.transcript.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf-8");
	fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
		runId: input.id,
		sessionId: input.sessionId ?? "session-current",
		mode: input.mode ?? (agents.length > 1 ? "parallel" : "single"),
		state: input.state ?? "running",
		startedAt: 100,
		lastUpdate: input.lastUpdate ?? 200,
		currentStep: 0,
		steps: agents.map((agent, index) => ({
			agent,
			...(input.contexts?.[index] ? { context: input.contexts[index] } : {}),
			...(input.models?.[index] ? { model: input.models[index] } : {}),
			...(input.thinking?.[index] ? { thinking: input.thinking[index] } : {}),
			status: input.state === "complete" ? "complete" : input.state === "failed" ? "failed" : index === 0 ? "running" : "pending",
			startedAt: 100,
			...(index === 0 ? { sessionFile: path.join(asyncDir, `${agent}.jsonl`), ...(transcriptPath ? { transcriptPath } : {}) } : {}),
		})),
		...(input.output !== undefined ? { outputFile: "output-0.log" } : {}),
	}, null, 2));
	return asyncDir;
}

const theme = {
	fg: (_name: string, text: string) => text,
	bold: (text: string) => text,
};

const markdownTheme: MarkdownTheme = {
	heading: (text) => text,
	link: (text) => text,
	linkUrl: (text) => text,
	code: (text) => text,
	codeBlock: (text) => text,
	codeBlockBorder: (text) => text,
	quote: (text) => text,
	quoteBorder: (text) => text,
	hr: (text) => text,
	listBullet: (text) => text,
	bold: (text) => text,
	italic: (text) => text,
	strikethrough: (text) => text,
	underline: (text) => text,
};

describe("native subagent fleet", () => {
	it("rewrites an authored prompt from guidance without persistence", async () => {
		const calls: unknown[] = [];
		const streamFn = (_model: never, context: unknown) => {
			calls.push(context);
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => stream.push({ type: "done", reason: "stop", message: fauxAssistantMessage("Rewritten task", { stopReason: "stop" }) }));
			return stream;
		};
		const model = { provider: "faux", id: "rewrite", api: "faux", input: ["text"], reasoning: false, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 100 };
		const ctx = {
			model,
			signal: undefined,
			modelRegistry: {
				async getApiKeyAndHeaders() { return { ok: true as const, apiKey: "test" }; },
				getRegisteredProviderConfig() { return { api: "faux", streamSimple: streamFn }; },
			},
		} as never;
		const rewritten = await rewritePromptWithGuidance({
			ctx,
			authoredTask: "Original task",
			runtimeAdditions: "Runtime context",
			finalEffectivePrompt: "Runtime context\n\nOriginal task",
			guidance: "Make it narrower",
		});
		assert.equal(rewritten, "Rewritten task");
		assert.match(JSON.stringify(calls), /Original task/);
		assert.match(JSON.stringify(calls), /Make it narrower/);
	});

	it("collects current-session foreground and flattened async children", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fleet-collect-"));
		try {
			writeAsyncRun(root, { id: "async-current", agents: ["worker", "reviewer"], output: "CURRENT OUTPUT" });
			writeAsyncRun(root, { id: "async-other", sessionId: "session-other", output: "OTHER OUTPUT" });
			const state = stateForTest();
			state.foregroundControls.set("foreground-live", {
				runId: "foreground-live",
				mode: "chain",
				startedAt: 10,
				updatedAt: 30,
				currentAgent: "scout",
				currentIndex: 1,
			});
			state.foregroundRuns!.set("foreground-recent", {
				runId: "foreground-recent",
				mode: "single",
				cwd: root,
				sessionId: "session-current",
				updatedAt: 20,
				children: [{ agent: "planner", index: 0, status: "completed", finalOutput: "PLAN COMPLETE" }],
			});
			state.foregroundRuns!.set("foreground-other", {
				runId: "foreground-other",
				mode: "single",
				cwd: root,
				sessionId: "session-other",
				updatedAt: 20,
				children: [{ agent: "outsider", index: 0, status: "completed" }],
			});

			const snapshot = collectFleetSnapshot(state, { asyncDirRoot: root, resultsDir: path.join(root, "results") });
			assert.deepEqual(snapshot.items.map((item) => item.key), [
				"foreground-active:foreground-live:1",
				"async:async-current:0",
				"async:async-current:1",
				"foreground-recent:foreground-recent:0",
			]);
			assert.equal(snapshot.error, undefined);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("shows cached external jobs as display-only without reading paths or invoking controls", async () => {
		clearExternalRuns();
		registerExternalRun({
			id: "external-review",
			sessionId: "session-current",
			source: "interactive-shell",
			label: "Dependency review",
			state: "completed",
			startedAt: 100,
			updatedAt: 200,
			currentAction: "Inspecting package metadata",
			preview: "No dependency blockers found.",
			reportPath: "/outside/trusted/roots/report.md",
			transcriptPath: "/outside/trusted/roots/transcript.jsonl",
		});
		const state = stateForTest();
		const snapshot = collectFleetSnapshot(state);
		assert.equal(snapshot.error, undefined);
		assert.deepEqual(snapshot.items.map((item) => ({ key: item.key, kind: item.kind, agent: item.agent })), [{
			key: "external:external-review",
			kind: "external",
			agent: "Dependency review",
		}]);
		let steerCalls = 0;
		let stopCalls = 0;
		let inspectCalls = 0;
		const component = new SubagentFleetComponent(
			{ terminal: { rows: 32, columns: 120 }, requestRender() {} } as never,
			theme as never,
			state,
			() => {},
			{
				refreshMs: 60_000,
				markdownTheme,
				actions: {
					async steer() { steerCalls++; return { text: "unexpected" }; },
					stop() { stopCalls++; return { text: "unexpected" }; },
					async inspect() { inspectCalls++; return { text: "unexpected" }; },
				},
			},
		);
		try {
			const initial = component.render(120).join("\n");
			assert.match(initial, /Fleet inspector.*external display-only/);
			assert.match(initial, /Source: external · display-only/);
			assert.match(initial, /Owner: interactive-shell/);
			assert.match(initial, /Inspecting package metadata/);
			assert.match(initial, /Elapsed: 100ms/);
			assert.match(initial, /No dependency blockers found/);
			assert.match(initial, /Report path: \/outside\/trusted\/roots\/report\.md/);
			assert.match(initial, /Transcript path: \/outside\/trusted\/roots\/transcript\.jsonl/);
			assert.doesNotMatch(initial, /Herdr ·|steer ·|stop ·/);
			component.handleInput("H");
			assert.match(component.render(120).join("\n"), /display-only and have no Herdr controls/);
			component.handleInput("s");
			assert.match(component.render(120).join("\n"), /display-only and remain controlled/);
			component.handleInput("D");
			assert.match(component.render(120).join("\n"), /display-only and remain controlled/);
			await new Promise((resolve) => setImmediate(resolve));
			assert.deepEqual({ steerCalls, stopCalls, inspectCalls }, { steerCalls: 0, stopCalls: 0, inspectCalls: 0 });
		} finally {
			component.dispose();
			clearExternalRuns();
		}
	});

	it("keeps running external elapsed time live when endedAt is present", () => {
		clearExternalRuns();
		try {
			const startedAt = Date.now() - 5_000;
			registerExternalRun({
				id: "external-running",
				sessionId: "session-current",
				source: "interactive-shell",
				label: "Running external job",
				state: "running",
				startedAt,
				updatedAt: startedAt + 100,
				endedAt: startedAt + 100,
			});
			const component = new SubagentFleetComponent(
				{ terminal: { rows: 32, columns: 120 }, requestRender() {} } as never,
				theme as never,
				stateForTest(),
				() => {},
				{ refreshMs: 60_000, markdownTheme },
			);
			try {
				const rendered = component.render(120).join("\n");
				assert.match(rendered, /Elapsed: 5\.0s/);
				assert.doesNotMatch(rendered, /Elapsed: 100ms/);
			} finally {
				component.dispose();
			}
		} finally {
			clearExternalRuns();
		}
	});

	it("ignores malformed cached external jobs while rendering Fleet", () => {
		clearExternalRuns();
		const warnings: string[] = [];
		const originalWarn = console.warn;
		console.warn = (message?: unknown) => warnings.push(String(message));
		(globalThis as Record<PropertyKey, unknown>)[Symbol.for(EXTERNAL_RUN_REGISTRY_KEY)] = {
			version: EXTERNAL_RUN_REGISTRY_VERSION,
			runs: new Map<string, unknown>([[
				"session-current\0bad",
				{ id: "bad", sessionId: "session-current", source: "tool", label: "Bad external", state: "running", startedAt: Number.NaN },
			]]),
		};
		const state = stateForTest();
		const component = new SubagentFleetComponent(
			{ terminal: { rows: 28, columns: 100 }, requestRender() {} } as never,
			theme as never,
			state,
			() => {},
			{ refreshMs: 60_000, markdownTheme },
		);
		try {
			const snapshot = collectFleetSnapshot(state);
			assert.equal(snapshot.error, undefined);
			assert.deepEqual(snapshot.items, []);
			assert.match(warnings[0]!, /Removed Malformed cached external run/);
			assert.match(component.render(100).join("\n"), /No current-session Fleet jobs/);
		} finally {
			console.warn = originalWarn;
			component.dispose();
			clearExternalRuns();
		}
	});

	it("shows live prompt summaries and opens Prompt Audit with the authored prompt visible", async () => {
		const sentinel = "PROMPT_AUDIT_SENTINEL_1021";
		const secondSentinel = "PROMPT_AUDIT_SECOND_CHILD";
		const state = stateForTest();
		const control = {
			runId: "prompt-run",
			sessionId: "session-current",
			mode: "parallel" as const,
			startedAt: 10,
			updatedAt: 20,
			activeChildren: new Map([
				[0, { index: 0, agent: "worker", startedAt: 10, updatedAt: 20 }],
				[1, { index: 1, agent: "reviewer", startedAt: 11, updatedAt: 21 }],
			]),
		};
		state.foregroundControls.set(control.runId, control);
		registerLivePromptAudit(control, 0, sentinel, `[Read from: context.md]\n\n${sentinel}\n\n---\nRuntime acceptance`, { rerun: { params: { agent: "worker", task: sentinel } } });
		registerLivePromptAudit(control, 1, secondSentinel, secondSentinel);
		assert.doesNotMatch(JSON.stringify(control), new RegExp(sentinel), "live prompts must not enter serializable Fleet state");
		const clipboardWrites: string[] = [];
		const redoCalls: Array<{ runId: string; index: number; guidance: string }> = [];
		const component = new SubagentFleetComponent(
			{ terminal: { rows: 28, columns: 100 }, requestRender() {} } as never,
			theme as never,
			state,
			() => {},
			{
				refreshMs: 60_000,
				markdownTheme,
				copyText: (text) => { clipboardWrites.push(text); },
				actions: {
					async steer() { return { text: "unused" }; },
					stop() { return { text: "unused" }; },
					async redoPrompt(input) {
						redoCalls.push(input);
						return { text: "Prompt redo started redo-run." };
					},
				},
			},
		);
		try {
			const initialRender = component.render(100).join("\n");
			assert.match(initialRender, new RegExp(`Task: ${sentinel}`));
			assert.match(initialRender, /Prompt audit: 2 live · 3 views · p opens/);
			component.handleInput("p");
			assert.doesNotMatch(component.render(100).join("\n"), /Prompt text hidden|Enter reveal|r hide/);
			assert.match(component.render(100).join("\n"), new RegExp(sentinel));
			component.handleInput("2");
			assert.match(component.render(100).join("\n"), /Read from: context\.md/);
			component.handleInput("3");
			assert.match(component.render(100).join("\n"), /Runtime acceptance/);
			component.handleInput("c");
			await new Promise((resolve) => setImmediate(resolve));
			assert.deepEqual(clipboardWrites, [`[Read from: context.md]\n\n${sentinel}\n\n---\nRuntime acceptance`]);
			assert.match(component.render(100).join("\n"), /Copied visible prompt view/);
			component.handleInput("g");
			for (const char of "make narrower") component.handleInput(char);
			component.handleInput("\r");
			await new Promise((resolve) => setImmediate(resolve));
			assert.deepEqual(redoCalls, [{ runId: "prompt-run", index: 0, guidance: "make narrower", control }]);
			assert.match(component.render(100).join("\n"), /Prompt redo started redo-run/);
			component.handleInput("j");
			assert.match(component.render(100).join("\n"), /Selected: 2\/2/);
			assert.match(component.render(100).join("\n"), /Agent: reviewer/);
			assert.match(component.render(100).join("\n"), new RegExp(secondSentinel));
			component.handleInput("k");
			component.handleInput("1");
			assert.match(component.render(100).join("\n"), /Selected: 1\/2/);
			assert.match(component.render(100).join("\n"), /Agent: worker/);
			assert.match(component.render(100).join("\n"), new RegExp(sentinel));
			component.handleInput("\x1b");
			assert.match(component.render(100).join("\n"), /Prompt audit: 2 live · 3 views · p opens/);
		} finally {
			component.dispose();
		}
	});

	it("rejects Prompt Audit for a child owned by another session", () => {
		const state = stateForTest();
		const control = {
			runId: "other-run",
			sessionId: "session-other",
			mode: "single" as const,
			startedAt: 10,
			updatedAt: 20,
			activeChildren: new Map([[0, { index: 0, agent: "worker", startedAt: 10, updatedAt: 20 }]]),
		};
		state.foregroundControls.set(control.runId, control);
		registerLivePromptAudit(control, 0, "SECRET", "SECRET");
		const component = new SubagentFleetComponent(
			{ terminal: { rows: 28, columns: 100 }, requestRender() {} } as never,
			theme as never,
			state,
			() => {},
			{ refreshMs: 60_000, markdownTheme },
		);
		try {
			component.handleInput("p");
			const rendered = component.render(100).join("\n");
			assert.match(rendered, /Prompt Audit is available only/);
			assert.doesNotMatch(rendered, /SECRET/);
		} finally {
			component.dispose();
		}
	});

	it("keeps tracked active workflows ahead of older failed terminal history", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fleet-history-"));
		try {
			writeAsyncRun(root, { id: "older-failed", state: "failed", lastUpdate: 100 });
			writeAsyncRun(root, { id: "newer-complete", state: "complete", lastUpdate: 300 });
			const state = stateForTest();
			state.fleetJobs = new Map([["active-workflow", {
				asyncId: "active-workflow",
				asyncDir: path.join(root, "active-workflow"),
				sessionId: "session-current",
				status: "running",
				mode: "workflow",
				agents: ["worker"],
				startedAt: 100,
				updatedAt: 200,
			}]]);

			const snapshot = collectFleetSnapshot(state, { asyncDirRoot: root, resultsDir: path.join(root, "results") });
			assert.deepEqual(snapshot.items.map((item) => item.runId), ["active-workflow", "newer-complete", "older-failed"]);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("bounds Fleet history status-file reads", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fleet-bounded-history-"));
		try {
			for (let index = 0; index < 100; index++) {
				const asyncDir = writeAsyncRun(root, { id: `recent-${index}`, state: "complete", lastUpdate: index });
				fs.utimesSync(path.join(asyncDir, "status.json"), 1_000 + index, 1_000 + index);
			}
			const oldDir = writeAsyncRun(root, { id: "old-invalid", state: "failed", lastUpdate: 0 });
			fs.writeFileSync(path.join(oldDir, "status.json"), "{not-json", "utf8");
			fs.utimesSync(path.join(oldDir, "status.json"), 1, 1);

			const snapshot = collectFleetSnapshot(stateForTest(), { asyncDirRoot: root, resultsDir: path.join(root, "results") });
			assert.equal(snapshot.error, undefined);
			assert.equal(snapshot.items.length, 20);
			assert.ok(!snapshot.items.some((item) => item.runId === "old-invalid"));
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("shows async model and thinking metadata in the structured header", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fleet-model-thinking-"));
		try {
			writeAsyncRun(root, {
				id: "model-thinking",
				state: "running",
				models: ["openai-codex/gpt-5.5"],
				thinking: ["high"],
			});
			const component = new SubagentFleetComponent(
				{ terminal: { rows: 32, columns: 100 }, requestRender() {} } as never,
				theme as never,
				stateForTest(),
				() => {},
				{ asyncDirRoot: root, resultsDir: path.join(root, "results"), refreshMs: 60_000, markdownTheme },
			);
			try {
				assert.ok(component.render(100).some((line) => line.includes("gpt-5.5 · thinking high")));
			} finally {
				component.dispose();
			}
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("shows a scripted workflow as one fleet parent instead of unrelated children", () => {
		const state = stateForTest();
		state.fleetJobs = new Map([["workflow-1", {
			asyncId: "workflow-1",
			asyncDir: path.join(os.tmpdir(), "workflow-1"),
			sessionId: "session-current",
			status: "running",
			mode: "workflow",
			agents: ["scan", "review"],
			steps: [
				{ agent: "scan", workflowKey: "scan", status: "completed", index: 0 },
				{ agent: "review", workflowKey: "review", status: "running", index: 1 },
			],
			workflow: { trace: [], emits: ["reviewing"], console: [] },
			startedAt: 10,
			updatedAt: 20,
		}]]);

		const snapshot = collectFleetSnapshot(state);
		assert.deepEqual(snapshot.items.map((item) => item.key), ["async:workflow-1"]);
		assert.equal(snapshot.items[0]?.agent, "workflow");
	});

	it("hides workflow-owned foreground duplicates and opens the workflow parent inspector", async () => {
		const state = stateForTest();
		state.asyncJobs.set("workflow-1", {
			asyncId: "workflow-1",
			asyncDir: "/tmp/workflow-1",
			sessionId: "session-current",
			status: "running",
			mode: "workflow",
			startedAt: 10,
			updatedAt: 20,
		});
		state.asyncJobs.set("unrelated", {
			asyncId: "unrelated",
			asyncDir: "/tmp/unrelated",
			sessionId: "session-current",
			status: "running",
			mode: "single",
			startedAt: 5,
			updatedAt: 30,
		});
		state.foregroundControls.set("child-1", {
			runId: "child-1",
			parentWorkflowRunId: "workflow-1",
			workflowKey: "review",
			mode: "single",
			startedAt: 10,
			updatedAt: 20,
			activeChildren: new Map([[0, { index: 0, agent: "reviewer", startedAt: 10, updatedAt: 20 }]]),
		});
		const snapshot = collectFleetSnapshot(state);
		assert.deepEqual(snapshot.items.map((item) => item.key), ["async:unrelated", "async:workflow-1"]);
		const calls: Array<{ runId: string; asyncDir: string; index?: number }> = [];
		const component = new SubagentFleetComponent(
			{ terminal: { rows: 28, columns: 100 }, requestRender() {} } as never,
			theme as never,
			state,
			() => {},
			{
				initialKey: "foreground-active:child-1:0",
				refreshMs: 60_000,
				actions: {
					async steer() { return { text: "unused" }; },
					stop() { return { text: "unused" }; },
					async inspect(input) { calls.push(input); return { text: "Inspector opened." }; },
				},
			},
		);
		try {
			assert.ok(component.render(100).some((line) => line.includes("workflow")));
			component.handleInput("H");
			await new Promise((resolve) => setImmediate(resolve));
			assert.deepEqual(calls, [{ runId: "workflow-1", asyncDir: "/tmp/workflow-1" }]);
		} finally {
			component.dispose();
		}
	});

	it("keeps every active async run ahead of the bounded recent-completion window", () => {
		const state = stateForTest();
		for (let index = 0; index < 22; index++) {
			state.fleetJobs ??= new Map();
			state.fleetJobs.set(`terminal-${index}`, {
				asyncId: `terminal-${index}`,
				asyncDir: path.join(os.tmpdir(), `missing-terminal-${index}`),
				sessionId: "session-current",
				status: "complete",
				mode: "single",
				agents: ["worker"],
				startedAt: index,
				updatedAt: index,
			});
		}
		state.fleetJobs!.set("active-old", {
			asyncId: "active-old",
			asyncDir: path.join(os.tmpdir(), "missing-active-old"),
			sessionId: "session-current",
			status: "running",
			mode: "single",
			agents: ["scout"],
			startedAt: 0,
			updatedAt: 0,
		});

		const snapshot = collectFleetSnapshot(state);
		assert.equal(snapshot.items.length, 21);
		assert.equal(snapshot.items[0]?.runId, "active-old");
		assert.equal(snapshot.items.find((item) => item.runId === "terminal-21")?.state, "complete");
		assert.ok(!snapshot.items.some((item) => item.runId === "terminal-0"));
	});

	it("accepts default Fleet navigation from Kitty CSI-u input", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fleet-kitty-default-"));
		try {
			writeAsyncRun(root, { id: "newer", lastUpdate: 300 });
			writeAsyncRun(root, { id: "older", lastUpdate: 200 });
			const component = new SubagentFleetComponent(
				{ terminal: { rows: 28, columns: 100 }, requestRender() {} } as never,
				theme as never,
				stateForTest(),
				() => {},
				{ asyncDirRoot: root, resultsDir: path.join(root, "results"), refreshMs: 60_000 },
			);
			try {
				const selectedLine = () => component.render(100).find((line) => line.includes("›")) ?? "";
				assert.match(selectedLine(), /newer/);
				component.handleInput("\x1b[106;1u");
				assert.match(selectedLine(), /older/);
			} finally {
				component.dispose();
			}
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("uses custom Fleet keybindings without applying them inside modal text input", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fleet-custom-keys-"));
		try {
			writeAsyncRun(root, { id: "newer", lastUpdate: 300 });
			writeAsyncRun(root, { id: "older", lastUpdate: 200 });
			const state = stateForTest();
			let closed = false;
			const component = new SubagentFleetComponent(
				{ terminal: { rows: 28, columns: 100 }, requestRender() {} } as never,
				theme as never,
				state,
				() => { closed = true; },
				{
					asyncDirRoot: root,
					resultsDir: path.join(root, "results"),
					refreshMs: 60_000,
					fleetKeybindings: {
						selectDown: ["n"],
						selectUp: ["p"],
						steer: ["m"],
						close: ["z"],
					},
					actions: {
						async steer() { return { text: "unused" }; },
						stop() { return { text: "unused" }; },
					},
				},
			);
			try {
				const selectedLine = () => component.render(100).find((line) => line.includes("›")) ?? "";
				assert.match(selectedLine(), /newer/);
				component.handleInput("j");
				assert.match(selectedLine(), /newer/, "default j should not move when selectDown is overridden");
				component.handleInput("\x1b[110;1u");
				assert.match(selectedLine(), /older/, "custom selectDown should accept Kitty CSI-u input");
				component.handleInput("p");
				assert.match(selectedLine(), /newer/);
				component.handleInput("m");
				component.handleInput("m");
				assert.ok(component.render(100).some((line) => line.includes("Steer message (steer): m")));
				component.handleInput("\x1b");
				component.handleInput("z");
				assert.equal(closed, true);
			} finally {
				component.dispose();
			}
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("restores current-session completed foreground history from the compact index", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fleet-foreground-history-"));
		try {
			const resultsDir = path.join(root, "results");
			const cwd = path.join(root, "project");
			const artifactsRoot = getProjectArtifactsDir(cwd);
			fs.mkdirSync(artifactsRoot, { recursive: true });
			const outputPath = path.join(artifactsRoot, "outputs", "restored", "output.md");
			fs.mkdirSync(path.dirname(outputPath), { recursive: true });
			fs.writeFileSync(outputPath, "restored foreground output", "utf-8");

			const state = stateForTest();
			state.artifactDirPreference = "project";
			state.foregroundRuns!.set("restored", {
				runId: "restored",
				mode: "single",
				cwd,
				sessionId: "session-current",
				updatedAt: 200,
				children: [{ agent: "worker", index: 0, status: "completed", finalOutput: "do not persist this when an artifact exists", savedOutputPath: outputPath }],
			});
			state.foregroundRuns!.set("other-session", {
				runId: "other-session",
				mode: "single",
				cwd,
				sessionId: "session-other",
				updatedAt: 300,
				children: [{ agent: "outsider", index: 0, status: "completed", savedOutputPath: outputPath }],
			});
			persistForegroundRunHistory(state, { resultsDir });

			const restored = stateForTest();
			restored.baseCwd = cwd;
			restored.artifactDirPreference = "project";
			assert.equal(restoreForegroundRunHistory(restored, { resultsDir }), 1);
			const snapshot = collectFleetSnapshot(restored);
			assert.deepEqual(snapshot.items.map((item) => item.key), ["foreground-recent:restored:0"]);

			const component = new SubagentFleetComponent(
				{ terminal: { rows: 28, columns: 100 }, requestRender() {} } as never,
				theme as never,
				restored,
				() => {},
				{ refreshMs: 60_000 },
			);
			try {
				const lines = component.render(100);
				assert.ok(lines.some((line) => line.includes("restored foreground output")));
				assert.ok(!lines.some((line) => line.includes("do not persist")));
			} finally {
				component.dispose();
			}
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("does not restore nonterminal foreground history rows", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fleet-foreground-terminal-"));
		try {
			const resultsDir = path.join(root, "results");
			fs.mkdirSync(resultsDir, { recursive: true });
			fs.writeFileSync(path.join(resultsDir, "foreground-history.json"), JSON.stringify({
				version: 1,
				runs: [
					{
						runId: "stale-running",
						mode: "single",
						cwd: root,
						sessionId: "session-current",
						updatedAt: 300,
						children: [{ agent: "worker", index: 0, status: "running", currentTool: "bash" }],
					},
					{
						runId: "terminal",
						mode: "single",
						cwd: root,
						sessionId: "session-current",
						updatedAt: 200,
						children: [{ agent: "reviewer", index: 0, status: "completed", finalOutput: "done" }],
					},
				],
			}, null, 2), "utf-8");

			const restored = stateForTest();
			restored.baseCwd = root;
			assert.equal(restoreForegroundRunHistory(restored, { resultsDir }), 1);
			assert.deepEqual([...restored.foregroundRuns!.keys()], ["terminal"]);
			assert.deepEqual(collectFleetSnapshot(restored).items.map((item) => item.key), ["foreground-recent:terminal:0"]);

			const state = stateForTest();
			state.foregroundRuns!.set("stale-running", {
				runId: "stale-running",
				mode: "single",
				cwd: root,
				sessionId: "session-current",
				updatedAt: 400,
				children: [{ agent: "worker", index: 0, status: "running" as never }],
			});
			persistForegroundRunHistory(state, { resultsDir });
			const persisted = JSON.parse(fs.readFileSync(path.join(resultsDir, "foreground-history.json"), "utf-8")) as { runs: Array<{ runId: string }> };
			assert.deepEqual(persisted.runs.map((run) => run.runId), ["terminal"]);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("keeps restored foreground rows when output artifacts are unavailable and bounds history", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fleet-foreground-missing-"));
		try {
			const resultsDir = path.join(root, "results");
			const cwd = path.join(root, "project");
			const artifactsRoot = getProjectArtifactsDir(cwd);
			const state = stateForTest();
			state.artifactDirPreference = "project";
			for (let index = 0; index < 3; index++) {
				const outputPath = path.join(artifactsRoot, "outputs", `run-${index}`, "output.md");
				fs.mkdirSync(path.dirname(outputPath), { recursive: true });
				fs.writeFileSync(outputPath, `output ${index}`, "utf-8");
				state.foregroundRuns!.set(`run-${index}`, {
					runId: `run-${index}`,
					mode: "single",
					cwd,
					sessionId: "session-current",
					updatedAt: index,
					children: [{ agent: "worker", index: 0, status: "completed", savedOutputPath: outputPath }],
				});
			}
			persistForegroundRunHistory(state, { resultsDir, limit: 2 });
			fs.rmSync(path.join(artifactsRoot, "outputs", "run-2", "output.md"), { force: true });

			const restored = stateForTest();
			restored.baseCwd = cwd;
			restored.artifactDirPreference = "project";
			assert.equal(restoreForegroundRunHistory(restored, { resultsDir, limit: 2 }), 2);
			assert.deepEqual([...restored.foregroundRuns!.keys()], ["run-2", "run-1"]);

			const component = new SubagentFleetComponent(
				{ terminal: { rows: 28, columns: 100 }, requestRender() {} } as never,
				theme as never,
				restored,
				() => {},
				{ initialKey: "foreground-recent:run-2:0", refreshMs: 60_000 },
			);
			try {
				assert.ok(component.render(100).some((line) => line.includes("output artifact unavailable")));
			} finally {
				component.dispose();
			}
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("uses the full 85% terminal-height budget for the inspector", () => {
		const component = new SubagentFleetComponent(
			{ terminal: { rows: 60, columns: 100 }, requestRender() {} } as never,
			theme as never,
			stateForTest(),
			() => {},
			{ refreshMs: 60_000 },
		);
		try {
			assert.equal(component.render(100).length, 51);
		} finally {
			component.dispose();
		}
	});

	it("renders selectable transcript detail and completed artifact paths within terminal width", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fleet-render-"));
		try {
			const asyncDir = writeAsyncRun(root, { id: "async-finished", state: "complete", contexts: ["fork"], output: "FINAL ASYNC OUTPUT" });
			const state = stateForTest();
			let closed = false;
			let renderRequests = 0;
			const tui = { terminal: { rows: 32, columns: 100 }, requestRender: () => { renderRequests++; } };
			const component = new SubagentFleetComponent(
				tui as never,
				theme as never,
				state,
				() => { closed = true; },
				{ asyncDirRoot: root, resultsDir: path.join(root, "results"), refreshMs: 60_000 },
			);
			try {
				const lines = component.render(100);
				assert.ok(lines.some((line) => line.includes("FINAL ASYNC OUTPUT")));
				assert.ok(lines.some((line) => line.includes("output-0.log")));
				assert.ok(lines.some((line) => line.includes("worker") && line.includes("[fork]")));
				assert.ok(lines.some((line) => line.includes("worker.jsonl")));
				for (const line of lines) assert.ok(visibleWidth(line) <= 100, `line exceeded width: ${line}`);
				tui.terminal.rows = 10;
				assert.ok(component.render(100).length <= 8, "short-terminal render should fit the overlay's 85% height cap");
				component.handleInput("\x1b[6~");
				component.handleInput("r");
				assert.ok(renderRequests >= 2);
				component.handleInput("\x1b");
				assert.equal(closed, true);
			} finally {
				component.dispose();
			}
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("passes current-session trusted roots to async session transcript fallback", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fleet-session-fallback-"));
		try {
			const asyncDir = writeAsyncRun(root, { id: "async-session-fallback" });
			const sessionFile = path.join(asyncDir, "worker.jsonl");
			fs.writeFileSync(sessionFile, `${JSON.stringify({ role: "assistant", content: "TRUSTED SESSION FALLBACK" })}\n`, "utf-8");
			const state = stateForTest();
			state.trustedSessionRoots = [asyncDir];
			const component = new SubagentFleetComponent(
				{ terminal: { rows: 32, columns: 100 }, requestRender() {} } as never,
				theme as never,
				state,
				() => {},
				{ asyncDirRoot: root, resultsDir: path.join(root, "results"), refreshMs: 60_000 },
			);
			try {
				const rendered = component.render(100).join("\n");
				assert.match(rendered, /TRUSTED SESSION FALLBACK/);
				assert.doesNotMatch(rendered, /without a trusted root|Session read failed/);
			} finally {
				component.dispose();
			}
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("renders structured tool activity and assistant Markdown when a child transcript is available", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fleet-structured-"));
		try {
			const longResponse = `## Finding\n\n${Array.from({ length: 40 }, (_, index) => `detail ${index}`).join("\n")}\n\n\`\`\`ts\nconst fleet = true;\n\`\`\``;
			writeAsyncRun(root, {
				id: "async-structured",
				state: "complete",
				output: "RAW FALLBACK SHOULD NOT RENDER",
				transcript: [
					{ recordType: "message", sourceEventType: "initial_prompt", role: "user", text: "injected task" },
					{ recordType: "tool_start", toolName: "read", argsPreview: "src/tui/fleet.ts" },
					{ recordType: "tool_end", toolName: "read" },
					{ recordType: "message", role: "toolResult", text: "very large tool payload", message: { toolName: "read", isError: false } },
					{ recordType: "message", role: "assistant", model: "test-model", text: longResponse },
				],
			});
			const state = stateForTest();
			state.baseCwd = root;
			const component = new SubagentFleetComponent(
				{ terminal: { rows: 32, columns: 100 }, requestRender() {} } as never,
				theme as never,
				state,
				() => {},
				{ asyncDirRoot: root, resultsDir: path.join(root, "results"), refreshMs: 60_000, markdownTheme },
			);
			try {
				let lines = component.render(100);
				assert.ok(lines.some((line) => line.includes("Conversation") && line.includes("assistant response")));
				assert.ok(lines.some((line) => line.includes("const fleet = true;")));
				assert.ok(!lines.some((line) => line.includes("very large tool payload")));
				assert.ok(!lines.some((line) => line.includes("RAW FALLBACK SHOULD NOT RENDER")));
				const bottomLines = lines;
				const realDateNow = Date.now;
				const laterNow = realDateNow() + 2_000;
				Date.now = () => laterNow;
				try {
					component.handleInput("K");
					lines = component.render(100);
					assert.notDeepEqual(lines, bottomLines, "Shift+K should scroll the conversation up by one line");
					component.handleInput("J");
					lines = component.render(100);
					assert.deepEqual(lines, bottomLines, "Shift+J should scroll the conversation back down by one line");
				} finally {
					Date.now = realDateNow;
				}
				for (let page = 0; page < 4; page++) component.handleInput("\x1b[5~");
				lines = component.render(100);
				assert.ok(lines.some((line) => line.includes("Conversation") && line.includes("assistant response")), "the conversation header should remain pinned while scrolling");
				assert.ok(lines.some((line) => line.includes("✓ read") && line.includes("src/tui/fleet.ts")), "page up should reveal compact tool activity");
				assert.ok(lines.some((line) => line.includes("Assistant") && line.includes("test-model")), "page up should reveal the rendered assistant message header");
				for (const renderWidth of [60, 80, 100]) {
					for (const line of component.render(renderWidth)) {
						assert.ok(visibleWidth(line) <= renderWidth, `line exceeded ${renderWidth} columns: ${line}`);
					}
				}
			} finally {
				component.dispose();
			}
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("uses parent-tracked async state and cwd without rescanning status", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fleet-async-cwd-"));
		try {
			const asyncDir = path.join(root, "async-custom-cwd");
			const customCwd = path.join(root, "custom-cwd");
			const artifactsRoot = getProjectArtifactsDir(customCwd);
			fs.mkdirSync(asyncDir, { recursive: true });
			fs.mkdirSync(artifactsRoot, { recursive: true });
			const transcriptPath = path.join(artifactsRoot, "async-custom-cwd_worker_transcript.jsonl");
			fs.writeFileSync(transcriptPath, `${JSON.stringify({ recordType: "message", role: "assistant", text: "Custom cwd async result" })}\n`, "utf-8");
			fs.writeFileSync(path.join(asyncDir, "status.json"), "{in-flight status", "utf-8");
			const state = stateForTest();
			state.baseCwd = path.join(root, "parent-cwd");
			state.artifactDirPreference = "project";
			state.asyncJobs.set("async-custom-cwd", {
				asyncId: "async-custom-cwd",
				asyncDir,
				cwd: customCwd,
				sessionId: "session-current",
				status: "running",
				mode: "single",
				startedAt: 100,
				updatedAt: 200,
				steps: [{ agent: "worker", index: 0, status: "running", transcriptPath }],
			});
			const component = new SubagentFleetComponent(
				{ terminal: { rows: 28, columns: 100 }, requestRender() {} } as never,
				theme as never,
				state,
				() => {},
				{ refreshMs: 60_000, markdownTheme },
			);
			try {
				assert.ok(component.render(100).some((line) => line.includes("Custom cwd async result")));
			} finally {
				component.dispose();
			}
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("toggles bounded tool output expansion with x and Ctrl+O", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fleet-tool-toggle-"));
		try {
			writeAsyncRun(root, {
				id: "async-tools",
				state: "complete",
				transcript: [
					{ recordType: "tool_start", toolCallId: "read-1", toolName: "read", argsPreview: "src/a.ts", argsPayload: JSON.stringify({ path: "src/a.ts" }), ts: 1 },
					{ recordType: "tool_end", toolCallId: "read-1", toolName: "read", ts: 2 },
					{ recordType: "message", role: "toolResult", toolCallId: "read-1", toolName: "read", text: "alpha\nbeta\ngamma", isError: false, ts: 3 },
				],
			});
			const state = stateForTest();
			state.baseCwd = root;
			let renderRequests = 0;
			const component = new SubagentFleetComponent(
				{ terminal: { rows: 32, columns: 100 }, requestRender() { renderRequests++; } } as never,
				theme as never,
				state,
				() => {},
				{ asyncDirRoot: root, resultsDir: path.join(root, "results"), refreshMs: 60_000, markdownTheme },
			);
			try {
				let lines = component.render(100);
				assert.ok(lines.some((line) => line.includes("alpha beta gamma") && line.includes("x to expand")));
				component.handleInput("x");
				lines = component.render(100);
				assert.ok(lines.some((line) => line.includes("alpha") && !line.includes("beta")));
				assert.ok(lines.some((line) => line.includes("x to collapse")));
				component.handleInput("\x0f");
				lines = component.render(100);
				assert.ok(lines.some((line) => line.includes("alpha beta gamma") && line.includes("x to expand")));
				fs.appendFileSync(
					path.join(root, "async-tools", "transcript-0.jsonl"),
					`${JSON.stringify({ recordType: "message", role: "assistant", text: "Cache refreshed after append", ts: 4 })}\n`,
					"utf-8",
				);
				lines = component.render(100);
				assert.ok(lines.some((line) => line.includes("Cache refreshed after append")));
				assert.equal(renderRequests, 2);
			} finally {
				component.dispose();
			}
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("renders the selected foreground parallel child's structured transcript", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fleet-foreground-"));
		try {
			const state = stateForTest();
			state.baseCwd = path.join(root, "parent-cwd");
			state.artifactDirPreference = "project";
			const effectiveCwd = path.join(root, "effective-cwd");
			const now = Date.now();
			state.foregroundControls.set("foreground-live", {
				runId: "foreground-live",
				mode: "parallel",
				startedAt: now - 1_000,
				updatedAt: now,
				cwd: effectiveCwd,
				currentAgent: "reviewer",
				currentIndex: 1,
				description: "Review the active task",
				activeChildren: new Map([
					[0, { index: 0, agent: "worker", description: "Implement the active task", startedAt: now - 900, updatedAt: now - 100, tokens: 120, model: "provider/live-model", thinking: "high" }],
					[1, { index: 1, agent: "reviewer", description: "Review the active task", startedAt: now - 800, updatedAt: now, tokens: 240 }],
				]),
			});
			const artifactsRoot = getProjectArtifactsDir(effectiveCwd);
			fs.mkdirSync(artifactsRoot, { recursive: true });
			const transcriptPath = getArtifactPaths(artifactsRoot, "foreground-live", "worker", 0).transcriptPath;
			fs.writeFileSync(transcriptPath, `${JSON.stringify({ recordType: "message", role: "assistant", model: "test-model", text: "**Worker live result**" })}\n`, "utf-8");
			const component = new SubagentFleetComponent(
				{ terminal: { rows: 28, columns: 90 }, requestRender() {} } as never,
				theme as never,
				state,
				() => {},
				{ initialKey: "foreground-active:foreground-live:0", refreshMs: 60_000, markdownTheme },
			);
			try {
				const lines = component.render(90);
				assert.ok(lines.some((line) => line.includes("worker")));
				assert.ok(lines.some((line) => line.includes("reviewer")));
				assert.ok(lines.some((line) => line.includes("foreground · live")));
				assert.ok(lines.some((line) => line.includes("live-model · thinking high")));
				assert.ok(lines.every((line) => !line.includes("Implement the active task") && !line.includes("Review the active task")));
				assert.ok(lines.some((line) => line.includes("Conversation") && line.includes("assistant response")));
				assert.ok(lines.some((line) => line.includes("Worker live result")));
			} finally {
				component.dispose();
			}
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("renders configured session and temp transcripts for active foreground, completed foreground, and async children", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fleet-artifact-roots-"));
		const createdTranscriptPaths: string[] = [];
		try {
			for (const preference of ["session", "temp"] as const) {
				const baseCwd = path.join(root, `${preference}-cwd`);
				const sessionFile = path.join(root, `${preference}-session`, "session.jsonl");
				const artifactsRoot = getArtifactsDir(sessionFile, baseCwd, preference);
				const prefix = `${path.basename(root)}-${preference}`;
				fs.mkdirSync(artifactsRoot, { recursive: true });
				const transcript = (runId: string, agent: string, index: number, text: string) => {
					const transcriptPath = getArtifactPaths(artifactsRoot, runId, agent, index).transcriptPath;
					fs.writeFileSync(transcriptPath, `${JSON.stringify({ recordType: "message", role: "assistant", text })}\n`, "utf-8");
					createdTranscriptPaths.push(transcriptPath);
					return transcriptPath;
				};

				const activeId = `${prefix}-active`;
				const recentId = `${prefix}-recent`;
				const asyncId = `${prefix}-async`;
				transcript(activeId, "worker", 0, `${preference} active foreground transcript`);
				const recentTranscript = transcript(recentId, "reviewer", 0, `${preference} completed foreground transcript`);
				const asyncTranscript = transcript(asyncId, "scout", 0, `${preference} async transcript`);

				const state = stateForTest();
				state.baseCwd = baseCwd;
				state.artifactDirPreference = preference;
				state.parentSessionFile = sessionFile;
				state.foregroundControls.set(activeId, {
					runId: activeId,
					mode: "single",
					cwd: baseCwd,
					startedAt: 100,
					updatedAt: 300,
					currentAgent: "worker",
					currentIndex: 0,
				});
				state.foregroundRuns!.set(recentId, {
					runId: recentId,
					mode: "single",
					cwd: baseCwd,
					sessionId: "session-current",
					updatedAt: 200,
					children: [{ agent: "reviewer", index: 0, status: "completed", transcriptPath: recentTranscript, model: "provider/recent-model", thinking: "xhigh" }],
				});
				state.asyncJobs.set(asyncId, {
					asyncId,
					asyncDir: path.join(root, `${preference}-async-run`),
					cwd: baseCwd,
					sessionId: "session-current",
					status: "complete",
					mode: "single",
					startedAt: 100,
					updatedAt: 250,
					steps: [{ agent: "scout", index: 0, status: "complete", transcriptPath: asyncTranscript }],
				});

				for (const [initialKey, expected] of [
					[`foreground-active:${activeId}:0`, `${preference} active foreground transcript`],
					[`foreground-recent:${recentId}:0`, `${preference} completed foreground transcript`],
					[`async:${asyncId}:0`, `${preference} async transcript`],
				] as const) {
					const component = new SubagentFleetComponent(
						{ terminal: { rows: 28, columns: 100 }, requestRender() {} } as never,
						theme as never,
						state,
						() => {},
						{ initialKey, refreshMs: 60_000, markdownTheme },
					);
					try {
						const lines = component.render(100);
						assert.ok(lines.some((line) => line.includes(expected)), `missing ${expected}`);
						if (initialKey.startsWith("foreground-recent:")) {
							assert.ok(lines.some((line) => line.includes("recent-model · thinking xhigh")));
						}
					} finally {
						component.dispose();
					}
				}
			}
		} finally {
			for (const transcriptPath of createdTranscriptPaths) fs.rmSync(transcriptPath, { force: true });
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("shows disk-only current-session async runs when the overlay opens", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fleet-overlay-reconcile-"));
		try {
			writeAsyncRun(root, { id: "disk-only", agents: ["worker"] });
			const state = stateForTest();
			let rendered = "";
			const ctx = {
				hasUI: true,
				ui: {
					setWidget() {},
					async custom(factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (result: undefined) => void) => SubagentFleetComponent) {
						const component = factory({ terminal: { rows: 32 }, requestRender() {} }, theme, undefined, () => {});
						try {
							rendered = component.render(100).join("\n");
						} finally {
							component.dispose();
						}
					},
				},
			};

			await openSubagentFleet(ctx as never, state, { asyncDirRoot: root, resultsDir: path.join(root, "results") });
			assert.match(rendered, /worker/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("suppresses the status widget for the full inspector lifecycle", async () => {
		const state = stateForTest();
		let hidden = 0;
		let observedOpen = false;
		const ctx = {
			hasUI: true,
			ui: {
				setWidget(key: string, content: unknown) {
					assert.equal(key, FLEET_STATUS_WIDGET_KEY);
					assert.equal(content, undefined);
					hidden++;
				},
				async custom() {
					observedOpen = state.fleetInspectorOpen === true;
					throw new Error("overlay closed");
				},
			},
		};

		await assert.rejects(openSubagentFleet(ctx as never, state), /overlay closed/);
		assert.equal(hidden, 1);
		assert.equal(observedOpen, true);
		assert.equal(state.fleetInspectorOpen, false);
	});

	it("focuses the selected child and renders raw foreground model details", () => {
		const state = stateForTest();
		state.foregroundControls.set("run-worker", {
			runId: "run-worker",
			mode: "single",
			startedAt: 10,
			updatedAt: 20,
			currentAgent: "worker",
			currentIndex: 0,
			model: "provider/raw-model",
			thinking: "medium",
		});
		state.foregroundControls.set("run-reviewer", {
			runId: "run-reviewer",
			mode: "single",
			startedAt: 11,
			updatedAt: 21,
			currentAgent: "reviewer",
			currentIndex: 0,
		});
		state.foregroundRuns!.set("run-recent", {
			runId: "run-recent",
			mode: "single",
			cwd: process.cwd(),
			sessionId: "session-current",
			updatedAt: 19,
			children: [{ agent: "reviewer", index: 0, status: "completed", model: "provider/recent-raw-model", thinking: "xhigh" }],
		});
		const component = new SubagentFleetComponent(
			{ terminal: { rows: 28, columns: 90 }, requestRender() {} } as never,
			theme as never,
			state,
			() => {},
			{ initialKey: "foreground-active:run-worker:0", refreshMs: 60_000 },
		);
		try {
			const lines = component.render(90);
			const selectedLine = lines.find((line) => line.includes("›"));
			assert.ok(selectedLine?.includes("run-work"), `unexpected selected row: ${selectedLine}`);
			assert.ok(lines.some((line) => line.includes("Model: raw-model · thinking medium")));
		} finally {
			component.dispose();
		}

		const recentComponent = new SubagentFleetComponent(
			{ terminal: { rows: 28, columns: 90 }, requestRender() {} } as never,
			theme as never,
			state,
			() => {},
			{ initialKey: "foreground-recent:run-recent:0", refreshMs: 60_000 },
		);
		try {
			assert.ok(recentComponent.render(90).some((line) => line.includes("Model: recent-raw-model · thinking xhigh")));
		} finally {
			recentComponent.dispose();
		}
	});

	it("steers the selected async child with an inline message", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fleet-steer-"));
		try {
			const asyncDir = writeAsyncRun(root, { id: "async-steer", agents: ["worker", "reviewer"] });
			const state = stateForTest();
			const calls: Array<{ runId: string; asyncDir: string; index?: number; message: string; mode: string }> = [];
			const component = new SubagentFleetComponent(
				{ terminal: { rows: 28, columns: 100 }, requestRender() {} } as never,
				theme as never,
				state,
				() => {},
				{
					asyncDirRoot: root,
					resultsDir: path.join(root, "results"),
					initialKey: "async:async-steer:0",
					refreshMs: 60_000,
					actions: {
						async steer(input) {
							calls.push(input);
							return { text: "Steering queued." };
						},
						stop() {
							return { text: "unused" };
						},
					},
				},
			);
			try {
				component.handleInput("s");
				assert.ok(component.render(100).some((line) => line.includes("Steer message (steer):")));
				component.handleInput("\t");
				assert.ok(component.render(100).some((line) => line.includes("Steer message (follow_up):")));
				for (const char of "please continue") component.handleInput(char);
				component.handleInput("\r");
				await new Promise((resolve) => setImmediate(resolve));
				assert.deepEqual(calls, [{ runId: "async-steer", asyncDir, index: 0, message: "please continue", mode: "follow_up" }]);
				assert.ok(component.render(100).some((line) => line.includes("Steering queued.")));
			} finally {
				component.dispose();
			}
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("opens the selected async child in a Herdr inspector", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fleet-herdr-"));
		try {
			const asyncDir = writeAsyncRun(root, { id: "async-herdr" });
			const calls: Array<{ runId: string; asyncDir: string; index?: number }> = [];
			const component = new SubagentFleetComponent(
				{ terminal: { rows: 28, columns: 100 }, requestRender() {} } as never,
				theme as never,
				stateForTest(),
				() => {},
				{
					asyncDirRoot: root,
					resultsDir: path.join(root, "results"),
					refreshMs: 60_000,
					actions: {
						async steer() { return { text: "unused" }; },
						stop() { return { text: "unused" }; },
						async inspect(input) { calls.push(input); return { text: "Inspector opened." }; },
					},
				},
			);
			try {
				component.handleInput("H");
				await new Promise((resolve) => setImmediate(resolve));
				assert.deepEqual(calls, [{ runId: "async-herdr", asyncDir, index: 0 }]);
				assert.ok(component.render(100).some((line) => line.includes("Inspector opened.")));
			} finally {
				component.dispose();
			}
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("confirms stop for the selected async child before calling the action", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fleet-stop-"));
		try {
			const asyncDir = writeAsyncRun(root, { id: "async-stop" });
			const state = stateForTest();
			const calls: Array<{ runId: string; asyncDir: string; index?: number }> = [];
			const component = new SubagentFleetComponent(
				{ terminal: { rows: 28, columns: 100 }, requestRender() {} } as never,
				theme as never,
				state,
				() => {},
				{
					asyncDirRoot: root,
					resultsDir: path.join(root, "results"),
					refreshMs: 60_000,
					actions: {
						async steer() {
							return { text: "unused" };
						},
						stop(input) {
							calls.push(input);
							return { text: "Stop requested." };
						},
					},
				},
			);
			try {
				component.handleInput("D");
				assert.ok(component.render(100).some((line) => line.includes("Confirm stop for async run async-stop")));
				component.handleInput("n");
				assert.deepEqual(calls, []);
				component.handleInput("D");
				component.handleInput("y");
				await new Promise((resolve) => setImmediate(resolve));
				assert.deepEqual(calls, [{ runId: "async-stop", asyncDir, index: 0 }]);
				assert.ok(component.render(100).some((line) => line.includes("Stop requested.")));
			} finally {
				component.dispose();
			}
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("explains unavailable controls for completed async children", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fleet-unavailable-"));
		try {
			writeAsyncRun(root, { id: "async-complete", state: "complete" });
			const state = stateForTest();
			const component = new SubagentFleetComponent(
				{ terminal: { rows: 28, columns: 100 }, requestRender() {} } as never,
				theme as never,
				state,
				() => {},
				{
					asyncDirRoot: root,
					resultsDir: path.join(root, "results"),
					refreshMs: 60_000,
					actions: {
						async steer() {
							return { text: "unused" };
						},
						stop() {
							return { text: "unused" };
						},
					},
				},
			);
			try {
				component.handleInput("s");
				assert.ok(component.render(100).some((line) => line.includes("Selected child is complete")));
			} finally {
				component.dispose();
			}
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("periodically redraws only while the overlay remains open", (t) => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const state = stateForTest();
		let renderRequests = 0;
		let closed = false;
		const tui = { terminal: { rows: 28, columns: 90 }, requestRender: () => { renderRequests++; } };
		const component = new SubagentFleetComponent(
			tui as never,
			theme as never,
			state,
			() => { closed = true; },
			{ refreshMs: 10 },
		);
		t.mock.timers.tick(249);
		assert.equal(renderRequests, 0, "refresh cadence is bounded away from a hot loop");
		t.mock.timers.tick(1);
		assert.equal(renderRequests, 1);
		component.handleInput("\x1b");
		assert.equal(closed, true);
		t.mock.timers.tick(1_000);
		assert.equal(renderRequests, 1, "closing cancels periodic redraws");

		const disposed = new SubagentFleetComponent(
			tui as never,
			theme as never,
			state,
			() => {},
			{ refreshMs: 250 },
		);
		disposed.dispose();
		t.mock.timers.tick(1_000);
		assert.equal(renderRequests, 1, "disposing cancels periodic redraws");
	});

	it("refreshes the roster while the overlay remains open", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fleet-refresh-"));
		try {
			const state = stateForTest();
			let renderRequests = 0;
			const tui = { terminal: { rows: 28, columns: 90 }, requestRender: () => { renderRequests++; } };
			const component = new SubagentFleetComponent(
				tui as never,
				theme as never,
				state,
				() => {},
				{ asyncDirRoot: root, resultsDir: path.join(root, "results"), refreshMs: 250 },
			);
			let invalidations = 0;
			const originalInvalidate = component.invalidate.bind(component);
			component.invalidate = () => {
				invalidations++;
				originalInvalidate();
			};
			try {
				assert.ok(component.render(90).some((line) => line.includes("No tracked children")));
				const initialOutput = Array.from({ length: 40 }, (_, index) => `output line ${index}`).join("\n");
				const asyncDir = writeAsyncRun(root, { id: "appeared-live", output: initialOutput });
				await new Promise((resolve) => setTimeout(resolve, 275));
				let lines = component.render(90);
				assert.ok(lines.some((line) => line.includes("appeared")));
				assert.ok(lines.some((line) => line.includes("output line 39")));
				fs.appendFileSync(path.join(asyncDir, "output-0.log"), "\nLATEST LIVE OUTPUT", "utf-8");
				await new Promise((resolve) => setTimeout(resolve, 35));
				lines = component.render(90);
				assert.ok(lines.some((line) => line.includes("LATEST LIVE OUTPUT")), "live transcript should keep following new output");
				assert.ok(renderRequests > 0);
				assert.ok(invalidations > 0, "live refresh must invalidate cached TUI frames before rendering");
			} finally {
				component.dispose();
			}
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
