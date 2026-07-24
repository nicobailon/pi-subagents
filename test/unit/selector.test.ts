import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { initTheme } from "@earendil-works/pi-coding-agent";
import { SelectorComponent } from "../../src/slash/selector.ts";

initTheme("dark");

function createHarness(items: Array<{ value: string; label: string; current?: boolean }>) {
	const results: Array<{ confirmed: boolean; value?: string }> = [];
	const component = new SelectorComponent(
		{ requestRender() {} } as never,
		{
			fg(_color: string, text: string) { return text; },
			bold(text: string) { return text; },
		} as never,
		{
			matches(key: string, binding: string) { return key === binding; },
		} as never,
		{ title: "Select item", items, done: (result) => results.push(result) },
	);
	return { component, results };
}

describe("SelectorComponent", () => {
	it("keeps the current selection visible in a bounded list and confirms it", () => {
		const items = Array.from({ length: 12 }, (_, index) => ({
			value: `value-${index}`,
			label: `Item ${index}`,
			current: index === 10,
		}));
		const { component, results } = createHarness(items);

		const rendered = component.render(80).join("\n");
		assert.match(rendered, /Item 10/);
		assert.match(rendered, /\(11\/12\)/);

		component.handleInput("tui.select.confirm");
		assert.deepEqual(results, [{ confirmed: true, value: "value-10" }]);
	});

	it("filters searchable values and reports cancellation", () => {
		const { component, results } = createHarness([
			{ value: "anthropic/opus", label: "opus" },
			{ value: "openai/gpt", label: "gpt" },
		]);

		component.handleInput("gpt");
		component.handleInput("tui.select.confirm");
		component.handleInput("tui.select.cancel");

		assert.deepEqual(results, [
			{ confirmed: true, value: "openai/gpt" },
			{ confirmed: false },
		]);
	});
});
