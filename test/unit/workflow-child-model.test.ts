import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { listAsyncRuns } from "../../src/runs/background/async-status.ts";
import { readWorkflowChildRunModel, withWorkflowChildRunModel } from "../../src/runs/background/workflow-terminal-proof.ts";

const roots: string[] = [];

function workspace(): { root: string; parent: string } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-workflow-model-"));
	roots.push(root);
	const parent = path.join(root, "parent");
	fs.mkdirSync(parent);
	return { root, parent };
}

function writeStatus(dir: string, status: Record<string, unknown>): void {
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify(status));
}

function childRun(root: string, runId: string, step: Record<string, unknown>): void {
	writeStatus(path.join(root, runId), { runId, mode: "single", state: "complete", startedAt: 1, steps: [step] });
}

afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("workflow child run model", () => {
	it("ignores synchronous children, missing ids, path traversal, and unreadable status", () => {
		const { root, parent } = workspace();
		childRun(root, "child", { agent: "scout", status: "complete", model: "observed/model", thinking: "low" });
		assert.equal(readWorkflowChildRunModel(parent, { runId: "child" }), undefined);
		assert.equal(readWorkflowChildRunModel(parent, { async: true }), undefined);
		assert.equal(readWorkflowChildRunModel(parent, { async: true, runId: "../parent" }), undefined);
		assert.equal(readWorkflowChildRunModel(parent, { async: true, runId: "missing" }), undefined);
	});

	it("fills a roster row without overwriting a recorded model", () => {
		const { root, parent } = workspace();
		childRun(root, "child", { agent: "scout", status: "complete", model: "observed/model", thinking: "low" });
		assert.deepEqual(
			withWorkflowChildRunModel(parent, { childId: "lane", state: "completed", runId: "child" }),
			{ childId: "lane", state: "completed", runId: "child", model: "observed/model", thinking: "low" },
		);
		assert.deepEqual(
			withWorkflowChildRunModel(parent, { childId: "lane", state: "completed", model: "launch/model", thinking: "high" }),
			{ childId: "lane", state: "completed", model: "launch/model", thinking: "high" },
		);
	});

	it("projects the child model onto workflow lane rows", () => {
		const { root, parent } = workspace();
		childRun(root, "child", { agent: "scout", status: "complete", model: "observed/model", thinking: "low" });
		writeStatus(parent, {
			runId: "parent",
			mode: "workflow",
			state: "complete",
			startedAt: 1,
			steps: [{ agent: "scout", workflowKey: "architect", runId: "child", async: true, status: "complete" }],
		});
		const [run] = listAsyncRuns(root, { runId: "parent" });
		assert.equal(run?.steps?.[0]?.model, "observed/model");
		assert.equal(run?.steps?.[0]?.thinking, "low");
	});
});
