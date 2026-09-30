/** chain/tasks through executePublic with disabledFeatures "workflow-scripts", using the mock pi child launcher. */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { DIRS, type AsyncStatus } from "../../src/shared/types.ts";
import { createEventBus, makeAgent, makeMinimalCtx } from "../support/helpers.ts";
import { available, createSubagentExecutor, installSingleExecutionHooks, makeExecutor, mockPi, readAllCallArgs, tempDir } from "../support/single-execution-fixture.ts";

const DISABLED = { disabledFeatures: ["workflow-scripts"] };

function text(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map((part) => part.text ?? "").join("\n");
}

describe("structured chain/tasks workflows", { skip: !available || !createSubagentExecutor ? "pi packages not available" : undefined }, () => {
	installSingleExecutionHooks();

	it("runs a chain in order with {task}, {previous}, and {outputs.name}", async () => {
		mockPi.onCall({ matchArgIncludes: "Scan: fix login", output: "SCAN-RESULT" });
		mockPi.onCall({ matchArgIncludes: "Plan from SCAN-RESULT", output: "PLAN-RESULT" });
		mockPi.onCall({ matchArgIncludes: "Write PLAN-RESULT using SCAN-RESULT for fix login", output: "WRITTEN" });
		const executor = makeExecutor([makeAgent("scout"), makeAgent("planner"), makeAgent("writer")], DISABLED);
		const result = await executor.executePublic("chain-e2e", {
			task: "fix login",
			chain: [
				{ agent: "scout", task: "Scan: {task}", as: "scan" },
				{ agent: "planner", task: "Plan from {previous}" },
				{ agent: "writer", task: "Write {previous} using {outputs.scan} for {task}" },
			],
			async: false,
			chatProgress: "off",
		}, new AbortController().signal, undefined, makeMinimalCtx(tempDir));
		assert.equal(result.isError, undefined, text(result));
		assert.equal(result.details.mode, "workflow");
		assert.equal(result.details.workflow?.resource?.name, "chain");
		assert.deepEqual(result.details.workflow?.value, {
			ok: true,
			children: [
				{ key: "step-1", agent: "scout", ok: true, output: "SCAN-RESULT" },
				{ key: "step-2", agent: "planner", ok: true, output: "PLAN-RESULT" },
				{ key: "step-3", agent: "writer", ok: true, output: "WRITTEN" },
			],
		});
		const launched = readAllCallArgs().map((args) => args.join(" "));
		assert.equal(launched.length, 3);
		assert.ok(launched[2]!.includes("Write PLAN-RESULT using SCAN-RESULT for fix login"), launched[2]);
	});

	it("does not warn about dynamic launches for a chain", async (t) => {
		const warnings: string[] = [];
		t.mock.method(console, "warn", (message: string) => { warnings.push(message); });
		const result = await makeExecutor([makeAgent("scout")], DISABLED).executePublic("chain-warn", {
			chain: [{ agent: "scout", task: "One" }, { agent: "scout" }],
			async: false,
			chatProgress: "off",
		}, new AbortController().signal, undefined, makeMinimalCtx(tempDir));
		assert.equal(result.isError, undefined, text(result));
		assert.deepEqual(warnings.filter((message) => String(message).includes("dynamic child launches")), []);
	});

	it("returns a failed chain step as an error with the earlier step's output", async () => {
		mockPi.onCall({ matchArgIncludes: "First step", output: "FIRST-OUTPUT" });
		mockPi.onCall({ matchArgIncludes: "Second FIRST-OUTPUT", exitCode: 1, stderr: "second broke" });
		const executor = makeExecutor([makeAgent("scout"), makeAgent("writer")], DISABLED);
		const result = await executor.executePublic("chain-e2e-fail", {
			chain: [{ agent: "scout", task: "First step" }, { agent: "writer", task: "Second {previous}" }, { agent: "writer" }],
			async: false,
			chatProgress: "off",
		}, new AbortController().signal, undefined, makeMinimalCtx(tempDir));
		assert.equal(result.isError, true);
		assert.match(text(result), /chain stopped at step 2: step-2 \(writer\) failed/);
		assert.equal(result.details.workflow?.resource?.name, "chain");
		assert.deepEqual(result.details.results.map((child) => ({ agent: child.agent, ok: child.exitCode === 0 })), [
			{ agent: "scout", ok: true },
			{ agent: "writer", ok: false },
		]);
		assert.match(JSON.stringify(result.details.results[0]), /FIRST-OUTPUT/);
		assert.equal(readAllCallArgs().length, 2, "the step after the failure does not launch");
	});

	it("records a failed state for an async tasks run with a failed child", async () => {
		mockPi.onCall({ matchArgIncludes: "Task A", output: "A done" });
		mockPi.onCall({ matchArgIncludes: "Task B", exitCode: 1, stderr: "B broke" });
		const executor = makeExecutor([makeAgent("scout")], DISABLED, false, undefined, true, new Map(), undefined, undefined, createEventBus(), undefined, undefined, () => {});
		const launch = await executor.executePublic("tasks-e2e-async", {
			task: "the request",
			tasks: [{ agent: "scout", task: "Task A for {task}" }, { agent: "scout", task: "Task B" }],
			async: true,
		}, new AbortController().signal, undefined, makeMinimalCtx(tempDir));
		assert.equal(launch.isError, undefined, text(launch));
		assert.ok(launch.details.asyncDir);
		const statusPath = path.join(launch.details.asyncDir!, "status.json");
		let status: Partial<Pick<AsyncStatus, "state">> = {};
		for (let attempt = 0; attempt < 250; attempt += 1) {
			if (fs.existsSync(statusPath)) status = JSON.parse(fs.readFileSync(statusPath, "utf8"));
			if (status.state === "complete" || status.state === "failed") break;
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		assert.equal(status.state, "failed");
		fs.rmSync(launch.details.asyncDir!, { recursive: true, force: true });
		if (launch.details.asyncId) fs.rmSync(path.join(DIRS.results, `${launch.details.asyncId}.json`), { force: true });
	});
});
