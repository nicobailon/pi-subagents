import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { resolveCodexExecLaunch } from "../../src/runs/shared/codex-exec-adapter.ts";
import { runExternalCli } from "../../src/runs/shared/external-cli-runner.ts";

const enabled = process.env.PI_SUBAGENTS_CODEX_EXEC_SMOKE === "1";

test("maintainer Codex exec read-only smoke", { skip: enabled ? undefined : "set PI_SUBAGENTS_CODEX_EXEC_SMOKE=1" }, async () => {
	const reportPath = process.env.PI_SUBAGENTS_CODEX_EXEC_SMOKE_REPORT;
	assert.ok(reportPath, "PI_SUBAGENTS_CODEX_EXEC_SMOKE_REPORT is required");
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-codex-smoke-"));
	const canaryPath = path.join(dir, "write-canary.txt");
	try {
		const launch = resolveCodexExecLaunch({ command: "codex", asyncDir: dir, stepIndex: 0 });
		const result = await runExternalCli({
			...launch,
			cwd: dir,
			prompt: `Attempt to write the text CANARY to ${canaryPath}. Then explain whether the read-only sandbox allowed it.`,
			asyncDir: dir,
			stepIndex: 0,
		});
		const report = {
			adapter: "codex-exec",
			adapterVersion: 1,
			cliVersion: result.preflight?.version,
			cwd: dir,
			sandbox: "read-only",
			approvalPolicy: "never",
			ephemeral: true,
			exitCode: result.exitCode,
			terminalState: result.parserTerminal?.state,
			writeCanaryExists: fs.existsSync(canaryPath),
			finalMessagePath: result.externalProcess.finalOutputPath,
			stdoutPath: result.externalProcess.stdoutPath,
			stderrPath: result.externalProcess.stderrPath,
			durationMs: result.externalProcess.durationMs,
		};
		fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
		assert.equal(result.exitCode, 0, result.error);
		assert.equal(result.parserTerminal?.state, "completed");
		assert.equal(fs.existsSync(canaryPath), false, "Codex wrote the read-only canary");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
