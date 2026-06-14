import type { ResultResponse } from "./types.ts";
import { getStatus, getResult } from "./http-client.ts";

const ADAPTIVE_TIERS = [
  { untilMs: 30_000, intervalMs: 2_000 },
  { untilMs: 120_000, intervalMs: 5_000 },
  { untilMs: 300_000, intervalMs: 10_000 },
  { untilMs: Infinity, intervalMs: 30_000 },
];

function adaptiveInterval(elapsedMs: number): number {
  for (const tier of ADAPTIVE_TIERS) {
    if (elapsedMs < tier.untilMs) return tier.intervalMs;
  }
  return 30_000;
}

export interface PollOptions {
  baseUrl: string;
  runId: string;
  timeoutMs: number;
  fixedIntervalMs?: number;
  signal?: AbortSignal;
  onProgress?: (state: string, elapsedMs: number) => void;
}

export interface PollResult {
  state: "completed" | "failed" | "timeout" | "cancelled";
  result?: ResultResponse;
  error?: string;
  durationMs: number;
}

export async function pollUntilDone(opts: PollOptions): Promise<PollResult> {
  const start = Date.now();

  while (true) {
    if (opts.signal?.aborted) {
      return { state: "cancelled", error: "Aborted", durationMs: Date.now() - start };
    }

    const elapsed = Date.now() - start;
    if (elapsed > opts.timeoutMs) {
      return { state: "timeout", error: `Timed out after ${Math.round(elapsed / 1000)}s`, durationMs: elapsed };
    }

    try {
      // Try /status first, fall back to /result (409 = still running)
      let state: string = "running";
      try {
        const status = await getStatus(opts.baseUrl, opts.runId);
        state = status.state;
        opts.onProgress?.(state, elapsed);
      } catch {
        // /status not implemented — probe /result directly
        try {
          const result = await getResult(opts.baseUrl, opts.runId);
          return {
            state: result.state as "completed" | "failed",
            result,
            error: result.error ?? undefined,
            durationMs: Date.now() - start,
          };
        } catch (resultErr) {
          const msg = resultErr instanceof Error ? resultErr.message : "";
          if (msg.includes("still in progress")) {
            state = "running";
          } else {
            // both /status and /result failed — keep polling
          }
        }
      }

      if (state === "completed" || state === "failed") {
        try {
          const result = await getResult(opts.baseUrl, opts.runId);
          return {
            state: result.state as "completed" | "failed",
            result,
            error: result.error ?? undefined,
            durationMs: Date.now() - start,
          };
        } catch {
          return {
            state: state as "completed" | "failed",
            error: state === "failed" ? "Failed (result fetch error)" : undefined,
            durationMs: Date.now() - start,
          };
        }
      }
    } catch {
      // connectivity error — keep polling
    }

    const interval = opts.fixedIntervalMs ?? adaptiveInterval(Date.now() - start);
    await new Promise(resolve => setTimeout(resolve, interval));
  }
}
