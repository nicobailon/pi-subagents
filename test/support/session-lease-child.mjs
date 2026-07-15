import { spawn } from "node:child_process";
import * as fs from "node:fs";
import { acquireSessionLease } from "../../src/runs/shared/session-lease.ts";

const [sessionFile, rootDir, releaseSignal, mode = "hold"] = process.argv.slice(2);
if (!sessionFile || !rootDir) throw new Error("sessionFile and rootDir are required");

let lease;
try {
	lease = acquireSessionLease({
		sessionFile,
		runId: `child-${process.pid}`,
		sourceRunId: "source-child",
		parentSessionId: "parent-child",
	}, { rootDir });
} catch (error) {
	process.stdout.write(`${JSON.stringify({ acquired: false, error: error instanceof Error ? error.message : String(error) })}\n`);
	process.exit(2);
}
if (mode === "abandon-with-writer") {
	lease.updateWriter({ state: "spawning" });
	const writer = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
		detached: true,
		stdio: "ignore",
	});
	if (typeof writer.pid !== "number") throw new Error("writer pid is unavailable");
	lease.updateWriter({ state: "running", pid: writer.pid });
	writer.unref();
	process.stdout.write(`${JSON.stringify({ acquired: true, owner: lease.owner, writerPid: writer.pid })}\n`);
	process.exit(0);
}

process.stdout.write(`${JSON.stringify({ acquired: true, owner: lease.owner })}\n`);
if (mode === "abandon") process.exit(0);
if (!releaseSignal) throw new Error("releaseSignal is required in hold mode");

const timer = setInterval(() => {
	if (!fs.existsSync(releaseSignal)) return;
	clearInterval(timer);
	lease.release();
	process.exit(0);
}, 20);
