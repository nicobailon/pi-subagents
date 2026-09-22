import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { writeAtomicJson } from "../../shared/atomic-json.ts";
import { acquireSessionLease } from "../shared/session-lease.ts";
import { readProcessTerminalCandidate, writeProcessTerminalCandidate, markProcessTerminalCandidateLeaseRelease } from "./process-terminal-candidate.ts";
import { persistRunnerStartupFailure } from "./runner-startup-failure.ts";
import type { DefaultChildSessionFactoryOptions } from "../shared/child-session.ts";
import type { SubagentRunConfig } from "./subagent-runner.ts";

export type { SubagentRunConfig } from "./subagent-runner.ts";

type ExecutionModule = {
	runConfiguredSubagentExecution(config: SubagentRunConfig, options?: DefaultChildSessionFactoryOptions): Promise<void>;
};

export interface RunnerBootstrapOptions extends DefaultChildSessionFactoryOptions {
	/** Test-only seam for proving that execution loading stays behind startup commit. */
	loadExecutionModule?: () => Promise<ExecutionModule>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validateChildStep(value: unknown, field: string): void {
	if (!isRecord(value)) {
		throw new Error(`Invalid runner configuration: '${field}' must be an object.`);
	}
	if (typeof value.agent !== "string" || !value.agent) {
		throw new Error(`Invalid runner configuration: '${field}.agent' must be a non-empty string.`);
	}
	if (typeof value.task !== "string") {
		throw new Error(`Invalid runner configuration: '${field}.task' must be a string.`);
	}
	for (const requiredBoolean of ["inheritProjectContext", "inheritGlobalContext", "inheritSkills"] as const) {
		if (typeof value[requiredBoolean] !== "boolean") {
			throw new Error(`Invalid runner configuration: '${field}.${requiredBoolean}' must be a boolean.`);
		}
	}
}

function validateStep(value: unknown, index: number): void {
	const field = `steps[${index}]`;
	if (!isRecord(value)) {
		throw new Error(`Invalid runner configuration: '${field}' must be an object.`);
	}
	if ("expand" in value || "collect" in value) {
		if (!isRecord(value.expand)) {
			throw new Error(`Invalid runner configuration: '${field}.expand' must be an object.`);
		}
		if (!isRecord(value.collect)) {
			throw new Error(`Invalid runner configuration: '${field}.collect' must be an object.`);
		}
		validateChildStep(value.parallel, `${field}.parallel`);
		return;
	}
	if (Array.isArray(value.parallel)) {
		if (value.parallel.length === 0) {
			throw new Error(`Invalid runner configuration: '${field}.parallel' must not be empty.`);
		}
		value.parallel.forEach((step, childIndex) => validateChildStep(step, `${field}.parallel[${childIndex}]`));
		return;
	}
	validateChildStep(value, field);
}

export function validateSubagentRunConfig(value: unknown): asserts value is SubagentRunConfig {
	if (!isRecord(value)) {
		throw new Error("Invalid runner configuration: root must be an object.");
	}
	for (const field of ["id", "resultPath", "cwd", "asyncDir"] as const) {
		if (typeof value[field] !== "string" || !value[field]) {
			throw new Error(`Invalid runner configuration: '${field}' must be a non-empty string.`);
		}
	}
	if (typeof value.placeholder !== "string") {
		throw new Error("Invalid runner configuration: 'placeholder' must be a string.");
	}
	if (!Array.isArray(value.steps) || value.steps.length === 0) {
		throw new Error("Invalid runner configuration: 'steps' must be a non-empty array.");
	}
	value.steps.forEach(validateStep);
}

async function waitForStartupControl(controlPath: string, token: string, action: "ack" | "confirm" | "proceed", timeoutMs = 30_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() <= deadline) {
		if (fs.existsSync(controlPath)) {
			let payload: { action?: unknown; token?: unknown };
			try {
				payload = JSON.parse(fs.readFileSync(controlPath, "utf-8")) as { action?: unknown; token?: unknown };
			} catch (error) {
				throw new Error(`Failed to read runner startup control '${controlPath}': ${error instanceof Error ? error.message : String(error)}`);
			}
			if (payload.token !== token) {
				throw new Error("Runner startup control token does not match.");
			}
			if (payload.action === action) {
				return;
			}
			if (payload.action !== "ack" && payload.action !== "confirm" && payload.action !== "proceed") {
				throw new Error("Runner startup control action is invalid.");
			}
		}
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error(`Timed out after ${timeoutMs}ms waiting for runner startup control '${action}'.`);
}

/** Owns startup authorization and any revival lease across dynamically loaded execution. */
export async function runConfiguredSubagent(rawConfig: unknown, options: RunnerBootstrapOptions = {}): Promise<void> {
	validateSubagentRunConfig(rawConfig);
	const config = rawConfig;
	let lease: ReturnType<typeof acquireSessionLease> | undefined;
	let startupCommitted = config.revivalLease === undefined && config.launchBarrierToken === undefined;
	let executionLoaded = false;
	const startupPath = path.join(config.asyncDir, "runner-startup.json");
	const startupAckPath = path.join(config.asyncDir, "runner-startup-ack.json");
	const startupConfirmPath = path.join(config.asyncDir, "runner-startup-confirm.json");
	const startupProceedPath = path.join(config.asyncDir, "runner-startup-proceed.json");
	const releaseOnExit = (): void => {
		try {
			lease?.release();
		} catch {
			// Dead-owner leases are reclaimed on the next revival.
		}
	};
	process.once("exit", releaseOnExit);
	try {
		if (config.launchBarrierToken) {
			await waitForStartupControl(startupProceedPath, config.launchBarrierToken, "proceed");
			startupCommitted = true;
			try {
				fs.rmSync(startupProceedPath, { force: true });
			} catch {
				// Best effort after commit.
			}
		} else if (config.revivalLease) {
			lease = acquireSessionLease(config.revivalLease);
			config.revivalLeaseToken = lease.owner.token;
			writeAtomicJson(startupPath, { state: "ready", token: lease.owner.token, pid: process.pid, owner: lease.owner });
			await waitForStartupControl(startupAckPath, lease.owner.token, "ack");
			writeAtomicJson(startupPath, { state: "acknowledged", token: lease.owner.token, pid: process.pid });
			await waitForStartupControl(startupConfirmPath, lease.owner.token, "confirm");
			writeAtomicJson(startupPath, { state: "confirmed", token: lease.owner.token, pid: process.pid });
			await waitForStartupControl(startupProceedPath, lease.owner.token, "proceed");
			startupCommitted = true;
			for (const controlPath of [startupAckPath, startupConfirmPath, startupProceedPath]) {
				try {
					fs.rmSync(controlPath, { force: true });
				} catch {
					// Best effort after commit.
				}
			}
		}
		if (lease) {
			// Persist token identity before the heavy import so an import rejection
			// still leaves the parent enough evidence to prove lease release.
			const candidate = readProcessTerminalCandidate(config.asyncDir);
			if (candidate) {
				writeProcessTerminalCandidate(config.asyncDir, {
					...candidate,
					sessionFile: config.revivalLease?.sessionFile,
					revivalLeaseToken: lease.owner.token,
				});
			}
		}
		const { loadExecutionModule, ...executionOptions } = options;
		const testExecutionModule = process.env.PI_SUBAGENTS_TEST_RUNNER_EXECUTION_MODULE;
		const execution = await (loadExecutionModule?.() ?? (testExecutionModule ? import(testExecutionModule) : import("./subagent-runner.ts")));
		executionLoaded = true;
		await execution.runConfiguredSubagentExecution(config, executionOptions);
	} catch (error) {
		if (!startupCommitted) {
			try {
				writeAtomicJson(startupPath, { state: "error", pid: process.pid, error: error instanceof Error ? error.message : String(error) });
			} catch {
				// The parent will time out and terminate if startup evidence cannot be written.
			}
		} else if (!executionLoaded) {
			try {
				persistRunnerStartupFailure({
					asyncDir: config.asyncDir,
					runId: config.id,
					runnerProcessInstanceId: config.runnerProcessInstanceId ?? "unknown-runner-instance",
					message: `Subagent runner startup failed: ${error instanceof Error ? error.message : String(error)}`,
					...(config.sessionId ? { sessionId: config.sessionId } : {}),
					...(config.completionOwnerId ? { completionOwnerId: config.completionOwnerId } : {}),
					candidate: {
						...(config.revivalLease?.sessionFile ? { sessionFile: config.revivalLease.sessionFile } : {}),
						...(config.revivalLeaseToken ? { revivalLeaseToken: config.revivalLeaseToken } : {}),
					},
				});
			} catch (persistenceError) {
				console.error("Failed to persist runner startup failure:", persistenceError);
			}
		}
		throw error;
	} finally {
		process.off("exit", releaseOnExit);
		if (lease) {
			let acknowledged = false;
			try {
				acknowledged = lease.release();
			} catch (error) {
				console.error("Failed to release session revival lease:", error);
			}
			try {
				markProcessTerminalCandidateLeaseRelease(config.asyncDir, lease.owner.token, acknowledged);
			} catch (error) {
				console.error("Failed to record session revival lease release:", error);
			}
		}
	}
}

function startConfiguredSubagent(config: unknown): void {
	runConfiguredSubagent(config).then(
		() => process.exit(0),
		(error) => {
			console.error("Subagent runner error:", error);
			process.exit(1);
		},
	);
}

function monitorTestParent(): void {
	const parentPid = Number(process.env.PI_SUBAGENTS_TEST_PARENT_PID);
	if (!Number.isSafeInteger(parentPid) || parentPid <= 0 || parentPid === process.pid) {
		return;
	}
	const check = () => {
		try {
			process.kill(parentPid, 0);
		} catch {
			process.exit(1);
		}
	};
	check();
	setInterval(check, 250).unref();
}

const isRunnerEntrypoint = Boolean(process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href);
if (isRunnerEntrypoint) {
	monitorTestParent();
	const configArg = process.argv[2];
	if (configArg) {
		try {
			const config = JSON.parse(fs.readFileSync(configArg, "utf-8")) as unknown;
			try {
				fs.unlinkSync(configArg);
			} catch {
				// Temp-config cleanup is best effort.
			}
			startConfiguredSubagent(config);
		} catch (error) {
			console.error("Subagent runner error:", error);
			process.exit(1);
		}
	} else {
		let input = "";
		process.stdin.setEncoding("utf-8");
		process.stdin.on("data", (chunk) => {
			input += chunk;
		});
		process.stdin.on("end", () => {
			try {
				startConfiguredSubagent(JSON.parse(input) as unknown);
			} catch (error) {
				console.error("Subagent runner error:", error);
				process.exit(1);
			}
		});
	}
}
