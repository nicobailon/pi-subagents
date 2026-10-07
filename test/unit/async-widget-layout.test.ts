import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { renderWidget } from "../../src/tui/render.ts";
import type { AsyncJobState, AsyncWidgetLayout } from "../../src/shared/types.ts";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
const click = { type: "click", button: "left", y: 0, shift: false, alt: false, ctrl: false };
type Widget = { render(width: number): string[]; handleMouse(event: typeof click): { handled: boolean } | undefined };
type WidgetFactory = (tui: { requestRender(): void }, widgetTheme: typeof theme) => Widget;

const agents = ["scout", "reviewer", "worker", "tester"];
const jobs: AsyncJobState[] = agents.map((agent) => ({
	asyncId: `run-${agent}`, asyncDir: `/tmp/run-${agent}`, status: "running", mode: "single", agents: [agent], currentTool: "read",
}));

function detailRows(lines: string[]): string[] {
	return lines.filter((line) => line.endsWith("⎿  read"));
}

// Each mount resets the layout session that widgets share, so finish one widget before mounting the next.
function mountWidget(layout: AsyncWidgetLayout, initiallyCollapsed = false) {
	let widget: Widget | undefined;
	let expanded = false;
	const ctx = {
		hasUI: true, mode: "tui",
		ui: {
			getToolsExpanded: () => expanded,
			setWidget: (_key: string, factory: WidgetFactory | undefined) => { widget = factory?.({ requestRender() {} }, theme); },
		},
	};
	// SAFETY: the TUI path only reads hasUI, mode, and the supplied widget/expansion methods.
	const tuiContext = ctx as never;
	renderWidget(tuiContext, []);
	renderWidget(tuiContext, jobs, initiallyCollapsed, layout);
	return {
		lines: () => widget!.render(120).map((line) => line.trimEnd()),
		click: () => assert.deepEqual(widget!.handleMouse(click), { handled: true }),
		setExpanded: (value: boolean) => { expanded = value; },
	};
}

describe("async widget layout", () => {
	const now = Date.now;
	let rows: PropertyDescriptor | undefined;
	beforeEach(() => {
		rows = Object.getOwnPropertyDescriptor(process.stdout, "rows");
		Object.defineProperty(process.stdout, "rows", { configurable: true, value: 60 });
		// A fixed clock keeps the spinner frame equal across the renders a test compares.
		Date.now = () => 2_000;
	});
	afterEach(() => {
		Date.now = now;
		if (rows) Object.defineProperty(process.stdout, "rows", rows);
		else Reflect.deleteProperty(process.stdout, "rows");
	});

	it("renders a header plus one line per run at a height where the adaptive layout shows detail rows", () => {
		const adaptive = mountWidget("adaptive").lines();
		assert.match(adaptive[0]!, /^ \S Async agents · background$/);
		assert.equal(detailRows(adaptive).length, jobs.length, adaptive.join("\n"));

		const lines = mountWidget("rows").lines();
		assert.equal(lines.length, 1 + jobs.length, lines.join("\n"));
		assert.match(lines[0]!, /^ \S Async agents · 4 agents running$/);
		for (const [index, agent] of agents.entries()) assert.match(lines[index + 1]!, new RegExp(`^ {3}\\S ${agent} · running · read$`));
	});

	it("folds to the count line on a header click or when configured folded, in both layouts", () => {
		for (const layout of ["adaptive", "rows"] as const) {
			const widget = mountWidget(layout);
			const unfolded = widget.lines();
			widget.click();
			const folded = widget.lines();
			assert.equal(folded.length, 1, `${layout}: ${folded.join("\n")}`);
			assert.match(folded[0]!, /^ \S subagents \(4\/4 running\)$/);
			widget.click();
			assert.deepEqual(widget.lines(), unfolded, `${layout}: a second click restores the layout`);

			const configured = mountWidget(layout, true);
			assert.deepEqual(configured.lines(), folded, `${layout}: a configured widget starts folded`);
			configured.click();
			assert.deepEqual(configured.lines(), unfolded, `${layout}: a click unfolds a configured widget`);
		}
	});

	it("shows the detailed layout while Pi's expand key is on, in both layouts", () => {
		for (const layout of ["adaptive", "rows"] as const) {
			const widget = mountWidget(layout);
			const unfolded = widget.lines();
			widget.setExpanded(true);
			const expanded = widget.lines();
			assert.match(expanded[0]!, /^ \S Async agents · background$/, `${layout}: ${expanded.join("\n")}`);
			assert.equal(detailRows(expanded).length, jobs.length, `${layout}: ${expanded.join("\n")}`);
			widget.setExpanded(false);
			assert.deepEqual(widget.lines(), unfolded, `${layout}: collapsing restores the layout`);
		}
	});
});
