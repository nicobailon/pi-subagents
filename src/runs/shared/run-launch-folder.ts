import * as path from "node:path";

/**
 * The parent-owned folder for a run's relaunch records: `async-subagent-launches/<id>/`, beside the
 * runs root that holds the run folder. A runner launcher that isolates a run binds only the run's own
 * folder, so the run cannot rewrite what a later resume starts or under which identity.
 * Callers pass a runs root they know (never one derived from a requested path), because a run can
 * build a runs-shaped tree inside its own folder.
 * A nested run's records stay in its root run's folder (`nested-subagent-runs/<root>/.launches/<id>/`):
 * the child runner that started it writes them, so they add no isolation, and a folder shared by every
 * root run would only mix their records.
 */
export function runLaunchDir(runsRoot: string, runId: string): string {
	if (!runId || runId !== path.basename(runId) || runId === "." || runId === "..") throw new Error(`Invalid run id for a launch folder: '${runId}'.`);
	if (path.basename(path.dirname(runsRoot)) === "nested-subagent-runs") return path.join(runsRoot, ".launches", runId);
	return path.join(path.dirname(runsRoot), "async-subagent-launches", runId);
}

export function recoveryDescriptorPath(runsRoot: string, runId: string): string {
	return path.join(runLaunchDir(runsRoot, runId), "recovery-descriptor.json");
}
