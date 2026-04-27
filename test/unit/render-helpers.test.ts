import test from "node:test";
import assert from "node:assert/strict";

import { visibleWidth } from "@mariozechner/pi-tui";
import { row } from "../../render-helpers.ts";

const theme = {
	fg(_name: string, text: string): string {
		return text;
	},
};

test("row clips content to the available width", () => {
	const rendered = row("abcdef", 6, theme as any);
	assert.equal(visibleWidth(rendered), 6);
});

test("row normalizes multiline content before clipping", () => {
	const rendered = row("bash failed: line 1\nline 2\tvalue", 20, theme as any);
	assert.equal(visibleWidth(rendered), 20);
	assert.doesNotMatch(rendered, /[\r\n\t]/);
});

test("row keeps styled multiline content within the available width", () => {
	const rendered = row("\u001b[31merror line 1\nline 2\tvalue\u001b[39m", 18, theme as any);
	assert.equal(visibleWidth(rendered), 18);
	assert.doesNotMatch(rendered, /[\r\n\t]/);
});
