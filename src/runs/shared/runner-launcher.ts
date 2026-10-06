import type { AgentConfig } from "../../agents/agents.ts";
import type { RunnerLauncher } from "../../shared/types.ts";

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
