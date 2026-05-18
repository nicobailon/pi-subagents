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

## Applying Prompt Techniques Without Slash Commands

The prompt templates in `prompts/` encode workflows the parent agent can run on demand. If the user provides a URL, issue, PR, plan, local file, screenshot, or freeform target, treat that target as the primary scope: read or fetch it before launching children, then include it explicitly in every child task. Do not depend on the parent conversation history when the recipe calls for fresh context.

### Parallel review technique

Use this when the user wants adversarial review of a diff, plan, issue, file, or implemented work. Launch fresh-context `reviewer` agents with distinct angles generated from the actual target. Common angles are correctness/regressions, tests/validation, and simplicity/maintainability; adapt for TypeScript, UI, security, docs, or large structural changes. Reviewers should inspect files and diffs directly, return concise evidence-backed findings with file/line references, and avoid edits unless the user explicitly asks for a writer pass. The parent synthesizes fixes worth doing now, optional improvements, and feedback to ignore/defer before applying anything.

### Review-loop technique

Use this when the user wants implementation or current diff review to continue until reviewers stop finding fixes worth doing now. Keep the loop in the parent session: one async `worker` implements or fixes, fresh-context `reviewer` agents inspect the actual repo and diff, the parent synthesizes accepted fixes, and one async forked `worker` applies them. The parent can express the sequence up front as an async/background chain when the workflow is known, or continue with explicit follow-up subagent runs after each async completion. For an initial chain, pass `async: true` so the main chat is unblocked; do not set `clarify: true` unless the user explicitly wants the foreground clarify UI. Treat an async implementation worker handoff as an intermediate state, not final completion, unless the user explicitly asked for worker-only work, review-only output, or to stop after implementation. Stop when reviewers find no blockers or fixes worth doing now, remaining feedback is optional or deferred, an unapproved product/scope/architecture decision appears, or the max review-round cap is reached. Default to 3 review rounds unless the user sets a different cap. Do not loop for optional polish, and do not let children launch subagents or decide the loop outcome.

### Parallel research technique

Use this when the question needs both external evidence and local implications. Combine `researcher` for official docs, specs, ecosystem behavior, recent changes, benchmarks, and primary sources with `scout` for repository files, patterns, constraints, tests, and likely integration points. Give each child a distinct angle: external evidence, local code context, and practical tradeoffs. Ask for source links or file ranges, confidence level, gaps, and decision implications. Do not ask these children to edit unless implementation was explicitly requested.

### Parallel context-build technique

Use this before planning or implementation when a stronger handoff is needed. Run a chain with one parallel step of `context-builder` agents rather than top-level parallel tasks, so relative output files live under the temporary chain directory. Give every task a distinct output path such as `context-build/request-and-scope.md`, `context-build/codebase-and-patterns.md`, and `context-build/validation-and-risks.md`. Choose two or three builders: request/scope, codebase/patterns, and validation/risks. Each builder must read every relevant file needed to understand its slice, follow imports/callers/tests/docs/config, conduct tool-available web research when needed, and include a compact `meta-prompt` section. The parent synthesizes the outputs into important context, recommended next meta-prompt, open questions, assumptions, and artifact paths.

Example shape:

```typescript
subagent({
  chain: [{
    parallel: [
      { agent: "context-builder", task: "Build request/scope context for: ...", output: "context-build/request-and-scope.md" },
      { agent: "context-builder", task: "Build codebase/pattern context for: ...", output: "context-build/codebase-and-patterns.md" },
      { agent: "context-builder", task: "Build validation/risk context for: ...", output: "context-build/validation-and-risks.md" }
    ]
  }],
  context: "fresh"
})
```

### Parallel handoff-plan technique

Use this when the user needs a solution brief or implementation-ready handoff from an external reference plus local code context, such as “study this library behavior, inspect our codebase, then produce a worker prompt.” Run a chain with a first parallel group and a second synthesis `context-builder` step. The first group usually includes `researcher` for external projects/docs/prompt guidance and `context-builder` for local code context; add a second `context-builder` for implementation strategy only when the scope is large enough to benefit. Use distinct output paths under `handoff/`, then have the synthesis `context-builder` read those outputs and write `handoff/final-handoff-plan.md` with the recommended approach, likely files, constraints, non-goals, validation, risks, unresolved questions, and final compact implementation-ready meta-prompt.

Example shape:

```typescript
subagent({
  chain: [
    { parallel: [
      { agent: "researcher", task: "Research the external reference and transferable implementation ideas for: ...", output: "handoff/external-reference.md" },
      { agent: "context-builder", task: "Build local codebase context for: ...", output: "handoff/local-context.md" },
      { agent: "context-builder", task: "Compare evidence and propose implementation strategy for: ...", output: "handoff/implementation-strategy.md" }
    ] },
    { agent: "context-builder", task: "Read {previous} and synthesize the final handoff plan and implementation-ready meta-prompt.", output: "handoff/final-handoff-plan.md" }
  ],
  context: "fresh"
})
```

### Gather-context-and-clarify technique

Use this at the start of non-trivial work. Launch `scout` for local context and `researcher` only when external docs, recent sources, ecosystem context, or primary evidence would materially improve understanding. Ask children for concise findings plus remaining clarification questions. Then synthesize what is known and use `interview` to ask the unresolved questions needed for shared understanding before planning or implementing.

### Parallel cleanup technique

Use this after implementation when the user wants cleanup review or when a final pass would reduce AI-slop. Launch two fresh-context `reviewer` tasks with `output: false` and `progress: false`: one deslop pass and one verbosity pass. If the `deslop` or `verbosity-cleaner` skills are available, pass the relevant skill to that reviewer; otherwise inline the criteria. Both reviewers are review-only and should flag concrete issues with severity, file/line references, and smallest safe fixes. Review-only/no-edit beats progress-writing or artifact-writing instructions. The parent decides what to apply and asks before making changes unless cleanup was already authorized.

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
  task: "Review my current direction and challenge assumptions."
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

Avoid duplicate output paths in parallel tasks. Concurrent children should not write to the same file. For large saved outputs, set `outputMode: "file-only"` together with an `output` path. The parent result then contains only a compact reference like `Output saved to: /abs/report.md (48.2 KB, 2847 lines). Read this file if needed.` instead of the full saved content. Do not use `output: false` for this; `output: false` means no file output. Failed runs and save errors still return inline details for debugging.

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

Prefer async mode for every subagent launch. Set `async: true` no matter the task unless there is a specific reason to opt into a foreground/blocking run. This applies to scouts, researchers, workers, reviewers, validators, oracle checks, one-off delegates, chains, and parallel groups. Keep the write path single-threaded even when the run is async.

Async does not mean parallel writes. Do not edit the same active worktree while an async worker is changing it. Parent-side overlap should be reading, validation prep, synthesis, command planning, or review of unaffected context unless the writer is isolated in a separate worktree.

Do not end your turn immediately after launching an async child if you promised to keep working. Continue the local inspection, synthesis, or validation prep, then check the async run when its result is needed. If there is no independent work left and you would only be running `sleep` or status polling commands to wait, end your turn instead. Pi will deliver the async completion when it arrives.

```typescript
subagent({
  agent: "worker",
  task: "Run the full test suite",
  async: true
})
```

File-only output mode also works for async single runs, top-level parallel task items, sequential chain steps, and chain parallel task items. In chains, `{previous}` receives the compact saved-file reference when the prior step used file-only mode.

For review fanout where the parent continues a local audit:

```typescript
const run = subagent({
  agent: "reviewer",
  task: "Review the current diff for correctness issues. Do not edit files.",
  async: true,
  context: "fresh"
})
// Continue local inspection, then later call status with the returned id.
```

Inspect async runs with `subagent({ action: "status", id: "..." })` or `subagent({ action: "status" })` for active runs.

Use `resume` for follow-up work after a delegated run:

```typescript
subagent({ action: "resume", id: "run-id", message: "Follow up on this point." })
subagent({ action: "resume", id: "run-id", index: 1, message: "Continue reviewer 2." })
```

Resume behavior:
- If an async child is still running and reachable, `resume` sends the follow-up to that live child over intercom.
- If an async child has completed, `resume` revives it by starting a new async child from the persisted child session file.
- Multi-child async runs require `index` unless only one running child is selectable.
- Completed foreground single, parallel, and chain runs can also be revived by `index` while their run metadata remains in extension state.
- Revive starts a new child process from the old session context; it does not restart the same OS process.
- If the chosen child has no persisted `.jsonl` session file, resume fails and reports that directly.

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

## The Oracle Workflow

The intended oracle loop is:
1. the main agent forks to `oracle`
2. `oracle` reviews direction, drift, assumptions, and risks
3. `oracle` can coordinate back through `contact_supervisor` when the bridge injects it
4. the main agent decides what direction to approve
5. only then should `worker` implement

```typescript
// Advisory review in a branched thread. Oracle defaults to forked context.
subagent({
  agent: "oracle",
  task: "Review my current direction, challenge assumptions, and propose the best next move."
})

// Implementation only after explicit approval. Worker defaults to forked context.
subagent({
  agent: "worker",
  task: "Implement the approved approach: ..."
})
```

`oracle` is not a fresh-context reviewer in the Cognition article sense. It is
a forked advisory thread that inherits the parent session history and uses that
history as a baseline contract.

Use `oracle` as a smart-friend escalation when the parent needs help with trajectory rather than diff inspection: architectural boundaries, model capability routing, merge conflicts, reviewer disagreement, context drift after long work, a worker about to invent a pattern, or fixes that require product/scope tradeoffs. Ask broad questions when the right concern is unclear, and let `oracle` point out missing context or files the parent should inspect before asking again. Keep `oracle` advisory unless it has been explicitly assigned the single writer role.

## Subagent + Intercom Coordination

`pi-subagents` works without `pi-intercom`. When `pi-intercom` is installed and enabled, the intercom bridge can automatically give child agents a private coordination channel back to the parent session.

Most agents should not call generic `intercom` directly unless bridge instructions provide a target and `contact_supervisor` is unavailable. Do not invent a target. Prefer the tool from the injected bridge instructions.

Use `contact_supervisor` with `reason: "need_decision"` when:
- a subagent is blocked on a decision
- a child needs clarification instead of guessing
- an approval, product, API, or scope choice is required before continuing safely

Do not use `contact_supervisor` just to resolve review-only/no-edit versus progress-writing or artifact-writing instructions. No-edit wins, and the child should return review findings without touching files.

Use `contact_supervisor` with `reason: "progress_update"` when:
- a child is explicitly asked for progress
- a meaningful discovery changes the plan
- a long-running child needs to report a blocked/progress checkpoint without waiting for normal tool return flow

Message conventions:
- `reason: "need_decision"` waits for the parent reply and returns it to the child.
- `reason: "progress_update"` is non-blocking and should stay concise.
- Child-side routine completion handoffs are not expected. With the intercom bridge active, parent-side `pi-subagents` sends grouped completion results through `pi-intercom`: one grouped message per foreground parent run and one per completed async result file. Acknowledged foreground delivery returns a compact receipt with artifact/session paths; if unacknowledged, the normal full output is preserved. Grouped messages include child intercom targets and full child summaries.

If bridge instructions provide the child-facing tool, a child can ask:

```typescript
contact_supervisor({
  reason: "need_decision",
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
    package: "code-analysis",
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
  agent: "code-analysis.my-agent",
  config: {
    thinking: "high"
  }
})
```

### Delete an agent

```typescript
subagent({ action: "delete", agent: "code-analysis.my-agent" })
```

Use management actions when the system needs to create or edit subagents on
demand without dropping into raw file editing.

Management actions create or update user/project agent files. `config.name` is the local frontmatter name; optional `config.package` registers and looks up the runtime name as `{package}.{name}`. Use the dotted runtime name for `get`, `update`, `delete`, slash commands, and chain steps. For small builtin changes such as a model swap, prefer `subagents.agentOverrides` in settings.

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

## Best Practices

### Prefer async orchestration

Launch every subagent asynchronously by default. Use `async: true` for scouts, researchers, workers, reviewers, validators, oracle checks, one-off delegates, chains, and parallel groups unless you intentionally need a foreground/blocking run. The parent should keep moving: inspect code while scouts run, prepare validation while a worker implements, do a local diff pass while reviewers review, and synthesize or verify while a fix worker applies accepted feedback. Async is the default orchestration posture; foreground runs are the explicit opt-out.

### Keep writes single-threaded by default

A strong pattern is one main decision-maker plus advisory/research/review/validation subagents around it. Use `oracle` for advice and `worker` for the actual write path. Parallelize reading, review, validation, and synthesis support, not normal writes, unless you deliberately isolate writers with worktrees. A child that writes should report what changed, what was left undone, commands run with exit codes, validation evidence, surprises, and any decisions that need parent approval.

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

When you are the orchestrating agent for a new feature or non-trivial change, factor in the packaged prompt workflows without literally invoking slash commands. Use the same patterns through tools and subagents.

Keep builtin agent defaults unless the user explicitly asks for a different model, thinking level, skills, output behavior, context mode, or other override. Do not add overrides just because you are orchestrating; the defaults encode the intended role behavior. In particular, packaged `planner`, `worker`, and `oracle` default to forked context.

When the user approves launching a subagent to carry out a plan or workflow, treat that as approval to generate a proper role-specific meta prompt for that subagent. Include the approved plan path or summary, clarified requirements, non-goals, relevant context, role boundaries, files or areas to inspect, acceptance criteria, expected output, and validation expectations. Do not pass vague instructions like “implement the plan fully” or “review this” by themselves.

- `/gather-context-and-clarify` maps to: launch `scout` and, when needed, `researcher`; synthesize findings; then use `interview` to ask every clarification question needed for shared understanding.
- `/parallel-review` maps to: launch fresh-context `reviewer` agents with distinct review angles; synthesize the feedback before applying anything.
- `/review-loop` maps to: keep the parent in charge of worker → fresh reviewers → synthesized fix worker cycles until no fixes worth doing now remain, an unapproved decision appears, or the review-round cap is reached.
- `/parallel-research` maps to: combine local `scout` context with external `researcher` evidence when current docs, ecosystem behavior, or API details matter.
- `/parallel-context-build` maps to: run a chain-mode parallel group of `context-builder` agents with distinct temp output paths, then synthesize their context and meta-prompt sections.
- `/parallel-handoff-plan` maps to: run external `researcher` plus local/strategy `context-builder` passes, then a synthesis `context-builder` that writes an implementation handoff plan and implementation-ready meta-prompt.
- `/parallel-cleanup` maps to: use review-only cleanup passes after implementation, especially for simplicity, verbosity, and redundant tests.

For feature work, use this sequence as scaffolding for parent-agent behavior:

```text
clarify → validation contract → planner → async worker → parallel async fresh-context reviewers/validators → async fix worker → follow-up review when warranted → parent review
```

The validation contract defines what done means before code is written: expected behavior, acceptance checks, commands or user flows to exercise, and evidence the worker should return. Keep it lightweight for small tasks, but make it explicit enough that reviewers and validators are checking the intended outcome rather than the worker’s own assumptions.

The first `worker` implements the approved plan. The parent continues with independent inspection or validation prep while it runs, not parallel edits to the same worktree. When the async worker completes, treat its handoff as the transition into review, not as final completion, unless the user explicitly asked for worker-only work, review-only output, or to stop after implementation. Parallel reviewers inspect the resulting diff from fresh context. Validators check behavior with the best available evidence: commands, tests, browser/CLI interaction, screenshots, logs, or manual reproduction notes. The final `worker` applies synthesized review fixes in forked context, then the parent looks over the final diff before completing. The parent may launch these steps as an initial async chain when the workflow is already clear, or as follow-up subagent runs after each async completion. Initial chains should pass `async: true` so the main chat is unblocked; avoid `clarify: true` unless the user asked for foreground clarification. Do not stop after parallel review unless the user explicitly asked for review-only output or the review surfaced a decision that needs approval first.

For complex work, risky changes, broad refactors, or many changed lines, increase review and validation fanout rather than trusting one reviewer. Use distinct angles such as correctness/regressions, tests/validation, simplicity/maintainability, security/privacy, performance, docs/API contracts, and user-flow behavior. When reviewers find non-trivial issues or the fix worker touches many lines, run another focused review round before final validation.

For very large work, split into serial milestones instead of launching a swarm of writers. Each milestone gets one writer, a validation contract, fresh-context review/validation, a fix pass, and parent acceptance before the next milestone starts. Use parallel subagents inside a milestone for read-only context, research, review, and validation only.

Keep orchestration authority in the parent session. Child subagents should not launch more subagents, read this skill, or run their own orchestration loops. Spawned subagents do not receive the `pi-subagents` skill, parent-only status/control/slash messages, prior parent `subagent` tool-call/tool-result artifacts, or the `subagent` extension tool. Child context filtering also strips old hidden orchestration-instruction messages when they appear in inherited history. Every child also receives a boundary instruction that says the parent owns orchestration, the child must not propose or run subagents, and implementation children must call real edit/write tools instead of printing pseudo tool calls. Pass children concrete role-specific work instead.

1. Clarify first. This is mandatory. Gather code context with `scout` or `context-builder`, add `researcher` only when external evidence matters, then ask the user clarifying questions with `interview` until scope, acceptance criteria, constraints, and non-goals are clear.
2. Define the validation contract. State what done means before implementation: expected behavior, checks to run, user flows to exercise, and evidence required in the worker handoff. For UI, CLI, integration, or workflow changes, include at least one validator angle that uses the product the way a user would rather than only reading code.
3. Plan when useful. For complex work, call `planner` or write a plan doc yourself and get approval before implementation. For simple work, confirm shared understanding and explicitly note why planning is skipped.
4. Implement with one writer. After approval, launch `worker` asynchronously with a proper meta prompt that includes clarified requirements, relevant context, plan path or summary, the validation contract, and output expectations. Packaged `worker` defaults to forked context; pass `context: "fresh"` only when you intentionally want a fresh child. While it runs, prepare validation or inspect adjacent code instead of editing the same worktree.
5. Require a useful worker handoff. Ask the worker to report changed files, what was implemented, what was left undone, commands run with exit codes, validation evidence, surprises or new risks, decisions made inside approved scope, and decisions needing parent approval.
6. Review after implementation. After the worker completes, launch parallel async fresh-context `reviewer` agents for correctness/regressions, tests/validation, and simplicity/maintainability. Add security, performance, docs/API, domain-specific, or user-flow validators for complex work, risky changes, broad refactors, or many changed lines. Use `output: false` unless review artifacts are explicitly needed.
7. Synthesize, then run the fix worker. Separate blockers, fixes worth doing now, optional improvements, and feedback to ignore/defer, then launch an async forked `worker` to apply fixes worth doing now when the workflow is implementation-authorized. If reviewers found scope/product/architecture choices that were not approved, ask the user first instead of applying them.
8. Review again when warranted. If the fix worker made substantial changes or addressed non-trivial findings, run another focused parallel review round before final validation.
9. Validate and complete. After the fix worker and any follow-up review return, inspect the final diff yourself, run or confirm focused validation, update docs/changelog when relevant, and summarize what changed and why.

Example implementation handoff after clarification and optional planning:

```typescript
subagent({
  agent: "worker",
  task: "Implement the approved feature.\n\nClarified requirements:\n- ...\n\nPlan: see ~/Documents/docs/...-plan.md\n\nValidation contract:\n- ...\n\nReturn a handoff with changed files, what was implemented, what was left undone, commands run with exit codes, validation evidence, surprises/new risks, and decisions needing parent approval.",
  async: true
})
```

Example review pass after implementation:

```typescript
subagent({
  tasks: [
    { agent: "reviewer", task: "Review the current diff for correctness and regressions. Inspect changed files directly; do not rely on the worker's reasoning.", output: false },
    { agent: "reviewer", task: "Review the current diff for tests and validation quality against the validation contract. Inspect changed files directly.", output: false },
    { agent: "reviewer", task: "Review the current diff for simplicity and maintainability. Inspect changed files directly.", output: false }
  ],
  concurrency: 3,
  context: "fresh",
  async: true
})
```

Example fix worker after parallel reviews:

```typescript
subagent({
  agent: "worker",
  task: "Apply the synthesized reviewer feedback below. Only apply fixes worth doing now; preserve user-approved scope; ask before unapproved product or architecture changes. Run focused validation and summarize what changed.\n\nReviewer synthesis:\n...",
  async: true
})
```

### Review loop

Do not treat review as the final step for implementation work. Run reviewers and validators, synthesize their findings against user scope and the validation contract, then launch one `worker` for accepted fixes when implementation is authorized.

When an async implementation worker completes, treat the worker handoff as an intermediate state. The next parent action is review fanout, then synthesis, then a fix worker if reviewers found fixes worth doing now. This can be planned as an initial async chain when the whole workflow is known, or continued as follow-up subagent runs when the parent only launched the first worker initially. Initial chains should pass `async: true` so the main chat is unblocked; `clarify: true` is the explicit foreground opt-in.

For explicit review-loop requests, repeat worker → fresh-reviewer → synthesized-fix-worker cycles until reviewers find no blockers or fixes worth doing now, remaining feedback is optional or intentionally deferred, an unapproved product/scope/architecture decision needs the user, or the max review-round cap is reached. Default to 3 review rounds unless the user sets a different cap. For complex work, many changed lines, or any fix pass that materially changes the diff, run another focused review round before the parent’s final look; otherwise stop instead of chasing optional polish.

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
// Inspect `subagent({ action: "status", id: "..." })`, artifact metadata/output logs, and run doctor. Extension loader errors usually appear in child output logs.
```
