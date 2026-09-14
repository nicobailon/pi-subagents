import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { captureTraceParent, resolveTraceParent, traceParentHook } from "../../src/runs/shared/trace-parent.ts";

const key = Symbol.for("pi.langfuse.contexts.v1");
const globals = globalThis as unknown as Record<symbol, unknown>;
const traceId = "a".repeat(32), spanId = "b".repeat(16);
const root = () => ({ traceId, spanId, rootSessionId: "root", depth: 0 });
afterEach(() => { delete globals[key]; });
function request(context: ReturnType<typeof captureTraceParent>) {
 const handlers = new Map<string, (data: unknown) => void>();
 traceParentHook(context).factory({ events: { on: (name: string, fn: (data: unknown) => void) => { handlers.set(name, fn); } } } as never);
 let reply: unknown;
 handlers.get("pi:trace-parent-request")?.({ reply: (value: unknown) => { reply = value; } });
 return reply;
}
test("foreground siblings capture exact parents and retain independent role/run/index", async () => {
 globals[key] = new Map([["parent", root()]]);
 const first = resolveTraceParent({ parentSessionId: "parent", depth: 1, runId: "run", agent: "research", childIndex: 0 });
 const second = resolveTraceParent({ parentSessionId: "parent", depth: 1, runId: "run", agent: "review", childIndex: 1 });
 const replies = await Promise.all([Promise.resolve(request(first)), Promise.resolve(request(second))]);
 assert.deepEqual(replies, [first, second]);
 assert.equal(first.spanId, spanId); assert.equal(second.spanId, spanId);
 assert.equal(first.agent, "research"); assert.equal(second.childIndex, 1);
 assert.equal(Object.hasOwn(first, "parentToolCallId"), false);
 assert.equal(Object.isFrozen(first), true);
});
test("background JSON envelope survives parent completion before child start", () => {
 const parent = root(); globals[key] = new Map([["parent", parent]]);
 const config = JSON.parse(JSON.stringify({ traceParent: captureTraceParent("parent", 1) }));
 parent.spanId = "c".repeat(16); delete globals[key];
 const child = resolveTraceParent({ parentSessionId: "parent", depth: 1, runId: "bg", agent: "worker", childIndex: 2 }, config.traceParent, false);
 assert.equal((request(child) as typeof child).spanId, spanId);
});
test("resumed new run with same child session uses current caller envelope", () => {
 globals[key] = new Map([["current", { ...root(), spanId: "d".repeat(16) }]]);
 const serialized = JSON.parse(JSON.stringify({ sessionFile: "/same-child.jsonl", traceParent: captureTraceParent("current", 1) }));
 const child = resolveTraceParent({ parentSessionId: "current", depth: 1, runId: "new", sourceRunId: "old", agent: "worker", childIndex: 0 }, serialized.traceParent, false);
 assert.equal(child.spanId, "d".repeat(16)); assert.equal(child.runId, "new"); assert.equal(child.sourceRunId, "old");
 assert.equal(serialized.sessionFile, "/same-child.jsonl");
});
test("malformed, zero IDs, wrong scope and absent parents stay explicit orphans", () => {
 for (const value of [{ ...root(), traceId: "bad" }, { ...root(), spanId: "0".repeat(16) }, null]) {
  globals[key] = new Map([["parent", value]]);
  assert.equal(captureTraceParent("parent", 1).traceId, undefined);
 }
 globals[key] = new Map([["other", root()]]);
 assert.equal(captureTraceParent("parent", 1).spanId, undefined);
 assert.equal(resolveTraceParent({ parentSessionId: "parent", depth: 1 }, { ...root(), parentSessionId: "other" }, false).traceId, undefined);
 assert.equal(request(captureTraceParent(undefined, 1)) !== undefined, true);
});
test("runner never reads mutable global context when serialized parent is absent", () => {
 globals[key] = new Map([["parent", root()]]);
 assert.equal(resolveTraceParent({ parentSessionId: "parent", depth: 1 }, undefined, false).traceId, undefined);
});
