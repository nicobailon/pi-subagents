import { runWorkflowScript } from "../../src/workflows/scripted-workflow.ts";

if (!process.send) throw new Error("stale cwd fixture requires IPC");
process.send({ type: "ready" });
process.once("message", async (message: unknown) => {
  const processCwd = message && typeof message === "object" && "processCwd" in message
    ? String((message as { processCwd: unknown }).processCwd)
    : "";
  try {
    const result = await runWorkflowScript({
      processCwd,
      script: `return "recovered";`,
      async launch(key) { return { key, ok: true, output: "ok", artifactPaths: [] }; },
      async status(key) { return { key, ok: true, output: "ok", artifactPaths: [] }; },
    });
    process.send?.({ type: "result", ok: true, value: result.value });
  } catch (error) {
    process.send?.({
      type: "result",
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
