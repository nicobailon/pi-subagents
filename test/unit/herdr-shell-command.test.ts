import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { formatShellCommand } from "../../src/inspectors/herdr/shell-command.ts";

describe("formatShellCommand on POSIX shells", () => {
	const platform: NodeJS.Platform = "linux";

	it("keeps a shell-safe executable bare so Nushell parses it as a command", () => {
		assert.equal(
			formatShellCommand("/usr/bin/node", ["/home/u/.pi/inspector-runner.mjs", "--async-dir", "/tmp/run-1|fc_abc"], platform),
			"/usr/bin/node '/home/u/.pi/inspector-runner.mjs' '--async-dir' '/tmp/run-1|fc_abc'",
		);
	});

	it("keeps bare command names bare", () => {
		assert.equal(formatShellCommand("pi", ["review the diff"], platform), "pi 'review the diff'");
	});

	it("uses a bare sh invoker for an executable containing spaces and equals", () => {
		assert.equal(
			formatShellCommand("/opt/My Tools/node=bin", ["--flag"], platform),
			`sh -c 'exec "$0" "$@"' '/opt/My Tools/node=bin' '--flag'`,
		);
	});

	it("quotes executable paths and arguments containing quotes", () => {
		assert.equal(
			formatShellCommand("/opt/My Tools/it's node", ["it's", "a|b"], platform),
			"sh -c 'exec \"$0\" \"$@\"' '/opt/My Tools/it'\\''s node' 'it'\\''s' 'a|b'",
		);
	});

	it("executes an equals-sign path through the shell wrapper", { skip: process.platform === "win32" }, () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi herdr shell="));
		try {
			const executable = path.join(root, "tool=' value");
			fs.writeFileSync(executable, "#!/bin/sh\nprintf '%s' \"$1\"\n", "utf-8");
			fs.chmodSync(executable, 0o755);
			const launched = spawnSync("/bin/sh", ["-c", formatShellCommand(executable, ["arg=' value"], platform)], { encoding: "utf-8" });
			assert.equal(launched.status, 0, launched.stderr);
			assert.equal(launched.stdout, "arg=' value");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("formatShellCommand on Windows PowerShell", () => {
	it("prefixes the call operator and preserves argument quoting", () => {
		assert.equal(
			formatShellCommand("C:\\Program Files\\nodejs\\node.exe", ["two words", 'say "hi"'], "win32"),
			'& "C:\\Program Files\\nodejs\\node.exe" "two words" "say \\"hi\\""',
		);
	});
});
