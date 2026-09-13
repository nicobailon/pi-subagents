import { createHook } from "node:async_hooks";
import { runWorkflowScript } from "../../src/workflows/scripted-workflow.ts";

if (!process.send) throw new Error("cwd fixture requires IPC");

const originalChdir = process.chdir;
const workerInitCwds: string[] = [];
let chdirCalls = 0;
process.chdir = ((directory: string) => {
  chdirCalls += 1;
  return originalChdir(directory);
}) as typeof process.chdir;
createHook({
  init(_asyncId, type) {
    if (type === "WORKER") workerInitCwds.push(process.cwd());
  },
}).enable();

process.send({ type: "ready", cwd: process.cwd() });
process.once("message", async (message: unknown) => {
  try {
    const result = await runWorkflowScript({
      processCwd: String((message as { processCwd: unknown }).processCwd),
      script: `return "recovered";`,
      async launch(key) { return { key, ok: true, output: "ok", artifactPaths: [] }; },
      async status(key) { return { key, ok: true, output: "ok", artifactPaths: [] }; },
    });
    process.send?.({ type: "result", ok: true, value: result.value, chdirCalls, workerInitCwds });
  } catch (error) {
    process.send?.({
      type: "result",
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      cause: error instanceof Error && error.cause instanceof Error ? error.cause.message : undefined,
    });
  }
});
