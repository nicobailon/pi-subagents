import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	DEFAULT_LIST_KEYBINDINGS,
	getPrimaryAgentManagerNewKeyLabel,
	normalizeListKeybindings,
} from "./agent-manager-keybindings.ts";

describe("normalizeListKeybindings", () => {
	it("uses ctrl+n with alt+n fallback by default", () => {
		assert.deepEqual(normalizeListKeybindings(), DEFAULT_LIST_KEYBINDINGS);
	});

	it("preserves configured bindings", () => {
		assert.deepEqual(normalizeListKeybindings({ agentManagerNew: ["ctrl+shift+n"] }), {
			agentManagerNew: ["ctrl+shift+n"],
		});
	});

	it("falls back when configured binding list is empty", () => {
		assert.deepEqual(normalizeListKeybindings({ agentManagerNew: [] }), DEFAULT_LIST_KEYBINDINGS);
	});
});

describe("getPrimaryAgentManagerNewKeyLabel", () => {
	it("shows the first configured shortcut in the footer", () => {
		assert.equal(getPrimaryAgentManagerNewKeyLabel({ agentManagerNew: ["ctrl+shift+n", "alt+n"] }), "ctrl+shift+n");
	});
});
