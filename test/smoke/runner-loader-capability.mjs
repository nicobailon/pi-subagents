import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import * as nodeModule from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const expected = process.argv[2];
assert.ok(expected === "jiti" || expected === "native", "expected jiti or native");
const nativeCapability = Boolean(process.features.typescript) && typeof nodeModule.registerHooks === "function";
assert.equal(nativeCapability, expected === "native");

const source = fileURLToPath(new URL("../../", import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "runner-loader-capability-"));
try {
	const aliasTarget = path.join(root, "host-tui.mjs");
	fs.writeFileSync(aliasTarget, 'export const identity = "HOST_TUI_IDENTITY";\n');
	fs.writeFileSync(path.join(root, "dep.ts"), 'export const value: string = "TS_REDIRECT";\n');
	fs.writeFileSync(path.join(root, "target.ts"), [
		'import { identity } from "@earendil-works/pi-tui";',
		expected === "native" ? 'import { value } from "./dep.js";' : 'const value = "JITI";',
		`if (identity !== "HOST_TUI_IDENTITY" || value !== ${JSON.stringify(expected === "native" ? "TS_REDIRECT" : "JITI")}) throw new Error("wrong loader identity");`,
		`console.log(${JSON.stringify(`PASS_${expected.toUpperCase()}_LOADER`)})`,
	].join("\n"));
	const env = {
		...process.env,
		JITI_ALIAS: JSON.stringify({ "@earendil-works/pi-tui": aliasTarget }),
		PI_ASYNC_NATIVE_RUNNER: expected === "native" ? "1" : "0",
	};
	const preload = pathToFileURL(path.join(source, "runner-peer-preload.mjs")).href;
	const args = expected === "native"
		? ["--import", preload, "--experimental-strip-types", path.join(root, "target.ts")]
		: ["--import", preload, path.join(source, "node_modules/jiti/lib/jiti-cli.mjs"), path.join(root, "target.ts")];
	const result = spawnSync(process.execPath, args, { cwd: root, env, encoding: "utf8" });
	assert.ifError(result.error);
	assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
	assert.match(result.stdout, new RegExp(`PASS_${expected.toUpperCase()}_LOADER`));

	if (typeof nodeModule.registerHooks !== "function") {
		const eager = path.join(root, "eager-register-hooks.mjs");
		fs.writeFileSync(eager, 'import { registerHooks } from "node:module"; registerHooks({});\n');
		const oldResult = spawnSync(process.execPath, ["--import", pathToFileURL(eager).href, "--eval", 'console.log("UNREACHABLE")'], { encoding: "utf8" });
		assert.notEqual(oldResult.status, 0);
		assert.doesNotMatch(oldResult.stdout, /UNREACHABLE/);
		assert.match(oldResult.stderr, /does not provide an export named 'registerHooks'/);
	}
} finally {
	fs.rmSync(root, { recursive: true, force: true });
}
