# Pi Subagents: Prompting And Roles

This file is a detailed reference loaded from `skills/pi-subagents/SKILL.md`.

## Capability ceilings

Parent extensions may register a session-scoped, out-of-band ceiling through `pi-subagents/capability-ceiling`. Child tools and eligible canonical agent names are intersected with every active registration and inherited snapshot; `denyExtensions` removes ambient/provider extension loading while retaining package protocol runtime. `{ action: "list" }` marks non-allowlisted agents as restricted, and launch rejects them before spawn. Do not add a model-visible ceiling field or rely on unrestricted role selection for enforcement. Restricted schedules are rejected until their ceiling can be persisted safely.

## When to Use

- **Complex work orchestration**: use Fable mode as the default parent-agent loop for complex work. Complex means the task has multiple moving parts, unclear acceptance, cross-cutting code, meaningful user-visible impact, expensive or irreversible validation, broad review surface, or the user asks for orchestration. Lightweight one-off delegation can stay lightweight.
- **Advisory review**: use fresh-context `reviewer` agents for adversarial code review, or fork to `oracle` when inherited decisions and drift matter. When asking or consulting the oracle, expect live supervisor dialogue if the bridge is available and material unknowns remain.
- **Implementation handoff**: have `oracle` advise, then `worker` implement only after an approved direction
- **Recon and planning**: use `scout`, then write a plan when needed
- **Parallel exploration**: run multiple non-conflicting tasks concurrently
- **Regular skill specialists**: when discovery shows proactive skill subagent suggestions and the current work is broad enough, launch a small fresh-context fanout that asks one subagent per relevant regularly used skill to apply that skill's perspective to the task
- **Long-running work**: launch async/background runs and inspect them later. For mutation-capable work, bound the delivery slice and elapsed runtime, then request checkpoints after active tool work returns. Reserve hard turn and tool-call caps for explicitly read-only children.
- **Subagent control**: watch needs-attention signals and soft-interrupt only when a delegated run is genuinely blocked
- **Agent authoring**: create, update, or override agents and chains for a project

## Tool vs Slash Commands

Agents use the `subagent(...)` tool with `workflowScript` for execution, and `action` for management, status, and control. Humans often use the slash-command layer instead:

- `/run` — launch a single agent
- `workflowScript` — the sole public surface for sequence, parallelism, branching, retries, and aggregation
- `/subagents` — interactive admin for inspecting agents and editing model, thinking, or system prompt
- `/subagents-stop [run-id]` — stop a current-session top-level async run; opens a selector when no id is given
- `/subagents-detach [run-id]` — detach an active foreground single-subagent run without terminating its child
- `/subagent-cost` — show parent plus child token usage and cost for the session
- `/subagents-fleet` — open the live fleet inspector with per-child controls; `Ctrl+Alt+F` opens it during an active foreground turn, `↑↓`/`jk` selects children, `PgUp`/`PgDn` scrolls transcript detail, `s` steers the selected live async child, and `D` stops its top-level async run after confirmation
- `/subagents-watchdog` — inspect or configure the opt-in adversarial change watchdog (model, on/off, recommend-model, check)
- `/subagents-doctor` — diagnose setup, discovery, async paths, and intercom bridge state
- `/subagents-models [agent]` — show the live runtime-loaded builtin model mapping
- `/subagents-profiles`, `/subagents-load-profile`, `/subagents-refresh-provider-models`, `/subagents-generate-profiles`, `/subagents-check-profile` — manage model profiles and provider catalogs
- `/prompt-workflow` — run a prompt template through native workflowScript execution

Prefer the tool when you are writing agent logic. Prefer the slash commands when
you are guiding a human through an interactive flow.

Packaged prompt shortcuts are also available for repeatable workflows. Treat them as reusable orchestration recipes, not just human slash commands. When the user asks for one of these shapes, or when the workflow clearly fits, apply the same pattern directly with `subagent(...)` and other tools:
- `/parallel-review` — fresh-context reviewers with distinct review angles, then synthesis
- `/review-loop` — parent-orchestrated worker, fresh-reviewer, and fix-worker cycles until clean or capped
- `/parallel-research` — combine `researcher` and `scout` for external evidence plus local code context
- `/gather-context-and-clarify` — scout/research first, then ask the user clarifying questions with `interview`
- `/parallel-cleanup` — two fresh-context reviewers (deslop + verbosity passes) for an adversarial cleanup review of the current diff

## Applying Prompt Techniques Without Slash Commands

The prompt templates in `prompts/` encode workflows the parent agent can run on demand. If the user provides a URL, issue, PR, plan, local file, screenshot, or freeform target, treat that target as the primary scope: read or fetch it before launching children, then include it explicitly in every child task. For targets outside the parent cwd, include the exact repository, explicit `cwd`, authority boundary, and expected output path in each child task. Do not depend on the parent conversation history when the recipe calls for fresh context.

### Parallel review technique

Use this when the user wants adversarial review of a diff, plan, issue, file, or implemented work. Launch fresh-context `reviewer` agents with distinct angles generated from the actual target. Common angles are correctness/regressions, tests/validation, and simplicity/maintainability; adapt for TypeScript, UI, security, docs, or large structural changes. Reviewers should inspect files and diffs directly, return concise evidence-backed findings with file/line references, and avoid edits unless the user explicitly asks for a writer pass. The parent synthesizes fixes worth doing now, optional improvements, and feedback to ignore/defer before applying anything.

### Proactive skill-specialist technique

Use this when `{ action: "list" }` reports proactive skill subagent suggestions and the user's task would benefit from perspectives the parent regularly uses. These suggestions are conservative: a skill is recommended only when it is available and referenced repeatedly by configured agents or saved chains. Treat the list as an opt-in hint for the current task, not a command to always fan out.

Default guardrails:
- Keep the fanout small: usually one or two skill-specialist children, never more than the listed recommendations or configured cap.
- Prefer `context: "fresh"` and include only the files, diff, plan, URL, or request details each child needs. Use forked context only when private/session history is essential and appropriate to share.
- Use read-only agents for analysis/review unless implementation was explicitly requested; do not create several writers in the same worktree.
- Skip proactive skill subagents for tiny questions, direct commands, highly private requests, or when the user asks not to delegate.
- Make cost and concurrency visible by using an ordinary `subagent(...)` call rather than hidden/background automation.

Example shape:

```typescript
subagent({
  workflowScript: `
    const results = await runs.all([
      { key: "deslop", agent: "reviewer", task: "Apply the available 'deslop' skill to review the current diff for concrete cleanup findings only. Do not modify files.", skill: "deslop" },
      { key: "accessibility", agent: "reviewer", task: "Apply the available 'accessibility' skill to review the UI changes for concrete issues only. Do not modify files.", skill: "accessibility" }
    ]);
    return results.map(result => result.output);
  `,
  context: "fresh"
})
```

### Review-loop technique

Use this when the user wants implementation or current diff review to continue until reviewers stop finding fixes worth doing now. Keep the loop in the parent session: one async `worker` implements or fixes, fresh-context `reviewer` agents inspect the actual repo and diff, the parent synthesizes accepted fixes, and one async forked `worker` applies them. The parent can express the sequence up front as an async/background `workflowScript` when the workflow is known, or continue with explicit follow-up workflowScript runs after each async completion. For an initial workflow, pass `async: true` so the main chat is unblocked. Treat an async implementation worker handoff as an intermediate state, not final completion, unless the user explicitly asked for worker-only work, review-only output, or to stop after implementation. Stop when reviewers find no blockers or fixes worth doing now, remaining feedback is optional or deferred, an unapproved product/scope/architecture decision appears, or the max review-round cap is reached. Default to 3 review rounds unless the user sets a different cap. Do not loop for optional polish, and do not let children launch subagents or decide the loop outcome.

As a conservative orchestration policy, do not pass `turnBudget` or a hard `toolBudget` to an implementation worker, fix worker, reviewer with edit authority, or other mutation-capable child. The default tool budget blocks read/search tools rather than mutation tools, but count limits still do not measure delivery safety. Use a narrow task plus an outer elapsed deadline with enough margin, then request a checkpoint after the current tool returns. The checkpoint should report changed files, build/test state, remaining work, and commit or PR state. An elapsed timeout is not a mutation-safe boundary and must not be used as the checkpoint trigger.

### Parallel research technique

Use this when the question needs both external evidence and local implications. Combine `researcher` for official docs, specs, ecosystem behavior, recent changes, benchmarks, and primary sources with `scout` for repository files, patterns, constraints, tests, and likely integration points. Give each child a distinct angle: external evidence, local code context, and practical tradeoffs. Ask for source links or file ranges, confidence level, gaps, and decision implications. Do not ask these children to edit unless implementation was explicitly requested.



### Gather-context-and-clarify technique

Use this at the start of non-trivial work. Launch `scout` for local context and `researcher` only when external docs, recent sources, ecosystem context, or primary evidence would materially improve understanding. Ask children for concise findings plus remaining clarification questions. Then synthesize what is known and use `interview` to ask the unresolved questions needed for shared understanding before planning or implementing.

### Parallel cleanup technique

Use this after implementation when the user wants cleanup review or when a final pass would reduce AI-slop. Launch two fresh-context `reviewer` tasks with `output: false` and `progress: false`: one deslop pass and one verbosity pass. If the `deslop` or `verbosity-cleaner` skills are available, pass the relevant skill to that reviewer; otherwise inline the criteria. Both reviewers are review-only and should flag concrete issues with severity, file/line references, and smallest safe fixes. Phrase the constraint as “Do not modify project/source files; returning findings through the configured output artifact is allowed” when you use `output` or `outputMode: "file-only"`. The parent decides what to apply and asks before making changes unless cleanup was already authorized.

### Staged fix orchestration technique

Use this when a broad diff has known reviewer findings across several items and the user wants the parent to “orchestrate subagents like a boss.” Keep the active worktree safe with a three-stage chain:

1. A parallel read-only planning fanout, one reviewer per issue cluster. Each child inspects the real diff and returns exact files, line refs, proposed fixes, and focused validation. They must not edit.
2. One writer worker. It receives the reviewer summaries through `{previous}`, the parent’s accepted scope, stop rules, and verification contract. It is the only child allowed to edit the active worktree.
3. A parallel read-only validation fanout. Validators inspect the worker diff from fresh context with distinct angles, report pass/fail, remaining blockers, and missing verification.

Prefer `async: true`, `context: "fresh"` for reviewers/validators, `outputMode: "file-only"` for large summaries, and per-stage output names that will not collide. Add `phase` and `label` to make async status readable, and use `as` plus `{outputs.name}` when a later step needs a specific earlier result instead of the whole `{previous}` blob. Use this pattern instead of launching several writer workers into a dirty worktree. Include non-blocking suggestions in the writer prompt only when they are small, safe, and do not expand product scope; otherwise record them as deferred.

When one child returns a structured target list, use ordinary JavaScript to validate/filter it and map bounded entries into `runs.all`; do not use the removed chain fanout DSL.

Example shape:

```typescript
subagent({
  async: true,
  context: "fresh",
  chain: [
    { parallel: [
      { agent: "reviewer", phase: "Planning", label: "Deploy docs", as: "deployPlan", task: "Plan fixes for deploy docs/workflow. Inspect the current diff. Do not modify project/source files; returning findings via the configured output artifact is allowed.", output: "plans/deploy.md", outputMode: "file-only" },
      { agent: "reviewer", phase: "Planning", label: "Scheduler contract", as: "schedulerPlan", task: "Plan fixes for scheduler contract. Inspect the current diff. Do not modify project/source files; returning findings via the configured output artifact is allowed.", output: "plans/scheduler.md", outputMode: "file-only" },
      { agent: "reviewer", phase: "Planning", label: "Sandbox/security", as: "sandboxPlan", task: "Plan fixes for sandbox/security. Inspect the current diff. Do not modify project/source files; returning findings via the configured output artifact is allowed.", output: "plans/sandbox.md", outputMode: "file-only" }
    ], concurrency: 3 },
    { agent: "worker", phase: "Implementation", label: "Apply accepted fixes", as: "workerResult", task: "Apply only the accepted fixes from these planning summaries. You are the sole writer for the active worktree. Run focused validation and report changed files, commands, failures, and remaining issues.\n\nDeploy plan:\n{outputs.deployPlan}\n\nScheduler plan:\n{outputs.schedulerPlan}\n\nSandbox plan:\n{outputs.sandboxPlan}", output: "worker/fixes.md", outputMode: "file-only", progress: true },
    { parallel: [
      { agent: "reviewer", phase: "Validation", label: "Deploy/scheduler validation", task: "Validate the post-worker diff for deploy and scheduler fixes. Start from the worker result: {outputs.workerResult}. Do not modify project/source files; returning findings via the configured output artifact is allowed.", output: "validation/deploy-scheduler.md", outputMode: "file-only" },
      { agent: "reviewer", phase: "Validation", label: "Sandbox validation", task: "Validate the post-worker diff for sandbox/security fixes. Start from the worker result: {outputs.workerResult}. Do not modify project/source files; returning findings via the configured output artifact is allowed.", output: "validation/sandbox.md", outputMode: "file-only" }
    ], concurrency: 2 }
  ]
})
```

## Builtin Agents

Builtin agents load at the lowest priority. Project agents override user agents,
and user/project agents override builtins with the same name.

| Agent | Purpose | Model | Typical output / role |
|-------|---------|-------|------------------------|
| `scout` | Fast codebase recon | inherits default | Writes `context.md` handoff material |
| `worker` | Implementation and approved oracle handoffs | inherits default | Single-writer implementation with decision escalation |
| `reviewer` | Review specialist | inherits default | Default recipes are review-only; tools include edit/write when a fix pass is explicit |
| `researcher` | Web research brief generator | inherits default | Writes `research.md` |
| `delegate` | Lightweight generic delegate | inherits default | No fixed output; generic delegated work |
| `oracle` | Decision-consistency advisory review | inherits default | Advisory review, supervisor consultation when available |
| `advisor` | Claude Code-compatible alias for `oracle` | inherits default | Same advisory role as `oracle` |

Builtin `worker` and `delegate` use strict tool allowlists and do not inherit ambient parent extension tools. To give a child an extension tool, name it in `tools` and load its provider via `extensions`, a path-like `tools` entry, or `subagentOnlyExtensions`. Custom agents without an `extensions` field follow `subagents.defaultExtensions` when set.

Builtin agents inherit the current Pi default model unless a run, user setting, project setting, or `subagents.defaultModel` overrides `model`. Set `subagents.defaultModel` when subagents should use a different default model than the parent session. Override builtin defaults before copying full agent files when a small tweak is enough.

Set `subagents.defaultThinking` to apply a shared thinking level to builtin, package, user, and project agents whose frontmatter leaves `thinking` unset. Project settings win over user settings; explicit frontmatter (including `thinking: false`), `agentOverrides.<name>.thinking`, and per-run overrides remain more specific. This setting affects child agents only and does not change the parent session's default thinking level.

```json
{
  "subagents": {
    "defaultThinking": "medium"
  }
}
```

For one run, use inline config:

```text
/run reviewer[model=anthropic/claude-sonnet-4] "Review this diff"
```

For persistent tweaks, edit `subagents.agentOverrides` in user or project settings. User overrides apply everywhere. Project overrides apply only in that repo and win over user overrides. Use `/subagents-models` or `subagent({ action: "models" })` to inspect the live mapping after settings and overrides load.

Model ids do not have to be exact. Separator variations (`claude-haiku-4.5` vs `claude-haiku-4-5`), case (`Claude-Sonnet-4`), and optional trailing date stamps (`claude-haiku-4-5-20251001`) all resolve to the same registry model. Exact `provider/id` wins; a qualified `provider/model` never switches providers. To constrain subagents to a budget or compliance profile, set `subagents.modelScope: { enforce: true, allow: ["anthropic/*", "openai/gpt-5-*"] }` in user or project settings. Out-of-scope models you pass explicitly error and abort; models inherited from frontmatter, `subagents.defaultModel`, agent frontmatter, or the parent session only warn.

For model fleets, use the profile commands instead of hand-editing repeated overrides: `/subagents-refresh-provider-models <provider>`, `/subagents-generate-profiles <provider>`, `/subagents-load-profile <name>`, and `/subagents-check-profile <name>`. Profiles live under `~/.pi/agent/profiles/pi-subagents/` and replace only `settings.subagents` when loaded.

## Prompting role subagents

Builtin role agents inherit the current Pi default model unless you override them. When launching them, write the task prompt as a compact contract, not a long procedural script. Define the destination and let the role choose the efficient path.

A strong subagent prompt usually includes:
- **Goal**: the concrete outcome the child should produce.
- **Target**: repository, explicit `cwd`, branch/ref/head, and source seam when the target is not the parent cwd.
- **Authority boundary**: whether the child may read, edit, commit, push, comment, close, merge, publish, or release. Omit or forbid actions that are not approved.
- **Context/evidence**: relevant plan paths, files, diffs, decisions, or user constraints already approved.
- **Success criteria**: what must be true before the child can finish.
- **Hard constraints**: true invariants only, such as no edits for review-only tasks, one writer thread, child must not run subagents unless it is an explicitly assigned `tools: subagent` fanout child, or escalation for unapproved decisions.
- **Validation**: targeted checks to run, or the next-best check when validation is impossible.
- **Output**: the expected summary shape, artifact path, or finding format. Use repo-qualified durable output paths for cross-codebase waves.
- **Stop rules**: when to ask via `intercom` or `contact_supervisor`, when to stop after enough evidence, and when not to keep searching.

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
        "fallbackModels": ["openai/gpt-5-mini"],
        "acceptanceRole": "read-only"
      }
    }
  }
}
```

Useful override fields: `description`, `model`, `fallbackModels`, `thinking`,
`systemPromptMode`, `inheritProjectContext`, `inheritSkills`, `defaultContext`,
`acceptanceRole`, `disabled`, `skills`, `tools`, `extensions`, and `systemPrompt`.
`description` replaces the discovered description for builtin and custom agents
in `list` output, which is useful for deployment-specific routing notes.
Use `acceptanceRole: false` to clear an override. Create a user or project
agent with the same name only when you want a substantially different agent.

### Recommended model tiering (optional)

When several providers are available, route agents by task shape instead of one model for everything:

1. **Fast workhorse** — cheapest capable model at low thinking for recon, lookups, and mechanical edits (for example on `scout`).
2. **Standard well-scoped** — mid-tier model at medium thinking for most delegations: routine multi-file edits, focused reviews, straightforward implementation (for example on `worker`, `reviewer`, `delegate`).
3. **Deep but bounded** — top reasoning model at high thinking only for hard tasks that arrive with explicit goals and completion criteria; these models loop on vague goals (for example on oracle-style agents).
4. **Taste and intent** — a model that reads human intent well for ambiguous work: UX/design judgment, product tradeoffs, planning from vague requirements, writing quality.

Routing rule: use tiers 1–3 when the task is well-scoped; use tier 4 when scoping or judging is the task itself. Give tier-4 agents cross-provider `fallbackModels` so subscription usage limits degrade gracefully; fallback triggers automatically on rate-limit and overload errors. Note that forked context over an Anthropic parent transcript with signed thinking blocks forces the child's thinking off, so intent-tier agents work best with fresh context.

If a provider rejects model IDs with thinking suffixes, use
`subagents.disableThinking: true` in user or project settings to clear bundled
builtin thinking defaults globally. A higher-precedence per-agent `thinking`
override can opt one builtin back in. Existing custom-agent frontmatter remains authoritative.

Set `subagents.defaultExtensions` to give agents without an `extensions` field a shared child extension allowlist. Omit it to preserve ambient extension discovery, set it to `[]` to disable ambient extensions by default, or use `agentOverrides.<name>.extensions` for one agent. Explicit custom-agent frontmatter still wins.

Tool description modes live in `~/.pi/agent/extensions/subagent/config.json`, not `subagents` settings. Set `toolDescriptionMode` to `compact` to reduce tool-description prompt cost while keeping the execution, async/`subagent_wait`, child-safety, one-writer, management/action, and artifact/status guardrails. Set it to `custom` to read `subagent-tool-description.md` from the project config dir or agent dir; invalid custom files fall back to full mode and the safety guidance is still appended.
