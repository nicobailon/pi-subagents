import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { handleCreate, handleManagementAction, handleUpdate } from "../../src/agents/agent-management.ts";
import { createEditState, handleEditInput, renderEdit } from "../../src/manager-ui/agent-manager-edit.ts";

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
		const filePath = path.join(tempDir, ".pi", "agents", "code-analysis.review-flow.chain.md");
		let content = fs.readFileSync(filePath, "utf-8");
		assert.match(content, /^name: review-flow$/m);
		assert.match(content, /^package: code-analysis$/m);
		assert.match(content, /^## code-analysis\.scout$/m);

		const updated = handleUpdate(
			{ chainName: "code-analysis.review-flow", config: { package: false } },
			ctx,
		);
		assert.equal(updated.isError, false);
		const updatedPath = path.join(tempDir, ".pi", "agents", "review-flow.chain.md");
		assert.equal(fs.existsSync(filePath), false);
		content = fs.readFileSync(updatedPath, "utf-8");
		assert.match(content, /^name: review-flow$/m);
		assert.doesNotMatch(content, /^package:/m);
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

describe("agent manager edit prompt mode", () => {
	it("shows only thinking levels supported by the selected model", () => {
		const models = [{
			provider: "deepseek",
			id: "deepseek-v4-pro",
			fullId: "deepseek/deepseek-v4-pro",
			reasoning: true,
			thinkingLevelMap: { minimal: null, low: null, medium: null, high: "high", xhigh: "max" },
		}];
		const state = createEditState(
			{
				name: "worker",
				description: "Worker",
				source: "user",
				filePath: "/tmp/worker.md",
				systemPrompt: "Do work",
				systemPromptMode: "replace",
				inheritProjectContext: false,
				inheritSkills: false,
				model: "deepseek/deepseek-v4-pro",
			},
			false,
			models,
			[],
		);

		state.fieldIndex = state.fields.indexOf("thinking");
		handleEditInput("edit", state, "\r", 80, models, []);
		const rendered = renderEdit("edit-field", state, 80, { fg(_key: string, text: string) { return text; } }).join("\n");

		assert.match(rendered, /off - No extended thinking/);
		assert.match(rendered, /high - Deep reasoning/);
		assert.match(rendered, /xhigh - Maximum reasoning/);
		assert.doesNotMatch(rendered, /minimal - Brief reasoning/);
		assert.doesNotMatch(rendered, /low - Light reasoning/);
		assert.doesNotMatch(rendered, /medium - Moderate reasoning/);
	});

	it("drops thinking when switching to a model that does not support it", () => {
		const models = [
			{ provider: "test", id: "reasoning-model", fullId: "test/reasoning-model", reasoning: true },
			{ provider: "test", id: "basic-model", fullId: "test/basic-model", reasoning: false },
		];
		const state = createEditState(
			{
				name: "worker",
				description: "Worker",
				source: "user",
				filePath: "/tmp/worker.md",
				systemPrompt: "Do work",
				systemPromptMode: "replace",
				inheritProjectContext: false,
				inheritSkills: false,
				model: "test/reasoning-model",
				thinking: "high",
			},
			false,
			models,
			[],
		);

		state.fieldIndex = state.fields.indexOf("model");
		handleEditInput("edit", state, "\r", 80, models, []);
		state.modelCursor = state.filteredModels.findIndex((model) => model.fullId === "test/basic-model");
		handleEditInput("edit-field", state, "\r", 80, models, []);

		assert.equal(state.draft.model, "test/basic-model");
		assert.equal(state.draft.thinking, undefined);
	});

	it("keeps an empty packaged local name invalid instead of duplicating the package prefix", () => {
		const state = createEditState(
			{
				name: "code-analysis.scout",
				localName: "scout",
				packageName: "code-analysis",
				description: "Scout",
				source: "user",
				filePath: "/tmp/scout.md",
				systemPrompt: "Inspect",
				systemPromptMode: "replace",
				inheritProjectContext: false,
				inheritSkills: false,
			},
			false,
			[],
			[],
		);

		state.fieldIndex = state.fields.indexOf("name");
		handleEditInput("edit", state, "\r", 80, [], []);
		state.fieldEditor.buffer = "";
		state.fieldEditor.cursor = 0;
		handleEditInput("edit-field", state, "\r", 80, [], []);

		assert.equal(state.draft.name, "");
		assert.equal(state.draft.localName, undefined);
	});

	it("normalizes package edits through the shared package parser", () => {
		const state = createEditState(
			{
				name: "scout",
				localName: "scout",
				description: "Scout",
				source: "user",
				filePath: "/tmp/scout.md",
				systemPrompt: "Inspect",
				systemPromptMode: "replace",
				inheritProjectContext: false,
				inheritSkills: false,
			},
			false,
			[],
			[],
		);

		state.fieldIndex = state.fields.indexOf("package");
		handleEditInput("edit", state, "\r", 80, [], []);
		state.fieldEditor.buffer = "Code Analysis!";
		state.fieldEditor.cursor = state.fieldEditor.buffer.length;
		handleEditInput("edit-field", state, "\r", 80, [], []);

		assert.equal(state.draft.packageName, "code-analysis");
		assert.equal(state.draft.name, "code-analysis.scout");
	});

	it("rejects invalid package edits without clearing the current package", () => {
		const state = createEditState(
			{
				name: "code-analysis.scout",
				localName: "scout",
				packageName: "code-analysis",
				description: "Scout",
				source: "user",
				filePath: "/tmp/scout.md",
				systemPrompt: "Inspect",
				systemPromptMode: "replace",
				inheritProjectContext: false,
				inheritSkills: false,
			},
			false,
			[],
			[],
		);

		state.fieldIndex = state.fields.indexOf("package");
		handleEditInput("edit", state, "\r", 80, [], []);
		state.fieldEditor.buffer = "!!!";
		state.fieldEditor.cursor = state.fieldEditor.buffer.length;
		handleEditInput("edit-field", state, "\r", 80, [], []);

		assert.equal(state.error, "package is invalid after sanitization.");
		assert.equal(state.draft.packageName, "code-analysis");
		assert.equal(state.draft.name, "code-analysis.scout");
	});

	it("preserves explicit append mode when reopening and confirming the field", () => {
		const state = createEditState(
			{
				name: "worker",
				description: "Worker",
				source: "user",
				filePath: "/tmp/worker.md",
				systemPrompt: "Do work",
				systemPromptMode: "append",
				inheritProjectContext: false,
				inheritSkills: false,
			},
			false,
			[],
			[],
		);

		state.fieldIndex = state.fields.indexOf("systemPromptMode");
		const first = handleEditInput("edit", state, "\r", 80, [], []);
		assert.equal(first?.nextScreen, "edit-field");
		assert.equal(state.fieldEditor.buffer, "append");

		const second = handleEditInput("edit-field", state, "\r", 80, [], []);
		assert.equal(second?.nextScreen, "edit");
		assert.equal(state.draft.systemPromptMode, "append");
	});
});
