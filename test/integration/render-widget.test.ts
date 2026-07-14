import assert from "node:assert/strict";
import { describe, it } from "node:test";

const { buildWidgetLines, renderWidget } = await import("../../src/tui/render.ts") as {
	buildWidgetLines: (jobs: Array<Record<string, unknown>>, theme: { fg(name: string, text: string): string; bold(text: string): string }, width?: number, expanded?: boolean) => string[];
	renderWidget: (ctx: Record<string, unknown>, jobs: Array<Record<string, unknown>>, clock?: { frame: number; nowMs: number }) => void;
};
const theme = { fg: (_name: string, text: string) => text, bold: (text: string) => text };
const job = (steps: unknown[], extra: Record<string, unknown> = {}) => ({ asyncId: "root", asyncDir: "/tmp/root", status: "running", mode: "chain", startedAt: 1_000, steps, ...extra });

describe("subagent async widget rendering", () => {
	it("renders complete lifecycle counts, overlapping attention, action-first compact rows, and stable overflow", () => {
		const lines = buildWidgetLines([job([
			{ agent: "queued", status: "pending" },
			{ agent: "done", status: "complete" },
			{ agent: "failed", status: "failed", error: "\u001b]unsafe\u0007 failed reason" },
			{ agent: "paused", status: "paused", attentionReason: "waiting for approval" },
			{ agent: "active", status: "running", currentTool: "read", currentPath: "src/tui/render.ts", currentToolStartedAt: 1_500 },
			{ agent: "hidden", status: "running" },
		], { startedAt: 1_000 })], theme, 180).join("\n");
		assert.match(lines, /1 queued/); assert.match(lines, /1 completed/); assert.match(lines, /1 failed/); assert.match(lines, /1 paused/); assert.match(lines, /2 running/); assert.match(lines, /1 needs attention/);
		assert.ok(lines.indexOf("failed") < lines.indexOf("active"));
		assert.match(lines, /⚠ paused · paused · needs attention/);
		assert.match(lines, /read · src\/tui\/render.ts/);
		assert.doesNotMatch(lines, /token|thinking|model|output:|artifact/i);
		assert.doesNotMatch(lines, /\x1b/);
	});

	it("uses render clock frames only, with stable root-qualified child phase offsets", () => {
		const ui = { hasUI: true, ui: { theme, setWidget: (_key: string, value: unknown) => { (ui as { widget?: unknown }).widget = value; }, requestRender: () => undefined } };
		const input = [job([{ index: 0, agent: "one", status: "running", currentTool: "read", currentToolStartedAt: 1 }, { index: 1, agent: "two", status: "running", currentTool: "read", currentToolStartedAt: 999_999 }])];
		renderWidget(ui, input, { frame: 2, nowMs: 2_000 });
		const component = (ui as { widget: (tui: unknown, t: typeof theme) => { render(width: number): string[] } }).widget;
		const first = component(undefined, theme).render(180).join("\n");
		renderWidget(ui, [{ ...input[0]!, steps: [{ index: 0, agent: "one", status: "running", currentTool: "read", currentToolStartedAt: 2 }, { index: 1, agent: "two", status: "running", currentTool: "read", currentToolStartedAt: 3, toolCount: 99 }] }], { frame: 2, nowMs: 2_000 });
		const same = (ui as { widget: (tui: unknown, t: typeof theme) => { render(width: number): string[] } }).widget(undefined, theme).render(180).join("\n");
		assert.deepEqual(first.match(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/g)?.slice(1), same.match(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/g)?.slice(1));
		renderWidget(ui, input, { frame: 3, nowMs: 2_080 });
		const next = (ui as { widget: (tui: unknown, t: typeof theme) => { render(width: number): string[] } }).widget(undefined, theme).render(180).join("\n");
		assert.notEqual(first, next);
	});

	it("renders bounded ordered expanded sections without legacy output and preserves failures in timeline", () => {
		const stdout = process.stdout as NodeJS.WriteStream & { rows?: number }; const descriptor = Object.getOwnPropertyDescriptor(stdout, "rows"); Object.defineProperty(stdout, "rows", { configurable: true, value: 50 });
		try {
			const text = buildWidgetLines([job([{ agent: "worker", status: "running", activityKind: "reasoning", activityStartedAt: 1_200, lastActivityAt: 1_300, attentionReason: "retry limit", latestVisibleMessagePreview: "visible\nmessage", currentTool: "read", currentToolArgs: "safe args", model: "model-x", toolCount: 2, totalCost: { inputTokens: 1, outputTokens: 1, costUsd: 0.01 }, recentToolActivities: [
				{ tool: "grep", endMs: 1, outcome: "success", args: "x" }, { tool: "grep", endMs: 2, outcome: "success", args: "x" }, { tool: "grep", endMs: 3, outcome: "failed", failureSummary: "bad" },
			], children: [{ id: "nested", agent: "nested-worker", state: "running", path: [{ runId: "root", stepIndex: 0, agent: "worker" }, { runId: "nested", stepIndex: 1, agent: "nested-worker" }] }] }], { outputFile: "/tmp/output", totalCost: { inputTokens: 1, outputTokens: 1, costUsd: 0.01 } })], theme, 180, true).join("\n");
			for (const section of ["Current", "Recent activity", "Flow", "Health", "Usage", "Artifacts"]) assert.match(text, new RegExp(section));
			assert.ok(text.indexOf("Current") < text.indexOf("Recent activity") && text.indexOf("Recent activity") < text.indexOf("Flow"));
			assert.match(text, /grep.*success ×2/); assert.match(text, /grep.*failed/); assert.match(text, /nested-worker · running/);
			assert.doesNotMatch(text, /recentOutput|transcript/i);
		} finally { if (descriptor) Object.defineProperty(stdout, "rows", descriptor); else Reflect.deleteProperty(stdout, "rows"); }
	});

	it("keeps the one-line tier count-first with whole tokens at narrow widths", () => {
		const stdout = process.stdout as NodeJS.WriteStream & { rows?: number };
		const descriptor = Object.getOwnPropertyDescriptor(stdout, "rows"); Object.defineProperty(stdout, "rows", { configurable: true, value: 20 });
		try {
			const input = [job([{ agent: "x", status: "running", attentionReason: "budget" }, { agent: "y", status: "failed" }, { agent: "q", status: "pending" }])];
			const lines = buildWidgetLines(input, theme, 120);
			assert.equal(lines.length, 1); assert.match(lines[0]!, /⚠ 1/); assert.match(lines[0]!, /✗ 1/); assert.match(lines[0]!, /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] 1/);
			const narrow = buildWidgetLines(input, theme, 20)[0] ?? "";
			assert.ok(narrow.length <= 20);
			assert.match(narrow, /⚠ 1/);
			assert.match(narrow, /✗ 1/);
			assert.doesNotMatch(narrow, /Async agents · backg$/);
		} finally { if (descriptor) Object.defineProperty(stdout, "rows", descriptor); else Reflect.deleteProperty(stdout, "rows"); }
	});

	it("honors actual compact widget rows including evidence and hidden-running summary", () => {
		const stdout = process.stdout as NodeJS.WriteStream & { rows?: number };
		const descriptor = Object.getOwnPropertyDescriptor(stdout, "rows"); Object.defineProperty(stdout, "rows", { configurable: true, value: 22 });
		try {
			const lines = buildWidgetLines([job([
				{ agent: "one", status: "running", latestVisibleMessagePreview: "evidence one" },
				{ agent: "two", status: "running", latestVisibleMessagePreview: "evidence two" },
				{ agent: "three", status: "running", latestVisibleMessagePreview: "evidence three" },
			])], theme, 100);
			assert.equal(lines.length, 3);
			assert.match(lines.join("\n"), /one/);
			assert.match(lines.join("\n"), /2 running children hidden/);
			assert.doesNotMatch(lines.join("\n"), /evidence one/);
		} finally { if (descriptor) Object.defineProperty(stdout, "rows", descriptor); else Reflect.deleteProperty(stdout, "rows"); }
	});

	it("shows mandatory Health reasons and concrete chain/group/nested Flow with seconds-only durations", () => {
		const stdout = process.stdout as NodeJS.WriteStream & { rows?: number };
		const descriptor = Object.getOwnPropertyDescriptor(stdout, "rows"); Object.defineProperty(stdout, "rows", { configurable: true, value: 50 });
		try {
			const text = buildWidgetLines([job([
				{ index: 0, agent: "failed", status: "failed", error: "provider rejected request" },
				{ index: 1, agent: "paused", status: "paused", attentionReason: "approval required" },
				{ index: 2, agent: "active", status: "running", currentTool: "read", currentToolStartedAt: 1_920, recentToolActivities: [{ tool: "grep", outcome: "success", endMs: 1_990, durationMs: 80 }], children: [{ id: "nested-a", path: [{ runId: "root", stepIndex: 2, agent: "active" }, { runId: "nested-a", stepIndex: 0, agent: "nested" }], agent: "nested", state: "running" }] },
			], { chainStepCount: 2, parallelGroups: [{ start: 0, count: 2, stepIndex: 0 }] })], theme, 160, true).join("\n");
			assert.match(text, /failed: failed · provider rejected request/);
			assert.match(text, /paused: needs attention · approval required/);
			assert.match(text, /⚠ step 1\/2 · parallel group · 0\/2 done/);
			assert.match(text, /active · step 2\/2/);
			assert.match(text, /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] nested · running/);
			assert.match(text, /0s/);
			assert.doesNotMatch(text, /\dms\b/);
		} finally { if (descriptor) Object.defineProperty(stdout, "rows", descriptor); else Reflect.deleteProperty(stdout, "rows"); }
	});

	it("reserves mandatory Flow/Health facts and section-local omissions at medium height", () => {
		const stdout = process.stdout as NodeJS.WriteStream & { rows?: number };
		const descriptor = Object.getOwnPropertyDescriptor(stdout, "rows"); Object.defineProperty(stdout, "rows", { configurable: true, value: 30 });
		try {
			const attention = Array.from({ length: 5 }, (_, index) => ({ index, agent: `attention-${index}`, status: "running", attentionReason: `reason-${index} after ${index === 0 ? "1,500" : "80"}ms` }));
			const text = buildWidgetLines([job([...attention, { index: 5, agent: "failed", status: "failed", error: "failed reason after .5ms" }])], theme, 140, true).join("\n");
			assert.match(text, /Flow\n/);
			assert.match(text, /Health\n/);
			for (let index = 0; index < 5; index++) assert.match(text, new RegExp(`reason-${index}`));
			assert.match(text, /failed reason/);
			assert.match(text, /1s/);
			assert.match(text, /0s/);
			assert.match(text, /3 Current lines omitted/);
			assert.match(text, /6 Flow lines omitted/);
			assert.match(text, /5 Health lines omitted/);
			assert.doesNotMatch(text, /expanded lines hidden/);
			assert.doesNotMatch(text, /(?:Usage|Artifacts)\n(?=(?:…|$))/);
			assert.doesNotMatch(text, /(?:\d[\d,]*|\.\d+)\s*ms\b/i);
		} finally { if (descriptor) Object.defineProperty(stdout, "rows", descriptor); else Reflect.deleteProperty(stdout, "rows"); }
	});
});
