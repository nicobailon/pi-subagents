---
name: pi-subagents
description: |
  Delegate work to builtin or custom subagents with single-agent, chain,
  parallel, async, forked-context, and intercom-coordinated workflows. Use
  for advisory review, implementation handoffs, and multi-step tasks where a
  single agent should stay in control while other agents contribute context,
  planning, or execution.
---

# Pi Subagents

Use this skill when you need to launch a specialized subagent, compose multiple
agents into a workflow, or create/edit agents and chains on demand.

## When to Use

- **Advisory review**: use fresh-context `reviewer` agents for adversarial code review, or fork to `oracle` when inherited decisions and drift matter
- **Implementation handoff**: have `oracle` advise, then `worker` implement only after an approved direction
- **Recon and planning**: use `scout` or `context-builder`, then `planner`
- **Parallel exploration**: run multiple non-conflicting tasks concurrently
- **Long-running work**: launch async/background runs and inspect them later
- **Subagent control**: watch needs-attention signals and soft-interrupt only when a delegated run is genuinely blocked
- **Agent authoring**: create, update, or override agents and chains for a project

## Tool vs Slash Commands

Agents can use the `subagent(...)` tool directly for execution, management, status, and control.
Humans often use the slash-command layer instead:

- `/run` — launch a single agent
- `/chain` — launch a chain of steps
- `/parallel` — launch top-level parallel tasks
- `/agents` — open the agents manager TUI
- `/run-chain` — launch a saved `.chain.md` workflow
- `/subagents-status` — inspect active/recent async runs
- `/subagents-doctor` — diagnose setup, discovery, async paths, and intercom bridge state

Prefer the tool when you are writing agent logic. Prefer the slash commands when
you are guiding a human through an interactive flow.

Packaged prompt shortcuts are also available for repeatable workflows:
- `/parallel-review` — fresh-context reviewers with distinct review angles, then synthesis
- `/parallel-research` — combine `researcher` and `scout` for external evidence plus local code context
- `/gather-context-and-clarify` — scout/research first, then ask the user clarifying questions with `interview`

## Builtin Agents

Builtin agents load at the lowest priority. Project agents override user agents,
and user/project agents override builtins with the same name.

| Agent | Purpose | Model | Typical output / role |
|-------|---------|-------|------------------------|
| `scout` | Fast codebase recon | `openai-codex/gpt-5.4-mini` | Writes `context.md` handoff material |
| `planner` | Creates implementation plans | `openai-codex/gpt-5.5` | Writes `plan.md` |
| `worker` | Implementation and approved oracle handoffs | `openai-codex/gpt-5.3-codex` | Single-writer implementation with decision escalation |
| `reviewer` | Review-and-fix specialist | `openai-codex/gpt-5.5` | Can edit/fix reviewed code |
| `context-builder` | Requirements/codebase handoff builder | `openai-codex/gpt-5.5` | Writes structured context files |
| `researcher` | Web research brief generator | `openai-codex/gpt-5.5` | Writes `research.md` |
| `delegate` | Lightweight generic delegate | inherits parent model | No fixed output; generic delegated work |
| `oracle` | Decision-consistency advisory review | `openai-codex/gpt-5.5` | Advisory review, intercom coordination |

Override builtin defaults before copying full agent files when a small tweak is enough.

For one run, use inline config:

```text
/run reviewer[model=anthropic/claude-sonnet-4] "Review this diff"
```

For persistent tweaks, prefer `/agents`: choose the builtin, press `e`, change the model or other fields, then save a user or project override. User overrides apply everywhere. Project overrides apply only in that repo and win over user overrides.

Settings locations:
- User scope: `~/.pi/agent/settings.json`
- Project scope: `.pi/settings.json`

Direct settings example:

```json
{
  "subagents": {
    "agentOverrides": {
      "reviewer": {
        "model": "anthropic/claude-sonnet-4",
        "thinking": "high",
        "fallbackModels": ["openai/gpt-5-mini"]
      }
    }
  }
}
```

Useful override fields: `model`, `fallbackModels`, `thinking`,
`systemPromptMode`, `inheritProjectContext`, `inheritSkills`, `disabled`,
`skills`, `tools`, and `systemPrompt`. Create a user or project agent with the
same name only when you want a substantially different agent.

## Discovery and Scope Rules

Agent files can live in:
- `~/.pi/agent/agents/*.md` — user scope
- `.pi/agents/*.md` — canonical project scope
- legacy `.agents/*.md` — still read for compatibility, but `.pi/agents/` wins on conflicts

Chains live in:
- `~/.pi/agent/agents/*.chain.md`
- `.pi/agents/*.chain.md`
- legacy `.agents/*.chain.md`

Precedence is:
1. project scope
2. user scope
3. builtin agents

## Running Subagents

### Single agent

```typescript
subagent({
  agent: "oracle",
  task: "Review my current direction and challenge assumptions."
})
```

### Forked context

```typescript
subagent({
  agent: "oracle",
  task: "Review my current direction and challenge assumptions.",
  context: "fork"
})
```

`context: "fork"` creates a branched child session from the current persisted
parent session. It does **not** create a fresh minimal review context or filter
history down to only the relevant parts. Use it when you want a separate review
or execution thread that can still reference the parent session history.

### Parallel execution

```typescript
subagent({
  tasks: [
    { agent: "scout", task: "Explore the auth module" },
    { agent: "reviewer", task: "Review the API client" }
  ]
})
```

Top-level parallel tasks can override per-task behavior:

```typescript
subagent({
  tasks: [
    { agent: "scout", task: "Map auth", output: "auth-context.md", progress: true },
    { agent: "researcher", task: "Research OAuth best practices", output: "oauth-research.md" },
    { agent: "reviewer", task: "Review auth tests", model: "anthropic/claude-sonnet-4" }
  ],
  concurrency: 3
})
```

Avoid duplicate output paths in parallel tasks. Concurrent children should not write to the same file.

### Chain execution

```typescript
subagent({
  chain: [
    { agent: "scout", task: "Map the auth flow and summarize key files" },
    { agent: "planner", task: "Create an implementation plan from {previous}" },
    { agent: "worker", task: "Implement the approved plan based on {previous}" }
  ]
})
```

Chain steps can use templated variables such as `{task}`, `{previous}`, and
`{chain_dir}`. This is the main way to pass structured summaries between steps
without forcing each step to rediscover everything.

### Async/background

```typescript
subagent({
  agent: "worker",
  task: "Run the full test suite",
  async: true
})
```

Inspect async runs with `subagent({ action: "status", id: "..." })`, `subagent({ action: "status" })` for active runs, or the `/subagents-status` slash command.

Use diagnostics when setup or child startup looks wrong:

```typescript
subagent({ action: "doctor" })
```

Humans can use `/subagents-doctor` for the same read-only report. It checks runtime paths, discovery counts, async support, current session context, and intercom bridge state.

### Subagent control

Subagent control is the runtime visibility and intervention layer for delegated runs. It is separate from lifecycle status. Lifecycle status says whether a child is `queued`, `running`, `paused`, `complete`, or `failed`. Activity reporting is factual: it tracks the last observed activity time and the current tool when known. It does not pretend to know that a child is truly stuck.

Default behavior is intentionally conservative. When no activity has been observed past the configured threshold, the run emits a `needs_attention` control event. Foreground runs can push this as a `subagent:control-event` event, and async runs persist it to `events.jsonl` so the parent tracker can surface it without constant manual polling. Notification-worthy control events are also inserted into the visible transcript so both the user and the parent agent can see them, with a proactive hint plus concrete `nudge`, `status`, and `interrupt` options. Visible notifications fire once per child run and attention state.

Use soft interrupt when a child is clearly blocked or drifting and the parent needs to regain control:

```typescript
subagent({ action: "interrupt" })
```

Pass `id` when targeting a specific controllable run:

```typescript
subagent({ action: "interrupt", id: "abc123" })
```

A soft interrupt cancels the current child turn and leaves the run paused. It does not mean the delegated task succeeded or failed. After an interrupt, decide the next explicit action: resume with clearer instructions, replace the task, ask the user, or stop the workflow.

Per-run control thresholds can be overridden when a task legitimately runs without observable output for longer than usual:

```typescript
subagent({
  agent: "worker",
  task: "Run the slow migration test suite",
  control: {
    needsAttentionAfterMs: 300000,
    notifyOn: ["needs_attention"]
  }
})
```

If the run already has an active intercom bridge target, needs-attention notifications can also prepare a compact intercom ping for the orchestrator. When a child route is available, the ping tells the orchestrator which agent needs attention and includes the exact `intercom({ action: "send", to: "..." })` target for a nudge. Do not invent a target or ask the child to self-report when no bridge exists.

## Clarify TUI

Single and parallel runs support a clarification TUI when you want to preview or
edit parameters before launch:

```typescript
subagent({
  agent: "worker",
  task: "Implement feature X",
  clarify: true
})
```

Chains default to clarify mode unless you explicitly set `clarify: false`.
For programmatic background launches, use `clarify: false, async: true`.

The `/agents` manager also has launch toggles for forked context, background execution, and worktree-isolated parallel runs. Use it when guiding a human who wants to inspect or edit the launch before starting.

## Worktree Isolation

When multiple agents might write concurrently, use worktrees instead of letting
them share one filesystem view.

```typescript
subagent({
  tasks: [
    { agent: "worker", task: "Implement feature A" },
    { agent: "worker", task: "Implement feature B" }
  ],
  worktree: true
})
```

`worktree: true` gives each parallel task its own git worktree branched from
HEAD. This requires a clean git state and is mainly for intentionally parallel
write workflows. If you want one writer thread and several advisory agents,
prefer a single-writer pattern instead.

## The Oracle Workflow

The intended oracle loop is:
1. the main agent forks to `oracle`
2. `oracle` reviews direction, drift, assumptions, and risks
3. `oracle` can coordinate back to the orchestrator via `intercom`
4. the main agent decides what direction to approve
5. only then should `worker` implement

```typescript
// Advisory review in a branched thread
subagent({
  agent: "oracle",
  task: "Review my current direction, challenge assumptions, and propose the best next move.",
  context: "fork"
})

// Implementation only after explicit approval
subagent({
  agent: "worker",
  task: "Implement the approved approach: ...",
  context: "fork"
})
```

`oracle` is not a fresh-context reviewer in the Cognition article sense. It is
a forked advisory thread that inherits the parent session history and uses that
history as a baseline contract.

## Subagent + Intercom Coordination

`pi-subagents` works without `pi-intercom`. When `pi-intercom` is installed and enabled, the intercom bridge can automatically give child agents a private coordination channel back to the parent session.

Most agents should not call `intercom` directly unless bridge instructions provide a target. Do not invent a target. Use the target from the injected bridge instructions or from a visible needs-attention notice.

Use `intercom` when:
- a subagent is blocked on a decision
- a child needs clarification instead of guessing
- a detached or async child needs to coordinate without waiting for normal tool return flow
- an advisory agent was explicitly asked to send a concise progress update

Message conventions:
- `ask` means the child needs a decision or clarification from the parent session.
- `send` means a short blocked/progress update, only when blocked or explicitly asked.
- Child-side routine completion handoffs are not expected. With the intercom bridge active, parent-side `pi-subagents` sends grouped completion results through `pi-intercom`: one grouped message per foreground parent run and one per completed async result file. Acknowledged foreground delivery returns a compact receipt with artifact/session paths; if unacknowledged, the normal full output is preserved. Grouped messages include child intercom targets and full child summaries.

If a bridge target is available, a child can ask:

```typescript
intercom({
  action: "ask",
  to: "<bridge-provided-target>",
  message: "Should I optimize for readability or performance here?"
})
```

The parent replies with:

```typescript
intercom({ action: "reply", message: "Optimize for readability." })
```

Or inspects unresolved asks first:

```typescript
intercom({ action: "pending" })
```

If intercom messages do not show up, run `subagent({ action: "doctor" })` or `/subagents-doctor`.

## Management Mode

The `subagent(...)` tool also supports management actions.

### List available agents and chains

```typescript
subagent({ action: "list" })
```

### Create an agent

```typescript
subagent({
  action: "create",
  config: {
    name: "my-agent",
    description: "Project-specific implementation helper",
    systemPrompt: "Your system prompt here.",
    systemPromptMode: "replace",
    model: "openai-codex/gpt-5.4",
    tools: "read,grep,find,ls,bash"
  }
})
```

### Update an agent

```typescript
subagent({
  action: "update",
  agent: "my-agent",
  config: {
    thinking: "high"
  }
})
```

### Delete an agent

```typescript
subagent({ action: "delete", agent: "my-agent" })
```

Use management actions when the system needs to create or edit subagents on
demand without dropping into raw file editing.

Management actions create or update user/project agent files. For small builtin changes such as a model swap, prefer `/agents` builtin overrides or `subagents.agentOverrides` in settings.

## Creating and Editing Agents by File

A minimal agent file looks like this:

```markdown
---
name: my-agent
description: What this agent does
model: openai-codex/gpt-5.4
thinking: high
tools: read, grep, find, ls, bash
systemPromptMode: replace
inheritProjectContext: true
inheritSkills: false
---

Your system prompt here.
```

That is only a starting point. Common optional fields include:
- `defaultProgress`
- `defaultReads`
- `output`
- `fallbackModels`
- `maxSubagentDepth`

For many customizations, builtin overrides in settings are lower-friction than
copying a full builtin file.

## Prompt Template Integration

The package includes prompt shortcuts for common workflows: `/parallel-review`,
`/parallel-research`, and `/gather-context-and-clarify`. Use them when the user
wants repeatable review, research, or clarification patterns.

If `pi-prompt-template-model` is installed, additional user prompt templates can delegate into
`pi-subagents`. This is useful when a slash command should always run through a
particular agent or with forked context.

## Important Constraints

- **Forking requires a persisted parent session.** If the current session does not
  have a persisted session file, forked runs fail.
- **Forked runs inherit parent history.** They are branched threads, not fresh
  filtered contexts. Use fresh context for adversarial reviewers unless the user explicitly asks for forked context.
- **Default subagent nesting depth is 2.** Deeper recursive delegation is blocked
  unless configured otherwise.
- **Attention signals are not lifecycle state.** `needs_attention` means no activity has been observed past the configured threshold. `paused` means the child turn was intentionally interrupted or is awaiting direction; it is not the same as `failed`.
- **Intercom asks are blocking.** A session can only maintain one pending outbound
  ask wait state at a time.
- **Keep conversational authority clear.** Advisory subagents should not silently
  become second decision-makers.

## Best Practices

### Keep writes single-threaded by default

A strong pattern is one main decision-maker plus advisory/research/review
subagents around it. Use `oracle` for advice and `worker` for the actual write path.

### Use fork for branched advisory or execution threads

Forked runs are useful when the child should reason in a separate thread while
still inheriting the parent’s accumulated context. They are especially useful for
`oracle`, which audits inherited decisions and drift. For adversarial code review,
prefer fresh-context reviewers that inspect the repo and diff directly unless the
user explicitly requests forked context.

### Prefer narrow tasks

Give subagents specific tasks rather than vague mandates.
`Review auth.ts for null-check gaps` works better than `Review everything`.

### Escalate decisions upward

If a subagent encounters an unapproved product, architecture, or scope choice,
it should coordinate back via `intercom` instead of deciding alone.

### Intervene only on clear control signals

Use subagent control proactively when a delegated run emits `needs_attention`, or when a human asks you to regain control. Do not interrupt just because a child has briefly produced no output. Silence can be normal during long tool calls, test runs, or model reasoning.

### Name sessions meaningfully

Use `/name` so intercom targeting stays stable.

## Common Workflows

### Recon → Plan → Implement

```typescript
subagent({
  chain: [
    { agent: "scout", task: "Map the auth flow and summarize relevant files" },
    { agent: "planner", task: "Plan the migration from {previous}" },
    { agent: "worker", task: "Implement the approved plan from {previous}" }
  ]
})
```

### Clarify → Plan → Implement → Review (self-orchestrated workflow)

When you are the orchestrating agent for a new feature or non-trivial change, factor in the packaged prompt workflows without literally invoking slash commands. Use the same patterns through tools and subagents:

- `/gather-context-and-clarify` maps to: launch `scout` and, when needed, `researcher`; synthesize findings; then use `interview` to ask every clarification question needed for shared understanding.
- `/parallel-review` maps to: launch fresh-context `reviewer` agents with distinct review angles; synthesize the feedback before applying anything.
- `/parallel-research` maps to: combine local `scout` context with external `researcher` evidence when current docs, ecosystem behavior, or API details matter.
- `/parallel-cleanup` maps to: use review-only cleanup passes after implementation, especially for simplicity, verbosity, and redundant tests.

For feature work, use this sequence:

1. Clarify first. This is mandatory. Gather code context with `scout` or `context-builder`, add `researcher` only when external evidence matters, then ask the user clarifying questions with `interview` until scope, acceptance criteria, constraints, and non-goals are clear.
2. Plan when useful. For complex work, call `planner` or write a plan doc yourself. For simple work, confirm the shared understanding and skip the plan.
3. Implement with one writer. After approval, launch a forked `worker` with a proper meta prompt that includes the clarified requirements, relevant context, plan path or summary, acceptance criteria, and validation expectations.
4. Review automatically. After the worker completes, launch parallel fresh-context `reviewer` agents for correctness/regressions, tests/validation, and simplicity/maintainability. Use `output: false` unless review artifacts are explicitly needed.
5. Synthesize before acting. Separate blockers, fixes worth doing now, optional improvements, and feedback to ignore/defer. Ask before applying review fixes unless the user already authorized a writer pass.

Example implementation handoff after clarification and optional planning:

```typescript
subagent({
  agent: "worker",
  context: "fork",
  task: "Implement the approved feature.\n\nClarified requirements:\n- ...\n\nPlan: see ~/Documents/docs/...-plan.md\n\nValidation expected:\n- ..."
})
```

Example review pass after implementation:

```typescript
subagent({
  tasks: [
    { agent: "reviewer", task: "Review the current diff for correctness and regressions. Inspect changed files directly.", output: false },
    { agent: "reviewer", task: "Review the current diff for tests and validation quality. Inspect changed files directly.", output: false },
    { agent: "reviewer", task: "Review the current diff for simplicity and maintainability. Inspect changed files directly.", output: false }
  ],
  concurrency: 3
})
```

### Review loop

```typescript
subagent({ agent: "worker", task: "Add retry logic to the API client." })
subagent({
  agent: "reviewer",
  task: "Review the retry logic implementation. Inspect the repo and current diff directly. Look for edge cases and race conditions."
})
```

### Parallel non-conflicting analysis

```typescript
subagent({
  tasks: [
    { agent: "scout", task: "Audit frontend auth flow" },
    { agent: "researcher", task: "Research current retry/backoff best practices" }
  ]
})
```

### Saved chain

```text
/run-chain review-chain -- review this branch
```

Use saved `.chain.md` workflows when the user wants a repeatable multi-agent flow without rewriting the chain each time.

## Error Handling

**"Unknown agent"**
```typescript
subagent({ action: "list" })
// Check available agents and chains, then confirm scope/precedence.
```

**Setup, discovery, or intercom confusion**
```typescript
subagent({ action: "doctor" })
// Check runtime paths, async support, discovery counts, current session, and intercom bridge state.
```

**"Max subagent depth exceeded"**
```typescript
// Flatten the workflow or raise maxSubagentDepth in config.
```

**"Session manager did not return a session file"**
```typescript
// Persist the current session before using context: "fork".
```

**Intercom "Already waiting for a reply"**
```typescript
// Resolve the current outbound ask before starting another one.
```

**Parallel output-path conflict**
```typescript
// Give each parallel task a distinct output path, or disable output for tasks that do not need it.
```

**Worktree launch fails**
```typescript
// Ensure the git working tree is clean and task cwd overrides match the shared cwd.
```

**Child fails before starting**
```typescript
// Inspect /subagents-status detail, artifact metadata/output logs, and run doctor. Extension loader errors usually appear in child output logs.
```
