<p>
  <img src="https://raw.githubusercontent.com/nicobailon/pi-subagents/main/banner.png" alt="pi-subagents" width="1100">
</p>

# pi-subagents

`pi-subagents` lets Pi delegate work to focused child agents. Use it for code review, scouting, implementation, parallel audits, saved workflows, background jobs, and anything else that benefits from a second or third set of model eyes.

<https://github.com/user-attachments/assets/702554ec-faaf-4635-80aa-fb5d6e292fd1>

## Install

```bash
pi install npm:pi-subagents
```

That is the only required step. Background children require pi installed as the npm package (`@earendil-works/pi-coding-agent`): the detached runner imports pi's packages from that package directory. A standalone single-file pi binary has no package directory and cannot run background children; foreground children (`async: false`) still work there.

## Try this first

You do not need to create agents, write config, or learn slash commands. After installing, ask Pi in plain language:

```text
Use reviewer to review this diff.
```

```text
Ask oracle for a second opinion on my current plan. Challenge assumptions and tell me what I might be missing.
```

```text
Use scout to understand this code based on our discussion, then ask me clarification questions.
```

```text
Run parallel reviewers: one for correctness, one for tests, and one for unnecessary complexity.
```

That is enough to start. Pi decides whether to call the `subagent` tool, which agent to use, and how to compose the work.

## How it works

Pi is the parent session. A subagent is a focused child Pi session with its own job.

When you ask for a subagent, Pi starts the child, gives it the task, and brings the result back. Foreground children run as sessions inside the parent Pi process and stream in the conversation. Background children run as sessions inside a detached runner process that keeps working and can be checked later.

Installing the extension does not start an automatic reviewer in the background. It gives Pi a delegation tool. If you want every implementation reviewed, say so in your prompt or project instructions:

```text
When you finish implementing, run a reviewer subagent before summarizing.
```

## Builtin agents

The extension ships with agents you can use immediately:

| Agent | Use it when you want... |
|-------|--------------------------|
| `scout` | Fast local codebase recon: relevant files, entry points, data flow, risks. |
| `researcher` | Web/docs research with sources and a concise research brief. |
| `worker` | Implementation work. Edits files, validates, escalates unapproved decisions instead of guessing. |
| `reviewer` | Code review and small fixes against the task/plan, tests, edge cases, and simplicity. |
| `oracle` | A second opinion before acting. Challenges assumptions without editing. |
| `delegate` | A lightweight general delegate that behaves close to the parent session. |

Rule of thumb: `scout` before you understand the code, `researcher` before you trust external facts, `worker` to implement, `reviewer` to check, and `oracle` when the decision itself feels risky.

## Common workflows

The package includes `/council` and `council-mode`, plus documented model-based
`council-*` profile examples that you add in your own agent directory.

| Want | Ask naturally |
|------|---------------|
| Get a second opinion | "Ask oracle to review this plan and challenge assumptions." |
| Solve a hard problem | "Use oracle to investigate this bug before we edit." |
| Review a diff | "Use reviewer to review this diff." |
| Run parallel reviewers | "Run reviewers for correctness, tests, and cleanup." |
| Debate a material decision | "Use `/council` with model-based advisors to compare this decision." |
| Implement then review | "Implement this, then review it." |
| Review until clean | "Run a review loop on this change with a max of 3 rounds." |
| Execute a plan carefully | "Have worker implement this approved plan, then run reviewers and apply the feedback." |
| Scout before planning | "Use scout to inspect the auth flow before planning." |
| Run in the background | "Run this in the background." |
| Use a saved workflow | "Run the review chain on this branch." |
| Browse agents | "Show me the available subagents." |
| See running work | "Show active async runs." or "Show the subagent fleet." |
| Check setup | "Check whether subagents are configured correctly." |

For implementation work, the recommended loop is `clarify → scout → worker → fresh reviewers → worker`. Packaged prompt shortcuts like `/parallel-review` and `/review-loop` make these patterns repeatable — see [Workflows](https://github.com/nicobailon/pi-subagents/blob/main/docs/workflows.md).

## Where running work shows up

Foreground runs stream progress in the conversation. Background runs keep working after control returns to you.

In the TUI, a persistent FleetView below the editor keeps active work visible. `/subagents-fleet` opens a live inspector where you can browse children, read transcripts, steer a running child, or stop a run. You can also just ask: "Show me the current async runs."

Details, keybindings, and the machine-readable run artifacts are in [Observability](https://github.com/nicobailon/pi-subagents/blob/main/docs/observability.md).

For bounded orchestration, `maxSubagentSpawnsPerRun` limits cumulative logical children in one run tree. It defaults to 64 and stays separate from active concurrency and the session-wide cumulative spawn budget. See [Configuration](https://github.com/nicobailon/pi-subagents/blob/main/docs/configuration.md#maxsubagentspawnsperrun).

## If something feels off

```text
/subagents-doctor
```

or ask: "Check whether subagents and intercom are set up correctly."

For installed-version help, use `/subagents-guide [topic]` or `subagent({ action: "guide", topic: "workflows" })`. The default topic is `overview`; available topics are `overview`, `workflows`, `agents`, `missions`, `observability`, `tool-reference`, `configuration`, `models`, `watchdog`, and `extension-api`.

## Documentation

The full reference lives in `docs/`:

| Doc | What's in it |
|-----|--------------|
| [Agents](https://github.com/nicobailon/pi-subagents/blob/main/docs/agents.md) | Custom agents, frontmatter reference, overriding builtins, tools, extensions, skills, per-agent memory. |
| [Models](https://github.com/nicobailon/pi-subagents/blob/main/docs/models.md) | Default models, per-role overrides, recommended tiering, fallbacks, thinking levels, model scope enforcement, profiles. |
| [Workflows](https://github.com/nicobailon/pi-subagents/blob/main/docs/workflows.md) | Orchestration patterns, prompt shortcuts, scripted workflows, worktree isolation, child-to-parent coordination, the recursion guard. |
| [Watchdog](https://github.com/nicobailon/pi-subagents/blob/main/docs/watchdog.md) | The opt-in adversarial change reviewer, scope monitoring, LSP checks, and child tool permissions. |
| [Tool reference](https://github.com/nicobailon/pi-subagents/blob/main/docs/tool-reference.md) | Every `subagent` parameter, management actions, status/control actions, acceptance gates, external CLI runners. |
| [Observability](https://github.com/nicobailon/pi-subagents/blob/main/docs/observability.md) | FleetView, the fleet inspector, lifecycle artifacts, events, logs, session sharing. |
| [Missions and schedules](https://github.com/nicobailon/pi-subagents/blob/main/docs/missions.md) | Durable mission records, delivery receipts, timed and recurring runs. |
| [Configuration](https://github.com/nicobailon/pi-subagents/blob/main/docs/configuration.md) | Every `config.json` key and environment variable. |
| [Extension API](https://github.com/nicobailon/pi-subagents/blob/main/docs/extension-api.md) | The RPC, delegation API, preflight, capability ceilings, [trusted workflow resources](docs/extension-api.md#trusted-workflow-resources), background-work providers, Herdr integration. |
