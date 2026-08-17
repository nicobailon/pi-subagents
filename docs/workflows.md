# Workflows and orchestration

How to compose subagents: the recommended pattern, packaged prompt shortcuts, scripted workflows, direct commands, worktree isolation, and child-to-parent coordination.

## Recommended orchestration pattern

Use orchestration as parent-agent guidance, not as a runtime workflow mode. For implementation work, the recommended loop is:

```text
clarify → scout → worker → fresh reviewers → worker
```

Packaged `worker`, `oracle`, and `advisor` default to forked context when a launch omits `context`. If the parent has no persisted session file or current leaf yet, that implicit default falls back to `fresh`. Pass `context: "fresh"` when you intentionally want a fresh child run, or `context: "fork"` when fork must remain strict.

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

Keep helper functions portable across Node and Bun. Use top-level `await`, plain helper functions that return `runs.run(...)`, or explicit Promise chains. Do not define nested `async function` helpers, async arrows, or async methods inside `workflowScript`; native async helpers hide child-launch observation in Bun and are rejected.

```js
subagent({ workflowScript: `
  function scan() {
    return runs.run("scan", { agent: "scout", task: "Scan the codebase" });
  }
  const result = await scan();
  return result.output;
` });
```

Chaining is still supported. The supported form is scripted chaining: await one `runs.run(...)` result, then pass its output into the next step. Parallel fanout uses `runs.all(...)` inside the same script.

```js
subagent({ workflowScript: `
  const plan = await runs.run("plan", { agent: "scout", task: "Plan the migration" });
  const patch = await runs.run("patch", { agent: "worker", task: "Implement this plan:\n" + plan.output });
  return patch.output;
` });
```

### Steering a workflow child

Use `await runs.steer(key, message, options?)` after `runs.run` or `runs.all` has launched that stable key. Scripts do not target raw run ids. The optional fields are `mode: "steer" | "follow_up" | "auto"`, a non-negative child `index`, and a positive `ackTimeoutMs`.

```js
subagent({ workflowScript: `
  const writer = runs.run("writer", { agent: "worker", task: "Implement the change" });
  const evidence = await runs.run("evidence", { agent: "scout", task: "Find the exact contract" });
  const receipt = await runs.steer("writer", "Also check: " + evidence.output, { mode: "follow_up" });
  return { writer: await writer, receipt };
` });
```

The receipt state is `queued`, `delivered`, `missed`, or `failed`. `delivered` means the child Pi session accepted the input. It does not mean the model followed it. `missed` means the keyed child became terminal or had no live route before delivery. This first slice uses the existing foreground and async steering transports but does not start steering recovery. Workflow traces include one steering attempt entry and one receipt entry.

Always await or return a `runs.steer` promise. The workflow waits for an observed steering side effect to settle before it exits and rejects fire-and-forget calls. Use ordinary `Promise.race` when the first child or steering receipt should advance the script. There is no callback API or child inbox access.

### Rolling child runs

`runs.run` starts a keyed child when you call it. You do not need separate `runs.start`, `runs.next`, or `runs.collect` helpers for rolling councils or staged reviews. Keep the launched promises, use `Promise.race` to wait for the next completed child, steer a still-running sibling by its stable key, and use `Promise.all` to collect the remaining children.

```js
subagent({ workflowScript: `
  let pending = [
    { key: "analysis-a", promise: runs.run("analysis-a", { agent: "reviewer", task: "Analyze option A" }).then((result) => ({ key: "analysis-a", result })) },
    { key: "analysis-b", promise: runs.run("analysis-b", { agent: "reviewer", task: "Analyze option B" }).then((result) => ({ key: "analysis-b", result })) },
    { key: "critic", promise: runs.run("critic", { agent: "reviewer", task: "Find the strongest objection" }).then((result) => ({ key: "critic", result })) }
  ];

  const first = await Promise.race(pending.map((child) => child.promise));
  pending = pending.filter((child) => child.key !== first.key);

  const target = pending.find((child) => child.key === "critic") ?? pending[0];
  const receipt = await runs.steer(target.key, "Challenge this early result:\n" + first.result.output, { mode: "auto" });
  const rest = await Promise.all(pending.map((child) => child.promise));

  return { first: first.result.output, rest: rest.map((child) => child.result.output), receipt };
` });
```

The workflow trace records the run completions and steering receipt. Scripts still never see raw async directories, inbox paths, or session files. If the keyed child is terminal, stale, or has no live route when `runs.steer` runs, the receipt reports `missed` or `failed` and the script can decide whether to continue.

Use named outputs when later workflow steps need structured data or durable references:

```js
subagent({ workflowScript: `
  const inventory = await runs.run("inventory", {
    agent: "scout",
    task: "List the files that need review.",
    outputSchema: {
      type: "object",
      properties: { files: { type: "array", items: { type: "string" } } },
      required: ["files"],
      additionalProperties: false
    }
  });
  return runs.run("review", {
    agent: "reviewer",
    task: "Review these files: " + inventory.structuredOutput.files.join(", ")
  });
` });
```

For dynamic fanout, have one step return a structured list, check it in JavaScript, then map the bounded entries into `runs.all(...)`:

```js
subagent({ workflowScript: `
  const targets = await runs.run("targets", {
    agent: "scout",
    task: "Return up to five source files that need review.",
    outputSchema: {
      type: "object",
      properties: { files: { type: "array", items: { type: "string" }, maxItems: 5 } },
      required: ["files"],
      additionalProperties: false
    }
  });
  const files = targets.structuredOutput.files.slice(0, 5);
  return runs.all(files.map((file, index) => ({
    key: "review-" + index,
    agent: "reviewer",
    task: "Review " + file
  })));
` });
```

For intermediate data that only later steps need, prefer the prior child's returned output or `structuredOutput` instead of writing shared files:

```js
subagent({ workflowScript: `
  const scan = await runs.run("scan", { agent: "scout", task: "Find the files that need fixes." });
  return runs.run("fix", { agent: "worker", task: "Implement these findings:\n" + scan.output });
` });
```

`{chain_dir}` remains available inside scripted workflow step templates for legacy-compatible path templates. It expands to the workflow cwd, not to private temporary storage.

### Migrating old chain shapes

Legacy top-level `chain`, `tasks`, `parallel`, `chainDir`, `/chain`, `/parallel`, `/run-chain`, and durable `.chain.md` execution are no longer the public workflow API. Rewrite them as JavaScript:

```js
// Old shape, no longer supported:
// { chain: [{ agent: "scout", task: "Scan" }, { agent: "worker", task: "Fix from {previous}" }] }

// Current shape:
{ workflowScript: `
  const scan = await runs.run("scan", { agent: "scout", task: "Scan" });
  return runs.run("fix", { agent: "worker", task: "Fix from: " + scan.output });
` }
```

```js
// Old shape, no longer supported:
// { tasks: [{ agent: "reviewer", task: "Review API" }, { agent: "reviewer", task: "Review UI" }] }

// Current shape:
{ workflowScript: `
  return runs.all([
    { key: "api", agent: "reviewer", task: "Review API" },
    { key: "ui", agent: "reviewer", task: "Review UI" }
  ]);
` }
```

For long task text with Markdown fences or shell blocks, use quoted lines instead of a raw template literal:

````js
const task = [
  "Run this command:",
  "```bash",
  "npm test",
  "```"
].join("\n");
return runs.run("test", { agent: "worker", task });
````

A plain workflow creates one enclosing mission by default. Its children do not create separate missions. The result exposes the id as `details.missionId`, and human-readable output ends with `Mission: <id> (<status>)`. Pass `mission:false` for an ephemeral workflow with no mission or durable `state` global.

### Repeatable workflows

Use stable child keys and keep process logic in ordinary JavaScript. `runs.run` launches one child, `runs.all` launches independent children together, and later steps can use each completed child's `output`. Put long task text in arrays joined with `"\n"` so Markdown fences do not conflict with the script string.

For a process you run often, save the task as a prompt template under `.pi/prompts/` or `~/.pi/agent/prompts/` and launch it with `/prompt-workflow`. The adapter compiles prompt steps into `workflowScript`, so templates describe the work instead of embedding raw `subagent` tool-call JSON. You can ask the parent agent to create or update these prompt files from a process described in natural language.

```md
---
description: Review a release candidate
subagent: reviewer
fresh: true
---
Review $@. Return concrete findings with source proof, or state that no issue was found.
```

```text
/prompt-workflow review-release-candidate v0.51.0
```

For watched same-repo workflows, pass `async:false` only when the parent must block until completion. That blocking mode also shows the live in-chat workflow card. `chatProgress` can force `off` or `live-card` when the automatic policy is not what you want. Blocking workflows default to a 30-minute timeout; async workflows have no default timeout. See the [tool reference](tool-reference.md) for the full parameter list.

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

Child agents can talk back to the parent Pi session without installing `pi-intercom`. `pi-subagents` provides the child-facing `contact_supervisor` tool and the parent-facing `subagent_supervisor({ action: "reply" })` path natively. Generic `intercom` remains available only when an explicitly loaded external provider supplies it.

Use it for work where the child might need a decision instead of guessing:

```text
Run this implementation in the background. If the worker gets blocked or needs a product decision, have it ask me through the supervisor channel.
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
