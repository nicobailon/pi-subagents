import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { installWindowsHiddenChildProcesses, withWindowsHide } from "../support/windows-hide-child-processes.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("Windows test child-process visibility", () => {
	it("forces windowsHide across child-process overloads without mutating input", () => {
		const options = { cwd: "C:/tmp", windowsHide: false };
		const args = ["node", ["fixture.js"], options];
		const hidden = withWindowsHide(args, 2);
		assert.deepEqual(hidden, ["node", ["fixture.js"], { cwd: "C:/tmp", windowsHide: true }]);
		assert.equal(args[2], options);
		assert.equal(options.windowsHide, false);

		const callback = () => {};
		assert.deepEqual(withWindowsHide(["echo ok", callback], 1), ["echo ok", { windowsHide: true }, callback]);
	});

	it("loads the visibility guard from both unit and integration test preloads", () => {
		const isolated = fs.readFileSync(path.join(projectRoot, "test", "support", "isolated-temp-root.mjs"), "utf-8");
		const integration = fs.readFileSync(path.join(projectRoot, "test", "support", "register-loader.mjs"), "utf-8");
		assert.match(isolated, /windows-hide-child-processes\.mjs/);
		assert.match(integration, /isolated-temp-root\.mjs/);
	});

	it("installs at most once and only on Windows", () => {
		assert.equal(installWindowsHiddenChildProcesses("linux"), false);
		if (process.platform === "win32") assert.equal(installWindowsHiddenChildProcesses(), false);
	});
});
