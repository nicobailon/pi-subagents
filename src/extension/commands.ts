import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { HttpConfig } from "../transport/types.ts";
import type { PollResult } from "../transport/poll.ts";
import { invoke } from "../transport/http-client.ts";

type ResultWaiter = (agentUrl: string, runId: string, timeoutMs: number, signal?: AbortSignal) => Promise<PollResult>;
type ResultFormatter = (agent: string, poll: PollResult) => string;

export function registerCommands(
  pi: ExtensionAPI,
  config: HttpConfig,
  waitForResult: ResultWaiter,
  formatResult: ResultFormatter,
) {
  if (config.commands?.enabled === false) return;

  for (const agent of config.agents) {
    const name = agent.name.toLowerCase();

    pi.registerCommand(name, {
      description: `Delegate to ${agent.name}`,
      handler: async (args: string) => {
        const task = args.trim();
        if (!task) {
          pi.sendMessage(
            { customType: "subagent-cmd", content: `Usage: /${name} <task>`, display: true },
            { triggerTurn: false },
          );
          return;
        }

        pi.sendMessage(
          { customType: "subagent-cmd", content: `Delegating to ${agent.name}...`, display: true },
          { triggerTurn: false },
        );

        try {
          const resp = await invoke(agent.url, { task });
          const timeoutMs = agent.timeoutMs ?? config.defaults?.timeoutMs ?? 300_000;
          const result = await waitForResult(agent.url, resp.runId, timeoutMs);

          pi.sendMessage(
            { customType: "subagent-result", content: formatResult(agent.name, result), display: true },
            { triggerTurn: true },
          );
        } catch (err: any) {
          pi.sendMessage(
            { customType: "subagent-error", content: `${agent.name} failed: ${err.message}`, display: true },
            { triggerTurn: false },
          );
        }
      },
    });
  }

  const aliases = config.commands?.aliases || {};
  for (const [alias, target] of Object.entries(aliases)) {
    const targetAgent = config.agents.find(a => a.name.toLowerCase() === target.toLowerCase());
    if (!targetAgent) continue;
    pi.registerCommand(alias, {
      description: `Alias for /${target}`,
      handler: (args: string) => {
        const targetName = targetAgent.name.toLowerCase();
        const cmd = config.agents.find(a => a.name.toLowerCase() === targetName);
        if (!cmd) return;
        return invoke(cmd.url, { task: args.trim() }).then(async (resp) => {
          const timeoutMs = cmd.timeoutMs ?? config.defaults?.timeoutMs ?? 300_000;
          const result = await waitForResult(cmd.url, resp.runId, timeoutMs);
          pi.sendMessage(
            { customType: "subagent-result", content: formatResult(cmd.name, result), display: true },
            { triggerTurn: true },
          );
        }).catch((err: any) => {
          pi.sendMessage(
            { customType: "subagent-error", content: `${targetAgent.name} failed: ${err.message}`, display: true },
            { triggerTurn: false },
          );
        });
      },
    });
  }
}

export function registerShortcuts(pi: ExtensionAPI, config: HttpConfig) {
  if (!config.shortcuts) return;
  for (const [key, agentName] of Object.entries(config.shortcuts)) {
    const agent = config.agents.find(a => a.name.toLowerCase() === agentName.toLowerCase());
    if (!agent) continue;
    pi.registerShortcut(key, {
      description: `Send to ${agent.name}`,
      handler: async (ctx: any) => {
        const task = ctx.ui.getEditorText().trim();
        if (!task) return;
        ctx.ui.setEditorText("");
        // Trigger the registered command for this agent
        pi.sendMessage(
          { customType: "subagent-cmd", content: `/${agent!.name.toLowerCase()} ${task}`, display: true },
          { triggerTurn: true },
        );
      },
    });
  }
}
