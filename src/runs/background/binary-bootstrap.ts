import * as fs from "node:fs";
import * as path from "node:path";
import * as sdk from "@earendil-works/pi-coding-agent";
import { runConfiguredSubagent, type SubagentRunConfig } from "./subagent-runner.ts";

/**
 * This module must be loaded by Pi's extension loader, not Node/jiti or bare Bun.
 * Only that loader supplies the binary's embedded SDK namespaces. BUN_BE_BUN=1
 * bypasses it, and an apparent import success can be an auto-downloaded, different
 * SDK version. The isolated standalone smoke has a negative control for this.
 * An earlier bare-Bun probe accidentally fetched a different filesystem SDK;
 * import success alone therefore says nothing about embedded-SDK compatibility.
 * Bun workflow support has also regressed on Node-only assumptions (#1158),
 * repaired in #1170 without a Node sidecar. Keep the runner's portable workflow
 * implementation; this bootstrap changes its host, not its execution protocol.
 * https://github.com/nicobailon/pi-subagents/issues/1158
 * https://github.com/nicobailon/pi-subagents/pull/1170
 *
 * Keep the host inside extension initialization until the shared runner finishes.
 * Returning early enters Pi's normal session/RPC loop, where stdin EOF and outer
 * resource loading would compete with background ownership. Explicit exit follows
 * configured-runner disposal/lease release, just as in the Node entrypoint.
 * https://github.com/nicobailon/pi-subagents/pull/1844
 * Regression gate: node test/smoke/standalone-matrix.mjs <official-pi> <fresh-root>.
 * This must include real startup failures, two sessions in one host, parallel
 * stop and competing revival; an import probe or cross-run workflow is not enough.
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
			// Consumption succeeded; temp-config cleanup is best effort, as in the Node entrypoint.
		}
		await runConfiguredSubagent(config, { loadPiCodingAgent: async () => sdk });
		process.exit(0);
	} catch (error) {
		console.error("Subagent binary runner error:", error);
		process.exit(1);
	}
}
