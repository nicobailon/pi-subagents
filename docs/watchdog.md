# Watchdog and child permissions

The watchdog is an opt-in second model that reviews what the agent just did and pushes findings back into the transcript. It is adversarial by design: it looks for missed constraints, correctness risks, test gaps, unsafe changes, loop risks, and scope drift, and it says nothing when the turn is clean.

This page covers when it runs, what you see, what the reviewer is given, how to pick its model, child watchdogs, launch rules, and the native child tool permission gate that uses the child watchdog as its arbiter.

The watchdog is not the `reviewer` subagent. `subagents.defaultModel` and `subagents.agentOverrides.reviewer` do not configure it.

## When it runs

Three timings, and they stack.

**Boundary review** runs at `agent_end`, the end of each agent turn, and only when that turn changed the repo. In the main session that is every editing turn. In a child it is the end of each child turn, gated the same way, so a read-only child never triggers it. A finding is steered into the transcript, which gives the agent one continuation to act on it; that continuation's own `agent_end` is reviewed again.

- Multiple edits in one turn are coalesced into one review of the final changed state.
- Unchanged or reverted diffs are skipped.
- Generated `.pi/subagents/` and `tmp/` artifacts do not trigger a review.
- In orchestrated runs each writing child reviews its own worktree, and the parent still reviews the aggregate repo diff after child changes land.

**Cadence review** (opt-in) runs every N tool results mid-turn and is not gated on edits, so an agent that wanders without editing is still checked. Set `subagents.watchdog.cadence.everyNTools` (minimum 5). Cadence warnings are delivered with Pi's `steer` mode after the current tool, so the agent sees them before its next step. This is Scopey-style scope monitoring, inspired by [Scopey](https://github.com/ArchAstro/scopey).

**LSP pre-pass** runs before each boundary review on changed TypeScript and JavaScript files. Errors become blockers without a model call.

Children get all three. A child's cadence comes from `children.overrides.<agent>.cadence`, then `children.cadence`, then the top-level `cadence`:

```json
{
  "subagents": {
    "watchdog": {
      "enabled": true,
      "cadence": { "everyNTools": 10 },
      "children": {
        "enabled": true,
        "cadence": { "everyNTools": 20 },
        "overrides": {
          "worker": { "cadence": { "everyNTools": 5 } },
          "reviewer": { "enabled": false }
        }
      }
    }
  }
}
```

Here the main session is checked every 10 tools, a worker every 5, any other child every 20, and the reviewer never.

There is no "every turn regardless of edits" and no timer. The boundary review is edit-gated on purpose so a chatty but non-editing turn costs nothing. A low cadence such as `everyNTools: 5` is the closest equivalent.

## What you see

Every finding is an ordinary transcript message: expandable, scrollable, and present in the session JSONL. A clean review shows nothing.

### Boundary review in the main session

```
 you ──▶ agent turn ──▶ edits repo ──▶ agent_end
                                          │
                              ┌───────────▼────────────┐
                              │ watchdog review (model) │  ≤ agentEndTimeoutMs
                              │  read/grep/find/ls      │
                              │  watchdog_diff          │
                              └───────────┬────────────┘
                          clean ◀─────────┴─────────▶ warning
                            │                           │
                       turn ends                 steered into transcript
                                                        │
                                                 agent continues once,
                                                 sees it, fixes or argues
```

Collapsed, the first line is bold and colored (red for a blocker, yellow for a concern):

```
● Subagent watchdog Blocker (displayed): Claims tests passed without running them
  ⎿  Evidence: The transcript claims `npm test` passed but no test command appears in the tool log.

● I'll run the focused test now before finishing.
  $ npm test -- test/unit/billing.test.ts
```

Expanded:

```
● Subagent watchdog Blocker (displayed): Claims tests passed without running them

  Evidence: The transcript claims `npm test` passed but no test command appears in the tool log.
  Recommended action: Run the focused test before finishing.
  Category: Test Gap · Source: main
```

### Stalemate

A boundary warning continues the run so the agent can act on it. When consecutive boundary reviews raise the same warning, the agent is not making progress. After `subagents.watchdog.stalemateRepeats` identical warnings in a row (default 3) the watchdog marks the warning `stalemate` and shows it held: no continuation, the turn ends with the warning visible. Your next prompt resets the count.

```
 turn 1 ─ agent_end ─▶ Blocker: X   (steer, run continues)   repeats 1/3
 turn 2 ─ agent_end ─▶ Blocker: X   (steer, run continues)   repeats 2/3
 turn 3 ─ agent_end ─▶ Blocker: X   (held, run STOPS)        repeats 3/3 · stopped

● Subagent watchdog Blocker (stalemate): Claims tests passed without running them
  ⎿  Evidence: ...
     Same warning 3 times in a row; the watchdog stopped continuing the run.
```

### Cadence review mid-turn

```
 tool 1 … tool 10 ──▶ cadence review ──▶ (clean: nothing shown)
 tool 11 … tool 20 ──▶ cadence review ──▶ concern
                                             │
● Subagent watchdog Concern (displayed): Refactoring auth middleware is outside the current scope
  ⎿  Evidence: Current scope is "fix the billing rounding bug"; the last 6 edits touch src/auth/*.

● Good point, reverting the auth changes and returning to billing.
```

### Child watchdog, seen from the orchestrator

The child sees the same transcript message inside its own session. The parent sees it in the Fleet lane while the child runs, in the completion notice, and in the acceptance ledger.

```
        child session (worker)                     parent session (you)
 ┌──────────────────────────────────┐    ┌──────────────────────────────────────────────┐
 │ … edits, tests …                 │    │ Fleet lane while running:                     │
 │ agent_end ▶ child watchdog       │    │                                               │
 │ ● Subagent watchdog Blocker …    │───▶│  Patch billing only · role:worker · running    │
 │   ⎿  Evidence: …                 │    │    phase:implement · next:resolve watchdog     │
 │ ● (child fixes it, or doesn't)   │    │    blockers · workspace:~/repo · [wd:1]        │
 └──────────────────────────────────┘    └──────────────────────────────────────────────┘
```

Completion notice when the child exited without a turn after the blocker:

```
Background task failed: **worker** (Patch billing only)

worker:
Patched rounding in src/billing/round.ts and added a unit test.

Watchdog blockers:
- worker: Claims tests passed without running them (unaddressed)
```

The acceptance ledger carries `watchdog-blocker: failed — Unresolved watchdog blocker: Claims tests passed without running them`. If the child did follow the blocker with a turn, the line reads `(addressed)` and the check passes. A `(stalemate)` blocker stays unresolved even with a turn after it. See [Findings reach the orchestrator](#findings-reach-the-orchestrator) for the data shapes.

### Launch rules

Checked before any child starts; see [Launch rules](#launch-rules).

```
 action: "block"                              action: "warn"
 ───────────────                              ──────────────
 ● subagent(agent: "oracle", …)               ● subagent(agent: "scout", model: "…sol:high")
   ⎿  Error: Launch blocked by                  ⎿  Async: scout [abc123] started
      subagents.watchdog.rules: Agent
      'oracle' was launched with denied       ● Subagent watchdog Concern (displayed): Agent
      model 'anthropic/claude-opus-4-8'.         'scout' was launched with denied model '…sol:high'.
                                                ⎿  Evidence: …roleModels.scout.deny matches
   (child never starts)                            'openai-codex/gpt-5.6-sol*'. scout is cheap
```

### Status

```text
/subagents-watchdog status
```

```
Subagent watchdog
Main: on
Runtime: idle
Review trigger: repo edits only
Scope context: on
Cadence: every 10 tools + boundary
LSP diagnostics: on · ok · typescript-language-server
Session override: none
Main model: anthropic/claude-opus-4-8 (configured)
Main thinking: high
Children: on · model openai-codex/gpt-5.5 · thinking high · overrides oracle off
Recommended strong watchdog: openai-codex/gpt-5.5:high (GPT 5.5, complementary reviewer)
Agent-end timeout: 30000ms
Stalemate: 0/3
Rules: 2 role models · warn
Review model call: real model review
Last warning: blocker · displayed · Claims tests passed without running them

Config: ok
Sources:
- user ~/.pi/agent/settings.json: found
- project .pi/settings.json: found
```

`Stalemate` shows the current repeat count and adds `· stopped` once a stalemate is held. Failed and stale review counts, changed paths, the last error, and config errors appear when present.

## What the reviewer is given

**The turn delta.** The text of the turn plus the changed repo paths. Over-long input keeps its first 6,000 characters and its tail, so the reviewer sees both the task framing and the latest work.

**Current scope.** When `subagents.watchdog.scope.enabled` is on (the default), the watchdog keeps a bounded in-memory scope artifact from real user prompts and prepends it to the review input. Newer prompts supersede and mutate older ones, so the reviewer can flag work that no longer serves the current scope as `scope-drift`.

**The diff.** Every reviewer, main or child, gets a read-only `watchdog_diff` tool alongside `read`, `grep`, `find`, and `ls`. It shows the repository diff against the commit that was current when the session started (later commits included) and lists untracked paths for the reviewer to open with `read`, optionally narrowed to one path or reduced to per-file counts. A child in a managed worktree therefore sees exactly its own changes; a child in a shared cwd also sees changes that were already pending when it started. Sessions outside a git repository do not get the tool.

**Standing instructions.** `WATCHDOG.md` is read on every review, so edits take effect without restarting Pi. Two locations are read, project first and then user:

- `<project>/.pi/WATCHDOG.md` (the project config directory)
- `~/.pi/agent/WATCHDOG.md` (the agent directory)

Both files are concatenated and capped at 8,000 characters from the head. Use them for project rules the reviewer should hold the agent to, such as "never accept skipped tests" or "do not raise backwards compatibility unless the task requires it". Set `subagents.watchdog.guidance.watchdogMd` to `false` to ignore both files.

**LSP diagnostics.** Before the model review, changed TypeScript and JavaScript files are checked for fresh language-server diagnostics.

- It auto-detects `typescript-language-server` from the project `node_modules/.bin` or `PATH`. It never installs tools or scans the whole workspace.
- LSP errors surface as watchdog blockers, warnings as concerns, and info/hints stay in status details.
- Slow or missing servers are reported in `/subagents-watchdog status` without blocking the turn or emitting late mid-turn warnings.
- Configure the bounds with `subagents.watchdog.lsp.enabled`, `timeoutMs`, `maxFiles`, and `maxDiagnostics`.

## Choosing a model

One model setting serves both the boundary and cadence reviews for an endpoint, so pick it for the mode you lean on: a strong complementary model for rare adversarial boundary reviews, or a cheap one for frequent cadence monitoring.

Ask pi-subagents for the current strong pairing:

```text
/subagents-watchdog recommend-model
/subagents-watchdog session model recommended
/subagents-watchdog model recommended
```

The current recommendation policy is Opus 4.8 with thinking high or GPT 5.5 with thinking high. If your main session is using one, the watchdog should use the other when that model is authenticated.

- `session model recommended` changes only the current Pi session.
- `model recommended` saves the recommendation to `~/.pi/agent/settings.json`. It does not turn the watchdog on; enable it separately with `/subagents-watchdog on`.

Or set the model explicitly:

```text
/subagents-watchdog model anthropic/claude-opus-4-8:high
/subagents-watchdog model openai-codex/gpt-5.5:high
/subagents-watchdog model inherit
/subagents-watchdog check
```

In settings files, use `subagents.watchdog.main.model` and `subagents.watchdog.main.thinking` for the main watchdog:

- If `main.model` is omitted, the main watchdog uses the current session model and thinking level.
- If `main.model` is set without a thinking suffix or `main.thinking`, it runs with thinking off. Prefer `:high` or `"thinking": "high"` for the strong-watchdog pairing.

Strong-reviewer profile:

```json
{
  "subagents": {
    "watchdog": {
      "enabled": true,
      "main": {
        "model": "anthropic/claude-opus-4-8",
        "thinking": "high"
      }
    }
  }
}
```

Scopey-style monitoring profile:

```json
{
  "subagents": {
    "watchdog": {
      "enabled": true,
      "main": {
        "model": "anthropic/claude-haiku-4-5",
        "thinking": "medium"
      },
      "scope": { "enabled": true },
      "cadence": { "everyNTools": 10 },
      "stalemateRepeats": 3
    }
  }
}
```

Agents can configure the same values through the tool when you ask them to set up the watchdog:

```ts
subagent({ action: "watchdog.recommend-model" })
subagent({ action: "watchdog.configure", model: "recommended", scope: "session" })
subagent({ action: "watchdog.configure", model: "recommended", scope: "project" })
```

Persistent scopes (`user` or `project`) should only be used when you ask for a lasting default. Otherwise the agent should use `scope: "session"`.

## Child watchdogs

Child watchdogs are opt-in under `subagents.watchdog.children`. Use `children.model` and `children.thinking` as the default child watchdog model, or `children.overrides.<agent>.model` for a specific role. Per-role `enabled` and `cadence` overrides live in the same block; see [When it runs](#when-it-runs) for the cadence resolution order.

### Findings reach the orchestrator

A child watchdog warning is displayed inside the child session and also lifted into the parent:

- **Envelope.** Every warning is summarized on the result's `watchdog.warnings` (severity, category, summary, evidence, recommended action, `addressed`, `stalemate`), bounded to the last 20. `addressed` becomes true when a later assistant turn in the child followed the warning. Workflow status files carry the same list per step.
- **Acceptance.** When a watchdog was attached, acceptance evaluation adds the runtime check `watchdog-blocker`. A blocker that no turn followed, or that reached stalemate, fails the check with `Unresolved watchdog blocker: <summary>`, which rejects explicit acceptance like any other failed check.
- **Notify.** Completion notices list blockers after the result preview as `Watchdog blockers:` with one `- <agent>: <summary> (addressed | unaddressed | stalemate)` line each. Fleet and status views show a `wd:<n>` chip for unresolved blockers and set the next action to `resolve watchdog blockers`.

## Launch rules

`subagents.watchdog.rules` pins which models each role may run on. The check runs before a child starts, needs no model call, and applies whether or not the model review is enabled.

```json
{
  "subagents": {
    "watchdog": {
      "rules": {
        "action": "warn",
        "roleModels": {
          "scout": { "allow": ["openai-codex/gpt-5.6-luna:max"] },
          "oracle": { "deny": ["*"], "note": "oracle is for hard questions only; ask before launching" },
          "worker": { "deny": ["openai-codex/gpt-5.6-sol:high"] }
        }
      }
    }
  }
}
```

- `action`: `warn` (default) steers a watchdog concern into the orchestrator's transcript and lets the launch proceed; `block` returns a tool error and starts nothing.
- `roleModels.<agent>.allow` / `deny`: globs (`*`, `?`) matched against the resolved `provider/id[:thinking]` and against the bare `provider/id`. `deny` wins. An optional `note` is included in the warning text. Evaluated for direct launches, workflow children, and chain or parallel steps. Rules are read from the settings visible at the launch cwd.

`/subagents-watchdog status` reports the number of role models configured and the action.

## Native child tool permissions

Native permissions are opt-in and apply only to Pi child runtimes. With no rules configured, every tool call passes through unchanged.

Configure explicit non-bash rules globally in `~/.pi/agent/extensions/subagent/config.json`:

```json
{
  "permissions": {
    "rules": {
      "read": "allow",
      "write": "ask",
      "edit": "deny"
    }
  }
}
```

Custom agents can override matching global rules with a `permission:` or `permissions:` frontmatter block:

```yaml
---
name: worker
permission:
  write: allow
  edit: ask
---
```

Rules support `allow`, `ask`, and `deny`:

- Agent rules override matching global rules.
- Omitted and unknown tools default to `allow`.
- Explicit `allow` removes an inherited restriction.
- The gate is not registered when the resolved policy has no `ask` or `deny` rules.

### How `ask` works

An explicit `ask` pauses that exact tool call and sends a bounded, redacted preview to a one-call permission arbiter owned by the built-in child watchdog. The arbiter uses the configured child-watchdog model and returns only `approve` or `deny`; it does not notify the parent agent.

Enable and configure `subagents.watchdog.children` before using `ask` rules. A disabled watchdog, missing model/auth, timeout, malformed response, or runtime error denies the call with a clear error.

Asked requests and decisions are written to bounded audit JSONL, including `decisionSource: "watchdog"` and bounded failure reasons. Ordinary direction and clarification through `contact_supervisor` or the optional `pi-intercom` extension remain separate and are never permission-gated.

### Bash is out of scope

`bash` is always passed through by pi-subagents. Bash rules are rejected rather than parsed, gated, denied, or audited. Install and configure `pi-guard` when command-level bash policy is needed.

A pi-subagents child is headless, so a pi-guard rule that resolves to `ask` cannot request approval from the parent Pi UI. Native permissions do not forward pi-guard decisions; they only apply to the separate non-bash child permission gate. For child-specific policy, use `PI_GUARD` through a `PI_SUBAGENT_PI_BINARY` wrapper or an equivalent launch wrapper, and configure explicit `allow` or `deny` rules. An `allow` rule grants execution; it is not approval forwarding, so retain explicit denies for commands the child must not run.

### External CLI profiles

External CLI profiles are opaque processes, so native permissions cannot intercept their tools. A launch with effective `ask` or `deny` rules is rejected for an external CLI agent instead of claiming enforcement.
