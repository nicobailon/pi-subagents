import { Type } from "typebox";

const ParallelTaskItem = Type.Object({
  agent: Type.String({ description: "Remote agent name" }),
  task: Type.String({ description: "Task to delegate" }),
});

export const SubagentHttpParams = Type.Object({
  agent: Type.Optional(Type.String({ description: "Agent name for delegation or status target" })),
  task: Type.Optional(Type.String({ description: "Task to delegate to the agent" })),
  action: Type.Optional(Type.String({
    enum: ["list", "status", "cancel"],
    description: "Management action: list agents, check status, or cancel a run. Omit for delegation mode.",
  })),
  id: Type.Optional(Type.String({
    description: "Run id or prefix for action='status' or action='cancel'",
  })),
  tasks: Type.Optional(Type.Array(ParallelTaskItem, {
    description: "PARALLEL mode: delegate to multiple agents concurrently. Blocks until all complete.",
  })),
  context: Type.Optional(Type.String({
    description: "Additional context to include with the delegation request",
  })),
  async: Type.Optional(Type.Boolean({
    description: "Return immediately instead of waiting for result. Default false (blocks until complete).",
  })),
  pollIntervalMs: Type.Optional(Type.Integer({
    minimum: 500,
    description: "Override adaptive poll interval (ms). Default: adaptive backoff (2s→5s→10s→30s).",
  })),
});
