import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const binary = process.env.PI_SUBAGENTS_WORKFLOW_BUN_SMOKE_BINARY;
const packageRoot = process.env.PI_SUBAGENTS_WORKFLOW_BUN_SMOKE_PACKAGE_ROOT;
const workflowModule = packageRoot
	? pathToFileURL(path.resolve(packageRoot, "src/workflows/scripted-workflow.js")).href
	: new URL("../../src/workflows/scripted-workflow.ts", import.meta.url).href;

// Opt-in native gate: this specifically needs a Bun-compiled Pi, not Node's SDK.
// The cache is isolated but deliberately enabled across consecutive processes.
for (const scenario of [
	{ name: "constant workflows survive a warm Bun cache", script: "return 42;", expected: 42 },
	{ name: "child results survive a warm Bun cache", script: 'const child = await runs.run("review", {agent:"reviewer",task:"Read-only test"}); return child.output;', expected: "result:review" },
]) {
	test(scenario.name, { skip: !binary && "Set PI_SUBAGENTS_WORKFLOW_BUN_SMOKE_BINARY to a standalone Pi executable", timeout: 60_000 }, t => {
		assert.ok(binary, "native cache regression must run against the requested standalone executable");
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-workflow-bun-cache-"));
		t.after(() => fs.rmSync(root, { recursive: true, force: true }));
		const extension = path.join(root, "probe.ts");
		const resultFile = path.join(root, "result.json");
		fs.writeFileSync(extension, `
import { writeFileSync } from "node:fs";
import { runWorkflowScript } from ${JSON.stringify(workflowModule)};
export default function(pi) {
  pi.on("session_start", async () => {
    try {
      if (!process.versions.bun) throw new Error("The test binary must use Bun");
      const result = await runWorkflowScript({
        script: ${JSON.stringify(scenario.script)}, timeoutMs: 5000,
        launch: async key => ({key, ok:true, output:"result:" + key, artifactPaths:[]}),
        status: async key => ({key, ok:true, output:"status:" + key, artifactPaths:[]})
      });
      writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify(result.value));
      process.exit(0);
    } catch (error) { console.error(error); process.exit(1); }
  });
}
`);
		const env = { ...process.env, PI_CODING_AGENT_DIR: path.join(root, "profile"), PI_OFFLINE: "1", BUN_RUNTIME_TRANSPILER_CACHE_PATH: path.join(root, "cache") };
		for (const phase of ["cold", "warm", "warm-repeat"]) {
			fs.rmSync(resultFile, { force: true });
			const result = spawnSync(binary, ["--offline", "--no-approve", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-session", "--mode", "rpc", "--extension", extension], { cwd: root, env, encoding: "utf8", timeout: 15_000, windowsHide: true });
			assert.equal(result.status, 0, `${phase}: a workflow must not abort the parent Pi process: ${result.error?.message ?? result.stderr}`);
			assert.ok(fs.existsSync(resultFile), `${phase}: the extension must actually execute, not silently exit after a load failure: ${result.stderr}`);
			assert.equal(fs.readFileSync(resultFile, "utf8"), JSON.stringify(scenario.expected), `${phase}: a successful workflow must preserve the exact result`);
		}
	});
}
