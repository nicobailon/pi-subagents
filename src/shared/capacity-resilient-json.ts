import { isStorageCapacityError } from "./file-system-retry.ts";
import { writeAtomicJson } from "./atomic-json.ts";

type TimerApi = {
	setTimeout(handler: () => void, delayMs: number): unknown;
	clearTimeout(handle: unknown): void;
};

const defaultTimerApi: TimerApi = {
	setTimeout: (handler, delayMs) => setTimeout(handler, delayMs),
	clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export type CapacityResilientJsonWriterOptions = {
	/** The underlying write operation. It must be atomic for each target path. */
	write?: (filePath: string, payload: object) => void;
	/** Keep retry timers referenced by the event loop (needed by child runners). */
	keepAlive?: boolean;
	retryDelayMs?: number;
	timerApi?: TimerApi;
	onError?: (error: unknown, filePath: string) => void;
	onSuccess?: (filePath: string, payload: object) => void;
};

export type CapacityResilientJsonWriter = {
	write(filePath: string, payload: object, writeOperation?: (filePath: string, payload: object) => void): void;
	pendingCount(): number;
	dispose(): void;
};

/**
 * Defers only storage-capacity failures, retaining the newest payload per path.
 * Initial/ordinary writes remain synchronous and preserve their throwing contract;
 * only ENOSPC-like failures enter the guarded retry loop.
 */
export function createCapacityResilientJsonWriter(options: CapacityResilientJsonWriterOptions = {}): CapacityResilientJsonWriter {
	const defaultWrite = options.write ?? writeAtomicJson;
	const keepAlive = options.keepAlive ?? false;
	const retryDelayMs = options.retryDelayMs ?? 1_000;
	const timerApi = options.timerApi ?? defaultTimerApi;
	const onError = options.onError ?? ((error, filePath) => console.error(`Failed to persist JSON '${filePath}':`, error));
	const onSuccess = options.onSuccess;
	const reportError = (error: unknown, filePath: string): void => {
		try {
			onError(error, filePath);
		} catch (callbackError) {
			console.error(`Failed to report JSON persistence error for '${filePath}':`, callbackError);
		}
	};
	const notifySuccess = (filePath: string, payload: object): void => {
		if (!onSuccess) return;
		try {
			onSuccess(filePath, payload);
		} catch (error) {
			reportError(error, filePath);
		}
	};
	const pending = new Map<string, { payload: object; write: (filePath: string, payload: object) => void }>();
	let retryTimer: unknown;

	const scheduleRetry = (): void => {
		if (retryTimer !== undefined) return;
		retryTimer = timerApi.setTimeout(() => {
			retryTimer = undefined;
			for (const [filePath, entry] of pending) {
				try {
					entry.write(filePath, entry.payload);
					pending.delete(filePath);
					notifySuccess(filePath, entry.payload);
				} catch (error) {
					if (isStorageCapacityError(error)) continue;
					pending.delete(filePath);
					reportError(error, filePath);
				}
			}
			if (pending.size > 0) scheduleRetry();
		}, retryDelayMs);
		if (!keepAlive && typeof retryTimer === "object" && retryTimer !== null && "unref" in retryTimer && typeof retryTimer.unref === "function") {
			retryTimer.unref();
		}
	};

	return {
		write(filePath, payload, writeOperation = defaultWrite): void {
			try {
				writeOperation(filePath, payload);
				pending.delete(filePath);
				notifySuccess(filePath, payload);
			} catch (error) {
				if (!isStorageCapacityError(error)) throw error;
				pending.set(filePath, { payload, write: writeOperation });
				scheduleRetry();
			}
		},
		pendingCount: () => pending.size,
		dispose: (): void => {
			if (retryTimer !== undefined) timerApi.clearTimeout(retryTimer);
			retryTimer = undefined;
			pending.clear();
		},
	};
}
