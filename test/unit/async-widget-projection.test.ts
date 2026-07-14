import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { collapseRecentSuccesses, compactEvidence, displayLifecycle, formatWidgetDuration, normalizeWidgetDurationText, projectAsyncWidget, selectCompactChildren } from "../../src/tui/async-widget-projection.ts";

describe("async widget projection", () => {
	it("projects every direct snapshot step once and counts lifecycle plus overlapping attention", () => {
		const projected = projectAsyncWidget([{ asyncId: "r", asyncDir: "/tmp/r", status: "running", startedAt: 10, steps: [
			{ agent: "one", status: "pending" }, { agent: "two", status: "complete" }, { agent: "three", status: "failed", attentionReason: "retry limit" },
		] }], true, 30);
		assert.equal(projected.children.length, 3);
		assert.deepEqual(projected.counts, { running: 0, queued: 1, completed: 1, failed: 1, paused: 0, stopped: 0, attention: 1 });
		assert.equal(projected.elapsedMs, 20);
	});
	it("keeps mandatory attention/failed rows before stable running rows", () => {
		const projected = projectAsyncWidget([{ asyncId: "r", asyncDir: "/tmp/r", status: "running", steps: [
			{ agent: "run-1", status: "running" }, { agent: "failed", status: "failed" }, { agent: "warn", status: "running", attentionReason: "budget" }, { agent: "run-2", status: "running" },
		] }]);
		const selected = selectCompactChildren(projected, 1);
		assert.deepEqual(selected.rows.map((row) => row.agent), ["failed", "warn", "run-1"]);
		assert.equal(selected.hiddenRunning, 1);
	});
	it("normalizes display status and collapses adjacent success only", () => {
		assert.equal(displayLifecycle("complete"), "completed");
		const timeline = collapseRecentSuccesses([{ tool: "read", endMs: 1, outcome: "success" }, { tool: "read", endMs: 2, outcome: "success" }, { tool: "read", endMs: 3, outcome: "failed" }] );
		assert.equal(timeline.length, 2);
		assert.equal(timeline[0]?.count, 2);
		assert.equal(timeline[1]?.outcome, "failed");
	});
	it("sanitizes persisted direct, fallback, root-mode, and nested identities recursively", () => {
		const projected = projectAsyncWidget([
			{ asyncId: "root", asyncDir: "/tmp/root", status: "running", agents: ["fallback\u001b]0;bad\u0007"], steps: [{
				status: "running", currentToolArgs: "\u001b]8;url\u0007link\u001b]8;;\u0007", children: [{ id: "nested\u001b[2J", agent: undefined, currentTool: "read\u0001", children: [{ id: "deep\u009b", agent: "deep\u001b[0m" }] }],
			}] },
			{ asyncId: "mode", asyncDir: "/tmp/mode", status: "running", mode: "single\u001b[31m" as "single" },
		]);
		const child = projected.children.find((item) => item.rootId === "root")!;
		const modeChild = projected.children.find((item) => item.rootId === "mode")!;
		const nested = (child.source as { children: Array<{ id: string; currentTool?: string; children?: Array<{ id: string; agent?: string }> }> }).children[0]!;
		assert.equal(child.agent, "fallback");
		assert.equal(modeChild.agent, "single");
		assert.equal(child.source.currentToolArgs, "link");
		assert.equal(nested.id, "nested");
		assert.equal(nested.currentTool, "read");
		assert.equal(nested.children?.[0]?.id, "deep");
		assert.equal(nested.children?.[0]?.agent, "deep");
	});
	it("uses seconds as the minimum visible widget duration unit", () => {
		assert.equal(formatWidgetDuration(80), "0.08s");
		assert.equal(formatWidgetDuration(500), "0.5s");
		assert.equal(formatWidgetDuration(1_000), "1s");
		const projected = projectAsyncWidget([{ asyncId: "r", asyncDir: "/tmp/r", status: "running", updatedAt: 580, steps: [{ agent: "worker", status: "running", lastActivityAt: 500, recentToolActivities: [{ tool: "read", outcome: "success", endMs: 1, durationMs: 80 }] }] }]);
		assert.equal(compactEvidence(projected.children[0]!, true, 580), "read success · 0.08s");
		assert.doesNotMatch(compactEvidence(projected.children[0]!, true, 580) ?? "", /ms/);
		assert.equal(normalizeWidgetDurationText("Subagent timed out after 80ms."), "Subagent timed out after 0.08s.");
		assert.equal(normalizeWidgetDurationText("timeouts after 1,500ms and .5ms"), "timeouts after 1.5s and 0.0005s");
		const timedOut = projectAsyncWidget([{ asyncId: "timeout", asyncDir: "/tmp/timeout", status: "failed", steps: [{ agent: "worker", status: "failed", error: "Subagent timed out after 1,500ms and retried after .5ms." }] }]);
		assert.equal(compactEvidence(timedOut.children[0]!, true), "Subagent timed out after 1.5s and retried after 0.0005s.");
	});
});
