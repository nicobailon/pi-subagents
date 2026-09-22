import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as sdk from "@earendil-works/pi-coding-agent";
import { installRunnerHttpDispatcher } from "./runner-http-dispatcher.ts";
import { runConfiguredSubagent, validateSubagentRunConfig } from "./subagent-runner-bootstrap.ts";
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
		const rawConfig: unknown = JSON.parse(fs.readFileSync(configPath, "utf8"));
		validateSubagentRunConfig(rawConfig);
		const config = rawConfig;
		try {
			fs.unlinkSync(configPath);
		} catch {
			// Temp-config cleanup is best effort, as in the Node entrypoint.
		}
		// Pi applies httpIdleTimeoutMs to its dispatcher only after extension
		// factories return; this factory never does, so install the runner's own.
		installRunnerHttpDispatcher({ agentDir: getAgentDir(), cwd: process.cwd() });
		await runConfiguredSubagent(config, {
			loadPiCodingAgent: async () => sdk,
			loadExecutionModule: async () => createRequire(import.meta.url)(`./subagent-runner${path.extname(fileURLToPath(import.meta.url))}`),
		});
		process.exit(0);
	} catch (error) {
		console.error("Subagent binary runner error:", error);
		process.exit(1);
	}
}
