interface TimerApi {
	setTimeout(handler: () => void, delayMs: number): unknown;
	clearTimeout(handle: unknown): void;
}

interface FileCoalescer {
	schedule(file: string, delayMs?: number): boolean;
	flush(file: string): boolean;
	clear(): void;
}

const defaultTimerApi: TimerApi = {
	setTimeout: (handler, delayMs) => setTimeout(handler, delayMs),
	clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function createFileCoalescer(
	handler: (file: string) => void,
	defaultDelayMs: number,
	timerApi: TimerApi = defaultTimerApi,
): FileCoalescer {
	const pending = new Map<string, unknown>();

	return {
		schedule(file: string, delayMs = defaultDelayMs): boolean {
			if (pending.has(file)) return false;
			const timer = timerApi.setTimeout(() => {
				pending.delete(file);
				handler(file);
			}, delayMs);
			pending.set(file, timer);
			return true;
		},
		flush(file: string): boolean {
			const timer = pending.get(file);
			if (timer === undefined) return false;
			timerApi.clearTimeout(timer);
			pending.delete(file);
			handler(file);
			return true;
		},
		clear(): void {
			for (const timer of pending.values()) {
				timerApi.clearTimeout(timer);
			}
			pending.clear();
		},
	};
}
