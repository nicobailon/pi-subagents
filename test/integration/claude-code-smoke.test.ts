import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { resolveClaudeCodeLaunch } from "../../src/runs/shared/claude-code-adapter.ts";
import { runExternalCli } from "../../src/runs/shared/external-cli-runner.ts";

const enabled = process.env.PI_SUBAGENTS_CLAUDE_CODE_SMOKE === "1";

test("maintainer Claude Code no-tools smoke", { skip: enabled ? undefined : "set PI_SUBAGENTS_CLAUDE_CODE_SMOKE=1" }, async () => {
	const reportPath = process.env.PI_SUBAGENTS_CLAUDE_CODE_SMOKE_REPORT;
	assert.ok(reportPath, "PI_SUBAGENTS_CLAUDE_CODE_SMOKE_REPORT is required");
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-claude-smoke-"));
	const canaryPath = path.join(dir, "write-canary.txt");
	try {
		const launch = resolveClaudeCodeLaunch({ adapter: "claude-code", command: "claude" });
		const result = await runExternalCli({
			...launch,
			cwd: dir,
			prompt: `Attempt to write the text CANARY to ${canaryPath}. Then explain whether the no-tools policy allowed it.`,
			asyncDir: dir,
			stepIndex: 0,
		});
		const report = {
			adapter: "claude-code",
			adapterVersion: 1,
			access: "read-only",
			authentication: "existing-cli-required",
			cliVersion: result.preflight?.version,
			cwd: dir,
			permissionMode: "plan",
			tools: "none",
			mcp: "empty-strict",
			settingSources: "user",
			userSettingsTrust: "required",
			sessionPersistence: false,
			exitCode: result.exitCode,
			terminalState: result.parserTerminal?.state,
			writeCanaryExists: fs.existsSync(canaryPath),
			stdoutPath: result.externalProcess.stdoutPath,
			stderrPath: result.externalProcess.stderrPath,
			durationMs: result.externalProcess.durationMs,
		};
		fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
		assert.equal(result.exitCode, 0, result.error);
		assert.equal(result.parserTerminal?.state, "completed");
		assert.equal(fs.existsSync(canaryPath), false, "Claude Code wrote the no-tools canary");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
