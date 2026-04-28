import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

function readRegisteredSubagentDescription(): string {
	const testDir = path.dirname(fileURLToPath(import.meta.url));
	const indexSource = fs.readFileSync(path.resolve(testDir, "..", "..", "index.ts"), "utf-8");
	const match = indexSource.match(/name:\s*"subagent",[\s\S]*?description:\s*`([\s\S]*?)`,\n\t\tparameters: SubagentParams,/);
	assert.ok(match, "expected to find the registered subagent tool description");
	return match[1]!;
}

describe("registered subagent tool description", () => {
	it("does not advertise hardcoded builtin agent names", () => {
		const description = readRegisteredSubagentDescription();

		for (const builtinName of ["scout", "worker", "planner"]) {
			assert.doesNotMatch(description, new RegExp(`\\b${builtinName}\\b`));
		}
		assert.match(description, /use \{ action: "list" \} to inspect configured agents\/chains/i);
		assert.match(description, /executable\/non-disabled/i);
		assert.doesNotMatch(description, /disabled builtins/i);
		assert.match(description, /output\?,reads\?,progress\?/i);
	});
});
