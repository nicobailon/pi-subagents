import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), "utf8");

describe("writer budget guidance", () => {
	it("forbids hard turn and tool caps for mutation-capable agents", () => {
		const skill = read("skills/pi-subagents/SKILL.md");
		const reviewLoop = read("prompts/review-loop.md");
		const readme = read("README.md");

		for (const text of [skill, reviewLoop, readme]) {
			assert.match(text, /Do not (?:pass|set) `turnBudget` or a hard `toolBudget`/);
			assert.match(text, /mutation-safe(?: structured)? checkpoint/);
			assert.match(text, /elapsed timeout is not a mutation-safe boundary/);
			assert.match(text, /changed files/);
			assert.match(text, /build(?: and |\/)test state/);
			assert.match(text, /commit or PR state|PR or commit state/);
		}
	});

	it("keeps hard count caps available only for explicitly read-only work", () => {
		const skill = read("skills/pi-subagents/SKILL.md");
		const reviewLoop = read("prompts/review-loop.md");
		const readme = read("README.md");

		assert.match(skill, /Hard turn and tool-call caps remain suitable for explicitly read-only scouts, reviewers, and validators/);
		assert.match(reviewLoop, /explicitly read-only reviewers may use bounded `turnBudget` or `toolBudget` limits/);
		assert.match(readme, /Hard turn and tool-call caps remain suitable for bounded, explicitly read-only scouts, reviewers, and validators/);
	});

	it("records incident 672e31ef with the terminating tool-use boundary", () => {
		const readme = read("README.md");

		assert.match(readme, /incident `672e31ef`/);
		assert.match(readme, /4 minutes 28 seconds/);
		assert.match(readme, /23 assistant turns and 42 tool calls/);
		assert.match(readme, /more than 38 turns/);
		assert.match(readme, /stopReason: "toolUse"/);
		assert.match(readme, /`SIGINT`, `SIGTERM`, and `SIGKILL`/);
	});
});
