import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { projectPaneShellFlavor } from "../../src/inspectors/herdr/project-panes.ts";

describe("projectPaneShellFlavor", () => {
	const platform: NodeJS.Platform = "win32";

	it("treats a Git Bash pane as POSIX", () => {
		assert.equal(projectPaneShellFlavor(platform, "D:\\Soft\\Git\\bin\\bash.exe"), "posix");
		assert.equal(projectPaneShellFlavor(platform, "/usr/bin/bash.exe"), "posix");
		assert.equal(projectPaneShellFlavor(platform, "/bin/sh"), "posix");
	});

	it("keeps the PowerShell call operator for other Windows shells", () => {
		assert.equal(projectPaneShellFlavor(platform, "C:\\Windows\\System32\\cmd.exe"), "auto");
		assert.equal(projectPaneShellFlavor(platform, undefined), "auto");
	});

	it("never changes a non-Windows platform", () => {
		assert.equal(projectPaneShellFlavor("linux", "/usr/bin/bash"), "auto");
	});
});
