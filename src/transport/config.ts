import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { HttpConfig, AgentEndpoint } from "./types.ts";

function getConfigPath(): string {
  return path.join(os.homedir(), ".pi", "agent", "extensions", "subagent-http", "config.json");
}

export function loadHttpConfig(): HttpConfig {
  try {
    const raw = fs.readFileSync(getConfigPath(), "utf-8");
    const parsed = JSON.parse(raw) as HttpConfig;
    if (!Array.isArray(parsed.agents)) return { agents: [] };
    return parsed;
  } catch {
    return { agents: [] };
  }
}

export function getAgent(config: HttpConfig, name: string): AgentEndpoint | undefined {
  return config.agents.find(a => a.name === name);
}

export function listAgents(config: HttpConfig): AgentEndpoint[] {
  return config.agents;
}
