import * as path from "node:path";

/**
 * The parent-owned folder for a run's relaunch records: `async-subagent-launches/<id>/`, beside the
 * folder that holds the run folder. A runner launcher that isolates a run binds only the run's own
 * folder, so the run cannot rewrite what a later resume starts or under which identity.
 */
export function runLaunchDir(asyncDir: string): string {
	return path.join(path.dirname(path.dirname(asyncDir)), "async-subagent-launches", path.basename(asyncDir));
}

export function recoveryDescriptorPath(asyncDir: string): string {
	return path.join(runLaunchDir(asyncDir), "recovery-descriptor.json");
}
