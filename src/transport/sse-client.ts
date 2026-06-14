import { createParser, type EventSourceMessage } from "eventsource-parser";
import type { PollResult } from "./poll.ts";

export class SseClient {
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private decoder = new TextDecoder();
  private handlers = new Map<string, Set<(data: any) => void>>();
  private _connected = false;
  private reconnectMs = 1000;
  private abortController: AbortController | null = null;

  constructor(private url: string, private headers?: Record<string, string>) {}

  async connect(): Promise<void> {
    this.abortController = new AbortController();
    try {
      const res = await fetch(this.url, {
        headers: { Accept: "text/event-stream", ...this.headers },
        signal: this.abortController.signal,
      });
      if (!res.ok || !res.body) throw new Error(`SSE connect failed: ${res.status}`);

      this._connected = true;
      this.reconnectMs = 1000;
      this.reader = res.body.getReader();

      const parser = createParser({
        onEvent: (event: EventSourceMessage) => {
          const eventType = event.event || "message";
          const listeners = this.handlers.get(eventType);
          if (!listeners) return;
          try {
            const data = JSON.parse(event.data);
            for (const h of listeners) h(data);
          } catch {}
        },
      });

      while (true) {
        const { done, value } = await this.reader.read();
        if (done) break;
        parser.feed(this.decoder.decode(value, { stream: true }));
      }
    } catch (err: any) {
      if (err.name === "AbortError") return;
    }
    this._connected = false;

    if (!this.abortController?.signal.aborted) {
      setTimeout(() => this.connect(), this.reconnectMs);
      this.reconnectMs = Math.min(this.reconnectMs * 2, 30_000);
    }
  }

  on(event: string, handler: (data: any) => void): void {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(handler);
  }

  isConnected(): boolean { return this._connected; }

  close(): void {
    this.abortController?.abort();
    this.reader = null;
    this._connected = false;
  }
}

export async function waitViaSse(
  sse: SseClient,
  runId: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<PollResult> {
  return new Promise((resolve) => {
    const start = Date.now();
    const timeout = setTimeout(() => {
      resolve({ state: "timeout", error: `Timed out after ${timeoutMs}ms`, durationMs: timeoutMs });
    }, timeoutMs);

    const cleanup = () => { clearTimeout(timeout); };

    sse.on("run:completed", (data) => {
      if (data.runId !== runId) return;
      cleanup();
      resolve({ state: "completed", result: data, durationMs: Date.now() - start });
    });

    sse.on("run:failed", (data) => {
      if (data.runId !== runId) return;
      cleanup();
      resolve({ state: "failed", error: data.error, durationMs: Date.now() - start });
    });

    sse.on("run:cancelled", (data) => {
      if (data.runId !== runId) return;
      cleanup();
      resolve({ state: "cancelled", error: "Cancelled", durationMs: Date.now() - start });
    });

    if (signal) signal.addEventListener("abort", () => {
      cleanup();
      resolve({ state: "cancelled", error: "Aborted", durationMs: Date.now() - start });
    });
  });
}
