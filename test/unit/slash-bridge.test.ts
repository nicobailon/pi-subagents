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
});
