import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { getAgentDir } from "../../shared/utils.ts";
import { installRunnerHttpDispatcher } from "./runner-http-dispatcher.ts";
import { monitorTestParent, performRunnerStartupHandshake, publishCommittedStartupFailure, releaseStartupLease, type RunnerStartupOutcome } from "./runner-startup.ts";
import type { SubagentRunConfig } from "./subagent-runner.ts";

/**
 * Entry point of the detached async runner.
 *
 * The parent waits a fixed `RUNNER_STARTUP_TIMEOUT_MS` budget for the `ready`
 * handshake. Loading this file's execution graph can consume that whole budget
 * on its own — a cold module cache on Windows spends seconds reading the graph
 * before any startup code runs — so the startup handshake is completed here,
 * with a small import graph, and the heavy graph is imported only afterwards
 * (issue #2403). The runner keeps the acquired revival lease across the handoff.
 */
const isBootstrapEntrypoint = Boolean(process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href);

function readRunnerConfigFromArgv(configArg: string): SubagentRunConfig {
	const configJson = fs.readFileSync(configArg, "utf-8");
	const config = JSON.parse(configJson) as SubagentRunConfig;
	try {
		fs.unlinkSync(configArg);
	} catch {
		// Temp config cleanup is best effort.
	}
	return config;
}

function readRunnerConfigFromStdin(): Promise<SubagentRunConfig> {
	return new Promise((resolve, reject) => {
		let input = "";
		process.stdin.setEncoding("utf-8");
		process.stdin.on("data", (chunk) => { input += chunk; });
		process.stdin.on("end", () => {
			try {
				resolve(JSON.parse(input) as SubagentRunConfig);
			} catch (error) {
				reject(error);
			}
		});
	});
}

async function runBootstrapEntry(configArg: string | undefined): Promise<void> {
	// Detached Node runners skip Pi's CLI dispatcher setup; install the runner's own.
	installRunnerHttpDispatcher({ agentDir: getAgentDir(), cwd: process.cwd() });
	const config = configArg ? readRunnerConfigFromArgv(configArg) : await readRunnerConfigFromStdin();
	const startup: RunnerStartupOutcome = await performRunnerStartupHandshake(config);
	let handedOff = false;
	try {
		const { runConfiguredSubagent } = await import("./subagent-runner.ts");
		handedOff = true;
		await runConfiguredSubagent(config, undefined, startup);
	} catch (error) {
		// The runner releases the lease once it owns the run. Until then the
		// parent has already committed this run, so a failure must also stop the
		// run from holding capacity as if it were still starting.
		if (!handedOff) {
			releaseStartupLease(startup.lease);
			try {
				publishCommittedStartupFailure(config, error);
			} catch {
				// The parent's reconciliation still covers an unreadable status file.
			}
		}
		throw error;
	}
}

if (isBootstrapEntrypoint) {
	monitorTestParent();
	runBootstrapEntry(process.argv[2]).then(
		() => process.exit(0),
		(err) => {
			console.error("Subagent runner error:", err);
			process.exit(1);
		},
	);
}
