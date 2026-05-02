import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { SubagentsStatusComponent } from "../../src/tui/subagents-status.ts";
import type { AsyncRunOverlayData } from "../../src/runs/background/async-status.ts";

type StatusTui = ConstructorParameters<typeof SubagentsStatusComponent>[0];
type StatusTheme = ConstructorParameters<typeof SubagentsStatusComponent>[1];

function wait(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function createRun(id: string, state: "queued" | "running" | "complete" | "failed", asyncDir = `/tmp/${id}`) {
	return {
		id,
		asyncDir,
		state,
		mode: "single" as const,
		cwd: asyncDir,
		startedAt: 100,
		lastUpdate: state === "running" ? 200 : 300,
		endedAt: state === "running" ? undefined : 300,
		currentStep: 0,
		steps: [{ index: 0, agent: "waiter", status: state === "running" ? "running" : "complete", durationMs: 1200 }],
		outputFile: path.join(asyncDir, "output-0.log"),
		sessionDir: path.join(asyncDir, "sessions"),
		sessionFile: path.join(asyncDir, "session.jsonl"),
	};
}

function createTestTui(requestRender: () => void): StatusTui {
	return { requestRender } as StatusTui;
}

function createTestTheme(): StatusTheme {
	return {
		fg: (_token: string, text: string) => text,
		bg: (_token: string, text: string) => text,
	} as StatusTheme;
}

function renderDetailFor(run: AsyncRunOverlayData["active"][number], placement: "active" | "recent" = "active"): string {
	const component = new SubagentsStatusComponent(
		createTestTui(() => {}),
		createTestTheme(),
		() => {},
		{
			sessionId: "session-current",
			listRunsForOverlay: () => placement === "active" ? { active: [run], recent: [] } : { active: [], recent: [run] },
			refreshMs: 1000,
		},
	);
	try {
		component.handleInput("\r");
		return component.render(160).join("\n");
	} finally {
		component.dispose();
	}
}

describe("SubagentsStatusComponent", () => {
	it("scopes overlay listing to the provided session id", () => {
		let receivedOptions: unknown;
		const component = new SubagentsStatusComponent(
			createTestTui(() => {}),
			createTestTheme(),
			() => {},
			{
				sessionId: "session-current",
				listRunsForOverlay: (_root, options) => {
					receivedOptions = options;
					return { active: [createRun("run-current", "running")], recent: [] };
				},
				refreshMs: 1000,
			},
		);
		try {
			assert.deepEqual(receivedOptions, { recentLimit: 5, sessionId: "session-current" });
			assert.match(component.render(120).join("\n"), /Selected: run-current/);
		} finally {
			component.dispose();
		}
	});

	it("uses parallel-running wording in summary rows for top-level parallel runs", () => {
		const parallelRun = {
			id: "run-parallel",
			asyncDir: "/tmp/run-parallel",
			state: "running" as const,
			mode: "parallel" as const,
			cwd: "/tmp/run-parallel",
			startedAt: 100,
			lastUpdate: 200,
			currentStep: 1,
			chainStepCount: 1,
			parallelGroups: [{ start: 0, count: 3, stepIndex: 0 }],
			steps: [
				{ index: 0, agent: "scout", status: "complete" },
				{ index: 1, agent: "reviewer", status: "running" },
				{ index: 2, agent: "worker", status: "pending" },
			],
		};
		const component = new SubagentsStatusComponent(
			createTestTui(() => {}),
			createTestTheme(),
			() => {},
			{
				sessionId: "session-current",
				listRunsForOverlay: () => ({ active: [parallelRun], recent: [] }),
				refreshMs: 1000,
			},
		);
		try {
			const output = component.render(160).join("\n");
			assert.match(output, /▶ parallel · 1 agent running · 1\/3 done/);
			assert.match(output, /Agent 1\/3: scout · complete/);
			assert.doesNotMatch(output, /step 1\/1/);
			assert.doesNotMatch(output, /step 2\/3/);
		} finally {
			component.dispose();
		}
	});

	it("auto-refreshes and keeps the same run selected when it moves to Recent", async () => {
		const states: AsyncRunOverlayData[] = [
			{ active: [createRun("run-a", "running")], recent: [] },
			{ active: [], recent: [createRun("run-a", "complete")] },
		];
		let callCount = 0;
		let renderRequests = 0;
		const component = new SubagentsStatusComponent(
			createTestTui(() => { renderRequests++; }),
			createTestTheme(),
			() => {},
			{
				sessionId: "session-current",
				listRunsForOverlay: () => states[Math.min(callCount++, states.length - 1)]!,
				refreshMs: 10,
			},
		);

		try {
			await wait(25);
			const output = component.render(120).join("\n");
			assert.match(output, /Recent/);
			assert.match(output, /Selected: run-a/);
			assert.ok(output.includes(`output: ${path.join("/tmp/run-a", "output-0.log")}`));
			assert.ok(output.includes(`session: ${path.join("/tmp/run-a", "session.jsonl")}`));
			assert.match(output, /0 active \/ 1 recent/);
			assert.match(output, /summary view/);
			assert.ok(renderRequests >= 1, "expected auto-refresh to request a render");
		} finally {
			component.dispose();
		}
	});

	it("opens a read-only detail view and returns to the summary with escape", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-status-detail-"));
		try {
			const run = createRun("run-detail", "running", root);
			fs.writeFileSync(run.outputFile, "first line\nsecond line\n", "utf-8");
			fs.writeFileSync(path.join(root, "events.jsonl"), [
				JSON.stringify({ type: "subagent.run.started", ts: 100, runId: run.id }),
				"{not-json",
				JSON.stringify({ type: "subagent.step.completed", ts: 200, stepIndex: 0, agent: "waiter", status: "complete" }),
			].join("\n"), "utf-8");
			fs.writeFileSync(path.join(root, `subagent-log-${run.id}.md`), "# log", "utf-8");
			let renderRequests = 0;
			let closed = false;
			const component = new SubagentsStatusComponent(
				createTestTui(() => { renderRequests++; }),
				createTestTheme(),
				() => { closed = true; },
				{
					sessionId: "session-current",
					listRunsForOverlay: () => ({ active: [run], recent: [] }),
					refreshMs: 1000,
				},
			);

			try {
				component.handleInput("\r");
				const detail = component.render(120).join("\n");
				assert.match(detail, /Subagent Run run-deta/);
				assert.match(detail, /Steps/);
				assert.match(detail, /Recent events/);
				assert.match(detail, /subagent\.run\.started/);
				assert.match(detail, /subagent\.step\.completed/);
				assert.doesNotMatch(detail, /not-json/);
				assert.match(detail, /Output tail/);
				assert.match(detail, /second line/);
				assert.match(detail, /Paths/);
				assert.match(detail, /asyncDir:/);
				assert.match(detail, /outputFile:/);
				assert.match(detail, /sessionFile:/);
				assert.match(detail, /read-only detail/);
				assert.match(detail, /↓ \d+ more/);
				assert.equal(renderRequests, 1);

				component.handleInput("\u001b[6~");
				const scrolledDetail = component.render(120).join("\n");
				assert.match(scrolledDetail, /sessionDir:/);
				assert.match(scrolledDetail, /runLog:/);
				assert.match(scrolledDetail, /↑ \d+ more/);

				component.handleInput("\u001b");
				const summary = component.render(120).join("\n");
				assert.match(summary, /Subagents Status/);
				assert.match(summary, /enter detail/);
				assert.equal(closed, false);
			} finally {
				component.dispose();
			}
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("renders top-level async parallel detail with agent rows", () => {
		const parallelRun = {
			id: "run-parallel",
			asyncDir: "/tmp/run-parallel",
			state: "running" as const,
			mode: "parallel" as const,
			cwd: "/tmp/run-parallel",
			startedAt: Date.now() - 30_000,
			lastUpdate: Date.now(),
			currentStep: 0,
			chainStepCount: 1,
			parallelGroups: [{ start: 0, count: 3, stepIndex: 0 }],
			steps: [
				{ index: 0, agent: "scout", status: "running", toolCount: 2 },
				{ index: 1, agent: "reviewer", status: "pending" },
				{ index: 2, agent: "worker", status: "pending" },
			],
		};
		const detail = renderDetailFor(parallelRun);
		assert.match(detail, /Agents/);
		assert.match(detail, /▶ Agent 1\/3: scout · running · 2 tools/);
		assert.match(detail, /◦ Agent 2\/3: reviewer · pending/);
		assert.doesNotMatch(detail, /Steps/);
		assert.doesNotMatch(detail, /1\. scout/);
	});

	it("renders running async chain detail as grouped chain progress", () => {
		const chainRun = {
			id: "run-chain",
			asyncDir: "/tmp/run-chain",
			state: "running" as const,
			mode: "chain" as const,
			cwd: "/tmp/run-chain",
			startedAt: Date.now() - 30_000,
			lastUpdate: Date.now(),
			currentStep: 1,
			chainStepCount: 3,
			parallelGroups: [{ start: 1, count: 4, stepIndex: 1 }],
			steps: [
				{ index: 0, agent: "scout", status: "complete", durationMs: 3_000 },
				{ index: 1, agent: "reviewer", status: "running", toolCount: 4, durationMs: 12_000 },
				{ index: 2, agent: "auditor", status: "complete" },
				{ index: 3, agent: "critic", status: "failed" },
				{ index: 4, agent: "blocker", status: "paused" },
				{ index: 5, agent: "writer", status: "pending" },
			],
		};
		const detail = renderDetailFor(chainRun);
		assert.match(detail, /Chain progress/);
		assert.match(detail, /✓ Step 1\/3: scout · complete/);
		assert.match(detail, /▶ Step 2\/3: parallel group · 1 agent running · 1\/4 done · 1 failed · 1 paused/);
		assert.match(detail, /▶ Agent 1\/4: reviewer · running · 4 tools · 12\.0s/);
		assert.match(detail, /✓ Agent 2\/4: auditor · complete/);
		assert.match(detail, /✗ Agent 3\/4: critic · failed/);
		assert.match(detail, /■ Agent 4\/4: blocker · paused/);
		assert.match(detail, /◦ Step 3\/3: writer · pending/);
		assert.doesNotMatch(detail, /Steps\n/);
	});

	it("renders terminal async chain detail as grouped chain results", () => {
		const chainRun = {
			id: "run-chain-failed",
			asyncDir: "/tmp/run-chain-failed",
			state: "failed" as const,
			mode: "chain" as const,
			cwd: "/tmp/run-chain-failed",
			startedAt: Date.now() - 30_000,
			lastUpdate: Date.now(),
			currentStep: 1,
			chainStepCount: 3,
			parallelGroups: [{ start: 1, count: 2, stepIndex: 1 }],
			steps: [
				{ index: 0, agent: "scout", status: "complete" },
				{ index: 1, agent: "reviewer", status: "failed" },
				{ index: 2, agent: "auditor", status: "complete" },
				{ index: 3, agent: "writer", status: "pending" },
			],
		};
		const detail = renderDetailFor(chainRun, "recent");
		assert.match(detail, /Chain results/);
		assert.match(detail, /✓ Step 1\/3: scout · complete/);
		assert.match(detail, /✗ Step 2\/3: parallel group · 1\/2 done · 1 failed/);
		assert.match(detail, /✗ Agent 1\/2: reviewer · failed/);
		assert.match(detail, /✓ Agent 2\/2: auditor · complete/);
		assert.match(detail, /◦ Step 3\/3: writer · pending/);
		assert.doesNotMatch(detail, /Steps\n/);
	});

	it("omits running counts for inactive chain parallel groups", () => {
		const chainRun = {
			id: "run-chain-complete-group",
			asyncDir: "/tmp/run-chain-complete-group",
			state: "running" as const,
			mode: "chain" as const,
			cwd: "/tmp/run-chain-complete-group",
			startedAt: Date.now() - 30_000,
			lastUpdate: Date.now(),
			currentStep: 2,
			chainStepCount: 2,
			parallelGroups: [{ start: 1, count: 2, stepIndex: 1 }],
			steps: [
				{ index: 0, agent: "scout", status: "complete" },
				{ index: 1, agent: "reviewer", status: "complete" },
				{ index: 2, agent: "auditor", status: "failed" },
			],
		};
		const detail = renderDetailFor(chainRun);
		assert.match(detail, /✗ Step 2\/2: parallel group · 1\/2 done · 1 failed/);
		assert.doesNotMatch(detail, /0 agents running/);
	});

	it("keeps detail selection across refresh when a run moves to Recent", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-status-detail-refresh-"));
		try {
			const running = createRun("run-a", "running", root);
			const complete = createRun("run-a", "complete", root);
			fs.writeFileSync(running.outputFile, "done\n", "utf-8");
			const states: AsyncRunOverlayData[] = [
				{ active: [running], recent: [] },
				{ active: [], recent: [complete] },
			];
			let callCount = 0;
			const component = new SubagentsStatusComponent(
				createTestTui(() => {}),
				createTestTheme(),
				() => {},
				{
					sessionId: "session-current",
					listRunsForOverlay: () => states[Math.min(callCount++, states.length - 1)]!,
					refreshMs: 10,
				},
			);
			try {
				component.handleInput("\r");
				await wait(25);
				const output = component.render(120).join("\n");
				assert.match(output, /Subagent Run run-a/);
				assert.match(output, /✓ single · step 1\/1 · complete/);
			} finally {
				component.dispose();
			}
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("keeps detail mode on the opened run when that run disappears", async () => {
		const states: AsyncRunOverlayData[] = [
			{ active: [createRun("run-a", "running")], recent: [] },
			{ active: [createRun("run-b", "running")], recent: [] },
		];
		let callCount = 0;
		const component = new SubagentsStatusComponent(
			createTestTui(() => {}),
			createTestTheme(),
			() => {},
			{
				sessionId: "session-current",
				listRunsForOverlay: () => states[Math.min(callCount++, states.length - 1)]!,
				refreshMs: 10,
			},
		);
		try {
			component.handleInput("\r");
			await wait(25);
			const detail = component.render(120).join("\n");
			assert.match(detail, /Selected run is no longer available\./);
			assert.doesNotMatch(detail, /Subagent Run run-b/);

			component.handleInput("\u001b");
			const summary = component.render(120).join("\n");
			assert.match(summary, /Selected: run-b/);
		} finally {
			component.dispose();
		}
	});

	it("renders missing detail files as warnings without crashing", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-status-missing-"));
		try {
			const run = createRun("run-missing", "running", root);
			const component = new SubagentsStatusComponent(
				createTestTui(() => {}),
				createTestTheme(),
				() => {},
				{
					sessionId: "session-current",
					listRunsForOverlay: () => ({ active: [run], recent: [] }),
					refreshMs: 1000,
				},
			);
			try {
				component.handleInput("\r");
				const output = component.render(120).join("\n");
				assert.match(output, /No events recorded\./);
				assert.doesNotMatch(output, /missing events\.jsonl:/);
				assert.match(output, /missing output-0\.log:/);
			} finally {
				component.dispose();
			}
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("keeps summary step rows compact", () => {
		const run = createRun("run-summary-long", "running");
		run.steps[0]!.error = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda omega-tail";
		const component = new SubagentsStatusComponent(
			createTestTui(() => {}),
			createTestTheme(),
			() => {},
			{
				sessionId: "session-current",
				listRunsForOverlay: () => ({ active: [run], recent: [] }),
				refreshMs: 1000,
			},
		);
		try {
			const output = component.render(60).join("\n");
			assert.match(output, /alpha beta gamma/);
			assert.doesNotMatch(output, /omega-tail/);
		} finally {
			component.dispose();
		}
	});

	it("wraps long output lines in detail view", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-status-wrap-"));
		try {
			const run = createRun("run-long", "running", root);
			fs.writeFileSync(run.outputFile, "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda\n", "utf-8");
			const component = new SubagentsStatusComponent(
				createTestTui(() => {}),
				createTestTheme(),
				() => {},
				{
					sessionId: "session-current",
					listRunsForOverlay: () => ({ active: [run], recent: [] }),
					refreshMs: 1000,
				},
			);
			try {
				component.handleInput("\r");
				const output = component.render(60).join("\n");
				const outputTail = output.slice(output.indexOf("Output tail"), output.indexOf("Paths"));
				assert.match(outputTail, /alpha beta gamma/);
				assert.match(outputTail, /lambda/);
				assert.doesNotMatch(outputTail, /\.\.\./);
			} finally {
				component.dispose();
			}
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("stops auto-refreshing after dispose", async () => {
		let renderRequests = 0;
		const component = new SubagentsStatusComponent(
			createTestTui(() => { renderRequests++; }),
			createTestTheme(),
			() => {},
			{
				sessionId: "session-current",
				listRunsForOverlay: () => ({ active: [createRun("run-a", "running")], recent: [] }),
				refreshMs: 10,
			},
		);

		await wait(25);
		component.dispose();
		const before = renderRequests;
		await wait(25);
		assert.equal(renderRequests, before);
	});
});
