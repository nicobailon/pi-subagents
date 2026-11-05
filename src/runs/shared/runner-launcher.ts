import type { AgentConfig } from "../../agents/agents.ts";
import { agentDefinitionDigest } from "../../shared/launch-contract.ts";
import type { RequiredRunnerLauncher, RunnerLauncher } from "../../shared/types.ts";

export const REQUIRE_LAUNCHER_SHAPE_ERROR = "requireLauncher is supported only on a top-level single-agent call (agent + task); it cannot be combined with tasks, chain, workflow, an action, resume, or a workflow child.";

/** Own-property lookup, so an inherited object key can never select a command. */
export function lookupRunnerLauncher(runnerLaunchers: Record<string, string[]> | undefined, name: string): RunnerLauncher | undefined {
	const argv = runnerLaunchers && Object.hasOwn(runnerLaunchers, name) ? runnerLaunchers[name] : undefined;
	return argv ? { name, argv: [...argv] } : undefined;
}

/** A launcher wraps the local Pi background runner, so it cannot combine with machine placement or an external runner. */
export function runnerLauncherPlacementError(agent: Pick<AgentConfig, "name" | "launcher" | "runner">, machine: string | undefined): string | undefined {
	if (agent.launcher === undefined) return undefined;
	const runnerType = agent.runner?.type === "external-cli" || agent.runner?.type === "external-job" ? agent.runner.type : undefined;
	if (!machine && !runnerType) return undefined;
	return `Agent '${agent.name}' uses launcher '${agent.launcher}', which wraps the local Pi background runner, so it cannot run ${machine ? `on machine '${machine}'` : `with runner.type='${runnerType}'`}.`;
}

/** The launcher an agent launch runs under, or the reason it cannot launch. */
export function resolveAgentRunnerLauncher(agent: Pick<AgentConfig, "name" | "launcher" | "runner">, runnerLaunchers: Record<string, string[]> | undefined, machine: string | undefined): { launcher?: RunnerLauncher; error?: string } {
	if (agent.launcher === undefined) return {};
	const placementError = runnerLauncherPlacementError(agent, machine);
	if (placementError) return { error: placementError };
	const launcher = lookupRunnerLauncher(runnerLaunchers, agent.launcher);
	return launcher ? { launcher } : { error: `Agent '${agent.name}' uses launcher '${agent.launcher}', which is not defined in runnerLaunchers in the user subagent config.` };
}

/**
 * Checks a call's launcher requirement against the agent and launcher a launch resolved. On a match it returns the
 * digest it checked, so the launch can record that digest instead of hashing the agent file again.
 */
export function checkRequiredRunnerLauncher(agent: AgentConfig, launcherName: string | undefined, required: RequiredRunnerLauncher): { definitionDigest: string; error?: undefined } | { error: string } {
	if (launcherName === undefined) return { error: `Agent '${agent.name}' has no launcher, but the call requires launcher '${required.name}'.` };
	if (launcherName !== required.name) return { error: `Agent '${agent.name}' uses launcher '${launcherName}', but the call requires launcher '${required.name}'.` };
	const definitionDigest = agentDefinitionDigest(agent);
	if (definitionDigest !== required.definitionDigest) return { error: `Agent '${agent.name}' definition digest is ${definitionDigest}, but the call requires ${required.definitionDigest}; the agent definition changed after it was checked.` };
	return { definitionDigest };
}
