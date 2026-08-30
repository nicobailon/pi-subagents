import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	authorizeWorkflowResourceHost,
	consumeWorkflowResourcePermit,
} from "../../src/shared/workflow-child-permit.ts";
import { resolveWorkflowResource } from "../../src/workflows/workflow-resources.ts";
import { runWorkflowScript, WorkflowScriptError } from "../../src/workflows/scripted-workflow.ts";

describe("named workflow resources", () => {
	it("resolves and executes an extension-owned named workflow script", async () => {
		const resolved = resolveWorkflowResource("run-ci", { command: "npm test", timeoutMs: 1_000 });
		assert.equal(resolved.ok, true);
		if (!resolved.ok) return;
		assert.match(resolved.resource.script, /runs\.host\("ci"/);
		assert.deepEqual(resolved.resource.provenance, {
			kind: "workflow",
			name: "run-ci",
			version: 1,
			invocation: "named",
			expansion: "resolved",
			id: resolved.resource.provenance.id,
		});
		assert.equal(authorizeWorkflowResourceHost(resolved.resource.permit, "ci", "npm test"), "Workflow resource authority is unavailable.");
		const consumed = consumeWorkflowResourcePermit(resolved.resource.permit, resolved.resource.script);
		assert.equal(typeof consumed, "object");
		assert.equal(authorizeWorkflowResourceHost(resolved.resource.permit, "ci", "npm test"), undefined);
		const execution = await runWorkflowScript({
			script: resolved.resource.script,
			async host(key, params) {
				assert.equal(key, "ci");
				assert.equal(params.command, "npm test");
				return { key, kind: "command", ok: true, state: "passed", exitCode: 0, stdout: "ok", stderr: "", outputPath: "ci.log", durationMs: 1 };
			},
			async launch(key) { return { key, ok: true, output: "unused", artifactPaths: [] }; },
			async status(key) { return { key, ok: true, output: "unused", artifactPaths: [] }; },
		});
		assert.equal((execution.value as { ok?: boolean }).ok, true);
	});

	it("does not authorize raw equivalent scripts or unconsumed/forged permits", () => {
		const forged = { __workflowResourcePermit: Symbol("forged") } as never;
		assert.equal(authorizeWorkflowResourceHost(forged, "ci", "npm test"), "Workflow resource authority is unavailable.");
		const raw = `return await runs.host("ci", { kind: "command", command: "npm test", timeoutMs: 1000 });`;
		const resolved = resolveWorkflowResource("run-ci", { command: "npm test", timeoutMs: 1_000 });
		assert.equal(resolved.ok, true);
		if (!resolved.ok) return;
		assert.equal(authorizeWorkflowResourceHost(resolved.resource.permit, "ci", "npm test"), "Workflow resource authority is unavailable.");
		assert.notEqual(raw, resolved.resource.script);
	});

	it("rejects missing metadata, mismatched scripts, and unauthorized host combinations", () => {
		const resolved = resolveWorkflowResource("run-ci", { command: "npm test" });
		assert.equal(resolved.ok, true);
		if (!resolved.ok) return;
		assert.equal(consumeWorkflowResourcePermit(resolved.resource.permit, `${resolved.resource.script}\n`), "Workflow resource permit does not match the resolved workflow script.");
		assert.equal(authorizeWorkflowResourceHost(resolved.resource.permit, "shell", "npm test"), "Workflow resource authority is unavailable.");
		const consumed = consumeWorkflowResourcePermit(resolved.resource.permit, resolved.resource.script);
		assert.equal(typeof consumed, "object");
		assert.match(authorizeWorkflowResourceHost(resolved.resource.permit, "shell", "npm test") ?? "", /not allowed/);
		assert.match(authorizeWorkflowResourceHost(resolved.resource.permit, "ci", "git status") ?? "", /not allowed/);
		assert.match(authorizeWorkflowResourceHost(resolved.resource.permit, "ci", "npm test") ?? "", /^$/);

		const review = resolveWorkflowResource("review", { task: "Review" });
		assert.equal(review.ok, true);
		if (!review.ok) return;
		const reviewConsumed = consumeWorkflowResourcePermit(review.resource.permit, review.resource.script);
		assert.equal(typeof reviewConsumed, "object");
		assert.match(authorizeWorkflowResourceHost(review.resource.permit, "ci", "npm test") ?? "", /not allowed/);
	});

	it("validates resource names and bounded arguments before creating permits", () => {
		for (const [name, args] of [
			["unknown", {}],
			["run ci", {}],
			["run-ci", { command: "rm -rf /" }],
			["run-ci", { timeoutMs: 0 }],
			["run-ci", { extra: true }],
			["review", { task: "" }],
			["review", { task: "Review", extra: true }],
			["review", { task: "x".repeat(16 * 1024 + 1) }],
		] as const) {
			const result = resolveWorkflowResource(name, args);
			assert.equal(result.ok, false, `${name}: ${JSON.stringify(args)}`);
		}
	});

	it("reports unauthorized raw host execution through the workflow primitive when no host is supplied", async () => {
		await assert.rejects(
			runWorkflowScript({
				script: `return await runs.host("ci", { kind: "command", command: "npm test", timeoutMs: 1000 });`,
				async launch(key) { return { key, ok: true, output: "unused", artifactPaths: [] }; },
				async status(key) { return { key, ok: true, output: "unused", artifactPaths: [] }; },
			}),
			(error: unknown) => error instanceof WorkflowScriptError && /runs\.host is unavailable/.test(error.message),
		);
	});
});
