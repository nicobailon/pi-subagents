# Watchdog and child permissions

The watchdog is an opt-in second model that reviews what the agent just did and pushes findings back into the transcript. It looks for missed constraints, correctness risks, test gaps, unsafe changes, loop risks, and scope drift, and says nothing when the turn is clean. It is not the `reviewer` subagent; `subagents.defaultModel` and `agentOverrides.reviewer` do not configure it.

## When it runs

Three timings, and they stack:

| Timing | Trigger | Gate | Delivery |
|---|---|---|---|
| Boundary review | `agent_end` of every turn, main or child | Only when the turn changed the repo | Steered; the agent gets one continuation, and that turn is reviewed again |
| Cadence review (opt-in) | Every `cadence.everyNTools` tool results, minimum 5 | None | Steered after the current tool, before the next step |
| LSP pre-pass | Before each boundary review | Changed TypeScript and JavaScript files | Errors become blockers with no model call |

Boundary details: edits in one turn are coalesced into one review of the final state, unchanged or reverted diffs are skipped, `.pi/subagents/` and `tmp/` artifacts never trigger a review, and in orchestrated runs each writing child reviews its own worktree while the parent reviews the aggregate diff after child changes land. There is no "every turn regardless of edits" mode and no timer; the closest is a low cadence such as `everyNTools: 5`. Cadence monitoring is inspired by [Scopey](https://github.com/ArchAstro/scopey).

Children get all three. A child's cadence resolves from `children.overrides.<agent>.cadence`, then `children.cadence`, then the top-level `cadence`:

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

Main session every 10 tools, worker every 5, any other child every 20, reviewer never.

## What you see

Every finding is an ordinary transcript message: expandable, scrollable, in the session JSONL. A clean review shows nothing.

```
 you ──▶ agent turn ──▶ edits repo ──▶ agent_end
                                          │
                              ┌───────────▼────────────┐
                              │ watchdog review (model) │  ≤ agentEndTimeoutMs
                              │  read/grep/find/ls      │
                              │  watchdog_diff          │
                              └───────────┬────────────┘
                          clean ◀─────────┴─────────▶ warning steered in;
                            │                        agent continues once
                       turn ends
```

The first line is bold, red for a blocker and yellow for a concern. Collapsed, only the evidence line follows it; expanded shows everything:

```
● Subagent watchdog Blocker (displayed): Claims tests passed without running them

  Evidence: The transcript claims `npm test` passed but no test command appears in the tool log.
  Recommended action: Run the focused test before finishing.
  Category: Test Gap · Source: main
```

**Stalemate.** When consecutive boundary reviews raise the same warning, the agent is not making progress. After `stalemateRepeats` identical warnings in a row (default 3) the warning is marked `stalemate` and shown held: no continuation, the turn ends with it visible. Your next prompt resets the count.

```
 turn 1 ─ agent_end ─▶ Blocker: X   (steer, run continues)   1/3
 turn 2 ─ agent_end ─▶ Blocker: X   (steer, run continues)   2/3
 turn 3 ─ agent_end ─▶ Blocker: X   (held, run STOPS)        3/3 · stopped

● Subagent watchdog Blocker (stalemate): Claims tests passed without running them
  ⎿  Same warning 3 times in a row; the watchdog stopped continuing the run.
```

**Cadence.** Same message shape, mid-turn:

```
 tool 1 … 10 ──▶ review ──▶ clean, nothing shown
 tool 11 … 20 ──▶ review ──▶ ● Subagent watchdog Concern (displayed): Refactoring auth middleware is outside the current scope
                                ⎿  Evidence: Current scope is "fix the billing rounding bug"; the last 6 edits touch src/auth/*.
```

**Child watchdog, from the orchestrator.** The child sees the message in its own session. The parent sees a Fleet chip while the child runs, then the notice and acceptance ledger:

```
  Patch billing only · role:worker · running
    phase:implement · next:resolve watchdog blockers · workspace:~/repo · [wd:1]

Background task failed: **worker** (Patch billing only)

worker:
Patched rounding in src/billing/round.ts and added a unit test.

Watchdog blockers:
- worker: Claims tests passed without running them (unaddressed)
```

The acceptance check `watchdog-blocker` fails with `Unresolved watchdog blocker: <summary>`. A blocker followed by a child turn reads `(addressed)` and passes; a `(stalemate)` blocker stays unresolved either way.

**Launch rule violations** (see [Launch rules](#launch-rules)):

```
 action: "block"                                   action: "warn"
 ● subagent(agent: "oracle", …)                    ● subagent(agent: "scout", model: "…sol:high")
   ⎿  Error: Launch blocked by                       ⎿  Async: scout [abc123] started
      subagents.watchdog.rules: Agent 'oracle'     ● Subagent watchdog Concern (displayed): Agent 'scout'
      was launched with denied model '…'.            was launched with denied model '…sol:high'.
   (child never starts)                              ⎿  Evidence: …roleModels.scout.deny matches '…'. scout is cheap
```

**Status.** `/subagents-watchdog status` prints one line per setting plus runtime counters:

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

Failed and stale review counts, changed paths, the last error, and config errors appear when present; `Stalemate` adds `· stopped` once a stalemate is held.

## What the reviewer is given

- **Turn delta** with changed repo paths. Over-long input keeps its first 6,000 characters and its tail, so the task framing and the latest work both survive.
- **Current scope** (`scope.enabled`, default on): a bounded in-memory artifact built from real user prompts, newer prompts superseding older ones, so drift can be flagged as `scope-drift`.
- **`watchdog_diff`** alongside `read`, `grep`, `find`, and `ls`: the repo diff against the commit current at session start (later commits included) plus untracked paths to open with `read`, optionally narrowed to a path or reduced to per-file counts. A child in a managed worktree sees exactly its own changes; a child in a shared cwd also sees changes pending when it started. Not offered outside a git repository.
- **`WATCHDOG.md`** standing instructions, read on every review so edits need no restart: `<project>/.pi/WATCHDOG.md` first, then `~/.pi/agent/WATCHDOG.md`, concatenated and capped at 8,000 characters. Use it for rules like "never accept skipped tests". `guidance.watchdogMd: false` ignores both.
- **LSP diagnostics** from `typescript-language-server`, auto-detected in `node_modules/.bin` or `PATH`, never installed and never run over the whole workspace. Errors become blockers, warnings concerns, info and hints stay in status. Slow or missing servers are reported in status without blocking the turn. Bounds: `lsp.enabled`, `timeoutMs`, `maxFiles`, `maxDiagnostics`.

## Choosing a model

One model setting serves both boundary and cadence reviews per endpoint: a strong complementary model for rare adversarial boundary reviews, or a cheap one for frequent cadence monitoring.

```text
/subagents-watchdog recommend-model                 # show the strong pairing
/subagents-watchdog session model recommended       # this Pi session only
/subagents-watchdog model recommended               # save to ~/.pi/agent/settings.json
/subagents-watchdog model anthropic/claude-opus-4-8:high
/subagents-watchdog model openai-codex/gpt-5.5:high
/subagents-watchdog model inherit
/subagents-watchdog check
/subagents-watchdog on
```

The recommendation is Opus 4.8 or GPT 5.5 at thinking high, whichever your main session is not using and is authenticated. Saving a model does not enable the watchdog; use `on` separately.

In settings, `main.model` and `main.thinking` configure the main watchdog. Omit `main.model` to inherit the session model and thinking level. A `main.model` without a thinking suffix or `main.thinking` runs with thinking off, so prefer `:high` for the strong pairing.

```json
{ "subagents": { "watchdog": { "enabled": true, "main": { "model": "anthropic/claude-opus-4-8", "thinking": "high" } } } }
```

Scopey-style monitoring profile:

```json
{
  "subagents": {
    "watchdog": {
      "enabled": true,
      "main": { "model": "anthropic/claude-haiku-4-5", "thinking": "medium" },
      "scope": { "enabled": true },
      "cadence": { "everyNTools": 10 },
      "stalemateRepeats": 3
    }
  }
}
```

Agents can do the same through the tool: `subagent({ action: "watchdog.recommend-model" })` and `subagent({ action: "watchdog.configure", model: "recommended", scope: "session" | "user" | "project" })`. Agents should use `scope: "session"` unless you ask for a lasting default.

## Child watchdogs

Opt in under `subagents.watchdog.children`: `model` and `thinking` set the default child watchdog, `overrides.<agent>` sets `model`, `thinking`, `enabled`, or `cadence` per role.

A child warning is displayed inside the child session and lifted into the parent three ways:

- **Envelope.** The result's `watchdog.warnings` lists each warning (severity, category, summary, evidence, recommended action, `addressed`, `stalemate`), bounded to the last 20. `addressed` flips when a later assistant turn followed the warning. Workflow status files carry the same list per step.
- **Acceptance.** When a watchdog was attached, the runtime check `watchdog-blocker` fails on any blocker that no turn followed or that reached stalemate, rejecting explicit acceptance like any other failed check.
- **Notify.** Completion notices add `Watchdog blockers:` after the result preview, one `- <agent>: <summary> (addressed | unaddressed | stalemate)` line each. Fleet and status views show `wd:<n>` for unresolved blockers and set the next action to `resolve watchdog blockers`.

## Launch rules

`subagents.watchdog.rules` pins which models each role may run on. It runs before a child starts, needs no model call, and applies even when the model review is off.

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

- `action`: `warn` (default) steers a concern into the orchestrator's transcript and lets the launch proceed; `block` returns a tool error and starts nothing.
- `roleModels.<agent>.allow` / `deny`: globs (`*`, `?`) matched against `provider/id[:thinking]` and the bare `provider/id`; `deny` wins; `note` is appended to the warning. Evaluated for direct launches, workflow children, and chain or parallel steps, using the settings visible at the launch cwd.

## Native child tool permissions

Opt-in, Pi child runtimes only. With no rules, every tool call passes through. Global non-bash rules live in `~/.pi/agent/extensions/subagent/config.json`; agents override matching rules in a `permission:` (or `permissions:`) frontmatter block:

```json
{ "permissions": { "rules": { "read": "allow", "write": "ask", "edit": "deny" } } }
```

```yaml
---
name: worker
permission:
  write: allow
  edit: ask
---
```

Values are `allow`, `ask`, and `deny`. Agent rules override global ones, omitted and unknown tools default to `allow`, an explicit `allow` removes an inherited restriction, and the gate is not registered when the resolved policy has no `ask` or `deny`.

**`ask`** pauses that exact tool call and sends a bounded, redacted preview to a one-call arbiter owned by the child watchdog, which uses the configured child-watchdog model and returns only `approve` or `deny` without notifying the parent. Enable `subagents.watchdog.children` first; a disabled watchdog, missing model or auth, timeout, malformed response, or runtime error denies the call with a clear error. Requests and decisions go to bounded audit JSONL with `decisionSource: "watchdog"` and bounded failure reasons. `contact_supervisor` and the optional `pi-intercom` extension are never permission-gated.

**Bash** is always passed through; bash rules are rejected rather than parsed, gated, denied, or audited. Use `pi-guard` for command-level policy. A pi-subagents child is headless, so a pi-guard `ask` cannot reach the parent UI and native permissions do not forward pi-guard decisions. For child-specific policy, run `PI_GUARD` through a `PI_SUBAGENT_PI_BINARY` wrapper with explicit `allow` or `deny` rules; `allow` grants execution rather than forwarding approval, so keep explicit denies for commands the child must not run.

**External CLI profiles** are opaque processes, so native permissions cannot intercept their tools. A launch with effective `ask` or `deny` rules is rejected for an external CLI agent instead of claiming enforcement.
