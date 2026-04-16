import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { handleCreate, handleUpdate } from "../../agent-management.ts";
import { createEditState, handleEditInput } from "../../agent-manager-edit.ts";

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
});

describe("agent manager edit prompt mode", () => {
	it("preserves explicit append mode when reopening and confirming the field", () => {
		const state = createEditState(
			{
				name: "worker",
				description: "Worker",
				source: "user",
				filePath: "/tmp/worker.md",
				systemPrompt: "Do work",
				systemPromptMode: "append",
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
