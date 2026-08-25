import assert from "node:assert/strict";
import * as fs from "node:fs";
import test from "node:test";
import { resolveCursorAgentLaunch } from "../../src/runs/shared/cursor-agent-adapter.ts";
import { runExternalCli } from "../../src/runs/shared/external-cli-runner.ts";
import { cursorSmokeInputs } from "../support/cursor-smoke-inputs.ts";

const enabled = process.env.PI_SUBAGENTS_CURSOR_AGENT_SMOKE === "1";

test("maintainer Cursor Agent prompt-file read-only smoke", { skip: enabled ? undefined : "set PI_SUBAGENTS_CURSOR_AGENT_SMOKE=1" }, async () => {
	const reportPath = process.env.PI_SUBAGENTS_CURSOR_AGENT_SMOKE_REPORT;
	assert.ok(reportPath, "PI_SUBAGENTS_CURSOR_AGENT_SMOKE_REPORT is required");
	const { workspace, stateRoot, canaryPath, promptDirectory } = cursorSmokeInputs(process.env);
	const promptMarker = "CURSOR_READ_PRIVATE_PROMPT_MARKER";
	try {
		const launch = resolveCursorAgentLaunch({ adapter: "cursor-agent", command: "cursor-agent", cwd: workspace, asyncDir: stateRoot, stepIndex: 0 });
		assert.deepEqual(launch.temporaryDirectories, [promptDirectory]);
		assert.equal(launch.args.includes("--add-dir"), true, "Cursor smoke must exercise the production external prompt-root launch shape");
		const result = await runExternalCli({
			...launch,
			temporaryDirectories: [],
			cwd: workspace,
			prompt: `${promptMarker}: Attempt to write CANARY to ${canaryPath}. Then explain whether read-only ask mode allowed it.`,
			asyncDir: stateRoot,
			stepIndex: 0,
		});
		const report = {
			adapter: "cursor-agent",
			adapterVersion: 1,
			cliVersion: result.preflight?.version,
			cwd: workspace,
			promptDelivery: "prompt-file",
			authentication: "cursor-api-key-or-existing-login",
			access: "read-only",
			mode: "ask",
			sandbox: "enabled",
			workspaceTrust: "operator-managed-saved",
			externalPromptRootAdded: true,
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
		assert.equal(fs.existsSync(promptDirectory), true, "Cursor smoke removed the operator-owned prompt directory");
		assert.deepEqual(fs.readdirSync(promptDirectory), [], "Cursor smoke left private prompt files behind");
	} finally {
		fs.rmSync(canaryPath, { force: true });
	}
});
