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

	it("documents failed-lane recovery boundaries in packaged guide topics", () => {
		const workflows = readSubagentGuide("workflows");
		const toolReference = readSubagentGuide("tool-reference");
		assert.match(workflows, /subagent workflow[\s\S]*child launch[\s\S]*prompt runtime[\s\S]*extension loading[\s\S]*child tooling setup[\s\S]*lane infrastructure blocker/);
		assert.match(workflows, /exact failure[\s\S]*run\/status[\s\S]*(?:repo|repository)\/cwd\/worktree\/branch\/ref/);
		assert.match(workflows, /clean[\s\S]*partial diff/);
		assert.match(workflows, /same-protocol retry/);
		assert.match(workflows, /asking the owner/);
		assert.match(workflows, /external\/foreground\/CLI fallback requires explicit owner approval/);
		assert.match(workflows, /Pi core[\s\S]*pi -ne[\s\S]*out-of-repo hint[\s\S]*not protocol-approved fallback/);
		assert.match(toolReference, /lane infrastructure blocker[\s\S]*external\/foreground\/CLI fallback requires explicit owner approval[\s\S]*interactive_shell[\s\S]*pi -ne/);
	});

	it("keeps advanced workflow details in the packaged guide", () => {
		const guide = readSubagentGuide("workflows");

		assert.match(guide, /### Parallel sequential lanes[\s\S]*runs\.lanes/);
		assert.match(guide, /### Host command steps[\s\S]*runs\.host/);
		assert.match(guide, /### Advanced rolling child runs[\s\S]*Promise\.race[\s\S]*Promise\.all/);
	});
});
