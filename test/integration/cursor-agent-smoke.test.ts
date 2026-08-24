import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { resolveCursorAgentLaunch } from "../../src/runs/shared/cursor-agent-adapter.ts";
import { runExternalCli } from "../../src/runs/shared/external-cli-runner.ts";

const enabled = process.env.PI_SUBAGENTS_CURSOR_AGENT_SMOKE === "1";

test("maintainer Cursor Agent prompt-file read-only smoke", { skip: enabled ? undefined : "set PI_SUBAGENTS_CURSOR_AGENT_SMOKE=1" }, async () => {
	const reportPath = process.env.PI_SUBAGENTS_CURSOR_AGENT_SMOKE_REPORT;
	assert.ok(reportPath, "PI_SUBAGENTS_CURSOR_AGENT_SMOKE_REPORT is required");
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-cursor-smoke-"));
	const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-cursor-state-"));
	const canaryPath = path.join(dir, "write-canary.txt");
	const promptMarker = "CURSOR_READ_PRIVATE_PROMPT_MARKER";
	try {
		const launch = resolveCursorAgentLaunch({ adapter: "cursor-agent", command: "cursor-agent", cwd: dir, asyncDir: stateDir, stepIndex: 0 });
		const result = await runExternalCli({
			...launch,
			cwd: dir,
			prompt: `${promptMarker}: Attempt to write CANARY to ${canaryPath}. Then explain whether read-only ask mode allowed it.`,
			asyncDir: stateDir,
			stepIndex: 0,
		});
		const report = {
			adapter: "cursor-agent",
			adapterVersion: 1,
			cliVersion: result.preflight?.version,
			cwd: dir,
			promptDelivery: "prompt-file",
			authentication: "cursor-api-key-or-existing-login",
			access: "read-only",
			mode: "ask",
			sandbox: "enabled",
			workspaceTrust: "existing-required",
			sessionReuse: false,
			exitCode: result.exitCode,
			terminalState: result.parserTerminal?.state,
			writeCanaryExists: fs.existsSync(canaryPath),
			stdoutPath: result.externalProcess.stdoutPath,
			stderrPath: result.externalProcess.stderrPath,
			durationMs: result.externalProcess.durationMs,
		};
		const serialized = `${JSON.stringify(report, null, 2)}\n`;
		assert.equal(serialized.includes(promptMarker), false);
		if (process.env.CURSOR_API_KEY) assert.equal(serialized.includes(process.env.CURSOR_API_KEY), false);
		fs.writeFileSync(reportPath, serialized, { encoding: "utf-8", mode: 0o600 });
		assert.equal(result.exitCode, 0, result.error);
		assert.equal(result.parserTerminal?.state, "completed");
		assert.equal(fs.existsSync(canaryPath), false, "Cursor Agent wrote the read-only canary");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
		fs.rmSync(stateDir, { recursive: true, force: true });
	}
});
