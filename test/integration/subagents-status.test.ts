import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { SubagentsStatusComponent } from "../../subagents-status.ts";
import type { AsyncRunOverlayData } from "../../async-status.ts";

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

describe("SubagentsStatusComponent", () => {
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
				listRunsForOverlay: () => states[Math.min(callCount++, states.length - 1)]!,
				refreshMs: 10,
			},
		);

		try {
			await wait(25);
			const output = component.render(120).join("\n");
			assert.match(output, /Recent/);
			assert.match(output, /Selected: run-a/);
			assert.match(output, /output: \/tmp\/run-a\/output-0\.log/);
			assert.match(output, /session: \/tmp\/run-a\/session\.jsonl/);
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
					listRunsForOverlay: () => states[Math.min(callCount++, states.length - 1)]!,
					refreshMs: 10,
				},
			);
			try {
				component.handleInput("\r");
				await wait(25);
				const output = component.render(120).join("\n");
				assert.match(output, /Subagent Run run-a/);
				assert.match(output, /run-a \| complete/);
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

	it("truncates long output lines in detail view", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-status-truncate-"));
		try {
			const run = createRun("run-long", "running", root);
			fs.writeFileSync(run.outputFile, `${"x".repeat(200)}\n`, "utf-8");
			const component = new SubagentsStatusComponent(
				createTestTui(() => {}),
				createTestTheme(),
				() => {},
				{
					listRunsForOverlay: () => ({ active: [run], recent: [] }),
					refreshMs: 1000,
				},
			);
			try {
				component.handleInput("\r");
				const output = component.render(60).join("\n");
				assert.doesNotMatch(output, new RegExp("x".repeat(120)));
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
