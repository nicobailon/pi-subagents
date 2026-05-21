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

This skill is for the main parent orchestrator only. Do not inject or follow it inside spawned child subagents. The parent session owns delegation, orchestration, review fanout, and final fix-worker launches; child subagents should receive concrete role-specific tasks and should not run their own subagent workflows.

Use this skill when the parent orchestrator needs to launch a specialized subagent, compose multiple agents into a workflow, or create/edit agents and chains on demand.

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
- `/run-chain` — launch a saved `.chain.md` workflow
- `/subagents-doctor` — diagnose setup, discovery, async paths, and intercom bridge state

Prefer the tool when you are writing agent logic. Prefer the slash commands when
you are guiding a human through an interactive flow.

Packaged prompt shortcuts are also available for repeatable workflows. Treat them as reusable orchestration recipes, not just human slash commands. When the user asks for one of these shapes, or when the workflow clearly fits, apply the same pattern directly with `subagent(...)` and other tools:
- `/parallel-review` — fresh-context reviewers with distinct review angles, then synthesis
- `/review-loop` — parent-orchestrated worker, fresh-reviewer, and fix-worker cycles until clean or capped
- `/parallel-research` — combine `researcher` and `scout` for external evidence plus local code context
- `/parallel-context-build` — parallel `context-builder` passes that produce planning handoff context and meta-prompts
- `/parallel-handoff-plan` — external-reference research plus local `context-builder` passes, followed by a synthesis handoff plan and implementation-ready meta-prompt
- `/gather-context-and-clarify` — scout/research first, then ask the user clarifying questions with `interview`
- `/parallel-cleanup` — two fresh-context reviewers (deslop + verbosity passes) for an adversarial cleanup review of the current diff


## Builtin Agents

Builtin agents load at the lowest priority. Project agents override user agents,
and user/project agents override builtins with the same name.

| Agent | Purpose | Model | Typical output / role |
|-------|---------|-------|------------------------|
| `scout` | Fast codebase recon | inherits default | Writes `context.md` handoff material |
| `planner` | Creates implementation plans | inherits default | Writes `plan.md` |
| `worker` | Implementation and approved oracle handoffs | inherits default | Single-writer implementation with decision escalation |
| `reviewer` | Review-and-fix specialist | inherits default | Can edit/fix reviewed code |
| `context-builder` | Requirements/codebase handoff builder | inherits default | Writes structured context files |
| `researcher` | Web research brief generator | inherits default | Writes `research.md` |
| `delegate` | Lightweight generic delegate | inherits default | No fixed output; generic delegated work |
| `oracle` | Decision-consistency advisory review | inherits default | Advisory review, intercom coordination |

Builtin agents inherit the current Pi default model unless a run, user setting, or project setting overrides `model`. Override builtin defaults before copying full agent files when a small tweak is enough.

For one run, use inline config:

```text
/run reviewer[model=anthropic/claude-sonnet-4] "Review this diff"
```

For persistent tweaks, edit `subagents.agentOverrides` in user or project settings. User overrides apply everywhere. Project overrides apply only in that repo and win over user overrides.

## Prompting role subagents

Builtin role agents inherit the current Pi default model unless you override them. When launching them, write the task prompt as a compact contract, not a long procedural script. Define the destination and let the role choose the efficient path.

A strong subagent prompt usually includes:
- **Goal**: the concrete outcome the child should produce.
- **Context/evidence**: relevant plan paths, files, diffs, decisions, or user constraints already approved.
- **Success criteria**: what must be true before the child can finish.
- **Hard constraints**: true invariants only, such as no edits for review-only tasks, one writer thread, child must not run subagents, or escalation for unapproved decisions.
- **Validation**: targeted checks to run, or the next-best check when validation is impossible.
- **Output**: the expected summary shape, artifact path, or finding format.
- **Stop rules**: when to ask via `intercom`, when to stop after enough evidence, and when not to keep searching.

Avoid carrying over old prompt habits that over-specify every step. Use `must`, `always`, and `never` for real invariants; for judgment calls, give decision rules. For example, tell a reviewer to inspect the staged diff directly and report only evidence-backed findings, rather than prescribing every file or command. Tell a researcher the retrieval budget: start with broad targeted searches, fetch only the strongest sources, search again only when a required fact is missing, then stop.

For implementation handoffs, name the approved scope and success criteria more clearly than the process. Good prompts say what to change, what not to change, where the evidence lives, how to validate, and when to escalate. They should not ask the child to create another subagent plan or continue the parent conversation.

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
`systemPromptMode`, `inheritProjectContext`, `inheritSkills`, `defaultContext`,
`disabled`, `skills`, `tools`, and `systemPrompt`. Create a user or project
agent with the same name only when you want a substantially different agent.

## Discovery and Scope Rules

Agent files can live in:
- `~/.pi/agent/agents/**/*.md` — user scope
- `.pi/agents/**/*.md` — canonical project scope
- legacy `.agents/**/*.md` — still read for compatibility, but `.pi/agents/` wins on conflicts

Chains live in:
- `~/.pi/agent/chains/**/*.chain.md` — user scope
- `.pi/chains/**/*.chain.md` — project scope

Discovery is recursive. `.chain.md` files do not define agents. Agents and chains can set optional frontmatter `package: code-analysis`; `name: scout` plus `package: code-analysis` registers as runtime name `code-analysis.scout` while serialization keeps `name` and `package` separate.

Precedence is by parsed runtime name:
1. project scope
2. user scope
3. builtin agents


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

Chains default to clarify mode; set `clarify: false` to skip it. Clarify edits affect only the next run; use management actions, settings, or markdown files for persistent changes.
For programmatic background launches, use `async: true`. Set `clarify: false` when you want to bypass chain clarification explicitly; `clarify: true` keeps the run foreground for the clarify UI.


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


## Creating and Editing Agents by File

A minimal agent file looks like this:

```markdown
---
name: my-agent
package: code-analysis
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

That is only a starting point. Omit `package` for the traditional unqualified runtime name. Common optional fields include:
- `defaultProgress`
- `defaultReads`
- `output`
- `fallbackModels`
- `maxSubagentDepth`

For many customizations, builtin overrides in settings are lower-friction than
copying a full builtin file.

## Prompt Template Integration

The package includes prompt shortcuts for common workflows: `/parallel-review`,
`/review-loop`, `/parallel-research`, `/parallel-context-build`,
`/parallel-handoff-plan`, `/gather-context-and-clarify`, and
`/parallel-cleanup`. Use them when the user wants repeatable review,
review/fix loops, research, context handoff, implementation handoff,
clarification, or cleanup-review patterns. `/parallel-review autofix` and
`/parallel-cleanup autofix` synthesize reviewer feedback and then apply only the
fixes worth doing now. Parent agents can also apply the same recipes directly
with `subagent(...)` when the user describes the workflow in natural language
instead of invoking a slash command.

If `pi-prompt-template-model` is installed, additional user prompt templates can delegate into
`pi-subagents`. This is useful when a slash command should always run through a
particular agent or with forked context.


## Important Constraints

- **Forking requires a persisted parent session.** If the current session does not
  have a persisted session file, forked runs fail. Packaged `planner`, `worker`,
  and `oracle` default to forked context, so use `context: "fresh"` explicitly
  when that is not available or not wanted.
- **Forked runs inherit parent history.** They are branched threads, not fresh
  filtered contexts. Use fresh context for adversarial reviewers unless the user explicitly asks for forked context.
- **Default subagent nesting depth is 2.** Deeper recursive delegation is blocked
  unless configured otherwise.
- **Attention signals are not lifecycle state.** `needs_attention` means no activity has been observed past the configured threshold. `paused` means the child turn was intentionally interrupted or is awaiting direction; it is not the same as `failed`.
- **Intercom asks are blocking.** A session can only maintain one pending outbound
  ask wait state at a time.
- **Keep conversational authority clear.** Advisory subagents should not silently
  become second decision-makers.

## References

Detailed documentation has been split into the references/ directory for efficient context loading:

| File | Topic | When to Read |
|---|---|---|
| references/prompt-techniques.md | Prompt techniques (parallel review, review-loop, research, context-build, handoff-plan, gather-context, cleanup) | When applying advanced orchestration patterns without slash commands |
| references/running-subagents.md | Running subagents (single, fork, parallel, chain, async, control) | When executing subagent calls for parameter details and mode selection |
| references/coordination.md | Oracle Workflow + Intercom Coordination | When using oracle pattern or cross-session messaging |
| references/management.md | Management Mode (list, create, update, delete) | When managing agent/chain definitions |
| references/workflows.md | Best Practices + Common Workflows | When planning orchestration strategy or designing workflow patterns |
| references/error-handling.md | Error Handling | When debugging subagent failures |

Read the relevant reference file with the Read tool when you need detail on a specific topic.
