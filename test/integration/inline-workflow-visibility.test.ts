import assert from "node:assert/strict";
import { it } from "node:test";
import { Editor, visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AsyncJobState, SubagentState } from "../../src/shared/types.ts";
import { WIDGET_KEY } from "../../src/shared/types.ts";
import { FLEET_STATUS_WIDGET_KEY, SubagentFleetStatus } from "../../src/tui/fleet-status.ts";
import { renderWidget, setInlineWorkflowCoverage } from "../../src/tui/render.ts";

const theme = { fg: (_name: string, text: string) => text, bg: (_name: string, text: string) => text, bold: (text: string) => text };
type Mounted = { render(width: number): string[]; dispose?(): void };
function harness(maxAgentRows = 6, inspector: () => Promise<void> = async () => {}) {
	const job: AsyncJobState = { asyncId: "workflow", asyncDir: "/tmp/workflow", mode: "workflow", status: "running", startedAt: 1_000,
		steps: [{ workflowKey: "lane-a", agent: "unique-worker", status: "running" }] };
	const state = { asyncJobs: new Map([[job.asyncId, job]]), foregroundControls: new Map() } as unknown as SubagentState;
	const mounted = new Map<string, Mounted>();
	let requests = 0;
	let expanded = false;
	const tui = { requestRender() { requests++; }, focusedComponent: Object.create(Editor.prototype) };
	const ctx = { hasUI: true, ui: { theme, getToolsExpanded: () => expanded, getEditorText: () => "", onTerminalInput: () => () => {}, notify() {},
		setWidget(key: string, factory: ((tui: unknown, theme: unknown) => Mounted) | undefined) {
			mounted.get(key)?.dispose?.(); mounted.delete(key);
			if (factory) mounted.set(key, factory(tui, theme));
		} } } as unknown as ExtensionContext;
	const fleet = new SubagentFleetStatus(state, inspector, { refreshMs: 60_000, maxAgentRows, onWorkflowCoverageChange: setInlineWorkflowCoverage });
	fleet.setContext(ctx);
	renderWidget(ctx, [job]);
	return { job, state, ctx, fleet, mounted, get requests() { return requests; }, setExpanded(value: boolean) { expanded = value; },
		asyncText: () => mounted.get(WIDGET_KEY)!.render(240).join("\n"),
		roster: (width = 240) => mounted.get(FLEET_STATUS_WIDGET_KEY)!.render(width).join("\n"),
		activate() { fleet.handleKey("\x1b[B"); },
		close() { fleet.dispose(); mounted.get(WIDGET_KEY)?.dispose?.(); renderWidget(ctx, []); },
	};
}

it("collapses only after the actual same-UI roster renders, and restores on deactivation/disposal", () => {
	const h = harness();
	try {
		assert.match(h.asyncText(), /unique-worker/);
		h.activate();
		assert.match(h.asyncText(), /unique-worker/, "activation alone is not rendered coverage");
		assert.match(h.roster(), /unique-worker/);
		const before = h.requests;
		assert.match(h.asyncText(), /Workflow children shown in Fleet roster/);
		assert.doesNotMatch(h.asyncText(), /unique-worker/);
		h.setExpanded(true);
		assert.doesNotMatch(h.asyncText(), /unique-worker/);
		h.fleet.handleKey("\x1b");
		assert.ok(h.requests > before, "coverage changes invalidate the existing widget");
		assert.match(h.asyncText(), /unique-worker/);
		h.activate(); h.roster();
		h.mounted.get(FLEET_STATUS_WIDGET_KEY)!.dispose?.();
		assert.match(h.asyncText(), /unique-worker/);
	} finally { h.close(); }
});

it("keeps coverage when the roster drops a rate it had no room for", () => {
	const h = harness(10);
	try {
		const [alpha] = materialize(h);
		alpha.steps = [{ agent: "alpha-worker", status: "running", startedAt: Date.now() - 60_000, tokens: { input: 9_000, output: 60, total: 9_060 } }];
		renderWidget(h.ctx, [...h.state.asyncJobs.values()]);
		h.activate();
		const row = (width: number): string => h.roster(width).split("\n").find((line) => line.includes("alpha-worker"))!;
		assert.match(row(240), /· running.*\d+ tok\/s avg · ↓ 9\.1k tokens/);
		// Walk down to the boundary where the rate stops fitting and the render drops it.
		let width = 240;
		while (width > 20 && row(width).includes("tok/s")) width--;
		assert.match(row(width), /· running.*↓ 9\.1k tokens/);
		assert.doesNotMatch(row(width), /tok\/s/);
		assert.equal(visibleWidth(row(width)), width, "the row fits once the rate is dropped");
		assert.match(row(width + 1), /tok\/s avg/);
		// A row that fits once the rate is dropped is still visible, so coverage survives.
		h.roster(width);
		assert.match(h.asyncText(), /Workflow children shown in Fleet roster/);
	} finally { h.close(); }
});

it("retains detail for row overflow, horizontal truncation and nested children", () => {
	for (const kind of ["budget", "width", "nested", "overflow"] as const) {
		const h = harness(kind === "budget" ? 1 : 20);
		try {
			if (kind === "nested") h.job.steps![0]!.children = [{ id: "nested", state: "running", agent: "nested-worker" }];
			if (kind === "overflow") for (let i = 0; i < 6; i++) h.job.steps!.push({ agent: `worker-${i}`, status: "running" });
			renderWidget(h.ctx, [...h.state.asyncJobs.values()]);
			h.activate(); h.roster(kind === "width" ? 20 : 240);
			assert.doesNotMatch(h.asyncText(), /Workflow children shown in Fleet roster/, kind);
			assert.match(h.asyncText(), /unique-worker/, kind);
		} finally { h.close(); }
	}
});

it("revokes coverage when navigation scrolls a workflow out of the roster, or its context becomes stale", () => {
	const h = harness(3);
	try {
		h.state.asyncJobs.set("later", { asyncId: "later", asyncDir: "/tmp/later", mode: "single", status: "running", startedAt: 2_000, agents: ["later-worker"] });
		h.activate(); h.roster();
		assert.match(h.asyncText(), /Workflow children shown in Fleet roster/);
		h.fleet.handleKey("\x1b[B"); h.fleet.handleKey("\x1b[B"); h.roster();
		assert.match(h.asyncText(), /unique-worker/);
		h.fleet.handleKey("\x1b[A"); h.roster();
		assert.match(h.asyncText(), /Workflow children shown in Fleet roster/);
		Object.defineProperty(h.ctx, "hasUI", { get() { throw new Error("This extension ctx is stale after session replacement or reload."); }, configurable: true });
		h.fleet.refresh();
		assert.match(h.asyncText(), /unique-worker/);
	} finally {
		Object.defineProperty(h.ctx, "hasUI", { value: true, configurable: true });
		h.close();
	}
});

it("new step identities and materialized children revoke stale coverage within the same frame", () => {
	const h = harness();
	try {
		h.activate(); h.roster();
		assert.doesNotMatch(h.asyncText(), /unique-worker/);
		h.job.steps!.push({ workflowKey: "lane-b", agent: "new-worker", status: "running" });
		assert.match(h.asyncText(), /new-worker/, "in-place arrival cannot use cached covered lines");
		h.fleet.refresh(); h.roster();
		assert.match(h.asyncText(), /Workflow children shown in Fleet roster/);
		const child: AsyncJobState = { asyncId: "child", asyncDir: "/tmp/child", mode: "single", status: "running", parentWorkflowRunId: h.job.asyncId, agents: ["attached-worker"] };
		renderWidget(h.ctx, [h.job, child]);
		assert.match(h.asyncText(), /attached-worker/);
		assert.doesNotMatch(h.asyncText(), /Workflow children shown in Fleet roster/);
	} finally { h.close(); }
});

function materialize(h: ReturnType<typeof harness>) {
	h.job.steps = [];
	const leaf = (id: string): AsyncJobState => ({ asyncId: id, asyncDir: `/tmp/${id}`, mode: "single", status: "running", parentWorkflowRunId: h.job.asyncId, agents: [`${id}-worker`] });
	const children: [AsyncJobState, AsyncJobState] = [leaf("alpha"), leaf("beta")];
	for (const child of children) h.state.asyncJobs.set(child.asyncId, child);
	renderWidget(h.ctx, [...h.state.asyncJobs.values()]);
	return children;
}

it("covers flat materialized leaf cards only after every row renders and checks child freshness", () => {
	const h = harness(10);
	try {
		const [alpha, beta] = materialize(h);
		beta.mode = "parallel"; beta.agents = ["beta-worker", "second-beta-worker"];
		beta.steps = beta.agents.map((agent) => ({ agent, status: "running" }));
		h.setExpanded(true);
		assert.match(h.asyncText(), /alpha-worker/);
		h.activate();
		assert.match(h.asyncText(), /second-beta-worker/);
		assert.match(h.roster(), /second-beta-worker/);
		assert.match(h.asyncText(), /Workflow children shown in Fleet roster/);
		assert.doesNotMatch(h.asyncText(), /alpha-worker|beta-worker/);
		alpha.agents = ["changed-worker"];
		assert.match(h.asyncText(), /changed-worker/);
		h.fleet.refresh(); h.roster();
		assert.doesNotMatch(h.asyncText(), /changed-worker/);
		const arriving = { ...alpha, asyncId: "arriving", agents: ["arriving-worker"] };
		h.state.asyncJobs.set(arriving.asyncId, arriving);
		renderWidget(h.ctx, [...h.state.asyncJobs.values()]);
		assert.match(h.asyncText(), /arriving-worker/);
		h.fleet.refresh(); h.roster();
		assert.doesNotMatch(h.asyncText(), /arriving-worker/);
		h.roster(25);
		assert.match(h.asyncText(), /arriving-worker/);
		h.roster(); h.fleet.handleKey("\x1b");
		assert.match(h.asyncText(), /arriving-worker/);
	} finally { h.close(); }
});

it("restores materialized detail when child context or step window changes without a refresh", () => {
	for (const field of ["context", "window"] as const) {
		const h = harness();
		try {
			const [alpha] = materialize(h);
			const tokens = { input: 100, output: 20, total: 120, window: 100 };
			alpha.steps = [{ agent: "alpha-worker", status: "running", tokens }];
			h.activate(); h.roster();
			assert.doesNotMatch(h.asyncText(), /alpha-worker/);
			if (field === "context") alpha.context = "fork";
			else tokens.window = 110;
			assert.match(h.asyncText(), /alpha-worker/, field);
			h.fleet.refresh(); h.roster();
			assert.doesNotMatch(h.asyncText(), /alpha-worker/);
		} finally { h.close(); }
	}
});

it("revokes flat coverage on scroll, child replacement, and a new grandchild", () => {
	const h = harness(3);
	try {
		const [alpha, beta] = materialize(h);
		h.state.asyncJobs.set("later", { asyncId: "later", asyncDir: "/tmp/later", mode: "single", status: "running", agents: ["later-worker"] });
		h.activate(); h.roster();
		assert.doesNotMatch(h.asyncText(), /alpha-worker/);
		for (let i = 0; i < 4; i++) h.fleet.handleKey("\x1b[B");
		h.roster(); assert.match(h.asyncText(), /alpha-worker/);
		h.fleet.handleKey("\x1b[A"); h.roster();
		assert.doesNotMatch(h.asyncText(), /alpha-worker/);
		const replacement = { ...alpha, asyncId: "replacement" };
		h.state.asyncJobs.delete(alpha.asyncId); h.state.asyncJobs.set(replacement.asyncId, replacement);
		renderWidget(h.ctx, [h.job, beta, replacement]);
		assert.match(h.asyncText(), /alpha-worker/);
		h.fleet.refresh(); h.roster();
		assert.doesNotMatch(h.asyncText(), /alpha-worker/);
		const grandchild = { ...beta, asyncId: "grandchild", parentWorkflowRunId: replacement.asyncId, agents: ["grandchild-worker"] };
		renderWidget(h.ctx, [h.job, beta, replacement, grandchild]);
		assert.match(h.asyncText(), /alpha-worker/);
		h.setExpanded(true);
		assert.match(h.asyncText(), /grandchild-worker/);
	} finally { h.close(); }
});

it("retains materialized cards for incomplete, nested, uncertain and non-running groups", () => {
	for (const kind of ["budget", "multi-row-budget", "wrapper", "grandchild", "nested", "terminal", "parent", "foreground", "chain", "external", "overflow"] as const) {
		const h = harness(kind === "budget" ? 2 : kind === "multi-row-budget" ? 3 : 20);
		try {
			const [alpha, beta] = materialize(h);
			if (kind === "multi-row-budget") { beta.mode = "parallel"; beta.agents = ["beta-worker", "second-beta-worker"]; }
			if (kind === "wrapper") alpha.mode = "workflow";
			if (kind === "grandchild") h.state.asyncJobs.set("grandchild", { ...beta, asyncId: "grandchild", parentWorkflowRunId: alpha.asyncId });
			if (kind === "nested") alpha.nestedChildren = [{ id: "nested", agent: "nested-worker", state: "running" }];
			if (kind === "terminal") alpha.status = "complete";
			if (kind === "parent") h.job.status = "queued";
			if (kind === "foreground") h.state.foregroundControls.set("unknown", { runId: "unknown", mode: "single", startedAt: 1000, updatedAt: 1000, parentWorkflowRunId: h.job.asyncId });
			if (kind === "chain") { alpha.mode = "chain"; alpha.agents = ["alpha-worker", "pending-worker"]; }
			if (kind === "external") alpha.steps = [{ agent: "alpha-worker", status: "running", runner: {
				type: "external-job", provider: "test", options: {}, capabilities: { stop: false, steer: false, resume: false, structuredOutput: false, toolEvents: false },
			} }];
			if (kind === "overflow") h.job.steps = Array.from({ length: 4 }, (_, i) => ({ agent: `lane-${i}`, status: "running" }));
			renderWidget(h.ctx, [...h.state.asyncJobs.values()]); h.setExpanded(true);
			h.activate(); h.roster();
			assert.doesNotMatch(h.asyncText(), /Workflow children shown in Fleet roster/, kind);
			assert.match(h.asyncText(), kind === "overflow" ? /lane-0/ : /beta/, kind);
		} finally { h.close(); }
	}
});

it("restores detail for suspension, inspector transitions, UI replacement, and headless replacement", async () => {
	let finish!: () => void;
	const h = harness(6, () => new Promise<void>((resolve) => { finish = resolve; }));
	try {
		materialize(h);
		h.job.steps = [{ agent: "unique-worker", status: "running" }];
		h.activate(); h.roster();
		h.state.widgetsSuspended = true; h.fleet.refresh();
		assert.match(h.asyncText(), /unique-worker/);
		h.state.widgetsSuspended = false; h.fleet.refresh(); h.roster();
		assert.doesNotMatch(h.asyncText(), /unique-worker/);
		h.fleet.handleKey("\x1b[B"); h.fleet.handleKey("\r");
		assert.match(h.asyncText(), /unique-worker/);
		await Promise.resolve(); finish();
		await new Promise((resolve) => setImmediate(resolve));
		h.roster();
		assert.doesNotMatch(h.asyncText(), /unique-worker/);
		h.state.fleetInspectorOpen = true; h.fleet.refresh();
		assert.match(h.asyncText(), /unique-worker/);
		h.state.fleetInspectorOpen = false; h.fleet.refresh(); h.roster();
		const oldText = h.asyncText;
		const other = harness();
		try {
			assert.match(other.asyncText(), /unique-worker/, "coverage cannot leak to a second UI");
			h.fleet.setContext(other.ctx);
			assert.match(oldText(), /unique-worker/, "old UI regains detail immediately");
			h.fleet.setContext({ hasUI: false } as ExtensionContext);
			assert.match(other.asyncText(), /unique-worker/);
		} finally { other.close(); }
	} finally { h.close(); }
});
