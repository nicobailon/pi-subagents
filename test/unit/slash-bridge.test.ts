import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { registerSlashSubagentBridge } from "../../src/slash/slash-bridge.ts";

const REQUEST = "subagent:slash:request";
const RESPONSE = "subagent:slash:response";

function eventBus() {
  const handlers = new Map<string, Array<(data: unknown) => void>>();
  return {
    on(event: string, handler: (data: unknown) => void) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return () => handlers.set(event, (handlers.get(event) ?? []).filter((h) => h !== handler));
    },
    emit(event: string, data: unknown) {
      for (const handler of handlers.get(event) ?? []) handler(data);
    },
  };
}

describe("slash subagent bridge requester context", () => {
  it("uses request ctx instead of stale fallback context when provided", async () => {
    const events = eventBus();
    const fallbackCtx = { cwd: "/fallback" } as any;
    const requestCtx = { cwd: "/request" } as any;
    let executedCtx: any;

    registerSlashSubagentBridge({
      events,
      getContext: () => fallbackCtx,
      execute: async (_id, _params, _signal, _onUpdate, ctx) => {
        executedCtx = ctx;
        return { content: [{ type: "text", text: "ok" }], details: { mode: "single", results: [] } } as any;
      },
    });

    const done = new Promise<void>((resolve, reject) => {
      events.on(RESPONSE, (data: any) => {
        try {
          assert.equal(data.isError, false);
          assert.equal(executedCtx, requestCtx);
          resolve();
        } catch (error) {
          reject(error);
        }
      });
    });

    events.emit(REQUEST, { requestId: "ctx-test", params: { action: "list" }, ctx: requestCtx });
    await done;
  });

  it("passes structured single-child execution to the direct path", async () => {
    const events = eventBus();
    let executedParams: any;
    registerSlashSubagentBridge({
      events,
      getContext: () => ({ cwd: "/repo" }) as any,
      execute: async (_id, params) => {
        executedParams = params;
        return { content: [{ type: "text", text: "ok" }], details: { mode: "workflow", results: [] } } as any;
      },
    });

    const done = new Promise<void>((resolve, reject) => {
      events.on(RESPONSE, (data: any) => {
        try {
          assert.equal(data.isError, false);
          assert.equal(executedParams.agent, "worker");
          assert.equal(executedParams.task, "work");
          assert.equal(executedParams.async, false);
          assert.equal(executedParams.output, true);
          assert.equal(executedParams.workflowScript, undefined);
          resolve();
        } catch (error) {
          reject(error);
        }
      });
    });

    events.emit(REQUEST, { requestId: "structured-single", params: { agent: "worker", task: "work", async: false } });
    await done;
  });

  it("rejects removed chain and parallel inputs before executor dispatch", async () => {
    const events = eventBus();
    let executeCalls = 0;
    registerSlashSubagentBridge({
      events,
      getContext: () => ({ cwd: "/repo" }) as any,
      execute: async () => {
        executeCalls++;
        return { content: [{ type: "text", text: "unexpected" }], details: { mode: "single", results: [] } } as any;
      },
    });

    const done = new Promise<void>((resolve, reject) => {
      events.on(RESPONSE, (data: any) => {
        try {
          assert.equal(data.isError, true);
          assert.match(data.errorText, /removed.*workflowScript/i);
          assert.equal(executeCalls, 0);
          resolve();
        } catch (error) {
          reject(error);
        }
      });
    });

    events.emit(REQUEST, { requestId: "legacy-parallel", params: { tasks: [{ agent: "worker", task: "work" }] } });
    await done;
  });
});
