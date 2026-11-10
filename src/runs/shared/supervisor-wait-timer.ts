/** A child making one of these calls is blocked on its supervisor's reply, not working. */
export function isBlockingSupervisorTool(toolName: string | undefined, args: unknown): boolean {
	if (!args || typeof args !== "object") return false;
	const call = args as { reason?: unknown; action?: unknown };
	if (toolName === "contact_supervisor") return call.reason === "need_decision" || call.reason === "interview_request";
	return toolName === "intercom" && call.action === "ask";
}

/** A one-shot timer whose countdown stops while any key holds it paused. */
export interface PausableTimer {
	pause(key: string): void;
	resume(key: string): void;
	remainingMs(): number;
	clear(): void;
}

export function startPausableTimer(delayMs: number, onFire: () => void): PausableTimer {
	let remaining = Math.max(0, delayMs);
	// Monotonic clock: a system clock change must not shorten or extend the budget.
	let runningSince: number | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let done = false;
	const pausedBy = new Set<string>();
	const remainingMs = (): number => runningSince === undefined ? remaining : Math.max(0, remaining - (performance.now() - runningSince));
	const run = (): void => {
		runningSince = performance.now();
		timer = setTimeout(() => {
			done = true;
			runningSince = undefined;
			remaining = 0;
			onFire();
		}, remaining);
		timer.unref?.();
	};
	const stop = (): void => {
		clearTimeout(timer);
		remaining = remainingMs();
		runningSince = undefined;
	};
	run();
	return {
		pause(key) {
			if (done) return;
			if (pausedBy.size === 0) stop();
			pausedBy.add(key);
		},
		resume(key) {
			if (done || !pausedBy.delete(key) || pausedBy.size > 0) return;
			run();
		},
		remainingMs,
		clear() {
			done = true;
			stop();
		},
	};
}

export function pauseForSupervisorWait(timer: PausableTimer | undefined, event: { type?: string; toolCallId?: unknown; toolName?: string; args?: unknown }): void {
	if (!timer || typeof event.toolCallId !== "string") return;
	if (event.type === "tool_execution_start" && isBlockingSupervisorTool(event.toolName, event.args)) timer.pause(event.toolCallId);
	else if (event.type === "tool_execution_end") timer.resume(event.toolCallId);
}
