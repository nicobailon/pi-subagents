import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import * as path from "node:path";
import { it } from "node:test";
import { fileURLToPath } from "node:url";

it("imports the extension entry without loading the executor or Fleet TUI", async () => {
	const sourceRoot = `${path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src")}${path.sep}`;
	const loaded = new Set<string>();
	registerHooks({
		load(url, context, nextLoad) {
			if (url.startsWith("file:") && fileURLToPath(url).startsWith(sourceRoot)) loaded.add(fileURLToPath(url));
			return nextLoad(url, context);
		},
	});

	await import("../../src/extension/index.ts");

	assert.equal([...loaded].some((file) => file.endsWith(`${path.sep}runs${path.sep}foreground${path.sep}subagent-executor.ts`)), false);
	assert.equal([...loaded].some((file) => file.endsWith(`${path.sep}tui${path.sep}fleet.ts`)), false);
});
