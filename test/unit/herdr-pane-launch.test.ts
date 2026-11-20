import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { projectPaneShellFlavor } from "../../src/inspectors/herdr/project-panes.ts";
import { formatShellCommand } from "../../src/inspectors/shell-command.ts";

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
describe("Windows pane command formatting", () => {
	const node = "C:\\Program Files\\nodejs\\node.exe";

	it("formats a Git Bash pane without the PowerShell call operator", () => {
		assert.equal(
			formatShellCommand(node, ["cli.js"], "win32", projectPaneShellFlavor("win32", "D:\\Soft\\Git\\bin\\bash.exe")),
			`sh -c 'exec "$0" "$@"' 'C:\\Program Files\\nodejs\\node.exe' 'cli.js'`,
		);
	});

	it("formats a PowerShell pane with the call operator", () => {
		assert.equal(
			formatShellCommand(node, ["cli.js"], "win32", projectPaneShellFlavor("win32", "C:\\Windows\\System32\\cmd.exe")),
			'& "C:\\Program Files\\nodejs\\node.exe" "cli.js"',
		);
	});
});

