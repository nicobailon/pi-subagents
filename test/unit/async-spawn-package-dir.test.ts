import assert from "node:assert/strict";
import childProcess from "node:child_process";
import * as fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { executeAsyncSingle } from "../../src/runs/background/async-execution.ts";
import { resolveInstalledPiPackageRoot, resolvePiPackageRoot } from "../../src/runs/shared/pi-spawn.ts";
import { makeAgent } from "../support/helpers.ts";

test("detached spawn does not keep an inherited bundled-layout PI_PACKAGE_DIR", async (t) => {
	const bundled = fs.mkdtempSync(path.join(os.tmpdir(), "bundled-pi-"));
	const previous = process.env.PI_PACKAGE_DIR;
	process.env.PI_PACKAGE_DIR = bundled;
	const spawn = t.mock.method(childProcess, "spawn", () => {
		throw new Error("spawn boundary captured");
	});
	syncBuiltinESMExports();
	try {
		const result = executeAsyncSingle("spawn-package-dir", {
			agent: "worker",
			task: "Inspect package dir",
			agentConfig: makeAgent("worker"),
			ctx: { pi: { events: { emit() {} } }, cwd: bundled, currentSessionId: "spawn-package-dir" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			sessionRoot: path.join(bundled, "sessions"),
			maxSubagentDepth: 1,
			acceptance: false,
		});
		assert.match(result.content[0]!.text, /spawn boundary captured/);
		const npmRoot = resolvePiPackageRoot() ?? resolveInstalledPiPackageRoot();
		assert.equal(spawn.mock.calls[0]!.arguments[2].env.PI_PACKAGE_DIR, npmRoot);
		assert.notEqual(npmRoot, bundled);
	} finally {
		t.mock.restoreAll();
		syncBuiltinESMExports();
		if (previous === undefined) delete process.env.PI_PACKAGE_DIR;
		else process.env.PI_PACKAGE_DIR = previous;
		fs.rmSync(bundled, { recursive: true, force: true });
	}
});
