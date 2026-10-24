import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { remoteShellCommand, runBoundedCommand } from "./herdr-connection.ts";
import type { PlacementCommandResult, PlacementMachineAccess, PlacementSockets } from "./placement-host.ts";

const DEFAULT_TIMEOUT_MS = 15_000, DEFAULT_MAX_BUFFER = 256 * 1024;

/** Sockets on this machine are already reachable: forwarding returns the path unchanged and closing is a no-op. */
function localSockets(): PlacementSockets {
	return {
		async forwardRemoteSocket(socketPath) { if (!path.isAbsolute(socketPath)) throw new Error("Local socket path must be absolute."); return { socketPath, async close() {} }; },
		async close() {},
	};
}

/** Machine access for the parent's own machine: the same quoted `sh -c` scripts the SSH access sends, run directly through /bin/sh. */
export function localMachineAccess(options: { env?: NodeJS.ProcessEnv } = {}): PlacementMachineAccess {
	const env = options.env ?? process.env;
	return {
		shellCommand: remoteShellCommand,
		run(command, limits = {}) {
			const spawned = spawnSync("/bin/sh", ["-c", command], { encoding: "utf8", env, timeout: limits.timeout ?? DEFAULT_TIMEOUT_MS, maxBuffer: limits.maxBuffer ?? DEFAULT_MAX_BUFFER, windowsHide: true });
			const result: PlacementCommandResult = { status: spawned.status, stdout: spawned.stdout ?? "", stderr: spawned.stderr ?? "" };
			if (spawned.error) result.error = spawned.error;
			return result;
		},
		runAsync: (command, limits = {}) => runBoundedCommand("/bin/sh", ["-c", command], { env, ...limits }),
		openSockets: localSockets,
	};
}
