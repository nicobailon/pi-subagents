import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
	hasLiveSubagentWork,
	PI_WEB_SESSION_LIVENESS_REGISTRY_KEY,
	registerPiWebSessionLiveness,
	retainLiveForegroundNestedRoute,
} from "../../src/integrations/pi-web-session-liveness.ts";
import { createNestedRoute, writeNestedEvent } from "../../src/runs/shared/nested-events.ts";
import { removeForegroundControlIfIdle } from "../../src/runs/foreground/subagent-executor.ts";
import type { SubagentState } from "../../src/shared/types.ts";

function clearRegistry(): void {
	delete (globalThis as Record<PropertyKey, unknown>)[Symbol.for(PI_WEB_SESSION_LIVENESS_REGISTRY_KEY)];
}

const routeRoots: string[] = [];

afterEach(() => {
	clearRegistry();
	for (const root of routeRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function nestedRoute(rootRunId: string) {
	const route = createNestedRoute(rootRunId);
	routeRoots.push(path.dirname(route.eventSink));
	return route;
}

function writeNestedState(route: ReturnType<typeof nestedRoute>, state: "running" | "complete", ts: number): void {
	writeNestedEvent(route, {
		type: state === "running" ? "subagent.nested.updated" : "subagent.nested.completed",
		ts,
		parentRunId: route.rootRunId,
		parentStepIndex: 0,
		child: {
			id: "nested-child",
			parentRunId: route.rootRunId,
			parentStepIndex: 0,
			depth: 1,
			path: [{ runId: route.rootRunId, stepIndex: 0 }],
			state,
			agent: "worker",
			lastUpdate: ts,
		},
	});
}

function makeState(): Parameters<typeof hasLiveSubagentWork>[0] {
	return {
		asyncJobs: new Map(),
		foregroundControls: new Map(),
	};
}

describe("pi-web session liveness integration", () => {
	it("reports only queued or running async jobs as live", () => {
		const state = makeState();
		state.asyncJobs.set("retained", { status: "complete" } as never);
		assert.equal(hasLiveSubagentWork(state), false);

		state.asyncJobs.set("queued", { status: "queued" } as never);
		assert.equal(hasLiveSubagentWork(state), true);
		state.asyncJobs.delete("queued");

		state.asyncJobs.set("running", { status: "running" } as never);
		assert.equal(hasLiveSubagentWork(state), true);
	});

	it("keeps a terminal parent live while a nested descendant is active", () => {
		const state = makeState();
		const nestedChild = { state: "running" };
		state.asyncJobs.set("parent", {
			status: "complete",
			nestedChildren: [{ state: "complete", children: [nestedChild] }],
		} as never);
		assert.equal(hasLiveSubagentWork(state), true);

		nestedChild.state = "complete";
		assert.equal(hasLiveSubagentWork(state), false);
	});

	it("reports foreground scheduling or active children as live", () => {
		const state = makeState();
		state.foregroundControls.set("settled", { schedulingOwners: 0, activeChildren: new Map() } as never);
		assert.equal(hasLiveSubagentWork(state), false);

		state.foregroundControls.set("scheduling", { schedulingOwners: 1, activeChildren: new Map() } as never);
		assert.equal(hasLiveSubagentWork(state), true);
		state.foregroundControls.delete("scheduling");

		state.foregroundControls.set("child", { schedulingOwners: 0, activeChildren: new Map([[0, {}]]) } as never);
		assert.equal(hasLiveSubagentWork(state), true);
	});

	it("retains a foreground nested route until its async descendant finishes", () => {
		const state = makeState();
		const route = nestedRoute("foreground-root");
		writeNestedState(route, "running", 100);

		assert.equal(retainLiveForegroundNestedRoute(state, route), true);
		assert.equal(state.retainedForegroundNestedRoutes?.has(route.rootRunId), true);
		assert.equal(hasLiveSubagentWork(state), true);

		writeNestedState(route, "complete", 200);
		assert.equal(hasLiveSubagentWork(state), true, "the synchronous probe reads only its cached projection");
	});

	it("does not retain foreground nested routes without a host registration", () => {
		const state = makeState() as SubagentState;
		const route = nestedRoute("unregistered-foreground-root");
		writeNestedState(route, "running", 100);
		state.foregroundControls.set(route.rootRunId, {
			runId: route.rootRunId,
			mode: "single",
			startedAt: 1,
			updatedAt: 1,
			schedulingOwners: 0,
			activeChildren: new Map(),
			nestedRoute: route,
		});

		const liveness = registerPiWebSessionLiveness({ sessionId: "session-a", isActive: () => true });
		assert.equal(liveness.registered, false);
		assert.equal(removeForegroundControlIfIdle(state, route.rootRunId), true);
		assert.equal(state.retainedForegroundNestedRoutes, undefined);
	});

	it("transfers a live nested route before removing its settled foreground control", () => {
		const state = makeState() as SubagentState;
		const route = nestedRoute("settled-foreground-root");
		writeNestedState(route, "running", 100);
		state.foregroundControls.set(route.rootRunId, {
			runId: route.rootRunId,
			mode: "single",
			startedAt: 1,
			updatedAt: 1,
			schedulingOwners: 0,
			activeChildren: new Map(),
			nestedRoute: route,
		});
		let tracked: string | undefined;

		assert.equal(removeForegroundControlIfIdle(state, route.rootRunId, (rootRunId) => { tracked = rootRunId; }), true);
		assert.equal(state.foregroundControls.has(route.rootRunId), false);
		assert.equal(state.retainedForegroundNestedRoutes?.has(route.rootRunId), true);
		assert.equal(tracked, route.rootRunId);
	});

	it("does not retain foreground routes without live descendants", () => {
		const state = makeState();
		const route = nestedRoute("terminal-foreground-root");
		writeNestedState(route, "complete", 100);

		assert.equal(retainLiveForegroundNestedRoute(state, route), false);
		assert.equal(state.retainedForegroundNestedRoutes, undefined);
	});

	it("is a no-op outside pi-web or with an incompatible protocol", () => {
		const releaseWithoutHost = registerPiWebSessionLiveness({
			sessionId: "session-a",
			isActive: () => true,
		});
		assert.equal(releaseWithoutHost.registered, false);
		releaseWithoutHost.release();
		let registered = false;
		(globalThis as Record<PropertyKey, unknown>)[Symbol.for(PI_WEB_SESSION_LIVENESS_REGISTRY_KEY)] = {
			version: 2,
			register() {
				registered = true;
				return () => {};
			},
		};
		const incompatible = registerPiWebSessionLiveness({ sessionId: "session-a", isActive: () => true });
		assert.equal(incompatible.registered, false);
		assert.equal(registered, false);
	});

	it("registers exact session aliases and returns the host release function", () => {
		let provider: { name: string; sessionId: string; sessionFile?: string; isActive(): boolean } | undefined;
		let released = 0;
		(globalThis as Record<PropertyKey, unknown>)[Symbol.for(PI_WEB_SESSION_LIVENESS_REGISTRY_KEY)] = {
			version: 1,
			register(value: typeof provider) {
				provider = value;
				return () => { released += 1; };
			},
		};

		let active = true;
		const release = registerPiWebSessionLiveness({
			sessionId: "session-a",
			sessionFile: "/tmp/session-a.jsonl",
			isActive: () => active,
		});
		assert.equal(release.registered, true);
		assert.equal(provider?.name, "pi-subagents");
		assert.equal(provider?.sessionId, "session-a");
		assert.equal(provider?.sessionFile, "/tmp/session-a.jsonl");
		assert.equal(provider?.isActive(), true);
		active = false;
		assert.equal(provider?.isActive(), false);

		release.release();
		assert.equal(released, 1);
	});
});
