import * as fs from "node:fs";
import * as path from "node:path";
import * as sdk from "@earendil-works/pi-coding-agent";
import { installRunnerHttpDispatcher } from "./runner-http-dispatcher.ts";
import { runConfiguredSubagent, type SubagentRunConfig } from "./subagent-runner.ts";
import { getAgentDir } from "../../shared/utils.ts";

/**
 * Pi's extension loader supplies the embedded SDK. Bare Bun/Node cannot replace
 * it: an apparent import success can be an auto-installed, different SDK.
 * Await the configured runner inside extension initialization so the outer Pi
 * session/RPC loop never starts. Exit only after shared disposal/lease release.
 * Derived from xz-dev's PR #2049, commit 910807bfefcf9ee41d73fa25ec86dcd75ab8f4b2.
 */
export default async function runBinaryBootstrap(): Promise<never> {
	const configPath = process.env.PI_SUBAGENT_RUNNER_CONFIG;
	delete process.env.PI_SUBAGENT_RUNNER_CONFIG;
	try {
		if (!configPath || !path.isAbsolute(configPath)) throw new Error("Missing absolute PI_SUBAGENT_RUNNER_CONFIG path");
		const config = JSON.parse(fs.readFileSync(configPath, "utf8")) as SubagentRunConfig;
		if (!config || typeof config.id !== "string" || typeof config.asyncDir !== "string" || !Array.isArray(config.steps)) {
			throw new Error("Invalid binary runner configuration");
		}
		try {
			fs.unlinkSync(configPath);
		} catch {
			// Temp-config cleanup is best effort, as in the Node entrypoint.
		}
		// Pi applies httpIdleTimeoutMs to its dispatcher only after extension
		// factories return; this factory never does, so install the runner's own.
		installRunnerHttpDispatcher({ agentDir: getAgentDir(), cwd: process.cwd() });
		await runConfiguredSubagent(config, { loadPiCodingAgent: async () => sdk });
		process.exit(0);
	} catch (error) {
		console.error("Subagent binary runner error:", error);
		process.exit(1);
	}
}
