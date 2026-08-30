import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readSubagentGuide, SUBAGENT_GUIDE_TOPICS } from "../../src/extension/subagent-guide.ts";
import { SUBAGENT_ACTIONS } from "../../src/shared/types.ts";

describe("subagent guide", () => {
	it("reads the packaged overview by default", () => {
		const guide = readSubagentGuide();

		assert.match(guide, /# pi-subagents/);
	});

	it("lists valid topics for an unknown topic without changing files", () => {
		const guide = readSubagentGuide("unknown");

		assert.match(guide, /Unknown subagents guide topic 'unknown'/);
		assert.match(guide, /No files were changed\./);
		assert.match(guide, new RegExp(SUBAGENT_GUIDE_TOPICS.join(", ")));
	});

	it("registers the guide action for action recovery", () => {
		assert.ok(SUBAGENT_ACTIONS.includes("guide"));
	});

	it("documents external CLI runner limits in packaged guide topics", () => {
		assert.match(readSubagentGuide("tool-reference"), /External CLI agent profiles[\s\S]*native Pi child options[\s\S]*model override[\s\S]*native Pi tools/);
		assert.match(readSubagentGuide("agents"), /External CLI agents use their own runner contract[\s\S]*native Pi child options/);
	});

	it("keeps advanced workflow details in the packaged guide", () => {
		const guide = readSubagentGuide("workflows");

		assert.match(guide, /### Parallel sequential lanes[\s\S]*runs\.lanes/);
		assert.match(guide, /### Host command steps[\s\S]*runs\.host/);
		assert.match(guide, /### Advanced rolling child runs[\s\S]*Promise\.race[\s\S]*Promise\.all/);
	});
});
