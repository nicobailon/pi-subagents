import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { handleCreate, handleManagementAction, handleUpdate } from "../../src/agents/agent-management.ts";

let tempDir = "";

function readText(result: { content: Array<{ type: string; text?: string }> }): string {
	const first = result.content[0];
	assert.ok(first);
	assert.equal(first.type, "text");
	assert.equal(typeof first.text, "string");
	return first.text;
}

describe("agent management config parsing", () => {
	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-management-"));
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it("surfaces JSON parse errors for create config strings", () => {
		const result = handleCreate(
			{ config: '{"name":' },
			{ cwd: tempDir, modelRegistry: { getAvailable: () => [] } },
		);

		assert.equal(result.isError, true);
		assert.match(readText(result), /config must be valid JSON:/);
	});

	it("surfaces JSON parse errors for update config strings", () => {
		const result = handleUpdate(
			{ agent: "reviewer", config: '{"description":' },
			{ cwd: tempDir, modelRegistry: { getAvailable: () => [] } },
		);

		assert.equal(result.isError, true);
		assert.match(readText(result), /config must be valid JSON:/);
	});

	it("creates, gets, updates, and deletes a packaged agent by runtime name", () => {
		const ctx = { cwd: tempDir, modelRegistry: { getAvailable: () => [] } };
		const created = handleCreate(
			{ config: { name: "Scout", package: "Code Analysis", description: "Fast recon", scope: "project", systemPrompt: "Inspect" } },
			ctx,
		);

		assert.equal(created.isError, false);
		assert.match(readText(created), /Created agent 'code-analysis.scout'/);
		const filePath = path.join(tempDir, ".pi", "agents", "code-analysis.scout.md");
		let content = fs.readFileSync(filePath, "utf-8");
		assert.match(content, /^name: scout$/m);
		assert.match(content, /^package: code-analysis$/m);
		assert.doesNotMatch(content, /^name: code-analysis\.scout$/m);

		const got = handleManagementAction("get", { agent: "code-analysis.scout" }, ctx);
		assert.equal(got.isError, false);
		assert.match(readText(got), /Agent: code-analysis\.scout/);
		assert.match(readText(got), /Local name: scout/);
		assert.match(readText(got), /Package: code-analysis/);

		const updated = handleUpdate(
			{ agent: "code-analysis.scout", config: { package: "documentation" } },
			ctx,
		);
		assert.equal(updated.isError, false);
		assert.match(readText(updated), /code-analysis\.scout' to 'documentation\.scout'/);
		assert.equal(fs.existsSync(filePath), false);
		const updatedPath = path.join(tempDir, ".pi", "agents", "documentation.scout.md");
		content = fs.readFileSync(updatedPath, "utf-8");
		assert.match(content, /^name: scout$/m);
		assert.match(content, /^package: documentation$/m);

		const deleted = handleManagementAction("delete", { agent: "documentation.scout" }, ctx);
		assert.equal(deleted.isError, false);
		assert.equal(fs.existsSync(updatedPath), false);
	});

	it("rejects package values that cannot be normalized", () => {
		const ctx = { cwd: tempDir, modelRegistry: { getAvailable: () => [] } };
		const created = handleCreate(
			{ config: { name: "Scout", package: "!!!", description: "Fast recon", scope: "project" } },
			ctx,
		);

		assert.equal(created.isError, true);
		assert.match(readText(created), /config\.package is invalid/);
	});

	it("creates and updates packaged chains while preserving packaged step names", () => {
		const ctx = { cwd: tempDir, modelRegistry: { getAvailable: () => [] } };
		fs.mkdirSync(path.join(tempDir, ".pi", "agents"), { recursive: true });
		fs.writeFileSync(path.join(tempDir, ".pi", "agents", "code-analysis.scout.md"), `---
name: scout
package: code-analysis
description: Fast recon
---

Inspect
`, "utf-8");

		const created = handleCreate(
			{ config: { name: "Review Flow", package: "Code Analysis", description: "Review flow", scope: "project", steps: [{ agent: "code-analysis.scout", task: "Inspect" }] } },
			ctx,
		);
		assert.equal(created.isError, false);
		assert.match(readText(created), /Created chain 'code-analysis.review-flow'/);
		const filePath = path.join(tempDir, ".pi", "chains", "code-analysis.review-flow.chain.md");
		let content = fs.readFileSync(filePath, "utf-8");
		assert.match(content, /^name: review-flow$/m);
		assert.match(content, /^package: code-analysis$/m);
		assert.match(content, /^## code-analysis\.scout$/m);

		const updated = handleUpdate(
			{ chainName: "code-analysis.review-flow", config: { package: false } },
			ctx,
		);
		assert.equal(updated.isError, false);
		const updatedPath = path.join(tempDir, ".pi", "chains", "review-flow.chain.md");
		assert.equal(fs.existsSync(filePath), false);
		content = fs.readFileSync(updatedPath, "utf-8");
		assert.match(content, /^name: review-flow$/m);
		assert.doesNotMatch(content, /^package:/m);
	});

	it("creates agents with completion guard disabled", () => {
		const ctx = { cwd: tempDir, modelRegistry: { getAvailable: () => [] } };
		const result = handleCreate(
			{ config: { name: "test-runner", description: "Run tests", scope: "project", tools: "read, grep, bash, ls", completionGuard: false } },
			ctx,
		);

		assert.equal(result.isError, false);
		const filePath = path.join(tempDir, ".pi", "agents", "test-runner.md");
		const content = fs.readFileSync(filePath, "utf-8");
		assert.match(content, /^completionGuard: false$/m);

		const got = handleManagementAction("get", { agent: "test-runner" }, ctx);
		assert.equal(got.isError, false);
		assert.match(readText(got), /Completion guard: false/);
	});

	it("creates agents with resource limits", () => {
		const ctx = { cwd: tempDir, modelRegistry: { getAvailable: () => [] } };
		const result = handleCreate(
			{ config: { name: "budget-worker", description: "Bounded worker", scope: "project", maxExecutionTimeMs: 600000, maxTokens: 50000 } },
			ctx,
		);

		assert.equal(result.isError, false);
		const filePath = path.join(tempDir, ".pi", "agents", "budget-worker.md");
		const content = fs.readFileSync(filePath, "utf-8");
		assert.match(content, /^maxExecutionTimeMs: 600000$/m);
		assert.match(content, /^maxTokens: 50000$/m);

		const got = handleManagementAction("get", { agent: "budget-worker" }, ctx);
		assert.equal(got.isError, false);
		assert.match(readText(got), /Max execution time: 600000ms/);
		assert.match(readText(got), /Max tokens: 50000/);
	});

	it("rejects invalid resource limit config", () => {
		const result = handleCreate(
			{ config: { name: "budget-worker", description: "Bounded worker", scope: "project", maxTokens: 0 } },
			{ cwd: tempDir, modelRegistry: { getAvailable: () => [] } },
		);

		assert.equal(result.isError, true);
		assert.match(readText(result), /config\.maxTokens must be an integer >= 1/);
	});

	it("rejects non-boolean completion guard config", () => {
		const result = handleCreate(
			{ config: { name: "test-runner", description: "Run tests", scope: "project", completionGuard: "false" } },
			{ cwd: tempDir, modelRegistry: { getAvailable: () => [] } },
		);

		assert.equal(result.isError, true);
		assert.match(readText(result), /config\.completionGuard must be a boolean/);
	});

	it("updates JSON chain descriptions without rewriting them as markdown", () => {
		const ctx = { cwd: tempDir, modelRegistry: { getAvailable: () => [] } };
		const chainPath = path.join(tempDir, ".pi", "chains", "dynamic-review.chain.json");
		fs.mkdirSync(path.dirname(chainPath), { recursive: true });
		fs.writeFileSync(chainPath, JSON.stringify({
			name: "dynamic-review",
			description: "Review dynamic targets",
			chain: [
				{ agent: "scout", task: "Return targets", as: "targets", outputSchema: { type: "object" } },
				{
					expand: { from: { output: "targets", path: "/items" }, item: "target", key: "/path", maxItems: 4 },
					parallel: { agent: "reviewer", task: "Review {target.path}", outputSchema: { type: "object" } },
					collect: { as: "reviews" },
				},
			],
		}), "utf-8");

		const updated = handleUpdate({ chainName: "dynamic-review", config: { description: "Updated dynamic review" } }, ctx);

		assert.equal(updated.isError, false);
		const content = fs.readFileSync(chainPath, "utf-8");
		assert.doesNotMatch(content, /^---/);
		const parsed = JSON.parse(content) as { description?: string; chain?: Array<{ collect?: { as?: string } }> };
		assert.equal(parsed.description, "Updated dynamic review");
		assert.equal(parsed.chain?.[1]?.collect?.as, "reviews");
	});

	it("renames and repackages JSON chains while preserving JSON format and extension", () => {
		const ctx = { cwd: tempDir, modelRegistry: { getAvailable: () => [] } };
		const chainPath = path.join(tempDir, ".pi", "chains", "dynamic-review.chain.json");
		fs.mkdirSync(path.dirname(chainPath), { recursive: true });
		fs.writeFileSync(chainPath, JSON.stringify({
			name: "dynamic-review",
			description: "Review dynamic targets",
			chain: [{ agent: "scout", task: "Return targets" }],
		}), "utf-8");

		const updated = handleUpdate({ chainName: "dynamic-review", config: { name: "Review Flow", package: "Code Analysis" } }, ctx);

		assert.equal(updated.isError, false);
		const updatedPath = path.join(tempDir, ".pi", "chains", "code-analysis.review-flow.chain.json");
		assert.equal(fs.existsSync(chainPath), false);
		const content = fs.readFileSync(updatedPath, "utf-8");
		assert.doesNotMatch(content, /^---/);
		const parsed = JSON.parse(content) as { name?: string; package?: string; chain?: Array<{ agent?: string }> };
		assert.equal(parsed.name, "review-flow");
		assert.equal(parsed.package, "code-analysis");
		assert.equal(parsed.chain?.[0]?.agent, "scout");
	});

	it("gets dynamic JSON chain details and lists invalid chain diagnostics", () => {
		const ctx = { cwd: tempDir, modelRegistry: { getAvailable: () => [] } };
		fs.mkdirSync(path.join(tempDir, ".pi", "chains"), { recursive: true });
		fs.writeFileSync(path.join(tempDir, ".pi", "chains", "dynamic-review.chain.json"), JSON.stringify({
			name: "dynamic-review",
			description: "Review dynamic targets",
			chain: [
				{ agent: "scout", task: "Return targets", as: "targets", outputSchema: { type: "object" } },
				{
					expand: { from: { output: "targets", path: "/items" }, item: "target", key: "/path", maxItems: 4 },
					parallel: { agent: "reviewer", task: "Review {target.path}", outputSchema: { type: "object" } },
					collect: { as: "reviews" },
				},
			],
		}), "utf-8");
		fs.writeFileSync(path.join(tempDir, ".pi", "chains", "broken.chain.json"), "{", "utf-8");

		const got = handleManagementAction("get", { chainName: "dynamic-review" }, ctx);
		assert.equal(got.isError, false);
		assert.match(readText(got), /Dynamic fanout -> reviews/);
		assert.match(readText(got), /Expand: targets\/items/);
		assert.match(readText(got), /Agent: reviewer/);

		const listed = handleManagementAction("list", {}, ctx);
		assert.equal(listed.isError, false);
		assert.match(readText(listed), /Chain diagnostics:/);
		assert.match(readText(listed), /broken\.chain\.json/);
		assert.match(readText(listed), /Invalid JSON chain/);
	});

	it("creates delegate with its builtin prompt defaults", () => {
		const result = handleCreate(
			{ config: { name: "delegate", description: "Delegate helper", scope: "project" } },
			{ cwd: tempDir, modelRegistry: { getAvailable: () => [] } },
		);

		assert.equal(result.isError, false);
		const filePath = path.join(tempDir, ".pi", "agents", "delegate.md");
		const content = fs.readFileSync(filePath, "utf-8");
		assert.match(content, /systemPromptMode: append/);
		assert.match(content, /inheritProjectContext: true/);
		assert.match(content, /inheritSkills: false/);
	});
});
