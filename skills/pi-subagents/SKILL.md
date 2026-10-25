---
name: pi-subagents
description: |
  Delegate work to Pi subagents after the operator asks for it: one child,
  parallel or scripted workflows, async runs, resume/steer/stop, review fanout,
  and multi-lane or worktree orchestration.
---

# Pi Subagents

The parent works directly by default. Invoke subagents only when the operator
requested delegation in the current request or through applicable user/project
instructions. Task size, complexity, risk, tool-call count, recipe fit, or an
available specialist does not independently authorize delegation.

Once authorized, choose the smallest bounded shape that earns its token and
elapsed-time overhead through evidence, independent review, specialization,
useful parallelism, or isolation. A single child is valid. The parent keeps
intent, routing, decisions, final acceptance, and publication authority, and
does the work itself where that is cheaper.

## Calls

```typescript
subagent({ agent: "worker", task: "<brief>" })                    // one child; async by default
subagent({ workflow: "parallel", args: { tasks: [{ agent, task, cwd?, model? }] } })  // independent children
subagent({ workflow: true })              // runs the one ```js workflow block in this same reply
subagent({ workflow: "./lane.js", args }) // script file, path relative to the request cwd
subagent({ action: "validate", workflow: "./lane.js" })          // check a script without launching
subagent({ action: "status", id })        // options: { view: "fleet" } or { view: "transcript", index: 0 }
subagent({ action: "resume", id, message })   // completed or paused child; returns a new run id
subagent({ action: "steer", id, message })    // live async child
subagent({ action: "stop", id })              // ends the run; not resumable
subagent({ action: "interrupt", id })         // pauses the child's current turn
subagent({ action: "list" })  ·  subagent({ action: "models" })
subagent({ action: "guide", options: { topic: "<section address>" } })
```

Launches are async by default. Set `async: false` only when the parent must
block; final reviews and gates stay async. After launching, keep doing safe
independent work, or yield: native completion wakes this session. Do not sleep,
poll, or call `bg_wait` for ordinary children. Use `bg_wait` only for provider
or detached work that has no native notification and whose result this turn
needs.

## Workflow scripts

Use a script when later steps depend on earlier results, or for keyed,
retried, aggregated, or resumed children. Write one ```` ```js workflow ````
block in the reply and call `subagent({ workflow: true })` in the same reply.
For a long script, write it to a file and pass `workflow: "./path.js"`; calls in
one reply run at the same time, so write the file in one reply and `validate` or
launch it in the next. When a `workflow: true` call reports the block missing,
pass the source as `options: { script: "..." }` in place of `workflow: true` for
the rest of the turn: on some hosts, text after a tool call reaches the session
as a summary without the block.

```js workflow
const scan = await runs.run("scan", { label: "Map auth flow", agent: "scout", task: "..." });
const reviews = await runs.all([
  { key: "correctness", label: "Review auth correctness", agent: "reviewer", task: "... " + scan.output },
  { key: "tests", label: "Review auth tests", agent: "reviewer", task: "..." },
]);
return reviews.map((review) => review.output);
```

- Scripts are statement bodies with an explicit `return`, top-level `await`,
  and plain helpers. Nested async functions, arrows, and methods are rejected.
- Every `runs.run` / `runs.all` item needs a stable `key`. Add a short
  verb + behavior `label` unless the user gave one.
- Bind files with `output: "plans/x.md"` (relative paths land in run
  artifacts) and return `outputReference` or `artifactPaths`. A filename in
  task text does not route output. Never send reports to the repo root.
- `runs.lanes([{ key, stages: [...] }])` runs a predeclared plan: first stages
  together, later stages in order per lane.

Resuming a retained child:

```js workflow
let child = await runs.run("fix-1", { agent: "worker", task: "..." });
child = await runs.run("fix-2", { resume: child.runId, task: "Apply these accepted findings: ..." });
return child.output;
```

- Always resume the latest returned run id; every resume returns a new one.
- Use a new stable key for every resume pass.
- `resume` excludes `agent` and `gate`; the child keeps its agent, model, and tools.
- Resume a completed child; steer a live one. Top-level `{ action: "resume" }` is detached.

## Briefs

Every child starts cold. Its task states: goal; repo, explicit `cwd`, and
ref; authority and edit boundary; relevant files, decisions, and evidence;
success criteria; validation; expected output; and when to stop or ask.
Make parallel briefs differ by seam, evidence, and decision, not just an item
number.

## Rules

- One writer per cwd or worktree. Parallelize reading, review, and
  validation. `worktree: true` needs a clean checkout (untracked files count;
  `.pi/subagents/` does not). For Pi extension repos, put lane worktrees
  outside `~/.pi/agent/extensions`, for example `~/.pi/agent/worktrees`.
- Reviewers use fresh context. Use `context: "fork"` only when the child needs
  the parent's history; it requires a persisted parent session.
- Children do not spawn subagents unless the parent delegated fanout and their
  resolved `tools` include `subagent`.
- A failed workflow, launch, prompt runtime, extension load, or child tool
  setup blocks the lane. Stop, report the exact failure and run/worktree state,
  verify a clean worktree or capture the partial diff, then retry the same way
  once. Switching to `interactive_shell`, `pi -ne`, or another CLI needs owner
  approval.
- As a conservative orchestration policy, do not pass a hard `toolBudget` or tight `usageBudget` to mutation-capable workers. The default tool budget blocks read/search tools rather than mutation tools. If interrupted after a tool call starts, checkpoint after the current tool returns with changed files, build/test state, and commit or PR state.
- Route workers and scouts to a fast capable tier, serious reviews to a strong
  tier, and top reasoning only to bounded read-only critique. Exact model names
  belong in user or project settings, not here.
- `subagent`, `subagents_enable`, `subagent_supervisor`, `contact_supervisor`, and `structured_output` are model-only: call them as ordinary model tool calls. Codemode scripts cannot reach them through `tools.*`, `ALL_TOOLS`, or `searchTools`.
- Receipts, CI, and review bots are evidence, not authority. Backlog, release,
  and merge policy belong to the user's or project's own skill.

## Look up the rest

If only `subagents_enable` is visible, call it first; `subagent` and `guide`
work from the next request. Read one section, not a whole topic:

| Need | Guide section |
| --- | --- |
| Script API: `runs.*`, `state`, limits | `workflows/scripted-workflows` |
| Typed gates, host commands, rolling fanout | `workflows/typed-post-run-checks-and-typed-steps`, `workflows/host-command-steps`, `workflows/advanced-rolling-child-runs` |
| Budgets, timeouts, `baseRef`, `gate`, `output` | `tool-reference/execution-parameters`, `tool-reference/output-mode-details` |
| Fresh or forked context | `tool-reference/fork-context-details` |
| Resume, steer modes, stop, status | `tool-reference/retained-children`, `tool-reference/resume`, `tool-reference/steer`, `tool-reference/stop`, `tool-reference/status` |
| Acceptance and review gates | `tool-reference/acceptance-gates` |
| Worktrees and handoffs | `workflows/worktree-isolation` |
| Child asks the parent (`contact_supervisor`) | `workflows/supervisor-coordination-child-asks-parent` |
| Agent create, update, eject, disable, refine | `tool-reference/management-actions`, `agents/frontmatter-reference` |
| Missions and schedules | `missions/missions`, `missions/schedules` |
| Watchdog | `watchdog/when-it-runs`, `watchdog/choosing-a-model` |
| Model overrides and profiles | `models/setting-defaults-and-overrides` |
| Other projects in panes | `tool-reference/herdr-project-panes` |
| Setup looks wrong | `subagent({ action: "doctor" })` |

## References

- Choosing roles, writing prompts, review/research/cleanup techniques, oracle → [prompting-and-roles.md](references/prompting-and-roles.md)
- Several lanes, worktrees, repositories, staged fixes, review loops, finding and gate triage → [orchestration.md](references/orchestration.md)
- Advisor council → [../council-mode/SKILL.md](../council-mode/SKILL.md)
