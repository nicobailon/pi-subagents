import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import type { AsyncJobState, SubagentState } from "../../src/shared/types.ts";
import {
	createNestedRoute,
	hasLiveNestedDescendants,
	parseNestedEventRecords,
	projectNestedEvents,
	resolveNestedParentAddressFromEnv,
	resolveNestedRouteFromEnv,
	updateAsyncJobNestedProjection,
	updateForegroundNestedProjection,
	writeNestedEvent,
} from "../../src/runs/shared/nested-events.ts";
import {
	SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV,
	SUBAGENT_PARENT_CHILD_INDEX_ENV,
	SUBAGENT_PARENT_CONTROL_INBOX_ENV,
	SUBAGENT_PARENT_DEPTH_ENV,
	SUBAGENT_PARENT_EVENT_SINK_ENV,
	SUBAGENT_PARENT_PATH_ENV,
	SUBAGENT_PARENT_ROOT_RUN_ID_ENV,
	SUBAGENT_PARENT_RUN_ID_ENV,
} from "../../src/runs/shared/pi-args.ts";

const routes: Array<{ eventSink: string }> = [];
const savedEnv = {
	[SUBAGENT_PARENT_EVENT_SINK_ENV]: process.env[SUBAGENT_PARENT_EVENT_SINK_ENV],
	[SUBAGENT_PARENT_CONTROL_INBOX_ENV]: process.env[SUBAGENT_PARENT_CONTROL_INBOX_ENV],
	[SUBAGENT_PARENT_ROOT_RUN_ID_ENV]: process.env[SUBAGENT_PARENT_ROOT_RUN_ID_ENV],
	[SUBAGENT_PARENT_RUN_ID_ENV]: process.env[SUBAGENT_PARENT_RUN_ID_ENV],
	[SUBAGENT_PARENT_CHILD_INDEX_ENV]: process.env[SUBAGENT_PARENT_CHILD_INDEX_ENV],
	[SUBAGENT_PARENT_DEPTH_ENV]: process.env[SUBAGENT_PARENT_DEPTH_ENV],
	[SUBAGENT_PARENT_PATH_ENV]: process.env[SUBAGENT_PARENT_PATH_ENV],
	[SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV]: process.env[SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV],
};

afterEach(() => {
	for (const route of routes.splice(0)) {
		fs.rmSync(path.dirname(route.eventSink), { recursive: true, force: true });
	}
	for (const [key, value] of Object.entries(savedEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

function trackRoute(rootRunId = "root-run") {
	const route = createNestedRoute(rootRunId);
	routes.push(route);
	return route;
}

function child(id: string, state: "queued" | "running" | "complete" | "failed" | "paused", ts: number, parentRunId = "root-run") {
	return {
		id,
		parentRunId,
		parentStepIndex: 1,
		depth: 1,
		path: [{ runId: parentRunId, stepIndex: 1 }],
		mode: "single" as const,
		state,
		agent: "reviewer",
		agents: ["reviewer"],
		startedAt: 10,
		lastUpdate: ts,
		steps: [{ agent: "leaf", status: state === "running" ? "running" as const : "complete" as const }],
	};
}

describe("nested event route validation", () => {
	it("resolves nested parent addresses with full inherited path", () => {
		process.env[SUBAGENT_PARENT_RUN_ID_ENV] = "nested-parent";
		process.env[SUBAGENT_PARENT_CHILD_INDEX_ENV] = "2";
		process.env[SUBAGENT_PARENT_DEPTH_ENV] = "3";
		process.env[SUBAGENT_PARENT_PATH_ENV] = JSON.stringify([
			{ runId: "root-run", stepIndex: 0, agent: "root-agent" },
			{ runId: "../unsafe", stepIndex: 1, agent: "bad" },
			{ runId: "nested-parent", stepIndex: 2, agent: "nested-agent" },
		]);

		assert.deepEqual(resolveNestedParentAddressFromEnv(), {
			parentRunId: "nested-parent",
			parentStepIndex: 2,
			depth: 3,
			path: [
				{ runId: "root-run", stepIndex: 0, agent: "root-agent" },
				{ runId: "nested-parent", stepIndex: 2, agent: "nested-agent" },
			],
		});
	});

	it("ignores unsafe nested parent ids from env", () => {
		process.env[SUBAGENT_PARENT_RUN_ID_ENV] = "../unsafe";
		process.env[SUBAGENT_PARENT_CHILD_INDEX_ENV] = "2";

		assert.equal(resolveNestedParentAddressFromEnv(), undefined);
	});

	it("resolves only matching contained routes from env", () => {
		const route = trackRoute();
		process.env[SUBAGENT_PARENT_EVENT_SINK_ENV] = route.eventSink;
		process.env[SUBAGENT_PARENT_CONTROL_INBOX_ENV] = route.controlInbox;
		process.env[SUBAGENT_PARENT_ROOT_RUN_ID_ENV] = route.rootRunId;
		process.env[SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV] = route.capabilityToken;

		assert.deepEqual(resolveNestedRouteFromEnv(), route);

		process.env[SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV] = "wrong-token";
		assert.throws(() => resolveNestedRouteFromEnv(), /capability token/);
	});
});

describe("nested event parsing and projection", () => {
	it("projects started, updated, and completed records into async and foreground parent state", () => {
		const route = trackRoute();
		writeNestedEvent(route, {
			type: "subagent.nested.started",
			ts: 100,
			parentRunId: "root-run",
			parentStepIndex: 1,
			child: child("nested-a", "running", 100),
		});
		writeNestedEvent(route, {
			type: "subagent.nested.updated",
			ts: 200,
			parentRunId: "root-run",
			parentStepIndex: 1,
			child: { ...child("nested-a", "running", 200), currentTool: "read" },
		});
		writeNestedEvent(route, {
			type: "subagent.nested.completed",
			ts: 300,
			parentRunId: "root-run",
			parentStepIndex: 1,
			child: child("nested-a", "complete", 300),
		});

		const registry = projectNestedEvents(route);
		assert.equal(registry.children.length, 1);
		assert.equal(registry.children[0]?.id, "nested-a");
		assert.equal(registry.children[0]?.state, "complete");
		assert.equal(registry.children[0]?.steps?.[0]?.agent, "leaf");

		const job: AsyncJobState = {
			asyncId: "root-run",
			asyncDir: "/tmp/root-run",
			status: "running",
			nestedRoute: route,
			steps: [
				{ agent: "owner-0", status: "running", index: 0 },
				{ agent: "owner-1", status: "running", index: 1 },
			],
		};
		updateAsyncJobNestedProjection(job);
		assert.equal(job.nestedChildren?.[0]?.id, "nested-a");
		assert.equal(job.steps?.[1]?.children?.[0]?.id, "nested-a");

		const control: SubagentState["foregroundControls"] extends Map<string, infer T> ? T : never = {
			runId: "root-run",
			mode: "single",
			startedAt: 1,
			updatedAt: 1,
			nestedRoute: route,
		};
		updateForegroundNestedProjection(control);
		assert.equal(control.nestedChildren?.[0]?.id, "nested-a");
	});

	it("attaches root children to visible step slices by original step index", () => {
		const route = trackRoute();
		writeNestedEvent(route, {
			type: "subagent.nested.updated",
			ts: 100,
			parentRunId: "root-run",
			parentStepIndex: 3,
			child: { ...child("nested-visible", "running", 100), parentStepIndex: 3, path: [{ runId: "root-run", stepIndex: 3 }] },
		});
		const job: AsyncJobState = {
			asyncId: "root-run",
			asyncDir: "/tmp/root-run",
			status: "running",
			nestedRoute: route,
			steps: [
				{ agent: "owner-2", status: "running", index: 2 },
				{ agent: "owner-3", status: "running", index: 3 },
			],
		};

		updateAsyncJobNestedProjection(job);

		assert.equal(job.steps?.[0]?.children, undefined);
		assert.equal(job.steps?.[1]?.children?.[0]?.id, "nested-visible");
	});

	it("ignores corrupt, partial, wrong-token, duplicate, and stale records while preserving terminal state", () => {
		const route = trackRoute();
		fs.writeFileSync(path.join(route.eventSink, "0000000000001-corrupt.json"), "{not json", "utf-8");
		fs.writeFileSync(
			path.join(route.eventSink, "0000000000002-partial.jsonl"),
			`${JSON.stringify({
				type: "subagent.nested.started",
				ts: 50,
				rootRunId: route.rootRunId,
				parentRunId: "root-run",
				parentStepIndex: 1,
				capabilityToken: route.capabilityToken,
				child: child("partial-good", "running", 50),
			})}\n{"type":"subagent.nested.started"`,
			"utf-8",
		);
		writeNestedEvent(route, {
			type: "subagent.nested.completed",
			ts: 300,
			parentRunId: "root-run",
			parentStepIndex: 1,
			child: child("nested-terminal", "complete", 300),
		});
		fs.writeFileSync(path.join(route.eventSink, "0000000000400-stale.json"), `${JSON.stringify({
			type: "subagent.nested.updated",
			ts: 400,
			rootRunId: route.rootRunId,
			parentRunId: "root-run",
			parentStepIndex: 1,
			capabilityToken: route.capabilityToken,
			child: child("nested-terminal", "running", 100),
		})}\n`, "utf-8");
		fs.writeFileSync(path.join(route.eventSink, "0000000000500-wrong-token.json"), `${JSON.stringify({
			type: "subagent.nested.started",
			ts: 500,
			rootRunId: route.rootRunId,
			parentRunId: "root-run",
			parentStepIndex: 1,
			capabilityToken: "wrong",
			child: child("wrong-token", "running", 500),
		})}\n`, "utf-8");

		const registry = projectNestedEvents(route);
		assert.equal(registry.children.find((item) => item.id === "partial-good")?.state, "running");
		assert.equal(registry.children.find((item) => item.id === "nested-terminal")?.state, "complete");
		assert.equal(registry.children.some((item) => item.id === "wrong-token"), false);
		assert.equal(hasLiveNestedDescendants(registry.children), true);
	});

	it("detects live descendants attached to terminal step children", () => {
		assert.equal(hasLiveNestedDescendants([{
			...child("terminal-parent", "complete", 300),
			steps: [{
				agent: "owner-step",
				status: "complete",
				children: [{
					...child("running-step-child", "running", 310, "terminal-parent"),
					parentStepIndex: 0,
					path: [{ runId: "terminal-parent", stepIndex: 0 }],
				}],
			}],
		}]), true);
	});

	it("accepts only complete numeric token usage at the nested event boundary", () => {
		const route = trackRoute();
		writeNestedEvent(route, {
			type: "subagent.nested.updated",
			ts: 100,
			parentRunId: "root-run",
			parentStepIndex: 1,
			child: { ...child("nested-valid-tokens", "running", 100), totalTokens: { input: 10, output: 15, total: 25 } },
		});
		fs.writeFileSync(path.join(route.eventSink, "0000000000200-invalid-tokens.json"), `${JSON.stringify({
			type: "subagent.nested.updated",
			ts: 200,
			rootRunId: route.rootRunId,
			parentRunId: "root-run",
			parentStepIndex: 1,
			capabilityToken: route.capabilityToken,
			child: { ...child("nested-invalid-tokens", "running", 200), totalTokens: { input: 1, output: "bad", total: 1 } },
		})}\n`, "utf-8");

		const registry = projectNestedEvents(route);

		assert.deepEqual(registry.children.find((item) => item.id === "nested-valid-tokens")?.totalTokens, { input: 10, output: 15, total: 25 });
		assert.equal(registry.children.find((item) => item.id === "nested-invalid-tokens")?.totalTokens, undefined);
	});

	it("parses only complete jsonl records", () => {
		const route = trackRoute();
		const records = parseNestedEventRecords(`${JSON.stringify({
			type: "subagent.nested.started",
			ts: 100,
			rootRunId: route.rootRunId,
			parentRunId: "root-run",
			parentStepIndex: 1,
			capabilityToken: route.capabilityToken,
			child: child("jsonl-good", "running", 100),
		})}\n{"type":"subagent.nested.started"`, route);
		assert.equal(records.length, 1);
		assert.equal(records[0]?.child.id, "jsonl-good");
	});
});
