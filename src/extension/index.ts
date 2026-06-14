/**
 * Subagent HTTP Extension
 *
 * Delegates tasks to remote agents over HTTP.
 * - Single: { agent, task } — blocks until remote agent completes (default)
 * - Parallel: { tasks: [...] } — blocks until all remote agents complete
 * - Async: { agent, task, async: true } — fire-and-forget, poll manually
 * - Management: { action: "list" | "status" | "cancel" }
 *
 * Remote agents must implement: POST /invoke (202), GET /status/:runId, GET /result/:runId
 *
 * Config file: ~/.pi/agent/extensions/subagent-http/config.json
 */

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { SubagentHttpParams } from "./schemas.ts";
import { loadConfig } from "./config.ts";
import type { AgentEndpoint, RemoteRun, RemoteRunState, ResultResponse } from "../transport/types.ts";
import { listAgents } from "../transport/config.ts";
import { invoke, getStatus, getResult, cancelRun } from "../transport/http-client.ts";
import { AgentMonitor } from "../transport/agent-monitor.ts";
import { pollUntilDone, type PollResult } from "../transport/poll.ts";
import { randomUUID } from "node:crypto";
import { JobTracker } from "../transport/job-tracker.ts";

export { loadConfig } from "./config.ts";

interface HttpDetails {
  mode: "single" | "parallel" | "management";
  runId?: string;
  runs?: Array<{ runId: string; agent: string; state: string }>;
}

function formatResult(agent: string, poll: PollResult): string {
  if (poll.state === "timeout") return `${agent}: timed out after ${Math.round(poll.durationMs / 1000)}s`;
  if (poll.state === "cancelled") return `${agent}: cancelled`;
  const r = poll.result;
  if (!r) return `${agent}: ${poll.state}${poll.error ? ` — ${poll.error}` : ""}`;
  const meta = [
    r.model ? `model: ${r.model}` : null,
    r.usage ? `${r.usage.input}in/${r.usage.output}out, ${r.usage.turns} turns` : null,
    `${Math.round(poll.durationMs / 1000)}s`,
  ].filter(Boolean).join(", ");
  const header = poll.state === "completed"
    ? `${agent} completed (${meta})`
    : `${agent} failed (${meta}): ${r.error || poll.error || "unknown error"}`;
  return r.output ? `${header}\n\n${r.output}` : header;
}

export default function registerSubagentHttpExtension(pi: ExtensionAPI): void {
  const config = loadConfig();
  const defaultTimeoutMs = config.defaults?.timeoutMs ?? 300000;
  const pollIntervalMs = config.defaults?.pollIntervalMs ?? 3000;
  const tracker = new JobTracker(pollIntervalMs);
  const monitor = new AgentMonitor(config);

  function resolveAgent(name: string): AgentEndpoint | undefined {
    const lower = name.toLowerCase();
    return config.agents.find(a => a.name?.toLowerCase() === lower);
  }

  // Notifications for async-mode runs only
  tracker.onEvent((event) => {
    if (event.type === "completed" || event.type === "failed" || event.type === "timeout") {
      const status = event.type === "completed" ? "✓" : "✗";
      const preview = event.result?.output?.slice(0, 200) ?? event.error ?? "(no output)";
      try {
        pi.sendMessage(
          { customType: "subagent-notify", content: `${status} Remote subagent ${event.agent} ${event.type}: ${preview}`, display: true },
          { triggerTurn: true },
        );
      } catch { /* session may be gone */ }
    }
  });

  const tool: ToolDefinition<typeof SubagentHttpParams, HttpDetails> = {
    name: "subagent",
    label: "Remote Subagent",
    description: `Delegate tasks to remote agents running as HTTP services. Blocks until the remote agent completes and returns the full result.

DELEGATION (use exactly one mode):
• SINGLE: { agent: "name", task: "do something" } — blocks until complete
• PARALLEL: { tasks: [{agent: "a", task: "..."}, {agent: "b", task: "..."}] } — blocks until all complete
• ASYNC: add async: true to return immediately (use action: "status" to check later)

MANAGEMENT:
• { action: "list" } — show available remote agents
• { action: "status" } — show all tracked runs
• { action: "status", id: "abc" } — check specific run
• { action: "cancel", id: "abc" } — cancel a running task

OPTIONAL:
• pollIntervalMs: override adaptive poll interval (default: adaptive 2s→5s→10s→30s)`,
    parameters: SubagentHttpParams,

    async execute(_id, params, _signal, _onUpdate, _ctx): Promise<AgentToolResult<HttpDetails>> {
      // ACTION: list
      if (params.action === "list") {
        const agents = listAgents(config);
        if (agents.length === 0) {
          return {
            content: [{ type: "text", text: "No remote agents configured. Add agents to ~/.pi/agent/extensions/subagent-http/config.json" }],
            details: { mode: "management" },
          };
        }
        const lines = agents.map((a) => {
          const health = monitor.getHealth(a.url);
          const statusIcon = !health ? "?" : health.status === "ready" ? "●" : health.status === "busy" ? "◐" : health.status === "starting" ? "○" : "✗";
          const name = a.name || health?.describe?.name || health?.name || a.url;
          const model = health?.describe?.model || a.model || "";
          const desc = health?.describe?.description || a.description || "";
          const caps = health?.describe?.capabilities || "";
          const parts = [`${statusIcon} ${name} (${a.url})`];
          if (model) parts[0] += ` [${model}]`;
          if (desc) parts[0] += ` — ${desc}`;
          if (caps) parts.push(`    ${caps}`);
          if (health?.error) parts.push(`    Error: ${health.error}`);
          return parts.join("\n");
        });
        const warnings = monitor.getWarnings();
        const warningText = warnings.length > 0 ? `\n\nWarnings:\n${warnings.join("\n")}` : "";
        return {
          content: [{ type: "text", text: `Remote agents:\n${lines.join("\n")}${warningText}` }],
          details: { mode: "management" },
        };
      }

      // ACTION: status
      if (params.action === "status") {
        if (params.id) {
          const run = tracker.get(params.id);
          if (!run) {
            return {
              content: [{ type: "text", text: `No run found matching '${params.id}'` }],
              isError: true,
              details: { mode: "management" },
            };
          }
          try {
            const freshStatus = await getStatus(run.url, run.runId);
            run.state = freshStatus.state as RemoteRunState;
            run.lastCheckedAt = Date.now();
            if (freshStatus.state === "completed" || freshStatus.state === "failed") {
              try {
                const result = await getResult(run.url, run.runId);
                run.result = result;
                run.state = result.state as RemoteRunState;
                if (result.error) run.error = result.error;
              } catch { /* result fetch failed */ }
            }
          } catch { /* connectivity error */ }
          const elapsed = Math.floor((Date.now() - run.startedAt) / 1000);
          const lines = [
            `Run: ${run.runId}`,
            `Agent: ${run.agent} (${run.url})`,
            `State: ${run.state}`,
            `Elapsed: ${elapsed}s`,
            run.result?.model ? `Model: ${run.result.model}` : null,
            run.result?.usage ? `Usage: ${run.result.usage.input}in/${run.result.usage.output}out, ${run.result.usage.turns} turns` : null,
            run.error ? `Error: ${run.error}` : null,
            run.result?.output ? `\nOutput:\n${run.result.output}` : null,
          ].filter(Boolean);
          return {
            content: [{ type: "text", text: lines.join("\n") }],
            details: { mode: "management", runId: run.runId },
          };
        }
        const allRuns = tracker.getAll();
        if (allRuns.length === 0) {
          return { content: [{ type: "text", text: "No runs tracked." }], details: { mode: "management" } };
        }
        const lines = allRuns.map(r => {
          const elapsed = Math.floor((Date.now() - r.startedAt) / 1000);
          return `• [${r.state}] ${r.agent} (${r.runId.slice(0, 8)}) — ${elapsed}s`;
        });
        return {
          content: [{ type: "text", text: `Runs:\n${lines.join("\n")}` }],
          details: { mode: "management", runs: allRuns.map(r => ({ runId: r.runId, agent: r.agent, state: r.state })) },
        };
      }

      // ACTION: cancel
      if (params.action === "cancel") {
        if (!params.id) {
          return { content: [{ type: "text", text: "action='cancel' requires id." }], isError: true, details: { mode: "management" } };
        }
        const run = tracker.get(params.id);
        if (!run) {
          return { content: [{ type: "text", text: `No run found matching '${params.id}'` }], isError: true, details: { mode: "management" } };
        }
        if (run.state === "completed" || run.state === "failed" || run.state === "timeout") {
          return { content: [{ type: "text", text: `Run ${run.runId} already finished (${run.state})` }], isError: true, details: { mode: "management" } };
        }
        try {
          await cancelRun(run.url, run.runId);
        } catch {
          // /cancel not implemented — mark locally anyway
        }
        run.state = "failed";
        run.error = "Cancelled by orchestrator";
        return { content: [{ type: "text", text: `Cancelled run ${run.runId} (${run.agent})` }], details: { mode: "management", runId: run.runId } };
      }

      // DELEGATION: parallel
      if (params.tasks && params.tasks.length > 0) {
        const isAsync = params.async === true;

        const invocations = await Promise.allSettled(params.tasks.map(async (t) => {
          const endpoint = resolveAgent(t.agent);
          if (!endpoint) return { agent: t.agent, error: `Unknown agent: ${t.agent}` } as const;
          try {
            const correlationId = randomUUID();
            const resp = await invoke(endpoint.url, { task: t.task, context: params.context, correlationId });
            return { agent: t.agent, endpoint, runId: resp.runId } as const;
          } catch (err) {
            return { agent: t.agent, error: err instanceof Error ? err.message : String(err) } as const;
          }
        }));

        const dispatched = invocations
          .map(r => r.status === "fulfilled" ? r.value : { agent: "?", error: "dispatch failed" } as const)
          .filter((r): r is { agent: string; endpoint: AgentEndpoint; runId: string } => "runId" in r);
        const errors = invocations
          .map(r => r.status === "fulfilled" ? r.value : { agent: "?", error: "dispatch failed" } as const)
          .filter((r): r is { agent: string; error: string } => "error" in r);

        if (isAsync) {
          for (const d of dispatched) {
            tracker.track({
              runId: d.runId, agent: d.agent, url: d.endpoint.url, task: "", state: "running",
              startedAt: Date.now(), timeoutMs: d.endpoint.timeoutMs ?? defaultTimeoutMs, pollIntervalMs,
            });
          }
          const lines = [
            ...dispatched.map(d => `✓ ${d.agent}: delegated [${d.runId.slice(0, 8)}]`),
            ...errors.map(e => `✗ ${e.agent}: ${e.error}`),
          ];
          return {
            content: [{ type: "text", text: `Parallel delegation (async):\n${lines.join("\n")}\n\nUse subagent({ action: "status" }) to check progress.` }],
            details: { mode: "parallel", runs: dispatched.map(d => ({ runId: d.runId, agent: d.agent, state: "running" })) },
          };
        }

        // Blocking: poll all until done
        const pollResults = await Promise.allSettled(dispatched.map(async (d) => {
          const poll = await pollUntilDone({
            baseUrl: d.endpoint.url,
            runId: d.runId,
            timeoutMs: d.endpoint.timeoutMs ?? defaultTimeoutMs,
            fixedIntervalMs: params.pollIntervalMs ?? undefined,
            signal: _signal,
          });
          return { agent: d.agent, poll };
        }));

        const results = pollResults
          .map(r => r.status === "fulfilled" ? r.value : null)
          .filter(Boolean) as Array<{ agent: string; poll: PollResult }>;

        const parts: string[] = [];
        for (const { agent, poll } of results) {
          parts.push(formatResult(agent, poll));
        }
        for (const e of errors) {
          parts.push(`${e.agent}: ${e.error}`);
        }

        const allCompleted = results.every(r => r.poll.state === "completed");
        return {
          content: [{ type: "text", text: parts.join("\n\n---\n\n") }],
          isError: !allCompleted && results.length > 0 ? true : errors.length > 0 && results.length === 0 ? true : undefined,
          details: {
            mode: "parallel",
            runs: results.map(r => ({ runId: r.poll.result?.runId ?? "", agent: r.agent, state: r.poll.state })),
          },
        };
      }

      // DELEGATION: single
      if (params.agent && params.task) {
        const endpoint = resolveAgent(params.agent);
        if (!endpoint) {
          return {
            content: [{ type: "text", text: `Unknown agent: ${params.agent}. Use subagent({ action: "list" }) to see available agents.` }],
            isError: true,
            details: { mode: "single" },
          };
        }

        let resp;
        try {
          const correlationId = randomUUID();
          resp = await invoke(endpoint.url, { task: params.task, context: params.context, correlationId });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return {
            content: [{ type: "text", text: `Failed to delegate to ${params.agent}: ${msg}` }],
            isError: true,
            details: { mode: "single" },
          };
        }

        // Async mode: return immediately
        if (params.async === true) {
          tracker.track({
            runId: resp.runId, agent: params.agent, url: endpoint.url, task: params.task, state: "running",
            startedAt: Date.now(), timeoutMs: endpoint.timeoutMs ?? defaultTimeoutMs, pollIntervalMs,
          });
          return {
            content: [{ type: "text", text: `Delegated to ${params.agent} [${resp.runId.slice(0, 8)}] (async)\n\nUse subagent({ action: "status", id: "${resp.runId.slice(0, 8)}" }) to check progress.` }],
            details: { mode: "single", runId: resp.runId },
          };
        }

        // Blocking: poll until done
        const poll = await pollUntilDone({
          baseUrl: endpoint.url,
          runId: resp.runId,
          timeoutMs: endpoint.timeoutMs ?? defaultTimeoutMs,
          fixedIntervalMs: params.pollIntervalMs ?? undefined,
          signal: _signal,
        });

        return {
          content: [{ type: "text", text: formatResult(params.agent, poll) }],
          isError: poll.state !== "completed" ? true : undefined,
          details: { mode: "single", runId: resp.runId },
        };
      }

      // No valid mode
      return {
        content: [{ type: "text", text: "Provide { agent, task } for single delegation, { tasks: [...] } for parallel, or { action: \"list\" }." }],
        isError: true,
        details: { mode: "management" },
      };
    },

    renderCall(args, theme) {
      if (args.action === "list") return new Text(`${theme.fg("toolTitle", theme.bold("subagent "))}list`, 0, 0);
      if (args.action === "status") {
        const target = args.id ? ` ${args.id}` : "";
        return new Text(`${theme.fg("toolTitle", theme.bold("subagent "))}status${target}`, 0, 0);
      }
      if (args.action === "cancel") {
        return new Text(`${theme.fg("toolTitle", theme.bold("subagent "))}cancel ${args.id ?? "?"}`, 0, 0);
      }
      if (args.tasks?.length) {
        const mode = args.async ? "async " : "";
        return new Text(`${theme.fg("toolTitle", theme.bold("subagent "))}${mode}parallel (${args.tasks.length})`, 0, 0);
      }
      const mode = args.async ? " [async]" : "";
      return new Text(`${theme.fg("toolTitle", theme.bold("subagent "))}${theme.fg("accent", args.agent ?? "?")}${mode}`, 0, 0);
    },

    renderResult(result, _options, _theme) {
      const text = result.content?.map(c => c.type === "text" ? c.text : "").join("") ?? "";
      return new Text(text, 0, 0);
    },
  };

  pi.registerTool(tool);

  pi.on("session_shutdown", () => {
    tracker.stop();
    monitor.stop();
  });
}
