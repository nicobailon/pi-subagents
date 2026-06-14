import type { HttpConfig, AgentHealth, DescribeResponse } from "./types.ts";
import { describe } from "./http-client.ts";

const DEFAULT_HEARTBEAT_INTERVAL_MS = 30000;

export class AgentMonitor {
  private health = new Map<string, AgentHealth>();
  private configNames = new Map<string, string>();
  private timers = new Map<string, ReturnType<typeof setInterval>>();
  private warnings: string[] = [];
  private intervalMs: number;

  constructor(config: HttpConfig) {
    this.intervalMs = config.defaults?.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    for (const agent of config.agents) {
      const url = agent.url.replace(/\/+$/, "");
      if (agent.name) this.configNames.set(url, agent.name);
      this.health.set(url, {
        name: agent.name || url,
        url,
        status: "unknown",
      });
      if (agent.heartbeat === false) continue;
      // Initial check immediately, then periodic
      void this.checkAgent(url);
      const timer = setInterval(() => { void this.checkAgent(url); }, this.intervalMs);
      if (typeof timer === "object" && "unref" in timer) {
        (timer as NodeJS.Timeout).unref();
      }
      this.timers.set(url, timer);
    }
  }

  private async checkAgent(url: string): Promise<void> {
    const entry = this.health.get(url);
    if (!entry) return;
    const now = Date.now();
    try {
      const res = await fetch(`${url}/health`);
      entry.lastCheckedAt = now;
      if (res.ok) {
        const prev = entry.status;
        entry.status = "ready";
        entry.lastHealthy = now;
        entry.error = undefined;
        // Fetch /describe on first healthy check or if we don't have it yet
        if (!entry.describe || prev === "unreachable" || prev === "unknown") {
          try {
            entry.describe = await describe(url);
            const configName = this.configNames.get(url);
            if (configName && entry.describe.name && configName.toLowerCase() !== entry.describe.name.toLowerCase()) {
              this.warnings.push(`Agent at ${url}: config name "${configName}" != /describe name "${entry.describe.name}". LLM will use config name.`);
            }
            if (entry.describe.status === "busy") entry.status = "busy";
            if (entry.describe.status === "starting") entry.status = "starting";
          } catch { /* /describe optional */ }
        }
      } else {
        entry.status = "unreachable";
        entry.error = `HTTP ${res.status}`;
      }
    } catch (err) {
      entry.lastCheckedAt = now;
      entry.status = "unreachable";
      entry.error = err instanceof Error ? err.message : String(err);
    }
  }

  getHealth(url: string): AgentHealth | undefined {
    const normalized = url.replace(/\/+$/, "");
    return this.health.get(normalized);
  }

  getAllHealth(): AgentHealth[] {
    return Array.from(this.health.values());
  }

  getWarnings(): string[] {
    return [...this.warnings];
  }

  isReachable(url: string): boolean {
    const h = this.getHealth(url);
    return h ? h.status !== "unreachable" : false;
  }

  stop(): void {
    for (const timer of this.timers.values()) {
      clearInterval(timer);
    }
    this.timers.clear();
  }
}
