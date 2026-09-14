import assert from "node:assert/strict";
import childProcess from "node:child_process";
import * as nodeModule from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { mock } from "node:test";

const installed = process.argv[2];
const piEntry = process.argv[3];
assert.ok(installed && path.isAbsolute(installed));
assert.ok(piEntry && path.isAbsolute(piEntry));
assert.match(installed, /[/\\]node_modules[/\\]/);
process.argv[1] = piEntry;
const require = nodeModule.createRequire(path.join(installed, "package.json"));
const jitiPackage = require.resolve("jiti/package.json");
const { createJiti } = await import(pathToFileURL(path.join(path.dirname(jitiPackage), "lib/jiti.mjs")).href);
const jiti = createJiti(import.meta.url, { fsCache: false });
const { executeAsyncSingle } = await jiti.import(path.join(installed, "src/runs/background/async-execution.js"));
const spawn = mock.method(childProcess, "spawn", () => { throw new Error("packed spawn captured"); });
nodeModule.syncBuiltinESMExports();
const result = executeAsyncSingle("packed-selection", {
	agent: "worker",
	task: "Inspect packed launch",
	agentConfig: {
		name: "worker", description: "packed selector", systemPrompt: "", systemPromptMode: "replace",
		inheritGlobalContext: false, inheritProjectContext: false, inheritSkills: false,
	},
	ctx: { pi: { events: { emit() {} } }, cwd: process.cwd(), currentSessionId: "packed-selector" },
	artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
	shareEnabled: false,
	maxSubagentDepth: 1,
	acceptance: false,
});
assert.equal(result.isError, true);
assert.match(result.content[0].text, /packed spawn captured/);
assert.equal(spawn.mock.callCount(), 1);
const [, args, options] = spawn.mock.calls[0].arguments;
assert.match(args.at(-2), /[/\\]subagent-runner\.js$/);
assert.doesNotMatch(args.join(" "), /jiti-cli\.mjs/);
assert.equal(args.includes("--experimental-strip-types"), false);
assert.equal(options.env.PI_ASYNC_NATIVE_RUNNER, "1");
assert.equal(options.env.PI_ASYNC_COMPILED_RUNNER, "1");
console.log("PASS packed node_modules selects compiled JavaScript");
