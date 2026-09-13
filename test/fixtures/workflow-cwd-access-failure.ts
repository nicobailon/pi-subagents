import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mock } from "node:test";

const target = process.argv[2];
assert.ok(target);
const fs = createRequire(import.meta.url)("node:fs") as typeof import("node:fs");
const denied = Object.assign(new Error(`EACCES: permission denied, access '${target}'`), { code: "EACCES" });

mock.module("node:fs", {
	namedExports: {
		...fs,
		accessSync(path: import("node:fs").PathLike, mode?: number) {
			if (fs.realpathSync(path) === fs.realpathSync(target)) throw denied;
			fs.accessSync(path, mode);
		},
	},
	defaultExport: fs,
});

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
