import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

test("Unreleased changelog uses each subsection once", () => {
	const changelog = fs.readFileSync(new URL("../../CHANGELOG.md", import.meta.url), "utf8");
	const unreleased = changelog.match(/^## \[Unreleased\]\r?\n([\s\S]*?)(?=^## \[)/m)?.[1];
	assert.ok(unreleased, "Unreleased section should exist");
	const headings = [...unreleased.matchAll(/^### (.+)$/gm)].map((match) => match[1]);
	assert.deepEqual(headings, [...new Set(headings)]);
});
