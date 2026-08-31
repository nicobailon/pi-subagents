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
