import type { ExecutionLifetime } from "../../shared/types.ts";

export const MAX_EXECUTION_TIMEOUT_MS = 2_147_483_647;

interface ExecutionLifetimeResolution {
	effectiveExecutionLifetime?: ExecutionLifetime;
	timeoutMs?: number;
	error?: string;
}

/** Validate lifetime at public and persisted boundaries, before timeout defaults. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- This is the shared parser for untrusted public and persisted lifetime input.
export function resolveExecutionLifetime(requested: unknown, fallbackTimeoutMs?: number): ExecutionLifetimeResolution {
	if (requested === undefined) {
		return fallbackTimeoutMs === undefined
			? { effectiveExecutionLifetime: { mode: "unbounded" } }
			: { effectiveExecutionLifetime: { mode: "bounded", timeoutMs: fallbackTimeoutMs }, timeoutMs: fallbackTimeoutMs };
	}
	// oxlint-disable-next-line anti-slop/no-runtime-typeof -- Establish the object shape before validating its discriminant and timer range.
	if (requested === null || typeof requested !== "object" || Array.isArray(requested) || !("mode" in requested)) {
		return { error: "executionLifetime must be { mode: 'unbounded' } or { mode: 'bounded', timeoutMs }." };
	}
	if (requested.mode === "unbounded" && Object.keys(requested).every((key) => key === "mode")) {
		return { effectiveExecutionLifetime: { mode: "unbounded" } };
	}
	if (requested.mode === "bounded" && Object.keys(requested).every((key) => key === "mode" || key === "timeoutMs")
		// oxlint-disable-next-line anti-slop/no-runtime-typeof -- Timer input must be a number, not a numeric string or coercible object.
		&& "timeoutMs" in requested && typeof requested.timeoutMs === "number" && Number.isInteger(requested.timeoutMs)
		&& requested.timeoutMs > 0 && requested.timeoutMs <= MAX_EXECUTION_TIMEOUT_MS) {
		return { effectiveExecutionLifetime: { mode: "bounded", timeoutMs: requested.timeoutMs }, timeoutMs: requested.timeoutMs };
	}
	return { error: `executionLifetime must be { mode: 'unbounded' } or { mode: 'bounded', timeoutMs: integer from 1 to ${MAX_EXECUTION_TIMEOUT_MS} }.` };
}
