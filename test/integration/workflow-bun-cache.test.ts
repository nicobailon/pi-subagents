import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { pathToFileURL } from "node:url";

const binary = process.env.PI_SUBAGENTS_WORKFLOW_BUN_SMOKE_BINARY;
const packageRoot = process.env.PI_SUBAGENTS_WORKFLOW_BUN_SMOKE_PACKAGE_ROOT;
const workflowModule = packageRoot
	? pathToFileURL(path.resolve(packageRoot, "src/workflows/scripted-workflow.js")).href
	: new URL("../../src/workflows/scripted-workflow.ts", import.meta.url).href;

// Opt-in native gate: this specifically needs a Bun-compiled Pi, not Node's SDK.
// The cache is isolated but deliberately enabled across consecutive processes.
function runWarmPhases(t: TestContext, pi: string, probe: (root: string, resultFile: string) => string, check: (result: string, phase: string) => void): void {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-workflow-bun-cache-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const extension = path.join(root, "probe.ts");
	const resultFile = path.join(root, "result.json");
	fs.writeFileSync(extension, probe(root, resultFile));
	const env = { ...process.env, PI_CODING_AGENT_DIR: path.join(root, "profile"), PI_OFFLINE: "1", BUN_RUNTIME_TRANSPILER_CACHE_PATH: path.join(root, "cache") };
	for (const phase of ["cold", "warm", "warm-repeat"]) {
		fs.rmSync(resultFile, { force: true });
		const result = spawnSync(pi, ["--offline", "--no-approve", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-session", "--mode", "rpc", "--extension", extension], { cwd: root, env, encoding: "utf8", timeout: 15_000, windowsHide: true });
		assert.equal(result.status, 0, `${phase}: a workflow must not abort the parent Pi process: ${result.error?.message ?? result.stderr}`);
		assert.ok(fs.existsSync(resultFile), `${phase}: the extension must actually execute, not silently exit after a load failure: ${result.stderr}`);
		check(fs.readFileSync(resultFile, "utf8"), phase);
	}
}

test("child results survive a warm Bun cache", { skip: !binary && "Set PI_SUBAGENTS_WORKFLOW_BUN_SMOKE_BINARY to a standalone Pi executable", timeout: 60_000 }, t => {
	assert.ok(binary, "native cache regression must run against the requested standalone executable");
	runWarmPhases(t, binary, (_root, resultFile) => `
import { writeFileSync } from "node:fs";
import { runWorkflowScript } from ${JSON.stringify(workflowModule)};
export default function(pi) {
  pi.on("session_start", async () => {
    try {
      if (!process.versions.bun) throw new Error("The test binary must use Bun");
      const result = await runWorkflowScript({
        script: 'const child = await runs.run("review", {agent:"reviewer",task:"Read-only test"}); return child.output;', timeoutMs: 5000,
        launch: async key => ({key, ok:true, output:"result:" + key, artifactPaths:[]}),
        status: async key => ({key, ok:true, output:"status:" + key, artifactPaths:[]})
      });
      writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify(result.value));
      process.exit(0);
    } catch (error) { console.error(error); process.exit(1); }
  });
}
`, (result, phase) => assert.equal(result, JSON.stringify("result:review"), `${phase}: a successful workflow must preserve the exact result`));
});

test("the published extension completes async workflows with a warm Bun cache", {
	skip: (!binary || !packageRoot) && "Set PI_SUBAGENTS_WORKFLOW_BUN_SMOKE_BINARY and PI_SUBAGENTS_WORKFLOW_BUN_SMOKE_PACKAGE_ROOT",
	timeout: 60_000,
}, t => {
	assert.ok(binary && packageRoot, "native package coverage requires an explicit standalone Pi and built or unpacked package");
	const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
	const entry = manifest.pi?.extensions?.[0];
	assert.equal(typeof entry, "string", "the probe must use the published extension entry rather than an internal module");
	runWarmPhases(t, binary, (root, resultFile) => {
		const workflow = path.join(root, "workflow.js");
		fs.writeFileSync(workflow, 'return {status:"ok",value:42};');
		// Test adapter only: invoke actual registered tool implementations without a
		// provider/model, while exercising the complete bundled module graph.
		return `
import { writeFileSync } from "node:fs";
import registerSubagents from ${JSON.stringify(pathToFileURL(path.resolve(packageRoot, entry)).href)};
export default function(pi) {
  const tools = new Map();
  registerSubagents(new Proxy(pi, {get(target, property) {
    if (property === "registerTool") return tool => {tools.set(tool.name, tool); return target.registerTool(tool);};
    return Reflect.get(target, property);
  }}));
  pi.on("session_start", async (_event, ctx) => {
    try {
      if (!process.versions.bun) throw new Error("The test binary must use Bun");
      const signal = new AbortController().signal;
      await tools.get("subagent").execute("cache-package-guide", {}, signal, undefined, ctx);
      const launched = await tools.get("subagent").execute("cache-package-launch", {
        workflow:${JSON.stringify(workflow)}, async:true, cwd:${JSON.stringify(root)}, output:false, options:{mission:false}
      }, signal, undefined, ctx);
      if (launched.isError) throw new Error("Workflow launch failed");
      const id = launched.details?.runId || launched.details?.asyncId;
      if (!id) throw new Error("Workflow launch did not return a run id");
      const finished = await tools.get("subagent").execute("cache-package-wait", {action:"wait", id, timeoutMs:5000}, signal, undefined, ctx);
      const completed = finished.details?.completions;
      if (completed?.length !== 1) throw new Error("Expected one terminal workflow result");
      const result = completed[0];
      writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify({state:result.state, success:result.success, inventoryComplete:result.workflowChildren?.inventoryComplete}));
      process.exit(0);
    } catch (error) { console.error(error); process.exit(1); }
  });
}
`;
	}, (result, phase) => assert.deepEqual(JSON.parse(result), { state: "complete", success: true, inventoryComplete: true }, `${phase}: a launch acknowledgement is not terminal workflow success`));
});
