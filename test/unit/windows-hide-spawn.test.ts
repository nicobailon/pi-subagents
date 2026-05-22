import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function assertNestedPiSpawnHidesWindows(sourcePath: string): void {
	const source = fs.readFileSync(path.join(projectRoot, sourcePath), "utf-8");
	assert.match(
		source,
		/spawn\(spawnSpec\.command,\s*spawnSpec\.args,\s*\{[^}]*windowsHide:\s*true/s,
		`${sourcePath} nested Pi spawn should set windowsHide: true`,
	);
}

describe("nested child Pi process visibility", () => {
	it("hides foreground child Pi process windows on Windows", () => {
		assertNestedPiSpawnHidesWindows("src/runs/foreground/execution.ts");
	});

	it("hides background child Pi process windows on Windows", () => {
		assertNestedPiSpawnHidesWindows("src/runs/background/subagent-runner.ts");
	});
});
