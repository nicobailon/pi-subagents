import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { buildInProcessChildLaunch } from "../../src/runs/shared/child-launch.ts";

const base = { parentSessionId: "parent", sessionEnabled: false, inheritProjectContext: false, inheritGlobalContext: false, inheritSkills: false, cwd: process.cwd(), childAgentName: "review", childIndex: 0, runId: "new-run", host: "parent" as const, allowNestedSubagents: false, tools: ["read"] };
test("launch installs trace bridge without changing declared tool plan", () => {
 const key = Symbol.for("pi.langfuse.contexts.v1");
 const globals = globalThis as unknown as Record<symbol, unknown>;
 globals[key] = new Map([["parent", { traceId: "a".repeat(32), spanId: "b".repeat(16), rootSessionId: "root", depth: 0 }]]);
 try {
  const launch = buildInProcessChildLaunch(base);
  delete globals[key];
  const hook = launch.session.hooks.find(h => h.name === "pi-subagents:trace-parent");
  assert.ok(hook, "child launch must register session-local trace bridge");
  let listener: ((payload: unknown) => void) | undefined;
  hook.factory({ events: { on: (_: string, fn: typeof listener) => { listener = fn; } } } as never);
  let context: any;
  listener?.({ reply: (value: unknown) => { context = value; } });
  assert.equal(context.spanId, "b".repeat(16));
  assert.equal(context.runId, "new-run"); assert.equal(context.agent, "review"); assert.equal(context.childIndex, 0);
  assert.equal(launch.config.fanoutChild, false);
  assert.ok(launch.session.tools?.includes("read"));
  assert.equal(launch.session.processEnv, undefined);
 } finally { delete globals[key]; }
});
test("both detached launch paths persist snapshots and runner routes them through all execution contexts", () => {
 const asyncSource = readFileSync(new URL("../../src/runs/background/async-execution.ts", import.meta.url), "utf8");
 const runnerSource = readFileSync(new URL("../../src/runs/background/subagent-runner.ts", import.meta.url), "utf8");
 assert.equal((asyncSource.match(/traceParent: captureTraceParent\(/g) ?? []).length, 2);
 assert.match(asyncSource, /sourceRunId: params\.revivalLease\?\.sourceRunId/);
 assert.equal((runnerSource.match(/traceParent: config\.traceParent/g) ?? []).length, 3);
 assert.match(runnerSource, /traceParent: ctx\.traceParent/);
});
