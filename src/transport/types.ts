export interface AgentEndpoint {
  name: string;
  url: string;
  description?: string;
  model?: string;
  timeoutMs?: number;
  heartbeat?: boolean; // default true — set false to skip health monitoring
}

export interface HttpConfig {
  agents: AgentEndpoint[];
  defaults?: {
    timeoutMs?: number;
    pollIntervalMs?: number;
    heartbeatIntervalMs?: number; // default 30000
  };
}

export interface InvokeRequest {
  task: string;
  context?: string;
  runId?: string;
  traceparent?: string;
  correlationId?: string;
}

export interface InvokeResponse {
  runId: string;
  status: "accepted";
}

export interface StatusResponse {
  runId: string;
  state: "queued" | "running" | "completed" | "failed" | "timeout";
  startedAt?: string;
  durationMs?: number;
  progress?: {
    turnCount: number;
  };
}

export interface ResultResponse {
  runId: string;
  state: "completed" | "failed";
  output: string;
  error?: string | null;
  usage?: {
    input: number;
    output: number;
    cacheRead?: number;
    cost?: number;
    turns: number;
  };
  durationMs: number;
  model?: string;
}

export interface DescribeResponse {
  name: string;
  description?: string;
  role?: string;
  capabilities?: string;
  model?: string;
  status: "ready" | "busy" | "starting";
}

export type AgentStatus = "ready" | "busy" | "starting" | "unreachable" | "unknown";

export interface AgentHealth {
  name: string;
  url: string;
  status: AgentStatus;
  lastCheckedAt?: number;
  lastHealthy?: number;
  error?: string;
  describe?: DescribeResponse;
}

export type RemoteRunState = "pending" | "running" | "completed" | "failed" | "timeout";

export interface RemoteRun {
  runId: string;
  agent: string;
  url: string;
  task: string;
  state: RemoteRunState;
  startedAt: number;
  timeoutMs: number;
  pollIntervalMs: number;
  lastCheckedAt?: number;
  result?: ResultResponse;
  error?: string;
}
