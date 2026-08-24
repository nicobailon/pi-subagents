import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { resolveCodexExecLaunch } from "../../src/runs/shared/codex-exec-adapter.ts";
import { runExternalCli } from "../../src/runs/shared/external-cli-runner.ts";

const enabled = process.env.PI_SUBAGENTS_CODEX_EXEC_WRITER_SMOKE === "1";

test("maintainer Codex exec workspace writer smoke", { skip: enabled ? undefined : "set PI_SUBAGENTS_CODEX_EXEC_WRITER_SMOKE=1" }, async () => {
	const reportPath = process.env.PI_SUBAGENTS_CODEX_EXEC_WRITER_SMOKE_REPORT;
	assert.ok(reportPath, "PI_SUBAGENTS_CODEX_EXEC_WRITER_SMOKE_REPORT is required");
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-codex-writer-smoke-"));
	const canaryPath = path.join(dir, "write-canary.txt");
	const promptMarker = "CODEX_WRITER_PRIVATE_PROMPT_MARKER";
	try {
		const launch = resolveCodexExecLaunch({ adapter: "codex-exec-writer", command: "codex", asyncDir: dir, stepIndex: 0 });
		const result = await runExternalCli({
			...launch,
			cwd: dir,
			prompt: `${promptMarker}: Write exactly CANARY to ${canaryPath}. Then report completion.`,
			asyncDir: dir,
			stepIndex: 0,
		});
		const writeCanaryExists = fs.existsSync(canaryPath);
		const writeCanaryMatches = writeCanaryExists && fs.readFileSync(canaryPath, "utf-8").trim() === "CANARY";
		const report = {
			adapter: "codex-exec-writer",
			adapterVersion: 1,
			cliVersion: result.preflight?.version,
			cwd: dir,
			access: "workspace-write",
			sandbox: "workspace-write",
			approvalPolicy: "never",
			ephemeral: true,
			exitCode: result.exitCode,
			terminalState: result.parserTerminal?.state,
			writeCanaryExists,
			writeCanaryMatches,
			finalMessagePath: result.externalProcess.finalOutputPath,
			stdoutPath: result.externalProcess.stdoutPath,
			stderrPath: result.externalProcess.stderrPath,
			durationMs: result.externalProcess.durationMs,
		};
		const serialized = `${JSON.stringify(report, null, 2)}\n`;
		assert.equal(serialized.includes(promptMarker), false);
		if (process.env.OPENAI_API_KEY) assert.equal(serialized.includes(process.env.OPENAI_API_KEY), false);
		if (process.env.CODEX_API_KEY) assert.equal(serialized.includes(process.env.CODEX_API_KEY), false);
		fs.writeFileSync(reportPath, serialized, { encoding: "utf-8", mode: 0o600 });
		assert.equal(result.exitCode, 0, result.error);
		assert.equal(result.parserTerminal?.state, "completed");
		assert.equal(writeCanaryMatches, true, "Codex did not write the expected canary");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
