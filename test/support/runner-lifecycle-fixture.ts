import { ChildProcess } from "node:child_process";
import { createOwnedProcessTreeController, type OwnedProcessTreeController } from "../../src/runs/background/owned-process-tree.ts";
import { readProcessTerminal } from "../../src/runs/background/process-terminal.ts";
import { setAsyncRunnerTestObserver } from "../../src/runs/background/async-execution.ts";
import { createWindowsTestProcessTreeController } from "./windows-owned-process-tree.ts";

const NATURAL_EXIT_GRACE_MS = 250;
const EXIT_VERIFY_MS = 4_500;
const POLL_MS = 25;

export interface OwnedTestRunnerIdentity {
	runId: string;
	asyncDir: string;
	runnerProcessInstanceId: string;
}

interface OwnedTestRunner extends OwnedTestRunnerIdentity {
	pid: number;
	processTree: OwnedProcessTreeController;
	closed: Promise<void>;
	isClosed: () => boolean;
}

export interface TestRunnerCleanupResult {
	runId: string;
	pid: number;
	natural: boolean;
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function unrefDelay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms).unref());
}

function runnerIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

/** Owns only detached runners observed while one fixture test is active. */
export class TestRunnerLifecycle {
	private readonly owned = new Map<string, OwnedTestRunner>();
	private currentTest = "unknown test";
	private installed = false;
	private readonly naturalExitGraceMs: number;
	private readonly exitVerifyMs: number;
	private readonly createProcessTree: (pid: number) => OwnedProcessTreeController;

	constructor(options: { naturalExitGraceMs?: number; exitVerifyMs?: number; createProcessTree?: (pid: number) => OwnedProcessTreeController } = {}) {
		this.naturalExitGraceMs = options.naturalExitGraceMs ?? NATURAL_EXIT_GRACE_MS;
		this.exitVerifyMs = options.exitVerifyMs ?? EXIT_VERIFY_MS;
		this.createProcessTree = options.createProcessTree ?? (process.platform === "win32"
			? (pid) => createWindowsTestProcessTreeController(pid)
			: (pid) => createOwnedProcessTreeController(pid, { termGraceMs: 1_000, killVerifyMs: 1_000 }));
	}

	install(): void {
		if (this.installed) return;
		this.installed = true;
		setAsyncRunnerTestObserver((proc, identity) => this.track(proc, identity));
	}

	uninstall(): void {
		if (!this.installed) return;
		this.installed = false;
		setAsyncRunnerTestObserver(undefined);
	}

	beginTest(name: string): void {
		this.currentTest = name;
	}

	track(proc: ChildProcess, identity: OwnedTestRunnerIdentity): void {
		const key = `${identity.runId}\0${identity.runnerProcessInstanceId}`;
		if (typeof proc.pid !== "number" || this.owned.has(key)) return;
		let closed = false;
		let resolveClosed!: () => void;
		const closedPromise = new Promise<void>((resolve) => { resolveClosed = resolve; });
		const markClosed = () => {
			if (closed) return;
			closed = true;
			proc.off("close", markClosed);
			resolveClosed();
		};
		proc.once("close", markClosed);
		setImmediate(() => {
			if (proc.exitCode !== null || proc.signalCode !== null) markClosed();
		}).unref();
		this.owned.set(key, { ...identity, pid: proc.pid, processTree: this.createProcessTree(proc.pid), closed: closedPromise, isClosed: () => closed });
	}

	private async waitForNaturalExit(entry: OwnedTestRunner): Promise<boolean> {
		const deadline = Date.now() + this.naturalExitGraceMs;
		while (Date.now() < deadline) {
			if (entry.isClosed()) return true;
			await delay(Math.min(POLL_MS, deadline - Date.now()));
		}
		return entry.isClosed();
	}

	async cleanup(): Promise<TestRunnerCleanupResult[]> {
		const entries = [...this.owned.entries()];
		const settled = await Promise.allSettled(entries.map(async ([, entry]): Promise<TestRunnerCleanupResult> => {
			if (await this.waitForNaturalExit(entry)) return { runId: entry.runId, pid: entry.pid, natural: true };
			// A close observed after the grace check is still a natural exit. Never
			// signal its recorded PID or process group after that observation.
			if (entry.isClosed()) {
				return { runId: entry.runId, pid: entry.pid, natural: true };
			}
			const proof = await entry.processTree.terminate();
			await Promise.race([entry.closed, unrefDelay(this.exitVerifyMs)]);
			if (!entry.isClosed() || runnerIsAlive(entry.pid) || proof.state !== "observed") throw this.cleanupError(entry, proof);
			return { runId: entry.runId, pid: entry.pid, natural: false };
		}));
		for (const [index, result] of settled.entries()) {
			if (result.status !== "fulfilled") continue;
			const [key, entry] = entries[index]!;
			if (this.owned.get(key) === entry) this.owned.delete(key);
		}
		const failures = settled.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
		if (failures.length > 0) {
			const messages = failures.map((failure) => failure instanceof Error ? failure.message : String(failure));
			throw new AggregateError(failures, `Fixture teardown failed for ${failures.length} owned async runner(s) during '${this.currentTest}'.\n${messages.join("\n---\n")}`);
		}
		return settled.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
	}

	private cleanupError(entry: OwnedTestRunner, proof?: unknown, reason = "Owned runner did not reach verified process-tree terminal state."): Error {
		const terminal = readProcessTerminal(entry.asyncDir, { runId: entry.runId, runnerProcessInstanceId: entry.runnerProcessInstanceId });
		return new Error([
			`Fixture teardown leaked owned async runner during '${this.currentTest}': ${reason}`,
			`runId=${entry.runId} pid=${entry.pid} runnerProcessInstanceId=${entry.runnerProcessInstanceId}`,
			`asyncDir=${entry.asyncDir}`,
			`processTree=${JSON.stringify(proof)} processTerminal=${JSON.stringify(terminal)}`,
		].join("\n"));
	}
}
