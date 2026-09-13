import assert from "node:assert/strict";
import { createRequire, syncBuiltinESMExports } from "node:module";

const target = process.argv[2];
assert.ok(target);
const fs = createRequire(import.meta.url)("node:fs") as typeof import("node:fs");
const realAccessSync = fs.accessSync;
const denied = Object.assign(new Error(`EACCES: permission denied, access '${target}'`), { code: "EACCES" });

fs.accessSync = (path, mode) => {
	if (fs.realpathSync(path) === fs.realpathSync(target)) throw denied;
	realAccessSync(path, mode);
};
syncBuiltinESMExports();

try {
	const { runWorkflowScript } = await import("../../src/workflows/scripted-workflow.ts");
	await assert.rejects(
		runWorkflowScript({
			processCwd: target,
			script: `return "unexpected";`,
			async launch(key) { return { key, ok: true, output: "unexpected", artifactPaths: [] }; },
			async status(key) { return { key, ok: true, output: "unexpected", artifactPaths: [] }; },
		}),
		(error: unknown) => error instanceof Error
			&& error.message.includes(target)
			&& error.cause instanceof Error
			&& (error.cause as NodeJS.ErrnoException).code === "EACCES",
	);
} finally {
	fs.accessSync = realAccessSync;
	syncBuiltinESMExports();
}
