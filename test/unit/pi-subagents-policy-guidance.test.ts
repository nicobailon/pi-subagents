import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const readProjectFile = (file: string): string => readFileSync(join(process.cwd(), file), "utf-8");

describe("pi-subagents delegation policy guidance", () => {
	it("keeps delegation operator-authorized and cost-bounded", () => {
		const skill = readProjectFile("skills/pi-subagents/SKILL.md");
		const prompting = readProjectFile("skills/pi-subagents/references/prompting-and-roles.md");
		const recipes = readProjectFile("skills/pi-subagents/references/constraints-and-recipes.md");
		const lanes = readProjectFile("skills/pi-subagents/references/multi-lane-orchestration.md");
		const guidance = [skill, prompting, recipes, lanes].join("\n");

		assert.match(skill, /parent works directly by default/i);
		assert.match(skill, /only when the operator\s+requested delegation in the current request.*applicable user\/project\s+instructions/is);
		assert.match(skill, /task size, complexity, risk, tool-call count, recipe fit.*does not independently authorize delegation/is);
		assert.match(skill, /smallest bounded shape.*earns its token and\s+elapsed-time overhead/is);
		assert.match(prompting, /all launch guidance.*assumes delegation was requested by the operator/is);
		assert.match(recipes, /recipes select a shape; they do not authorize delegation/i);
		assert.match(lanes, /only after delegation is operator-authorized.*materially improves/is);

		assert.doesNotMatch(guidance, /not the routine primary doer/i);
		assert.doesNotMatch(guidance, /delegate[^\n]*(?:most|all) non-trivial requests/i);
		assert.doesNotMatch(guidance, /use this at the start of non-trivial work/i);
	});
});
