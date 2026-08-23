import assert from "node:assert/strict";
import test from "node:test";
import { parseStaticRunsAllWorkflow } from "../../src/workflows/static-workflow-manifest.ts";

const lanes = [
	{ key: "scout", agent: "ultra-scout", task: "Inspect", context: "fresh", output: true },
	{ key: "worker", agent: "ultra-worker", task: "Implement", context: "fresh", model: "openai/test", worktree: true, output: true },
];

test("parses one exact static return-await-runs.all manifest", () => {
	const script = `return await runs.all(${JSON.stringify(lanes)});`;
	assert.deepEqual(parseStaticRunsAllWorkflow(script), lanes.map(({ key, ...params }) => ({ key, params })));
});

test("rejects empty, sequential, dynamic, spread, non-literal, duplicate, and extra-statement workflows", () => {
	for (const script of [
		"return await runs.all([]);",
		"return await runs.run('a',{agent:'worker'});",
		"const items=[]; return await runs.all(items);",
		"return await runs.all([{key:'a',agent:'worker',...extra}]);",
		"return await runs.all([{key:'a',agent:choose()}]);",
		"return await runs.all([{key:'a',agent:'worker'},{key:'a',agent:'worker'}]);",
		"console.log('x'); return await runs.all([{key:'a',agent:'worker'}]);",
		"return await runs.all([{key:'a',agent:'worker'}]); console.log('x');",
	]) assert.throws(() => parseStaticRunsAllWorkflow(script), /static|runs\.all|literal|duplicate|exactly one|at least one/i, script);
});

test("rejects unsupported child keys and values that are not strict JSON literals", () => {
	assert.throws(() => parseStaticRunsAllWorkflow("return await runs.all([{key:'a',agent:'worker',unknown:true}]);"), /unsupported child field/i);
	assert.throws(() => parseStaticRunsAllWorkflow("return await runs.all([{key:'a',agent:'worker',task:undefined}]);"), /literal/i);
	assert.throws(() => parseStaticRunsAllWorkflow("return await runs.all([{key:'a',agent:'worker',task:`template`}]);"), /literal/i);
});
