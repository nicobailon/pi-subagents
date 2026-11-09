import { fork, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { realpathSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

const WORKFLOW_WORKER_URL = new URL("../../workflow-script-worker.cjs", import.meta.url);
const WORKFLOW_PROCESS_URL = new URL("../../workflow-script-process.cjs", import.meta.url);

export class WorkflowScriptProcess extends EventEmitter {
	readonly child: ChildProcess;
	private exitCode: number | undefined;
	private stopping = false;
	private stderr = "";

	constructor(acornPath: string) {
		super();
		const acorn = realpathSync(acornPath);
		// Fork a path, not the URL. A host that runs Pi on Electron does not strip execArgv from a child started
		// from a file URL, so the flags below would arrive in the child's argv ahead of the script.
		this.child = fork(fileURLToPath(WORKFLOW_PROCESS_URL), [acorn], {
			// Under --permission, Node lets worker threads read everything under the process cwd, so the cwd must
			// hold only public files: acorn's own directory. It also never holds a caller's cwd open on Windows.
			cwd: dirname(acorn),
			// No inherited execArgv or NODE_OPTIONS. Only the supervisor may create a worker.
			execArgv: [
				"--permission", "--allow-worker",
				`--allow-fs-read=${realpathSync(fileURLToPath(WORKFLOW_PROCESS_URL))}`,
				`--allow-fs-read=${realpathSync(fileURLToPath(WORKFLOW_WORKER_URL))}`,
				`--allow-fs-read=${acorn}`,
			],
			env: process.platform === "win32" && process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {},
			stdio: ["ignore", "ignore", "pipe", "ipc"],
		});
		this.child.stderr!.on("data", (chunk: Buffer) => { this.stderr = (this.stderr + chunk.toString("utf8")).slice(-4096); });
		this.child.on("error", (error) => this.emit("error", error));
		this.child.on("message", (json) => {
			if (this.stopping) return;
			try {
				if (typeof json !== "string") throw new Error("Workflow process sent a non-string IPC message.");
				const message: unknown = JSON.parse(json);
				if (!message || typeof message !== "object" || Array.isArray(message)) throw new Error("Workflow process sent an invalid IPC message.");
				this.emit("message", message);
			} catch (error) { this.emit("error", error); }
		});
		this.child.on("exit", (code) => {
			this.exitCode = code ?? 1;
			this.child.stderr!.destroy();
			if (!this.stopping && code !== 0 && this.stderr.trim()) this.emit("error", new Error(this.stderr.trim()));
			this.emit("exit", this.exitCode);
		});
	}

	postMessage(message: unknown): void {
		if (this.stopping || !this.child.connected) return;
		this.child.send(JSON.stringify(message), (error) => {
			if (error && !this.stopping) this.emit("error", error);
		});
	}

	async terminate(): Promise<number> {
		if (this.exitCode !== undefined) return this.exitCode;
		this.stopping = true;
		return await new Promise((resolve) => {
			this.once("exit", resolve);
			this.child.kill("SIGKILL");
		});
	}
}

export function createWorkflowScriptWorker(acornPath: string): Worker | WorkflowScriptProcess {
	// Bun has no permission model. Keep its existing file worker; do not claim process isolation there.
	return typeof process.versions.bun === "string"
		? new Worker(WORKFLOW_WORKER_URL, { workerData: { acornPath } })
		: new WorkflowScriptProcess(acornPath);
}
