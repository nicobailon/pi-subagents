import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { shellFlavorFor } from "../../src/inspectors/shell-command.ts";

describe("shellFlavorFor", () => {
	const platform: NodeJS.Platform = "win32";

	it("treats a Git Bash pane as POSIX", () => {
		assert.equal(shellFlavorFor(platform, "D:\\Soft\\Git\\bin\\bash.exe"), "posix");
		assert.equal(shellFlavorFor(platform, "/usr/bin/bash.exe"), "posix");
		assert.equal(shellFlavorFor(platform, "/bin/sh"), "posix");
	});

	it("keeps the PowerShell call operator for other Windows shells", () => {
		assert.equal(shellFlavorFor(platform, "C:\\Windows\\System32\\cmd.exe"), "auto");
		assert.equal(shellFlavorFor(platform, undefined), "auto");
	});

	it("never changes a non-Windows platform", () => {
		assert.equal(shellFlavorFor("linux", "/usr/bin/bash"), "auto");
	});
});
