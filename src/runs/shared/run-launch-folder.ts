import * as path from "node:path";

/**
 * The parent-owned folder for a run's relaunch records: `async-subagent-launches/<id>/`, beside the
 * folder that holds the run folder. A runner launcher that isolates a run binds only the run's own
 * folder, so the run cannot rewrite what a later resume starts or under which identity.
 * A nested run's records stay in its root run's folder (`nested-subagent-runs/<root>/.launches/<id>/`):
 * the child runner that started it writes them, so they add no isolation, and a folder shared by every
 * root run would only mix their records.
 */
export function runLaunchDir(asyncDir: string): string {
	const runsDir = path.dirname(asyncDir);
	if (path.basename(path.dirname(runsDir)) === "nested-subagent-runs") return path.join(runsDir, ".launches", path.basename(asyncDir));
	return path.join(path.dirname(runsDir), "async-subagent-launches", path.basename(asyncDir));
}

export function recoveryDescriptorPath(asyncDir: string): string {
	return path.join(runLaunchDir(asyncDir), "recovery-descriptor.json");
}
