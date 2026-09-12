/** Owner policy for unbounded local inference. This is deliberately not a tool argument. */
import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "../../shared/utils.ts";

export interface LocalInferenceConfig { enabled: boolean }

export function localInferenceEnabled(config: { localInference?: LocalInferenceConfig }): boolean {
	if (config.localInference === undefined) return false;
	if (!config.localInference || typeof config.localInference !== "object"
		|| Array.isArray(config.localInference) || typeof config.localInference.enabled !== "boolean"
		|| Object.keys(config.localInference).some((key) => key !== "enabled")) {
		throw new Error("localInference must be { enabled: true | false }; refusing to silently restore timeout defaults");
	}
	return config.localInference.enabled;
}

/** Read at launch, including detached/resumed launches; malformed owner policy is fatal. */
export function readLocalInferencePolicy(): boolean {
	const configPath = path.join(getAgentDir(), "extensions", "subagent", "config.json");
	try {
		return localInferenceEnabled(JSON.parse(fs.readFileSync(configPath, "utf8")));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw new Error(`Cannot enforce local-AI timeout policy from ${configPath}`, { cause: error });
	}
}

/** Only execution clocks: do not rewrite tool, verification, or control-plane waits. */
export function withoutExecutionDeadline<T extends object>(value: T): T {
	const result = { ...value };
	for (const key of ["timeoutMs", "maxRuntimeMs", "deadlineAt", "workflowParentDeadlineAt"] as const) {
		delete (result as Record<string, unknown>)[key];
	}
	return result;
}

export const LOCAL_INFERENCE_POLICY_NOTICE = "Local inference: execution and inference deadlines disabled by owner policy; manual cancellation remains enabled.";
