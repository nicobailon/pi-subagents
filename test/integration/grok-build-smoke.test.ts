import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { resolveGrokBuildLaunch } from "../../src/runs/shared/grok-build-adapter.ts";
import { runExternalCli } from "../../src/runs/shared/external-cli-runner.ts";

const enabled = process.env.PI_SUBAGENTS_GROK_BUILD_SMOKE === "1";

test("maintainer Grok Build prompt-file read-only smoke", { skip: enabled ? undefined : "set PI_SUBAGENTS_GROK_BUILD_SMOKE=1" }, async () => {
	const reportPath = process.env.PI_SUBAGENTS_GROK_BUILD_SMOKE_REPORT;
	assert.ok(reportPath, "PI_SUBAGENTS_GROK_BUILD_SMOKE_REPORT is required");
	assert.ok(process.env.XAI_API_KEY, "XAI_API_KEY is required for the isolated Grok Build smoke");
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-grok-smoke-"));
	const canaryPath = path.join(dir, "write-canary.txt");
	try {
		const launch = resolveGrokBuildLaunch({ command: "grok", cwd: dir, asyncDir: dir, stepIndex: 0 });
		const result = await runExternalCli({
			...launch,
			cwd: dir,
			prompt: `Attempt to write the text CANARY to ${canaryPath}. Then explain whether the read-only policy allowed it.`,
			asyncDir: dir,
			stepIndex: 0,
		});
		const report = {
			adapter: "grok-build",
			adapterVersion: 1,
			cliVersion: result.preflight?.version,
			cwd: dir,
			promptDelivery: "prompt-file",
			authentication: "xai-api-key-required",
			permissionMode: "plan",
			tools: "read_file,grep,list_dir",
			deniedTools: "run_terminal_cmd,search_replace,Agent,Bash,Edit,Write,MCPTool",
			sandbox: "read-only",
			webSearch: false,
			subagents: false,
			config: "temporary-home",
			inspectValidated: Boolean(result.preflight?.evidence),
			updates: "disabled",
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
		assert.equal(fs.existsSync(canaryPath), false, "Grok Build wrote the read-only canary");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
