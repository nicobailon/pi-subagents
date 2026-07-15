import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { collectFleetSnapshot, SubagentFleetComponent } from "../../src/tui/fleet.ts";
import type { SubagentState } from "../../src/shared/types.ts";

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
	state?: "running" | "complete";
	agents?: string[];
	output?: string;
}): string {
	const asyncDir = path.join(root, input.id);
	fs.mkdirSync(asyncDir, { recursive: true });
	const agents = input.agents ?? ["worker"];
	if (input.output !== undefined) fs.writeFileSync(path.join(asyncDir, "output-0.log"), input.output, "utf-8");
	fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
		runId: input.id,
		sessionId: input.sessionId ?? "session-current",
		mode: agents.length > 1 ? "parallel" : "single",
		state: input.state ?? "running",
		startedAt: 100,
		lastUpdate: 200,
		currentStep: 0,
		steps: agents.map((agent, index) => ({
			agent,
			status: input.state === "complete" ? "complete" : index === 0 ? "running" : "pending",
			startedAt: 100,
			...(index === 0 ? { sessionFile: path.join(asyncDir, `${agent}.jsonl`) } : {}),
		})),
		...(input.output !== undefined ? { outputFile: "output-0.log" } : {}),
	}, null, 2));
	return asyncDir;
}

const theme = {
	fg: (_name: string, text: string) => text,
	bold: (text: string) => text,
};

describe("native subagent fleet", () => {
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

	it("renders selectable transcript detail and completed artifact paths within terminal width", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fleet-render-"));
		try {
			const asyncDir = writeAsyncRun(root, { id: "async-finished", state: "complete", output: "FINAL ASYNC OUTPUT" });
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
				{ asyncDirRoot: root, resultsDir: path.join(root, "results"), refreshMs: 10 },
			);
			try {
				assert.ok(component.render(90).some((line) => line.includes("No tracked children")));
				const initialOutput = Array.from({ length: 40 }, (_, index) => `output line ${index}`).join("\n");
				const asyncDir = writeAsyncRun(root, { id: "appeared-live", output: initialOutput });
				await new Promise((resolve) => setTimeout(resolve, 35));
				let lines = component.render(90);
				assert.ok(lines.some((line) => line.includes("appeared")));
				assert.ok(lines.some((line) => line.includes("output line 39")));
				fs.appendFileSync(path.join(asyncDir, "output-0.log"), "\nLATEST LIVE OUTPUT", "utf-8");
				await new Promise((resolve) => setTimeout(resolve, 35));
				lines = component.render(90);
				assert.ok(lines.some((line) => line.includes("LATEST LIVE OUTPUT")), "live transcript should keep following new output");
				assert.ok(renderRequests > 0);
			} finally {
				component.dispose();
			}
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
