import type { RemoteRun, ResultResponse } from "./types.ts";
import { getStatus, getResult } from "./http-client.ts";

export type RunEventType = "started" | "completed" | "failed" | "timeout" | "error";

export interface RunEvent {
  type: RunEventType;
  runId: string;
  agent: string;
  result?: ResultResponse;
  error?: string;
}

export type RunEventHandler = (event: RunEvent) => void;

export class JobTracker {
  private runs = new Map<string, RemoteRun>();
  private poller: ReturnType<typeof setInterval> | null = null;
  private defaultPollIntervalMs: number;
  private listeners: RunEventHandler[] = [];

  constructor(defaultPollIntervalMs = 3000) {
    this.defaultPollIntervalMs = defaultPollIntervalMs;
  }

  onEvent(handler: RunEventHandler): () => void {
    this.listeners.push(handler);
    return () => {
      const idx = this.listeners.indexOf(handler);
      if (idx >= 0) this.listeners.splice(idx, 1);
    };
  }

  private emit(event: RunEvent): void {
    for (const handler of this.listeners) {
      try { handler(event); } catch { /* listener errors don't propagate */ }
    }
  }

  track(run: RemoteRun): void {
    this.runs.set(run.runId, run);
    this.emit({ type: "started", runId: run.runId, agent: run.agent });
    this.ensurePoller();
  }

  get(runId: string): RemoteRun | undefined {
    const direct = this.runs.get(runId);
    if (direct) return direct;
    for (const [key, run] of this.runs) {
      if (key.startsWith(runId)) return run;
    }
    return undefined;
  }

  getAll(): RemoteRun[] {
    return Array.from(this.runs.values());
  }

  getActive(): RemoteRun[] {
    return this.getAll().filter(r => r.state === "pending" || r.state === "running");
  }

  private ensurePoller(): void {
    if (this.poller) return;
    const interval = this.defaultPollIntervalMs;
    this.poller = setInterval(() => { void this.pollAll(); }, interval);
    if (typeof this.poller === "object" && "unref" in this.poller) {
      (this.poller as NodeJS.Timeout).unref();
    }
  }

  private async pollAll(): Promise<void> {
    const active = this.getActive();
    if (active.length === 0) {
      this.stopPoller();
      return;
    }
    await Promise.allSettled(active.map(run => this.pollOne(run)));
  }

  private async pollOne(run: RemoteRun): Promise<void> {
    const now = Date.now();
    if (now - run.startedAt > run.timeoutMs) {
      run.state = "timeout";
      run.error = `Timed out after ${run.timeoutMs}ms`;
      this.emit({ type: "timeout", runId: run.runId, agent: run.agent, error: run.error });
      return;
    }
    try {
      const status = await getStatus(run.url, run.runId);
      run.lastCheckedAt = now;
      if (status.state === "completed" || status.state === "failed") {
        try {
          const result = await getResult(run.url, run.runId);
          run.state = result.state as RemoteRun["state"];
          run.result = result;
          if (result.error) run.error = result.error;
        } catch {
          run.state = status.state as RemoteRun["state"];
        }
        const eventType = run.state === "completed" ? "completed" : "failed";
        this.emit({ type: eventType, runId: run.runId, agent: run.agent, result: run.result, error: run.error });
      } else {
        run.state = "running";
      }
    } catch (err) {
      run.lastCheckedAt = now;
    }
  }

  private stopPoller(): void {
    if (this.poller) {
      clearInterval(this.poller);
      this.poller = null;
    }
  }

  stop(): void {
    this.stopPoller();
    this.listeners.length = 0;
  }
}
