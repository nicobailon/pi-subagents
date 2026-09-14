import assert from "node:assert/strict";
import { it } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { renderWidget, setInlineWorkflowCoverage } from "../../src/tui/render.ts";
import type { AsyncJobState } from "../../src/shared/types.ts";

it("toggles only the async header and retains live status without changing global expansion", () => {
	const click = { type: "click", button: "left", y: 0, shift: false, alt: false, ctrl: false };
	type Widget = { render(width: number): string[]; handleMouse(event: typeof click): { handled: boolean } | undefined; dispose(): void };
	const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
	type WidgetFactory = (tui: { requestRender(): void }, theme: { fg(color: string, text: string): string; bold(text: string): string }) => Widget;
	let widget: Widget | undefined;
	let registrations = 0;
	let renderRequests = 0;
	let expanded = false;
	const ctx = {
		hasUI: true, mode: "tui",
		ui: {
			getToolsExpanded: () => expanded,
			setWidget: (_key: string, factory: WidgetFactory | undefined) => {
				registrations++;
				widget?.dispose();
				widget = factory?.({ requestRender: () => renderRequests++ }, theme);
			},
		},
	};
	const job = (asyncId: string, status: AsyncJobState["status"] = "running"): AsyncJobState => ({
		asyncId, asyncDir: "/tmp/widget-mouse", status, mode: "single", agents: ["worker"], description: "Mouse test", startedAt: 1_000,
	});
	// SAFETY: the TUI path only reads hasUI, mode, and the supplied widget/expansion methods.
	const render = (jobs: AsyncJobState[]) => renderWidget(ctx as never, jobs);
	const lines = (width = 120) => widget!.render(width);
	const rows = Object.getOwnPropertyDescriptor(process.stdout, "rows");
	Object.defineProperty(process.stdout, "rows", { configurable: true, value: 60 });
	const now = Date.now;
	Date.now = () => 2_000;
	try {
		render([job("a")]);
		assert.ok(lines().length > 1);
		assert.deepEqual(widget!.handleMouse(click), { handled: true });
		const first = lines();
		assert.equal(first.length, 1);
		assert.match(first[0]!, /1\/1 running/);
		assert.strictEqual(lines(), first, "same-frame renders reuse the cache");
		const beforeIgnored = renderRequests;
		for (const change of [
			{ y: 1 }, { y: 2 }, { button: "right" }, { button: "middle" },
			{ type: "press" }, { type: "release" }, { type: "drag" }, { type: "wheel" }, { type: "move" },
			{ shift: true }, { alt: true }, { ctrl: true },
		]) assert.equal(widget!.handleMouse({ ...click, ...change }), undefined);
		assert.equal(renderRequests, beforeIgnored);
		expanded = true;
		assert.equal(lines().length, 1, "global expansion does not override manual collapse");
		const jobs = [job("a"), job("b", "failed"), job("c", "queued"), job("d", "paused"), job("e", "partial"), job("f", "rejected")];
		jobs[0]!.mode = "workflow";
		jobs[1]!.parentWorkflowRunId = "a";
		const snapshot = JSON.stringify(jobs);
		render(jobs);
		assert.equal(registrations, 1, "progress updates retain the mounted widget");
		for (const text of ["1/6 running", "1 failed", "1 queued", "1 paused", "1 partial", "1 rejected"]) assert.ok(lines()[0]!.includes(text));
		assert.ok(visibleWidth(lines(15)[0]!) <= 15);
		// SAFETY: coverage uses this UI object only as a WeakMap key and invokes its registered invalidator.
		setInlineWorkflowCoverage(ctx.ui as never, new Map([["a", "changed"]]));
		assert.equal(lines().length, 1);
		widget!.handleMouse(click);
		assert.ok(lines().length > 1);
		assert.equal(expanded, true);
		assert.equal(JSON.stringify(jobs), snapshot);
		render([]);
		assert.equal(widget, undefined);
		render([job("new")]);
		assert.ok(lines().length > 1, "a newly mounted widget starts unfolded");
	} finally {
		render([]);
		Date.now = now;
		if (rows) Object.defineProperty(process.stdout, "rows", rows);
		else Reflect.deleteProperty(process.stdout, "rows");
	}
});
