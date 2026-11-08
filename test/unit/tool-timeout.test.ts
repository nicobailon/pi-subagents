import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	DEFAULT_FAST_TOOL_TIMEOUT_MS,
	DEFAULT_FAST_TOOL_TIMEOUT_TOOLS,
	TOOL_TIMEOUT_ALLOWLIST,
	TOOL_TIMEOUT_ENV,
	defaultToolTimeoutMs,
	effectiveToolTimeoutMs,
	formatToolTimeoutMessage,
	isToolTimeoutExempt,
	resolveToolTimeoutMs,
	toolTimeoutCallKey,
	toolTimeoutFromEnv,
} from "../../src/runs/shared/tool-timeout.ts";

import { createActiveRuntimeTimeout, createSupervisorWaitTracker, isBlockingSupervisorTool } from "../../src/runs/shared/active-runtime-timeout.ts";

describe("active runtime timeout", () => {
	it("keeps the remaining budget across repeated and overlapping waits", (t) => {
		t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
		let expired = 0;
		const clock = createActiveRuntimeTimeout(100);
		clock.start(() => expired++);
		t.mock.timers.tick(30);
		clock.setWaiting("a", true);
		t.mock.timers.tick(1000);
		clock.setWaiting("b", true);
		clock.setWaiting("a", false);
		t.mock.timers.tick(1000);
		assert.equal(expired, 0);
		assert.equal(clock.remainingMs(), 70);
		clock.setWaiting("b", false);
		t.mock.timers.tick(20);
		clock.setWaiting("a", true);
		t.mock.timers.tick(1000);
		clock.setWaiting("a", false);
		t.mock.timers.tick(49);
		assert.equal(expired, 0);
		t.mock.timers.tick(1);
		assert.equal(expired, 1);
		clock.dispose();
	});

	it("exposes a finite sliding deadline estimate while paused without consuming budget", (t) => {
		t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
		const clock = createActiveRuntimeTimeout(100);
		clock.start(() => assert.fail("paused budget expired"));
		t.mock.timers.tick(30);
		clock.setWaiting("ask", true);
		assert.equal(clock.deadlineAt(), 1100);
		t.mock.timers.tick(5000);
		assert.equal(clock.remainingMs(), 70);
		assert.equal(clock.deadlineAt(), 6100);
		clock.setWaiting("ask", false);
		t.mock.timers.tick(60);
		assert.equal(clock.deadlineAt(), 6100);
		assert.equal(clock.remainingMs(), 10);
		clock.dispose();
	});

	it("cleans up cancellation and retains active budget between attempts", (t) => {
		t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
		let expired = 0;
		const clock = createActiveRuntimeTimeout(100);
		clock.start(() => expired++);
		t.mock.timers.tick(40);
		clock.setWaiting("cancelled", true);
		clock.stop();
		clock.setWaiting("cancelled", false);
		t.mock.timers.tick(1000);
		clock.start(() => expired++);
		t.mock.timers.tick(59);
		assert.equal(expired, 0);
		clock.dispose();
		t.mock.timers.tick(1000);
		assert.equal(expired, 0);
	});

	it("tracks overlapping call ids, progress and result-only completion without leaking waits", (t) => {
		t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
		let expired = 0;
		const clock = createActiveRuntimeTimeout(100);
		clock.start(() => expired++);
		const tracker = createSupervisorWaitTracker(clock.setWaiting);
		tracker.observe({ type: "tool_execution_start", toolName: "contact_supervisor", toolCallId: "a", args: { reason: "need_decision" } });
		tracker.observe({ type: "tool_execution_start", toolName: "contact_supervisor", toolCallId: "progress", args: { reason: "progress_update" } });
		tracker.observe({ type: "tool_execution_start", toolName: "intercom", toolCallId: "b", args: { action: "ask" } });
		tracker.observe({ type: "tool_execution_end", toolName: "contact_supervisor", toolCallId: "progress" });
		tracker.observe({ type: "tool_result_end", message: { toolCallId: "a", toolName: "contact_supervisor" } });
		t.mock.timers.tick(1000);
		assert.equal(expired, 0);
		tracker.dispose();
		t.mock.timers.tick(100);
		assert.equal(expired, 1);
		clock.dispose();
	});

	it("pauses only blocking coordination, never progress updates", () => {
		assert.equal(isBlockingSupervisorTool("contact_supervisor", { reason: "need_decision" }), true);
		assert.equal(isBlockingSupervisorTool("contact_supervisor", { reason: "interview_request" }), true);
		assert.equal(isBlockingSupervisorTool("intercom", { action: "ask" }), true);
		assert.equal(isBlockingSupervisorTool("contact_supervisor", { reason: "progress_update" }), false);
		assert.equal(isBlockingSupervisorTool("intercom", { action: "send" }), false);
	});
});

describe("resolveToolTimeoutMs", () => {
	it("has no configured hard timeout when nothing is configured anywhere", () => {
		assert.deepEqual(resolveToolTimeoutMs({}), {});
	});

	it("honors precedence: per-call > agent frontmatter > config > env", () => {
		const input = {
			callValue: 1_000,
			agentValue: 2_000,
			configValue: 3_000,
			envValue: "4000",
		};
		assert.deepEqual(resolveToolTimeoutMs(input), { toolTimeoutMs: 1_000 });
		assert.deepEqual(resolveToolTimeoutMs({ ...input, callValue: undefined }), { toolTimeoutMs: 2_000 });
		assert.deepEqual(resolveToolTimeoutMs({ ...input, callValue: undefined, agentValue: undefined }), {
			toolTimeoutMs: 3_000,
		});
		assert.deepEqual(
			resolveToolTimeoutMs({ ...input, callValue: undefined, agentValue: undefined, configValue: undefined }),
			{ toolTimeoutMs: 4_000 },
		);
	});

	it("accepts the env value as a plain integer string", () => {
		assert.deepEqual(
			resolveToolTimeoutMs({ envValue: "60000", callValue: undefined, agentValue: undefined, configValue: undefined }),
			{ toolTimeoutMs: 60_000 },
		);
	});

	it("rejects non-positive, non-integer, and oversized values with an error", () => {
		for (const bad of [0, -1, 1.5, "abc", Number.NaN]) {
			const r = resolveToolTimeoutMs({ callValue: bad });
			assert.ok(r.error, `expected error for ${String(bad)}`);
			assert.match(r.error!, /positive integer/);
		}
		const huge = resolveToolTimeoutMs({ callValue: 2_147_483_648 });
		assert.ok(huge.error);
		assert.match(huge.error!, /no larger than/);
	});

	it("ignores an empty env string (treated as unset)", () => {
		assert.deepEqual(resolveToolTimeoutMs({ envValue: "  " }), {});
	});
});

describe("effectiveToolTimeoutMs", () => {
	it("uses a default hard timeout only for known-fast tools", () => {
		for (const tool of ["read", "grep", "find", "ls", "edit", "write", "structured_output"]) {
			assert.equal(defaultToolTimeoutMs(tool), DEFAULT_FAST_TOOL_TIMEOUT_MS, tool);
			assert.equal(effectiveToolTimeoutMs(tool, undefined), DEFAULT_FAST_TOOL_TIMEOUT_MS, tool);
		}
		assert.equal(defaultToolTimeoutMs("bash"), undefined);
		assert.equal(effectiveToolTimeoutMs("bash", undefined), undefined);
		assert.deepEqual([...DEFAULT_FAST_TOOL_TIMEOUT_TOOLS].sort(), ["edit", "find", "grep", "ls", "read", "structured_output", "write"]);
	});

	it("lets an explicit configured timeout win for non-exempt tools", () => {
		assert.equal(effectiveToolTimeoutMs("bash", 1234), 1234);
		assert.equal(effectiveToolTimeoutMs("read", 1234), 1234);
	});

	it("never applies a tool timeout to blocking coordination tools", () => {
		for (const tool of ["contact_supervisor", "intercom", "bg_wait"]) {
			assert.equal(isToolTimeoutExempt(tool), true, `${tool} must be exempt`);
			assert.equal(effectiveToolTimeoutMs(tool, 1234), undefined);
			assert.equal(effectiveToolTimeoutMs(tool, undefined), undefined);
		}
		assert.equal(isToolTimeoutExempt("bash"), false);
		assert.equal(isToolTimeoutExempt(undefined), false);
		assert.deepEqual([...TOOL_TIMEOUT_ALLOWLIST].sort(), ["bg_wait", "contact_supervisor", "intercom"]);
	});
});

describe("tool timeout formatting and keys", () => {
	it("formats timeout errors consistently", () => {
		assert.equal(formatToolTimeoutMessage("bash", 1000), "Tool 'bash' exceeded its timeout of 1000ms.");
	});

	it("uses toolCallId when present and falls back to an anonymous sequence", () => {
		assert.equal(toolTimeoutCallKey({ toolCallId: "call-1", toolName: "read" }, 9), "id:call-1");
		assert.equal(toolTimeoutCallKey({ toolName: "read" }, 9), "anon:read:9");
	});
});

describe("toolTimeoutFromEnv", () => {
	it("reads PI_SUBAGENT_TOOL_TIMEOUT_MS from the process env", () => {
		assert.equal(TOOL_TIMEOUT_ENV, "PI_SUBAGENT_TOOL_TIMEOUT_MS");
		assert.equal(toolTimeoutFromEnv({ PI_SUBAGENT_TOOL_TIMEOUT_MS: "123" }), "123");
		assert.equal(toolTimeoutFromEnv({}), undefined);
	});
});
