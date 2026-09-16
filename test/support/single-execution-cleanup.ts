import assert from "node:assert/strict";
import { retainSingleExecutionTempRoot } from "./isolated-temp-root.mjs";
import * as fs from "node:fs";
import * as path from "node:path";
import { SUBAGENT_ASYNC_STARTED_EVENT, SUBAGENT_PROCESS_TERMINAL_EVENT } from "../../src/shared/types.ts";
import { readProcessTerminal, sanitizeProcessTerminal } from "../../src/runs/background/process-terminal.ts";

type EventBus = { on(channel: string, handler: (payload: unknown) => void): () => void };
type Start = { id: string; asyncDir: string; pid: number; instance: string };
function record(value: unknown): Record<string, unknown> {
	assert.ok(value && typeof value === "object" && !Array.isArray(value), "expected event record");
	return value as Record<string, unknown>;
}

/** Only the two single-execution leaves opt into this parent-finalization barrier. */
export class SingleExecutionCleanup {
	private starts = new Map<string, Start>();
	private terminals = new Map<string, unknown>();
	private errors: unknown[] = [];
	private expected?: string;
	private expectedDir?: string;
	private waiting?: () => void;
	private deadline?: ReturnType<typeof setTimeout>;
	private unsubscribe: Array<() => void>;
	private settlement?: Promise<void>;
	private settled = false;
	private timeoutMs: number;
	private retainRoot: () => void;

	// Synthetic in-process controls substitute this callback: they own only os.tmpdir siblings.
	constructor(events: EventBus, timeoutMs = 15_000, retainRoot = retainSingleExecutionTempRoot) {
		this.retainRoot = retainRoot;
		this.timeoutMs = timeoutMs;
		const observe = (handler: (value: unknown) => void) => (value: unknown) => {
			try { handler(structuredClone(value)); } catch (error) { this.errors.push(error); }
			this.waiting?.(); // Observers never throw into production dispatch.
		};
		this.unsubscribe = [
			events.on(SUBAGENT_ASYNC_STARTED_EVENT, observe(value => {
				const start = record(value);
				assert.ok(typeof start.id === "string" && start.id.length > 0, "missing start ID");
				assert.ok(typeof start.asyncDir === "string" && path.isAbsolute(start.asyncDir), "missing start directory");
				assert.ok(typeof start.pid === "number" && Number.isInteger(start.pid) && start.pid > 0, "missing start PID");
				assert.equal(this.starts.has(start.id), false, "duplicate/conflicting start");
				const status = record(JSON.parse(fs.readFileSync(path.join(start.asyncDir, "status.json"), "utf-8")));
				assert.equal(status.runId, start.id, "status run mismatch");
				assert.equal(status.pid, start.pid, "status PID mismatch");
				const proof = sanitizeProcessTerminal(status.processTerminal, { runId: start.id });
				assert.ok(proof && (proof.state === "pending" || proof.state === "observed"), "invalid start runner identity");
				this.starts.set(start.id, { id: start.id, asyncDir: start.asyncDir, pid: start.pid, instance: proof.runnerProcessInstanceId });
			})),
			events.on(SUBAGENT_PROCESS_TERMINAL_EVENT, observe(value => {
				const proof = record(value);
				assert.ok(typeof proof.runId === "string" && proof.runId.length > 0, "missing terminal run ID");
				assert.equal(this.terminals.has(proof.runId), false, "duplicate/conflicting terminal");
				this.terminals.set(proof.runId, value);
			})),
		];
	}

	expect(runId: string, asyncDir: string): void {
		assert.equal(this.expected, undefined, "expected launch already bound");
		assert.ok(runId && path.isAbsolute(asyncDir), "missing expected launch identity");
		this.expected = runId;
		this.expectedDir = asyncDir;
	}

	private ready(): boolean {
		if (this.errors.length) throw new AggregateError(this.errors, "cleanup observation failed; retain fixtures");
		assert.ok(this.expected, "missing returned run ID; retain fixtures");
		assert.equal(this.starts.size, 1, "expected exactly one owned start; retain fixtures");
		const start = this.starts.get(this.expected);
		assert.ok(start, "returned run ID does not match owned start");
		assert.equal(start.asyncDir, this.expectedDir, "returned run directory mismatch");
		for (const id of this.terminals.keys()) assert.ok(this.starts.has(id), "unknown terminal run");
		if (!this.terminals.has(start.id)) return false;
		const identity = { runId: start.id, runnerProcessInstanceId: start.instance };
		const proof = sanitizeProcessTerminal(this.terminals.get(start.id), identity);
		assert.equal(proof?.state, "observed", "terminal proof is not observed");
		const runners = proof!.instances!.filter(instance => instance.kind === "runner");
		assert.equal(runners.length, 1, "expected exactly one runner close");
		assert.equal(runners[0].processInstanceId, start.instance);
		assert.equal(runners[0].exitCode, 0, "runner exited unsuccessfully");
		assert.equal(runners[0].signal, null, "runner was signalled");
		assert.deepEqual(readProcessTerminal(start.asyncDir, identity), proof, "notification does not match finalized durable proof");
		return true;
	}

	settle(): Promise<void> {
		if (this.settlement) return this.settlement;
		this.settlement = new Promise<void>((resolve, reject) => {
			const finish = (error?: unknown) => {
				if (this.deadline) clearTimeout(this.deadline);
				this.deadline = undefined;
				this.waiting = undefined;
				for (const off of this.unsubscribe.splice(0)) off();
				if (error !== undefined) { this.retainRoot(); reject(error); }
				else { this.settled = true; resolve(); }
			};
			this.waiting = () => {
				try { if (this.ready()) finish(); } catch (error) { finish(error); }
			};
			this.deadline = setTimeout(() => finish(new Error("process-terminal settlement deadline; retain fixtures")), this.timeoutMs);
			this.waiting();
		});
		return this.settlement;
	}

	async run<T>(body: () => Promise<T>): Promise<T> {
		let value: T;
		try { value = await body(); } catch (original) {
			try { await this.settle(); } catch (settlement) {
				throw new AggregateError([original, settlement], "leaf failed and cleanup unsettled; retain fixtures");
			}
			throw original;
		}
		await this.settle();
		return value;
	}

	assertSettled(): void { assert.ok(this.settled, "previous leaf unsettled; do not reset fixture ownership"); }
	get observing(): boolean { return this.unsubscribe.length > 0 || this.deadline !== undefined; }
}

/** Hook ownership is retained on failure; ordinary leaves have no barrier. */
export class SingleExecutionCleanupHooks {
	private current?: SingleExecutionCleanup;
	private retainRoot: () => void;
	constructor(retainRoot = retainSingleExecutionTempRoot) { this.retainRoot = retainRoot; }
	register(events: EventBus): SingleExecutionCleanup {
		assert.equal(this.current, undefined, "cleanup owner already registered");
		return this.current = new SingleExecutionCleanup(events, 15_000, this.retainRoot);
	}
	beforeSetup(): void { this.current?.assertSettled(); }
	async beforeRemoval(): Promise<void> { await this.current?.settle(); }
	afterRemoval(): void { this.current = undefined; }
	async beforeUninstall(): Promise<void> { await this.current?.settle(); }
}
