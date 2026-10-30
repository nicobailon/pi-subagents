import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { it } from "node:test";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

it("runtime replacement cancels owned discovery and withdraws pending advertisements", { skip: process.platform === "win32" }, () => {
	const output = execFileSync(process.execPath, [
		"--experimental-strip-types", "--import", "./test/support/register-loader.mjs",
		"./test/support/advertisement-runtime-replacement.mjs",
	], { cwd: repo, encoding: "utf8", timeout: 15_000 });
	assert.match(output, /runtime replacement cleaned discovery/);
});
