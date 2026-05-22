import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
	attachNestedChildrenToResultChildren,
	buildSubagentResultIntercomPayload,
	formatSubagentResultReceipt,
	resolveSubagentResultStatus,
	stripDetailsOutputsForIntercomReceipt,
} from "../../src/intercom/result-intercom.ts";

describe("result intercom formatter", () => {
	it("builds one grouped intercom payload with status counts and child sections", () => {
		const payload = buildSubagentResultIntercomPayload({
			to: "subagent-chat-main",
			runId: "run-123",
			mode: "chain",
			source: "foreground",
			chainSteps: 4,
			children: [
				{
					agent: "reviewer-a",
					status: "completed",
					summary: "Completed checks",
					artifactPath: "/tmp/a.md",
					sessionPath: "/tmp/a-session.jsonl",
					intercomTarget: "subagent-reviewer-a-run-123-1",
				},
				{
					agent: "reviewer-b",
					status: "failed",
					summary: "Failed checks",
					artifactPath: "/tmp/b.md",
				},
			],
		});

		assert.equal(payload.status, "failed");
		assert.equal(payload.summary, "1 completed, 1 failed");
		assert.equal(payload.children.length, 2);
		assert.match(payload.message, /^subagent results/m);
		assert.match(payload.message, /Run: run-123/);
		assert.match(payload.message, /Mode: chain/);
		assert.match(payload.message, /Status: failed/);
		assert.match(payload.message, /Children: 1 completed, 1 failed/);
		assert.match(payload.message, /Chain steps: 4/);
		assert.match(payload.message, /Intercom targets below identify child sessions used while they were running/);
		assert.match(payload.message, /1\. reviewer-a — completed/);
		assert.match(payload.message, /Run intercom target: subagent-reviewer-a-run-123-1/);
		assert.match(payload.message, /2\. reviewer-b — failed/);
		assert.match(payload.message, /Output artifact: \/tmp\/a\.md/);
		assert.match(payload.message, /Session: \/tmp\/a-session\.jsonl/);
	});

	it("advertises async revive only for single-child results with an existing session", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-intercom-"));
		try {
			const sessionPath = path.join(root, "session.jsonl");
			fs.writeFileSync(sessionPath, "", "utf-8");
			const payload = buildSubagentResultIntercomPayload({
				to: "chat",
				runId: "run-single",
				mode: "single",
				source: "async",
				asyncId: "run-single",
				children: [{ agent: "worker", status: "completed", summary: "done", sessionPath }],
			});

			assert.match(payload.message, /Revive: subagent\(\{ action: "resume", id: "run-single", message: "\.\.\." \}\)/);
			assert.doesNotMatch(payload.message, /unsupported for multi-child/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("advertises indexed revive for multi-child async results with existing child sessions", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-intercom-"));
		try {
			const firstSession = path.join(root, "a.jsonl");
			const secondSession = path.join(root, "b.jsonl");
			fs.writeFileSync(firstSession, "", "utf-8");
			fs.writeFileSync(secondSession, "", "utf-8");
			const payload = buildSubagentResultIntercomPayload({
				to: "chat",
				runId: "run-multi",
				mode: "parallel",
				source: "async",
				asyncId: "run-multi",
				children: [
					{ agent: "a", status: "completed", summary: "done", sessionPath: firstSession },
					{ agent: "b", status: "completed", summary: "done", sessionPath: secondSession },
				],
			});

			assert.match(payload.message, /Revive child: subagent\(\{ action: "resume", id: "run-multi", index: 0, message: "\.\.\." \}\)/);
			assert.doesNotMatch(payload.message, /unsupported for multi-child/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("does not advertise async revive for missing child session files", () => {
		const payload = buildSubagentResultIntercomPayload({
			to: "chat",
			runId: "run-missing-session",
			mode: "single",
			source: "async",
			asyncId: "run-missing-session",
			children: [{ agent: "worker", status: "failed", summary: "failed", sessionPath: path.join(os.tmpdir(), "missing-pi-session.jsonl") }],
		});

		assert.match(payload.message, /Resume: unavailable; no child session file was persisted/);
		assert.doesNotMatch(payload.message, /Revive:/);
	});

	it("attaches compact nested children under their parent result child without route secrets", () => {
		const payload = buildSubagentResultIntercomPayload({
			to: "chat",
			runId: "root-run",
			mode: "parallel",
			source: "foreground",
			children: attachNestedChildrenToResultChildren("root-run", [
				{ agent: "owner-a", status: "completed", summary: "done", index: 0 },
				{ agent: "owner-b", status: "completed", summary: "done", index: 1 },
			], [{
				id: "nested-a",
				parentRunId: "root-run",
				parentStepIndex: 1,
				depth: 1,
				path: [{ runId: "root-run", stepIndex: 1 }],
				state: "complete",
				agent: "reviewer",
				sessionFile: path.join(os.tmpdir(), "nested-a.jsonl"),
				controlInbox: "/tmp/should-not-leak",
				capabilityToken: "secret-token",
				children: [{
					id: "nested-grandchild",
					parentRunId: "nested-a",
					depth: 2,
					path: [{ runId: "root-run", stepIndex: 1 }, { runId: "nested-a" }],
					state: "complete",
					agent: "auditor",
					controlInbox: "/tmp/grandchild-should-not-leak",
					capabilityToken: "grandchild-secret",
				}],
			}]),
		});

		const nested = payload.children[1]?.children?.[0];
		const grandchild = nested?.children?.[0];
		assert.equal(payload.children[0]?.children, undefined);
		assert.equal(nested?.id, "nested-a");
		assert.equal(Object.hasOwn(nested ?? {}, "controlInbox"), false);
		assert.equal(Object.hasOwn(nested ?? {}, "capabilityToken"), false);
		assert.equal(grandchild?.id, "nested-grandchild");
		assert.equal(Object.hasOwn(grandchild ?? {}, "controlInbox"), false);
		assert.equal(Object.hasOwn(grandchild ?? {}, "capabilityToken"), false);
		assert.match(payload.message, /Nested subagents:/);
		assert.match(payload.message, /↳ reviewer — complete \[nested-a\]/);
	});

	it("keeps full child summaries inside grouped payloads", () => {
		const longSummary = `${"x".repeat(2000)}\n${"y".repeat(2000)}`;
		const payload = buildSubagentResultIntercomPayload({
			to: "chat",
			runId: "run-bound",
			mode: "single",
			source: "foreground",
			children: [{ agent: "worker", status: "completed", summary: longSummary }],
		});
		assert.equal(payload.children[0]!.summary, longSummary);
		assert.match(payload.message, new RegExp(`${"x".repeat(2000)}\\n${"y".repeat(2000)}`));
	});

	it("formats compact grouped receipts with artifacts and sessions", () => {
		const payload = buildSubagentResultIntercomPayload({
			to: "chat",
			runId: "run-abc",
			mode: "parallel",
			source: "foreground",
			children: [
				{ agent: "a", status: "completed", summary: "done", artifactPath: "/tmp/a.md", intercomTarget: "subagent-a-run-abc-1" },
				{ agent: "b", status: "failed", summary: "failed", sessionPath: "/tmp/b.jsonl" },
			],
		});
		const receipt = formatSubagentResultReceipt({
			mode: "parallel",
			runId: "run-abc",
			payload,
		});

		assert.match(receipt, /Delivered parallel subagent results via intercom\./);
		assert.match(receipt, /Children: 1 completed, 1 failed/);
		assert.match(receipt, /Artifacts:\n- a \[completed\]: \/tmp\/a\.md/);
		assert.match(receipt, /Run intercom targets \(may be inactive after completion\):\n- a \[completed\]: subagent-a-run-abc-1/);
		assert.match(receipt, /Sessions:\n- b \[failed\]: \/tmp\/b\.jsonl/);
		assert.match(receipt, /Full grouped output was sent over intercom\./);
	});

	it("strips heavy output fields from receipt details", () => {
		const stripped = stripDetailsOutputsForIntercomReceipt({
			mode: "single",
			results: [{
				agent: "worker",
				task: "Task",
				exitCode: 0,
				messages: [{ role: "assistant", content: [{ type: "text", text: "full" }] } as never],
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
				finalOutput: "full output",
				truncation: { text: "truncated", truncated: true },
			}],
		});
		assert.equal(stripped.results[0]?.messages, undefined);
		assert.equal(stripped.results[0]?.finalOutput, undefined);
		assert.equal(stripped.results[0]?.truncation, undefined);
	});

	it("resolves paused and detached statuses", () => {
		assert.equal(resolveSubagentResultStatus({ interrupted: true }), "paused");
		assert.equal(resolveSubagentResultStatus({ detached: true }), "detached");
		assert.equal(resolveSubagentResultStatus({ success: true }), "completed");
		assert.equal(resolveSubagentResultStatus({ exitCode: 1 }), "failed");
	});
});
