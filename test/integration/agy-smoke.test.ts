import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { resolveAgyLaunch } from "../../src/runs/shared/agy-adapter.ts";
import { runExternalCli } from "../../src/runs/shared/external-cli-runner.ts";

const enabled = process.env.PI_SUBAGENTS_AGY_SMOKE === "1";

function requiredDirectory(name: string): string {
	const value = process.env[name];
	assert.ok(value?.trim(), `${name} is required`);
	const directory = fs.realpathSync(path.resolve(value));
	assert.ok(fs.statSync(directory).isDirectory(), `${name} must be an existing directory`);
	return directory;
}

test("maintainer agy-writer smoke", { skip: enabled ? undefined : "set PI_SUBAGENTS_AGY_SMOKE=1" }, async () => {
	const reportPath = process.env.PI_SUBAGENTS_AGY_SMOKE_REPORT;
	assert.ok(reportPath, "PI_SUBAGENTS_AGY_SMOKE_REPORT is required");
	// Override only the child environment; the test process keeps its isolated HOME.
	const cliHome = requiredDirectory("PI_SUBAGENTS_AGY_SMOKE_HOME");
	const workspace = requiredDirectory("PI_SUBAGENTS_AGY_SMOKE_WORKSPACE");
	const canaryPath = path.join(workspace, "pi-subagents-agy-write-canary.txt");
	assert.equal(fs.existsSync(canaryPath), false, "smoke canary must not already exist");
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-agy-smoke-"));
	const promptMarker = "AGY_WRITER_PRIVATE_PROMPT_MARKER";
	try {
		const command = process.env.PI_SUBAGENTS_AGY_COMMAND || "agy";
		const launch = resolveAgyLaunch({ adapter: "agy-writer", command });
		const result = await runExternalCli({
			...launch,
			environment: { ...launch.environment, values: { HOME: cliHome, USERPROFILE: cliHome } },
			cwd: workspace,
			prompt: `${promptMarker}: Create the file ${canaryPath} containing the exact text CANARY, then reply with the file path.`,
			asyncDir: dir,
			stepIndex: 0,
		});
		const report = {
			adapter: "agy-writer",
			adapterVersion: 1,
			cliVersion: result.preflight?.version,
			cwd: workspace,
			promptDelivery: "stdin",
			authentication: "existing-cli-required",
			access: "workspace-write",
			permissionMode: "accept-edits",
			exitCode: result.exitCode,
			terminalState: result.parserTerminal?.state,
			writeCanaryMatches: fs.existsSync(canaryPath) && fs.readFileSync(canaryPath, "utf-8").trim() === "CANARY",
			stdoutPath: result.externalProcess.stdoutPath,
			stderrPath: result.externalProcess.stderrPath,
			durationMs: result.externalProcess.durationMs,
		};
		const serialized = `${JSON.stringify(report, null, 2)}\n`;
		assert.equal(serialized.includes(promptMarker), false);
		fs.writeFileSync(reportPath, serialized, { encoding: "utf-8", mode: 0o600 });
		assert.equal(result.exitCode, 0, result.error);
		assert.equal(result.parserTerminal?.state, "completed");
		assert.equal(report.writeCanaryMatches, true, "agy-writer did not write the canary");
	} finally {
		fs.rmSync(canaryPath, { force: true });
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
