import { runWorkflowScript } from "../../src/workflows/scripted-workflow.ts";

try {
  const result = await runWorkflowScript({
    script: `const child = await runs.run("probe", { agent: "scout", task: "ping" }); return { output: child.output };`,
    async launch(key) { return { key, ok: true, output: "pong", artifactPaths: [] }; },
    async status(key) { return { key, ok: true, output: "pong", artifactPaths: [] }; },
  });
  process.stdout.write(JSON.stringify({ ok: true, value: result.value }));
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
}
