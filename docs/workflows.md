# Workflows and orchestration

How to compose subagents: the recommended pattern, packaged prompt shortcuts, scripted workflows, direct commands, worktree isolation, and child-to-parent coordination.

## Recommended orchestration pattern

Use orchestration as parent-agent guidance, not as a runtime workflow mode. For implementation work, the recommended loop is:

```text
clarify → scout → worker → fresh reviewers → worker
```

Packaged `worker`, `oracle`, and `advisor` default to forked context when a launch omits `context`; pass `context: "fresh"` when you intentionally want a fresh child run.

Child-safety boundaries are enforced at runtime:

- Spawned child sessions do not receive the bundled `pi-subagents` skill.
- Forked child context filtering removes parent-only subagent artifacts (including old hidden orchestration-instruction messages, slash/status/control messages, and prior parent `subagent` tool-call/tool-result history) while preserving ordinary prose and unrelated tool calls/results.
- By default, children do not register the `subagent` tool and receive boundary instructions that they are not the parent orchestrator and must not propose or run subagents.
- The explicit exception is an agent whose resolved builtin `tools` includes `subagent`; that child gets a child-safe `subagent` tool for the fanout work the parent assigned, still bounded by `maxSubagentDepth`.

## Prompt shortcuts

The package includes reusable prompt templates for common workflows. You do not need them, but they are handy when you want the same shape every time:

| Prompt | Use it for |
|--------|------------|
| `/parallel-review` | Launch fresh-context reviewers with distinct angles, then synthesize what to fix. |
| `/review-loop` | Run parent-controlled worker, reviewer, and fix-worker cycles until clean or capped. |
| `/parallel-research` | Combine `researcher` and `scout` for external evidence, local code context, and practical tradeoffs. |
| `/gather-context-and-clarify` | Scout/research first, then ask the user the clarification questions that matter. |
| `/parallel-cleanup` | Run review-only cleanup passes after implementation. |

Add `autofix` to `/parallel-review` or `/parallel-cleanup` to apply only the synthesized fixes worth doing now after reviewers return.

## Scripted workflows (workflowScript)

All model-facing subagent execution is expressed through `workflowScript` in the `subagent` tool. Use stable keys and ordinary JavaScript for one child, sequence, and parallelism. Scripts are ordinary JavaScript statement bodies. Use an explicit `return` for a useful result:

```js
subagent({ workflowScript: `
  const scan = await runs.run("scan", { agent: "scout", task: "Scan the codebase" });
  const reviews = await runs.all([
    { key: "correctness", agent: "reviewer", task: "Review correctness: " + scan.output },
    { key: "tests", agent: "reviewer", task: "Review tests: " + scan.output }
  ]);
  return reviews.map(result => result.output);
` });
```

For watched same-repo workflows, pass `async:false` to show the live in-chat workflow card. `chatProgress` can force `off` or `live-card` when the automatic policy is not what you want. Foreground workflows default to a 30-minute timeout; async workflows have no default timeout. See the [tool reference](tool-reference.md) for the full parameter list.

The legacy `/chain`, `/parallel`, and `/run-chain` commands are not registered.

## Direct commands

Use `/run <agent> [task] [--bg] [--fork]` for one child.

## Worktree isolation

Scripted workflows can give each writing child a separate managed git worktree by setting `worktree: true` on each `runs.run` / `runs.all` item:

```javascript
const [api, ui] = await runs.all([
  { key: "api", agent: "worker", task: "Implement the API", worktree: true },
  { key: "ui", agent: "worker", task: "Implement the UI", worktree: true }
]);
return { api: api.artifactPaths, ui: ui.artifactPaths };
```

Each child uses the existing worktree lifecycle: it branches from clean HEAD, journals ownership before launch, captures a patch and handoff manifest, then removes cleanly captured temporary worktrees and branches. The handoff manifest path remains available in the child's `artifactPaths`; return or emit it when the orchestrator needs to apply or inspect the patches. `runs.ref` stays concise and intentionally omits full paths.

A top-level `{ workflowScript, worktree: true }` makes isolation the default for every workflow child. An individual child can override that default with `worktree: false`. Keep one writer when parallel writes are not intentionally isolated.

Configure the worktree base directory and setup hook in [configuration.md](configuration.md).

## Supervisor coordination (child asks parent)

Child agents can talk back to the parent Pi session without installing `pi-intercom`. `pi-subagents` provides the child-facing `contact_supervisor` tool and the parent-facing `subagent_supervisor({ action: "reply" })` path natively. If no external `pi-intercom` tool owns the `intercom` name, the native channel also exposes `intercom` as a compatibility fallback.

Use it for work where the child might need a decision instead of guessing:

```text
Run this implementation in the background. If the worker gets blocked or needs a product decision, have it ask me through intercom.
```

```text
Ask oracle to review this plan. If it sees a decision I need to make, have it ask me instead of assuming.
```

The child uses one dedicated coordination tool, `contact_supervisor`, with a `reason`:

- `need_decision` — blocking decisions or clarification
- `interview_request` — structured input
- `progress_update` — short non-blocking updates when a discovery changes the plan

Children should not ask for clarification when the only conflict is review-only/no-edit versus progress-writing or artifact-writing instructions; no-edit wins.

The parent replies with `subagent_supervisor({ action: "reply", replyTo, message })` or checks pending requests with `subagent_supervisor({ action: "pending" })`. Supervisor messages are scoped to the exact Pi session id that spawned the child. A second Pi session in the same repository does not receive those requests.

Child-side routine completion handoffs are not expected. If a child appears stalled, needs-attention notices show up in the parent session with useful next actions, such as checking `subagent({ action: "status" })`, interrupting the run, or nudging the child.

If messages do not show up, run `/subagents-doctor`. Advanced users can tune the bridge with `intercomBridge` in [configuration.md](configuration.md).

## Recursion guard

Subagents can call `subagent` only when their resolved builtin tools explicitly include `subagent`. That is meant for delegated fanout agents, not ordinary worker/reviewer children. A depth guard prevents unbounded nesting.

By default, nesting is limited to two levels: main session → subagent → sub-subagent. Deeper calls are blocked with guidance to complete the current task directly. Nested runs appear in the parent status widget and `status` output as a tree, and `status`, `interrupt`, and `resume` can target a nested run by its id.

Configure the limit with:

1. `PI_SUBAGENT_MAX_DEPTH` before starting Pi
2. `config.maxSubagentDepth`
3. `maxSubagentDepth` in agent frontmatter, which can only tighten the inherited limit

```bash
export PI_SUBAGENT_MAX_DEPTH=3
export PI_SUBAGENT_MAX_DEPTH=1
export PI_SUBAGENT_MAX_DEPTH=0
```

`PI_SUBAGENT_DEPTH` is internal and propagated automatically. Do not set it manually.

## Prompt-template integration

`pi-subagents` includes a native prompt-workflow adapter for reusable subagent prompt templates, so you do not need `pi-prompt-template-model` for the common subagent workflow path.

Create a prompt in `.pi/prompts/` or `~/.pi/agent/prompts/`:

```md
---
description: Take a screenshot
model: claude-sonnet-4-20250514
subagent: browser-screenshoter
cwd: /tmp/screenshots
---
Use url in the prompt to take screenshot: $@
```

Then run it through the native adapter:

```text
/prompt-workflow take-screenshot https://example.com
```

The adapter delegates to the named subagent, applies `model`, `skill`, `cwd`, and fork/fresh context metadata, and supports runtime overrides such as `--subagent reviewer`, `--fork`, `--fresh`, and `--bg`.

Prompt templates with `chain:` frontmatter are translated into `workflowScript` and launched through `/prompt-workflow`; `/chain-prompts` is no longer registered.
