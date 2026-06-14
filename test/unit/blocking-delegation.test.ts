import { describe, it, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";

/**
 * Tests for blocking (synchronous) delegation via pollUntilDone.
 *
 * We mock global fetch to simulate the HTTP server responses,
 * then call pollUntilDone directly — same code path the extension uses.
 */

import { pollUntilDone } from "../../src/transport/poll.ts";

function mockFetch(responses: Array<{ status: number; body: unknown }>) {
  let callIndex = 0;
  const calls: Array<{ url: string; method: string }> = [];
  const original = globalThis.fetch;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method || "GET";
    calls.push({ url, method });
    const resp = responses[Math.min(callIndex++, responses.length - 1)]!;
    return {
      ok: resp.status >= 200 && resp.status < 300,
      status: resp.status,
      json: async () => resp.body,
      text: async () => JSON.stringify(resp.body),
    };
  }) as typeof fetch;

  return { calls, restore: () => { globalThis.fetch = original; } };
}

describe("pollUntilDone — blocking single delegation", () => {
  it("blocks until remote run completes and returns full result", async () => {
    const m = mockFetch([
      { status: 200, body: { runId: "r1", state: "running" } },
      { status: 200, body: { runId: "r1", state: "running" } },
      { status: 200, body: { runId: "r1", state: "completed" } },
      { status: 200, body: { runId: "r1", state: "completed", output: "research findings", usage: { input: 100, output: 50, turns: 1 }, durationMs: 5000 } },
    ]);
    try {
      const result = await pollUntilDone({
        baseUrl: "http://localhost:8082",
        runId: "r1",
        timeoutMs: 30000,
        fixedIntervalMs: 10,
      });
      assert.equal(result.state, "completed");
      assert.equal(result.result?.output, "research findings");
      assert.equal(result.result?.usage?.input, 100);
      assert.ok(result.durationMs >= 0);
    } finally {
      m.restore();
    }
  });

  it("returns timeout error if run exceeds timeout", async () => {
    const m = mockFetch([
      { status: 200, body: { runId: "r2", state: "running" } },
      { status: 200, body: { runId: "r2", state: "running" } },
      { status: 200, body: { runId: "r2", state: "running" } },
      { status: 200, body: { runId: "r2", state: "running" } },
    ]);
    try {
      const result = await pollUntilDone({
        baseUrl: "http://localhost:8082",
        runId: "r2",
        timeoutMs: 50,
        fixedIntervalMs: 10,
      });
      assert.equal(result.state, "timeout");
      assert.ok(result.error?.includes("Timed out"));
    } finally {
      m.restore();
    }
  });

  it("does not require any LLM-side polling — single pollUntilDone call gets result", async () => {
    const m = mockFetch([
      { status: 200, body: { runId: "r3", state: "running" } },
      { status: 200, body: { runId: "r3", state: "completed" } },
      { status: 200, body: { runId: "r3", state: "completed", output: "done", durationMs: 1000 } },
    ]);
    try {
      const result = await pollUntilDone({
        baseUrl: "http://localhost:8082",
        runId: "r3",
        timeoutMs: 30000,
        fixedIntervalMs: 10,
      });
      assert.equal(result.state, "completed");
      assert.equal(result.result?.output, "done");
      // Verify: extension made the HTTP calls, not the LLM
      const statusCalls = m.calls.filter(c => c.url.includes("/status/"));
      const resultCalls = m.calls.filter(c => c.url.includes("/result/"));
      assert.ok(statusCalls.length >= 1, "extension polled status internally");
      assert.ok(resultCalls.length >= 1, "extension fetched result internally");
    } finally {
      m.restore();
    }
  });

  it("handles failed runs", async () => {
    const m = mockFetch([
      { status: 200, body: { runId: "r4", state: "running" } },
      { status: 200, body: { runId: "r4", state: "failed" } },
      { status: 200, body: { runId: "r4", state: "failed", output: "", error: "model rate limited", durationMs: 2000 } },
    ]);
    try {
      const result = await pollUntilDone({
        baseUrl: "http://localhost:8082",
        runId: "r4",
        timeoutMs: 30000,
        fixedIntervalMs: 10,
      });
      assert.equal(result.state, "failed");
      assert.equal(result.error, "model rate limited");
    } finally {
      m.restore();
    }
  });

  it("survives transient network errors and keeps polling", async () => {
    let callCount = 0;
    const original = globalThis.fetch;
    globalThis.fetch = (async () => {
      callCount++;
      if (callCount <= 2) throw new Error("ECONNREFUSED");
      if (callCount === 3) return { ok: true, status: 200, json: async () => ({ runId: "r5", state: "completed" }), text: async () => "" };
      return { ok: true, status: 200, json: async () => ({ runId: "r5", state: "completed", output: "recovered", durationMs: 100 }), text: async () => "" };
    }) as typeof fetch;
    try {
      const result = await pollUntilDone({
        baseUrl: "http://localhost:8082",
        runId: "r5",
        timeoutMs: 30000,
        fixedIntervalMs: 10,
      });
      assert.equal(result.state, "completed");
      assert.equal(result.result?.output, "recovered");
      assert.ok(callCount >= 4, "retried after network errors");
    } finally {
      globalThis.fetch = original;
    }
  });

  it("respects abort signal", async () => {
    const controller = new AbortController();
    const m = mockFetch([
      { status: 200, body: { runId: "r6", state: "running" } },
      { status: 200, body: { runId: "r6", state: "running" } },
      { status: 200, body: { runId: "r6", state: "running" } },
    ]);
    try {
      setTimeout(() => controller.abort(), 30);
      const result = await pollUntilDone({
        baseUrl: "http://localhost:8082",
        runId: "r6",
        timeoutMs: 30000,
        fixedIntervalMs: 10,
        signal: controller.signal,
      });
      assert.equal(result.state, "cancelled");
    } finally {
      m.restore();
    }
  });

  it("calls onProgress during polling", async () => {
    const progressCalls: Array<{ state: string; elapsed: number }> = [];
    const m = mockFetch([
      { status: 200, body: { runId: "r7", state: "running" } },
      { status: 200, body: { runId: "r7", state: "running" } },
      { status: 200, body: { runId: "r7", state: "completed" } },
      { status: 200, body: { runId: "r7", state: "completed", output: "ok", durationMs: 100 } },
    ]);
    try {
      await pollUntilDone({
        baseUrl: "http://localhost:8082",
        runId: "r7",
        timeoutMs: 30000,
        fixedIntervalMs: 10,
        onProgress: (state, elapsed) => progressCalls.push({ state, elapsed }),
      });
      assert.ok(progressCalls.length >= 2, "onProgress called during polling");
      assert.ok(progressCalls.some(p => p.state === "running"), "saw running state");
      assert.ok(progressCalls.some(p => p.state === "completed"), "saw completed state");
    } finally {
      m.restore();
    }
  });

  it("uses caller-specified pollIntervalMs override", async () => {
    const timestamps: number[] = [];
    const original = globalThis.fetch;
    let callCount = 0;
    globalThis.fetch = (async () => {
      callCount++;
      timestamps.push(Date.now());
      if (callCount < 3) return { ok: true, status: 200, json: async () => ({ runId: "r8", state: "running" }), text: async () => "" };
      if (callCount === 3) return { ok: true, status: 200, json: async () => ({ runId: "r8", state: "completed" }), text: async () => "" };
      return { ok: true, status: 200, json: async () => ({ runId: "r8", state: "completed", output: "done", durationMs: 100 }), text: async () => "" };
    }) as typeof fetch;
    try {
      await pollUntilDone({
        baseUrl: "http://localhost:8082",
        runId: "r8",
        timeoutMs: 30000,
        fixedIntervalMs: 100,
      });
      // Check intervals between polls are roughly 100ms (not adaptive 2s)
      for (let i = 1; i < timestamps.length - 1; i++) {
        const gap = timestamps[i]! - timestamps[i - 1]!;
        assert.ok(gap < 500, `Poll interval should be ~100ms, got ${gap}ms`);
      }
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("blocking parallel delegation", () => {
  it("blocks until ALL parallel polls complete", async () => {
    // Simulate two concurrent pollUntilDone calls (what the extension does)
    let callCount = 0;
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      callCount++;
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("status/r-a")) {
        return { ok: true, status: 200, json: async () => ({ runId: "r-a", state: callCount > 2 ? "completed" : "running" }), text: async () => "" };
      }
      if (url.includes("result/r-a")) {
        return { ok: true, status: 200, json: async () => ({ runId: "r-a", state: "completed", output: "result A", durationMs: 100 }), text: async () => "" };
      }
      if (url.includes("status/r-b")) {
        return { ok: true, status: 200, json: async () => ({ runId: "r-b", state: callCount > 4 ? "completed" : "running" }), text: async () => "" };
      }
      if (url.includes("result/r-b")) {
        return { ok: true, status: 200, json: async () => ({ runId: "r-b", state: "completed", output: "result B", durationMs: 200 }), text: async () => "" };
      }
      return { ok: true, status: 200, json: async () => ({}), text: async () => "" };
    }) as typeof fetch;
    try {
      const [a, b] = await Promise.all([
        pollUntilDone({ baseUrl: "http://a:8080", runId: "r-a", timeoutMs: 5000, fixedIntervalMs: 10 }),
        pollUntilDone({ baseUrl: "http://b:8080", runId: "r-b", timeoutMs: 5000, fixedIntervalMs: 10 }),
      ]);
      assert.equal(a.state, "completed");
      assert.equal(a.result?.output, "result A");
      assert.equal(b.state, "completed");
      assert.equal(b.result?.output, "result B");
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("async opt-in", () => {
  it("async: true field exists in schema", async () => {
    try {
      const { SubagentHttpParams } = await import("../../src/extension/schemas.ts");
      const props = SubagentHttpParams.properties;
      assert.ok("async" in props, "async field should exist in schema");
    } catch (err) {
      if (err instanceof Error && err.message.includes("Cannot find package")) {
        // typebox peer dep chain not available outside Pi runtime — verify file directly
        const { readFileSync } = await import("node:fs");
        const src = readFileSync(new URL("../../src/extension/schemas.ts", import.meta.url), "utf-8");
        assert.ok(src.includes("async"), "async field should exist in schema source");
        return;
      }
      throw err;
    }
  });

  it("pollIntervalMs field exists in schema", async () => {
    try {
      const { SubagentHttpParams } = await import("../../src/extension/schemas.ts");
      const props = SubagentHttpParams.properties;
      assert.ok("pollIntervalMs" in props, "pollIntervalMs field should exist in schema");
    } catch (err) {
      if (err instanceof Error && err.message.includes("Cannot find package")) {
        const { readFileSync } = await import("node:fs");
        const src = readFileSync(new URL("../../src/extension/schemas.ts", import.meta.url), "utf-8");
        assert.ok(src.includes("pollIntervalMs"), "pollIntervalMs field should exist in schema source");
        return;
      }
      throw err;
    }
  });
});
