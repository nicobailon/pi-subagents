import type { SubagentRunMode } from "../../shared/types.ts";

export interface RunnerCrashResultInput {
	id: string;
	agent: string;
	mode: SubagentRunMode;
	reason: string;
	startedAt: number;
	now: number;
	asyncDir: string;
	cwd: string;
	sessionId?: string | null;
	topLevelIntercomTarget?: string;
	childIntercomTarget?: string;
	taskIndex?: number;
	totalTasks?: number;
}

export function buildRunnerCrashResultPayload(input: RunnerCrashResultInput): object {
	const message = `Runner crashed: ${input.reason}`;
	return {
		id: input.id,
		agent: input.agent,
		mode: input.mode,
		success: false,
		state: "failed",
		summary: message,
		results: [{
			agent: input.agent,
			output: "",
			error: message,
			success: false,
			exitCode: 1,
			intercomTarget: input.childIntercomTarget,
		}],
		exitCode: 1,
		error: message,
		timestamp: input.now,
		durationMs: input.now - input.startedAt,
		asyncDir: input.asyncDir,
		cwd: input.cwd,
		sessionId: input.sessionId,
		intercomTarget: input.topLevelIntercomTarget,
		...(input.taskIndex !== undefined && { taskIndex: input.taskIndex }),
		...(input.totalTasks !== undefined && { totalTasks: input.totalTasks }),
	};
}
